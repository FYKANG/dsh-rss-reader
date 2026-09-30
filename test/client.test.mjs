/**
 * dsh-rss-reader — client bundle smoke test.
 *
 * The browser half ships as a hand-written `window.__ModuleLoader__.load`
 * registration, so nothing at build time proves it is well-formed. This test
 * reproduces the loader's contract closely enough to catch the failure modes
 * that would otherwise surface only as a blank panel in the running GUI:
 *
 * - the bundle registers under the package name the host expects;
 * - the factory executes with only platform seed modules available, so an
 *   accidental dependency fails here rather than at runtime;
 * - `apply(ctx)` registers the panel key and the matching sidebar entry;
 * - the panel actually renders, in its loading, empty, and populated states,
 *   and its controls drive the host API.
 *
 * React comes from `./react-shim.mjs` (see that file for why), `fetch` is
 * stubbed with the host's real response shapes, and `window` is stubbed
 * because a browser always provides it.
 */

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import { createReactShim } from "./react-shim.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const bundlePath = join(here, "..", "lib", "client.js");

/** The bundle's registered module id, asserted in several tests. */
const MODULE_ID = "dsh-rss-reader";

// ── Test harness ────────────────────────────────────────────────────────────

/**
 * Execute the client bundle against a `window.__ModuleLoader__` double and
 * return the module it registered.
 *
 * @param {Record<string, unknown>} seeds - modules the factory may require.
 * @returns {Promise<{id: string, exports: object, requires: string[]}>} registration.
 */
async function loadBundle(seeds) {
  const source = await readFile(bundlePath, "utf8");
  const requires = [];
  let registration;

  const fakeWindow = {
    __ModuleLoader__: {
      load(entry) {
        registration = entry;
      }
    }
  };

  const originalWindow = globalThis.window;
  globalThis.window = fakeWindow;
  try {
    // The bundle is a plain script that reads `window` from the global scope.
    // It must NOT be passed as a parameter: that would bind `window` lexically
    // for every function the bundle defines, so the panel would keep seeing the
    // loader double instead of the browser window.
    new Function(source)();
  } finally {
    if (originalWindow === undefined) delete globalThis.window;
    else globalThis.window = originalWindow;
  }

  assert.ok(registration !== undefined, "the bundle must call window.__ModuleLoader__.load");
  const exports = registration.factory((specifier) => {
    requires.push(specifier);
    if (!Object.hasOwn(seeds, specifier)) {
      throw new Error(`the bundle required "${specifier}", which is not a platform seed module`);
    }
    return seeds[specifier];
  });

  return { id: registration.id, exports, requires };
}

/** React seeds for the bundle: the shim stands in for the platform's React. */
function seedsFor(shim) {
  return {
    react: shim.react,
    // The panel is written with createElement; the seed is still provided so an
    // accidental jsx-runtime import surfaces as a test failure, not a throw.
    "react/jsx-runtime": {
      jsx: shim.react.createElement,
      jsxs: shim.react.createElement,
      Fragment: shim.react.Fragment
    }
  };
}

/**
 * Run `body` with a browser `window` double installed.
 *
 * The panel legitimately calls `window.addEventListener` (dialog keyboard
 * handling) and `window.confirm` (delete confirmation).
 *
 * @param {(window: object) => Promise<void>} body - the test body.
 * @returns {Promise<void>} resolves when the body and cleanup finish.
 */
async function withWindow(body) {
  const original = globalThis.window;
  const listeners = new Map();
  const double = {
    addEventListener(type, handler) {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type).add(handler);
    },
    removeEventListener(type, handler) {
      listeners.get(type)?.delete(handler);
    },
    confirm: () => true,
    setTimeout: globalThis.setTimeout.bind(globalThis),
    clearTimeout: globalThis.clearTimeout.bind(globalThis)
  };
  globalThis.window = double;
  try {
    await body(double);
  } finally {
    if (original === undefined) delete globalThis.window;
    else globalThis.window = original;
  }
}

/**
 * Install a stub host API for the duration of `body`.
 *
 * @param {(path: string, call: {method: string, body?: object}) => object} handler
 *   returns the response envelope (`{status?, body}`).
 * @param {(api: {calls: object[]}) => Promise<void>} body - the test body.
 * @returns {Promise<void>} resolves when the body and cleanup finish.
 */
async function withApi(handler, body) {
  const original = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, init = {}) => {
    const path = String(url);
    const call = {
      path,
      method: init.method ?? "GET",
      body: init.body === undefined ? undefined : JSON.parse(init.body)
    };
    calls.push(call);
    const envelope = handler(path, call) ?? {};
    const status = envelope.status ?? 200;
    return {
      ok: status >= 200 && status < 300,
      status,
      async json() {
        return envelope.body;
      }
    };
  };
  try {
    await body({ calls });
  } finally {
    globalThis.fetch = original;
  }
}

/**
 * A context double that records slot registrations and runs inject factories.
 *
 * The right Sidebar is an optional service, so its face is reached through
 * `ctx.inject([...])`; the double runs that callback with a derived context
 * carrying the smallest useful faces of the two services.
 *
 * Registrations come back with a real disposer: the left-Sidebar row is
 * withdrawn and re-registered as its preference changes, so a double that
 * ignored the disposer would report a row that is no longer there.
 */
function makeCtx() {
  const registrations = [];
  const injected = [];
  const injectDeps = [];
  const tabTypes = [];
  const opened = [];
  const effects = [];
  const ctx = {
    registrations,
    injected,
    injectDeps,
    tabTypes,
    opened,
    effects,
    slots: {
      inject(key, factory) {
        injected.push(key);
        // The real service runs the factory once its slot exists.
        const dispose = factory();
        return () => {
          const at = injected.lastIndexOf(key);
          if (at >= 0) injected.splice(at, 1);
          if (typeof dispose === "function") dispose();
        };
      },
      register(options, component) {
        const entry = { options, component };
        registrations.push(entry);
        return () => {
          const at = registrations.indexOf(entry);
          if (at >= 0) registrations.splice(at, 1);
        };
      }
    },
    effect(execute, label) {
      effects.push(label);
      const dispose = execute();
      return typeof dispose === "function" ? dispose : () => {};
    },
    inject(deps, callback) {
      injectDeps.push(deps);
      const right = {
        effect(execute, label) {
          effects.push(label);
          const dispose = execute();
          return typeof dispose === "function" ? dispose : () => {};
        },
        sidebarRightTabs: {
          register(definition) {
            tabTypes.push(definition);
            return () => {};
          }
        },
        sidebarRight: {
          openTab(kind) {
            opened.push(kind);
          }
        },
        slots: ctx.slots
      };
      callback(right);
      return { dispose() {} };
    }
  };
  return ctx;
}

/**
 * Install a host stub that answers the preference routes, for the tests that
 * exercise registration rather than the panel's data.
 *
 * @param {object} initial - the effective preferences the host reports.
 * @param {object[]} writes - collects every PATCH body.
 * @param {(api: {calls: object[]}) => Promise<void>} body - the test body.
 * @returns {Promise<void>} resolves when the body finishes.
 */
async function withPrefsApi(initial, writes, body) {
  let current = { ...initial };
  return withApi((path, call) => {
    if (path.endsWith("/prefs")) {
      if (call.method === "PATCH") {
        writes.push(call.body);
        current = { ...current, ...call.body };
      }
      return { body: { ok: true, prefs: current } };
    }
    return { status: 404, body: { ok: false, error: "not stubbed by this test" } };
  }, body);
}

/** The left Sidebar's registered row, or undefined when it is withdrawn. */
function sidebarRow(ctx) {
  return ctx.registrations.find((entry) => entry.options.name === "sidebar.panellist");
}

/** The RSS settings page's registration. */
function settingsSection(ctx) {
  return ctx.registrations.find((entry) => entry.options.name === "settings.section");
}

/** The switch inside a rendered settings row. */
function switchOf(shim, tree) {
  return shim.findAll(tree, "button").find((node) => node.props?.role === "switch");
}

/** The switch carrying a given accessible label, in a rendered settings page. */
function switchByLabel(shim, tree, label) {
  return shim.findAll(tree, "button")
    .find((node) => node.props?.role === "switch" && node.props?.["aria-label"] === label);
}

/** A host state envelope with one feed and two items. */
function populatedState() {
  return {
    version: 1,
    feeds: [
      {
        id: "f1",
        url: "https://s.test/feed",
        title: "示例订阅源",
        siteLink: "https://s.test/",
        description: "desc",
        image: "",
        format: "rss",
        group: "",
        addedAt: "2024-05-01T00:00:00.000Z",
        fetchedAt: new Date().toISOString(),
        lastError: "",
        unread: 2,
        itemCount: 2,
        latestDate: "2024-05-02T10:00:00.000Z",
        items: [
          {
            id: "1", title: "最新一条", link: "https://s.test/1", summary: "摘要一", content: "正文一",
            author: "Ann", date: "2024-05-02T10:00:00.000Z", categories: ["tech"], enclosure: "", read: false, starred: false
          },
          {
            id: "2", title: "较早一条", link: "https://s.test/2", summary: "摘要二", content: "正文二",
            author: "", date: "2024-05-01T10:00:00.000Z", categories: [], enclosure: "", read: true, starred: false
          }
        ]
      }
    ],
    groups: [],
    totals: { feeds: 1, items: 2, unread: 2, lastFetched: new Date().toISOString(), failures: 0 }
  };
}

/** An empty-subscription state envelope. */
function emptyState() {
  return { version: 1, feeds: [], groups: [], totals: { feeds: 0, items: 0, unread: 0, lastFetched: "", failures: 0 } };
}

/** Every node in a rendered tree, depth-first. */
function collectAll(node, out = []) {
  if (node === undefined || node === null) return out;
  out.push(node);
  for (const child of node.children ?? []) collectAll(child, out);
  return out;
}

/**
 * Whether any element carries `needle` as a placeholder.
 *
 * Placeholders are attributes rather than text, so they need their own check.
 *
 * @param {object} tree - rendered tree.
 * @param {string} needle - substring to look for.
 * @returns {boolean} true when found.
 */
function hasPlaceholder(tree, needle) {
  return collectAll(tree).some((node) => String(node.props?.placeholder ?? "").includes(needle));
}

/** Find the first button whose text contains `needle`. */
function buttonByText(shim, tree, needle) {
  return shim.findAll(tree, "button").find((button) => shim.textContent(button).includes(needle));
}

/** Let queued promise callbacks run, so a state update can land. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

// ── Bundle contract ─────────────────────────────────────────────────────────

test("client bundle registers under the package name the host serves", async () => {
  const { id } = await loadBundle(seedsFor(createReactShim()));
  assert.equal(id, MODULE_ID);
});

test("the factory requires only platform seed modules", async () => {
  const { requires } = await loadBundle(seedsFor(createReactShim()));
  for (const specifier of requires) {
    assert.ok(
      specifier === "react" || specifier === "react/jsx-runtime",
      `unexpected module request "${specifier}" — it would miss the module table at runtime`
    );
  }
});

test("the bundle exports the plugin surface the loader expects", async () => {
  const { exports } = await loadBundle(seedsFor(createReactShim()));
  assert.equal(typeof exports.apply, "function");
  assert.ok(Array.isArray(exports.inject), "inject must be an array to be a module plugin");
  assert.equal(typeof exports.RssPanel, "function");
  assert.equal(typeof exports.RssGlyph, "function");
});

test("apply registers the main panel and a sidebar entry sharing one key", async () => {
  const { exports } = await loadBundle(seedsFor(createReactShim()));
  await withPrefsApi({ showSidebarEntry: true }, [], async () => {
    const ctx = makeCtx();
    exports.apply(ctx);
    await settle();

    const panel = ctx.registrations.find((entry) => entry.options.name === "main");
    const sidebar = sidebarRow(ctx);
    assert.ok(panel !== undefined, "no 'main' panel was registered");
    assert.ok(sidebar !== undefined, "no 'sidebar.panellist' entry was registered");

    // The sidebar row dispatches by matching its id to the main panel's key; if
    // these drift apart the button routes nowhere.
    assert.equal(sidebar.options.id, panel.options.key);
    assert.equal(typeof panel.component, "function");
    assert.equal(typeof sidebar.component, "function");
    assert.equal(typeof sidebar.options.label, "function");
    assert.equal(sidebar.options.label(), "RSS");
    assert.equal(sidebar.options.order, 50);
    // The settings page is one section of its own, not rows mixed into 通用.
    assert.deepEqual([...ctx.injected].sort(), [
      "main",
      "settings.section",
      "sidebar.footer.action",
      "sidebar.panellist",
      "sidebar.right.pane.tab"
    ]);
    const section = settingsSection(ctx);
    assert.ok(section !== undefined, "the RSS settings page must be registered");
    assert.equal(section.options.id, "rss-reader");
    assert.equal(section.options.label(), "RSS 阅读器");
    assert.equal(section.options.order, 20, "after 通用 / 模型 / 插件");
  });
});

test("apply registers the right Sidebar tab type, its body seat, and a launcher", async () => {
  const { exports } = await loadBundle(seedsFor(createReactShim()));
  const ctx = makeCtx();
  await withPrefsApi({ showSidebarEntry: true }, [], async () => {
    exports.apply(ctx);
    await settle();
  });

  // The two services are optional, so they are requested through `inject`
  // rather than named in the module's own `inject` array: a build without the
  // right Sidebar must still load the centre panel.
  assert.deepEqual(ctx.injectDeps, [["sidebarRightTabs", "sidebarRight"]]);

  assert.equal(ctx.tabTypes.length, 1);
  const definition = ctx.tabTypes[0];
  assert.equal(definition.id, "dsh-rss-reader");
  assert.equal(definition.kind, "rss-reader");
  assert.equal(definition.title(), "RSS 阅读器");
  // A page type is opened by kind and must not claim resource addresses.
  assert.equal(definition.patterns, undefined);
  assert.equal(definition.guide.length, 1);
  // dsh ≥ 0.1.7 requires an `id` per guide entry: the guide keys each rendered
  // box by it, and the tab registry rejects a type whose entries share one. An
  // entry written against 0.1.5 leaves it undefined.
  assert.equal(definition.guide[0].id, "dsh-rss-reader");
  assert.equal(definition.guide[0].title(), "RSS 阅读器");
  assert.equal(typeof definition.guide[0].description(), "string");
  assert.equal(typeof definition.guide[0].icon, "function");

  // The body seat is keyed by the type's own id: that is how the framework
  // finds the body belonging to a definition.
  const body = ctx.registrations.find((entry) => entry.options.name === "sidebar.right.pane.tab");
  assert.ok(body !== undefined, "no right Sidebar body seat was registered");
  assert.equal(body.options.key, definition.id);

  // Every registration is owned by an effect, so a re-provided registry can
  // register this id again instead of throwing on the duplicate.
  assert.deepEqual([...ctx.effects].sort(), [
    "dsh-rss-reader: left Sidebar row",
    "dsh-rss-reader: right Sidebar launcher",
    "dsh-rss-reader: right Sidebar tab body",
    "dsh-rss-reader: right Sidebar tab type"
  ]);

  // The launcher beside Settings opens exactly this kind.
  const launcher = ctx.registrations.find((entry) => entry.options.name === "sidebar.footer.action");
  assert.ok(launcher !== undefined, "no footer launcher was registered");
  assert.equal(launcher.options.id, "rss-reader");
  const shim = createReactShim();
  const tree = await shim.render(shim.react.createElement(launcher.component, { wide: true }));
  const button = buttonByText(shim, tree, "RSS 阅读器");
  assert.ok(button !== undefined, "the launcher should render a labelled button");
  button.props.onClick();
  assert.deepEqual(ctx.opened, ["rss-reader"]);
});

// ── The RSS settings section ────────────────────────────────────────────────

test("the left Sidebar row follows the stored preference and re-registers on a flip", async () => {
  const shim = createReactShim();
  const { exports } = await loadBundle(seedsFor(shim));
  const writes = [];
  await withPrefsApi({ showSidebarEntry: true }, writes, async () => {
    const ctx = makeCtx();
    exports.apply(ctx);

    // Nothing is registered before the host answers: registering optimistically
    // would flash the row on every load for someone who switched it off.
    assert.equal(sidebarRow(ctx), undefined, "the row must wait for the stored value");
    await settle();
    assert.ok(sidebarRow(ctx) !== undefined, "the row registers once the host says to show it");

    const section = settingsSection(ctx);
    assert.ok(section !== undefined, "the settings page must always be available");

    // Flipping the switch writes the preference and withdraws the row in the
    // same breath — a setting change must not need a page reload.
    let tree = await shim.render(shim.react.createElement(section.component));
    const toggle = switchByLabel(shim, tree, "左侧栏入口");
    assert.ok(toggle !== undefined, "the section should render the entry switch");
    assert.equal(toggle.props["aria-checked"], true);
    toggle.props.onClick();
    await settle();
    await settle();

    assert.deepEqual(writes, [{ showSidebarEntry: false }]);
    assert.equal(sidebarRow(ctx), undefined, "hiding the entry withdraws its registration");

    // ...and flipping it back restores it.
    tree = await shim.render(shim.react.createElement(section.component));
    assert.equal(switchByLabel(shim, tree, "左侧栏入口").props["aria-checked"], false);
    switchByLabel(shim, tree, "左侧栏入口").props.onClick();
    await settle();
    await settle();
    assert.deepEqual(writes, [{ showSidebarEntry: false }, { showSidebarEntry: true }]);
    assert.ok(sidebarRow(ctx) !== undefined, "the row comes back");
  });
});

test("a hidden entry stays hidden at startup", async () => {
  const { exports } = await loadBundle(seedsFor(createReactShim()));
  await withPrefsApi({ showSidebarEntry: false }, [], async () => {
    const ctx = makeCtx();
    exports.apply(ctx);
    await settle();
    assert.equal(sidebarRow(ctx), undefined, "a stored false must survive a reload");
    // The panel itself is unaffected: hiding an entry is not disabling it.
    assert.ok(ctx.registrations.some((entry) => entry.options.name === "main"));
    assert.ok(settingsSection(ctx) !== undefined, "the way back must be there");
  });
});

test("the section holds both switches, each writing its own preference", async () => {
  const shim = createReactShim();
  const { exports } = await loadBundle(seedsFor(shim));
  const writes = [];
  await withPrefsApi({ showSidebarEntry: true, expandImages: false }, writes, async () => {
    const ctx = makeCtx();
    exports.apply(ctx);
    await settle();

    const section = settingsSection(ctx);
    assert.equal(typeof section.component, "function");
    let tree = await shim.render(shim.react.createElement(section.component));
    const text = shim.textContent(tree);
    assert.match(text, /左侧栏入口/);
    assert.match(text, /正文图片直接展开/);
    assert.match(text, /订阅源顺序/, "the order control belongs on this page");

    // Two switches, two keys: the image one must not touch the entry one.
    const imageToggle = switchByLabel(shim, tree, "正文图片直接展开");
    assert.equal(imageToggle.props["aria-checked"], false, "pictures start folded");
    imageToggle.props.onClick();
    await settle();
    await settle();
    assert.deepEqual(writes, [{ expandImages: true }]);

    tree = await shim.render(shim.react.createElement(section.component));
    switchByLabel(shim, tree, "左侧栏入口").props.onClick();
    await settle();
    await settle();
    assert.deepEqual(writes, [{ expandImages: true }, { showSidebarEntry: false }]);
  });
});

test("the settings section reorders subscriptions with the arrow buttons", async () => {
  const shim = createReactShim();
  const { exports } = await loadBundle(seedsFor(shim));
  const state = populatedState();
  state.feeds = [
    { ...state.feeds[0], id: "f1", title: "First" },
    { ...state.feeds[0], id: "f2", title: "Second" },
    { ...state.feeds[0], id: "f3", title: "Third" }
  ];
  const orders = [];
  await withPrefsApi({ showSidebarEntry: true }, [], async () => {
    const panelApi = (path, call) => {
      if (path.includes("/feeds/order")) {
        orders.push(call.body.ids);
        const byId = new Map(state.feeds.map((feed) => [feed.id, feed]));
        state.feeds = call.body.ids.map((id) => byId.get(id)).filter(Boolean);
        return { body: { ok: true, order: call.body.ids, state } };
      }
      return { body: { ok: true, state, refreshing: false } };
    };
    await withApi(panelApi, async () => {
      const ctx = makeCtx();
      exports.apply(ctx);
      await settle();
      const section = settingsSection(ctx);
      let tree = await shim.render(shim.react.createElement(section.component));
      await settle();
      tree = await shim.render(shim.react.createElement(section.component));
      assert.match(shim.textContent(tree), /First/);

      // Moving the third subscription up one step is a single write of the whole
      // order — the shape the host stores.
      const buttons = shim.findAll(tree, "button").filter((node) => ["↑", "↓"].includes(shim.textContent(node)));
      assert.equal(buttons.length, 6, "every row offers both directions");
      assert.equal(buttons[4].props.disabled, false, "the last row can move up");
      buttons[4].props.onClick();
      await settle();
      await settle();
      assert.deepEqual(orders, [["f1", "f3", "f2"]]);

      tree = await shim.render(shim.react.createElement(section.component));
      const rows = shim.findAll(tree, "div").filter((node) => String(node.props?.style?.borderBottom ?? "").includes("0.5px"));
      assert.ok(rows.length >= 3, "the list still renders every subscription");
      // The first row cannot go up, and the last cannot go down: the ends are
      // disabled rather than silently doing nothing.
      const after = shim.findAll(tree, "button").filter((node) => ["↑", "↓"].includes(shim.textContent(node)));
      assert.deepEqual(after.map((node) => node.props.disabled), [true, false, false, false, false, true]);
      assert.match(shim.textContent(tree), /Second[^]*Third|Third[^]*Second/);
    });
  });
});

test("the settings section reports a refused write and rolls the switch back", async () => {
  const shim = createReactShim();
  const { exports } = await loadBundle(seedsFor(shim));
  await withPrefsApi({ showSidebarEntry: true }, [], async () => {
    // The read succeeds; the write is refused.
    const original = globalThis.fetch;
    globalThis.fetch = async (url, init = {}) => {
      if (String(url).endsWith("/prefs") && init.method === "PATCH") {
        return { ok: false, status: 400, async json() { return { ok: false, error: "unknown preference" }; } };
      }
      return original(url, init);
    };
    try {
      const ctx = makeCtx();
      exports.apply(ctx);
      await settle();
      const section = settingsSection(ctx);
      const tree = await shim.render(shim.react.createElement(section.component));
      switchByLabel(shim, tree, "左侧栏入口").props.onClick();
      await settle();
      await settle();

      const after = await shim.render(shim.react.createElement(section.component));
      assert.match(shim.textContent(after), /unknown preference/, "the failure must be visible");
      assert.equal(switchByLabel(shim, after, "左侧栏入口").props["aria-checked"], true,
        "the switch must not lie about what was saved");
      assert.ok(sidebarRow(ctx) !== undefined, "the row must still be registered");
    } finally {
      globalThis.fetch = original;
    }
  });
});

// ── Reordering in the panel ─────────────────────────────────────────────────

/** A state envelope with three subscriptions, in a known order. */
function threeFeedState() {
  const base = populatedState();
  const template = base.feeds[0];
  return { ...base, feeds: [
    { ...template, id: "f1", title: "First", unread: 1 },
    { ...template, id: "f2", title: "Second", unread: 2 },
    { ...template, id: "f3", title: "Third", unread: 3 }
  ] };
}

