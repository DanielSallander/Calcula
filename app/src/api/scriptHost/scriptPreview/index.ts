//! FILENAME: app/src/api/scriptHost/scriptPreview/index.ts
// PURPOSE: The faithful L3 rung — run a candidate object script in the realm it
//          ACTUALLY runs in, against a copy of the workbook, and report what it
//          would change. Applies nothing.
// CONTEXT: docs/design/local-model-script-authoring.md §5c;
//          docs/design/open-items.md (the 19-of-358 row this closes).
//
//          WHY THIS EXISTS. `ai_dry_run_script` executes a candidate in the Rust
//          QuickJS realm. That realm rejects `export` outright and shares a
//          small fraction of the Worker realm's `context`, so it DECLINES every
//          object script — correctly, because anything it said would describe
//          the emulator rather than the draft. The consequence was that L3 was
//          dead for the only surface the AI actually drafts for: a draft could
//          pass every static check, be queued for a human, and fail on its first
//          line.
//
//          WHAT MAKES THIS ONE FAITHFUL, precisely. Four of the five layers are
//          the product's own code, not a re-implementation:
//            1. the REALM      — a real hardened Worker (`hostPreviewScript`)
//            2. the TRANSFORM  — `wrapModuleSource`, the production mount
//            3. the SURFACE    — `buildWorkerContext`, all of it
//            4. the POLICY     — the real `brokerCall`: ALLOWLIST lookup,
//                                argument validators, tier, R19 ceiling
//            5. the BACKEND    — SUBSTITUTED. This is the one, and it is the
//                                irreducible one: a preview must not write to
//                                the document it is previewing.
//
//          So the design doc's objection to emulation ("emulating 5% of a
//          surface and reporting the gaps as defects is not a cheaper version of
//          it") is answered rather than dodged: nothing here emulates the
//          surface. What the substituted backend cannot serve is not reported as
//          a defect at all — the run is marked INAPPLICABLE and no conclusion is
//          drawn, which is the same decline discipline the rung was built on.
//
//          THE INVARIANT: this never writes. The snapshot is taken with
//          read-class calls; the script's writes land in an in-memory grid; the
//          preview handle declares no capabilities so every capability-bearing
//          method is refused before any grant is consulted; nothing is
//          registered, granted, audited or mounted. See `hostPreviewScript`'s
//          safety-by-absence list.

import { hostPreviewScript, type PreviewRunResult } from "../host";
import { ALLOWLIST } from "../allowlist";
import { createPreviewBackend, createPreviewState, type PreviewStubs } from "./backend";
import { PreviewGrid } from "./grid";
import { buildReport, declined, diffGrid } from "./report";
import { MAX_SNAPSHOT_CELLS, snapshotActiveSheet, type SnapshotResult, type SnapshotSource } from "./snapshot";
import type { DryRunReport } from "../scriptAuthoring";

export interface PreviewRequest {
  source: string;
  /** The object type the draft is written for ("button", "shape", ...). */
  objectType: string;
  /** A hook to fire after `setup` — for a button, "onClick". */
  event?: string;
  eventCount?: number;
  /** Fire `event` only if the script registered it; absence is not a failure. */
  eventOptional?: boolean;
  /** Cells to report the value of after the run, whether or not they changed. */
  readBack?: Array<{ row: number; col: number }>;
  /**
   * Seed the preview grid from these cells instead of from the live workbook.
   * The corpus uses this; the app does not.
   */
  fixture?: Array<{ row: number; col: number; value: string }>;
  stubs?: PreviewStubs;
  /** Where the workbook copy comes from. Injected so this is testable headless. */
  snapshotSource?: SnapshotSource;
  tier?: "restricted" | "unlocked";
}

/**
 * Run a draft against a copy of the workbook in its real realm.
 *
 * Returns the SAME `DryRunReport` shape `ai_dry_run_script` returns, so every
 * existing consumer — the draft gate, the authoring loop's repair prompt, the
 * transcript note — works unchanged and keeps branching on `applicable` before
 * drawing any conclusion.
 */
