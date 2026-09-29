/**
 * dsh-rss-reader — browser client bundle.
 *
 * Hand-written in the harness's lazy-CJS `__ModuleLoader__.load` format (no
 * bundler step): the factory's `require` resolves the platform seed modules,
 * so this file ships as-is.
 *
 * It registers two things:
 *
 * - a **`main` panel** (key `rss-reader`) occupying the center column, with a
 *   three-pane reader: subscriptions, the item stream, and the reading pane;
 * - a **`sidebar.panellist`** entry whose id matches that key, which is what
 *   puts the RSS button in the sidebar and routes to the panel.
 *
 * All data flows through the host's `/api/rss-reader/*` routes, so this bundle
 * holds no feed state of its own beyond view preferences.
 *
 * @module dsh-rss-reader/client
 */

window.__ModuleLoader__.load({
  id: "dsh-rss-reader",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

    const React = require("react");
    const { useState, useEffect, useMemo, useCallback, useRef } = React;
    const h = React.createElement;

    /** Slot key shared by the panel registration and the sidebar entry. */
    const PANEL_KEY = "rss-reader";

    /**
     * The right Sidebar tab type's id.
     *
     * It is this implementation's identity in that registry (so a second
     * registration of it would throw), and the key both of its seats register
     * under — the body and, when present, the chip title.
     */
    const SIDEBAR_TAB_ID = "dsh-rss-reader";

    /** The tab kind `ctx.sidebarRight.openTab` names to open this panel. */
    const SIDEBAR_TAB_KIND = "rss-reader";

    /** API root served by the host half. */
    const API = "/api/rss-reader";

    /**
     * The time windows the stream can be scoped to.
     *
     * `days` counts the current local day as one of them, so "近 3 天" means
     * today plus the two before it — not "72 hours ago". Keeping the window on
     * whole local days is what lets it share one boundary rule with "今天";
     * a rolling 72-hour window would answer a different question than the label
     * asks, and the two would disagree across midnight.
     */
    const TIME_RANGES = [
      { value: "all", label: "全部", days: 0 },
      { value: "today", label: "今天", days: 1 },
      { value: "3d", label: "近 3 天", days: 3 },
      { value: "7d", label: "近 7 天", days: 7 }
    ];

    /**
     * The instant a range starts, in local time.
     *
     * Local midnight, not `now - days * 24h`: the decision is that "今天" is the
     * reader's own calendar day, and every other window is measured in the same
     * unit so the labels stay comparable.
     *
     * @param {number} days - 1 for today, 3 for the last three days, …
     * @returns {number} epoch milliseconds of local midnight that many days back.
     */
    function rangeStart(days) {
      const midnight = new Date();
      midnight.setHours(0, 0, 0, 0);
      return midnight.getTime() - (days - 1) * 24 * 60 * 60 * 1000;
    }

    /**
     * Whether an item's publication instant falls inside a window.
     *
     * Lives at module scope rather than in the component so the memo that uses
     * it depends on data alone — a re-created closure would invalidate that memo
     * on every render.
     *
     * An unusable date cannot be placed in a window and answers `false`; those
     * rows are counted and reported separately, never silently dropped.
     *
     * @param {{item: {date: string}}} row - one stream entry.
     * @param {number} days - window size; 0 or less means "no window".
     * @returns {boolean} whether the row is inside the window.
     */
    function inTimeRange(row, days) {
      if (days <= 0) return true;
      const at = Date.parse(row.item.date || "");
      return Number.isFinite(at) && at >= rangeStart(days);
    }

    /** Whether an item carries a date this panel can place on a timeline. */
    function hasUsableDate(item) {
      return Number.isFinite(Date.parse(item?.date || ""));
    }

    /**
     * Whether an item was published during the reader's current local day.
     * @param {{date: string}} item - a stored item.
     * @returns {boolean} true when its publication instant is today.
     */
    function isFromToday(item) {
      const at = Date.parse(item?.date || "");
      return Number.isFinite(at) && at >= rangeStart(1);
    }

    /**
     * How long a success/status notice stays before it dismisses itself.
     *
     * Long enough to read a one-line "已刷新 3/4 个源，新增 12 条" without
     * hurrying, short enough that it stops covering the list.
     */
    const NOTICE_AUTO_DISMISS_MS = 2000;

    /**
     * How long the reading pane waits after a scroll before storing the offset.
     *
     * A write per scroll frame would be absurd, and the value only has to be
     * right when the panel closes — which can happen at any moment, hence a
     * short window rather than writing on teardown (an unmounted component gets
     * no reliable last word).
     */
    const SCROLL_MEMORY_DEBOUNCE_MS = 400;

    const COLOR = {
      bg: "var(--dsw-alias-bg-base, #ffffff)",
      panel: "var(--dsw-alias-bg-layer-3, #f7f8fa)",
      layer2: "var(--dsw-alias-bg-layer-2, #f2f4f7)",
      border: "var(--dsw-alias-border-l2, #e3e6ea)",
      borderStrong: "var(--dsw-alias-border-l3, #d0d5dc)",
      text: "var(--dsw-alias-label-primary, #1f2329)",
      dim: "var(--dsw-alias-label-secondary, #646a73)",
      faint: "var(--dsw-alias-label-tertiary, #8f959e)",
      accent: "var(--dsw-alias-state-business-primary, #1668dc)",
      danger: "#e5484d",
      warning: "#f5a524",
      success: "#2f9e63"
    };

    // ── API helpers ───────────────────────────────────────────────────────
    /**
     * Call the host API and unwrap its envelope.
     * @param {string} path - route below the API root.
     * @param {object} [options] - fetch options.
     * @returns {Promise<object>} the parsed `ok: true` envelope.
     */
    async function call(path, options = {}) {
      const init = { method: options.method ?? "GET", headers: {} };
      if (options.body !== undefined) {
        init.headers["content-type"] = "application/json";
        init.body = JSON.stringify(options.body);
      }
      let res;
      try {
        res = await fetch(API + path, init);
      } catch (error) {
        throw new Error(`无法连接宿主 API：${error instanceof Error ? error.message : String(error)}`);
      }
      let data;
      try {
        data = await res.json();
      } catch {
        throw new Error(`HTTP ${res.status}：响应不是合法 JSON`);
      }
      if (!res.ok || data.ok !== true) throw new Error(data.error || `HTTP ${res.status}`);
      return data;
    }

    /** Shape an unknown thrown value into a message. */
    const messageOf = (error) => (error instanceof Error ? error.message : String(error));

    // ── view preferences ─────────────────────────────────────────────────
    /**
     * The view preferences every part of this bundle shares.
     *
     * Module scope, not component state: the centre panel, the right Sidebar's
     * tab, and the settings row are three separate React trees, and the row's
     * whole job is to change what `apply` registers for the others. The host
     * owns the value (it persists it), so this is a cache plus a subscription,
     * not a source of truth.
     */
    const prefsState = {
      /** The last values read from or written to the host. */
      value: { showSidebarEntry: true, collapseFeeds: false },
      /** Which keys the user has actually chosen, as the host reports them. */
      stored: [],
      /** Whether the host has answered yet; until then the fallback stands. */
      loaded: false,
      /** @type {Set<() => void>} */
      listeners: new Set()
    };

    /** Read the cached preferences. */
    function readPrefs() {
      return prefsState.value;
    }

    /**
     * Whether the host has answered with the stored preferences yet.
     *
     * The panel's remembered position is only meaningful once the real values
     * are in hand: restoring before that would overwrite the reader's place with
     * the fallback defaults.
     *
     * @returns {boolean} true once the read has settled.
     */
    function prefsReady() {
      return prefsState.loaded;
    }

    /**
     * The preference keys the user has chosen.
     *
     * The merged values cannot answer this: a value equal to the default is
     * indistinguishable from no choice at all, and "is this mine, or the plugin
     * config's?" is exactly what the settings page has to say.
     *
     * @returns {string[]} the stored keys.
     */
    function storedPrefs() {
      return prefsState.stored;
    }

    /** Tell every subscriber, and listener, that the value may have moved. */
    function notifyPrefs() {
      for (const listener of [...prefsState.listeners]) listener();
    }

    /**
     * Subscribe to preference changes.
     * @param {() => void} listener - called after every change.
     * @returns {() => void} unsubscribe.
     */
    function subscribePrefs(listener) {
      prefsState.listeners.add(listener);
      return () => prefsState.listeners.delete(listener);
    }

    /**
     * Adopt the preferences the host reports, keeping the fallback for keys it
     * does not mention.
     * @param {unknown} prefs - the host's `prefs` object.
     * @param {unknown} [stored] - the keys the user has chosen.
     */
    function adoptPrefs(prefs, stored) {
      if (Array.isArray(stored)) prefsState.stored = stored.filter((key) => typeof key === "string");
      if (prefs === null || typeof prefs !== "object" || Array.isArray(prefs)) return;
      const next = { ...prefsState.value };
      for (const [key, value] of Object.entries(prefs)) {
        // Booleans are the switches; the instance URL is the one string. The
        // host validates both, so this only has to refuse shapes it cannot use.
        if (typeof value === "boolean" || typeof value === "string") next[key] = value;
      }
      prefsState.value = next;
    }

    /**
     * Read the preferences once at startup.
     *
     * Subscribers are notified even on failure: a listener that registers UI is
     * waiting for an answer, and silence would leave the panel with no entry at
     * all. The fallback is the visible, safe state.
     *
     * Both the plugin body and the panel ask for this, and both may ask at once
     * — the body reads at load so the left-Sidebar row can be registered from the
     * right value, while the panel reads on mount so it does not depend on the
     * body having run first. Coalescing keeps that one request either way.
     *
     * @returns {Promise<void>} resolves once the value is settled.
     */
    let prefsInFlight = false;
    async function loadPrefs() {
      if (prefsInFlight) return;
      prefsInFlight = true;
      try {
        const data = await call("/prefs");
        adoptPrefs(data?.prefs, data?.stored);
      } catch {
        // A preference read that fails must not be reported as a plugin error;
        // the settings page surfaces the write path's failure on its own.
      } finally {
        prefsInFlight = false;
        prefsState.loaded = true;
        notifyPrefs();
      }
    }

    /**
     * Change one preference.
     *
     * Applied optimistically so the switch moves on the click, then rolled back
     * if the host refuses: a control that silently keeps a value the host never
     * stored is worse than one that snaps back.
     *
     * @param {string} key - the preference key.
     * @param {boolean | string} value - the new value; "" clears it.
     * @returns {Promise<object>} the host's answer, with the effective values.
     * @throws when the host refuses.
     */
    async function setPref(key, value) {
      const previous = prefsState.value;
      const previousStored = prefsState.stored;
      prefsState.value = { ...previous, [key]: value };
      prefsState.stored = value === "" ? previousStored.filter((entry) => entry !== key) : [...new Set([...previousStored, key])];
      notifyPrefs();
      try {
        const data = await call("/prefs", { method: "PATCH", body: { [key]: value } });
        adoptPrefs(data?.prefs, data?.stored);
        notifyPrefs();
        return data;
      } catch (error) {
        prefsState.value = previous;
        prefsState.stored = previousStored;
        notifyPrefs();
        throw error;
      }
    }

    /**
     * Read one preference reactively.
     * @returns {Record<string, boolean>} the current values.
     */
    function usePrefs() {
      const [, bump] = useState(0);
      useEffect(() => subscribePrefs(() => bump((value) => value + 1)), []);
      return prefsState.value;
    }

    /**
     * The preference keys the host reports as the user's, as a hook.
     *
     * The panel's remembered position can only be applied once the real values
     * are in hand, so the effect that restores it has to run again *after* the
     * read settles. `prefsState.stored` is the signal to hook onto because the
     * read replaces the array, which changes its identity — whereas the values
     * object is merged into in place, so a flag inside it can change without any
     * effect noticing.
     *
     * @returns {string[]} the stored keys.
     */
    function useStoredPrefs() {
      const [, bump] = useState(0);
      useEffect(() => subscribePrefs(() => bump((value) => value + 1)), []);
      return prefsState.stored;
    }

    // ── small utilities ───────────────────────────────────────────────────
    const pad2 = (value) => String(value).padStart(2, "0");

    /**
     * Format an ISO timestamp as a relative label for recent items and an
     * absolute one for older entries.
     * @param {string} iso - ISO timestamp.
     * @returns {string} a display label.
     */
    function formatWhen(iso) {
      if (typeof iso !== "string" || iso.length === 0) return "";
      const date = new Date(iso);
      if (Number.isNaN(date.getTime())) return "";
      const diffMs = Date.now() - date.getTime();
      if (diffMs < 0) return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`;
      const minutes = Math.floor(diffMs / 60000);
      if (minutes < 1) return "刚刚";
      if (minutes < 60) return `${minutes} 分钟前`;
      const hours = Math.floor(minutes / 60);
      if (hours < 24) return `${hours} 小时前`;
      const days = Math.floor(hours / 24);
      if (days < 7) return `${days} 天前`;
      return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`;
    }

    /** Full local timestamp for a tooltip. */
    function formatFull(iso) {
      if (typeof iso !== "string" || iso.length === 0) return "";
      const date = new Date(iso);
      if (Number.isNaN(date.getTime())) return iso;
      return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())} ${pad2(date.getHours())}:${pad2(date.getMinutes())}`;
    }

    // ── subscription order ────────────────────────────────────────────────
    /**
     * Move one id a step up or down.
     *
     * @param {string[]} ids - the order in force.
     * @param {string} moving - the id to move.
     * @param {number} delta - -1 up, +1 down.
     * @returns {string[] | null} the new order, or null at the ends.
     */
    function shiftId(ids, moving, delta) {
      const from = ids.indexOf(moving);
      if (from < 0) return null;
      const to = from + delta;
      if (to < 0 || to >= ids.length) return null;
      const next = [...ids];
      next.splice(from, 1);
      next.splice(to, 0, moving);
      return next;
    }

    /**
     * Move one id into another's place.
     *
     * Dropping a row onto another reads as "take its place", so everything
     * between the two shifts by one — which is what the reader sees happen.
     *
     * @param {string[]} ids - the order in force.
     * @param {string} moving - the dragged id.
     * @param {string} target - the id it was dropped on.
     * @returns {string[] | null} the new order, or null when it is a no-op.
     */
    function moveIdTo(ids, moving, target) {
      const from = ids.indexOf(moving);
      const to = ids.indexOf(target);
      if (from < 0 || to < 0 || from === to) return null;
      const next = [...ids];
      next.splice(from, 1);
      next.splice(to, 0, moving);
      return next;
    }

    /**
     * Reorder a rendered feed list to match an id order.
     *
     * Feeds the caller does not mention keep their place at the end: a list read
     * a moment ago must never make a subscription vanish from the screen.
     *
     * @param {Array<object>} feeds - the feeds as rendered.
     * @param {string[]} ids - the wanted order.
     * @returns {Array<object>} the reordered feeds.
     */
    function reorderFeeds(feeds, ids) {
      const byId = new Map(feeds.map((feed) => [feed.id, feed]));
      const out = [];
      for (const id of ids) {
        const feed = byId.get(id);
        if (feed !== undefined) {
          out.push(feed);
          byId.delete(id);
        }
      }
      for (const feed of byId.values()) out.push(feed);
      return out;
    }

    /** Whether a feed's cache is older than the staleness threshold. */
    function isStale(fetchedAt, minutes = 30) {
      if (typeof fetchedAt !== "string" || fetchedAt.length === 0) return true;
      const date = new Date(fetchedAt);
      if (Number.isNaN(date.getTime())) return true;
      return Date.now() - date.getTime() > minutes * 60000;
    }

    // ── markdown ──────────────────────────────────────────────────────────
    // A self-contained Markdown renderer. It cannot use a library: a client
    // bundle may only require the boot's platform seed modules (`react`,
    // `react/jsx-runtime`, `react-dom`, cordis, store, slots, primitives,
    // dockkit) — `marked` is not one, and requiring it would miss the module
    // table at runtime. The supported subset is the one feed bodies actually
    // use: headings, paragraphs, lists, blockquotes, fenced/inline code,
    // tables, rules, links, emphasis, and images.
    //
    // React elements are produced directly (never `dangerouslySetInnerHTML`),
    // so hostile markup in a feed cannot inject script into the DSH page.

    /** Escape a string for a `href`; returns "" when the scheme is unsafe. */
    function safeHref(url) {
      const raw = String(url ?? "").trim();
      if (raw.length === 0) return "";
      if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(raw)) return /^https?:/i.test(raw) ? raw : "";
      // Relative and scheme-relative URLs resolve against the app origin.
      return raw.startsWith("//") ? "" : raw;
    }

    /** Decode the small set of entities a feed body may still contain. */
    function decodeText(value) {
      return String(value ?? "").replace(/&(#[0-9]+|#[xX][0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]*);/g, (match, body) => {
        if (body.charCodeAt(0) === 35) {
          const hex = body[1] === "x" || body[1] === "X";
          const code = Number.parseInt(hex ? body.slice(2) : body.slice(1), hex ? 16 : 10);
          if (!Number.isFinite(code) || code < 0 || code > 0x10ffff) return match;
          try {
            return String.fromCodePoint(code);
          } catch {
            return match;
          }
        }
        const named = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: "\u00a0" };
        return named[body] ?? match;
      });
    }

    /** One Markdown image token; global, so `String#match` reads them all. */
    const IMAGE_TOKEN = /!\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g;

    /**
     * The images of one run of Markdown, in document order.
     *
     * Duplicates inside a single run are dropped: a body that repeats one
     * tracking pixel or logo around the same picture is not showing two
     * pictures. Across runs nothing is deduplicated — a picture that appears
     * twice in the original appears twice here, which is the whole point.
     *
     * @param {string} text - Markdown source.
     * @returns {Array<{url: string, alt: string}>} the images.
     */
    function imagesIn(text) {
      const tokens = String(text ?? "").match(IMAGE_TOKEN) ?? [];
      const out = [];
      const seen = new Set();
      for (const token of tokens) {
        const parts = /!\[([^\]]*)\]\(([^)\s]+)/.exec(token);
        if (parts === null) continue;
        const url = safeHref(parts[2]);
        if (url.length === 0 || seen.has(url)) continue;
        seen.add(url);
        out.push({ alt: decodeText(parts[1]).trim(), url });
      }
      return out;
    }

    /**
     * Read a paragraph that contains nothing but images.
     *
     * @param {string} text - the paragraph's text.
     * @returns {Array<object> | null} its images, or null when it carries prose.
     */
    function imageRun(text) {
      const source = String(text ?? "");
      // Whatever is left after removing the image tokens decides it: any prose,
      // punctuation or stray markup means this is a paragraph with a picture in
      // it, and the picture belongs inline.
      if (source.replace(IMAGE_TOKEN, "").replace(/\s+/g, "").length > 0) return null;
      const images = imagesIn(source);
      return images.length > 0 ? images : null;
    }

    /**
     * Join neighbouring picture blocks into one group.
     *
     * A blank line between two pictures is typography, not separation: the
     * article meant one gallery, and splitting it into two collapsing bars
     * would read as two.
     *
     * @param {Array<object>} blocks - parsed blocks.
     * @returns {Array<object>} the same list with adjacent runs merged.
     */
    function mergeImageRuns(blocks) {
      const merged = [];
      for (const block of blocks) {
        const previous = merged[merged.length - 1];
        if (block.type === "images" && previous !== undefined && previous.type === "images") {
          for (const image of block.images) {
            if (!previous.images.some((other) => other.url === image.url)) previous.images.push(image);
          }
          continue;
        }
        merged.push(block);
      }
      return merged;
    }

    /**
     * Parse inline Markdown into React nodes.
     *
     * Handles code spans first (their content is literal), then links, images,
     * and emphasis.
     *
     * @param {string} text - inline Markdown.
     * @param {string} keyPrefix - stable key prefix.
     * @param {(image: object) => void} [onImage] - opens one image full size.
     * @returns {Array} React nodes.
     */
    function inlineNodes(text, keyPrefix, onImage) {
      const source = String(text ?? "");
      const nodes = [];
      // One pass, longest-match-first, over the inline constructs.
      const pattern = /(`+)([\s\S]*?)\1|!\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)|\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)|\*\*([^*]+)\*\*|__([^_]+)__|(?<!\*)\*([^*\n]+)\*|(?<!_)_([^_\n]+)_|~~([^~]+)~~|<((?:https?):\/\/[^>\s]+)>/g;
      let last = 0;
      let match;
      let index = 0;

      const pushText = (value) => {
        if (value.length === 0) return;
        nodes.push(decodeText(value));
      };

      while ((match = pattern.exec(source)) !== null) {
        pushText(source.slice(last, match.index));
        last = pattern.lastIndex;
        index += 1;
        const key = `${keyPrefix}-i${index}`;
        const [, , code, imgAlt, imgUrl, linkText, linkUrl, bold1, bold2, em1, em2, del, autolink] = match;

        if (code !== undefined) {
          nodes.push(h("code", { key, style: S.mdCode }, code.trim()));
        } else if (imgUrl !== undefined) {
          // An image inside a run of text sat inside that text in the original
          // article, so it stays there rather than joining the picture blocks.
          // It still starts collapsed, so nothing is downloaded until asked for.
          const url = safeHref(imgUrl);
          if (url.length === 0) nodes.push(decodeText(imgAlt ?? ""));
          else nodes.push(h(InlineImage, {
            key,
            image: { alt: decodeText(imgAlt ?? "").trim(), url },
            onOpen: onImage
          }));
        } else if (linkUrl !== undefined) {
          const href = safeHref(linkUrl);
          if (href.length === 0) nodes.push(decodeText(linkText));
          else nodes.push(h("a", {
            key,
            href,
            target: "_blank",
            rel: "noreferrer noopener",
            style: S.mdLink
          }, inlineNodes(linkText, key, onImage)));
        } else if (autolink !== undefined) {
          const href = safeHref(autolink);
          nodes.push(href.length === 0
            ? autolink
            : h("a", { key, href, target: "_blank", rel: "noreferrer noopener", style: S.mdLink }, autolink));
        } else if (bold1 !== undefined || bold2 !== undefined) {
          nodes.push(h("strong", { key }, inlineNodes(bold1 ?? bold2, key, onImage)));
        } else if (em1 !== undefined || em2 !== undefined) {
          nodes.push(h("em", { key }, inlineNodes(em1 ?? em2, key, onImage)));
        } else if (del !== undefined) {
          nodes.push(h("del", { key, style: { opacity: 0.65 } }, inlineNodes(del, key, onImage)));
        }
      }
      pushText(source.slice(last));
      return nodes;
    }

    /**
     * Split a Markdown document into block-level tokens.
     *
     * @param {string} markdown - Markdown source.
     * @returns {Array<object>} block tokens.
     */
    function parseBlocks(markdown) {
      const lines = String(markdown ?? "").replace(/\r\n?/g, "\n").split("\n");
      const blocks = [];
      let i = 0;

      const isBlank = (line) => line.trim().length === 0;

      while (i < lines.length) {
        const line = lines[i];

        if (isBlank(line)) {
          i += 1;
          continue;
        }

        // Fenced code block.
        const fence = /^\s*(`{3,}|~{3,})\s*([\w+#.-]*)\s*$/.exec(line);
        if (fence !== null) {
          const marker = fence[1][0].repeat(fence[1].length);
          const language = fence[2] ?? "";
          const body = [];
          i += 1;
          while (i < lines.length && !new RegExp(`^\\s*${marker[0]}{${marker.length},}\\s*$`).test(lines[i])) {
            body.push(lines[i]);
            i += 1;
          }
          i += 1; // consume the closing fence
          blocks.push({ type: "code", language, text: body.join("\n") });
          continue;
        }

        // Heading.
        const heading = /^(#{1,6})\s+(.*)$/.exec(line);
        if (heading !== null) {
          blocks.push({ type: "heading", level: heading[1].length, text: heading[2].trim() });
          i += 1;
          continue;
        }

        // Horizontal rule.
        if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) {
          blocks.push({ type: "rule" });
          i += 1;
          continue;
        }

        // Table: a header row followed by a delimiter row.
        if (line.includes("|") && i + 1 < lines.length && /^\s*\|?[\s:|-]+\|[\s:|-]*$/.test(lines[i + 1])) {
          const splitRow = (row) => row.replace(/^\s*\|/, "").replace(/\|\s*$/, "").split("|").map((cell) => cell.trim());
          const header = splitRow(line);
          const aligns = splitRow(lines[i + 1]).map((cell) => {
            const left = cell.startsWith(":");
            const right = cell.endsWith(":");
            if (left && right) return "center";
            if (right) return "right";
            if (left) return "left";
            return null;
          });
          i += 2;
          const rows = [];
          while (i < lines.length && lines[i].includes("|") && !isBlank(lines[i])) {
            rows.push(splitRow(lines[i]));
            i += 1;
          }
          blocks.push({ type: "table", header, aligns, rows });
          continue;
        }

        // Blockquote: consecutive `>` lines (including lazy continuation).
        if (/^\s*>/.test(line)) {
          const body = [];
          while (i < lines.length && (/^\s*>/.test(lines[i]) || (!isBlank(lines[i]) && body.length > 0 && !/^\s*(#{1,6}\s|[-*+]\s|\d+\.\s|`{3,})/.test(lines[i])))) {
            body.push(lines[i].replace(/^\s*>\s?/, ""));
            i += 1;
          }
          blocks.push({ type: "quote", lines: body });
          continue;
        }

        // Lists (ordered or unordered), with nested items by indentation.
        const listMatch = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/.exec(line);
        if (listMatch !== null) {
          const items = [];
          const baseIndent = listMatch[1].length;
          const ordered = /\d/.test(listMatch[2]);
          while (i < lines.length) {
            const item = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/.exec(lines[i]);
            if (item === null) {
              // A blank line or a continuation line of the current item.
              if (isBlank(lines[i])) break;
              const indent = lines[i].match(/^\s*/)[0].length;
              if (items.length > 0 && indent > baseIndent) {
                items[items.length - 1].body.push(lines[i].slice(baseIndent + 2));
                i += 1;
                continue;
              }
              break;
            }
            if (item[1].length < baseIndent) break;
            if (item[1].length > baseIndent) {
              // Nested list: keep it inside the parent item's body.
              items[items.length - 1].body.push(lines[i].slice(baseIndent + 2));
              i += 1;
              continue;
            }
            if (/\d/.test(item[2]) !== ordered) break;
            items.push({ marker: item[2], body: [item[3]] });
            i += 1;
          }
          blocks.push({ type: "list", ordered, items });
          continue;
        }

        // Paragraph: consume until a blank line or a line starting a new block.
        const paragraph = [];
        while (i < lines.length && !isBlank(lines[i])) {
          if (paragraph.length > 0 && /^(\s*(#{1,6}\s|>|[-*+]\s|\d+[.)]\s|`{3,}|~{3,}))/.test(lines[i])) break;
          if (paragraph.length > 0 && /^\s*([-*_])(\s*\1){2,}\s*$/.test(lines[i])) break;
          paragraph.push(lines[i]);
          i += 1;
        }
        const text = paragraph.join("\n");
        // A paragraph that is nothing but pictures is a picture in the article,
        // not a sentence: making it its own block is what lets it render at the
        // position the article gave it.
        const run = imageRun(text);
        if (run !== null) {
          blocks.push({ type: "images", images: run });
          continue;
        }
        blocks.push({ type: "paragraph", text });
      }

      return mergeImageRuns(blocks);
    }

    /**
     * Render one image tile.
     *
     * The `<img>` is always in the flow. Hiding it behind `display: none` until
     * it loads looks tidy but deadlocks: a hidden element never enters the
     * viewport, so `loading="lazy"` never starts the fetch, so `onLoad` never
     * fires, so it stays hidden — the tile would sit on "载入中…" forever. The
     * placeholder is therefore laid over a reserved-height box, not substituted
     * for the image.
     */
    function MarkdownImage({ image, onOpen }) {
      const [failed, setFailed] = useState(false);
      const [loaded, setLoaded] = useState(false);
      const node = useRef(null);
      // A cached image can settle before React attaches its handlers, in which
      // case neither `onLoad` nor `onError` ever arrives and the tile would sit
      // on "载入中…" forever. The element itself knows the answer.
      useEffect(() => {
        const element = node.current;
        if (element === null || element === undefined || element.complete !== true) return;
        if (element.naturalWidth > 0) setLoaded(true);
        else setFailed(true);
      }, [image.url]);
      return h("figure", { style: S.mdFigure },
        // The box keeps the tile's height while the image is in flight, and the
        // placeholder is laid over it rather than in place of it — the image
        // itself must stay in the flow, or a lazy load never starts.
        h("div", { style: S.mdImageBox },
          failed
            ? h("div", { style: S.mdImageFallback }, "图片加载失败")
            : h("img", {
                ref: node,
                src: image.url,
                alt: image.alt,
                loading: "lazy",
                decoding: "async",
                referrerPolicy: "no-referrer",
                onLoad: () => setLoaded(true),
                onError: () => setFailed(true),
                onClick: () => onOpen?.(image),
                style: { ...S.mdImage, cursor: onOpen ? "zoom-in" : "default" }
              }),
          !loaded && !failed ? h("div", { style: S.mdImageOverlay }, "载入中…") : null
        ),
        image.alt.length > 0 ? h("figcaption", { style: S.mdFigcaption }, image.alt) : null
      );
    }

    /**
     * An image that sat inside a run of text.
     *
     * Mid-sentence images are usually badges, emoji or small figures, so they
     * stay in the sentence — but collapsed to a chip, because the same rule
     * applies as everywhere else: nothing is downloaded until it is asked for.
     * Clicking the chip swaps in the picture in place; clicking the picture
     * opens it full size.
     *
     * @param {object} props - `{image, onOpen}`.
     */
    function InlineImage({ image, onOpen }) {
      const prefs = usePrefs();
      // `null` means "the reader has not touched this one", so it follows the
      // preference; a click pins it either way.
      const [open, setOpen] = useState(null);
      const [failed, setFailed] = useState(false);
      const shown = open ?? prefs.expandImages === true;
      if (!shown) {
        return h("button", {
          type: "button",
          style: S.mdInlineChip,
          title: image.alt.length > 0 ? `显示图片：${image.alt}` : "显示图片",
          onClick: () => setOpen(true)
        }, `🖼${image.alt.length > 0 ? ` ${image.alt}` : ""}`);
      }
      if (failed) {
        return h("span", { style: S.mdInlineFailed }, "图片加载失败");
      }
      return h("img", {
        src: image.url,
        alt: image.alt,
        loading: "lazy",
        decoding: "async",
        referrerPolicy: "no-referrer",
        onError: () => setFailed(true),
        onClick: () => onOpen?.(image),
        style: { ...S.mdInlineImage, cursor: onOpen ? "zoom-in" : "default" }
      });
    }

    /**
     * The collapsed image group: a summary bar that expands on demand.
     *
     * One group stands where the article's picture block stood. Its label names
     * the picture when there is only one, because "图片 1 张" says less than the
     * caption the feed already provided.
     *
     * @param {object} props - `{images, onOpen}`.
     */
    function ImageGroup({ images, onOpen }) {
      const prefs = usePrefs();
      // `null` means "the reader has not touched this group", so it follows the
      // preference; a click pins this one either way, and stays pinned when the
      // preference changes underneath it.
      const [open, setOpen] = useState(null);
      const expanded = open ?? prefs.expandImages === true;
      const single = images.length === 1 ? images[0] : null;
      const label = single === null
        ? `图片 ${images.length} 张`
        : single.alt.length > 0 ? `图片：${single.alt}` : "图片";
      return h("div", { style: S.mdImageGroup },
        h("button", {
          type: "button",
          style: S.mdImageToggle,
          onClick: () => setOpen(!expanded),
          title: expanded ? "折叠图片" : "展开图片"
        },
          h("span", { style: { fontSize: "11px" } }, expanded ? "▾" : "▸"),
          h("span", { style: { minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" } }, label),
          h("span", { style: { color: COLOR.faint, fontSize: "11px", flex: "0 0 auto" } },
            expanded ? "点击折叠" : "默认折叠，点击展开")
        ),
        expanded
          ? h("div", { style: S.mdImageGrid }, images.map((image, index) => h(MarkdownImage, {
              key: `${image.url}-${index}`,
              image,
              onOpen
            })))
          : null
      );
    }

    /**
     * Render a Markdown document into React nodes.
     *
     * @param {object} props - `{markdown, onOpenImage}`.
     */
    function Markdown({ markdown, onOpenImage }) {
      // Pictures are not lifted out of the document. Each run of them is a block
      // of its own, rendered where the article put it, collapsed until asked
      // for — so the reading order is the article's, and nothing is downloaded
      // until the reader opens it.
      const blocks = useMemo(() => parseBlocks(String(markdown ?? "")), [markdown]);

      const nodes = [];
      blocks.forEach((block, index) => {
        const key = `b${index}`;
        if (block.type === "images") {
          nodes.push(h(ImageGroup, { key, images: block.images, onOpen: onOpenImage }));
          return;
        }
        if (block.type === "heading") {
          const level = Math.min(6, Math.max(1, block.level));
          nodes.push(h(`h${level}`, { key, style: S.mdHeading(level) }, inlineNodes(block.text, key, onOpenImage)));
          return;
        }
        if (block.type === "rule") {
          nodes.push(h("hr", { key, style: { border: "none", borderTop: `1px solid ${COLOR.border}`, margin: "16px 0" } }));
          return;
        }
        if (block.type === "code") {
          nodes.push(h("pre", { key, style: S.mdPre },
            block.language.length > 0
              ? h("div", { style: { fontSize: "11px", color: COLOR.faint, marginBottom: "6px" } }, block.language)
              : null,
            h("code", { style: { fontFamily: "var(--ds-font-family-code, ui-monospace, monospace)" } }, block.text)
          ));
          return;
        }
        if (block.type === "quote") {
          nodes.push(h("blockquote", { key, style: S.mdQuote },
            parseBlocks(block.lines.join("\n")).map((inner, innerIndex) => {
              const innerKey = `${key}-${innerIndex}`;
              if (inner.type === "images") {
                return h(ImageGroup, { key: innerKey, images: inner.images, onOpen: onOpenImage });
              }
              if (inner.type === "paragraph") {
                return h("p", { key: innerKey, style: S.mdParagraph }, inlineNodes(inner.text, innerKey, onOpenImage));
              }
              return h("div", { key: innerKey, style: S.mdParagraph }, inlineNodes(inner.text ?? "", innerKey, onOpenImage));
            })
          ));
          return;
        }
        if (block.type === "list") {
          const ListTag = block.ordered ? "ol" : "ul";
          nodes.push(h(ListTag, { key, style: S.mdList }, block.items.map((item, itemIndex) => {
            const itemKey = `${key}-${itemIndex}`;
            const body = item.body.join("\n");
            // A nested list inside the item body is parsed recursively.
            const nested = parseBlocks(body).filter((inner) => inner.type === "list");
            const text = body.split("\n").filter((line) => !/^\s*([-*+]|\d+[.)])\s+/.test(line)).join("\n");
            return h("li", { key: itemKey, style: S.mdListItem },
              inlineNodes(text, itemKey, onOpenImage),
              nested.map((inner, innerIndex) => {
                const InnerTag = inner.ordered ? "ol" : "ul";
                return h(InnerTag, { key: `${itemKey}-n${innerIndex}`, style: S.mdList },
                  inner.items.map((nestedItem, nestedIndex) => h("li", {
                    key: `${itemKey}-n${innerIndex}-${nestedIndex}`,
                    style: S.mdListItem
                  }, inlineNodes(nestedItem.body.join("\n"), `${itemKey}-n${innerIndex}-${nestedIndex}`, onOpenImage)))
                );
              })
            );
          })));
          return;
        }
        if (block.type === "table") {
          nodes.push(h("div", { key, style: { overflowX: "auto", margin: "12px 0" } },
            h("table", { style: S.mdTable },
              h("thead", null, h("tr", null, block.header.map((cell, cellIndex) => h("th", {
                key: `h${cellIndex}`,
                style: { ...S.mdTableCell, textAlign: block.aligns[cellIndex] ?? "left", fontWeight: 600, background: COLOR.panel }
              }, inlineNodes(cell, `${key}-h${cellIndex}`, onOpenImage))))),
              h("tbody", null, block.rows.map((row, rowIndex) => h("tr", { key: `r${rowIndex}` },
                block.header.map((_cell, cellIndex) => h("td", {
                  key: `c${cellIndex}`,
                  style: { ...S.mdTableCell, textAlign: block.aligns[cellIndex] ?? "left" }
                }, inlineNodes(row[cellIndex] ?? "", `${key}-r${rowIndex}c${cellIndex}`, onOpenImage)))
              )))
            )
          ));
          return;
        }
        nodes.push(h("p", { key, style: S.mdParagraph }, inlineNodes(block.text, key, onOpenImage)));
      });

      return h("div", null, nodes);
    }

    // ── styles ────────────────────────────────────────────────────────────
    const S = {
      root: {
        display: "flex",
        flexDirection: "column",
        height: "100%",
        minHeight: 0,
        background: COLOR.bg,
        color: COLOR.text,
        fontSize: "13px",
        overflow: "hidden"
      },
      header: {
        display: "flex",
        alignItems: "center",
        gap: "8px",
        padding: "10px 14px",
        borderBottom: `1px solid ${COLOR.border}`,
        flex: "0 0 auto",
        flexWrap: "wrap"
      },
      title: { fontSize: "15px", fontWeight: 600, marginRight: "2px" },
      counter: { fontSize: "12px", color: COLOR.dim },
      spacer: { flex: "1 1 auto" },
      btn: {
        display: "inline-flex",
        alignItems: "center",
        gap: "5px",
        padding: "5px 10px",
        borderRadius: "8px",
        border: `1px solid ${COLOR.border}`,
        background: COLOR.bg,
        color: COLOR.text,
        fontSize: "12px",
        cursor: "pointer",
        whiteSpace: "nowrap"
      },
      btnPrimary: {
        display: "inline-flex",
        alignItems: "center",
        gap: "5px",
        padding: "5px 12px",
        borderRadius: "8px",
        border: `1px solid ${COLOR.accent}`,
        background: COLOR.accent,
        color: "#fff",
        fontSize: "12px",
        cursor: "pointer",
        whiteSpace: "nowrap"
      },
      btnGhost: {
        border: "none",
        background: "transparent",
        color: COLOR.dim,
        cursor: "pointer",
        fontSize: "12px",
        padding: "3px 6px",
        borderRadius: "6px"
      },
      input: {
        flex: "0 1 200px",
        minWidth: "120px",
        padding: "5px 9px",
        borderRadius: "8px",
        border: `1px solid ${COLOR.border}`,
        background: COLOR.bg,
        color: COLOR.text,
        fontSize: "12px",
        outline: "none"
      },
      /**
       * One time window, as a chip.
       *
       * Four of these sit in a row, so they are tighter than a `btn`: the row has
       * to fit beside the search box and the unread/starred toggles without
       * pushing the refresh control off the header.
       */
      rangeChip: {
        display: "inline-flex",
        alignItems: "center",
        padding: "5px 9px",
        borderRadius: "999px",
        border: `1px solid ${COLOR.border}`,
        background: COLOR.bg,
        color: COLOR.dim,
        fontSize: "12px",
        cursor: "pointer",
        whiteSpace: "nowrap"
      },
      /** The same choice in the narrow column, where four chips do not fit. */
      rangeSelect: {
        flex: "0 0 auto",
        padding: "5px 7px",
        borderRadius: "8px",
        border: `1px solid ${COLOR.border}`,
        background: COLOR.bg,
        color: COLOR.text,
        fontSize: "12px",
        outline: "none"
      },
      /**
       * A line above the stream explaining what the time window did.
       *
       * Deliberately quiet — it is bookkeeping about the filter, not news — but
       * never hidden: an unexplained gap in a timeline is what sends a reader
       * back to checking dates by hand.
       */
      timeNotice: {
        padding: "7px 14px",
        fontSize: "11px",
        lineHeight: "16px",
        color: COLOR.dim,
        background: COLOR.layer2,
        borderBottom: `1px solid ${COLOR.border}`
      },
      /**
       * The line where today's news ends and the older backlog starts.
       *
       * It exists so the time filter has something visible to move: with a full
       * day of news, the rows above this mark are identical whichever window is
       * chosen, so without it switching to 今天 looks like a control that does
       * nothing. A filled strip rather than a hairline, because it has to be
       * findable while scrolling past it.
       */
      todayBoundary: {
        padding: "6px 14px",
        fontSize: "11px",
        lineHeight: "16px",
        color: COLOR.dim,
        background: COLOR.layer2,
        borderTop: `1px solid ${COLOR.border}`,
        borderBottom: `1px solid ${COLOR.border}`,
        textAlign: "center"
      },
      body: { display: "flex", flex: "1 1 auto", minHeight: 0, overflow: "hidden" },
      feedsPane: {
        width: "240px",
        flex: "0 0 auto",
        borderRight: `1px solid ${COLOR.border}`,
        background: COLOR.panel,
        overflowY: "auto",
        padding: "8px 6px"
      },
      listPane: {
        flex: "1 1 320px",
        minWidth: 0,
        overflowY: "auto",
        borderRight: `1px solid ${COLOR.border}`
      },
      readPane: { flex: "1 1 360px", minWidth: 0, overflowY: "auto", padding: "16px 20px" },
      feedRow: (active) => ({
        display: "flex",
        alignItems: "center",
        gap: "7px",
        width: "100%",
        textAlign: "left",
        padding: "7px 8px",
        borderRadius: "8px",
        border: "none",
        background: active ? "var(--dsw-alias-interactive-bg-active, #e8effb)" : "transparent",
        color: active ? COLOR.text : COLOR.dim,
        cursor: "pointer",
        fontSize: "12.5px",
        fontWeight: active ? 600 : 400
      }),
      badge: (tone) => ({
        flex: "0 0 auto",
        minWidth: tone === "unread" || tone === "error" ? "18px" : undefined,
        textAlign: "center",
        padding: "0 5px",
        borderRadius: "9px",
        fontSize: "11px",
        lineHeight: "17px",
        whiteSpace: "nowrap",
        background: tone === "error"
          ? "#fdecec"
          : tone === "unread"
            ? COLOR.accent
            : tone === "rsshub" ? `${COLOR.accent}1a` : tone === "noDate" ? "transparent" : COLOR.layer2,
        color: tone === "error"
          ? COLOR.danger
          : tone === "unread"
            ? "#fff"
            : tone === "rsshub" ? COLOR.accent : tone === "noDate" ? COLOR.faint : COLOR.dim,
        // The undated marker is a quiet outline rather than a filled pill: it
        // states a fact about the row, not a status worth attracting the eye.
        ...(tone === "noDate" ? { border: `1px solid ${COLOR.border}` } : {})
      }),
      feedName: { flex: "1 1 auto", minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" },
      itemRow: (active, read) => ({
        display: "block",
        width: "100%",
        textAlign: "left",
        padding: "10px 14px",
        border: "none",
        borderBottom: `1px solid ${COLOR.border}`,
        background: active ? "var(--dsw-alias-interactive-bg-active, #e8effb)" : "transparent",
        cursor: "pointer",
        color: read ? COLOR.dim : COLOR.text
      }),
      itemTitle: (read) => ({
        fontSize: "13px",
        fontWeight: read ? 400 : 600,
        lineHeight: "19px",
        marginBottom: "3px",
        display: "block"
      }),
      itemMeta: { fontSize: "11px", color: COLOR.faint, display: "flex", gap: "8px", flexWrap: "wrap" },
      itemSummary: {
        fontSize: "12px",
        color: COLOR.dim,
        lineHeight: "18px",
        marginTop: "4px",
        display: "-webkit-box",
        WebkitLineClamp: 2,
        WebkitBoxOrient: "vertical",
        overflow: "hidden"
      },
      empty: {
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        gap: "10px",
        height: "100%",
        padding: "40px 24px",
        color: COLOR.faint,
        textAlign: "center",
        fontSize: "13px"
      },
      banner: (tone) => ({
        margin: "10px 14px 0",
        padding: "8px 12px",
        borderRadius: "8px",
        fontSize: "12px",
        lineHeight: "18px",
        background: tone === "error" ? "#fdecec" : "#fff7e6",
        color: tone === "error" ? COLOR.danger : COLOR.warning,
        border: `1px solid ${tone === "error" ? "#f8d3d4" : "#ffe1b0"}`
      }),
      modal: {
        position: "fixed",
        inset: 0,
        zIndex: 2100,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        background: "rgba(15,18,22,0.42)"
      },
      modalCard: {
        width: "min(520px, calc(100vw - 40px))",
        maxHeight: "calc(100vh - 80px)",
        overflowY: "auto",
        background: COLOR.bg,
        border: `1px solid ${COLOR.border}`,
        borderRadius: "14px",
        padding: "18px 20px",
        boxShadow: "0 18px 48px rgba(0,0,0,0.22)"
      },
      label: { display: "block", fontSize: "12px", color: COLOR.dim, marginBottom: "5px" },
      // ── single-column presentation (the right Sidebar's tab) ──────────
      /** Chips, then the list — which the open item's detail replaces in place. */
      narrowBody: { display: "flex", flexDirection: "column", flex: "1 1 auto", minHeight: 0, overflow: "hidden" },
      chips: {
        display: "flex",
        alignItems: "center",
        gap: "6px",
        flex: "0 0 auto",
        padding: "8px 10px",
        overflowX: "auto",
        borderBottom: `1px solid ${COLOR.border}`
      },
      chip: (active) => ({
        display: "inline-flex",
        alignItems: "center",
        gap: "5px",
        flex: "0 0 auto",
        maxWidth: "200px",
        padding: "4px 9px",
        borderRadius: "999px",
        border: `1px solid ${active ? COLOR.accent : COLOR.border}`,
        background: active ? "var(--dsw-alias-interactive-bg-active, #e8effb)" : COLOR.bg,
        color: active ? COLOR.accent : COLOR.dim,
        fontSize: "12px",
        cursor: "pointer",
        whiteSpace: "nowrap"
      }),
      chipName: { minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" },
      narrowList: { flex: "1 1 auto", minHeight: 0, overflowY: "auto" },
      /**
       * The reading pane as one scrolling column.
       *
       * No top padding: the pinned bar below provides that space itself, and a
       * parent's padding would sit *above* the pinned strip — a transparent
       * gap for the article to scroll through, which is exactly the seam this
       * layout must not have.
       */
      narrowDetail: {
        flex: "1 1 auto",
        minHeight: 0,
        overflowY: "auto",
        // Written out rather than as a shorthand so the zero above the strip is
        // explicit and assertable.
        paddingTop: 0,
        paddingRight: "14px",
        paddingBottom: "20px",
        paddingLeft: "14px"
      },
      /**
       * The way back to the list, pinned to the top of the reading pane.
       *
       * Sticky rather than merely first: the pane scrolls as one column, so a
       * bar that scrolls away leaves a reader who has reached the end of a long
       * article with nothing to click. `top: 0` pins it to the top of that
       * scroll container, the negative side margins let it span the pane's
       * padding, and with no padding above the pane the strip's top edge *is*
       * the pane's top edge — so nothing can show above it. The opaque
       * background covers the body scrolling underneath, and the bottom border
       * is the only separation it needs.
       */
      detailBar: {
        position: "sticky",
        top: 0,
        zIndex: 2,
        display: "flex",
        alignItems: "center",
        // The way back holds the left edge and the article's controls the right,
        // so the bar reads as one row even when its two ends are far apart.
        justifyContent: "space-between",
        flexWrap: "wrap",
        gap: "8px",
        // Tight below: a bottom margin here would be a transparent gap between
        // the strip and the body, which is where the article peeked through.
        margin: "0 -14px 0",
        padding: "6px 14px 5px",
        background: COLOR.bg,
        borderBottom: `1px solid ${COLOR.border}`
      },
      /**
       * The row the article's controls sit in, right-aligned.
       *
       * It lives *inside* the pinned way-back bar rather than floating over the
       * pane. An absolutely-positioned element at `top: 0` would be painted over
       * by that bar — it is sticky with a z-index and an opaque background — so
       * taking part in its layout is what actually puts the controls in the
       * top-right corner for good, and one pinned bar is also less chrome than
       * two. `flex-end` is what holds them to the right edge; menus at 2300 stay
       * far above everything here.
       */
      actionBar: {
        position: "relative",
        display: "flex",
        flexWrap: "wrap",
        justifyContent: "flex-end",
        alignItems: "center",
        gap: "6px"
      },
      /**
       * The cluster the controls sit in.
       *
       * No fill of its own: it shares the pinned bar's opaque background, and a
       * second translucent layer over an opaque one would only muddy it. The
       * border and radius are enough to read it as one group. It may wrap to a
       * second row on a narrow column, which is why the gaps are stated as row
       * *and* column.
       */
      actionCapsule: {
        display: "flex",
        alignItems: "center",
        flexWrap: "wrap",
        justifyContent: "flex-end",
        rowGap: "6px",
        columnGap: "6px",
        maxWidth: "100%",
        padding: "2px 3px",
        borderRadius: "10px",
        border: `1px solid ${COLOR.border}`,
        pointerEvents: "auto"
      },
      /**
       * The reading pane's own style hook.
       *
       * The pane's content sits inside a flex wrapper, and a title's top margin
       * collapses through it — leaving a margin-sized gap directly under the
       * pinned bar, which the article then shows through as it scrolls. Margin
       * collapse cannot be expressed with inline styles and cannot be cleared
       * from the ancestor, so this one scoped rule does it. The id is unique to
       * this pane, so it cannot reach anything else in DSH.
       */
      detailStyle: "#rss-reader-detail > * > *:first-child { margin-top: 0; }",
      // ── right-click menu ──────────────────────────────────────────────
      menuLayer: { position: "fixed", inset: 0, zIndex: 2300 },
      menu: {
        position: "fixed",
        minWidth: "172px",
        padding: "5px",
        borderRadius: "10px",
        border: `1px solid ${COLOR.border}`,
        background: COLOR.bg,
        boxShadow: "0 12px 32px rgba(0,0,0,0.20)"
      },
      menuHint: {
        margin: "0 0 4px",
        padding: "5px 10px",
        fontSize: "11px",
        color: COLOR.faint,
        borderBottom: `1px solid ${COLOR.border}`,
        overflow: "hidden",
        textOverflow: "ellipsis",
        whiteSpace: "nowrap"
      },
      menuItem: (danger) => ({
        display: "block",
        width: "100%",
        textAlign: "left",
        padding: "7px 10px",
        border: "none",
        borderRadius: "7px",
        background: "transparent",
        color: danger ? COLOR.danger : COLOR.text,
        fontSize: "12.5px",
        cursor: "pointer"
      }),
      // ── left Sidebar footer launcher ──────────────────────────────────
      footAction: {
        display: "inline-flex",
        alignItems: "center",
        gap: "7px",
        width: "100%",
        padding: "6px 8px",
        border: "none",
        borderRadius: "8px",
        background: "transparent",
        color: COLOR.dim,
        fontSize: "12px",
        cursor: "pointer",
        textAlign: "left"
      },
      // ── settings (设置 → RSS 阅读器) ──────────────────────────────────
      /** Mirrors the shipped rows: full-width, hairline separator. */
      prefRow: {
        display: "flex",
        alignItems: "center",
        gap: "8px",
        width: "100%",
        padding: "16px 0",
        borderBottom: `0.5px solid ${COLOR.border}`
      },
      prefText: { display: "flex", flexDirection: "column", flex: "1 1 auto", gap: "4px", minWidth: 0, paddingRight: "24px" },
      prefTitle: { color: COLOR.text, fontSize: "14px", fontWeight: 400, lineHeight: "22px" },
      prefDesc: { color: COLOR.faint, fontSize: "12px", fontWeight: 400, lineHeight: "18px" },
      prefError: { color: COLOR.danger, fontSize: "12px", lineHeight: "18px", marginTop: "4px" },
      hubOk: { color: COLOR.success, fontSize: "12px", lineHeight: "18px", marginTop: "4px" },
      settingsSection: { display: "flex", flexDirection: "column", width: "100%" },
      settingsLead: { color: COLOR.dim, fontSize: "12px", lineHeight: "18px", marginBottom: "8px" },
      settingsBlock: { marginTop: "26px", paddingTop: "18px", borderTop: `0.5px solid ${COLOR.border}` },
      settingsBlockTitle: { color: COLOR.text, fontSize: "14px", lineHeight: "22px" },
      settingsBlockLead: { color: COLOR.faint, fontSize: "12px", lineHeight: "18px", marginTop: "4px" },
      orderRow: {
        display: "flex",
        alignItems: "center",
        gap: "8px",
        padding: "6px 0",
        borderBottom: `0.5px solid ${COLOR.border}`
      },
      orderIndex: {
        flex: "0 0 auto",
        minWidth: "18px",
        textAlign: "right",
        color: COLOR.faint,
        fontSize: "12px",
        fontVariantNumeric: "tabular-nums"
      },
      orderName: {
        flex: "1 1 auto",
        minWidth: 0,
        overflow: "hidden",
        textOverflow: "ellipsis",
        whiteSpace: "nowrap",
        color: COLOR.text,
        fontSize: "13px"
      },
      prefSwitch: (on, busy) => ({
        flex: "0 0 auto",
        position: "relative",
        width: "40px",
        height: "22px",
        padding: 0,
        borderRadius: "11px",
        border: `1px solid ${on ? COLOR.accent : COLOR.borderStrong}`,
        background: on ? COLOR.accent : COLOR.layer2,
        cursor: busy ? "default" : "pointer",
        opacity: busy ? 0.6 : 1,
        transition: "background 120ms ease, border-color 120ms ease"
      }),
      prefKnob: (on) => ({
        position: "absolute",
        top: "2px",
        left: on ? "20px" : "2px",
        width: "16px",
        height: "16px",
        borderRadius: "50%",
        background: "#fff",
        boxShadow: "0 1px 2px rgba(0,0,0,0.25)",
        transition: "left 120ms ease"
      }),
      // ── explore (the RSSHub route catalogue) ──────────────────────────
      /** Wider than the other dialogs: a catalogue needs room for two columns of text. */
      exploreCard: {
        width: "min(680px, calc(100vw - 40px))",
        maxHeight: "calc(100vh - 80px)",
        display: "flex",
        flexDirection: "column",
        background: COLOR.bg,
        border: `1px solid ${COLOR.border}`,
        borderRadius: "14px",
        padding: "18px 20px",
        boxShadow: "0 18px 48px rgba(0,0,0,0.22)"
      },
      exploreBody: { flex: "1 1 auto", minHeight: "160px", overflowY: "auto", margin: "10px 0 0" },
      chipsRow: { display: "flex", flexWrap: "wrap", gap: "6px", marginTop: "10px" },
      nsRow: {
        display: "flex",
        alignItems: "center",
        gap: "8px",
        width: "100%",
        textAlign: "left",
        padding: "8px 10px",
        marginBottom: "4px",
        borderRadius: "8px",
        border: `1px solid ${COLOR.border}`,
        background: COLOR.bg,
        color: COLOR.text,
        cursor: "pointer",
        fontSize: "12.5px"
      },
      nsName: { display: "block", fontWeight: 600, lineHeight: "18px" },
      nsUrl: { display: "block", fontSize: "11px", color: COLOR.faint, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" },
      routeCard: {
        padding: "9px 10px",
        marginBottom: "6px",
        borderRadius: "9px",
        border: `1px solid ${COLOR.border}`,
        background: COLOR.panel
      },
      routeBadges: { display: "flex", alignItems: "center", gap: "6px", flexWrap: "wrap", marginTop: "5px" },
      mono: {
        fontFamily: "var(--ds-font-family-code, ui-monospace, monospace)",
        fontSize: "11px",
        color: COLOR.faint,
        wordBreak: "break-all",
        lineHeight: "16px"
      },
      paramBox: { marginTop: "10px", paddingTop: "10px", borderTop: `1px dashed ${COLOR.border}` },
      paramRow: { marginBottom: "9px" },
      paramLabel: { display: "block", fontSize: "11.5px", color: COLOR.dim, marginBottom: "4px" },
      // ── discovery candidates ──────────────────────────────────────────
      candidate: {
        display: "flex",
        alignItems: "center",
        gap: "8px",
        width: "100%",
        padding: "8px 10px",
        borderRadius: "8px",
        border: `1px solid ${COLOR.border}`,
        background: COLOR.bg,
        cursor: "pointer",
        textAlign: "left"
      },
      // ── markdown typography ───────────────────────────────────────────
      mdParagraph: { margin: "0 0 12px", fontSize: "13.5px", lineHeight: "23px", wordBreak: "break-word" },
      mdHeading: (level) => ({
        margin: level <= 2 ? "20px 0 10px" : "16px 0 8px",
        fontSize: level === 1 ? "19px" : level === 2 ? "17px" : level === 3 ? "15px" : "14px",
        fontWeight: 600,
        lineHeight: "26px",
        wordBreak: "break-word"
      }),
      mdLink: { color: COLOR.accent, textDecoration: "none", wordBreak: "break-word" },
      mdCode: {
        padding: "1px 5px",
        borderRadius: "4px",
        background: COLOR.layer2,
        fontFamily: "var(--ds-font-family-code, ui-monospace, monospace)",
        fontSize: "12px"
      },
      mdPre: {
        margin: "12px 0",
        padding: "12px 14px",
        borderRadius: "8px",
        background: COLOR.panel,
        border: `1px solid ${COLOR.border}`,
        overflowX: "auto",
        fontSize: "12.5px",
        lineHeight: "20px",
        whiteSpace: "pre"
      },
      mdQuote: {
        margin: "12px 0",
        padding: "2px 0 2px 14px",
        borderLeft: `3px solid ${COLOR.borderStrong}`,
        color: COLOR.dim
      },
      mdList: { margin: "0 0 12px", paddingLeft: "22px", fontSize: "13.5px", lineHeight: "23px" },
      mdListItem: { marginBottom: "4px", wordBreak: "break-word" },
      mdTable: { borderCollapse: "collapse", fontSize: "12.5px", width: "100%" },
      mdTableCell: { border: `1px solid ${COLOR.border}`, padding: "6px 9px", verticalAlign: "top" },
      // ── collapsed image group ─────────────────────────────────────────
      mdImageGroup: {
        // A picture block sits between paragraphs, so it keeps paragraph
        // rhythm rather than the wide gap a document footer would take.
        margin: "4px 0 12px",
        border: `1px solid ${COLOR.border}`,
        borderRadius: "10px",
        background: COLOR.panel,
        overflow: "hidden"
      },
      mdImageToggle: {
        display: "flex",
        alignItems: "center",
        gap: "8px",
        width: "100%",
        padding: "9px 12px",
        border: "none",
        background: "transparent",
        color: COLOR.text,
        fontSize: "12.5px",
        cursor: "pointer",
        textAlign: "left"
      },
      mdImageGrid: {
        display: "grid",
        gridTemplateColumns: "repeat(auto-fit, minmax(160px, 1fr))",
        gap: "10px",
        padding: "0 12px 12px"
      },
      mdFigure: { margin: 0, minWidth: 0 },
      // ── an image that sat inside a sentence ───────────────────────────
      mdInlineChip: {
        display: "inline-flex",
        alignItems: "center",
        gap: "4px",
        maxWidth: "100%",
        margin: "0 2px",
        padding: "1px 7px",
        borderRadius: "999px",
        border: `1px solid ${COLOR.border}`,
        background: COLOR.layer2,
        color: COLOR.dim,
        fontSize: "12px",
        lineHeight: "18px",
        cursor: "pointer",
        verticalAlign: "baseline",
        overflow: "hidden",
        textOverflow: "ellipsis",
        whiteSpace: "nowrap"
      },
      mdInlineImage: {
        maxWidth: "100%",
        maxHeight: "240px",
        borderRadius: "6px",
        verticalAlign: "middle",
        border: `1px solid ${COLOR.border}`
      },
      mdInlineFailed: { color: COLOR.faint, fontSize: "12px" },
      mdImageBox: { position: "relative", minHeight: "60px" },
      mdImage: {
        width: "100%",
        height: "auto",
        maxHeight: "320px",
        objectFit: "contain",
        borderRadius: "8px",
        background: COLOR.bg,
        border: `1px solid ${COLOR.border}`
      },
      mdImageOverlay: {
        position: "absolute",
        inset: 0,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        fontSize: "11px",
        color: COLOR.faint
      },
      mdImageFallback: {
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        height: "60px",
        fontSize: "11px",
        color: COLOR.faint,
        border: `1px dashed ${COLOR.border}`,
        borderRadius: "8px"
      },
      mdFigcaption: {
        marginTop: "5px",
        fontSize: "11px",
        color: COLOR.faint,
        lineHeight: "16px",
        wordBreak: "break-word"
      },
      footer: {
        flex: "0 0 auto",
        borderTop: `1px solid ${COLOR.border}`,
        padding: "6px 14px",
        fontSize: "11px",
        color: COLOR.faint,
        display: "flex",
        gap: "12px",
        flexWrap: "wrap"
      }
    };

    /** A button that keeps the shared look. */
    function Button({ children, onClick, variant, disabled, title, style }) {
      const base = variant === "primary" ? S.btnPrimary : variant === "ghost" ? S.btnGhost : S.btn;
      return h("button", {
        type: "button",
        title,
        disabled,
        onClick,
        style: { ...base, ...(disabled ? { opacity: 0.55, cursor: "default" } : {}), ...style }
      }, children);
    }

    /** The sidebar glyph: an RSS mark drawn inline so no asset is shipped. */
    function RssGlyph({ size = 16, active }) {
      const color = active ? COLOR.accent : "currentColor";
      return h("svg", {
        width: size,
        height: size,
        viewBox: "0 0 24 24",
        fill: "none",
        "aria-hidden": "true",
        focusable: "false"
      },
        h("circle", { cx: 6.2, cy: 17.8, r: 2.2, fill: color }),
        h("path", {
          d: "M4 10.6a9.4 9.4 0 0 1 9.4 9.4",
          stroke: color,
          strokeWidth: 2.1,
          strokeLinecap: "round"
        }),
        h("path", {
          d: "M4 4.6A15.4 15.4 0 0 1 19.4 20",
          stroke: color,
          strokeWidth: 2.1,
          strokeLinecap: "round"
        })
      );
    }

    /**
     * The RSS launcher beside Settings in the left Sidebar's foot.
     *
     * The panel is reachable from the right Sidebar's own add control as well;
     * this is the one-click way in, so the tab does not have to be discovered.
     */
    function RssLauncher({ wide, onOpen }) {
      return h("button", {
        type: "button",
        title: "在右侧边栏打开 RSS 阅读器",
        style: S.footAction,
        onClick: onOpen
      },
        h(RssGlyph, { size: 16 }),
        wide === false ? null : h("span", null, "RSS 阅读器")
      );
    }

    /**
     * The RSS tab body for the right Sidebar.
     *
     * That Sidebar is a narrow column, so the panel runs single-column there:
     * the item list, the detail in its place, and a way back to the list.
     */
    function RssSidebarPanel(props) {
      return h(RssPanel, { ...(props ?? {}), variant: "sidebar" });
    }

    /**
     * One preference row in DSH's own settings (设置 → 通用).
     *
     * The rows live there rather than inside the panel because they govern the
     * panel from outside: the sidebar row decides whether the panel has an
     * entry at all, and reaching that switch through the entry it removes would
     * be a trap. Both rows draw themselves — the seat supplies no copy, no
     * label and no props — so the switch, its wording and its write path are
     * all here.
     *
     * @param {object} props - `{prefKey, title, description, onLabel, offLabel}`.
     */
    function RssPreferenceRow({ prefKey, title, description, onLabel, offLabel }) {
      const prefs = usePrefs();
      const [busy, setBusy] = useState(false);
      const [error, setError] = useState("");
      const on = prefs[prefKey] === true;
      const toggle = () => {
        setBusy(true);
        setError("");
        void setPref(prefKey, !on)
          .catch((err) => setError(messageOf(err)))
          .finally(() => setBusy(false));
      };
      return h("div", { style: S.prefRow },
        h("div", { style: S.prefText },
          h("div", { style: S.prefTitle }, title),
          h("div", { style: S.prefDesc }, description),
          error.length > 0 ? h("div", { style: S.prefError }, error) : null
        ),
        h("button", {
          type: "button",
          role: "switch",
          "aria-checked": on,
          "aria-label": title,
          disabled: busy,
          title: on ? offLabel : onLabel,
          style: S.prefSwitch(on, busy),
          onClick: toggle
        }, h("span", { style: S.prefKnob(on) }))
      );
    }

    /**
     * The provider groups in the model catalog, defensively.
     *
     * A catalog that failed to load, or one from a harness build without the
     * field, must leave an empty picker rather than throw during render.
     *
     * @param {object|null} catalog - the host's catalog.
     * @returns {object[]} provider groups.
     */
    function providerGroupsOf(catalog) {
      return Array.isArray(catalog?.groups) ? catalog.groups : [];
    }

    /**
     * The models offered for one provider choice.
     *
     * An empty choice means "follow the default", so it lists the provider the
     * host says is in force — otherwise the reader would have to guess a name to
     * pin the very model already being used.
     *
     * @param {object[]} groups - provider groups.
     * @param {string} provider - the chosen provider, or "".
     * @param {object|null} inForce - the route the host reports.
     * @returns {object[]} models.
     */
    function modelsForProvider(groups, provider, inForce) {
      const wanted = provider.length > 0 ? provider : (inForce?.provider ?? "");
      const group = groups.find((candidate) => candidate.id === wanted);
      return Array.isArray(group?.models) ? group.models : [];
    }

    /**
     * The selectable thinking intensities for one route.
     *
     * Only meaningful for a concrete provider and model: the default route's
     * efforts are the adapter's business, and offering them under "默认" would
     * write a preference the reader did not really choose.
     *
     * @param {object[]} groups - provider groups.
     * @param {string} provider - chosen provider.
     * @param {string} model - chosen model.
     * @returns {object[]} efforts.
     */
    function effortsForRoute(groups, provider, model) {
      if (provider.length === 0 || model.length === 0) return [];
      const found = modelsForProvider(groups, provider, null).find((candidate) => candidate.id === model);
      const efforts = found?.reasoning?.efforts;
      return Array.isArray(efforts) ? efforts : [];
    }

    /**
     * One-off options for a stored route the catalog does not list.
     *
     * A provider can be registered in one build and absent in the next, and a
     * select whose value matches no option renders as the first entry — which
     * would show the reader a different model from the one in force.
     *
     * @param {object[]} groups - provider groups.
     * @param {string} provider - the stored provider.
     * @param {string} model - the stored model.
     * @returns {object[]} extra option elements.
     */
    function adhocRouteOptions(groups, provider, model) {
      const extra = [];
      if (provider.length > 0 && !groups.some((group) => group.id === provider)) {
        extra.push(h("option", { key: `extra-p-${provider}`, value: provider }, `${provider}（不在当前目录中）`));
      }
      const models = modelsForProvider(groups, provider, null);
      if (model.length > 0 && !models.some((candidate) => candidate.id === model)) {
        extra.push(h("option", { key: `extra-m-${model}`, value: model }, `${model}（不在当前目录中）`));
      }
      return extra;
    }

    /**
     * Split a body into the top-level blocks a reader sees.
     *
     * Deliberately the same rule the host uses when it builds the translation
     * prompt (blank lines separate blocks, fenced code keeps its blank lines):
     * both sides cut the same source the same way, which is what lets a returned
     * paragraph be placed under the paragraph it came from. The browser half is
     * a hand-written module loader bundle and cannot import the host's copy, so
     * the rule is duplicated here — if it changes, change it in
     * `lib/translate.js` too.
     *
     * @param {string} markdown - the body.
     * @returns {string[]} blocks in source order.
     */
    function splitDisplayBlocks(markdown) {
      const text = typeof markdown === "string" ? markdown.replace(/\r\n?/g, "\n") : "";
      if (text.trim().length === 0) return [];
      const blocks = [];
      let current = [];
      let fence = null;
      const flush = () => {
        const joined = current.join("\n").trim();
        if (joined.length > 0) blocks.push(joined);
        current = [];
      };
      for (const line of text.split("\n")) {
        const marker = /^\s*(`{3,}|~{3,})/.exec(line);
        if (fence === null && marker !== null) fence = marker[1][0];
        else if (fence !== null && marker !== null) fence = null;
        if (fence === null && line.trim().length === 0) {
          flush();
          continue;
        }
        current.push(line);
      }
      flush();
      return blocks;
    }

    /**
     * Pair each source block with the translation returned for it.
     *
     * All-or-nothing, exactly like the host's alignment: a mismatched count
     * means the model merged or dropped paragraphs, and pairing from there would
     * print one paragraph's translation under another.
     *
     * @param {string} markdown - the original body.
     * @param {string[]} segments - translated blocks, in source order.
     * @returns {Array<{source: string, translated: string}>} pairs, or [].
     */
    function zipBlocks(markdown, segments) {
      const blocks = splitDisplayBlocks(markdown);
      if (blocks.length === 0 || !Array.isArray(segments) || segments.length !== blocks.length) return [];
      return blocks.map((source, index) => ({
        source,
        translated: typeof segments[index] === "string" ? segments[index] : ""
      }));
    }

    /**
     * The key identifying one item within its feed.
     *
     * Item ids are only unique inside a feed, so the feed id is part of the key.
     * One definition because the same string is built when opening an item, when
     * restoring it, and when marking its row selected — three places that must
     * agree.
     *
     * @param {string} feedId - the feed.
     * @param {object} item - the item.
     * @returns {string} the key.
     */
    function itemKeyOf(feedId, item) {
      return `${feedId}::${item.id || item.link}`;
    }

    /** Friendly label for a translation target code. */    function targetLabel(code) {
      const known = {
        "zh-CN": "简体中文",
        "zh-TW": "繁體中文",
        en: "English",
        ja: "日本語",
        ko: "한국어",
        fr: "Français",
        de: "Deutsch",
        es: "Español",
        ru: "Русский",
        pt: "Português"
      };
      return known[code] ?? code ?? "";
    }

    /**
     * Full-screen image viewer.
     *
     * The reading pane keeps images collapsed and small; this is how a reader
     * actually inspects one without leaving the panel.
     */
    function Lightbox({ image, onClose }) {
      useEffect(() => {
        const onKey = (event) => {
          if (event.key === "Escape") onClose();
        };
        window.addEventListener("keydown", onKey);
        return () => window.removeEventListener("keydown", onKey);
      }, [onClose]);
      return h("div", {
        style: { ...S.modal, zIndex: 2300, cursor: "zoom-out" },
        onClick: onClose
      }, h("div", {
        style: { maxWidth: "92vw", maxHeight: "92vh", display: "flex", flexDirection: "column", gap: "8px" },
        onClick: (event) => event.stopPropagation()
      },
        h("img", {
          src: image.url,
          alt: image.alt,
          referrerPolicy: "no-referrer",
          style: { maxWidth: "92vw", maxHeight: "84vh", objectFit: "contain", borderRadius: "8px", background: "#fff" }
        }),
        h("div", { style: { display: "flex", gap: "10px", alignItems: "center", justifyContent: "center" } },
          image.alt.length > 0
            ? h("span", { style: { color: "#fff", fontSize: "12px", opacity: 0.85, maxWidth: "60vw", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" } }, image.alt)
            : null,
          h("a", {
            href: image.url,
            target: "_blank",
            rel: "noreferrer noopener",
            style: { color: "#fff", fontSize: "12px", opacity: 0.85 }
          }, "原图 ↗"),
          h("button", {
            type: "button",
            onClick: onClose,
            style: { ...S.btnGhost, color: "#fff", opacity: 0.9, fontSize: "13px" }
          }, "关闭 ✕")
        )
      ));
    }

    /**
     * One discovered subscription candidate.
     *
     * Clicking it subscribes immediately: the user has already made a choice,
     * so requiring a second confirming click would only add friction.
     */
    function CandidateRow({ candidate, onPick, busy }) {
      const isRsshub = candidate.kind === "rsshub";
      return h("button", {
        type: "button",
        disabled: busy,
        title: candidate.url,
        onClick: () => onPick(candidate),
        style: { ...S.candidate, ...(busy ? { opacity: 0.6, cursor: "default" } : {}) }
      },
        h("span", { style: { flex: "1 1 auto", minWidth: 0 } },
          h("span", { style: { display: "flex", alignItems: "center", gap: "6px", marginBottom: "2px" } },
            h("span", { style: { fontSize: "12.5px", color: COLOR.text, fontWeight: 500, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" } },
              candidate.title || candidate.url),
            h("span", { style: S.badge(isRsshub ? "rsshub" : "page") }, isRsshub ? "RSSHub" : "站点")
          ),
          h("span", { style: { display: "block", fontSize: "11px", color: COLOR.faint, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" } },
            candidate.url)
        ),
        h("span", { style: { flex: "0 0 auto", fontSize: "11px", color: COLOR.accent } }, busy ? "…" : "订阅 →")
      );
    }

    /**
     * Add-subscription dialog with feed discovery.
     *
     * A plain URL is accepted directly, but discovery is the point: paste any
     * page (`https://space.bilibili.com/2267573`) and the host reports both the
     * page's own feeds and the RSSHub routes that can generate one. RSSHub is
     * what makes sites with no feed of their own subscribable at all.
     */
    function AddFeedDialog({ onClose, onSubmit, busy, suggestions }) {
      const [url, setUrl] = useState("");
      const [group, setGroup] = useState("");
      const [finding, setFinding] = useState(false);
      const [found, setFound] = useState(suggestions ?? null);
      const [findError, setFindError] = useState("");
      const inputRef = useRef(null);

      useEffect(() => {
        inputRef.current?.focus();
        const onKey = (event) => {
          if (event.key === "Escape") onClose();
        };
        window.addEventListener("keydown", onKey);
        return () => window.removeEventListener("keydown", onKey);
      }, [onClose]);

      const submit = () => {
        const value = url.trim();
        if (value.length === 0 || busy) return;
        onSubmit({ url: value, group: group.trim() });
      };

      /** Ask the host what feeds this URL could be. */
      const find = async () => {
        const value = url.trim();
        if (value.length === 0 || finding) return;
        setFinding(true);
        setFindError("");
        setFound(null);
        try {
          const data = await call("/discover", { method: "POST", body: { url: value } });
          setFound({
            candidates: data.candidates ?? [],
            rsshub: data.rsshub ?? { enabled: false },
            pageIsFeed: data.pageIsFeed === true,
            pageError: data.pageError ?? "",
            finalUrl: data.finalUrl ?? value
          });
        } catch (error) {
          setFindError(messageOf(error));
        } finally {
          setFinding(false);
        }
      };

      /** Subscribe to a discovered candidate. */
      const pick = (candidate) => {
        if (busy) return;
        onSubmit({ url: candidate.url, group: group.trim(), title: candidate.title ?? "" });
      };

      const candidates = found?.candidates ?? [];
      const domainRoutes = found?.rsshub?.domainRoutes ?? [];
      const rsshubOff = found !== null && found.rsshub?.enabled === false;

      return h("div", {
        style: S.modal,
        onClick: (event) => {
          event.stopPropagation();
          onClose();
        }
      }, h("div", {
        style: S.modalCard,
        onClick: (event) => event.stopPropagation()
      },
        h("div", { style: { fontSize: "15px", fontWeight: 600, marginBottom: "4px" } }, "添加订阅源"),
        h("div", { style: { fontSize: "12px", color: COLOR.dim, marginBottom: "14px", lineHeight: "18px" } },
          "粘贴 RSS/Atom 地址，或任意网页 / 用户主页地址，然后点「查找订阅源」——插件会读取页面自身声明的订阅源，并通过 RSSHub 查找可生成的订阅源。"),
        h("label", { style: S.label, htmlFor: "rss-add-url" }, "订阅源地址 / 网页地址"),
        h("div", { style: { display: "flex", gap: "8px" } },
          h("input", {
            id: "rss-add-url",
            ref: inputRef,
            style: { ...S.input, flex: "1 1 auto", width: "auto", padding: "8px 10px", fontSize: "13px", boxSizing: "border-box" },
            placeholder: "https://example.com/feed.xml",
            value: url,
            disabled: busy || finding,
            onChange: (event) => setUrl(event.target.value),
            onKeyDown: (event) => {
              if (event.key === "Enter") submit();
            }
          }),
          h(Button, {
            onClick: () => void find(),
            disabled: finding || busy || url.trim().length === 0,
            title: "查找这个地址可用的订阅源"
          }, finding ? "查找中…" : "🔍 查找")
        ),

        // ── discovery results ──────────────────────────────────────────
        candidates.length > 0
          ? h("div", { style: { marginTop: "14px" } },
              h("div", { style: { fontSize: "12px", color: COLOR.dim, marginBottom: "6px" } },
                `找到 ${candidates.length} 个订阅源，点击即可订阅：`),
              h("div", { style: { display: "flex", flexDirection: "column", gap: "6px", maxHeight: "260px", overflowY: "auto" } },
                candidates.map((candidate, index) => h(CandidateRow, {
                  key: `${candidate.url}-${index}`,
                  candidate,
                  busy,
                  onPick: pick
                })))
            )
          : null,

        found !== null && candidates.length === 0
          ? h("div", { style: { marginTop: "14px", padding: "10px 12px", borderRadius: "8px", background: COLOR.panel, fontSize: "12px", lineHeight: "18px", color: COLOR.dim } },
              found.pageIsFeed
                ? "这个地址本身就是一个订阅源，直接点「添加并获取」即可。"
                : found.pageError.length > 0 && rsshubOff
                  ? `无法读取该网页：${found.pageError}`
                  : `没有找到可用的订阅源。${found.rsshub?.reason ?? ""}`,
              domainRoutes.length > 0
                ? h("div", { style: { marginTop: "8px" } },
                    h("div", { style: { marginBottom: "4px" } },
                      `${found.rsshub.site || "该站点"}在 RSSHub 中共有 ${found.rsshub.domainRouteTotal} 条路由，但它们需要更具体的页面地址（例如某个用户 / 仓库 / 频道页），可参考：`),
                    h("div", { style: { display: "flex", flexDirection: "column", gap: "3px" } },
                      domainRoutes.slice(0, 6).map((route, index) => h("div", {
                        key: `${route.route}-${index}`,
                        style: { fontSize: "11px", color: COLOR.faint, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }
                      }, `${route.title} — ${route.route}`))))
                  : null
            )
          : null,

        findError.length > 0
          ? h("div", { style: { ...S.banner("error"), margin: "14px 0 0" } }, findError)
          : null,

        h("label", { style: { ...S.label, marginTop: "12px" }, htmlFor: "rss-add-group" }, "分组（可选）"),
        h("input", {
          id: "rss-add-group",
          style: { ...S.input, flex: "none", width: "100%", padding: "8px 10px", fontSize: "13px", boxSizing: "border-box" },
          placeholder: "例如：技术、新闻",
          value: group,
          disabled: busy,
          onChange: (event) => setGroup(event.target.value),
          onKeyDown: (event) => {
            if (event.key === "Enter") submit();
          }
        }),
        h("div", { style: { display: "flex", gap: "8px", justifyContent: "flex-end", marginTop: "18px" } },
          h(Button, { onClick: onClose, disabled: busy }, "取消"),
          h(Button, { variant: "primary", onClick: submit, disabled: busy || url.trim().length === 0 },
            busy ? "正在获取…" : "添加并获取")
        )
      ));
    }

    /**
     * A menu anchored at the pointer, dismissed by pressing anywhere else.
     *
     * Unsubscribing is the one destructive action in the panel, so it lives
     * behind this: a deliberate right-click, then a confirmation. A stray
     * left-click on a feed row can no longer destroy a subscription.
     */
    function ContextMenu({ x, y, hint, items, onClose }) {
      const width = 182;
      const height = 34 + items.length * 31;
      // Opened near the window's edge the card would be clipped out of reach,
      // so it is pulled back inside. Measuring is skipped where there is no
      // window to measure (the render tests), keeping the given point.
      const viewportWidth = typeof window === "undefined" ? 0 : window.innerWidth || 0;
      const viewportHeight = typeof window === "undefined" ? 0 : window.innerHeight || 0;
      const left = viewportWidth > 0 ? Math.max(6, Math.min(x, viewportWidth - width - 6)) : x;
      const top = viewportHeight > 0 ? Math.max(6, Math.min(y, viewportHeight - height - 6)) : y;
      return h("div", {
        style: S.menuLayer,
        // The layer covers the panel, so any press outside the card lands here.
        onClick: onClose,
        onContextMenu: (event) => {
          event.preventDefault();
          onClose();
        }
      },
        h("div", {
          style: { ...S.menu, left: `${left}px`, top: `${top}px` },
          onClick: (event) => event.stopPropagation()
        },
          hint === undefined || hint === null
            ? null
            : h("div", { style: { ...S.menuHint, borderBottom: `1px solid ${COLOR.border}` }, title: hint }, hint),
          items.map((item) => h("button", {
            key: item.key,
            type: "button",
            style: S.menuItem(item.danger === true),
            onClick: () => {
              onClose();
              item.onSelect();
            }
          }, item.label))
        )
      );
    }

    /**
     * The panel's own yes/no confirmation.
     *
     * The browser's `confirm()` blocks the whole page and cannot say what is
     * about to be lost, which is exactly what this dialog is for.
     */
    function ConfirmDialog({ title, message, confirmLabel, cancelLabel, onConfirm, onCancel }) {
      return h("div", { style: S.modal, onClick: onCancel },
        h("div", { style: S.modalCard, onClick: (event) => event.stopPropagation() },
          h("div", { style: { fontSize: "15px", fontWeight: 600, marginBottom: "10px" } }, title),
          h("div", { style: { fontSize: "12.5px", lineHeight: "20px", color: COLOR.dim } }, message),
          h("div", { style: { display: "flex", justifyContent: "flex-end", gap: "8px", marginTop: "18px" } },
            h(Button, { onClick: onCancel }, cancelLabel ?? "取消"),
            h(Button, {
              variant: "primary",
              onClick: onConfirm,
              style: { borderColor: COLOR.danger, background: COLOR.danger }
            }, confirmLabel)
          )
        )
      );
    }

    /**
     * Fetch older articles for one subscription.
     *
     * A feed is a window: many blogs publish only the newest few entries and
     * never an older one, so no amount of refreshing reaches last year. The
     * articles are still on the site's own archive page, and this dialog is how
     * the reader asks for a bounded number of them.
     *
     * @param {object} props - `{ feed, onClose, onSubmit, busy, progress, note }`.
     */
    function HistoryDialog({ feed, onClose, onSubmit, busy, progress, note }) {
      const [archiveUrl, setArchiveUrl] = useState(() => guessArchiveUrl(feed));
      const [limit, setLimit] = useState("20");

      const count = Math.max(1, Math.min(Math.floor(Number(limit)) || 20, 50));
      return h("div", { style: S.modal, onClick: busy ? undefined : onClose },
        h("div", { style: { ...S.modalCard, maxWidth: "440px" }, onClick: (event) => event.stopPropagation() },
          h("div", { style: { fontSize: "15px", fontWeight: 600, marginBottom: "6px" } },
            `抓取更早的文章`),
          h("div", { style: { fontSize: "12.5px", lineHeight: "20px", color: COLOR.dim, marginBottom: "12px" } },
            `订阅源只会给出最近若干条，「${feed.title}」当前有 ${feed.items.length} 条。`
            + `填一个列有往期文章的归档页地址，插件会从里面找出与已订阅地址同一形态的链接，按最新在前逐篇抓取。`),
          h("div", { style: { marginBottom: "10px" } },
            h("div", { style: S.paramLabel }, "归档页地址"),
            h("input", {
              "aria-label": "归档页地址",
              style: { ...S.input, width: "100%", boxSizing: "border-box", padding: "8px 10px" },
              value: archiveUrl,
              disabled: busy,
              placeholder: "https://example.com/archives/",
              onChange: (event) => setArchiveUrl(event.target.value)
            })
          ),
          h("div", { style: { marginBottom: "10px" } },
            h("div", { style: S.paramLabel }, "抓取篇数（上限 50）"),
            h("input", {
              "aria-label": "抓取篇数",
              style: { ...S.input, width: "100%", boxSizing: "border-box", padding: "8px 10px" },
              type: "number",
              min: "1",
              max: "50",
              value: limit,
              disabled: busy,
              onChange: (event) => setLimit(event.target.value)
            })
          ),
          h("div", { style: { fontSize: "11.5px", lineHeight: "17px", color: COLOR.faint } },
            `请求之间会间隔约 0.3 秒，${count} 篇大约需要 ${Math.ceil(count * 0.3 + count * 0.4)} 秒左右。已经订阅过的文章不会重复抓取。`),
          note.length > 0 ? h("div", { style: { fontSize: "12px", color: COLOR.dim, marginTop: "10px" } }, note) : null,
          h("div", { style: { display: "flex", justifyContent: "flex-end", gap: "8px", marginTop: "16px" } },
            h(Button, { disabled: busy, onClick: onClose }, busy ? "关闭对话框" : "取消"),
            h(Button, {
              variant: "primary",
              disabled: busy || archiveUrl.trim().length === 0,
              onClick: () => void onSubmit({ archiveUrl: archiveUrl.trim(), limit: count })
            }, busy ? (progress > 0 ? `抓取中…（已 ${progress} 篇）` : "抓取中…") : "开始抓取")
          )
        )
      );
    }

    /**
     * A plausible archive URL for a feed, as a starting point for the input.
     *
     * The feed's own item links are the best hint: their common directory is
     * usually where the archive lives. The site link is the fallback.
     *
     * @param {object} feed - the subscription record.
     * @returns {string} a URL, or "" when nothing can be guessed.
     */
    function guessArchiveUrl(feed) {
      const links = (feed.items ?? []).map((item) => item.link).filter((link) => typeof link === "string" && link.length > 0);
      for (const link of links) {
        try {
          const parsed = new URL(link);
          // The directory the articles live in, which is where a site usually
          // keeps its index too: `/blog/2026/09/x.html` suggests `/blog/`.
          const segments = parsed.pathname.split("/").filter((segment) => segment.length > 0);
          const first = segments[0] ?? "";
          return first.length > 0 ? `${parsed.origin}/${first}/` : `${parsed.origin}/`;
        } catch {
          /* try the next one */
        }
      }
      return typeof feed.siteLink === "string" ? feed.siteLink : "";
    }

    /**
     * The RSSHub route catalogue: browse, search, and subscribe in one click.
     *
     * The add dialog answers "I have an address"; this answers "what is worth
     * subscribing to?". RSSHub's community maintains a few thousand routes, and
     * the host serves them as pages of a compact projection — the panel never
     * sees the multi-megabyte registry.
     *
     * @param {object} props - `{ onSubscribe, onClose }`.
     */
    function ExploreDialog({ onSubscribe, onClose }) {
      const [query, setQuery] = useState("");
      /** The debounced query: typing is not a request per keystroke. */
      const [search, setSearch] = useState("");
      const [category, setCategory] = useState("");
      /** The drilled-into namespace; empty means "browse the site list". */
      const [namespace, setNamespace] = useState("");
      const [offset, setOffset] = useState(0);
      const [page, setPage] = useState(null);
      const [loading, setLoading] = useState(true);
      const [loadError, setLoadError] = useState("");
      /** The route whose parameter form is open, by `namespace+path`. */
      const [editing, setEditing] = useState(null);
      const [values, setValues] = useState({});
      const [added, setAdded] = useState({});
      const [note, setNote] = useState("");
      const [formError, setFormError] = useState("");
      const [subscribing, setSubscribing] = useState(false);

      useEffect(() => {
        const timer = setTimeout(() => setSearch(query.trim()), 250);
        return () => clearTimeout(timer);
      }, [query]);

      useEffect(() => {
        let cancelled = false;
        const params = new URLSearchParams();
        if (search.length > 0) params.set("q", search);
        if (category.length > 0) params.set("category", category);
        if (namespace.length > 0) params.set("namespace", namespace);
        if (offset > 0) params.set("offset", String(offset));
        setLoading(true);
        setLoadError("");
        void (async () => {
          try {
            const data = await call(`/explore?${params.toString()}`);
            if (!cancelled) setPage(data);
          } catch (err) {
            if (!cancelled) setLoadError(messageOf(err));
          } finally {
            if (!cancelled) setLoading(false);
          }
        })();
        return () => {
          cancelled = true;
        };
      }, [search, category, namespace, offset]);

      const routeKey = (route) => `${route.namespace}${route.path}`;
      const base = page?.base ?? "";
      const routes = page?.routes ?? [];
      const namespaces = page?.namespaces ?? [];
      const categories = page?.categories ?? [];
      const loaded = (page?.offset ?? 0) + routes.length;

      /** Open one route's parameter form, prefilled from its own example. */
      const openForm = (route) => {
        setNote("");
        setFormError("");
        setEditing(routeKey(route));
        setValues({ ...(route.values ?? {}) });
      };

      /**
       * Turn the filled parameters into a feed URL and subscribe.
       *
       * The URL is built by the host, not here: the route template, the
       * optional-parameter rules and the example all live in one place, and the
       * host can refuse a route the instance no longer has.
       */
      const subscribe = async (route) => {
        setSubscribing(true);
        setFormError("");
        try {
          const built = await call("/explore/url", {
            method: "POST",
            body: { namespace: route.namespace, path: route.path, values }
          });
          const title = typeof built.title === "string" && built.title.length > 0 ? built.title : route.name;
          const result = await onSubscribe({ url: built.url, title, namespace: route.namespace });
          setAdded((current) => ({ ...current, [routeKey(route)]: true }));
          setEditing(null);
          setNote(result.warning.length > 0
            ? `已订阅「${title}」，但${result.warning}`
            : `已订阅「${title}」`);
        } catch (err) {
          setFormError(messageOf(err));
        } finally {
          setSubscribing(false);
        }
      };

      /** The badges that say whether a route can work on this instance. */
      const badges = (route) => {
        const out = [];
        if (route.flags.config.length > 0) {
          out.push(h("span", {
            key: "config",
            style: S.badge("error"),
            title: `这条路由需要实例侧配置：${route.flags.config.join("、")}。公共实例上通常无法使用。`
          }, "需配置"));
        }
        if (route.flags.antiCrawler) out.push(h("span", { key: "anti", style: S.badge("rsshub"), title: "站点有反爬措施，公共实例可能取不到内容" }, "反爬"));
        if (route.flags.puppeteer) out.push(h("span", { key: "pptr", style: S.badge("rsshub"), title: "需要实例开启 Playwright / Puppeteer" }, "需浏览器"));
        if (route.flags.podcast) out.push(h("span", { key: "pod", style: S.badge("rsshub") }, "播客"));
        if (route.example.length > 0) {
          out.push(h("span", { key: "example", style: { ...S.mono, flex: "1 1 auto", minWidth: 0 }, title: `官方示例：${route.example}` },
            `示例 ${route.example}`));
        }
        return out.length === 0 ? null : h("div", { style: S.routeBadges }, out);
      };

      /** The parameter form of one open route. */
      const form = (route) => {
        const fieldId = (name) => `rss-explore-${route.namespace}-${name}`;
        const set = (name, value) => setValues((current) => ({ ...current, [name]: value }));
        return h("div", { style: S.paramBox },
          route.parameters.length === 0
            ? h("div", { style: { fontSize: "11.5px", color: COLOR.dim } }, "这条路由不需要参数。")
            : route.parameters.map((parameter) => h("div", { key: parameter.name, style: S.paramRow },
                h("label", { style: S.paramLabel, htmlFor: fieldId(parameter.name) },
                  parameter.name,
                  parameter.optional
                    ? h("span", { style: { color: COLOR.faint } }, " 可选")
                    : h("span", { style: { color: COLOR.danger } }, " *")),
                parameter.options.length > 0
                  ? h("select", {
                      id: fieldId(parameter.name),
                      style: { ...S.input, width: "100%", boxSizing: "border-box" },
                      value: values[parameter.name] ?? "",
                      onChange: (event) => set(parameter.name, event.target.value)
                    },
                      h("option", { value: "" }, parameter.optional ? "（不填）" : "请选择"),
                      parameter.options.map((option) => h("option", { key: option.value, value: option.value },
                        `${option.label}（${option.value}）`)))
                  : h("input", {
                      id: fieldId(parameter.name),
                      style: { ...S.input, width: "100%", boxSizing: "border-box" },
                      value: values[parameter.name] ?? "",
                      placeholder: parameter.default.length > 0
                        ? `默认 ${parameter.default}`
                        : parameter.optional ? "可不填" : `填写 ${parameter.name}`,
                      onChange: (event) => set(parameter.name, event.target.value)
                    }),
                parameter.description.length > 0
                  ? h("div", { style: { fontSize: "11px", color: COLOR.faint, lineHeight: "16px", marginTop: "3px" } }, parameter.description)
                  : null
              )),
          formError.length > 0 ? h("div", { style: { fontSize: "11.5px", color: COLOR.danger, marginTop: "6px" } }, formError) : null,
          h("div", { style: { display: "flex", alignItems: "center", gap: "8px", marginTop: "10px" } },
            h(Button, { variant: "primary", disabled: subscribing, onClick: () => void subscribe(route) },
              subscribing ? "订阅中…" : "订阅"),
            // A route template is namespace-relative; the example is a complete,
            // working path, which is what is worth showing here.
            h("span", { style: { ...S.mono, flex: "1 1 auto", minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" } },
              `${base}/${route.namespace}${route.example.length > 0 ? route.example.replace(new RegExp(`^/${route.namespace}`), "") : route.path}`)
          )
        );
      };

      /** One route row, with its form when open. */
      const routeRow = (route) => {
        const key = routeKey(route);
        const open = editing === key;
        return h("div", { key: `route:${key}`, style: S.routeCard },
          h("div", { style: { display: "flex", alignItems: "flex-start", gap: "8px" } },
            h("div", { style: { flex: "1 1 auto", minWidth: 0 } },
              h("div", { style: { fontSize: "13px", fontWeight: 600, lineHeight: "19px" } }, route.name),
              h("div", { style: S.mono }, `${route.namespace}${route.path}`),
              route.description.length > 0
                ? h("div", { style: { fontSize: "11.5px", color: COLOR.dim, lineHeight: "17px", marginTop: "3px" } }, route.description)
                : null,
              badges(route)
            ),
            added[key] === true
              ? h("span", { style: { flex: "0 0 auto", fontSize: "11px", color: COLOR.success } }, "已订阅")
              : h(Button, {
                  variant: open ? undefined : "primary",
                  onClick: () => (open ? setEditing(null) : openForm(route))
                }, open ? "收起" : "添加")
          ),
          open ? form(route) : null
        );
      };

      return h("div", {
        style: S.modal,
        onClick: (event) => {
          event.stopPropagation();
          onClose();
        }
      }, h("div", {
        style: S.exploreCard,
        onClick: (event) => event.stopPropagation()
      },
        h("div", { style: { display: "flex", alignItems: "center", gap: "8px" } },
          h("div", { style: { fontSize: "15px", fontWeight: 600 } }, "探索 RSSHub 订阅源"),
          h("span", { style: S.spacer }),
          h(Button, { onClick: onClose, title: "关闭" }, "✕")),
        h("div", { style: { fontSize: "12px", color: COLOR.dim, margin: "4px 0 12px", lineHeight: "18px" } },
          "浏览 RSSHub 社区维护的全部路由：按分类或站点找，点「添加」即可订阅。参数已按官方示例预填，可直接改。"),

        h("input", {
          style: { ...S.input, width: "100%", boxSizing: "border-box", padding: "8px 10px", fontSize: "13px" },
          placeholder: "搜索站点 / 路由名称 / 路径，例如 bilibili、热搜、/user/video",
          value: query,
          onChange: (event) => {
            setQuery(event.target.value);
            setOffset(0);
          }
        }),

        categories.length > 0
          ? h("div", { style: S.chipsRow },
              h("button", {
                key: "__all__",
                type: "button",
                style: S.chip(category === ""),
                onClick: () => {
                  setCategory("");
                  setOffset(0);
                }
              }, "全部"),
              categories.map((entry) => h("button", {
                key: entry.id,
                type: "button",
                title: `${entry.label}：${entry.count} 个站点`,
                style: S.chip(category === entry.id),
                onClick: () => {
                  setCategory(category === entry.id ? "" : entry.id);
                  setOffset(0);
                }
              }, entry.label)))
          : null,

        namespace.length > 0
          ? h("div", { style: { display: "flex", alignItems: "center", gap: "8px", marginTop: "10px" } },
              h(Button, {
                onClick: () => {
                  setNamespace("");
                  setOffset(0);
                  setEditing(null);
                },
                title: "返回站点列表"
              }, "← 返回"),
              h("span", { style: { fontSize: "12px", color: COLOR.dim } }, namespace))
          : null,

        loadError.length > 0 ? h("div", { style: { ...S.banner("error"), margin: "10px 0 0" } }, loadError) : null,
        note.length > 0 ? h("div", { style: { ...S.banner("info"), margin: "10px 0 0" } }, note) : null,

        h("div", { style: S.exploreBody },
          loading && page === null
            ? h("div", { style: { padding: "28px 0", textAlign: "center", color: COLOR.faint, fontSize: "12px" } },
                "正在读取 RSSHub 路由表…（首次要下载几 MB，之后走宿主缓存）")
            : routes.length === 0 && namespaces.length === 0
              ? h("div", { style: { padding: "28px 0", textAlign: "center", color: COLOR.faint, fontSize: "12px" } },
                  loadError.length > 0 ? "" : "没有匹配的订阅源，换个关键词试试")
              : [
                  ...namespaces.map((entry) => h("button", {
                    key: `ns:${entry.id}`,
                    type: "button",
                    style: S.nsRow,
                    onClick: () => {
                      setNamespace(entry.id);
                      setOffset(0);
                      setEditing(null);
                    }
                  },
                    h("span", { style: { flex: "1 1 auto", minWidth: 0 } },
                      h("span", { style: S.nsName }, entry.name),
                      entry.url.length > 0 ? h("span", { style: S.nsUrl }, entry.url) : null),
                    h("span", { style: S.badge("rsshub") }, `${entry.routes} 条`)
                  )),
                  ...routes.map(routeRow)
                ]
        ),

        h("div", { style: { display: "flex", alignItems: "center", gap: "8px", marginTop: "10px", fontSize: "11px", color: COLOR.faint } },
          h("span", null, page === null
            ? ""
            : `${routes.length} / ${page.total} 条路由${page.namespaceTotal > namespaces.length ? ` · ${page.namespaceTotal} 个站点` : ""}`),
          loaded < (page?.total ?? 0)
            ? h(Button, { onClick: () => setOffset(loaded) }, loading ? "载入中…" : "加载更多")
            : null,
          h("span", { style: S.spacer }),
          base.length > 0 ? h("span", { title: "路由表来源实例" }, base) : null)
      ));
    }

    /**
     * The RSS settings page (设置 → RSS 阅读器).
     *
     * Its own section rather than rows in 通用: these settings all belong to one
     * feature, and the subscription list with an explicit order is more than a
     * preference row can hold. The rows here are the same components the panel's
     * preferences use, so there is one write path, not two.
     */
    function RssSettingsSection() {
      const prefs = usePrefs();
      const [feeds, setFeeds] = useState(null);
      const [error, setError] = useState("");
      const [busy, setBusy] = useState(false);
      /** What the host says about RSSHub: whether it is on, and where. */
      const [hub, setHub] = useState(null);
      /** The instance URL as typed, before it is saved. */
      const [baseDraft, setBaseDraft] = useState("");
      const [hubBusy, setHubBusy] = useState(false);
      const [hubNote, setHubNote] = useState(null);
      /** The routes the translation picker may offer, and whether translation is on. */
      const [modelPick, setModelPick] = useState(null);
      /** A refusal from the translation picker's write path. */
      const [pickNote, setPickNote] = useState("");

      const savedBase = typeof prefs.rsshubBase === "string" ? prefs.rsshubBase : "";
      /** Whether the instance URL is the reader's own, or the plugin default. */
      const baseStored = storedPrefs().includes("rsshubBase");

      /**
       * Read what the host says about translation: whether it is on at all, and
       * which model routes can be chosen. Also reports the route in force, so
       * the picker can show a snapshot rather than silently diverging.
       */
      const loadModels = useCallback(async () => {
        let usable = false;
        let inForce = null;
        try {
          const info = await call("/translate");
          usable = info.available === true;
          if (usable) inForce = { provider: info.provider, model: info.model };
        } catch {
          // A profile without translation is a normal state, not an error: the
          // whole section simply does not appear.
        }
        if (!usable) {
          setModelPick({ usable: false, catalog: null, inForce: null });
          return;
        }
        try {
          const data = await call("/models");
          setModelPick({ usable: true, catalog: data.catalog ?? null, inForce, stored: data.stored ?? [] });
        } catch (err) {
          setModelPick({ usable: true, catalog: null, inForce, error: messageOf(err) });
        }
      }, []);

      useEffect(() => {
        void loadModels();
      }, [loadModels]);

      /** Ask the host where RSSHub points, optionally pinging the instance. */
      const probeHub = useCallback(async (check) => {
        try {
          const data = await call(`/rsshub${check === true ? "?check=1" : ""}`);
          setHub({ enabled: data.enabled === true, explore: data.explore === true, base: data.base ?? "" });
          if (typeof data.reachable === "object" && data.reachable !== null) {
            setHubNote(data.reachable.ok
              ? { ok: true, text: `实例可达（HTTP ${data.reachable.status}）` }
              : { ok: false, text: `实例没有响应：${data.reachable.error}` });
          }
          return data;
        } catch (err) {
          setHub({ enabled: false, explore: false, base: "" });
          setHubNote({ ok: false, text: messageOf(err) });
          return null;
        }
      }, []);

      useEffect(() => {
        let cancelled = false;
        void (async () => {
          try {
            // The order lives on the host, next to the subscriptions it orders.
            const data = await call("/state?items=0");
            if (!cancelled) setFeeds(data.state.feeds);
          } catch (err) {
            if (!cancelled) setError(messageOf(err));
          }
        })();
        void probeHub(false);
        return () => {
          cancelled = true;
        };
      }, [probeHub]);

      // A value that arrives from somewhere else (another tab, a cleared pref)
      // wins over whatever was typed but never saved.
      useEffect(() => {
        setBaseDraft(savedBase);
      }, [savedBase]);

      /** Persist an order, applied locally first so the row moves at once. */
      const saveOrder = async (ids) => {
        const previous = feeds;
        setBusy(true);
        setError("");
        setFeeds(reorderFeeds(feeds ?? [], ids));
        try {
          const data = await call("/feeds/order", { method: "PATCH", body: { ids } });
          setFeeds(data.state.feeds);
        } catch (err) {
          setError(messageOf(err));
          setFeeds(previous);
        } finally {
          setBusy(false);
        }
      };

      const move = (id, delta) => {
        const next = shiftId((feeds ?? []).map((feed) => feed.id), id, delta);
        if (next !== null) void saveOrder(next);
      };

      /**
       * Save the instance URL.
       *
       * The host refuses an address it cannot use, so the error lands here
       * rather than at the next lookup — and the check that follows says whether
       * the instance answered, which is the question the reader actually has.
       */
      const saveBase = async (value) => {
        setHubBusy(true);
        setHubNote(null);
        try {
          const data = await setPref("rsshubBase", value);
          const prefsNow = data?.prefs ?? {};
          setHub((current) => (current === null ? current : { ...current, base: prefsNow.rsshubBase ?? current.base }));
          const checked = await probeHub(true);
          if (checked !== null) setHubNote((note) => (note === null ? null : { ...note, text: `已保存。${note.text}` }));
        } catch (err) {
          setHubNote({ ok: false, text: messageOf(err) });
        } finally {
          setHubBusy(false);
        }
      };

      /** Persist one translation preference, reporting anything the host refuses. */
      const saveTranslatePref = async (key, value) => {
        setHubBusy(true);
        setPickNote("");
        try {
          await setPref(key, value);
        } catch (err) {
          setPickNote(messageOf(err));
        } finally {
          setHubBusy(false);
        }
      };

      /**
       * Choose a translation route.
       *
       * Provider and model are saved together: a provider whose model is empty
       * means "this provider's default model", which the host also accepts, so
       * the two selects never leave a half-written pair behind.
       */
      const pickRoute = async (provider, model) => {
        setHubBusy(true);
        setPickNote("");
        try {
          await setPref("translateProvider", provider);
          await setPref("translateModel", model);
        } catch (err) {
          setPickNote(messageOf(err));
        } finally {
          setHubBusy(false);
        }
      };

      /** Drop every translation-routing choice, so the defaults apply again. */
      const resetTranslateRoute = async () => {
        setHubBusy(true);
        setPickNote("");
        try {
          await setPref("translateProvider", "");
          await setPref("translateModel", "");
          await setPref("translateEffort", "");
        } catch (err) {
          setPickNote(messageOf(err));
        } finally {
          setHubBusy(false);
        }
      };

      const list = feeds ?? [];
      const hubAvailable = hub !== null && (hub.enabled || hub.explore);
      const dirty = baseDraft.trim() !== savedBase;

      // ── translation model picker ──
      const savedProvider = typeof prefs.translateProvider === "string" ? prefs.translateProvider : "";
      const savedModel = typeof prefs.translateModel === "string" ? prefs.translateModel : "";
      const savedEffort = typeof prefs.translateEffort === "string" ? prefs.translateEffort : "";
      const translateStored = storedPrefs().some((key) => key.startsWith("translate"));
      const providerGroups = providerGroupsOf(modelPick?.catalog);
      const routable = Array.isArray(modelPick?.catalog?.routableProviders)
        ? modelPick.catalog.routableProviders
        : providerGroups.map((group) => group.id);
      const inForce = modelPick?.inForce ?? null;
      // Say what is actually in force — including when a selection no longer
      // resolves, which is invisible in the selects themselves.
      const chosenProvider = savedProvider.length > 0 ? savedProvider : (inForce?.provider ?? "");
      const chosenModel = savedModel.length > 0 ? savedModel : (inForce?.model ?? "");
      const routeProblem = savedProvider.length > 0 && routable.length > 0 && !routable.includes(savedProvider)
        ? `当前选择的模型服务「${savedProvider}」在这个 profile 里没有挂载，翻译会失败。`
        : "";
      const translateSummary = routeProblem.length > 0
        ? routeProblem
        : `当前使用：${chosenProvider.length > 0 ? `${chosenProvider} / ${chosenModel.length > 0 ? chosenModel : "默认模型"}` : "跟随 DSH 默认模型"}`
          + `${savedEffort.length > 0 ? `，思考强度 ${savedEffort}` : ""}`
          + `${translateStored ? "（自定义）" : "（默认）"}`;

      return h("div", { style: S.settingsSection },
        h("div", { style: S.settingsLead },
          "RSS 阅读器的全部设置：面板入口、图片显示方式、订阅源顺序，以及 RSSHub 实例。"),

        h(RssPreferenceRow, {
          prefKey: "showSidebarEntry",
          title: "左侧栏入口",
          description: "在左侧栏显示 RSS 图标，点击在中间区域打开三栏阅读面板。关闭后仍可从左侧栏底部的「RSS 阅读器」按钮或右侧边栏打开。",
          onLabel: "点击隐藏左侧栏入口",
          offLabel: "点击显示左侧栏入口"
        }),
        h(RssPreferenceRow, {
          prefKey: "expandImages",
          title: "正文图片直接展开",
          description: "默认把正文里的图片折成一条可展开的提示，位置与原文一致，点开才加载。打开后图片直接显示在它原来的位置（仍然按需加载）。",
          onLabel: "点击改为默认折叠",
          offLabel: "点击改为直接展开"
        }),

        // The strip only exists in the right Sidebar's narrow presentation, so
        // this row is worded for that one — it does not affect the wide panel's
        // subscription column, which is where that layout manages its sources.
        h(RssPreferenceRow, {
          prefKey: "collapseFeeds",
          title: "收起订阅源栏",
          description: "把右侧边栏面板顶部的订阅源一行折叠起来，给条目腾出空间。折叠后表头的「▸」会显示当前筛的是哪个源，点它即可展开。",
          onLabel: "点击改为展开",
          offLabel: "点击改为折叠"
        }),

        h("div", { style: S.settingsBlock },
          h("div", { style: S.settingsBlockTitle }, "订阅源顺序"),
          h("div", { style: S.settingsBlockLead },
            "上下移动决定面板里的排列。也可以在阅读面板里直接拖动订阅源，或右键选「上移 / 下移」。"),
          error.length > 0 ? h("div", { style: S.prefError }, error) : null,
          feeds === null
            ? h("div", { style: S.settingsBlockLead }, "正在读取订阅源…")
            : list.length === 0
              ? h("div", { style: S.settingsBlockLead }, "还没有订阅任何 RSS 源。")
              : h("div", { style: { marginTop: "6px" } }, list.map((feed, index) => h("div", {
                  key: feed.id,
                  style: S.orderRow
                },
                  h("span", { style: S.orderIndex }, String(index + 1)),
                  h("span", { style: S.orderName, title: feed.url }, feed.title),
                  h(Button, {
                    disabled: busy || index === 0,
                    title: `把「${feed.title}」上移`,
                    onClick: () => move(feed.id, -1)
                  }, "↑"),
                  h(Button, {
                    disabled: busy || index === list.length - 1,
                    title: `把「${feed.title}」下移`,
                    onClick: () => move(feed.id, 1)
                  }, "↓")
                )))
        ),

        // ── translation model ──────────────────────────────────────────────
        // Only when the host can actually translate: a picker for a feature
        // that is switched off would be a lie.
        modelPick !== null && modelPick.usable
          ? h("div", { style: S.settingsBlock },
              h("div", { style: S.settingsBlockTitle }, "翻译模型"),
              h("div", { style: S.settingsBlockLead },
                "「译」按钮用哪个模型、想多深。留空 = 跟随插件配置；配置也留空时跟随你在 DSH 里选的默认模型。"),
              h("div", { style: { display: "flex", gap: "8px", flexWrap: "wrap", marginTop: "8px" } },
                h("select", {
                  "aria-label": "翻译模型服务",
                  style: { ...S.input, flex: "1 1 200px", minWidth: "150px", padding: "7px 10px", boxSizing: "border-box" },
                  value: savedProvider,
                  disabled: hubBusy,
                  onChange: (event) => void pickRoute(event.target.value, "")
                },
                  h("option", { value: "" },
                    modelPick.inForce === null ? "默认（跟随 DSH）" : `默认：${modelPick.inForce.provider}`),
                  // Every route the harness reports, so a model that is not the
                  // session default is still selectable — that is the whole
                  // point of choosing a lighter one for translation.
                  ...providerGroups.map((group) => h("option", { key: group.id, value: group.id }, group.name)),
                  ...adhocRouteOptions(providerGroups, savedProvider, savedModel)
                ),
                h("select", {
                  "aria-label": "翻译模型",
                  style: { ...S.input, flex: "1 1 200px", minWidth: "150px", padding: "7px 10px", boxSizing: "border-box" },
                  value: savedModel,
                  disabled: hubBusy,
                  onChange: (event) => void pickRoute(savedProvider.length > 0 ? savedProvider : (modelPick.inForce?.provider ?? ""), event.target.value)
                },
                  h("option", { value: "" }, "默认模型"),
                  ...modelsForProvider(providerGroups, savedProvider, modelPick.inForce)
                    .map((model) => h("option", { key: model.id, value: model.id }, model.name))
                ),
                effortsForRoute(providerGroups, savedProvider, savedModel).length > 0
                  ? h("select", {
                      "aria-label": "翻译思考强度",
                      style: { ...S.input, flex: "0 1 170px", minWidth: "130px", padding: "7px 10px", boxSizing: "border-box" },
                      value: savedEffort,
                      disabled: hubBusy,
                      onChange: (event) => void saveTranslatePref("translateEffort", event.target.value)
                    },
                      h("option", { value: "" }, "思考强度：模型默认"),
                      ...effortsForRoute(providerGroups, savedProvider, savedModel)
                        .map((effort) => h("option", { key: effort.id, value: effort.id }, effort.name))
                    )
                  : null,
                h(Button, {
                  disabled: hubBusy || !translateStored,
                  title: translateStored ? "清掉选择，回到插件配置 / DSH 默认" : "已经在用默认",
                  onClick: () => void resetTranslateRoute()
                }, "翻译模型：恢复默认")
              ),
              h("div", { style: { ...S.settingsBlockLead, marginTop: "6px" } }, translateSummary),
              // A reasoning model spends this budget before writing anything, so
              // "high" is what makes a long article's translation run out of room.
              h("div", { style: { ...S.settingsBlockLead, marginTop: "4px" } },
                "长文翻译失败多半是「思考」把输出额度用光了：换一个不做长推理的模型，或把思考强度调到最低，比调大额度更有效。"),
              modelPick.error !== undefined
                ? h("div", { style: S.prefError }, modelPick.error)
                : null,
              pickNote.length > 0 ? h("div", { style: S.prefError }, pickNote) : null
            )
          : null,

        // Only offered when the host actually runs RSSHub: a field that changes
        // a disabled feature would be a lie.
        hubAvailable
          ? h("div", { style: S.settingsBlock },
              h("div", { style: S.settingsBlockTitle }, "RSSHub 实例"),
              h("div", { style: S.settingsBlockLead },
                "「🔍 查找」与「🧭 探索」都走这个实例。官方实例在部分网络下不可达，换成自建或更近的实例即可，改完立即生效、不用重启。留空 = 回到插件配置里的默认值。"),
              h("div", { style: { display: "flex", gap: "8px", flexWrap: "wrap", marginTop: "8px" } },
                h("input", {
                  style: { ...S.input, flex: "1 1 220px", minWidth: "160px", padding: "7px 10px", boxSizing: "border-box" },
                  placeholder: "https://rsshub.app",
                  value: baseDraft,
                  disabled: hubBusy,
                  onChange: (event) => setBaseDraft(event.target.value),
                  onKeyDown: (event) => {
                    if (event.key === "Enter" && dirty) void saveBase(baseDraft);
                  }
                }),
                h(Button, {
                  variant: "primary",
                  disabled: hubBusy || !dirty,
                  title: dirty ? "保存这个实例地址" : "地址没有变化",
                  onClick: () => void saveBase(baseDraft)
                }, hubBusy ? "…" : "保存"),
                h(Button, {
                  disabled: hubBusy,
                  title: "向该实例发一个请求，看它是否响应",
                  onClick: () => void saveBase(savedBase)
                }, "测试连接"),
                baseStored
                  ? h(Button, {
                      disabled: hubBusy,
                      title: "清空自定义地址，回到插件配置的默认实例",
                      onClick: () => void saveBase("")
                    }, "恢复默认")
                  : null
              ),
              h("div", { style: { ...S.settingsBlockLead, marginTop: "6px" } },
                baseStored ? `当前使用自定义实例：${savedBase}` : `当前使用默认实例：${savedBase}`),
              hubNote === null
                ? null
                : h("div", { style: hubNote.ok ? S.hubOk : S.prefError }, hubNote.text)
            )
          : null
      );
    }

    /**
     * The reader panel: subscriptions, item stream, and reading pane.
     *
     * Data is pulled from the host API; the component keeps only view state
     * (selection, filters, search text).
     *
     * `props.variant` selects the presentation: absent means the roomy
     * three-pane form used by the centre panel, `"sidebar"` the single-column
     * form the right Sidebar's narrow tab needs.
     */
    function RssPanel(props) {
      const singleColumn = props?.variant === "sidebar";
      const [state, setState] = useState(null);
      const [loading, setLoading] = useState(true);
      const [error, setError] = useState("");
      const [notice, setNotice] = useState("");
      const [refreshing, setRefreshing] = useState(false);
      const [selectedFeed, setSelectedFeed] = useState(null);
      const [selectedItemKey, setSelectedItemKey] = useState(null);
      const [query, setQuery] = useState("");
      const [unreadOnly, setUnreadOnly] = useState(false);
      const [starredOnly, setStarredOnly] = useState(false);
      /**
       * The time window the stream is scoped to.
       *
       * Defaults to `"all"`: the reader's habit is a full timeline, and the
       * window is there for when they go looking for today's news — not as a
       * new default that silently hides things.
       */
      const [timeRange, setTimeRange] = useState("all");
      const [adding, setAdding] = useState(false);
      const [addBusy, setAddBusy] = useState(false);
      const [addError, setAddError] = useState("");
      /** Discovery results handed to the dialog after a failed add. */
      const [addSuggestions, setAddSuggestions] = useState(null);
      /** The subscription whose older articles are being fetched, if any. */
      const [historyFor, setHistoryFor] = useState(null);
      const [historyBusy, setHistoryBusy] = useState(false);
      /** How many articles the running backfill has requested so far. */
      const [historyProgress, setHistoryProgress] = useState(0);
      /** The backfill's running note: progress, then the outcome. */
      const [historyNote, setHistoryNote] = useState("");
      // The open item's full body, fetched on demand (`/item`), plus the
      // translation state for it.
      const [body, setBody] = useState(null);
      const [bodyLoading, setBodyLoading] = useState(false);
      /**
       * Which body the reading pane shows: the original, the translation only,
       * or the two interleaved paragraph by paragraph.
       */
      const [translationView, setTranslationView] = useState("original");
      const [translating, setTranslating] = useState(false);
      const [translateTarget, setTranslateTarget] = useState("");
      const [translateInfo, setTranslateInfo] = useState(null);
      const [lightbox, setLightbox] = useState(null);
      const didAutoRefresh = useRef(false);
      /** The open right-click menu: `{ feed, x, y }`, or `null` when closed. */
      const [feedMenu, setFeedMenu] = useState(null);
      /** The feed awaiting unsubscribe confirmation — the menu's second step. */
      const [pendingRemove, setPendingRemove] = useState(null);
      /** Whether the RSSHub catalogue browser is open. */
      const [exploring, setExploring] = useState(false);
      /** What the host says about RSSHub, probed once so no button can only fail. */
      const [rsshubInfo, setRsshubInfo] = useState(null);
      /** The feed id currently being dragged, so a drop knows what it carries. */
      const [dragging, setDragging] = useState(null);
      // Whether the reader folded the subscription-source strip away. A
      // preference rather than local state: folding it is how a reader makes
      // room for the items, and having it spring back on every open would make
      // the control not worth using.
      const prefs = usePrefs();
      // The identity of this array changes when the host answers, which is what
      // tells the restore effect below that the read has settled.
      const storedReady = useStoredPrefs();
      const feedsCollapsed = prefs.collapseFeeds === true;
      // Named up here rather than beside the pane, because the header's fold
      // label has to say which source the items are filtered to while the strip
      // is hidden — otherwise folding would lose the reader's place. Derived
      // from the same `state` the feed list below is, so the two cannot drift.
      const activeFeed = selectedFeed === null
        ? null
        : (state?.feeds ?? []).find((feed) => feed.id === selectedFeed) ?? null;

      /** Load the current state from the host. */
      const load = useCallback(async (options = {}) => {
        try {
          const data = await call("/state");
          setState(data.state);
          setError("");
        } catch (err) {
          setError(messageOf(err));
        } finally {
          setLoading(false);
        }
      }, []);

      // Initial load.
      useEffect(() => {
        void load();
      }, [load]);

      // The panel reads the preferences itself rather than trusting the plugin
      // body to have done it: `loadPrefs` coalesces, so the body's startup read
      // and this one are the same request, and the panel still gets a real value
      // when it is mounted on its own.
      useEffect(() => {
        void loadPrefs();
      }, []);

      /**
       * Auto-dismiss a progress notice after two seconds.
       *
       * The notice banner only ever carries success and status ("已刷新 3/4 个源",
       * "翻译完成"); failures go to the error banner instead. A confirmation that
       * stays until dismissed keeps demanding attention it no longer needs, so it
       * leaves on its own — while an error, which the reader may still have to
       * act on, waits to be closed. Any new notice restarts the wait, and
       * clearing one cancels the pending timer so it cannot hide a later one.
       */
      useEffect(() => {
        if (notice.length === 0) return undefined;
        const timer = setTimeout(() => setNotice(""), NOTICE_AUTO_DISMISS_MS);
        return () => clearTimeout(timer);
      }, [notice]);

      // ── remembering the reading position ────────────────────────────────
      // The panel is unmounted while the reader is elsewhere — that is what
      // "closing the RSS reader" does — so its React state cannot be the memory.
      // The host keeps three plain values instead, and the panel restores from
      // them on mount and writes them back as the reader moves.

      /** Whether the stored position has been applied to this mounting. */
      const restoredRef = useRef(false);
      /** The position already written back, so the restore is not echoed. */
      const memoryRef = useRef({ feedId: null, itemKey: null });

      useEffect(() => {
        // Both inputs have to be in hand: the stored values, and the feed list
        // the stored feed is validated against. Waiting for the list is also why
        // the "already restored" flag is only set once it has arrived.
        if (restoredRef.current || !prefsReady() || state === null) return;
        restoredRef.current = true;
        const storedFeed = readPrefs().lastFeedId ?? "";
        const storedItem = readPrefs().lastItemKey ?? "";
        // A feed that no longer exists must not be restored: an unknown id
        // filters the list down to nothing, which reads as "the reader has no
        // items" rather than "that subscription is gone". The item half cannot
        // be resolved here either, since the feed list has not arrived yet — a
        // stale one simply does not match anything later.
        const knownFeed = feeds.some((feed) => feed.id === storedFeed);
        if (storedFeed.length > 0 && knownFeed) {
          memoryRef.current = { feedId: storedFeed, itemKey: storedItem };
          setSelectedFeed(storedFeed);
          // Rebuilt with the feed rather than stored full: an item key is
          // `<feedId>::<itemId>`, and the feed half is stored separately.
          if (storedItem.length > 0) setSelectedItemKey(itemKeyOf(storedFeed, { id: storedItem }));
        } else {
          memoryRef.current = { feedId: "", itemKey: "" };
        }
      }, [storedReady, state]);

      /**
       * Write the reading position back to the host.
       *
       * Two keys rather than one blob, so a panel opened in between does not
       * have to guess whether the feed and the item were written together; when
       * both change in the same interaction they are packaged atomically anyway.
       *
       * Called from the interactions themselves rather than from an effect on
       * the selection state: the interaction is the moment worth remembering,
       * the identity check makes a repeat a no-op, and nothing has to watch a
       * derived value to notice.
       *
       * @param {string} feedId - the selected feed, or "" for all.
       * @param {string} itemId - the open item's id, or "".
       */
      const storePosition = useCallback((feedId, itemId) => {
        if (feedId === memoryRef.current.feedId && itemId === memoryRef.current.itemKey) return;
        memoryRef.current = { feedId, itemKey: itemId };
        void setPref("lastFeedId", feedId).catch(() => {});
        void setPref("lastItemKey", itemId).catch(() => {});
      }, []);

      /**
       * The position within the open article, in the pane's own scroll units.
       *
       * Held in a ref rather than state: it changes on every scroll frame, and
       * re-rendering the panel for that would be absurd.
       */
      const detailScrollRef = useRef(0);
      /** The scroll container itself, so a restored offset can be applied. */
      const detailPaneRef = useRef(null);
      /** Hides the one programmatic scroll from the listener. */
      const restoreScrollRef = useRef(false);
      /** The pending debounced write, so a later scroll replaces it. */
      const scrollWriteRef = useRef(undefined);

      /**
       * The same three things for the *list*, which is a separate scroll box.
       *
       * The list has one problem the body does not: opening an article replaces
       * it in the narrow layout, so a debounced write armed by its last scroll
       * never fires — clearing this timer when the selection changes (a few
       * lines down) kills it. Whatever it is going to write is therefore written
       * synchronously at the moment the reader leaves the list, in `openItem`;
       * the timer below only covers the case where they scroll the list and then
       * close the panel without opening anything.
       */
      const listScrollRef = useRef(0);
      const listPaneRef = useRef(null);
      const listScrollWriteRef = useRef(undefined);
      /**
       * The offset a restore just applied, so the scroll event it fires is not
       * mistaken for the reader moving — and this very write not repeated.
       *
       * A number rather than a flag, unlike the body's guard: the body's guard
       * can stay `true` because the body never re-renders without a new article,
       * while the list re-renders on every state refresh. A stuck flag would then
       * swallow the next genuine scroll.
       */
      const listRestoreTopRef = useRef(null);

      /**
       * Store the current offset, after the reader has stopped moving.
       *
       * The timer has to be armed by the scroll itself: the offset lives in a
       * ref, so no effect can depend on it without re-rendering on every frame —
       * and a write that is only scheduled when the *article* changes records
       * the offset the article opened at (zero) and never the one reached.
       */
      const scheduleScrollWrite = useCallback(() => {
        if (scrollWriteRef.current !== undefined) clearTimeout(scrollWriteRef.current);
        scrollWriteRef.current = setTimeout(() => {
          scrollWriteRef.current = undefined;
          const value = detailScrollRef.current > 0 ? String(Math.round(detailScrollRef.current)) : "";
          if (value === (readPrefs().lastScrollTop ?? "")) return;
          void setPref("lastScrollTop", value).catch(() => {});
        }, SCROLL_MEMORY_DEBOUNCE_MS);
      }, []);

      /**
       * The next article starts at its top.
       *
       * Returning to the list deliberately keeps the remembered offset: the
       * reader asked for the list, and if they come back to this article the
       * position they had reached is exactly what the memory is for. The offset
       * is scoped to the article by the key stored beside it, so it cannot leak
       * onto a different one.
       */
      useEffect(() => {
        if (scrollWriteRef.current !== undefined) {
          clearTimeout(scrollWriteRef.current);
          scrollWriteRef.current = undefined;
        }
        detailScrollRef.current = 0;
      }, [selectedItemKey]);

      // Nothing else runs after a restore, so the value it applied is written
      // once here — the identity check makes that a no-op when it is unchanged.
      useEffect(() => {
        scheduleScrollWrite();
      }, [body, scheduleScrollWrite]);

      /**
       * Remember where the list was scrolled to, after the reader stops moving.
       *
       * The same shape as {@link scheduleScrollWrite}, and for the same reason:
       * the offset lives in a ref because it changes on every scroll frame.
       */
      const scheduleListScrollWrite = useCallback(() => {
        if (listScrollWriteRef.current !== undefined) clearTimeout(listScrollWriteRef.current);
        listScrollWriteRef.current = setTimeout(() => {
          listScrollWriteRef.current = undefined;
          // Scrolling back to the top writes nothing: the stored value is then
          // already empty or absent, and the comparison below is the same
          // "unchanged means no request" rule the article's offset follows.
          const value = listScrollRef.current > 0 ? String(Math.round(listScrollRef.current)) : "";
          if (value === readPrefs().lastListScrollTop) return;
          if (value === "" && readPrefs().lastListScrollTop === undefined) return;
          void setPref("lastListScrollTop", value).catch(() => {});
        }, SCROLL_MEMORY_DEBOUNCE_MS);
      }, []);

      /**
       * Whether the list was visible on the previous render.
       *
       * The restore has to run on the transition *into* visibility, and only
       * then. Restoring on every render would fight the reader as they scroll;
       * restoring on mount alone would miss the case that matters, since opening
       * an article replaces the list in the narrow layout and mounting it again is
       * exactly what "← 返回列表" does.
       */
      const listShownRef = useRef(false);

      /**
       * Put the list back where it was, whenever it becomes visible again.
       *
       * The value applied is read back from the element rather than assumed: the
       * list only renders the newest 400 items, so a list that has since grown
       * shorter clamps the offset, and remembering the offset that was *asked for*
       * would then write the pre-clamp value back as soon as the reader opened an
       * article. Reading it back both keeps the refs truthful and tells us whether
       * the browser moved at all — when it did, the scroll event that follows is
       * ours, not the reader's, and must not be recorded as a new position.
       */
      useEffect(() => {
        const shown = selectedItemKey === null;
        const wasShown = listShownRef.current;
        listShownRef.current = shown;
        if (!shown || wasShown) return;
        const pane = listPaneRef.current;
        if (pane === null) return;
        const stored = Number.parseInt(readPrefs().lastListScrollTop ?? "", 10);
        const offset = Number.isFinite(stored) && stored > 0 ? stored : 0;
        if (offset === 0) return;
        pane.scrollTop = offset;
        const applied = pane.scrollTop;
        listScrollRef.current = applied;
        listRestoreTopRef.current = applied > 0 ? applied : null;
      }, [selectedItemKey]);

      /**
       * Record the list's offset as the reader scrolls it.
       *
       * The one event the restore itself fires carries the offset the restore
       * applied, and is skipped so that a programmatic jump is not mistaken for
       * the reader moving. Any other offset clears that guard, so a restore the
       * browser clamped or refused cannot leave the list untracked.
       */
      const handleListScroll = useCallback((event) => {
        const top = event?.currentTarget?.scrollTop ?? 0;
        if (listRestoreTopRef.current !== null && Math.round(top) === listRestoreTopRef.current) return;
        listRestoreTopRef.current = null;
        listScrollRef.current = top;
        scheduleListScrollWrite();
      }, [scheduleListScrollWrite]);

      /**
       * Switch the active source and show the list again.
       *
       * Every entry point goes through here. Picking a different source is a
       * request to see *its* items, so staying on the previously open article —
       * which may not even belong to the newly chosen source — would leave the
       * reader looking at something they did not ask for and having to find
       * their way back by hand.
       *
       * @param {string|null} feedId - the feed to filter to, or null for all.
       */
      const selectFeed = useCallback((feedId) => {
        setSelectedFeed(feedId);
        setSelectedItemKey(null);
        // A source change is a position worth remembering, and it clears the
        // open article in the same breath.
        storePosition(feedId ?? "", "");
        // The restored offset belongs to the list the reader was reading, so a
        // different source starts at its top: those are different items, and an
        // offset carried across would land them in the middle of a list they have
        // never seen. Written as well as zeroed, or a later reopen of the panel
        // would restore the offset this branch just discarded.
        if (listScrollWriteRef.current !== undefined) {
          clearTimeout(listScrollWriteRef.current);
          listScrollWriteRef.current = undefined;
        }
        listScrollRef.current = 0;
        listRestoreTopRef.current = null;
        // Same rule again: a value that is already empty or absent stays untouched.
        if (readPrefs().lastListScrollTop !== undefined && readPrefs().lastListScrollTop !== "") {
          void setPref("lastListScrollTop", "").catch(() => {});
        }
      }, [storePosition]);

      /** Refresh every feed (or one), then re-read state. */
      const refresh = useCallback(async (ids, options = {}) => {
        setRefreshing(true);
        setError("");
        setNotice("");
        try {
          const data = await call("/refresh", {
            method: "POST",
            body: { ids, force: options.force === true }
          });
          setState(data.state);
          const summary = data.summary;
          const parts = [`已刷新 ${summary.refreshed}/${summary.results.length} 个源`];
          if (summary.added > 0) parts.push(`新增 ${summary.added} 条`);
          if (summary.failed > 0) parts.push(`${summary.failed} 个失败`);
          setNotice(parts.join("，"));
        } catch (err) {
          setError(messageOf(err));
        } finally {
          setRefreshing(false);
        }
      }, []);

      // Refresh on first open when the cache looks stale.
      useEffect(() => {
        if (state === null || didAutoRefresh.current) return;
        didAutoRefresh.current = true;
        if ((state.feeds ?? []).length > 0 && isStale(state.totals?.lastFetched ?? "", 30)) {
          void refresh(undefined);
        }
      }, [state, refresh]);

      /**
       * Fetch older articles for one subscription.
       *
       * The host does the work — one request per article with a gap between
       * them — so this only reports progress by polling nothing: it times the
       * expected duration and, more usefully, states the outcome when the
       * answer arrives. The dialog stays open so a second, deeper run is one
       * click away.
       */
      const fetchHistory = async (feed, options) => {
        setHistoryBusy(true);
        setHistoryProgress(0);
        setHistoryNote("正在读取归档页…");
        try {
          const data = await call("/history", {
            method: "POST",
            body: { feedId: feed.id, archiveUrl: options.archiveUrl, limit: options.limit }
          });
          setState(data.state);
          const parts = [`新增 ${data.added} 篇（共 ${data.total} 条）`];
          if (data.skipped > 0) parts.push(`跳过已订阅的 ${data.skipped} 篇`);
          if (data.failures.length > 0) parts.push(`${data.failures.length} 篇抓取失败`);
          setHistoryNote(parts.join("，"));
          setNotice(parts.join("，"));
        } catch (err) {
          // A backfill that fails is reported where it was asked for, and the
          // dialog stays open so the address can be corrected and retried.
          setHistoryNote(messageOf(err));
        } finally {
          setHistoryBusy(false);
          setHistoryProgress(0);
        }
      };

      /** Subscribe to a new feed. */
      const addFeed = useCallback(async ({ url, group, title }) => {
        setAddBusy(true);
        setAddError("");
        try {
          const data = await call("/feeds", {
            method: "POST",
            // An RSSHub candidate already knows its title, so the feed is named
            // properly instead of showing the raw route URL.
            body: { url, group, ...(typeof title === "string" && title.length > 0 ? { title } : {}) }
          });
          setState(data.state);
          // The URL was not a feed, but the host found what to paste instead —
          // keep the dialog open and show the choices.
          if (data.suggestions !== undefined) {
            setAddSuggestions({
              candidates: data.suggestions.candidates ?? [],
              rsshub: data.suggestions.rsshub ?? { enabled: false },
              pageIsFeed: false,
              pageError: "",
              finalUrl: url
            });
            setAddError("");
            return;
          }
          setAdding(false);
          if (data.outcome?.ok === false) {
            setNotice("");
            setError(`已添加订阅源，但首次获取失败：${data.outcome.error}`);
          } else {
            const added = data.outcome?.added ?? 0;
            setNotice(data.created ? `订阅成功${added > 0 ? `，获取到 ${added} 条` : ""}` : "该订阅源已存在，已重新获取");
          }
        } catch (err) {
          setAddError(messageOf(err));
        } finally {
          setAddBusy(false);
        }
      }, []);

      // Ask the host once whether RSSHub is available at all (and whether its
      // catalogue is): a button that can only fail is worse than no button.
      useEffect(() => {
        let cancelled = false;
        void (async () => {
          try {
            const data = await call("/rsshub");
            if (!cancelled) setRsshubInfo({ explore: data.explore === true, base: data.base ?? "" });
          } catch {
            if (!cancelled) setRsshubInfo({ explore: false, base: "" });
          }
        })();
        return () => {
          cancelled = true;
        };
      }, []);

      /**
       * Subscribe from the explore dialog.
       *
       * Throws so the dialog can show the reason beside the form it came from,
       * and returns what happened so the dialog can report it without closing —
       * a reader browsing a catalogue usually adds more than one feed.
       *
       * @param {object} payload - `{url, title, namespace}`.
       * @returns {Promise<{created: boolean, warning: string}>} the outcome.
       */
      const subscribeFromExplore = useCallback(async ({ url, title }) => {
        const data = await call("/feeds", {
          method: "POST",
          body: { url, ...(typeof title === "string" && title.length > 0 ? { title } : {}) }
        });
        setState(data.state);
        // The host answers with suggestions when the URL did not serve a feed —
        // for a catalogue route that means the instance would not generate it.
        if (data.suggestions !== undefined) {
          throw new Error("这个路由没有返回订阅源：实例可能未启用它，或它需要额外的实例配置。");
        }
        const warning = data.outcome?.ok === false ? `首次获取失败：${data.outcome.error}` : "";
        setNotice(warning.length > 0
          ? ""
          : data.created
            ? `订阅成功${(data.outcome?.added ?? 0) > 0 ? `，获取到 ${data.outcome.added} 条` : ""}`
            : "该订阅源已存在，已重新获取");
        return { created: data.created === true, warning };
      }, []);

      /** Remove a subscription; the caller has already asked the user. */
      const removeFeed = useCallback(async (feed) => {
        try {
          const data = await call(`/feeds?id=${encodeURIComponent(feed.id)}`, { method: "DELETE" });
          setState(data.state);
          // Removing the selected source is a source change like any other: the
          // open article may be one of the ones that just went away.
          if (selectedFeed === feed.id) selectFeed(null);
        } catch (err) {
          setError(messageOf(err));
        }
      }, [selectedFeed, selectFeed]);

      /** Open a feed's right-click menu at the pointer. */
      const openFeedMenu = useCallback((feed, event) => {
        // Row handlers sit inside a button and, for chips, inside a scroll
        // strip: neither the browser menu nor a parent click should also fire.
        if (typeof event?.preventDefault === "function") event.preventDefault();
        if (typeof event?.stopPropagation === "function") event.stopPropagation();
        setFeedMenu({ feed, x: event?.clientX ?? 0, y: event?.clientY ?? 0 });
      }, []);


      /** Mark one item read/starred. */
      const patchItem = useCallback(async (feedId, item, flags) => {
        try {
          const data = await call("/items", {
            method: "PATCH",
            body: { feedId, itemId: item.id || item.link, ...flags }
          });
          setState(data.state);
        } catch (err) {
          setError(messageOf(err));
        }
      }, []);

      /** Mark every item in a feed read. */
      const markFeedRead = useCallback(async (feedId) => {
        try {
          const data = await call("/items", { method: "PATCH", body: { feedId, all: true, read: true } });
          setState(data.state);
        } catch (err) {
          setError(messageOf(err));
        }
      }, []);

      // Ask the host once whether translation is possible here (no model
      // configured ⇒ the button is hidden rather than failing on click).
      useEffect(() => {
        let cancelled = false;
        void (async () => {
          try {
            const data = await call("/translate");
            if (cancelled) return;
            setTranslateInfo(data);
            if (typeof data.defaultTarget === "string" && data.defaultTarget.length > 0) {
              setTranslateTarget((current) => (current.length > 0 ? current : data.defaultTarget));
            }
          } catch {
            if (!cancelled) setTranslateInfo({ available: false, reason: "" });
          }
        })();
        return () => {
          cancelled = true;
        };
      }, []);

      const feeds = state?.feeds ?? [];

      /**
       * Persist a new subscription order.
       *
       * Applied locally first: a row must land where it was dropped, not where
       * it was while the host answered. A refusal puts the old order back by
       * reloading, so the screen never keeps an arrangement the host rejected.
       *
       * @param {string[]} ids - the wanted order.
       */
      const saveOrder = useCallback(async (ids) => {
        setState((current) => (current === null ? current : { ...current, feeds: reorderFeeds(current.feeds, ids) }));
        try {
          const data = await call("/feeds/order", { method: "PATCH", body: { ids } });
          setState(data.state);
        } catch (err) {
          setError(`排序失败：${messageOf(err)}`);
          void load();
        }
      }, [load]);

      /** Move one feed a step (the context menu's 上移 / 下移). */
      const stepFeed = useCallback((id, delta) => {
        const next = shiftId(feeds.map((feed) => feed.id), id, delta);
        if (next !== null) void saveOrder(next);
      }, [feeds, saveOrder]);

      /** Drop one feed onto another. */
      const dropFeed = useCallback((moving, target) => {
        const next = moveIdTo(feeds.map((feed) => feed.id), moving, target);
        if (next !== null) void saveOrder(next);
      }, [feeds, saveOrder]);

      /**
       * The drag props of one draggable feed row.
       *
       * HTML5 drag-and-drop, with the id read back from `dataTransfer` as well as
       * from state: a drag that began in another window (or after a re-render)
       * would otherwise arrive with nothing to move.
       *
       * @param {object} feed - the feed the row stands for.
       * @returns {object} props to spread onto the row.
       */
      const dragProps = (feed) => ({
        draggable: true,
        onDragStart: (event) => {
          setDragging(feed.id);
          const transfer = event?.dataTransfer;
          if (transfer !== undefined && transfer !== null) {
            transfer.effectAllowed = "move";
            // Some browsers refuse to start a drag unless data is set.
            if (typeof transfer.setData === "function") transfer.setData("text/plain", feed.id);
          }
        },
        onDragOver: (event) => {
          // Without this the drop never fires: the default is "not a drop target".
          if (typeof event?.preventDefault === "function") event.preventDefault();
        },
        onDrop: (event) => {
          if (typeof event?.preventDefault === "function") event.preventDefault();
          const carried = dragging ?? (typeof event?.dataTransfer?.getData === "function"
            ? event.dataTransfer.getData("text/plain")
            : "");
          setDragging(null);
          if (typeof carried === "string" && carried.length > 0) dropFeed(carried, feed.id);
        },
        onDragEnd: () => setDragging(null)
      });

      /**
       * The menu's move entries, for a feed that can actually move.
       *
       * A disabled "上移" on the first row would be one more thing to read and
       * nothing to do, so the entry is simply absent at the ends.
       *
       * @param {object} feed - the feed the menu was opened on.
       * @returns {Array<object>} zero, one or two menu entries.
       */
      const shiftItems = (feed) => {
        const at = feeds.findIndex((candidate) => candidate.id === feed.id);
        if (at < 0) return [];
        return [
          ...(at > 0 ? [{ key: "up", label: "上移", onSelect: () => stepFeed(feed.id, -1) }] : []),
          ...(at < feeds.length - 1 ? [{ key: "down", label: "下移", onSelect: () => stepFeed(feed.id, 1) }] : [])
        ];
      };

      /**
       * The stream before the time window is applied: flattened across feeds,
       * filtered by unread / starred / search, and sorted newest-first.
       *
       * The window is deliberately a *separate* pass. Applying it here would
       * leave no way to ask "would today have held anything?" — the question the
       * fallback has to answer — without walking every feed again.
       */
      const baseRows = useMemo(() => {
        const needle = query.trim().toLowerCase();
        const rows = [];
        for (const feed of feeds) {
          if (selectedFeed !== null && feed.id !== selectedFeed) continue;
          for (const item of feed.items ?? []) {
            if (unreadOnly && item.read === true) continue;
            if (starredOnly && item.starred !== true) continue;
            if (needle.length > 0) {
              const haystack = `${item.title} ${item.summary} ${item.author} ${feed.title}`.toLowerCase();
              if (!haystack.includes(needle)) continue;
            }
            rows.push({ feed, item });
          }
        }
        rows.sort((a, b) => {
          const left = a.item.date || "";
          const right = b.item.date || "";
          if (left === right) return 0;
          if (left.length === 0) return 1;
          if (right.length === 0) return -1;
          return right.localeCompare(left);
        });
        return rows;
      }, [feeds, selectedFeed, unreadOnly, starredOnly, query]);

      /** Whether a row falls inside a window, by its publication instant. */
      const inRange = inTimeRange;

      /**
       * The window in force — always exactly the one chosen.
       *
       * An empty window stays empty. It used to widen "今天" to three days so a
       * blank pane would not read as "nothing happened", but that made the
       * control lie: the chip said 今天 while the list showed three days. The
       * reader chose the window, so the window is what they get, and the empty
       * line names it so a blank pane is explained rather than papered over.
       */
      const activeRange = TIME_RANGES.find((range) => range.value === timeRange) ?? TIME_RANGES[0];

      /** The visible stream: the base rows narrowed to the window in force. */
      const items = useMemo(
        () => baseRows.filter((row) => inTimeRange(row, activeRange.days)),
        [baseRows, activeRange.days]
      );

      /**
       * Rows a time window had to leave out because they carry no usable date.
       *
       * Only non-zero under a window: with "全部" they are all visible, so there
       * is nothing to account for.
       */
      const undatedHidden = activeRange.days > 0
        ? baseRows.filter((row) => !hasUsableDate(row.item)).length
        : 0;

      /**
       * Unread counts scoped to the window in force, keyed by feed id (and
       * `__all__` for the total).
       *
       * The badges have to agree with the stream or they become noise: a chip
       * reading 9 beside a header reading 3 makes the reader distrust both. So
       * under a window the badges count what that window holds, which is exactly
       * what selecting that feed would show.
       *
       * Scoped by time only — deliberately *not* by `selectedFeed`, because a
       * chip's own badge must not change meaning depending on which chip is
       * selected.
       */
      const scopedUnread = useMemo(() => {
        const counts = new Map();
        let total = 0;
        for (const feed of feeds) {
          const unread = (feed.items ?? []).filter((item) => item.read !== true
            && (activeRange.days === 0 || inTimeRange({ item }, activeRange.days))).length;
          counts.set(feed.id, unread);
          total += unread;
        }
        counts.set("__all__", total);
        return counts;
      }, [feeds, activeRange.days]);

      /** The same number the badge shows, for one feed (or `__all__`). */
      const unreadBadge = (key) => scopedUnread.get(key) ?? 0;

      /** The item shown in the reading pane. */
      const selected = useMemo(() => {
        if (selectedItemKey === null) return null;
        return items.find(({ feed, item }) => itemKeyOf(feed.id, item) === selectedItemKey) ?? null;
      }, [items, selectedItemKey]);

      /** Open an item: select it and mark it read. */
      const openItem = useCallback((feed, item) => {
        // The list is about to be replaced by this article in the narrow layout,
        // and the effect that resets the article's offset clears the pending write
        // on the way past — taking the reader's place with it. So the offset is
        // written here, now, while the list still exists: the debounce cannot be
        // relied on to survive the swap. Reading it from the ref is what makes this
        // exact, since the last scroll event already put the real offset there.
        if (listScrollWriteRef.current !== undefined) {
          clearTimeout(listScrollWriteRef.current);
          listScrollWriteRef.current = undefined;
        }
        // Written only when there is something to write, so returning to the top
        // of a list the reader never scrolled costs no request. `?? ""` on the
        // stored side would instead make "nothing stored" differ from "top", and
        // turn every opened article into an extra write.
        const at = listScrollRef.current > 0 ? String(Math.round(listScrollRef.current)) : "";
        if (at !== "" && at !== readPrefs().lastListScrollTop) void setPref("lastListScrollTop", at).catch(() => {});
        setSelectedItemKey(itemKeyOf(feed.id, item));
        storePosition(feed.id, item.id || item.link);
        if (item.read !== true) void patchItem(feed.id, item, { read: true });
      }, [patchItem, storePosition]);

      /**
       * Load the open item's full body.
       *
       * Bodies are excluded from the list payload (they dominate its size), so
       * the reading pane fetches exactly one on selection. Declared after
       * `selected` because it derives from it.
       */
      /**
       * The item whose body the pane is showing.
       *
       * Tracked separately from `selected` so the reset below fires when the
       * *item* changes, not whenever the derived `selected` object is rebuilt.
       * Resetting on every rebuild would fight the reader: translating an item
       * re-renders the list, and the reset would land after the click and undo
       * the view it just asked for.
       */
      const shownItemKey = useRef(null);

      useEffect(() => {
        if (selected === null) {
          shownItemKey.current = null;
          setBody(null);
          setTranslationView("original");
          return undefined;
        }
        const feedId = selected.feed.id;
        const itemId = selected.item.id || selected.item.link;
        let cancelled = false;
        if (shownItemKey.current !== selectedItemKey) {
          shownItemKey.current = selectedItemKey;
          setTranslationView("original");
        }
        setBodyLoading(true);
        setBody(null);
        void (async () => {
          try {
            const data = await call(`/item?feedId=${encodeURIComponent(feedId)}&itemId=${encodeURIComponent(itemId)}`);
            if (cancelled) return;
            // Coerce a missing body to null: the reading pane branches on
            // `body === null`, so an unexpected response shape must not become
            // `undefined` and crash the render.
            setBody(data?.item ?? null);
          } catch (err) {
            if (!cancelled) setError(messageOf(err));
          } finally {
            if (!cancelled) setBodyLoading(false);
          }
        })();
        return () => {
          cancelled = true;
        };
      }, [selected]);

      /**
       * Put the reader back where they were inside the article.
       *
       * Deliberately after the body has rendered: the offset means nothing until
       * there is content to scroll. The listener below ignores the resulting
       * scroll event — a programmatic jump must not read as the reader moving,
       * or it would overwrite the very value being restored.
       */
      useEffect(() => {
        if (body === null || bodyLoading || !restoredRef.current) {
          restoreScrollRef.current = false;
          return;
        }
        const pane = detailPaneRef.current;
        const stored = Number.parseInt(readPrefs().lastScrollTop ?? "", 10);
        const offset = Number.isFinite(stored) && stored > 0 ? stored : 0;
        if (pane === null || offset === 0) return;
        restoreScrollRef.current = true;
        pane.scrollTop = offset;
        detailScrollRef.current = offset;
      }, [body, bodyLoading]);

      /**
       * Translate the open item, or reveal the translation already cached.
       *
       * `options.view` says which presentation the caller wants afterwards, so
       * pressing 对照 can go straight to the interleaved view instead of landing
       * on the translation-only one.
       */
      const translate = useCallback(async (options = {}) => {
        if (selected === null) return;
        const feedId = selected.feed.id;
        const itemId = selected.item.id || selected.item.link;
        const cached = body?.translation ?? null;
        const wanted = options.view ?? "translated";
        // A cached translation for this target is revealed with no request.
        // 对照 needs the per-segment form; a translation stored before that
        // existed (or one the model answered in a single block) has none, so it
        // is re-translated rather than shown misaligned.
        if (options.force !== true && cached !== null && cached.target === translateTarget) {
          if (wanted !== "parallel" || (cached.segments ?? []).length > 0) {
            setTranslationView(wanted);
            return;
          }
        }
        setTranslating(true);
        setError("");
        try {
          const data = await call("/translate", {
            method: "POST",
            body: {
              feedId,
              itemId,
              target: translateTarget,
              // Asking for 对照 is itself a request for the aligned form.
              ...(options.force === true || wanted === "parallel" ? { force: true } : {})
            }
          });
          setBody((current) => (current === null ? current : { ...current, translation: data.translation }));
          setTranslationView(wanted);
          setNotice(data.cached === true ? "已显示缓存的翻译" : "翻译完成");
        } catch (err) {
          setError(`翻译失败：${messageOf(err)}`);
        } finally {
          setTranslating(false);
        }
      }, [selected, body, translateTarget]);

      /** Drop the cached translation for the open item. */
      const clearTranslation = useCallback(async () => {
        if (selected === null) return;
        const feedId = selected.feed.id;
        const itemId = selected.item.id || selected.item.link;
        try {
          await call(`/translate?feedId=${encodeURIComponent(feedId)}&itemId=${encodeURIComponent(itemId)}`, { method: "DELETE" });
          setBody((current) => (current === null ? current : { ...current, translation: null }));
          setTranslationView("original");
        } catch (err) {
          setError(messageOf(err));
        }
      }, [selected]);

      // ── render helpers ──────────────────────────────────────────────────
      const feedRows = [
        h("button", {
          key: "__all__",
          type: "button",
          style: S.feedRow(selectedFeed === null),
          onClick: () => selectFeed(null)
        },
          h("span", { style: S.feedName }, "全部订阅源"),
          state === null ? null : h("span", { style: S.badge("unread") }, String(unreadBadge("__all__")))
        ),
        ...feeds.map((feed) => h("div", {
          key: feed.id,
          style: { display: "flex", alignItems: "center", gap: "2px" }
        },
          h("button", {
            type: "button",
            title: feed.lastError.length > 0 ? feed.lastError : `${feed.url}\n拖动可调整订阅源顺序`,
            style: { ...S.feedRow(selectedFeed === feed.id), cursor: "grab" },
            onClick: () => selectFeed(feed.id),
            onContextMenu: (event) => openFeedMenu(feed, event),
            ...dragProps(feed)
          },
            h("span", { style: { ...S.feedName, flex: "0 0 auto", color: COLOR.faint } }, "⠿"),
            h("span", { style: S.feedName }, feed.title),
            feed.lastError.length > 0
              ? h("span", { style: S.badge("error"), title: feed.lastError }, "!")
              : (unreadBadge(feed.id) > 0 ? h("span", { style: S.badge("unread") }, String(unreadBadge(feed.id))) : null)
          ),
          h("button", {
            type: "button",
            title: "刷新此源",
            style: { ...S.btnGhost, padding: "2px 5px" },
            disabled: refreshing,
            onClick: (event) => {
              event.stopPropagation();
              void refresh([feed.id], { force: true });
            }
          }, "⟳"),
          // Unsubscribing sits behind this menu (and its confirmation) rather
          // than on the row itself, so no stray click can destroy a feed.
          h("button", {
            type: "button",
            title: "更多操作（在订阅源上右键也可打开）",
            style: { ...S.btnGhost, padding: "2px 5px" },
            onClick: (event) => openFeedMenu(feed, event)
          }, "⋯")
        ))
      ];

      // The single-column form has no room for a feed list beside the items, so
      // the subscriptions become a scrolling strip of chips above them.
      const feedChips = [
        h("button", {
          key: "__all__",
          type: "button",
          title: "全部订阅源",
          style: S.chip(selectedFeed === null),
          onClick: () => selectFeed(null)
        },
          h("span", { style: S.chipName }, "全部"),
          state === null ? null : h("span", { style: S.badge("unread") }, String(unreadBadge("__all__")))
        ),
        ...feeds.map((feed) => h("button", {
          key: feed.id,
          type: "button",
          title: feed.lastError.length > 0
            ? `${feed.title}（上次刷新失败：${feed.lastError}）\n拖动或用右键菜单可调整顺序`
            : `${feed.title}\n拖动或用右键菜单可调整顺序`,
          style: { ...S.chip(selectedFeed === feed.id), cursor: "grab" },
          onClick: () => selectFeed(feed.id),
          onContextMenu: (event) => openFeedMenu(feed, event),
          ...dragProps(feed)
        },
          feed.lastError.length > 0 ? h("span", { style: { color: COLOR.danger } }, "!") : null,
          h("span", { style: S.chipName }, feed.title),
          unreadBadge(feed.id) > 0 ? h("span", { style: S.badge("unread") }, String(unreadBadge(feed.id))) : null
        ))
      ];

      const listRows = items.slice(0, 400).map(({ feed, item }) => {
        const key = itemKeyOf(feed.id, item);
        const read = item.read === true;
        return h("button", {
          key,
          type: "button",
          style: S.itemRow(selectedItemKey === key, read),
          onClick: () => openItem(feed, item)
        },
          h("span", { style: S.itemTitle(read) }, item.starred === true ? "★ " : "", item.title),
          item.summary.length > 0 ? h("span", { style: S.itemSummary }, item.summary) : null,
          h("span", { style: S.itemMeta },
            h("span", null, feed.title),
            item.date.length > 0 ? h("span", { title: formatFull(item.date) }, formatWhen(item.date)) : null,
            // An undated item must not pass for a fresh one: with no date to
            // show, the row would otherwise look like any other.
            item.date.length > 0 ? null : h("span", { style: S.badge("noDate"), title: "这个源没有提供发布日期" }, "无日期"),
            item.author.length > 0 ? h("span", null, item.author) : null,
            (item.categories ?? []).slice(0, 2).map((category) => h("span", { key: category }, `#${category}`))
          )
        );
      });

      // Where today ends and the backlog begins.
      //
      // The stream is newest-first, so today's items are already the top of the
      // list. That is precisely why a time filter looks like it does nothing:
      // with a full day of news, the rows *above* the boundary are the same
      // whichever window is chosen, and the cut lands far below the fold. The
      // reader sees an identical list and concludes the control is broken.
      // Marking the boundary is what makes the window's effect visible at all.
      //
      // Newest-first also guarantees today's rows are a contiguous prefix
      // (undated rows sort to the end), so the boundary is a single index.
      const todayBoundary = activeRange.days === 0 ? listRows.findIndex((_, index) => !isFromToday(items[index].item)) : -1;
      if (todayBoundary > 0) {
        listRows.splice(todayBoundary, 0, h("div", { key: "__today_boundary__", style: S.todayBoundary },
          `今天到此为止（${todayBoundary} 条）· 以下为更早的内容`));
      }

      /**
       * What the time window left out, said plainly above the stream.
       *
       * Only the undated rows need a line now: they can never be placed in a
       * window, so silence would read as "they do not exist". A window that
       * hides rows without saying so cannot be trusted, and the reader would go
       * back to reading every date by hand.
       */
      const timeNotices = [];
      if (undatedHidden > 0) {
        timeNotices.push(h("div", { key: "undated", style: S.timeNotice },
          `${undatedHidden} 条内容没有发布日期，未计入当前时间范围。`));
      }

      /**
       * The empty-list line.
       *
       * Under a window it names that window and says how to widen it, because a
       * blank pane has to be explained rather than papered over — the panel no
       * longer widens the window on its own, so this line is the only thing
       * standing between "nothing today" and "the feature is broken".
       */
      const emptyText = activeRange.days > 0
        ? `${activeRange.label}内暂无内容，可换一个时间范围`
        : (query.length > 0 || unreadOnly || starredOnly ? "没有符合筛选条件的内容" : "该订阅源暂无内容，试试刷新");

      // ── reading pane ────────────────────────────────────────────────────
      const translation = body?.translation ?? null;
      const hasTranslation = translation !== null && ((translation.markdown ?? "").length > 0 || (translation.title ?? "").length > 0);
      // Three ways to read the same item: the original, the translation alone,
      // or the two interleaved. `parallel` is only honoured when both sides are
      // available — the stale state must never show an empty pane.
      const showingTranslation = translationView === "translated" && hasTranslation;
      // The Markdown to render: the translation when toggled on, else the
      // original. Both arrive from the host already converted to Markdown.
      //
      // Many feeds publish the whole article in <description> rather than
      // <content:encoded>, so the body falls back to the summary — otherwise
      // those items would render as empty.
      const originalMarkdown = body === null
        ? ""
        : ((body.markdown ?? "").length > 0
            ? body.markdown
            : (body.summaryMarkdown ?? "").length > 0 ? body.summaryMarkdown : (body.content || body.summary || ""));
      const bodyMarkdown = showingTranslation && (translation.markdown ?? "").length > 0
        ? translation.markdown
        : originalMarkdown;
      // Alignment here, not only on the host: the two sides are cut from the
      // same body, so the paragraph a translation belongs to is decided by the
      // body the pane is actually showing.
      const parallelPairs = translationView === "parallel" && hasTranslation
        ? zipBlocks(originalMarkdown, translation.segments ?? [])
        : [];
      const showingParallel = parallelPairs.length > 0;
      // A stored translation from before the aligned form existed has no
      // segments: say so instead of rendering something misaligned.
      const parallelUnavailable = translationView === "parallel" && hasTranslation && !showingParallel;
      const displayTitle = translationView !== "original" && (translation?.title ?? "").length > 0
        ? translation.title
        : selected?.item.title ?? "";
      // With the two sides interleaved the original title is already directly
      // under the translated one; in translation-only mode it would be the only
      // title left, which would defeat the point of showing the translation.
      const showOriginalTitle = hasTranslation && (translation.title ?? "").length > 0 && translation.title !== (selected?.item.title ?? "")
        && translationView !== "translated";
      const canTranslate = translateInfo?.available === true;

      /**
       * The controls that act on the open article, for the top-right corner.
       *
       * These used to share a row with the title, which meant a long piece
       * scrolled them away: at the end of it the reader had to scroll back to
       * bookmark, translate or open the original. They are rendered into the
       * pinned way-back bar's right end instead, so they hold the same corner
       * for the whole article.
       *
       * The narrow presentation (the right Sidebar) has little width, so there
       * the same controls collapse to glyphs with tooltips — exactly how its top
       * bar already folds its labels. Labelling and hinting are defined once and
       * read twice, so the two presentations cannot drift apart.
       */
      const labelPair = (glyph, label) => (singleColumn ? { text: glyph, hint: label } : { text: label, hint: label });
      const starLabel = labelPair("★", selected?.item.starred === true ? "取消收藏" : "收藏");
      const readLabel = labelPair("○", selected?.item.read === true ? "标为未读" : "标为已读");
      const linkLabel = labelPair("↗", "打开原文 ↗");

      const floatingActionCapsule = selected === null
        ? null
        : h("div", { style: S.actionBar },
            h("div", { style: S.actionCapsule },
              h(Button, {
                onClick: () => void patchItem(selected.feed.id, selected.item, { starred: selected.item.starred !== true }),
                title: starLabel.hint,
                style: {
                  color: selected.item.starred === true ? COLOR.warning : COLOR.dim,
                  // A starred item keeps a visible mark when the label is a glyph.
                  ...(selected.item.starred === true ? { borderColor: COLOR.warning } : {})
                }
              }, starLabel.text),
              // The translate control is only offered when a model is actually
              // reachable, so it never becomes a button that can only fail.
              canTranslate
                ? h(Button, {
                    variant: hasTranslation ? undefined : "primary",
                    disabled: translating,
                    onClick: () => void translate(),
                    title: hasTranslation ? "显示 / 隐藏翻译" : `翻译成 ${targetLabel(translateTarget)}`,
                    style: showingTranslation ? { borderColor: COLOR.accent, color: COLOR.accent } : undefined
                  }, translating ? "…" : hasTranslation ? (showingTranslation ? "原文" : "译文") : "译")
                : null,
              // 原文 / 译文 / 对照 — the interleaved view is the reason the
              // translation is stored per paragraph rather than as one blob.
              // `translate` decides on its own whether an aligned answer has to
              // be fetched; the button only states which view is wanted.
              canTranslate && hasTranslation
                ? h(Button, {
                    disabled: translating,
                    onClick: () => void translate({ view: "parallel" }),
                    title: "原文与译文逐段对照",
                    style: showingParallel ? { borderColor: COLOR.accent, color: COLOR.accent } : undefined
                  }, translating ? "…" : "对照")
                : null,
              canTranslate && hasTranslation
                ? h(Button, {
                    disabled: translating,
                    title: "重新翻译",
                    onClick: () => void translate({ force: true })
                  }, "↻")
                : null,
              canTranslate && hasTranslation
                ? h(Button, { title: "删除已缓存的翻译", onClick: () => void clearTranslation() }, "✕")
                : null,
              selected.item.link.length > 0
                ? h("a", {
                    href: selected.item.link,
                    target: "_blank",
                    rel: "noreferrer noopener",
                    title: linkLabel.hint,
                    style: { ...S.btn, textDecoration: "none" }
                  }, linkLabel.text)
                : null,
              h(Button, {
                onClick: () => void patchItem(selected.feed.id, selected.item, { read: selected.item.read !== true }),
                title: readLabel.hint
              }, readLabel.text)
            )
          );

      /**
       * The interleaved body: each paragraph, then its translation.
       *
       * The original is rendered as Markdown and the translation as Markdown
       * too, so links, code and images keep working on both sides rather than
       * one becoming a wall of plain text.
       */
      const parallelBody = h("div", null,
        ...parallelPairs.flatMap((pair, index) => {
          const rows = [];
          if (pair.source.trim().length > 0) {
            rows.push(h("div", {
              key: `src-${index}`,
              style: { marginBottom: pair.translated.trim().length > 0 ? "6px" : "16px" }
            }, h(Markdown, { markdown: pair.source, onOpenImage: (image) => setLightbox(image) })));
          }
          if (pair.translated.trim().length > 0) {
            rows.push(h("div", {
              key: `tr-${index}`,
              style: {
                marginBottom: "18px",
                paddingLeft: "10px",
                borderLeft: `3px solid ${COLOR.accent}`,
                color: COLOR.dim
              }
            }, h(Markdown, { markdown: pair.translated, onOpenImage: (image) => setLightbox(image) })));
          }
          return rows;
        })
      );

      const readingPane = selected === null
        ? h("div", { style: S.empty },
            h(RssGlyph, { size: 34 }),
            h("div", null, "选择左侧的一条内容开始阅读"))
        : h("div", null,
            // The wide presentation has no pinned bar of its own — its pane
            // keeps a heading at the top, so the controls can simply hold the
            // right end of that first row. The narrow one instead renders them
            // into the way-back bar that is already pinned (see below), so they
            // are emitted in exactly one place per presentation.
            singleColumn
              ? null
              : h("div", { style: S.actionBar }, floatingActionCapsule),
            // Only the heading lives in this row. The controls used to share it,
            // which meant a long piece scrolled them away: at the end of it the
            // reader had to scroll back to bookmark, translate or open the
            // original.
            h("div", { style: { display: "flex", alignItems: "flex-start", gap: "10px", marginBottom: "6px", flexWrap: "wrap" } },
              h("div", { style: { flex: "1 1 240px", minWidth: 0 } },
                h("div", { style: { fontSize: "17px", fontWeight: 600, lineHeight: "25px", marginBottom: "6px" } },
                  displayTitle),
                h("div", { style: { ...S.itemMeta, marginBottom: "4px" } },
                  h("span", null, selected.feed.title),
                  selected.item.date.length > 0
                    ? h("span", { title: formatFull(selected.item.date) }, formatFull(selected.item.date))
                    : null,
                  selected.item.author.length > 0 ? h("span", null, selected.item.author) : null,
                  translationView !== "original" && hasTranslation
                    ? h("span", { style: { color: COLOR.accent } }, `译自 ${translation.model || "模型"}`)
                    : null
                ),
                showOriginalTitle
                  ? h("div", { style: { fontSize: "12px", color: COLOR.faint, marginBottom: "6px" } }, selected.item.title)
                  : null
              )
            ),
            (selected.item.categories ?? []).length > 0
              ? h("div", { style: { ...S.itemMeta, marginBottom: "10px" } },
                  selected.item.categories.map((category) => h("span", { key: category }, `#${category}`)))
              : null,
            h("div", { style: { borderTop: `1px solid ${COLOR.border}`, paddingTop: "14px", color: COLOR.text } },
              bodyLoading
                ? h("div", { style: { fontSize: "12px", color: COLOR.faint, padding: "12px 0" } }, "正在载入正文…")
                : showingParallel
                  ? parallelBody
                  : bodyMarkdown.trim().length > 0
                    ? h(Markdown, { markdown: bodyMarkdown, onOpenImage: (image) => setLightbox(image) })
                    : h("div", { style: { fontSize: "12px", color: COLOR.faint, padding: "12px 0" } },
                        "（该条目没有正文摘要，请点「打开原文」查看。）")
            ),
            // The interleaved view is only as good as the alignment behind it;
            // when there is none, saying so beats showing a wrong pairing.
            parallelUnavailable
              ? h("div", { style: { ...S.settingsBlockLead, marginTop: "8px" } },
                  "这篇的译文是按整篇返回的，没有分段对应关系，所以暂时没法逐段对照。点「重新翻译」可以重新按段翻译一次。")
              : null,
            selected.item.link.length > 0
              ? h("div", { style: { marginTop: "18px", fontSize: "11px", color: COLOR.faint, wordBreak: "break-all" } },
                  selected.item.link)
              : null
          );

      // ── main render ─────────────────────────────────────────────────────
      if (loading && state === null) {
        return h("div", { style: S.root }, h("div", { style: S.empty }, "正在载入订阅源…"));
      }

      /**
       * How much of the unread pile is actually from today.
       *
       * Counted over every feed's items, the same population the host's own
       * `unread` total covers, so the two numbers cannot disagree. One number —
       * "41 条未读" — cannot be acted on, because it mixes today's news with
       * months of backlog and so never seems to go down; splitting it is what
       * turns "lots" into "five things to read".
       */
      const todayUnread = (state?.feeds ?? []).reduce((total, feed) => {
        const fromToday = (feed.items ?? []).filter((item) => item.read !== true
          && hasUsableDate(item) && inTimeRange({ item }, 1)).length;
        return total + fromToday;
      }, 0);
      /** Unread everywhere else — the backlog the split exists to separate. */
      const olderUnread = Math.max(0, (state?.totals?.unread ?? 0) - todayUnread);

      return h("div", { style: S.root },
        h("div", { style: S.header },
          h("span", { style: S.title }, "RSS 阅读器"),
          state === null
            ? null
            : h("span", { style: S.counter },
                // The counter describes the window in force, the same as the
                // badges beside it. The "N 个源 · N 条" part is inventory and
                // stays whole; only the unread part is scoped.
                //
                // Without a window the day split applies: a single "41 条未读"
                // mixes today's news with months of backlog, which is what makes
                // it feel unactionable. With one, the split is redundant (the
                // scoped number already answers "how much is in this window"),
                // so it states the window and the count.
                `${state.totals.feeds} 个源 · ${state.totals.items} 条 · `
                + (activeRange.days > 0
                  ? `${activeRange.label} ${unreadBadge("__all__")} 条未读`
                  : (todayUnread > 0
                    // The narrow column gets the short form: the long one wraps
                    // the header onto a second line.
                    ? (singleColumn
                        ? `今天 ${todayUnread} · 更早 ${olderUnread}`
                        : `今天 ${todayUnread} 条未读 · 更早 ${olderUnread} 条未读`)
                    : `${state.totals.unread} 条未读`))),
          h("span", { style: S.spacer }),
          // Folding the source strip is the reader's call, so the control sits
          // where the strip itself would appear — not buried in DSH's settings.
          // Only the narrow presentation has a strip: the wide one's subscription
          // column is also the only place its sources can be managed, so folding
          // it would take a capability away rather than make room.
          !singleColumn || feeds.length === 0
            ? null
            : h(Button, {
                onClick: () => void setPref("collapseFeeds", !feedsCollapsed).catch((err) => setError(messageOf(err))),
                title: feedsCollapsed ? "展开订阅源" : "收起订阅源",
                style: feedsCollapsed ? { borderColor: COLOR.accent, color: COLOR.accent } : undefined
              }, feedsCollapsed
                // While the strip is away, say what the strip said: which source
                // the items are filtered to (or that none is).
                ? `▸ ${activeFeed === null ? `订阅源 ${feeds.length}` : activeFeed.title}`
                : "▾"),
          h("input", {
            style: singleColumn ? { ...S.input, flex: "1 1 140px" } : S.input,
            placeholder: singleColumn ? "搜索" : "搜索标题 / 摘要 / 作者",
            value: query,
            onChange: (event) => setQuery(event.target.value)
          }),
          // The time window. It narrows the stream without ever being the
          // default (`all`), so the panel opens on the same full timeline it
          // always did and the window is there for when the reader goes looking
          // for today's news.
          //
          // Four chips need a row the narrow column does not have, so there the
          // choice becomes one select — the same values, and the label still
          // says which window is in force.
          singleColumn
            ? h("select", {
                style: S.rangeSelect,
                "aria-label": "时间范围",
                title: "只看某个时间范围内的内容",
                value: timeRange,
                onChange: (event) => setTimeRange(event.target.value)
              }, TIME_RANGES.map((range) => h("option", { key: range.value, value: range.value }, range.label)))
            : TIME_RANGES.map((range) => h("button", {
                key: range.value,
                type: "button",
                title: range.value === "all" ? "不限时间" : `只看${range.label}发布的内容`,
                "aria-pressed": timeRange === range.value,
                style: {
                  ...S.rangeChip,
                  ...(timeRange === range.value ? { borderColor: COLOR.accent, color: COLOR.accent } : {})
                },
                onClick: () => setTimeRange(range.value)
              }, range.label)),
          // A narrow column cannot carry the long labels, so there the controls
          // fall back to their glyphs with the same titles.
          h(Button, {
            onClick: () => setUnreadOnly((value) => !value),
            title: "只看未读",
            style: unreadOnly ? { borderColor: COLOR.accent, color: COLOR.accent } : undefined
          }, singleColumn ? (unreadOnly ? "●" : "○") : (unreadOnly ? "● 未读" : "○ 未读")),
          h(Button, {
            onClick: () => setStarredOnly((value) => !value),
            title: "只看收藏",
            style: starredOnly ? { borderColor: COLOR.warning, color: COLOR.warning } : undefined
          }, singleColumn ? "★" : "★ 收藏"),
          // Offered when the window in force actually holds unread items — the
          // same count the badge and the stream show, so the control never
          // appears for an empty view nor hides when there is something to clear.
          activeFeed !== null && unreadBadge(activeFeed.id) > 0
            ? h(Button, { onClick: () => void markFeedRead(activeFeed.id), title: "把该源全部标为已读（不受时间范围限制）" },
                singleColumn ? "✓" : "全部已读")
            : null,
          h(Button, {
            variant: "primary",
            disabled: refreshing,
            onClick: () => void refresh(activeFeed === null ? undefined : [activeFeed.id], { force: true }),
            title: activeFeed === null ? "刷新全部订阅源" : `刷新「${activeFeed.title}」`
          }, refreshing ? (singleColumn ? "…" : "刷新中…") : (singleColumn ? "⟳" : "⟳ 刷新")),
          // Only meaningful for one source: fetching "older articles" for every
          // subscription at once would be a lot of someone else's bandwidth.
          activeFeed === null
            ? null
            : h(Button, {
                disabled: historyBusy,
                onClick: () => {
                  setHistoryNote("");
                  setHistoryProgress(0);
                  setHistoryFor(activeFeed);
                },
                title: `抓取「${activeFeed.title}」更早的文章（订阅源只给出最近若干条）`
              }, singleColumn ? "⇤" : "⇤ 更早"),
          rsshubInfo?.explore === true
            ? h(Button, {
                title: "浏览 RSSHub 上社区维护的订阅源",
                onClick: () => setExploring(true)
              }, singleColumn ? "🧭" : "🧭 探索")
            : null,
          h(Button, {
            title: "添加订阅源",
            onClick: () => { setAddError(""); setAddSuggestions(null); setAdding(true); }
          }, singleColumn ? "+" : "+ 添加订阅源")
        ),

        error.length > 0
          ? h("div", { style: S.banner("error") },
              error,
              h("button", {
                type: "button",
                style: { ...S.btnGhost, marginLeft: "8px", color: "inherit" },
                onClick: () => setError("")
              }, "关闭"))
          : null,
        notice.length > 0
          ? h("div", { style: S.banner("info") },
              notice,
              h("button", {
                type: "button",
                style: { ...S.btnGhost, marginLeft: "8px", color: "inherit" },
                onClick: () => setNotice("")
              }, "关闭"))
          : null,

        feeds.length === 0
          ? h("div", { style: S.empty },
              h(RssGlyph, { size: 40 }),
              h("div", { style: { fontSize: "15px", fontWeight: 600, color: COLOR.text } }, "还没有订阅任何 RSS 源"),
              h("div", { style: { maxWidth: "420px", lineHeight: "20px" } },
                "点击「+ 添加订阅源」粘贴 RSS/Atom 地址；也可以直接粘贴网站首页，插件会自动查找它声明的订阅源。"),
              h(Button, { variant: "primary", onClick: () => { setAddSuggestions(null); setAdding(true); } }, "+ 添加订阅源"))
          : singleColumn
            // ── single-column presentation (the right Sidebar's tab) ──────
            ? h("div", { style: S.narrowBody },
                feedsCollapsed ? null : h("div", { style: S.chips }, feedChips),
                selected === null
                  ? h("div", {
                      ref: listPaneRef,
                      style: S.narrowList,
                      onScroll: handleListScroll
                    },
                      ...timeNotices,
                      listRows.length === 0
                        ? h("div", { style: S.empty }, emptyText)
                        : listRows
                    )
                  // The detail takes the list's place on the same page — no new
                  // tab — and the way back restores the list, filters and all.
                  : h("div", {
                      id: "rss-reader-detail",
                      ref: detailPaneRef,
                      style: S.narrowDetail,
                      onScroll: (event) => {
                        // The one scroll event caused by restoring the position
                        // is not the reader moving, so it must not overwrite it.
                        if (restoreScrollRef.current) {
                          restoreScrollRef.current = false;
                          return;
                        }
                        detailScrollRef.current = event?.currentTarget?.scrollTop ?? 0;
                        // The offset lives in a ref, so the write has to be armed
                        // by the scroll itself — see `scheduleScrollWrite`.
                        scheduleScrollWrite();
                      }
                    },
                      h("style", { key: "detail-style" }, S.detailStyle),
                      h("div", { style: S.detailBar },
                        h(Button, { onClick: () => setSelectedItemKey(null), title: "回到内容列表" }, "← 返回列表"),
                        // The controls take the right end of this same pinned
                        // bar. The source name used to sit here and has given up
                        // its place: the article's own metadata line, directly
                        // below, already names the feed.
                        floatingActionCapsule
                      ),
                      readingPane
                    )
              )
            : h("div", { style: S.body },
                h("div", { style: S.feedsPane },
                  feedRows,
                  state !== null && state.groups.length > 0
                    ? h("div", { style: { marginTop: "12px", padding: "0 8px", fontSize: "11px", color: COLOR.faint } },
                        `分组：${state.groups.join("、")}`)
                    : null
                ),
                h("div", { ref: listPaneRef, style: S.listPane, onScroll: handleListScroll },
                  ...timeNotices,
                  listRows.length === 0
                    ? h("div", { style: S.empty }, emptyText)
                    : listRows
                ),
                h("div", { style: S.readPane }, readingPane)
              ),

        h("div", { style: S.footer },
          h("span", null, `最近刷新：${state === null || (state.totals?.lastFetched ?? "").length === 0 ? "从未" : formatFull(state.totals.lastFetched)}`),
          refreshing ? h("span", null, "正在刷新…") : null,
          state !== null && (state.totals?.failures ?? 0) > 0
            ? h("span", { style: { color: COLOR.warning } }, `${state.totals.failures} 个源刷新失败`)
            : null,
          state?.warning !== undefined ? h("span", { style: { color: COLOR.warning } }, state.warning) : null,
          h("span", { style: S.spacer }),
          // The target picker only makes sense when translation is available.
          canTranslate
            ? h("span", { style: { display: "inline-flex", alignItems: "center", gap: "5px" } },
                h("span", null, "翻译为"),
                h("select", {
                  value: translateTarget,
                  onChange: (event) => {
                    setTranslateTarget(event.target.value);
                    // Switching target invalidates the shown translation.
                    setTranslationView("original");
                  },
                  style: {
                    padding: "2px 6px",
                    borderRadius: "6px",
                    border: `1px solid ${COLOR.border}`,
                    background: COLOR.bg,
                    color: COLOR.text,
                    fontSize: "11px"
                  }
                }, Object.keys(translateInfo.targets ?? {}).map((code) => h("option", { key: code, value: code }, targetLabel(code))))
              )
            : null,
          canTranslate ? null : h("span", null, "Agent 可调用 rss_read 工具，或输入 /rss 命令查看")
        ),

        // These overlays come and go independently, and each carries state of
        // its own (search text, a half-filled form). Keys are what let React
        // match them across a re-render: without them, a banner appearing above
        // shifts every later sibling's position and silently remounts the open
        // dialog, resetting what the reader has typed.
        adding
          ? h(AddFeedDialog, {
              key: "add-dialog",
              busy: addBusy,
              suggestions: addSuggestions,
              onClose: () => {
                if (addBusy) return;
                setAdding(false);
                setAddError("");
                setAddSuggestions(null);
              },
              onSubmit: (payload) => void addFeed(payload)
            })
          : null,
        exploring
          ? h(ExploreDialog, {
              key: "explore-dialog",
              onSubscribe: subscribeFromExplore,
              onClose: () => setExploring(false)
            })
          : null,
        historyFor === null
          ? null
          : h(HistoryDialog, {
              key: "history-dialog",
              feed: historyFor,
              busy: historyBusy,
              progress: historyProgress,
              note: historyNote,
              // Closing while a run is in flight is allowed: the request keeps
              // going and the list fills in when it lands.
              onClose: () => { if (!historyBusy) setHistoryFor(null); },
              onSubmit: (options) => void fetchHistory(historyFor, options)
            }),
        lightbox !== null
          ? h(Lightbox, { key: "lightbox", image: lightbox, onClose: () => setLightbox(null) })
          : null,

        feedMenu === null
          ? null
          : h(ContextMenu, {
              key: "feed-menu",
              x: feedMenu.x,
              y: feedMenu.y,
              hint: feedMenu.feed.title,
              onClose: () => setFeedMenu(null),
              items: [
                // Moving by menu is the precise, always-available half of the
                // reordering: dragging is faster, but it needs a pointer and a
                // steady hand, and the narrow column is a strip of chips.
                ...shiftItems(feedMenu.feed),
                { key: "refresh", label: "刷新此源", onSelect: () => void refresh([feedMenu.feed.id], { force: true }) },
                { key: "read", label: "全部标为已读（整个源）", onSelect: () => void markFeedRead(feedMenu.feed.id) },
                // The one destructive entry: named with an ellipsis because it
                // opens the confirmation rather than acting at once.
                { key: "unsubscribe", label: "取消订阅…", danger: true, onSelect: () => setPendingRemove(feedMenu.feed) }
              ]
            }),

        pendingRemove === null
          ? null
          : h(ConfirmDialog, {
              key: "confirm-dialog",
              title: "取消订阅",
              message: `确定要取消订阅「${pendingRemove.title}」吗？该源已缓存的 ${pendingRemove.itemCount ?? 0} 条内容会一并删除，此操作无法撤销。`,
              confirmLabel: "确定取消订阅",
              onConfirm: () => {
                const feed = pendingRemove;
                setPendingRemove(null);
                void removeFeed(feed);
              },
              onCancel: () => setPendingRemove(null)
            }),

        adding && addError.length > 0
          ? h("div", {
              key: "add-error",
              style: { ...S.banner("error"), position: "fixed", bottom: "18px", left: "50%", transform: "translateX(-50%)", zIndex: 2200, margin: 0 }
            }, addError)
          : null
      );
    }

    // ── plugin body ───────────────────────────────────────────────────────
    const inject = ["slots"];

    /**
     * Register the panel, its left-Sidebar entry, and its right-Sidebar tab.
     *
     * The `main` slot is keyed: the sidebar row whose id matches this key is
     * what dispatches to the panel, so both registrations share PANEL_KEY.
     *
     * The right Sidebar is a separate, optional product: its services are
     * reached through `ctx.inject([...])` so a build without it still loads
     * this plugin, just with the centre panel alone.
     *
     * The left-Sidebar row is the one entry the user can switch off (设置 →
     * 通用 → RSS 阅读器入口), so it is registered from the persisted preference
     * and re-registered when that changes — a setting flip must not need a page
     * reload.
     *
     * @param {object} ctx - client root context.
     */
    function apply(ctx) {
      ctx.slots.inject("main", () => ctx.slots.register({
        name: "main",
        key: PANEL_KEY
      }, RssPanel));

      // The RSS settings are a page of their own rather than rows mixed into
      // 通用: they are all one feature's, and the subscription order needs the
      // room a preference row does not have. Registered unconditionally — it is
      // also how a hidden left-Sidebar entry comes back.
      ctx.slots.inject("settings.section", () => ctx.slots.register({
        name: "settings.section",
        id: "rss-reader",
        // After 通用 (0), 模型 (10) and 插件 (15).
        order: 20,
        label: () => "RSS 阅读器"
      }, RssSettingsSection));

      /** Holds the left-Sidebar row's disposer while the preference allows it. */
      let disposeSidebarRow = null;
      const applySidebarRowPreference = () => {
        const show = readPrefs().showSidebarEntry !== false;
        if (show && disposeSidebarRow === null) {
          disposeSidebarRow = ctx.slots.inject("sidebar.panellist", () => ctx.slots.register({
            name: "sidebar.panellist",
            id: PANEL_KEY,
            order: 50,
            label: () => "RSS"
          }, RssGlyph));
        } else if (!show && disposeSidebarRow !== null) {
          disposeSidebarRow();
          disposeSidebarRow = null;
        }
      };
      subscribePrefs(applySidebarRowPreference);
      ctx.effect(() => () => {
        if (disposeSidebarRow !== null) {
          disposeSidebarRow();
          disposeSidebarRow = null;
        }
      }, "dsh-rss-reader: left Sidebar row");
      // Read first, register second: registering optimistically would flash the
      // row on every load for someone who has switched it off.
      void loadPrefs();

      if (typeof ctx.inject !== "function") return;
      ctx.inject(["sidebarRightTabs", "sidebarRight"], (right) => {
        // `effect` ties every registration to this context's lifetime: the tab
        // registry refuses a second registration of one id, so a stale one must
        // go away with the services that carried it.
        if (typeof right.effect !== "function") return;
        right.effect(() => right.sidebarRightTabs.register({
          id: SIDEBAR_TAB_ID,
          kind: SIDEBAR_TAB_KIND,
          // A page type: opened by kind, so it declares no address patterns.
          title: () => "RSS 阅读器",
          // The right Sidebar's add control lists guide entries, which is the
          // second way in beside the launcher below.
          //
          // `id` is required on an entry as of dsh 0.1.7: the guide keys each
          // rendered box by it (the `entryId` of the
          // `sidebar.right.tab.guide.entry` seat, and a React key of
          // `[providerId, entryId]`), and the registry rejects a type whose
          // entries share one. Omitting it left every box of this type keyed
          // `undefined` — one entry per type hides that, but it binds the
          // plugin to dsh ≥ 0.1.7 either way, so the requirement is declared
          // rather than relied on. The value is scoped to the type, so the tab
          // type's own id is the natural one.
          guide: [{
            id: SIDEBAR_TAB_ID,
            order: 60,
            title: () => "RSS 阅读器",
            description: () => "在右侧边栏订阅并阅读 RSS / Atom 源",
            icon: RssGlyph
          }]
        }), "dsh-rss-reader: right Sidebar tab type");

        right.effect(() => right.slots.inject("sidebar.right.pane.tab", () => right.slots.register({
          name: "sidebar.right.pane.tab",
          key: SIDEBAR_TAB_ID
        }, RssSidebarPanel)), "dsh-rss-reader: right Sidebar tab body");

        const openRssTab = () => right.sidebarRight.openTab(SIDEBAR_TAB_KIND);
        right.effect(() => right.slots.inject("sidebar.footer.action", () => right.slots.register({
          name: "sidebar.footer.action",
          id: PANEL_KEY,
          order: 60
        }, (props) => h(RssLauncher, { ...props, onOpen: openRssTab }))),
          "dsh-rss-reader: right Sidebar launcher");
      });
    }

    exports.RssPanel = RssPanel;
    exports.RssSidebarPanel = RssSidebarPanel;
    exports.ContextMenu = ContextMenu;
    exports.ConfirmDialog = ConfirmDialog;
    exports.RssSidebarEntryRow = RssPreferenceRow;
    exports.RssSettingsSection = RssSettingsSection;
    exports.RssGlyph = RssGlyph;
    exports.apply = apply;
    exports.inject = inject;
    return module.exports;
  }
});
