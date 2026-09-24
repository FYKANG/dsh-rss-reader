/**
 * dsh-rss-reader — history backfill tests.
 *
 * A feed is a window, not an archive, so this feature reaches articles the feed
 * itself stopped carrying. What matters:
 *
 * - the archive page is filtered down to article-shaped links, because an
 *   archive is mostly navigation;
 * - the same article is never fetched twice, whatever scheme it was stored under;
 * - one bad page does not lose the rest of the run;
 * - the per-feed cap trims the oldest article, never the feed's own entries.
 *
 * A real loopback HTTP server serves the pages, so the whole path — fetch,
 * extract, convert, merge — is exercised rather than mocked.
 */

import assert from "node:assert/strict";
import { createServer } from "node:http";
import { after, test } from "node:test";

import {
  HISTORY_MAX_LIMIT,
  backfillHistory,
  canonicalUrl,
  deriveLinkFilter,
  extractArticleHtml,
  extractLinks,
  extractTitle,
  firstProseParagraph,
  inferDate,
  itemFromPage
} from "../lib/history.js";
import { FeedStore } from "../lib/store.js";

/** Directories created by the tests, removed at the end. */
const servers = [];

after(async () => {
  for (const server of servers) {
    await new Promise((resolve) => server.close(resolve));
  }
});

/**
 * Start a loopback server serving a fixed path table.
 *
 * @param {Record<string, {status?: number, type?: string, body: string}>} routes - path → response.
 * @returns {Promise<{origin: string, requests: string[]}>} the origin and a live request log.
 */
