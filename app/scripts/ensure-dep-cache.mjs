/**
 * ENSURE VITE'S DEPENDENCY CACHE IS COMPLETE BEFORE ANYTHING LOADS A MODULE.
 *
 * ===========================================================================
 * WHY THIS RUNS ON EVERY `npm run dev` (BUG-0082 / open-decisions §32)
 * ===========================================================================
 * Vite pre-bundles dependencies into `node_modules/.vite/deps/`. It builds them
 * in `deps_temp_<hash>/` and then RENAMES that directory onto `deps/`. Measured
 * on this tree, 2026-08-15, by clearing the cache and running the optimiser in a
 * loop:
 *
 *     3 of 10 runs FAILED, every one with
 *       Error: EBUSY: resource busy or locked, rename
 *         '...\.vite\deps_temp_78efe380' -> '...\.vite\deps'
 *     and every failure left a `deps_temp_*` directory behind.
 *
 * When that rename fails there is no usable `deps/`, so the dev server falls back
 * to discovering dependencies request-by-request WHILE THE PAGE IS LOADING. The
 * page then receives `/node_modules/.vite/deps/react.js?v=<hash>` under more than
 * one hash -- different URLs, therefore different module instances, therefore
 * more than one React. Measured: FOUR copies of `react.js` in a single page load,
 * in 4 of 11 cold-cache launches. What the user sees is
 *
 *     Warning: Invalid hook call
 *     TypeError: Cannot read properties of null (reading 'useReducer')
 *
 * inside <GridProvider>, and a window that never renders. Vite's own repair is a
 * `full-reload` over the HMR channel -- which `CALCULA_E2E=1` switches OFF on
 * purpose (a stray fast-refresh resets the grid mid-capture, see vite.config.ts),
 * so under E2E the page stays dead at `readyState: complete` with an empty
 * `#root` forever. That is §32's ten-minute corpse.
 *
 * WHAT HOLDS THE HANDLE. `app/node_modules` lives inside the Dropbox-synced tree
 * and, unlike `app/src-tauri/target` and `core/target`, carried no
 * `com.dropbox.ignored` marker, so Dropbox opened every file the optimiser wrote.
 * Marking it ignored (see `scripts/dropbox-ignore.mjs`) took the failure rate
 * from 3/10 to 1/12 -- a large improvement and NOT a cure, because Defender and
 * the Windows indexer can hold the same handle.
 *
 * THE FIX IS THIS SCRIPT: complete the optimisation up front, retrying the
 * transient EBUSY, so the server starts against a finished single-generation
 * cache and never re-optimises mid-load. Verified by clearing the cache and
 * launching 8 more times: 0 of 8 page loads duplicated anything (two of the
 * eight needed the retry).
 *
 * It is wired as npm's `predev`, which Tauri's `beforeDevCommand` ("npm run dev")
 * runs -- so it covers interactive development, the E2E auto-launch and the
 * manual E2E launcher alike, from one place.
 *
 * It NEVER fails the command. A cache it cannot repair is reported, loudly, with
 * the EBUSY verbatim; the run continues and the E2E startup barrier gets to say
 * what the page actually did. Set CALCULA_SKIP_DEP_CACHE=1 to disable.
 */
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const APP_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** Vite's cache directory for this app. */
export function viteCacheDir(appRoot = APP_DIR) {
  return path.join(appRoot, "node_modules", ".vite");
}

/**
 * What is on disk right now. Never throws.
 *
 * @returns {{populated: boolean, bundles: number, metadataOk: boolean, staleTemp: string[]}}
 */
export function readDepCacheState(appRoot = APP_DIR) {
  const cache = viteCacheDir(appRoot);
  const deps = path.join(cache, "deps");
  /** @type {string[]} */
  const staleTemp = [];
  let bundles = 0;
  let metadataOk = false;
  try {
    for (const entry of fs.readdirSync(cache)) {
      if (entry.startsWith("deps_temp")) staleTemp.push(entry);
    }
  } catch {
    /* no cache directory at all -- that is a state, not an error */
  }
  try {
    bundles = fs.readdirSync(deps).filter((f) => f.endsWith(".js")).length;
  } catch {
    bundles = 0;
  }
  try {
    JSON.parse(fs.readFileSync(path.join(deps, "_metadata.json"), "utf8"));
    metadataOk = true;
  } catch {
    metadataOk = false;
  }
  // 20 is far below the 123 bundles this app optimises to and far above the
  // handful a half-written directory contains: a sanity floor, not a count that
  // has to be kept in step with package.json.
  return { populated: bundles >= 20 && metadataOk, bundles, metadataOk, staleTemp };
}

/**
 * Delete `deps_temp_*` left behind by a failed rename, and report the ones that
 * would not go -- which is itself the signal that something still holds handles.
 *
 * @returns {string[]} directories that could not be removed
 */
export function clearStaleDepTemp(appRoot = APP_DIR) {
  const cache = viteCacheDir(appRoot);
  /** @type {string[]} */
  const stuck = [];
  let entries = [];
  try {
    entries = fs.readdirSync(cache);
  } catch {
    return stuck;
  }
  for (const entry of entries) {
    if (!entry.startsWith("deps_temp")) continue;
    try {
      fs.rmSync(path.join(cache, entry), {
        recursive: true,
        force: true,
        maxRetries: 5,
        retryDelay: 200,
      });
    } catch {
      stuck.push(entry);
    }
  }
  return stuck;
}

/**
 * The reason an optimiser attempt failed, in ONE line, preferring the errno.
 *
 * Vite prints `error when optimizing deps:` and puts the actual `Error: EBUSY
 * ...` on the NEXT line, so a naive "first line containing 'error'" reports the
 * useless half and hides the only part that names the cause.
 */
