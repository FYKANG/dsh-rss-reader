/**
 * dsh-rss-reader — bounded history backfill.
 *
 * A feed is a **window**, not an archive: many blogs publish only the newest few
 * entries and never an older one. 阮一峰's weekly, for one, serves exactly three
 * entries in its `atom.xml`, so no amount of refreshing reaches issue 400 —
 * the data is simply not in the document.
 *
 * The older articles do exist, on the blog's own archive page. This module goes
 * and gets a *bounded* number of them, on request:
 *
 * - it reads an archive page the reader points at and collects the links;
 * - it keeps only links shaped like the ones already subscribed, so a page full
 *   of navigation does not turn into forty junk subscriptions;
 * - it skips what is already stored, so pressing the button twice does not
 *   download anything twice;
 * - it fetches them **one at a time with a gap between requests**, because the
 *   point is to be a good citizen on someone else's server, not to be fast.
 *
 * @module dsh-rss-reader/history
 */

import { htmlToMarkdown } from "./markdown.js";
import { fetchUrl } from "./fetch.js";
import { htmlToText, normalizeDate } from "./feed.js";

/** Longest archive page accepted, in bytes. */
const MAX_ARCHIVE_BYTES = 4 * 1024 * 1024;

/** Longest article page accepted, in bytes. */
const MAX_PAGE_BYTES = 4 * 1024 * 1024;

/** Gap between two article requests, in milliseconds. */
export const HISTORY_DELAY_MS = 300;

/** Hard ceiling on one backfill run, regardless of what the caller asks. */
export const HISTORY_MAX_LIMIT = 50;

/**
 * Collect the candidate article links on a page.
 *
 * Relative hrefs resolve against the page URL, fragments and obvious non-page
 * targets are dropped, and the result is de-duplicated in document order.
 *
 * @param {string} html - the archive page.
 * @param {string} base - the page's own URL, for resolving relative links.
 * @returns {string[]} absolute URLs.
 */