/**
 * A host stub for the panel's reorder flow: `/state` plus the reorder route,
 * which really rearranges the state the panel will read back.
 */
function orderApi(state, orders) {
  return (path, call) => {
    if (path.includes("/feeds/order")) {
      orders.push(call.body.ids);
      const byId = new Map(state.feeds.map((feed) => [feed.id, feed]));
      state.feeds = call.body.ids.map((id) => byId.get(id)).filter(Boolean);
      return { body: { ok: true, order: call.body.ids, state } };
    }
    return { body: { ok: true, state, refreshing: false } };
  };
}

test("dragging one subscription onto another moves it into its place", async () => {
  const shim = createReactShim();
  await withWindow(async () => {
    const { exports } = await loadBundle(seedsFor(shim));
    const state = threeFeedState();
    const orders = [];
    await withApi(orderApi(state, orders), async () => {
      const render = () => shim.render(shim.react.createElement(exports.RssPanel));
      await render();
      await settle();
      let tree = await render();

      const rows = shim.findAll(tree, "button").filter((node) => node.props?.draggable === true);
      assert.equal(rows.length, 3, "every subscription row is draggable");

      // Dragging the third onto the first takes the first's place; the row must
      // not need the reader to aim at a gap.
      rows[2].props.onDragStart({ dataTransfer: { setData() {}, effectAllowed: "" } });
      rows[0].props.onDrop({ preventDefault() {}, dataTransfer: { getData: () => "f3" } });
      await settle();
      await settle();
      assert.deepEqual(orders, [["f3", "f1", "f2"]]);

      tree = await render();
      const titles = shim.findAll(tree, "button")
        .filter((node) => node.props?.draggable === true)
        .map((node) => shim.textContent(node));
      assert.match(titles[0], /Third/, "the panel shows the new order");
    });
  });
});

test("a drag that carries nothing changes nothing", async () => {
  const shim = createReactShim();
  await withWindow(async () => {
    const { exports } = await loadBundle(seedsFor(shim));
    const state = threeFeedState();
    const orders = [];
    await withApi(orderApi(state, orders), async () => {
      const render = () => shim.render(shim.react.createElement(exports.RssPanel));
      await render();
      await settle();
      const tree = await render();
      const rows = shim.findAll(tree, "button").filter((node) => node.props?.draggable === true);

      // A drop with no drag behind it (a stray drop from another window) must
      // not reshuffle the list.
      rows[1].props.onDrop({ preventDefault() {}, dataTransfer: { getData: () => "" } });
      await settle();
      assert.deepEqual(orders, [], "no order write without something being dragged");
    });
  });
});

test("the right-click menu moves a subscription up and down", async () => {
  const shim = createReactShim();
  await withWindow(async () => {
    const { exports } = await loadBundle(seedsFor(shim));
    const state = threeFeedState();
    const orders = [];
    await withApi(orderApi(state, orders), async () => {
      const render = () => shim.render(shim.react.createElement(exports.RssPanel));
      await render();
      await settle();
      let tree = await render();

      const rows = shim.findAll(tree, "button").filter((node) => node.props?.draggable === true);
      // The first row cannot move up, so the entry is absent rather than inert.
      rows[0].props.onContextMenu({ clientX: 10, clientY: 20, preventDefault() {}, stopPropagation() {} });
      await settle();
      tree = await render();
      assert.equal(buttonByExactText(shim, tree, "上移"), undefined, "nothing above the first row");
      assert.ok(buttonByExactText(shim, tree, "下移") !== undefined, "but it can go down");

      buttonByExactText(shim, tree, "下移").props.onClick();
      await settle();
      await settle();
      assert.deepEqual(orders, [["f2", "f1", "f3"]]);

      // And from the middle row, both directions are offered.
      tree = await render();
      const after = shim.findAll(tree, "button").filter((node) => node.props?.draggable === true);
      after[2].props.onContextMenu({ clientX: 10, clientY: 20, preventDefault() {}, stopPropagation() {} });
      await settle();
      tree = await render();
      buttonByExactText(shim, tree, "上移").props.onClick();
      await settle();
      await settle();
      assert.deepEqual(orders, [["f2", "f1", "f3"], ["f2", "f3", "f1"]]);
    });
  });
});

/**
 * A host stub for the RSS settings page: preferences, state, and the RSSHub
 * facts the instance field is built from.
 *
 * @param {object} [options] - `{prefs, stored, hub, reachable, refusePrefs, onPrefs}`.
 * @returns {Function} the handler `withApi` expects.
 */
function settingsApi(options = {}) {
  const values = { showSidebarEntry: true, expandImages: false, ...(options.prefs ?? {}) };
  const stored = [...(options.stored ?? [])];
  const hub = options.hub ?? { enabled: true, explore: true, base: "https://hub.test" };
  return (path, call) => {
    if (path.includes("/prefs")) {
      if (call.method === "PATCH") {
        // Recorded before the refusal, so a test can tell "tried and refused"
        // from "never tried".
        options.onPrefs?.(call.body);
        if (options.refusePrefs === true) {
          return {
            status: 400,
            body: { ok: false, error: "RSSHub 实例地址不可用：需要完整的 http(s) 地址（现在填的是「nope」）" }
          };
        }
        for (const [key, value] of Object.entries(call.body ?? {})) {
          if (value === "") {
            delete values[key];
            const at = stored.indexOf(key);
            if (at >= 0) stored.splice(at, 1);
          } else {
            values[key] = value;
            if (!stored.includes(key)) stored.push(key);
          }
        }
      }
      // The panel caches the answer, so a stub that never reports a stored key
      // makes every write look like the first one — and a later "clear this"
      // write look unnecessary.
      return { body: { ok: true, prefs: values, stored } };
    }
    if (path.includes("/rsshub")) {
      const withCheck = path.includes("check=1") && options.reachable !== undefined ? { reachable: options.reachable } : {};
      return { body: { ok: true, ...hub, ...withCheck } };
    }
    if (path.includes("/models")) {
      if (options.models === undefined) return { status: 503, body: { ok: false, error: "没有可选模型" } };
      return { body: { ok: true, catalog: options.models, stored } };
    }
    if (path.includes("/translate")) {
      // Default mirrors a profile where translation is mounted; a test can pin
      // the unavailable state instead.
      return { body: { ok: true, available: true, provider: "p", model: "m", ...(options.translate ?? {}) } };
    }
    return { body: { ok: true, state: populatedState(), refreshing: false } };
  };
}

/** Render the RSS settings page and let its reads settle. */
async function openSettings(shim, exports) {
  const ctx = makeCtx();
  exports.apply(ctx);
  await settle();
  const section = settingsSection(ctx);
  assert.ok(section !== undefined, "the settings page should be registered");
  const render = () => shim.render(shim.react.createElement(section.component));
  await render();
  await settle();
  return { ctx, tree: await render() };
}

/** The RSSHub instance text field, if the page is showing one. */
function baseField(shim, tree) {
  return shim.findAll(tree, "input").find((node) => String(node.props.placeholder ?? "").includes("rsshub"));
}

test("the settings page points RSSHub at another instance", async () => {
  const shim = createReactShim();
  const { exports } = await loadBundle(seedsFor(shim));
  const writes = [];
  await withApi(settingsApi({
    prefs: { rsshubBase: "https://rsshub.app" },
    reachable: { ok: true, status: 200, error: "" },
    onPrefs: (body) => writes.push(body)
  }), async () => {
    let { tree } = await openSettings(shim, exports);
    const field = baseField(shim, tree);
    assert.ok(field !== undefined, "the instance field should render when RSSHub is on");
    assert.equal(field.props.value, "https://rsshub.app", "it shows the instance in force");
    assert.match(shim.textContent(tree), /当前使用默认实例/, "and says where the value came from");

    // Typing alone changes nothing: the address is only sent when asked.
    field.props.onChange({ target: { value: "https://mirror.test" } });
    await settle();
    assert.deepEqual(writes, [], "no request before 保存");

    tree = (await openSettings(shim, exports)).tree;
    buttonByExactText(shim, tree, "保存").props.onClick();
    await settle();
    await settle();
    await settle();
    assert.deepEqual(writes, [{ rsshubBase: "https://mirror.test" }], "保存 writes exactly the instance URL");

    tree = (await openSettings(shim, exports)).tree;
    assert.match(shim.textContent(tree), /已保存/, "the answer says it was stored");
    assert.match(shim.textContent(tree), /实例可达/, "and whether the instance answered");
    assert.match(shim.textContent(tree), /当前使用自定义实例/, "the page now says the value is the reader's");
  });
});

test("a refused instance address is reported instead of silently kept", async () => {
  const shim = createReactShim();
  const { exports } = await loadBundle(seedsFor(shim));
  const writes = [];
  await withApi(settingsApi({
    prefs: { rsshubBase: "https://rsshub.app" },
    refusePrefs: true,
    onPrefs: (body) => writes.push(body)
  }), async () => {
    let { tree } = await openSettings(shim, exports);
    baseField(shim, tree).props.onChange({ target: { value: "nope" } });
    await settle();
    tree = (await openSettings(shim, exports)).tree;
    buttonByExactText(shim, tree, "保存").props.onClick();
    await settle();
    await settle();
    tree = (await openSettings(shim, exports)).tree;
    assert.match(shim.textContent(tree), /实例地址不可用/, "the host's refusal belongs on the page");
    assert.match(shim.textContent(tree), /当前使用默认实例/, "and nothing was stored");
    assert.ok(writes.length > 0, "the attempt was made");
  });
});

test("仅当地址是自己填的时候才提供「恢复默认」", async () => {
  const shim = createReactShim();
  const { exports } = await loadBundle(seedsFor(shim));
  const writes = [];
  await withApi(settingsApi({
    prefs: { rsshubBase: "https://mirror.test" },
    stored: ["rsshubBase"],
    reachable: { ok: true, status: 200, error: "" },
    onPrefs: (body) => writes.push(body)
  }), async () => {
    let { tree } = await openSettings(shim, exports);
    assert.ok(buttonByExactText(shim, tree, "恢复默认") !== undefined, "a custom address can be given up");
    assert.match(shim.textContent(tree), /当前使用自定义实例/);

    buttonByExactText(shim, tree, "恢复默认").props.onClick();
    await settle();
    await settle();
    assert.deepEqual(writes, [{ rsshubBase: "" }], "clearing is how the plugin default comes back");

    tree = (await openSettings(shim, exports)).tree;
    assert.match(shim.textContent(tree), /当前使用默认实例/);
    assert.equal(buttonByExactText(shim, tree, "恢复默认"), undefined, "and the offer goes away");
  });
});

test("when the host runs no RSSHub there is no instance field to fill in", async () => {
  const shim = createReactShim();
  const { exports } = await loadBundle(seedsFor(shim));
  await withApi(settingsApi({ hub: { enabled: false, explore: false, base: "" } }), async () => {
    const { tree } = await openSettings(shim, exports);
    // A field that changed a disabled feature would be a lie.
    assert.equal(baseField(shim, tree), undefined);
    assert.equal(shim.textContent(tree).includes("「🔍 查找」与「🧭 探索」"), false, "no instance block at all");
    assert.match(shim.textContent(tree), /订阅源顺序/, "the rest of the page is still there");
  });
});

// ── Unsubscribing: right-click menu, then confirmation ──────────────────────

test("unsubscribing needs the right-click menu and then a confirmation", async () => {
  const shim = createReactShim();
  await withWindow(async () => {
    const { exports } = await loadBundle(seedsFor(shim));
    const host = populatedState();
    const calls = [];
    const api = (path, call) => {
      if (path.includes("/feeds?")) {
        calls.push({ path, method: call.method });
        return { body: { ok: true, state: emptyState() } };
      }
      return { body: { ok: true, state: host, refreshing: false } };
    };
    const render = () => shim.render(shim.react.createElement(exports.RssPanel));
    const exactButton = (tree, needle) =>
      shim.findAll(tree, "button").find((node) => shim.textContent(node) === needle);

    await withApi(api, async () => {
      let tree = await render();

      // The row carries no destructive control any more: a stray click can no
      // longer reach one.
      assert.equal(buttonByText(shim, tree, "✕"), undefined, "the feed row still carries a delete button");

      const row = buttonByText(shim, tree, "示例订阅源");
      assert.ok(row !== undefined, "the feed row should render");
      row.props.onContextMenu({ clientX: 40, clientY: 60, preventDefault() {}, stopPropagation() {} });
      await settle();
      tree = await render();

      const unsubscribe = exactButton(tree, "取消订阅…");
      assert.ok(unsubscribe !== undefined, "the right-click menu should offer unsubscribing");
      assert.equal(calls.length, 0, "opening the menu must not unsubscribe anything");

      unsubscribe.props.onClick();
      await settle();
      tree = await render();

      // Second step: the confirmation, before anything is sent.
      assert.match(shim.textContent(tree), /无法撤销/);
      assert.equal(calls.length, 0, "the confirmation must come before the delete");

      // Declining leaves the subscription alone and closes the dialog.
      exactButton(tree, "取消").props.onClick();
      await settle();
      tree = await render();
      assert.equal(calls.length, 0);
      assert.doesNotMatch(shim.textContent(tree), /无法撤销/);
      assert.ok(buttonByText(shim, tree, "示例订阅源") !== undefined, "the feed should still be listed");

      // Confirming is the only path that reaches the host.
      buttonByText(shim, tree, "⋯").props.onClick();
      await settle();
      tree = await render();
      exactButton(tree, "取消订阅…").props.onClick();
      await settle();
      tree = await render();
      exactButton(tree, "确定取消订阅").props.onClick();
      await settle();
      await settle();

      assert.equal(calls.length, 1, "confirming should send exactly one request");
      assert.equal(calls[0].method, "DELETE");
      assert.match(calls[0].path, /\/feeds\?id=f1/);
    });
  });
});

/**
 * A host stub for the panel that also answers the preference routes.
 *
 * The panel needs `/state` (and `/item` when a body is opened) while its fold
 * control needs `/prefs`; neither stub alone covers both.
 *
 * @param {object} host - `{state, item, markdown}` served to the panel.
 * @param {object} [options] - `{prefs, stored, onPrefs}` passed to the prefs stub.
 * @returns {Function} the handler `withApi` expects.
 */
function panelPrefsApi(host, options = {}) {
  const state = host.state === undefined ? {} : host.state;
  const panelApi = markdownApi({ ...host, state });
  const prefsApi = settingsApi({
    prefs: options.prefs ?? {},
    stored: options.stored ?? [],
    onPrefs: options.onPrefs
  });
  return (path, call) => {
    if (path.includes("/prefs")) return prefsApi(path, call);
    return panelApi(path, call);
  };
}

/**
 * Whether the panel is showing its subscription-source strip.
 *
 * Keyed off the strip's own "全部" chip rather than a style, because both
 * presentations and the fold control put `overflowX: "auto"`/arrow glyphs
 * elsewhere in the tree — a style match reports a strip that is not there.
 */
function showingChipStrip(shim, tree) {
  const all = buttonByText(shim, tree, "全部");
  return all !== undefined && shim.textContent(all) === "全部 0";
}

test("the sidebar panel folds its subscription-source row away", async () => {
  const shim = createReactShim();
  await withWindow(async () => {
    const { exports } = await loadBundle(seedsFor(shim));
    const host = markdownState("正文段落一");
    await withApi(panelPrefsApi(host), async () => {
      const render = () => shim.render(shim.react.createElement(exports.RssPanel, { variant: "sidebar" }));

      let tree = await render();
      assert.ok(showingChipStrip(shim, tree), "the strip should start unfolded");
      assert.ok(buttonByText(shim, tree, "全部") !== undefined, "and carry the feed chips");

      // Folding: the row goes, and the header says what the row said.
      buttonByText(shim, tree, "▾").props.onClick();
      await settle();
      tree = await render();
      assert.equal(showingChipStrip(shim, tree), false, "折叠后那一行应该消失");
      assert.equal(buttonByText(shim, tree, "全部"), undefined, "连同它的 chip");
      const folded = buttonByText(shim, tree, "▸");
      assert.ok(folded !== undefined, "the header should offer the way back");
      assert.match(shim.textContent(folded), /订阅源 1/, "and name the source count in the strip's place");

      // Unfolding restores it, still filtered to the same source.
      folded.props.onClick();
      await settle();
      tree = await render();
      assert.ok(showingChipStrip(shim, tree), "展开后那一行应该回来");
    });
  });
});

