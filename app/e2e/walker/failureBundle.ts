//! FILENAME: app/e2e/walker/failureBundle.ts
// PURPOSE: ONE implementation of "a walk failed — write down everything the
//          next person needs". Used by the soak walk AND by the invariant
//          walk, which used to have neither a bundle nor a minimiser.
//
// A bundle is a directory:
//
//   <resultsDir>/failures/<runId>/
//     trace.json            the original failing trace (replayable as-is)
//     minimized.trace.json  the ddmin-reduced repro (when minimization ran)
//     failure.json          violation, shrink outcome, and the EXACT commands
//                           that replay both the run and the reduced trace
//     diagnostics.json      console ring, per-action timings, oracle
//                           checkpoint timings, script-host probe, app log tail
//     report.md             the human-readable version of all of it
//     app-dev.log.tail      the app's own stdout, when it was being recorded
//
// TWO LESSONS ARE BUILT IN, both from the pass that found them:
//
//   1. A SHRINK MUST NOT DISCARD ITS OWN ANSWER. `minimizeTrace` matches only
//      the original violation id, so a replay that fails a DIFFERENT way used
//      to be recorded exactly like a replay that passed. `failure.json` now
//      always carries `shrinkOtherOutcomes` and the report prints it in
//      English, because "twelve of twelve replays failed with no-js-exceptions"
//      is a finding, not an absence of one.
//
//   2. "USE THIS SEED TO REPLAY" MUST BE TRUE. The report said it while the
//      spec read `Date.now()` and offered no way to inject a seed. Every bundle
//      records the seed AND the literal command line that reproduces it, and
//      the harness that writes the bundle is the one that guarantees the seed
//      is injectable (INVARIANT_SEED / SOAK_SEED).

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import type { Page } from "@playwright/test";
import { getConsoleLog } from "../invariants/stateSnapshot";
import type { ConsoleLog } from "../invariants/stateSnapshot";
import { saveTrace } from "./trace";
import { minimizeTrace } from "./shrinker";
import type { ReplayFn, ShrinkResult } from "./shrinker";
import { formatWalkReport } from "./walkRunner";
import type { ActionTiming, WalkResult } from "./walkRunner";

// ============================================================================
// App log
// ============================================================================

/**
 * Where the app's own stdout is recorded, when anything is recording it:
 * `global-setup.ts` tees `tauri dev` here, and so does the manual launcher
 * (`scratchpad/launch-vba-batch.ps1`). Overridable with E2E_APP_LOG.
 *
 * A walker failure that shows nothing in the browser console is usually the
 * BACKEND saying something, and until now no bundle could contain a single
 * line of it.
 */
const HERE = path.dirname(fileURLToPath(import.meta.url));

export function appLogPath(): string {
  if (process.env.E2E_APP_LOG) return path.resolve(process.env.E2E_APP_LOG);
  return path.resolve(HERE, "../results/app-dev.log");
}

/**
 * Decode a log tail whoever wrote it.
 *
 * The manual launcher used to tee through PowerShell 5.1's `Tee-Object`, which
 * has no `-Encoding` and writes UTF-16LE; read as UTF-8 that is one NUL between
 * every character, and the bundle would have carried unreadable mojibake as its
 * only record of the backend. The launcher writes BOM-less UTF-8 now, but a log
 * is written by whatever the operator happened to run, so the READER is the
 * right place to be tolerant.
 */
function decodeLogBytes(buf: Buffer): string {
  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) {
    return buf.subarray(2).toString("utf16le");
  }
  if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) {
    return buf.subarray(3).toString("utf8");
  }
  // No BOM. A tail slice can start mid-character, so sniff instead: UTF-16LE
  // ASCII text is half NUL bytes, which UTF-8 text never is.
  const sample = buf.subarray(0, Math.min(buf.length, 512));
  let nuls = 0;
  for (const b of sample) if (b === 0) nuls++;
  if (sample.length > 0 && nuls / sample.length > 0.3) {
    return buf.toString("utf16le");
  }
  return buf.toString("utf8");
}

