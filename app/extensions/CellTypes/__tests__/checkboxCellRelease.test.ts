//! FILENAME: app/extensions/CellTypes/__tests__/checkboxCellRelease.test.ts
// PURPOSE: A CHECKBOX CELL (Cell Type: Checkbox) toggles on the RELEASE on its
//          own cell, and sliding off cancels -- the Windows checkbox rule,
//          through the same release seam the button cell uses (owner question
//          26, 2026-10-02; BUG-0258 design phase 4, @api/cellClickInterceptors):
//            - its onClick CLAIMS the press for its release: nothing is written
//              at the press, and the cell is selected AT the press (the keyboard
//              follows the press, so Space toggles it next);
//            - the claim's target is exactly that one cell: a release on any
//              other cell is off it, so Core runs nothing (sliding off cancels);
//            - its release flips the value the cell holds AT THE RELEASE, once,
//              through the normal (undoable) cell write, and repaints;
//            - a FORMULA checkbox is display-only: its press selects the cell and
//              is handled, with nothing held and nothing written; a value that
//              is not TRUE/FALSE/empty is not claimed (it renders as text);
//            - Space still toggles AT ONCE (a key has no release to wait for).
// CONTEXT: WHEN a claim runs is Core's press session (src/core/lib/
//          cellPressRelease.ts, its own tests); the cell-type registry passes a
//          claim to it unchanged (src/api/__tests__/cellTypes.test.ts). The
//          backend reads and writes are doubled at src/api/lib.

import { describe, it, expect, vi, beforeEach } from "vitest";

const h = vi.hoisted(() => ({
  /** "row,col" -> the cell as the backend holds it now. */
  cells: new Map<string, { display: string; formula?: string }>(),
  updates: [] as Array<[number, number, string]>,
  dispatched: [] as unknown[],
}));

vi.mock("../../../src/api/lib", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../src/api/lib")>()),
  getCell: async (row: number, col: number) => {
    const cell = h.cells.get(`${row},${col}`);
    return cell ? { row, col, display: cell.display, formula: cell.formula ?? null, styleIndex: 0 } : null;
  },
  updateCell: async (row: number, col: number, value: string) => {
    h.updates.push([row, col, value]);
    const cell = h.cells.get(`${row},${col}`);
    if (cell) cell.display = value;
  },
}));
vi.mock("../../../src/api/gridDispatch", () => ({
  dispatchGridAction: (action: unknown) => void h.dispatched.push(action),
}));
vi.mock("../../../src/api/grid", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../src/api/grid")>()),
  setSelection: (selection: unknown) => ({ type: "SET_SELECTION", payload: selection }),
}));

import { isCellReleaseClaim, type CellPressPoint, type CellReleaseClaim } from "@api/cellClickInterceptors";
import { checkboxCellType, CHECKBOX_TYPE_ID } from "../types/checkbox";

/** The checkbox cell at D7. */
const ROW = 6;
const COL = 3;

function at(row: number, col: number): CellPressPoint {
  return { clientX: 0, clientY: 0, row, col };
}

async function pressOn(row = ROW, col = COL) {
  return checkboxCellType.onClick!({
    row,
    col,
    typeId: CHECKBOX_TYPE_ID,
    params: {},
    event: { clientX: 0, clientY: 0 },
  });
}

async function claimOf(row = ROW, col = COL): Promise<CellReleaseClaim> {
  const answer = await pressOn(row, col);
  expect(isCellReleaseClaim(answer), "the checkbox cell still toggles on the PRESS (its press was not claimed for its release)").toBe(true);
  return answer as CellReleaseClaim;
}

function setCell(display: string, formula?: string, row = ROW, col = COL): void {
  h.cells.set(`${row},${col}`, formula === undefined ? { display } : { display, formula });
}

const repaints: Event[] = [];
window.addEventListener("grid:refresh", (e) => repaints.push(e));

