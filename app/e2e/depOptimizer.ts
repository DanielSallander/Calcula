//! FILENAME: app/e2e/depOptimizer.ts
// PURPOSE: Make sure Vite's dependency cache is COMPLETE AND SINGLE-GENERATION
//          before the application under test loads a single module -- because
//          when it is not, the dev server hands one page FOUR DIFFERENT COPIES
//          OF REACT, and with HMR off nothing can ever repair it.
//
// ============================================================================
// THE SECOND BUG-0082 MECHANISM: REPRODUCED, AND THEN EXPLAINED. (2026-08-15)
// ============================================================================
// §32 recorded a second, unexplained way a run arrives dead: deleting
// `app/node_modules/.vite` produced a launch that sat at `readyState complete`
// for ten minutes, and a reload caught `Warning: Invalid hook call` +
// `TypeError: Cannot read properties of null (reading 'useReducer')` inside
// <GridProvider>. It was filed as "a second React instance from a mid-flight
// Vite dependency re-optimisation" and never reproduced. The watcher fix
// (`server.watch.ignored`) addressed a DIFFERENT cause -- a page starved of
// module responses -- and left this one open.
//
// IT REPRODUCES, AND IT NEEDS NO BROWSER TO SEE. Vite rewrites every bare import
// to `/node_modules/.vite/deps/<dep>.js?v=<hash>`, and the hash identifies the
// OPTIMISER RUN. Two hashes for `react.js` in one page load are two URLs,
// therefore two module instances, therefore two dispatchers -- which IS "Invalid
// hook call". So: clear the dep cache, start the dev server the way the E2E
// launcher does (CALCULA_E2E=1, HMR OFF), crawl the 1,422-module graph over HTTP
// exactly as the browser does, and count hashes.
//
//   ELEVEN cold-cache launches:
//     7 clean   -- 1,422 modules, 0 failures, ONE hash per dep, ~4.3 s
//     4 BROKEN  -- 1,510 modules, 18 refused requests, and `react.js` served
//                  under FOUR hashes in a single load (04c34edb / df213f5f /
//                  0b7a08f1 / 81dda651), `react-dom` under three,
//                  `@monaco-editor/react` under four.
//
//   The server said what it was doing, every broken time:
//     [vite] new dependencies optimized: react/jsx-dev-runtime, react, ...
//     [vite] optimized dependencies changed. reloading        <-- NOBODY HEARS THIS
//     The file does not exist at ".../deps/jspdf.js?v=9edc1293" which is in the
//       optimize deps directory ...                           <-- the refused requests
//
// "reloading" is a `full-reload` on the HMR channel, and `CALCULA_E2E=1` sets
// `server.hmr = false` deliberately -- it must stay off, because a stray
// fast-refresh resets GridProvider's `useReducer` mid-capture and photographs the
// editor into a golden. So Vite's ONE repair for this state is disconnected by
// design. The page has already loaded; it will never load again; `readyState` is
// `complete` and `#root` is empty. That is §32's ten-minute corpse exactly.
//
// ============================================================================
// WHY THE OPTIMISER SPLITS: EBUSY ON A DIRECTORY RENAME.
// ============================================================================
// The optimiser writes `node_modules/.vite/deps_temp_<hash>/` and then renames
// it onto `deps/`. Measured by clearing the cache and running `vite optimize
// --force` in a loop:
//
//     3 of 10 runs FAILED, every one of them with
//       Error: EBUSY: resource busy or locked, rename
//         '...\.vite\deps_temp_78efe380' -> '...\.vite\deps'
//     and every failure left a `deps_temp_*` directory behind.
//
// A failed rename leaves NO usable `deps/`, so the server falls back to
// discovering dependencies request-by-request while the page is already loading
// -- three optimiser generations in one page load, which is the duplicated React.
// The 30 % failure rate and the 36 % duplicated-React rate are the same event.
//
// WHAT HOLDS THE HANDLE. `app/node_modules` sits inside the Dropbox-synced tree
// and, unlike `app/src-tauri/target` and `core/target`, carried NO
// `com.dropbox.ignored` marker: Dropbox was opening every freshly written file
// in `deps_temp_*` to index it. Marking it ignored took the failure rate from
// 3/10 to 1/12 -- a large improvement and NOT a cure, because Defender and the
// Windows indexer can hold the same handle. A rename that is only usually
// possible cannot be the foundation of a test run.
//
// ============================================================================
// THE FIX: COMPLETE THE OPTIMISATION BEFORE THE APP EXISTS, AND RETRY THE RENAME.
// ============================================================================
// `ensureDepCache()` runs the optimiser to completion from the harness, BEFORE
// `tauri dev` is spawned -- so every discovery round happens while no page is
// depending on the answer -- and it retries the EBUSY, which is transient by
// nature. The dev server then starts against a complete, single-generation cache
// and never re-optimises mid-flight.
//
// THIS IS NOT A RETRY OF THE THING THAT FAILED, which BUG-0082's fix note keeps
// last for good reason. The run is not re-run and no evidence is discarded: a
// DIFFERENT step (the optimiser) is completed first, the reason each attempt
// failed is printed, and if it never succeeds the run continues to the startup
// barrier, which decides on its own evidence.

// ---------------------------------------------------------------------------
// Reading what the server actually served -- pure, so it has a unit tier
// ---------------------------------------------------------------------------

/** One dep as the browser sees it: a file under `deps/` plus an optimiser hash. */
export interface DepVersion {
  dep: string;
  hash: string;
}

