/**
 * dsh-rss-reader — host plugin load test.
 *
 * Proves the Node half is a valid Cordis plugin: it exports the shape the
 * loader requires, its config schema accepts partial input, and `apply()`
 * registers the tool, command, prompt section, and HTTP routes against a
 * context double — without a live harness or any network access.
 */

import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

import { Config, apply, name, renderDigest } from "../lib/index.js";
import { API_PREFIX } from "../lib/api.js";

const scratchDirs = [];
after(async () => {
  for (const dir of scratchDirs) await rm(dir, { recursive: true, force: true });
});

async function scratchFile() {
  const dir = await mkdtemp(join(tmpdir(), "rss-reader-host-"));
  scratchDirs.push(dir);
  return join(dir, "feeds.json");
}

/**
 * A harness context double that records everything the plugin registers.
 *
 * Cordis refuses a bare property read of a service that the plugin did not
 * declare through `inject` — reading `ctx.tools` before injecting `"tools"`
 * throws "cannot get property ... without inject". The double reproduces that
 * rule, because a permissive double would happily accept the broken form and
 * let it fail only in a real profile boot.
 *
 * @returns {object} the context and its recordings.
 */
function makeCtx() {
  const tools = [];
  const commands = [];
  const sections = [];
  const routes = [];
  const effects = [];
  const warnings = [];
  const injected = [];

  const ctx = {
    _injected: injected,
    effect(callback) {
      const dispose = callback();
      effects.push(dispose);
      return dispose;
    },
    inject(services, callback) {
      for (const service of services) injected.push(service);
      // A real fiber narrows the context to the injected services; the double
      // hands back the same object, now with those services marked available.
      callback(ctx);
    },
    // The real context offers `get` for optional capabilities. Returning
    // `undefined` for anything not mounted is what a profile without the
    // session controller looks like, and that path must stay exercised.
    get(name) {
      const value = optionalServices.get(name);
      return value;
    },
    logger: { warn: (message) => warnings.push(message) }
  };

  /** Services reachable through `ctx.get` rather than an injection. */
  const optionalServices = new Map();

  /** Attach a service behind an inject-declaration check. */
  const provide = (name, value) => {
    Object.defineProperty(ctx, name, {
      enumerable: true,
      // A test may replace a service with a double of its own (a recording LLM,
      // a registry with different providers) after the ctx is built.
      configurable: true,
      get() {
        if (!injected.includes(name)) {
          throw new Error(`cannot get property "${name}" without inject`);
        }
        return value;
      }
    });
  };

  provide("tools", { register: (tool) => tools.push(tool) });
  provide("commands", { register: (command) => commands.push(command) });
  provide("systemPrompt", { section: (section) => sections.push(section) });
  provide("webServer", {
    register: (route) => {
      routes.push(route);
      return () => {};
    }
  });
  // The LLM route is optional in the harness: a profile may mount the reader
  // with no model at all. `available: false` exercises that path.
  provide("llm", {
    stream() {
      return (async function* generate() {
        yield { type: "finish", reason: { kind: "stop" } };
      })();
    }
  });
  provide("agentDefaultModel", {
    currentSelection: () => ({ provider: "test-provider", model: "test-model" })
  });

  return { ctx, tools, commands, sections, routes, effects, warnings, injected, optionalServices, provide };
}

/**
 * Run one route against a request double and parse its JSON body.
 *
 * @param {object} route - a route descriptor from `createRoutes`.
 * @param {object} options - `{method, url, body}`.
 * @returns {Promise<{status: number, body: object}>} the response.
 */
async function requestJson(route, { method = "GET", url, body } = {}) {
  const chunks = body === undefined ? [] : [Buffer.from(JSON.stringify(body), "utf8")];
  let status = 0;
  let payload = "";
  await route.handler(
    {
      method,
      url: url ?? route.path,
      headers: { host: "127.0.0.1:3080", origin: "http://127.0.0.1:3080", "sec-fetch-site": "same-origin" },
      socket: { remoteAddress: "127.0.0.1" },
      async *[Symbol.asyncIterator]() {
        for (const chunk of chunks) yield chunk;
      }
    },
    {
      writeHead(code) {
        status = code;
        return this;
      },
      end(text) {
        payload = text ?? "";
      }
    }
  );
  return { status, body: payload.length > 0 ? JSON.parse(payload) : undefined };
}

