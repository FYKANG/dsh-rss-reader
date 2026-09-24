/**
 * dsh-rss-reader — RSSHub route catalogue tests.
 *
 * The network is never touched: the client is handed a fake `fetchImpl`, and
 * the fixtures mirror the shapes the real `/api/namespace` document uses
 * (templates with `?` and `{.+}`, parameters that are a string or a descriptor
 * with `options`, `features.requireConfig` as `false` or an array).
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  CATEGORY_ORDER,
  CatalogClient,
  MAX_PAGE,
  buildCatalog,
  categoryLabel,
  exampleValues,
  fillRoutePath,
  oneLine,
  parseRoutePath,
  queryCatalog,
  routeFlags,
  routeParameters
} from "../lib/explore.js";

/**
 * A slice of a real registry, trimmed to the shapes that matter.
 * @returns {object} the raw document.
 */
function registry() {
  return {
    github: {
      name: "GitHub",
      url: "github.com",
      lang: "en",
      routes: {
        "/trending/:since/:language/:spoken_language?": {
          path: "/trending/:since/:language/:spoken_language?",
          name: "Trending",
          categories: ["programming"],
          example: "/github/trending/daily/javascript/en",
          description: "See what the GitHub community is most excited about today.",
          parameters: {
            since: {
              description: "time range",
              options: [
                { value: "daily", label: "Today" },
                { value: "weekly", label: "This week" },
                { value: "monthly", label: "This month" }
              ]
            },
            language: { description: "the feed language, `any` for no filter", default: "any" },
            spoken_language: { description: "natural language" }
          },
          features: { requireConfig: false, antiCrawler: false, requirePuppeteer: false }
        },
        "/file/:user/:repo/:branch/:filepath{.+}": {
          path: "/file/:user/:repo/:branch/:filepath{.+}",
          name: "File",
          categories: ["programming"],
          example: "/github/file/DIYgod/RSSHub/master/lib/routes/github/routes.ts",
          features: { requireConfig: false }
        },
        "/repos/:user": {
          path: "/repos/:user",
          name: "Repos",
          categories: ["programming"],
          example: "/github/repos/DIYgod",
          parameters: { user: "GitHub username" },
          features: {
            requireConfig: [{ name: "GITHUB_ACCESS_TOKEN", description: "raises the rate limit" }],
            antiCrawler: true
          }
        }
      }
    },
    bilibili: {
      name: "哔哩哔哩 bilibili",
      url: "www.bilibili.com",
      lang: "zh-CN",
      categories: ["social-media"],
      routes: {
        "/user/video/:uid/:embed?": {
          path: "/user/video/:uid/:embed?",
          name: "UP 主投稿",
          categories: ["social-media"],
          example: "/bilibili/user/video/2267573",
          parameters: { uid: "用户 id", embed: "默认为开启内嵌视频" },
          features: { requireConfig: false }
        },
        "/hot-search": {
          path: "/hot-search",
          name: "热搜",
          categories: ["social-media"],
          example: "/bilibili/hot-search",
          features: { requireConfig: false }
        }
      }
    },
    broken: {
      name: "Broken",
      url: "broken.test",
      routes: {
        "/bad/:thing": null,
        "/good": { path: "/good", name: "Good", categories: ["other"], example: "/broken/good" }
      }
    },
    notAnObject: null,
    "no-routes": { name: "Empty", url: "empty.test" }
  };
}

/** A catalogue built from the fixture. */
function catalog() {
  return buildCatalog(registry());
}

/** Find one route by namespace and path. */
function routeOf(built, namespace, path) {
  const found = built.routes.find((route) => route.namespace === namespace && route.path === path);
  assert.ok(found !== undefined, `route ${namespace}${path} should be in the catalogue`);
  return found;
}

// ── path parsing ────────────────────────────────────────────────────────────

