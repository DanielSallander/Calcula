//! FILENAME: app/e2e/__tests__/depOptimizer.test.ts
// PURPOSE: Unit tier for the second BUG-0082 mechanism -- the dev server handing
//          one page more than one copy of React -- covering both halves: the
//          DETECTION (which turns a blank screenshot into an attribution) and
//          the REPAIR (which stops it happening at all).
//
// CONTEXT: open-decisions §32, reproduced and explained 2026-08-15. The measured
//          numbers this file encodes:
//            * 4 of 11 cold-cache launches served `react.js` under FOUR `?v=`
//              hashes in a single page load;
//            * 3 of 10 `vite optimize --force` runs failed with EBUSY renaming
//              `deps_temp_<hash>` onto `deps`;
//            * 0 of 8 launches were broken once `ensureDepCache` ran first.
//
//          The live behaviour needs a dev server and cannot live in vitest, so
//          what is pinned here is the decision logic, and it is pinned against
//          the ACTUAL URLs and the ACTUAL error text observed in those runs --
//          not against invented strings that would pass whatever the code did.

import { describe, it, expect, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import {
  absoluteSpecifiersOf,
  collectDuplicateDepVersions,
  ensureDepCache,
  parseDepVersion,
  readDepCacheState,
  clearStaleDepTemp,
  reasonFromOptimizerOutput,
} from "../depOptimizer";
import { describeStartupFailure, probeShowsDuplicateDeps, waitForMount } from "../startupGuard";
import type { MountFailure, MountOutcome, StartupProbe } from "../startupGuard";

// ---------------------------------------------------------------------------
// Detection
// ---------------------------------------------------------------------------

describe("parseDepVersion", () => {
  it("reads the dep and the optimiser hash out of a real Vite URL", () => {
    expect(
      parseDepVersion("http://localhost:5173/node_modules/.vite/deps/react.js?v=6bf4d579"),
    ).toEqual({ dep: "react.js", hash: "6bf4d579" });
  });

  it("handles the scoped names Vite flattens", () => {
    expect(
      parseDepVersion("/node_modules/.vite/deps/@monaco-editor_react.js?v=b7a6162a")?.dep,
    ).toBe("@monaco-editor_react.js");
  });

  it("is null for anything that is not a pre-bundled dependency", () => {
    expect(parseDepVersion("/src/main.tsx")).toBeNull();
    expect(parseDepVersion("/node_modules/.vite/deps/react.js")).toBeNull();
    expect(parseDepVersion("/@vite/client")).toBeNull();
  });
});

describe("collectDuplicateDepVersions", () => {
  it("says nothing when every dep came from ONE optimiser run", () => {
    expect(
      collectDuplicateDepVersions([
        "/node_modules/.vite/deps/react.js?v=6bf4d579",
        "/node_modules/.vite/deps/react.js?v=6bf4d579",
        "/node_modules/.vite/deps/react-dom.js?v=6bf4d579",
        "/src/main.tsx",
      ]),
    ).toEqual([]);
  });

  it("names react when the page holds four copies of it", () => {
    // VERBATIM from the reproduction on 2026-08-15 (attempt 2 of 11).
    const found = collectDuplicateDepVersions([
      "/node_modules/.vite/deps/react.js?v=04c34edb",
      "/node_modules/.vite/deps/react.js?v=df213f5f",
      "/node_modules/.vite/deps/react.js?v=0b7a08f1",
      "/node_modules/.vite/deps/react.js?v=81dda651",
      "/node_modules/.vite/deps/react-dom.js?v=04c34edb",
      "/node_modules/.vite/deps/react-dom.js?v=81dda651",
    ]);
    expect(found).toHaveLength(2);
    expect(found[0]).toBe("react-dom.js: 04c34edb, 81dda651");
    expect(found[1]).toBe("react.js: 04c34edb, 0b7a08f1, 81dda651, df213f5f");
  });

  it("is case-insensitive about the hash, because a URL is not", () => {
    expect(
      collectDuplicateDepVersions([
        "/node_modules/.vite/deps/react.js?v=6BF4D579",
        "/node_modules/.vite/deps/react.js?v=6bf4d579",
      ]),
    ).toEqual([]);
  });
});

describe("absoluteSpecifiersOf", () => {
  it("finds static, dynamic and side-effect imports", () => {
    const code = [
      'import { a } from "/node_modules/.vite/deps/react.js?v=abc";',
      'import "/src/styles.css";',
      'const m = await import("/src/lazy.tsx");',
      'export { x } from "/src/other.ts";',
      'import rel from "./relative.ts";',
    ].join("\n");
    const found = absoluteSpecifiersOf(code);
    expect(found).toContain("/node_modules/.vite/deps/react.js?v=abc");
    expect(found).toContain("/src/styles.css");
    expect(found).toContain("/src/lazy.tsx");
    expect(found).toContain("/src/other.ts");
    // Relative specifiers are the module's own business; the crawl works in
    // dev-server paths.
    expect(found).not.toContain("./relative.ts");
  });
});

// ---------------------------------------------------------------------------
// The barrier arm
// ---------------------------------------------------------------------------

function probe(over: Partial<StartupProbe> = {}): StartupProbe {
  return {
    rootChildCount: 1,
    spreadsheetPresent: true,
    tauriBridgePresent: true,
    calcImportPresent: true,
    url: "http://localhost:5173/",
    readyState: "complete",
    title: "app",
    resourceCount: 250,
    networkResponses: 100,
    bootErrorText: null,
    bootErrorSignal: null,
    depUrls: [],
    ...over,
  };
}

const DUPLICATED = [
  "/node_modules/.vite/deps/react.js?v=60076897",
  "/node_modules/.vite/deps/react.js?v=7110d5b9",
  "/node_modules/.vite/deps/react_jsx-dev-runtime.js?v=2a8f89f3",
  "/node_modules/.vite/deps/react_jsx-dev-runtime.js?v=7110d5b9",
];

async function runBarrier(script: (elapsed: number) => StartupProbe | null): Promise<MountOutcome> {
  let clock = 0;
  return waitForMount({
    readProbe: async () => ({ probe: script(clock), survey: { pageCount: 1, urls: [] } }),
    capMs: 900_000,
    stallMs: 45_000,
    serverSilentMs: 300_000,
    pollMs: 1_000,
    vitePort: 5173,
    now: () => clock,
    sleep: async (ms) => {
      clock += ms;
    },
  });
}

describe("the barrier names a duplicated dependency instead of waiting it out", () => {
  it("detects it from the page's own resource timings", () => {
    expect(probeShowsDuplicateDeps(probe({ depUrls: DUPLICATED }))).toEqual([
      "react.js: 60076897, 7110d5b9",
      "react_jsx-dev-runtime.js: 2a8f89f3, 7110d5b9",
    ]);
  });

  it("fails IMMEDIATELY -- it does not sit out the 45s stall window", async () => {
    const out = (await runBarrier(() =>
      probe({ rootChildCount: 0, spreadsheetPresent: false, depUrls: DUPLICATED }),
    )) as MountFailure;
    expect(out.ok).toBe(false);
    expect(out.kind).toBe("duplicate-deps");
    // The whole point of deciding early: nothing the page can do undoes two
    // copies of React, so making the reader wait 45s adds nothing.
    expect(out.elapsedMs).toBe(0);
    expect(out.duplicateDeps).toContain("react.js: 60076897, 7110d5b9");
  });

  it("fires even when the app APPEARS to have mounted", async () => {
    // A page can render something and still hold two Reacts -- and every spec
    // after it would be running against an incoherent module graph.
    const out = (await runBarrier(() => probe({ depUrls: DUPLICATED }))) as MountFailure;
    expect(out.kind).toBe("duplicate-deps");
  });

  it("does NOT fire for a page whose deps all came from one run", async () => {
    const out = await runBarrier(() =>
      probe({
        depUrls: [
          "/node_modules/.vite/deps/react.js?v=6bf4d579",
          "/node_modules/.vite/deps/react-dom.js?v=6bf4d579",
        ],
      }),
    );
    expect(out.ok).toBe(true);
  });
});

describe("the duplicate-deps message", () => {
  const failure: MountFailure = {
    ok: false,
    kind: "duplicate-deps",
    elapsedMs: 1200,
    quietMs: 0,
    samples: 2,
    probe: probe({ rootChildCount: 0, depUrls: DUPLICATED }),
    survey: null,
    duplicateDeps: ["react.js: 60076897, 7110d5b9"],
  };

  it("prints the duplicated deps and the one-command remedy", () => {
    const msg = describeStartupFailure(failure);
    expect(msg).toContain("MORE THAN ONE COPY");
    expect(msg).toContain("react.js: 60076897, 7110d5b9");
    expect(msg).toContain("ensure-dep-cache.mjs");
    expect(msg).toContain("dropbox:check");
  });

  it("attributes it to the harness, not to the product", () => {
    // The opposite mistake to `boot-error`: telling the reader their code broke
    // when the dev server served an incoherent graph would send them to the
    // wrong file for hours. This is the misattribution the guard exists to stop.
    const msg = describeStartupFailure(failure);
    expect(msg).toContain("NOT a product");
    expect(msg).toContain("Invalid hook call");
    expect(msg).toContain("useReducer");
  });

  it("does not mention duplicated deps on failures that have none", () => {
    const msg = describeStartupFailure({ ...failure, kind: "never-mounted-stalled", duplicateDeps: [] });
    expect(msg).not.toContain("MORE THAN ONE COPY");
  });
});

// ---------------------------------------------------------------------------
// The repair
// ---------------------------------------------------------------------------

/** A throwaway app root with a Vite cache directory in whatever state we want. */
function fakeApp(setup: (cache: string) => void): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "calcula-depcache-"));
  const cache = path.join(root, "node_modules", ".vite");
  fs.mkdirSync(cache, { recursive: true });
  setup(cache);
  return root;
}

