/**
 * dsh-rss-reader — store, refresh orchestration, and API surface tests.
 *
 * The network is never touched: `globalThis.fetch` is replaced per test so the
 * full refresh path (conditional GET, error recording, de-duplication) runs
 * deterministically.
 */

import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

import { FeedStore, defaultStorePath } from "../lib/store.js";
import { RefreshCoordinator, mapWithConcurrency, refreshFeed, refreshFeeds } from "../lib/refresh.js";
import { FeedFetchError, normalizeFeedUrl } from "../lib/fetch.js";
import { API_PREFIX, createRoutes, isLocalUiRequest, readJsonBody, statusForError } from "../lib/api.js";
import { renderDigest } from "../lib/index.js";

/** Create a scratch directory that is removed when the process exits. */
const scratchDirs = [];
async function scratch() {
  const dir = await mkdtemp(join(tmpdir(), "rss-reader-test-"));
  scratchDirs.push(dir);
  return dir;
}
after(async () => {
  for (const dir of scratchDirs) await rm(dir, { recursive: true, force: true });
});

/** Build a store backed by a temporary file. */
async function makeStore(options = {}) {
  const dir = await scratch();
  const store = new FeedStore({ file: join(dir, "feeds.json"), ...options });
  await store.load();
  return store;
}

const SAMPLE = `<rss version="2.0"><channel><title>Sample</title><link>https://s.test/</link>
  <item><title>One</title><link>https://s.test/1</link><pubDate>Wed, 01 May 2024 10:00:00 GMT</pubDate><description>first</description></item>
  <item><title>Two</title><link>https://s.test/2</link><pubDate>Thu, 02 May 2024 10:00:00 GMT</pubDate><description>second</description></item>
</channel></rss>`;

/** Install a fake fetch returning the given responses in order. */
function stubFetch(responses) {
  const original = globalThis.fetch;
  const calls = [];
  let index = 0;
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), headers: init?.headers ?? {} });
    const next = responses[Math.min(index, responses.length - 1)];
    index += 1;
    if (typeof next === "function") return next(String(url), init, calls.length);
    return next;
  };
  return {
    calls,
    restore: () => {
      globalThis.fetch = original;
    }
  };
}

/** Build a Response-like object with a real stream body. */
function response(body, { status = 200, headers = {}, url = "https://s.test/feed.xml" } = {}) {
  const bytes = new TextEncoder().encode(body);
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 304 ? "Not Modified" : "OK",
    url,
    headers: new Headers({ "content-type": "application/rss+xml", ...headers }),
    body: new ReadableStream({
      start(controller) {
        if (bytes.length > 0) controller.enqueue(bytes);
        controller.close();
      }
    })
  };
}

// ── URL normalization ───────────────────────────────────────────────────────

test("normalizeFeedUrl assumes https for a bare host and rejects other schemes", () => {
  assert.equal(normalizeFeedUrl("example.com/feed"), "https://example.com/feed");
  assert.equal(normalizeFeedUrl("http://example.com/feed"), "http://example.com/feed");
  assert.equal(normalizeFeedUrl("  https://example.com/f#frag  "), "https://example.com/f");
  assert.throws(() => normalizeFeedUrl(""), /empty/);
  assert.throws(() => normalizeFeedUrl("ftp://example.com/f"), /unsupported URL scheme/);
  assert.throws(() => normalizeFeedUrl("https://"), /not a valid URL|no host|Invalid URL/);
});

// ── Store ───────────────────────────────────────────────────────────────────

test("store adds feeds, de-duplicates by URL, and persists to disk", async () => {
  const store = await makeStore();
  const first = store.add({ url: "https://a.test/feed", title: "A" });
  assert.equal(first.created, true);
  assert.equal(first.feed.title, "A");

  // The same URL must not create a second subscription.
  const again = store.add({ url: "https://a.test/feed", title: "A renamed" });
  assert.equal(again.created, false);
  assert.equal(store.list().length, 1);
  assert.equal(again.feed.title, "A renamed");

  await store.flush();
  const reloaded = new FeedStore({ file: store.file });
  await reloaded.load();
  assert.equal(reloaded.list().length, 1);
  assert.equal(reloaded.list()[0].title, "A renamed");
});

test("store rejects a missing URL and enforces the feed cap", async () => {
  const store = await makeStore({ maxFeeds: 1 });
  assert.throws(() => store.add({}), /URL is required/);
  store.add({ url: "https://a.test/feed" });
  assert.throws(() => store.add({ url: "https://b.test/feed" }), /subscription limit/);
});

test("store merges fetched items and preserves read/starred flags", async () => {
  const store = await makeStore();
  const { feed } = store.add({ url: "https://s.test/feed" });
  const first = store.applyFetch(feed.id, {
    feed: { title: "Sample", link: "https://s.test/", description: "d", image: "", format: "rss", items: [
      { id: "1", title: "One", link: "https://s.test/1", summary: "first", content: "", author: "", date: "2024-05-01T10:00:00.000Z", categories: [], enclosure: "" },
      { id: "2", title: "Two", link: "https://s.test/2", summary: "second", content: "", author: "", date: "2024-05-02T10:00:00.000Z", categories: [], enclosure: "" }
    ] },
    url: "https://s.test/feed",
    etag: 'W/"1"',
    lastModified: "Wed, 01 May 2024 10:00:00 GMT"
  });
  assert.equal(first.added, 2);
  assert.equal(feed.title, "Sample");
  assert.equal(feed.etag, 'W/"1"');

  // Mark one read; a later fetch must not resurrect it as unread.
  store.setItemFlags(feed.id, "1", { read: true, starred: true });
  const second = store.applyFetch(feed.id, {
    feed: { title: "Sample", link: "https://s.test/", description: "d", image: "", format: "rss", items: [
      { id: "1", title: "One (edited)", link: "https://s.test/1", summary: "first", content: "", author: "", date: "2024-05-01T10:00:00.000Z", categories: [], enclosure: "" },
      { id: "3", title: "Three", link: "https://s.test/3", summary: "third", content: "", author: "", date: "2024-05-03T10:00:00.000Z", categories: [], enclosure: "" }
    ] },
    url: "https://s.test/feed",
    etag: "",
    lastModified: ""
  });
  assert.equal(second.added, 1, "only the genuinely new item counts");
  const item1 = feed.items.find((item) => item.id === "1");
  assert.equal(item1.read, true, "read flag survives a refresh");
  assert.equal(item1.starred, true);
  assert.equal(item1.title, "One (edited)", "presentation fields still refresh");
});

test("store keeps one row when a feed lists the same guid twice", async () => {
  const store = await makeStore();
  const { feed } = store.add({ url: "https://s.test/feed" });
  const STORY = "https://s.test/introducing-gpt-6-1-sol";
  const story = (date) => ({
    id: STORY,
    title: "Introducing GPT-6.1 Sol",
    link: STORY,
    summary: "Meet GPT-6.1 Sol",
    content: "",
    author: "",
    date,
    categories: [],
    enclosure: ""
  });
  const fetched = () => ({
    feed: { title: "S", link: "", description: "", image: "", format: "rss", items: [story("2026-09-29T17:00:00.000Z"), story("2026-09-29T10:00:00.000Z")] },
    url: "",
    etag: "",
    lastModified: ""
  });

  const first = store.applyFetch(feed.id, fetched());
  assert.equal(first.added, 1, "one story, however many times the feed lists it");
  assert.equal(feed.items.length, 1, "the second copy must not be stored");
  assert.equal(feed.items[0].date, "2026-09-29T17:00:00.000Z", "the newest copy is the one kept");
  assert.equal(store.snapshot().totals.unread, 1, "a duplicate must not be counted twice");

  // Reading it clears it for good: the next refresh neither resurrects it as
  // unread nor reports the twin as a new item.
  store.setItemFlags(feed.id, STORY, { read: true });
  assert.equal(store.snapshot().totals.unread, 0);
  const second = store.applyFetch(feed.id, fetched());
  assert.equal(second.added, 0, "a repeated guid is never a new item");
  assert.equal(feed.items.length, 1);
  assert.equal(feed.items[0].read, true, "the read flag survives the refresh");
});

test("store repairs a duplicated item it reads off disk", async () => {
  const dir = await scratch();
  const file = join(dir, "feeds.json");
  const stored = (date, read) => ({
    id: "https://s.test/introducing-gpt-6-1-sol",
    title: "Introducing GPT-6.1 Sol",
    link: "https://s.test/introducing-gpt-6-1-sol",
    summary: "Meet GPT-6.1 Sol",
    summaryMarkdown: "",
    content: "",
    markdown: "",
    author: "",
    date,
    categories: [],
    enclosure: "",
    read,
    starred: false,
    translation: null
  });
  await writeFile(file, JSON.stringify({
    version: 1,
    feeds: [{
      id: "f1",
      url: "https://s.test/feed",
      title: "S",
      items: [stored("2026-09-29T17:00:00.000Z", true), stored("2026-09-29T10:00:00.000Z", false)]
    }]
  }), "utf8");

  const store = new FeedStore({ file });
  await store.load();
  const items = store.list()[0].items;
  assert.equal(items.length, 1, "a pair written before the fix is collapsed on load");
  // The reader did read this story: the copy carrying that flag is what remains.
  assert.equal(items[0].read, true);
  assert.equal(store.snapshot().totals.unread, 0);
});

test("store trims each feed to its retention cap, keeping the newest", async () => {
  const store = await makeStore({ maxItemsPerFeed: 3 });
  const { feed } = store.add({ url: "https://s.test/feed" });
  const items = Array.from({ length: 10 }, (_, i) => ({
    id: `i${i}`, title: `T${i}`, link: `https://s.test/${i}`, summary: "", content: "",
    author: "", date: `2024-05-0${(i % 9) + 1}T00:00:00.000Z`, categories: [], enclosure: ""
  }));
  store.applyFetch(feed.id, { feed: { items, title: "S", link: "", description: "", image: "", format: "rss" }, url: "", etag: "", lastModified: "" });
  assert.equal(feed.items.length, 3);
  assert.deepEqual(feed.items.map((item) => item.id), ["i0", "i1", "i2"]);
});

test("store records a fetch error without discarding cached items", async () => {
  const store = await makeStore();
  const { feed } = store.add({ url: "https://s.test/feed" });
  store.applyFetch(feed.id, { feed: { items: [{ id: "1", title: "One", link: "", summary: "", content: "", author: "", date: "", categories: [], enclosure: "" }], title: "S", link: "", description: "", image: "", format: "rss" }, url: "", etag: "", lastModified: "" });
  store.applyError(feed.id, "boom");
  assert.equal(feed.lastError, "boom");
  assert.equal(feed.items.length, 1, "cached items survive a failed refresh");

  // A later success clears the error.
  store.applyFetch(feed.id, { notModified: true });
  assert.equal(feed.lastError, "");
});