test("a route path splits into literals, parameters, options and greedy tails", () => {
  const segments = parseRoutePath("/trending/:since/:language/:spoken_language?");
  assert.deepEqual(segments.map((segment) => [segment.kind, segment.name, segment.optional, segment.greedy]), [
    ["literal", "", false, false],
    ["param", "since", false, false],
    ["param", "language", false, false],
    ["param", "spoken_language", true, false]
  ]);

  const greedy = parseRoutePath("/file/:user/:repo/:branch/:filepath{.+}");
  assert.equal(greedy.at(-1).name, "filepath");
  assert.equal(greedy.at(-1).greedy, true, "a pattern attaches to the parameter it follows");
  assert.equal(greedy.at(-1).optional, false);

  assert.deepEqual(parseRoutePath("/81rc/:category{.+}?").at(-1), {
    kind: "param", value: ":category{.+}?", name: "category", optional: true, greedy: true
  });
  assert.deepEqual(parseRoutePath(""), []);
});

// ── example recovery ────────────────────────────────────────────────────────

test("a route's own example yields the values that produced it", () => {
  assert.deepEqual(
    exampleValues("/trending/:since/:language/:spoken_language?", "/github/trending/daily/javascript/en", "github"),
    { since: "daily", language: "javascript", spoken_language: "en" }
  );
  // A trailing optional the example omits stays absent.
  assert.deepEqual(
    exampleValues("/user/video/:uid/:embed?", "/bilibili/user/video/2267573", "bilibili"),
    { uid: "2267573" }
  );
  // A greedy parameter keeps its slashes instead of being split apart.
  assert.deepEqual(
    exampleValues("/file/:user/:repo/:branch/:filepath{.+}", "/github/file/DIYgod/RSSHub/master/lib/routes/github/routes.ts", "github"),
    { user: "DIYgod", repo: "RSSHub", branch: "master", filepath: "lib/routes/github/routes.ts" }
  );
});

test("an example that does not line up yields nothing rather than a wrong guess", () => {
  // Wrong namespace: the two are not describing the same route.
  assert.equal(exampleValues("/trending/:since", "/gitlab/trending/daily", "github"), null);
  // Too few segments to fill a required parameter.
  assert.equal(exampleValues("/trending/:since/:language", "/github/trending/daily", "github"), null);
  // A literal that does not match the example.
  assert.equal(exampleValues("/trending/:since", "/github/explore/daily", "github"), null);
  assert.equal(exampleValues("/trending/:since", "", "github"), null);
});

// ── URL filling ─────────────────────────────────────────────────────────────

test("filling a path drops trailing optionals and rejects missing required values", () => {
  assert.equal(
    fillRoutePath("/trending/:since/:language/:spoken_language?", { since: "daily", language: "javascript" }),
    "/trending/daily/javascript"
  );
  assert.equal(
    fillRoutePath("/trending/:since/:language/:spoken_language?", { since: "daily", language: "javascript", spoken_language: "en" }),
    "/trending/daily/javascript/en"
  );
  // A required value with no answer is a refusal, not a URL with a hole in it.
  assert.equal(fillRoutePath("/trending/:since/:language", { since: "daily" }), null);
  assert.equal(fillRoutePath("/trending/:since", {}), null);
  assert.equal(fillRoutePath("/trending/:since", { since: "   " }), null);
  // A greedy value is one segment even when it contains slashes.
  assert.equal(
    fillRoutePath("/file/:user/:repo/:branch/:filepath{.+}", {
      user: "DIYgod", repo: "RSSHub", branch: "master", filepath: "lib/routes/github/routes.ts"
    }),
    "/file/DIYgod/RSSHub/master/lib/routes/github/routes.ts"
  );
});

test("an optional parameter before a required one cannot be left out", () => {
  // Dropping `:middle?` would slide the required value into its place, so the
  // form must ask for it.
  assert.equal(fillRoutePath("/a/:middle?/:last", { last: "z" }), null);
  assert.equal(fillRoutePath("/a/:middle?/:last", { middle: "m", last: "z" }), "/a/m/z");
});

test("a route with no parameters fills to a path that can be subscribed as-is", () => {
  assert.equal(fillRoutePath("/hot-search", {}), "/hot-search");
});

// ── parameter metadata ──────────────────────────────────────────────────────