/** Last `maxBytes` of the app log, or null when nothing was recording it. */
function readAppLogTail(maxBytes = 256 * 1024): { path: string; tail: string } | null {
  const p = appLogPath();
  try {
    const stat = fs.statSync(p);
    const start = Math.max(0, stat.size - maxBytes);
    const fd = fs.openSync(p, "r");
    try {
      const length = stat.size - start;
      const buf = Buffer.alloc(length);
      fs.readSync(fd, buf, 0, length, start);
      // Read the BOM too when the whole file fits, so the sniff has it.
      return { path: p, tail: decodeLogBytes(buf) };
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return null;
  }
}

// ============================================================================
// Script-host probe
// ============================================================================

export interface ScriptHostProbe {
  available: boolean;
  mounted?: Array<{ id: string; instanceId?: string | null; tier?: string | null }>;
  registered?: string[];
  error?: string;
}

/**
 * What the object-script realm looked like at the moment of failure.
 *
 * S13 was a script-mount timeout, and the bundle could not say whether ANY
 * script was mounted, let alone which. This never throws: a probe that can
 * fail the run it is diagnosing is worse than no probe.
 */
export async function probeScriptHost(page: Page): Promise<ScriptHostProbe> {
  try {
    const result = await page.evaluate(async () => {
      const w = window as any;
      if (typeof w.__calcImport !== "function") {
        return { available: false as const };
      }
      const api = await w.__calcImport(
        new URL("/src/api/index.ts", document.baseURI).href
      );
      const mgr = api?.ObjectScriptManager;
      if (!mgr) return { available: false as const };
      const defs: any[] = mgr.getAllScripts?.() ?? [];
      const registered: string[] = defs.map((d: any) => d?.id ?? String(d));
      const mounted = defs
        .filter((d: any) => {
          try {
            return mgr.isScriptMounted?.(d?.id) === true;
          } catch {
            return false;
          }
        })
        .map((d: any) => ({
          id: d?.id,
          instanceId: d?.instanceId ?? null,
          tier: d?.accessLevel ?? null,
        }));
      return { available: true as const, registered, mounted };
    });
    return result as ScriptHostProbe;
  } catch (err) {
    return { available: false, error: (err as Error).message ?? String(err) };
  }
}

// ============================================================================
// Bundle
// ============================================================================

export interface FailureBundleOptions {
  /** The failing walk. */
  result: WalkResult;
  /** Live page, used for the diagnostic probe. Omit when it is gone. */
  page?: Page | null;
  /** Root results directory; the bundle lands in `<resultsDir>/failures/<runId>`. */
  resultsDir: string;
  /** Which harness produced this — "soak", "invariant", ... */
  harness: string;
  /** Seed that generated the walk (null for a trace replay). */
  seed: number | null;
  /** Literal command that re-runs the WHOLE walk. Must actually work. */
  replayCommand: string;
  /**
   * Replays a candidate trace from a clean workbook. Omit to skip minimization
   * entirely (there is nothing to minimize on a crash).
   */
  replay?: ReplayFn | null;
  /** Cap on shrink replays (default 30). */
  shrinkMaxReplays?: number;
  /** Wall-clock budget for the shrink (default 15 minutes). */
  shrinkTimeBudgetMs?: number;
  /** Extra fields recorded verbatim in failure.json. */
  extra?: Record<string, unknown>;
}

export interface FailureBundle {
  dir: string;
  /** The report, including the shrink outcome when minimization ran. */
  report: string;
  shrink: ShrinkResult | null;
  minimizedTracePath: string | null;
}

export interface RealmConnection {
  /** Walk step the realm started connecting during. */
  step: number;
  /** ms since tracking started. */
  atMs: number;
  /** ms from "connecting..." to "connected." — null when it never connected. */
  connectedAfterMs: number | null;
  /** The action that was executing, for correlation. */
  action: string | null;
}

/**
 * Every Vite client connection in the console — i.e. every new JS REALM.
 *
 * In a Vite dev build each realm loads `/@vite/client` and announces itself
 * with `[vite] connecting...` then `[vite] connected.`. That is the page on
 * load AND **every Web Worker on spawn**, which makes this the only direct
 * observation of worker-spawn timing the harness has.
 *
 * THIS WAS ALMOST SHIPPED AS A "the app was restarted under the test"
 * DETECTOR, and it would have been wrong. The first real bundle showed four
 * connect pairs and an app that died; read as reloads they said "`tauri dev`
 * rebuilt underneath you". Checked against the trace, all four landed on
 * exactly the four `script.shape-mount` steps (6, 60, 63, 66) and on no other
 * step — they were worker spawns, and the reload story was invented. So the
 * bundle REPORTS the connections and their correlation, and does not diagnose:
 * a heuristic must not decide what a failure means.
 *
 * The useful half survives, and it is the half S13 needs: a `connecting...`
 * with no `connected.`, or a long gap between the two, is a worker that did not
 * come up — which is what a ten-second mount deadline expiring looks like from
 * the page's side.
 */
function realmConnections(
  consoleLog: ConsoleLog,
  timings: ActionTiming[]
): RealmConnection[] {
  const actionByStep = new Map<number, string>();
  for (const t of timings) actionByStep.set(t.step, t.id);

  const out: RealmConnection[] = [];
  const entries = consoleLog.entries;
  for (let i = 0; i < entries.length; i++) {
    if (!entries[i].text.includes("[vite] connecting")) continue;
    let connectedAfterMs: number | null = null;
    for (let j = i + 1; j < entries.length; j++) {
      if (entries[j].text.includes("[vite] connected")) {
        connectedAfterMs = entries[j].atMs - entries[i].atMs;
        break;
      }
      if (entries[j].text.includes("[vite] connecting")) break; // a different realm
    }
    out.push({
      step: entries[i].step,
      atMs: entries[i].atMs,
      connectedAfterMs,
      action: actionByStep.get(entries[i].step) ?? null,
    });
  }
  return out;
}

/**
 * Why minimization was skipped, or null when it can run.
 *
 * THE FIRST VERSION OF THIS CALLED A CRASH "a harness failure, not a product
 * one — the trace is not what went wrong", which is exactly backwards and was
 * caught by the first real bundle this code wrote: the app had died, and the
 * bundle told its reader to look elsewhere. `page-crashed` is the most serious
 * result this walker can produce. The reason it is not minimized IN-SPEC is
 * mechanical — every replay needs a live page and there isn't one — so the
 * bundle has to say that, and say what to do instead.
 */
export function skipShrinkReason(violationId: string): string | null {
  if (violationId === "page-crashed") {
    return (
      `not minimized in-spec: the app was GONE, so no replay could run — not ` +
      `because this is a lesser failure. Before filing it as a product crash, ` +
      `rule out the harness losing its app: under \`tauri dev\` an edit to the ` +
      `Rust crate (by anyone, including another agent in the same tree) tears ` +
      `the application down and rebuilds it mid-run. Then relaunch ` +
      `(scratchpad/launch-vba-batch.ps1) and run the "originalTrace" command ` +
      `below — replaying the recorded actions against a fresh app is the only ` +
      `way to learn whether the crash is reproducible.`
    );
  }
  if (violationId === "oracle-infrastructure") {
    return (
      `not minimized: "oracle-infrastructure" means the oracle battery itself ` +
      `threw, so the trace is not what went wrong. Read the violation message.`
    );
  }
  if (violationId === "undo-evidence-missing") {
    // MEASURED 2026-08-16, invariant seed 20260816102. The rapid-fire walk
    // failed `undo-evidence-missing` and the shrinker then ran 16+ replays,
    // EVERY ONE OF WHICH PASSED, because the replay paths construct their
    // `OracleBattery` with `requireUndoEvidence: false` -- deliberately, so a
    // one-action candidate is not judged on undo evidence. The verdict being
    // minimized is therefore one the replay function can never return: ddmin
    // reduces nothing, burns up to 30 replays and 15 minutes, and writes a
    // bundle whose "could not reduce" reads like a failed reproduction.
    //
    // It is also the wrong question. This verdict is not a property of the
    // TRACE, it is a property of the walk's CONFIGURATION -- the oracle cadence
    // measured against how often the generated action mix ends the undo
    // history. No subset of the actions is "the minimal reproducer"; the whole
    // walk is, and the fix is a number in the spec.
    return (
      `not minimized: "undo-evidence-missing" is a property of the WALK'S ` +
      `CONFIGURATION (oracle cadence vs how often the action mix ends the undo ` +
      `history), not of the trace — no subset of these actions is a smaller ` +
      `reproducer. Minimizing it is also impossible by construction: the replay ` +
      `paths set \`requireUndoEvidence: false\`, so every candidate PASSES and ` +
      `ddmin reduces nothing. Read the violation message, which names the three ` +
      `spec-level fixes, and see \`rebaseActions\` in the details for which ` +
      `actions were ending the history.`
    );
  }
  return null;
}

export async function writeFailureBundle(
  options: FailureBundleOptions
): Promise<FailureBundle> {
  const {
    result,
    page = null,
    resultsDir,
    harness,
    seed,
    replayCommand,
    replay = null,
    shrinkMaxReplays = 30,
    shrinkTimeBudgetMs = 15 * 60 * 1000,
    extra = {},
  } = options;

  const violationId = result.violation?.invariantId ?? "unknown";
  const runId = `${new Date().toISOString().replace(/[:.]/g, "-")}-${harness}-${violationId}`;
  const dir = path.join(resultsDir, "failures", runId);
  fs.mkdirSync(dir, { recursive: true });

  const tracePath = path.join(dir, "trace.json");
  saveTrace(result.trace, tracePath);

  // ---- Diagnostics, captured BEFORE any shrink replay disturbs the page ----
  const consoleLog: ConsoleLog = getConsoleLog();
  const scriptHost = page ? await probeScriptHost(page) : { available: false };
  const appLog = readAppLogTail();
  if (appLog) {
    try {
      fs.writeFileSync(path.join(dir, "app-dev.log.tail"), appLog.tail, "utf8");
    } catch {
      // Best effort — never fail a failure report.
    }
  }

  const slowest = [...result.timings]
    .sort((a, b) => b.durationMs - a.durationMs)
    .slice(0, 10);

  const diagnostics = {
    harness,
    seed,
    failedAtStep: result.failedAtStep,
    elapsedMs: result.elapsedMs,
    /** Every console line the page produced, in order, step-stamped. */
    console: consoleLog,
    /** Per-action durations, in execution order. */
    actionTimings: result.timings,
    slowestActions: slowest,
    oracleCheckpoints: result.checkpoints,
    scriptHost,
    realmConnections: realmConnections(consoleLog, result.timings),
    appLog: appLog
      ? { path: appLog.path, capturedBytes: appLog.tail.length }
      : { path: appLogPath(), capturedBytes: 0, note: "no app log was being recorded" },
    failingSnapshot: result.failingSnapshot,
  };
  fs.writeFileSync(
    path.join(dir, "diagnostics.json"),
    JSON.stringify(diagnostics, null, 2),
    "utf8"
  );

  // ---- failure.json (pre-shrink; rewritten once the shrink finishes) ----
  const minimizedTracePath = path.join(dir, "minimized.trace.json");
  const failureJson: Record<string, unknown> = {
    harness,
    seed,
    violationId,
    violation: result.violation,
    allViolations: result.allViolations,
    failedAtStep: result.failedAtStep,
    totalActions: result.totalActions,
    checkpoints: result.checkpoints,
    replayConfirmed: false,
    minimized: false,
    // Everything needed to replay deterministically, spelled out. The previous
    // generation of this report told the reader to "use this seed" and the seed
    // could not be injected; a command that has been run is the only honest
    // form of that instruction.
    // Everything that replays THIS bundle. `minimizedTrace` is added only once
    // the file it names exists — the first version printed it unconditionally,
    // so a bundle that skipped minimization handed its reader a command
    // referencing a file that was never written.
    replay: {
      wholeWalk: replayCommand,
      originalTrace: traceReplayCommand(tracePath),
    } as Record<string, string>,
    ...extra,
  };

  const writeFailureJson = () =>
    fs.writeFileSync(
      path.join(dir, "failure.json"),
      JSON.stringify(failureJson, null, 2),
      "utf8"
    );
  writeFailureJson();

  // ---- Minimize ----
  let shrink: ShrinkResult | null = null;
  let minimizedPath: string | null = null;
  const skipReason = skipShrinkReason(violationId);
  if (replay && skipReason === null) {
    console.log(
      `\n  Minimizing failing trace (${result.trace.actions.length} actions)...`
    );
    shrink = await minimizeTrace(replay, result.trace, violationId, {
      maxReplays: shrinkMaxReplays,
      timeBudgetMs: shrinkTimeBudgetMs,
    });
    saveTrace(shrink.minimized, minimizedTracePath);
    minimizedPath = minimizedTracePath;

    failureJson.minimized = true;
    failureJson.minimizedActionCount = shrink.minimized.actions.length;
    // `replayConfirmed` is now derived from a tri-state, because as a bare
    // boolean it claimed confirmation for shrinks whose confirmation replay
    // never ran (see ShrinkVerdict). `shrinkVerdict` is the value to read.
    failureJson.replayConfirmed = shrink.verdict === "confirmed";
    failureJson.shrinkVerdictCode = shrink.verdict;
    failureJson.shrinkReplays = shrink.replays;
    failureJson.shrinkTruncated = shrink.truncated;
    // What the replays did INSTEAD. Without this the bundle says
    // `replayConfirmed: false` and nothing else, which reads as "the failure
    // did not reproduce" even when every replay failed with a different,
    // perfectly deterministic violation. See ShrinkResult.otherOutcomes.
    failureJson.shrinkOtherOutcomes = shrink.otherOutcomes;
    failureJson.shrinkVerdict = describeShrink(shrink, violationId);
    (failureJson.replay as Record<string, string>).minimizedTrace =
      traceReplayCommand(minimizedTracePath);
    writeFailureJson();

    console.log(
      `  Minimized: ${result.trace.actions.length} -> ` +
        `${shrink.minimized.actions.length} actions ` +
        `(${shrink.replays} replays, verdict=${shrink.verdict}` +
        `, replay outcomes: ${JSON.stringify(shrink.otherOutcomes)})`
    );
  } else if (skipReason !== null) {
    failureJson.shrinkVerdict = skipReason;
    writeFailureJson();
    console.log(`\n  ${skipReason}`);
  } else {
    failureJson.shrinkVerdict =
      "not minimized: no replay function was supplied (minimization disabled).";
    writeFailureJson();
  }

  // ---- report.md ----
  const report = buildReport({
    result,
    harness,
    seed,
    dir,
    replayCommand,
    tracePath,
    minimizedPath,
    shrink,
    violationId,
    consoleLog,
    scriptHost,
    appLogRecorded: appLog !== null,
    skipReason,
  });
  fs.writeFileSync(path.join(dir, "report.md"), report, "utf8");

  return { dir, report, shrink, minimizedTracePath: minimizedPath };
}

/** The command that replays one trace file. */
function traceReplayCommand(tracePathAbs: string): string {
  return (
    `E2E_MANUAL=1 SOAK_TRACE="${tracePathAbs}" SOAK_EXPECT_FAIL=1 ` +
    `npx playwright test --project=soak --grep "Trace replay"`
  );
}

/**
 * The shrink outcome as a sentence. Three genuinely different results hide
 * behind one boolean, and reading `replayConfirmed: false` as "nothing here"
 * is the mistake that cost this program a pass.
 */
function describeShrink(shrink: ShrinkResult, originalViolationId: string): string {
  if (shrink.verdict === "confirmed") {
    return (
      `confirmed: the minimized ${shrink.minimized.actions.length}-action trace ` +
      `still fails with "${originalViolationId}" (${shrink.replays} replays).`
    );
  }
  const otherFailures = Object.entries(shrink.otherOutcomes).filter(
    ([id]) => id !== "(passed)"
  );
  const passed = shrink.otherOutcomes["(passed)"] ?? 0;
  if (shrink.verdict === "unverified") {
    return (
      `UNVERIFIED: the shrink budget ran out after ${shrink.replays} replays ` +
      `before any of them reproduced "${originalViolationId}". This is not ` +
      `evidence that the failure is unreproducible — nothing was established. ` +
      `Raise shrinkMaxReplays / shrinkTimeBudgetMs and run the trace replay ` +
      `command above.` +
      (otherFailures.length > 0
        ? ` Replays that did fail: ${otherFailures
            .sort((a, b) => b[1] - a[1])
            .map(([id, n]) => `${id} x${n}`)
            .join(", ")} (${passed} passed).`
        : "")
    );
  }
  if (otherFailures.length > 0) {
    const summary = otherFailures
      .sort((a, b) => b[1] - a[1])
      .map(([id, n]) => `${id} x${n}`)
      .join(", ");
    return (
      `DIFFERENT reproducible failure: "${originalViolationId}" never reproduced ` +
      `in ${shrink.replays} replays, but the replays DID fail — ${summary} ` +
      `(${passed} passed). Triage the failure that reproduces, not the one that ` +
      `was reported.`
    );
  }
  return (
    `not reproducible: "${originalViolationId}" did not fire in any of ` +
    `${shrink.replays} replays and every replay passed. Order-dependent, ` +
    `timing-dependent, or dependent on state the reset does not restore — ` +
    `read diagnostics.json (console ring + action timings) rather than replaying again.`
  );
}

function buildReport(o: {
  result: WalkResult;
  harness: string;
  seed: number | null;
  dir: string;
  replayCommand: string;
  tracePath: string;
  minimizedPath: string | null;
  shrink: ShrinkResult | null;
  violationId: string;
  consoleLog: ConsoleLog;
  scriptHost: ScriptHostProbe;
  appLogRecorded: boolean;
  skipReason: string | null;
}): string {
  const lines: string[] = [];
  lines.push(`# ${o.harness} failure — ${o.violationId}`);
  lines.push("");
  lines.push(formatWalkReport(o.result));
  lines.push("");
  lines.push(`## Replay`);
  lines.push("");
  lines.push("```");
  lines.push(o.replayCommand);
  lines.push("```");
  lines.push("");
  lines.push(`Original trace (${o.result.trace.actions.length} actions):`);
  lines.push("");
  lines.push("```");
  lines.push(traceReplayCommand(o.tracePath));
  lines.push("```");
  if (o.skipReason !== null) {
    lines.push("");
    lines.push(`## Minimization`);
    lines.push("");
    lines.push(o.skipReason);
  }
  if (o.minimizedPath && o.shrink) {
    lines.push("");
    lines.push(
      `Minimized trace (${o.shrink.minimized.actions.length} actions, ` +
        `${o.shrink.replays} replays):`
    );
    lines.push("");
    lines.push("```");
    lines.push(traceReplayCommand(o.minimizedPath));
    lines.push("```");
    lines.push("");
    lines.push(`## Shrink verdict`);
    lines.push("");
    lines.push(describeShrink(o.shrink, o.violationId));
    lines.push("");
    lines.push(`Replay outcomes: \`${JSON.stringify(o.shrink.otherOutcomes)}\``);
    if (o.shrink.minimized.actions.length > 0) {
      lines.push("");
      lines.push(`### Minimized actions`);
      lines.push("");
      o.shrink.minimized.actions.forEach((a, i) => {
        lines.push(`${i + 1}. \`${a.id}\` ${JSON.stringify(a.params)}`);
      });
    }
  }

  // ---- Diagnostics ----
  lines.push("");
  lines.push(`## Diagnostics`);
  lines.push("");
  const failedStep = o.result.failedAtStep ?? 0;
  const nearby = o.consoleLog.entries.filter(
    (e) => e.step >= failedStep - 2 && e.step <= failedStep
  );
  lines.push(
    `Console ring: ${o.consoleLog.entries.length} entries` +
      (o.consoleLog.dropped > 0
        ? ` (**${o.consoleLog.dropped} evicted** — this is a tail, not the whole run)`
        : ` (complete)`)
  );
  lines.push("");
  // JS realms that came up during the run — the page, and every Worker.
  const realms = realmConnections(o.consoleLog, o.result.timings);
  if (realms.length > 0) {
    const stalled = realms.filter((r) => r.connectedAfterMs === null);
    lines.push(
      `### JS realms that connected (${realms.length})` +
        (stalled.length > 0 ? ` — **${stalled.length} never connected**` : "")
    );
    lines.push("");
    lines.push(
      `Each Vite client connection is a new realm: the page on load, and every ` +
        `Web Worker on spawn. A realm that starts connecting and never finishes ` +
        `is a worker that did not come up, which is what an expiring script-mount ` +
        `deadline looks like from the page's side.`
    );
    lines.push("");
    lines.push("| step | +ms | connected after | action |");
    lines.push("| --- | --- | --- | --- |");
    for (const r of realms.slice(0, 30)) {
      lines.push(
        `| ${r.step} | ${r.atMs} | ` +
          `${r.connectedAfterMs === null ? "**never**" : `${r.connectedAfterMs}ms`} | ` +
          `${r.action ? `\`${r.action}\`` : ""} |`
      );
    }
    lines.push("");
  }

  // Errors and warnings FIRST, over the whole run rather than a window around
  // the failure. The walker logs a refused/slow script mount as a WARNING and
  // the product logs the mount failure as an ERROR one tick earlier; a report
  // that only shows a window around the failing step can miss both, which is
  // how a ten-second mount deadline reached a bundle as an unexplained
  // `no-console-errors`.
  const significant = o.consoleLog.entries.filter(
    (e) => e.type === "error" || e.type === "warning" || e.type === "pageerror"
  );
  lines.push(
    `Errors/warnings in the ring: ${significant.length}` +
      ` (${significant.filter((e) => e.filtered).length} filtered as known noise)`
  );
  lines.push("");
  if (significant.length > 0) {
    lines.push(`### Every error and warning, whole run`);
    lines.push("");
    lines.push("```");
    for (const e of significant.slice(-80)) {
      lines.push(
        `[step ${e.step} +${e.atMs}ms] ${e.type}${e.filtered ? " (filtered)" : ""}: ` +
          `${e.text.slice(0, 600)}${e.location ? `  @ ${e.location}` : ""}`
      );
    }
    lines.push("```");
    lines.push("");
  }
  if (nearby.length > 0) {
    lines.push(`### Console around the failing step (${failedStep})`);
    lines.push("");
    lines.push("```");
    for (const e of nearby.slice(-60)) {
      lines.push(
        `[step ${e.step} +${e.atMs}ms] ${e.type}${e.filtered ? " (filtered)" : ""}: ` +
          `${e.text.slice(0, 400)}${e.location ? `  @ ${e.location}` : ""}`
      );
    }
    lines.push("```");
    lines.push("");
  }
  const slowest = [...o.result.timings]
    .sort((a, b) => b.durationMs - a.durationMs)
    .slice(0, 10);
  if (slowest.length > 0) {
    lines.push(`### Slowest actions`);
    lines.push("");
    lines.push("| step | action | ms | threw |");
    lines.push("| --- | --- | --- | --- |");
    for (const t of slowest) {
      lines.push(
        `| ${t.step} | \`${t.id}\` | ${t.durationMs} | ${t.error ? t.error.slice(0, 80) : ""} |`
      );
    }
    lines.push("");
  }
  lines.push(`### Script host at failure`);
  lines.push("");
  lines.push("```json");
  lines.push(JSON.stringify(o.scriptHost, null, 2));
  lines.push("```");
  lines.push("");
  lines.push(
    o.appLogRecorded
      ? `App log tail captured in \`app-dev.log.tail\`.`
      : `No app log was being recorded (nothing wrote \`${appLogPath()}\`). ` +
          `Launch through \`scratchpad/launch-vba-batch.ps1\` or the Playwright ` +
          `global setup so the next occurrence has one.`
  );
  lines.push("");
  lines.push(`Full machine-readable detail: \`diagnostics.json\`.`);
  return lines.join("\n");
}
