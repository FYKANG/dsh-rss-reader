/**
 * dsh-rss-reader — RSSHub feed discovery.
 *
 * Many sites publish no `<link rel="alternate">` at all, so on-page discovery
 * finds nothing. RSSHub fills that gap: it maintains community "Radar" rules
 * mapping a site URL pattern to an RSSHub route, and every instance serves them:
 *
 *   GET {base}/api/radar/rules/{registrable-domain}
 *   → { "_name": "GitHub", ".": [ { title, docs, source: ["/:user"], target: "/github/activity/:user" } ] }
 *
 * Discovery therefore runs in two stages: read the page's own `<link>` tags
 * first (authoritative, no third party), then ask RSSHub for route candidates.
 * Both feed the same chooser in the UI, so the user sees every option at once.
 *
 * All rule handling here is pure and offline-testable; only {@link RsshubClient}
 * touches the network.
 *
 * @module dsh-rss-reader/rsshub
 */

/** Official public instance, used when no other base is configured. */
export const DEFAULT_BASE = "https://rsshub.app";

/** Radar rules change slowly, so they are cached per domain. */
export const DEFAULT_CACHE_TTL_MS = 6 * 60 * 60 * 1000;

/** Most distinct domains whose rules are kept in memory. */
export const DEFAULT_CACHE_LIMIT = 64;

/** Multi-part public suffixes common enough to matter for domain extraction. */
const MULTI_PART_SUFFIXES = new Set([
  "co.uk", "org.uk", "ac.uk", "gov.uk", "co.jp", "ne.jp", "or.jp", "co.kr",
  "com.cn", "net.cn", "org.cn", "gov.cn", "edu.cn", "com.tw", "org.tw",
  "com.hk", "com.au", "net.au", "org.au", "com.br", "com.mx", "co.in",
  "co.nz", "com.sg", "com.tr", "com.ar", "com.my", "co.za", "com.ua"
]);

/**
 * Normalize a configured RSSHub base URL.
 *
 * @param {unknown} value - the configured base.
 * @returns {string} an absolute base without a trailing slash.
 * @throws {Error} when the value is not a usable http(s) URL.
 */
export function normalizeBase(value) {
  const raw = typeof value === "string" ? value.trim() : "";
  const candidate = raw.length === 0 ? DEFAULT_BASE : raw;
  let parsed;
  try {
    parsed = new URL(candidate);
  } catch {
    throw new Error(`RSSHub base is not a valid URL: ${candidate}`);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(`RSSHub base must be http(s), got ${parsed.protocol}`);
  }
  return parsed.href.replace(/\/+$/, "");
}

/**
 * Candidate registrable domains for a hostname, most specific first.
 *
 * RSSHub keys its rules by registrable domain (`github.com`), but a user may
 * paste any subdomain (`show.bilibili.com`). Without a public-suffix list the
 * reliable approach is to try the host itself, then progressively shorter
 * suffixes; the first that answers wins. Multi-part suffixes such as `co.uk`
 * are handled so `bbc.co.uk` is not truncated to `co.uk`.
 *
 * @param {string} hostname - a URL hostname.
 * @returns {string[]} candidate domains, longest first.
 */
export function domainCandidates(hostname) {
  const host = String(hostname ?? "").trim().toLowerCase().replace(/\.$/, "");
  if (host.length === 0) return [];
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host) || host.includes(":")) return [host];

  const labels = host.split(".").filter((label) => label.length > 0);
  const out = [];
  // Try the full host first (a site may be keyed with its subdomain).
  for (let start = 0; start < labels.length; start += 1) {
    const candidate = labels.slice(start).join(".");
    const labelCount = labels.length - start;
    if (labelCount < 2) break;
    // Stop before reducing a multi-part suffix to its last label.
    if (labelCount === 2 && out.length > 0) {
      const suffix = candidate;
      if (MULTI_PART_SUFFIXES.has(suffix)) break;
    }
    out.push(candidate);
  }
  // A bare two-label host still needs one candidate.
  if (out.length === 0 && labels.length >= 2) out.push(labels.slice(-2).join("."));
  return [...new Set(out)];
}