/**
 * Run one GET route against a request double and parse its JSON body.
 *
 * @param {object} route - a route descriptor from `createRoutes`.
 * @param {string} url - the request URL.
 * @returns {Promise<object>} the parsed response body.
 */
async function getJson(route, url) {
  const res = await requestJson(route, { url });
  return res.body;
}

/** Config with a temporary store path so tests never touch the real home. */
async function testConfig(overrides = {}) {
  return Config({
    storeFile: await scratchFile(),
    tool: true,
    webApi: true,
    refreshMinutes: 0,
    ...overrides
  });
}

test("the plugin exports the identity and inject list the loader expects", () => {
  assert.equal(name, "rss-reader");
});

test("the config schema applies defaults to an empty object", () => {
  const config = Config({});
  assert.equal(config.timeoutMs, 20000);
  assert.equal(config.concurrency, 4);
  assert.equal(config.maxItemsPerFeed, 100);
  assert.equal(config.maxFeeds, 200);
  assert.equal(config.tool, true);
  assert.equal(config.webApi, true);
  // Background refresh is opt-in: an unexpected timer would be a surprise.
  assert.equal(config.refreshMinutes, 0);
});

test("the RSSHub switches and cache windows have defaults", () => {
  const defaults = Config({});
  assert.equal(defaults.rsshub, true);
  assert.equal(defaults.rsshubExplore, true);
  assert.equal(defaults.rsshubBase, "");
  assert.ok(defaults.rsshubCacheMinutes >= 1);
  // The registry is a multi-megabyte document, so its cache outlives the rules'.
  assert.ok(defaults.rsshubCatalogMinutes > defaults.rsshubCacheMinutes);
  assert.throws(() => Config({ rsshubCatalogMinutes: 0 }), /rsshubCatalogMinutes/);
});

test("the config schema rejects out-of-range values", () => {
  assert.throws(() => Config({ timeoutMs: 10 }), /timeoutMs/);
  assert.throws(() => Config({ concurrency: 0 }), /concurrency/);
  assert.throws(() => Config({ refreshMinutes: -1 }), /refreshMinutes/);
});

test("translation defaults are set and can be overridden", () => {
  const defaults = Config({});
  assert.equal(defaults.translate, true);
  assert.equal(defaults.translateTarget, "zh-CN");
  // An empty route means "reuse whatever model the session uses".
  assert.equal(defaults.translateProvider, "");
  assert.equal(defaults.translateModel, "");
  assert.ok(defaults.translateTimeoutMs > 0);
  assert.ok(defaults.translateMaxTokens >= 256);

  const custom = Config({ translateTarget: "en", translateProvider: "p", translateModel: "m", translateMaxTokens: 999 });
  assert.equal(custom.translateTarget, "en");
  assert.equal(custom.translateProvider, "p");
  assert.equal(custom.translateModel, "m");
  assert.equal(custom.translateMaxTokens, 999);
  assert.throws(() => Config({ translateTimeoutMs: 10 }), /translateTimeoutMs/);
});

test("the translate route reports availability through the LLM service", async () => {
  const harness = makeCtx();
  apply(harness.ctx, await testConfig());
  const route = harness.routes.find((candidate) => candidate.path.endsWith("/translate"));
  assert.ok(route !== undefined, "the translate route should be registered");

  let status = 0;
  let payload = "";
  await route.handler(
    {
      method: "GET",
      url: "/api/rss-reader/translate",
      headers: { host: "127.0.0.1:3080", origin: "http://127.0.0.1:3080", "sec-fetch-site": "same-origin" },
      socket: { remoteAddress: "127.0.0.1" },
      async *[Symbol.asyncIterator]() {}
    },
    { writeHead(code) { status = code; return this; }, end(text) { payload = text ?? ""; } }
  );
  assert.equal(status, 200);
  const body = JSON.parse(payload);
  // The session's default model is reused when no explicit route is configured.
  assert.equal(body.available, true);
  assert.equal(body.provider, "test-provider");
  assert.equal(body.model, "test-model");
  assert.ok(Object.keys(body.targets).length > 0, "the UI needs the target list");
});

