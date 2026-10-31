//! FILENAME: app/extensions/Sparklines/__tests__/mergePendingGroups.test.ts
// PURPOSE: revF#3 -- the merge of a PENDING sparkline change with groups the
//          backend rewrote on its own (a structural edit moved them, gave
//          them more areas or removed them, or an undo put them back): by
//          group id, each field
//          the change touched keeping the change.

import { describe, it, expect } from "vitest";
import { mergeSparklineGroups } from "../store";
import type { CellRange, SparklineGroup } from "../types";

function range(startRow: number, startCol: number, endRow: number, endCol: number): CellRange {
  return { startRow, startCol, endRow, endCol };
}

function group(id: number, location: CellRange, dataRange: CellRange, color = "#4472C4"): SparklineGroup {
  return { id, location, dataRange, type: "line", color } as unknown as SparklineGroup;
}

describe("mergeSparklineGroups (revF#3)", () => {
  it("a recolour keeps its colour AND takes the moved location and data", () => {
    const base = [group(1, range(1, 4, 4, 4), range(1, 0, 4, 2))];
    const current = [group(1, range(1, 4, 4, 4), range(1, 0, 4, 2), "#000000")];
    const stored = [group(1, range(1, 4, 5, 4), range(1, 0, 5, 2))];
    expect(mergeSparklineGroups(current, base, stored)).toEqual([
      group(1, range(1, 4, 5, 4), range(1, 0, 5, 2), "#000000"),
    ]);
  });

  it("a group the change created is kept, under a fresh id when a group the backend has took its id", () => {
    const base = [group(1, range(1, 4, 4, 4), range(1, 0, 4, 2))];
    // The change created group 2; the backend holds a group 2 of its own (one an
    // undo put back -- a structural edit never makes a second group, BUG-0616#4).
    const current = [...base, group(2, range(1, 7, 4, 7), range(1, 0, 4, 2), "#00ff00")];
    const stored = [group(1, range(1, 4, 1, 4), range(1, 0, 1, 2)), group(2, range(2, 4, 4, 4), range(3, 0, 5, 2))];
    const merged = mergeSparklineGroups(current, base, stored);
    expect(merged.map((g) => [g.id, g.color, g.location.startCol])).toEqual([
      [1, "#4472C4", 4],
      [2, "#4472C4", 4],
      [3, "#00ff00", 7],
    ]);
  });

  it("a group the change removed stays removed, and so does one the backend removed", () => {
    const base = [group(1, range(1, 4, 4, 4), range(1, 0, 4, 2)), group(2, range(1, 6, 4, 6), range(1, 0, 4, 2))];
    // The change deleted group 1 and recoloured group 2; the edit deleted group 2's cells.
    const current = [group(2, range(1, 6, 4, 6), range(1, 0, 4, 2), "#000000")];
    const stored = [group(1, range(1, 4, 5, 4), range(1, 0, 5, 2))];
    expect(mergeSparklineGroups(current, base, stored)).toEqual([]);
  });

  it("a group an undo put back is taken as the backend has it", () => {
    const base: SparklineGroup[] = [];
    const current: SparklineGroup[] = [];
    const stored = [group(5, range(1, 4, 4, 4), range(1, 0, 4, 2))];
    expect(mergeSparklineGroups(current, base, stored)).toEqual(stored);
  });

  // BUG-0346 (review rev4B#4). The fresh id was `Math.max(0, ...out ids,
  // ...current ids) + 1`: one call argument per group, so a sheet a fill gave
  // one group per cell threw RangeError inside a refused save's merge.
  // SABOTAGE: put the spread back -> RangeError "Maximum call stack size exceeded".
  it("a sheet with very many groups merges without a RangeError, and a colliding new group still gets a fresh id", () => {
    const n = 150_000;
    const base: SparklineGroup[] = [];
    const stored: SparklineGroup[] = [];
    const current: SparklineGroup[] = [];
    for (let i = 1; i <= n; i++) {
      // The backend's own groups (an undo put them back) ...
      stored.push(group(i, range(i, 4, i, 4), range(i, 0, i, 2)));
      // ... and the change's new ones, whose ids the backend's took.
      current.push(group(i, range(i, 7, i, 7), range(i, 0, i, 2), "#00ff00"));
    }
    const merged = mergeSparklineGroups(current, base, stored);
    expect(merged).toHaveLength(2 * n);
    expect(merged[n].id, "the first created group moved past every id in use").toBe(n + 1);
    expect(merged[2 * n - 1].id).toBe(2 * n);
    expect(new Set(merged.map((g) => g.id)).size, "no id used twice").toBe(2 * n);
  });
});
