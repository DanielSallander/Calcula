//! FILENAME: app/src/core/lib/gridRenderer/rendering/mergeIndex.test.ts
// PURPOSE: Prove buildMergeSlaveIndex (C3b) is byte-identical to the old
//   per-cell getMasterCellKey scan it replaced, so merged-cell rendering is
//   provably unchanged while the cost drops from O(visible x cache) to O(cache).

import { describe, it, expect } from "vitest";
import { buildMergeSlaveIndex } from "./mergeIndex";

type CellMap = Map<string, { rowSpan?: number; colSpan?: number }>;

function makeCells(
  entries: Array<[row: number, col: number, rowSpan: number, colSpan: number]>,
): CellMap {
  const map: CellMap = new Map();
  for (const [r, c, rs, cs] of entries) {
    map.set(`${r},${c}`, { rowSpan: rs, colSpan: cs });
  }
  return map;
}

// The ORIGINAL per-cell scan, preserved verbatim as an equivalence oracle.
function oracleMasterKey(row: number, col: number, cells: CellMap): string | null {
  for (const [key, cell] of cells.entries()) {
    const rowSpan = cell.rowSpan ?? 1;
    const colSpan = cell.colSpan ?? 1;
    if (rowSpan > 1 || colSpan > 1) {
      const parts = key.split(",");
      const masterRow = parseInt(parts[0], 10);
      const masterCol = parseInt(parts[1], 10);
      if (
        row >= masterRow &&
        row < masterRow + rowSpan &&
        col >= masterCol &&
        col < masterCol + colSpan &&
        !(row === masterRow && col === masterCol)
      ) {
        return key;
      }
    }
  }
  return null;
}

describe("buildMergeSlaveIndex (C3b)", () => {
  it("maps interior slaves to the master and excludes the master itself", () => {
    const cells = makeCells([[0, 0, 3, 4]]); // master 0,0 spans rows 0-2, cols 0-3
    const idx = buildMergeSlaveIndex(cells);
    expect(idx.get("0,1")).toBe("0,0");
    expect(idx.get("1,0")).toBe("0,0");
    expect(idx.get("2,3")).toBe("0,0");
    expect(idx.has("0,0")).toBe(false); // master is NOT a slave
    expect(idx.get("0,4") ?? null).toBeNull(); // outside the merge
    expect(idx.get("3,0") ?? null).toBeNull();
  });

  it("a 1x1 'merge' produces no slave entries", () => {
    expect(buildMergeSlaveIndex(makeCells([[5, 5, 1, 1]])).size).toBe(0);
  });

  it("keeps two disjoint merges under their own masters", () => {
    const idx = buildMergeSlaveIndex(makeCells([[0, 0, 2, 2], [10, 10, 2, 2]]));
    expect(idx.get("1,1")).toBe("0,0");
    expect(idx.get("11,11")).toBe("10,10");
    expect(idx.get("1,1")).not.toBe(idx.get("11,11"));
  });

  it("is byte-identical to the old per-cell scan across a swept range (oracle)", () => {
    const cells = makeCells([
      [0, 0, 3, 4], // origin merge
      [5, 2, 2, 2], // mid merge
      [8, 8, 1, 1], // 1x1 (no span)
      [10, 0, 4, 1], // tall single-column merge
    ]);
    const idx = buildMergeSlaveIndex(cells);
    for (let r = 0; r <= 15; r++) {
      for (let c = 0; c <= 12; c++) {
        expect(idx.get(`${r},${c}`) ?? null).toBe(oracleMasterKey(r, c, cells));
      }
    }
  });
});
