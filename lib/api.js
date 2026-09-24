/**
 * dsh-rss-reader — HTTP API for the browser UI.
 *
 * Every route is registered on the harness webserver under
 * `/api/rss-reader/*`, so the panel talks to the host over the same origin it
 * was served from (no CORS, no separate port). Requests are additionally
 * fenced to the local UI:
 *
 * - only loopback sockets are served;
 * - the `Host` header must name a loopback address (a DNS-rebinding guard);
 * - a browser same-origin marker is required, so a page on another origin
 *   cannot drive the API through a simple form post.
 *
 * This is a convenience fence around a loopback-only server, not a substitute
 * for the harness's own authentication.
 *
 * @module dsh-rss-reader/api
 */

import { discoverFeeds } from "./feed.js";
import { FeedFetchError, fetchUrl, normalizeFeedUrl } from "./fetch.js";
import { refreshFeed } from "./refresh.js";
import { normalizeBase } from "./rsshub.js";
import { canonicalUrl } from "./history.js";
import { PREF_KEYS, normalizePref } from "./store.js";
import { fillRoutePath, missingParameters } from "./explore.js";
import { DEFAULT_TARGET, TARGET_LANGUAGES } from "./translate.js";

/**
 * Project one item for the reading pane: its Markdown body plus any cached
 * translation.
 *
 * @param {object} item - stored item.
 * @returns {object} the wire item.
 */
export function projectItemBody(item) {
  return {
    id: item.id,
    title: item.title,
    link: item.link,
    summary: item.summary,
    summaryMarkdown: item.summaryMarkdown ?? "",
    markdown: item.markdown ?? "",
    content: item.content ?? "",
    author: item.author,
    date: item.date,
    categories: item.categories,
    enclosure: item.enclosure,
    read: item.read === true,
    starred: item.starred === true,
    translation: item.translation ?? null
  };
}

/** Route prefix owned by this plugin. */
export const API_PREFIX = "/api/rss-reader";

/** Body cap for API requests (1 MiB) — feeds are added by URL, not upload. */
const MAX_BODY_BYTES = 1024 * 1024;

/** Hostnames treated as loopback. */
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "::1", "localhost", "[::1]"]);

/** Fetch-error codes caused by the caller's own input, not by the upstream. */
const CLIENT_ERROR_CODES = new Set(["empty-url", "invalid-url", "unsupported-scheme"]);

/**
 * Map a thrown error onto an HTTP status.
 *
 * A caller's malformed input is a 400, an unreachable or misbehaving upstream
 * is a 502, and anything unclassified is a 500 — so the UI can distinguish
 * "you typed this wrong" from "the feed is down" from "the plugin broke".
 *
 * @param {unknown} error - the thrown value.
 * @returns {number} the HTTP status to send.
 */
export function statusForError(error) {
  if (Number.isInteger(error?.statusCode)) return error.statusCode;
  if (error instanceof FeedFetchError) {
    return CLIENT_ERROR_CODES.has(error.code) ? 400 : 502;
  }
  return 500;
}

/**
 * Write a JSON response.
 * @param {import("node:http").ServerResponse} res - response.
 * @param {number} status - HTTP status.
 * @param {unknown} body - JSON-serializable body.
 */
export function sendJson(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "content-length": Buffer.byteLength(payload)
  });
  res.end(payload);
}

/**
 * Read and parse a JSON request body with a hard size cap.
 * @param {import("node:http").IncomingMessage} req - request.
 * @returns {Promise<object>} the parsed body ({} when empty).
 * @throws {Error} with `statusCode` set on malformed or oversized input.
 */
export async function readJsonBody(req) {
  const chunks = [];
  let total = 0;
  for await (const chunk of req) {
    total += chunk.length;
    if (total > MAX_BODY_BYTES) {
      const error = new Error("request body too large");
      error.statusCode = 413;
      throw error;
    }
    chunks.push(chunk);
  }
  const raw = Buffer.concat(chunks).toString("utf8").trim();
  if (raw.length === 0) return {};
  try {
    const parsed = JSON.parse(raw);
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      const error = new Error("request body must be a JSON object");
      error.statusCode = 400;
      throw error;
    }
    return parsed;
  } catch (error) {
    if (error?.statusCode !== undefined) throw error;
    const wrapped = new Error("request body must be valid JSON");
    wrapped.statusCode = 400;
    throw wrapped;
  }
}

