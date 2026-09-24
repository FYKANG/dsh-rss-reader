/**
 * dsh-rss-reader — end-to-end integration test.
 *
 * Boots the plugin's host half on a real Cordis context with the harness's own
 * `WebServer` service, then drives the HTTP API over a real loopback socket.
 * This is the layer the unit tests cannot reach: route registration against the
 * real service, real request parsing, real response serialization, and the
 * plugin's own startup effect.
 *
 * The webserver package resolves from the DSH installation rather than the
 * plugin's dependencies (the harness injects it in a real boot), so this test
 * skips cleanly when it is not resolvable.
 */

import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, test } from "node:test";

import { Service } from "@deepseek-ai/cordis";
import { Config, apply } from "../lib/index.js";
import { API_PREFIX } from "../lib/api.js";

const scratchDirs = [];
after(async () => {
  for (const dir of scratchDirs) await rm(dir, { recursive: true, force: true });
});

/**
 * Directory names a package could be resolved from.
 *
 * Deliberately spawn-free: shelling out to `npm root -g` would make the suite
 * depend on a subprocess being permitted, and on npm specifically. Each entry is
 * a directory whose `node_modules` is searched, so the layout of both a global
 * install and a Windows `%APPDATA%\npm` one is covered.
 *
 * @returns {string[]} candidate directories.
 */
function globalSearchDirs() {
  const dirs = [];
  const appData = process.env.APPDATA;
  if (typeof appData === "string" && appData.length > 0) dirs.push(join(appData, "npm", "node_modules"));
  // A Unix/macOS prefix install: <prefix>/bin/node -> <prefix>/lib/node_modules.
  dirs.push(join(dirname(process.execPath), "..", "lib", "node_modules"));
  dirs.push("/usr/local/lib/node_modules", "/usr/lib/node_modules");
  // The harness is built from packages in its own tree, so look there too.
  for (const root of [...dirs]) {
    const dshDir = join(root, "@deepseek-ai", "dsh");
    if (existsSync(dshDir)) dirs.push(join(dshDir, "node_modules"));
  }
  return [...new Set(dirs)];
}

/**
 * Resolve the harness's webserver package.
 * @returns {Promise<object | null>} the module, or null when unavailable.
 */
async function loadWebServer() {
  try {
    return await import("@deepseek-ai/dsh-host-webserver");
  } catch {
    // Fall back to the DSH installation's own dependency tree, located from the
    // environment rather than a hard-coded path — a fixed absolute path made
    // this test pass on exactly one machine.
    try {
      const { createRequire } = await import("node:module");
      const { pathToFileURL } = await import("node:url");
      const require = createRequire(import.meta.url);
      const dirs = globalSearchDirs().filter((dir) => existsSync(dir));
      for (const dir of dirs) {
        try {
          const resolved = require.resolve("@deepseek-ai/dsh-host-webserver", { paths: [dir] });
          return await import(pathToFileURL(resolved).href);
        } catch {
          // Try the next candidate location.
        }
      }
      return null;
    } catch {
      return null;
    }
  }
}

/**
 * A minimal service registry standing in for the Cordis root context.
 *
 * `Service` instances need a real context to register against; this provides
 * the `reflect.provide` / `get` contract the webserver's constructor uses, plus
 * the `effect` and `inject` helpers the plugin calls.
 */
function makeContext() {
  const services = new Map();
  const effects = [];
  const ctx = {
    services,
    effects,
    reflect: {
      provide(name, value) {
        services.set(name, value);
        return () => services.delete(name);
      },
      get(name) {
        return services.get(name);
      }
    },
    get(name) {
      return services.get(name);
    },
    effect(callback) {
      const dispose = callback();
      effects.push(dispose);
      return dispose;
    },
    inject(names, callback) {
      callback(ctx);
    },
    on() {
      return () => {};
    },
    logger: { warn() {} }
  };
  return ctx;
}