export async function previewObjectScript(req: PreviewRequest): Promise<DryRunReport> {
  const startedAt = Date.now();

  let snapshot: SnapshotResult;
  try {
    snapshot = req.fixture
      ? seedFixture(req.fixture)
      : req.snapshotSource
        ? await snapshotActiveSheet(req.snapshotSource)
        : await snapshotActiveSheet(await liveSnapshotSource());
  } catch (e) {
    // A snapshot that could not be taken is not a verdict about the script.
    return declined(
      `the workbook could not be copied for the preview: ${e instanceof Error ? e.message : String(e)}`,
    );
  }

  const before = snapshot.grid.inputSnapshot();
  const state = createPreviewState({
    grid: snapshot.grid,
    sheetNames: snapshot.sheetNames,
    activeSheet: snapshot.activeSheet,
    stubs: req.stubs,
  });
  const backend = createPreviewBackend(state);

  let run: PreviewRunResult;
  try {
    run = await hostPreviewScript({
      source: req.source,
      objectType: req.objectType,
      scriptName: "(preview)",
      tier: req.tier ?? "unlocked",
      backend,
      event: req.event,
      eventCount: req.eventCount,
      eventOptional: req.eventOptional,
    });
  } catch (e) {
    return declined(
      `the preview realm could not be started: ${e instanceof Error ? e.message : String(e)}`,
    );
  }

  if (run.realmUnavailable) {
    // No Worker in this environment (jsdom). Saying "it did not run" here would
    // report a fact about the test environment as a fact about the script.
    return declined("this environment has no Worker realm, so the script was not run");
  }

  // A member the backend does not serve makes the WHOLE run inapplicable. The
  // script may well be correct; what happened after that call is evidence about
  // the backend. This is checked BEFORE `run.ran`, because a gap usually
  // presents as a thrown call and would otherwise be reported as the script's
  // own runtime error.
  if (state.gap) {
    return declined(
      `the preview cannot serve ${state.gap}, so it has nothing to say about this script`,
      [...state.output],
    );
  }

  // A CAPABILITY call is a preview limitation, not a script defect.
  //
  // The preview declares nothing, so the broker's R19 ceiling refuses every
  // capability-bearing method. That refusal is about THIS RUN, not about the
  // draft — and the draft's declarations were already checked by L2, which
  // runs first and rejects an undeclared capability with a repair instruction.
  // So a capability call reaching here is one the script correctly declared,
  // and the honest answer is that a preview cannot perform it: it has no
  // network, no user to answer a dialog, and no workbook storage to write.
  // Answering from a canned stub would be worse than declining — a script that
  // parsed `{}` as an exchange rate would fail, and the preview would report
  // ITS OWN stub as the draft's runtime error.
  const capabilityRefusal = run.refusals.find((r) => ALLOWLIST[r.method]?.capability);
  if (capabilityRefusal) {
    const cap = ALLOWLIST[capabilityRefusal.method]?.capability;
    return declined(
      `the preview cannot perform ${capabilityRefusal.method} (the "${cap}" capability), ` +
        `so it has nothing to say about what this script would do`,
      [...state.output],
    );
  }

  // Every OTHER refusal is a real finding and must be visible. The product
  // would refuse these identically — a bad argument is a bad argument in either
  // realm — and a refusal the script never awaited neither throws nor changes a
  // cell, so without this it reads as a clean run that happened to do nothing.
  const refusalNotes = run.refusals.map(
    (r) => `[preview] ${r.method} was refused: ${r.message}`,
  );

  return buildReport({
    ok: run.ran,
    error: run.error,
    durationMs: Date.now() - startedAt,
    changes: diffGrid(before, snapshot.grid),
    output: [...state.output, ...refusalNotes],
    readBack: (req.readBack ?? []).map((r) => ({
      row: r.row,
      col: r.col,
      value: snapshot.grid.input(r.row, r.col),
    })),
    // A capped copy still produces a REAL verdict — the script ran against real
    // data, just not all of it — so this is a note rather than a decline. It is
    // said out loud because a reviewer who cannot see the bound would read
    // "changed 3 cells" as a statement about the whole sheet.
    note: snapshot.truncated
      ? `only the first ${MAX_SNAPSHOT_CELLS} cells of the sheet were copied for this preview`
      : undefined,
  });
}

/** Build a snapshot-shaped result from an explicit fixture (corpus use). */
function seedFixture(fixture: Array<{ row: number; col: number; value: string }>): SnapshotResult {
  const grid = new PreviewGrid();
  for (const seed of fixture) grid.setInput(seed.row, seed.col, seed.value);
  return { grid, sheetNames: ["Sheet1"], activeSheet: 0, copied: null, truncated: false };
}

/**
 * The live workbook, as the snapshot's read surface.
 *
 * Imported lazily so this module stays importable in environments with no
 * backend at all (the corpus, unit tests), and so nothing is invoked until a
 * preview actually asks for a document.
 */
async function liveSnapshotSource(): Promise<SnapshotSource> {
  const lib = await import("../../lib");
  return {
    getSheetNames: async () => (await lib.getSheets()).sheets.map((s: { name: string }) => s.name),
    getActiveSheet: () => lib.getActiveSheet(),
    getUsedRange: () => lib.getUsedRange(),
    getRangeCells: (startRow, startCol, endRow, endCol) =>
      lib.getRangeCellsTyped(startRow, startCol, endRow, endCol),
  };
}

export { MAX_SNAPSHOT_CELLS } from "./snapshot";
export { MAX_REPORTED_CHANGES, summarize } from "./report";
export type { PreviewStubs } from "./backend";
export { PreviewGapError } from "./backend";
