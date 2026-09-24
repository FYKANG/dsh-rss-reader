/**
 * Validates the client bundle exactly as SERVED by a running dsh web instance.
 *
 * The unit tests exercise the repository copy; this checks the artifact a real
 * boot actually hands the browser (combo-wrapped, possibly renamed), so a
 * serving-layer problem cannot hide behind a passing source-level test.
 *
 * Usage: node scripts/verify-served-bundle.mjs <path-to-served-client.js>
 */

import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const target = process.argv[2];
if (target === undefined) {
  process.stderr.write("usage: node scripts/verify-served-bundle.mjs <served-client.js>\n");
  process.exit(2);
}

const here = dirname(fileURLToPath(import.meta.url));
const source = await readFile(target, "utf8");
const require = createRequire(import.meta.url);

/**
 * Platform seed modules.
 *
 * React is provided by the DSH boot, not installed as a package here, so the
 * repository's test shim stands in for it. Its API surface is the same shape
 * the panel uses, which is what this check depends on.
 */
const { createReactShim } = await import(pathToFileURL(join(here, "..", "test", "react-shim.mjs")).href);
const shim = createReactShim();
const SEEDS = {
  react: shim.react,
  "react/jsx-runtime": {
    jsx: shim.react.createElement,
    jsxs: shim.react.createElement,
    Fragment: shim.react.Fragment
  }
};

const failures = [];
const check = (label, ok, detail) => {
  if (!ok) failures.push(`${label}${detail === undefined ? "" : `: ${detail}`}`);
  process.stdout.write(`${ok ? "  ok  " : " FAIL "} ${label}${ok || detail === undefined ? "" : ` — ${detail}`}\n`);
};

// ── registration ────────────────────────────────────────────────────────────
const registration = { id: undefined };
const fakeWindow = { __ModuleLoader__: { load: (entry) => { registration.id = entry.id; registration.factory = entry.factory; } } };
const originalWindow = globalThis.window;
globalThis.window = fakeWindow;
try {
  new Function(source)();
} finally {
  if (originalWindow === undefined) delete globalThis.window;
  else globalThis.window = originalWindow;
}

check("bundle registers via window.__ModuleLoader__.load", registration.factory !== undefined);
check("bundle id matches the package name", registration.id === "dsh-rss-reader", registration.id);

// ── factory purity ──────────────────────────────────────────────────────────
const requires = [];
const exports = registration.factory((specifier) => {
  requires.push(specifier);
  if (!Object.hasOwn(SEEDS, specifier)) throw new Error(`not a platform seed: ${specifier}`);
  return SEEDS[specifier];
});

for (const specifier of requires) {
  check(`requires only seed modules (${specifier})`, Object.hasOwn(SEEDS, specifier));
}
check("exports apply()", typeof exports.apply === "function");
check("exports an inject array", Array.isArray(exports.inject), JSON.stringify(exports.inject));
check("exports the panel component", typeof exports.RssPanel === "function");

// ── slot registration ───────────────────────────────────────────────────────
const registrations = [];
const injected = [];
const tabTypes = [];
const opened = [];
const SEAT_NAMES = new Set([
  "main",
  "sidebar.panellist",
  "sidebar.right.pane.tab",
  "sidebar.footer.action",
  "settings.section"
]);
const ctx = {
  slots: {
    inject(key, factory) {
      injected.push(key);
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
  effect(execute) {
    const dispose = execute();
    return typeof dispose === "function" ? dispose : () => {};
  },
  // The right Sidebar is optional, so its face arrives through `inject`.
  inject(deps, callback) {
    callback({
      effect: (execute) => {
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
    });
    return { dispose() {} };
  }
};
// The left-Sidebar row is registered from the stored preference, so the boot
// reads `/prefs` before it registers anything. Serve that one request, so the
// check sees the layout a browser gets when the setting has never been touched.
const originalFetch = globalThis.fetch;
globalThis.fetch = async () => ({
  ok: true,
  status: 200,
  async json() {
    return { ok: true, prefs: { showSidebarEntry: true } };
  }
});
exports.apply(ctx);
try {
  await new Promise((resolve) => setTimeout(resolve, 0));
} finally {
  globalThis.fetch = originalFetch;
}

const panel = registrations.find((entry) => entry.options.name === "main");
const sidebar = registrations.find((entry) => entry.options.name === "sidebar.panellist");
check("registers a 'main' panel", panel !== undefined);
check("registers a 'sidebar.panellist' entry", sidebar !== undefined);
if (panel !== undefined && sidebar !== undefined) {
  check("sidebar id equals the panel key (the row routes to the panel)", sidebar.options.id === panel.options.key,
    `id=${sidebar.options.id} key=${panel.options.key}`);
  check("sidebar label resolves", typeof sidebar.options.label === "function" && sidebar.options.label() === "RSS");
}
const section = registrations.find((entry) => entry.options.name === "settings.section");
check("registers the RSS settings page", section !== undefined);
if (section !== undefined) {
  check("the settings page carries a nav id, label and position",
    typeof section.options.id === "string"
    && typeof section.options.label === "function"
    && typeof section.options.order === "number",
    `id=${section.options.id} order=${section.options.order}`);
  check("the nav label resolves", section.options.label().length > 0, section.options.label());
}
check("no RSS rows are left inside 通用",
  registrations.every((entry) => entry.options.name !== "settings.general.item"));

// ── right Sidebar integration ───────────────────────────────────────────────
check("registers one right Sidebar tab type", tabTypes.length === 1, String(tabTypes.length));
const definition = tabTypes[0];
if (definition !== undefined) {
  check("the tab type is a page type (no address patterns)", definition.patterns === undefined);
  check("the tab title resolves", typeof definition.title === "function" && definition.title().length > 0);
  check("the guide entry opens it", Array.isArray(definition.guide) && definition.guide.length === 1
    && typeof definition.guide[0].title === "function" && typeof definition.guide[0].order === "number");
  const body = registrations.find((entry) => entry.options.name === "sidebar.right.pane.tab");
  check("registers the tab body seat", body !== undefined);
  if (body !== undefined) {
    check("the body seat is keyed by the type id", body.options.key === definition.id,
      `key=${body.options.key} id=${definition.id}`);
  }
}
const launcher = registrations.find((entry) => entry.options.name === "sidebar.footer.action");
check("registers the footer launcher", launcher !== undefined);
if (launcher !== undefined) {
  check("the launcher has an id for the list seat", typeof launcher.options.id === "string");
}
check("injects only known slots", injected.every((key) => SEAT_NAMES.has(key)), injected.join(", "));

process.stdout.write(`\n${failures.length === 0 ? "PASS" : `FAIL (${failures.length})`}: served bundle is bootable\n`);
process.exit(failures.length === 0 ? 0 : 1);