test("store marks all items read and reports unread counts", async () => {
  const store = await makeStore();
  const { feed } = store.add({ url: "https://s.test/feed" });
  store.applyFetch(feed.id, { feed: { items: [
    { id: "1", title: "a", link: "", summary: "", content: "", author: "", date: "", categories: [], enclosure: "" },
    { id: "2", title: "b", link: "", summary: "", content: "", author: "", date: "", categories: [], enclosure: "" }
  ], title: "S", link: "", description: "", image: "", format: "rss" }, url: "", etag: "", lastModified: "" });
  assert.equal(store.snapshot().totals.unread, 2);
  assert.equal(store.markAllRead(feed.id), 2);
  assert.equal(store.snapshot().totals.unread, 0);
  // A second call changes nothing.
  assert.equal(store.markAllRead(feed.id), 0);
});

test("store recovers from a corrupt state file instead of crashing", async () => {
  const dir = await scratch();
  const file = join(dir, "feeds.json");
  await writeFile(file, "{ this is not json", "utf8");
  const store = new FeedStore({ file });
  await store.load();
  assert.equal(store.list().length, 0);
  // The unreadable file is preserved for inspection, not silently destroyed.
  const entries = await readdir(dir);
  assert.ok(entries.some((name) => name.includes("corrupt")), `expected a corrupt backup, got ${entries.join(",")}`);
});

test("store ignores unusable records in an otherwise valid file", async () => {
  const dir = await scratch();
  const file = join(dir, "feeds.json");
  await writeFile(file, JSON.stringify({
    version: 1,
    feeds: [
      null,
      "nonsense",
      { url: "" },
      { id: "keep", url: "https://keep.test/feed", title: "Keep", items: [{ id: "x", title: "t" }, null, 5] }
    ]
  }), "utf8");
  const store = new FeedStore({ file });
  await store.load();
  assert.equal(store.list().length, 1);
  assert.equal(store.list()[0].id, "keep");
  assert.equal(store.list()[0].items.length, 1);
});

test("store writes atomically, leaving no temp file behind", async () => {
  const store = await makeStore();
  store.add({ url: "https://a.test/feed" });
  await store.flush();
  const entries = await readdir(join(store.file, ".."));
  assert.ok(!entries.some((name) => name.includes(".tmp-")), `temp file left behind: ${entries.join(",")}`);
  const written = JSON.parse(await readFile(store.file, "utf8"));
  assert.equal(written.feeds.length, 1);
});

test("store update applies whitelisted fields and rejects a blank title", async () => {
  const store = await makeStore();
  const { feed } = store.add({ url: "https://a.test/feed", title: "Original" });
  store.update(feed.id, { title: "Changed", group: "news", bogus: "ignored", id: "hacked" });
  assert.equal(feed.title, "Changed");
  assert.equal(feed.group, "news");
  assert.equal(feed.id, "hacked" === feed.id ? feed.id : feed.id, "id is never reassigned");
  assert.equal(feed.bogus, undefined);
  store.update(feed.id, { title: "   " });
  assert.equal(feed.title, "Changed", "a blank title does not clobber the existing one");
});

test("defaultStorePath honours DSH_HOME and defaults to ~/.dsh", () => {
  // Generic roots, not a real machine's: the point is only that an absolute
  // `DSH_HOME` wins, and that a blank one falls back to the home directory.
  const fallback = join("<home>", ".dsh", "rss-reader", "feeds.json");
  assert.equal(defaultStorePath({ DSH_HOME: "   " }, "<home>"), fallback);
  assert.equal(
    defaultStorePath({ DSH_HOME: "/dsh-home" }, "<home>"),
    join("/dsh-home", "rss-reader", "feeds.json")
  );
});

// ── Concurrency helper ──────────────────────────────────────────────────────

test("mapWithConcurrency preserves input order and respects the limit", async () => {
  let active = 0;
  let peak = 0;
  const result = await mapWithConcurrency([1, 2, 3, 4, 5, 6], 2, async (value) => {
    active += 1;
    peak = Math.max(peak, active);
    await new Promise((resolve) => setTimeout(resolve, 5));
    active -= 1;
    return value * 2;
  });
  assert.deepEqual(result, [2, 4, 6, 8, 10, 12]);
  assert.ok(peak <= 2, `expected at most 2 concurrent workers, saw ${peak}`);
});

test("mapWithConcurrency handles an empty list and a limit above the item count", async () => {
  assert.deepEqual(await mapWithConcurrency([], 4, async () => 1), []);
  assert.deepEqual(await mapWithConcurrency([1, 2], 99, async (v) => v), [1, 2]);
});

// ── Refresh ─────────────────────────────────────────────────────────────────

test("refreshFeed stores items and replays the ETag on the next call", async () => {
  const store = await makeStore();
  const { feed } = store.add({ url: "https://s.test/feed" });
  const stub = stubFetch([response(SAMPLE, { headers: { etag: 'W/"abc"' } })]);
  try {
    const outcome = await refreshFeed(store, feed.id);
    assert.equal(outcome.ok, true);
    assert.equal(outcome.added, 2);
    assert.equal(feed.etag, 'W/"abc"');

    // Second pass: the validator must be sent and a 304 must add nothing.
    stub.calls.length = 0;
    globalThis.fetch = async (url, init) => {
      stub.calls.push({ url: String(url), headers: init?.headers ?? {} });
      return response("", { status: 304 });
    };
    const second = await refreshFeed(store, feed.id);
    assert.equal(second.notModified, true);
    assert.equal(second.added, 0);
    assert.equal(stub.calls[0].headers["if-none-match"], 'W/"abc"');
  } finally {
    stub.restore();
  }
});

test("refreshFeed records an HTTP failure on the feed and reports it", async () => {
  const store = await makeStore();
  const { feed } = store.add({ url: "https://s.test/feed" });
  const stub = stubFetch([response("nope", { status: 500 })]);
  try {
    const outcome = await refreshFeed(store, feed.id);
    assert.equal(outcome.ok, false);
    assert.match(outcome.error, /HTTP 500/);
    assert.match(feed.lastError, /HTTP 500/);
  } finally {
    stub.restore();
  }
});

test("refreshFeed reports a friendly error for an HTML page with no feed", async () => {
  const store = await makeStore();
  const { feed } = store.add({ url: "https://site.test/page" });
  const stub = stubFetch([response("<html><body>no feed here</body></html>", { headers: { "content-type": "text/html" } })]);
  try {
    const outcome = await refreshFeed(store, feed.id, { discover: true });
    assert.equal(outcome.ok, false);
    assert.match(outcome.error, /no RSS\/Atom feed advertised/);
  } finally {
    stub.restore();
  }
});

test("refreshFeed follows an advertised feed when given a site URL", async () => {
  const store = await makeStore();
  const { feed } = store.add({ url: "https://site.test/" });
  const html = '<html><head><link rel="alternate" type="application/rss+xml" href="/feed.xml"></head></html>';
  const stub = stubFetch([
    response(html, { headers: { "content-type": "text/html" }, url: "https://site.test/" }),
    response(SAMPLE)
  ]);
  try {
    const outcome = await refreshFeed(store, feed.id);
    assert.equal(outcome.ok, true);
    assert.equal(outcome.added, 2);
    assert.equal(feed.items.length, 2);
  } finally {
    stub.restore();
  }
});

test("refreshFeed refuses to buffer a response past the size cap", async () => {
  const store = await makeStore();
  const { feed } = store.add({ url: "https://big.test/feed" });
  const big = "x".repeat(50_000);
  const stub = stubFetch([response(big)]);
  try {
    const outcome = await refreshFeed(store, feed.id, { maxBytes: 1024 });
    assert.equal(outcome.ok, false);
    assert.match(outcome.error, /too large/);
  } finally {
    stub.restore();
  }
});

test("refreshFeed reports a timeout when the request never settles", async () => {
  const store = await makeStore();
  const { feed } = store.add({ url: "https://slow.test/feed" });
  const original = globalThis.fetch;
  globalThis.fetch = async () => {
    const error = new Error("timed out");
    error.name = "TimeoutError";
    throw error;
  };
  try {
    const outcome = await refreshFeed(store, feed.id, { timeoutMs: 1000 });
    assert.equal(outcome.ok, false);
    assert.equal(outcome.code, "timeout");
  } finally {
    globalThis.fetch = original;
  }
});

test("refreshFeed isolates one dead feed from the rest of a batch", async () => {
  const store = await makeStore();
  const a = store.add({ url: "https://good.test/feed" }).feed;
  const b = store.add({ url: "https://bad.test/feed" }).feed;
  const original = globalThis.fetch;
  globalThis.fetch = async (url) => {
    if (String(url).includes("bad.test")) return response("no", { status: 404 });
    return response(SAMPLE);
  };
  try {
    const summary = await refreshFeeds(store, { concurrency: 2 });
    assert.equal(summary.refreshed, 1);
    assert.equal(summary.failed, 1);
    assert.equal(summary.added, 2);
    assert.equal(a.lastError, "");
    assert.match(b.lastError, /HTTP 404/);
  } finally {
    globalThis.fetch = original;
  }
});

test("RefreshCoordinator reuses an in-flight pass instead of stacking requests", async () => {
  const store = await makeStore();
  store.add({ url: "https://s.test/feed" });
  let hits = 0;
  const original = globalThis.fetch;
  globalThis.fetch = async () => {
    hits += 1;
    await new Promise((resolve) => setTimeout(resolve, 10));
    return response(SAMPLE);
  };
  try {
    const coordinator = new RefreshCoordinator();
    const [first, second] = await Promise.all([coordinator.run(store), coordinator.run(store)]);
    assert.equal(hits, 1, "the second call joined the first pass");
    assert.equal(first, second, "both callers observe the same summary");
    assert.equal(coordinator.busy, false, "the guard clears once settled");
    // A later pass runs again.
    await coordinator.run(store);
    assert.equal(hits, 2);
  } finally {
    globalThis.fetch = original;
  }
});

// ── API ─────────────────────────────────────────────────────────────────────

/**
 * Invoke a route with a minimal request/response double.
 *
 * Route matching ignores the query string, mirroring the real webserver, which
 * matches on `pathname` and hands the handler the full `req.url`.
 */
async function invoke(routes, path, { method = "GET", body, headers = {}, url } = {}) {
  const pathname = path.split("?")[0];
  const route = routes.find((candidate) => candidate.path === pathname);
  assert.ok(route !== undefined, `no route for ${pathname}`);
  const chunks = body === undefined ? [] : [Buffer.from(JSON.stringify(body), "utf8")];
  const req = {
    method,
    url: url ?? path,
    headers: {
      host: "127.0.0.1:3080",
      origin: "http://127.0.0.1:3080",
      "sec-fetch-site": "same-origin",
      ...headers
    },
    socket: { remoteAddress: "127.0.0.1" },
    async *[Symbol.asyncIterator]() {
      for (const chunk of chunks) yield chunk;
    }
  };
  let status = 0;
  let payload = "";
  const res = {
    writeHead(code) {
      status = code;
      return res;
    },
    end(text) {
      payload = text ?? "";
    }
  };
  await route.handler(req, res);
  return { status, body: payload.length > 0 ? JSON.parse(payload) : undefined };
}

