//! FILENAME: app/src/api/__tests__/cellCues.test.ts
// PURPOSE: The transient cell-cue store: per-owner set/clear, the per-cell
//          index the painter reads every frame, notification on change only.

import { describe, it, expect, beforeEach } from "vitest";
import {
  setCellCues, clearCellCues, clearAllCellCues, getCellCues, listCellCueOwners,
  cellCuesAt, hasAnyCellCues, onCellCuesChanged, type CellCue,
} from "../cellCues";

function cue(factId: string, row: number, col: number, sheetIndex = 0): CellCue {
  return { factId, polarity: "neutral", description: `d ${factId}`, sheetIndex, row, col };
}

beforeEach(() => clearAllCellCues());

describe("@api/cellCues", () => {
  it("is empty for an unknown owner and cell", () => {
    expect(getCellCues("nope")).toEqual([]);
    expect(cellCuesAt(0, 1, 1)).toEqual([]);
    expect(hasAnyCellCues()).toBe(false);
  });

  it("indexes cues by cell across owners, and clearing one owner leaves the others", () => {
    setCellCues("range:a", [cue("f1", 5, 2), cue("f2", 6, 2)]);
    setCellCues("pivot:p", [cue("g1", 5, 2), cue("g2", 9, 9, 1)]);
    expect(cellCuesAt(0, 5, 2).map((c) => c.factId)).toEqual(["f1", "g1"]);
    expect(cellCuesAt(1, 9, 9).map((c) => c.factId)).toEqual(["g2"]);
    expect(cellCuesAt(0, 9, 9)).toEqual([]); // wrong sheet
    expect(listCellCueOwners().sort()).toEqual(["pivot:p", "range:a"]);

    clearCellCues("range:a");
    expect(cellCuesAt(0, 5, 2).map((c) => c.factId)).toEqual(["g1"]);
    expect(cellCuesAt(0, 6, 2)).toEqual([]);
    expect(hasAnyCellCues()).toBe(true);
    clearAllCellCues();
    expect(hasAnyCellCues()).toBe(false);
  });

  it("stores a frozen copy and treats an empty set as a clear", () => {
    const mine = [cue("f1", 1, 1)];
    setCellCues("o", mine);
    mine[0].row = 99;
    expect(getCellCues("o")[0].row).toBe(1);
    expect(Object.isFrozen(getCellCues("o"))).toBe(true);
    setCellCues("o", []);
    expect(listCellCueOwners()).toEqual([]);
  });

  it("notifies with the owner id on set and on a clear that removed something", () => {
    const seen: string[] = [];
    const off = onCellCuesChanged((id) => seen.push(id));
    setCellCues("o", [cue("f1", 1, 1)]);
    clearCellCues("o");
    clearCellCues("o");
    setCellCues("p", [cue("f2", 1, 1)]);
    clearAllCellCues();
    off();
    setCellCues("q", [cue("f3", 1, 1)]);
    expect(seen).toEqual(["o", "o", "p", "p"]);
  });
});