test("parameters come back in path order with the path's own optionality", () => {
  const parameters = routeParameters("/trending/:since/:language/:spoken_language?", {
    since: { description: "time range", options: [{ value: "daily", label: "Today" }] },
    language: { description: "language", default: "any" },
    spoken_language: "natural language",
    // Not in the path: there is nowhere to put it, so it is dropped rather than
    // silently producing a URL that means something else.
    routeParams: "extra"
  });
  assert.deepEqual(parameters.map((parameter) => parameter.name), ["since", "language", "spoken_language"]);
  assert.deepEqual(parameters.map((parameter) => parameter.optional), [false, false, true]);
  assert.deepEqual(parameters[0].options, [{ value: "daily", label: "Today" }]);
  assert.equal(parameters[1].default, "any");
  assert.equal(parameters[2].description, "natural language");
  assert.equal(parameters[2].optional, true);
});

test("a parameter with no metadata still appears, so the form can ask for it", () => {
  const parameters = routeParameters("/repos/:user", undefined);
  assert.equal(parameters.length, 1);
  assert.equal(parameters[0].name, "user");
  assert.equal(parameters[0].description, "");
  assert.deepEqual(parameters[0].options, []);
});

test("route flags name the instance configuration a route needs", () => {
  assert.deepEqual(routeFlags({ requireConfig: false }).config, []);
  assert.deepEqual(routeFlags({ requireConfig: [{ name: "A" }, { name: "B", optional: true }] }).config, ["A", "B"]);
  assert.deepEqual(routeFlags({ requireConfig: ["C"] }).config, ["C"]);
  const flags = routeFlags({ requireConfig: false, antiCrawler: true, requirePuppeteer: true, supportBT: true, supportPodcast: true });
  assert.equal(flags.antiCrawler, true);
  assert.equal(flags.puppeteer, true);
  assert.equal(flags.bt, true);
  assert.equal(flags.podcast, true);
  assert.deepEqual(routeFlags(undefined), { config: [], antiCrawler: false, puppeteer: false, bt: false, podcast: false });
});

// ── descriptions ────────────────────────────────────────────────────────────

test("a documentation description collapses into one readable line", () => {
  const text = oneLine([
    "# Title",
    "",
    "| a | b |",
    "| - | - |",
    "| 1 | 2 |",
    "",
    "The [first](https://example.com) paragraph.",
    "",
    "```js",
    "const x = 1;",
    "```",
    "",
    "::: warning",
    "careful",
    ":::"
  ].join("\n"), 200);
  assert.equal(text, "Title The first paragraph.");
  const long = oneLine("x".repeat(300), 40);
  assert.equal(long.length, 40);
  assert.ok(long.endsWith("…"));
  assert.equal(oneLine(undefined, 10), "");
});

// ── the catalogue ───────────────────────────────────────────────────────────

test("the raw registry projects into namespaces, routes and category counts", () => {
  const built = catalog();
  assert.equal(built.totals.namespaces, 4, "a null namespace and its junk routes are dropped");
  assert.equal(built.totals.routes, 6, "a null route record is dropped");
  assert.equal(built.totals.routesWithExample, 6, "every surviving route in the fixture ships an example");

  const github = built.namespaces.find((entry) => entry.id === "github");
  assert.equal(github.name, "GitHub");
  assert.equal(github.url, "github.com");
  assert.equal(github.routes, 3);
  assert.deepEqual(github.categories, ["programming"]);

  // `no-routes` declares no categories and has no routes: it still appears, so
  // a namespace is never invisible just because it is empty.
  assert.ok(built.namespaces.some((entry) => entry.id === "no-routes"));
  // Namespaces lead with the richest, which is what an unsearched picker wants.
  assert.equal(built.namespaces[0].id, "github");
});

test("categories are counted once per namespace-and-category pair", () => {
  const built = catalog();
  const programming = built.categories.find((category) => category.id === "programming");
  assert.equal(programming.count, 1, "three github routes in one category is one namespace");
  assert.equal(programming.label, "编程");
  const social = built.categories.find((category) => category.id === "social-media");
  assert.equal(social.count, 1);
  const other = built.categories.find((category) => category.id === "other");
  assert.equal(other.label, "其他");
  assert.equal(categoryLabel("unlisted-slug"), "unlisted-slug", "an unknown slug stays readable");
  assert.ok(CATEGORY_ORDER.includes("programming"));
});