/** Build a route table over a fresh store. */
async function makeRoutes() {
  const store = await makeStore();
  return { store, routes: createRoutes({ store, coordinator: new RefreshCoordinator() }) };
}

test("all API routes live under the plugin prefix", async () => {
  const { routes } = await makeRoutes();
  for (const route of routes) {
    assert.ok(route.path.startsWith(API_PREFIX), `${route.path} escapes the prefix`);
    assert.equal(route.kind, "exact");
    assert.equal(typeof route.handler, "function");
  }
});

test("API state route returns the snapshot and a refresh flag", async () => {
  const { routes } = await makeRoutes();
  const res = await invoke(routes, `${API_PREFIX}/state`);
  assert.equal(res.status, 200);
  assert.equal(res.body.ok, true);
  assert.deepEqual(res.body.state.feeds, []);
  assert.equal(res.body.state.totals.feeds, 0);
  assert.equal(res.body.refreshing, false);
});

test("API adds a feed, lists it, then deletes it", async () => {
  const { store, routes } = await makeRoutes();
  const stub = stubFetch([response(SAMPLE)]);
  try {
    const added = await invoke(routes, `${API_PREFIX}/feeds`, {
      method: "POST",
      body: { url: "https://s.test/feed", refresh: true }
    });
    assert.equal(added.status, 201);
    assert.equal(added.body.created, true);
    assert.equal(added.body.outcome.ok, true);
    assert.equal(added.body.state.feeds.length, 1);
    const id = added.body.feedId;

    const listed = await invoke(routes, `${API_PREFIX}/state`);
    assert.equal(listed.body.state.feeds[0].items.length, 2);
    assert.equal(listed.body.state.totals.unread, 2);

    const removed = await invoke(routes, `${API_PREFIX}/feeds`, {
      method: "DELETE",
      url: `${API_PREFIX}/feeds?id=${id}`
    });
    assert.equal(removed.status, 200);
    assert.equal(removed.body.state.feeds.length, 0);
    assert.equal(store.list().length, 0);
  } finally {
    stub.restore();
  }
});

test("API rejects an invalid feed URL with a 4xx and a readable message", async () => {
  const { routes } = await makeRoutes();
  const res = await invoke(routes, `${API_PREFIX}/feeds`, { method: "POST", body: { url: "ftp://x.test/f" } });
  // A caller's own bad input is a 400, not a 500 — the UI must be able to tell
  // "you typed this wrong" apart from "the plugin broke".
  assert.equal(res.status, 400);
  assert.equal(res.body.ok, false);
  assert.match(res.body.error, /unsupported URL scheme/);

  const empty = await invoke(routes, `${API_PREFIX}/feeds`, { method: "POST", body: { url: "   " } });
  assert.equal(empty.status, 400);
  assert.match(empty.body.error, /empty/);
});

test("API returns 404 for an unknown feed on DELETE and PATCH", async () => {
  const { routes } = await makeRoutes();
  const deleted = await invoke(routes, `${API_PREFIX}/feeds`, { method: "DELETE", url: `${API_PREFIX}/feeds?id=nope` });
  assert.equal(deleted.status, 404);
  const patched = await invoke(routes, `${API_PREFIX}/items`, {
    method: "PATCH",
    body: { feedId: "nope", itemId: "x", read: true }
  });
  assert.equal(patched.status, 404);
});

test("API reports an unreachable feed as a 502 without failing the request", async () => {
  const { routes } = await makeRoutes();
  const stub = stubFetch([response("nope", { status: 500 })]);
  try {
    const res = await invoke(routes, `${API_PREFIX}/feeds`, {
      method: "POST",
      body: { url: "https://down.test/feed", refresh: true }
    });
    // The subscription itself succeeded; only its first fetch failed, and that
    // is reported inside the envelope rather than as a transport error.
    assert.equal(res.status, 201);
    assert.equal(res.body.ok, true);
    assert.equal(res.body.outcome.ok, false);
    assert.match(res.body.outcome.error, /HTTP 500/);
    assert.equal(res.body.state.feeds.length, 1);
    assert.match(res.body.state.feeds[0].lastError, /HTTP 500/);
  } finally {
    stub.restore();
  }
});

test("API discovery reports an unreachable site as a 502", async () => {
  const { routes } = await makeRoutes();
  const original = globalThis.fetch;
  globalThis.fetch = async () => {
    const error = new Error("timed out");
    error.name = "TimeoutError";
    throw error;
  };
  try {
    const res = await invoke(routes, `${API_PREFIX}/discover`, {
      method: "POST",
      body: { url: "https://slow.test/", timeoutMs: 1000 }
    });
    assert.equal(res.status, 502);
    assert.match(res.body.error, /timed out/);
  } finally {
    globalThis.fetch = original;
  }
});

test("API rejects a wrong method with 405", async () => {
  const { routes } = await makeRoutes();
  const res = await invoke(routes, `${API_PREFIX}/state`, { method: "POST" });
  assert.equal(res.status, 405);
  assert.match(res.body.error, /method not allowed/);
});

// ── RSSHub discovery ────────────────────────────────────────────────────────

/** An RSSHub client double recording calls and returning a canned result. */
function fakeRsshub(result = { candidates: [], site: "", domain: "", reason: "" }) {
  return {
    base: "https://rsshub.test",
    calls: [],
    async discover(url, options) {
      this.calls.push({ url, options });
      return { candidates: [], site: "", domain: "", reason: "", base: this.base, ...result };
    },
    async listRoutes(domain, options) {
      this.calls.push({ domain, options });
      return { routes: [
        { title: "Needs A Page", route: "/x/:id", docs: "", needsParams: true }
      ], site: "Example", total: 24, base: this.base };
    }
  };
}

test("discovery merges the page's feeds with RSSHub routes", async () => {
  const stub = stubFetch([response(PAGE_WITH_FEED)]);
  try {
    const rsshub = fakeRsshub({
      candidates: [{ title: "UP 主动态", url: "https://rsshub.test/bilibili/user/dynamic/2267573", route: "/bilibili/user/dynamic/2267573" }],
      site: "哔哩哔哩",
      domain: "bilibili.com"
    });
    const store = await makeStore();
    const routes = createRoutes({ store, coordinator: new RefreshCoordinator(), rsshub });

    const res = await invoke(routes, `${API_PREFIX}/discover`, {
      method: "POST",
      body: { url: "https://space.bilibili.com/2267573" }
    });
    assert.equal(res.status, 200);
    const kinds = res.body.candidates.map((candidate) => candidate.kind);
    assert.ok(kinds.includes("feed"), "the page's own feed is included");
    assert.ok(kinds.includes("rsshub"), "the RSSHub route is included");
    // The page's declared feed comes first so it wins any duplicate.
    assert.equal(res.body.candidates[0].kind, "feed");
    assert.equal(res.body.rsshub.enabled, true);
    assert.equal(res.body.rsshub.base, "https://rsshub.test");
    assert.equal(res.body.rsshub.site, "哔哩哔哩");
  } finally {
    stub.restore();
  }
});

test("discovery reports RSSHub as disabled when no client is configured", async () => {
  const store = await makeStore();
  const routes = createRoutes({ store, coordinator: new RefreshCoordinator() });
  const res = await invoke(routes, `${API_PREFIX}/discover`, { method: "POST", body: { url: "https://x.test/", page: false } });
  assert.equal(res.status, 200);
  assert.equal(res.body.rsshub.enabled, false);
  assert.deepEqual(res.body.candidates, []);
});

test("discovery can suppress either stage on request", async () => {
  const stub = stubFetch([response(PAGE_WITH_FEED)]);
  try {
    const rsshub = fakeRsshub({ candidates: [{ title: "R", url: "https://rsshub.test/r", route: "/r" }] });
    const store = await makeStore();
    const routes = createRoutes({ store, coordinator: new RefreshCoordinator(), rsshub });

    const noPage = await invoke(routes, `${API_PREFIX}/discover`, {
      method: "POST",
      body: { url: "https://x.test/", page: false }
    });
    assert.deepEqual(noPage.body.candidates.map((c) => c.kind), ["rsshub"], "only RSSHub ran");

    const noRsshub = await invoke(routes, `${API_PREFIX}/discover`, {
      method: "POST",
      body: { url: "https://x.test/", rsshub: false }
    });
    assert.deepEqual(noRsshub.body.candidates.map((c) => c.kind), ["feed"], "only the page was read");
  } finally {
    stub.restore();
  }
});

test("discovery lists a covered domain's routes when the path matches nothing", async () => {
  const stub = stubFetch([response(PAGE_WITH_FEED)]);
  try {
    const rsshub = fakeRsshub({ site: "Example", domain: "example.com" });
    const store = await makeStore();
    const routes = createRoutes({ store, coordinator: new RefreshCoordinator(), rsshub });

    const res = await invoke(routes, `${API_PREFIX}/discover`, {
      method: "POST",
      body: { url: "https://example.com/", page: false }
    });
    assert.equal(res.status, 200);
    assert.deepEqual(res.body.candidates, []);
    // Orientation beats silence: the user learns which page to paste instead.
    assert.equal(res.body.rsshub.domainRouteTotal, 24);
    assert.equal(res.body.rsshub.domainRoutes.length, 1);
    assert.equal(res.body.rsshub.domainRoutes[0].needsParams, true);
  } finally {
    stub.restore();
  }
});

test("discovery succeeds via RSSHub even when the page cannot be fetched", async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async () => {
    const error = new Error("ECONNREFUSED");
    error.name = "FetchError";
    throw error;
  };
  try {
    const rsshub = fakeRsshub({
      candidates: [{ title: "Generated", url: "https://rsshub.test/g/1", route: "/g/1" }],
      site: "Site",
      domain: "site.test"
    });
    const store = await makeStore();
    const routes = createRoutes({ store, coordinator: new RefreshCoordinator(), rsshub });

    const res = await invoke(routes, `${API_PREFIX}/discover`, {
      method: "POST",
      body: { url: "https://site.test/page" }
    });
    // RSSHub generates feeds server-side, so an unreachable page for us does
    // not mean nothing can be found.
    assert.equal(res.status, 200);
    assert.equal(res.body.candidates.length, 1);
    assert.match(res.body.pageError, /ECONNREFUSED/, "but the page problem is reported");
  } finally {
    globalThis.fetch = original;
  }
});

test("the RSSHub status route reports the configured instance", async () => {
  const store = await makeStore();
  const enabled = createRoutes({ store, coordinator: new RefreshCoordinator(), rsshub: fakeRsshub() });
  const on = await invoke(enabled, `${API_PREFIX}/rsshub`);
  assert.equal(on.status, 200);
  assert.equal(on.body.enabled, true);
  assert.equal(on.body.base, "https://rsshub.test");

  const off = createRoutes({ store, coordinator: new RefreshCoordinator() });
  const res = await invoke(off, `${API_PREFIX}/rsshub`);
  assert.equal(res.status, 200);
  assert.equal(res.body.enabled, false);
  assert.match(res.body.reason, /disabled/);
});