export function extractLinks(html, base) {
  const source = typeof html === "string" ? html : "";
  const out = [];
  const seen = new Set();
  // The `[^<>]` guard on the attribute run matters: a malformed page with an
  // unclosed `<a>` turns the *following* tag into text, and a looser pattern
  // happily reads `href=` out of that text — inventing a link out of markup and
  // losing the real one. The run must not cross a `<` or `>`.
  const pattern = /<a\b[^<>]*?\bhref\s*=\s*(?:"([^"<>]*)"|'([^'<>]*)'|([^\s<>"']+))/gi;
  let match;
  while ((match = pattern.exec(source)) !== null) {
    const raw = (match[1] ?? match[2] ?? match[3] ?? "").trim();
    if (raw.length === 0) continue;
    if (/^(?:#|mailto:|javascript:|data:|tel:)/i.test(raw)) continue;
    let resolved;
    try {
      resolved = new URL(raw, base);
    } catch {
      continue;
    }
    if (resolved.protocol !== "http:" && resolved.protocol !== "https:") continue;
    resolved.hash = "";
    const href = resolved.href;
    if (seen.has(href)) continue;
    seen.add(href);
    out.push(href);
  }
  return out;
}

/**
 * One canonical spelling of a URL, for comparison.
 *
 * Drops the scheme, a trailing slash and the fragment, so `http://x/a/` and
 * `https://x/a#top` are recognised as the same article. **Idempotent**: a value
 * that is already canonical parses as a scheme-less URL and is returned
 * unchanged, which matters because callers normalize before passing a set in
 * and this function normalizes again on the way through.
 *
 * @param {string} value - any URL-ish string.
 * @returns {string} the canonical form, or "" when it is not a URL.
 */
export function canonicalUrl(value) {
  const raw = String(value ?? "").trim();
  if (raw.length === 0) return "";
  for (const candidate of [raw, `https://${raw}`]) {
    try {
      const parsed = new URL(candidate);
      if (parsed.host.length === 0) continue;
      const path = parsed.pathname.replace(/\/+$/, "");
      return `${parsed.host}${path}${parsed.search}`;
    } catch {
      /* try the next interpretation */
    }
  }
  return "";
}

/**
 * The shape of a URL path: its letters and punctuation with digit runs collapsed.
 *
 * `/blog/2026/09/weekly-issue-413.html` becomes `/blog/#/#/weekly-issue-#.html`,
 * so the same shape covers every issue while still excluding a page that merely
 * starts with the same letters.
 *
 * @param {string} pathname - a URL path.
 * @returns {string} the shape.
 */
function shapeKey(pathname) {
  return String(pathname ?? "").replace(/\d+/g, "#");
}

/**
 * The directory part of a path, by shape, plus the file extension.
 *
 * Covers the sites whose article slugs carry no common stem — `/blog/2026/09/`
 * with any `*.html` at the end — without resorting to "anything under the first
 * directory", which would sweep in tag pages and navigation.
 *
 * @param {string} pathname - a URL path.
 * @returns {string} the key, or "" when there is no directory part.
 */
function directoryKey(pathname) {
  const path = String(pathname ?? "");
  const name = path.slice(path.lastIndexOf("/") + 1);
  const dot = name.lastIndexOf(".");
  if (dot <= 0) return "";
  const directory = shapeKey(path.slice(0, path.lastIndexOf("/") + 1));
  return `${directory}\u0000${name.slice(dot).toLowerCase()}`;
}

/**
 * Build a filter that recognises the kind of URL this feed already contains.
 *
 * Derived from the stored items rather than asked of the reader: the archive
 * page mixes articles with monthly indexes, tag pages and navigation, and the
 * already-subscribed URLs say exactly what an article looks like on this site.
 * Two signals are accepted, either of which is enough:
 *
 * - the **whole path shape**, so `/2026/09/weekly-issue-413` recognises
 *   `/2018/04/weekly-issue-1`;
 * - the **directory shape plus file extension**, so `/blog/2026/09/anything`
 *   recognises `/blog/2018/04/something-else` on a site whose slugs carry no
 *   common stem.
 *
 * @param {string[]} sampleLinks - links from the feed's existing items.
 * @returns {(url: string) => boolean} the filter; accepts everything when the
 *   sample is too thin to describe a shape.
 */
export function deriveLinkFilter(sampleLinks) {
  const samples = (Array.isArray(sampleLinks) ? sampleLinks : [])
    .map((link) => {
      try {
        const parsed = new URL(link);
        return { host: parsed.host, path: parsed.pathname };
      } catch {
        return null;
      }
    })
    .filter((entry) => entry !== null);
  if (samples.length === 0) return () => true;
  // The host, not the origin: a site's own links move between http and https,
  // and a feed seeded from `http://…` must still recognise today's `https://…`.
  // One host is assumed — a feed's items come from the site it describes.
  const host = samples[0].host;
  const shapes = new Set(samples.map((entry) => shapeKey(entry.path)));
  const directories = new Set(
    samples.map((entry) => directoryKey(entry.path)).filter((key) => key.length > 0)
  );
  return (url) => {
    try {
      const parsed = new URL(url);
      if (parsed.host !== host) return false;
      if (shapes.has(shapeKey(parsed.pathname))) return true;
      const key = directoryKey(parsed.pathname);
      return key.length > 0 && directories.has(key);
    } catch {
      return false;
    }
  };
}

/**
 * Isolate a page's article HTML.
 *
 * Tries the semantic element first and falls back to the conventional content
 * container, then to the whole document. Converting the whole page would drag
 * the site chrome into the article body, so the ordered attempts matter.
 *
 * @param {string} html - the article page.
 * @returns {string} an HTML fragment to convert.
 */
export function extractArticleHtml(html) {
  const source = typeof html === "string" ? html : "";
  const article = /<article\b[^>]*>([\s\S]*?)<\/article>/i.exec(source);
  if (article !== null && article[1].trim().length > 0) return article[1];

  // A content container: take everything from its opening tag to the matching
  // `</div>`, tracking nesting so an inner div does not end it early.
  for (const pattern of [/<div\b[^>]*\bid\s*=\s*["']?(?:main-content|content|post|entry)["']?[^>]*>/i]) {
    const opening = pattern.exec(source);
    if (opening === null) continue;
    const start = opening.index + opening[0].length;
    const inner = sliceElement(source, opening[0], start);
    if (inner !== null && inner.trim().length > 0) return inner;
  }
  // Nothing identified the article, so the whole page is the only option —
  // minus the parts that would otherwise be rendered as article text.
  return stripChrome(source);
}

/**
 * Remove the page furniture that would read as article text if converted whole.
 *
 * @param {string} html - a full document.
 * @returns {string} the document with chrome elements dropped.
 */
export function stripChrome(html) {
  const element = /<(script|style|nav|header|footer|form|noscript)\b[^>]*>[\s\S]*?<\/\1\s*>/gi;
  return String(html ?? "").replace(element, "");
}

/**
 * The contents of the element whose opening tag is `opening`, up to its close.
 *
 * @param {string} source - the document.
 * @param {string} opening - the opening tag text.
 * @param {number} start - index just past the opening tag.
 * @returns {string | null} the inner HTML, or null when it never closes.
 */
function sliceElement(source, opening, start) {
  const name = /^<([a-zA-Z][a-zA-Z0-9-]*)/.exec(opening)?.[1];
  if (name === undefined) return null;
  const tag = new RegExp(`<${name}\\b[^>]*>|</${name}\\s*>`, "gi");
  tag.lastIndex = start;
  let depth = 1;
  let match;
  while ((match = tag.exec(source)) !== null) {
    if (match[0].startsWith("</")) {
      depth -= 1;
      if (depth === 0) return source.slice(start, match.index);
    } else {
      depth += 1;
    }
  }
  return null;
}

/**
 * The article's own title, without the site's suffix.
 *
 * @param {string} html - the article page.
 * @returns {string} the title, or "" when the page carries none.
 */
export function extractTitle(html) {
  const raw = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(typeof html === "string" ? html : "")?.[1] ?? "";
  const text = htmlToText(raw).trim();
  if (text.length === 0) return "";
  // "Article - Site" / "Article | Site" / "Article – Site" are the common forms.
  const cut = text.split(/\s+[-|–—]\s+/);
  return cut.length > 1 ? cut[0].trim() : text;
}

/**
 * The first prose block of a Markdown body, for the list's summary line.
 *
 * Headings, images and code are skipped: a summary that opens with "## 封面图"
 * tells the reader nothing about the article.
 *
 * @param {string} markdown - the body.
 * @param {number} [maxChars] - cap.
 * @returns {string} the summary.
 */
export function firstProseParagraph(markdown, maxChars = 300) {
  for (const block of String(markdown ?? "").split(/\n{2,}/)) {
    const text = block.trim();
    if (text.length === 0) continue;
    if (/^(#{1,6}\s|```|~~~|>|\||!\[|<)/.test(text)) continue;
    const plain = htmlToText(text.replace(/[*_`]/g, "")).replace(/\s+/g, " ").trim();
    if (plain.length === 0) continue;
    // Byline lines are not a summary of anything.
    if (/^(作者|日期|时间|编辑|来源|发布|作者简介|author|by|date|published)\s*[:：]/i.test(plain)) continue;
    // A one- or two-word fragment (a stray label, a trailing link) carries no
    // information either.
    if (plain.length < 12) continue;
    return plain.length > maxChars ? `${plain.slice(0, maxChars - 1)}…` : plain;
  }
  return "";
}

/**
 * A date for a backfilled article.
 *
 * The page's own declared date wins; a dated URL is the fallback, because an
 * article filed under `/2026/09/` was published in that month and a wrong month
 * is still a better sort key than "now".
 *
 * @param {string} html - the article page.
 * @param {string} url - the article URL.
 * @returns {string} an ISO timestamp, or "" when nothing can be established.
 */
export function inferDate(html, url) {
  const source = typeof html === "string" ? html : "";
  // `<time datetime="...">` is the most explicit signal.
  const time = /<time\b[^>]*\bdatetime\s*=\s*["']([^"']+)["']/i.exec(source)?.[1];
  const fromTime = normalizeDate(time ?? "");
  if (fromTime.length > 0) return fromTime;
  // A visible "日期：2026年9月18日" style line. The text is compacted first
  // because the value is usually wrapped in markup, which htmlToText leaves as
  // whitespace between the year, month and day.
  const compact = htmlToText(source).replace(/\s+/g, "");
  const visible = /(?:日期|时间|发布于|发布时间|date|published)\s*[:：]?\s*(\d{4}[年\-/.]\d{1,2}[月\-/.]\d{1,2}日?)/i.exec(
    compact
  )?.[1];
  const fromVisible = normalizeDate(visible ?? "");
  if (fromVisible.length > 0) return fromVisible;
  // A dated URL, most specific first.
  const day = /[/-](\d{4})[/-](\d{1,2})[/-](\d{1,2})[/-]/.exec(url);
  if (day !== null) {
    const candidate = normalizeDate(`${day[1]}-${day[2]}-${day[3]}`);
    if (candidate.length > 0) return candidate;
  }
  const month = /[/-](\d{4})[/-](\d{1,2})[/-]/.exec(url);
  if (month !== null) {
    const candidate = normalizeDate(`${month[1]}-${month[2]}-01`);
    if (candidate.length > 0) return candidate;
  }
  return "";
}

/**
 * Turn one article page into a stored item.
 *
 * @param {string} html - the page.
 * @param {string} url - its URL.
 * @returns {object} the item, in the shape the feed parser produces.
 */
export function itemFromPage(html, url) {
  const markdown = htmlToMarkdown(extractArticleHtml(html));
  const title = extractTitle(html) || url;
  const summary = firstProseParagraph(markdown);
  return {
    id: url,
    title,
    link: url,
    summary,
    summaryMarkdown: summary,
    content: htmlToText(markdown),
    markdown,
    author: "",
    date: inferDate(html, url),
    categories: [],
    enclosure: "",
    read: false,
    starred: false,
    translation: null
  };
}

/**
 * Fetch a bounded number of older articles from an archive page.
 *
 * Never throws for a single article: a page that fails is reported and the rest
 * proceed, because a partial backfill is still useful and the reader can press
 * the button again. A failure to *read the archive* is fatal, since without it
 * there is nothing to do.
 *
 * @param {object} options - the run's inputs.
 * @param {string} options.archiveUrl - the archive page to read.
 * @param {number} options.limit - how many articles to fetch at most.
 * @param {string[]} [options.sampleLinks] - the feed's existing item links.
 * @param {Set<string>} [options.known] - links already stored.
 * @param {number} [options.timeoutMs] - per-request budget.
 * @param {number} [options.delayMs] - gap between article requests.
 * @param {(done: number, total: number) => void} [options.onProgress] - progress.
 * @returns {Promise<{items: object[], considered: number, skipped: number,
 *   failures: Array<{url: string, error: string}>}>} the outcome.
 * @throws {Error} when the archive page itself cannot be read.
 */
export async function backfillHistory(options) {
  const limit = Math.max(1, Math.min(Math.floor(options.limit) || 20, HISTORY_MAX_LIMIT));
  const delayMs = Number.isFinite(options.delayMs) ? Math.max(0, options.delayMs) : HISTORY_DELAY_MS;
  const timeoutMs = options.timeoutMs;

  const archive = await fetchUrl(options.archiveUrl, { timeoutMs, maxBytes: MAX_ARCHIVE_BYTES });
  if (archive.status >= 400) {
    throw new Error(`读取归档页失败：HTTP ${archive.status}（${options.archiveUrl}）`);
  }
  const all = extractLinks(archive.body, archive.finalUrl || options.archiveUrl);
  const matches = all.filter(deriveLinkFilter(options.sampleLinks ?? []));
  // Compare in one canonical form: a feed seeded over `http://` would otherwise
  // fail to recognise the same article at `https://`, and every backfill would
  // re-download the newest entries the feed already holds instead of reaching
  // the older ones the reader actually asked for.
  const known = new Set(
    [...(options.known ?? [])].map(canonicalUrl).filter((value) => value.length > 0)
  );
  const candidates = matches.filter((url) => !known.has(canonicalUrl(url)));
  const selected = candidates.slice(0, limit);

  const items = [];
  const failures = [];
  for (const [index, url] of selected.entries()) {
    if (index > 0 && delayMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMs));
    try {
      const page = await fetchUrl(url, { timeoutMs, maxBytes: MAX_PAGE_BYTES });
      if (page.status >= 400) throw new Error(`HTTP ${page.status}`);
      const item = itemFromPage(page.body, page.finalUrl || url);
      // A page that yielded no body is not worth storing: it would show up as an
      // empty article and hide the fact that the fetch did not really work.
      if (item.markdown.trim().length === 0) throw new Error("页面没有可读正文");
      items.push(item);
    } catch (error) {
      failures.push({ url, error: error instanceof Error ? error.message : String(error) });
    }
    options.onProgress?.(index + 1, selected.length);
  }

  return { items, considered: matches.length, skipped: matches.length - candidates.length, failures };
}
