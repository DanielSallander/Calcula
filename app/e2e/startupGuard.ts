//! FILENAME: app/e2e/startupGuard.ts
// PURPOSE: FAIL THE RUN, before a single test is attempted, when the application
//          under test came up but the frontend never mounted -- and say so in a
//          message that names itself, instead of letting the harness report the
//          same fact as N product failures.
//
// WHY THIS EXISTS (BUG-0082, docs/design/open-decisions-2026-08.md §32).
// Measured three times on 2026-08-15. The app was running, CDP was answering,
// the page had LOADED from Vite -- `frameUrl http://localhost:5173/`, the whole
// index.html DOM present, `<title>app</title>` -- and `<div id="root">` had no
// children, because `/src/main.tsx` was fetched and never evaluated. Every spec
// then failed identically on `waitForSelector("[data-focus-container=
// 'spreadsheet']")` after 60 s:
//
//     --project=soak       12 failed / 1 skipped
//     --project=invariant  the run died at startup
//     --project=visual     18 failed of 18 -- i.e. "the entire golden corpus"
//
// The report contained eighteen Playwright TimeoutErrors, eighteen blank white
// screenshots, and nothing that said the application never mounted. An
// instrument that lies in the direction of "your code is broken" is the failure
// mode this programme has paid for most often, so the fix is not a longer
// timeout: it is a BARRIER that runs before the first test, decides the question
// while the evidence is still on screen, and refuses the run.
//
// THE SHAPE IS `collectionGuard.ts`'S, DELIBERATELY.
//   * The barrier is called from `global-setup.ts`, so a run that fails it
//     reports ZERO tests -- there is no green (or red) number to misread. A
//     reporter cannot be dropped from it, because it is not a reporter: a CLI
//     `--reporter=dot,json` (the standard invocation in this programme) cannot
//     reach it at all.
//   * The MID-RUN half -- the app that mounts, then goes away and comes back
//     empty, which `fixtures.ts` detects on its own `waitForSelector` timeout --
//     writes the marker below, and the EXISTING collection-guard reporter reads
//     it in `onEnd`, prints the banner and fails the run. One reporter, one
//     handshake (`assertCollectionGuardPresent`), one status override. No second
//     reporting channel.
//   * `e2e/__tests__/startupGuard.test.ts` pins the wording and the timing
//     arms, and `e2e/__tests__/startupBarrierWired.test.ts` pins that
//     global-setup still calls the barrier and still clears the marker -- a
//     guard nothing checks is one edit from being decorative.
//
// WHAT IT WILL NOT DO. It will not retry, and it will not raise a ceiling on one
// sample. A retry deletes the evidence the next occurrence needs (BUG-0082's
// fix note keeps retries LAST for exactly that reason), and the ~55 s cold mount
// measured once is a MEASUREMENT, not a limit. The bound here is therefore not a
// mount deadline at all: it is a quiet window over the page's own progress
// signals, and WHICH quiet window applies is decided by `document.readyState`
// (see `waitForMount` -- the split is measured, not reasoned). An app that is
// merely slow keeps waiting; an app that has finished loading and not mounted is
// named in 45 s; and a cap fifteen minutes out stops the barrier ever becoming
// the silent hang this programme keeps deleting.

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import type { RawPageState } from "./pageState";
import { collectDuplicateDepVersions } from "./depOptimizer";

const HERE = path.dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------------------
// The marker: THE one path, three stages (cf. appDiedMarker.ts)
// ---------------------------------------------------------------------------

/**
 * Written when a startup/mount failure is PROVEN (by the barrier in
 * `global-setup.ts`, or by `fixtures.ts` when the same state is found mid-run),
 * cleared by `global-setup.ts` at the start of every run, read by the
 * collection-guard reporter's `onEnd`, which fails the run and prints the
 * banner.
 *
 * One module owns the path for the same reason `appDiedMarker.ts` does: three
 * copies that happen to agree is not one source of truth, and the failure mode
 * of the drift is silent -- the marker is written, nobody reads it, and the run
 * ends with "N failed" again.
 */
export const STARTUP_FAILED_MARKER = path.join(
  HERE,
  "results",
  "APP-NEVER-MOUNTED.txt",
);

/** Remove the marker so a banner can only ever be about THIS run. */
export function clearStartupFailure(): void {
  try {
    if (fs.existsSync(STARTUP_FAILED_MARKER)) fs.unlinkSync(STARTUP_FAILED_MARKER);
  } catch {
    /* a stale marker we cannot remove must not stop the run */
  }
}

/** Record a proven startup failure. Never throws: the marker is evidence, not the verdict. */
export function recordStartupFailure(detail: string): void {
  try {
    fs.mkdirSync(path.dirname(STARTUP_FAILED_MARKER), { recursive: true });
    fs.writeFileSync(
      STARTUP_FAILED_MARKER,
      `${new Date().toISOString()}\n${detail}\n`,
      "utf-8",
    );
  } catch {
    /* a marker we cannot write must not replace the error we can throw */
  }
}