/**
 * `/node_modules/.vite/deps/react.js?v=6bf4d579` -> `{ dep: "react.js", hash: "6bf4d579" }`.
 * Anything else -> null.
 */
export function parseDepVersion(url: string): DepVersion | null {
  const m = /\/node_modules\/\.vite\/deps\/([^?/]+)\?v=([0-9a-fA-F]+)/.exec(url);
  return m ? { dep: m[1] as string, hash: (m[2] as string).toLowerCase() } : null;
}

/**
 * Deps that appeared under MORE THAN ONE optimiser hash, formatted for a human.
 *
 * This is the whole diagnosis in one function, and it works on any list of URLs:
 * the harness's own crawl, or `performance.getEntriesByType("resource")` read out
 * of the LIVE page -- which is how the startup barrier attributes the failure
 * when it meets one, instead of leaving the reader a blank white screenshot.
 */
export function collectDuplicateDepVersions(urls: readonly string[]): string[] {
  const byDep = new Map<string, Set<string>>();
  for (const url of urls) {
    const parsed = parseDepVersion(url);
    if (!parsed) continue;
    const set = byDep.get(parsed.dep) ?? new Set<string>();
    set.add(parsed.hash);
    byDep.set(parsed.dep, set);
  }
  const out: string[] = [];
  for (const [dep, hashes] of byDep) {
    if (hashes.size > 1) out.push(`${dep}: ${[...hashes].sort().join(", ")}`);
  }
  return out.sort();
}

/** Every absolute module specifier a transformed Vite module refers to. */
export function absoluteSpecifiersOf(code: string): string[] {
  const out = new Set<string>();
  const patterns = [/(?:from|import)\s*\(?\s*["'](\/[^"']*)["']/g, /import\s*["'](\/[^"']*)["']/g];
  for (const re of patterns) {
    let m: RegExpExecArray | null;
    while ((m = re.exec(code)) !== null) {
      const spec = m[1] as string;
      // `//host/...` is protocol-relative, not a dev-server path.
      if (!spec.startsWith("//")) out.add(spec);
    }
  }
  return [...out];
}

// ---------------------------------------------------------------------------
// The repair
// ---------------------------------------------------------------------------

// The DISK half of this -- reading the cache, clearing half-written directories,
// and driving the optimiser with bounded retries -- lives in
// `app/scripts/ensure-dep-cache.mjs` and is re-exported here.
//
// WHY IT IS PLAIN JAVASCRIPT IN scripts/ AND NOT TYPESCRIPT IN e2e/: it has to
// run from npm's `predev`, which is what Tauri's `beforeDevCommand` invokes.
// That one hook covers interactive development, the E2E auto-launch AND the
// manual E2E launcher -- every way this app is ever started -- from a single
// place, and it must not depend on the running Node being new enough to strip
// types. Re-exporting rather than reimplementing keeps ONE source of truth: two
// copies that happen to agree are not one, and the drift here would be silent.
export {
  ensureDepCache,
  readDepCacheState,
  clearStaleDepTemp,
  viteCacheDir,
  reasonFromOptimizerOutput,
} from "../scripts/ensure-dep-cache.mjs";

// ---------------------------------------------------------------------------
// Verification -- crawl the graph the way the browser does
// ---------------------------------------------------------------------------

export interface CrawlResult {
  fetched: number;
  /** Requests the dev server refused -- the "file does not exist" responses. */
  failures: number;
  urls: string[];
  /** Deps served under more than one optimiser hash. Empty means ONE graph. */
  duplicates: string[];
  elapsedMs: number;
  truncated: boolean;
}

export interface CrawlOptions {
  vitePort: number;
  entry?: string;
  budgetMs?: number;
  concurrency?: number;
  fetchImpl?: (url: string) => Promise<{ ok: boolean; text: () => Promise<string> }>;
}

/**
 * Walk the module graph over HTTP the way the browser does, and report what the
 * dev server actually served. Used to VERIFY the repair, and available as a
 * diagnosis on any machine that meets the failure again.
 */
export async function crawlModuleGraph(opts: CrawlOptions): Promise<CrawlResult> {
  const base = `http://localhost:${opts.vitePort}`;
  const budgetMs = opts.budgetMs ?? 300_000;
  const concurrency = opts.concurrency ?? 12;
  const doFetch =
    opts.fetchImpl ?? ((url: string) => fetch(url, { signal: AbortSignal.timeout(120_000) }));

  const seen = new Set<string>();
  const urls: string[] = [];
  const queue: string[] = [opts.entry ?? "/src/main.tsx"];
  const started = Date.now();
  let fetched = 0;
  let failures = 0;

  while (queue.length > 0 && Date.now() - started < budgetMs) {
    const batch = queue.splice(0, concurrency).filter((u) => !seen.has(u));
    for (const u of batch) seen.add(u);
    await Promise.all(
      batch.map(async (u) => {
        urls.push(u);
        let text = "";
        try {
          const res = await doFetch(base + u);
          if (!res.ok) {
            failures++;
            return;
          }
          text = await res.text();
        } catch {
          failures++;
          return;
        }
        fetched++;
        for (const spec of absoluteSpecifiersOf(text)) {
          // Record it even when already seen: the SAME dep under a NEW hash is a
          // different URL, and that is precisely the finding.
          if (!seen.has(spec)) queue.push(spec);
          else urls.push(spec);
        }
      }),
    );
  }

  return {
    fetched,
    failures,
    urls,
    duplicates: collectDuplicateDepVersions(urls),
    elapsedMs: Date.now() - started,
    truncated: queue.length > 0,
  };
}