export function reasonFromOptimizerOutput(output, status) {
  const lines = String(output ?? "")
    // Vite colourises its errors. The ESC is part of the sequence, so it is
    // written as an escape rather than embedded as a raw control byte: a
    // literal one in a source file is invisible to grep and to review.
    .replace(/\u001B\[[0-9;]*m/g, "")
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  const errno = lines.find((l) => /\b(EBUSY|EPERM|ENOTEMPTY|EACCES|EMFILE|ENOENT)\b/.test(l));
  if (errno) return errno;
  const errorLine = lines.find((l) => /^Error\b|error:/i.test(l));
  if (errorLine) return errorLine;
  const anyError = lines.find((l) => /error/i.test(l));
  return anyError ?? `exit status ${status}`;
}

/**
 * `npx vite optimize --force`, synchronously, with its output captured.
 *
 * Vite 6 prints "manually calling optimizeDeps is deprecated" and does it
 * anyway. If a future Vite removes the subcommand this returns a non-zero status,
 * the attempts are exhausted, the message below is printed and the run CONTINUES
 * -- degrading to detection (the startup barrier's `duplicate-deps` arm), which
 * is the correct direction for a repair to fail in. It must never be replaced by
 * a silent no-op that reports success.
 */
function defaultRunOptimizer(appRoot) {
  const r = spawnSync("npx", ["vite", "optimize", "--force"], {
    cwd: appRoot,
    // CALCULA_E2E changes the resolved config (HMR off), and the config is part
    // of the cache's identity. Optimising under a different config than the
    // server will run is optimising into a cache the server will discard.
    env: { ...process.env, CALCULA_E2E: process.env.CALCULA_E2E ?? "" },
    encoding: "utf8",
    shell: true,
    windowsHide: true,
  });
  return { status: r.status, output: `${r.stdout ?? ""}${r.stderr ?? ""}` };
}

function defaultSleep(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * Leave the dependency cache complete and single-generation, or say why not.
 *
 * NEVER THROWS. This is a repair, not a gate: a machine where the rename can
 * never succeed still gets its run, and gets the EBUSY printed -- which is the
 * one fact that turns "the whole suite failed" into "something is holding
 * node_modules".
 *
 * NOT a retry of the thing that failed, which BUG-0082's fix note keeps last for
 * good reason. Nothing is re-run and no evidence is discarded: a DIFFERENT step
 * is completed first, before the step that would fail is asked to start.
 *
 * @returns {{ok: boolean, attempts: number, failures: string[], stuckTemp: string[], state: ReturnType<typeof readDepCacheState>, elapsedMs: number}}
 */
export function ensureDepCache(options = {}) {
  const appRoot = options.appRoot ?? APP_DIR;
  const maxAttempts = options.maxAttempts ?? 4;
  const run = options.runOptimizer ?? defaultRunOptimizer;
  const sleep = options.sleep ?? defaultSleep;
  const log = options.log ?? ((line) => console.log(line));
  const started = Date.now();
  /** @type {string[]} */
  const failures = [];

  let stuckTemp = clearStaleDepTemp(appRoot);
  let state = readDepCacheState(appRoot);

  if (state.populated && stuckTemp.length === 0) {
    log(
      `[dep-cache] complete: ${state.bundles} pre-bundled dependencies, nothing half-written.`,
    );
    return { ok: true, attempts: 0, failures, stuckTemp, state, elapsedMs: Date.now() - started };
  }

  log(
    `[dep-cache] INCOMPLETE (${state.bundles} bundles, metadata ${
      state.metadataOk ? "ok" : "MISSING"
    }${
      state.staleTemp.length > 0 ? `, ${state.staleTemp.length} half-written director(ies)` : ""
    }). Optimising now, before the app starts, so no page ever meets two generations of it.`,
  );

  let attempts = 0;
  while (attempts < maxAttempts) {
    attempts++;
    const { status, output } = run(appRoot);
    clearStaleDepTemp(appRoot);
    state = readDepCacheState(appRoot);
    if (status === 0 && state.populated) {
      log(
        `[dep-cache] optimised on attempt ${attempts}: ${state.bundles} dependencies pre-bundled` +
          ` (${((Date.now() - started) / 1000).toFixed(1)}s).`,
      );
      return {
        ok: true,
        attempts,
        failures,
        stuckTemp: clearStaleDepTemp(appRoot),
        state,
        elapsedMs: Date.now() - started,
      };
    }
    const reason = reasonFromOptimizerOutput(output, status);
    failures.push(`attempt ${attempts}: ${reason}`);
    log(`[dep-cache] attempt ${attempts} failed -- ${reason}`);
    if (attempts < maxAttempts) sleep(750);
  }

  stuckTemp = clearStaleDepTemp(appRoot);
  log(
    `[dep-cache] GAVE UP after ${maxAttempts} attempts. Vite will now discover dependencies` +
      " while the page loads, which on this tree has produced FOUR copies of React in one" +
      " page and an app that never mounts (BUG-0082, open-decisions §32). Most likely cause:" +
      " another process (Dropbox, an antivirus, the Windows indexer) is holding handles" +
      " inside app/node_modules/.vite -- run `node scripts/dropbox-ignore.mjs`.",
  );
  return { ok: false, attempts, failures, stuckTemp, state, elapsedMs: Date.now() - started };
}

// --- CLI ---------------------------------------------------------------------
if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  if (process.env.CALCULA_SKIP_DEP_CACHE === "1") {
    console.log("[dep-cache] skipped (CALCULA_SKIP_DEP_CACHE=1)");
  } else {
    ensureDepCache();
  }
  // Always 0: a repair that could not repair must not stop a developer working.
  process.exit(0);
}
