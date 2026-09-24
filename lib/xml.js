/**
 * dsh-rss-reader — a small, dependency-free, fault-tolerant XML reader.
 *
 * Feed documents in the wild are frequently malformed: unescaped `&`,
 * mismatched or unclosed tags, stray HTML entities, HTML served under an XML
 * content type. A strict parser rejects all of that, so this module is a
 * forgiving scanner that always yields a usable tree:
 *
 * - unclosed elements are closed implicitly at EOF;
 * - a stray end tag closes the nearest matching ancestor (or is ignored);
 * - `>` inside a quoted attribute value does not end the tag;
 * - comments, processing instructions and DOCTYPE (including an internal
 *   subset) are skipped;
 * - CDATA is preserved verbatim, so markup inside it survives.
 *
 * The tree is deliberately minimal — `{name, attrs, children}` where a child
 * is either a node or a string — which is all feed extraction needs.
 *
 * @module dsh-rss-reader/xml
 */

/** Named character references seen in feeds, on top of the five XML ones. */
const NAMED_ENTITIES = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: "\u00a0",
  ensp: "\u2002",
  emsp: "\u2003",
  thinsp: "\u2009",
  shy: "\u00ad",
  laquo: "\u00ab",
  raquo: "\u00bb",
  lsquo: "\u2018",
  rsquo: "\u2019",
  ldquo: "\u201c",
  rdquo: "\u201d",
  ndash: "\u2013",
  mdash: "\u2014",
  hellip: "\u2026",
  bull: "\u2022",
  middot: "\u00b7",
  times: "\u00d7",
  divide: "\u00f7",
  deg: "\u00b0",
  plusmn: "\u00b1",
  frac12: "\u00bd",
  sup2: "\u00b2",
  sup3: "\u00b3",
  micro: "\u00b5",
  para: "\u00b6",
  sect: "\u00a7",
  copy: "\u00a9",
  reg: "\u00ae",
  trade: "\u2122",
  euro: "\u20ac",
  pound: "\u00a3",
  yen: "\u00a5",
  cent: "\u00a2",
  larr: "\u2190",
  uarr: "\u2191",
  rarr: "\u2192",
  darr: "\u2193",
  harr: "\u2194",
  infin: "\u221e",
  ne: "\u2260",
  le: "\u2264",
  ge: "\u2265",
  spades: "\u2660",
  clubs: "\u2663",
  hearts: "\u2665",
  diams: "\u2666"
};

/**
 * Decode XML/HTML character references.
 *
 * Unknown or malformed references are returned unchanged rather than dropped,
 * so text never loses content to a stray `&` — a very common feed defect.
 *
 * @param {string} input - raw text possibly containing references.
 * @returns {string} decoded text.
 */
export function decodeEntities(input) {
  if (typeof input !== "string" || input.indexOf("&") < 0) return input ?? "";
  return input.replace(/&(#[0-9]+|#[xX][0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]*);?/g, (match, body) => {
    if (body.charCodeAt(0) === 35 /* # */) {
      const hex = body[1] === "x" || body[1] === "X";
      const digits = hex ? body.slice(2) : body.slice(1);
      if (digits.length === 0) return match;
      const code = Number.parseInt(digits, hex ? 16 : 10);
      if (!Number.isFinite(code) || code < 0 || code > 0x10ffff) return match;
      // Control characters other than tab/newline/CR are not valid in XML text
      // and would only corrupt the rendered output.
      if (code < 0x20 && code !== 0x09 && code !== 0x0a && code !== 0x0d) return "";
      try {
        return String.fromCodePoint(code);
      } catch {
        return match;
      }
    }
    const hit = NAMED_ENTITIES[body] ?? NAMED_ENTITIES[body.toLowerCase()];
    return hit === undefined ? match : hit;
  });
}

/**
 * Strip any namespace prefix from an element/attribute name.
 * @param {string} name - possibly prefixed name (`dc:date`).
 * @returns {string} the local part, lower-cased (`date`).
 */
export function localName(name) {
  if (typeof name !== "string") return "";
  const colon = name.indexOf(":");
  return (colon < 0 ? name : name.slice(colon + 1)).toLowerCase();
}

/**
 * HTML void elements: tags that never have children and, in HTML, are written
 * without a closing tag. Without this set a parser would nest everything that
 * follows a `<br>` or `<img>` inside it, destroying the document structure.
 */
export const VOID_ELEMENTS = new Set([
  "area", "base", "br", "col", "embed", "hr", "img", "input",
  "link", "meta", "param", "source", "track", "wbr"
]);

/**
 * Index of the `>` closing the tag opened at `start`, ignoring quoted spans.
 */