test("adding a non-feed URL removes the stub and offers RSSHub routes instead", async () => {
  // The user pasted a page that is not a feed: leaving a dead subscription
  // behind and showing only an error would be the worst outcome.
  const stub = stubFetch([response("<html><body>no feed here</body></html>")]);
  try {
    const rsshub = fakeRsshub({
      candidates: [{ title: "From RSSHub", url: "https://rsshub.test/found/1", route: "/found/1" }],
      site: "Site",
      domain: "site.test"
    });
    const store = await makeStore();
    const routes = createRoutes({ store, coordinator: new RefreshCoordinator(), rsshub });

    const res = await invoke(routes, `${API_PREFIX}/feeds`, {
      method: "POST",
      body: { url: "https://site.test/not-a-feed" }
    });
    assert.equal(res.status, 201);
    assert.equal(res.body.created, false, "the stub subscription is not left behind");
    assert.equal(res.body.removed, true);
    assert.equal(store.list().length, 0, "and it is gone from the sidebar");
    assert.equal(res.body.suggestions.candidates.length, 1);
    assert.equal(res.body.outcome.ok, false);
    assert.match(res.body.outcome.error, /could not parse a feed|no RSS\/Atom feed advertised/);
  } finally {
    stub.restore();
  }
});

test("adding a real feed keeps it and offers no suggestions", async () => {
  const stub = stubFetch([response(BODY_FEED)]);
  try {
    const store = await makeStore();
    const routes = createRoutes({ store, coordinator: new RefreshCoordinator(), rsshub: fakeRsshub() });
    const res = await invoke(routes, `${API_PREFIX}/feeds`, {
      method: "POST",
      body: { url: "https://s.test/feed", refresh: true }
    });
    assert.equal(res.status, 201);
    assert.equal(res.body.suggestions, undefined);
    assert.equal(store.list().length, 1, "a working feed is kept");
  } finally {
    stub.restore();
  }
});

test("API rejects a malformed JSON body with 400", async () => {
  const { routes } = await makeRoutes();
  const route = routes.find((candidate) => candidate.path === `${API_PREFIX}/feeds`);
  const req = {
    method: "POST",
    url: `${API_PREFIX}/feeds`,
    headers: { host: "127.0.0.1:3080", origin: "http://127.0.0.1:3080", "sec-fetch-site": "same-origin" },
    socket: { remoteAddress: "127.0.0.1" },
    async *[Symbol.asyncIterator]() {
      yield Buffer.from("{ not json");
    }
  };
  let status = 0;
  let payload = "";
  await route.handler(req, {
    writeHead(code) { status = code; return this; },
    end(text) { payload = text ?? ""; }
  });
  assert.equal(status, 400);
  assert.match(JSON.parse(payload).error, /valid JSON/);
});

test("API marks one item and then the whole feed read", async () => {
  const { store, routes } = await makeRoutes();
  const stub = stubFetch([response(SAMPLE)]);
  try {
    const added = await invoke(routes, `${API_PREFIX}/feeds`, { method: "POST", body: { url: "https://s.test/feed" } });
    const feedId = added.body.feedId;
    const items = store.get(feedId).items;
    const one = await invoke(routes, `${API_PREFIX}/items`, {
      method: "PATCH",
      body: { feedId, itemId: items[0].id, read: true, starred: true }
    });
    assert.equal(one.status, 200);
    assert.equal(one.body.item.read, true);
    assert.equal(one.body.item.starred, true);
    assert.equal(one.body.state.totals.unread, 1);

    const all = await invoke(routes, `${API_PREFIX}/items`, { method: "PATCH", body: { feedId, all: true, read: true } });
    assert.equal(all.body.changed, 1);
    assert.equal(all.body.state.totals.unread, 0);
  } finally {
    stub.restore();
  }
});

test("API health route identifies the plugin", async () => {
  const { routes } = await makeRoutes();
  const res = await invoke(routes, `${API_PREFIX}/health`);
  assert.equal(res.body.plugin, "dsh-rss-reader");
});

test("API discovery route lists feeds advertised by a page", async () => {
  const { routes } = await makeRoutes();
  const html = '<html><head><link rel="alternate" type="application/rss+xml" href="/feed.xml"></head></html>';
  const stub = stubFetch([
    response(html, { headers: { "content-type": "text/html" }, url: "https://site.test/" })
  ]);
  try {
    const res = await invoke(routes, `${API_PREFIX}/discover`, { method: "POST", body: { url: "https://site.test/" } });
    assert.equal(res.status, 200);
    assert.equal(res.body.candidates.length, 1);
    assert.equal(res.body.candidates[0].url, "https://site.test/feed.xml");
  } finally {
    stub.restore();
  }
});

// ── Request fence ───────────────────────────────────────────────────────────

test("isLocalUiRequest accepts the local UI and refuses other callers", () => {
  const base = { headers: { host: "127.0.0.1:3080", "sec-fetch-site": "same-origin" }, socket: { remoteAddress: "127.0.0.1" } };
  assert.equal(isLocalUiRequest(base), true);
  assert.equal(isLocalUiRequest({ ...base, socket: { remoteAddress: "10.0.0.5" } }), false, "non-loopback socket");
  assert.equal(isLocalUiRequest({ ...base, headers: { ...base.headers, host: "evil.test" } }), false, "rebinding host");
  assert.equal(isLocalUiRequest({ ...base, headers: { ...base.headers, "sec-fetch-site": "cross-site" } }), false);
  assert.equal(isLocalUiRequest({ ...base, headers: { ...base.headers, origin: "https://evil.test" } }), false);
  // A bare curl sends no browser marker at all.
  assert.equal(isLocalUiRequest({ ...base, headers: { host: "127.0.0.1:3080" } }), false);
  // Referer is forgeable and some clients set it automatically, so on its own
  // it must NOT be accepted as evidence of a browser.
  assert.equal(
    isLocalUiRequest({ ...base, headers: { host: "127.0.0.1:3080", referer: "http://127.0.0.1:3080/" } }),
    false,
    "a bare Referer must not pass the fence"
  );
  // A same-origin Origin is accepted even without Fetch metadata.
  assert.equal(
    isLocalUiRequest({ ...base, headers: { host: "127.0.0.1:3080", origin: "http://127.0.0.1:3080" } }),
    true
  );
});

test("statusForError distinguishes bad input, upstream failure, and bugs", () => {
  // Caller's own malformed input -> 400.
  for (const code of ["empty-url", "invalid-url", "unsupported-scheme"]) {
    assert.equal(statusForError(new FeedFetchError("bad", { code })), 400, `${code} should be a 400`);
  }
  // Upstream problems -> 502, so the UI can say "the feed is down".
  for (const code of ["timeout", "network", "http-status", "parse-failed", "too-large", "not-a-feed"]) {
    assert.equal(statusForError(new FeedFetchError("bad", { code })), 502, `${code} should be a 502`);
  }
  // An explicit statusCode on the error wins.
  const explicit = new Error("nope");
  explicit.statusCode = 413;
  assert.equal(statusForError(explicit), 413);
  // Anything unclassified is a genuine 500.
  assert.equal(statusForError(new Error("boom")), 500);
  assert.equal(statusForError("a string"), 500);
});

test("API refuses a cross-origin caller with 403", async () => {
  const { routes } = await makeRoutes();
  const res = await invoke(routes, `${API_PREFIX}/state`, { headers: { origin: "https://evil.test" } });
  assert.equal(res.status, 403);
});

test("readJsonBody rejects an oversized body", async () => {
  const big = Buffer.alloc(1024 * 1024 + 10, 0x41);
  const req = {
    async *[Symbol.asyncIterator]() {
      yield big;
    }
  };
  await assert.rejects(() => readJsonBody(req), /too large/);
});

test("readJsonBody rejects a non-object JSON body", async () => {
  const req = {
    async *[Symbol.asyncIterator]() {
      yield Buffer.from("[1,2,3]");
    }
  };
  await assert.rejects(() => readJsonBody(req), /must be a JSON object/);
});

// ── Agent digest rendering ──────────────────────────────────────────────────

test("renderDigest explains an empty subscription list", async () => {
  const store = await makeStore();
  const digest = renderDigest(store.snapshot());
  assert.match(digest.text, /No RSS feeds are subscribed/);
  assert.deepEqual(digest.items, []);
});

test("renderDigest lists items, honours unreadOnly and limit, and reports errors", async () => {
  const store = await makeStore();
  const { feed } = store.add({ url: "https://s.test/feed" });
  store.applyFetch(feed.id, { feed: { items: [
    { id: "1", title: "First", link: "https://s.test/1", summary: "s1", content: "", author: "Ann", date: "2024-05-02T10:00:00.000Z", categories: [], enclosure: "" },
    { id: "2", title: "Second", link: "https://s.test/2", summary: "s2", content: "", author: "", date: "2024-05-01T10:00:00.000Z", categories: [], enclosure: "" }
  ], title: "Sample", link: "https://s.test/", description: "", image: "", format: "rss" }, url: "", etag: "", lastModified: "" });
  store.setItemFlags(feed.id, "2", { read: true });
  store.applyError(feed.id, "upstream down");

  const all = renderDigest(store.snapshot(), { limit: 10 });
  assert.match(all.text, /First/);
  assert.match(all.text, /Second/);
  assert.match(all.text, /upstream down/, "a feed's error is surfaced to the agent");
  assert.equal(all.items.length, 2);
  // Newest first.
  assert.equal(all.items[0].title, "First");

  const unread = renderDigest(store.snapshot(), { unreadOnly: true });
  assert.equal(unread.items.length, 1);
  assert.equal(unread.items[0].title, "First");

  const limited = renderDigest(store.snapshot(), { limit: 1 });
  assert.equal(limited.items.length, 1);
  assert.match(limited.text, /and 1 more items/);

  const unnamed = renderDigest(store.snapshot(), { feedId: "does-not-exist" });
  assert.match(unnamed.text, /No feed matched/);
});

test("renderDigest names subscriptions even before anything is fetched", async () => {
  // Regression: with no cached items the digest used to print only the totals
  // header, leaving "what am I subscribed to?" unanswerable before a refresh.
  const store = await makeStore();
  store.add({ url: "https://example.test/feed" });
  const digest = renderDigest(store.snapshot());
  assert.match(digest.text, /example\.test/, "the subscription must be named");
  assert.match(digest.text, /never fetched/);
  assert.deepEqual(digest.items, []);
});

test("renderDigest reports a per-feed refresh error when nothing is cached", async () => {
  const store = await makeStore();
  const { feed } = store.add({ url: "https://broken.test/feed" });
  store.applyError(feed.id, "HTTP 503");
  const digest = renderDigest(store.snapshot());
  assert.match(digest.text, /refresh error: HTTP 503/);
  assert.match(digest.text, /broken\.test/);
});

