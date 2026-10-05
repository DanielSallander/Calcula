//! FILENAME: app/src/core/lib/__tests__/fillLinePlan.test.ts
// PURPOSE: ONE per-line AutoFill planner (`planFillLine`, core/lib/fillEngine)
//          for every door that fills "like dragging the fill handle": the drag
//          itself, the double-click auto-fill to the edge, and Fill > Series >
//          AutoFill (through @api/fillPatterns).
// CONTEXT: Review finding (j), 2026-10-04. The handle inferred the pattern from
//          the NON-formula values of a line; Series copied the loop and dropped
//          the filter, so ["Item 1", "=B1"] filled as a COPY from Series and as
//          a text increment from the drag -- the drift @api/fillPatterns says it
//          exists to prevent. The loop now lives once, here.

import { describe, it, expect, vi } from "vitest";

vi.mock("../tauri-api", () => ({
  shiftFormulasBatch: vi.fn(async () => []),
  getMergedRegions: vi.fn(async () => []),
  mergeCells: vi.fn(async () => undefined),
}));

import { planFillLine, detectPattern, generateFillValue, type FillLineCell } from "../fillEngine";
import * as facade from "../../../api/fillPatterns";

function cells(values: string[], col = 0, firstRow = 0, styles: number[] = []): FillLineCell[] {
  return values.map((value, i) => ({ row: firstRow + i, col, value, styleIndex: styles[i] ?? 0 }));
}

describe("planFillLine: the fill handle's per-line plan", () => {
  it("infers the pattern from the NON-formula values (Item 1, =B1 -> a text increment, not a copy)", () => {
    const plan = planFillLine({
      source: cells(["Item 1", "=B1"]),
      targets: [{ row: 2, col: 0 }, { row: 3, col: 0 }],
    });
    expect(plan[0].pattern).toEqual(detectPattern(["Item 1"]));
    expect(plan[0].pattern.type).not.toBe("copy");
  });

  it("all formulas: the pattern comes from all the values (nothing is filtered to nothing)", () => {
    const plan = planFillLine({ source: cells(["=A1", "=A2"]), targets: [{ row: 2, col: 0 }] });
    expect(plan[0].pattern).toEqual(detectPattern(["=A1", "=A2"]));
  });

  it("forward (down / right): fillIndex counts on from the source, cycling the source cells", () => {
    const plan = planFillLine({
      source: cells(["1", "3"], 4, 10, [7, 8]),
      targets: [{ row: 12, col: 4 }, { row: 13, col: 4 }, { row: 14, col: 4 }],
    });
    expect(plan.map((p) => [p.row, p.fillIndex, p.sourceRow, p.sourceValue, p.sourceStyleIndex])).toEqual([
      [12, 2, 10, "1", 7],
      [13, 3, 11, "3", 8],
      [14, 4, 10, "1", 7],
    ]);
    expect(plan[0].allSourceValues).toEqual(["1", "3"]);
    // The value the engine then writes: 1, 3 -> 5, 7, 9.
    expect(plan.map((p) => generateFillValue(p.pattern, p.allSourceValues, p.fillIndex))).toEqual(["5", "7", "9"]);
  });

  it("backward (up / left): the source is read from its FAR end, values reversed, pattern from reading order", () => {
    const plan = planFillLine({
      source: cells(["1", "3"], 0, 5),
      targets: [{ row: 4, col: 0 }, { row: 3, col: 0 }],
      backward: true,
    });
    expect(plan.map((p) => [p.row, p.fillIndex, p.sourceRow, p.sourceValue])).toEqual([
      [4, 2, 6, "3"],
      [3, 3, 5, "1"],
    ]);
    expect(plan[0].allSourceValues).toEqual(["3", "1"]);
    expect(plan[0].pattern).toEqual(detectPattern(["1", "3"]));
  });

  it("no source or no target: nothing", () => {
    expect(planFillLine({ source: [], targets: [{ row: 1, col: 0 }] })).toEqual([]);
    expect(planFillLine({ source: cells(["1"]), targets: [] })).toEqual([]);
  });

  it("extensions reach the SAME planner through @api/fillPatterns", () => {
    expect(facade.planFillLine).toBe(planFillLine);
  });
});