/**
 * A context double recording the plugin's registrations.
 *
 * Like the host test's double, this enforces Cordis's inject rule: a bare read
 * of an undeclared service throws, so the plugin cannot pass here while failing
 * a real profile boot.
 */
function makeHarness() {
  const tools = [];
  const commands = [];
  const sections = [];
  const routes = [];
  const injected = [];
  const ctx = {
    _injected: injected,
    logger: { warn() {} },
    effect(callback) {
      callback();
      return () => {};
    },
    inject(services, callback) {
      for (const service of services) injected.push(service);
      callback(ctx);
    }
  };
  /** Attach a service behind an inject-declaration check. */
  const provide = (name, value) => {
    Object.defineProperty(ctx, name, {
      enumerable: true,
      get() {
        if (!injected.includes(name)) throw new Error(`cannot get property "${name}" without inject`);
        return value;
      }
    });
  };
  provide("tools", { register: (tool) => tools.push(tool) });
  provide("commands", { register: (command) => commands.push(command) });
  provide("systemPrompt", { section: (section) => sections.push(section) });
  // webServer is assigned AFTER the harness is built (the tests replace it with
  // the real webserver), so it stays a plain writable property. The inject rule
  // for it is pinned by the host unit test.
  ctx.webServer = { register: (route) => { routes.push(route); return () => {}; } };
  return { ctx, tools, commands, sections, routes, injected };
}

const webserver = await loadWebServer();
const skip = webserver === null ? "the harness webserver package is not resolvable here" : false;

/** Start a real webserver on an ephemeral port and return it with its port. */
async function startServer() {
  const WebServer = webserver.WebServer;
  const ctx = makeContext();
  const server = new WebServer(ctx, WebServer.Config({
    host: "127.0.0.1",
    port: 0,
    compression: "none"
  }));
  // The harness activates services through Cordis's init hook; calling it
  // directly is what binds the socket in a real boot.
  const init = server[Service.init];
  if (typeof init !== "function") throw new Error("WebServer exposes no Service.init hook");
  await init.call(server);
  return { server, ctx, port: server.port };
}

/**
 * Close a webserver started by {@link startServer}.
 *
 * Teardown also lives behind a Cordis `Service` symbol, and the underlying
 * `server.close()` waits for open connections — so the sockets are destroyed
 * explicitly to keep teardown prompt.
 *
 * @param {object} server - the webserver instance.
 * @returns {Promise<void>} resolves once the socket is released.
 */
async function stopServer(server) {
  const stop = server[Service.stop];
  if (typeof stop === "function") {
    await stop.call(server);
    return;
  }
  server.server?.closeAllConnections?.();
  await new Promise((resolve) => (server.server === undefined ? resolve() : server.server.close(resolve)));
}

test("the API answers real HTTP requests over a loopback socket", { skip }, async () => {
  const { server, port } = await startServer();
  const dir = await mkdtemp(join(tmpdir(), "rss-reader-e2e-"));
  scratchDirs.push(dir);

  const harness = makeHarness();
  harness.ctx.webServer = server;
  apply(harness.ctx, Config({ storeFile: join(dir, "feeds.json"), refreshMinutes: 0 }));

  try {
    const health = await fetch(`http://127.0.0.1:${port}${API_PREFIX}/health`);
    assert.equal(health.status, 200);
    const body = await health.json();
    assert.equal(body.ok, true);
    assert.equal(body.plugin, "dsh-rss-reader");

    const state = await fetch(`http://127.0.0.1:${port}${API_PREFIX}/state`);
    assert.equal(state.status, 200);
    const snapshot = await state.json();
    assert.equal(snapshot.ok, true);
    assert.deepEqual(snapshot.state.feeds, []);
  } finally {
    await stopServer(server);
  }
});