/** The recorded detail, or null when this run proved no startup failure. */
export function readStartupFailure(): string | null {
  try {
    if (!fs.existsSync(STARTUP_FAILED_MARKER)) return null;
    return fs.readFileSync(STARTUP_FAILED_MARKER, "utf-8").trim();
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// What the barrier reads from the page
// ---------------------------------------------------------------------------

/**
 * One reading of the page under test. Every field is a FACT the page reported,
 * or the explicit "could not be read" value -- never an inference. `null` in
 * place of a whole probe means there was no page/target to read at all.
 *
 * THE FIELDS AND THE READING ITSELF LIVE IN `pageState.ts`, because the barrier
 * and `fixtures.ts` must agree on them exactly and used to keep separate,
 * drifted copies. `networkResponses` is added here because it is the BARRIER's
 * measurement (its own CDP session), not something the page can report about
 * itself.
 *
 * `bootErrorText` is the seam between the two fixes that landed together.
 * `#root` having children was the ONLY mount signal, and it meant "React ran and
 * rendered the app". Since BUG-0083 added a `RootErrorBoundary` above all five
 * React roots, a boot-time throw ALSO puts a child under `#root` -- the failure
 * panel. So the old signal reported a crashed app as a healthy mount, the
 * barrier waved the run through, and every spec failed on
 * `[data-focus-container='spreadsheet']`: N product-looking timeouts for one
 * systemic fact, which is BUG-0082's misreporting reappearing through the other
 * fix's front door. `bootErrorSignal` records WHICH marker identified the panel,
 * so a build that has quietly lost the `data-testid` says so out loud.
 */
export interface StartupProbe extends RawPageState {
  /**
   * Responses seen by the barrier's CDP Network domain since it attached.
   * Secondary progress signal, and the one that keeps counting when a page is
   * fetching things `performance` does not enumerate. -1 when not instrumented.
   */
  networkResponses: number;
}

/** How many pages the barrier saw, and which one it read. Evidence only. */
export interface StartupSurvey {
  pageCount: number;
  urls: string[];
}

/**
 * The frontend is up exactly when React put something under `#root`.
 *
 * NOTE this is deliberately still true when the thing React put there is the
 * root error boundary's failure panel: React DID run, which is a different fact
 * from BUG-0082's. `probeShowsBootError` separates the two, and `waitForMount`
 * checks it before accepting the mount.
 */
export function probeIsMounted(probe: StartupProbe): boolean {
  return probe.rootChildCount > 0;
}

/**
 * The app rendered its root error boundary instead of itself: React ran and the
 * product threw during boot. Reported as its own failure kind so the run ends
 * ONCE, naming the error, rather than N times on a selector that was never
 * going to appear.
 */
export function probeShowsBootError(probe: StartupProbe): boolean {
  return probe.bootErrorText !== null;
}

/**
 * The page fetched the same pre-bundled dependency under more than one Vite
 * optimiser hash -- i.e. it is holding more than one copy of it.
 *
 * THIS IS AN ATTRIBUTION, NOT A SYMPTOM, and it is the one §32 was missing. When
 * the dep is `react.js` the consequence is exact and not a guess: hooks are
 * registered against one dispatcher module and read through another, which is
 * `Warning: Invalid hook call` followed by `Cannot read properties of null
 * (reading 'useReducer')` -- the console lines §32 recorded in <GridProvider>
 * and could not explain. It is checked FIRST among the failure kinds because it
 * explains BOTH shapes the failure takes: a page that never mounts at all, and
 * one that mounts the root error boundary instead of the app.
 */
export function probeShowsDuplicateDeps(probe: StartupProbe): string[] {
  return collectDuplicateDepVersions(probe.depUrls);
}

/**
 * The origins a legitimately-launched app can be on. Anything else -- a page
 * parked at `about:blank`, a WebView2 error page, a `data:` URL -- is the third
 * shape of infrastructure failure wearing product failure's clothes.
 */
export function isExpectedOrigin(url: string, vitePort: number): boolean {
  const u = url.trim().toLowerCase();
  return (
    u.startsWith(`http://localhost:${vitePort}`) ||
    u.startsWith(`http://127.0.0.1:${vitePort}`) ||
    u.startsWith("tauri://localhost") ||
    u.startsWith("http://tauri.localhost") ||
    u.startsWith("https://tauri.localhost")
  );
}

/**
 * The fields whose CHANGE means the launch is still getting somewhere. Compared
 * as a string so "anything moved" is one comparison; the network counter is the
 * signal that carries a cold module-graph transform (which changes nothing else
 * for tens of seconds), and the rest catch a page that navigates, finishes
 * loading, or reaches main.tsx's body.
 */
export function progressKey(probe: StartupProbe | null): string {
  if (!probe) return "(no page)";
  return [
    probe.url,
    probe.readyState,
    probe.rootChildCount,
    probe.calcImportPresent ? "calcImport" : "-",
    probe.tauriBridgePresent ? "tauri" : "-",
    probe.resourceCount,
    probe.networkResponses,
  ].join("|");
}

/**
 * Is the page still waiting for something? `"complete"` means the load event has
 * fired and no subresource is outstanding -- so an empty `#root` at that point
 * is FINAL, not early. Anything else (`"loading"`, `"interactive"`) means the
 * browser is still blocked on a request, which on this stack means blocked on
 * Vite. An unreadable page is treated as NOT pending, because the patient arm
 * must not be claimed on evidence nobody has.
 */
export function documentIsPending(probe: StartupProbe): boolean {
  return probe.readyState !== "complete" && probe.readyState !== "(unreadable)";
}

// ---------------------------------------------------------------------------
// The barrier
// ---------------------------------------------------------------------------

export type MountFailureKind =
  /** The CDP endpoint that global-setup just proved ready would not connect. */
  | "cdp-unreachable"
  /** No page/target at all to read. */
  | "no-page"
  /** A page, on an origin the app is never served from. */
  | "wrong-origin"
  /**
   * `#root` empty, the document COMPLETE (so nothing is pending) and nothing has
   * moved for the stall window. This is BUG-0082's measured signature.
   */
  | "never-mounted-stalled"
  /**
   * `#root` empty and the document still LOADING: the page is blocked on the dev
   * server, which has not answered for the (much longer) server-silence window.
   */
  | "dev-server-not-answering"
  /** `#root` empty at the absolute cap, though the page was still moving. */
  | "never-mounted-cap"
  /** Mounted, but `window.__TAURI__` is absent -- every spec would fail. */
  | "no-tauri-bridge"
  /**
   * React ran and rendered the ROOT ERROR BOUNDARY: the product threw during
   * boot. `#root` is non-empty, so this is not BUG-0082 -- but every spec would
   * still fail on the spreadsheet selector, so it is reported here, once, with
   * the error the boundary caught.
   */
  | "boot-error"
  /**
   * The page loaded the same pre-bundled dependency under more than one Vite
   * optimiser hash: it holds two Reacts. Named separately from every other kind
   * because it is neither a product failure nor a slow start -- it is the dev
   * server having served an incoherent module graph, and the remedy is a
   * command, not a debugging session.
   */
  | "duplicate-deps";

export interface MountSuccess {
  ok: true;
  elapsedMs: number;
  samples: number;
  probe: StartupProbe;
}

export interface MountFailure {
  ok: false;
  kind: MountFailureKind;
  elapsedMs: number;
  /** How long nothing had changed when the barrier gave up. */
  quietMs: number;
  samples: number;
  probe: StartupProbe | null;
  survey: StartupSurvey | null;
  /** The underlying error, when the failure was an exception rather than a state. */
  cause?: unknown;
  /** Console/pageerror lines the barrier heard while it waited. */
  consoleTail?: string[];
  /** Deps the page loaded under more than one optimiser hash (`duplicate-deps`). */
  duplicateDeps?: string[];
}

export type MountOutcome = MountSuccess | MountFailure;

export interface MountBarrierOptions {
  /**
   * Read the page. Resolves `null` when there is no page/target yet -- an
   * ABSENCE, which the barrier reports as such rather than as an empty page.
   */
  readProbe: () => Promise<{ probe: StartupProbe | null; survey: StartupSurvey | null }>;
  /** Absolute ceiling. Exceeding it is a NAMED failure, never a retry. */
  capMs: number;
  /**
   * No progress for this long, with `#root` empty and the document COMPLETE, is
   * a NAMED failure. Nothing is pending, so nothing is coming.
   */
  stallMs: number;
  /**
   * No progress for this long while the document is still LOADING. Much longer
   * than `stallMs`, because a page waiting on the dev server is waiting on work
   * that is genuinely happening somewhere else (measured: 218s of total silence
   * during one Vite dependency re-optimisation).
   */
  serverSilentMs: number;
  pollMs: number;
  vitePort: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  /** Called once per reading, so a long wait is not a silent one. */
  onSample?: (probe: StartupProbe | null, elapsedMs: number) => void;
}

/**
 * Wait until the frontend mounts, or name the reason it did not.
 *
 * THE BOUND IS A STALL WINDOW, NOT A DEADLINE, and that is the whole design.
 * BUG-0082 measured one cold mount at ~55 s against a 60 s fixture ceiling, and
 * turning that single sample into a hard limit is how a guard becomes a flake
 * generator on a colder machine. What actually distinguishes "slow" from "dead"
 * is whether the launch is still DOING anything:
 *
 *   * anything moves (a resource completes, a navigation, readyState, a child
 *     under `#root`) -> keep waiting, however long it takes;
 *   * nothing moves for `stallMs` while `#root` is empty AND the document is
 *     COMPLETE -> FAIL, named. Nothing is pending, so nothing is coming;
 *   * nothing moves while the document is still LOADING -> keep waiting up to
 *     the much longer `serverSilentMs`, then FAIL with a DIFFERENT name: the
 *     page is blocked on the dev server, not broken;
 *   * `capMs` reached at all -> FAIL, named differently again, because "still
 *     going after fifteen minutes" is a different bug from "stopped".
 *
 * THE DOCUMENT-READINESS SPLIT IS MEASURED, NOT REASONED (§32). A cold start
 * with `app/node_modules/.vite` deleted sat SILENT for 218 SECONDS -- two
 * resources loaded at 12 s and the next at 231 s -- because the page was blocked
 * on a single `/src/main.tsx` request while Vite re-optimised its dependencies.
 * A stall window over network activity alone would have failed that healthy (if
 * pathological) launch at 57 s. Throughout the silence `document.readyState` was
 * `"interactive"`; when the same launch reached the BUG-0082 state minutes later
 * it was `"complete"` -- with the resource count frozen (167 on the first load,
 * 250 after a reload) and `#root` still empty for the following ten minutes.
 * That one field separates "waiting on work happening elsewhere" from "this page
 * is finished and it did not mount".
 *
 * Mounted-but-no-`window.__TAURI__` is also a failure, and deliberately not a
 * warning: it is the documented signature of a run launched without
 * `src-tauri/tauri.e2e.conf.json`, where every single spec fails on
 * `page.evaluate(() => window.__TAURI__...)` and the report again reads as a
 * product collapse.
 */
export async function waitForMount(opts: MountBarrierOptions): Promise<MountOutcome> {
  const now = opts.now ?? (() => Date.now());
  const sleep =
    opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));

  const start = now();
  let lastKey: string | null = null;
  let lastProgressAt = start;
  let samples = 0;

  for (;;) {
    const { probe, survey } = await opts.readProbe();
    samples++;
    const elapsedMs = now() - start;
    opts.onSample?.(probe, elapsedMs);

    const key = progressKey(probe);
    if (key !== lastKey) {
      lastKey = key;
      lastProgressAt = now();
    }

    // DUPLICATED DEPENDENCIES ARE TERMINAL AND SELF-EVIDENT, so they are decided
    // before anything else and WITHOUT waiting out a stall window. The page is
    // holding two copies of a module; nothing it does from here can undo that,
    // and Vite's own repair (a `full-reload` over HMR) is switched off for E2E.
    // Waiting 45 more seconds to say so would only delay the answer -- and if
    // the app DID mount despite it, the state is still incoherent and every
    // spec after it would be running against a page with two Reacts.
    if (probe) {
      const duplicates = probeShowsDuplicateDeps(probe);
      if (duplicates.length > 0) {
        return {
          ok: false,
          kind: "duplicate-deps",
          elapsedMs,
          quietMs: now() - lastProgressAt,
          samples,
          probe,
          survey,
          duplicateDeps: duplicates,
        };
      }
    }

    if (probe && probeIsMounted(probe)) {
      // ORDER MATTERS. The boot-error check comes FIRST because the root error
      // boundary's panel is itself a child of `#root`: accepting the mount and
      // then testing the bridge would pass a crashed app straight through to the
      // specs. It is checked here rather than as a separate wait because a
      // boundary that has rendered is terminal -- nothing re-renders the app.
      if (probeShowsBootError(probe)) {
        return {
          ok: false,
          kind: "boot-error",
          elapsedMs,
          quietMs: now() - lastProgressAt,
          samples,
          probe,
          survey,
        };
      }
      if (!probe.tauriBridgePresent) {
        return {
          ok: false,
          kind: "no-tauri-bridge",
          elapsedMs,
          quietMs: now() - lastProgressAt,
          samples,
          probe,
          survey,
        };
      }
      return { ok: true, elapsedMs, samples, probe };
    }

    const quietMs = now() - lastProgressAt;
    const capReached = elapsedMs >= opts.capMs;
    // WHICH quiet window applies depends on whether the page is still waiting on
    // the server. A page with nothing outstanding gets the short one; a page
    // blocked on Vite gets the long one, because the measured cost of getting
    // that wrong is failing a healthy launch at 57s that would have mounted.
    const pending = probe !== null && documentIsPending(probe);
    const quietBudget = pending ? opts.serverSilentMs : opts.stallMs;
    const quietExceeded = quietMs >= quietBudget;
    if (capReached || quietExceeded) {
      const kind: MountFailureKind = !probe
        ? "no-page"
        : !isExpectedOrigin(probe.url, opts.vitePort)
          ? "wrong-origin"
          : !quietExceeded
            ? "never-mounted-cap"
            : pending
              ? "dev-server-not-answering"
              : "never-mounted-stalled";
      return { ok: false, kind, elapsedMs, quietMs, samples, probe, survey };
    }

    await sleep(opts.pollMs);
  }
}

