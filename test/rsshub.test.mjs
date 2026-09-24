/**
 * dsh-rss-reader — RSSHub discovery tests.
 *
 * The network is faked throughout: what needs pinning is the rule *semantics*
 * (which page maps to which route) and the client's behaviour on the response
 * shapes real instances return — including the surprising ones.
 *
 * The shape that matters most: an uncovered domain answers `200` with an
 * **empty body**, not `404`. Treating that as a failure turns "RSSHub has no
 * rules for this site" into a bogus "cannot reach the instance".
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  DEFAULT_BASE,
  RsshubClient,
  buildTarget,
  candidatesFromRules,
  domainCandidates,
  joinRoute,
  matchSource,
  normalizeBase,
  subdomainOf
} from "../lib/rsshub.js";

// ── Base URL handling ───────────────────────────────────────────────────────

test("normalizeBase defaults, trims slashes, and rejects bad input", () => {
  assert.equal(normalizeBase(""), DEFAULT_BASE);
  assert.equal(normalizeBase("   "), DEFAULT_BASE);
  assert.equal(normalizeBase("https://rsshub.example.com/"), "https://rsshub.example.com");
  assert.equal(normalizeBase("https://rsshub.example.com///"), "https://rsshub.example.com");
  assert.equal(normalizeBase("http://127.0.0.1:1200"), "http://127.0.0.1:1200");
  assert.throws(() => normalizeBase("not a url"), /not a valid URL/);
  assert.throws(() => normalizeBase("ftp://x.test"), /must be http/);
});

// ── Domain extraction ───────────────────────────────────────────────────────

test("domainCandidates returns host suffixes, longest first", () => {
  assert.deepEqual(domainCandidates("github.com"), ["github.com"]);
  assert.deepEqual(domainCandidates("www.github.com"), ["www.github.com", "github.com"]);
  assert.deepEqual(domainCandidates("show.bilibili.com"), ["show.bilibili.com", "bilibili.com"]);
});

test("domainCandidates respects multi-part public suffixes", () => {
  // Truncating bbc.co.uk to co.uk would query the wrong site's rules.
  assert.deepEqual(domainCandidates("bbc.co.uk"), ["bbc.co.uk"]);
  assert.deepEqual(domainCandidates("www.bbc.co.uk"), ["www.bbc.co.uk", "bbc.co.uk"]);
  assert.deepEqual(domainCandidates("news.bbc.co.uk"), ["news.bbc.co.uk", "bbc.co.uk"]);
});

test("domainCandidates handles IPs, ports, and empties without inventing domains", () => {
  assert.deepEqual(domainCandidates("127.0.0.1"), ["127.0.0.1"]);
  assert.deepEqual(domainCandidates(""), []);
  assert.deepEqual(domainCandidates(null), []);
  assert.deepEqual(domainCandidates("localhost"), []);
});

test("subdomainOf extracts the key RSSHub buckets rules under", () => {
  assert.equal(subdomainOf("show.bilibili.com", "bilibili.com"), "show");
  assert.equal(subdomainOf("bilibili.com", "bilibili.com"), "");
  assert.equal(subdomainOf("www.github.com", "github.com"), "www");
  assert.equal(subdomainOf("unrelated.test", "github.com"), "");
});

// ── Source pattern matching ─────────────────────────────────────────────────

test("matchSource captures named parameters", () => {
  assert.deepEqual(matchSource("/:user/:repo", "/DIYgod/RSSHub"), { user: "DIYgod", repo: "RSSHub" });
  assert.deepEqual(
    matchSource("/:user/:repo/issues", "/DIYgod/RSSHub/issues"),
    { user: "DIYgod", repo: "RSSHub" }
  );
});

test("matchSource requires the whole path unless the pattern has a wildcard", () => {
  // A deeper page must not silently match its parent's rule.
  assert.equal(matchSource("/:user/:repo", "/DIYgod/RSSHub/issues"), null);
  assert.equal(matchSource("/:user/:repo/issues", "/DIYgod/RSSHub/issues/123"), null);
});

test("matchSource wildcards capture the remainder", () => {
  assert.deepEqual(matchSource("/v/*tpath", "/v/douga/mad"), { tpath: "douga/mad" });
  assert.deepEqual(matchSource("/:user/:repo/*", "/DIYgod/RSSHub/issues"), { user: "DIYgod", repo: "RSSHub" });
  assert.deepEqual(
    matchSource("/:user/:repo/*path", "/DIYgod/RSSHub/issues/1234"),
    { user: "DIYgod", repo: "RSSHub", path: "issues/1234" }
  );
  // A wildcard still needs at least one segment to consume.
  assert.equal(matchSource("/v/*", "/v"), null);
});

test("matchSource handles literals, case, and the root path", () => {
  assert.deepEqual(matchSource("/", "/"), {});
  assert.equal(matchSource("/", "/other"), null);
  assert.deepEqual(matchSource("/Issues", "/issues"), {}, "literal segments compare case-insensitively");
  assert.deepEqual(matchSource("/a/b", "/a/b/"), {}, "a trailing slash is not a segment");
  assert.deepEqual(matchSource("", "/"), {});
});

test("matchSource decodes percent-encoded segments", () => {
  assert.deepEqual(matchSource("/:name", "/%E4%B8%AD%E6%96%87"), { name: "中文" });
  // Malformed escapes are kept verbatim rather than throwing.
  assert.deepEqual(matchSource("/:name", "/%E4%B8"), { name: "%E4%B8" });
});

// ── Target building ─────────────────────────────────────────────────────────

test("buildTarget substitutes parameters and encodes them", () => {
  assert.equal(buildTarget("/github/issue/:user/:repo", { user: "DIYgod", repo: "RSSHub" }), "/github/issue/DIYgod/RSSHub");
  assert.equal(buildTarget("/zhihu/posts/people/:id", { id: "a b" }), "/zhihu/posts/people/a%20b");
  assert.equal(buildTarget("github/stars/:user", { user: "x" }), "/github/stars/x");
});

test("buildTarget refuses a route it cannot fill completely", () => {
  // A half-filled route would produce a broken subscription URL.
  assert.equal(buildTarget("/github/issue/:user/:repo", { user: "DIYgod" }), null);
  assert.equal(buildTarget("/a/:x", {}), null);
  assert.equal(buildTarget("/a/:x", { x: "" }), null);
  assert.equal(buildTarget("/a/*rest", { rest: "x" }), null, "an unresolved wildcard is not usable");
  assert.equal(buildTarget("", {}), null);
  assert.equal(buildTarget(null, {}), null);
});

test("joinRoute produces one slash between base and route", () => {
  assert.equal(joinRoute("https://rsshub.app", "/github/stars/x"), "https://rsshub.app/github/stars/x");
  assert.equal(joinRoute("https://rsshub.app/", "/github/stars/x"), "https://rsshub.app/github/stars/x");
  assert.equal(joinRoute("https://rsshub.app", "github/stars/x"), "https://rsshub.app/github/stars/x");
});

// ── Rule → candidate conversion ─────────────────────────────────────────────

const GITHUB_RULES = {
  _name: "GitHub",
  ".": [
    { title: "Repo Issues", docs: "https://docs.rsshub.app/routes/programming", source: ["/:user/:repo/issues", "/:user/:repo"], target: "/github/issue/:user/:repo" },
    { title: "Repo Stars", docs: "", source: ["/:user/:repo/stargazers"], target: "/github/stars/:user/:repo" },
    { title: "User Activities", docs: "", source: ["/:user"], target: "/github/activity/:user" },
    { title: "Needs A Param", docs: "", source: ["/x"], target: "/github/needs/:missing" }
  ]
};

test("candidatesFromRules picks the rule matching the page path", () => {
  const found = candidatesFromRules({
    rules: GITHUB_RULES,
    url: "https://github.com/DIYgod/RSSHub/issues",
    base: "https://rsshub.app"
  });
  assert.equal(found.length, 1, "only the issues page matches");
  assert.equal(found[0].title, "Repo Issues");
  assert.equal(found[0].url, "https://rsshub.app/github/issue/DIYgod/RSSHub");
  assert.equal(found[0].site, "GitHub");
  assert.deepEqual(found[0].params, { user: "DIYgod", repo: "RSSHub" });
});

test("candidatesFromRules drops rules whose target cannot be filled", () => {
  // `/x` matches BOTH `/:user` (fillable) and the literal `/x` rule whose target
  // needs a param no URL can supply. Only the usable one may be offered.
  const found = candidatesFromRules({ rules: GITHUB_RULES, url: "https://github.com/x", base: "https://rsshub.app" });
  assert.deepEqual(found.map((c) => c.title), ["User Activities"]);
  assert.ok(
    !found.some((c) => c.title === "Needs A Param"),
    "a route with an unfillable parameter must not be offered"
  );
  assert.ok(
    found.every((candidate) => !/[:*]/.test(candidate.route)),
    "no offered route may contain an unresolved placeholder"
  );
  // And the offered URL is that route, joined to the instance base.
  assert.equal(found[0].url, "https://rsshub.app/github/activity/x");
});

test("candidatesFromRules prefers the exact subdomain bucket over the catch-all", () => {
  const rules = {
    _name: "Bilibili",
    show: [{ title: "Show Only", docs: "", source: ["/:id"], target: "/bilibili/show/:id" }],
    ".": [{ title: "Catch All", docs: "", source: ["/:id"], target: "/bilibili/any/:id" }]
  };
  const specific = candidatesFromRules({ rules, url: "https://show.bilibili.com/2267573", base: "https://r.example" });
  assert.equal(specific[0].title, "Show Only", "the subdomain bucket wins");

  const generic = candidatesFromRules({ rules, url: "https://bilibili.com/2267573", base: "https://r.example" });
  assert.equal(generic[0].title, "Catch All", "a bare host uses the catch-all");
});

test("candidatesFromRules de-duplicates identical feed URLs and honours the limit", () => {
  const rules = {
    _name: "X",
    ".": [
      { title: "A", docs: "", source: ["/p/:id"], target: "/x/:id" },
      { title: "B", docs: "", source: ["/q/:id"], target: "/x/:id" }
    ]
  };
  const found = candidatesFromRules({ rules, url: "https://x.test/p/1", base: "https://r.example" });
  assert.equal(found.length, 1, "the same generated feed is offered once");

  const many = {
    _name: "Y",
    ".": Array.from({ length: 20 }, (_, i) => ({ title: `T${i}`, docs: "", source: ["/:id"], target: `/y/${i}/:id` }))
  };
  assert.equal(candidatesFromRules({ rules: many, url: "https://y.test/1", base: "https://r.example", limit: 5 }).length, 5);
});

test("candidatesFromRules tolerates malformed rules and URLs", () => {
  assert.deepEqual(candidatesFromRules({ rules: null, url: "https://x.test/", base: "b" }), []);
  assert.deepEqual(candidatesFromRules({ rules: GITHUB_RULES, url: "not a url", base: "b" }), []);
  const junk = { _name: "J", ".": [null, "string", { title: "No source" }, { source: [], target: "/a" }] };
  assert.deepEqual(candidatesFromRules({ rules: junk, url: "https://j.test/", base: "b" }), []);
});

// ── Client: response shapes ─────────────────────────────────────────────────

/** Build a fetch double that answers radar requests from a table. */
function fakeFetch(table) {
  const calls = [];
  const impl = async (url) => {
    calls.push(String(url));
    const key = decodeURIComponent(String(url).split("/api/radar/rules/")[1] ?? "");
    const entry = table[key];
    if (entry === undefined) {
      // Uncovered: a real instance answers 200 with an empty body.
      return { status: 200, async text() { return ""; }, async json() { throw new Error("empty"); } };
    }
    if (typeof entry === "function") return entry();
    if (typeof entry === "number") return { status: entry, async text() { return ""; }, async json() { throw new Error("nope"); } };
    return { status: 200, async text() { return JSON.stringify(entry); }, async json() { return entry; } };
  };
  impl.calls = calls;
  return impl;
}

