/**
 * dsh-rss-reader — subscription store.
 *
 * Owns the durable state: the list of feeds, their last-known metadata, and
 * their cached items. Design notes:
 *
 * - **atomic writes**: state is written to a temporary file and renamed, so a
 *   crash mid-write cannot leave a truncated subscription list;
 * - **coalesced flushes**: rapid refreshes share one write via a short debounce,
 *   with a synchronous flush on dispose;
 * - **bounded growth**: each feed keeps at most `maxItemsPerFeed` items and the
 *   whole document is pruned to `maxFeeds` subscriptions;
 * - **pure read model**: `snapshot()` returns the plain object the HTTP API and
 *   the UI consume, never internal references.
 *
 * @module dsh-rss-reader/store
 */

import { existsSync } from "node:fs";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

/** Current on-disk schema version. */
export const STORE_VERSION = 1;

/** Default item retention per feed. */
export const DEFAULT_MAX_ITEMS = 100;

/** Default cap on subscriptions. */
export const DEFAULT_MAX_FEEDS = 200;

/**
 * Preference keys the store persists.
 *
 * A whitelist rather than free-form storage: the file is user-editable, and an
 * unknown or mistyped key must not become a setting that nothing reads (or,
 * worse, that a future version reads with a different meaning).
 */
export const PREF_KEYS = [
  "showSidebarEntry",
  "expandImages",
  "collapseFeeds",
  "rsshubBase",
  // Translation routing, chosen in 设置 → RSS 阅读器. Stored as plain strings so
  // the picker can write exactly what it shows; the plugin config only supplies
  // the default, so a value equal to it and "never chosen" stay distinguishable
  // (`stored` is what tells them apart).
  "translateProvider",
  "translateModel",
  "translateEffort",
  // Where the reader was last time, so reopening the panel returns to the same
  // article instead of the top of the list. Kept on the host rather than in
  // browser storage for the same reason as the rest of the state: it belongs to
  // the subscription list, not to one browser.
  "lastFeedId",
  "lastItemKey",
  // Two offsets, not one: `lastScrollTop` is the position inside the open
  // article, `lastListScrollTop` the position of the item list behind it. Going
  // back from an article has to land on the list row the reader left from, and
  // that is a different scroll box from the body — one number cannot serve both.
  "lastScrollTop",
  "lastListScrollTop"
];

/** Longest string a preference may hold. */
export const MAX_PREF_STRING = 300;

/** Preference keys whose value is free text rather than a boolean switch. */
const STRING_PREF_KEYS = [
  "rsshubBase",
  "translateProvider",
  "translateModel",
  "translateEffort",
  "lastFeedId",
  "lastItemKey",
  "lastScrollTop",
  "lastListScrollTop"
];

/**
 * Check one preference value and return it in canonical form.
 *
 * Typed rather than "anything goes": a boolean switch must not end up holding a
 * URL because two keys were mixed up in a patch request.
 *
 * @param {string} key - a key from {@link PREF_KEYS}.
 * @param {unknown} value - the candidate value.
 * @returns {boolean | string} the value to store.
 * @throws {Error} when the key is unknown or the value has the wrong type.
 */
export function normalizePref(key, value) {
  if (!PREF_KEYS.includes(key)) throw new Error(`unknown preference "${key}"`);
  if (STRING_PREF_KEYS.includes(key)) {
    if (typeof value !== "string") throw new Error(`preference "${key}" must be a string`);
    const trimmed = value.trim();
    if (trimmed.length > MAX_PREF_STRING) {
      throw new Error(`preference "${key}" must be at most ${MAX_PREF_STRING} characters`);
    }
    return trimmed;
  }
  if (typeof value !== "boolean") throw new Error(`preference "${key}" must be a boolean`);
  return value;
}

/**
 * {@link normalizePref} for values read off disk: unusable ones are dropped
 * rather than thrown, because a hand-edited file must not stop the plugin.
 *
 * @param {string} key - a preference key.
 * @param {unknown} value - the stored value.
 * @returns {boolean | string | undefined} the value, or undefined to drop it.
 */