test("an explicit translate route overrides the session default", async () => {
  const harness = makeCtx();
  apply(harness.ctx, await testConfig({ translateProvider: "explicit-p", translateModel: "explicit-m" }));
  const route = harness.routes.find((candidate) => candidate.path.endsWith("/translate"));
  let payload = "";
  await route.handler(
    {
      method: "GET",
      url: "/api/rss-reader/translate",
      headers: { host: "127.0.0.1:3080", origin: "http://127.0.0.1:3080", "sec-fetch-site": "same-origin" },
      socket: { remoteAddress: "127.0.0.1" },
      async *[Symbol.asyncIterator]() {}
    },
    { writeHead() { return this; }, end(text) { payload = text ?? ""; } }
  );
  const body = JSON.parse(payload);
  assert.equal(body.provider, "explicit-p");
  assert.equal(body.model, "explicit-m");
});

test("RSSHub discovery defaults are set and can be overridden", () => {
  const defaults = Config({});
  assert.equal(defaults.rsshub, true);
  // Empty means "use the official public instance".
  assert.equal(defaults.rsshubBase, "");
  assert.ok(defaults.rsshubTimeoutMs > 0);
  assert.ok(defaults.rsshubCacheMinutes >= 1);

  const custom = Config({ rsshubBase: "https://rsshub.example.com/", rsshub: false, rsshubCacheMinutes: 30 });
  assert.equal(custom.rsshub, false);
  assert.equal(custom.rsshubBase, "https://rsshub.example.com/");
  assert.equal(custom.rsshubCacheMinutes, 30);
  assert.throws(() => Config({ rsshubTimeoutMs: 10 }), /rsshubTimeoutMs/);
  assert.throws(() => Config({ rsshubCacheMinutes: 0 }), /rsshubCacheMinutes/);
});

test("RSSHub discovery is wired into the API with the configured instance", async () => {
  const harness = makeCtx();
  apply(harness.ctx, await testConfig({ rsshubBase: "https://rsshub.example.com/" }));
  const route = harness.routes.find((candidate) => candidate.path.endsWith("/rsshub"));
  assert.ok(route !== undefined, "the RSSHub status route should be registered");
  const body = await getJson(route, "/api/rss-reader/rsshub");
  assert.equal(body.enabled, true);
  // The configured base is normalized (no trailing slash).
  assert.equal(body.base, "https://rsshub.example.com");
});

test("PATCH /prefs retargets the RSSHub clients without a restart", async () => {
  const harness = makeCtx();
  apply(harness.ctx, await testConfig());
  const prefs = harness.routes.find((route) => route.path.endsWith("/prefs"));
  const hub = harness.routes.find((route) => route.path.endsWith("/rsshub"));

  const before = await getJson(hub, "/api/rss-reader/rsshub");
  assert.equal(before.base, "https://rsshub.app", "the configured default to start with");
  assert.equal(before.explore, true);

  const moved = await requestJson(prefs, { method: "PATCH", body: { rsshubBase: "https://mirror.test/" } });
  assert.equal(moved.status, 200);
  assert.equal(moved.body.prefs.rsshubBase, "https://mirror.test", "the address is normalized");
  assert.deepEqual(moved.body.stored, ["rsshubBase"]);

  // The point of the setting: the client the features actually use moves with
  // it, in the same request — no restart, no stale instance.
  const after = await getJson(hub, "/api/rss-reader/rsshub");
  assert.equal(after.base, "https://mirror.test");

  // A typo is refused, and the working instance stays where it was.
  const bogus = await requestJson(prefs, { method: "PATCH", body: { rsshubBase: "nope" } });
  assert.equal(bogus.status, 400);
  assert.match(bogus.body.error, /实例地址不可用/);
  assert.equal((await getJson(hub, "/api/rss-reader/rsshub")).base, "https://mirror.test");

  // Clearing it goes back to the plugin config's default, and stores nothing.
  const cleared = await requestJson(prefs, { method: "PATCH", body: { rsshubBase: "" } });
  assert.equal(cleared.status, 200);
  assert.equal(cleared.body.prefs.rsshubBase, "https://rsshub.app");
  assert.deepEqual(cleared.body.stored, [], "a cleared preference is not stored");
  assert.equal((await getJson(hub, "/api/rss-reader/rsshub")).base, "https://rsshub.app");
});