function findTagEnd(source, start) {
  let quote = null;
  for (let i = start + 1; i < source.length; i += 1) {
    const ch = source[i];
    if (quote !== null) {
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") quote = ch;
    else if (ch === ">") return i;
  }
  return -1;
}

/** Skip a `<!DOCTYPE ...>` declaration, honouring a bracketed internal subset. */
function skipDeclaration(source, start) {
  let depth = 0;
  for (let i = start + 2; i < source.length; i += 1) {
    const ch = source[i];
    if (ch === "[") depth += 1;
    else if (ch === "]") depth -= 1;
    else if (ch === ">" && depth <= 0) return i + 1;
  }
  return source.length;
}

/**
 * Parse a tag body into a name plus an attribute map (keys lower-cased).
 *
 * Every branch must advance `i`. The `=== before` guard below is not
 * decorative: malformed input can present a character that matches none of the
 * sub-scanners (the classic case is JavaScript captured by a stray `<`, e.g.
 * `plotW / (n - 1)`), and a loop that `continue`s without consuming it would
 * spin forever — synchronously, freezing the whole harness event loop.
 *
 * @param {string} body - the text between `<` and `>`.
 * @returns {{name: string, attrs: Record<string, string>}} the parsed tag.
 */
function parseTag(body) {
  const attrs = {};
  const trimmed = body.trim();
  let i = 0;
  while (i < trimmed.length && !/[\s/]/.test(trimmed[i])) i += 1;
  const name = trimmed.slice(0, i).toLowerCase();

  while (i < trimmed.length) {
    const before = i;
    while (i < trimmed.length && /\s/.test(trimmed[i])) i += 1;
    if (i >= trimmed.length) break;

    let key = "";
    while (i < trimmed.length && !/[\s=/]/.test(trimmed[i])) key += trimmed[i++];
    while (i < trimmed.length && /\s/.test(trimmed[i])) i += 1;

    if (trimmed[i] !== "=") {
      if (key.length > 0) attrs[key.toLowerCase()] = "";
      // Guarantee progress when nothing was consumed (e.g. a bare `/` or `=`).
      if (i === before) i += 1;
      continue;
    }

    i += 1;
    while (i < trimmed.length && /\s/.test(trimmed[i])) i += 1;
    const quote = trimmed[i];
    let value = "";
    if (quote === '"' || quote === "'") {
      i += 1;
      while (i < trimmed.length && trimmed[i] !== quote) value += trimmed[i++];
      // Skip the closing quote; an unterminated value must not overshoot.
      if (i < trimmed.length) i += 1;
    } else {
      while (i < trimmed.length && !/\s/.test(trimmed[i])) value += trimmed[i++];
    }
    if (key.length > 0) attrs[key.toLowerCase()] = decodeEntities(value);
  }
  return { name, attrs };
}

/** Append character data to the innermost open element. */
function pushText(stack, raw) {
  if (raw.length === 0 || raw.trim().length === 0) return;
  stack[stack.length - 1].children.push(decodeEntities(raw));
}

/** Extract `encoding` (and version) from an XML declaration body. */
function parseXmlDeclaration(body) {
  const encoding = /encoding\s*=\s*["']([^"']+)["']/i.exec(body);
  const version = /version\s*=\s*["']([^"']+)["']/i.exec(body);
  return {
    version: version === null ? undefined : version[1],
    encoding: encoding === null ? undefined : encoding[1]
  };
}

/**
 * Parse an XML document into a `{name:"#document"}` root.
 *
 * Never throws on malformed input: the returned tree is the best reading of
 * whatever arrived.
 *
 * @param {string} source - document text.
 * @param {{voidElements?: boolean}} [options] - pass `voidElements: true` to
 *   treat {@link VOID_ELEMENTS} as self-closing. XML feeds never need this, but
 *   HTML fragments do: without it everything after a `<br>` or `<img>` would be
 *   nested inside that element and the structure would be lost.
 * @returns {{root: object, declaration: {version?: string, encoding?: string} | undefined}}
 */
export function parseXml(source, options = {}) {
  const treatVoidAsSelfClosing = options.voidElements === true;
  const text = typeof source === "string" ? source : String(source ?? "");
  const root = { name: "#document", attrs: {}, children: [] };
  const stack = [root];
  let declaration;
  let i = 0;

  while (i < text.length) {
    const lt = text.indexOf("<", i);
    if (lt < 0) {
      pushText(stack, text.slice(i));
      break;
    }
    if (lt > i) pushText(stack, text.slice(i, lt));

    // Every branch below must move past this `<`. The guard turns any future
    // non-advancing branch into a single skipped character instead of an
    // infinite synchronous loop that would freeze the process.
    const cursorBefore = i;
    const advance = () => {
      if (i <= cursorBefore) i = lt + 1;
    };

    if (text.startsWith("<!--", lt)) {
      const end = text.indexOf("-->", lt + 4);
      i = end < 0 ? text.length : end + 3;
      advance();
      continue;
    }
    if (text.startsWith("<![CDATA[", lt)) {
      const end = text.indexOf("]]>", lt + 9);
      const raw = end < 0 ? text.slice(lt + 9) : text.slice(lt + 9, end);
      stack[stack.length - 1].children.push({ name: "#cdata", attrs: {}, children: [raw] });
      i = end < 0 ? text.length : end + 3;
      advance();
      continue;
    }
    if (text.startsWith("<?", lt)) {
      const end = text.indexOf("?>", lt + 2);
      const body = text.slice(lt + 2, end < 0 ? text.length : end);
      if (declaration === undefined && /^xml(\s|$)/i.test(body)) declaration = parseXmlDeclaration(body);
      i = end < 0 ? text.length : end + 2;
      advance();
      continue;
    }
    if (text.startsWith("<!", lt)) {
      i = skipDeclaration(text, lt);
      advance();
      continue;
    }

    const gt = findTagEnd(text, lt);
    if (gt < 0) {
      pushText(stack, text.slice(lt));
      break;
    }
    const inner = text.slice(lt + 1, gt);

    if (inner.startsWith("/")) {
      const name = inner.slice(1).trim().toLowerCase();
      for (let depth = stack.length - 1; depth > 0; depth -= 1) {
        if (stack[depth].name === name) {
          stack.length = depth;
          break;
        }
      }
      i = gt + 1;
      continue;
    }

    const selfClosing = inner.endsWith("/");
    const { name, attrs } = parseTag(selfClosing ? inner.slice(0, -1) : inner);
    if (name.length === 0) {
      i = gt + 1;
      continue;
    }
    const node = { name, attrs, children: [] };
    stack[stack.length - 1].children.push(node);
    // A void element is complete on its own, even unclosed (`<br>`, `<img …>`).
    if (!selfClosing && !(treatVoidAsSelfClosing && VOID_ELEMENTS.has(name))) stack.push(node);
    i = gt + 1;
  }

  return { root, declaration };
}

/**
 * Whether a node matches any of the supplied names.
 *
 * Matching accepts either the full lower-cased name (`content:encoded`) or its
 * local part (`encoded`), so the same lookup serves RSS 1.0/2.0 and Atom.
 *
 * @param {object} node - element node.
 * @param {...string} names - candidate names.
 * @returns {boolean} true on a match.
 */
export function isNamed(node, ...names) {
  if (node === null || typeof node !== "object" || typeof node.name !== "string") return false;
  const full = node.name.toLowerCase();
  const local = localName(full);
  for (const candidate of names) {
    const wanted = candidate.toLowerCase();
    if (full === wanted || local === localName(wanted)) return true;
  }
  return false;
}

/** Direct element children of `node`. */
export function childElements(node) {
  if (node === null || typeof node !== "object" || !Array.isArray(node.children)) return [];
  return node.children.filter((child) => typeof child === "object" && child !== null);
}

/**
 * First direct child element matching any name.
 * @returns {object | undefined} the element, or undefined.
 */
export function findChild(node, ...names) {
  for (const child of childElements(node)) if (isNamed(child, ...names)) return child;
  return undefined;
}

/** All direct child elements matching any name. */
export function findChildren(node, ...names) {
  return childElements(node).filter((child) => isNamed(child, ...names));
}

/**
 * Depth-first search for the first descendant matching any name.
 * @returns {object | undefined} the element, or undefined.
 */
export function findDescendant(node, ...names) {
  for (const child of childElements(node)) {
    if (isNamed(child, ...names)) return child;
    const nested = findDescendant(child, ...names);
    if (nested !== undefined) return nested;
  }
  return undefined;
}

/** Attribute lookup by exact or local name (case-insensitive). */
export function attr(node, name) {
  if (node === null || typeof node !== "object" || node.attrs === null || typeof node.attrs !== "object") return undefined;
  const wanted = name.toLowerCase();
  if (Object.hasOwn(node.attrs, wanted)) return node.attrs[wanted];
  for (const [key, value] of Object.entries(node.attrs)) {
    if (localName(key) === localName(wanted)) return value;
  }
  return undefined;
}

/**
 * Concatenated text of an element (descendant text and CDATA included),
 * trimmed. Inline markup is flattened, which is what feed titles need.
 *
 * @param {object | undefined} node - element node.
 * @returns {string} the text, or "" when absent.
 */
export function nodeText(node) {
  if (node === undefined || node === null) return "";
  const parts = [];
  const walk = (current) => {
    if (typeof current === "string") {
      parts.push(current);
      return;
    }
    if (current === null || typeof current !== "object") return;
    if (Array.isArray(current.children)) for (const child of current.children) walk(child);
  };
  walk(node);
  return decodeEntities(parts.join("")).replace(/\s+/g, " ").trim();
}

/**
 * Text of the first child matching any name.
 * @returns {string} the text, or "" when the child is absent.
 */
export function childText(node, ...names) {
  return nodeText(findChild(node, ...names));
}
