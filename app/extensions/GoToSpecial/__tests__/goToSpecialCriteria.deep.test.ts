//! FILENAME: app/extensions/GoToSpecial/__tests__/goToSpecialCriteria.deep.test.ts
// PURPOSE: Deep tests for the areas Go To Special selects (matchAreas.ts):
//          large and awkward result sets, against an independent oracle.
// CONTEXT: This file used to replicate the dialog's bounding-box handler and
//          pin it ("computes correct bounds from cells in all 4 corners" -- a
//          selection of A1:ALL10000 for four constants), plus a criteria
//          matcher it also wrote itself, so it agreed with itself whatever the
//          product did. Both are gone: the grouping under test is the real one,
//          and the oracle below is a plain set comparison that shares no code
//          with it.

import { describe, it, expect } from "vitest";
import { groupMatchedCells, selectionForMatches, type MatchedCell, type MatchArea } from "../lib/matchAreas";

function cellSet(cells: MatchedCell[]): Set<string> {
  return new Set(cells.map((c) => `${c.row},${c.col}`));
}

/** Oracle: the areas cover the set exactly, with no overlap and nothing extra. */
function assertExactCover(cells: MatchedCell[], areas: MatchArea[]): void {
  const want = cellSet(cells);
  const seen = new Set<string>();
  for (const a of areas) {
    expect(a.startRow <= a.endRow && a.startCol <= a.endCol, "an area is inverted").toBe(true);
    for (let r = a.startRow; r <= a.endRow; r++) {
      for (let c = a.startCol; c <= a.endCol; c++) {
        const k = `${r},${c}`;
        expect(want.has(k), `area ${JSON.stringify(a)} covers ${k}, which did not match`).toBe(true);
        expect(seen.has(k), `${k} is covered twice`).toBe(false);
        seen.add(k);
      }
    }
  }
  expect(seen.size).toBe(want.size);
}

/** A deterministic pseudo-random generator (no flaky seeds). */
function lcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}

describe("four corners of a large sheet", () => {
  it("are four one-cell areas, never A1 to the far corner", () => {
    const cells = [
      { row: 0, col: 0 },
      { row: 0, col: 999 },
      { row: 9999, col: 0 },
      { row: 9999, col: 999 },
    ];
    const areas = groupMatchedCells(cells);
    expect(areas).toHaveLength(4);
    assertExactCover(cells, areas);
  });
});

describe("rows, columns and blocks", () => {
  it("a full row run is one area", () => {
    const cells = Array.from({ length: 50 }, (_, c) => ({ row: 7, col: c }));
    expect(groupMatchedCells(cells)).toEqual([{ startRow: 7, startCol: 0, endRow: 7, endCol: 49 }]);
  });

  it("a full column run is one area", () => {
    const cells = Array.from({ length: 500 }, (_, r) => ({ row: r, col: 3 }));
    expect(groupMatchedCells(cells)).toEqual([{ startRow: 0, startCol: 3, endRow: 499, endCol: 3 }]);
  });

  it("two blocks separated by one empty row stay two areas", () => {
    const cells: MatchedCell[] = [];
    for (const r of [0, 1, 3, 4]) for (let c = 0; c < 3; c++) cells.push({ row: r, col: c });
    expect(groupMatchedCells(cells)).toEqual([
      { startRow: 0, startCol: 0, endRow: 1, endCol: 2 },
      { startRow: 3, startCol: 0, endRow: 4, endCol: 2 },
    ]);
  });

  it("input order does not matter", () => {
    const cells = [{ row: 2, col: 2 }, { row: 0, col: 0 }, { row: 1, col: 0 }, { row: 2, col: 1 }];
    const shuffled = [...cells].reverse();
    expect(groupMatchedCells(shuffled)).toEqual(groupMatchedCells(cells));
  });
});

describe("random result sets against the oracle", () => {
  for (const seed of [1, 7, 42, 2026]) {
    it(`seed ${seed}: the areas cover the matches exactly`, () => {
      const rnd = lcg(seed);
      const cells: MatchedCell[] = [];
      for (let r = 0; r < 60; r++) for (let c = 0; c < 12; c++) if (rnd() < 0.45) cells.push({ row: r, col: c });
      const areas = groupMatchedCells(cells);
      assertExactCover(cells, areas);
      const payload = selectionForMatches(cells)!;
      const fromPayload: MatchArea[] = [
        {
          startRow: Math.min(payload.startRow, payload.endRow),
          startCol: Math.min(payload.startCol, payload.endCol),
          endRow: Math.max(payload.startRow, payload.endRow),
          endCol: Math.max(payload.startCol, payload.endCol),
        },
        ...(payload.additionalRanges ?? []),
      ];
      assertExactCover(cells, fromPayload);
    });
  }
});

describe("scale", () => {
  it("10,000 matches in a 100x100 block group into ONE area quickly", () => {
    const cells = Array.from({ length: 10_000 }, (_, i) => ({ row: Math.floor(i / 100), col: i % 100 }));
    const t0 = performance.now();
    const areas = groupMatchedCells(cells);
    expect(performance.now() - t0).toBeLessThan(1000);
    expect(areas).toEqual([{ startRow: 0, startCol: 0, endRow: 99, endCol: 99 }]);
  });

  it("a single cell is a single-cell selection", () => {
    const payload = selectionForMatches([{ row: 42, col: 7 }])!;
    expect(payload).toMatchObject({ startRow: 42, startCol: 7, endRow: 42, endCol: 7, type: "cells" });
    expect(payload.additionalRanges).toBeUndefined();
  });
});
