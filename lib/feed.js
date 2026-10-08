/**
 * dsh-rss-reader — feed document parsing.
 *
 * Normalizes the three formats found in the wild into one shape:
 *
 * - **RSS 2.0** (`<rss><channel><item>`)
 * - **RSS 1.0 / RDF** (`<rdf:RDF><channel>` + `<item>` siblings)
 * - **Atom 1.0** (`<feed><entry>`)
 *
 * Format detection is structural rather than declaration-based, so a feed
 * served with the wrong content type still parses. Everything here is a pure
 * function over text: no network, no filesystem, so it is trivially testable.
 *
 * @module dsh-rss-reader/feed
 */

import {
  attr,
  childText,
  childElements,
  decodeEntities,
  findChild,
  findChildren,
  findDescendant,
  localName,
  nodeText,
  parseXml
} from "./xml.js";
import { htmlToMarkdown } from "./markdown.js";

/** Cap on retained items per feed, keeping the newest. */
export const MAX_ITEMS_PER_FEED = 200;

/** Cap on a retained summary's length, in characters. */
const MAX_SUMMARY_CHARS = 1200;

/** Cap on a retained content body's length, in characters. */
const MAX_CONTENT_CHARS = 20000;

/**
 * Strip markup from an HTML fragment, keeping readable text.
 *
 * Feed summaries routinely contain escaped HTML (`&lt;p&gt;`), a CDATA HTML
 * block, or raw markup. Naive tag-stripping is correct enough for a preview
 * and avoids injecting third-party markup into the DSH page.
 *
 * @param {string} input - raw fragment.
 * @returns {string} plain text, whitespace-collapsed.
 */
export function htmlToText(input) {
  if (typeof input !== "string" || input.length === 0) return "";
  let text = input;
  // Unwrap a CDATA wrapper that survived as literal text.
  text = text.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1");
  // Drop script/style bodies entirely; their text is never preview content.
  text = text.replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, " ");
  // Block-level boundaries become spaces so words do not run together.
  text = text.replace(/<\/?(p|div|br|li|ul|ol|tr|td|th|h[1-6]|blockquote|section|article)\b[^>]*>/gi, " ");
  // Remaining tags.
  text = text.replace(/<[^>]*>/g, "");
  text = decodeEntities(text);
  return text.replace(/\s+/g, " ").trim();
}

/**
 * Resolve a possibly-relative URL against a base.
 * @param {string} value - candidate URL.
 * @param {string | undefined} base - absolute base URL.
 * @returns {string} an absolute URL, or the original value when unresolvable.
 */
export function resolveUrl(value, base) {
  const raw = typeof value === "string" ? value.trim() : "";
  if (raw.length === 0) return "";
  if (base === undefined || base.length === 0) return raw;
  try {
    return new URL(raw, base).href;
  } catch {
    return raw;
  }
}

/** Clamp a string to `limit` characters, appending an ellipsis when cut. */
function clamp(value, limit) {
  if (typeof value !== "string") return "";
  const text = value.trim();
  if (text.length <= limit) return text;
  return `${text.slice(0, limit - 1).trimEnd()}\u2026`;
}

/** Normalize a date string to an ISO-8601 instant, or "" when unusable. */
export function normalizeDate(value) {
  const raw = typeof value === "string" ? value.trim() : "";
  if (raw.length === 0) return "";
  const parsed = new Date(rewriteDate(raw));
  if (Number.isNaN(parsed.getTime())) return "";
  // Reject absurd values that some feeds carry (epoch 0, far-future typos).
  const year = parsed.getUTCFullYear();
  if (year < 1990 || year > 2200) return "";
  return parsed.toISOString();
}

/**
 * Rewrite the date spellings `new Date` cannot read into ones it can.
 *
 * Deliberately narrow. The platform parser already handles RFC-822, ISO with an
 * offset (`2024-05-01T10:00:00+08:00`) and everything else standard — rewriting
 * those would *lose* information, because a rebuilt string with no zone is read
 * as local time. Only two shapes need help:
 *
 * - `2026年9月18日`, ordinary on a Chinese site but `Invalid Date` to the
 *   platform parser, so such an item lost its date entirely and sorted as if it
 *   were undated. The day may also arrive split from the month, which is how
 *   markup wrapping the day in its own element renders as text.
 * - `2024-05-01 10:00:00`, which the platform parser reads as *local* time
 *   while a feed means UTC.
 *
 * @param {string} raw - a trimmed date string.
 * @returns {string} a string `new Date` can parse.
 */