test("a route carries its example, prefilled values and badges", () => {
  const built = catalog();
  const trending = routeOf(built, "github", "/trending/:since/:language/:spoken_language?");
  assert.equal(trending.name, "Trending");
  assert.equal(trending.example, "/github/trending/daily/javascript/en");
  assert.deepEqual(trending.values, { since: "daily", language: "javascript", spoken_language: "en" });
  assert.equal(trending.site, "GitHub");
  assert.ok(trending.description.startsWith("See what the GitHub community"));
  assert.deepEqual(trending.flags.config, []);

  const repos = routeOf(built, "github", "/repos/:user");
  assert.deepEqual(repos.flags.config, ["GITHUB_ACCESS_TOKEN"]);
  assert.equal(repos.flags.antiCrawler, true);

  // A route with no parameters still recovers from its example — there is
  // simply nothing to fill in, which is different from "no example at all".
  const noParams = routeOf(built, "broken", "/good");
  assert.deepEqual(noParams.values, {});
  const noExample = buildCatalog({ x: { name: "X", routes: { "/a/:b": { path: "/a/:b", name: "A" } } } });
  assert.equal(noExample.routes[0].values, null, "without an example there is nothing to prefill from");
});

test("a namespace without its own categories borrows the ones its routes declare", () => {
  const built = buildCatalog({
    thing: { name: "Thing", routes: { "/a": { path: "/a", name: "A", categories: ["game", "anime"] } } }
  });
  const namespace = built.namespaces.find((entry) => entry.id === "thing");
  assert.deepEqual([...namespace.categories].sort(), ["anime", "game"]);
});

// ── querying ────────────────────────────────────────────────────────────────

test("browsing with no filter lists namespaces and the first page of routes", () => {
  const page = queryCatalog(catalog(), {});
  assert.equal(page.total, 6);
  assert.equal(page.routes.length, 6);
  assert.ok(page.namespaceTotal >= 4);
  assert.ok(page.categories.length >= 3);
  assert.equal(page.offset, 0);
});

test("a category narrows both the namespaces and the routes", () => {
  const page = queryCatalog(catalog(), { category: "social-media" });
  assert.deepEqual(page.namespaces.map((entry) => entry.id), ["bilibili"]);
  assert.deepEqual(page.routes.map((route) => route.namespace), ["bilibili", "bilibili"]);
  assert.equal(page.total, 2);
});

test("a namespace lists its own routes", () => {
  const page = queryCatalog(catalog(), { namespace: "github" });
  assert.equal(page.total, 3);
  assert.deepEqual(page.routes.map((route) => route.namespace), ["github", "github", "github"]);
  // The level above is not offered once a namespace is chosen.
  assert.deepEqual(page.namespaces, []);
});

test("a search ranks the namespace itself above a route that merely mentions it", () => {
  const page = queryCatalog(catalog(), { q: "github" });
  assert.equal(page.namespaces[0].id, "github");
  assert.ok(page.total >= 3);
  const names = page.routes.map((route) => `${route.namespace}${route.path}`);
  assert.ok(names.includes("github/repos/:user"), "a path match still finds the route");
});

test("a search finds a route by its display name and by its Chinese site name", () => {
  assert.ok(queryCatalog(catalog(), { q: "热搜" }).routes.some((route) => route.path === "/hot-search"));
  assert.ok(queryCatalog(catalog(), { q: "UP 主投稿" }).routes.some((route) => route.path === "/user/video/:uid/:embed?"));
  assert.equal(queryCatalog(catalog(), { q: "no-such-route-anywhere" }).total, 0);
});

test("paging is bounded and reports the unpaged total", () => {
  const first = queryCatalog(catalog(), { limit: 2, offset: 0 });
  assert.equal(first.routes.length, 2);
  assert.equal(first.total, 6);
  const second = queryCatalog(catalog(), { limit: 2, offset: 2 });
  assert.notDeepEqual(second.routes.map((route) => route.path), first.routes.map((route) => route.path));
  assert.equal(queryCatalog(catalog(), { limit: 10_000 }).limit, MAX_PAGE, "a client cannot ask for everything");
  assert.equal(queryCatalog(catalog(), { offset: 99 }).routes.length, 0);
});

// ── the client ──────────────────────────────────────────────────────────────

/** A `fetch` double that serves the fixture body and counts calls. */
function stubFetch(handler) {
  const calls = [];
  const impl = async (url, init) => {
    calls.push({ url: String(url), init });
    return handler(String(url), init);
  };
  impl.calls = calls;
  return impl;
}

