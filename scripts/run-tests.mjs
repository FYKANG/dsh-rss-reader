/**
 * dsh-rss-reader — test runner.
 *
 * Imports every `test/*.test.mjs` into this one process and lets `node:test`
 * drive them, exiting non-zero if anything failed.
 *
 * Why not `node --test`: the built-in runner spawns a child process per file,
 * which some sandboxed environments refuse (EPERM on spawn). Importing the
 * files directly runs the same `node:test` suites with no child process, so
 * `npm test` behaves identically in a sandbox and on a normal shell.
 */

import { readdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { test } from "node:test";

const here = dirname(fileURLToPath(import.meta.url));
const testDir = join(here, "..", "test");

const files = (await readdir(testDir)).filter((name) => name.endsWith(".test.mjs")).sort();
if (files.length === 0) {
  process.stderr.write("no test files found\n");
  process.exit(1);
}

const t = test("dsh-rss-reader suite", async (t) => {
  for (const name of files) {
    // Each file registers its own top-level tests; awaiting the import keeps
    // the files sequential, so one file's globals never leak into the next.
    await import(pathToFileURL(join(testDir, name)).href);
    await t.test(name, () => {});
  }
});

// Awaiting the root test settles once every suite has run; `node:test` then
// reports the results and sets the exit code itself.
await t;
