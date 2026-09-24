/**
 * dsh-rss-reader — host half.
 *
 * The Node side of the plugin owns everything the browser cannot do:
 *
 * - **subscription state**, persisted as one atomically-written JSON document
 *   under `$DSH_HOME/rss-reader/feeds.json`;
 * - **feed retrieval** (conditional GET, size caps, timeouts, proxy support);
 * - **an HTTP API** under `/api/rss-reader/*` that the browser panel drives;
 * - **one-click translation** of an item through the harness LLM service;
 * - **an agent tool** `rss_read` so the model can pull the user's feeds into a
 *   conversation on request;
 * - **optional background refresh** on a timer.
 *
 * The browser half (`./client`) registers the panel and the sidebar entry; the
 * two communicate only through the HTTP API, which keeps the boundary explicit
 * and lets the client be developed and tested independently.
 *
 * @module dsh-rss-reader
 */

import z from "schemastery";
import { defineTool } from "@deepseek-ai/dsh-tools";
import { registerApi } from "./api.js";
import { FeedStore, defaultStorePath } from "./store.js";
import { RefreshCoordinator } from "./refresh.js";
import { normalizeFeedUrl } from "./fetch.js";
import { DEFAULT_TARGET, DEFAULT_TRANSLATE_MAX_TOKENS, DEFAULT_TRANSLATE_TIMEOUT_MS, TARGET_LANGUAGES, translateItem } from "./translate.js";
import { backfillHistory } from "./history.js";
import { DEFAULT_BASE as RSSHUB_DEFAULT_BASE, RsshubClient } from "./rsshub.js";
import { CatalogClient } from "./explore.js";

/** Plugin identity for the loader. */
export const name = "rss-reader";

/** Friendly name used in tool results and notices. */
const DISPLAY_NAME = "RSS Reader";

/** Services used when present; the plugin still loads without them. */
export const inject = [];

/** Loader configuration schema. */
export const Config = z.object({
  /** Where the subscription document lives; defaults to `$DSH_HOME/rss-reader/feeds.json`. */
  storeFile: z.string().default(""),
  /** Background refresh interval in minutes; 0 disables the timer. */
  refreshMinutes: z.number().min(0).default(0),
  /** Refresh every feed once at startup. */
  refreshOnStart: z.boolean().default(false),
  /** Per-request timeout. */
  timeoutMs: z.number().min(1000).default(20000),
  /** Response size cap in bytes. */
  maxBytes: z.number().min(1024).default(8 * 1024 * 1024),
  /** Parallel feeds per refresh batch. */
  concurrency: z.number().min(1).default(4),
  /** Items retained per feed. */
  maxItemsPerFeed: z.number().min(1).default(100),
  /** Subscription cap. */
  maxFeeds: z.number().min(1).default(200),
  /** Register the `rss_read` agent tool. */
  tool: z.boolean().default(true),
  /** Serve the web API and the panel. */
  webApi: z.boolean().default(true),
  /**
   * Show the RSS row in the left Sidebar.
   *
   * This is the *default*, not a lock: the same switch lives in DSH's own
   * settings (设置 → 通用 → RSS 阅读器入口), and once the user chooses there
   * their choice is what applies. Set this to `false` to ship the panel with
   * only the right-Sidebar entry.
   */
  showSidebarEntry: z.boolean().default(true),
  /** Enable the one-click translate action. */
  translate: z.boolean().default(true),
  /** Default target language code for translations. */
  translateTarget: z.string().default(DEFAULT_TARGET),
  /** Model provider for translation; empty reuses the session's default model. */
  translateProvider: z.string().default(""),
  /** Model id for translation; empty reuses the session's default model. */
  translateModel: z.string().default(""),
  /**
   * Thinking intensity for translation; empty leaves the model's own default.
   *
   * A reasoning model spends this budget before writing anything, so "high"
   * makes a long article's translation much more likely to hit the output cap.
   */
  translateEffort: z.string().default(""),
  /**
   * Allow fetching older articles from a site's own archive page.
   *
   * Off by default would be safer for other people's servers, but the feature is
   * only ever triggered by an explicit click, so it ships on and stays bounded
   * by `historyMaxPerRun`.
   */
  history: z.boolean().default(true),
  /** Hard ceiling on how many articles one backfill run may fetch. */
  historyMaxPerRun: z.number().min(1).max(500).default(50),
  /** Gap between two article requests during a backfill, in milliseconds. */
  historyDelayMs: z.number().min(0).default(300),
  /** Translation timeout. */
  translateTimeoutMs: z.number().min(1000).default(DEFAULT_TRANSLATE_TIMEOUT_MS),
  /** Output token cap for a translation call; also the floor of the adaptive budget. */
  translateMaxTokens: z.number().min(256).default(DEFAULT_TRANSLATE_MAX_TOKENS),
  /** Offer RSSHub-sourced feeds when adding a subscription. */
  rsshub: z.boolean().default(true),
  /** RSSHub instance base URL; empty uses the official public instance. */
  rsshubBase: z.string().default(""),
  /** Per-request timeout for RSSHub lookups. */
  rsshubTimeoutMs: z.number().min(1000).default(15000),
  /** How long a domain's Radar rules are cached. */
  rsshubCacheMinutes: z.number().min(1).default(360),
  /** Browse and search RSSHub's public route registry ("探索" in the panel). */
  rsshubExplore: z.boolean().default(true),
  /**
   * How long the route registry is cached.
   *
   * Separate from the rules' TTL and far longer by default: the registry is a
   * multi-megabyte document that only changes when the instance is upgraded.
   */
  rsshubCatalogMinutes: z.number().min(1).default(720)
});