test("a folded strip reports the source the items are filtered to", async () => {
  const shim = createReactShim();
  await withWindow(async () => {
    const { exports } = await loadBundle(seedsFor(shim));
    const host = markdownState("正文段落一");
    await withApi(panelPrefsApi(host, { prefs: { collapseFeeds: true } }), async () => {
      const render = () => shim.render(shim.react.createElement(exports.RssPanel, { variant: "sidebar" }));

      let tree = await render();
      assert.equal(showingChipStrip(shim, tree), false, "订阅源栏已按偏好折叠");
      assert.match(shim.textContent(buttonByText(shim, tree, "▸")), /订阅源 1/);

      // Unfold, filter to one source, fold again: with the strip away the label
      // is the only thing that can say what the items are filtered to, so it has
      // to follow the filter rather than freeze at the count it started with.
      buttonByText(shim, tree, "▸").props.onClick();
      await settle();
      tree = await render();
      buttonByText(shim, tree, "示例订阅源").props.onClick();
      await settle();
      tree = await render();
      buttonByText(shim, tree, "▾").props.onClick();
      await settle();
      tree = await render();
      assert.match(shim.textContent(buttonByText(shim, tree, "▸")), /示例订阅源/,
        "折叠时表头要说清当前筛的是哪个源");
    });
  });
});

test("the fold is remembered, so it is a preference and not local state", async () => {
  const shim = createReactShim();
  const { exports } = await loadBundle(seedsFor(shim));
  const writes = [];
  await withApi(settingsApi({
    prefs: { collapseFeeds: false },
    onPrefs: (body) => writes.push(body)
  }), async () => {
    let { tree } = await openSettings(shim, exports);
    switchByLabel(shim, tree, "收起订阅源栏").props.onClick();
    await settle();
    await settle();
    assert.deepEqual(writes, [{ collapseFeeds: true }], "开关要写入宿主的偏好，而不是只改本地状态");

    tree = (await openSettings(shim, exports)).tree;
    assert.equal(switchByLabel(shim, tree, "收起订阅源栏").props["aria-checked"], true, "开关应反映已保存的值");
  });
});

test("the wide panel keeps its subscription column", async () => {
  const shim = createReactShim();
  await withWindow(async () => {
    const { exports } = await loadBundle(seedsFor(shim));
    const host = markdownState("正文段落一");
    await withApi(panelPrefsApi(host, { prefs: { collapseFeeds: true } }), async () => {
      // The wide layout's subscription column is where its sources are managed,
      // so the preference must not take it away.
      const tree = await shim.render(shim.react.createElement(exports.RssPanel));
      assert.ok(buttonByText(shim, tree, "全部订阅源") !== undefined,
        "宽面板的订阅源列不该被折叠偏好影响");
    });
  });
});

/** The select carrying a given accessible label, in a rendered settings page. */
function selectByLabel(shim, tree, label) {
  return shim.findAll(tree, "select").find((node) => node.props?.["aria-label"] === label);
}

/** The translation section's "back to the defaults" action. */
function settingsReset(shim, tree) {
  return buttonByExactText(shim, tree, "翻译模型：恢复默认");
}

/** The translation section's "what is in force" line. */
function translateSummaryText(shim, tree) {
  const node = shim.findAll(tree, "div").find((candidate) => String(candidate.props?.children?.[0] ?? "").startsWith("当前使用："));
  return node === undefined ? "" : shim.textContent(node);
}

/**
 * A host stub carrying a two-provider catalogue, one provider with thinking
 * intensities — the shape the picker has to cope with.
 */
function catalogApi(extra = {}) {
  return settingsApi({
    // The route in force, which the picker shows beside the selects.
    translate: { available: true, provider: "deepseek-official", model: "deepseek-flash" },
    models: {
      default: { provider: "deepseek-official", model: "deepseek-flash" },
      routableProviders: ["deepseek-official", "cust"],
      groups: [
        {
          id: "deepseek-official",
          name: "DeepSeek",
          models: [{
            id: "deepseek-flash",
            name: "Flash",
            reasoning: { efforts: [{ id: "low", name: "低" }, { id: "high", name: "高" }], defaultEffort: "high" }
          }]
        },
        { id: "cust", name: "cust", models: [{ id: "qwen3.8-uncensored", name: "QW" }] }
      ],
      failures: []
    },
    ...extra
  });
}

test("the settings page picks the model and thinking intensity translation uses", async () => {
  const shim = createReactShim();
  const { exports } = await loadBundle(seedsFor(shim));
  const writes = [];
  await withApi(catalogApi({ onPrefs: (body) => writes.push(body) }), async () => {
    let { tree } = await openSettings(shim, exports);

    const provider = selectByLabel(shim, tree, "翻译模型服务");
    assert.ok(provider !== undefined, "the provider picker should render when translation is on");
    assert.equal(provider.props.value, "", "and start on the default");
    // Every route the harness reports is offered, not just the session default —
    // choosing a lighter model is the point of the control.
    const providerValues = shim.findAll(provider, "option").map((option) => option.props.value);
    assert.deepEqual(providerValues, ["", "deepseek-official", "cust"]);
    assert.match(translateSummaryText(shim, tree), /当前使用：deepseek-official \/ deepseek-flash/,
      "and it says which route is actually in force");

    // Choosing a provider clears the model, so the pair is never half-written.
    provider.props.onChange({ target: { value: "cust" } });
    await settle();
    await settle();
    assert.deepEqual(writes, [
      { translateProvider: "cust" },
      { translateModel: "" }
    ]);

    tree = (await openSettings(shim, exports)).tree;
    const model = selectByLabel(shim, tree, "翻译模型");
    const modelValues = shim.findAll(model, "option").map((option) => option.props.value);
    assert.deepEqual(modelValues, ["", "qwen3.8-uncensored"], "the model list follows the chosen provider");
    // A model without reasoning metadata must not offer an intensity at all.
    assert.equal(selectByLabel(shim, tree, "翻译思考强度"), undefined);

    model.props.onChange({ target: { value: "qwen3.8-uncensored" } });
    await settle();
    await settle();
    assert.equal(writes.length, 4);
    assert.deepEqual(writes[2], { translateProvider: "cust" });
    assert.deepEqual(writes[3], { translateModel: "qwen3.8-uncensored" });
  });
});

test("the thinking intensity follows the chosen model", async () => {
  const shim = createReactShim();
  const { exports } = await loadBundle(seedsFor(shim));
  const writes = [];
  // Start from a route that does declare efforts, so the control must appear.
  await withApi(catalogApi({
    prefs: { translateProvider: "deepseek-official", translateModel: "deepseek-flash" },
    stored: ["translateProvider", "translateModel"],
    onPrefs: (body) => writes.push(body)
  }), async () => {
    let { tree } = await openSettings(shim, exports);
    const effort = selectByLabel(shim, tree, "翻译思考强度");
    assert.ok(effort !== undefined, "a reasoning model should offer its intensities");
    assert.deepEqual(shim.findAll(effort, "option").map((o) => o.props.value), ["", "low", "high"]);

    effort.props.onChange({ target: { value: "low" } });
    await settle();
    await settle();
    assert.deepEqual(writes, [{ translateEffort: "low" }]);

    // The header action clears all three choices at once.
    tree = (await openSettings(shim, exports)).tree;
    settingsReset(shim, tree).props.onClick();
    await settle();
    await settle();
    assert.deepEqual(writes.slice(1), [
      { translateProvider: "" },
      { translateModel: "" },
      { translateEffort: "" }
    ]);
  });
});

test("no model picker is offered when nothing can translate", async () => {
  const shim = createReactShim();
  const { exports } = await loadBundle(seedsFor(shim));
  await withApi(settingsApi({ translate: { available: false, reason: "translation is disabled in the plugin config" } }), async () => {
    const { tree } = await openSettings(shim, exports);
    assert.equal(selectByLabel(shim, tree, "翻译模型服务"), undefined,
      "a picker for a switched-off feature would be a lie");
    // The rest of the page still renders.
    assert.ok(switchByLabel(shim, tree, "左侧栏入口") !== undefined);
  });
});

test("the picker says so when a chosen provider is not mounted", async () => {
  const shim = createReactShim();
  const { exports } = await loadBundle(seedsFor(shim));
  await withApi(catalogApi({
    prefs: { translateProvider: "ghost", translateModel: "x" },
    stored: ["translateProvider", "translateModel"]
  }), async () => {
    const { tree } = await openSettings(shim, exports);
    // The option has to exist, or the select would silently display a different
    // model than the one in force.
    const provider = selectByLabel(shim, tree, "翻译模型服务");
    const values = shim.findAll(provider, "option").map((option) => option.props.value);
    assert.ok(values.includes("ghost"), "the stored provider must stay selectable");
    assert.match(shim.textContent(tree), /没有挂载/, "and the page must say it will fail");
  });
});

test("the way back to the list stays pinned while the article scrolls", async () => {
  const shim = createReactShim();
  await withWindow(async () => {
    const { exports } = await loadBundle(seedsFor(shim));
    const host = markdownState("正文段落一");
    await withApi(markdownApi(host), async () => {
      const render = () => shim.render(shim.react.createElement(exports.RssSidebarPanel));
      let tree = await render();
      buttonByText(shim, tree, "Open item").props.onClick();
      await settle();
      await settle();
      tree = await render();

      const back = buttonByText(shim, tree, "返回列表");
      assert.ok(back !== undefined, "the detail should keep offering the way back");
      // The reading pane scrolls as one column, so the bar has to be sticky —
      // otherwise a reader at the end of a long article has to scroll all the
      // way up to leave it. Take the innermost div holding that button.
      const bar = shim.findAll(tree, "div").filter((node) => shim.findAll(node, "button")
        .some((candidate) => shim.textContent(candidate) === "← 返回列表")).pop();
      assert.ok(bar !== undefined, "the bar holding the back button should render");
      assert.equal(bar.props.style.position, "sticky", "返回按钮所在的条应固定悬浮");
      assert.equal(bar.props.style.top, 0, "贴住阅读区的顶边");
      // The negative side margins let it span the pane's padding, so it is flush
      // with the edges instead of inset like ordinary content.
      assert.match(bar.props.style.margin, /-14px/);
      // No margin below it: that gap would be transparent, and the article would
      // scroll through it right under the strip.
      assert.match(bar.props.style.margin, /0$/, "悬浮条下方不能留空隙");
      // An opaque fill is what keeps the article from showing through it.
      assert.ok(bar.props.style.background !== undefined && bar.props.style.background.length > 0,
        "悬浮条需要不透明底色，否则正文会从它下面透出来");

      // The pane itself must not pad above the strip: padding there would sit
      // above the sticky element and show the article through.
      const pane = shim.findAll(tree, "div").find((node) => node.props.id === "rss-reader-detail");
      assert.ok(pane !== undefined, "the scrolling pane should be identifiable");
      assert.equal(pane.props.style.paddingTop, 0, "阅读区顶部不留内边距");

      // A title's top margin would collapse into that seam; one scoped rule
      // clears it, and it has to be the pane's own id so nothing else is hit.
      assert.match(shim.textContent(tree), /#rss-reader-detail > \* > \*:first-child \{ margin-top: 0; \}/,
        "需要一条只作用于该阅读区的规则来清掉首个子元素的上外边距");

      // Leaving the detail still restores the list.
      back.props.onClick();
      await settle();
      tree = await render();
      assert.ok(buttonByText(shim, tree, "Open item") !== undefined);
    });
  });
});

test("the article's controls hold the top-right of the reading pane", async () => {
  const shim = createReactShim();
  await withWindow(async () => {
    const { exports } = await loadBundle(seedsFor(shim));
    const host = markdownState("正文段落一");
    const calls = [];
    await withApi(markdownApi(host, (kind) => calls.push(kind)), async () => {
      const tree = await renderOpenItem(shim, exports, host);

      // The controls used to share a row with the title, so a long article
      // scrolled them out of reach. In this presentation they hold the right end
      // of the pane's first row instead — in the flow, not as an overlay, so
      // there is nothing for a pinned bar to paint over and nothing covering the
      // article.
      const bar = shim.findAll(tree, "div").find((node) => node.props?.style?.justifyContent === "flex-end"
        && node.props?.style?.flexWrap === "wrap");
      assert.ok(bar !== undefined, "文章的操作应排在阅读区第一行右端");
      assert.equal(bar.props.style.position, "relative", "它在正常流里，不覆盖正文");
      assert.equal(bar.props.style.pointerEvents, undefined, "不需要为覆盖正文而屏蔽指针");
      assert.equal(bar.props.style.bottom, undefined, "不再贴底");

      // The reading pane must not have gained a positioning context it does not
      // need — that would be left over from the overlay approach.
      const pane = shim.findAll(tree, "div")
        .find((node) => node.props?.style?.overflowY === "auto" && String(node.props?.style?.padding ?? "").includes("20px"));
      assert.ok(pane !== undefined, "三栏的阅读区应可识别");
      assert.equal(pane.props.style.position, undefined, "阅读区不需要定位锚点");

      // The capsule gathers the controls, right-aligned.
      const capsule = shim.findAll(tree, "div")
        .find((node) => node.props?.style?.pointerEvents === "auto" && node.props?.style?.borderRadius === "10px");
      assert.ok(capsule !== undefined, "the control cluster should render");
      assert.equal(capsule.props.style.justifyContent, "flex-end", "胶囊内容靠右");

      // The four the reader asked for, all inside the cluster. The item is
      // already read, so the action offered is the way back to unread.
      const texts = shim.findAll(capsule, "button").map((node) => shim.textContent(node));
      for (const label of ["收藏", "译", "标为未读"]) {
        assert.ok(texts.includes(label), `操作区里应有「${label}」，实得 ${JSON.stringify(texts)}`);
      }
      const original = shim.findAll(capsule, "a").map((node) => node.props.href);
      assert.deepEqual(original, ["https://s.test/1"], "「打开原文」应指向条目链接");

      // They must act on the item, not merely render: the star patches it.
      const star = shim.findAll(capsule, "button").find((node) => shim.textContent(node) === "收藏");
      star.props.onClick();
      await settle();
      assert.ok(calls.some((kind) => String(kind).includes("PATCH") || String(kind).includes("items")),
        "点收藏应发出标记请求");
    });
  });
});

test("the narrow panel pins the same controls, folded to glyphs", async () => {
  const shim = createReactShim();
  await withWindow(async () => {
    const { exports } = await loadBundle(seedsFor(shim));
    const host = markdownState("正文段落一");
    await withApi(panelPrefsApi(host, {}), async () => {
      const render = () => shim.render(shim.react.createElement(exports.RssPanel, { variant: "sidebar" }));
      let tree = await render();

      // Nothing is open, so there is nothing to act on and no controls.
      assert.equal(shim.findAll(tree, "div").find((node) => node.props?.style?.borderRadius === "10px"),
        undefined, "列表态不该有操作区");

      buttonByText(shim, tree, "Open item").props.onClick();
      await settle();
      await settle();
      await settle();
      tree = await render();

      // In the narrow pane the controls join the way-back bar, which is already
      // sticky — that is what keeps them in the top-right corner, and it is why
      // they are not an overlay here.
      const pane = shim.findAll(tree, "div").find((node) => node.props.id === "rss-reader-detail");
      assert.ok(pane !== undefined, "the scrolling pane should render");
      const pinned = shim.findAll(pane, "div").find((node) => node.props?.style?.position === "sticky");
      assert.ok(pinned !== undefined, "the way-back bar should still be pinned");
      assert.equal(pinned.props.style.justifyContent, "space-between",
        "返回在左、操作在右，同一条固定的条上");

      // The sidebar is too narrow for the wide labels, so the controls fold to
      // glyphs with their full text kept as tooltips.
      const capsule = shim.findAll(pane, "div")
        .find((node) => node.props?.style?.pointerEvents === "auto" && node.props?.style?.borderRadius === "10px");
      assert.ok(capsule !== undefined, "the control cluster should render");
      assert.ok(shim.findAll(pinned, "div").includes(capsule), "操作区要在那条固定的条里面");
      const buttons = shim.findAll(capsule, "button");
      const glyphs = buttons.map((node) => shim.textContent(node));
      assert.ok(glyphs.includes("★"), `收藏应收成 ★，实得 ${JSON.stringify(glyphs)}`);
      assert.ok(glyphs.includes("○"), `未读应收成 ○，实得 ${JSON.stringify(glyphs)}`);
      const star = buttons.find((node) => shim.textContent(node) === "★");
      assert.equal(star.props.title, "收藏", "收成图标后仍要说明它是什么");

      // The source name gave up its place on that bar for the controls; the
      // article's own metadata line still names the feed.
      assert.equal(shim.textContent(pinned).includes("示例订阅源"), false,
        "固定条上不再重复源名");
      assert.ok(shim.textContent(pane).includes("示例订阅源"), "正文的元信息行仍写明源名");

      // Going back to the list takes the controls with it: they belong to the
      // article, not to the pane.
      buttonByText(shim, tree, "返回列表").props.onClick();
      await settle();
      tree = await render();
      assert.equal(shim.findAll(tree, "div").find((node) => node.props?.style?.borderRadius === "10px"),
        undefined, "回到列表后操作区应消失");
    });
  });
});

test("the panel remembers where the reader was and returns there", async () => {
  const shim = createReactShim();
  await withWindow(async () => {
    const { exports } = await loadBundle(seedsFor(shim));
    const host = markdownState("正文段落一");
    const writes = [];

    // First visit: nothing stored, so the panel starts at the list.
    await withApi(panelPrefsApi(host, { onPrefs: (body) => writes.push(body) }), async () => {
      const render = () => shim.render(shim.react.createElement(exports.RssPanel, { variant: "sidebar" }));
      let tree = await render();
      assert.equal(buttonByText(shim, tree, "返回列表"), undefined, "没有记忆时应该停在列表");

      // Opening an article is a position worth remembering.
      buttonByText(shim, tree, "Open item").props.onClick();
      await settle();
      await settle();
      await settle();
      const remembered = writes.filter((body) => "lastItemKey" in body);
      assert.equal(remembered.length, 1, "打开条目应记下它，且只记一次");
      // The item half only — the feed half travels in its own key, which is how
      // `<feedId>::<itemId>` is put back together on the next visit.
      assert.equal(remembered[0].lastItemKey, "1", "记住的应该是这一条");
      assert.ok(writes.some((body) => body.lastFeedId === "f1"), "连同当时的订阅源筛选");
    });

    // Second visit: the panel is mounted fresh, as reopening it does.
    const restored = [];
    await withApi(panelPrefsApi(host, {
      prefs: { lastFeedId: "f1", lastItemKey: "1", lastScrollTop: "420" },
      stored: ["lastFeedId", "lastItemKey", "lastScrollTop"],
      onPrefs: (body) => restored.push(body)
    }), async () => {
      const render = () => shim.render(shim.react.createElement(exports.RssPanel, { variant: "sidebar" }));
      const tree = await render();
      assert.ok(buttonByText(shim, tree, "返回列表") !== undefined, "再打开应该直接回到上次那篇");
      assert.ok(buttonByText(shim, tree, "Open item") === undefined, "而不是停在列表");
      // Restoring is not a change: echoing it back would defeat the point of
      // only writing when the reader actually moves.
      assert.deepEqual(restored, [], "恢复位置本身不该产生写入");
    });
  });
});

test("a remembered position that no longer exists falls back to the list", async () => {
  const shim = createReactShim();
  await withWindow(async () => {
    const { exports } = await loadBundle(seedsFor(shim));
    const host = markdownState("正文段落一");
    const writes = [];
    await withApi(panelPrefsApi(host, {
      // The article was deleted, or the feed went away with it.
      prefs: { lastFeedId: "gone", lastItemKey: "also-gone" },
      stored: ["lastFeedId", "lastItemKey"],
      onPrefs: (body) => writes.push(body)
    }), async () => {
      const render = () => shim.render(shim.react.createElement(exports.RssPanel, { variant: "sidebar" }));
      const tree = await render();
      // Each survives on its own: the item cannot resolve, so the list shows;
      // the feed id is remembered as given (it resolves to an empty list).
      assert.equal(buttonByText(shim, tree, "返回列表"), undefined, "失效的记忆不该停在详情");
      assert.ok(buttonByText(shim, tree, "Open item") !== undefined, "应该正常回到列表");
    });
  });
});