test("the instance preference is refused when it is not an address at all", async () => {
  const harness = makeCtx();
  apply(harness.ctx, await testConfig());
  const prefs = harness.routes.find((route) => route.path.endsWith("/prefs"));

  const wrongType = await requestJson(prefs, { method: "PATCH", body: { rsshubBase: 42 } });
  assert.equal(wrongType.status, 400);
  assert.match(wrongType.body.error, /must be a string/);

  const tooLong = await requestJson(prefs, { method: "PATCH", body: { rsshubBase: `https://${"a".repeat(400)}.test` } });
  assert.equal(tooLong.status, 400);
  assert.match(tooLong.body.error, /at most/);

  // Nothing was stored along the way.
  const read = await getJson(prefs, "/api/rss-reader/prefs");
  assert.deepEqual(read.stored, []);
  assert.equal(read.prefs.rsshubBase, "https://rsshub.app");
});

test("a stored instance URL is adopted once the store has been read", async () => {
  // The preference lives in the file, which is read asynchronously — the clients
  // must catch up, or the panel would show one host and fetch from another.
  const storeFile = await scratchFile();
  await writeFile(storeFile, JSON.stringify({
    version: 1,
    prefs: { rsshubBase: "https://stored.test" },
    feeds: []
  }), "utf8");

  const harness = makeCtx();
  apply(harness.ctx, Config({ storeFile, refreshMinutes: 0, tool: false }));
  const hub = harness.routes.find((route) => route.path.endsWith("/rsshub"));
  await new Promise((resolve) => setTimeout(resolve, 30));
  const info = await getJson(hub, "/api/rss-reader/rsshub");
  assert.equal(info.base, "https://stored.test");
});

test("a malformed RSSHub base disables discovery instead of failing the plugin", async () => {
  // An optional feature's typo must not take the whole reader down at boot.
  const harness = makeCtx();
  apply(harness.ctx, await testConfig({ rsshubBase: "not a url" }));
  const route = harness.routes.find((candidate) => candidate.path.endsWith("/rsshub"));
  const body = await getJson(route, "/api/rss-reader/rsshub");
  assert.equal(body.enabled, false, "discovery is off rather than the plugin failing");
  // Everything else still loaded, so the reader works normally.
  assert.equal(harness.routes.length, 15);
  assert.equal(harness.tools.length, 1);
  assert.ok(
    harness.warnings.some((message) => /RSSHub discovery disabled/.test(message)),
    "and the reason is logged"
  );
});

test("the route in force follows the reader's choice, then config, then the session default", async () => {
  const harness = makeCtx();
  let captured;
  harness.provide("llm", {
    stream(options) {
      captured = options;
      return (async function* generate() {
        const body = '{"title":"t","markdown":"m"}';
        yield { type: "block-start", index: 0, blockType: "text" };
        yield { type: "text-delta", index: 0, text: body };
        yield { type: "block-end", index: 0, block: { type: "text", text: body } };
        yield { type: "finish", reason: { kind: "stop" } };
      })();
    }
  });

  // One stored subscription with one item, so the POST has something to translate.
  const storeFile = await scratchFile();
  await writeFile(storeFile, JSON.stringify({
    version: 1,
    feeds: [{
      id: "f1",
      url: "https://s.test/feed",
      title: "F",
      items: [{ id: "i1", title: "T", link: "https://s.test/1", markdown: "body", read: false, starred: false }]
    }]
  }), "utf8");
  apply(harness.ctx, Config({ storeFile, tool: false, refreshMinutes: 0 }));

  const translate = harness.routes.find((route) => route.path.endsWith("/translate"));
  const prefs = harness.routes.find((route) => route.path.endsWith("/prefs"));

  /** Translate the seeded item and report the model call it produced. */
  const call = async () => {
    captured = undefined;
    const res = await requestJson(translate, {
      method: "POST",
      body: { feedId: "f1", itemId: "i1", force: true }
    });
    assert.equal(res.status, 200, `translation should succeed: ${JSON.stringify(res.body)}`);
    return captured;
  };

  // Nothing configured and nothing chosen: the session's default model, and no
  // explicit intensity, so the adapter's own default applies.
  const session = await call();
  assert.equal(session.provider, "test-provider");
  assert.equal(session.model, "test-model");
  assert.equal("reasoningEffort" in session, false);

  // The settings page writes both selects in one go; the host must adopt the
  // pair without a restart.
  await requestJson(prefs, {
    method: "PATCH",
    body: { translateProvider: "ui-prov", translateModel: "ui-mod" }
  });
  const chosen = await call();
  assert.equal(chosen.provider, "ui-prov");
  assert.equal(chosen.model, "ui-mod");

  // The intensity is separate: it can be set without touching the pair.
  await requestJson(prefs, { method: "PATCH", body: { translateEffort: "low" } });
  const withEffort = await call();
  assert.equal(withEffort.provider, "ui-prov");
  assert.equal(withEffort.model, "ui-mod");
  assert.equal(withEffort.reasoningEffort, "low");

  // Clearing the choice hands the route back to the session default.
  await requestJson(prefs, { method: "PATCH", body: { translateProvider: "", translateModel: "", translateEffort: "" } });
  const cleared = await call();
  assert.equal(cleared.provider, "test-provider");
  assert.equal(cleared.model, "test-model");
  assert.equal("reasoningEffort" in cleared, false);
});