test("renderDigest explains an unreadOnly filter that hides everything", async () => {
  const store = await makeStore();
  const { feed } = store.add({ url: "https://s.test/feed" });
  store.applyFetch(feed.id, { feed: { items: [
    { id: "1", title: "Read already", link: "", summary: "", content: "", author: "", date: "", categories: [], enclosure: "" }
  ], title: "Sample", link: "", description: "", image: "", format: "rss" }, url: "", etag: "", lastModified: "" });
  store.markAllRead(feed.id);
  const digest = renderDigest(store.snapshot(), { unreadOnly: true });
  assert.match(digest.text, /No unread items/);
  assert.match(digest.text, /Sample/);
  assert.deepEqual(digest.items, []);
});

// ── Durability of API writes (regression) ───────────────────────────────────

test("adding a feed with refresh persists the fetched items to disk", async () => {
  // Regression: the POST /feeds handler refreshed but never flushed, so the
  // items it reported in the response were lost on the next restart.
  const { store, routes } = await makeRoutes();
  const stub = stubFetch([response(SAMPLE)]);
  try {
    const added = await invoke(routes, `${API_PREFIX}/feeds`, {
      method: "POST",
      body: { url: "https://s.test/feed", refresh: true }
    });
    assert.equal(added.body.outcome.added, 2);

    const reloaded = new FeedStore({ file: store.file });
    await reloaded.load();
    assert.equal(reloaded.list().length, 1, "the subscription must survive a reload");
    assert.equal(reloaded.list()[0].items.length, 2, "the fetched items must survive a reload");
    assert.equal(reloaded.list()[0].items[0].title, "Two", "newest first");
  } finally {
    stub.restore();
  }
});

test("adding a feed without refresh persists it immediately", async () => {
  const { store, routes } = await makeRoutes();
  const added = await invoke(routes, `${API_PREFIX}/feeds`, {
    method: "POST",
    body: { url: "https://plain.test/feed", refresh: false }
  });
  assert.equal(added.status, 201);
  const reloaded = new FeedStore({ file: store.file });
  await reloaded.load();
  assert.equal(reloaded.list().length, 1);
});

test("a failed refresh is persisted so the error survives a restart", async () => {
  const { store, routes } = await makeRoutes();
  const stub = stubFetch([response("nope", { status: 500 })]);
  try {
    await invoke(routes, `${API_PREFIX}/feeds`, {
      method: "POST",
      body: { url: "https://bad.test/feed", refresh: true }
    });
    const reloaded = new FeedStore({ file: store.file });
    await reloaded.load();
    assert.match(reloaded.list()[0].lastError, /HTTP 500/);
  } finally {
    stub.restore();
  }
});

// ── Startup race (regression) ───────────────────────────────────────────────

test("concurrent load() calls all observe the loaded data", async () => {
  // Regression: `load()` used to flip its flag before its first await, so a
  // second caller returned immediately and saw an empty store.
  const dir = await scratch();
  const file = join(dir, "feeds.json");
  const seeded = new FeedStore({ file });
  await seeded.load();
  seeded.add({ url: "https://a.test/feed", title: "A" });
  seeded.add({ url: "https://b.test/feed", title: "B" });
  await seeded.flush();

  const store = new FeedStore({ file });
  // Fire many loads at once, before any of them can finish.
  const results = await Promise.all(Array.from({ length: 8 }, () => store.load()));
  for (const result of results) {
    assert.equal(result.list().length, 2, "every concurrent caller must see both feeds");
  }
  assert.equal(store.list().length, 2);
});

test("flush() before load() does not overwrite existing data", async () => {
  // A write racing startup must not persist an empty list over a real one.
  const dir = await scratch();
  const file = join(dir, "feeds.json");
  const seeded = new FeedStore({ file });
  await seeded.load();
  seeded.add({ url: "https://keep.test/feed", title: "Keep" });
  await seeded.flush();

  const fresh = new FeedStore({ file });
  // Deliberately never call load(): flush() must do it.
  await fresh.flush();

  const reloaded = new FeedStore({ file });
  await reloaded.load();
  assert.equal(reloaded.list().length, 1, "the existing subscription must survive");
  assert.equal(reloaded.list()[0].title, "Keep");
});

test("the API answers with real data when the store was never loaded first", async () => {
  // The webserver starts accepting before startup loading finishes, so the API
  // must not depend on the caller having loaded the store.
  const dir = await scratch();
  const file = join(dir, "feeds.json");
  const seeded = new FeedStore({ file });
  await seeded.load();
  seeded.add({ url: "https://preseeded.test/feed", title: "Preseeded" });
  await seeded.flush();

  const store = new FeedStore({ file });
  const routes = createRoutes({ store, coordinator: new RefreshCoordinator() });
  const res = await invoke(routes, `${API_PREFIX}/state`);
  assert.equal(res.status, 200);
  assert.equal(res.body.state.feeds.length, 1, "an early request must see the stored feeds");
  assert.equal(res.body.state.feeds[0].title, "Preseeded");
});

// ── Translations ────────────────────────────────────────────────────────────

/**
 * A feed whose item carries a full Markdown body, an image, and a summary.
 *
 * `content:encoded` is the body; `<description>` is the summary. Feeds differ
 * in which one holds the article, so both paths are covered below.
 */
const BODY_FEED = `<rss version="2.0" xmlns:content="http://purl.org/rss/1.0/modules/content/">
  <channel><title>Sample</title><link>https://s.test/</link>
  <item><title>One</title><link>https://s.test/1</link>
    <description>Short summary</description>
    <content:encoded><![CDATA[<p>Body <strong>bold</strong></p><img src="https://s.test/a.png" alt="pic">]]></content:encoded>
  </item>
</channel></rss>`;

/** An HTML page declaring one feed of its own. */
const PAGE_WITH_FEED = '<html><head><link rel="alternate" type="application/rss+xml" title="Own Feed" href="https://x.test/own.xml"></head><body>page</body></html>';

/** A feed whose item publishes the whole article in <description> instead. */
const DESCRIPTION_ONLY_FEED = `<rss version="2.0"><channel><title>Only</title><link>https://o.test/</link>
  <item><title>Solo</title><link>https://o.test/1</link>
    <description><![CDATA[<p>Whole article in the <em>description</em></p>]]></description>
  </item>
</channel></rss>`;

/** Seed one feed with one item; returns the resulting ids. */
async function seedOneItem(store) {
  const stub = stubFetch([response(BODY_FEED)]);
  try {
    const outcome = await refreshFeed(store, store.add({ url: "https://s.test/feed" }).feed.id);
    assert.equal(outcome.ok, true, outcome.error);
  } finally {
    stub.restore();
  }
  const feed = store.list()[0];
  return { feedId: feed.id, itemId: feed.items[0].id };
}

test("a fetched item carries both plain text and Markdown", async () => {
  const store = await makeStore();
  await seedOneItem(store);
  const item = store.list()[0].items[0];
  assert.match(item.content, /Body bold/, "plain text feeds the agent digest");
  assert.match(item.markdown, /\*\*bold\*\*/, "Markdown feeds the reading pane");
  assert.match(item.markdown, /!\[pic\]\(https:\/\/s\.test\/a\.png\)/, "images survive as Markdown");
  assert.equal(item.summary, "Short summary");
});

test("a feed that publishes its article in <description> still has a body", async () => {
  // This is very common, and the reading pane must not come up empty for it.
  const store = await makeStore();
  const stub = stubFetch([response(DESCRIPTION_ONLY_FEED)]);
  try {
    await refreshFeed(store, store.add({ url: "https://o.test/feed" }).feed.id);
  } finally {
    stub.restore();
  }
  const item = store.list()[0].items[0];
  assert.equal(item.markdown, "", "there is no content:encoded");
  assert.match(item.summaryMarkdown, /\*description\*/, "the summary carries the article");

  // The detail projection must expose it, and the translator must receive it.
  const { feedId, itemId } = { feedId: store.list()[0].id, itemId: item.id };
  const translator = fakeTranslator();
  const routes = createRoutes({ store, coordinator: new RefreshCoordinator(), translator });
  const detail = await invoke(routes, `${API_PREFIX}/item?feedId=${feedId}&itemId=${encodeURIComponent(itemId)}`);
  assert.match(detail.body.item.summaryMarkdown, /description/);

  await invoke(routes, `${API_PREFIX}/translate`, { method: "POST", body: { feedId, itemId } });
  assert.match(translator.calls[0].markdown, /description/, "the model must receive the summary as the body");
});

test("a translation is stored, persisted, and preserved across a refresh", async () => {
  const store = await makeStore();
  const { feedId, itemId } = await seedOneItem(store);

  store.setItemTranslation(feedId, itemId, {
    title: "标题",
    markdown: "# 标题\n\n**正文**",
    target: "zh-CN",
    model: "p/m",
    at: "2024-05-01T00:00:00.000Z"
  });
  await store.flush();

  // Survives a reload from disk.
  const reloaded = new FeedStore({ file: store.file });
  await reloaded.load();
  assert.equal(reloaded.list()[0].items[0].translation.title, "标题");
  assert.equal(reloaded.list()[0].items[0].translation.target, "zh-CN");

  // Survives a routine refresh: a translation is expensive to produce, so
  // losing it on the next fetch would be a real regression.
  const stub = stubFetch([response(BODY_FEED)]);
  try {
    await refreshFeed(store, feedId);
  } finally {
    stub.restore();
  }
  assert.equal(store.list()[0].items[0].translation?.title, "标题", "the translation must survive a refresh");
});

test("a malformed translation is rejected rather than stored", async () => {
  const store = await makeStore();
  const { feedId, itemId } = await seedOneItem(store);

  store.setItemTranslation(feedId, itemId, { title: "t", markdown: "m", target: "zh-CN" });
  assert.notEqual(store.list()[0].items[0].translation, null);

  store.setItemTranslation(feedId, itemId, null);
  assert.equal(store.list()[0].items[0].translation, null, "clearing must work");

  store.setItemTranslation(feedId, itemId, { title: "", markdown: "   " });
  assert.equal(store.list()[0].items[0].translation, null, "an empty record is not a translation");
  store.setItemTranslation(feedId, itemId, "not an object");
  assert.equal(store.list()[0].items[0].translation, null);
});

test("the list snapshot omits bodies but still reports translation state", async () => {
  const store = await makeStore();
  const { feedId, itemId } = await seedOneItem(store);
  store.setItemTranslation(feedId, itemId, { title: "t", markdown: "translated body", target: "zh-CN" });

  const list = store.snapshot();
  const item = list.feeds[0].items[0];
  // Bodies dominate the payload, so the list must not carry them.
  assert.equal(item.markdown, undefined, "the list must not ship bodies");
  assert.equal(item.content, undefined);
  assert.equal(item.translation, undefined);
  assert.equal(item.translated, true, "the list still reports that a translation exists");
  assert.equal(item.translationTarget, "zh-CN");
  assert.equal(list.totals.translated, 1);

  // The detail projection is where bodies live.
  const detail = store.snapshot({ withBodies: true });
  assert.match(detail.feeds[0].items[0].markdown, /bold/);
  assert.equal(detail.feeds[0].items[0].translation.markdown, "translated body");
});