/**
 * The subdomain key RSSHub uses for a host, given its registrable domain.
 *
 * `show.bilibili.com` + `bilibili.com` → `"show"`; `bilibili.com` → `""`
 * (which RSSHub spells `.`).
 *
 * @param {string} hostname - the URL hostname.
 * @param {string} domain - the registrable domain that matched.
 * @returns {string} the subdomain, or "" when there is none.
 */
export function subdomainOf(hostname, domain) {
  const host = String(hostname ?? "").toLowerCase();
  const base = String(domain ?? "").toLowerCase();
  if (host === base) return "";
  if (host.endsWith(`.${base}`)) return host.slice(0, host.length - base.length - 1);
  return "";
}

/**
 * Match one `source` pattern against a URL path.
 *
 * Pattern syntax (per RSSHub's Radar docs): `/`-separated segments, `:name` for
 * a single-segment parameter, `*` or `*name` for the remaining segments. A
 * non-wildcard pattern must consume the path exactly, otherwise visiting a
 * deeper page would wrongly offer a feed for its parent.
 *
 * @param {string} pattern - the source pattern, e.g. `/:user/:repo/issues`.
 * @param {string} pathname - the URL path, e.g. `/DIYgod/RSSHub/issues`.
 * @returns {Record<string, string> | null} captured params, or null on no match.
 */
export function matchSource(pattern, pathname) {
  const patternSegments = String(pattern ?? "").split("/").filter((part) => part.length > 0);
  const pathSegments = String(pathname ?? "").split("/").filter((part) => part.length > 0);
  const params = {};
  let cursor = 0;

  for (let index = 0; index < patternSegments.length; index += 1) {
    const segment = patternSegments[index];
    if (segment.startsWith("*")) {
      // A wildcard consumes the remainder and must match at least one segment.
      const name = segment.slice(1);
      const rest = pathSegments.slice(cursor);
      if (rest.length === 0) return null;
      if (name.length > 0) params[name] = decodeSegment(rest.join("/"));
      return params;
    }
    if (cursor >= pathSegments.length) return null;
    if (segment.startsWith(":")) {
      const name = segment.slice(1);
      if (name.length > 0) params[name] = decodeSegment(pathSegments[cursor]);
    } else if (segment.toLowerCase() !== pathSegments[cursor].toLowerCase()) {
      return null;
    }
    cursor += 1;
  }

  if (cursor !== pathSegments.length) return null;
  return params;
}

