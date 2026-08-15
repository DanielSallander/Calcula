// @vitest-environment node
//
// (`resolveConfig` loads the real Vite config, which loads esbuild, and esbuild
// refuses to run under the suite's default DOM environment: "new
// TextEncoder().encode('') instanceof Uint8Array is incorrectly false".)
//
//! FILENAME: app/e2e/__tests__/viteWatchExclusions.test.ts
// PURPOSE: Keep the Vite dev server's file watcher off the Rust build tree.
// CONTEXT: BUG-0082 -- "a cold E2E launch can come up with an empty #root".
//
//          The dev server is one thread. Vite's default watcher is
//          `chokidar.watch(root)` with root = `app/`, and `app/src-tauri/`
//          holds an in-repo Cargo `target/` of 100,175 files in 9,118
//          directories. Chokidar registers a native `fs.watch` per entry AFTER
//          `server.listen()` has already printed "ready in 380 ms" and begun
//          answering HTTP -- so the server serves the static `index.html`
//          instantly and then starves every `/src/*.ts` request behind the
//          walk. The page sits at http://localhost:5173/ with `<div id="root">`
//          present and EMPTY, which is exactly the state the failing run's
//          trace recorded, and the 60 s fixture ceiling turns it into N
//          product-looking timeouts.
//
//          MEASURED 2026-08-15 against the dev server ALONE -- no cargo, no
//          app.exe, no WebView2, so CPU contention is excluded -- by crawling
//          the 1,420-module graph over HTTP the way the browser does:
//
//            default watcher   37.0 s / 37.4 s / 62 s / >120 s to serve 1,420
//                              modules (one run served THREE in 120 s)
//            src-tauri ignored  3.4 s /  3.3 s /  3.7 s
//            second traversal   0.4-0.6 s in BOTH  <- transform is not the cost
//            chokidar watched   9,720 dirs / 113,460 entries -> 545 / 3,443
//
//          A CPU profile of the slow traversal put 74.5 % of samples in
//          `_addToNodeFs` -> `_watchWithNodeFs` -> `createFsWatchInstance` ->
//          `node:fs.watch` -> native `FSWatcher.start`.
//
//          WHY THIS IS A TEST AND NOT A COMMENT. The exclusion is five lines in
//          `vite.config.ts` that nothing else depends on and nothing else would
//          miss. Delete them and every suite still passes -- slowly, until the
//          walk runs long enough on some idle morning to cross the fixture
//          ceiling, and then eighteen goldens "break" at once. So the assertion
//          is on the RESOLVED config (a mistyped key, or the option placed
//          outside `server`, must fail) and on MATCHING BEHAVIOUR in both
//          directions: the build tree is excluded AND the sources are not.

import { describe, it, expect } from "vitest";
import { resolveConfig } from "vite";
import { createRequire } from "node:module";
import { join } from "node:path";

// picomatch IS the matcher chokidar applies to `ignored`, so the guard tests the
// real semantics rather than a hand-rolled glob translation that could disagree
// with the server. It ships no type declarations and is a transitive dependency,
// hence the explicitly typed require: if it ever disappears the guard fails
// loudly instead of quietly asserting nothing.
type Picomatch = (glob: string, options?: { dot?: boolean }) => (input: string) => boolean;
const picomatch = createRequire(import.meta.url)("picomatch") as Picomatch;

const APP_ROOT = process.cwd();

/**
 * Would a watcher configured with `patterns` ignore `absPath`?
 *
 * PURE, and exported so the guard can be self-tested against a control: a
 * predicate that answered "yes" to everything would make the assertions below
 * pass while the config was empty, which is the shape of failure this program
 * has paid for repeatedly.
 */
export function watcherIgnores(patterns: readonly string[], absPath: string): boolean {
  const posix = absPath.replace(/\\/g, "/");
  return patterns.some((p) => picomatch(p, { dot: true })(posix));
}

/** Absolute, POSIX-slashed path inside the app root. */
const at = (rel: string): string => join(APP_ROOT, rel).replace(/\\/g, "/");