function rewriteDate(raw) {
  const cn = /^(\d{4})\s*年\s*(\d{1,2})\s*月\s*(?:(\d{1,2})\s*日?)?/.exec(raw);
  if (cn !== null) {
    const [, year, month, day] = cn;
    // A month-only date becomes the first of that month: the honest guess, and
    // it still keeps the article in the right month for sorting.
    return `${year}-${month.padStart(2, "0")}-${(day ?? "01").padStart(2, "0")}`;
  }
  // Anything carrying its own zone is left alone: the platform parser is right
  // about it and a rebuilt string would silently change the instant.
  if (/(?:Z|[+-]\d{2}:?\d{2}|\bGMT\b|\bUTC\b)\s*$/i.test(raw)) return raw;
  const spaced = /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})[T\s]+(\d{1,2}):(\d{2})(?::(\d{2}))?/.exec(raw);
  if (spaced !== null) {
    const [, year, month, day, hour, minute, second] = spaced;
    return `${year}-${month.padStart(2, "0")}-${day.padStart(2, "0")}T${hour.padStart(2, "0")}:${minute}:${second ?? "00"}`;
  }
  return raw;
}

/**
 * Pick the best link for an Atom entry, preferring `rel="alternate"` and
 * falling back to any link with an href.
 * @param {object} node - `<entry>` element.
 * @returns {string} the href, or "".
 */
function atomLink(node) {
  const links = findChildren(node, "link");
  let fallback = "";
  for (const link of links) {
    const href = attr(link, "href") ?? nodeText(link);
    if (typeof href !== "string" || href.trim().length === 0) continue;
    const rel = (attr(link, "rel") ?? "alternate").toLowerCase();
    if (rel === "alternate") return href.trim();
    if (fallback.length === 0 && rel !== "self" && rel !== "edit") fallback = href.trim();
  }
  return fallback;
}

/** Read the first `<link>`-ish value from an RSS item/channel. */
function rssLink(node) {
  const direct = childText(node, "link");
  if (direct.length > 0) return direct;
  // RSS 1.0 puts the URL in the element's rdf:resource attribute.
  for (const link of findChildren(node, "link")) {
    const resource = attr(link, "resource") ?? attr(link, "href");
    if (typeof resource === "string" && resource.trim().length > 0) return resource.trim();
  }
  // Some feeds emit <guid isPermaLink="true"> as the only URL.
  const guid = findChild(node, "guid", "id");
  if (guid !== undefined) {
    const permalink = attr(guid, "ispermalink");
    const value = nodeText(guid);
    if (permalink !== "false" && /^https?:\/\//i.test(value)) return value;
  }
  return "";
}

/** Read the richest available body from an item. */
function readContent(node) {
  const encoded = findChild(node, "encoded", "content:encoded");
  if (encoded !== undefined) {
    const text = nodeText(encoded);
    if (text.length > 0) return describeBody(text);
  }
  const content = findChild(node, "content");
  if (content !== undefined) {
    // Atom <content type="xhtml"> nests real markup; type="html" is escaped.
    const text = nodeText(content);
    if (text.length > 0) return describeBody(text);
  }
  const body = findChild(node, "body");
  if (body !== undefined) {
    const text = nodeText(body);
    if (text.length > 0) return describeBody(text);
  }
  return { value: "", markdown: "", raw: "" };
}

/**
 * Describe a body as both plain text and Markdown.
 *
 * The Markdown is what the reading pane renders (it keeps headings, lists,
 * links, code and images); the plain text is what the agent digest and the
 * translation prompt use, since models handle clean prose best.
 *
 * @param {string} html - decoded HTML fragment.
 * @returns {{value: string, markdown: string, raw: string}} the projections.
 */
function describeBody(html) {
  return {
    value: htmlToText(html),
    markdown: htmlToMarkdown(html, { maxChars: MAX_CONTENT_CHARS }),
    raw: html
  };
}

/** Read the best available summary/description. */
function readSummary(node) {
  for (const name of ["summary", "description", "excerpt", "subtitle"]) {
    const found = findChild(node, name);
    if (found === undefined) continue;
    const raw = nodeText(found);
    if (raw.length > 0) return { value: htmlToText(raw), markdown: htmlToMarkdown(raw, { maxChars: MAX_SUMMARY_CHARS }), raw };
  }
  return { value: "", markdown: "", raw: "" };
}

/** First non-empty value among the named children. */
function firstOf(node, names) {
  for (const name of names) {
    const value = childText(node, name);
    if (value.length > 0) return value;
  }
  return "";
}

/** Read an item's publication date, trying the common vocabulary. */
function readDate(node) {
  for (const name of ["pubdate", "published", "date", "updated", "issued", "created", "modified", "dc:date"]) {
    const value = childText(node, name);
    const normalized = normalizeDate(value);
    if (normalized.length > 0) return normalized;
  }
  // Atom <published>/<updated> may carry the value in a nested element.
  const updated = findDescendant(node, "updated");
  if (updated !== undefined) {
    const normalized = normalizeDate(nodeText(updated));
    if (normalized.length > 0) return normalized;
  }
  return "";
}

/** Normalize an author from RSS `<author>`, `dc:creator`, or Atom `<author>`. */
function readAuthor(node) {
  const direct = firstOf(node, ["author", "creator", "dc:creator"]);
  if (direct.length > 0) {
    // RSS <author> is often "email (Name)".
    const paren = /\(([^)]+)\)\s*$/.exec(direct);
    if (paren !== null && paren[1].trim().length > 0) return paren[1].trim();
    return direct;
  }
  const author = findChild(node, "author");
  if (author !== undefined) {
    const name = childText(author, "name");
    if (name.length > 0) return name;
    const text = nodeText(author);
    if (text.length > 0) return text;
  }
  return "";
}

