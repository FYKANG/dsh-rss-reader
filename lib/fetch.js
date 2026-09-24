/**
 * dsh-rss-reader — network layer for feed retrieval.
 *
 * Responsibilities kept out of the store and the UI:
 *
 * - **bounded reads**: a hard byte cap enforced while streaming, so a hostile
 *   or accidental multi-gigabyte response cannot exhaust memory;
 * - **timeouts**: an abort signal covers connect plus body read;
 * - **conditional GET**: ETag/Last-Modified are replayed so unchanged feeds
 *   cost one cheap 304 instead of a full transfer;
 * - **content-type tolerance**: feeds are routinely served as text/html or
 *   text/plain, so the body is decoded and handed to the parser regardless;
 * - **optional proxy**: `HTTPS_PROXY`/`HTTP_PROXY`/`ALL_PROXY` are honoured
 *   when `undici` is resolvable, and silently ignored otherwise.
 *
 * @module dsh-rss-reader/fetch
 */

import { discoverFeeds, parseFeed } from "./feed.js";

/** Default per-request timeout. */
export const DEFAULT_TIMEOUT_MS = 20000;

/** Default response size cap (8 MiB) — far above any real feed. */
export const DEFAULT_MAX_BYTES = 8 * 1024 * 1024;

/** Identifying User-Agent; some hosts reject requests without one. */
const USER_AGENT = "dsh-rss-reader/0.1 (+https://github.com/deepseek-ai/deepseek-harness)";

/** Status codes worth retrying once on a different transport path. */
const RETRY_STATUS = new Set([408, 425, 429, 500, 502, 503, 504]);

/**
 * A feed retrieval failure carrying a machine-readable reason.
 */
export class FeedFetchError extends Error {
  /**
   * @param {string} message - human-readable description.
   * @param {{code?: string, status?: number, url?: string}} [details] - context.
   */
  constructor(message, details = {}) {
    super(message);
    this.name = "FeedFetchError";
    this.code = details.code ?? "fetch-failed";
    this.status = details.status;
    this.url = details.url;
  }
}

/**
 * Validate and normalize a user-supplied feed URL.
 * @param {string} input - raw URL.
 * @returns {string} the normalized absolute URL.
 * @throws {FeedFetchError} when the URL is unusable or not http(s).
 */
export function normalizeFeedUrl(input) {
  const raw = typeof input === "string" ? input.trim() : "";
  if (raw.length === 0) throw new FeedFetchError("feed URL is empty", { code: "empty-url" });
  // Accept a bare host/path by assuming https, which is what users paste.
  const candidate = /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(raw) ? raw : `https://${raw}`;
  let parsed;
  try {
    parsed = new URL(candidate);
  } catch {
    throw new FeedFetchError(`not a valid URL: ${raw}`, { code: "invalid-url" });
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new FeedFetchError(`unsupported URL scheme "${parsed.protocol}" (only http and https are supported)`, {
      code: "unsupported-scheme"
    });
  }
  if (parsed.hostname.length === 0) throw new FeedFetchError("URL has no host", { code: "invalid-url" });
  parsed.hash = "";
  return parsed.href;
}

/** Resolve a proxy URL from the environment, if any. */
function proxyFromEnv(env) {
  return env.HTTPS_PROXY ?? env.https_proxy ?? env.HTTP_PROXY ?? env.http_proxy ?? env.ALL_PROXY ?? env.all_proxy ?? "";
}

/** Lazily build a dispatcher for the configured proxy; "" when unavailable. */
let proxyDispatcherPromise;
async function proxyDispatcher(env) {
  const proxy = proxyFromEnv(env);
  if (proxy.length === 0) return undefined;
  if (proxyDispatcherPromise === undefined) {
    proxyDispatcherPromise = (async () => {
      try {
        const { ProxyAgent } = await import("undici");
        return new ProxyAgent({ uri: proxy });
      } catch {
        return undefined;
      }
    })();
  }
  return proxyDispatcherPromise;
}

/** Reset the cached proxy dispatcher (tests, or after an env change). */
export function resetProxyCache() {
  proxyDispatcherPromise = undefined;
}

/**
 * Read a response body with a hard byte cap.
 *
 * Streams the body and aborts as soon as the cap is crossed, so an oversized
 * response never lands in memory in full.
 *
 * @param {Response} response - fetch response with a body.
 * @param {number} maxBytes - cap in bytes.
 * @returns {Promise<Buffer>} the collected body.
 * @throws {FeedFetchError} when the cap is exceeded.
 */