test("findItem locates an item by id or by link", async () => {
  const store = await makeStore();
  const { feedId, itemId } = await seedOneItem(store);
  assert.ok(store.findItem(feedId, itemId) !== undefined);
  assert.ok(store.findItem(feedId, "https://s.test/1") !== undefined, "a link also identifies the item");
  assert.equal(store.findItem(feedId, "nope"), undefined);
  assert.equal(store.findItem("nope", itemId), undefined);
});

// ── Translation routes ──────────────────────────────────────────────────────

/** A translator double that records every call. */
function fakeTranslator(overrides = {}) {
  const calls = [];
  return {
    calls,
    describe: () => ({ available: true, provider: "p", model: "m", targets: { "zh-CN": "Chinese" } }),
    translate: async (input) => {
      calls.push(input);
      return {
        status: "ok",
        title: "标题",
        markdown: "# 标题",
        target: input.target ?? "zh-CN",
        model: "p/m",
        at: "2024-05-01T00:00:00.000Z"
      };
    },
    ...overrides
  };
}

/** Build routes over a seeded store, optionally with a translator. */
async function makeTranslateRoutes(translator) {
  const store = await makeStore();
  const { feedId, itemId } = await seedOneItem(store);
  return { store, feedId, itemId, routes: createRoutes({ store, coordinator: new RefreshCoordinator(), translator }) };
}

test("GET /translate reports availability, targets and the default", async () => {
  const { routes } = await makeTranslateRoutes(fakeTranslator());
  const res = await invoke(routes, `${API_PREFIX}/translate`);
  assert.equal(res.status, 200);
  assert.equal(res.body.available, true);
  assert.equal(res.body.defaultTarget, "zh-CN");
  assert.ok(Object.keys(res.body.targets).length > 0, "the UI needs the target list");
});

test("GET /translate explains why translation is unavailable", async () => {
  // Without a translator the UI must be told, not left to fail on click.
  const store = await makeStore();
  const routes = createRoutes({ store, coordinator: new RefreshCoordinator() });
  const res = await invoke(routes, `${API_PREFIX}/translate`);
  assert.equal(res.status, 200);
  assert.equal(res.body.available, false);
  assert.match(res.body.reason, /disabled/);
});

test("POST /translate stores the translation and returns it", async () => {
  const translator = fakeTranslator();
  const { store, feedId, itemId, routes } = await makeTranslateRoutes(translator);
  const res = await invoke(routes, `${API_PREFIX}/translate`, {
    method: "POST",
    body: { feedId, itemId, target: "zh-CN" }
  });
  assert.equal(res.status, 200);
  assert.equal(res.body.cached, false);
  assert.equal(res.body.translation.title, "标题");
  // It must be persisted, not merely returned.
  assert.equal(store.list()[0].items[0].translation.title, "标题");
  // The model receives the item's Markdown, not its flattened text.
  assert.match(translator.calls[0].markdown, /bold/);
  assert.equal(translator.calls[0].title, "One");
});

test("POST /translate serves a cached translation without calling the model", async () => {
  const translator = fakeTranslator();
  const { routes, feedId, itemId } = await makeTranslateRoutes(translator);
  const first = await invoke(routes, `${API_PREFIX}/translate`, { method: "POST", body: { feedId, itemId, target: "zh-CN" } });
  assert.equal(first.body.cached, false);
  const second = await invoke(routes, `${API_PREFIX}/translate`, { method: "POST", body: { feedId, itemId, target: "zh-CN" } });
  assert.equal(second.status, 200);
  assert.equal(second.body.cached, true, "the second call must reuse the cache");
  assert.equal(translator.calls.length, 1, "the model must not be called twice");
});

test("POST /translate with force re-runs the model", async () => {
  const translator = fakeTranslator();
  const { routes, feedId, itemId } = await makeTranslateRoutes(translator);
  await invoke(routes, `${API_PREFIX}/translate`, { method: "POST", body: { feedId, itemId, target: "zh-CN" } });
  const forced = await invoke(routes, `${API_PREFIX}/translate`, {
    method: "POST",
    body: { feedId, itemId, target: "zh-CN", force: true }
  });
  assert.equal(forced.body.cached, false);
  assert.equal(translator.calls.length, 2);
});

test("POST /translate re-runs the model when the target language changes", async () => {
  const translator = fakeTranslator();
  const { routes, feedId, itemId } = await makeTranslateRoutes(translator);
  await invoke(routes, `${API_PREFIX}/translate`, { method: "POST", body: { feedId, itemId, target: "zh-CN" } });
  // A cached Chinese translation must not be served for a Japanese request.
  const japanese = await invoke(routes, `${API_PREFIX}/translate`, { method: "POST", body: { feedId, itemId, target: "ja" } });
  assert.equal(japanese.body.cached, false);
  assert.equal(translator.calls.length, 2);
  assert.equal(translator.calls[1].target, "ja");
});

test("POST /translate reports a model failure as a 502, not a bad request", async () => {
  const translator = fakeTranslator({
    translate: async () => ({ status: "failed", error: "the model returned no text" })
  });
  const { routes, feedId, itemId } = await makeTranslateRoutes(translator);
  const res = await invoke(routes, `${API_PREFIX}/translate`, { method: "POST", body: { feedId, itemId } });
  assert.equal(res.status, 502, "an upstream model failure is not the caller's fault");
  assert.match(res.body.error, /no text/);
});

test("POST /translate 404s for an unknown item and 503s without a translator", async () => {
  const { routes } = await makeTranslateRoutes(fakeTranslator());
  const missing = await invoke(routes, `${API_PREFIX}/translate`, {
    method: "POST",
    body: { feedId: "nope", itemId: "nope" }
  });
  assert.equal(missing.status, 404);

  const store = await makeStore();
  const bare = createRoutes({ store, coordinator: new RefreshCoordinator() });
  const unavailable = await invoke(bare, `${API_PREFIX}/translate`, { method: "POST", body: { feedId: "a", itemId: "b" } });
  assert.equal(unavailable.status, 503);
  assert.match(unavailable.body.error, /not available/);
});

test("DELETE /translate removes the cached translation", async () => {
  const translator = fakeTranslator();
  const { store, feedId, itemId, routes } = await makeTranslateRoutes(translator);
  await invoke(routes, `${API_PREFIX}/translate`, { method: "POST", body: { feedId, itemId } });
  assert.notEqual(store.list()[0].items[0].translation, null);

  const url = `${API_PREFIX}/translate?feedId=${feedId}&itemId=${encodeURIComponent(itemId)}`;
  const res = await invoke(routes, url, { method: "DELETE" });
  assert.equal(res.status, 200);
  assert.equal(res.body.cleared, true);
  assert.equal(store.list()[0].items[0].translation, null);
});

// ── Item body route ─────────────────────────────────────────────────────────

test("GET /item returns one item's body and its translation", async () => {
  const { routes, feedId, itemId } = await makeTranslateRoutes(fakeTranslator());
  await invoke(routes, `${API_PREFIX}/translate`, { method: "POST", body: { feedId, itemId, target: "zh-CN" } });

  const url = `${API_PREFIX}/item?feedId=${feedId}&itemId=${encodeURIComponent(itemId)}`;
  const res = await invoke(routes, url);
  assert.equal(res.status, 200);
  assert.match(res.body.item.markdown, /\*\*bold\*\*/, "the reading pane needs the Markdown body");
  assert.equal(res.body.item.translation.title, "标题");
});

test("GET /item 404s for an unknown item", async () => {
  const { routes } = await makeTranslateRoutes(fakeTranslator());
  const res = await invoke(routes, `${API_PREFIX}/item?feedId=nope&itemId=nope`);
  assert.equal(res.status, 404);
});

// ── view preferences ────────────────────────────────────────────────────────

/** Build a route table whose preference defaults stand in for the plugin config. */
async function makePrefRoutes(prefDefaults = {}) {
  const store = await makeStore();
  return { store, routes: createRoutes({ store, coordinator: new RefreshCoordinator(), prefDefaults }) };
}

test("a preference is written through and read back", async () => {
  const { store } = await makePrefRoutes();
  const file = store.file;
  await store.load();

  // Nothing is set yet: an absent key means "the user never chose", which is
  // what keeps the plugin config's default in play.
  assert.deepEqual(store.prefs(), {});

  await store.setPref("showSidebarEntry", false);
  assert.deepEqual(store.prefs(), { showSidebarEntry: false });

  const document = JSON.parse(await readFile(file, "utf8"));
  assert.deepEqual(document.prefs, { showSidebarEntry: false });

  // A fresh store over the same file sees the choice.
  const reopened = new FeedStore({ file });
  await reopened.load();
  assert.deepEqual(reopened.prefs(), { showSidebarEntry: false });
});

test("preferences reject unknown keys and non-boolean values", async () => {
  const store = await makeStore();
  await assert.rejects(() => store.setPref("colour", true), /unknown preference/);
  await assert.rejects(() => store.setPref("showSidebarEntry", "yes"), /must be a boolean/);
  assert.deepEqual(store.prefs(), {}, "a rejected write must not leave a value behind");
});

test("the translation route is a stored string preference, and clearing it means default", async () => {
  const { store } = await makePrefRoutes();
  await store.load();

  await store.setPref("translateProvider", "cust");
  await store.setPref("translateModel", "qwen3.8-uncensored");
  await store.setPref("translateEffort", "low");
  assert.deepEqual(store.prefs(), {
    translateProvider: "cust",
    translateModel: "qwen3.8-uncensored",
    translateEffort: "low"
  });

  // Whitespace is not part of a route name, and an empty string is a real
  // instruction: it drops the key so the plugin config applies again.
  await store.setPref("translateEffort", "  ");
  assert.equal("translateEffort" in store.prefs(), false);
  await assert.rejects(() => store.setPref("translateModel", 42), /must be a string/);
  await assert.rejects(() => store.setPref("translateProvider", "a".repeat(400)), /at most/);
});

test("folding the subscription strip is a stored choice, not a session one", async () => {
  const { store } = await makePrefRoutes();
  await store.load();

  await store.setPref("collapseFeeds", true);
  assert.deepEqual(store.prefs(), { collapseFeeds: true });

  // The point of the preference: a reader who folded the strip gets it folded
  // again after a reload, so it has to survive the file round trip.
  const reopened = new FeedStore({ file: store.file });
  await reopened.load();
  assert.deepEqual(reopened.prefs(), { collapseFeeds: true });

  await assert.rejects(() => reopened.setPref("collapseFeeds", "yes"), /must be a boolean/);
});