async function serve(routes) {
  const requests = [];
  const server = createServer((req, res) => {
    const path = (req.url ?? "/").split("?")[0];
    requests.push(path);
    const route = routes[path];
    if (route === undefined) {
      res.writeHead(404, { "content-type": "text/plain" });
      res.end("not found");
      return;
    }
    res.writeHead(route.status ?? 200, { "content-type": route.type ?? "text/html; charset=utf-8" });
    res.end(route.body);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  servers.push(server);
  const { port } = server.address();
  return { origin: `http://127.0.0.1:${port}`, requests };
}

/** One article page with the shape the extractor looks for. */
function articlePage(title, date, prose) {
  return `<!doctype html><html><head><title>${title} - 示例站</title></head><body>
    <nav><a href="/">首页</a></nav>
    <article>
      <h1>${title}</h1>
      <p>作者： 某人</p>
      <p>日期： ${date}</p>
      <p>${prose}</p>
    </article>
    <footer><a href="/about">关于</a></footer>
  </body></html>`;
}

// ── Link extraction and filtering ───────────────────────────────────────────

test("extractLinks resolves relative hrefs and drops non-page targets", () => {
  const html = `
    <a href="/a/1.html">one</a>
    <a href='a/2.html'>two</a>
    <a href="https://other.test/x.html">three</a>
    <a href="#top">frag</a>
    <a href="mailto:x@y.test">mail</a>
    <a href="javascript:void(0)">js</a>
    <a href="/a/1.html">dup</a>
  `;
  assert.deepEqual(extractLinks(html, "http://site.test/blog/index.html"), [
    "http://site.test/a/1.html",
    "http://site.test/blog/a/2.html",
    "https://other.test/x.html"
  ]);
  assert.deepEqual(extractLinks("", "http://site.test/"), []);
});

test("deriveLinkFilter keeps the article shape and drops the furniture", () => {
  const filter = deriveLinkFilter([
    "http://site.test/blog/2026/09/weekly-issue-413.html",
    "http://site.test/blog/2026/09/weekly-issue-412.html"
  ]);
  // Another date and issue number: the whole point of matching on shape.
  assert.equal(filter("https://site.test/blog/2018/04/weekly-issue-1.html"), true);
  // The same host, but not an article of this shape.
  assert.equal(filter("https://site.test/about"), false);
  assert.equal(filter("https://site.test/blog/"), false);
  assert.equal(filter("https://other.test/blog/2026/09/weekly-issue-1.html"), false);
  // A feed with nothing to learn from accepts everything.
  assert.equal(deriveLinkFilter([])("https://anything.test/x"), true);
});

test("canonicalUrl makes the http/https spellings of one article equal", () => {
  assert.equal(
    canonicalUrl("http://site.test/blog/x.html"),
    canonicalUrl("https://site.test/blog/x.html#top")
  );
  assert.equal(canonicalUrl("not a url"), "");
});

// ── Page extraction ─────────────────────────────────────────────────────────

test("extractArticleHtml prefers the article element over the whole page", () => {
  const html = "<html><body><nav>menu</nav><article><p>Body text.</p></article><footer>end</footer></body></html>";
  const inner = extractArticleHtml(html);
  assert.match(inner, /Body text/);
  assert.doesNotMatch(inner, /menu/, "navigation must not become article text");
  assert.doesNotMatch(inner, /end/);

  // Without an <article>, a conventional content container is used and ends at
  // its matching close, not at the first inner div.
  const container = `<html><body><div id="main-content"><div>inner</div><p>kept</p></div><footer>drop</footer></body></html>`;
  const fromContainer = extractArticleHtml(container);
  assert.match(fromContainer, /inner/);
  assert.match(fromContainer, /kept/);
  assert.doesNotMatch(fromContainer, /drop/);

  // With nothing to identify the article, the chrome is still stripped.
  const bare = "<html><body><script>var x=1</script><p>only</p><footer>f</footer></body></html>";
  const stripped = extractArticleHtml(bare);
  assert.match(stripped, /only/);
  assert.doesNotMatch(stripped, /var x=1/);
});

test("extractTitle drops the site suffix", () => {
  assert.equal(extractTitle("<title>Article - Site</title>"), "Article");
  assert.equal(extractTitle("<title>Article | Site</title>"), "Article");
  assert.equal(extractTitle("<title>Just A Title</title>"), "Just A Title");
  assert.equal(extractTitle("<html></html>"), "");
});

test("firstProseParagraph skips headings, images and bylines", () => {
  const body = [
    "## 封面图",
    "",
    "![pic](https://x.test/a.png)",
    "",
    "作者： [某人](https://x.test)",
    "",
    "这是正文的第一段，应该被当作摘要使用。"
  ].join("\n");
  assert.match(firstProseParagraph(body), /这是正文的第一段/);

  // Nothing usable yields an empty summary rather than a heading.
  assert.equal(firstProseParagraph("# Only a heading"), "");
  assert.equal(firstProseParagraph(""), "");
});

test("inferDate reads a Chinese date, a time element, and a dated URL", () => {
  assert.equal(
    inferDate("<html><body><p>日期： 2026年9月18日</p></body></html>", "https://x.test/a.html"),
    "2026-09-18T00:00:00.000Z"
  );
  assert.equal(
    inferDate('<time datetime="2024-06-02T08:30:00Z">x</time>', "https://x.test/a.html"),
    "2024-06-02T08:30:00.000Z"
  );
  // No date in the page: the URL's month is better than nothing.
  assert.equal(inferDate("<html></html>", "https://x.test/2018/04/a.html"), "2018-04-01T00:00:00.000Z");
  assert.equal(inferDate("<html></html>", "https://x.test/a.html"), "");
});

test("itemFromPage produces the same shape a feed parser would", () => {
  const item = itemFromPage(
    articlePage("标题", "2026年9月18日", "这是正文的第一段，长度足够作为摘要。"),
    "https://x.test/blog/a.html"
  );
  assert.equal(item.id, "https://x.test/blog/a.html");
  assert.equal(item.title, "标题");
  assert.equal(item.link, "https://x.test/blog/a.html");
  assert.equal(item.date, "2026-09-18T00:00:00.000Z");
  assert.match(item.markdown, /这是正文的第一段/);
  // The summary is prose, not the byline line above it.
  assert.match(item.summary, /这是正文的第一段/);
  assert.doesNotMatch(item.summary, /日期/);
  assert.equal(item.read, false);
  // The site chrome must not leak into the body.
  assert.doesNotMatch(item.markdown, /首页/);
});

// ── The run itself ──────────────────────────────────────────────────────────

test("backfillHistory fetches older articles in order, politely", async () => {
  const { origin, requests } = await serve({
    "/archives/": {
      body: `<html><body>
        <nav><a href="/about">关于</a><a href="/blog/">目录</a></nav>
        <a href="/blog/2026/09/issue-3.html">3</a>
        <a href="/blog/2026/08/issue-2.html">2</a>
        <a href="/blog/2026/07/issue-1.html">1</a>
      </body></html>`
    },
    "/blog/2026/08/issue-2.html": { body: articlePage("第二期", "2026年8月10日", "第二期的正文，写得长一些才像一篇文章。") },
    "/blog/2026/07/issue-1.html": { body: articlePage("第一期", "2026年7月10日", "第一期的正文，同样写得长一些。") }
  });

  const result = await backfillHistory({
    archiveUrl: `${origin}/archives/`,
    limit: 2,
    sampleLinks: [`${origin}/blog/2026/09/issue-3.html`],
    known: new Set([canonicalUrl(`${origin}/blog/2026/09/issue-3.html`)]),
    delayMs: 0,
    timeoutMs: 5000
  });

  assert.equal(result.considered, 3, "three article-shaped links, not the navigation");
  assert.equal(result.skipped, 1, "the one already subscribed");
  assert.deepEqual(result.items.map((item) => item.title), ["第二期", "第一期"]);
  assert.deepEqual(result.failures, []);
  // Newest first, then descending: the reader keeps going further back.
  assert.ok(result.items[0].date > result.items[1].date);
  // Each article was fetched exactly once, and never the held one.
  assert.deepEqual(requests.filter((path) => path.startsWith("/blog/")), [
    "/blog/2026/08/issue-2.html",
    "/blog/2026/07/issue-1.html"
  ]);
});

test("one unreadable article does not lose the rest of the run", async () => {
  const { origin } = await serve({
    // Dated paths, so one shape covers all three: the filter matches the kind of
    // URL a feed carries, not one exact article.
    "/archives/": {
      body: `<a href="/blog/2026/09/a.html">a</a><a href="/blog/2026/08/b.html">b</a><a href="/blog/2026/07/c.html">c</a>`
    },
    "/blog/2026/09/a.html": { body: articlePage("A", "2026年9月1日", "A 的正文，写得长一些。") },
    "/blog/2026/08/b.html": { status: 500, body: "boom" },
    "/blog/2026/07/c.html": { body: articlePage("C", "2026年7月1日", "C 的正文，也写得长一些。") }
  });

  const result = await backfillHistory({
    archiveUrl: `${origin}/archives/`,
    limit: 3,
    // The sample describes the URL shape; it is not itself in this archive, so
    // all three links are candidates and the middle one fails.
    sampleLinks: [`${origin}/blog/2026/06/older.html`],
    delayMs: 0,
    timeoutMs: 5000
  });

  assert.deepEqual(result.items.map((item) => item.title), ["A", "C"]);
  assert.equal(result.failures.length, 1);
  assert.match(result.failures[0].url, /\/blog\/2026\/08\/b\.html$/);
  assert.match(result.failures[0].error, /500/);
});

test("an archive page that cannot be read fails the run", async () => {
  const { origin } = await serve({});
  await assert.rejects(
    () => backfillHistory({ archiveUrl: `${origin}/missing/`, limit: 1, delayMs: 0, timeoutMs: 5000 }),
    /归档页失败|404/
  );
});

test("the per-run ceiling is enforced whatever the caller asks for", async () => {
  const { origin } = await serve({
    "/archives/": { body: `<a href="/blog/a.html">a</a><a href="/blog/b.html">b</a>` },
    "/blog/a.html": { body: articlePage("A", "2026年9月1日", "A 的正文。") },
    "/blog/b.html": { body: articlePage("B", "2026年8月1日", "B 的正文。") }
  });
  const result = await backfillHistory({
    archiveUrl: `${origin}/archives/`,
    limit: 9999,
    sampleLinks: [`${origin}/blog/a.html`],
    delayMs: 0,
    timeoutMs: 5000
  });
  assert.ok(result.items.length <= HISTORY_MAX_LIMIT);
});

// ── Merging into the store ──────────────────────────────────────────────────

test("backfilled items join the feed without displacing its own", async () => {
  const store = new FeedStore({ file: ":memory:", maxItemsPerFeed: 4 });
  await store.load();
  const added = store.add({ url: "https://s.test/feed", title: "F" });
  const feedId = added.feed.id;
  // The feed's own window: two recent items.
  store.addItems(feedId, [
    { id: "newest", link: "https://s.test/3", title: "最新", date: "2026-09-20T00:00:00.000Z" },
    { id: "recent", link: "https://s.test/2", title: "近期", date: "2026-09-10T00:00:00.000Z" }
  ]);
  assert.equal(store.get(feedId).items.length, 2);

  // Older articles arrive and sort below the feed's own entries.
  const merged = store.addItems(feedId, [
    { id: "old1", link: "https://s.test/1", title: "较早", date: "2026-08-10T00:00:00.000Z" },
    { id: "old2", link: "https://s.test/0", title: "更早", date: "2026-07-10T00:00:00.000Z" }
  ]);
  assert.equal(merged.added, 2);
  assert.deepEqual(store.get(feedId).items.map((item) => item.title), ["最新", "近期", "较早", "更早"]);

  // The same items again add nothing: a second run is not a re-download.
  assert.equal(store.addItems(feedId, [{ id: "old1", link: "https://s.test/1", title: "较早", date: "2026-08-10T00:00:00.000Z" }]).added, 0);

  // A backfilled article is ordinary content: flags and translations stick.
  store.setItemFlags(feedId, "old1", { starred: true });
  assert.equal(store.findItem(feedId, "old1").item.starred, true);
});

test("the per-feed cap trims the oldest article, never the feed's own", async () => {
  const store = new FeedStore({ file: ":memory:", maxItemsPerFeed: 2 });
  await store.load();
  const feedId = store.add({ url: "https://s.test/feed", title: "F" }).feed.id;
  store.addItems(feedId, [
    { id: "newest", link: "https://s.test/2", title: "最新", date: "2026-09-20T00:00:00.000Z" },
    { id: "oldest", link: "https://s.test/1", title: "较早", date: "2026-08-10T00:00:00.000Z" }
  ]);
  const outcome = store.addItems(feedId, [
    { id: "ancient", link: "https://s.test/0", title: "更早", date: "2026-07-10T00:00:00.000Z" },
    { id: "recent", link: "https://s.test/3", title: "更新", date: "2026-09-25T00:00:00.000Z" }
  ]);
  assert.equal(outcome.total, 2);
  assert.deepEqual(store.get(feedId).items.map((item) => item.title), ["更新", "最新"]);
});