/** Percent-decode one path segment, leaving malformed input intact. */
function decodeSegment(value) {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

/**
 * Substitute captured params into an RSSHub route target.
 *
 * @param {string} target - route path such as `/github/issue/:user/:repo`.
 * @param {Record<string, string>} params - captured params.
 * @returns {string | null} the filled route, or null when a param is missing.
 */
export function buildTarget(target, params) {
  const raw = typeof target === "string" ? target.trim() : "";
  if (raw.length === 0) return null;
  let missing = false;
  const filled = raw.replace(/:([A-Za-z0-9_]+)/g, (_match, name) => {
    const value = params?.[name];
    if (typeof value !== "string" || value.length === 0) {
      missing = true;
      return "";
    }
    // Each captured value occupies one path segment, so encode it as one.
    return encodeURIComponent(value);
  });
  if (missing) return null;
  // A `*` left in the target cannot be resolved without the wildcard capture.
  if (filled.includes("*")) return null;
  return filled.startsWith("/") ? filled : `/${filled}`;
}

/**
 * Join an RSSHub base with a route path.
 * @param {string} base - normalized base URL.
 * @param {string} route - route path beginning with `/`.
 * @returns {string} the full feed URL.
 */
export function joinRoute(base, route) {
  return `${String(base).replace(/\/+$/, "")}${route.startsWith("/") ? route : `/${route}`}`;
}

/**
 * Turn a domain's Radar rules into feed candidates for one URL.
 *
 * @param {object} input - `{ rules, url, base, domain, limit }`.
 * @param {string} [input.domain] - the registrable domain the rules belong to.
 *   Supplied by the caller (it just fetched them by that name); deriving it
 *   again from the URL is unreliable, because a subdomain host makes several
 *   suffixes look plausible.
 * @returns {Array<{title: string, url: string, route: string, docs: string,
 *   site: string, source: string, params: Record<string, string>}>} candidates.
 */
export function candidatesFromRules({ rules, url, base, domain, limit = 12 }) {
  const out = [];
  if (rules === null || typeof rules !== "object") return out;

  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return out;
  }

  const siteName = typeof rules._name === "string" ? rules._name : "";
  const hostname = parsed.hostname.toLowerCase();
  const pathname = parsed.pathname;

  // Prefer the bucket for this exact subdomain (`show.bilibili.com` → `show`),
  // then RSSHub's catch-all `.`, then anything else as a last resort.
  const baseDomain = typeof domain === "string" && domain.length > 0
    ? domain
    : inferRulesDomain(hostname, rules);
  const subdomain = subdomainOf(hostname, baseDomain);
  const keys = [];
  if (subdomain.length > 0 && Array.isArray(rules[subdomain])) keys.push(subdomain);
  if (Array.isArray(rules["."])) keys.push(".");
  for (const key of Object.keys(rules)) {
    if (key === "_name" || keys.includes(key)) continue;
    if (Array.isArray(rules[key])) keys.push(key);
  }

  const seen = new Set();
  for (const key of keys) {
    for (const rule of rules[key]) {
      if (rule === null || typeof rule !== "object") continue;
      const sources = Array.isArray(rule.source) ? rule.source : [];
      for (const source of sources) {
        if (typeof source !== "string") continue;
        const params = matchSource(source, pathname);
        if (params === null) continue;
        const route = buildTarget(rule.target, params);
        if (route === null) continue;
        const feedUrl = joinRoute(base, route);
        if (seen.has(feedUrl)) continue;
        seen.add(feedUrl);
        out.push({
          title: typeof rule.title === "string" && rule.title.length > 0 ? rule.title : siteName,
          url: feedUrl,
          route,
          docs: typeof rule.docs === "string" ? rule.docs : "",
          site: siteName,
          source,
          params
        });
        if (out.length >= limit) return out;
      }
    }
  }
  return out;
}

/**
 * The registrable domain a rules object describes, when the caller did not
 * supply one.
 *
 * A rules object is keyed by its registrable domain plus optional subdomain
 * buckets, so the right answer is the host suffix whose bucket names this
 * host's subdomain: for `show.bilibili.com` that is `bilibili.com` (subdomain
 * `show`), not the full host.
 *
 * @param {string} hostname - the URL hostname.
 * @param {object} rules - a fetched rules object.
 * @returns {string} the best guess at the rules' domain.
 */
function inferRulesDomain(hostname, rules) {
  const buckets = Object.keys(rules ?? {}).filter((key) => key !== "_name");
  const candidates = domainCandidates(hostname);
  for (const candidate of candidates) {
    if (buckets.includes(subdomainOf(hostname, candidate))) return candidate;
  }
  return candidates[candidates.length - 1] ?? hostname;
}

/**
 * Fetch and cache RSSHub Radar rules for a domain.
 *
 * The client is transport-injectable so tests can run without a network, and
 * caches both hits and misses: a site RSSHub does not cover should not cost a
 * request on every keystroke.
 */