test("scrolling an article is remembered for the next visit", async () => {
  const shim = createReactShim();
  await withWindow(async () => {
    const { exports } = await loadBundle(seedsFor(shim));
    const host = markdownState("正文段落一");
    const writes = [];
    // Timers are recorded so the debounced write can be fired deterministically.
    // Everything else still takes the real timer, or the renderer would hang.
    const original = globalThis.setTimeout;
    const pending = [];
    globalThis.setTimeout = (callback, delay) => {
      if (delay === 400) {
        pending.push(callback);
        return 0;
      }
      return original(callback, delay);
    };
    try {
      await withApi(panelPrefsApi(host, { onPrefs: (body) => writes.push(body) }), async () => {
        const render = () => shim.render(shim.react.createElement(exports.RssPanel, { variant: "sidebar" }));
        let tree = await render();
        buttonByText(shim, tree, "Open item").props.onClick();
        await settle();
        await settle();
        await settle();
        tree = await render();

        const pane = shim.findAll(tree, "div").find((node) => node.props.id === "rss-reader-detail");
        assert.ok(pane !== undefined, "the scrolling pane should render");
        assert.equal(typeof pane.props.onScroll, "function", "it has to watch its own scrolling");

        // The reader scrolls: the handler must arm the write itself, because the
        // offset lives in a ref that no effect can depend on. A write that only
        // happens when the *article* changes records zero and never this.
        pane.props.onScroll({ currentTarget: { scrollTop: 640 } });
        await settle();
        assert.ok(pending.length >= 1, "滚动后应排定一次延迟写入");
        pending[pending.length - 1]();
        await settle();
        await settle();
        assert.deepEqual(
          writes.filter((body) => "lastScrollTop" in body),
          [{ lastScrollTop: "640" }],
          "滚到哪就记到哪"
        );
      });
    } finally {
      globalThis.setTimeout = original;
    }
  });
});

test("leaving an article keeps the offset for when the reader comes back", async () => {
  const shim = createReactShim();
  await withWindow(async () => {
    const { exports } = await loadBundle(seedsFor(shim));
    const host = markdownState("正文段落一");
    const writes = [];
    await withApi(panelPrefsApi(host, {
      prefs: { lastFeedId: "f1", lastItemKey: "1", lastScrollTop: "640" },
      stored: ["lastFeedId", "lastItemKey", "lastScrollTop"],
      onPrefs: (body) => writes.push(body)
    }), async () => {
      const render = () => shim.render(shim.react.createElement(exports.RssPanel, { variant: "sidebar" }));
      let tree = await render();
      assert.ok(buttonByText(shim, tree, "返回列表") !== undefined, "先回到那篇");

      // Going back to the list is not a scroll and must not overwrite the offset
      // the reader reached — coming back to this article should resume there.
      buttonByText(shim, tree, "返回列表").props.onClick();
      await settle();
      await settle();
      tree = await render();
      assert.ok(buttonByText(shim, tree, "Open item") !== undefined, "回到列表");
      assert.deepEqual(
        writes.filter((body) => "lastScrollTop" in body),
        [],
        "回到列表不该改动已记住的位置"
      );
    });
  });
});

/**
 * The list's own offset, which is a different scroll box from the article's.
 *
 * Only the recording half is observable here: the test renderer assigns no refs,
 * so `listPaneRef.current` is null and the restore effect returns before touching
 * the element — the same limitation the article's restore documents. What is
 * asserted instead is that the offset is captured from the list and that opening
 * an article does not lose it, which is the part that was broken: the pending
 * debounced write is cleared when the detail replaces the list, so a write armed
 * by scrolling alone never survives the swap.
 */
test("the list's scroll offset is kept when an article replaces it", async () => {
  const shim = createReactShim();
  await withWindow(async () => {
    const { exports } = await loadBundle(seedsFor(shim));
    const host = markdownState("正文段落一");
    const writes = [];
    // Same recording trick as the article's test: only the 400 ms write is
    // captured, so the renderer keeps using real timers and cannot hang.
    const original = globalThis.setTimeout;
    const pending = [];
    globalThis.setTimeout = (callback, delay) => {
      if (delay === 400) {
        pending.push(callback);
        return 0;
      }
      return original(callback, delay);
    };
    try {
      await withApi(panelPrefsApi(host, { onPrefs: (body) => writes.push(body) }), async () => {
        const render = () => shim.render(shim.react.createElement(exports.RssPanel, { variant: "sidebar" }));
        let tree = await render();

        // The list is the scroll container that carries the watcher.
        const list = shim.findAll(tree, "div").find((node) => typeof node.props.onScroll === "function"
          && node.props.id === undefined);
        assert.ok(list !== undefined, "列表需要一个自己的滚动容器");

        // The reader scrolls the list down, then opens an article from it.
        // Mounting already armed one write of its own (the article effect), so the
        // queue is emptied first — otherwise the assertion below would pass even if
        // scrolling armed nothing, which is exactly the behaviour under test.
        pending.length = 0;
        list.props.onScroll({ currentTarget: { scrollTop: 512 } });
        await settle();
        assert.ok(pending.length >= 1, "滚动列表后应排定一次延迟写入");

        buttonByText(shim, tree, "Open item").props.onClick();
        await settle();
        await settle();

        // The offset has to be written by the click itself, because the pending
        // debounced write is cleared when the selection changes.
        assert.deepEqual(
          writes.filter((body) => "lastListScrollTop" in body),
          [{ lastListScrollTop: "512" }],
          "打开条目时应该已经记下列表位置"
        );
        // And it must not be confused with the article's own offset.
        assert.deepEqual(
          writes.filter((body) => "lastScrollTop" in body),
          [],
          "列表位置不该写进正文的键"
        );
      });
    } finally {
      globalThis.setTimeout = original;
    }
  });
});

test("a list the reader never scrolled costs no write when an article is opened", async () => {
  const shim = createReactShim();
  await withWindow(async () => {
    const { exports } = await loadBundle(seedsFor(shim));
    const host = markdownState("正文段落一");
    const writes = [];
    await withApi(panelPrefsApi(host, { onPrefs: (body) => writes.push(body) }), async () => {
      const render = () => shim.render(shim.react.createElement(exports.RssPanel, { variant: "sidebar" }));
      const tree = await render();
      buttonByText(shim, tree, "Open item").props.onClick();
      await settle();
      await settle();
      // Nothing to remember: writing "" here would turn every opened article
      // into an extra request, and `lastListScrollTop` would stop meaning
      // "there is a position to restore".
      assert.deepEqual(
        writes.filter((body) => "lastListScrollTop" in body),
        [],
        "没滚动过的列表不该产生写入"
      );
    });
  });
});

test("switching the source drops the list offset instead of restoring over it", async () => {
  const shim = createReactShim();
  await withWindow(async () => {
    const { exports } = await loadBundle(seedsFor(shim));
    const host = markdownState("正文段落一");
    // A stored offset, plus a second source to switch to.
    host.state.feeds.push({
      id: "f2",
      url: "https://s.test/two",
      title: "另一个源",
      siteLink: "https://s.test/two",
      description: "",
      image: "",
      format: "rss",
      group: "",
      addedAt: "2024-05-01T00:00:00.000Z",
      fetchedAt: new Date().toISOString(),
      lastError: "",
      unread: 0,
      itemCount: 0,
      latestDate: "",
      items: []
    });
    const writes = [];
    await withApi(panelPrefsApi(host, {
      prefs: { lastListScrollTop: "512" },
      stored: ["lastListScrollTop"],
      onPrefs: (body) => writes.push(body)
    }), async () => {
      const render = () => shim.render(shim.react.createElement(exports.RssPanel, { variant: "sidebar" }));
      const tree = await render();
      buttonByText(shim, tree, "另一个源").props.onClick();
      await settle();
      await settle();
      // A different source is a different list, so its top is the only honest
      // place to start — an offset carried across would land the reader in the
      // middle of items they have never seen.
      assert.deepEqual(
        writes.filter((body) => "lastListScrollTop" in body),
        [{ lastListScrollTop: "" }],
        "换源应清掉列表位置"
      );
    });
  });
});

test("reopening the panel re-reads the stored offset", async () => {
  const shim = createReactShim();
  await withWindow(async () => {
    const { exports } = await loadBundle(seedsFor(shim));
    const host = markdownState("正文段落一");
    const reads = [];
    const api = markdownApi(host);
    await withApi(panelPrefsApi(host, {
      prefs: { lastFeedId: "f1", lastItemKey: "1", lastScrollTop: "640" },
      stored: ["lastFeedId", "lastItemKey", "lastScrollTop"]
    }), async () => {
      const tree = await shim.render(shim.react.createElement(exports.RssPanel, { variant: "sidebar" }));
      // The panel comes back on the remembered article...
      assert.ok(buttonByText(shim, tree, "返回列表") !== undefined, "再打开时应直接回到这篇的详情");
      // ...and its pane is the scroll container whose offset the restore sets.
      // The test renderer has no DOM, so the observable here is that the pane
      // exists and watchable; the offset being applied is covered by the value
      // travelling intact through the store and back (store tests).
      const pane = shim.findAll(tree, "div").find((node) => node.props.id === "rss-reader-detail");
      assert.ok(pane !== undefined, "详情需要一个可滚动的容器来恢复位置");
      assert.equal(typeof pane.props.onScroll, "function");
    });
  });
});

test("switching the source returns to the list instead of keeping the article open", async () => {
  const shim = createReactShim();
  await withWindow(async () => {
    const { exports } = await loadBundle(seedsFor(shim));
    const host = markdownState("正文段落一");
    // A second source, so switching has somewhere to go.
    host.state.feeds.push({
      id: "f2",
      url: "https://s.test/two",
      title: "另一个源",
      siteLink: "https://s.test/two",
      description: "",
      image: "",
      format: "rss",
      group: "",
      addedAt: "2024-05-01T00:00:00.000Z",
      fetchedAt: new Date().toISOString(),
      lastError: "",
      unread: 1,
      itemCount: 1,
      latestDate: "2024-05-02T10:00:00.000Z",
      items: [{
        id: "9", title: "另一条", link: "https://s.test/9", summary: "摘要", summaryMarkdown: "",
        content: "正文", markdown: "", author: "", date: "2024-05-02T10:00:00.000Z",
        categories: [], enclosure: "", read: false, starred: false
      }]
    });
    await withApi(markdownApi(host), async () => {
      const render = () => shim.render(shim.react.createElement(exports.RssPanel, { variant: "sidebar" }));
      let tree = await render();
      buttonByText(shim, tree, "Open item").props.onClick();
      await settle();
      await settle();
      tree = await render();
      assert.ok(buttonByText(shim, tree, "返回列表") !== undefined, "先进入详情");

      // Picking another source is a request to see that source's items, so the
      // open article must give way to the list on its own.
      buttonByText(shim, tree, "另一个源").props.onClick();
      await settle();
      tree = await render();
      assert.equal(buttonByText(shim, tree, "返回列表"), undefined, "切换源后不该还停在详情");
      assert.ok(buttonByText(shim, tree, "另一条") !== undefined, "应该直接看到新源的列表");
      assert.doesNotMatch(shim.textContent(tree), /正文段落一/, "上一条的正文不该还留在页面上");

      // Going back to 全部 is the same kind of switch: it must clear the open
      // article too, not just re-filter the list.
      buttonByText(shim, tree, "全部").props.onClick();
      await settle();
      tree = await render();
      assert.equal(buttonByText(shim, tree, "返回列表"), undefined, "「全部」同样直接回列表");
      assert.ok(buttonByText(shim, tree, "Open item") !== undefined, "回到全部后两条都在");

      // And the full round trip still works: open, switch, open again.
      buttonByText(shim, tree, "Open item").props.onClick();
      await settle();
      await settle();
      tree = await render();
      assert.ok(buttonByText(shim, tree, "返回列表") !== undefined, "再次进入详情");
      buttonByText(shim, tree, "另一个源").props.onClick();
      await settle();
      tree = await render();
      assert.equal(buttonByText(shim, tree, "返回列表"), undefined, "再切一次源，仍然直接回列表");
      assert.ok(buttonByText(shim, tree, "另一条") !== undefined);
    });
  });
});

// ── The right Sidebar's single-column presentation ──────────────────────────

test("the right Sidebar presentation swaps the list for the detail and back", async () => {
  const shim = createReactShim();
  await withWindow(async () => {
    const { exports } = await loadBundle(seedsFor(shim));
    const host = markdownState("正文段落一");
    await withApi(markdownApi(host), async () => {
      const render = () => shim.render(shim.react.createElement(exports.RssSidebarPanel));

      let tree = await render();
      // The subscription list becomes a strip of chips in a narrow column.
      assert.ok(buttonByText(shim, tree, "全部") !== undefined, "the chips strip should render");
      assert.ok(buttonByText(shim, tree, "Open item") !== undefined, "the item list should render");

      buttonByText(shim, tree, "Open item").props.onClick();
      await settle();
      await settle();
      tree = await render();

      // The detail replaced the list on the same page, and the way back is part
      // of it — nothing navigated away.
      const back = buttonByText(shim, tree, "返回列表");
      assert.ok(back !== undefined, "the detail should offer a way back to the list");
      assert.equal(buttonByText(shim, tree, "Open item"), undefined, "the list should give way to the detail");
      assert.match(shim.textContent(tree), /正文段落一/);

      back.props.onClick();
      await settle();
      tree = await render();
      assert.ok(buttonByText(shim, tree, "Open item") !== undefined, "the list should come back");
      assert.equal(buttonByText(shim, tree, "返回列表"), undefined);
    });
  });
});

test("the wide presentation keeps the list and the detail side by side", async () => {
  const shim = createReactShim();
  await withWindow(async () => {
    const { exports } = await loadBundle(seedsFor(shim));
    const host = markdownState("正文段落一");
    await withApi(markdownApi(host), async () => {
      const tree = await renderOpenItem(shim, exports, host);
      // In the centre panel both are visible at once, so there is no back step.
      assert.ok(buttonByText(shim, tree, "Open item") !== undefined, "the list should stay visible");
      assert.equal(buttonByText(shim, tree, "返回列表"), undefined, "the wide layout needs no back step");
      assert.ok(buttonByText(shim, tree, "全部订阅源") !== undefined, "the feed list should render");
    });
  });
});

// ── Exploring the RSSHub catalogue ──────────────────────────────────────────

/** One catalogue route as the host projects it. */
function routeRecord() {
  return {
    namespace: "github",
    site: "GitHub",
    url: "github.com",
    lang: "en",
    path: "/trending/:since/:language/:spoken_language?",
    name: "Trending",
    example: "/github/trending/daily/javascript/en",
    description: "See what the GitHub community is most excited about.",
    categories: ["programming"],
    parameters: [
      { name: "since", optional: false, greedy: false, description: "time range", default: "", options: [{ value: "daily", label: "Today" }, { value: "weekly", label: "This week" }] },
      { name: "language", optional: false, greedy: false, description: "the feed language", default: "any", options: [] },
      { name: "spoken_language", optional: true, greedy: false, description: "natural language", default: "", options: [] }
    ],
    flags: { config: [], antiCrawler: false, puppeteer: false, bt: false, podcast: false },
    values: { since: "daily", language: "javascript", spoken_language: "en" },
    search: "trending /trending/:since github github.com see what the github community is most excited about."
  };
}

/** One `/explore` page, as the host serves it. */
function explorePage(overrides = {}) {
  return {
    ok: true,
    enabled: true,
    base: "https://hub.test",
    total: 1,
    offset: 0,
    limit: 30,
    routes: [routeRecord()],
    namespaces: [{ id: "github", name: "GitHub", url: "github.com", lang: "en", categories: ["programming"], routes: 1 }],
    namespaceTotal: 1,
    categories: [{ id: "programming", label: "编程", count: 1 }, { id: "social-media", label: "社交媒体", count: 2 }],
    totals: { namespaces: 1, routes: 1, routesWithExample: 1 },
    ...overrides
  };
}

/**
 * A host stub covering the whole explore flow.
 *
 * The URL builder echoes the values it was handed, so a test can see what the
 * form actually submitted; the builder's own rules are covered host-side.
 */
function exploreApi({ explore = true, page = explorePage() } = {}) {
  return (path, call) => {
    if (path.endsWith("/rsshub")) {
      return { body: { ok: true, enabled: true, explore, base: "https://hub.test" } };
    }
    if (path.includes("/explore/url")) {
      const values = call.body?.values ?? {};
      const parts = ["since", "language", "spoken_language"]
        .map((key) => values[key])
        .filter((value) => typeof value === "string" && value.length > 0);
      return { body: { ok: true, path: `/${parts.join("/")}`, url: `https://hub.test/${parts.join("/")}`, title: "Trending", namespace: "github" } };
    }
    if (path.includes("/explore")) return { body: page };
    if (path.endsWith("/feeds")) {
      return { body: { ok: true, created: true, feedId: "f9", outcome: { ok: true, added: 3 }, state: populatedState() } };
    }
    return { body: { ok: true, state: populatedState(), refreshing: false } };
  };
}

/** The first button whose whole text is exactly `needle`. */
function buttonByExactText(shim, tree, needle) {
  return shim.findAll(tree, "button").find((node) => shim.textContent(node) === needle);
}

/** Render the panel, open the explore dialog, and return the settled tree. */
async function openExplore(shim, exports) {
  const render = () => shim.render(shim.react.createElement(exports.RssPanel));
  await render();
  await settle();
  const toolbar = await render();
  const explore = buttonByText(shim, toolbar, "探索");
  assert.ok(explore !== undefined, "the toolbar should offer exploring");
  explore.props.onClick();
  await settle();
  await settle();
  return render();
}

test("the explore button is not offered when the catalogue is unavailable", async () => {
  const shim = createReactShim();
  await withWindow(async () => {
    const { exports } = await loadBundle(seedsFor(shim));
    await withApi(exploreApi({ explore: false }), async () => {
      await shim.render(shim.react.createElement(exports.RssPanel));
      await settle();
      const tree = await shim.render(shim.react.createElement(exports.RssPanel));
      // A button that can only fail is worse than no button.
      assert.equal(buttonByText(shim, tree, "探索"), undefined);
    });
  });
});

test("the explore dialog browses the catalogue and follows the facets", async () => {
  const shim = createReactShim();
  await withWindow(async () => {
    const { exports } = await loadBundle(seedsFor(shim));
    await withApi(exploreApi({}), async (api) => {
      const render = () => shim.render(shim.react.createElement(exports.RssPanel));
      let tree = await openExplore(shim, exports);

      // The first page: category chips, the site list, and its routes.
      assert.match(shim.textContent(tree), /探索 RSSHub 订阅源/);
      assert.match(shim.textContent(tree), /编程/);
      assert.match(shim.textContent(tree), /GitHub/);
      assert.match(shim.textContent(tree), /Trending/);
      assert.match(shim.textContent(tree), /https:\/\/hub\.test/, "the source instance is named");

      // Drilling into a site asks the host for that namespace.
      buttonByText(shim, tree, "GitHub").props.onClick();
      await settle();
      await settle();
      tree = await render();
      const asked = api.calls.map((entry) => entry.path);
      assert.ok(asked.some((path) => path.includes("namespace=github")), `expected a namespace query, saw ${asked.join(", ")}`);
      assert.ok(buttonByText(shim, tree, "返回") !== undefined, "drilling in must be reversible");

      // A category chip narrows the catalogue the same way.
      buttonByExactText(shim, tree, "社交媒体").props.onClick();
      await render();
      await settle();
      await settle();
      assert.ok(api.calls.some((entry) => entry.path.includes("category=social-media")),
        `expected a category query, saw ${api.calls.map((entry) => entry.path).join(", ")}`);
    });
  });
});