test("an uncovered domain is reported as 'no route', not as a network failure", async () => {
  // Regression: the empty 200 body used to throw inside response.json() and
  // surface as "cannot reach the instance".
  const client = new RsshubClient({ base: "https://r.example", fetchImpl: fakeFetch({}) });
  const result = await client.discover("https://example.com/nothing");
  assert.deepEqual(result.candidates, []);
  assert.match(result.reason, /no route for this URL/);
  assert.ok(!/cannot reach/.test(result.reason), "the reason must not blame the network");
});

test("a 404 for a domain is also treated as uncovered", async () => {
  const client = new RsshubClient({ base: "https://r.example", fetchImpl: fakeFetch({ "x.test": 404 }) });
  const result = await client.discover("https://x.test/a");
  assert.deepEqual(result.candidates, []);
  assert.match(result.reason, /no route/);
});

test("a non-JSON 200 is reported as an instance problem", async () => {
  const client = new RsshubClient({
    base: "https://r.example",
    fetchImpl: fakeFetch({ "x.test": () => ({ status: 200, async text() { return "<html>not json</html>"; } }) })
  });
  const result = await client.discover("https://x.test/a");
  assert.deepEqual(result.candidates, []);
  assert.match(result.reason, /non-JSON response/);
});

test("a network failure is reported with the instance URL", async () => {
  const client = new RsshubClient({
    base: "https://r.example",
    fetchImpl: async () => {
      throw new Error("ECONNREFUSED");
    }
  });
  const result = await client.discover("https://x.test/a");
  assert.match(result.reason, /cannot reach https:\/\/r\.example/);
});