// ---------------------------------------------------------------------------
// The wording -- pure, because the wording IS the guard
// ---------------------------------------------------------------------------

const RULE =
  "==============================================================================";

function evidenceBlock(f: MountFailure): string {
  const p = f.probe;
  const lines = [
    `  elapsed:            ${(f.elapsedMs / 1000).toFixed(1)}s over ${f.samples} reading(s)`,
    `  nothing changed for:${(f.quietMs / 1000).toFixed(1)}s`,
  ];
  if (p) {
    lines.push(
      `  url:                ${p.url}`,
      `  document.readyState:${p.readyState}`,
      `  document.title:     ${p.title}`,
      `  #root children:     ${p.rootChildCount < 0 ? "(page unreadable)" : p.rootChildCount}`,
      `  spreadsheet:        ${p.spreadsheetPresent ? "present" : "ABSENT"}`,
      `  window.__TAURI__:   ${p.tauriBridgePresent ? "present" : "ABSENT"}`,
      `  window.__calcImport:${p.calcImportPresent ? "present" : "ABSENT"}`,
      `  resources loaded:   ${p.resourceCount < 0 ? "(page unreadable)" : p.resourceCount}`,
      `  network responses:  ${
        p.networkResponses < 0 ? "(not instrumented)" : p.networkResponses
      }`,
    );
    // Printed only when it is there, because "root error boundary: absent" on
    // every ordinary startup failure would train the reader to skip the line
    // that matters most on the one occasion it is present.
    if (p.bootErrorText !== null) {
      lines.push(`  ROOT ERROR BOUNDARY IS ON SCREEN (found by ${p.bootErrorSignal}).`);
      // A fallback hit is ITSELF a finding: the panel was identified without its
      // `data-testid`, which means a build step has removed the attribute the
      // guard used to depend on exclusively. Said here, once, at the moment it
      // is observable -- silent degradation is what this whole file is about.
      if (p.bootErrorSignal === "role+text") {
        lines.push(
          "  NOTE: the `data-testid` was ABSENT and the panel was recognised by its",
          "  role+text fallback. That is a build/tooling change worth chasing --",
          "  see e2e/pageState.ts and bootErrorMarkerSurvivesBuild.test.ts.",
        );
      }
      lines.push("  It reported:");
      for (const l of p.bootErrorText.split("\n")) lines.push(`    ${l}`);
    }
    // Printed only when there ARE duplicates, for the same reason the boundary
    // line is: a "duplicated dependencies: none" on every ordinary failure
    // trains the reader past the line that matters.
    if (f.duplicateDeps && f.duplicateDeps.length > 0) {
      lines.push("  THE PAGE HOLDS MORE THAN ONE COPY OF THESE DEPENDENCIES:");
      for (const d of f.duplicateDeps) lines.push(`    ${d}`);
    }
  } else {
    lines.push("  (no page/target could be read at all)");
  }
  if (f.survey) {
    lines.push(
      `  pages seen:         ${f.survey.pageCount}${
        f.survey.urls.length > 0 ? ` -> ${f.survey.urls.join(", ")}` : ""
      }`,
    );
  }
  if (f.cause !== undefined) {
    lines.push(
      `  underlying error:   ${
        f.cause instanceof Error ? f.cause.message : String(f.cause)
      }`,
    );
  }
  // THE CONSOLE TAIL IS THE ATTRIBUTION, and its absence has to be stated as an
  // absence -- silence about the console reads as "the console was clean". On
  // the live reproduction of §32 these lines carried the answer outright:
  // "Invalid hook call" and "Cannot read properties of null (reading
  // 'useReducer')" in <GridProvider>.
  if (f.consoleTail && f.consoleTail.length > 0) {
    lines.push("  last console output:");
    for (const l of f.consoleTail) lines.push(`    ${l}`);
  } else {
    lines.push("  console:            the page produced NO output to attribute it with");
  }
  return lines.join("\n");
}