test("adding a catalogue route prefills the form from the example and subscribes", async () => {
  const shim = createReactShim();
  await withWindow(async () => {
    const { exports } = await loadBundle(seedsFor(shim));
    await withApi(exploreApi({}), async (api) => {
      const render = () => shim.render(shim.react.createElement(exports.RssPanel));
      let tree = await openExplore(shim, exports);

      buttonByExactText(shim, tree, "添加").props.onClick();
      await settle();
      tree = await render();

      // The form arrives filled in from the route's own example, which is what
      // makes this a one-click subscribe rather than a documentation exercise.
      const select = shim.findAll(tree, "select")[0];
      assert.equal(select.props.value, "daily", "the option-typed parameter is prefilled");
      const inputs = shim.findAll(tree, "input").filter((node) => String(node.props.id ?? "").startsWith("rss-explore-"));
      assert.deepEqual(inputs.map((node) => [node.props.id, node.props.value]), [
        ["rss-explore-github-language", "javascript"],
        ["rss-explore-github-spoken_language", "en"]
      ]);

      buttonByExactText(shim, tree, "订阅").props.onClick();
      await settle();
      await settle();
      await settle();
      tree = await render();

      const built = api.calls.find((entry) => entry.path.includes("/explore/url"));
      assert.ok(built !== undefined, "the subscribe path must build the URL host-side");
      assert.equal(built.method, "POST");
      assert.deepEqual(built.body, {
        namespace: "github",
        path: "/trending/:since/:language/:spoken_language?",
        values: { since: "daily", language: "javascript", spoken_language: "en" }
      });

      const subscribed = api.calls.filter((entry) => entry.path.endsWith("/feeds"));
      assert.equal(subscribed.length, 1);
      assert.deepEqual(subscribed[0].body, { url: "https://hub.test/daily/javascript/en", title: "Trending" });

      // The dialog stays open — browsing a catalogue usually means adding more
      // than one — and marks the row instead.
      assert.match(shim.textContent(tree), /已订阅/);
      assert.match(shim.textContent(tree), /探索 RSSHub 订阅源/, "the dialog is still open");
      assert.ok(buttonByExactText(shim, tree, "订阅") === undefined, "the closed form is gone");
    });
  });
});

test("a refused route keeps the form open and shows why", async () => {
  const shim = createReactShim();
  await withWindow(async () => {
    const { exports } = await loadBundle(seedsFor(shim));
    const api = (path) => {
      if (path.endsWith("/rsshub")) return { body: { ok: true, enabled: true, explore: true, base: "https://hub.test" } };
      if (path.includes("/explore/url")) return { status: 400, body: { ok: false, error: "缺少必填参数：since" } };
      if (path.includes("/explore")) return { body: explorePage() };
      return { body: { ok: true, state: populatedState(), refreshing: false } };
    };
    await withApi(api, async () => {
      const render = () => shim.render(shim.react.createElement(exports.RssPanel));
      let tree = await openExplore(shim, exports);
      buttonByExactText(shim, tree, "添加").props.onClick();
      await settle();
      tree = await render();
      buttonByExactText(shim, tree, "订阅").props.onClick();
      await settle();
      await settle();
      tree = await render();
      assert.match(shim.textContent(tree), /缺少必填参数：since/, "the reason belongs next to the form");
      assert.equal(shim.textContent(tree).includes("已订阅"), false, "a refusal must not look like success");
    });
  });
});

test("the explore dialog reports an unreachable instance instead of an empty list", async () => {
  const shim = createReactShim();
  await withWindow(async () => {
    const { exports } = await loadBundle(seedsFor(shim));
    const api = (path) => {
      if (path.endsWith("/rsshub")) return { body: { ok: true, enabled: true, explore: true, base: "https://hub.test" } };
      if (path.includes("/explore")) return { status: 503, body: { ok: false, error: "无法连接 RSSHub 实例 https://hub.test" } };
      return { body: { ok: true, state: populatedState(), refreshing: false } };
    };
    await withApi(api, async () => {
      const tree = await openExplore(shim, exports);
      assert.match(shim.textContent(tree), /无法连接 RSSHub 实例/);
    });
  });
});

// ── Rendering ───────────────────────────────────────────────────────────────

test("the panel shows a loading state on first paint", async () => {
  const shim = createReactShim();
  await withWindow(async () => {
    const original = globalThis.fetch;
    // A never-settling request keeps the panel in its loading branch.
    globalThis.fetch = () => new Promise(() => {});
    try {
      const { exports } = await loadBundle(seedsFor(shim));
      const tree = await shim.render(shim.react.createElement(exports.RssPanel), { maxPasses: 2 });
      assert.match(shim.textContent(tree), /正在载入订阅源/);
    } finally {
      globalThis.fetch = original;
    }
  });
});

test("the panel renders its empty state, including the add prompt", async () => {
  const shim = createReactShim();
  await withWindow(async () => {
    const { exports } = await loadBundle(seedsFor(shim));
    await withApi(
      () => ({ body: { ok: true, state: emptyState(), refreshing: false } }),
      async () => {
        const tree = await shim.render(shim.react.createElement(exports.RssPanel));
        const text = shim.textContent(tree);
        assert.match(text, /RSS 阅读器/);
        assert.match(text, /还没有订阅任何 RSS 源/);
        assert.match(text, /添加订阅源/);
        assert.ok(hasPlaceholder(tree, "搜索标题"), "the search field should be present");
        assert.ok(shim.findAll(tree, "button").length > 0, "expected actionable buttons");
      }
    );
  });
});

test("the panel renders feeds, items, and the reading pane from host state", async () => {
  const shim = createReactShim();
  await withWindow(async () => {
    const { exports } = await loadBundle(seedsFor(shim));
    await withApi(
      () => ({ body: { ok: true, state: populatedState(), refreshing: false } }),
      async () => {
        const tree = await shim.render(shim.react.createElement(exports.RssPanel));
        const text = shim.textContent(tree);
        assert.match(text, /1 个源 · 2 条 · 2 条未读/);
        assert.match(text, /示例订阅源/);
        assert.match(text, /最新一条/);
        assert.match(text, /较早一条/);
        assert.match(text, /摘要一/);
        // With nothing selected the reading pane invites a choice.
        assert.match(text, /选择左侧的一条内容开始阅读/);
      }
    );
  });
});

test("opening an item shows its body and marks it read through the API", async () => {
  const shim = createReactShim();
  await withWindow(async () => {
    const { exports } = await loadBundle(seedsFor(shim));
    let state = populatedState();
    await withApi(
      (path, call) => {
        // The reading pane fetches one item's body on demand; the list payload
        // deliberately carries no bodies.
        if (path.includes("/item?")) {
          return {
            body: {
              ok: true,
              item: {
                id: "1", title: "最新一条", link: "https://s.test/1", summary: "摘要一",
                markdown: "**正文一**", content: "正文一", author: "Ann",
                date: "2024-05-02T10:00:00.000Z", categories: ["tech"], enclosure: "",
                read: false, starred: false, translation: null
              }
            }
          };
        }
        if (path.endsWith("/items")) {
          state = { ...state, totals: { ...state.totals, unread: 1 } };
          return { body: { ok: true, item: { id: call.body.itemId, read: true }, state } };
        }
        if (path.endsWith("/translate") && call.method === "GET") {
          return {
            body: {
              ok: true, available: true, provider: "p", model: "m",
              targets: { "zh-CN": "Simplified Chinese (简体中文)" }, defaultTarget: "zh-CN"
            }
          };
        }
        return { body: { ok: true, state, refreshing: false } };
      },
      async (api) => {
        const tree = await shim.render(shim.react.createElement(exports.RssPanel));
        const row = buttonByText(shim, tree, "最新一条");
        assert.ok(row !== undefined, "the item row should be a button");
        row.props.onClick();
        // One settle for the read PATCH, one for the body fetch.
        await settle();
        await settle();

        const after = await shim.render(shim.react.createElement(exports.RssPanel));
        assert.match(shim.textContent(after), /正文一/, "the reading pane should show the item body");
        assert.ok(
          api.calls.some((call) => call.path.includes("/item?")),
          "the body must be fetched on demand rather than shipped in the list"
        );
        assert.ok(
          api.calls.some((call) => call.path.endsWith("/items") && call.body?.read === true),
          "opening an item must mark it read"
        );
      }
    );
  });
});

test("the refresh button calls the refresh route and reports the outcome", async () => {
  const shim = createReactShim();
  await withWindow(async () => {
    const { exports } = await loadBundle(seedsFor(shim));
    await withApi(
      (path) => {
        if (path.endsWith("/refresh")) {
          return {
            body: {
              ok: true,
              summary: { results: [{ ok: true }], refreshed: 1, failed: 0, added: 3 },
              state: populatedState()
            }
          };
        }
        return { body: { ok: true, state: populatedState(), refreshing: false } };
      },
      async (api) => {
        const tree = await shim.render(shim.react.createElement(exports.RssPanel));
        const refresh = buttonByText(shim, tree, "刷新");
        assert.ok(refresh !== undefined, "expected a refresh button");
        refresh.props.onClick();
        await settle();

        const after = await shim.render(shim.react.createElement(exports.RssPanel));
        assert.ok(
          api.calls.some((call) => call.path.endsWith("/refresh") && call.method === "POST"),
          "refresh must be a POST"
        );
        assert.match(shim.textContent(after), /已刷新 1\/1 个源/);
        assert.match(shim.textContent(after), /新增 3 条/);
      }
    );
  });
});

test("the add-feed dialog opens and submits the URL", async () => {
  const shim = createReactShim();
  await withWindow(async () => {
    const { exports } = await loadBundle(seedsFor(shim));
    await withApi(
      (path) => {
        if (path.endsWith("/feeds")) {
          return {
            status: 201,
            body: { ok: true, created: true, feedId: "f2", outcome: { ok: true, added: 5 }, state: populatedState() }
          };
        }
        return { body: { ok: true, state: emptyState(), refreshing: false } };
      },
      async (api) => {
        const tree = await shim.render(shim.react.createElement(exports.RssPanel));
        const open = buttonByText(shim, tree, "添加订阅源");
        assert.ok(open !== undefined, "expected an add button");
        open.props.onClick();
        await settle();

        const dialog = await shim.render(shim.react.createElement(exports.RssPanel));
        assert.ok(hasPlaceholder(dialog, "example.com/feed.xml"), "the dialog should show its URL field");
        const urlField = shim
          .findAll(dialog, "input")
          .find((input) => String(input.props.placeholder ?? "").includes("example.com"));
        assert.ok(urlField !== undefined, "expected the URL field");

        urlField.props.onChange({ target: { value: "https://new.test/feed" } });
        await settle();

        const withValue = await shim.render(shim.react.createElement(exports.RssPanel));
        const submit = buttonByText(shim, withValue, "添加并获取");
        assert.ok(submit !== undefined, "expected a submit button");
        submit.props.onClick();
        await settle();

        const call = api.calls.find((candidate) => candidate.path.endsWith("/feeds"));
        assert.ok(call !== undefined, "the add must reach the host");
        assert.equal(call.method, "POST");
        assert.equal(call.body.url, "https://new.test/feed");
      }
    );
  });
});

test("a host error is surfaced in the panel instead of swallowed", async () => {
  const shim = createReactShim();
  await withWindow(async () => {
    const { exports } = await loadBundle(seedsFor(shim));
    await withApi(
      () => ({ body: { ok: false, error: "宿主暂时不可用" } }),
      async () => {
        const tree = await shim.render(shim.react.createElement(exports.RssPanel));
        assert.match(shim.textContent(tree), /宿主暂时不可用/);
      }
    );
  });
});

test("the sidebar glyph renders an inline svg with no external asset", async () => {
  const shim = createReactShim();
  const { exports } = await loadBundle(seedsFor(shim));
  const tree = await shim.render(shim.react.createElement(exports.RssGlyph, { size: 18, active: true }));
  const svg = shim.findAll(tree, "svg");
  assert.equal(svg.length, 1);
  assert.equal(svg[0].props.viewBox, "0 0 24 24");
  // Two arcs plus a dot: the classic RSS mark, drawn rather than fetched.
  assert.equal(shim.findAll(tree, "circle").length, 1);
  assert.equal(shim.findAll(tree, "path").length, 2);
});

test("the panel issues exactly one state request on mount", async () => {
  const shim = createReactShim();
  await withWindow(async () => {
    const { exports } = await loadBundle(seedsFor(shim));
    await withApi(
      () => ({ body: { ok: true, state: emptyState(), refreshing: false } }),
      async (api) => {
        await shim.render(shim.react.createElement(exports.RssPanel));
        const stateCalls = api.calls.filter((call) => call.path.endsWith("/state"));
        assert.equal(stateCalls.length, 1, `expected one /state request, saw ${stateCalls.length}`);
        // The panel now reads its own preferences on mount as well; the guard in
        // `loadPrefs` has to keep that from becoming a second request.
        const prefCalls = api.calls.filter((call) => call.path.endsWith("/prefs"));
        assert.equal(prefCalls.length, 1, `expected one /prefs request, saw ${prefCalls.length}`);
      }
    );
  });
});

test("a stale cache triggers one background refresh on open", async () => {
  const shim = createReactShim();
  await withWindow(async () => {
    const { exports } = await loadBundle(seedsFor(shim));
    // A feed cached long ago should prompt an automatic refresh.
    const stale = populatedState();
    stale.feeds[0].fetchedAt = "2020-01-01T00:00:00.000Z";
    stale.totals.lastFetched = "2020-01-01T00:00:00.000Z";
    await withApi(
      (path) => {
        if (path.endsWith("/refresh")) {
          return { body: { ok: true, summary: { results: [{ ok: true }], refreshed: 1, failed: 0, added: 0 }, state: populatedState() } };
        }
        return { body: { ok: true, state: stale, refreshing: false } };
      },
      async (api) => {
        await shim.render(shim.react.createElement(exports.RssPanel));
        await settle();
        await shim.render(shim.react.createElement(exports.RssPanel));
        assert.ok(
          api.calls.some((call) => call.path.endsWith("/refresh")),
          "a stale cache should refresh automatically"
        );
      }
    );
  });
});

test("a fresh cache does not trigger a background refresh", async () => {
  const shim = createReactShim();
  await withWindow(async () => {
    const { exports } = await loadBundle(seedsFor(shim));
    await withApi(
      () => ({ body: { ok: true, state: populatedState(), refreshing: false } }),
      async (api) => {
        await shim.render(shim.react.createElement(exports.RssPanel));
        await settle();
        await shim.render(shim.react.createElement(exports.RssPanel));
        assert.equal(
          api.calls.filter((call) => call.path.endsWith("/refresh")).length,
          0,
          "a freshly fetched cache should not refresh again"
        );
      }
    );
  });
});

/**
 * Build a host double whose one feed carries several dated items, so the time
 * windows can be exercised.
 *
 * Offsets are counted in *local* days from today's midnight — the unit the
 * windows are defined in — so a test states intent ("published yesterday")
 * rather than a fragile absolute timestamp. Sunday is avoided as the starting
 * point because subtracting local days across a DST transition would shift the
 * hour and could push an item over a window edge.
 *
 * @param {Array<{days: number, title: string, read?: boolean}>} items - items,
 *   `days` being whole local days before today.
 * @param {object} [hostFields] - extra host-level fields.
 * @returns {object} the host double.
 */
function datedState(items, hostFields = {}) {
  const state = populatedState();
  const midnight = new Date();
  midnight.setHours(0, 0, 0, 0);
  const rows = items.map((entry, index) => ({
    id: `i${index + 1}`,
    title: entry.title,
    link: `https://s.test/${index + 1}`,
    summary: "",
    summaryMarkdown: "",
    content: "",
    markdown: `正文 ${entry.title}`,
    author: "",
    // 12:00 local, a day `entry.days` before today. `days: null` means the
    // source published no date at all.
    date: entry.days === null || entry.days === undefined
      ? ""
      : new Date(midnight.getTime() - entry.days * 86400000 + 12 * 3600000).toISOString(),
    categories: [],
    enclosure: "",
    read: entry.read === true,
    starred: false,
    translated: false
  }));
  state.feeds = [{ ...state.feeds[0], items: rows }];
  const unread = rows.filter((row) => !row.read).length;
  state.totals = { feeds: 1, items: rows.length, unread, lastFetched: new Date().toISOString(), failures: 0 };
  const first = rows[0];
  return {
    state,
    item: { ...first, markdown: first.markdown },
    ...hostFields
  };
}

/** The chip / select labels for the time windows. */
const RANGE_LABELS = ["全部", "今天", "近 3 天", "近 7 天"];

/**
 * Click a time-window chip in the wide presentation.
 * @param {object} shim - the render shim.
 * @param {object} tree - the rendered tree.
 * @param {string} label - the chip's label.
 */
function pickRange(shim, tree, label) {
  const chip = shim.findAll(tree, "button").find((node) => shim.textContent(node) === label);
  assert.ok(chip !== undefined, `should find the ${label} chip`);
  chip.props.onClick();
}

/**
 * Select one subscription in the wide presentation's source column.
 * @param {object} shim - the render shim.
 * @param {object} tree - the rendered tree.
 * @param {string} title - the feed's title.
 */
function selectFeedIn(shim, tree, title) {
  const row = shim.findAll(tree, "button").find((node) => {
    const text = shim.textContent(node);
    return text.includes(title) && text.includes("⠿");
  });
  assert.ok(row !== undefined, `should find the ${title} source row`);
  row.props.onClick();
}

// ── Markdown rendering, images, and translation ─────────────────────────────

/**
 * Build a host stub serving one item with a Markdown body.
 *
 * The returned object drives both the `/state` list payload and the `/item`
 * detail response, so a test configures the item once.
 *
 * @param {string} markdown - the item's `markdown` (body) field.
 * @param {object} [itemFields] - extra fields merged into the item.
 * @param {object} [hostFields] - extra host-level fields, e.g. `translateAvailable`.
 * @returns {object} the host double.
 */
function markdownState(markdown, itemFields = {}, hostFields = {}) {
  const state = populatedState();
  const item = {
    id: "1", title: "Open item", link: "https://s.test/1", summary: "摘要", summaryMarkdown: "",
    author: "Ann", date: "2024-05-02T10:00:00.000Z", categories: [], enclosure: "",
    read: true, starred: false, translated: false, ...itemFields
  };
  state.feeds = [{ ...state.feeds[0], items: [item] }];
  state.totals = { feeds: 1, items: 1, unread: 0, lastFetched: new Date().toISOString(), failures: 0 };
  // The detail route reads `${markdown}` and the list item's own fields.
  return { state, item: { ...item, markdown }, ...hostFields };
}

/**
 * Open the single item and let the body load.
 *
 * @param {object} shim - the render shim.
 * @param {object} exports - the bundle's exports.
 * @param {object} host - `{state, markdown, translation}` served by the stub.
 * @returns {Promise<object>} the rendered tree.
 */
async function renderOpenItem(shim, exports, host) {
  const tree = await shim.render(shim.react.createElement(exports.RssPanel));
  const row = buttonByText(shim, tree, "Open item");
  assert.ok(row !== undefined, "the item row should render");
  row.props.onClick();
  await settle();
  await settle();
  return shim.render(shim.react.createElement(exports.RssPanel));
}

/**
 * Install a host stub that serves one item's body.
 *
 * Item-level fields come from `host.item`, so a test can drive both the list
 * payload and the `/item` detail from one place.
 */
