//! FILENAME: app/e2e/__tests__/depCacheWired.test.ts
// PURPOSE: Keep the dependency-cache repair PLUGGED IN, and keep this machine's
//          build trees out of Dropbox's hands.
//
// CONTEXT: BUG-0082's second mechanism, reproduced 2026-08-15 (open-decisions
//          §32). `ensure-dep-cache.mjs` only helps if it actually runs, and it
//          runs from exactly one place -- npm's `predev`, which Tauri's
//          `beforeDevCommand` ("npm run dev") invokes for interactive
//          development, the E2E auto-launch and the manual E2E launcher alike.
//          Unhook that one string and the repair is decorative, silently, and
//          the next cold cache is a 36 %-chance suite-wide collapse again.
//
//          `depOptimizer.test.ts` proves the logic. This proves the wiring, the
//          same instrument `hmrDisabledForE2E.test.ts` and
//          `startupBarrierWired.test.ts` use for the same reason.

import { describe, it, expect } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { surveyIgnoredTrees, DROPBOX_IGNORED_TREES } from "../../scripts/dropbox-ignore.mjs";

const APP_ROOT = process.cwd();
const REPO_ROOT = join(APP_ROOT, "..");
const read = (rel: string): string => readFileSync(join(APP_ROOT, rel), "utf8");

describe("the dependency-cache repair runs on every launch", () => {
  const pkg = JSON.parse(read("package.json")) as { scripts?: Record<string, string> };

  it("exists", () => {
    expect(existsSync(join(APP_ROOT, "scripts/ensure-dep-cache.mjs"))).toBe(true);
  });

  it("is wired into `predev`, which is what every launch path goes through", () => {
    for (const name of ["predev", "predev:data"]) {
      expect(
        (pkg.scripts?.[name] ?? "").includes("ensure-dep-cache.mjs"),
        `npm's \`${name}\` no longer runs scripts/ensure-dep-cache.mjs. Vite will discover ` +
          "dependencies while the page is loading again, which on this tree served react.js " +
          "under FOUR ?v= hashes in 4 of 11 cold-cache launches -- two Reacts, " +
          "`Invalid hook call`, and a window that never renders (BUG-0082 §32).",
      ).toBe(true);
    }
  });

  it("still kills stale servers FIRST -- a live server holds the cache open", () => {
    const predev = pkg.scripts?.predev ?? "";
    expect(predev.indexOf("kill-stale-dev")).toBeLessThan(predev.indexOf("ensure-dep-cache"));
  });

  it("Tauri's beforeDevCommand is still the npm script that carries predev", () => {
    // If this ever becomes `vite` directly, `predev` stops running and the
    // repair silently leaves the E2E launch path.
    const conf = readFileSync(join(APP_ROOT, "src-tauri/tauri.conf.json"), "utf8");
    expect(conf).toContain('"beforeDevCommand": "npm run dev"');
  });

  it("the barrier can still name the failure when the repair does not run", () => {
    // Defence in depth: prevention can be skipped (CALCULA_SKIP_DEP_CACHE=1, a
    // machine where the rename never succeeds). Detection must survive that.
    const guard = read("e2e/startupGuard.ts");
    expect(guard).toContain("duplicate-deps");
    expect(guard).toContain("probeShowsDuplicateDeps");
    expect(read("e2e/pageState.ts")).toContain("depUrls");
  });
});

describe("Dropbox is not holding this machine's build trees", () => {
  // MACHINE STATE, NOT REPO STATE. `com.dropbox.ignored` is an NTFS alternate
  // data stream, so it cannot be committed: a fresh clone, or a fresh
  // `npm install` that recreates node_modules, starts unprotected. Nothing else
  // in the tree can notice that, which is precisely why it is asserted here.
  const insideDropbox = /(^|[\\/])Dropbox([\\/]|$)/i.test(REPO_ROOT);

  it("knows which trees it is talking about", () => {
    // A census that names nothing passes forever.
    expect(DROPBOX_IGNORED_TREES).toContain("app/node_modules");
    expect(DROPBOX_IGNORED_TREES.length).toBeGreaterThanOrEqual(5);
  });

  it.runIf(insideDropbox)("every tree that exists is marked ignored", () => {
    const unprotected = surveyIgnoredTrees(REPO_ROOT)
      .filter((t) => t.exists && t.ignored !== true)
      .map((t) => t.rel);
    expect(
      unprotected,
      `${unprotected.join(", ")} are inside a Dropbox-synced tree and are NOT marked ` +
        "`com.dropbox.ignored`. Dropbox opens files the moment they are written, which " +
        "makes Vite's dependency-cache rename fail with EBUSY (measured 3/10 vs 1/12 with " +
        "the marker) and hands the app more than one copy of React. " +
        "Fix: `cd app && npm run dropbox:ignore`.",
    ).toEqual([]);
  });
});