async function resolvedWatchIgnores(): Promise<string[]> {
  // command "serve" -- this is the dev server's watcher, not the build's.
  const config = await resolveConfig({ configFile: join(APP_ROOT, "vite.config.ts") }, "serve", "development");
  const ignored = config.server.watch?.ignored;
  if (ignored === undefined) return [];
  const list = Array.isArray(ignored) ? ignored : [ignored];
  return list.filter((entry): entry is string => typeof entry === "string");
}

describe("the Vite dev server does not watch the Rust build tree (BUG-0082)", () => {
  it("resolves a server.watch.ignored list from vite.config.ts", async () => {
    const patterns = await resolvedWatchIgnores();
    expect(
      patterns.length,
      "vite.config.ts resolves NO string patterns for `server.watch.ignored`. Either the " +
        "option was removed, or it was mistyped / placed outside `server` -- in which case " +
        "Vite silently uses its default and the dev server goes back to registering an " +
        "fs.watch for all 100,175 files under app/src-tauri on every start (BUG-0082).",
    ).toBeGreaterThan(0);
  });

  it("ignores app/src-tauri, which is where the 100,000-file Cargo target lives", async () => {
    const patterns = await resolvedWatchIgnores();
    for (const rel of [
      "src-tauri/target/debug/app.exe",
      "src-tauri/target/debug/build/some-crate-1234/output",
      "src-tauri/target/release/deps/libfoo.rlib",
      "src-tauri/src/lib.rs",
    ]) {
      expect(
        watcherIgnores(patterns, at(rel)),
        `${rel} is NOT excluded from the dev-server watcher. Registering native fs.watch ` +
          `handles across that tree blocks the server's single thread for 37-120 s after ` +
          `"ready in 380 ms", during which /src/main.tsx is never served and #root stays ` +
          `empty. Measured 2026-08-15; see vite.config.ts.`,
      ).toBe(true);
    }
  });

  it("ignores the generated corpora and outputs, which are equally uninteresting", async () => {
    const patterns = await resolvedWatchIgnores();
    for (const rel of [
      "e2e/results/app-dev.log",
      "e2e/visual/__screenshots__/x.png",
      "e2e/visual/grid.spec.ts-snapshots/grid-win32.png",
      "test-results/whatever.png",
      "dist/assets/index-abcd1234.js",
    ]) {
      // The screenshot corpora live under `*-snapshots/`; a bare `__screenshots__`
      // directory is not covered and does not need to be -- it is small. Only
      // assert what the config actually claims.
      if (rel.includes("__screenshots__")) continue;
      expect(
        watcherIgnores(patterns, at(rel)),
        `${rel} is watched by the dev server for no reason.`,
      ).toBe(true);
    }
  });

  it("still watches everything the frontend is actually built from", async () => {
    const patterns = await resolvedWatchIgnores();
    for (const rel of [
      "src/main.tsx",
      "src/core/lib/gridRenderer/rendering/grid.ts",
      "src/api/commands.ts",
      "extensions/Charts/index.ts",
      "extensions/manifest.ts",
      "index.html",
      "vite.config.ts",
    ]) {
      expect(
        watcherIgnores(patterns, at(rel)),
        `${rel} is EXCLUDED from the dev-server watcher, so saving it would not hot-reload ` +
          `during interactive development. The exclusion list has grown too broad.`,
      ).toBe(false);
    }
  });

  it("self-test: the predicate distinguishes a real list from an empty one", () => {
    const good = ["**/src-tauri/**"];
    const empty: string[] = [];
    expect(watcherIgnores(good, at("src-tauri/target/debug/app.exe"))).toBe(true);
    expect(watcherIgnores(good, at("src/main.tsx"))).toBe(false);
    // An empty config must FAIL the src-tauri assertion, or the guard above is
    // asserting nothing at all.
    expect(watcherIgnores(empty, at("src-tauri/target/debug/app.exe"))).toBe(false);
  });
});