test("the reading position is a stored preference that survives a reload", async () => {
  const { store } = await makePrefRoutes();
  await store.load();

  await store.setPref("lastFeedId", "f1");
  await store.setPref("lastItemKey", "post-42");
  await store.setPref("lastScrollTop", "1200");
  assert.deepEqual(store.prefs(), { lastFeedId: "f1", lastItemKey: "post-42", lastScrollTop: "1200" });

  // Reopening the panel reads these back; that is the whole feature.
  const reopened = new FeedStore({ file: store.file });
  await reopened.load();
  assert.equal(reopened.prefs().lastItemKey, "post-42");
  assert.equal(reopened.prefs().lastScrollTop, "1200");

  // Going back to the list is a position too, so clearing the item is
  // meaningful — it drops the key, and the fallback is the list.
  await reopened.setPref("lastItemKey", "");
  assert.equal("lastItemKey" in reopened.prefs(), false);
  await assert.rejects(() => reopened.setPref("lastScrollTop", 420), /must be a string/);
});

test("GET /models serves the catalogue and says which choices are the user's", async () => {
  const store = await makeStore();
  await store.load();
  await store.setPref("translateProvider", "cust");
  const catalog = {
    default: { provider: "deepseek-official", model: "deepseek-flash" },
    routableProviders: ["deepseek-official", "cust"],
    groups: [
      { id: "deepseek-official", name: "DeepSeek", models: [{ id: "deepseek-flash", name: "Flash" }] },
      {
        id: "cust",
        name: "cust",
        models: [{
          id: "qwen3.8-uncensored",
          name: "QW",
          reasoning: { efforts: [{ id: "low", name: "Low" }, { id: "high", name: "High" }], defaultEffort: "high" }
        }]
      }
    ],
    failures: []
  };
  const routes = createRoutes({
    store,
    coordinator: new RefreshCoordinator(),
    modelCatalog: async () => ({ ok: true, catalog })
  });

  const res = await invoke(routes, `${API_PREFIX}/models`);
  assert.equal(res.status, 200);
  assert.deepEqual(res.body.catalog.groups[1].models[0].reasoning.efforts.map((e) => e.id), ["low", "high"]);
  // The picker shows "this is the reader's own choice" differently from "this is
  // the default", and only `stored` can tell those apart.
  assert.deepEqual(res.body.stored, ["translateProvider"]);
});

test("GET /models explains itself when the host has no model registry", async () => {
  const { routes } = await makePrefRoutes();
  const res = await invoke(routes, `${API_PREFIX}/models`);
  assert.equal(res.status, 503);
  assert.match(res.body.error, /没有可选模型/);
});

// ── history backfill ────────────────────────────────────────────────────────

/** A route table whose backfill is a recording double. */
async function makeHistoryRoutes(options = {}) {
  const store = await makeStore();
  const { feedId } = await seedOneItem(store);
  const calls = [];
  const routes = createRoutes({
    store,
    coordinator: new RefreshCoordinator(),
    backfill: async (input) => {
      calls.push(input);
      if (options.fail === true) throw new Error("无法连接归档页：连接超时");
      return {
        items: options.items ?? [],
        considered: options.considered ?? 3,
        skipped: options.skipped ?? 1,
        failures: options.failures ?? []
      };
    }
  });
  return { store, feedId, calls, routes };
}

test("POST /history backfills older articles into the feed", async () => {
  const older = {
    id: "https://s.test/old",
    link: "https://s.test/old",
    title: "更早的一条",
    summary: "摘要",
    markdown: "旧正文",
    date: "2020-01-01T00:00:00.000Z"
  };
  const { store, feedId, calls, routes } = await makeHistoryRoutes({ items: [older] });
  const before = store.get(feedId).items.length;

  const res = await invoke(routes, `${API_PREFIX}/history`, {
    method: "POST",
    body: { feedId, archiveUrl: "https://s.test/archives/", limit: 5 }
  });

  assert.equal(res.status, 200);
  assert.equal(res.body.added, 1);
  assert.equal(res.body.skipped, 1);
  assert.ok(res.body.state !== undefined, "the panel needs the new state to paint from");
  assert.equal(store.get(feedId).items.length, before + 1);
  assert.equal(store.findItem(feedId, "https://s.test/old").item.title, "更早的一条");
  // What the route asked the backfill for: the archive, the ceiling, and the
  // feed's own links as both the shape sample and the do-not-refetch set.
  assert.equal(calls.length, 1);
  assert.equal(calls[0].archiveUrl, "https://s.test/archives/");
  assert.equal(calls[0].limit, 5);
  assert.ok(calls[0].sampleLinks.length > 0);
  assert.ok(calls[0].known instanceof Set);
});

test("POST /history refuses a missing feed, a bad address and a missing feature", async () => {
  const { feedId, routes } = await makeHistoryRoutes();

  const noFeed = await invoke(routes, `${API_PREFIX}/history`, {
    method: "POST",
    body: { feedId: "nope", archiveUrl: "https://s.test/archives/" }
  });
  assert.equal(noFeed.status, 404);

  for (const archiveUrl of ["", "not a url", "ftp://s.test/x"]) {
    const bad = await invoke(routes, `${API_PREFIX}/history`, { method: "POST", body: { feedId, archiveUrl } });
    assert.equal(bad.status, 400, `expected 400 for ${JSON.stringify(archiveUrl)}`);
    assert.match(bad.body.error, /归档页地址不可用/);
  }

  // Without the dependency the feature is off, and says so rather than 404ing.
  const store = await makeStore();
  const offRoutes = createRoutes({ store, coordinator: new RefreshCoordinator() });
  const off = await invoke(offRoutes, `${API_PREFIX}/history`, {
    method: "POST",
    body: { feedId, archiveUrl: "https://s.test/archives/" }
  });
  assert.equal(off.status, 503);
  assert.match(off.body.error, /history/);
});

test("POST /history reports an unreachable archive as an upstream failure", async () => {
  const { feedId, routes } = await makeHistoryRoutes({ fail: true });
  const res = await invoke(routes, `${API_PREFIX}/history`, {
    method: "POST",
    body: { feedId, archiveUrl: "https://s.test/archives/" }
  });
  assert.equal(res.status, 502);
  assert.match(res.body.error, /无法连接归档页/);
});

test("POST /history clamps the requested count to the configured ceiling", async () => {
  const store = await makeStore();
  const { feedId } = await seedOneItem(store);
  const calls = [];
  const routes = createRoutes({
    store,
    coordinator: new RefreshCoordinator(),
    historyMaxLimit: 7,
    backfill: async (input) => {
      calls.push(input);
      return { items: [], considered: 0, skipped: 0, failures: [] };
    }
  });
  await invoke(routes, `${API_PREFIX}/history`, {
    method: "POST",
    body: { feedId, archiveUrl: "https://s.test/archives/", limit: 500 }
  });
  assert.equal(calls[0].limit, 7);
});

test("a stored preference outside the whitelist is dropped on load", async () => {
  const dir = await scratch();
  const file = join(dir, "feeds.json");
  // The file is user-editable, so an unknown or mistyped key must not become a
  // setting: dropping it is how the plugin stays honest about what it reads.
  await writeFile(file, JSON.stringify({
    version: 1,
    prefs: { showSidebarEntry: true, sneaky: false, half: "true" },
    feeds: []
  }), "utf8");

  const store = new FeedStore({ file });
  await store.load();
  assert.deepEqual(store.prefs(), { showSidebarEntry: true });
});

test("GET /prefs falls back to the plugin config until the user chooses", async () => {
  const { routes } = await makePrefRoutes({ showSidebarEntry: false });
  const res = await invoke(routes, `${API_PREFIX}/prefs`);
  assert.equal(res.status, 200);
  // The default matters: an operator who ships the panel with only the right
  // Sidebar entry must be able to say so without editing the state file.
  assert.deepEqual(res.body.prefs, { showSidebarEntry: false });
});

test("PATCH /prefs stores the choice and it overrides the config default", async () => {
  const { store, routes } = await makePrefRoutes({ showSidebarEntry: true });

  const patched = await invoke(routes, `${API_PREFIX}/prefs`, {
    method: "PATCH",
    body: { showSidebarEntry: false }
  });
  assert.equal(patched.status, 200);
  assert.deepEqual(patched.body.prefs, { showSidebarEntry: false });
  assert.deepEqual(store.prefs(), { showSidebarEntry: false }, "the choice must be persisted");

  // A later read agrees, and the config default no longer wins.
  const again = await invoke(routes, `${API_PREFIX}/prefs`);
  assert.deepEqual(again.body.prefs, { showSidebarEntry: false });

  // Flipping back is remembered too — including back to the config's value,
  // which must stay the user's choice rather than becoming "unset".
  await invoke(routes, `${API_PREFIX}/prefs`, { method: "PATCH", body: { showSidebarEntry: true } });
  assert.deepEqual(store.prefs(), { showSidebarEntry: true });
});

test("PATCH /prefs rejects a bad request without storing anything", async () => {
  const { store, routes } = await makePrefRoutes({ showSidebarEntry: true });

  const empty = await invoke(routes, `${API_PREFIX}/prefs`, { method: "PATCH", body: {} });
  assert.equal(empty.status, 400);
  assert.match(empty.body.error, /key is required/);

  const unknown = await invoke(routes, `${API_PREFIX}/prefs`, { method: "PATCH", body: { colour: true } });
  assert.equal(unknown.status, 400);
  assert.match(unknown.body.error, /unknown preference/);

  const wrongType = await invoke(routes, `${API_PREFIX}/prefs`, { method: "PATCH", body: { showSidebarEntry: "no" } });
  assert.equal(wrongType.status, 400);
  assert.match(wrongType.body.error, /must be a boolean/);

  // One good key beside one bad one must not half-apply.
  const partial = await invoke(routes, `${API_PREFIX}/prefs`, {
    method: "PATCH",
    body: { showSidebarEntry: false, colour: true }
  });
  assert.equal(partial.status, 400);
  assert.deepEqual(store.prefs(), {}, "a rejected request must leave the store untouched");
});

// ── subscription order ──────────────────────────────────────────────────────

/** A store holding three subscriptions, in the order they were added. */
async function makeOrderedStore() {
  const store = await makeStore();
  for (const name of ["Alpha", "Beta", "Gamma"]) {
    store.add({ url: `https://${name.toLowerCase()}.test/feed`, title: name });
  }
  await store.flush();
  return store;
}

/** The feed titles, in the store's current order. */
const titlesOf = (store) => store.list().map((feed) => feed.title);

test("a new subscription appends to the order the user arranged", async () => {
  const store = await makeOrderedStore();
  assert.deepEqual(titlesOf(store), ["Alpha", "Beta", "Gamma"], "the default is the order things were added");

  const ids = store.orderedIds();
  await store.setOrder([ids[2], ids[0], ids[1]]);
  assert.deepEqual(titlesOf(store), ["Gamma", "Alpha", "Beta"]);

  // A feed the arrangement never mentioned belongs at the end, not somewhere in
  // the middle of a decision the user already made.
  store.add({ url: "https://delta.test/feed", title: "Delta" });
  assert.deepEqual(titlesOf(store), ["Gamma", "Alpha", "Beta", "Delta"]);
  assert.deepEqual(store.orderedIds().length, 4);
});