test("a configured route is the default the reader overrides", async () => {
  // The plugin config supplies the default; the reader's choice is what wins
  // once it exists. Both have to be visible through the same route.
  const harness = makeCtx();
  let captured;
  harness.provide("llm", {
    stream(options) {
      captured = options;
      return (async function* generate() {
        const body = '{"title":"t","markdown":"m"}';
        yield { type: "block-start", index: 0, blockType: "text" };
        yield { type: "text-delta", index: 0, text: body };
        yield { type: "block-end", index: 0, block: { type: "text", text: body } };
        yield { type: "finish", reason: { kind: "stop" } };
      })();
    }
  });
  const storeFile = await scratchFile();
  await writeFile(storeFile, JSON.stringify({
    version: 1,
    feeds: [{
      id: "f1",
      url: "https://s.test/feed",
      title: "F",
      items: [{ id: "i1", title: "T", link: "https://s.test/1", markdown: "body", read: false, starred: false }]
    }]
  }), "utf8");
  apply(harness.ctx, Config({
    storeFile,
    tool: false,
    refreshMinutes: 0,
    translateProvider: "cfg-prov",
    translateModel: "cfg-mod",
    translateEffort: "high"
  }));
  const translate = harness.routes.find((route) => route.path.endsWith("/translate"));
  const prefs = harness.routes.find((route) => route.path.endsWith("/prefs"));

  const call = async () => {
    captured = undefined;
    const res = await requestJson(translate, {
      method: "POST",
      body: { feedId: "f1", itemId: "i1", force: true }
    });
    assert.equal(res.status, 200, `translation should succeed: ${JSON.stringify(res.body)}`);
    return captured;
  };

  const fromConfig = await call();
  assert.equal(fromConfig.provider, "cfg-prov");
  assert.equal(fromConfig.model, "cfg-mod");
  assert.equal(fromConfig.reasoningEffort, "high");

  await requestJson(prefs, { method: "PATCH", body: { translateProvider: "ui-prov", translateModel: "ui-mod" } });
  const overridden = await call();
  assert.equal(overridden.provider, "ui-prov");
  assert.equal(overridden.model, "ui-mod");
  // An intensity the reader never chose keeps following the config.
  assert.equal(overridden.reasoningEffort, "high");

  await requestJson(prefs, { method: "PATCH", body: { translateProvider: "", translateModel: "" } });
  const back = await call();
  assert.equal(back.provider, "cfg-prov");
  assert.equal(back.model, "cfg-mod");
});

