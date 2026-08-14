//! FILENAME: app/e2e/walker/walkRunner.ts
// PURPOSE: The walk runner — generalizes the v1 InvariantRunner:
//          - actions come from an ActionSource (seeded generator OR explicit
//            trace replay)
//          - every executed action is recorded and the trace is FLUSHED TO
//            DISK after every action (a hard WebView2 crash still leaves a
//            replayable artifact)
//          - cheap invariants run after every action; the semantic oracle
//            battery runs every N actions and at the end
//          - stops on maxActions OR a wall-clock budget (soak mode)

import * as path from "node:path";
import type { Page } from "@playwright/test";
import type { GridHelper } from "../helpers/grid";
import type { Invariant, InvariantViolation } from "../invariants/invariants";
import {
  captureSnapshot,
  installErrorTracking,
  setWalkStep,
} from "../invariants/stateSnapshot";
import type { StateSnapshot } from "../invariants/stateSnapshot";
import type { OracleBattery } from "../oracles";
import type { OracleBaseline } from "../oracles/types";
import { sweepNativeDialogs } from "../helpers/nativeDialogs";
import type { ActionSource } from "./sources";
import type { ActionTrace } from "./trace";
import { createTrace, saveTrace } from "./trace";
import { executeInstance } from "./actionCatalog";
import type { AnyActionDef } from "./actionCatalog";

// ============================================================================
// Types
// ============================================================================

export interface WalkOptions {
  source: ActionSource;
  /** Cheap invariants checked after every action. */
  invariants: Invariant[];
  /** Semantic oracle battery (null disables oracle checkpoints). */
  oracleBattery?: OracleBattery | null;
  /** Oracle checkpoint cadence (default 25). */
  oracleEveryNActions?: number;
  /** Stop after this many actions (default 75; ignored when the source is a
   *  trace that ends earlier). */
  maxActions?: number;
  /** Stop when this much wall-clock time has elapsed (soak mode). */
  budgetMs?: number;
  /** UI settle time after each action (default 250ms). */
  settleTimeMs?: number;
  /** Directory where the live trace is flushed (trace.json). */
  resultsDir?: string;
  /**
   * How long the post-action snapshot may take before the walk concludes that
   * Tauri IPC is blocked — which in practice means a NATIVE dialog is open.
   *
   * `captureSnapshot` is the walk's first `invoke` after every action, so it is
   * exactly where a blocked IPC channel shows up. Default 45s: the slowest
   * legitimate snapshot measured in these suites is under two seconds, and the
   * app's heaviest dialogs settle in single digits, so this cannot turn a slow
   * snapshot into a false failure — it turns an INFINITE one into a reported
   * failure that names the dialog. See helpers/nativeDialogs.ts (BUG-0039).
   */
  snapshotTimeoutMs?: number;
  /** Catalog used for executing instances (default ACTION_CATALOG). */
  catalog?: AnyActionDef[];
  verbose?: boolean;
}

/**
 * How long one action actually took.
 *
 * S13's bundle could not distinguish "the script mount sat on its ten-second
 * deadline and then failed" from "something failed instantly": nothing timed
 * anything. A deadline is a DURATION, so a bundle that cannot report durations
 * cannot report deadlines, and the only failure mode this walker has that is
 * defined in seconds was the one it could say least about.
 */