function readPref(key, value) {
  try {
    return normalizePref(key, value);
  } catch {
    return undefined;
  }
}

/** Debounce window for coalescing disk writes. */
const FLUSH_DELAY_MS = 400;

/** Generate a short, collision-resistant id. */
function makeId() {
  return Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);
}

/**
 * Coerce a stored value into a well-formed feed record, dropping anything
 * unusable. Defensive because the file is user-editable and may predate a
 * schema change.
 *
 * @param {unknown} raw - candidate record.
 * @param {number} maxItems - per-feed retention cap.
 * @returns {object | null} the normalized record, or null when unusable.
 */
function normalizeFeed(raw, maxItems) {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return null;
  const record = /** @type {Record<string, unknown>} */ (raw);
  const url = typeof record.url === "string" ? record.url.trim() : "";
  if (url.length === 0) return null;
  const items = Array.isArray(record.items)
    ? record.items
        .filter((item) => item !== null && typeof item === "object" && !Array.isArray(item))
        .map((item) => {
          const entry = /** @type {Record<string, unknown>} */ (item);
          return {
            id: typeof entry.id === "string" ? entry.id : "",
            title: typeof entry.title === "string" ? entry.title : "(untitled)",
            link: typeof entry.link === "string" ? entry.link : "",
            summary: typeof entry.summary === "string" ? entry.summary : "",
            summaryMarkdown: typeof entry.summaryMarkdown === "string" ? entry.summaryMarkdown : "",
            content: typeof entry.content === "string" ? entry.content : "",
            markdown: typeof entry.markdown === "string" ? entry.markdown : "",
            author: typeof entry.author === "string" ? entry.author : "",
            date: typeof entry.date === "string" ? entry.date : "",
            categories: Array.isArray(entry.categories)
              ? entry.categories.filter((c) => typeof c === "string").slice(0, 5)
              : [],
            enclosure: typeof entry.enclosure === "string" ? entry.enclosure : "",
            read: entry.read === true,
            starred: entry.starred === true,
            // A cached translation, kept across refreshes like the flags.
            translation: normalizeTranslationRecord(entry.translation)
          };
        })
        .filter((item) => item.id.length > 0 || item.link.length > 0 || item.title.length > 0)
        .slice(0, maxItems)
    : [];

  return {
    id: typeof record.id === "string" && record.id.length > 0 ? record.id : makeId(),
    url,
    title: typeof record.title === "string" && record.title.length > 0 ? record.title : url,
    siteLink: typeof record.siteLink === "string" ? record.siteLink : "",
    description: typeof record.description === "string" ? record.description : "",
    image: typeof record.image === "string" ? record.image : "",
    format: typeof record.format === "string" ? record.format : "",
    group: typeof record.group === "string" ? record.group : "",
    addedAt: typeof record.addedAt === "string" ? record.addedAt : new Date().toISOString(),
    fetchedAt: typeof record.fetchedAt === "string" ? record.fetchedAt : "",
    lastError: typeof record.lastError === "string" ? record.lastError : "",
    etag: typeof record.etag === "string" ? record.etag : "",
    lastModified: typeof record.lastModified === "string" ? record.lastModified : "",
    items
  };
}

/**
 * Validate a stored translation, dropping anything unusable.
 *
 * Translations are expensive to produce, so they are persisted; this keeps a
 * hand-edited or half-written file from poisoning the reader.
 *
 * @param {unknown} raw - candidate translation.
 * @returns {object | null} the normalized translation, or null.
 */
function normalizeTranslationRecord(raw) {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return null;
  const record = /** @type {Record<string, unknown>} */ (raw);
  const markdown = typeof record.markdown === "string" ? record.markdown : "";
  const title = typeof record.title === "string" ? record.title : "";
  if (markdown.trim().length === 0 && title.trim().length === 0) return null;
  // The translated blocks, in source order, when the model answered per
  // segment. Stored so the side-by-side view survives a reload without asking
  // the model again — a translation is the expensive part.
  const segments = Array.isArray(record.segments)
    ? record.segments.filter((entry) => typeof entry === "string").slice(0, 500)
    : [];
  return {
    title,
    markdown,
    ...(segments.length > 0 ? { segments } : {}),
    target: typeof record.target === "string" ? record.target : "",
    language: typeof record.language === "string" ? record.language : "",
    model: typeof record.model === "string" ? record.model : "",
    at: typeof record.at === "string" ? record.at : ""
  };
}