test("GET /models prefers the harness catalogue and falls back to the raw registry", async () => {
  // With the session controller mounted, its projection is authoritative: it is
  // what carries each model's selectable thinking intensities.
  const withController = makeCtx();
  withController.optionalServices.set("sessionController", {
    async modelCatalog() {
      return {
        default: { provider: "p", model: "m" },
        routableProviders: ["p"],
        groups: [{ id: "p", name: "P", models: [{ id: "m", name: "M", reasoning: { efforts: [{ id: "low", name: "Low" }] } }] }],
        failures: []
      };
    }
  });
  apply(withController.ctx, await testConfig());
  const modelsRoute = withController.routes.find((route) => route.path.endsWith("/models"));
  const withCatalog = await getJson(modelsRoute, "/api/rss-reader/models");
  assert.deepEqual(withCatalog.catalog.groups[0].models[0].reasoning.efforts.map((e) => e.id), ["low"]);

  // Without it, the plugin still has to offer something usable.
  const bare = makeCtx();
  bare.provide("llm", {
    listProviders: () => [{ id: "raw", name: "Raw" }],
    async listModels() { return [{ id: "raw-mod", name: "Raw Mod" }]; },
    stream() { return (async function* generate() { yield { type: "finish", reason: { kind: "stop" } }; })(); }
  });
  apply(bare.ctx, await testConfig());
  const bareRoute = bare.routes.find((route) => route.path.endsWith("/models"));
  const fallback = await getJson(bareRoute, "/api/rss-reader/models");
  assert.deepEqual(fallback.catalog.groups, [{ id: "raw", name: "Raw", models: [{ id: "raw-mod", name: "Raw Mod" }] }]);
  assert.deepEqual(fallback.catalog.routableProviders, ["raw"]);
});

test("translation can be switched off entirely", async () => {  const harness = makeCtx();
  apply(harness.ctx, await testConfig({ translate: false }));
  const route = harness.routes.find((candidate) => candidate.path.endsWith("/translate"));
  let payload = "";
  await route.handler(
    {
      method: "GET",
      url: "/api/rss-reader/translate",
      headers: { host: "127.0.0.1:3080", origin: "http://127.0.0.1:3080", "sec-fetch-site": "same-origin" },
      socket: { remoteAddress: "127.0.0.1" },
      async *[Symbol.asyncIterator]() {}
    },
    { writeHead() { return this; }, end(text) { payload = text ?? ""; } }
  );
  const body = JSON.parse(payload);
  assert.equal(body.available, false, "the UI must be told so it can hide the action");
  assert.match(body.reason, /disabled/);
});

test("apply registers the tool, command, prompt section, and API routes", async () => {
  const harness = makeCtx();
  apply(harness.ctx, await testConfig());

  const tool = harness.tools.find((candidate) => candidate.name === "rss_read");
  assert.ok(tool !== undefined, "the rss_read tool should be registered");
  assert.equal(typeof tool.execute, "function");
  assert.match(tool.description, /RSS/);

  const command = harness.commands.find((candidate) => candidate.name === "rss");
  assert.ok(command !== undefined, "the /rss command should be registered");
  assert.equal(typeof command.handler, "function");

  assert.ok(harness.sections.some((section) => section.name === "rss-reader"), "the prompt hint should be registered");

  assert.equal(harness.routes.length, 15, `expected 15 API routes, saw ${harness.routes.length}`);
  for (const route of harness.routes) {
    assert.ok(route.path.startsWith(API_PREFIX), `${route.path} escapes the API prefix`);
    assert.equal(typeof route.handler, "function");
  }
  const paths = harness.routes.map((route) => route.path).sort();
  assert.deepEqual(paths, [
    `${API_PREFIX}/discover`,
    `${API_PREFIX}/explore`,
    `${API_PREFIX}/explore/url`,
    `${API_PREFIX}/feeds`,
    `${API_PREFIX}/feeds/order`,
    `${API_PREFIX}/health`,
    `${API_PREFIX}/history`,
    `${API_PREFIX}/item`,
    `${API_PREFIX}/items`,
    `${API_PREFIX}/models`,
    `${API_PREFIX}/prefs`,
    `${API_PREFIX}/refresh`,
    `${API_PREFIX}/rsshub`,
    `${API_PREFIX}/state`,
    `${API_PREFIX}/translate`
  ]);
});

test("apply honours the tool and webApi switches", async () => {
  const harness = makeCtx();
  apply(harness.ctx, await testConfig({ tool: false, webApi: false }));
  assert.equal(harness.tools.length, 0, "the tool must not register when disabled");
  assert.equal(harness.sections.length, 0, "the prompt hint follows the tool switch");
  assert.equal(harness.routes.length, 0, "the API must not register when disabled");
  // The command stays available regardless: it is the always-present entry.
  assert.equal(harness.commands.length, 1);
});