export interface ActionTiming {
  step: number;
  id: string;
  params: Record<string, unknown>;
  /** Milliseconds from the start of the walk to the start of this action. */
  startedAtMs: number;
  /** Milliseconds `execute()` took (excludes the settle wait). */
  durationMs: number;
  /** Set when `execute()` threw and the walk tolerated it. */
  error?: string;
  /**
   * The workbook's sheet shape before and after this action, recorded ONLY
   * when it actually changed. See `sheetShapeOf` for why an untouched action
   * records nothing.
   */
  sheetChange?: { before: SheetShape; after: SheetShape };
  /**
   * The workbook's floating-range shape before and after this action,
   * recorded only when it changed — the same measured-not-inferred rule as
   * `sheetChange`, applied to the object family the 2026-08-13 landings
   * introduced. Without it, every `fr.*` action would be issued-but-never-
   * observed on its first walk, the §14a blind spot re-created wholesale.
   */
  frChange?: { before: FloatingShape; after: FloatingShape };
  /**
   * Elements covering most of the viewport at the moment an action threw.
   *
   * WHY. Playwright's `actionTimeout` turned an invisible hang into a reported
   * failure, and the report named the victim ("waiting for locator('button')
   * ... <div class="css-1fr3uyz"> intercepts pointer events") but not the
   * culprit: an emotion hash is not a component. MEASURED on invariant seed
   * 1786456498740, where `ribbon.switch-tab` failed TWICE against a ribbon
   * button that was visible, enabled and stable — something was sitting on top
   * of the whole ribbon, and nothing in the bundle could say what. A tolerated
   * throw with no diagnosis is a lead this programme cannot follow, so the
   * walker takes the census itself, at the moment it still exists.
   */
  overlays?: OverlayCensusEntry[];
}

/**
 * Everything about the workbook a sheet action is supposed to change.
 *
 * WHY IT EXISTS. The coverage summary answers "which families did this walk
 * touch", and it answers it from the action list — an action that ran without
 * throwing counts as explored. Half the sheet actions cannot throw: `sheet.add`
 * probes `isVisible({timeout: 500})` and returns silently when the button is
 * not there, `sheet.switch` and `sheet.delete` do the same. So `sheet=7` in a
 * report has never distinguished seven sheet operations from seven no-ops, and
 * that is precisely the reading that made BUG-0031 invisible for the whole
 * programme (`chart.select`/`chart.delete` counted as explored while talking to
 * nothing).
 *
 * The fix is to stop inferring effect from the action and start OBSERVING it.
 * `count` catches add/delete, `active` catches switch, `names` catches rename —
 * and a rename is the case a count could never have caught.
 */
export interface SheetShape {
  count: number;
  active: number;
  names: string[];
  /**
   * Per-sheet visibility and tab colours. Without these, `sheet.hide` of a
   * NON-active sheet, every `sheet.unhide` and every `sheet.tabColor` change
   * nothing the shape can see — issued-but-never-effective, the §14a blind
   * spot re-created for exactly the three operations BUG-0050 made undoable.
   */
  visibility: string[];
  tabColors: string[];
}

export function sheetShapeOf(snapshot: StateSnapshot): SheetShape {
  return {
    count: snapshot.logical.sheetCount,
    active: snapshot.logical.activeSheet,
    names: [...(snapshot.logical.sheetNames ?? [])],
    visibility: [...(snapshot.logical.sheetVisibility ?? [])],
    tabColors: [...(snapshot.logical.sheetTabColors ?? [])],
  };
}

function stringArraysDiffer(a: string[], b: string[]): boolean {
  return a.length !== b.length || a.some((v, i) => v !== b[i]);
}

/**
 * Everything about the workbook a floating-range action is supposed to
 * change, one line per object, ORDER-INSENSITIVE (sorted by id): create and
 * delete move the count, resize moves rows/cols, a move moves x/y, rename
 * moves the name — and a rename is the case a count could never catch, the
 * same reasoning as `SheetShape.names`.
 */
export interface FloatingShape {
  /** One canonical line per FR: `id|name|host|rows x cols|x,y` — sorted. */
  entries: string[];
}

export function frShapeOf(snapshot: StateSnapshot): FloatingShape {
  const frs = snapshot.logical.floatingRanges ?? [];
  return {
    entries: frs
      .map(
        (fr) =>
          `${fr.id}|${fr.name}|${fr.hostSheetIndex}|${fr.rows}x${fr.cols}|` +
          `${Math.round(fr.x)},${Math.round(fr.y)}|${fr.cellStamp ?? ""}`
      )
      .sort(),
  };
}