async function readCapped(response, maxBytes) {
  const declared = Number.parseInt(response.headers.get("content-length") ?? "", 10);
  if (Number.isFinite(declared) && declared > maxBytes) {
    throw new FeedFetchError(`response too large (${declared} bytes exceeds the ${maxBytes}-byte limit)`, {
      code: "too-large"
    });
  }
  const body = response.body;
  if (body === null || body === undefined) return Buffer.alloc(0);

  const chunks = [];
  let total = 0;
  const reader = body.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value === undefined) continue;
      total += value.byteLength;
      if (total > maxBytes) {
        throw new FeedFetchError(`response too large (exceeded the ${maxBytes}-byte limit)`, { code: "too-large" });
      }
      chunks.push(Buffer.from(value));
    }
  } finally {
    // Cancelling a partially-read body releases the socket promptly.
    try {
      await reader.cancel();
    } catch {
      /* the stream may already be closed */
    }
  }
  return Buffer.concat(chunks, total);
}

/**
 * Fetch a URL with a timeout, size cap, and optional conditional headers.
 *
 * @param {string} url - absolute http(s) URL.
 * @param {object} [options] - request options.
 * @param {number} [options.timeoutMs] - total request budget.
 * @param {number} [options.maxBytes] - response size cap.
 * @param {string} [options.etag] - previous ETag for a conditional GET.
 * @param {string} [options.lastModified] - previous Last-Modified value.
 * @param {Record<string, string>} [options.headers] - extra request headers.
 * @param {AbortSignal} [options.signal] - caller cancellation.
 * @param {NodeJS.ProcessEnv} [options.env] - environment for proxy resolution.
 * @returns {Promise<{status: number, notModified: boolean, body: string, etag: string,
 *   lastModified: string, contentType: string, finalUrl: string}>} the response.
 * @throws {FeedFetchError} on network, timeout, or size failures.
 */