test("the arrangement is persisted and survives a reload", async () => {
  const store = await makeOrderedStore();
  const ids = store.orderedIds();
  await store.setOrder([ids[1], ids[2], ids[0]]);

  const document = JSON.parse(await readFile(store.file, "utf8"));
  assert.deepEqual(document.feedOrder, [ids[1], ids[2], ids[0]]);

  const reopened = new FeedStore({ file: store.file });
  await reopened.load();
  assert.deepEqual(titlesOf(reopened), ["Beta", "Gamma", "Alpha"]);
});

test("a rearrangement ignores ids the store does not have", async () => {
  const store = await makeOrderedStore();
  const ids = store.orderedIds();
  // A client reordering a list it read a moment ago may name a feed that has
  // since been removed; that must not cost the reader the whole edit.
  const order = await store.setOrder([ids[1], "gone-forever", ids[0]]);
  assert.deepEqual(order, [ids[1], ids[0], ids[2]], "the missing feed keeps its place at the end");
  assert.deepEqual(titlesOf(store), ["Beta", "Alpha", "Gamma"]);
});

test("a partial arrangement keeps the rest in their relative order", async () => {
  const store = await makeOrderedStore();
  const ids = store.orderedIds();
  await store.setOrder([ids[2]]);
  assert.deepEqual(titlesOf(store), ["Gamma", "Alpha", "Beta"]);
});

test("a removed feed leaves the stored arrangement, not a hole in it", async () => {
  const store = await makeOrderedStore();
  const ids = store.orderedIds();
  await store.setOrder([ids[2], ids[1], ids[0]]);
  store.remove(ids[1]);
  await store.flush();

  assert.deepEqual(titlesOf(store), ["Gamma", "Alpha"]);
  const document = JSON.parse(await readFile(store.file, "utf8"));
  assert.deepEqual(document.feedOrder, [ids[2], ids[0]], "the deleted id is normalized away on write");
});

test("the read model follows the arrangement", async () => {
  const store = await makeOrderedStore();
  const ids = store.orderedIds();
  await store.setOrder([ids[1], ids[0], ids[2]]);
  assert.deepEqual(store.snapshot().feeds.map((feed) => feed.title), ["Beta", "Alpha", "Gamma"]);
  // The agent's digest reads the same snapshot, so it sees the same order.
  assert.deepEqual(store.snapshot({ withItems: false }).feeds.map((feed) => feed.title), ["Beta", "Alpha", "Gamma"]);
});

test("PATCH /feeds/order rearranges and answers with the new state", async () => {
  const store = await makeOrderedStore();
  const routes = createRoutes({ store, coordinator: new RefreshCoordinator() });
  const ids = store.orderedIds();

  const res = await invoke(routes, `${API_PREFIX}/feeds/order`, { method: "PATCH", body: { ids: [ids[2], ids[1], ids[0]] } });
  assert.equal(res.status, 200);
  assert.deepEqual(res.body.order, [ids[2], ids[1], ids[0]]);
  assert.deepEqual(res.body.state.feeds.map((feed) => feed.title), ["Gamma", "Beta", "Alpha"]);

  // And the reader's arrangement is what a later read reports.
  const after = await invoke(routes, `${API_PREFIX}/state?items=0`);
  assert.deepEqual(after.body.state.feeds.map((feed) => feed.title), ["Gamma", "Beta", "Alpha"]);
});

test("PATCH /feeds/order refuses a body that is not a list of ids", async () => {
  const store = await makeOrderedStore();
  const routes = createRoutes({ store, coordinator: new RefreshCoordinator() });
  const before = store.orderedIds();

  const missing = await invoke(routes, `${API_PREFIX}/feeds/order`, { method: "PATCH", body: {} });
  assert.equal(missing.status, 400);
  assert.match(missing.body.error, /array of feed ids/);

  const wrongType = await invoke(routes, `${API_PREFIX}/feeds/order`, { method: "PATCH", body: { ids: "a,b,c" } });
  assert.equal(wrongType.status, 400);

  const wrongMethod = await invoke(routes, `${API_PREFIX}/feeds/order`);
  assert.equal(wrongMethod.status, 405);
  assert.deepEqual(store.orderedIds(), before, "a refused request must not rearrange anything");
});

test("the prefs route refuses methods it does not implement", async () => {
  const { routes } = await makePrefRoutes({ showSidebarEntry: true });
  const deleted = await invoke(routes, `${API_PREFIX}/prefs`, { method: "DELETE" });
  assert.equal(deleted.status, 405);
  assert.match(deleted.body.error, /GET or PATCH/);
});

// ── the RSSHub explore API ──────────────────────────────────────────────────

/**
 * A catalogue-client double exposing the two calls the API makes.
 *
 * The catalogue's own behaviour is covered in `explore.test.mjs`; here the
 * question is only what the routes do with it.
 */
function fakeCatalog({ base = "https://hub.test", routes = [], namespaces = [], categories = [] } = {}) {
  const index = new Map(routes.map((route) => [`${route.namespace} ${route.path}`, route]));
  return {
    base,
    async list() {
      return {
        total: routes.length,
        offset: 0,
        limit: 30,
        routes,
        namespaces,
        namespaceTotal: namespaces.length,
        categories,
        totals: { namespaces: namespaces.length, routes: routes.length, routesWithExample: routes.length },
        base
      };
    },
    async find(namespace, path) {
      return index.get(`${namespace} ${path}`) ?? null;
    }
  };
}

/** Routes over a fresh store plus the given catalogue double. */
async function makeExploreRoutes(catalog) {
  const store = await makeStore();
  return { store, routes: createRoutes({ store, coordinator: new RefreshCoordinator(), catalog }) };
}

test("GET /explore serves the catalogue's page through the API", async () => {
  const catalog = fakeCatalog({
    routes: [{ namespace: "github", path: "/trending/:since", name: "Trending", example: "/github/trending/daily" }],
    namespaces: [{ id: "github", name: "GitHub", url: "github.com", routes: 1, categories: ["programming"] }],
    categories: [{ id: "programming", label: "编程", count: 1 }]
  });
  const { routes } = await makeExploreRoutes(catalog);
  const res = await invoke(routes, `${API_PREFIX}/explore?q=trending`);
  assert.equal(res.status, 200);
  assert.equal(res.body.ok, true);
  assert.equal(res.body.enabled, true);
  assert.equal(res.body.total, 1);
  assert.equal(res.body.routes[0].name, "Trending");
  assert.equal(res.body.base, "https://hub.test", "the panel needs the instance to build a feed URL");
  assert.deepEqual(res.body.categories, [{ id: "programming", label: "编程", count: 1 }]);
});

test("GET /explore says why it is empty when the feature is off", async () => {
  const store = await makeStore();
  const routes = createRoutes({ store, coordinator: new RefreshCoordinator() });
  const res = await invoke(routes, `${API_PREFIX}/explore`);
  assert.equal(res.status, 503);
  assert.match(res.body.error, /rsshubExplore/, "the panel shows this text as-is");
});

test("GET /explore reports an unreachable instance as an upstream failure", async () => {
  const store = await makeStore();
  const failing = {
    base: "https://hub.test",
    async list() {
      const error = new Error("无法连接 RSSHub 实例 https://hub.test");
      error.statusCode = 502;
      throw error;
    }
  };
  const routes = createRoutes({ store, coordinator: new RefreshCoordinator(), catalog: failing });
  const res = await invoke(routes, `${API_PREFIX}/explore`);
  // 502 = the upstream failed; the documented meaning of the code the reader
  // sees, rather than a generic 500 that says "the plugin broke".
  assert.equal(res.status, 502);
  assert.match(res.body.error, /无法连接/);
});

test("POST /explore/url builds the feed URL from the catalogue's own record", async () => {
  const catalog = fakeCatalog({
    routes: [{
      namespace: "github",
      path: "/trending/:since/:language/:spoken_language?",
      name: "Trending",
      example: "/github/trending/daily/javascript/en"
    }]
  });
  const { routes } = await makeExploreRoutes(catalog);

  const res = await invoke(routes, `${API_PREFIX}/explore/url`, {
    method: "POST",
    body: { namespace: "github", path: "/trending/:since/:language/:spoken_language?", values: { since: "weekly", language: "rust" } }
  });
  assert.equal(res.status, 200);
  assert.equal(res.body.path, "/trending/weekly/rust", "a trailing optional the user left out ends the path");
  // The template is namespace-relative; the feed URL must not be, or it
  // resolves to a different route entirely.
  assert.equal(res.body.url, "https://hub.test/github/trending/weekly/rust");
  assert.equal(res.body.title, "Trending");
});

test("POST /explore/url refuses an unknown route or a missing value", async () => {
  const catalog = fakeCatalog({
    routes: [{ namespace: "github", path: "/repos/:user", name: "Repos" }]
  });
  const { routes } = await makeExploreRoutes(catalog);

  const unknown = await invoke(routes, `${API_PREFIX}/explore/url`, {
    method: "POST",
    body: { namespace: "gitlab", path: "/repos/:user", values: { user: "a" } }
  });
  assert.equal(unknown.status, 404, "the URL is built from the catalogue, never from the client alone");

  const missing = await invoke(routes, `${API_PREFIX}/explore/url`, {
    method: "POST",
    body: { namespace: "github", path: "/repos/:user", values: {} }
  });
  assert.equal(missing.status, 400);
  assert.match(missing.body.error, /user/, "the refusal names the parameter to fill");

  const wrongMethod = await invoke(routes, `${API_PREFIX}/explore/url`);
  assert.equal(wrongMethod.status, 405);

  const off = createRoutes({ store: await makeStore(), coordinator: new RefreshCoordinator() });
  const disabled = await invoke(off, `${API_PREFIX}/explore/url`, { method: "POST", body: {} });
  assert.equal(disabled.status, 503);
});

test("GET /rsshub reports both RSSHub features together", async () => {
  const store = await makeStore();
  const both = createRoutes({
    store,
    coordinator: new RefreshCoordinator(),
    rsshub: { base: "https://hub.test" },
    catalog: fakeCatalog()
  });
  const on = await invoke(both, `${API_PREFIX}/rsshub`);
  assert.equal(on.body.enabled, true);
  assert.equal(on.body.explore, true);
  assert.equal(on.body.base, "https://hub.test");

  // Discovery off, explore on: the base still has to be reported, because the
  // panel builds feed URLs from it.
  const exploreOnly = createRoutes({ store, coordinator: new RefreshCoordinator(), catalog: fakeCatalog() });
  const partial = await invoke(exploreOnly, `${API_PREFIX}/rsshub`);
  assert.equal(partial.body.enabled, false);
  assert.equal(partial.body.explore, true);
  assert.equal(partial.body.base, "https://hub.test");

  const neither = createRoutes({ store, coordinator: new RefreshCoordinator() });
  const off = await invoke(neither, `${API_PREFIX}/rsshub`);
  assert.equal(off.body.explore, false);
  assert.match(off.body.reason, /disabled/);
});