function writePopulatedDeps(cache: string): void {
  const deps = path.join(cache, "deps");
  fs.mkdirSync(deps, { recursive: true });
  for (let i = 0; i < 25; i++) fs.writeFileSync(path.join(deps, `dep${i}.js`), "//");
  fs.writeFileSync(path.join(deps, "_metadata.json"), JSON.stringify({ optimized: {} }));
}

describe("readDepCacheState", () => {
  it("calls a complete cache complete", () => {
    const root = fakeApp(writePopulatedDeps);
    const state = readDepCacheState(root);
    expect(state.populated).toBe(true);
    expect(state.bundles).toBe(25);
    expect(state.metadataOk).toBe(true);
    expect(state.staleTemp).toEqual([]);
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("calls a half-written cache incomplete, and names the leftover", () => {
    // EXACTLY what a failed rename leaves: bundles in a temp directory and no
    // usable `deps/`. This is the state that makes the server discover
    // dependencies while the page is loading.
    const root = fakeApp((cache) => {
      fs.mkdirSync(path.join(cache, "deps_temp_78efe380"), { recursive: true });
    });
    const state = readDepCacheState(root);
    expect(state.populated).toBe(false);
    expect(state.bundles).toBe(0);
    expect(state.staleTemp).toEqual(["deps_temp_78efe380"]);
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("treats deps WITHOUT metadata as incomplete", () => {
    // A directory of bundles Vite cannot index is not a cache -- and this is the
    // difference between "populated" meaning something and meaning nothing.
    const root = fakeApp((cache) => {
      const deps = path.join(cache, "deps");
      fs.mkdirSync(deps, { recursive: true });
      for (let i = 0; i < 30; i++) fs.writeFileSync(path.join(deps, `d${i}.js`), "//");
    });
    expect(readDepCacheState(root).populated).toBe(false);
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("never throws on a tree with no cache at all", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "calcula-nocache-"));
    expect(readDepCacheState(root).populated).toBe(false);
    fs.rmSync(root, { recursive: true, force: true });
  });
});

describe("clearStaleDepTemp", () => {
  it("removes the directories a failed rename leaves behind", () => {
    const root = fakeApp((cache) => {
      fs.mkdirSync(path.join(cache, "deps_temp_a"), { recursive: true });
      fs.mkdirSync(path.join(cache, "deps_temp_b"), { recursive: true });
      writePopulatedDeps(cache);
    });
    expect(clearStaleDepTemp(root)).toEqual([]);
    expect(readDepCacheState(root).staleTemp).toEqual([]);
    // ...and it must not have taken `deps/` with it.
    expect(readDepCacheState(root).populated).toBe(true);
    fs.rmSync(root, { recursive: true, force: true });
  });
});

describe("reasonFromOptimizerOutput", () => {
  it("reports the EBUSY, not the useless line above it", () => {
    // VERBATIM from the 3-in-10 failures. Vite prints a heading and puts the
    // error on the NEXT line, so "first line containing 'error'" reports the
    // half that names nothing -- which is how a cause stays unexplained for a
    // week.
    const output = [
      "\u001b[31merror when optimizing deps:",
      "Error: EBUSY: resource busy or locked, rename " +
        "'C:\\Dropbox\\Projekt\\Calcula\\app\\node_modules\\.vite\\deps_temp_78efe380' -> " +
        "'C:\\Dropbox\\Projekt\\Calcula\\app\\node_modules\\.vite\\deps'\u001b[39m",
    ].join("\n");
    const reason = reasonFromOptimizerOutput(output, 1);
    expect(reason).toContain("EBUSY");
    expect(reason).toContain("deps_temp_78efe380");
  });

  it("falls back to the exit status when the output says nothing", () => {
    expect(reasonFromOptimizerOutput("", 3)).toBe("exit status 3");
  });
});

describe("ensureDepCache", () => {
  it("does nothing at all when the cache is already complete", () => {
    const root = fakeApp(writePopulatedDeps);
    const run = vi.fn();
    const result = ensureDepCache({ appRoot: root, runOptimizer: run, log: () => undefined });
    expect(result.ok).toBe(true);
    expect(result.attempts).toBe(0);
    // Running the optimiser on every `npm run dev` would add ~3s to every launch
    // for nothing.
    expect(run).not.toHaveBeenCalled();
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("optimises when the cache is missing", () => {
    const root = fakeApp(() => undefined);
    const run = vi.fn((appRoot: string) => {
      writePopulatedDeps(path.join(appRoot, "node_modules", ".vite"));
      return { status: 0, output: "" };
    });
    const result = ensureDepCache({ appRoot: root, runOptimizer: run, log: () => undefined });
    expect(result.ok).toBe(true);
    expect(result.attempts).toBe(1);
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("RETRIES the EBUSY, which is the whole fix", () => {
    // Measured: 2 of 8 launches needed the second attempt, and every one of
    // those then succeeded. Without the retry those 2 launches are the 4-copies-
    // of-React failure.
    const root = fakeApp(() => undefined);
    let calls = 0;
    const run = vi.fn((appRoot: string) => {
      calls++;
      if (calls === 1) {
        return {
          status: 1,
          output: "error when optimizing deps:\nError: EBUSY: resource busy or locked, rename",
        };
      }
      writePopulatedDeps(path.join(appRoot, "node_modules", ".vite"));
      return { status: 0, output: "" };
    });
    const result = ensureDepCache({
      appRoot: root,
      runOptimizer: run,
      sleep: () => undefined,
      log: () => undefined,
    });
    expect(result.ok).toBe(true);
    expect(result.attempts).toBe(2);
    expect(result.failures[0]).toContain("EBUSY");
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("gives up after a BOUNDED number of attempts and reports, never throws", () => {
    // A repair that loops forever is the silent hang this programme keeps
    // deleting. Giving up hands the verdict to the startup barrier, which reads
    // the live page.
    const root = fakeApp(() => undefined);
    const run = vi.fn(() => ({ status: 1, output: "Error: EBUSY: resource busy or locked" }));
    const result = ensureDepCache({
      appRoot: root,
      maxAttempts: 3,
      runOptimizer: run,
      sleep: () => undefined,
      log: () => undefined,
    });
    expect(result.ok).toBe(false);
    expect(result.attempts).toBe(3);
    expect(run).toHaveBeenCalledTimes(3);
    expect(result.failures).toHaveLength(3);
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("treats an optimiser that exits 0 but writes nothing as a FAILURE", () => {
    // Exit status alone is not the answer: the measured failures left `deps/`
    // empty, and a cache that is empty is a cache the server will rebuild while
    // the page loads. What matters is what is on disk afterwards.
    const root = fakeApp(() => undefined);
    const run = vi.fn(() => ({ status: 0, output: "" }));
    const result = ensureDepCache({
      appRoot: root,
      maxAttempts: 2,
      runOptimizer: run,
      sleep: () => undefined,
      log: () => undefined,
    });
    expect(result.ok).toBe(false);
    expect(run).toHaveBeenCalledTimes(2);
    fs.rmSync(root, { recursive: true, force: true });
  });
});