/** Read the first category/tag label. */
function readCategories(node) {
  const seen = new Set();
  const out = [];
  for (const category of findChildren(node, "category", "tag", "subject")) {
    let label = attr(category, "term") ?? attr(category, "label") ?? nodeText(category);
    if (typeof label !== "string") continue;
    label = htmlToText(label);
    if (label.length === 0 || label.length > 60 || seen.has(label)) continue;
    seen.add(label);
    out.push(label);
    if (out.length >= 5) break;
  }
  return out;
}

/** Read an explicit enclosure/media URL. */
function readEnclosure(node) {
  for (const link of findChildren(node, "enclosure", "content")) {
    const url = attr(link, "url") ?? attr(link, "href");
    if (typeof url === "string" && /^https?:\/\//i.test(url)) return url.trim();
  }
  return "";
}

/**
 * Whether the item carries any usable identity at all.
 *
 * Judged on the *extracted* title/link, before any placeholder is substituted,
 * so an entry with only a description is discarded rather than stored as
 * "(untitled)".
 *
 * @param {string} title - raw extracted title.
 * @param {string} link - raw extracted link.
 * @returns {boolean} true when the item is worth keeping.
 */
function isUsableItem(title, link) {
  return title.length > 0 || link.length > 0;
}

/**
 * Build one normalized item from a source element.
 * @param {object} node - `<item>` or `<entry>`.
 * @param {string | undefined} base - URL used to resolve relative links.
 * @param {string} fallbackDate - feed-level date when the item has none.
 * @returns {object | null} normalized item, or null when it has no identity.
 */
function normalizeItem(node, base, fallbackDate) {
  const guid = firstOf(node, ["guid", "id", "identifier", "atom:id"]);
  const link = resolveUrl(atomLink(node) || rssLink(node), base);
  const rawTitle = htmlToText(firstOf(node, ["title", "name"]));
  if (!isUsableItem(rawTitle, link)) return null;

  const title = clamp(rawTitle, 400);
  const content = readContent(node);
  const summary = readSummary(node);
  const author = clamp(readAuthor(node), 120);
  const date = readDate(node) || fallbackDate;
  // The summary is the preview; fall back to the content body, then nothing.
  const preview = clamp(summary.value || content.value, MAX_SUMMARY_CHARS);
  const id = guid.length > 0 ? guid : link || `${title}|${date}`;

  return {
    id: clamp(id, 500),
    title: title.length > 0 ? title : "(untitled)",
    link,
    summary: preview,
    /** Markdown projection of the summary, rendered in list previews. */
    summaryMarkdown: clamp(summary.markdown || content.markdown, MAX_SUMMARY_CHARS),
    content: clamp(content.value, MAX_CONTENT_CHARS),
    /** Markdown projection of the body, rendered in the reading pane. */
    markdown: clamp(content.markdown, MAX_CONTENT_CHARS),
    author,
    date,
    categories: readCategories(node),
    enclosure: readEnclosure(node)
  };
}

/**
 * Extract the feed's own metadata.
 * @param {object} channel - `<channel>` (RSS) or `<feed>` (Atom) element.
 * @param {string | undefined} base - host URL for relative resolution.
 * @returns {object} feed-level fields.
 */
function normalizeFeedMeta(channel, base) {
  const title = clamp(htmlToText(childText(channel, "title")), 300);
  const description = clamp(htmlToText(firstOf(channel, ["description", "subtitle", "tagline"])), 600);
  const link = resolveUrl(rssLink(channel) || atomLink(channel), base);
  const language = clamp(firstOf(channel, ["language", "lang"]), 40) || (attr(channel, "lang") ?? "");
  const image = findChild(channel, "image", "logo", "icon");
  let imageUrl = "";
  if (image !== undefined) {
    imageUrl = resolveUrl(attr(image, "url") ?? attr(image, "href") ?? nodeText(image), base);
  }
  const date = normalizeDate(firstOf(channel, ["lastbuilddate", "updated", "pubdate", "date", "modified"]));
  return {
    title: title.length > 0 ? title : "",
    description,
    link,
    language,
    image: imageUrl,
    updated: date
  };
}

/**
 * Detect which of the three supported shapes the document has.
 * @param {object} root - document root.
 * @returns {"rss" | "rdf" | "atom" | "unknown"} the format.
 */
function detectFormat(root) {
  // The outermost element usually names the format outright.
  const container = childElements(root)[0];
  if (container !== undefined) {
    const local = localName(container.name);
    if (local === "rdf") return "rdf";
    if (local === "rss") return "rss";
    if (local === "feed") return "atom";
    if (local === "channel") return "rss";
  }
  // Otherwise look for the characteristic element anywhere in the tree.
  if (findDescendant(root, "feed") !== undefined) return "atom";
  if (findDescendant(root, "channel") !== undefined) return "rss";
  return "unknown";
}

/**
 * Parse a feed document into normalized feed metadata plus items.
 *
 * Throws only when the text is not a recognizable feed at all, so the caller
 * can report a precise error instead of silently returning nothing.
 *
 * @param {string} source - feed document text.
 * @param {{url?: string}} [options] - source URL, used to resolve relative links.
 * @returns {{format: string, title: string, description: string, link: string,
 *   language: string, image: string, updated: string, items: Array<object>}}
 * @throws {Error} when the document contains no recognizable feed element.
 */
export function parseFeed(source, options = {}) {
  const base = typeof options.url === "string" && options.url.length > 0 ? options.url : undefined;
  const { root } = parseXml(source);
  const format = detectFormat(root);

  let channel;
  let itemNodes;
  // The outermost element is the format container (`<rss>`, `<rdf:RDF>`,
  // `<feed>`) — or, for a bare fragment, the channel itself.
  const container = childElements(root)[0];
  if (format === "atom") {
    channel = findDescendant(root, "feed");
    itemNodes = channel === undefined ? [] : findChildren(channel, "entry");
  } else if (format === "rdf") {
    // RDF keeps <channel> and <item> as siblings under <rdf:RDF>.
    const scope = container !== undefined && localName(container.name) === "rdf"
      ? container
      : root;
    channel = findDescendant(root, "channel");
    itemNodes = findChildren(scope, "item");
    if (itemNodes.length === 0 && channel !== undefined) itemNodes = findChildren(channel, "item");
  } else if (format === "rss") {
    const rss = container !== undefined && localName(container.name) === "rss"
      ? container
      : findDescendant(root, "rss");
    channel = findDescendant(root, "channel") ?? rss ?? root;
    itemNodes = findChildren(channel, "item", "entry");
    if (itemNodes.length === 0 && rss !== undefined && rss !== channel) {
      itemNodes = findChildren(rss, "item", "entry");
    }
  } else {
    throw new Error("no feed structure found (expected an RSS <channel>, RDF <channel>, or Atom <feed> element)");
  }

  if (channel === undefined && itemNodes.length === 0) {
    throw new Error("no feed structure found (expected an RSS <channel>, RDF <channel>, or Atom <feed> element)");
  }

  const meta = channel === undefined
    ? { title: "", description: "", link: "", language: "", image: "", updated: "" }
    : normalizeFeedMeta(channel, base);

  const items = itemNodes
    .map((node) => normalizeItem(node, base, meta.updated))
    .filter((item) => item !== null);

  // Newest first; undated items keep their document order at the end.
  items.sort((a, b) => {
    if (a.date.length === 0 && b.date.length === 0) return 0;
    if (a.date.length === 0) return 1;
    if (b.date.length === 0) return -1;
    return b.date.localeCompare(a.date);
  });

  // One document may list the same entry twice — a story re-published under
  // the guid it already had (openai.com/blog/rss.xml does exactly that). Both
  // copies would be stored, and the reader would show one story as two rows
  // whose read state can only ever apply to the first: the second stays unread
  // for good and the unread count includes it twice. Identity is the guid, so
  // the later copy is the duplicate. Deduplicated after the sort, so the kept
  // copy is the newest one the feed published.
  const seen = new Set();
  const unique = [];
  for (const item of items) {
    if (seen.has(item.id)) continue;
    seen.add(item.id);
    unique.push(item);
  }

  return {
    format,
    title: meta.title,
    description: meta.description,
    link: meta.link,
    language: meta.language,
    image: meta.image,
    updated: meta.updated,
    items: unique.slice(0, MAX_ITEMS_PER_FEED)
  };
}

/**
 * Extract feed URLs advertised by an HTML document's `<link rel="alternate">`
 * tags, so a user can paste a site URL instead of hunting for the feed path.
 *
 * @param {string} html - HTML document text.
 * @param {string | undefined} base - URL the document was fetched from.
 * @returns {Array<{url: string, title: string, type: string}>} discovered feeds.
 */
export function discoverFeeds(html, base) {
  if (typeof html !== "string" || html.length === 0) return [];
  const out = [];
  const seen = new Set();
  const pattern = /<link\b[^>]*>/gi;
  let match;
  while ((match = pattern.exec(html)) !== null) {
    const tag = match[0];
    const rel = /\brel\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i.exec(tag);
    const relValue = (rel?.[1] ?? rel?.[2] ?? rel?.[3] ?? "").toLowerCase();
    if (!relValue.split(/\s+/).includes("alternate")) continue;
    const typeMatch = /\btype\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i.exec(tag);
    const typeValue = (typeMatch?.[1] ?? typeMatch?.[2] ?? typeMatch?.[3] ?? "").toLowerCase();
    if (typeValue.length > 0 && !typeValue.includes("rss") && !typeValue.includes("atom") && !typeValue.includes("xml")) continue;
    const hrefMatch = /\bhref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i.exec(tag);
    const href = (hrefMatch?.[1] ?? hrefMatch?.[2] ?? hrefMatch?.[3] ?? "").trim();
    if (href.length === 0) continue;
    const url = resolveUrl(decodeEntities(href), base);
    if (url.length === 0 || seen.has(url)) continue;
    seen.add(url);
    const titleMatch = /\btitle\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i.exec(tag);
    out.push({
      url,
      title: decodeEntities((titleMatch?.[1] ?? titleMatch?.[2] ?? titleMatch?.[3] ?? "").trim()),
      type: typeValue
    });
  }
  return out;
}

/**
 * Guess a feed's advertised title from a URL, used when a fetch fails before
 * the document can be read.
 * @param {string} url - feed URL.
 * @returns {string} a human-readable label.
 */
export function labelFromUrl(url) {
  try {
    const parsed = new URL(url);
    return parsed.hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}
