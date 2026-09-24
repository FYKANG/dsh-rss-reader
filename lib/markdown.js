/**
 * dsh-rss-reader — HTML to Markdown conversion.
 *
 * Feed bodies arrive as HTML (`content:encoded`, `description`, Atom
 * `type="html"`), but the reader displays Markdown. Converting once on the host
 * side rather than at render time means:
 *
 * - the stored item carries structure (headings, lists, links, code, images)
 *   that a plain-text flattening would have destroyed;
 * - the browser half stays a pure Markdown renderer with no HTML parsing;
 * - the translation call can send Markdown, which models handle far better than
 *   tag soup, and can return Markdown that renders through the same path.
 *
 * The converter walks the parsed tree rather than running regexes over tags, so
 * nesting, entity decoding, and void elements behave correctly. Anything it
 * does not model is flattened to its text, which is always preferable to
 * leaking markup into the reading pane.
 *
 * @module dsh-rss-reader/markdown
 */

import {
  childElements,
  decodeEntities,
  findChild,
  nodeText,
  parseXml
} from "./xml.js";

/** Cap on a generated Markdown document, in characters. */
export const MAX_MARKDOWN_CHARS = 60000;

/** Block elements whose boundaries become blank lines. */
const BLOCK_ELEMENTS = new Set([
  "address", "article", "aside", "blockquote", "details", "div", "dl", "dd", "dt",
  "fieldset", "figcaption", "figure", "footer", "form", "h1", "h2", "h3", "h4",
  "h5", "h6", "header", "hr", "li", "main", "nav", "ol", "p", "pre", "section",
  "summary", "table", "tbody", "tfoot", "thead", "tr", "ul"
]);

/** Tags whose entire subtree is dropped (never display content). */
const DROPPED_ELEMENTS = new Set(["script", "style", "noscript", "template", "svg", "iframe", "object", "embed"]);

/** Inline elements that map to plain text. */
const INLINE_TEXT_ELEMENTS = new Set([
  "a", "abbr", "b", "bdi", "bdo", "cite", "code", "data", "del", "dfn", "em", "i",
  "ins", "kbd", "mark", "q", "s", "samp", "small", "span", "strong", "sub", "sup",
  "time", "u", "var", "wbr"
]);