const selectedAtPress = {
  type: "SET_SELECTION",
  payload: { startRow: ROW, startCol: COL, endRow: ROW, endCol: COL, type: "cells" },
};

beforeEach(() => {
  h.cells.clear();
  setCell("FALSE");
  h.updates.length = 0;
  h.dispatched.length = 0;
  repaints.length = 0;
});

describe("a checkbox cell: the press is claimed, the release toggles it", () => {
  it("the press is CLAIMED: nothing is written, and the cell is selected at the press", async () => {
    await claimOf();
    expect(h.updates, "the checkbox cell toggled on the PRESS").toEqual([]);
    expect(repaints, "the press repainted as if it had toggled").toEqual([]);
    expect(h.dispatched, "the press did not select the checkbox's cell").toEqual([selectedAtPress]);
  });

  it("its target is exactly its own cell: a release on any other cell is off it (sliding off cancels)", async () => {
    const claim = await claimOf();
    expect(claim.targetAt(at(ROW, COL))).toBe(claim.key);
    expect(claim.targetAt(at(ROW, COL + 1)), "a release on the NEXT cell counts as the checkbox").toBeNull();
    expect(claim.targetAt(at(ROW - 1, COL)), "a release on the cell ABOVE counts as the checkbox").toBeNull();
  });

  it("its release toggles FALSE -> TRUE once, through the cell write, and repaints", async () => {
    const claim = await claimOf();
    await claim.runAtRelease(at(ROW, COL));
    expect(h.updates).toEqual([[ROW, COL, "TRUE"]]);
    expect(repaints).toHaveLength(1);
  });

  it("an EMPTY (ghost) checkbox becomes TRUE at the release", async () => {
    setCell("");
    const claim = await claimOf();
    await claim.runAtRelease(at(ROW, COL));
    expect(h.updates).toEqual([[ROW, COL, "TRUE"]]);
  });

  it("its release flips the value the cell holds AT THE RELEASE, not the one it held at the press", async () => {
    const claim = await claimOf();
    h.cells.get(`${ROW},${COL}`)!.display = "TRUE";
    await claim.runAtRelease(at(ROW, COL));
    expect(h.updates, "the release wrote the value read at the PRESS").toEqual([[ROW, COL, "FALSE"]]);
  });

  it("a cell that became a formula or text before the release is left alone", async () => {
    const formulaClaim = await claimOf();
    setCell("TRUE", "=A1>0");
    await formulaClaim.runAtRelease(at(ROW, COL));
    setCell("FALSE");
    const textClaim = await claimOf();
    setCell("banana");
    await textClaim.runAtRelease(at(ROW, COL));
    expect(h.updates, "the release wrote a cell it must not toggle").toEqual([]);
    expect(repaints).toEqual([]);
  });
});

describe("what is not claimed for a release", () => {
  it("a FORMULA checkbox: the press selects the cell and is handled, with nothing held and nothing written", async () => {
    setCell("TRUE", "=A1>0");
    const answer = await pressOn();
    expect(answer, "a formula checkbox's press is not simply handled").toBe(true);
    expect(h.dispatched).toEqual([selectedAtPress]);
    expect(h.updates).toEqual([]);
  });

  it("a value that is not TRUE/FALSE/empty is NOT claimed: nothing selected, nothing written", async () => {
    setCell("banana");
    expect(await pressOn()).toBe(false);
    expect(h.dispatched).toEqual([]);
    expect(h.updates).toEqual([]);
  });

  it("Space still toggles AT ONCE (a key has no release to wait for)", async () => {
    const handled = await checkboxCellType.onKeyDown!({ row: ROW, col: COL, typeId: CHECKBOX_TYPE_ID, params: {}, key: " " });
    expect(handled).toBe(true);
    expect(h.updates).toEqual([[ROW, COL, "TRUE"]]);
    expect(h.dispatched).toEqual([selectedAtPress]);
  });
});