/**
 * The headline and the "what to check" list for each way a launch can be dead
 * on arrival. Every arm ends the same way -- this run has no test results --
 * because that is the sentence the reader has to act on, and the absence of it
 * is what cost BUG-0082 three debugging sessions.
 */
export function describeStartupFailure(f: MountFailure): string {
  let headline: string;
  let causes: string[];

  switch (f.kind) {
    case "cdp-unreachable":
      headline =
        "THE STARTUP BARRIER COULD NOT REACH THE APPLICATION -- it was never inspected.";
      causes = [
        "The CDP endpoint answered `/json/version` moments earlier and then refused a",
        "connection, so whether the frontend mounted is UNKNOWN. A guard that cannot",
        "run is not a guard that passed, which is why this fails the run rather than",
        "waving it through.",
        "",
        "What to check:",
        "  1. Whether app.exe is still alive (a startup panic exits after the CDP",
        "     endpoint has already been published).",
        "  2. Whether a SECOND launcher took the port. A CDP port is not an identity.",
      ];
      break;
    case "never-mounted-stalled":
      headline = "THE APPLICATION NEVER MOUNTED -- the page finished loading and did not mount.";
      causes = [
        "`#root` is EMPTY, `document.readyState` is `complete` and the resource count",
        "has stopped moving. Nothing is outstanding, so nothing is coming: the module",
        "graph was served and the app did not render. This is BUG-0082's exact",
        "signature, and it is a STARTUP failure, not a slow start.",
        "",
        "What to check, in the order these have actually been the cause:",
        "  1. THE CONSOLE TAIL ABOVE. Reproduced live on 2026-08-15 (§32) after deleting",
        "     `app/node_modules/.vite`: the page loaded 250 resources, reached",
        "     `complete`, and threw `Invalid hook call` + `TypeError: Cannot read",
        "     properties of null (reading 'useReducer')` inside <GridProvider> -- a",
        "     SECOND React instance from a mid-flight Vite dependency re-optimisation.",
        "     Nothing after that ever renders, and the page looks idle and healthy.",
        "  2. Whether the run has HMR disabled (CALCULA_E2E=1). Vite delivers its",
        "     post-re-optimisation `full-reload` over the HMR channel, so with the",
        "     channel cut a re-optimised page is never told to reload.",
        "  3. `window.__calcImport` above dates the failure: present means main.tsx ran",
        "     and threw after installing it; absent means main.tsx never got that far.",
        "  4. Deleting `app/node_modules/.vite` and relaunching REPRODUCES this state on",
        "     demand -- which is also how to prove a fix.",
      ];
      break;
    case "dev-server-not-answering":
      headline =
        "THE APPLICATION NEVER MOUNTED -- the page is still waiting for the dev server.";
      causes = [
        "`#root` is empty and `document.readyState` is NOT `complete`: the browser is",
        "still blocked on a request that Vite has not answered. This is not a broken",
        "frontend -- it is a dev server that has stopped serving, or is taking longer",
        "than any measured launch to answer.",
        "",
        "What to check:",
        "  1. Curl the module directly -- `curl -m 30 http://localhost:5173/src/main.tsx`.",
        "     Measured (§32) on a launch with `app/node_modules/.vite` deleted: that",
        "     request did not answer within 30s while `/@vite/client` took 11.8s, and the",
        "     page sat silent for 218 SECONDS before the graph arrived. A first launch",
        "     after clearing the dep cache legitimately looks like this.",
        "  2. Whether the Vite process is alive at all (the `[tauri]` lines in",
        "     e2e/results/app-dev.log carry its output).",
        "  3. If this machine genuinely needs longer, raise E2E_MOUNT_SERVER_SILENT_MS",
        "     and RECORD the measurement -- do not raise it silently.",
      ];
      break;
    case "never-mounted-cap":
      headline =
        "THE APPLICATION NEVER MOUNTED -- it was still working when the cap ran out.";
      causes = [
        "`#root` is EMPTY, but the page WAS still making progress (responses were still",
        "arriving) when the absolute cap was reached. That is a different animal from a",
        "stall: nothing is wedged, the launch is simply taking longer than any mount",
        "ever measured on this machine.",
        "",
        "What to check:",
        "  1. Whether this machine is genuinely slower (a cold Vite transform on a busy",
        "     box). If so, raise the cap with E2E_MOUNT_CAP_MS and record the measurement",
        "     -- do not raise it silently, and do not raise it on ONE sample.",
        "  2. Whether something is re-fetching in a loop (a reload cycle shows as a URL",
        "     that keeps changing and a response count that never settles).",
      ];
      break;
    case "no-page":
      headline = "THE APPLICATION EXPOSED NO PAGE -- CDP answered, nothing was open.";
      causes = [
        "The CDP endpoint accepted the connection but there is no page/target to read.",
        "",
        "What to check:",
        "  1. Whether the WebView2 window actually opened (a Tauri startup panic exits",
        "     before the window; see e2e/results/app-dev.log).",
        "  2. Whether the CDP port belongs to a DIFFERENT browser -- a port is not an",
        "     identity. Check that app.exe is the process listening on it.",
      ];
      break;
    case "wrong-origin":
      headline =
        "THE APPLICATION IS ON AN ORIGIN IT IS NEVER SERVED FROM -- it never reached the app.";
      causes = [
        "The page is not on the Vite dev origin nor on tauri://localhost, so whatever",
        "the tests would have driven, it is not this product.",
        "",
        "What to check:",
        "  1. `about:blank` or a WebView2 error page means the dev server was not up (or",
        "     not on the expected port) when the window navigated.",
        "  2. A stale CDP port from a previous, unrelated browser -- verify the process",
        "     listening on it is app.exe.",
      ];
      break;
    case "boot-error":
      headline =
        "THE APPLICATION CRASHED ON BOOT -- it rendered its root error boundary, not itself.";
      causes = [
        "React ran, so this is NOT BUG-0082's empty `#root`. What is under `#root` is the",
        "failure panel from `RootErrorBoundary` (BUG-0083), which means a component threw",
        "during the first render. The error and both stacks are printed above -- that is",
        "the attribution, and it is the whole reason the boundary exists.",
        "",
        "THIS IS A PRODUCT FAILURE, but it is ONE failure, not N. Every spec would have",
        "timed out on `[data-focus-container='spreadsheet']` and the report would have",
        "read as a broad regression, which is exactly the misreading BUG-0082 was about.",
        "",
        "What to check:",
        "  1. The panel text above names the surface that failed and the throwing",
        "     component. Fix that; do not re-run hoping for a different result -- a boot",
        "     throw is deterministic in a way a startup stall is not.",
        "  2. If the panel text looks like a dependency/hook error rather than product",
        "     logic (`Invalid hook call`, a null `useReducer`), suspect a duplicated React",
        "     from a mid-flight Vite dep re-optimisation and delete `app/node_modules/.vite`",
        "     before blaming the code (§32).",
      ];
      break;
    case "duplicate-deps":
      headline =
        "THE DEV SERVER SERVED TWO COPIES OF THE SAME DEPENDENCY -- the page has two Reacts.";
      causes = [
        "The page fetched `/node_modules/.vite/deps/<dep>.js?v=<hash>` under MORE THAN ONE",
        "hash (listed above). The `?v=` identifies Vite's optimiser run, so two hashes are",
        "two URLs, two module instances, two React dispatchers -- hooks registered against",
        "one and read through the other. That is `Warning: Invalid hook call` followed by",
        "`Cannot read properties of null (reading 'useReducer')`, and nothing renders.",
        "",
        "THIS IS NOT A PRODUCT FAILURE and it is not random. Vite pre-bundles dependencies",
        "into `node_modules/.vite/deps_temp_<hash>/` and RENAMES that directory onto",
        "`deps/`. When something holds a handle inside it the rename fails with EBUSY, the",
        "server has no usable cache, and it discovers dependencies request-by-request while",
        "the page is ALREADY LOADING. Measured on this tree: 3 of 10 optimiser runs failed",
        "that way, and 4 of 11 cold-cache launches served react.js under FOUR hashes.",
        "",
        "Vite's own repair is a `full-reload` over the HMR channel, and E2E runs set",
        "CALCULA_E2E=1 which disables HMR on purpose (a stray fast-refresh resets the grid",
        "mid-capture). So under test the page NEVER recovers: BUG-0082, open-decisions §32.",
        "",
        "What to do, in order:",
        "  1. `cd app && node scripts/ensure-dep-cache.mjs` -- rebuilds the cache to",
        "     completion, retrying the EBUSY, then relaunch. This normally runs by itself",
        "     as npm's `predev`; reaching this banner means it was skipped or it gave up.",
        "  2. `cd app && npm run dropbox:check`. This repository lives inside a Dropbox",
        "     tree, and `app/node_modules` was being synced -- Dropbox opening the freshly",
        "     written bundles is what made the rename fail. `npm run dropbox:ignore` marks",
        "     the build trees so it stops. (An antivirus or the Windows indexer can hold",
        "     the same handle; the retry in step 1 covers those.)",
        "  3. If it persists, look for `deps_temp_*` directories left in",
        "     `app/node_modules/.vite/` -- each one is a rename that failed.",
      ];
      break;
    case "no-tauri-bridge":
      headline =
        "THE FRONTEND MOUNTED BUT THE TAURI BRIDGE IS ABSENT -- every spec would fail.";
      causes = [
        "`#root` has children, so the app is up, but `window.__TAURI__` is undefined.",
        "The harness drives the app through it from `page.evaluate`, so EVERY spec that",
        "touches the backend fails, one identical failure at a time.",
        "",
        "What to check:",
        "  1. The app was launched WITHOUT `--config src-tauri/tauri.e2e.conf.json`.",
        "     That overlay is what re-enables `withGlobalTauri`; a plain `tauri dev`",
        "     produces exactly this state.",
        "  2. A production build was launched instead of the dev one.",
      ];
      break;
  }

  // THE VERDICT LINE IS NOT SHARED, because it is an attribution and one arm
  // attributes the opposite way. Every other kind is infrastructure and must
  // say "do not open a bug against the product"; `boot-error` IS the product,
  // and telling the reader to re-launch would send them round a loop that a
  // deterministic boot throw can never break. A guard that misattributes is the
  // failure mode this whole programme exists to delete, so the two are split.
  const verdict =
    f.kind === "boot-error"
      ? [
          "  THIS RUN HAS NO TEST RESULTS, and this one IS a product failure -- but it is",
          "  ONE failure, reported once. Do not re-run expecting a different outcome: fix",
          "  the throw named below. (BUG-0083; reported here by BUG-0082's guard, §32.)",
        ]
      : [
          "  THIS RUN HAS NO TEST RESULTS -- it is a HARNESS/STARTUP failure, NOT a product",
          "  failure. Do not read any number out of it, and do not open a bug against the",
          "  product for it. Re-launch and re-run. (BUG-0082, open-decisions §32.)",
        ];

  return [
    "",
    RULE,
    `  ${headline}`,
    ...verdict,
    RULE,
    evidenceBlock(f),
    RULE,
    ...causes.map((l) => (l === "" ? "" : `  ${l}`)),
    RULE,
    "",
  ].join("\n");
}