function markdownApi(host, onCall) {
  return (path, call) => {
    if (path.includes("/item?")) {
      return {
        body: {
          ok: true,
          item: {
            id: "1", title: "Open item", link: "https://s.test/1",
            summary: host.item?.summary ?? "摘要",
            summaryMarkdown: host.item?.summaryMarkdown ?? "",
            markdown: host.item?.markdown ?? "",
            content: host.item?.content ?? "",
            author: "Ann", date: "2024-05-02T10:00:00.000Z",
            categories: [], enclosure: "", read: true, starred: false,
            translation: host.item?.translation ?? null
          }
        }
      };
    }
    if (path.endsWith("/translate") && call.method === "GET") {
      return {
        body: {
          ok: true,
          available: host.translateAvailable !== false,
          provider: "p", model: "m",
          targets: { "zh-CN": "Simplified Chinese (简体中文)", en: "English" },
          defaultTarget: "zh-CN",
          ...(host.translateAvailable === false ? { reason: "no model is configured for translation" } : {})
        }
      };
    }
    if (path.endsWith("/translate") && call.method === "POST") {
      onCall?.("translate", call);
      return {
        body: {
          ok: true,
          cached: false,
          translation: {
            title: "标题", markdown: "# 译文标题\n\n这是**译文**正文。",
            target: call.body.target ?? "zh-CN", model: "p/m", at: "2024-05-01T00:00:00.000Z"
          }
        }
      };
    }
    if (path.endsWith("/translate") && call.method === "DELETE") {
      onCall?.("clear", call);
      return { body: { ok: true, cleared: true } };
    }
    if (path.endsWith("/items")) {
      onCall?.("items", call);
      return { body: { ok: true, item: { id: "1", read: true }, state: host.state } };
    }
    return { body: { ok: true, state: host.state, refreshing: false } };
  };
}

test("a Markdown body renders as structure, not as literal syntax", async () => {
  const markdown = [
    "# Heading One",
    "",
    "A paragraph with **bold** and *italic* and `code`.",
    "",
    "- first",
    "- second",
    "",
    "> quoted line",
    "",
    "```js",
    "const a = 1;",
    "```",
    "",
    "| H1 | H2 |",
    "| --- | --- |",
    "| a | b |"
  ].join("\n");
  const shim = createReactShim();
  await withWindow(async () => {
    const { exports } = await loadBundle(seedsFor(shim));
    const host = markdownState(markdown);
    await withApi(markdownApi(host), async () => {
      const tree = await renderOpenItem(shim, exports, host);
      const text = shim.textContent(tree);

      // The marker characters must be consumed, not printed.
      assert.ok(!text.includes("**"), `emphasis markers leaked: ${text}`);
      assert.ok(!text.includes("```"), "code fence markers leaked");
      assert.ok(!text.includes("| --- |"), "table delimiter row leaked");

      // The structure must be present as real elements.
      assert.equal(shim.findAll(tree, "h1").length, 1, "the heading should render as h1");
      assert.equal(shim.findAll(tree, "strong").length, 1);
      assert.equal(shim.findAll(tree, "em").length, 1);
      assert.equal(shim.findAll(tree, "ul").length, 1);
      assert.equal(shim.findAll(tree, "li").length, 2);
      assert.equal(shim.findAll(tree, "blockquote").length, 1);
      assert.equal(shim.findAll(tree, "pre").length, 1, "fenced block");
      // One inline code span plus the <code> inside the fenced block.
      assert.equal(shim.findAll(tree, "code").length, 2, "inline code and the fenced block's code");
      assert.equal(shim.findAll(tree, "table").length, 1);
      assert.equal(shim.findAll(tree, "th").length, 2);
      assert.equal(shim.findAll(tree, "td").length, 2);

      // And the content survived.
      assert.match(text, /Heading One/);
      assert.match(text, /const a = 1;/);
      assert.match(text, /quoted line/);
    });
  });
});

test("links render as anchors and unsafe schemes are defused", async () => {
  const markdown = "[safe](https://x.test/a) and [bad](javascript:alert(1)) and <https://x.test/bare>";
  const shim = createReactShim();
  await withWindow(async () => {
    const { exports } = await loadBundle(seedsFor(shim));
    const host = markdownState(markdown);
    await withApi(markdownApi(host), async () => {
      const tree = await renderOpenItem(shim, exports, host);
      const anchors = shim.findAll(tree, "a").filter((node) => String(node.props.href ?? "").includes("x.test"));
      const hrefs = anchors.map((node) => node.props.href);
      assert.ok(hrefs.includes("https://x.test/a"), "a safe link survives");
      assert.ok(hrefs.includes("https://x.test/bare"), "an autolink survives");
      assert.ok(
        !hrefs.some((href) => href.startsWith("javascript:")),
        "a javascript: URL must never become a live anchor"
      );
      // The dangerous link keeps its text but loses its target.
      assert.match(shim.textContent(tree), /bad/);
    });
  });
});

test("images are collapsed by default with a count, and expand on click", async () => {
  const markdown = [
    "Text before.",
    "",
    "![first](https://x.test/1.png)",
    "",
    "![second](https://x.test/2.png)"
  ].join("\n");
  const shim = createReactShim();
  await withWindow(async () => {
    const { exports } = await loadBundle(seedsFor(shim));
    const host = markdownState(markdown);
    await withApi(markdownApi(host), async () => {
      const tree = await renderOpenItem(shim, exports, host);

      // Collapsed: the count is shown, but no <img> is in the tree at all, so
      // no remote image is requested until the reader asks for it.
      assert.match(shim.textContent(tree), /图片 2 张/);
      assert.match(shim.textContent(tree), /默认折叠/);
      assert.equal(shim.findAll(tree, "img").length, 0, "collapsed images must not render an <img>");

      // Expanding reveals both, in order.
      const toggle = buttonByText(shim, tree, "图片 2 张");
      assert.ok(toggle !== undefined, "the toggle should be a button");
      toggle.props.onClick();
      await settle();

      const expanded = await shim.render(shim.react.createElement(exports.RssPanel));
      const images = shim.findAll(expanded, "img");
      assert.equal(images.length, 2, "expanding reveals every image");
      assert.equal(images[0].props.src, "https://x.test/1.png");
      assert.equal(images[1].props.src, "https://x.test/2.png");
      assert.equal(images[0].props.alt, "first");
      // Images load lazily so a long article does not block on them.
      assert.equal(images[0].props.loading, "lazy");
      assert.match(shim.textContent(expanded), /点击折叠/);

      // Collapsing again removes them.
      const collapse = buttonByText(shim, expanded, "图片 2 张");
      collapse.props.onClick();
      await settle();
      const recollapsed = await shim.render(shim.react.createElement(exports.RssPanel));
      assert.equal(shim.findAll(recollapsed, "img").length, 0, "collapsing removes the images again");
    });
  });
});

test("an image tile starts loading, then settles on load or failure", async () => {
  const shim = createReactShim();
  await withWindow(async () => {
    const { exports } = await loadBundle(seedsFor(shim));
    const host = markdownState("![first](https://x.test/1.png)");
    const open = () => shim.render(shim.react.createElement(exports.RssPanel));
    await withApi(markdownApi(host), async () => {
      let tree = await renderOpenItem(shim, exports, host);
      // The toggle is the button carrying the collapse hint, whatever the
      // picture happens to be labelled.
      buttonByText(shim, tree, "默认折叠").props.onClick();
      await settle();
      tree = await open();

      // The image must be in the flow AND visible: one hidden with
      // `display: none` never enters the viewport, so a lazy image never
      // starts fetching and the tile is stuck on "载入中…" for good.
      const image = shim.findAll(tree, "img")[0];
      assert.ok(image !== undefined, "the image element must be rendered");
      assert.notEqual(image.props.style.display, "none", "the image must not be hidden while loading");
      assert.equal(image.props.loading, "lazy");
      assert.match(shim.textContent(tree), /载入中/);

      image.props.onLoad();
      await settle();
      tree = await open();
      assert.doesNotMatch(shim.textContent(tree), /载入中/, "a loaded image must drop its placeholder");
      assert.equal(shim.findAll(tree, "img").length, 1);

      // A failure settles too, instead of leaving the tile spinning.
      shim.findAll(tree, "img")[0].props.onError();
      await settle();
      tree = await open();
      assert.match(shim.textContent(tree), /图片加载失败/);
      assert.doesNotMatch(shim.textContent(tree), /载入中/);
      assert.equal(shim.findAll(tree, "img").length, 0, "the broken image gives way to the fallback");
    });
  });
});

test("each picture block stays where the article put it", async () => {
  // The old behaviour hoisted every image into one group at the end, which
  // turned a picture essay into a wall of text followed by a wall of images.
  // Position is restored: a picture block is a block, in document order.
  const shim = createReactShim();
  await withWindow(async () => {
    const { exports } = await loadBundle(seedsFor(shim));
    const markdown = [
      "First paragraph.",
      "",
      "![one](https://x.test/1.png)",
      "",
      "Second paragraph.",
      "",
      "![two](https://x.test/2.png)",
      "",
      "Third paragraph."
    ].join("\n");
    const host = markdownState(markdown);
    await withApi(markdownApi(host), async () => {
      const tree = await renderOpenItem(shim, exports, host);
      const text = shim.textContent(tree);
      assert.ok(!text.includes("!["), "raw image syntax must not leak into the text");
      // `textContent` walks the tree in order, so a label sitting between two
      // paragraphs is a label rendered between them.
      assert.match(text, /First paragraph\.[^]*图片：one[^]*Second paragraph\.[^]*图片：two[^]*Third paragraph\./,
        "each picture keeps its place in the reading order");
      // Still collapsed: a picture nobody opened costs no request.
      assert.equal(shim.findAll(tree, "img").length, 0, "nothing is downloaded until asked for");
    });
  });
});

test("pictures render unfolded when the reader asks for that", async () => {
  // The setting is a reading preference, not a rendering rule: with it on, the
  // pictures appear in their places straight away (still lazily).
  const shim = createReactShim();
  await withWindow(async () => {
    const { exports } = await loadBundle(seedsFor(shim));
    const host = markdownState([
      "Before.",
      "",
      "![one](https://x.test/1.png)",
      "",
      "After."
    ].join("\n"));
    // `/prefs` first, then the panel's own routes.
    const panelApi = markdownApi(host);
    await withApi((path, call) => {
      if (path.endsWith("/prefs")) {
        return { body: { ok: true, prefs: { showSidebarEntry: true, expandImages: true } } };
      }
      return panelApi(path, call);
    }, async () => {
      const ctx = makeCtx();
      exports.apply(ctx);
      await settle();
      const tree = await renderOpenItem(shim, exports, host);
      const text = shim.textContent(tree);
      assert.match(text, /Before\.[^]*After\./, "the text still reads in order");
      assert.equal(shim.findAll(tree, "img").length, 1, "the picture is shown without a click");
      assert.equal(shim.findAll(tree, "img")[0].props.loading, "lazy", "and still loads on demand");
    });
  });
});

test("the preference sets the initial state, and a click still pins one group", async () => {
  const shim = createReactShim();
  await withWindow(async () => {
    const { exports } = await loadBundle(seedsFor(shim));
    const host = markdownState("![one](https://x.test/1.png)");
    const panelApi = markdownApi(host);
    await withApi((path, call) => {
      if (path.endsWith("/prefs")) {
        return { body: { ok: true, prefs: { expandImages: true } } };
      }
      return panelApi(path, call);
    }, async () => {
      const ctx = makeCtx();
      exports.apply(ctx);
      await settle();
      let tree = await renderOpenItem(shim, exports, host);
      assert.equal(shim.findAll(tree, "img").length, 1, "the preference unfolds it");

      buttonByText(shim, tree, "点击折叠").props.onClick();
      await settle();
      tree = await shim.render(shim.react.createElement(exports.RssPanel));
      assert.equal(shim.findAll(tree, "img").length, 0, "a click folds this one back");
    });
  });
});

test("pictures with only blank lines between them stay one group", async () => {
  const shim = createReactShim();
  await withWindow(async () => {
    const { exports } = await loadBundle(seedsFor(shim));
    // A blank line between pictures is typography, not separation: the article
    // meant one gallery, and two collapsing bars would read as two.
    const markdown = [
      "![a](https://x.test/1.png)",
      "![b](https://x.test/2.png)",
      "",
      "![c](https://x.test/3.png)"
    ].join("\n");
    const host = markdownState(markdown);
    await withApi(markdownApi(host), async () => {
      const tree = await renderOpenItem(shim, exports, host);
      const toggles = shim.findAll(tree, "button").filter((node) => shim.textContent(node).includes("默认折叠"));
      assert.equal(toggles.length, 1, "one run of pictures is one control");
      assert.match(shim.textContent(toggles[0]), /图片 3 张/);

      // Expanding shows all three, in the order the article had them.
      toggles[0].props.onClick();
      await settle();
      const expanded = await shim.render(shim.react.createElement(exports.RssPanel));
      assert.deepEqual(shim.findAll(expanded, "img").map((node) => node.props.src), [
        "https://x.test/1.png",
        "https://x.test/2.png",
        "https://x.test/3.png"
      ]);
    });
  });
});

test("an image inside a sentence stays in the sentence, folded to a chip", async () => {
  const shim = createReactShim();
  await withWindow(async () => {
    const { exports } = await loadBundle(seedsFor(shim));
    const host = markdownState("Look here ![a badge](https://x.test/badge.png) and read on.");
    await withApi(markdownApi(host), async () => {
      const tree = await renderOpenItem(shim, exports, host);
      const text = shim.textContent(tree);
      // The chip holds the sentence together instead of breaking it into three
      // paragraphs with a picture bar in the middle.
      assert.match(text, /Look here 🖼 a badge and read on\./);
      assert.equal(shim.findAll(tree, "img").length, 0, "the chip downloads nothing until clicked");

      buttonByText(shim, tree, "🖼 a badge").props.onClick();
      await settle();
      const opened = await shim.render(shim.react.createElement(exports.RssPanel));
      const images = shim.findAll(opened, "img");
      assert.equal(images.length, 1, "clicking the chip reveals the picture in place");
      assert.equal(images[0].props.src, "https://x.test/badge.png");
    });
  });
});

test("an inline image that fails says so instead of leaving a hole", async () => {
  const shim = createReactShim();
  await withWindow(async () => {
    const { exports } = await loadBundle(seedsFor(shim));
    const host = markdownState("before ![bad](https://x.test/bad.png) after");
    await withApi(markdownApi(host), async () => {
      const tree = await renderOpenItem(shim, exports, host);
      buttonByText(shim, tree, "🖼 bad").props.onClick();
      await settle();
      const opened = await shim.render(shim.react.createElement(exports.RssPanel));
      shim.findAll(opened, "img")[0].props.onError();
      await settle();
      const failed = await shim.render(shim.react.createElement(exports.RssPanel));
      assert.match(shim.textContent(failed), /图片加载失败/);
    });
  });
});

test("expanding an image opens a lightbox and Escape closes it", async () => {
  const shim = createReactShim();
  await withWindow(async () => {
    const { exports } = await loadBundle(seedsFor(shim));
    const host = markdownState("![pic](https://x.test/1.png)");
    await withApi(markdownApi(host), async () => {
      const tree = await renderOpenItem(shim, exports, host);
      buttonByText(shim, tree, "默认折叠").props.onClick();
      await settle();

      const expanded = await shim.render(shim.react.createElement(exports.RssPanel));
      const image = shim.findAll(expanded, "img")[0];
      image.props.onClick();
      await settle();

      const withLightbox = await shim.render(shim.react.createElement(exports.RssPanel));
      // Two images now: the tile and the enlarged copy.
      assert.equal(shim.findAll(withLightbox, "img").length, 2, "the lightbox should show the image");
      assert.match(shim.textContent(withLightbox), /原图/);
    });
  });
});

test("the translate button is hidden when no model is available", async () => {
  const shim = createReactShim();
  await withWindow(async () => {
    const { exports } = await loadBundle(seedsFor(shim));
    const host = markdownState("# Body", {}, { translateAvailable: false });
    await withApi(markdownApi(host), async () => {
      const tree = await renderOpenItem(shim, exports, host);
      // Offering a button that can only fail is worse than hiding it.
      assert.equal(buttonByText(shim, tree, "译"), undefined, "no translate button without a model");
      assert.ok(!shim.textContent(tree).includes("翻译为"), "no target picker without a model");
    });
  });
});

test("the translate button asks the host and swaps in the translation", async () => {
  const shim = createReactShim();
  await withWindow(async () => {
    const { exports } = await loadBundle(seedsFor(shim));
    const host = markdownState("# Original heading\n\nOriginal body.");
    const calls = [];
    await withApi(markdownApi(host, (kind, call) => calls.push({ kind, call })), async () => {
      const tree = await renderOpenItem(shim, exports, host);
      assert.match(shim.textContent(tree), /Original body/);

      const button = buttonByText(shim, tree, "译");
      assert.ok(button !== undefined, "the translate button should be offered");
      button.props.onClick();
      await settle();
      await settle();

      const translated = await shim.render(shim.react.createElement(exports.RssPanel));
      const text = shim.textContent(translated);
      assert.match(text, /译文/, "the translation should be shown");
      assert.ok(!text.includes("Original body"), "the original is replaced while the translation is shown");

      const request = calls.find((entry) => entry.kind === "translate");
      assert.ok(request !== undefined, "the host must be asked to translate");
      assert.equal(request.call.body.target, "zh-CN", "the picker's target is sent");
    });
  });
});

test("a cached translation is revealed without calling the model", async () => {
  const shim = createReactShim();
  await withWindow(async () => {
    const { exports } = await loadBundle(seedsFor(shim));
    const host = markdownState("# Original", {
      translation: { title: "译标题", markdown: "已缓存的译文", target: "zh-CN", model: "p/m", at: "2024-05-01T00:00:00.000Z" }
    });
    const calls = [];
    await withApi(markdownApi(host, (kind) => calls.push(kind)), async () => {
      const tree = await renderOpenItem(shim, exports, host);
      // With a cached translation the control offers to show it.
      const button = buttonByText(shim, tree, "译文");
      assert.ok(button !== undefined, "a cached translation should offer a toggle");
      button.props.onClick();
      await settle();

      const shown = await shim.render(shim.react.createElement(exports.RssPanel));
      assert.match(shim.textContent(shown), /已缓存的译文/);
      assert.ok(
        !calls.includes("translate"),
        "revealing a cached translation must not call the model again"
      );
      // The metadata records where it came from.
      assert.match(shim.textContent(shown), /p\/m/);
    });
  });
});

test("a translation failure is reported and the original stays visible", async () => {
  const shim = createReactShim();
  await withWindow(async () => {
    const { exports } = await loadBundle(seedsFor(shim));
    const host = markdownState("# Original body");
    await withApi(
      (path, call) => {
        if (path.includes("/item?")) return markdownApi(host)(path, call);
        if (path.endsWith("/translate") && call.method === "GET") return markdownApi(host)(path, call);
        if (path.endsWith("/translate")) {
          return { status: 502, body: { ok: false, error: "the model returned no text" } };
        }
        return { body: { ok: true, state: host.state, refreshing: false } };
      },
      async () => {
        const tree = await renderOpenItem(shim, exports, host);
        buttonByText(shim, tree, "译").props.onClick();
        await settle();
        await settle();

        const after = await shim.render(shim.react.createElement(exports.RssPanel));
        const text = shim.textContent(after);
        assert.match(text, /翻译失败/, "the failure must be surfaced");
        assert.match(text, /the model returned no text/, "with the host's reason");
        assert.match(text, /Original body/, "the original stays readable");
      }
    );
  });
});