export function frShapesDiffer(a: FloatingShape, b: FloatingShape): boolean {
  return stringArraysDiffer(a.entries, b.entries);
}

export function sheetShapesDiffer(a: SheetShape, b: SheetShape): boolean {
  return (
    a.count !== b.count ||
    a.active !== b.active ||
    stringArraysDiffer(a.names, b.names) ||
    stringArraysDiffer(a.visibility, b.visibility) ||
    stringArraysDiffer(a.tabColors, b.tabColors)
  );
}

/** One viewport-covering element, as seen when an action threw. */
export interface OverlayCensusEntry {
  tag: string;
  id: string | null;
  className: string;
  role: string | null;
  position: string;
  zIndex: string;
  pointerEvents: string;
  /** Fraction of the viewport the element's box covers, 0..1. */
  coverage: number;
  /** First ~80 chars of text, to identify a menu/dialog by its content. */
  text: string;
}

/**
 * Census of elements that cover at least `minCoverage` of the viewport.
 *
 * Deliberately DOM-only and synchronous: it must run in the failure's own
 * moment, before the settle wait gives whatever it is a chance to unmount.
 */
async function censusViewportOverlays(
  page: Page,
  minCoverage = 0.4
): Promise<OverlayCensusEntry[]> {
  try {
    return (await page.evaluate((min: number) => {
      const vw = window.innerWidth;
      const vh = window.innerHeight;
      const area = vw * vh;
      if (area === 0) return [];
      const out: Array<Record<string, unknown>> = [];
      for (const el of Array.from(document.body.querySelectorAll("*"))) {
        const style = window.getComputedStyle(el);
        if (style.position !== "fixed" && style.position !== "absolute") continue;
        if (style.display === "none" || style.visibility === "hidden") continue;
        const r = el.getBoundingClientRect();
        const w = Math.min(r.right, vw) - Math.max(r.left, 0);
        const h = Math.min(r.bottom, vh) - Math.max(r.top, 0);
        if (w <= 0 || h <= 0) continue;
        const coverage = (w * h) / area;
        if (coverage < min) continue;
        out.push({
          tag: el.tagName.toLowerCase(),
          id: (el as HTMLElement).id || null,
          className: typeof el.className === "string" ? el.className : "",
          role: el.getAttribute("role"),
          position: style.position,
          zIndex: style.zIndex,
          pointerEvents: style.pointerEvents,
          coverage: Math.round(coverage * 100) / 100,
          text: (el.textContent ?? "").trim().slice(0, 80),
        });
      }
      return out;
    }, minCoverage)) as unknown as OverlayCensusEntry[];
  } catch {
    // The page may be gone — that is a different failure and is reported by
    // the caller. Never let diagnostics mask the thing being diagnosed.
    return [];
  }
}

export interface CheckpointTiming {
  step: number;
  durationMs: number;
}

export interface WalkResult {
  passed: boolean;
  seed: number | null;
  totalActions: number;
  failedAtStep: number | null;
  /** The concrete, replayable trace of everything that executed. */
  trace: ActionTrace;
  violation: InvariantViolation | null;
  allViolations: InvariantViolation[];
  failingSnapshot: StateSnapshot | null;
  /** Oracle checkpoints that ran, with how long each took. */
  checkpoints: CheckpointTiming[];
  /** Per-action timings, in execution order. */
  timings: ActionTiming[];
  /**
   * What the oracle battery actually got to ASK across the run, already
   * formatted (see `OracleBattery.formatCoverage`). Null when no battery ran.
   *
   * Carried on the RESULT rather than left on the battery, because the battery
   * is not reachable from `formatWalkReport` — which is precisely why the
   * counts it had been accumulating since it was written were never printed by
   * anything.
   */
  oracleCoverage: string | null;
  elapsedMs: number;
}

// ============================================================================
// Runner
// ============================================================================

export class WalkRunner {
  private page: Page;
  private grid: GridHelper;
  private opts: WalkOptions;

  constructor(page: Page, grid: GridHelper, opts: WalkOptions) {
    this.page = page;
    this.grid = grid;
    this.opts = opts;
  }