/**
 * Whether a request comes from the local UI.
 *
 * A bare `curl` is refused, while the browser panel passes: `fetch()` from a
 * page always sends `Sec-Fetch-Site`/`Sec-Fetch-Mode` plus an `Origin`, which
 * a non-browser client does not synthesize. Only those Fetch-metadata signals
 * and `Origin` are accepted — `Referer` is deliberately NOT one of them, since
 * it is trivially forged and some HTTP clients (PowerShell's included) set it
 * automatically.
 *
 * This is a tripwire, not an authority check: the real boundary is the
 * loopback bind plus the harness's own authentication.
 *
 * @param {import("node:http").IncomingMessage} req - request.
 * @returns {boolean} true when the request looks browser-initiated and local.
 */
export function isLocalUiRequest(req) {
  const remote = req.socket?.remoteAddress ?? "";
  const isLoopbackSocket = remote === "127.0.0.1" || remote === "::1" || remote === "::ffff:127.0.0.1";
  if (!isLoopbackSocket) return false;

  const host = String(req.headers.host ?? "");
  const hostname = host.replace(/:\d+$/, "").toLowerCase();
  if (hostname.length > 0 && !LOOPBACK_HOSTS.has(hostname)) return false;

  if (req.headers["sec-fetch-site"] === "cross-site") return false;

  const origin = req.headers.origin;
  if (typeof origin === "string" && origin.length > 0) {
    try {
      const originHost = new URL(origin).hostname.toLowerCase();
      if (!LOOPBACK_HOSTS.has(originHost)) return false;
    } catch {
      return false;
    }
    return true;
  }

  // No Origin: fall back to Fetch metadata, which browsers attach to every
  // same-origin fetch and non-browser clients do not send.
  return req.headers["sec-fetch-site"] === "same-origin" || req.headers["sec-fetch-mode"] !== undefined;
}

/**
 * Whether a fetched document is itself a feed.
 *
 * Used to tell the user "this URL is already a feed" when discovery finds no
 * `<link>` declarations because there was no HTML page to begin with.
 *
 * @param {object} response - result of `fetchUrl`.
 * @returns {boolean} true when the body looks like a feed document.
 */
function looksLikeFeedDocument(response) {
  const contentType = String(response?.contentType ?? "").toLowerCase();
  if (/rss|atom|rdf|\+xml|text\/xml|application\/xml/.test(contentType)) return true;
  return /^\s*(<\?xml|<rss|<feed|<rdf:RDF)/i.test(String(response?.body ?? "").slice(0, 200));
}

/**
 * Route table factory.
 *
 * The returned descriptors are plain data (kind/path/handler) so the whole
 * surface can be exercised in tests without a live harness.
 *
 * @param {object} deps - collaborators.
 * @param {import("./store.js").FeedStore} deps.store - subscription store.
 * @param {import("./refresh.js").RefreshCoordinator} deps.coordinator - refresh guard.
 * @param {() => object} [deps.status] - extra plugin status (schedule info).
 * @param {object} [deps.translator] - `{describe, translate}`; omitted when no
 *   model is reachable, which disables the translate route with a clear answer.
 * @param {import("./rsshub.js").RsshubClient} [deps.rsshub] - RSSHub discovery
 *   client; omitted when the feature is disabled.
 * @param {import("./explore.js").CatalogClient} [deps.catalog] - RSSHub route
 *   registry client; omitted when the "探索" feature is disabled.
 * @param {Record<string, boolean|string>} [deps.prefDefaults] - the plugin
 *   config's value for each preference, used wherever the user has not chosen.
 * @param {(prefs: object) => Promise<void>|void} [deps.onPrefsChanged] - called
 *   after a preference is stored, so the host can retarget anything that
 *   follows it (the RSSHub instance, for one).
 * @param {() => Promise<object>} [deps.modelCatalog] - the model routes the
 *   translation picker may offer; omitted when the harness has no LLM registry.
 * @param {(options: object) => Promise<object>} [deps.backfill] - the bounded
 *   history fetch; omitted when the plugin config disables it.
 * @param {number} [deps.historyMaxLimit] - hard ceiling on one backfill run.
 * @returns {Array<{kind: string, path: string, handler: Function}>} routes.
 */