/**
 * The end-of-run banner, printed by the ONE guard reporter from the marker.
 *
 * TWO ARMS, because the two ways here are not the same event. The barrier
 * refusing the run at global-setup produces NO test results, and saying "the 0
 * failures in this report are not test results" would be gibberish; a worker
 * that found the app unmounted LATER leaves N failures behind, and the banner's
 * whole job there is to say what those N numbers are worth.
 */
export function startupFailureBanner(detail: string, failedTests: number): string {
  const verdict =
    failedTests > 0
      ? [
          `  The ${failedTests} failure(s) in this report are NOT test results: the harness was`,
          "  driving a page whose `#root` was empty. Re-launch and re-run before reading any",
          "  number out of it. (BUG-0082, §32.)",
          "  ONE CAVEAT, because this arm cannot tell the two apart: the startup barrier",
          "  verified the app WAS mounted before the first test, so something unmounted it",
          "  during the run. That is usually infrastructure -- but a spec that deliberately",
          "  reloads the frontend (the `journey` project has several) is a product suspect,",
          "  and this banner does not exonerate it.",
        ]
      : [
          "  NO test results were produced, and that is the CORRECT outcome: the startup",
          "  barrier refused the run before the first test rather than letting the harness",
          "  report this as N product failures. Re-launch and re-run. (BUG-0082, §32.)",
        ];
  return [
    "",
    RULE,
    "  THE APPLICATION WAS NOT MOUNTED DURING THIS RUN.",
    ...verdict,
    RULE,
    ...detail.split("\n").map((l) => `  ${l}`),
    RULE,
    "",
  ].join("\n");
}