/**
 * A subscription store backed by a single JSON document.
 *
 * Writes are debounced; call {@link FeedStore#flush} (or `dispose`) when the
 * process is about to end.
 */
export class FeedStore {
  /**
   * @param {object} [options] - store options.
   * @param {string} options.file - absolute path of the JSON state file.
   * @param {number} [options.maxItemsPerFeed] - retention per feed.
   * @param {number} [options.maxFeeds] - subscription cap.
   */
  constructor(options = {}) {
    if (typeof options.file !== "string" || options.file.length === 0) {
      throw new Error("FeedStore requires a file path");
    }
    this.file = options.file;
    this.maxItemsPerFeed = Math.max(1, options.maxItemsPerFeed ?? DEFAULT_MAX_ITEMS);
    this.maxFeeds = Math.max(1, options.maxFeeds ?? DEFAULT_MAX_FEEDS);
    /** @type {Map<string, object>} */
    this.feeds = new Map();
    /**
     * View preferences the user has set explicitly.
     *
     * Only the keys in {@link PREF_KEYS} ever appear here, and only once the
     * user has chosen a value — anything absent falls back to the plugin
     * config, so clearing the file returns the plugin to its configured
     * defaults rather than pinning whatever the last click happened to be.
     *
     * @type {Record<string, boolean>}
     */
    this.prefValues = {};
    /**
     * The subscription order the user arranged, as feed ids.
     *
     * A list rather than a position on each feed: "move this one up" is a change
     * to its neighbours too, and a list keeps that one edit instead of several
     * writes that can disagree. Ids the store no longer has are ignored when
     * reading; feeds the list does not mention keep their place at the end, so a
     * new subscription appends instead of landing in the middle of an
     * arrangement the user already made.
     *
     * @type {string[]}
     */
    this.feedOrder = [];
    this.loaded = false;
    /** In-flight load, shared by concurrent callers. */
    this.loadPromise = undefined;
    this.writeTimer = undefined;
    this.writeChain = Promise.resolve();
    this.lastWriteError = "";
  }