test("adding a feed over HTTP persists it to disk", { skip }, async () => {
  const { server, port } = await startServer();
  const dir = await mkdtemp(join(tmpdir(), "rss-reader-e2e-"));
  scratchDirs.push(dir);
  const storeFile = join(dir, "feeds.json");

  const harness = makeHarness();
  harness.ctx.webServer = server;
  apply(harness.ctx, Config({ storeFile, refreshMinutes: 0 }));

  // The feed body is served from a second loopback server, so the whole path
  // (HTTP client -> parser -> store -> HTTP API) runs for real.
  const { createServer } = await import("node:http");
  const feedServer = createServer((_req, res) => {
    res.writeHead(200, { "content-type": "application/rss+xml" });
    res.end("<rss version='2.0'><channel><title>E2E Feed</title><link>https://e2e.test/</link>"
      + "<item><title>E2E Item</title><link>https://e2e.test/1</link><description>hello</description></item>"
      + "</channel></rss>");
  });
  await new Promise((resolve) => feedServer.listen(0, "127.0.0.1", resolve));
  const feedPort = feedServer.address().port;

  try {
    const added = await fetch(`http://127.0.0.1:${port}${API_PREFIX}/feeds`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ url: `http://127.0.0.1:${feedPort}/feed.xml`, refresh: true })
    });
    assert.equal(added.status, 201);
    const result = await added.json();
    assert.equal(result.ok, true);
    assert.equal(result.created, true);
    assert.equal(result.outcome.ok, true, `refresh failed: ${result.outcome.error}`);
    assert.equal(result.outcome.added, 1);
    assert.equal(result.state.feeds.length, 1);
    assert.equal(result.state.feeds[0].items.length, 1);
    assert.equal(result.state.feeds[0].items[0].title, "E2E Item");

    // The refresh must have written through to disk.
    const { readFile } = await import("node:fs/promises");
    const persisted = JSON.parse(await readFile(storeFile, "utf8"));
    assert.equal(persisted.feeds.length, 1);
    assert.equal(persisted.feeds[0].items.length, 1);
  } finally {
    await new Promise((resolve) => feedServer.close(resolve));
    await stopServer(server);
  }
});

test("the /rss command and rss_read tool share one store", { skip }, async () => {
  const { server, port } = await startServer();
  const dir = await mkdtemp(join(tmpdir(), "rss-reader-e2e-"));
  scratchDirs.push(dir);

  const harness = makeHarness();
  harness.ctx.webServer = server;
  apply(harness.ctx, Config({ storeFile: join(dir, "feeds.json"), refreshMinutes: 0 }));

  try {
    // Subscribe through HTTP, then read it back through the agent tool.
    await fetch(`http://127.0.0.1:${port}${API_PREFIX}/feeds`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ url: "https://example.test/feed", refresh: false })
    });

    const tool = harness.tools.find((candidate) => candidate.name === "rss_read");
    const digest = await tool.execute({ limit: 5 }, {});
    assert.equal(digest.feeds, 1);
    assert.match(digest.text, /example\.test/);

    const command = harness.commands.find((candidate) => candidate.name === "rss");
    const output = await command.handler({ rawInput: "" });
    assert.equal(output.kind, "success");
    assert.match(output.text, /example\.test/);
  } finally {
    await stopServer(server);
  }
});