test("对照 interleaves each paragraph with its translation", async () => {
  const shim = createReactShim();
  await withWindow(async () => {
    const { exports } = await loadBundle(seedsFor(shim));
    const originalBody = "First paragraph.\n\nSecond paragraph.";
    const host = markdownState(originalBody);
    let translation = { title: "中文标题", markdown: "第一段。\n\n第二段。", segments: ["第一段。", "第二段。"], target: "zh-CN", model: "p/m", at: "2024-05-01T00:00:00.000Z" };
    const posted = [];
    const api = markdownApi(host, (kind, call) => posted.push({ kind, call }));
    await withApi((path, call) => {
      if (path.includes("/item?")) {
        // The pane re-reads the item; hand back the translation in force so the
        // view it switches to is the one the reader actually has.
        const base = api(path, call);
        return { ...base, body: { ...base.body, item: { ...base.body.item, translation } } };
      }
      // A re-translation answers with a fresh aligned result.
      if (path.endsWith("/translate") && call.method === "POST") {
        posted.push({ kind: "translate", call });
        translation = { ...translation, segments: ["第一段。", "第二段。"], markdown: "第一段。\n\n第二段。" };
        return { body: { ok: true, cached: false, translation } };
      }
      return api(path, call);
    }, async () => {
      let tree = await renderOpenItem(shim, exports, host);
      // Translation-only is for reading the translation on its own.
      buttonByText(shim, tree, "译文").props.onClick();
      await settle();
      tree = await shim.render(shim.react.createElement(exports.RssPanel));
      const translatedOnly = shim.textContent(tree);
      assert.match(translatedOnly, /第一段。/);
      assert.doesNotMatch(translatedOnly, /First paragraph/, "译文模式只显示译文");

      // 对照 puts each paragraph back above its translation.
      buttonByText(shim, tree, "对照").props.onClick();
      await settle();
      await settle();
      tree = await shim.render(shim.react.createElement(exports.RssPanel));
      const text = shim.textContent(tree);
      assert.match(text, /First paragraph/, "对照模式保留原文");
      assert.match(text, /第一段。/);
      assert.match(text, /Second paragraph/);
      assert.match(text, /第二段。/);
      // Interleaved, not appended: the first pair must come before the second
      // one on both sides.
      assert.ok(text.indexOf("First paragraph") < text.indexOf("Second paragraph"));
      assert.ok(text.indexOf("第一段。") < text.indexOf("第二段。"));
      assert.ok(text.indexOf("First paragraph") < text.indexOf("第一段。"), "译文紧跟它自己的原文");
      // The aligned form is already cached, so switching views is free.
      assert.equal(posted.filter((entry) => entry.kind === "translate").length, 0);
    });
  });
});

test("without aligned segments the interleaved view re-translates instead of guessing", async () => {
  const shim = createReactShim();
  await withWindow(async () => {
    const { exports } = await loadBundle(seedsFor(shim));
    const originalBody = "First paragraph.\n\nSecond paragraph.";
    const host = markdownState(originalBody);
    // A translation cached before the segment-aligned form existed.
    let translation = { title: "中文标题", markdown: "第一段。\n\n第二段。", target: "zh-CN", model: "p/m", at: "2024-05-01T00:00:00.000Z" };
    const posted = [];
    const api = markdownApi(host, (kind, call) => posted.push({ kind, call }));
    await withApi((path, call) => {
      if (path.includes("/item?")) {
        const base = api(path, call);
        return { ...base, body: { ...base.body, item: { ...base.body.item, translation } } };
      }
      if (path.endsWith("/translate") && call.method === "POST") {
        posted.push({ kind: "translate", call });
        // The model now answers per segment, so the view becomes available.
        translation = { ...translation, segments: ["第一段。", "第二段。"] };
        return { body: { ok: true, cached: false, translation } };
      }
      return api(path, call);
    }, async () => {
      let tree = await renderOpenItem(shim, exports, host);
      buttonByText(shim, tree, "对照").props.onClick();
      await settle();
      await settle();
      tree = await shim.render(shim.react.createElement(exports.RssPanel));
      const translateCalls = posted.filter((entry) => entry.kind === "translate");
      assert.equal(translateCalls.length, 1, "没有分段就必须重译，而不是硬配对");
      assert.equal(translateCalls[0].call.body.force, true);
      const text = shim.textContent(tree);
      assert.match(text, /First paragraph/);
      assert.match(text, /第一段。/);
    });
  });
});

test("an image-only body is left out of the pairing", async () => {
  const shim = createReactShim();
  await withWindow(async () => {
    const { exports } = await loadBundle(seedsFor(shim));
    // The model was told to answer with an empty string for a picture block, so
    // the aligned arrays still line up and the picture is not printed twice.
    const host = markdownState("Prose paragraph.\n\n![pic](https://x.test/a.png)");
    let translation = { title: "", markdown: "散文段落。", segments: ["散文段落。", ""], target: "zh-CN", model: "p/m", at: "2024-05-01T00:00:00.000Z" };
    const api = markdownApi(host);
    await withApi((path, call) => {
      if (path.includes("/item?")) {
        const base = api(path, call);
        return { ...base, body: { ...base.body, item: { ...base.body.item, translation } } };
      }
      return api(path, call);
    }, async () => {
      let tree = await renderOpenItem(shim, exports, host);
      buttonByText(shim, tree, "对照").props.onClick();
      await settle();
      await settle();
      tree = await shim.render(shim.react.createElement(exports.RssPanel));
      assert.match(shim.textContent(tree), /散文段落/);
      // The original picture appears once (from its source block), not twice.
      assert.equal(shim.findAll(tree, "img").length + (shim.textContent(tree).match(/pic/g) ?? []).length, 1);
    });
  });
});

/**
 * Record the delays the panel schedules for its notices.
 *
 * The panel calls timers through the global, so recording the window double is
 * not enough. Only the two-second notice dismissal is withheld — everything
 * else (including the test renderer's own tick) takes the real timer, so the
 * render loop still settles — and the caller fires the dismissal itself,
 * on purpose.
 *
 * @returns {{scheduled: object[], restore: Function}} the recorder.
 */
function recordTimers() {
  const original = globalThis.setTimeout;
  const scheduled = [];
  globalThis.setTimeout = (callback, delay) => {
    if (delay === 2000) {
      scheduled.push({ callback, delay });
      return 0;
    }
    return original(callback, delay);
  };
  return {
    scheduled,
    restore() {
      globalThis.setTimeout = original;
    }
  };
}

test("a success notice dismisses itself after two seconds", async () => {
  const shim = createReactShim();
  await withWindow(async () => {
    const { exports } = await loadBundle(seedsFor(shim));
    const timers = recordTimers();
    try {
      const host = markdownState("body");
      const api = markdownApi(host);
      await withApi((path, call) => {
        if (path.includes("/refresh")) {
          return { body: { ok: true, state: host.state, summary: { refreshed: 3, results: [1, 2, 3, 4], added: 12, failed: 0 } } };
        }
        return api(path, call);
      }, async () => {
        let tree = await shim.render(shim.react.createElement(exports.RssPanel));
        buttonByText(shim, tree, "刷新").props.onClick();
        await settle();
        await settle();
        tree = await shim.render(shim.react.createElement(exports.RssPanel));
        assert.match(shim.textContent(tree), /已刷新 3\/4 个源/, "刷新结果先要看得见");
        assert.match(shim.textContent(tree), /新增 12 条/);

        // The wait is the two seconds the reader asked for...
        const pending = timers.scheduled.filter((entry) => entry.delay === 2000);
        assert.ok(pending.length >= 1, "a two-second auto-dismiss should be scheduled");
        // ...and firing it takes the notice away, with no click involved.
        pending[pending.length - 1].callback();
        await settle();
        tree = await shim.render(shim.react.createElement(exports.RssPanel));
        assert.doesNotMatch(shim.textContent(tree), /已刷新/, "提示应自行消失，不必手动关闭");
      });
    } finally {
      timers.restore();
    }
  });
});

test("an error notice waits for a manual close instead of expiring", async () => {
  const shim = createReactShim();
  await withWindow(async () => {
    const { exports } = await loadBundle(seedsFor(shim));
    const timers = recordTimers();
    try {
      const host = markdownState("body");
      const api = markdownApi(host);
      await withApi((path, call) => {
        if (path.includes("/refresh")) {
          return { status: 502, body: { ok: false, error: "全部订阅源都抓取失败了" } };
        }
        return api(path, call);
      }, async () => {
        let tree = await shim.render(shim.react.createElement(exports.RssPanel));
        buttonByText(shim, tree, "刷新").props.onClick();
        await settle();
        await settle();
        tree = await shim.render(shim.react.createElement(exports.RssPanel));
        assert.match(shim.textContent(tree), /全部订阅源都抓取失败了/, "失败必须说出来");

        // Nothing scheduled to hide it: an error the reader may have to act on
        // must not vanish on a timer.
        assert.equal(timers.scheduled.filter((entry) => entry.delay === 2000).length, 0,
          "异常提示不该排定自动关闭");
        assert.match(shim.textContent(tree), /全部订阅源都抓取失败了/);

        // Closing it is the reader's move.
        buttonByText(shim, tree, "关闭").props.onClick();
        await settle();
        tree = await shim.render(shim.react.createElement(exports.RssPanel));
        assert.doesNotMatch(shim.textContent(tree), /全部订阅源都抓取失败了/);
      });
    } finally {
      timers.restore();
    }
  });
});