  async run(): Promise<WalkResult> {
    const {
      source,
      invariants,
      oracleBattery = null,
      oracleEveryNActions = 25,
      maxActions = 75,
      budgetMs,
      settleTimeMs = 250,
      resultsDir,
      catalog,
      snapshotTimeoutMs = 45_000,
      verbose = true,
    } = this.opts;

    const startedAt = Date.now();
    const trace = createTrace(source.seed);
    const tracePath = resultsDir ? path.join(resultsDir, "trace.json") : null;
    const checkpoints: CheckpointTiming[] = [];
    const timings: ActionTiming[] = [];

    const fail = (
      step: number,
      violation: InvariantViolation,
      all: InvariantViolation[],
      snapshot: StateSnapshot | null
    ): WalkResult => ({
      passed: false,
      seed: source.seed,
      totalActions: step,
      failedAtStep: step,
      trace,
      violation,
      allViolations: all,
      failingSnapshot: snapshot,
      checkpoints,
      timings,
      oracleCoverage: oracleBattery ? oracleBattery.formatCoverage() : null,
      elapsedMs: Date.now() - startedAt,
    });

    installErrorTracking(this.page);

    let oracleBaseline: OracleBaseline | null = oracleBattery
      ? await oracleBattery.begin(this.page)
      : null;

    let snapshot = await captureSnapshot(this.page);
    let step = 0;

    while (step < maxActions) {
      if (budgetMs !== undefined && Date.now() - startedAt > budgetMs) {
        if (verbose) console.log(`  [walk] budget reached after ${step} actions`);
        break;
      }

      const instance = source.next(snapshot, step + 1);
      if (instance === null) break; // trace exhausted
      step++;

      trace.actions.push(instance);
      if (tracePath) saveTrace(trace, tracePath);

      if (verbose) {
        console.log(`  [step ${step}/${maxActions}] ${instance.id}`);
      }

      // Every console line from here on belongs to this step.
      setWalkStep(step);

      // Execute
      const actionStartedAtMs = Date.now() - startedAt;
      const actionStartedAt = Date.now();
      const timing: ActionTiming = {
        step,
        id: instance.id,
        params: instance.params,
        startedAtMs: actionStartedAtMs,
        durationMs: 0,
      };
      timings.push(timing);
      try {
        await executeInstance(this.page, this.grid, instance, catalog);
        timing.durationMs = Date.now() - actionStartedAt;
      } catch (err) {
        timing.durationMs = Date.now() - actionStartedAt;
        const msg = (err as Error).message ?? "";
        timing.error = msg;
        if (
          msg.includes("Target page, context or browser has been closed") ||
          msg.includes("Target closed") ||
          msg.includes("browser has been closed")
        ) {
          console.log(`  [ABORT] Page closed at step ${step} during ${instance.id}`);
          return fail(
            step,
            {
              invariantId: "page-crashed",
              message: `Page/browser closed during action "${instance.id}": ${msg}`,
              details: { action: instance.id, error: msg },
            },
            [],
            null
          );
        }
        // Other failures are expected with random sequences (preconditions
        // can be stale) — log and continue. But take the overlay census FIRST:
        // a click that could not land because something covered the target is
        // the one tolerated failure whose cause disappears if you wait.
        timing.overlays = await censusViewportOverlays(this.page);
        if (verbose) {
          console.log(`    [action failed] ${instance.id}: ${msg}`);
          if (timing.overlays.length > 0) {
            for (const o of timing.overlays) {
              console.log(
                `      [covering ${Math.round(o.coverage * 100)}% of the viewport] ` +
                  `<${o.tag} class="${o.className}" role=${o.role ?? "-"}> ` +
                  `position:${o.position} z:${o.zIndex} pointer-events:${o.pointerEvents}` +
                  (o.text ? ` text:"${o.text}"` : "")
              );
            }
          }
        }
      }

      // Settle
      try {
        await this.page.waitForTimeout(settleTimeMs);
      } catch {
        return fail(
          step,
          {
            invariantId: "page-crashed",
            message: `Page closed during settle after action "${instance.id}"`,
            details: { action: instance.id },
          },
          [],
          null
        );
      }

      // Snapshot.
      //
      // BOUNDED, because this is the walk's first `invoke` after every action
      // and therefore exactly where a blocked IPC channel surfaces. A native
      // dialog blocks Tauri IPC while leaving the page perfectly responsive —
      // `page.evaluate` returns, the canvas paints, nothing throws — so an
      // unbounded await here is a SILENT hang, not a failure. Measured: a soak
      // walk sat on `Failed to rename sheet: Sheet index 2 out of range` with
      // twelve stacked dialogs and burned its entire 30-minute spec timeout
      // without printing a line (BUG-0039).
      const NO_SNAPSHOT = Symbol("snapshot-timeout");
      let timer: NodeJS.Timeout | undefined;
      let captured: StateSnapshot | typeof NO_SNAPSHOT;
      try {
        captured = await Promise.race([
          captureSnapshot(this.page),
          new Promise<typeof NO_SNAPSHOT>((resolve) => {
            timer = setTimeout(() => resolve(NO_SNAPSHOT), snapshotTimeoutMs);
          }),
        ]);
      } catch {
        clearTimeout(timer);
        return fail(
          step,
          {
            invariantId: "page-crashed",
            message: `Page closed during snapshot after action "${instance.id}"`,
            details: { action: instance.id },
          },
          [],
          null
        );
      }
      clearTimeout(timer);

      if (captured === NO_SNAPSHOT) {
        // Read AND dismiss whatever is there: the text is the only evidence of
        // what raised it, and leaving the pile standing poisons every later
        // walk in the session.
        const sweep = sweepNativeDialogs();
        const named = sweep.dismissed.length
          ? sweep.dismissed.map((t) => `"${t}"`).join("; ")
          : "(none found — the block was elsewhere)";
        console.log(
          `  [ABORT] Tauri IPC stopped answering after ${instance.id}; ` +
            `native dialogs dismissed: ${named}`
        );
        return fail(
          step,
          {
            invariantId: "native-dialog-blocking",
            message:
              `Tauri IPC stopped answering within ${Math.round(snapshotTimeoutMs / 1000)}s ` +
              `after action "${instance.id}". ${sweep.dismissed.length} native ` +
              `dialog(s) were open and have been dismissed: ${named}. A native ` +
              `dialog blocks every invoke while leaving the page responsive, so ` +
              `this would otherwise be a silent hang, not a failure.`,
            details: {
              action: instance.id,
              params: instance.params,
              dismissedDialogs: sweep.dismissed,
              snapshotTimeoutMs,
            },
          },
          [],
          null
        );
      }
      // Did this action actually move the workbook's sheet structure? Asked
      // while `snapshot` is still the PRE-action reading. Recorded on any
      // action, not just the `sheet` family: a non-sheet action that renames or
      // drops a sheet is a finding in its own right, and the trace is the only
      // place it would ever show.
      const sheetBefore = sheetShapeOf(snapshot);
      const frBefore = frShapeOf(snapshot);
      snapshot = captured;
      const sheetAfter = sheetShapeOf(snapshot);
      if (sheetShapesDiffer(sheetBefore, sheetAfter)) {
        timing.sheetChange = { before: sheetBefore, after: sheetAfter };
      }
      const frAfter = frShapeOf(snapshot);
      if (frShapesDiffer(frBefore, frAfter)) {
        timing.frChange = { before: frBefore, after: frAfter };
      }

      // Cheap invariants
      const violations = invariants.flatMap((inv) => inv.check(snapshot));
      if (violations.length > 0) {
        return fail(step, violations[0], violations, snapshot);
      }

      // Oracle battery checkpoint
      const isLastStep = step === maxActions;
      const budgetExhausted =
        budgetMs !== undefined && Date.now() - startedAt > budgetMs;
      if (
        oracleBattery !== null &&
        oracleBaseline !== null &&
        (step % oracleEveryNActions === 0 || isLastStep || budgetExhausted)
      ) {
        if (verbose) console.log(`  [oracle checkpoint] after step ${step}`);
        const checkpointTiming: CheckpointTiming = { step, durationMs: 0 };
        checkpoints.push(checkpointTiming);
        const checkpointStartedAt = Date.now();
        try {
          const result = await oracleBattery.checkpoint(this.page, oracleBaseline);
          checkpointTiming.durationMs = Date.now() - checkpointStartedAt;
          oracleBaseline = result.nextBaseline;
          if (result.violations.length > 0) {
            return fail(step, result.violations[0], result.violations, snapshot);
          }
        } catch (err) {
          checkpointTiming.durationMs = Date.now() - checkpointStartedAt;
          const msg = (err as Error).message ?? String(err);
          return fail(
            step,
            {
              invariantId: "oracle-infrastructure",
              message: `Oracle battery failed to run: ${msg}`,
              details: { error: msg },
            },
            [],
            snapshot
          );
        }
      }
    }

    // Final oracle checkpoint if the loop ended off-cadence (budget/trace end)
    if (
      oracleBattery !== null &&
      oracleBaseline !== null &&
      step > 0 &&
      step % (this.opts.oracleEveryNActions ?? 25) !== 0
    ) {
      if (verbose) console.log(`  [oracle checkpoint] final after step ${step}`);
      const finalTiming: CheckpointTiming = { step, durationMs: 0 };
      checkpoints.push(finalTiming);
      const finalStartedAt = Date.now();
      try {
        const result = await oracleBattery.checkpoint(this.page, oracleBaseline);
        finalTiming.durationMs = Date.now() - finalStartedAt;
        if (result.violations.length > 0) {
          return fail(step, result.violations[0], result.violations, snapshot);
        }
      } catch (err) {
        finalTiming.durationMs = Date.now() - finalStartedAt;
        const msg = (err as Error).message ?? String(err);
        return fail(
          step,
          {
            invariantId: "oracle-infrastructure",
            message: `Oracle battery failed to run: ${msg}`,
            details: { error: msg },
          },
          [],
          snapshot
        );
      }
    }

    return {
      passed: true,
      seed: source.seed,
      totalActions: step,
      failedAtStep: null,
      trace,
      violation: null,
      allViolations: [],
      failingSnapshot: null,
      checkpoints,
      timings,
      oracleCoverage: oracleBattery ? oracleBattery.formatCoverage() : null,
      elapsedMs: Date.now() - startedAt,
    };
  }
}

