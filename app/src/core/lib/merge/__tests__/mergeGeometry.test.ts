//! FILENAME: app/src/core/lib/merge/__tests__/mergeGeometry.test.ts
// PURPOSE: The selection's blocks and the rectangle questions the Merge menu
//          asks of them (Excel: every Ctrl+click block on its own; overlapping
//          blocks merge nothing; a merge ANYWHERE in the selection presses
//          Merge & Center).

import { describe, it, expect } from "vitest";
import type { Selection } from "../../../types";
import {
  blocksOverlap,
  boundingBox,
  cellCount,
  colsOf,
  intersects,
  isSingleCell,
  regionsTouching,
  rowsOf,
  selectionBlocks,
} from "../mergeGeometry";

function sel(
  startRow: number,
  startCol: number,
  endRow: number,
  endCol: number,
  additionalRanges?: Selection["additionalRanges"],
): Selection {
  return { startRow, startCol, endRow, endCol, type: "cells", additionalRanges };
}

describe("selectionBlocks", () => {
  it("normalises a selection dragged up and left", () => {
    expect(selectionBlocks(sel(4, 3, 1, 0))).toEqual([{ startRow: 1, startCol: 0, endRow: 4, endCol: 3 }]);
  });

  it("lists the Ctrl+click ranges first and the main range LAST", () => {
    const blocks = selectionBlocks(sel(10, 0, 10, 2, [{ startRow: 0, startCol: 0, endRow: 0, endCol: 2 }]));
    expect(blocks).toEqual([
      { startRow: 0, startCol: 0, endRow: 0, endCol: 2 },
      { startRow: 10, startCol: 0, endRow: 10, endCol: 2 },
    ]);
  });

  it("drops a block that repeats another exactly (the same cell Ctrl+clicked twice)", () => {
    const blocks = selectionBlocks(sel(0, 0, 0, 2, [{ startRow: 0, startCol: 2, endRow: 0, endCol: 0 }]));
    expect(blocks).toHaveLength(1);
  });

  it("is empty for no selection", () => {
    expect(selectionBlocks(null)).toEqual([]);
    expect(boundingBox([])).toBeNull();
  });
});

describe("overlap, touching, bounding box", () => {
  it("blocks that share a cell overlap; blocks that only touch edges do not", () => {
    const a = { startRow: 0, startCol: 0, endRow: 0, endCol: 2 };
    const touching = { startRow: 1, startCol: 0, endRow: 1, endCol: 2 };
    const overlapping = { startRow: 0, startCol: 2, endRow: 3, endCol: 2 };
    expect(blocksOverlap([a, touching])).toBe(false);
    expect(blocksOverlap([a, touching, overlapping])).toBe(true);
    expect(intersects(a, overlapping)).toBe(true);
  });

  it("a merged region touching any block counts, even away from the active cell", () => {
    const blocks = selectionBlocks(sel(0, 0, 2, 4));
    const inside = { startRow: 1, startCol: 2, endRow: 1, endCol: 3 };
    const outside = { startRow: 8, startCol: 0, endRow: 8, endCol: 1 };
    expect(regionsTouching(blocks, [inside, outside])).toEqual([inside]);
  });

  it("the bounding box holds every block", () => {
    expect(
      boundingBox([
        { startRow: 5, startCol: 1, endRow: 6, endCol: 1 },
        { startRow: 0, startCol: 3, endRow: 0, endCol: 4 },
      ]),
    ).toEqual({ startRow: 0, startCol: 1, endRow: 6, endCol: 4 });
  });

  it("counts, rows and columns of a rectangle", () => {
    const b = { startRow: 2, startCol: 1, endRow: 3, endCol: 3 };
    expect(cellCount(b)).toBe(6);
    expect(rowsOf(b)).toEqual([2, 3]);
    expect(colsOf(b)).toEqual([1, 2, 3]);
    expect(isSingleCell({ startRow: 4, startCol: 4, endRow: 4, endCol: 4 })).toBe(true);
    expect(isSingleCell(b)).toBe(false);
  });
});
