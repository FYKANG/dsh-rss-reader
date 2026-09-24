/**
 * dsh-rss-reader — refresh orchestration.
 *
 * Sits between the store and the network layer and owns the policy that the
 * API and the UI both need:
 *
 * - **bounded concurrency**: feeds refresh in small parallel batches so a
 *   hundred subscriptions do not open a hundred sockets at once;
 * - **per-feed isolation**: one dead feed never fails the whole refresh — its
 *   error is recorded and the others proceed;
 * - **de-duplication**: a refresh already in flight is reused, so repeated
 *   button presses (or the periodic timer) cannot stack requests;
 * - **intelligent update**: conditional GET via stored ETag/Last-Modified.
 *
 * @module dsh-rss-reader/refresh
 */

import { FeedFetchError, fetchFeed } from "./fetch.js";

/** Default parallelism for a multi-feed refresh. */
export const DEFAULT_CONCURRENCY = 4;

/**
 * Run `worker` over `items` with at most `limit` in flight.
 *
 * Results keep input order regardless of completion order, so the UI's feed
 * list does not reshuffle between refreshes.
 *
 * @template T, R
 * @param {T[]} items - work items.
 * @param {number} limit - maximum parallel workers (clamped to >= 1).
 * @param {(item: T, index: number) => Promise<R>} worker - async task.
 * @returns {Promise<R[]>} results in input order.
 */
export async function mapWithConcurrency(items, limit, worker) {
  const list = Array.isArray(items) ? items : [];
  const results = new Array(list.length);
  if (list.length === 0) return results;
  const width = Math.max(1, Math.min(Math.floor(limit) || 1, list.length));
  let cursor = 0;

  const runners = Array.from({ length: width }, async () => {
    for (;;) {
      const index = cursor;
      cursor += 1;
      if (index >= list.length) return;
      results[index] = await worker(list[index], index);
    }
  });

  await Promise.all(runners);
  return results;
}

/**
 * Refresh a single feed and fold the outcome into the store.
 *
 * Never throws: failures are recorded on the feed record so the UI can show a
 * per-feed error while keeping whatever was cached.
 *
 * @param {import("./store.js").FeedStore} store - subscription store.
 * @param {string} feedId - feed id.
 * @param {object} [options] - refresh options (fetch options plus `force`).
 * @returns {Promise<{feedId: string, ok: boolean, added: number, total: number,
 *   notModified: boolean, error?: string, code?: string}>} the outcome.
 */
export async function refreshFeed(store, feedId, options = {}) {
  const feed = store.get(feedId);
  if (feed === undefined) {
    return { feedId, ok: false, added: 0, total: 0, notModified: false, error: "feed not found", code: "not-found" };
  }

  try {
    const result = await fetchFeed(feed.url, {
      timeoutMs: options.timeoutMs,
      maxBytes: options.maxBytes,
      // A forced refresh ignores validators and always transfers the body.
      etag: options.force === true ? undefined : feed.etag,
      lastModified: options.force === true ? undefined : feed.lastModified,
      signal: options.signal,
      discover: options.discover,
      env: options.env
    });

    const applied = store.applyFetch(feedId, result);
    return {
      feedId,
      ok: true,
      added: applied?.added ?? 0,
      total: applied?.total ?? 0,
      notModified: result.notModified === true
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const code = error instanceof FeedFetchError ? error.code : "unknown";
    store.applyError(feedId, message);
    return { feedId, ok: false, added: 0, total: feed.items.length, notModified: false, error: message, code };
  }
}

/**
 * Refresh many feeds (or every feed) with per-feed isolation.
 *
 * @param {import("./store.js").FeedStore} store - subscription store.
 * @param {object} [options] - refresh options.
 * @param {string[]} [options.ids] - specific feed ids; defaults to all.
 * @param {number} [options.concurrency] - parallel workers.
 * @returns {Promise<{results: Array<object>, refreshed: number, failed: number,
 *   added: number, startedAt: string, finishedAt: string}>} the batch summary.
 */
export async function refreshFeeds(store, options = {}) {
  const startedAt = new Date().toISOString();
  const targets = Array.isArray(options.ids) && options.ids.length > 0
    ? options.ids.filter((id) => store.get(id) !== undefined)
    : store.list().map((feed) => feed.id);

  const results = await mapWithConcurrency(
    targets,
    options.concurrency ?? DEFAULT_CONCURRENCY,
    (id) => refreshFeed(store, id, options)
  );

  const failed = results.filter((result) => result.ok !== true).length;
  const refreshed = results.length - failed;
  const added = results.reduce((sum, result) => sum + (result.ok ? result.added : 0), 0);

  return {
    results,
    refreshed,
    failed,
    added,
    startedAt,
    finishedAt: new Date().toISOString()
  };
}

/**
 * A re-entrancy guard around a refresh: while one runs, callers receive the
 * same promise instead of starting a second pass.
 */
export class RefreshCoordinator {
  constructor() {
    /** @type {Promise<object> | undefined} */
    this.inFlight = undefined;
    this.lastResult = undefined;
  }

  /** Whether a refresh is currently running. */
  get busy() {
    return this.inFlight !== undefined;
  }

  /**
   * Start (or join) a refresh pass.
   * @param {import("./store.js").FeedStore} store - subscription store.
   * @param {object} [options] - refresh options.
   * @returns {Promise<object>} the batch summary.
   */
  run(store, options = {}) {
    if (this.inFlight !== undefined) return this.inFlight;
    const promise = refreshFeeds(store, options)
      .then((summary) => {
        this.lastResult = summary;
        return summary;
      })
      .finally(() => {
        this.inFlight = undefined;
      });
    this.inFlight = promise;
    return promise;
  }
}
