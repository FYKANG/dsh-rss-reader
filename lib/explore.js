/**
 * dsh-rss-reader — the RSSHub route catalogue ("探索").
 *
 * Discovery by URL (see `rsshub.js`) answers "what can I subscribe to here?".
 * This answers the other question a reader has: "what have other people
 * already collected that I might want?" — RSSHub's whole public route
 * registry, browsable by category and searchable, with the parameters of each
 * route spelled out so one click can produce a working feed URL.
 *
 * The registry is one 3 MB JSON document (`GET /api/namespace` with no
 * argument). That is far too much to hand a browser panel on every open, so
 * the host fetches it once, projects it into a compact searchable shape, keeps
 * it in memory for a long TTL, and serves pages of that projection instead.
 *
 * @module dsh-rss-reader/explore
 */

import { normalizeBase } from "./rsshub.js";

/**
 * How long a fetched catalogue stays fresh.
 *
 * Much longer than the Radar rules' TTL: the registry only changes when the
 * instance is upgraded, and re-reading it costs megabytes.
 */
export const DEFAULT_CATALOG_TTL_MS = 12 * 60 * 60 * 1000;

/** Cap on one `/explore` response page. */
export const MAX_PAGE = 100;

/** Default page size. */
export const DEFAULT_PAGE = 30;

/**
 * Chinese labels for RSSHub's own category slugs.
 *
 * The slug is the contract (`lib/types.ts` fixes the union); the label is
 * presentation, so an unlisted slug falls back to the slug itself rather than
 * disappearing from the UI.
 */
export const CATEGORY_LABELS = {
  popular: "热门",
  "social-media": "社交媒体",
  "new-media": "新媒体",
  "traditional-media": "传统媒体",
  bbs: "论坛",
  blog: "博客",
  programming: "编程",
  design: "设计",
  live: "直播",
  multimedia: "多媒体",
  picture: "图片",
  anime: "二次元",
  "program-update": "程序更新",
  university: "大学",
  forecast: "预报",
  travel: "出行",
  shopping: "购物",
  game: "游戏",
  reading: "阅读",
  government: "政务",
  study: "学习",
  journal: "期刊",
  finance: "财经",
  sport: "运动",
  other: "其他"
};

/**
 * The order the category chips are offered in.
 *
 * RSSHub's own declaration order, so the picker reads the way the project's
 * documentation does.
 */
export const CATEGORY_ORDER = [
  "popular",
  "social-media",
  "new-media",
  "traditional-media",
  "bbs",
  "blog",
  "programming",
  "design",
  "live",
  "multimedia",
  "picture",
  "anime",
  "program-update",
  "university",
  "forecast",
  "travel",
  "shopping",
  "game",
  "reading",
  "government",
  "study",
  "journal",
  "finance",
  "sport",
  "other"
];

/** Label for a category slug, falling back to the slug itself. */
export function categoryLabel(slug) {
  return CATEGORY_LABELS[slug] ?? slug;
}

/**
 * Collapse a Markdown description into one readable line.
 *
 * Route descriptions are documentation: prose paragraphs, `<details>` tables,
 * `::: warning` callouts and links. What a list row needs is the first
 * sentence that actually describes the route, so tables and code fences are
 * dropped rather than truncated mid-cell.
 *
 * @param {unknown} value - the raw description.
 * @param {number} max - character cap.
 * @returns {string} a single line, or "".
 */