test("a preference round-trips over HTTP and lands on disk", { skip }, async () => {
  const { server, port } = await startServer();
  const dir = await mkdtemp(join(tmpdir(), "rss-reader-e2e-"));
  scratchDirs.push(dir);
  const storeFile = join(dir, "feeds.json");

  const harness = makeHarness();
  harness.ctx.webServer = server;
  apply(harness.ctx, Config({ storeFile, refreshMinutes: 0, showSidebarEntry: true }));

  try {
    // The config default answers first: nothing has been chosen yet.
    const initial = await fetch(`http://127.0.0.1:${port}${API_PREFIX}/prefs`);
    assert.equal(initial.status, 200);
    const initialPrefs = (await initial.json()).prefs;
    assert.equal(initialPrefs.showSidebarEntry, true);
    assert.equal(initialPrefs.rsshubBase, "https://rsshub.app", "the configured instance is the default");

    const patched = await fetch(`http://127.0.0.1:${port}${API_PREFIX}/prefs`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ showSidebarEntry: false })
    });
    assert.equal(patched.status, 200);
    assert.equal((await patched.json()).prefs.showSidebarEntry, false);

    // The choice is on disk before the answer was sent, so a restart keeps it.
    assert.equal(JSON.parse(await readFile(storeFile, "utf8")).prefs.showSidebarEntry, false);

    // A bad request is refused over the wire too, and changes nothing.
    const bad = await fetch(`http://127.0.0.1:${port}${API_PREFIX}/prefs`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ showSidebarEntry: "nope" })
    });
    assert.equal(bad.status, 400);

    // The instance URL is adjustable at runtime, and the change reaches the
    // client the RSSHub features actually use — no restart in between.
    const moved = await fetch(`http://127.0.0.1:${port}${API_PREFIX}/prefs`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ rsshubBase: "https://mirror.test/" })
    });
    assert.equal(moved.status, 200);
    assert.equal((await moved.json()).prefs.rsshubBase, "https://mirror.test", "a trailing slash is not part of the address");
    const hub = await fetch(`http://127.0.0.1:${port}${API_PREFIX}/rsshub`);
    assert.equal((await hub.json()).base, "https://mirror.test", "the running client moved with it");
    assert.equal(JSON.parse(await readFile(storeFile, "utf8")).prefs.rsshubBase, "https://mirror.test");

    // An address that is not an address is refused rather than stored: a typo
    // must fail where the reader can see it, not at the next request.
    const bogus = await fetch(`http://127.0.0.1:${port}${API_PREFIX}/prefs`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ rsshubBase: "not a url" })
    });
    assert.equal(bogus.status, 400);

    // Clearing it goes back to the configured default, and stores no value.
    const cleared = await fetch(`http://127.0.0.1:${port}${API_PREFIX}/prefs`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ rsshubBase: "" })
    });
    assert.equal(cleared.status, 200);
    assert.equal((await cleared.json()).prefs.rsshubBase, "https://rsshub.app");
    assert.equal("rsshubBase" in JSON.parse(await readFile(storeFile, "utf8")).prefs, false,
      "a cleared preference is not stored at all");
    const back = await fetch(`http://127.0.0.1:${port}${API_PREFIX}/rsshub`);
    assert.equal((await back.json()).base, "https://rsshub.app", "and the client went back too");

    const after = await fetch(`http://127.0.0.1:${port}${API_PREFIX}/prefs`);
    const settled = (await after.json()).prefs;
    assert.equal(settled.showSidebarEntry, false, "the switch that was set is still set");
    assert.equal(settled.rsshubBase, "https://rsshub.app", "and the cleared one is back to the default");
  } finally {
    await stopServer(server);
  }
});

test("two mounts on one webserver collide loudly instead of silently", { skip }, async () => {
  const { server, port } = await startServer();
  const dir = await mkdtemp(join(tmpdir(), "rss-reader-e2e-"));
  scratchDirs.push(dir);

  const first = makeHarness();
  first.ctx.webServer = server;
  apply(first.ctx, Config({ storeFile: join(dir, "a.json"), refreshMinutes: 0 }));

  // A second mount is exactly the double-registration a stray manual
  // cordis.patch.yml row would cause; it must fail rather than half-work.
  const second = makeHarness();
  second.ctx.webServer = server;
  assert.throws(
    () => apply(second.ctx, Config({ storeFile: join(dir, "b.json"), refreshMinutes: 0 })),
    /duplicate exact route/
  );

  try {
    const health = await fetch(`http://127.0.0.1:${port}${API_PREFIX}/health`);
    assert.equal(health.status, 200, "the first mount keeps serving");
  } finally {
    await stopServer(server);
  }
});
