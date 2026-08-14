//! FILENAME: app/e2e/__tests__/walkerSheetCoverage.test.ts
// PURPOSE: Prove that the walk report can tell "the oracles found no sheet bug"
//          apart from "the walker never changed a sheet".
//
// CONTEXT. `summarizeCoverage` counts an action as explored when it ran without
// throwing. Half the sheet actions CANNOT throw: `sheet.add` probes
// `isVisible({ timeout: 500 })` and returns silently if the button is not there;
// `sheet.switch` and `sheet.delete` do the same. So a green report reading
// `sheet=7` has never distinguished seven sheet operations from seven no-ops.
//
// That reading is not hypothetical — it is BUG-0031's exact shape, where
// `chart.select` / `chart.delete` were counted as explored for the whole
// programme while talking to a store that was never wired up. And it mattered
// here the moment `EXCLUDED_UNTIL_FIXED` was emptied, because the FIRST
// question about the newly-reachable sheet surface is whether the walker really
// reached it.
//
// The answer is now OBSERVED (`ActionTiming.sheetChange`, written by the walk
// runner from the pre- and post-action snapshots) instead of inferred, and
// these cases pin both directions, including the detector firing.

import { describe, it, expect } from "vitest";
import {
  summarizeCoverage,
  sheetShapeOf,
  sheetShapesDiffer,
} from "../walker/walkRunner";
import type { ActionTiming, SheetShape } from "../walker/walkRunner";
import type { StateSnapshot } from "../invariants/stateSnapshot";

function shape(
  count: number,
  active: number,
  names: string[],
  visibility: string[] = [],
  tabColors: string[] = []
): SheetShape {
  return { count, active, names, visibility, tabColors };
}

function timing(
  step: number,
  id: string,
  sheetChange?: { before: SheetShape; after: SheetShape },
  error?: string
): ActionTiming {
  return {
    step,
    id,
    params: {},
    startedAtMs: step * 100,
    durationMs: 10,
    ...(sheetChange ? { sheetChange } : {}),
    ...(error ? { error } : {}),
  };
}

