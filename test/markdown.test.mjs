/**
 * dsh-rss-reader — HTML→Markdown conversion tests.
 *
 * Feed bodies are HTML full of links, images, code and nesting; the converter
 * is what makes the reading pane's Markdown rendering possible. These tests
 * pin the structures that actually appear in feeds, plus the escaping rules
 * that keep hostile markup from becoming live Markdown syntax.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { extractImages, htmlToMarkdown, tidyMarkdown, MAX_MARKDOWN_CHARS } from "../lib/markdown.js";
import { parseFeed } from "../lib/feed.js";

// ── Text and entities ───────────────────────────────────────────────────────

test("plain text passes through verbatim, with blank runs trimmed", () => {
  // Already-textual fields are not escaped or reflowed: an item whose body is
  // plain text must render exactly as written.
  assert.equal(htmlToMarkdown("Hello   world"), "Hello   world");
  assert.equal(htmlToMarkdown("a\n\n\n\nb"), "a\n\nb");
  assert.equal(htmlToMarkdown(""), "");
  assert.equal(htmlToMarkdown(null), "");
});

test("entities are decoded and markup-derived text is escaped", () => {
  assert.equal(htmlToMarkdown("<p>Tom &amp; Jerry</p>"), "Tom & Jerry");
  // Text that came from HTML is escaped, so a literal `*` cannot become
  // emphasis that the feed never asked for.
  assert.equal(htmlToMarkdown("<p>2 * 3 * 4</p>"), "2 \\* 3 \\* 4");
  assert.match(htmlToMarkdown("<p>snake_case_name</p>"), /\\_/);
});

// ── Block structure ─────────────────────────────────────────────────────────

test("headings map to the matching level", () => {
  assert.equal(htmlToMarkdown("<h1>Title</h1>"), "# Title");
  assert.equal(htmlToMarkdown("<h3>Sub</h3>"), "### Sub");
  assert.equal(htmlToMarkdown("<h6>Deep</h6>"), "###### Deep");
});

test("paragraphs are separated by blank lines", () => {
  assert.equal(htmlToMarkdown("<p>One</p><p>Two</p>"), "One\n\nTwo");
});

test("unordered and ordered lists keep their markers", () => {
  assert.equal(htmlToMarkdown("<ul><li>a</li><li>b</li></ul>"), "- a\n- b");
  assert.equal(htmlToMarkdown("<ol><li>a</li><li>b</li></ol>"), "1. a\n2. b");
});

test("an ordered list honours its start attribute", () => {
  assert.match(htmlToMarkdown('<ol start="5"><li>a</li><li>b</li></ol>'), /^5\. a\n6\. b$/);
});

test("nested lists are indented under their parent item", () => {
  const markdown = htmlToMarkdown("<ul><li>a<ul><li>a1</li></ul></li><li>b</li></ul>");
  assert.match(markdown, /- a/);
  assert.match(markdown, /a1/, "the nested item must survive");
  assert.match(markdown, /- b/);
});

test("blockquotes get the quote prefix", () => {
  assert.equal(htmlToMarkdown("<blockquote><p>Quoted</p></blockquote>"), "> Quoted");
});

test("horizontal rules become a thematic break", () => {
  assert.match(htmlToMarkdown("<p>a</p><hr><p>b</p>"), /a\n\n---\n\nb/);
});

test("a table becomes pipe rows with a header separator", () => {
  const markdown = htmlToMarkdown(
    "<table><thead><tr><th>H1</th><th>H2</th></tr></thead>"
    + "<tbody><tr><td>a</td><td>b</td></tr></tbody></table>"
  );
  assert.match(markdown, /\| H1 \| H2 \|/);
  assert.match(markdown, /\| --- \| --- \|/);
  assert.match(markdown, /\| a \| b \|/);
});

test("a pipe inside a cell is escaped so the row keeps its shape", () => {
  const markdown = htmlToMarkdown("<table><tr><th>H</th></tr><tr><td>a|b</td></tr></table>");
  assert.match(markdown, /a\\\|b/);
});

// ── Inline structure ────────────────────────────────────────────────────────

test("emphasis and strikethrough convert", () => {
  assert.equal(htmlToMarkdown("<p><strong>bold</strong></p>"), "**bold**");
  assert.equal(htmlToMarkdown("<p><b>bold</b></p>"), "**bold**");
  assert.equal(htmlToMarkdown("<p><em>it</em></p>"), "*it*");
  assert.equal(htmlToMarkdown("<p><del>gone</del></p>"), "~~gone~~");
});

test("links become Markdown links and bare URLs become autolinks", () => {
  assert.equal(
    htmlToMarkdown('<p><a href="https://x.test/">Text</a></p>'),
    "[Text](https://x.test/)"
  );
  assert.equal(
    htmlToMarkdown('<p><a href="https://x.test/">https://x.test/</a></p>'),
    "<https://x.test/>"
  );
});

test("a link with no href degrades to its text", () => {
  assert.equal(htmlToMarkdown("<p><a>Plain</a></p>"), "Plain");
});

test("javascript and data URLs are dropped, keeping only the text", () => {
  // A hostile feed must not be able to produce a live script link.
  const markdown = htmlToMarkdown('<p><a href="javascript:alert(1)">Click</a></p>');
  assert.equal(markdown, "Click");
  assert.ok(!markdown.includes("javascript:"), "the dangerous scheme must not survive");
  assert.equal(htmlToMarkdown('<p><a href="data:text/html;base64,PHNjcmlwdD4=">x</a></p>'), "x");
  assert.equal(htmlToMarkdown('<img src="javascript:alert(1)" alt="x">'), "");
});

test("parentheses in a URL are escaped so the link does not close early", () => {
  const markdown = htmlToMarkdown('<p><a href="https://x.test/a(b)">t</a></p>');
  assert.match(markdown, /a\\\(b\\\)/);
});

test("inline code and fenced blocks survive with their language", () => {
  assert.equal(htmlToMarkdown("<p>use <code>npm i</code></p>"), "use `npm i`");
  const block = htmlToMarkdown('<pre><code class="language-js">const a = 1;</code></pre>');
  assert.match(block, /```js/);
  assert.match(block, /const a = 1;/);
});

test("a code block containing backticks gets a longer fence", () => {
  const block = htmlToMarkdown("<pre><code>a ``` b</code></pre>");
  // The fence must be longer than the run inside, or the block would break out.
  assert.match(block, /````/);
  assert.match(block, /a ``` b/);
});

test("inline code containing a backtick uses a longer fence", () => {
  // A single-backtick fence could not hold the content, so the fence grows.
  assert.equal(htmlToMarkdown("<p><code>a`b</code></p>"), "``a`b``");
});

test("script and style content never reaches the output", () => {
  const markdown = htmlToMarkdown("<p>safe</p><script>alert(1)</script><style>p{}</style>");
  assert.equal(markdown, "safe");
});

test("an unknown tag keeps its text and loses the tag", () => {
  assert.equal(htmlToMarkdown("<p><custom-tag>Kept</custom-tag></p>"), "Kept");
});

// ── Images ──────────────────────────────────────────────────────────────────

test("images become Markdown image syntax", () => {
  assert.equal(
    htmlToMarkdown('<p><img src="https://x.test/a.png" alt="A cat"></p>'),
    "![A cat](https://x.test/a.png)"
  );
});

test("an image with no alt still converts", () => {
  assert.equal(htmlToMarkdown('<img src="https://x.test/a.png">'), "![](https://x.test/a.png)");
});

test("lazy-loaded images fall back to their data-src", () => {
  // Many feeds ship a placeholder src plus the real URL in data-src.
  assert.equal(
    htmlToMarkdown('<img src="data:image/gif;base64,R0lGOD" data-src="https://x.test/real.png" alt="r">'),
    "![r](https://x.test/real.png)"
  );
});

test("brackets in alt text are stripped so the syntax stays valid", () => {
  assert.equal(htmlToMarkdown('<img src="https://x.test/a.png" alt="a [b] c">'), "![a b c](https://x.test/a.png)");
});

test("extractImages lists unique images in document order", () => {
  const markdown = "![one](https://x.test/1.png)\n\ntext\n\n![two](https://x.test/2.png)\n\n![dup](https://x.test/1.png)";
  const images = extractImages(markdown);
  assert.equal(images.length, 2, "a repeated URL is listed once");
  assert.equal(images[0].url, "https://x.test/1.png");
  assert.equal(images[0].alt, "one");
  assert.equal(images[1].url, "https://x.test/2.png");
});

test("extractImages tolerates empty and malformed input", () => {
  assert.deepEqual(extractImages(""), []);
  assert.deepEqual(extractImages(null), []);
  assert.deepEqual(extractImages("![unclosed](https://x.test/a.png"), []);
  assert.deepEqual(extractImages("no images here"), []);
});

// ── Void elements (the reason HTML needs its own parsing mode) ──────────────

test("a <br> does not swallow the rest of the document", () => {
  // Without void-element handling everything after <br> nests inside it.
  const markdown = htmlToMarkdown("<p>one<br>two</p><p>three</p>");
  assert.match(markdown, /one/);
  assert.match(markdown, /two/);
  assert.match(markdown, /three/, "the paragraph after the <br> must survive");
});

test("an unclosed <img> keeps the following content in place", () => {
  const markdown = htmlToMarkdown('<p>before<img src="https://x.test/a.png">after</p>');
  assert.match(markdown, /before/);
  assert.match(markdown, /after/);
  assert.match(markdown, /!\[\]\(https:\/\/x\.test\/a\.png\)/);
});

// ── Robustness ──────────────────────────────────────────────────────────────

test("markup in a CDATA wrapper is converted rather than dumped verbatim", () => {
  const markdown = htmlToMarkdown("<![CDATA[<p>Body <b>bold</b></p>]]>");
  assert.match(markdown, /Body \*\*bold\*\*/);
});