/**
 * Format a timestamp for humans, e.g. "2026-09-22 20:15".
 * @param {string} iso - ISO timestamp.
 * @returns {string} a compact local-time label.
 */
function formatWhen(iso) {
  if (typeof iso !== "string" || iso.length === 0) return "never";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "unknown";
  const pad = (value) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/**
 * Render a compact text listing of the store, used by the agent tool.
 *
 * @param {object} state - store snapshot.
 * @param {object} [options] - rendering options.
 * @param {string} [options.feedId] - limit to one feed.
 * @param {number} [options.limit] - max items overall.
 * @param {boolean} [options.unreadOnly] - only unread items.
 * @returns {{text: string, items: Array<object>}} the rendered text and the items shown.
 */
export function renderDigest(state, options = {}) {
  const feeds = Array.isArray(state?.feeds) ? state.feeds : [];
  const selected = options.feedId === undefined
    ? feeds
    : feeds.filter((feed) => feed.id === options.feedId || feed.title === options.feedId);
  if (selected.length === 0) {
    return { text: feeds.length === 0
      ? "No RSS feeds are subscribed yet. Add one in the RSS Reader panel (sidebar → RSS) or with the /rss command."
      : `No feed matched ${JSON.stringify(options.feedId)}.`, items: [] };
  }

  const limit = Math.max(1, options.limit ?? 30);
  const rows = [];
  for (const feed of selected) {
    const items = (feed.items ?? []).filter((item) => options.unreadOnly !== true || item.read !== true);
    for (const item of items) rows.push({ feed, item });
  }
  rows.sort((a, b) => (b.item.date || "").localeCompare(a.item.date || ""));
  const shown = rows.slice(0, limit);

  const lines = [
    `${DISPLAY_NAME}: ${state.totals?.feeds ?? feeds.length} feeds, ${state.totals?.items ?? 0} cached items, ${state.totals?.unread ?? 0} unread.`,
    `Last refresh: ${formatWhen(state.totals?.lastFetched ?? "")}.`,
    ""
  ];

  // With nothing to list — a filter that matched nothing, or feeds that have
  // never been fetched — still name the subscriptions. "What am I subscribed
  // to" must be answerable before the first refresh.
  if (shown.length === 0) {
    const why = options.unreadOnly === true ? "No unread items." : "No cached items yet.";
    lines.push(why, "");
    for (const feed of selected) {
      const status = feed.lastError.length > 0
        ? `refresh error: ${feed.lastError}`
        : feed.itemCount > 0 ? `${feed.itemCount} cached items (all filtered out)` : "never fetched";
      lines.push(`- ${feed.title} — ${status}`);
      if (feed.url.length > 0) lines.push(`    ${feed.url}`);
    }
    return { text: lines.join("\n"), items: [] };
  }

  let currentFeed = "";
  for (const { feed, item } of shown) {
    if (feed.id !== currentFeed) {
      currentFeed = feed.id;
      lines.push(`## ${feed.title}${feed.lastError.length > 0 ? " (refresh error)" : ""}`);
      if (feed.lastError.length > 0) lines.push(`   ! ${feed.lastError}`);
    }
    const when = item.date.length > 0 ? item.date.slice(0, 16).replace("T", " ") : "no date";
    lines.push(`- [${item.read ? "x" : " "}] ${item.title}`);
    lines.push(`    ${when}${item.author.length > 0 ? ` · ${item.author}` : ""}`);
    if (item.link.length > 0) lines.push(`    ${item.link}`);
  }
  if (rows.length > shown.length) lines.push(`... and ${rows.length - shown.length} more items.`);

  return {
    text: lines.join("\n"),
    items: shown.map(({ feed, item }) => ({
      feedId: feed.id,
      feedTitle: feed.title,
      title: item.title,
      link: item.link,
      date: item.date,
      author: item.author,
      summary: item.summary,
      read: item.read === true,
      starred: item.starred === true
    }))
  };
}

/**
 * Apply the plugin.
 *
 * @param {import("@deepseek-ai/cordis").Context} ctx - harness context.
 * @param {ReturnType<typeof Config>} config - validated config.
 */
export function apply(ctx, config) {
  const storeFile = config.storeFile.length > 0 ? config.storeFile : defaultStorePath();
  const store = new FeedStore({
    file: storeFile,
    maxItemsPerFeed: config.maxItemsPerFeed,
    maxFeeds: config.maxFeeds
  });
  const coordinator = new RefreshCoordinator();
  let timer;
  let disposed = false;

  /** Fetch options shared by every network call. */
  const fetchOptions = () => ({
    timeoutMs: config.timeoutMs,
    maxBytes: config.maxBytes,
    concurrency: config.concurrency
  });

  /** Refresh options for a batch. */
  const refreshOptions = (extra = {}) => ({ ...fetchOptions(), ...extra });

  // ── translation ────────────────────────────────────────────────────────
  // The LLM service and the session's default model are optional: without them
  // the reader still works and the UI hides the translate action, rather than
  // offering a button that can only fail.
  let llmService;
  let defaultModel;
  if (config.translate) {
    ctx.inject(["llm"], (llmCtx) => {
      llmService = llmCtx.llm;
    });
    // `agentDefaultModel` is absent in headless compositions, so it is injected
    // separately and its absence is tolerated.
    try {
      ctx.inject(["agentDefaultModel"], (modelCtx) => {
        defaultModel = modelCtx.agentDefaultModel;
      });
    } catch {
      defaultModel = undefined;
    }
  }

  /**
   * Resolve the model route for translation.
   *
   * Three layers, most specific first: the reader's own choice in
   * 设置 → RSS 阅读器, then the plugin config, then the session's default model.
   * The provider and model move as a pair — taking one from a preference and the
   * other from config would name a route that may not exist — while the thinking
   * intensity is independent, because it applies to whichever route wins.
   *
   * @returns {{provider: string, model: string, effort: string}} the route.
   */
  const translateRoute = () => {
    const prefs = store.prefs();
    const prefProvider = typeof prefs.translateProvider === "string" ? prefs.translateProvider : "";
    const prefModel = typeof prefs.translateModel === "string" ? prefs.translateModel : "";
    const prefEffort = typeof prefs.translateEffort === "string" ? prefs.translateEffort : "";

    let provider = "";
    let model = "";
    if (prefProvider.length > 0 && prefModel.length > 0) {
      provider = prefProvider;
      model = prefModel;
    } else if (config.translateProvider.length > 0 && config.translateModel.length > 0) {
      provider = config.translateProvider;
      model = config.translateModel;
    } else {
      try {
        const selection = defaultModel?.currentSelection?.();
        if (selection?.provider !== undefined && selection?.model !== undefined) {
          provider = selection.provider;
          model = selection.model;
        }
      } catch {
        /* fall through to the unavailable state */
      }
    }
    // An unchosen intensity stays empty: the adapter's own default is the right
    // answer then, and naming one here would override a deployment's choice.
    const effort = prefEffort.length > 0 ? prefEffort : config.translateEffort;
    return { provider, model, effort };
  };

  /**
   * The translator surface handed to the API: `describe()` reports availability
   * (so the UI can hide the action) and `translate()` performs one call.
   */
  const translator = config.translate ? {
    describe() {
      const route = translateRoute();
      if (llmService === undefined || llmService === null) {
        return { available: false, reason: "the harness LLM service is not mounted in this profile" };
      }
      if (route.provider.length === 0 || route.model.length === 0) {
        return { available: false, reason: "no model is configured for translation" };
      }
      return { available: true, provider: route.provider, model: route.model, targets: TARGET_LANGUAGES };
    },
    async translate(input) {
      const route = translateRoute();
      return translateItem(
        { llm: llmService, provider: route.provider, model: route.model, effort: route.effort },
        {
          ...input,
          target: input.target ?? config.translateTarget,
          timeoutMs: config.translateTimeoutMs,
          maxTokens: config.translateMaxTokens
        }
      );
    }
  } : undefined;

  /**
   * The model routes the reader may choose for translation.
   *
   * Prefers the harness's own catalog projection, which already resolves each
   * model's selectable thinking intensities. Fallback is the raw registry (a
   * composition without the session controller still gets a provider/model list,
   * just without effort metadata). Reference-based lookups rather than a
   * captured value, so a provider registered later is picked up.
   *
   * @returns {Promise<{ok: boolean, error?: string, catalog?: object}>} the catalog.
   */
  const resolveModelCatalog = async () => {
    const controller = ctx.get("sessionController");
    if (controller !== undefined && typeof controller.modelCatalog === "function") {
      try {
        const catalog = await controller.modelCatalog();
        if (catalog !== null && typeof catalog === "object") return { ok: true, catalog };
      } catch (error) {
        // A broken provider lookup must not hide the ones that work, but if the
        // whole projection fails the registry below is still worth trying.
        ctx.logger?.warn?.(`[rss-reader] model catalog failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    if (llmService === undefined || llmService === null) {
      return { ok: false, error: "LLM 服务没有挂载在这个 profile 里，无法列出可选模型" };
    }
    try {
      const providers = llmService.listProviders();
      const groups = [];
      for (const provider of providers) {
        let models = [];
        try {
          const listed = await llmService.listModels(provider.id);
          models = (listed ?? []).map((model) => ({ id: model.id, name: model.name }));
        } catch {
          models = [];
        }
        groups.push({ id: provider.id, name: provider.name, models });
      }
      const current = translateRoute();
      return {
        ok: true,
        catalog: {
          default: { provider: current.provider, model: current.model, reasoningEffort: current.effort },
          routableProviders: providers.map((provider) => provider.id),
          groups,
          failures: []
        }
      };
    } catch (error) {
      return { ok: false, error: `无法读取模型目录：${error instanceof Error ? error.message : String(error)}` };
    }
  };

  // ── RSSHub discovery ───────────────────────────────────────────────────
  // The instance the RSSHub features talk to. The plugin config sets the
  // default; the reader can point it elsewhere from 设置 → RSS 阅读器, which is
  // the whole reason this is not just a config value — the official instance is
  // unreachable from some networks, and finding a reachable mirror should not
  // mean editing the profile and restarting.
  const configuredBase = config.rsshubBase.length > 0 ? config.rsshubBase : RSSHUB_DEFAULT_BASE;
  const prefBase = store.prefs().rsshubBase;
  let rsshubBase = typeof prefBase === "string" && prefBase.length > 0 ? prefBase : configuredBase;

  // Many sites publish no feed of their own; RSSHub's Radar rules map a page
  // URL to a route that generates one. The client is optional: when disabled,
  // discovery simply reports the page's own feeds.
  let rsshub;
  if (config.rsshub) {
    try {
      rsshub = new RsshubClient({
        base: rsshubBase,
        timeoutMs: config.rsshubTimeoutMs,
        cacheTtlMs: config.rsshubCacheMinutes * 60_000
      });
    } catch (error) {
      // A typo in the optional base URL must not fail the whole plugin tree at
      // boot; the reader stays usable and discovery reports why it is off.
      ctx.logger?.warn?.(`[rss-reader] RSSHub discovery disabled: ${error instanceof Error ? error.message : String(error)}`);
      rsshub = undefined;
    }
  }

  // The route registry behind "探索": the same instance, but a different
  // question — not "what can I subscribe to here?" but "what has the community
  // already collected?". Disabled independently, because it is a multi-megabyte
  // read that a slow instance should not be made to pay for.
  let catalog;
  if (config.rsshub && config.rsshubExplore) {
    try {
      catalog = new CatalogClient({
        base: rsshubBase,
        // The registry is one big document, so it gets a longer leash than a
        // single rules lookup.
        timeoutMs: Math.max(config.rsshubTimeoutMs, 30000),
        cacheTtlMs: config.rsshubCatalogMinutes * 60_000
      });
    } catch (error) {
      ctx.logger?.warn?.(`[rss-reader] RSSHub explore disabled: ${error instanceof Error ? error.message : String(error)}`);
      catalog = undefined;
    }
  }

  /**
   * Adopt the instance URL a preference change asked for.
   *
   * Both clients move together, and each drops the caches it filled from the
   * old host. A value that cannot be used is refused here rather than at the
   * next request: the reader gets the error, and the working instance stays.
   *
   * @param {object} prefs - the effective preferences.
   * @returns {void}
   */
  const adoptRsshubBase = (prefs) => {
    const wanted = typeof prefs.rsshubBase === "string" && prefs.rsshubBase.length > 0
      ? prefs.rsshubBase
      : configuredBase;
    if (wanted === rsshubBase) return;
    try {
      rsshub?.useBase(wanted);
      catalog?.useBase(wanted);
      rsshubBase = wanted;
      ctx.logger?.info?.(`[rss-reader] RSSHub 实例已切换为 ${wanted}`);
    } catch (error) {
      ctx.logger?.warn?.(`[rss-reader] 未能切换 RSSHub 实例：${error instanceof Error ? error.message : String(error)}`);
    }
  };

  // ── startup ────────────────────────────────────────────────────────────
  ctx.effect(() => {
    let cancelled = false;
    void (async () => {
      await store.load();
      if (cancelled || disposed) return;
      // The stored instance URL can only be honoured once the file has been
      // read, and `/prefs` reports it from that moment on — so the clients have
      // to catch up here, or the panel would show one host while fetching from
      // another.
      adoptRsshubBase(store.prefs());
      if (config.refreshOnStart && store.list().length > 0) {
        void coordinator.run(store, refreshOptions());
      }
    })().catch((error) => {
      ctx.logger?.warn?.(`[rss-reader] failed to load subscriptions: ${error instanceof Error ? error.message : String(error)}`);
    });

    return () => {
      cancelled = true;
      disposed = true;
      if (timer !== undefined) clearInterval(timer);
      timer = undefined;
      void store.dispose();
    };
  }, "rss-reader: store lifecycle");

  // ── background refresh ─────────────────────────────────────────────────
  if (config.refreshMinutes > 0) {
    ctx.effect(() => {
      const intervalMs = Math.max(60_000, config.refreshMinutes * 60_000);
      timer = setInterval(() => {
        if (disposed || store.list().length === 0) return;
        void coordinator.run(store, refreshOptions()).catch(() => {
          /* per-feed errors are already recorded on the store */
        });
      }, intervalMs);
      // The timer must not keep the process alive on its own.
      timer.unref?.();
      return () => {
        if (timer !== undefined) clearInterval(timer);
        timer = undefined;
      };
    }, "rss-reader: refresh timer");
  }

  // ── agent tool ─────────────────────────────────────────────────────────
  // Every service is reached through `ctx.inject` rather than read off `ctx`
  // directly: Cordis refuses a bare property access on an undeclared service
  // ("cannot get property ... without inject"), and injecting also makes the
  // registration wait for the service to exist.
  if (config.tool) {
    ctx.inject(["tools"], (toolCtx) => {
      toolCtx.tools.register(defineTool({
        name: "rss_read",
        description: "Read the user's subscribed RSS/Atom feeds. Returns feeds, unread counts and the most recent items with links. Use when the user asks about their feeds, news, or subscriptions, or wants a digest of recent articles. Set `refresh` to pull the latest from the network first.",
        parameters: {
          feedId: {
            type: "string",
            description: "Limit the listing to one feed (its id or exact title). Omit for all feeds."
          },
          limit: {
            type: "integer",
            description: "Maximum number of items to list (default 30)."
          },
          unreadOnly: {
            type: "boolean",
            description: "Only list items not yet marked read."
          },
          refresh: {
            type: "boolean",
            description: "Fetch the latest items from the network before listing."
          }
        },
        output: {
          schema: {
            type: "object",
            additionalProperties: false,
            properties: {
              text: { type: "string", required: true, description: "Human-readable digest." },
              feeds: { type: "integer", required: true, description: "Number of subscribed feeds." },
              unread: { type: "integer", required: true, description: "Total unread items." },
              items: {
                type: "array",
                required: true,
                description: "Items included in the digest.",
                items: {
                  type: "object",
                  additionalProperties: false,
                  properties: {
                    feedId: { type: "string", required: true },
                    feedTitle: { type: "string", required: true },
                    title: { type: "string", required: true },
                    link: { type: "string", required: true },
                    date: { type: "string", required: true },
                    author: { type: "string", required: true },
                    summary: { type: "string", required: true },
                    read: { type: "boolean", required: true },
                    starred: { type: "boolean", required: true }
                  }
                }
              }
            }
          },
          render: (_args, value) => [{ type: "text", text: value.text }]
        },
        async execute(args, exec) {
          await store.load();
          if (args?.refresh === true) {
            await coordinator.run(store, refreshOptions({ ids: args.feedId === undefined ? undefined : [args.feedId] }));
          }
          const state = store.snapshot();
          const digest = renderDigest(state, {
            feedId: args?.feedId,
            limit: typeof args?.limit === "number" ? args.limit : undefined,
            unreadOnly: args?.unreadOnly === true
          });
          return {
            text: digest.text,
            feeds: state.totals.feeds,
            unread: state.totals.unread,
            items: digest.items
          };
        },
        presentCall: (args) => ({
          card: "generic",
          title: args?.refresh === true ? "Refresh and read RSS feeds" : "Read RSS feeds",
          kind: "read",
          rawInput: args
        })
      }));
    });
  }

  // ── system-prompt hint ─────────────────────────────────────────────────
  if (config.tool) {
    ctx.inject(["systemPrompt"], (promptCtx) => {
      promptCtx.systemPrompt.section({
        name: "rss-reader",
        order: 210,
        text: "The user may subscribe to RSS/Atom feeds, browsable in the dedicated RSS Reader panel. Call `rss_read` when they ask about their feeds, subscriptions, or recent news from them; pass `refresh: true` when freshness matters."
      });
    });
  }

  // ── slash command ──────────────────────────────────────────────────────
  ctx.inject(["commands"], (commandCtx) => {
    commandCtx.commands.register({
      name: "rss",
      description: "list subscribed RSS feeds, or refresh them (`/rss refresh`)",
      input: { hint: "[refresh] [feed id or title]" },
      handler: async (invocation) => {
        const tokens = (invocation.rawInput ?? "").trim().split(/\s+/).filter(Boolean);
        const wantsRefresh = tokens[0] === "refresh" || tokens[0] === "-r";
        const target = wantsRefresh ? tokens.slice(1).join(" ") : tokens.join(" ");
        try {
          await store.load();
          let summary;
          if (wantsRefresh) summary = await coordinator.run(store, refreshOptions());
          const state = store.snapshot();
          const digest = renderDigest(state, { feedId: target.length > 0 ? target : undefined, limit: 40 });
          const footer = summary === undefined
            ? ""
            : `\n\nRefreshed ${summary.refreshed}/${summary.results.length} feeds, ${summary.added} new items${summary.failed > 0 ? `, ${summary.failed} failed` : ""}.`;
          return { kind: "success", text: digest.text + footer };
        } catch (error) {
          return { kind: "error", text: `RSS refresh failed: ${error instanceof Error ? error.message : String(error)}` };
        }
      }
    });
  });

  // ── web API (web profile only) ─────────────────────────────────────────
  if (config.webApi) {
    ctx.inject(["webServer"], (apiCtx) => {
      apiCtx.effect(() => {
        const disposers = registerApi(apiCtx, {
          store,
          coordinator,
          translator,
          rsshub,
          catalog,
          prefDefaults: {
            showSidebarEntry: config.showSidebarEntry,
            // The *configured* default, not the base in force: clearing the
            // field must fall back to the plugin config, not to whatever was
            // stored when this process started.
            rsshubBase: configuredBase
          },
          onPrefsChanged: adoptRsshubBase,
          modelCatalog: resolveModelCatalog,
          // A feed is a window, not an archive: this is how a reader reaches
          // articles the feed itself stopped carrying.
          backfill: config.history
            ? (options) => backfillHistory({ ...options, timeoutMs: config.timeoutMs, delayMs: config.historyDelayMs })
            : undefined,
          historyMaxLimit: config.historyMaxPerRun,
          status: () => ({
            storeFile,
            refreshMinutes: config.refreshMinutes,
            refreshing: coordinator.busy,
            translated: store.snapshot({ withItems: false }).totals.translated,
            defaultTarget: config.translateTarget,
            rsshub: rsshub === undefined ? "" : rsshub.base
          })
        });
        return () => {
          for (const dispose of disposers) dispose();
        };
      }, "rss-reader: http api");
    });
  }
}

export { normalizeFeedUrl };