/**
 * The one line a HEALTHY run prints. It exists to accumulate the samples
 * BUG-0082 was closed without: every run now records how long this machine took
 * to mount, so the next person to argue about a ceiling argues from a series.
 */
export function describeMountSuccess(s: MountSuccess): string {
  const secs = (s.elapsedMs / 1000).toFixed(1);
  const slow = s.elapsedMs >= 20_000;
  return (
    `[startup-guard] the frontend mounted after ${secs}s ` +
    `(${s.samples} reading(s), ${
      s.probe.resourceCount < 0 ? "resource count unreadable" : `${s.probe.resourceCount} resources`
    }, readyState ${s.probe.readyState})` +
    (slow
      ? ` -- SLOW. The fixture's own first-selector ceiling is 60s; a mount this` +
        ` close to it is the BUG-0082 shape and is worth recording.`
      : "")
  );
}

/** Append one mount timing to the run log. Evidence, not reporting; never throws. */
export function recordMountTiming(elapsedMs: number, mounted: boolean, note: string): void {
  try {
    const file = path.join(HERE, "results", "mount-timings.log");
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(
      file,
      `${new Date().toISOString()}\t${mounted ? "mounted" : "FAILED"}\t${elapsedMs}ms\t${note}\n`,
      "utf-8",
    );
  } catch {
    /* a timing we cannot record must not stop the run */
  }
}