  /**
   * Load state from disk, tolerating a missing or corrupt file.
   *
   * Concurrent callers share one in-flight load: the flag alone is not enough,
   * because it would flip before the file was actually read and every later
   * caller would observe an empty store.
   *
   * @returns {Promise<FeedStore>} this store, once loaded.
   */
  async load() {
    if (this.loaded) return this;
    if (this.loadPromise !== undefined) return this.loadPromise;
    this.loadPromise = this.#load().finally(() => {
      this.loaded = true;
      this.loadPromise = undefined;
    });
    return this.loadPromise;
  }

  /** Perform the actual read; see {@link FeedStore#load}. */
  async #load() {
    let text;
    try {
      text = await readFile(this.file, "utf8");
    } catch (error) {
      if (error?.code !== "ENOENT") {
        this.lastWriteError = `could not read store: ${error instanceof Error ? error.message : String(error)}`;
      }
      return this;
    }
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch {
      // Preserve the unreadable file rather than silently overwriting it.
      try {
        await rename(this.file, `${this.file}.corrupt-${Date.now()}`);
      } catch {
        /* best effort */
      }
      this.lastWriteError = "store file was not valid JSON; it has been moved aside";
      return this;
    }
    const list = Array.isArray(parsed?.feeds) ? parsed.feeds : [];
    for (const raw of list) {
      const record = normalizeFeed(raw, this.maxItemsPerFeed);
      if (record !== null) this.feeds.set(record.id, record);
    }
    const prefs = parsed?.prefs;
    if (prefs !== null && typeof prefs === "object" && !Array.isArray(prefs)) {
      for (const key of PREF_KEYS) {
        const value = readPref(key, prefs[key]);
        // An empty string is not a choice: it means "follow the plugin config",
        // which is exactly what leaving the key out does.
        if (value !== undefined && value !== "") this.prefValues[key] = value;
      }
    }
    this.feedOrder = Array.isArray(parsed?.feedOrder)
      ? parsed.feedOrder.filter((id) => typeof id === "string")
      : [];
    return this;
  }

  /** The serializable state document. */
  toJSON() {
    return {
      version: STORE_VERSION,
      savedAt: new Date().toISOString(),
      prefs: { ...this.prefValues },
      // Normalized on the way out: the stored arrangement never accumulates
      // deleted ids, and never omits a feed that was added since.
      feedOrder: this.orderedIds(),
      feeds: [...this.feeds.values()]
    };
  }

  /** Schedule a debounced write; the promise resolves once it lands. */
  scheduleSave() {
    if (this.writeTimer !== undefined) clearTimeout(this.writeTimer);
    this.writeTimer = setTimeout(() => {
      this.writeTimer = undefined;
      void this.flush();
    }, FLUSH_DELAY_MS);
    // A pending timer must not hold the process open.
    this.writeTimer.unref?.();
    return this.writeChain;
  }

  /**
   * Write immediately, serializing behind any in-flight write.
   *
   * The pending load is awaited first: writing before the file has been read
   * would persist an empty subscription list over a real one.
   *
   * @returns {Promise<void>} resolves once this write (and any earlier one) lands.
   */
  flush() {
    if (this.writeTimer !== undefined) {
      clearTimeout(this.writeTimer);
      this.writeTimer = undefined;
    }
    this.writeChain = this.writeChain
      .then(async () => {
        await this.load();
        const document = JSON.stringify(this.toJSON(), null, 2);
        await mkdir(dirname(this.file), { recursive: true });
        const temp = `${this.file}.tmp-${process.pid}`;
        await writeFile(temp, document, "utf8");
        await rename(temp, this.file);
        this.lastWriteError = "";
      })
      .catch((error) => {
        this.lastWriteError = `could not save store: ${error instanceof Error ? error.message : String(error)}`;
      });
    return this.writeChain;
  }

  /** Flush pending writes and release timers. */
  async dispose() {
    await this.flush();
  }

  /**
   * The subscription order in force: the user's arrangement first, then
   * everything they have not placed, in the order it was added.
   *
   * @returns {string[]} every feed id, exactly once.
   */
  orderedIds() {
    const ordered = [];
    const seen = new Set();
    for (const id of this.feedOrder) {
      if (this.feeds.has(id) && !seen.has(id)) {
        seen.add(id);
        ordered.push(id);
      }
    }
    for (const id of this.feeds.keys()) if (!seen.has(id)) ordered.push(id);
    return ordered;
  }

  /**
   * Replace the subscription order.
   *
   * Ids the store does not have are ignored — a client reordering a list it read
   * a moment ago may name a feed that has since been removed, and refusing the
   * whole arrangement over that would lose the user's edit. Feeds the caller
   * leaves out keep their relative place at the end.
   *
   * @param {string[]} ids - the wanted order.
   * @returns {Promise<string[]>} the order that is now in force.
   */
  async setOrder(ids) {
    // Load first: the arrangement must be merged into the real subscription
    // list, not into an empty store that the file would then overwrite.
    await this.load();
    const wanted = [];
    const seen = new Set();
    for (const id of Array.isArray(ids) ? ids : []) {
      if (typeof id === "string" && this.feeds.has(id) && !seen.has(id)) {
        seen.add(id);
        wanted.push(id);
      }
    }
    for (const id of this.orderedIds()) if (!seen.has(id)) wanted.push(id);
    this.feedOrder = wanted;
    await this.flush();
    return [...this.feedOrder];
  }

  /** All feed records, in the order the user arranged. */
  list() {
    return this.orderedIds().map((id) => this.feeds.get(id));
  }

  /** Look up a feed by id. */
  get(id) {
    return typeof id === "string" ? this.feeds.get(id) : undefined;
  }

  /** Find a feed by its URL (normalized comparison). */
  findByUrl(url) {
    const wanted = typeof url === "string" ? url.trim() : "";
    if (wanted.length === 0) return undefined;
    for (const feed of this.feeds.values()) if (feed.url === wanted) return feed;
    return undefined;
  }

  /**
   * Add a subscription.
   * @param {object} input - feed fields (`url` required).
   * @returns {{feed: object, created: boolean}} the stored record.
   * @throws {Error} when the URL is missing or the cap is reached.
   */
  add(input) {
    const url = typeof input?.url === "string" ? input.url.trim() : "";
    if (url.length === 0) throw new Error("feed URL is required");
    const existing = this.findByUrl(url);
    if (existing !== undefined) {
      // Re-adding an existing URL refreshes its label instead of duplicating.
      if (typeof input.title === "string" && input.title.trim().length > 0) existing.title = input.title.trim();
      this.scheduleSave();
      return { feed: existing, created: false };
    }
    if (this.feeds.size >= this.maxFeeds) {
      throw new Error(`subscription limit reached (${this.maxFeeds} feeds)`);
    }
    const now = new Date().toISOString();
    const feed = {
      id: makeId(),
      url,
      title: typeof input.title === "string" && input.title.trim().length > 0 ? input.title.trim() : url,
      siteLink: typeof input.siteLink === "string" ? input.siteLink : "",
      description: typeof input.description === "string" ? input.description : "",
      image: typeof input.image === "string" ? input.image : "",
      format: typeof input.format === "string" ? input.format : "",
      group: typeof input.group === "string" ? input.group.trim() : "",
      addedAt: now,
      fetchedAt: "",
      lastError: "",
      etag: "",
      lastModified: "",
      items: []
    };
    this.feeds.set(feed.id, feed);
    this.scheduleSave();
    return { feed, created: true };
  }

  /** Remove a feed by id; returns true when something was removed. */
  remove(id) {
    const existed = this.feeds.delete(id);
    if (existed) this.scheduleSave();
    return existed;
  }

  /**
   * Apply partial updates to a feed's metadata.
   * @param {string} id - feed id.
   * @param {object} patch - fields to merge.
   * @returns {object | undefined} the updated record.
   */
  update(id, patch) {
    const feed = this.feeds.get(id);
    if (feed === undefined) return undefined;
    const allowed = ["title", "group", "siteLink", "description", "image", "format", "url"];
    for (const key of allowed) {
      if (patch?.[key] === undefined) continue;
      if (typeof patch[key] !== "string") continue;
      const value = patch[key].trim();
      if (key === "title" && value.length === 0) continue;
      if (key === "url") {
        if (value.length === 0) continue;
        feed.url = value;
        continue;
      }
      feed[key] = value;
    }
    this.scheduleSave();
    return feed;
  }

  /**
   * Merge freshly fetched items into a feed.
   *
   * Read/starred flags are preserved for items already known, and new items
   * are prepended; the result is trimmed to the retention cap.
   *
   * @param {string} id - feed id.
   * @param {object} result - outcome of a fetch (see `lib/refresh.js`).
   * @returns {{feed: object, added: number, total: number} | undefined} summary.
   */
  applyFetch(id, result) {
    const feed = this.feeds.get(id);
    if (feed === undefined) return undefined;

    if (result?.notModified === true) {
      feed.fetchedAt = new Date().toISOString();
      feed.lastError = "";
      if (typeof result.etag === "string" && result.etag.length > 0) feed.etag = result.etag;
      if (typeof result.lastModified === "string" && result.lastModified.length > 0) {
        feed.lastModified = result.lastModified;
      }
      this.scheduleSave();
      return { feed, added: 0, total: feed.items.length };
    }

    const incoming = Array.isArray(result?.feed?.items) ? result.feed.items : [];
    const known = new Map();
    for (const item of feed.items) known.set(item.id || item.link, item);

    let added = 0;
    const merged = [];
    for (const item of incoming) {
      const key = item.id || item.link;
      const previous = known.get(key);
      if (previous === undefined) {
        added += 1;
        merged.push({ ...item, read: false, starred: false, translation: null });
      } else {
        // Keep the locally recorded flags and any cached translation; refresh
        // the presentation fields. A translation is expensive to produce, so
        // losing it on a routine refresh would be a real regression.
        merged.push({
          ...item,
          read: previous.read === true,
          starred: previous.starred === true,
          translation: previous.translation ?? null
        });
        known.delete(key);
      }
    }
    // Items that vanished upstream are dropped, keeping the cache a mirror.
    feed.items = merged.slice(0, this.maxItemsPerFeed);

    if (typeof result.feed?.title === "string" && result.feed.title.length > 0) feed.title = result.feed.title;
    if (typeof result.feed?.link === "string" && result.feed.link.length > 0) feed.siteLink = result.feed.link;
    if (typeof result.feed?.description === "string") feed.description = result.feed.description;
    if (typeof result.feed?.image === "string") feed.image = result.feed.image;
    if (typeof result.feed?.format === "string") feed.format = result.feed.format;
    if (typeof result.url === "string" && result.url.length > 0) feed.url = result.url;
    feed.etag = typeof result.etag === "string" ? result.etag : "";
    feed.lastModified = typeof result.lastModified === "string" ? result.lastModified : "";
    feed.fetchedAt = new Date().toISOString();
    feed.lastError = "";

    this.scheduleSave();
    return { feed, added, total: feed.items.length };
  }

  /**
   * Record a failed fetch without discarding cached items.
   * @param {string} id - feed id.
   * @param {string} message - failure text.
   * @returns {object | undefined} the updated record.
   */
  applyError(id, message) {
    const feed = this.feeds.get(id);
    if (feed === undefined) return undefined;
    feed.lastError = typeof message === "string" && message.length > 0 ? message : "refresh failed";
    feed.fetchedAt = new Date().toISOString();
    this.scheduleSave();
    return feed;
  }

  /**
   * Fold backfilled older articles into a feed.
   *
   * Deliberately not a refresh: the feed's own entries stay exactly as they are,
   * because a backfill exists precisely because *more* is wanted than the feed
   * window holds. Newly fetched items are added, everything is re-sorted
   * newest-first, and the per-feed cap applies last — so the cap trims the
   * oldest articles, never the feed's own recent ones.
   *
   * @param {string} id - feed id.
   * @param {object[]} items - items to add.
   * @returns {{added: number, total: number} | undefined} the outcome.
   */
  addItems(id, items) {
    const feed = this.feeds.get(id);
    if (feed === undefined) return undefined;
    const incoming = Array.isArray(items) ? items : [];
    if (incoming.length === 0) return { added: 0, total: feed.items.length };

    const known = new Set(feed.items.map((item) => item.id || item.link));
    const additions = [];
    for (const item of incoming) {
      const key = item?.id || item?.link;
      if (typeof key !== "string" || key.length === 0 || known.has(key)) continue;
      known.add(key);
      additions.push({
        id: key,
        title: typeof item.title === "string" ? item.title : "(untitled)",
        link: typeof item.link === "string" ? item.link : "",
        summary: typeof item.summary === "string" ? item.summary : "",
        summaryMarkdown: typeof item.summaryMarkdown === "string" ? item.summaryMarkdown : "",
        content: typeof item.content === "string" ? item.content : "",
        markdown: typeof item.markdown === "string" ? item.markdown : "",
        author: typeof item.author === "string" ? item.author : "",
        date: typeof item.date === "string" ? item.date : "",
        categories: Array.isArray(item.categories) ? item.categories.filter((c) => typeof c === "string") : [],
        enclosure: typeof item.enclosure === "string" ? item.enclosure : "",
        read: item.read === true,
        starred: item.starred === true,
        translation: null
      });
    }
    if (additions.length === 0) return { added: 0, total: feed.items.length };

    // Newest first, undated items last — the same order the reader renders in.
    const merged = [...feed.items, ...additions].sort((left, right) => {
      if (left.date === right.date) return 0;
      if (left.date.length === 0) return 1;
      if (right.date.length === 0) return -1;
      return right.date.localeCompare(left.date);
    });
    feed.items = merged.slice(0, this.maxItemsPerFeed);
    this.scheduleSave();
    return { added: additions.length, total: feed.items.length };
  }

  /**
   * Locate one item by id or link.
   * @param {string} feedId - feed id.
   * @param {string} itemId - item id or link.
   * @returns {{feed: object, item: object} | undefined} the pair, when found.
   */
  findItem(feedId, itemId) {
    const feed = this.feeds.get(feedId);
    if (feed === undefined) return undefined;
    const item = feed.items.find((candidate) => candidate.id === itemId || candidate.link === itemId);
    if (item === undefined) return undefined;
    return { feed, item };
  }

  /**
   * Mark one item read or starred.
   * @param {string} feedId - feed id.
   * @param {string} itemId - item id.
   * @param {{read?: boolean, starred?: boolean}} flags - flags to set.
   * @returns {object | undefined} the updated item.
   */
  setItemFlags(feedId, itemId, flags) {
    const found = this.findItem(feedId, itemId);
    if (found === undefined) return undefined;
    const { item } = found;
    if (typeof flags?.read === "boolean") item.read = flags.read;
    if (typeof flags?.starred === "boolean") item.starred = flags.starred;
    this.scheduleSave();
    return item;
  }

  /**
   * Store (or clear) an item's cached translation.
   * @param {string} feedId - feed id.
   * @param {string} itemId - item id or link.
   * @param {object | null} translation - the translation, or null to clear it.
   * @returns {object | undefined} the updated item.
   */
  setItemTranslation(feedId, itemId, translation) {
    const found = this.findItem(feedId, itemId);
    if (found === undefined) return undefined;
    const { item } = found;
    item.translation = translation === null ? null : normalizeTranslationRecord(translation);
    this.scheduleSave();
    return item;
  }

  /**
   * Mark every item in a feed read (or unread).
   * @param {string} feedId - feed id.
   * @param {boolean} [read] - target state.
   * @returns {number} the number of items changed.
   */
  markAllRead(feedId, read = true) {
    const feed = this.feeds.get(feedId);
    if (feed === undefined) return 0;
    let changed = 0;
    for (const item of feed.items) {
      if (item.read !== read) {
        item.read = read;
        changed += 1;
      }
    }
    if (changed > 0) this.scheduleSave();
    return changed;
  }

  /**
   * The view preferences the user has set, and nothing else.
   *
   * An absent key is not "false": it means the user has never chosen, so the
   * caller must fall back to the plugin config. Returning the defaults here
   * would erase that distinction and make the config option unobservable.
   *
   * @returns {Record<string, boolean>} a copy, so callers cannot mutate state.
   */
  prefs() {
    return { ...this.prefValues };
  }

  /**
   * Persist one preference.
   *
   * Written through immediately rather than debounced: preferences change on a
   * human click, so there is nothing to coalesce, and the click should be
   * durable before the answer reaches the browser.
   *
   * @param {string} key - one of {@link PREF_KEYS}.
   * @param {boolean | string} value - the chosen value; an empty string clears.
   * @returns {Promise<void>} resolves once the document is on disk.
   * @throws when the key is unknown or the value has the wrong type.
   */
  async setPref(key, value) {
    const normalized = normalizePref(key, value);
    // Load first: writing before the file has been read would let the read
    // overwrite the value that was just chosen.
    await this.load();
    // An empty string is "no choice", not "the empty choice": dropping the key
    // is what lets the plugin config's default apply again.
    if (normalized === "") delete this.prefValues[key];
    else this.prefValues[key] = normalized;
    await this.flush();
  }

  /**
   * The read model consumed by the HTTP API and the UI: feeds with derived
   * unread counts, plus aggregate totals.
   *
   * Item *bodies* are omitted unless `withBodies` is set: a full Markdown body
   * is up to tens of kilobytes, so shipping every item of every feed would push
   * megabytes to the browser for a list that only renders titles and summaries.
   * The reading pane fetches one item's body on demand instead.
   *
   * @param {object} [options] - projection options.
   * @param {boolean} [options.withItems] - include each feed's items.
   * @param {number} [options.itemLimit] - max items per feed when included.
   * @param {boolean} [options.withBodies] - include Markdown bodies and bodies
   *   of cached translations.
   * @returns {object} the snapshot.
   */
  snapshot(options = {}) {
    const withItems = options.withItems !== false;
    const withBodies = options.withBodies === true;
    const limit = Math.max(1, options.itemLimit ?? this.maxItemsPerFeed);
    const feeds = [];
    let totalUnread = 0;
    let totalItems = 0;
    let translated = 0;
    let lastFetched = "";

    for (const id of this.orderedIds()) {
      const feed = this.feeds.get(id);
      const unread = feed.items.reduce((count, item) => count + (item.read === true ? 0 : 1), 0);
      totalUnread += unread;
      totalItems += feed.items.length;
      translated += feed.items.reduce((count, item) => count + (item.translation === null || item.translation === undefined ? 0 : 1), 0);
      if (feed.fetchedAt > lastFetched) lastFetched = feed.fetchedAt;
      feeds.push({
        id: feed.id,
        url: feed.url,
        title: feed.title,
        siteLink: feed.siteLink,
        description: feed.description,
        image: feed.image,
        format: feed.format,
        group: feed.group,
        addedAt: feed.addedAt,
        fetchedAt: feed.fetchedAt,
        lastError: feed.lastError,
        unread,
        itemCount: feed.items.length,
        latestDate: feed.items[0]?.date ?? "",
        ...(withItems ? { items: feed.items.slice(0, limit).map((item) => projectItem(item, withBodies)) } : {})
      });
    }

    const groups = [...new Set(feeds.map((feed) => feed.group).filter((group) => group.length > 0))].sort();
    return {
      version: STORE_VERSION,
      feeds,
      groups,
      totals: {
        feeds: feeds.length,
        items: totalItems,
        unread: totalUnread,
        translated,
        lastFetched,
        failures: feeds.filter((feed) => feed.lastError.length > 0).length
      },
      ...(this.lastWriteError.length > 0 ? { warning: this.lastWriteError } : {})
    };
  }
}