describe("sheet-structure coverage is measured, not inferred", () => {
  it("counts a sheet action as effective only when the workbook answered", () => {
    const added = {
      before: shape(1, 0, ["Sheet1"]),
      after: shape(2, 1, ["Sheet1", "Sheet2"]),
    };
    const summary = summarizeCoverage([
      timing(1, "sheet.add", added),
      timing(2, "sheet.add"), // silent no-op: the button was not there
      timing(3, "cell.click"),
    ]);

    expect(summary.sheet.attempted).toBe(2);
    expect(summary.sheet.effective).toBe(1);
    expect(summary.sheet.byActionEffective).toEqual({ "sheet.add": 1 });
    // The OLD reading — "it ran, so it counts" — is still there for families,
    // which is exactly why the sheet accounting has to be separate.
    expect(summary.families.sheet).toBe(2);
  });

  it("sees a RENAME, which no count of sheets ever could", () => {
    const renamed = {
      before: shape(2, 0, ["Sheet1", "Sheet2"]),
      after: shape(2, 0, ["Sheet1", "Blad_7"]),
    };
    const summary = summarizeCoverage([timing(1, "sheet.rename", renamed)]);
    expect(summary.sheet.effective).toBe(1);
    expect(summary.sheet.byActionEffective["sheet.rename"]).toBe(1);
  });

  it("sees a HIDE of a NON-active sheet, which count+active+names never could", () => {
    // The three operations BUG-0050 made undoable move nothing the old shape
    // carried: hiding a non-active sheet changes no count, no name and no
    // active index. Without the visibility axis, sheet.hide of a background
    // sheet — and EVERY unhide — was issued-but-never-effective (§14a).
    const hidden = {
      before: shape(2, 0, ["Sheet1", "Sheet2"], ["visible", "visible"]),
      after: shape(2, 0, ["Sheet1", "Sheet2"], ["visible", "hidden"]),
    };
    expect(sheetShapesDiffer(hidden.before, hidden.after)).toBe(true);
    const summary = summarizeCoverage([timing(1, "sheet.hide", hidden)]);
    expect(summary.sheet.effective).toBe(1);
  });

  it("sees a TAB COLOUR, which nothing else in the shape ever could", () => {
    const recoloured = {
      before: shape(1, 0, ["Sheet1"], ["visible"], [""]),
      after: shape(1, 0, ["Sheet1"], ["visible"], ["#C00000"]),
    };
    expect(sheetShapesDiffer(recoloured.before, recoloured.after)).toBe(true);
    const summary = summarizeCoverage([timing(1, "sheet.tabColor", recoloured)]);
    expect(summary.sheet.effective).toBe(1);
    expect(summary.sheet.byActionEffective["sheet.tabColor"]).toBe(1);
  });

  it("sees a SWITCH, which no list of names ever could", () => {
    const switched = {
      before: shape(3, 0, ["Sheet1", "Sheet2", "Sheet3"]),
      after: shape(3, 2, ["Sheet1", "Sheet2", "Sheet3"]),
    };
    expect(
      sheetShapesDiffer(switched.before, switched.after),
      "an active-sheet move is a change"
    ).toBe(true);
    const summary = summarizeCoverage([timing(1, "sheet.switch", switched)]);
    expect(summary.sheet.effective).toBe(1);
  });

  it("reports a wholly inert sheet surface as zero, not as coverage", () => {
    const summary = summarizeCoverage([
      timing(1, "sheet.add"),
      timing(2, "sheet.switch"),
      timing(3, "sheet.rename"),
      timing(4, "sheet.delete"),
    ]);
    expect(summary.families.sheet, "all four 'ran'").toBe(4);
    expect(
      summary.sheet.effective,
      "and not one of them changed anything — the surface was NOT explored"
    ).toBe(0);
  });

  it("names a NON-sheet action that moved the sheet structure", () => {
    // A finding in its own right: nothing but the sheet family is supposed to
    // add, drop or rename a sheet.
    const dropped = {
      before: shape(3, 2, ["Sheet1", "Sheet2", "Sheet3"]),
      after: shape(2, 1, ["Sheet1", "Sheet2"]),
    };
    const summary = summarizeCoverage([timing(9, "undo.undo", dropped)]);
    expect(summary.sheet.attempted).toBe(0);
    expect(summary.unexpectedSheetChanges).toEqual([{ step: 9, id: "undo.undo" }]);
  });

  it("counts an action that threw but still changed the sheets", () => {
    // `threw` excludes it from the family census (it did not complete), but the
    // workbook moved and that has to be visible — a half-applied sheet
    // operation is the more interesting of the two states.
    const half = {
      before: shape(1, 0, ["Sheet1"]),
      after: shape(2, 0, ["Sheet1", "Sheet2"]),
    };
    const summary = summarizeCoverage([timing(1, "sheet.add", half, "boom")]);
    expect(summary.threw).toBe(1);
    expect(summary.families.sheet, "not counted as a clean run").toBeUndefined();
    expect(summary.sheet.attempted).toBe(1);
    expect(summary.sheet.effective, "but the effect is still counted").toBe(1);
  });
});

describe("the sheet shape reads what the snapshot actually holds", () => {
  const snap = (
    count: number,
    active: number,
    names: string[]
  ): StateSnapshot =>
    ({
      logical: { sheetCount: count, activeSheet: active, sheetNames: names },
    }) as unknown as StateSnapshot;

  it("carries names, count, active index, visibility and tab colours", () => {
    expect(sheetShapeOf(snap(2, 1, ["A", "B"]))).toEqual({
      count: 2,
      active: 1,
      names: ["A", "B"],
      visibility: [],
      tabColors: [],
    });
  });

  it("survives a snapshot taken before sheetNames existed", () => {
    const legacy = { logical: { sheetCount: 1, activeSheet: 0 } } as unknown as StateSnapshot;
    expect(sheetShapeOf(legacy).names).toEqual([]);
  });

  it("does not report a change when nothing changed", () => {
    const a = sheetShapeOf(snap(2, 1, ["A", "B"]));
    const b = sheetShapeOf(snap(2, 1, ["A", "B"]));
    expect(sheetShapesDiffer(a, b)).toBe(false);
  });

  it("copies the names, so a later snapshot cannot rewrite a recorded shape", () => {
    // The runner keeps `before` while the next snapshot overwrites `snapshot`.
    // Sharing the array would make every recorded change read as "no change".
    const names = ["A", "B"];
    const recorded = sheetShapeOf(snap(2, 0, names));
    names[1] = "RENAMED";
    expect(recorded.names).toEqual(["A", "B"]);
  });
});