// ---------------------------------------------------------------------------
// The escape hatch -- loud, like COLLECTION_GUARD=off
// ---------------------------------------------------------------------------

/** True when the barrier is switched off. Says so on stderr; never silent. */
export function startupGuardDisabled(env: NodeJS.ProcessEnv = process.env): boolean {
  if (env.STARTUP_GUARD !== "off") return false;
  console.error(
    "[startup-guard] DISABLED via STARTUP_GUARD=off -- this run will NOT verify that" +
      " the application actually mounted before the first test. If every test fails" +
      " on the same selector, that is what you are looking at (BUG-0082).",
  );
  return true;
}

/** The barrier's two bounds, from the environment, with the measured defaults. */
export function mountBounds(env: NodeJS.ProcessEnv = process.env): {
  capMs: number;
  stallMs: number;
  serverSilentMs: number;
  pollMs: number;
} {
  const num = (v: string | undefined, dflt: number): number => {
    const n = Number(v);
    return Number.isFinite(n) && n > 0 ? n : dflt;
  };
  return {
    // THE ANTI-HANG BACKSTOP, not the detector. 15 minutes is above every launch
    // measured on this machine including the pathological one (§32: 231s to the
    // first module response with the dep cache deleted, ~250s to `complete`).
    // A hang that is invisible to exit status is the failure mode this programme
    // keeps deleting, so there is an upper bound at all -- but exceeding it is a
    // NAMED failure, never a retry.
    capMs: num(env.E2E_MOUNT_CAP_MS, 900_000),
    // THE DETECTOR. Applies only when `document.readyState === "complete"`, i.e.
    // when the page has nothing outstanding: measured on the live reproduction,
    // that state persisted unchanged for 171s and then for a further 10 minutes
    // with the resource count frozen at 250. Nothing legitimate sits there. 45s
    // is generous for a state that never recovers.
    stallMs: num(env.E2E_MOUNT_STALL_MS, 45_000),
    // THE PATIENT ARM, for a page still waiting on Vite. The worst silence
    // measured on this tree is 218s -- two resources at 12s, the next at 231s --
    // on a launch with `app/node_modules/.vite` deleted, while the browser
    // blocked on one `/src/main.tsx` request. That is ONE sample (the repeat of
    // the same setup mounted in 7.8s, max quiet 2.1s), which is exactly why this
    // arm is set by patience rather than by fit: 300s is ~1.4x the worst seen,
    // it only ever applies while the document is still LOADING, and being wrong
    // here costs a wait, whereas being wrong the other way fails a healthy run.
    serverSilentMs: num(env.E2E_MOUNT_SERVER_SILENT_MS, 300_000),
    pollMs: num(env.E2E_MOUNT_POLL_MS, 1_000),
  };
}