// ============================================================================
// Report formatting
// ============================================================================

/**
 * What the walk actually touched, by family, counting only actions that ran
 * without throwing.
 *
 * WHY A PASSING WALK NEEDS THIS. A green walk used to report four numbers, none
 * of which said what it explored — so "the oracles never found a chart bug" and
 * "the oracles never created a chart" were indistinguishable in every report
 * this program has ever produced. They were in fact the second: BUG-0031 left
 * `chart.select`/`chart.delete` silently doing nothing, and the reports could
 * not show it. Coverage belongs in the PASS path precisely because that is
 * where an untested surface hides.
 */
export function summarizeCoverage(timings: ActionTiming[]): {
  families: Record<string, number>;
  byAction: Record<string, number>;
  threw: number;
  /**
   * Sheet-structure accounting, MEASURED rather than inferred.
   *
   * `attempted` counts sheet actions the walk issued; `effective` counts the
   * ones the workbook visibly answered (`ActionTiming.sheetChange`). The gap is
   * the number that did nothing, and it is the only number in this report that
   * can tell "the oracles found no sheet bug" apart from "the walker never
   * changed a sheet". `byActionEffective` says WHICH ones, because
   * `sheet.rename` failing while `sheet.add` works is a different defect from
   * the whole surface being inert.
   */
  sheet: {
    attempted: number;
    effective: number;
    byActionEffective: Record<string, number>;
  };
  /** Actions OUTSIDE the sheet family that moved the sheet structure anyway. */
  unexpectedSheetChanges: Array<{ step: number; id: string }>;
  /**
   * Floating-range accounting, same measured-not-inferred contract as `sheet`.
   * `unexpectedFrChanges` names non-`fr.` actions that moved the object store
   * — undo/redo of a geometry change legitimately does; anything else is a
   * finding.
   */
  fr: {
    attempted: number;
    effective: number;
    byActionEffective: Record<string, number>;
  };
  unexpectedFrChanges: Array<{ step: number; id: string }>;
} {
  const families: Record<string, number> = {};
  const byAction: Record<string, number> = {};
  const byActionEffective: Record<string, number> = {};
  const unexpectedSheetChanges: Array<{ step: number; id: string }> = [];
  const frByActionEffective: Record<string, number> = {};
  const unexpectedFrChanges: Array<{ step: number; id: string }> = [];
  let threw = 0;
  let sheetAttempted = 0;
  let sheetEffective = 0;
  let frAttempted = 0;
  let frEffective = 0;

  for (const t of timings) {
    const isSheetAction = t.id.startsWith("sheet.");
    if (isSheetAction) sheetAttempted++;
    if (t.sheetChange) {
      if (isSheetAction) {
        sheetEffective++;
        byActionEffective[t.id] = (byActionEffective[t.id] ?? 0) + 1;
      } else {
        unexpectedSheetChanges.push({ step: t.step, id: t.id });
      }
    }
    // `fr.refFromGrid`'s effect lands in a GRID cell, outside the fr shape —
    // like every `cell.*` action, its effect is not shape-observed, so it is
    // excluded from the attempted/effective accounting (it still counts in
    // `families`). Everything else `fr.` is observable: geometry/name via the
    // row store, cell writes via the snapshot's cellStamp.
    const isFrAction = t.id.startsWith("fr.") && t.id !== "fr.refFromGrid";
    if (isFrAction) frAttempted++;
    if (t.frChange) {
      if (isFrAction) {
        frEffective++;
        frByActionEffective[t.id] = (frByActionEffective[t.id] ?? 0) + 1;
      } else {
        unexpectedFrChanges.push({ step: t.step, id: t.id });
      }
    }
    if (t.error) {
      threw++;
      continue;
    }
    const family = t.id.split(".")[0];
    families[family] = (families[family] ?? 0) + 1;
    byAction[t.id] = (byAction[t.id] ?? 0) + 1;
  }

  return {
    families,
    byAction,
    threw,
    sheet: {
      attempted: sheetAttempted,
      effective: sheetEffective,
      byActionEffective,
    },
    unexpectedSheetChanges,
    fr: {
      attempted: frAttempted,
      effective: frEffective,
      byActionEffective: frByActionEffective,
    },
    unexpectedFrChanges,
  };
}

