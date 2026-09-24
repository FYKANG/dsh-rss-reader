/**
 * dsh-rss-reader — refresh the copy a DSH profile actually loads.
 *
 * `dsh plugin add file:<this repo>` installs this package as a **directory
 * dependency**. Under pnpm's hoisted linker that is a *copy* inside the
 * profile's `node_modules`, not a link back here — so editing a file in this
 * repo changes nothing the running host can see. `pnpm install` does not help
 * either: with the lockfile already satisfied, pnpm considers the directory
 * dependency unchanged and restores the same stale copy.
 *
 * That failure is silent and looks exactly like a broken feature: the UI keeps
 * rendering the old code and new API fields come back `400`. This script is the
 * one-step fix — it copies the package's published files into every profile
 * that depends on it, then reports what it did.
 *
 * Usage:
 *
 *   node scripts/sync-install.mjs            # sync into every installed profile
 *   node scripts/sync-install.mjs --check    # report drift, copy nothing
 *
 * A restart of DSH is still required afterwards: the host loads the plugin at
 * boot, so the fixed files have to be read by a new process.
 */

import { copyFile, mkdir, readdir, readFile, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** This package's root, derived from this file's location. */
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * Expand the package's `files` entries into absolute paths.
 *
 * Uses the manifest's own `files` list so the copy is exactly what an install
 * would have placed there — no more (tests and scripts stay behind) and no less.
 *
 * @returns {Promise<{rel: string, abs: string}[]>} files to copy.
 */
async function publishedFiles() {
  const manifest = JSON.parse(await readFile(join(ROOT, "package.json"), "utf8"));
  const out = [];
  for (const entry of manifest.files ?? []) {
    const abs = join(ROOT, entry);
    if (!existsSync(abs)) continue;
    if ((await stat(abs)).isDirectory()) {
      for (const name of await readdir(abs)) out.push({ rel: `${entry}/${name}`, abs: join(abs, name) });
    } else {
      out.push({ rel: entry, abs });
    }
  }
  return out;
}

/** SHA-256 of a file, or null when it is not there. */
async function hashOf(file) {
  try {
    return createHash("sha256").update(await readFile(file)).digest("hex");
  } catch {
    return null;
  }
}

/**
 * Every `node_modules/dsh-rss-reader` under the DSH home's profiles.
 * @returns {Promise<string[]>} install directories that exist.
 */
async function installedCopies() {
  const home = process.env.DSH_HOME ?? join(process.env.USERPROFILE ?? process.env.HOME ?? ".", ".dsh");
  const profiles = join(home, "profiles");
  if (!existsSync(profiles)) return [];
  const out = [];
  for (const profile of await readdir(profiles)) {
    const candidate = join(profiles, profile, "node_modules", "dsh-rss-reader");
    if (existsSync(candidate)) out.push(candidate);
  }
  return out;
}

const check = process.argv.includes("--check");
const files = await publishedFiles();
const copies = await installedCopies();

if (copies.length === 0) {
  console.log("no installed copy found under $DSH_HOME/profiles/*/node_modules/dsh-rss-reader");
  console.log("add it first:  dsh plugin --profile <name> add file:" + ROOT);
  process.exit(0);
}

let drifted = 0;
for (const target of copies) {
  const stale = [];
  for (const file of files) {
    const destination = join(target, file.rel);
    if ((await hashOf(destination)) !== (await hashOf(file.abs))) {
      stale.push(file);
      if (!check) {
        await mkdir(dirname(destination), { recursive: true });
        await copyFile(file.abs, destination);
      }
    }
  }
  drifted += stale.length;
  const where = target.replace(/\\/g, "/");
  if (stale.length === 0) {
    console.log(`up to date  ${where}`);
  } else if (check) {
    console.log(`STALE (${stale.length})  ${where}`);
    for (const file of stale) console.log(`  ${file.rel}`);
  } else {
    console.log(`synced ${stale.length} file(s)  ${where}`);
    for (const file of stale) console.log(`  ${file.rel}`);
  }
}

if (drifted > 0 && !check) {
  console.log("\nrestart DSH to load the new code — the host reads this package at boot.");
} else if (drifted > 0) {
  console.log("\nrun without --check to copy them, then restart DSH.");
}