test("a timeout is reported as such", async () => {
  const client = new RsshubClient({
    base: "https://r.example",
    timeoutMs: 40,
    fetchImpl: async () => {
      const error = new Error("timed out");
      error.name = "TimeoutError";
      throw error;
    }
  });
  const result = await client.discover("https://x.test/a");
  assert.match(result.reason, /timed out/);
});

// ── Client: caching ─────────────────────────────────────────────────────────

test("rules are cached per domain and reused across lookups", async () => {
  const impl = fakeFetch({ "github.com": GITHUB_RULES });
  const client = new RsshubClient({ base: "https://r.example", fetchImpl: impl });
  await client.discover("https://github.com/a/b");
  await client.discover("https://github.com/c/d");
  assert.equal(impl.calls.length, 1, "the second lookup must not re-request");
});

test("a negative result is cached too, so uncovered sites do not re-query", async () => {
  const impl = fakeFetch({});
  const client = new RsshubClient({ base: "https://r.example", fetchImpl: impl });
  await client.discover("https://example.com/a");
  await client.discover("https://example.com/b");
  assert.equal(impl.calls.length, 1);
});

test("a failure is cached only briefly so an outage does not stick for the full TTL", async () => {
  const impl = fakeFetch({
    "x.test": async () => {
      throw new Error("boom");
    }
  });
  // A long TTL: a failure must still be retried after about a minute, not
  // remembered as "uncovered" for the whole window.
  const client = new RsshubClient({ base: "https://r.example", cacheTtlMs: 3_600_000, fetchImpl: impl });
  await client.discover("https://x.test/a");
  const entry = client.cache.get("x.test");
  assert.ok(entry !== undefined, "the failure is remembered");
  const remainingFreshness = client.cacheTtlMs - (Date.now() - entry.at);
  assert.ok(
    remainingFreshness > 0 && remainingFreshness <= 60_500,
    `a failure should stay fresh for about a minute, got ${remainingFreshness}ms`
  );
});