export class RsshubClient {
  /**
   * @param {object} [options] - client options.
   * @param {string} [options.base] - RSSHub instance base URL.
   * @param {number} [options.timeoutMs] - per-request timeout.
   * @param {number} [options.cacheTtlMs] - how long a domain's rules stay fresh.
   * @param {number} [options.cacheLimit] - max cached domains.
   * @param {Function} [options.fetchImpl] - fetch implementation override.
   */
  constructor(options = {}) {
    this.base = normalizeBase(options.base);
    this.timeoutMs = options.timeoutMs ?? 15000;
    this.cacheTtlMs = options.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS;
    this.cacheLimit = options.cacheLimit ?? DEFAULT_CACHE_LIMIT;
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch;
    /** @type {Map<string, {rules: object | null, at: number, error: string}>} */
    this.cache = new Map();
  }

  /** Fetch rules for one domain, using the cache when fresh. */
  async rulesFor(domain) {
    const cached = this.cache.get(domain);
    if (cached !== undefined && Date.now() - cached.at < this.cacheTtlMs) {
      return cached.rules;
    }
    const url = `${this.base}/api/radar/rules/${encodeURIComponent(domain)}`;
    let rules = null;
    let error = "";
    try {
      const response = await this.fetchImpl(url, {
        headers: { accept: "application/json", "user-agent": "dsh-rss-reader/0.1" },
        signal: AbortSignal.timeout(this.timeoutMs)
      });
      if (response.status === 200) {
        // An uncovered domain answers 200 with an EMPTY body, not 404 — so the
        // body must be read defensively. Parsing it blindly turned "RSSHub has
        // no rules for this site" into a bogus "cannot reach the instance".
        const text = typeof response.text === "function"
          ? await response.text()
          : JSON.stringify(await response.json());
        const trimmed = String(text ?? "").trim();
        if (trimmed.length === 0 || trimmed === "null") {
          rules = null;
        } else {
          try {
            const parsed = JSON.parse(trimmed);
            rules = parsed !== null && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
          } catch {
            // A non-JSON 200 is an instance problem, not "no rules".
            error = `${this.base} returned a non-JSON response for ${domain} radar rules`;
          }
        }
      } else if (response.status === 404) {
        // Some instances spell "not covered" as 404.
        rules = null;
      } else {
        error = `HTTP ${response.status}`;
      }
    } catch (cause) {
      const name = cause instanceof Error ? cause.name : "";
      error = name === "TimeoutError" || name === "AbortError"
        ? `request to ${this.base} timed out after ${this.timeoutMs}ms`
        : `cannot reach ${this.base}: ${cause instanceof Error ? cause.message : String(cause)}`;
    }

    // Cache failures briefly so a dead instance is not retried on every call,
    // but do not let a transient outage poison the cache for the full TTL.
    const entry = { rules, at: Date.now(), error };
    if (error.length > 0) entry.at = Date.now() - this.cacheTtlMs + 60_000;
    this.remember(domain, entry);
    if (error.length > 0) throw new Error(error);
    return rules;
  }

  /** Store one cache entry, evicting the oldest beyond the limit. */
  remember(domain, entry) {
    this.cache.set(domain, entry);
    while (this.cache.size > this.cacheLimit) {
      const oldest = this.cache.keys().next().value;
      if (oldest === undefined) break;
      this.cache.delete(oldest);
    }
  }

  /**
   * Discover RSSHub feed candidates for a URL.
   *
   * Never throws: a site RSSHub does not cover, or an unreachable instance, is
   * reported as an empty candidate list plus a reason, so the UI can say why
   * nothing was found instead of showing a bare error.
   *
   * @param {string} url - the page URL to find feeds for.
   * @param {object} [options] - `{limit}`.
   * @returns {Promise<{candidates: Array<object>, site: string, domain: string,
   *   reason: string, base: string}>} the outcome.
   */
  async discover(url, options = {}) {
    const empty = { candidates: [], site: "", domain: "", reason: "", base: this.base };
    let parsed;
    try {
      parsed = new URL(url);
    } catch {
      return { ...empty, reason: "not a valid URL" };
    }

    let lastError = "";
    for (const domain of domainCandidates(parsed.hostname)) {
      let rules;
      try {
        rules = await this.rulesFor(domain);
      } catch (error) {
        lastError = error instanceof Error ? error.message : String(error);
        continue;
      }
      if (rules === null) continue;
      const candidates = candidatesFromRules({
        rules,
        url: parsed.href,
        base: this.base,
        // The rules were fetched by this name, so this is the domain they
        // describe — no need to re-derive it from the URL.
        domain,
        limit: options.limit ?? 12
      });
      if (candidates.length > 0) {
        return {
          candidates,
          site: typeof rules._name === "string" ? rules._name : "",
          domain,
          reason: "",
          base: this.base
        };
      }
      // The domain is covered but this particular path has no rule; keep going
      // in case a shorter suffix matches (a subdomain-specific rule set).
    }

    return {
      ...empty,
      reason: lastError.length > 0
        ? lastError
        : "RSSHub has no route for this URL (it may not be covered, or the rules changed)"
    };
  }