export function createRoutes({
  store,
  coordinator,
  status,
  translator,
  rsshub,
  catalog,
  prefDefaults = {},
  onPrefsChanged,
  modelCatalog,
  backfill,
  historyMaxLimit = 50
}) {
  /**
   * The effective preferences: the user's choice, else the plugin config.
   *
   * The distinction matters — a preference the user never touched must keep
   * following the config, so an operator can change the default and have it
   * take effect for everyone who never overrode it.
   *
   * @returns {Record<string, boolean>} the values the UI should show.
   */
  const resolvePrefs = () => ({ ...prefDefaults, ...store.prefs() });

  /** Wrap a handler with the local-UI fence and top-level error reporting. */
  const guard = (handler) => async (req, res) => {
    try {
      if (!isLocalUiRequest(req)) {
        sendJson(res, 403, { ok: false, error: "forbidden: this API is served to the local DSH UI only" });
        return;
      }
      // The store loads asynchronously at startup, and the webserver starts
      // accepting before that finishes. Without this, an early request would
      // read an empty store and could overwrite a real one with its snapshot.
      await store.load();
      await handler(req, res);
    } catch (error) {
      sendJson(res, statusForError(error), {
        ok: false,
        error: error instanceof Error ? error.message : String(error)
      });
    }
  };

  /** Reject a request whose method is not allowed. */
  const requireMethod = (req, res, method) => {
    if (req.method === method) return true;
    sendJson(res, 405, { ok: false, error: `method not allowed (use ${method})` });
    return false;
  };

  /**
   * Find every feed a URL could be subscribed to.
   *
   * Two stages, because they answer different questions:
   *
   * 1. the page's own `<link rel="alternate">` declarations — authoritative and
   *    needing no third party, so it runs first and wins any duplicate;
   * 2. RSSHub's Radar rules, which map a page URL to a generated feed and cover
   *    the many sites that publish nothing themselves.
   *
   * A page that cannot be fetched is not fatal: RSSHub generates its feed
   * server-side and may reach a site this process cannot.
   *
   * @param {string} url - the page or feed URL to inspect.
   * @param {object} [options] - `{timeoutMs, limit, page, rsshub}`.
   * @returns {Promise<object>} the merged discovery result.
   */
  const runDiscovery = async (url, options = {}) => {
    const candidates = [];
    const seen = new Set();
    /** Add a candidate once; the first source to report it wins. */
    const push = (candidate) => {
      if (seen.has(candidate.url)) return;
      seen.add(candidate.url);
      candidates.push(candidate);
    };

    let finalUrl = url;
    let pageError = "";
    let pageIsFeed = false;
    if (options.page !== false) {
      try {
        const response = await fetchUrl(url, { timeoutMs: options.timeoutMs });
        finalUrl = response.finalUrl;
        for (const found of discoverFeeds(response.body, response.finalUrl)) {
          push({ kind: "feed", source: "page", title: found.title, url: found.url, type: found.type });
        }
        pageIsFeed = candidates.length === 0 && looksLikeFeedDocument(response);
      } catch (error) {
        pageError = error instanceof Error ? error.message : String(error);
      }
    }

    const info = {
      enabled: rsshub !== undefined,
      base: rsshub?.base ?? "",
      site: "",
      domain: "",
      reason: "",
      domainRoutes: [],
      domainRouteTotal: 0
    };
    if (rsshub !== undefined && options.rsshub !== false) {
      const found = await rsshub.discover(finalUrl, { limit: options.limit ?? 12 });
      info.site = found.site;
      info.domain = found.domain;
      info.reason = found.reason;
      for (const candidate of found.candidates) {
        push({
          kind: "rsshub",
          source: "rsshub",
          title: candidate.title,
          url: candidate.url,
          route: candidate.route,
          docs: candidate.docs,
          site: candidate.site
        });
      }

      // Nothing path-matched, but the site is covered: list what exists so the
      // user learns which page to paste instead of just seeing nothing.
      if (found.candidates.length === 0 && found.domain.length > 0) {
        try {
          const listed = await rsshub.listRoutes(found.domain, { limit: 12 });
          info.domainRoutes = listed.routes;
          info.domainRouteTotal = listed.total;
          info.site = info.site.length > 0 ? info.site : listed.site;
        } catch {
          /* orientation only; a failure here is not worth reporting */
        }
      }
    }

    return { candidates, finalUrl, pageIsFeed, rsshub: info, pageError };
  };

  return [
    {
      kind: "exact",
      path: `${API_PREFIX}/state`,
      handler: guard(async (req, res) => {
        if (!requireMethod(req, res, "GET")) return;
        const url = new URL(req.url ?? "/", "http://localhost");
        const withItems = url.searchParams.get("items") !== "0";
        sendJson(res, 200, {
          ok: true,
          state: store.snapshot({ withItems }),
          refreshing: coordinator.busy,
          ...(status === undefined ? {} : { status: status() })
        });
      })
    },
    {
      kind: "exact",
      path: `${API_PREFIX}/item`,
      handler: guard(async (req, res) => {
        if (!requireMethod(req, res, "GET")) return;
        const url = new URL(req.url ?? "/", "http://localhost");
        const found = store.findItem(url.searchParams.get("feedId") ?? "", url.searchParams.get("itemId") ?? "");
        if (found === undefined) {
          sendJson(res, 404, { ok: false, error: "feed or item not found" });
          return;
        }
        // The one place item bodies are sent: a single item, on demand.
        sendJson(res, 200, { ok: true, item: projectItemBody(found.item) });
      })
    },
    {
      kind: "exact",
      path: `${API_PREFIX}/models`,
      handler: guard(async (req, res) => {
        if (!requireMethod(req, res, "GET")) return;
        if (modelCatalog === undefined) {
          sendJson(res, 503, { ok: false, error: "这个 profile 没有挂载 LLM 服务，所以没有可选模型" });
          return;
        }
        const result = await modelCatalog();
        if (result?.ok !== true) {
          sendJson(res, 503, { ok: false, error: result?.error ?? "无法读取模型目录" });
          return;
        }
        // The picker needs to know what is in force *and* what the user chose:
        // an empty preference means "follow the session default", which reads
        // very differently from "chose the same model the default names".
        const stored = Object.keys(store.prefs());
        sendJson(res, 200, { ok: true, catalog: result.catalog, stored });
      })
    },
    {
      kind: "exact",
      path: `${API_PREFIX}/history`,
      handler: guard(async (req, res) => {
        if (!requireMethod(req, res, "POST")) return;
        if (backfill === undefined) {
          sendJson(res, 503, { ok: false, error: "回溯抓取已在插件配置中关闭（history: false）" });
          return;
        }
        const body = await readJsonBody(req);
        const feedId = typeof body.feedId === "string" ? body.feedId : "";
        const feed = store.get(feedId);
        if (feed === undefined) {
          sendJson(res, 404, { ok: false, error: "feed not found" });
          return;
        }
        const archiveUrl = typeof body.archiveUrl === "string" ? body.archiveUrl.trim() : "";
        try {
          const parsed = new URL(archiveUrl);
          if (parsed.protocol !== "http:" && parsed.protocol !== "https:") throw new Error("not http");
        } catch {
          sendJson(res, 400, { ok: false, error: `归档页地址不可用：需要完整的 http(s) 地址（现在填的是「${archiveUrl}」）` });
          return;
        }
        const requested = Number.isFinite(body.limit) ? Math.floor(body.limit) : 20;
        const limit = Math.max(1, Math.min(requested, historyMaxLimit));
        // Only the links the feed already holds describe what an article looks
        // like on this site, and they are also what must not be fetched again.
        const sampleLinks = feed.items.map((item) => item.link).filter((link) => typeof link === "string" && link.length > 0);
        let result;
        try {
          result = await backfill({
            archiveUrl,
            limit,
            sampleLinks,
            known: new Set(sampleLinks.map(canonicalUrl)),
            timeoutMs: undefined
          });
        } catch (error) {
          // The archive itself is unreachable: that is an upstream failure, not
          // the caller's mistake.
          sendJson(res, 502, { ok: false, error: error instanceof Error ? error.message : String(error) });
          return;
        }
        const added = store.addItems(feedId, result.items);
        await store.flush();
        sendJson(res, 200, {
          ok: true,
          added: added?.added ?? 0,
          total: added?.total ?? feed.items.length,
          considered: result.considered,
          skipped: result.skipped,
          failures: result.failures,
          // The panel paints the new items from the same snapshot the rest of
          // the UI uses, so a backfill needs no follow-up state request.
          state: store.snapshot()
        });
      })
    },
    {
      kind: "exact",
      path: `${API_PREFIX}/translate`,
      handler: guard(async (req, res) => {
        if (req.method === "GET") {
          // "Is translation available at all?" — the UI hides the button when
          // no model is configured, rather than failing after a click.
          const route = translator?.describe?.() ?? { available: false, reason: "translation is disabled in the plugin config" };
          sendJson(res, 200, { ok: true, ...route, targets: TARGET_LANGUAGES, defaultTarget: DEFAULT_TARGET });
          return;
        }
        if (req.method === "DELETE") {
          const url = new URL(req.url ?? "/", "http://localhost");
          const updated = store.setItemTranslation(
            url.searchParams.get("feedId") ?? "",
            url.searchParams.get("itemId") ?? "",
            null
          );
          if (updated === undefined) {
            sendJson(res, 404, { ok: false, error: "feed or item not found" });
            return;
          }
          await store.flush();
          sendJson(res, 200, { ok: true, cleared: true });
          return;
        }
        if (!requireMethod(req, res, "POST")) return;
        if (translator === undefined) {
          sendJson(res, 503, { ok: false, error: "translation is not available in this profile (the LLM service is missing)" });
          return;
        }
        const body = await readJsonBody(req);
        const feedId = typeof body.feedId === "string" ? body.feedId : "";
        const itemId = typeof body.itemId === "string" ? body.itemId : "";
        const found = store.findItem(feedId, itemId);
        if (found === undefined) {
          sendJson(res, 404, { ok: false, error: "feed or item not found" });
          return;
        }
        const { item } = found;
        const target = typeof body.target === "string" && body.target.length > 0 ? body.target : DEFAULT_TARGET;

        // A cached translation for the same target is returned as-is, so the
        // button costs nothing the second time.
        if (body.force !== true && item.translation !== null && item.translation !== undefined
          && item.translation.target === target) {
          sendJson(res, 200, { ok: true, cached: true, translation: item.translation });
          return;
        }

        const outcome = await translator.translate({
          title: item.title,
          // Fall back to the summary's Markdown: feeds that publish the whole
          // article in <description> leave `markdown` empty.
          markdown: (item.markdown ?? "").length > 0 ? item.markdown : (item.summaryMarkdown ?? ""),
          summary: item.summary,
          target,
          signal: undefined
        });
        if (outcome.status !== "ok") {
          // A model or configuration failure is an upstream problem, not the
          // caller's mistake, so it must not look like a bad request.
          sendJson(res, 502, { ok: false, error: outcome.error });
          return;
        }
        store.setItemTranslation(feedId, itemId, outcome);
        await store.flush();
        sendJson(res, 200, { ok: true, cached: false, translation: outcome });
      })
    },
    {
      kind: "exact",
      path: `${API_PREFIX}/feeds`,
      handler: guard(async (req, res) => {
        if (req.method === "POST") {
          const body = await readJsonBody(req);
          const url = normalizeFeedUrl(body.url);
          // Adding with `refresh: false` lets the UI add first and fetch after,
          // so a slow feed never blocks the form.
          const { feed, created } = store.add({
            url,
            title: typeof body.title === "string" ? body.title : "",
            group: typeof body.group === "string" ? body.group : ""
          });
          if (body.refresh === false) {
            // Persist the subscription before answering, so a crash right after
            // the response cannot lose it.
            await store.flush();
            sendJson(res, created ? 201 : 200, { ok: true, created, feedId: feed.id, state: store.snapshot() });
            return;
          }
          const outcome = await refreshFeed(store, feed.id, {
            timeoutMs: body.timeoutMs,
            force: true
          });
          // The fetched items and the recorded error both live in the store, so
          // this must flush too — otherwise a restart silently loses the items
          // the response just reported.
          await store.flush();

          // The URL turned out not to be a feed. Rather than leaving the user
          // with an empty subscription and an error, look for what they should
          // have pasted instead (a page's own feeds, or RSSHub routes).
          let suggestions;
          if (outcome.ok !== true && (outcome.code === "not-a-feed" || outcome.code === "parse-failed")) {
            const discovered = await runDiscovery(feed.url, { timeoutMs: body.timeoutMs });
            if (discovered.candidates.length > 0 || discovered.rsshub.domainRoutes.length > 0) {
              suggestions = {
                candidates: discovered.candidates,
                rsshub: discovered.rsshub
              };
            }
            // The failed subscription has served its purpose; drop it so the
            // sidebar does not accumulate dead entries.
            if (created) store.remove(feed.id);
            await store.flush();
            sendJson(res, created ? 201 : 200, {
              ok: true,
              created: false,
              removed: created,
              feedId: feed.id,
              outcome,
              state: store.snapshot(),
              ...(suggestions === undefined ? {} : { suggestions })
            });
            return;
          }

          sendJson(res, created ? 201 : 200, {
            ok: true,
            created,
            feedId: feed.id,
            outcome,
            state: store.snapshot()
          });
          return;
        }
        if (req.method === "DELETE") {
          const url = new URL(req.url ?? "/", "http://localhost");
          const id = url.searchParams.get("id") ?? "";
          const removed = store.remove(id);
          if (!removed) {
            sendJson(res, 404, { ok: false, error: `feed not found: ${id}` });
            return;
          }
          await store.flush();
          sendJson(res, 200, { ok: true, state: store.snapshot() });
          return;
        }
        if (req.method === "PATCH") {
          const body = await readJsonBody(req);
          const updated = store.update(body.id, body);
          if (updated === undefined) {
            sendJson(res, 404, { ok: false, error: `feed not found: ${body.id}` });
            return;
          }
          await store.flush();
          sendJson(res, 200, { ok: true, state: store.snapshot() });
          return;
        }
        sendJson(res, 405, { ok: false, error: "method not allowed (use POST, PATCH, or DELETE)" });
      })
    },
    {
      kind: "exact",
      path: `${API_PREFIX}/refresh`,
      handler: guard(async (req, res) => {
        if (!requireMethod(req, res, "POST")) return;
        const body = await readJsonBody(req);
        const ids = Array.isArray(body.ids) ? body.ids.filter((id) => typeof id === "string" && id.length > 0) : undefined;
        const summary = await coordinator.run(store, {
          ids,
          force: body.force === true,
          timeoutMs: body.timeoutMs,
          concurrency: body.concurrency
        });
        await store.flush();
        sendJson(res, 200, { ok: true, summary, state: store.snapshot() });
      })
    },
    {
      kind: "exact",
      path: `${API_PREFIX}/items`,
      handler: guard(async (req, res) => {
        if (!requireMethod(req, res, "PATCH")) return;
        const body = await readJsonBody(req);
        const feedId = typeof body.feedId === "string" ? body.feedId : "";
        if (body.all === true) {
          const changed = store.markAllRead(feedId, body.read !== false);
          await store.flush();
          sendJson(res, 200, { ok: true, changed, state: store.snapshot() });
          return;
        }
        const itemId = typeof body.itemId === "string" ? body.itemId : "";
        const item = store.setItemFlags(feedId, itemId, {
          read: typeof body.read === "boolean" ? body.read : undefined,
          starred: typeof body.starred === "boolean" ? body.starred : undefined
        });
        if (item === undefined) {
          sendJson(res, 404, { ok: false, error: "feed or item not found" });
          return;
        }
        await store.flush();
        sendJson(res, 200, { ok: true, item, state: store.snapshot() });
      })
    },
    {
      kind: "exact",
      path: `${API_PREFIX}/discover`,
      handler: guard(async (req, res) => {
        if (!requireMethod(req, res, "POST")) return;
        const body = await readJsonBody(req);
        const url = typeof body.url === "string" ? body.url.trim() : "";
        if (url.length === 0) {
          sendJson(res, 400, { ok: false, error: "url is required" });
          return;
        }
        const result = await runDiscovery(url, {
          timeoutMs: body.timeoutMs,
          limit: body.limit,
          page: body.page,
          rsshub: body.rsshub
        });
        // Nothing found *and* the page could not be read is an upstream failure,
        // not an empty answer — unless RSSHub covered the site anyway, in which
        // case the page error is merely a note on a successful result.
        if (result.candidates.length === 0 && result.pageError.length > 0 && result.rsshub.domainRoutes.length === 0) {
          sendJson(res, 502, { ok: false, error: result.pageError });
          return;
        }
        sendJson(res, 200, {
          ok: true,
          candidates: result.candidates,
          finalUrl: result.finalUrl,
          pageIsFeed: result.pageIsFeed,
          rsshub: result.rsshub,
          ...(result.pageError.length > 0 ? { pageError: result.pageError } : {})
        });
      })
    },
    {
      kind: "exact",
      path: `${API_PREFIX}/rsshub`,
      handler: guard(async (req, res) => {
        if (!requireMethod(req, res, "GET")) return;
        const url = new URL(req.url ?? "/", "http://localhost");
        // `?check=1` also asks the instance whether it answers. Kept behind a
        // flag because it costs a request, and the panel only needs the facts.
        let reachable;
        if (url.searchParams.get("check") === "1" && rsshub !== undefined) {
          reachable = await rsshub.ping();
        }
        sendJson(res, 200, {
          ok: true,
          enabled: rsshub !== undefined,
          // The two RSSHub features travel together: one instance, one config
          // block, so the UI asks once whether the whole family is available.
          explore: catalog !== undefined,
          base: rsshub?.base ?? catalog?.base ?? "",
          ...(reachable === undefined ? {} : { reachable }),
          ...(rsshub === undefined && catalog === undefined
            ? { reason: "RSSHub discovery is disabled in the plugin config" }
            : {})
        });
      })
    },
    {
      kind: "exact",
      path: `${API_PREFIX}/prefs`,
      handler: guard(async (req, res) => {
        if (req.method === "GET") {
          // `stored` names the keys the user actually chose: the merged values
          // alone cannot say whether the instance URL is theirs or the config's.
          sendJson(res, 200, { ok: true, prefs: resolvePrefs(), stored: Object.keys(store.prefs()) });
          return;
        }
        if (req.method === "PATCH") {
          const body = await readJsonBody(req);
          const keys = body === null || typeof body !== "object" ? [] : Object.keys(body);
          if (keys.length === 0) {
            sendJson(res, 400, { ok: false, error: "a preference key is required" });
            return;
          }
          // Validate everything before writing anything: a request that names
          // one good key and one bad one must not half-apply.
          const accepted = {};
          for (const key of keys) {
            try {
              accepted[key] = normalizePref(key, body[key]);
            } catch (error) {
              sendJson(res, 400, { ok: false, error: error instanceof Error ? error.message : String(error) });
              return;
            }
          }
          // The instance URL is the one preference that has to be a usable
          // address: storing a typo would break RSSHub at the next boot instead
          // of failing here, where the reader can still see why.
          if (Object.hasOwn(accepted, "rsshubBase") && accepted.rsshubBase !== "") {
            try {
              accepted.rsshubBase = normalizeBase(accepted.rsshubBase);
            } catch {
              // The stored value has to be usable at the next boot, so a typo is
              // refused here, where the reader can still see what went wrong.
              sendJson(res, 400, {
                ok: false,
                error: `RSSHub 实例地址不可用：需要完整的 http(s) 地址（现在填的是「${accepted.rsshubBase}」）`
              });
              return;
            }
          }
          for (const key of keys) await store.setPref(key, accepted[key]);
          // Hand the new values to the host, which retargets whatever has to
          // follow them — a changed instance URL must not wait for a restart.
          if (typeof onPrefsChanged === "function") await onPrefsChanged(resolvePrefs());
          sendJson(res, 200, { ok: true, prefs: resolvePrefs(), stored: Object.keys(store.prefs()) });
          return;
        }
        sendJson(res, 405, { ok: false, error: "method not allowed (use GET or PATCH)" });
      })
    },
    {
      kind: "exact",
      path: `${API_PREFIX}/explore`,
      handler: guard(async (req, res) => {
        if (!requireMethod(req, res, "GET")) return;
        if (catalog === undefined) {
          sendJson(res, 503, {
            ok: false,
            enabled: false,
            error: "RSSHub 探索已在插件配置中关闭（rsshubExplore: false）"
          });
          return;
        }
        const url = new URL(req.url ?? "/", "http://localhost");
        const params = url.searchParams;
        const page = await catalog.list({
          q: params.get("q") ?? "",
          namespace: params.get("namespace") ?? "",
          category: params.get("category") ?? "",
          limit: Number.parseInt(params.get("limit") ?? "", 10) || undefined,
          offset: Number.parseInt(params.get("offset") ?? "", 10) || 0,
          refresh: params.get("refresh") === "1"
        });
        sendJson(res, 200, { ok: true, enabled: true, ...page });
      })
    },
    {
      kind: "exact",
      path: `${API_PREFIX}/explore/url`,
      handler: guard(async (req, res) => {
        if (!requireMethod(req, res, "POST")) return;
        if (catalog === undefined) {
          sendJson(res, 503, { ok: false, error: "RSSHub 探索已在插件配置中关闭（rsshubExplore: false）" });
          return;
        }
        const body = await readJsonBody(req);
        const namespace = typeof body.namespace === "string" ? body.namespace : "";
        const path = typeof body.path === "string" ? body.path : "";
        const values = body.values !== null && typeof body.values === "object" && !Array.isArray(body.values) ? body.values : {};
        const route = await catalog.find(namespace, path);
        if (route === null) {
          sendJson(res, 404, { ok: false, error: `RSSHub 路由表里没有 ${namespace}${path}，可能是实例版本不同，请重新加载列表` });
          return;
        }
        const missing = missingParameters(path, values);
        if (missing.length > 0) {
          sendJson(res, 400, { ok: false, error: `缺少必填参数：${missing.join("、")}` });
          return;
        }
        const filled = fillRoutePath(path, values);
        if (filled === null) {
          sendJson(res, 400, { ok: false, error: "无法根据这些参数拼出路由地址" });
          return;
        }
        sendJson(res, 200, {
          ok: true,
          path: filled,
          // A route template is namespace-relative; the feed URL is not. The
          // namespace is the first path segment, and leaving it out produces a
          // URL that resolves to a different route — or to nothing at all.
          url: `${catalog.base}/${namespace}${filled}`,
          title: route.name,
          namespace: route.namespace
        });
      })
    },
    {
      kind: "exact",
      path: `${API_PREFIX}/feeds/order`,
      handler: guard(async (req, res) => {
        if (!requireMethod(req, res, "PATCH")) return;
        const body = await readJsonBody(req);
        if (!Array.isArray(body.ids)) {
          sendJson(res, 400, { ok: false, error: "ids must be an array of feed ids" });
          return;
        }
        // Unknown ids are ignored rather than refused: this is a list the client
        // read a moment ago, and a feed removed in between must not cost the
        // reader the whole rearrangement.
        const order = await store.setOrder(body.ids);
        sendJson(res, 200, { ok: true, order, state: store.snapshot() });
      })
    },
    {
      kind: "exact",
      path: `${API_PREFIX}/health`,
      handler: guard(async (_req, res) => {
        sendJson(res, 200, { ok: true, plugin: "dsh-rss-reader", feeds: store.list().length, ts: Date.now() });
      })
    }
  ];
}

/**
 * Register the API routes on the harness webserver.
 *
 * @param {object} ctx - context carrying `webServer`.
 * @param {object} deps - see {@link createRoutes}.
 * @returns {Array<() => void>} route disposers.
 */
export function registerApi(ctx, deps) {
  const disposers = [];
  for (const route of createRoutes(deps)) {
    disposers.push(ctx.webServer.register(route));
  }
  return disposers;
}
