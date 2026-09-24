/**
 * dsh-rss-reader — XML reader and feed parser tests.
 *
 * Feeds in the wild are malformed in predictable ways, so the fixtures here
 * are deliberately broken: unescaped ampersands, missing namespace
 * declarations, stray end tags, CDATA-wrapped HTML, and HTML entities that are
 * not valid XML.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { attr, childText, findChild, findChildren, findDescendant, localName, nodeText, parseXml } from "../lib/xml.js";
import { discoverFeeds, htmlToText, normalizeDate, parseFeed, resolveUrl } from "../lib/feed.js";

// ── XML reader ──────────────────────────────────────────────────────────────

test("parseXml reads nested elements, attributes, and text", () => {
  const { root } = parseXml('<a href="x"><b>hi</b><c d=\'1\'/></a>');
  const a = findChild(root, "a");
  assert.equal(attr(a, "href"), "x");
  assert.equal(childText(a, "b"), "hi");
  assert.equal(attr(findChild(a, "c"), "d"), "1");
});

test("parseXml keeps `>` inside a quoted attribute value", () => {
  const { root } = parseXml('<a title="a > b">text</a>');
  assert.equal(attr(findChild(root, "a"), "title"), "a > b");
  assert.equal(nodeText(findChild(root, "a")), "text");
});

test("parseXml decodes entities but still reads a raw ampersand", () => {
  const { root } = parseXml("<a>Tom &amp; Jerry & Jerry</a>");
  // The bare `&` survives verbatim: dropping it would lose content.
  assert.equal(nodeText(findChild(root, "a")), "Tom & Jerry & Jerry");
});

test("parseXml decodes numeric references, including hex", () => {
  const { root } = parseXml("<a>&#65;&#x42;&#x4e2d;</a>");
  assert.equal(nodeText(findChild(root, "a")), "AB中");
});

test("parseXml drops control characters that would corrupt output", () => {
  const { root } = parseXml("<a>x&#0;y&#8;z</a>");
  assert.equal(nodeText(findChild(root, "a")), "xyz");
});

test("parseXml preserves CDATA verbatim", () => {
  const { root } = parseXml("<a><![CDATA[<p>raw & stuff</p>]]></a>");
  assert.equal(nodeText(findChild(root, "a")), "<p>raw & stuff</p>");
});

test("parseXml recovers from mismatched and stray end tags", () => {
  const { root } = parseXml("<a><b>one</a></b><c>two</c>");
  const a = findChild(root, "a");
  assert.equal(childText(a, "b"), "one");
  // Parsing must continue after the mis-nesting.
  assert.equal(childText(root, "c"), "two");
});

test("parseXml closes unclosed elements at EOF", () => {
  const { root } = parseXml("<a><b>text");
  assert.equal(childText(findChild(root, "a"), "b"), "text");
});

test("parseXml skips comments, processing instructions, and DOCTYPE", () => {
  const { root } = parseXml(
    '<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE rss [<!ENTITY x "y">]><!-- note --><a>ok</a>'
  );
  assert.equal(childText(root, "a"), "ok");
});

test("parseXml reports the XML declaration", () => {
  const { declaration } = parseXml('<?xml version="1.0" encoding="GB2312"?><a/>');
  assert.equal(declaration.version, "1.0");
  assert.equal(declaration.encoding, "GB2312");
});

test("parseXml handles empty and non-string input without throwing", () => {
  for (const input of ["", null, undefined, "<", "<a", "<a>"]) {
    assert.doesNotThrow(() => parseXml(input));
  }
});

test("parseXml terminates on a tag body containing bare slashes and equals", () => {
  // Regression: the attribute scanner used to `continue` without consuming a
  // character when it met `/` or `=` where no attribute name had been read.
  // Real feeds hit this when JavaScript is captured by a stray `<` (e.g.
  // `plotW / (n - 1);`), and the resulting loop was synchronous and infinite —
  // it froze the whole harness process, not merely the one request.
  const hostile = "<p>before < 5 ? plotW / (n - 1) : 0; and a / b = c after</p>";
  assert.doesNotThrow(() => parseXml(hostile, { voidElements: true }));
  assert.match(nodeText(parseXml(hostile, { voidElements: true }).root), /before/);
});

test("parseXml terminates on pathological attribute runs", () => {
  const cases = [
    "<a /=/=/=/>",
    "<a ////>",
    "<a ====>",
    "<a b=/ c=/ d=/>",
    "<a b='unterminated",
    '<a b="unterminated',
    "<a = = = >",
    "<a / b / c / d>",
    `<a ${"/ ".repeat(500)}>`,
    `<a ${"= ".repeat(500)}>`
  ];
  for (const input of cases) {
    // A non-advancing loop would hang the test process rather than fail it.
    assert.doesNotThrow(() => parseXml(input, { voidElements: true }), `input: ${input.slice(0, 40)}`);
  }
});

test("parseFeed terminates on a body containing leaked code fragments", () => {
  // The real-world shape: JavaScript that leaked out of a feed's HTML body.
  const feed = `<rss><channel><title>T</title><item><title>I</title>
    <description><![CDATA[<p>Chart</p><script>var w = n < 2 ? 0 : plotW / (n - 1);</script>]]></description>
  </item></channel></rss>`;
  assert.doesNotThrow(() => parseFeed(feed));
  assert.equal(parseFeed(feed).items.length, 1);
});

test("namespace prefixes are matched by their local part", () => {
  const { root } = parseXml('<rdf:RDF xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:creator>Ann</dc:creator></rdf:RDF>');
  assert.equal(localName("dc:creator"), "creator");
  // The prefixed element is reachable by either spelling.
  assert.equal(childText(findDescendant(root, "rdf:RDF"), "creator"), "Ann");
  assert.equal(childText(findDescendant(root, "rdf:RDF"), "dc:creator"), "Ann");
  // Names are lower-cased throughout, so matching is case-insensitive.
  assert.equal(localName(findChild(root, "rdf:RDF").name), "rdf");
});

// ── HTML flattening ─────────────────────────────────────────────────────────

test("htmlToText strips tags, decodes entities, and collapses whitespace", () => {
  const text = htmlToText("<p>Hello   <b>world</b></p><p>Second &amp; third</p>");
  assert.equal(text, "Hello world Second & third");
});

test("htmlToText drops script and style bodies", () => {
  const text = htmlToText("<style>a{color:red}</style><script>alert(1)</script><p>keep</p>");
  assert.equal(text, "keep");
});

test("htmlToText unwraps a CDATA wrapper that arrived as text", () => {
  assert.equal(htmlToText("<![CDATA[<p>inside</p>]]>"), "inside");
});

// ── URL and date normalization ──────────────────────────────────────────────

test("resolveUrl makes relative links absolute and leaves bad input alone", () => {
  assert.equal(resolveUrl("/a/b", "https://x.test/c/d"), "https://x.test/a/b");
  assert.equal(resolveUrl("https://y.test/z", "https://x.test/"), "https://y.test/z");
  assert.equal(resolveUrl("", "https://x.test/"), "");
  // Unresolvable input is returned rather than dropped.
  assert.equal(resolveUrl("not a url", ""), "not a url");
});

test("normalizeDate accepts real dates and rejects nonsense", () => {
  assert.equal(normalizeDate("2024-05-01T10:00:00Z"), "2024-05-01T10:00:00.000Z");
  assert.equal(normalizeDate("Wed, 01 May 2024 10:00:00 GMT"), "2024-05-01T10:00:00.000Z");
  assert.equal(normalizeDate("not a date"), "");
  assert.equal(normalizeDate(""), "");
  // Absurd years are treated as unusable rather than displayed.
  assert.equal(normalizeDate("1900-01-01T00:00:00Z"), "");
  assert.equal(normalizeDate("9999-01-01T00:00:00Z"), "");
});

// ── RSS 2.0 ─────────────────────────────────────────────────────────────────

const RSS2 = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:content="http://purl.org/rss/1.0/modules/content/" xmlns:dc="http://purl.org/dc/elements/1.1/">
  <channel>
    <title>Example Feed</title>
    <link>https://example.com/</link>
    <description>A test feed</description>
    <language>en-us</language>
    <lastBuildDate>Wed, 01 May 2024 12:00:00 GMT</lastBuildDate>
    <item>
      <title>Newer item</title>
      <link>https://example.com/2</link>
      <guid isPermaLink="false">tag:example.com,2024:2</guid>
      <pubDate>Wed, 01 May 2024 11:00:00 GMT</pubDate>
      <description>&lt;p&gt;Second &amp;amp; newest&lt;/p&gt;</description>
      <dc:creator>Ann</dc:creator>
      <category>tech</category>
      <category>news</category>
    </item>
    <item>
      <title>Older item</title>
      <link>https://example.com/1</link>
      <pubDate>Tue, 30 Apr 2024 09:00:00 GMT</pubDate>
      <content:encoded><![CDATA[<p>Body with <b>markup</b></p>]]></content:encoded>
    </item>
  </channel>
</rss>`;

test("parseFeed reads RSS 2.0 channel metadata", () => {
  const feed = parseFeed(RSS2, { url: "https://example.com/feed.xml" });
  assert.equal(feed.format, "rss");
  assert.equal(feed.title, "Example Feed");
  assert.equal(feed.link, "https://example.com/");
  assert.equal(feed.description, "A test feed");
  assert.equal(feed.language, "en-us");
  assert.equal(feed.updated, "2024-05-01T12:00:00.000Z");
});

test("parseFeed normalizes RSS items and sorts newest first", () => {
  const feed = parseFeed(RSS2);
  assert.equal(feed.items.length, 2);
  assert.equal(feed.items[0].title, "Newer item");
  assert.equal(feed.items[1].title, "Older item");
  assert.equal(feed.items[0].author, "Ann");
  assert.deepEqual(feed.items[0].categories, ["tech", "news"]);
  assert.equal(feed.items[0].summary, "Second & newest");
  // The non-permalink guid is kept as the identity.
  assert.equal(feed.items[0].id, "tag:example.com,2024:2");
});

test("parseFeed flattens content:encoded markup", () => {
  const feed = parseFeed(RSS2);
  assert.equal(feed.items[1].content, "Body with markup");
});

// ── Atom ────────────────────────────────────────────────────────────────────

const ATOM = `<?xml version="1.0" encoding="utf-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <title>Atom Example</title>
  <subtitle>Sub</subtitle>
  <link rel="alternate" href="https://atom.test/"/>
  <link rel="self" href="https://atom.test/feed.atom"/>
  <updated>2024-06-02T08:30:00Z</updated>
  <entry>
    <title>Entry One</title>
    <link rel="alternate" href="/entry/1"/>
    <id>urn:uuid:1</id>
    <updated>2024-06-02T08:00:00Z</updated>
    <published>2024-06-01T08:00:00Z</published>
    <author><name>Bob</name></author>
    <summary>Short summary</summary>
    <category term="alpha"/>
  </entry>
</feed>`;

test("parseFeed reads Atom metadata and prefers rel=alternate", () => {
  const feed = parseFeed(ATOM, { url: "https://atom.test/feed.atom" });
  assert.equal(feed.format, "atom");
  assert.equal(feed.title, "Atom Example");
  assert.equal(feed.description, "Sub");
  assert.equal(feed.link, "https://atom.test/");
  assert.equal(feed.updated, "2024-06-02T08:30:00.000Z");
});

test("parseFeed resolves relative Atom entry links against the feed URL", () => {
  const feed = parseFeed(ATOM, { url: "https://atom.test/feed.atom" });
  assert.equal(feed.items.length, 1);
  assert.equal(feed.items[0].link, "https://atom.test/entry/1");
  assert.equal(feed.items[0].author, "Bob");
  assert.equal(feed.items[0].id, "urn:uuid:1");
  assert.deepEqual(feed.items[0].categories, ["alpha"]);
});

// ── RSS 1.0 / RDF ───────────────────────────────────────────────────────────

const RDF = `<?xml version="1.0"?>
<rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#" xmlns="http://purl.org/rss/1.0/" xmlns:dc="http://purl.org/dc/elements/1.1/">
  <channel rdf:about="https://rdf.test/">
    <title>RDF Example</title>
    <link>https://rdf.test/</link>
    <description>RDF desc</description>
  </channel>
  <item rdf:about="https://rdf.test/1">
    <title>RDF Item</title>
    <link>https://rdf.test/1</link>
    <dc:date>2024-03-03T00:00:00Z</dc:date>
    <description>Body text</description>
  </item>
</rdf:RDF>`;

test("parseFeed reads RSS 1.0 / RDF where items are channel siblings", () => {
  const feed = parseFeed(RDF, { url: "https://rdf.test/feed.rdf" });
  assert.equal(feed.format, "rdf");
  assert.equal(feed.title, "RDF Example");
  assert.equal(feed.link, "https://rdf.test/");
  assert.equal(feed.items.length, 1);
  assert.equal(feed.items[0].title, "RDF Item");
  assert.equal(feed.items[0].date, "2024-03-03T00:00:00.000Z");
});

// ── Hostile / broken input ──────────────────────────────────────────────────

test("parseFeed survives unescaped ampersands in titles and links", () => {
  const feed = parseFeed(`<rss><channel><title>A & B</title>
    <item><title>Tom & Jerry</title><link>https://x.test/?a=1&b=2</link></item>
  </channel></rss>`);
  assert.equal(feed.title, "A & B");
  assert.equal(feed.items[0].title, "Tom & Jerry");
  assert.equal(feed.items[0].link, "https://x.test/?a=1&b=2");
});

test("parseFeed falls back to the channel date when an item has none", () => {
  const feed = parseFeed(`<rss><channel>
    <lastBuildDate>Wed, 01 May 2024 12:00:00 GMT</lastBuildDate>
    <item><title>No date</title></item>
  </channel></rss>`);
  assert.equal(feed.items[0].date, "2024-05-01T12:00:00.000Z");
});

test("parseFeed keeps an item that has a title but no link", () => {
  const feed = parseFeed("<rss><channel><item><title>Title only</title></item></channel></rss>");
  assert.equal(feed.items.length, 1);
  assert.equal(feed.items[0].link, "");
});

test("parseFeed drops entries with neither title nor link", () => {
  const feed = parseFeed("<rss><channel><item><description>orphan</description></item></channel></rss>");
  assert.equal(feed.items.length, 0);
});

test("parseFeed names an untitled item rather than dropping it", () => {
  const feed = parseFeed('<rss><channel><item><link>https://x.test/1</link></item></channel></rss>');
  assert.equal(feed.items[0].title, "(untitled)");
});

test("parseFeed derives a stable id when no guid is present", () => {
  const feed = parseFeed('<rss><channel><item><title>T</title><link>https://x.test/1</link></item></channel></rss>');
  assert.equal(feed.items[0].id, "https://x.test/1");
});

test("parseFeed recognizes a bare <channel> root", () => {
  const feed = parseFeed("<channel><title>Bare</title><item><title>x</title></item></channel>");
  assert.equal(feed.title, "Bare");
  assert.equal(feed.items.length, 1);
});

test("parseFeed reports a precise error for non-feed markup", () => {
  assert.throws(() => parseFeed("<html><body>hi</body></html>"), /no feed structure found/);
  assert.throws(() => parseFeed(""), /no feed structure found/);
});

test("parseFeed reads an enclosure URL", () => {
  const feed = parseFeed(`<rss><channel><item><title>Pod</title>
    <enclosure url="https://x.test/a.mp3" type="audio/mpeg" length="1"/>
  </item></channel></rss>`);
  assert.equal(feed.items[0].enclosure, "https://x.test/a.mp3");
});

// ── Feed discovery ──────────────────────────────────────────────────────────

test("discoverFeeds finds RSS and Atom link declarations", () => {
  const html = `<html><head>
    <link rel="alternate" type="application/rss+xml" title="Main" href="/feed.xml">
    <link rel="alternate" type="application/atom+xml" href="https://other.test/atom">
    <link rel="stylesheet" href="/style.css">
  </head></html>`;
  const found = discoverFeeds(html, "https://site.test/page");
  assert.equal(found.length, 2);
  assert.equal(found[0].url, "https://site.test/feed.xml");
  assert.equal(found[0].title, "Main");
  assert.equal(found[1].url, "https://other.test/atom");
});

test("discoverFeeds ignores non-feed alternate links", () => {
  const html = '<link rel="alternate" type="text/html" hreflang="fr" href="/fr">';
  assert.equal(discoverFeeds(html, "https://site.test/").length, 0);
});

test("discoverFeeds returns nothing for empty input", () => {
  assert.deepEqual(discoverFeeds("", "https://x.test/"), []);
  assert.deepEqual(discoverFeeds(null, undefined), []);
});