/** Escape the characters that would otherwise be read as Markdown syntax. */
function escapeText(value) {
  return value.replace(/([\\`*_[\]]|^[#>+-] )/gm, "\\$1");
}

/** Collapse runs of whitespace inside an inline span to single spaces. */
function collapseInline(value) {
  return value.replace(/\s+/g, " ");
}

/** Whether a URL is safe to emit as a link or image target. */
function isSafeUrl(value) {
  const raw = String(value ?? "").trim();
  if (raw.length === 0) return false;
  // Reject anything with a scheme that can execute script.
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(raw)) return /^https?:/i.test(raw);
  // Scheme-relative and relative URLs are safe (resolved against the feed base).
  return true;
}

/** Render a link destination, escaping parentheses that would close it early. */
function linkDestination(url) {
  return url.replace(/[()]/g, (match) => `\\${match}`).replace(/\s+/g, "%20");
}

/** Attributes, in priority order, that may carry an image's real URL. */
const IMAGE_URL_ATTRIBUTES = ["data-src", "data-original", "data-lazy-src", "data-actualsrc", "src"];

/**
 * Choose an image's URL from its attributes.
 *
 * Lazy-loading feeds ship a placeholder in `src` (often a 1×1 `data:` URI or a
 * blank spacer) and the real URL in `data-src`. Reading `src` first would keep
 * the placeholder and throw away the actual picture, so the data-attributes are
 * preferred and a real URL always wins over a placeholder.
 *
 * @param {Record<string, string>} attrs - the `<img>` attributes.
 * @returns {string} the chosen URL, or "" when none is usable.
 */
function pickImageUrl(attrs) {
  let inlineData = "";
  for (const attribute of IMAGE_URL_ATTRIBUTES) {
    const value = String(attrs[attribute] ?? "").trim();
    if (value.length === 0) continue;
    if (/^https?:/i.test(value)) return value;
    if (value.startsWith("//")) return `https:${value}`;
    // A relative URL is resolved against the feed base by the reader's origin.
    if (!/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(value)) return value;
    // Keep a data: URI as a last resort — it is still a real inline image.
    if (inlineData.length === 0 && /^data:image\//i.test(value)) inlineData = value;
  }
  return inlineData;
}

/** Markdown inline code span: pad when the content starts or ends with a backtick. */
function codeSpan(value) {
  const text = value.replace(/\s+/g, " ").trim();
  if (text.length === 0) return "";
  // Choose a fence longer than any backtick run inside the content.
  let fence = "`";
  while (text.includes(fence)) fence += "`";
  const pad = text.startsWith("`") || text.endsWith("`") ? " " : "";
  return `${fence}${pad}${text}${pad}${fence}`;
}

/**
 * Convert one HTML element into Markdown.
 *
 * @param {object} node - element node from {@link parseXml}.
 * @param {object} state - `{ listDepth, orderedStack }` for list context.
 * @returns {string} Markdown fragment.
 */
function renderElement(node, state) {
  const name = node.name.includes(":") ? node.name.slice(node.name.indexOf(":") + 1) : node.name;
  if (DROPPED_ELEMENTS.has(name)) return "";
  if (name === "#cdata") return renderChildren(node, state);

  // ── leaf replacements ─────────────────────────────────────────────────
  if (name === "br") return "\n";
  if (name === "hr") return "\n\n---\n\n";
  if (name === "img") {
    const src = pickImageUrl(node.attrs ?? {});
    if (src.length === 0) return "";
    const alt = collapseInline(String(node.attrs?.alt ?? "")).trim();
    return `\n\n![${alt.replace(/[[\]]/g, "")}](${linkDestination(src)})\n\n`;
  }

  // ── headings ──────────────────────────────────────────────────────────
  if (/^h[1-6]$/.test(name)) {
    const level = Number(name[1]);
    const text = collapseInline(renderChildren(node, state)).trim();
    if (text.length === 0) return "";
    return `\n\n${"#".repeat(level)} ${text}\n\n`;
  }

  // ── code ──────────────────────────────────────────────────────────────
  if (name === "pre") {
    // <pre><code class="language-x">…</code></pre> becomes a fenced block.
    const codeNode = childElements(node).find((child) => child.name === "code");
    const body = codeNode === undefined ? nodeText(node) : nodeText(codeNode);
    const className = String(codeNode?.attrs?.class ?? node.attrs?.class ?? "");
    const language = (/language-([\w+#-]+)/i.exec(className)?.[1] ?? "").toLowerCase();
    const text = body.replace(/^\n+|\n+$/g, "").replace(/\n{3,}/g, "\n\n");
    if (text.trim().length === 0) return "";
    // A fence longer than any backtick run in the body keeps the block intact.
    let fence = "```";
    while (text.includes(fence)) fence += "`";
    return `\n\n${fence}${language}\n${text}\n${fence}\n\n`;
  }
  if (name === "code") return codeSpan(nodeText(node));

  // ── emphasis ──────────────────────────────────────────────────────────
  if (name === "strong" || name === "b") {
    const text = collapseInline(renderChildren(node, state)).trim();
    return text.length === 0 ? "" : `**${text}**`;
  }
  if (name === "em" || name === "i") {
    const text = collapseInline(renderChildren(node, state)).trim();
    return text.length === 0 ? "" : `*${text}*`;
  }
  if (name === "del" || name === "s" || name === "strike") {
    const text = collapseInline(renderChildren(node, state)).trim();
    return text.length === 0 ? "" : `~~${text}~~`;
  }

  // ── links ─────────────────────────────────────────────────────────────
  if (name === "a") {
    const text = collapseInline(renderChildren(node, state)).trim();
    const href = String(node.attrs?.href ?? "").trim();
    if (href.length === 0 || !isSafeUrl(href)) return text;
    // A bare-URL link renders as an autolink, which reads better.
    if (text.length === 0) return `<${href}>`;
    if (text === href) return `<${href}>`;
    return `[${text}](${linkDestination(href)})`;
  }

  // ── lists ─────────────────────────────────────────────────────────────
  if (name === "ul" || name === "ol") {
    const ordered = name === "ol";
    const start = Number.parseInt(String(node.attrs?.start ?? "1"), 10);
    const items = childElements(node).filter((child) => child.name === "li");
    const lines = [];
    items.forEach((item, index) => {
      const body = renderListItem(item, state, ordered ? (Number.isFinite(start) ? start : 1) + index : undefined);
      if (body.length > 0) lines.push(body);
    });
    if (lines.length === 0) return "";
    return `\n\n${lines.join("\n")}\n\n`;
  }

  // ── blockquote ────────────────────────────────────────────────────────
  if (name === "blockquote") {
    const body = renderChildren(node, state).replace(/^\n+|\n+$/g, "");
    if (body.trim().length === 0) return "";
    const quoted = body
      .split("\n")
      .map((line) => (line.trim().length === 0 ? ">" : `> ${line}`))
      .join("\n");
    return `\n\n${quoted}\n\n`;
  }

  // ── tables: keep the cell structure, one row per line ─────────────────
  if (name === "table") {
    return renderTable(node, state);
  }
  if (name === "td" || name === "th") {
    return collapseInline(renderChildren(node, state)).trim();
  }
  if (name === "tr" || name === "thead" || name === "tbody" || name === "tfoot") {
    const cells = childElements(node)
      .filter((child) => child.name === "tr" || child.name === "td" || child.name === "th")
      .map((child) => renderElement(child, state).trim())
      .filter((cell) => cell.length > 0);
    return cells.length === 0 ? "" : `\n${cells.join(" | ")}\n`;
  }

  // ── generic blocks ────────────────────────────────────────────────────
  if (BLOCK_ELEMENTS.has(name)) {
    const body = renderChildren(node, state).replace(/^\n+|\n+$/g, "");
    return body.trim().length === 0 ? "" : `\n\n${body}\n\n`;
  }

  // Unknown or inline: keep the text, drop the tag.
  if (INLINE_TEXT_ELEMENTS.has(name) || name.length > 0) return renderChildren(node, state);
  return "";
}

/** Render one `<li>`, including a nested list when present. */
function renderListItem(item, state, orderedNumber) {
  const marker = orderedNumber === undefined ? "-" : `${orderedNumber}.`;
  // Separate nested lists from the item's own inline content.
  const parts = { inline: "", nested: "" };
  const nestedState = { ...state, listDepth: (state.listDepth ?? 0) + 1 };
  for (const child of childElements(item)) {
    if (child.name === "ul" || child.name === "ol") {
      parts.nested += renderElement(child, nestedState).trim();
      continue;
    }
    parts.inline += renderElement(child, state);
  }
  // Text nodes are rendered by renderChildren; walk again for the inline parts.
  const text = collapseInline(
    parts.inline.length > 0 ? parts.inline : renderChildren(item, state)
  ).trim();
  const indent = "  ".repeat(state.listDepth ?? 0);
  const head = `${indent}${marker} ${text}`.trimEnd();
  if (parts.nested.length === 0) return head;
  // Nested items are indented one level deeper.
  return `${head}\n${parts.nested}`;
}

/** Render a `<table>` as pipe rows, using the first row as the header. */
function renderTable(node, state) {
  const rows = [];
  const collect = (element) => {
    for (const child of childElements(element)) {
      if (child.name === "tr") {
        const cells = childElements(child)
          .filter((cell) => cell.name === "td" || cell.name === "th")
          .map((cell) => collapseInline(renderChildren(cell, state)).replace(/\|/g, "\\|").trim());
        if (cells.length > 0) rows.push(cells);
        continue;
      }
      if (child.name === "thead" || child.name === "tbody" || child.name === "tfoot") collect(child);
    }
  };
  collect(node);
  if (rows.length === 0) return "";
  const width = Math.max(...rows.map((row) => row.length));
  const pad = (row) => [...row, ...Array(width - row.length).fill("")];
  const lines = [
    `| ${pad(rows[0]).join(" | ")} |`,
    `| ${Array(width).fill("---").join(" | ")} |`,
    ...rows.slice(1).map((row) => `| ${pad(row).join(" | ")} |`)
  ];
  return `\n\n${lines.join("\n")}\n\n`;
}

/** Render an element's children, passing text through. */
function renderChildren(node, state) {
  const out = [];
  for (const child of node.children ?? []) {
    if (typeof child === "string") out.push(escapeText(child));
    else out.push(renderElement(child, state));
  }
  return out.join("");
}

/** Whether the input looks like HTML rather than already-plain text. */
function looksLikeHtml(input) {
  return /<(?:[a-zA-Z][a-zA-Z0-9-]*|\/[a-zA-Z])[^>]*>/.test(input);
}

/**
 * Tidy the generated Markdown: normalize newlines, collapse excess blank lines,
 * and trim trailing spaces on each line.
 *
 * @param {string} markdown - raw Markdown.
 * @returns {string} cleaned Markdown.
 */
export function tidyMarkdown(markdown) {
  return String(markdown ?? "")
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((line) => line.replace(/[ \t]+$/, ""))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/^\n+|\n+$/g, "")
    .trim();
}

/**
 * Convert an HTML fragment (or plain text) into Markdown.
 *
 * Plain text is returned with only whitespace normalized, so already-textual
 * feed fields are not escaped into noise.
 *
 * @param {string} input - HTML fragment or plain text.
 * @param {object} [options] - conversion options.
 * @param {number} [options.maxChars] - output cap.
 * @returns {string} Markdown.
 */
export function htmlToMarkdown(input, options = {}) {
  if (typeof input !== "string" || input.length === 0) return "";
  let source = input;
  // Unwrap a CDATA wrapper that survived as literal text.
  source = source.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1");
  if (!looksLikeHtml(source)) {
    return tidyMarkdown(source.replace(/\r\n?/g, "\n"));
  }

  const { root } = parseXml(source, { voidElements: true });
  const state = { listDepth: 0 };
  // Render every top-level node so a fragment with several roots is kept whole.
  const body = (root.children ?? [])
    .map((child) => (typeof child === "string" ? escapeText(child) : renderElement(child, state)))
    .join("");
  const markdown = tidyMarkdown(body);
  const max = options.maxChars ?? MAX_MARKDOWN_CHARS;
  return markdown.length > max ? `${markdown.slice(0, max - 1).trimEnd()}\u2026` : markdown;
}

/**
 * Extract the image URLs referenced by a Markdown document.
 *
 * The reader uses this to show an image count next to the collapsed group
 * without having to re-parse at render time.
 *
 * @param {string} markdown - Markdown text.
 * @returns {Array<{url: string, alt: string}>} images in document order.
 */
export function extractImages(markdown) {
  if (typeof markdown !== "string" || markdown.length === 0) return [];
  const out = [];
  const seen = new Set();
  const pattern = /!\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g;
  let match;
  while ((match = pattern.exec(markdown)) !== null) {
    const url = match[2].replace(/\\([()])/g, "$1");
    if (url.length === 0 || seen.has(url)) continue;
    seen.add(url);
    out.push({ alt: decodeEntities(match[1]).trim(), url });
  }
  return out;
}