test("the tool reports an empty subscription list without touching the network", async () => {
  const harness = makeCtx();
  apply(harness.ctx, await testConfig());
  const tool = harness.tools[0];

  const result = await tool.execute({}, { agent: undefined, signal: undefined });
  assert.equal(result.feeds, 0);
  assert.equal(result.unread, 0);
  assert.deepEqual(result.items, []);
  assert.match(result.text, /No RSS feeds are subscribed/);
});

test("the /rss command reports an empty subscription list as success", async () => {
  const harness = makeCtx();
  apply(harness.ctx, await testConfig());
  const result = await harness.commands[0].handler({ rawInput: "" });
  assert.equal(result.kind, "success");
  assert.match(result.text, /No RSS feeds are subscribed/);
});

test("the tool schema and output schema are well formed", async () => {
  const harness = makeCtx();
  apply(harness.ctx, await testConfig());
  const tool = harness.tools[0];

  // defineTool normalizes the authored name -> spec map into a JSON Schema.
  assert.equal(tool.parameters.type, "object");
  const properties = tool.parameters.properties;
  for (const [key, spec] of Object.entries(properties)) {
    assert.ok(
      ["string", "integer", "boolean", "number", "array", "object"].includes(spec.type),
      `parameter ${key} has unsupported type ${spec.type}`
    );
    assert.equal(typeof spec.description, "string", `parameter ${key} needs a description`);
  }
  assert.deepEqual(Object.keys(properties).sort(), ["feedId", "limit", "refresh", "unreadOnly"]);

  // The output schema is object-rooted with every declared property required:
  // a value the schema does not describe would be dropped at the boundary.
  const schema = tool.output.schema;
  assert.equal(schema.type, "object");
  assert.equal(schema.additionalProperties, false);
  assert.deepEqual([...schema.required].sort(), ["feeds", "items", "text", "unread"]);
  assert.deepEqual(Object.keys(schema.properties).sort(), ["feeds", "items", "text", "unread"]);

  // Nested item objects must be closed and fully required too.
  const itemSchema = schema.properties.items.items;
  assert.equal(itemSchema.type, "object");
  assert.equal(itemSchema.additionalProperties, false);
  assert.deepEqual(
    [...itemSchema.required].sort(),
    ["author", "date", "feedId", "feedTitle", "link", "read", "starred", "summary", "title"]
  );
  assert.equal(typeof tool.output.render, "function");
});

test("presentCall marks the call read-only", async () => {
  const harness = makeCtx();
  apply(harness.ctx, await testConfig());
  const tool = harness.tools[0];
  const presentation = tool.presentCall({ limit: 5 });
  assert.equal(presentation.card, "generic");
  assert.equal(presentation.kind, "read");
});

test("apply declares every service it touches through inject", async () => {
  // Regression: reading `ctx.tools` directly threw
  // "cannot get property "tools" without inject" and failed the whole plugin
  // tree at boot, so nothing mounted at all. The double enforces the same rule.
  const harness = makeCtx();
  assert.doesNotThrow(() => apply(harness.ctx, Config({
    storeFile: "x.json",
    tool: true,
    webApi: true,
    refreshMinutes: 0
  })));

  // Every service the plugin actually used must have been injected first.
  for (const service of ["tools", "commands", "systemPrompt", "webServer", "llm"]) {
    assert.ok(
      harness.injected.includes(service),
      `the plugin used ctx.${service} without injecting "${service}"`
    );
  }
});

test("the config schema is exported for the loader to validate against", async () => {
  // The loader reads `Config` off the module; a partial config must be accepted
  // so a profile can mount the plugin with no config block at all.
  const harness = makeCtx();
  assert.doesNotThrow(() => apply(harness.ctx, Config({ storeFile: "x.json" })));
});

test("renderDigest is exported for reuse and reports totals", () => {
  const digest = renderDigest({ feeds: [], groups: [], totals: { feeds: 0, items: 0, unread: 0, lastFetched: "" } });
  assert.match(digest.text, /No RSS feeds are subscribed/);
});