  /** Drop cached rules, e.g. after the base URL changes. */
  clear() {
    this.cache.clear();
  }

  /**
   * Retarget this client at another instance.
   *
   * The caches belong to the instance that filled them, so they go with it:
   * keeping rules fetched from one host while reading another would serve
   * generated routes the new host may not even have.
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

  /**
   * Ask the instance whether it answers at all.
   *
   * Deliberately cheap and separate from any feature call: the point of the
   * settings field is to find out whether *this* address works before trusting
   * it with radar rules or a multi-megabyte route table.
   *
   * @returns {Promise<{ok: boolean, status: number, error: string}>} the result.
   */
  async ping() {
    try {
      const response = await this.fetchImpl(`${this.base}/`, {
        headers: { accept: "text/html,application/json;q=0.9,*/*;q=0.8", "user-agent": "dsh-rss-reader/0.1" },
        // A liveness check must not outlive the reader's patience.
        signal: AbortSignal.timeout(Math.min(this.timeoutMs, 10000))
      });
      if (response.status >= 200 && response.status < 400) return { ok: true, status: response.status, error: "" };
      return { ok: false, status: response.status, error: `HTTP ${response.status}` };
    } catch (cause) {
      const name = cause instanceof Error ? cause.name : "";
      return {
        ok: false,
        status: 0,
        error: name === "TimeoutError" || name === "AbortError"
          ? `连接超时（${Math.min(this.timeoutMs, 10000)}ms）`
          : `无法连接：${cause instanceof Error ? cause.message : String(cause)}`
      };
    }
  }

  /**
   * List every route RSSHub documents for a domain, as orientation.
   *
   * A path-specific rule only matches a specific kind of page, so a user who
   * pastes a home page often gets nothing while the site is well covered. These
   * entries are informational: their targets still contain `:params`, so they
   * cannot be subscribed to until a matching page URL supplies the values.
   *
   * @param {string} domain - the registrable domain.
   * @param {object} [options] - `{limit}`.
   * @returns {Promise<{routes: Array<{title: string, route: string, docs: string}>,
   *   site: string, total: number, base: string}>} the listing.
   */
  async listRoutes(domain, options = {}) {
    const rules = await this.rulesFor(domain);
    const empty = { routes: [], site: "", total: 0, base: this.base };
    if (rules === null) return empty;

    const limit = options.limit ?? 40;
    const site = typeof rules._name === "string" ? rules._name : "";
    const out = [];
    let total = 0;
    for (const [key, value] of Object.entries(rules)) {
      if (key === "_name" || !Array.isArray(value)) continue;
      for (const rule of value) {
        if (rule === null || typeof rule !== "object") continue;
        const target = typeof rule.target === "string" ? rule.target : "";
        if (target.length === 0) continue;
        total += 1;
        if (out.length >= limit) continue;
        out.push({
          title: typeof rule.title === "string" && rule.title.length > 0 ? rule.title : site,
          route: target,
          docs: typeof rule.docs === "string" ? rule.docs : "",
          needsParams: /[:*]/.test(target)
        });
      }
    }
    return { routes: out, site, total, base: this.base };
  }
}