/** A 200 response carrying `body`. */
function jsonResponse(body, status = 200) {
  return {
    status,
    async text() {
      return typeof body === "string" ? body : JSON.stringify(body);
    }
  };
}

test("the catalogue client fetches once and serves later reads from memory", async () => {
  const impl = stubFetch(() => jsonResponse(registry()));
  const client = new CatalogClient({ base: "https://hub.test", fetchImpl: impl });

  const first = await client.list({ namespace: "github" });
  assert.equal(first.total, 3);
  assert.equal(first.base, "https://hub.test");
  assert.equal(first.totals.namespaces, 4);
  assert.equal(impl.calls.length, 1);
  assert.equal(impl.calls[0].url, "https://hub.test/api/namespace");

  await client.list({ q: "bilibili" });
  assert.equal(impl.calls.length, 1, "a warm catalogue is not refetched per keystroke");

  // Concurrent callers share one in-flight read rather than racing for it.
  client.clear();
  await Promise.all([client.list({}), client.list({})]);
  assert.equal(impl.calls.length, 2);
});

test("a forced read bypasses the cache, and clearing it does too", async () => {
  const impl = stubFetch(() => jsonResponse(registry()));
  const client = new CatalogClient({ base: "https://hub.test", fetchImpl: impl });
  await client.list({});
  await client.list({ refresh: true });
  assert.equal(impl.calls.length, 2);
  client.clear();
  assert.equal(client.fresh, false);
  await client.list({});
  assert.equal(impl.calls.length, 3);
});

test("a stale catalogue is refetched once its window closes", async () => {
  const impl = stubFetch(() => jsonResponse(registry()));
  const client = new CatalogClient({ base: "https://hub.test", fetchImpl: impl, cacheTtlMs: 0 });
  await client.list({});
  await client.list({});
  assert.equal(impl.calls.length, 2);
});

test("a catalog client reports the instance's failure in words the panel can show", async () => {
  const notFound = new CatalogClient({ base: "https://hub.test", fetchImpl: stubFetch(() => jsonResponse("nope", 404)) });
  // A missing registry endpoint is this deployment's gap, not a broken upstream.
  await assert.rejects(() => notFound.load(), (error) => error.statusCode === 503 && /HTTP 404/.test(error.message));

  const broken = new CatalogClient({ base: "https://hub.test", fetchImpl: stubFetch(() => jsonResponse("nope", 500)) });
  await assert.rejects(() => broken.load(), (error) => error.statusCode === 502);

  const garbage = new CatalogClient({ base: "https://hub.test", fetchImpl: stubFetch(() => jsonResponse("<html>proxy</html>")) });
  await assert.rejects(() => garbage.load(), (error) => error.statusCode === 502 && /不是合法 JSON/.test(error.message));

  const wrongShape = new CatalogClient({ base: "https://hub.test", fetchImpl: stubFetch(() => jsonResponse([1, 2, 3])) });
  await assert.rejects(() => wrongShape.load(), (error) => error.statusCode === 502 && /格式不认识/.test(error.message));

  const offline = new CatalogClient({
    base: "https://hub.test",
    fetchImpl: stubFetch(() => {
      throw new Error("getaddrinfo ENOTFOUND");
    })
  });
  await assert.rejects(() => offline.load(), (error) => error.statusCode === 502 && /无法连接 RSSHub 实例/.test(error.message));

  const timeout = new CatalogClient({
    base: "https://hub.test",
    fetchImpl: stubFetch(() => {
      const error = new Error("timed out");
      error.name = "TimeoutError";
      throw error;
    })
  });
  await assert.rejects(() => timeout.load(), (error) => error.statusCode === 502 && /超时/.test(error.message));
});

test("a failed read is not cached as if it were a catalogue", async () => {
  let mode = "fail";
  const impl = stubFetch(() => (mode === "fail" ? jsonResponse("", 502) : jsonResponse(registry())));
  const client = new CatalogClient({ base: "https://hub.test", fetchImpl: impl });
  await assert.rejects(() => client.load());
  mode = "ok";
  const page = await client.list({});
  assert.equal(page.total, 6, "the next read is allowed to succeed");
});