test("a fresh success stays cached for the whole TTL", async () => {
  const impl = fakeFetch({ "ok.test": { _name: "OK", ".": [] } });
  const client = new RsshubClient({ base: "https://r.example", cacheTtlMs: 3_600_000, fetchImpl: impl });
  await client.discover("https://ok.test/a");
  const entry = client.cache.get("ok.test");
  const remainingFreshness = client.cacheTtlMs - (Date.now() - entry.at);
  assert.ok(remainingFreshness > 3_500_000, "a success is cached for essentially the full TTL");
});

test("the cache is bounded", async () => {
  const client = new RsshubClient({ base: "https://r.example", cacheLimit: 3, fetchImpl: fakeFetch({}) });
  for (const host of ["a.test", "b.test", "c.test", "d.test", "e.test"]) {
    await client.discover(`https://${host}/x`);
  }
  assert.ok(client.cache.size <= 3, `cache grew to ${client.cache.size}`);
});

// ── Client: discovery across domain candidates ──────────────────────────────

test("discover falls back to a shorter domain suffix when the host has no rules", async () => {
  // Rules are keyed by registrable domain; a subdomain host must still find them.
  const impl = fakeFetch({ "bilibili.com": { _name: "Bilibili", ".": [
    { title: "UP", docs: "", source: ["/:id"], target: "/bilibili/user/:id" }
  ] } });
  const client = new RsshubClient({ base: "https://r.example", fetchImpl: impl });
  const result = await client.discover("https://show.bilibili.com/2267573");
  assert.equal(result.domain, "bilibili.com");
  assert.equal(result.candidates[0].url, "https://r.example/bilibili/user/2267573");
});

test("discover reports the site name from the rules", async () => {
  const client = new RsshubClient({ base: "https://r.example", fetchImpl: fakeFetch({ "github.com": GITHUB_RULES }) });
  const result = await client.discover("https://github.com/DIYgod/RSSHub/issues");
  assert.equal(result.site, "GitHub");
  assert.equal(result.base, "https://r.example");
});

test("discover rejects a malformed URL without touching the network", async () => {
  const impl = fakeFetch({});
  const client = new RsshubClient({ base: "https://r.example", fetchImpl: impl });
  const result = await client.discover("not a url");
  assert.deepEqual(result.candidates, []);
  assert.equal(result.reason, "not a valid URL");
  assert.equal(impl.calls.length, 0);
});

// ── Client: domain route listing ────────────────────────────────────────────

test("listRoutes reports every documented route, flagging ones needing params", async () => {
  const client = new RsshubClient({ base: "https://r.example", fetchImpl: fakeFetch({ "github.com": GITHUB_RULES }) });
  const listed = await client.listRoutes("github.com");
  assert.equal(listed.site, "GitHub");
  assert.equal(listed.total, 4);
  assert.equal(listed.routes.length, 4);
  // Templates still contain :params, so they are informational only.
  assert.ok(listed.routes.every((route) => route.needsParams === true));
});

test("listRoutes returns nothing for an uncovered domain", async () => {
  const client = new RsshubClient({ base: "https://r.example", fetchImpl: fakeFetch({}) });
  const listed = await client.listRoutes("example.com");
  assert.deepEqual(listed.routes, []);
  assert.equal(listed.total, 0);
});