export function oneLine(value, max) {
  if (typeof value !== "string" || value.length === 0) return "";
  const text = value
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/:::[^\n]*[\s\S]*?:::/g, " ")
    .split("\n")
    .filter((line) => !line.trim().startsWith("|"))
    .join(" ")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/[*_`>#]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  if (text.length <= max) return text;
  return `${text.slice(0, Math.max(1, max - 1))}…`;
}

/**
 * Split a route path into its literal and parameter segments.
 *
 * RSSHub paths spell parameters as `:name`, with two suffixes that matter here:
 * `?` marks the parameter optional, and `{...}` attaches a pattern — a greedy
 * one (`{.+}`) can span slashes, so it must never be split apart.
 *
 * @param {string} path - a route path such as `/trending/:since/:language?`.
 * @returns {Array<{kind: "literal" | "param", value: string, name: string,
 *   optional: boolean, greedy: boolean}>} the segments, in order.
 */
export function parseRoutePath(path) {
  const raw = String(path ?? "");
  const segments = raw.split("/").filter((segment) => segment.length > 0);
  return segments.map((segment) => {
    const match = /^:([A-Za-z0-9_]+)(\{[\s\S]*\})?(\?)?$/.exec(segment);
    if (match === null) return { kind: "literal", value: segment, name: "", optional: false, greedy: false };
    return {
      kind: "param",
      value: segment,
      name: match[1],
      optional: match[3] === "?",
      greedy: match[2] !== undefined
    };
  });
}

/**
 * How many leading parameters a URL must supply.
 *
 * An optional parameter that sits *before* a required one cannot simply be
 * dropped — the path would lose its shape — so everything up to the last
 * required parameter is treated as needed, and only the trailing optionals may
 * be left out. This mirrors how RSSHub's own examples are written.
 *
 * @param {Array<object>} segments - from {@link parseRoutePath}.
 * @returns {number} the number of leading segments that must carry a value.
 */
function neededThrough(segments) {
  let last = -1;
  segments.forEach((segment, index) => {
    if (segment.kind === "param" && !segment.optional) last = index;
  });
  return last + 1;
}

/**
 * Build a concrete route path from parameter values.
 *
 * The result is namespace-relative, like the template: the caller prepends the
 * namespace to reach a real feed URL.
 *
 * @param {string} path - the route template.
 * @param {Record<string, string>} [values] - one value per parameter name.
 * @returns {string | null} the path, or null when a needed value is missing.
 */
export function fillRoutePath(path, values = {}) {
  const segments = parseRoutePath(path);
  const needed = neededThrough(segments);
  const out = [];
  for (let index = 0; index < segments.length; index += 1) {
    const segment = segments[index];
    if (segment.kind === "literal") {
      out.push(segment.value);
      continue;
    }
    const value = String(values[segment.name] ?? "").trim();
    if (value.length === 0) {
      // A trailing optional without a value ends the path: RSSHub reads the
      // absent tail as "not set", which is exactly what the user chose.
      if (index >= needed) break;
      return null;
    }
    out.push(value.replace(/^\/+|\/+$/g, ""));
  }
  return out.length === 0 ? null : `/${out.join("/")}`;
}

/**
 * Which needed parameters still have no value.
 *
 * Separate from {@link fillRoutePath} so the refusal can say *what* is missing
 * instead of just declining.
 *
 * @param {string} path - the route template.
 * @param {Record<string, string>} [values] - the values supplied so far.
 * @returns {string[]} the names, in path order.
 */
export function missingParameters(path, values = {}) {
  const segments = parseRoutePath(path);
  const needed = neededThrough(segments);
  const missing = [];
  segments.forEach((segment, index) => {
    if (segment.kind !== "param" || index >= needed) return;
    if (String(values[segment.name] ?? "").trim().length === 0) missing.push(segment.name);
  });
  return missing;
}

/**
 * Read parameter values back out of a route's own example.
 *
 * Every route ships a working `example` path (`/github/trending/daily/javascript/en`),
 * which is the difference between "here is a route" and "here is a feed you can
 * subscribe to right now". Recovering the values lets the UI prefill the form,
 * so the common case is a single click.
 *
 * @param {string} path - the route template, without the namespace.
 * @param {string} example - the example path, with the namespace.
 * @param {string} namespace - the namespace the example should start with.
 * @returns {Record<string, string> | null} the values, or null when the
 *   example does not line up with the template.
 */
export function exampleValues(path, example, namespace) {
  if (typeof example !== "string" || example.length === 0) return null;
  const segments = parseRoutePath(path);
  const exampleSegments = String(example).split("/").filter((segment) => segment.length > 0);
  // The example carries the namespace as its first segment; the template does
  // not. A mismatch means the two are not describing the same thing.
  if (exampleSegments[0] !== namespace) return null;
  const tail = exampleSegments.slice(1);
  const values = {};
  let cursor = 0;
  for (const segment of segments) {
    if (cursor >= tail.length) {
      if (segment.kind === "literal" || segment.optional) continue;
      return null;
    }
    if (segment.kind === "literal") {
      if (tail[cursor] !== segment.value) return null;
      cursor += 1;
      continue;
    }
    if (segment.greedy) {
      values[segment.name] = tail.slice(cursor).join("/");
      cursor = tail.length;
      continue;
    }
    values[segment.name] = tail[cursor];
    cursor += 1;
  }
  // Extra example segments cannot be explained by the template.
  return cursor === tail.length ? values : null;
}

/**
 * Describe one parameter for the fill-in form.
 *
 * @param {string} name - parameter name.
 * @param {boolean} optional - whether the path marks it optional.
 * @param {unknown} spec - the raw metadata (a string, or an object).
 * @param {boolean} greedy - whether it may contain slashes.
 * @returns {object} the UI-facing record.
 */
function normalizeParameter(name, optional, spec, greedy) {
  const detail = spec !== null && typeof spec === "object" && !Array.isArray(spec) ? spec : {};
  const text = typeof spec === "string" ? spec : (typeof detail.description === "string" ? detail.description : "");
  const options = Array.isArray(detail.options)
    ? detail.options
        .filter((option) => option !== null && typeof option === "object" && typeof option.value === "string")
        .slice(0, 40)
        .map((option) => ({
          value: option.value,
          label: typeof option.label === "string" && option.label.length > 0 ? option.label : option.value
        }))
    : [];
  return {
    name,
    optional,
    greedy,
    description: oneLine(text, 200),
    default: detail.default === undefined || detail.default === null ? "" : String(detail.default),
    options
  };
}

/**
 * The parameters of a route, in path order.
 *
 * Path order is the only order that can be rendered as a form, and the path is
 * also the authority on which parameters are optional. Metadata keys that the
 * path never mentions are dropped: there is no way to place them in the URL,
 * and guessing would produce a feed URL that silently means something else.
 *
 * @param {string} path - the route template.
 * @param {unknown} raw - the route's `parameters` object.
 * @returns {Array<object>} UI-facing parameter records.
 */
export function routeParameters(path, raw) {
  const meta = raw !== null && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
  return parseRoutePath(path)
    .filter((segment) => segment.kind === "param")
    .map((segment) => normalizeParameter(segment.name, segment.optional, meta[segment.name], segment.greedy));
}

/**
 * The names of the instance-side configuration a route needs.
 *
 * A route needing `GITHUB_ACCESS_TOKEN` or a cookie cannot work on a public
 * instance. Saying so up front is the difference between "this route is
 * broken" and "this route needs a self-hosted instance".
 *
 * @param {unknown} features - the route's `features` object.
 * @returns {{ config: string[], antiCrawler: boolean, puppeteer: boolean,
 *   bt: boolean, podcast: boolean }} the badges the row should show.
 */
export function routeFlags(features) {
  const record = features !== null && typeof features === "object" && !Array.isArray(features) ? features : {};
  const config = Array.isArray(record.requireConfig)
    ? record.requireConfig
        .map((entry) => {
          if (typeof entry === "string") return entry;
          if (entry !== null && typeof entry === "object" && typeof entry.name === "string") return entry.name;
          return "";
        })
        .filter((name) => name.length > 0)
    : [];
  return {
    config,
    antiCrawler: record.antiCrawler === true,
    puppeteer: record.requirePuppeteer === true,
    bt: record.supportBT === true,
    podcast: record.supportPodcast === true
  };
}

/**
 * Project the instance's raw registry into the searchable catalogue.
 *
 * @param {unknown} raw - the parsed `GET /api/namespace` body.
 * @returns {{namespaces: Array<object>, routes: Array<object>, categories: Array<object>,
 *   totals: {namespaces: number, routes: number, routesWithExample: number}}}
 *   the catalogue.
 */
export function buildCatalog(raw) {
  const source = raw !== null && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
  const namespaces = [];
  const routes = [];
  const counts = new Map();
  let routesWithExample = 0;

  for (const [id, entry] of Object.entries(source)) {
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) continue;
    const site = typeof entry.name === "string" && entry.name.length > 0 ? entry.name : id;
    const url = typeof entry.url === "string" ? entry.url : "";
    const lang = typeof entry.lang === "string" ? entry.lang : "";
    const declared = Array.isArray(entry.categories) ? entry.categories.filter((c) => typeof c === "string") : [];
    const rawRoutes = entry.routes !== null && typeof entry.routes === "object" && !Array.isArray(entry.routes) ? entry.routes : {};
    const seen = new Set();
    let count = 0;

    for (const [path, route] of Object.entries(rawRoutes)) {
      if (route === null || typeof route !== "object" || Array.isArray(route)) continue;
      const categories = (Array.isArray(route.categories) ? route.categories : declared).filter((c) => typeof c === "string");
      for (const category of categories) {
        if (!seen.has(category)) {
          seen.add(category);
          counts.set(category, (counts.get(category) ?? 0) + 1);
        }
      }
      const example = typeof route.example === "string" ? route.example : "";
      if (example.length > 0) routesWithExample += 1;
      const name = typeof route.name === "string" && route.name.length > 0 ? route.name : path;
      const description = oneLine(route.description, 240);
      const parameters = routeParameters(path, route.parameters);
      const flags = routeFlags(route.features);
      const record = {
        namespace: id,
        site,
        url,
        lang,
        path,
        name,
        example,
        description,
        categories,
        parameters,
        flags,
        /** Prefilled values recovered from the route's own example, when they line up. */
        values: example.length > 0 ? exampleValues(path, example, id) : null,
        /** Lowercased haystack, built once: search runs on every keystroke. */
        search: `${name} ${path} ${id} ${site} ${url} ${description}`.toLowerCase()
      };
      routes.push(record);
      count += 1;
    }

    namespaces.push({
      id,
      name: site,
      url,
      lang,
      categories: declared.length > 0 ? declared : [...seen],
      routes: count
    });
  }

  namespaces.sort((a, b) => b.routes - a.routes || a.id.localeCompare(b.id));
  const categories = [...counts.entries()]
    .map(([id, count]) => ({ id, label: categoryLabel(id), count }))
    .sort((a, b) => b.count - a.count || a.id.localeCompare(b.id));

  return {
    namespaces,
    routes,
    categories,
    /** `namespace + path` → route, so one route can be looked up without a scan. */
    index: new Map(routes.map((route) => [`${route.namespace} ${route.path}`, route])),
    totals: { namespaces: namespaces.length, routes: routes.length, routesWithExample }
  };
}

/**
 * Rank one route against a search query.
 *
 * A reader typing "github" wants the GitHub namespace's routes before a route
 * that merely mentions GitHub in its description, so the score is about where
 * the match landed, not how many times it appears.
 *
 * @param {object} route - a catalogue route record.
 * @param {string} needle - the lowercased query.
 * @returns {number} lower is better; -1 means "no match".
 */
function scoreRoute(route, needle) {
  const namespace = route.namespace.toLowerCase();
  const name = route.name.toLowerCase();
  if (namespace === needle || name === needle) return 0;
  if (namespace.startsWith(needle) || name.startsWith(needle)) return 1;
  if (namespace.includes(needle)) return 2;
  if (name.includes(needle)) return 3;
  if (route.path.toLowerCase().includes(needle)) return 4;
  if (route.search.includes(needle)) return 5;
  return -1;
}

/**
 * Answer one browse/search request against a catalogue.
 *
 * One shape serves the whole picker: the caller either has no filter (browse
 * the namespace list), a category (browse the namespaces in it), a namespace
 * (list its routes), or a query (search everything).
 *
 * @param {object} catalog - from {@link buildCatalog}.
 * @param {object} [options] - the request.
 * @param {string} [options.q] - search text.
 * @param {string} [options.namespace] - restrict to one namespace.
 * @param {string} [options.category] - restrict to one category.
 * @param {number} [options.limit] - page size.
 * @param {number} [options.offset] - page offset.
 * @returns {{total: number, offset: number, limit: number, routes: Array<object>,
 *   namespaces: Array<object>, namespaceTotal: number, categories: Array<object>}} the page.
 */
export function queryCatalog(catalog, options = {}) {
  const query = typeof options.q === "string" ? options.q.trim().toLowerCase() : "";
  const namespace = typeof options.namespace === "string" ? options.namespace : "";
  const category = typeof options.category === "string" ? options.category : "";
  const limit = Math.min(MAX_PAGE, Math.max(1, options.limit ?? DEFAULT_PAGE));
  const offset = Math.max(0, options.offset ?? 0);

  /** Whether a route passes the hard filters (everything but the query). */
  const passes = (route) =>
    (namespace.length === 0 || route.namespace === namespace)
    && (category.length === 0 || route.categories.includes(category));

  let candidates = catalog.routes.filter(passes);
  if (query.length > 0) {
    const scored = [];
    for (const route of candidates) {
      const score = scoreRoute(route, query);
      if (score >= 0) scored.push({ route, score });
    }
    scored.sort((a, b) =>
      a.score - b.score
      || b.route.name.length - a.route.name.length
      || a.route.namespace.localeCompare(b.route.namespace)
      || a.route.name.localeCompare(b.route.name));
    candidates = scored.map((entry) => entry.route);
  } else {
    candidates = [...candidates].sort((a, b) =>
      a.namespace.localeCompare(b.namespace)
      || a.name.localeCompare(b.name)
      || a.path.localeCompare(b.path));
  }

  // The namespace list is the level above the route list: it only makes sense
  // where the caller has not already chosen one.
  let namespaces = [];
  if (namespace.length === 0) {
    namespaces = catalog.namespaces.filter((entry) =>
      (category.length === 0 || entry.categories.includes(category))
      && (query.length === 0
        || entry.id.toLowerCase().includes(query)
        || entry.name.toLowerCase().includes(query)
        || entry.url.toLowerCase().includes(query)));
    // A query is about finding one thing, so the matching namespaces lead;
    // otherwise the richest namespaces lead, because an empty picker helps
    // nobody.
    if (query.length > 0) {
      namespaces = [...namespaces].sort((a, b) =>
        Number(!a.id.toLowerCase().startsWith(query)) - Number(!b.id.toLowerCase().startsWith(query))
        || b.routes - a.routes
        || a.id.localeCompare(b.id));
    }
  }

  return {
    total: candidates.length,
    offset,
    limit,
    routes: candidates.slice(offset, offset + limit),
    namespaces: namespaces.slice(0, 60),
    namespaceTotal: namespaces.length,
    categories: catalog.categories
  };
}

/**
 * The RSSHub route catalogue, fetched once and kept warm.
 *
 * One instance per plugin: the payload is megabytes, so concurrent callers
 * share a single in-flight fetch rather than racing for it.
 */
export class CatalogClient {
  /**
   * @param {object} [options] - client options.
   * @param {string} [options.base] - RSSHub instance base URL.
   * @param {number} [options.timeoutMs] - per-request timeout.
   * @param {number} [options.cacheTtlMs] - how long the catalogue stays fresh.
   * @param {Function} [options.fetchImpl] - fetch implementation override.
   */
  constructor(options = {}) {
    this.base = normalizeBase(options.base);
    this.timeoutMs = options.timeoutMs ?? 20000;
    this.cacheTtlMs = options.cacheTtlMs ?? DEFAULT_CATALOG_TTL_MS;
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch;
    /** @type {{catalog: object, at: number} | undefined} */
    this.cached = undefined;
    /** In-flight load, shared by concurrent callers. */
    this.pending = undefined;
  }

  /** Whether a catalogue is in memory and still fresh. */
  get fresh() {
    return this.cached !== undefined && Date.now() - this.cached.at < this.cacheTtlMs;
  }

  /**
   * Read the catalogue, fetching it when the cache is cold or stale.
   *
   * @param {object} [options] - `{force}`.
   * @returns {Promise<object>} the catalogue.
   * @throws {Error} with a message the UI can show as-is.
   */
  async load(options = {}) {
    if (this.fresh && options.force !== true) return this.cached.catalog;
    if (this.pending !== undefined) return this.pending;
    this.pending = this.#fetch()
      .then((catalog) => {
        this.cached = { catalog, at: Date.now() };
        return catalog;
      })
      .finally(() => {
        this.pending = undefined;
      });
    return this.pending;
  }

  /** Perform the fetch and projection; see {@link CatalogClient#load}. */
  async #fetch() {
    const url = `${this.base}/api/namespace`;
    let response;
    try {
      response = await this.fetchImpl(url, {
        headers: { accept: "application/json", "user-agent": "dsh-rss-reader/0.1" },
        signal: AbortSignal.timeout(this.timeoutMs)
      });
    } catch (cause) {
      const name = cause instanceof Error ? cause.name : "";
      const error = new Error(name === "TimeoutError" || name === "AbortError"
        ? `读取 RSSHub 路由表超时（${this.timeoutMs}ms）`
        : `无法连接 RSSHub 实例 ${this.base}：${cause instanceof Error ? cause.message : String(cause)}`);
      // The instance is the upstream here, so the API reports it as one.
      error.statusCode = 502;
      throw error;
    }
    if (response.status !== 200) {
      // A 404 is the instance saying it has no such endpoint — a feature gap on
      // that deployment, not a broken upstream. Anything else is upstream.
      const error = new Error(`RSSHub 实例 ${this.base} 返回 HTTP ${response.status}（路由表接口在部分实例上被关闭）`);
      error.statusCode = response.status === 404 ? 503 : 502;
      throw error;
    }
    let raw;
    try {
      raw = JSON.parse(await response.text());
    } catch {
      const error = new Error(`RSSHub 实例 ${this.base} 的路由表不是合法 JSON（可能是代理或错误页）`);
      error.statusCode = 502;
      throw error;
    }
    if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
      const error = new Error(`RSSHub 实例 ${this.base} 的路由表格式不认识`);
      error.statusCode = 502;
      throw error;
    }
    return buildCatalog(raw);
  }

  /**
   * Answer one browse/search request.
   *
   * @param {object} [options] - see {@link queryCatalog}.
   * @returns {Promise<object>} the page, plus the catalogue's totals.
   */
  async list(options = {}) {
    const catalog = await this.load({ force: options.refresh === true });
    return { ...queryCatalog(catalog, options), totals: catalog.totals, base: this.base };
  }

  /**
   * Look up one route by its namespace and template.
   *
   * The URL a subscribe uses is built from the catalogue's own record, not from
   * whatever the browser sent, so a stale or hostile client cannot assemble a
   * URL for a route that does not exist.
   *
   * @param {string} namespace - the namespace id.
   * @param {string} path - the route template.
   * @returns {Promise<object | null>} the route record, or null.
   */
  async find(namespace, path) {
    const catalog = await this.load();
    return catalog.index.get(`${namespace} ${path}`) ?? null;
  }

  /** Drop the cached catalogue, so the next read refetches it. */
  clear() {
    this.cached = undefined;
  }

  /**
   * Retarget this client at another instance.
   *
   * The catalogue in memory came from the old host, so it goes: the two
   * instances may run different versions with different routes.
   *
   * @param {string} base - the new instance base URL.
   * @returns {boolean} whether the client actually moved.
   * @throws {Error} when the URL is unusable, leaving the client untouched.
   */
  useBase(base) {
    const next = normalizeBase(base);
    if (next === this.base) return false;
    this.base = next;
    this.clear();
    return true;
  }
}