test("notices float in the bottom-right, semi-transparent, with a distinct close", async () => {
  const shim = createReactShim();
  await withWindow(async () => {
    const { exports } = await loadBundle(seedsFor(shim));
    const host = markdownState("body");
    const api = markdownApi(host);
    await withApi((path, call) => {
      if (path.includes("/refresh")) {
        return { body: { ok: true, state: host.state, summary: { refreshed: 3, results: [1, 2, 3, 4], added: 12, failed: 0 } } };
      }
      return api(path, call);
    }, async () => {
      let tree = await shim.render(shim.react.createElement(exports.RssPanel));
      buttonByText(shim, tree, "刷新").props.onClick();
      await settle();
      await settle();
      tree = await shim.render(shim.react.createElement(exports.RssPanel));

      // The message must not sit in the panel's flow: arriving mid-article it
      // would shove the list the reader is looking at.
      const layer = shim.findAll(tree, "div").find((node) => node.props?.style?.position === "fixed"
        && node.props?.style?.right !== undefined && node.props?.style?.bottom !== undefined);
      assert.ok(layer !== undefined, "提示应固定悬浮在角落");
      assert.equal(layer.props.style.right, "18px", "贴右下角");
      assert.equal(layer.props.style.bottom, "18px");
      assert.ok(Number(layer.props.style.zIndex) >= 2200, "要盖在面板内容之上");

      const toast = shim.findAll(layer, "div").find((node) => node.props?.style?.backdropFilter !== undefined);
      assert.ok(toast !== undefined, "提示卡片应当半透明（带背景模糊）");
      const background = String(toast.props.style.background);
      assert.match(background, /rgba\(/, `底色应是半透明而非实色，实得 ${background}`);

      // The close control must not wear the message's ink: sharing it made the
      // two read as one sentence with a stray 「关闭」 stuck on the end.
      const text = shim.findAll(toast, "span")[0];
      const close = shim.findAll(toast, "button")[0];
      assert.ok(text !== undefined, "提示文字应自成一块");
      assert.ok(close !== undefined, "关闭应是一个独立控件");
      assert.notEqual(close.props.style.color, text.props.style.color,
        "关闭按钮的颜色要和提示文字区分开");
      assert.notEqual(close.props.style.color, undefined);
      assert.equal(close.props.style.borderRadius, "999px", "关闭做成独立的小胶囊");
      assert.ok(String(close.props.style.border ?? "").length > 0, "关闭要有自己的描边");

      // Clicking it clears that message only.
      close.props.onClick();
      await settle();
      tree = await shim.render(shim.react.createElement(exports.RssPanel));
      assert.doesNotMatch(shim.textContent(tree), /已刷新 3\/4 个源/);
    });
  });
});

test("fetching older articles: the button, the dialog, and the request", async () => {
  const shim = createReactShim();
  await withWindow(async () => {
    const { exports } = await loadBundle(seedsFor(shim));
    const host = markdownState("正文段落一");
    const posted = [];
    const api = markdownApi(host);
    await withApi((path, call) => {
      if (path.endsWith("/history")) {
        posted.push(call.body);
        return {
          body: {
            ok: true,
            added: 3,
            total: 6,
            considered: 412,
            skipped: 1,
            failures: [],
            state: { ...host.state, totals: { ...host.state.totals, items: 6 } }
          }
        };
      }
      return api(path, call);
    }, async () => {
      const render = () => shim.render(shim.react.createElement(exports.RssPanel, { variant: "sidebar" }));
      let tree = await render();

      // The action only makes sense for one source, so it appears with one.
      // This is the narrow presentation, where the controls are glyph-only.
      const sourceChip = buttonByText(shim, tree, "示例订阅源");
      assert.equal(buttonByText(shim, tree, "⇤"), undefined, "「全部」时不应该有这个入口");
      sourceChip.props.onClick();
      await settle();
      tree = await render();
      const open = buttonByText(shim, tree, "⇤");
      assert.ok(open !== undefined, "选中一个源后应提供抓取更早文章的入口");
      assert.match(open.props.title, /更早/, "它的说明要说清这是抓更早的文章");

      open.props.onClick();
      await settle();
      tree = await render();
      const urlField = shim.findAll(tree, "input").find((node) => node.props["aria-label"] === "归档页地址");
      const countField = shim.findAll(tree, "input").find((node) => node.props["aria-label"] === "抓取篇数");
      assert.ok(urlField !== undefined && countField !== undefined, "对话框要有地址与篇数两个输入");
      // Prefilled from the feed's own links, so the reader usually just confirms.
      assert.match(urlField.props.value, /^https?:\/\/s\.test\//);
      assert.equal(countField.props.value, "20");

      countField.props.onChange({ target: { value: "5" } });
      await settle();
      tree = await render();
      buttonByText(shim, tree, "开始抓取").props.onClick();
      await settle();
      await settle();
      assert.equal(posted.length, 1, "点一次就发一次");
      assert.equal(posted[0].feedId, "f1");
      assert.equal(posted[0].limit, 5);
      assert.match(posted[0].archiveUrl, /^https?:\/\/s\.test\//);

      // The outcome is reported in the dialog, and the new items are on screen.
      tree = await render();
      assert.match(shim.textContent(tree), /新增 3 篇/);
      assert.match(shim.textContent(tree), /跳过已订阅的 1 篇/);
      assert.match(shim.textContent(tree), /共 6 条/);
    });
  });
});

test("a backfill that fails keeps the dialog open and says why", async () => {
  const shim = createReactShim();
  await withWindow(async () => {
    const { exports } = await loadBundle(seedsFor(shim));
    const host = markdownState("正文段落一");
    const api = markdownApi(host);
    await withApi((path, call) => {
      if (path.endsWith("/history")) {
        return { status: 502, body: { ok: false, error: "读取归档页失败：HTTP 404" } };
      }
      return api(path, call);
    }, async () => {
      const render = () => shim.render(shim.react.createElement(exports.RssPanel, { variant: "sidebar" }));
      let tree = await render();
      buttonByText(shim, tree, "示例订阅源").props.onClick();
      await settle();
      tree = await render();
      buttonByText(shim, tree, "⇤").props.onClick();
      await settle();
      tree = await render();
      buttonByText(shim, tree, "开始抓取").props.onClick();
      await settle();
      await settle();
      tree = await render();
      assert.match(shim.textContent(tree), /读取归档页失败/, "失败原因要留在对话框里");
      // Still open, so the address can be corrected and retried.
      assert.ok(buttonByText(shim, tree, "开始抓取") !== undefined, "失败后应还能重试");
    });
  });
});

test("switching the target language drops the shown translation", async () => {
  const shim = createReactShim();
  await withWindow(async () => {
    const { exports } = await loadBundle(seedsFor(shim));
    const host = markdownState("# Original body", {
      translation: { title: "译标题", markdown: "中文译文", target: "zh-CN", model: "p/m", at: "2024-05-01T00:00:00.000Z" }
    });
    await withApi(markdownApi(host), async () => {
      const tree = await renderOpenItem(shim, exports, host);
      buttonByText(shim, tree, "译文").props.onClick();
      await settle();
      const shown = await shim.render(shim.react.createElement(exports.RssPanel));
      assert.match(shim.textContent(shown), /中文译文/);

      // Switching to another language must not keep showing the old one.
      const select = shim.findAll(shown, "select")[0];
      assert.ok(select !== undefined, "the target picker should be present");
      select.props.onChange({ target: { value: "en" } });
      await settle();
      const switched = await shim.render(shim.react.createElement(exports.RssPanel));
      assert.match(shim.textContent(switched), /Original body/, "the original returns until re-translated");
    });
  });
});

test("the target picker lists the languages the host advertises", async () => {
  const shim = createReactShim();
  await withWindow(async () => {
    const { exports } = await loadBundle(seedsFor(shim));
    const host = markdownState("body");
    await withApi(markdownApi(host), async () => {
      const tree = await renderOpenItem(shim, exports, host);
      const select = shim.findAll(tree, "select")[0];
      assert.ok(select !== undefined);
      const options = shim.findAll(select, "option");
      assert.equal(options.length, 2, "one option per advertised target");
      assert.equal(options[0].props.value, "zh-CN");
      // Options show a friendly label, not a bare code.
      assert.match(shim.textContent(options[0]), /简体中文/);
    });
  });
});

test("a description-only item still renders its article", async () => {
  // Feeds that publish the whole article in <description> leave `markdown`
  // empty; falling back to the summary is what keeps them readable.
  const shim = createReactShim();
  await withWindow(async () => {
    const { exports } = await loadBundle(seedsFor(shim));
    const host = markdownState("", { summaryMarkdown: "## 来自摘要的正文\n\n内容在此。" });
    await withApi(markdownApi(host), async () => {
      const tree = await renderOpenItem(shim, exports, host);
      const text = shim.textContent(tree);
      assert.match(text, /来自摘要的正文/);
      assert.equal(shim.findAll(tree, "h2").length, 1, "the summary renders as Markdown too");
    });
  });
});

test("an item with no body at all says so instead of rendering blank", async () => {
  const shim = createReactShim();
  await withWindow(async () => {
    const { exports } = await loadBundle(seedsFor(shim));
    // No body, no summary, no fallback: the pane must explain itself rather
    // than render an empty area.
    const host = markdownState("", { summary: "", summaryMarkdown: "" });
    await withApi(markdownApi(host), async () => {
      const tree = await renderOpenItem(shim, exports, host);
      assert.match(shim.textContent(tree), /没有正文摘要/);
    });
  });
});

test("hostile markup in a feed body cannot inject script", async () => {
  // The renderer builds React elements rather than HTML strings, so a script
  // tag is inert text; this pins that property.
  const shim = createReactShim();
  await withWindow(async () => {
    const { exports } = await loadBundle(seedsFor(shim));
    const host = markdownState("Before <script>alert(1)</script> After <img src=x onerror=alert(2)>");
    await withApi(markdownApi(host), async () => {
      const tree = await renderOpenItem(shim, exports, host);
      const text = shim.textContent(tree);
      // No element carries an inline event handler.
      const all = [];
      const walk = (node) => {
        all.push(node);
        for (const child of node.children ?? []) walk(child);
      };
      walk(tree);
      // Every handler in the tree is one this panel attaches to its own
      // controls; none can come from feed text, which only ever reaches
      // `children`.
      const ownHandlers = new Set([
        "onClick", "onChange", "onLoad", "onError", "onKeyDown", "onContextMenu",
        "onDragStart", "onDragOver", "onDrop", "onDragEnd",
        // The list panes track their own scroll offset to remember the reader's
        // place. It is attached by the panel to its <div>, never by feed markup.
        "onScroll"
      ]);
      for (const node of all) {
        for (const key of Object.keys(node.props ?? {})) {
          assert.ok(!key.startsWith("on") || ownHandlers.has(key),
            `unexpected handler prop ${key}`);
        }
      }
    });
  });
});

// ── RSSHub discovery in the add dialog ──────────────────────────────────────

/**
 * Open the add-subscription dialog.
 *
 * @param {object} shim - the render shim.
 * @param {object} exports - the bundle's exports.
 * @returns {Promise<object>} the rendered tree.
 */
async function openAddDialog(shim, exports) {
  const tree = await shim.render(shim.react.createElement(exports.RssPanel));
  const addButton = shim.findAll(tree, "button").find((node) => shim.textContent(node).includes("添加订阅源"));
  assert.ok(addButton !== undefined, "the add button should render");
  addButton.props.onClick();
  await settle();
  return shim.render(shim.react.createElement(exports.RssPanel));
}

/** Type a URL into the dialog's address field. */
function fillUrl(shim, tree, value) {
  const input = shim.findAll(tree, "input").find((node) => String(node.props.placeholder ?? "").includes("example.com"));
  assert.ok(input !== undefined, "the URL field should render");
  input.props.onChange({ target: { value } });
}

/** Click the dialog's lookup button. */
function clickFind(shim, tree) {
  const button = shim.findAll(tree, "button").find((node) => shim.textContent(node).includes("查找"));
  assert.ok(button !== undefined, "the find button should render");
  button.props.onClick();
}

test("the add dialog offers a lookup button", async () => {
  const shim = createReactShim();
  await withWindow(async () => {
    const { exports } = await loadBundle(seedsFor(shim));
    const host = markdownState("body");
    await withApi(markdownApi(host), async () => {
      const dialog = await openAddDialog(shim, exports);
      const button = shim.findAll(dialog, "button").find((node) => shim.textContent(node).includes("查找"));
      assert.ok(button !== undefined, "the dialog should offer discovery");
    });
  });
});

test("discovery lists the page's own feeds and RSSHub routes together", async () => {
  const shim = createReactShim();
  await withWindow(async () => {
    const { exports } = await loadBundle(seedsFor(shim));
    const host = markdownState("body");
    const seen = [];
    await withApi(
      (path, call) => {
        if (path.endsWith("/discover")) {
          seen.push(call.body.url);
          return {
            body: {
              ok: true,
              candidates: [
                { kind: "feed", source: "page", title: "该站点自己的订阅源", url: "https://x.test/own.xml" },
                { kind: "rsshub", source: "rsshub", title: "UP 主动态", url: "https://rsshub.test/bilibili/user/dynamic/2267573", route: "/bilibili/user/dynamic/2267573" }
              ],
              finalUrl: "https://space.bilibili.com/2267573",
              rsshub: { enabled: true, base: "https://rsshub.test", site: "哔哩哔哩", domain: "bilibili.com" }
            }
          };
        }
        return markdownApi(host)(path, call);
      },
      async () => {
        const dialog = await openAddDialog(shim, exports);
        fillUrl(shim, dialog, "https://space.bilibili.com/2267573");
        await settle();
        const filled = await shim.render(shim.react.createElement(exports.RssPanel));
        clickFind(shim, filled);
        await settle();
        await settle();

        const results = await shim.render(shim.react.createElement(exports.RssPanel));
        const text = shim.textContent(results);
        assert.match(text, /找到 2 个订阅源/, "the count is shown");
        assert.match(text, /该站点自己的订阅源/, "the page's feed is listed");
        assert.match(text, /UP 主动态/, "the RSSHub route is listed");
        // The source is labelled so the user knows where each came from.
        assert.match(text, /RSSHub/);
        assert.match(text, /站点/);
        assert.deepEqual(seen, ["https://space.bilibili.com/2267573"]);
      }
    );
  });
});

test("clicking a discovered candidate subscribes to it with its title", async () => {
  const shim = createReactShim();
  await withWindow(async () => {
    const { exports } = await loadBundle(seedsFor(shim));
    const host = markdownState("body");
    let added;
    await withApi(
      (path, call) => {
        if (path.endsWith("/discover")) {
          return {
            body: {
              ok: true,
              candidates: [{ kind: "rsshub", source: "rsshub", title: "UP 主动态", url: "https://rsshub.test/bilibili/user/dynamic/2267573", route: "/bilibili/user/dynamic/2267573" }],
              finalUrl: "https://space.bilibili.com/2267573",
              rsshub: { enabled: true, base: "https://rsshub.test", site: "哔哩哔哩", domain: "bilibili.com" }
            }
          };
        }
        if (path.endsWith("/feeds") && call.method === "POST") added = call.body;
        return markdownApi(host)(path, call);
      },
      async () => {
        const dialog = await openAddDialog(shim, exports);
        fillUrl(shim, dialog, "https://space.bilibili.com/2267573");
        await settle();
        const filled = await shim.render(shim.react.createElement(exports.RssPanel));
        clickFind(shim, filled);
        await settle();
        await settle();

        const results = await shim.render(shim.react.createElement(exports.RssPanel));
        const row = shim.findAll(results, "button").find((node) => shim.textContent(node).includes("UP 主动态"));
        assert.ok(row !== undefined, "the candidate should be clickable");
        row.props.onClick();
        await settle();
        await settle();

        assert.ok(added !== undefined, "picking a candidate must subscribe");
        assert.equal(added.url, "https://rsshub.test/bilibili/user/dynamic/2267573");
        // The route's title is used, so the feed is not named by URL.
        assert.equal(added.title, "UP 主动态");
      }
    );
  });
});

test("when no route matches, the dialog explains and shows domain routes", async () => {
  const shim = createReactShim();
  await withWindow(async () => {
    const { exports } = await loadBundle(seedsFor(shim));
    const host = markdownState("body");
    await withApi(
      (path, call) => {
        if (path.endsWith("/discover")) {
          return {
            body: {
              ok: true,
              candidates: [],
              finalUrl: "https://github.com/",
              rsshub: {
                enabled: true,
                base: "https://rsshub.test",
                site: "GitHub",
                domain: "github.com",
                reason: "RSSHub has no route for this URL",
                domainRoutes: [
                  { title: "User Activities", route: "/github/activity/:user", docs: "", needsParams: true },
                  { title: "Repo Branches", route: "/github/branches/:user/:repo", docs: "", needsParams: true }
                ],
                domainRouteTotal: 24
              }
            }
          };
        }
        return markdownApi(host)(path, call);
      },
      async () => {
        const dialog = await openAddDialog(shim, exports);
        fillUrl(shim, dialog, "https://github.com/");
        await settle();
        const filled = await shim.render(shim.react.createElement(exports.RssPanel));
        clickFind(shim, filled);
        await settle();
        await settle();

        const results = await shim.render(shim.react.createElement(exports.RssPanel));
        const text = shim.textContent(results);
        assert.match(text, /没有找到可用的订阅源/, "the outcome is explained");
        // Orientation: what the site does offer, and that it needs a page URL.
        assert.match(text, /24 条路由/);
        assert.match(text, /User Activities/);
      }
    );
  });
});

test("a discovery failure is shown in the dialog", async () => {
  const shim = createReactShim();
  await withWindow(async () => {
    const { exports } = await loadBundle(seedsFor(shim));
    const host = markdownState("body");
    await withApi(
      (path, call) => {
        if (path.endsWith("/discover")) return { status: 502, body: { ok: false, error: "cannot reach https://rsshub.test" } };
        return markdownApi(host)(path, call);
      },
      async () => {
        const dialog = await openAddDialog(shim, exports);
        fillUrl(shim, dialog, "https://x.test/");
        await settle();
        const filled = await shim.render(shim.react.createElement(exports.RssPanel));
        clickFind(shim, filled);
        await settle();
        await settle();

        const results = await shim.render(shim.react.createElement(exports.RssPanel));
        assert.match(shim.textContent(results), /cannot reach https:\/\/rsshub\.test/);
      }
    );
  });
});

// ── time windows ────────────────────────────────────────────────────────────

test("the stream opens on the full timeline, with the windows offered but unused", async () => {
  const shim = createReactShim();
  await withWindow(async () => {
    const { exports } = await loadBundle(seedsFor(shim));
    const host = datedState([
      { days: 0, title: "今天的新闻" },
      { days: 4, title: "四天前的旧闻" }
    ]);
    await withApi(markdownApi(host), async () => {
      const tree = await shim.render(shim.react.createElement(exports.RssPanel));
      const text = shim.textContent(tree);

      // The default matters: adding a time filter must not silently start
      // hiding things from a reader who never asked for a window.
      assert.match(text, /今天的新闻/);
      assert.match(text, /四天前的旧闻/);

      // All four windows are on offer, and none is in force.
      const labels = shim.findAll(tree, "button").map((node) => shim.textContent(node));
      for (const label of RANGE_LABELS) {
        assert.ok(labels.includes(label), `应提供「${label}」时间胶囊`);
      }
      const pressed = shim.findAll(tree, "button").filter((node) => node.props["aria-pressed"] === true);
      assert.deepEqual(pressed.map((node) => shim.textContent(node)), ["全部"],
        "默认生效的应当是「全部」");
    });
  });
});

test("choosing 今天 narrows the stream to the local calendar day", async () => {
  const shim = createReactShim();
  await withWindow(async () => {
    const { exports } = await loadBundle(seedsFor(shim));
    const host = datedState([
      { days: 0, title: "今天的新闻" },
      { days: 1, title: "昨天的旧闻" },
      { days: 4, title: "四天前的旧闻" }
    ]);
    await withApi(markdownApi(host), async () => {
      let tree = await shim.render(shim.react.createElement(exports.RssPanel));
      pickRange(shim, tree, "今天");
      await settle();
      tree = await shim.render(shim.react.createElement(exports.RssPanel));
      const text = shim.textContent(tree);

      assert.match(text, /今天的新闻/, "今天发布的应当留下");
      assert.doesNotMatch(text, /昨天的旧闻/, "昨天的应当被窗口排除");
      assert.doesNotMatch(text, /四天前的旧闻/, "更早的同样排除");

      // The chip in force says so, rather than leaving the reader guessing.
      const pressed = shim.findAll(tree, "button").filter((node) => node.props["aria-pressed"] === true);
      assert.deepEqual(pressed.map((node) => shim.textContent(node)), ["今天"]);
    });
  });
});

test("an empty 今天 stays empty instead of widening on its own", async () => {
  const shim = createReactShim();
  await withWindow(async () => {
    const { exports } = await loadBundle(seedsFor(shim));
    // Nothing today; the newest item is two days old — inside 近 3 天, so the
    // panel *could* widen to it. It must not: the chosen window is honoured.
    const host = datedState([
      { days: 2, title: "两天前的新闻" },
      { days: 9, title: "九天前的旧闻" }
    ]);
    await withApi(markdownApi(host), async () => {
      let tree = await shim.render(shim.react.createElement(exports.RssPanel));
      pickRange(shim, tree, "今天");
      await settle();
      tree = await shim.render(shim.react.createElement(exports.RssPanel));
      const text = shim.textContent(tree);

      // The window means what it says. Widening to 近 3 天 used to make the chip
      // a liar: it read 今天 while the list showed three days.
      assert.doesNotMatch(text, /两天前的新闻/, "选了「今天」就不该出现前天的内容");
      assert.doesNotMatch(text, /九天前的旧闻/);
      assert.match(text, /今天内暂无内容，可换一个时间范围/, "空列表要说明，而不是自己换范围");

      // The choice is left exactly as the reader made it.
      const pressed = shim.findAll(tree, "button").filter((node) => node.props["aria-pressed"] === true);
      assert.deepEqual(pressed.map((node) => shim.textContent(node)), ["今天"]);

      // And the reader can widen it themselves.
      pickRange(shim, tree, "近 3 天");
      await settle();
      tree = await shim.render(shim.react.createElement(exports.RssPanel));
      assert.match(shim.textContent(tree), /两天前的新闻/, "手动换到近 3 天即可看到");
      assert.doesNotMatch(shim.textContent(tree), /九天前的旧闻/);
    });
  });
});

test("a window holding nothing at all says which window it was", async () => {
  const shim = createReactShim();
  await withWindow(async () => {
    const { exports } = await loadBundle(seedsFor(shim));
    const host = datedState([{ days: 30, title: "一个月前的旧闻" }]);
    await withApi(markdownApi(host), async () => {
      let tree = await shim.render(shim.react.createElement(exports.RssPanel));
      pickRange(shim, tree, "今天");
      await settle();
      tree = await shim.render(shim.react.createElement(exports.RssPanel));
      const text = shim.textContent(tree);

      assert.doesNotMatch(text, /一个月前的旧闻/);
      assert.match(text, /今天内暂无内容/, "要说清是哪个范围空着");
    });
  });
});

test("items with no date are counted and reported, never quietly dropped", async () => {
  const shim = createReactShim();
  await withWindow(async () => {
    const { exports } = await loadBundle(seedsFor(shim));
    const host = datedState([
      { days: 0, title: "今天的新闻" },
      { days: null, title: "没有日期的内容" }
    ]);
    await withApi(markdownApi(host), async () => {
      let tree = await shim.render(shim.react.createElement(exports.RssPanel));
      // With no window in force the undated item is simply present, and marked.
      assert.match(shim.textContent(tree), /没有日期的内容/);
      assert.match(shim.textContent(tree), /无日期/, "没有日期的条目要带徽标");

      pickRange(shim, tree, "今天");
      await settle();
      tree = await shim.render(shim.react.createElement(exports.RssPanel));
      const text = shim.textContent(tree);

      // It cannot be placed in a window, so it is excluded — but the reader is
      // told how many were left out, or the gap becomes untrustworthy.
      assert.doesNotMatch(text, /没有日期的内容/);
      assert.match(text, /1 条内容没有发布日期，未计入当前时间范围/);
    });
  });
});

test("the today / older boundary is marked, so a window change is visible", async () => {
  const shim = createReactShim();
  await withWindow(async () => {
    const { exports } = await loadBundle(seedsFor(shim));
    // Enough rows on both sides that the cut lands below the fold. This is the
    // shape that made the filter look broken: the stream is newest-first, so
    // with a full day of news the rows above the boundary are identical under
    // every window, and nothing on screen moves when the window changes.
    const host = datedState([
      ...Array.from({ length: 8 }, (_, i) => ({ days: 0, title: `今天的第${i + 1}条` })),
      ...Array.from({ length: 8 }, (_, i) => ({ days: 3 + i, title: `更早的第${i + 1}条` }))
    ]);
    await withApi(markdownApi(host), async () => {
      let tree = await shim.render(shim.react.createElement(exports.RssPanel));

      // The boundary states how much of the list is today, which is the fact the
      // filter acts on.
      assert.match(shim.textContent(tree), /今天到此为止（8 条）· 以下为更早的内容/);

      // It sits between the two groups, and both groups are present.
      const titles = shim.findAll(tree, "button")
        .map((node) => shim.textContent(node))
        .filter((text) => /^(今天的|更早的)第/.test(text));
      assert.equal(titles.length, 16, "two groups of eight should render");
      assert.equal(titles.findIndex((text) => text.startsWith("更早的")), 8,
        "分界线之前应当正好是今天的 8 条");

      // Choosing 今天 now has a visible consequence: the boundary goes away,
      // because everything below it has been cut.
      pickRange(shim, tree, "今天");
      await settle();
      tree = await shim.render(shim.react.createElement(exports.RssPanel));
      assert.doesNotMatch(shim.textContent(tree), /今天到此为止/,
        "窗口已把更早的内容排除，分界线就没有意义了");
      assert.match(shim.textContent(tree), /今天的第8条/);
      assert.doesNotMatch(shim.textContent(tree), /更早的第1条/);
    });
  });
});

test("feed badges count the window in force, not the whole feed", async () => {
  const shim = createReactShim();
  await withWindow(async () => {
    const { exports } = await loadBundle(seedsFor(shim));
    // One feed with three unread from today and six older ones — the shape that
    // made the badges contradict the header: 今天 read 3 while the chip said 9.
    const host = datedState([
      { days: 0, title: "今天 A" },
      { days: 0, title: "今天 B" },
      { days: 0, title: "今天 C" },
      ...Array.from({ length: 6 }, (_, i) => ({ days: 4 + i, title: `更早的第${i + 1}条` }))
    ]);
    await withApi(markdownApi(host), async () => {
      const feedChip = (tree) => shim.findAll(tree, "button")
        .find((node) => shim.textContent(node).includes("示例订阅源"));
      const badgeOf = (tree) => shim.findAll(feedChip(tree), "span")
        .map((node) => shim.textContent(node))
        .find((text) => /^\d+$/.test(text));

      // No window: the feed badge states the feed's whole unread count.
      let tree = await shim.render(shim.react.createElement(exports.RssPanel));
      assert.equal(badgeOf(tree), "9");
      assert.match(shim.textContent(tree), /今天 3 条未读 · 更早 6 条未读/);

      // Under 今天 the badge has to follow, or it contradicts both the header
      // and the stream below it.
      pickRange(shim, tree, "今天");
      await settle();
      tree = await shim.render(shim.react.createElement(exports.RssPanel));
      assert.equal(badgeOf(tree), "3", "标签应显示该时间范围内的未读数");
      assert.match(shim.textContent(tree), /今天 3 条未读/);
      assert.doesNotMatch(shim.textContent(tree), /更早 6 条未读/,
        "已选定时间范围时，只报该范围的数量");

      // The window is scoped by time only: selecting the feed must not change
      // what its own chip says.
      selectFeedIn(shim, tree, "示例订阅源");
      await settle();
      tree = await shim.render(shim.react.createElement(exports.RssPanel));
      assert.equal(badgeOf(tree), "3", "选中该源不应改变它自己的标签");
    });
  });
});

test("a stream that is entirely today has no boundary to draw", async () => {
  const shim = createReactShim();
  await withWindow(async () => {
    const { exports } = await loadBundle(seedsFor(shim));
    const host = datedState([
      { days: 0, title: "今天 A" },
      { days: 0, title: "今天 B" }
    ]);
    await withApi(markdownApi(host), async () => {
      const tree = await shim.render(shim.react.createElement(exports.RssPanel));
      // A boundary with nothing below it would be a line dividing nothing.
      assert.doesNotMatch(shim.textContent(tree), /今天到此为止/);
    });
  });
});

test("the header splits unread into today and the older backlog", async () => {
  const shim = createReactShim();
  await withWindow(async () => {
    const { exports } = await loadBundle(seedsFor(shim));
    const host = datedState([
      { days: 0, title: "今天 A" },
      { days: 0, title: "今天 B" },
      { days: 5, title: "更早 C" },
      { days: 6, title: "更早 D" },
      { days: 7, title: "更早 E" }
    ]);
    await withApi(markdownApi(host), async () => {
      const tree = await shim.render(shim.react.createElement(exports.RssPanel));
      // One number cannot be acted on; splitting it is the whole point.
      assert.match(shim.textContent(tree), /今天 2 条未读 · 更早 3 条未读/);
    });
  });
});

test("the narrow panel picks a window from a select instead of four chips", async () => {
  const shim = createReactShim();
  await withWindow(async () => {
    const { exports } = await loadBundle(seedsFor(shim));
    const host = datedState([
      { days: 0, title: "今天的新闻" },
      { days: 5, title: "五天前的旧闻" }
    ]);
    await withApi(panelPrefsApi(host, {}), async () => {
      const render = () => shim.render(shim.react.createElement(exports.RssPanel, { variant: "sidebar" }));
      let tree = await render();

      const select = shim.findAll(tree, "select").find((node) => node.props["aria-label"] === "时间范围");
      assert.ok(select !== undefined, "窄栏应有时间范围选择器");
      assert.deepEqual(shim.findAll(select, "option").map((node) => node.props.value),
        ["all", "today", "3d", "7d"]);
      assert.equal(select.props.value, "all", "默认仍是全部");
      // Four chips would not fit the column; the select is the whole control.
      assert.equal(shim.findAll(tree, "button").find((node) => shim.textContent(node) === "今天"), undefined);

      select.props.onChange({ target: { value: "today" } });
      await settle();
      tree = await render();
      const text = shim.textContent(tree);
      assert.match(text, /今天的新闻/);
      assert.doesNotMatch(text, /五天前的旧闻/);
    });
  });
});