function formatCoverage(result: WalkResult): string[] {
  const { families, threw, sheet, unexpectedSheetChanges, fr, unexpectedFrChanges } =
    summarizeCoverage(result.timings);
  const entries = Object.entries(families).sort((a, b) => b[1] - a[1]);
  if (entries.length === 0) return [];
  const lines = [
    `  --- Coverage (actions that ran, by family) ---`,
    `  ${entries.map(([k, n]) => `${k}=${n}`).join(" ")}` +
      (threw > 0 ? `  [${threw} threw]` : ""),
  ];
  if (sheet.attempted > 0) {
    const detail = Object.entries(sheet.byActionEffective)
      .sort((a, b) => b[1] - a[1])
      .map(([k, n]) => `${k}=${n}`)
      .join(" ");
    lines.push(
      `  Sheet structure: ${sheet.attempted} action(s) issued, ` +
        `${sheet.effective} changed the workbook` +
        (detail ? ` (${detail})` : "") +
        (sheet.effective === 0
          ? `  [WARNING: every sheet action was a no-op — the sheet surface was NOT explored]`
          : "")
    );
  }
  if (unexpectedSheetChanges.length > 0) {
    lines.push(
      `  Sheet structure moved by NON-sheet actions: ` +
        unexpectedSheetChanges.map((u) => `step ${u.step} ${u.id}`).join(", ")
    );
  }
  if (fr.attempted > 0) {
    const detail = Object.entries(fr.byActionEffective)
      .sort((a, b) => b[1] - a[1])
      .map(([k, n]) => `${k}=${n}`)
      .join(" ");
    lines.push(
      `  Floating ranges: ${fr.attempted} action(s) issued, ` +
        `${fr.effective} changed the workbook` +
        (detail ? ` (${detail})` : "") +
        (fr.effective === 0
          ? `  [WARNING: every floating-range action was a no-op — the surface was NOT explored]`
          : "")
    );
  }
  if (unexpectedFrChanges.length > 0) {
    lines.push(
      `  Floating ranges moved by NON-fr actions: ` +
        unexpectedFrChanges.map((u) => `step ${u.step} ${u.id}`).join(", ")
    );
  }
  return lines;
}