test("output is capped so one hostile item cannot blow up the store", () => {
  const huge = `<p>${"x".repeat(MAX_MARKDOWN_CHARS + 5000)}</p>`;
  const markdown = htmlToMarkdown(huge);
  assert.ok(markdown.length <= MAX_MARKDOWN_CHARS, `expected a capped length, got ${markdown.length}`);
});

test("deeply nested markup does not throw", () => {
  let html = "deep";
  for (let i = 0; i < 200; i += 1) html = `<div><span>${html}</span></div>`;
  assert.doesNotThrow(() => htmlToMarkdown(html));
  assert.match(htmlToMarkdown(html), /deep/);
});

test("tidyMarkdown trims trailing spaces and collapses blank runs", () => {
  assert.equal(tidyMarkdown("a   \n\n\n\n b "), "a\n\n b");
  assert.equal(tidyMarkdown("\n\n\n"), "");
});

// ── Feed integration ────────────────────────────────────────────────────────

test("parseFeed projects item bodies to Markdown as well as text", () => {
  const feed = parseFeed(`<rss><channel><title>T</title>
    <item>
      <title>Post</title>
      <link>https://x.test/1</link>
      <description><![CDATA[<p>Intro <strong>bold</strong></p><ul><li>one</li></ul>]]></description>
      <content:encoded xmlns:content="http://purl.org/rss/1.0/modules/content/"><![CDATA[
        <h2>Section</h2><p>See <a href="https://x.test/y">link</a></p>
        <img src="https://x.test/pic.png" alt="pic">
      ]]></content:encoded>
    </item>
  </channel></rss>`);
  const item = feed.items[0];
  // Plain text keeps the old behaviour for the agent digest.
  assert.match(item.content, /Section/);
  // Markdown keeps the structure the reading pane renders.
  assert.match(item.markdown, /## Section/);
  assert.match(item.markdown, /\[link\]\(https:\/\/x\.test\/y\)/);
  assert.match(item.markdown, /!\[pic\]\(https:\/\/x\.test\/pic\.png\)/);
  assert.match(item.summaryMarkdown, /\*\*bold\*\*/);
});

test("an Atom entry's HTML content also becomes Markdown", () => {
  const feed = parseFeed(`<feed xmlns="http://www.w3.org/2005/Atom">
    <title>A</title>
    <entry><title>E</title><id>1</id>
      <content type="html">&lt;h1&gt;Head&lt;/h1&gt;&lt;p&gt;Body&lt;/p&gt;</content>
    </entry>
  </feed>`, { url: "https://a.test/feed" });
  assert.match(feed.items[0].markdown, /# Head/);
  assert.match(feed.items[0].markdown, /Body/);
});

test("an item with no body yields empty Markdown rather than noise", () => {
  const feed = parseFeed("<rss><channel><item><title>Only a title</title></item></channel></rss>");
  assert.equal(feed.items[0].markdown, "");
  assert.equal(feed.items[0].content, "");
});