export async function fetchUrl(url, options = {}) {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
  const env = options.env ?? process.env;

  const headers = {
    "user-agent": USER_AGENT,
    accept: "application/rss+xml, application/atom+xml, application/xml, application/rdf+xml, text/xml, application/json;q=0.8, text/html;q=0.7, */*;q=0.5",
    "accept-language": "zh-CN,zh;q=0.9,en;q=0.8",
    "accept-encoding": "gzip, deflate, br",
    ...(options.headers ?? {})
  };
  if (typeof options.etag === "string" && options.etag.length > 0) headers["if-none-match"] = options.etag;
  if (typeof options.lastModified === "string" && options.lastModified.length > 0) {
    headers["if-modified-since"] = options.lastModified;
  }

  const timer = AbortSignal.timeout(timeoutMs);
  const signal = options.signal === undefined ? timer : AbortSignal.any([timer, options.signal]);
  const dispatcher = await proxyDispatcher(env).catch(() => undefined);

  let response;
  try {
    response = await fetch(url, {
      method: "GET",
      headers,
      redirect: "follow",
      signal,
      ...(dispatcher === undefined ? {} : { dispatcher })
    });
  } catch (error) {
    const name = error instanceof Error ? error.name : "";
    if (name === "TimeoutError" || name === "AbortError") {
      if (options.signal?.aborted === true) throw new FeedFetchError("request cancelled", { code: "aborted", url });
      throw new FeedFetchError(`request timed out after ${timeoutMs}ms`, { code: "timeout", url });
    }
    const cause = error instanceof Error && error.cause instanceof Error ? error.cause : undefined;
    const detail = cause?.message ?? (error instanceof Error ? error.message : String(error));
    throw new FeedFetchError(`network error: ${detail}`, { code: "network", url });
  }

  const finalUrl = response.url.length > 0 ? response.url : url;
  if (response.status === 304) {
    return {
      status: 304,
      notModified: true,
      body: "",
      etag: options.etag ?? "",
      lastModified: options.lastModified ?? "",
      contentType: response.headers.get("content-type") ?? "",
      finalUrl
    };
  }
  if (!response.ok) {
    // Drain/cancel the body so the socket is released before throwing.
    try {
      await response.body?.cancel();
    } catch {
      /* ignore */
    }
    throw new FeedFetchError(`HTTP ${response.status} ${response.statusText}`.trim(), {
      code: RETRY_STATUS.has(response.status) ? "retryable-status" : "http-status",
      status: response.status,
      url: finalUrl
    });
  }

  const contentType = response.headers.get("content-type") ?? "";
  let buffer;
  try {
    buffer = await readCapped(response, maxBytes);
  } catch (error) {
    if (error instanceof FeedFetchError) throw error;
    if (error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError")) {
      throw new FeedFetchError(`request timed out after ${timeoutMs}ms`, { code: "timeout", url: finalUrl });
    }
    throw new FeedFetchError(`failed to read response body: ${error instanceof Error ? error.message : String(error)}`, {
      code: "network",
      url: finalUrl
    });
  }

  // Decode with the declared charset by re-wrapping, keeping one code path.
  const declaredCharset = /charset\s*=\s*["']?([\w-]+)/i.exec(contentType)?.[1];
  const body = decodeBuffer(buffer, declaredCharset);

  return {
    status: response.status,
    notModified: false,
    body,
    etag: response.headers.get("etag") ?? "",
    lastModified: response.headers.get("last-modified") ?? "",
    contentType,
    finalUrl
  };
}

/**
 * Decode a buffer using a charset label, sniffing the document declaration
 * when the header is silent, and falling back to UTF-8.
 * @param {Buffer} buffer - raw bytes.
 * @param {string | undefined} charset - charset from the content type.
 * @returns {string} decoded text.
 */
function decodeBuffer(buffer, charset) {
  let label = (charset ?? "").toLowerCase();
  if (label.length === 0) {
    const head = buffer.subarray(0, 1024).toString("latin1");
    label = (/encoding\s*=\s*["']([\w-]+)["']/i.exec(head)?.[1] ?? "utf-8").toLowerCase();
  }
  if (label === "utf-8" || label === "utf8" || label === "us-ascii" || label === "ascii") return buffer.toString("utf8");
  try {
    return new TextDecoder(label, { fatal: false }).decode(buffer);
  } catch {
    return buffer.toString("utf8");
  }
}

/** Whether a content type looks like an actual feed document. */
function looksLikeFeedContent(contentType) {
  const value = contentType.toLowerCase();
  return value.includes("xml") || value.includes("rss") || value.includes("atom") || value.includes("rdf");
}

/**
 * Fetch and parse a feed, following common discovery paths when the URL turns
 * out to serve HTML.
 *
 * When the target is an HTML page, its `<link rel="alternate">` declarations
 * are consulted and the first one is fetched instead — so a user can paste a
 * site's home page and still subscribe.
 *
 * @param {string} url - feed or site URL.
 * @param {object} [options] - fetch options plus `discover` (default true).
 * @returns {Promise<{feed: object, url: string, finalUrl: string, etag: string,
 *   lastModified: string, notModified: boolean, discoveredFrom?: string}>}
 * @throws {FeedFetchError} when retrieval or parsing fails.
 */
export async function fetchFeed(url, options = {}) {
  const target = normalizeFeedUrl(url);
  const response = await fetchUrl(target, options);

  if (response.notModified) {
    return {
      feed: undefined,
      url: target,
      finalUrl: response.finalUrl,
      etag: response.etag,
      lastModified: response.lastModified,
      notModified: true
    };
  }

  let body = response.body;
  let sourceUrl = response.finalUrl;

  // A page, not a feed: look for an advertised feed and follow it once.
  const isHtml = response.contentType.toLowerCase().includes("html")
    || (!looksLikeFeedContent(response.contentType) && /^\s*<(!doctype\s+html|html)\b/i.test(body));
  if (isHtml && options.discover !== false) {
    const candidates = discoverFeeds(body, sourceUrl);
    if (candidates.length > 0) {
      const discovered = candidates[0].url;
      const followed = await fetchUrl(discovered, options);
      if (followed.notModified) {
        return {
          feed: undefined,
          url: discovered,
          finalUrl: followed.finalUrl,
          etag: followed.etag,
          lastModified: followed.lastModified,
          notModified: true
        };
      }
      body = followed.body;
      sourceUrl = followed.finalUrl;
      try {
        const feed = parseFeed(body, { url: sourceUrl });
        return {
          feed,
          url: discovered,
          finalUrl: followed.finalUrl,
          etag: followed.etag,
          lastModified: followed.lastModified,
          notModified: false,
          discoveredFrom: response.finalUrl
        };
      } catch (error) {
        throw new FeedFetchError(
          `found a feed link at ${discovered} but it did not parse: ${error instanceof Error ? error.message : String(error)}`,
          { code: "parse-failed", url: discovered }
        );
      }
    }
    throw new FeedFetchError(
      "this URL serves an HTML page with no RSS/Atom feed advertised — paste the feed URL instead",
      { code: "not-a-feed", url: response.finalUrl }
    );
  }

  try {
    const feed = parseFeed(body, { url: sourceUrl });
    return {
      feed,
      url: target,
      finalUrl: sourceUrl,
      etag: response.etag,
      lastModified: response.lastModified,
      notModified: false
    };
  } catch (error) {
    throw new FeedFetchError(
      `could not parse a feed at this URL: ${error instanceof Error ? error.message : String(error)}`,
      { code: "parse-failed", url: sourceUrl }
    );
  }
}