export function formatWalkReport(result: WalkResult): string {
  if (result.passed) {
    return (
      [
        `[OK] Walk passed`,
        `  Seed: ${result.seed ?? "(trace replay)"}`,
        `  Actions executed: ${result.totalActions}`,
        `  Oracle checkpoints: ${result.checkpoints.length}`,
        `  Elapsed: ${Math.round(result.elapsedMs / 1000)}s`,
      ]
        .concat(formatCoverage(result))
        .concat(result.oracleCoverage ? [result.oracleCoverage] : [])
        .join("\n")
    );
  }

  const lines: string[] = [
    `[FAIL] Walk violation detected`,
    ``,
    `  Seed: ${result.seed ?? "(trace replay)"}`,
    `  Failed at step: ${result.failedAtStep} of ${result.totalActions}`,
    ``,
    `  --- Violation ---`,
    `  Invariant: ${result.violation!.invariantId}`,
    `  Message: ${result.violation!.message}`,
    ``,
  ];

  if (result.violation!.details) {
    lines.push(`  --- Details ---`);
    for (const [key, value] of Object.entries(result.violation!.details)) {
      lines.push(`  ${key}: ${JSON.stringify(value)}`);
    }
    lines.push(``);
  }

  if (result.allViolations.length > 1) {
    lines.push(`  --- Additional violations: ${result.allViolations.length - 1} ---`);
    for (const v of result.allViolations.slice(1)) {
      lines.push(`  [${v.invariantId}] ${v.message.slice(0, 200)}`);
    }
    lines.push(``);
  }

  lines.push(...formatCoverage(result));
  if (result.oracleCoverage) lines.push(result.oracleCoverage);
  lines.push(``);
  lines.push(`  --- Action trace (last 20 of ${result.trace.actions.length}) ---`);
  const actions = result.trace.actions;
  const startIdx = Math.max(0, actions.length - 20);
  for (let i = startIdx; i < actions.length; i++) {
    const marker = i === actions.length - 1 ? " <-- FAILED HERE" : "";
    lines.push(`  ${i + 1}. ${actions[i].id} ${JSON.stringify(actions[i].params)}${marker}`);
  }

  // The slowest actions, because the walker's only second-defined failure mode
  // (the 10s script-mount deadline) is invisible in an untimed trace. An action
  // sitting on ~10000ms IS the deadline; one at 120ms is not.
  const slowest = [...result.timings]
    .sort((a, b) => b.durationMs - a.durationMs)
    .slice(0, 5);
  if (slowest.length > 0 && slowest[0].durationMs > 0) {
    lines.push(``);
    lines.push(`  --- Slowest actions ---`);
    for (const t of slowest) {
      lines.push(
        `  step ${t.step}: ${t.id} ${t.durationMs}ms` +
          (t.error ? ` (threw: ${t.error.slice(0, 120)})` : "")
      );
    }
  }

  return lines.join("\n");
}
