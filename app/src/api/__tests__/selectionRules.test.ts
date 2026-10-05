//! FILENAME: app/src/api/__tests__/selectionRules.test.ts
// PURPOSE: The three shared selection rules extensions reach through @api
//          (review findings (g) and (h), 2026-10-04): which cell is ACTIVE
//          (`@api/activeCell`), which rectangles a selection holds
//          (`@api/selectionBlocks`), and what is announced after a formatting
//          write lands (`@api/announceFormatting`).

import { describe, it, expect, vi, afterEach } from "vitest";
import { activeCellOf } from "../activeCell";
import { selectionBlocks } from "../selectionBlocks";
import { announceFormattingResult } from "../announceFormatting";
import { cellEvents } from "../cellEvents";
import type { FormattingResult, Selection } from "../types";

function sel(
  startRow: number,
  startCol: number,
  endRow: number,
  endCol: number,
  extra?: Selection["additionalRanges"],
): Selection {
  return { startRow, startCol, endRow, endCol, type: "cells", additionalRanges: extra };
}

describe("activeCellOf: the cell the grid draws as active", () => {
  it("is END, never the anchor: a drag from B2 down to B5 is on B5", () => {
    expect(activeCellOf(sel(1, 1, 4, 1))).toEqual({ row: 4, col: 1 });
  });

  it("never the top-left corner: a drag up-left from D5 to B2 is on B2, a drag down-right on its far end", () => {
    expect(activeCellOf(sel(4, 3, 1, 1))).toEqual({ row: 1, col: 1 });
    expect(activeCellOf(sel(1, 1, 4, 3))).toEqual({ row: 4, col: 3 });
  });

  it("activeRow / activeCol win when the grid sets them", () => {
    expect(activeCellOf({ ...sel(0, 0, 9, 9), activeRow: 3, activeCol: 2 })).toEqual({ row: 3, col: 2 });
  });

  it("no selection: null", () => {
    expect(activeCellOf(null)).toBeNull();
    expect(activeCellOf(undefined)).toBeNull();
  });
});

describe("selectionBlocks: every rectangle, the main one first", () => {
  it("the main range (the active cell's) first, then the others in order, each normalised", () => {
    expect(
      selectionBlocks(
        sel(5, 5, 4, 4, [
          { startRow: 2, startCol: 0, endRow: 0, endCol: 0 },
          { startRow: 8, startCol: 8, endRow: 8, endCol: 9 },
        ]),
      ),
    ).toEqual([
      { startRow: 4, startCol: 4, endRow: 5, endCol: 5 },
      { startRow: 0, startCol: 0, endRow: 2, endCol: 0 },
      { startRow: 8, startCol: 8, endRow: 8, endCol: 9 },
    ]);
  });

  it("a block that repeats another exactly (the same cell Ctrl+clicked twice) is dropped", () => {
    expect(selectionBlocks(sel(0, 0, 0, 0, [{ startRow: 0, startCol: 0, endRow: 0, endCol: 0 }]))).toHaveLength(1);
  });

  it("no selection: none", () => {
    expect(selectionBlocks(null)).toEqual([]);
  });
});

describe("announceFormattingResult", () => {
  const listeners: Array<() => void> = [];
  afterEach(() => {
    while (listeners.length > 0) listeners.pop()!();
  });

  function heard(name: string): { count: () => number } {
    let n = 0;
    const on = (): void => {
      n++;
    };
    window.addEventListener(name, on);
    listeners.push(() => window.removeEventListener(name, on));
    return { count: () => n };
  }

  function result(...cells: Array<[number, number]>): FormattingResult {
    return {
      cells: cells.map(([row, col]) => ({ row, col, display: `r${row}c${col}`, formula: null, styleIndex: 1 }) as never),
      styles: [],
    };
  }

  it("a cell event per cell, then ONE styles:refresh and ONE grid:refresh", () => {
    const events: Array<{ row: number; col: number; newValue: unknown }> = [];
    listeners.push(cellEvents.subscribe((e) => events.push({ row: e.row, col: e.col, newValue: e.newValue })));
    const styles = heard("styles:refresh");
    const grid = heard("grid:refresh");
    announceFormattingResult(result([0, 0], [2, 3]));
    expect(events).toEqual([
      { row: 0, col: 0, newValue: "r0c0" },
      { row: 2, col: 3, newValue: "r2c3" },
    ]);
    expect(styles.count()).toBe(1);
    expect(grid.count()).toBe(1);
  });

  it("several results (a write per block): every cell announced, the refreshes still once", () => {
    const rows: number[] = [];
    listeners.push(cellEvents.subscribe((e) => rows.push(e.row)));
    const grid = heard("grid:refresh");
    announceFormattingResult([result([0, 0]), result([7, 7])]);
    expect(rows).toEqual([0, 7]);
    expect(grid.count()).toBe(1);
  });

  it("an empty / absent result still refreshes (the write landed; the backend reported no cell)", () => {
    const grid = heard("grid:refresh");
    announceFormattingResult(null);
    expect(grid.count()).toBe(1);
  });
});