/**
 * Project one stored item for the wire.
 *
 * Bodies are opt-in because they dominate the payload; the list view only needs
 * titles, summaries, flags and the translation's existence.
 *
 * @param {object} item - stored item.
 * @param {boolean} withBodies - include Markdown bodies.
 * @returns {object} the projected item.
 */
function projectItem(item, withBodies) {
  const translation = item.translation ?? null;
  const base = {
    id: item.id,
    title: item.title,
    link: item.link,
    summary: item.summary,
    summaryMarkdown: item.summaryMarkdown ?? "",
    author: item.author,
    date: item.date,
    categories: item.categories,
    enclosure: item.enclosure,
    read: item.read === true,
    starred: item.starred === true,
    /** Whether a cached translation exists, so the list can show a marker. */
    translated: translation !== null,
    ...(translation === null ? {} : { translationTarget: translation.target })
  };
  if (!withBodies) return base;
  return {
    ...base,
    content: item.content ?? "",
    markdown: item.markdown ?? "",
    translation
  };
}

/**
 * Resolve the default state-file path for the plugin.
 *
 * Lives under the DSH home so it survives plugin reinstall, and honours
 * `DSH_HOME` the way the rest of the harness does.
 *
 * @param {NodeJS.ProcessEnv} [env] - environment to read.
 * @param {string} [home] - the user's home directory.
 * @returns {string} absolute path of the store file.
 */
export function defaultStorePath(env = process.env, home = undefined) {
  const configured = typeof env.DSH_HOME === "string" && env.DSH_HOME.trim().length > 0 ? env.DSH_HOME.trim() : "";
  const base = configured.length > 0
    ? configured
    : join(home ?? process.env.USERPROFILE ?? process.env.HOME ?? ".", ".dsh");
  return join(base, "rss-reader", "feeds.json");
}

/** Whether a store file already exists at the default location. */
export function storeExists(file) {
  return existsSync(file);
}
