//! FILENAME: app/extensions/Checkbox/__tests__/checkboxRelease.test.ts
// PURPOSE: A legacy style-flag CHECKBOX cell toggles on the RELEASE on its own
//          cell, and sliding off cancels -- the Windows checkbox rule, through
//          the same release seam the in-cell buttons use (owner question 26,
//          2026-10-02; BUG-0258 design phase 4, @api/cellClickInterceptors):
//            - its click interceptor CLAIMS the press for its release: nothing
//              is written at the press, and the cell is selected AT the press
//              (the keyboard follows the press, so Space toggles it next);
//            - the claim's target is exactly that one cell: a release on any
//              other cell is off it, so Core runs nothing (sliding off cancels);
//            - its release flips the value the cell holds AT THE RELEASE, once,
//              through the normal (undoable) cell write, and repaints;
//            - a cell that is not a checkbox is not claimed (Core selects it as
//              before), and one that stopped being a checkbox before the
//              release is left alone.
// CONTEXT: WHEN a claim runs is Core's press session (src/core/lib/
//          cellPressRelease.ts, its own tests); this pins what the checkbox's
//          claim IS and DOES. The backend reads and writes are doubled at
//          src/api/lib, the grid dispatch at src/api/gridDispatch.

import { describe, it, expect, vi, beforeEach } from "vitest";

const h = vi.hoisted(() => ({
  /** "row,col" -> the cell as the backend holds it now. */
  cells: new Map<string, { display: string; styleIndex: number }>(),
  updates: [] as Array<[number, number, string]>,
  dispatched: [] as unknown[],
}));

/** Style 5 is a checkbox style; style 0 is not. */
const CHECKBOX_STYLE = 5;

vi.mock("../../../src/api/lib", () => ({
  getAllStyles: vi.fn(async () => []),
  getStyle: vi.fn(async (index: number) => (index === CHECKBOX_STYLE ? { checkbox: true } : { checkbox: false })),
  getCell: vi.fn(async (row: number, col: number) => {
    const cell = h.cells.get(`${row},${col}`);
    return cell ? { row, col, display: cell.display, styleIndex: cell.styleIndex } : null;
  }),
  updateCell: vi.fn(async (row: number, col: number, value: string) => {
    h.updates.push([row, col, value]);
    const cell = h.cells.get(`${row},${col}`);
    if (cell) cell.display = value;
  }),
  updateCellsBatch: vi.fn(async () => []),
  applyFormatting: vi.fn(async () => {}),
}));
vi.mock("../../../src/api/gridDispatch", () => ({
  dispatchGridAction: (action: unknown) => void h.dispatched.push(action),
}));
vi.mock("../../../src/api/grid", () => ({
  setSelection: (selection: unknown) => ({ type: "SET_SELECTION", payload: selection }),
}));

import { isCellReleaseClaim, type CellPressPoint, type CellReleaseClaim } from "@api/cellClickInterceptors";
import { checkboxClickInterceptor } from "../interceptors";

/** The legacy checkbox at B3. */
const ROW = 2;
const COL = 1;

function at(row: number, col: number): CellPressPoint {
  return { clientX: 0, clientY: 0, row, col };
}

async function pressOn(row = ROW, col = COL) {
  return checkboxClickInterceptor(row, col, { clientX: 0, clientY: 0 });
}

async function claimOf(row = ROW, col = COL): Promise<CellReleaseClaim> {
  const answer = await pressOn(row, col);
  expect(isCellReleaseClaim(answer), "the checkbox still toggles on the PRESS (its press was not claimed for its release)").toBe(true);
  return answer as CellReleaseClaim;
}

const repaints: Event[] = [];
window.addEventListener("styles:refresh", (e) => repaints.push(e));

beforeEach(() => {
  h.cells.clear();
  h.cells.set(`${ROW},${COL}`, { display: "FALSE", styleIndex: CHECKBOX_STYLE });
  h.cells.set(`${ROW},${COL + 1}`, { display: "x", styleIndex: 0 });
  h.updates.length = 0;
  h.dispatched.length = 0;
  repaints.length = 0;
});

describe("a legacy checkbox: the press is claimed, the release toggles it", () => {
  it("the press is CLAIMED: nothing is written, and the cell is selected at the press", async () => {
    await claimOf();
    expect(h.updates, "the checkbox toggled on the PRESS").toEqual([]);
    expect(repaints, "the press repainted as if it had toggled").toEqual([]);
    expect(h.dispatched, "the press did not select the checkbox's cell").toHaveLength(1);
    expect(h.dispatched[0]).toEqual({
      type: "SET_SELECTION",
      payload: { startRow: ROW, startCol: COL, endRow: ROW, endCol: COL, type: "cells" },
    });
  });

  it("its target is exactly its own cell: a release on any other cell is off it (sliding off cancels)", async () => {
    const claim = await claimOf();
    expect(claim.targetAt(at(ROW, COL))).toBe(claim.key);
    expect(claim.targetAt(at(ROW, COL + 1)), "a release on the NEXT cell counts as the checkbox").toBeNull();
    expect(claim.targetAt(at(ROW + 1, COL)), "a release on the cell BELOW counts as the checkbox").toBeNull();
  });

  it("its release toggles FALSE -> TRUE once, through the cell write, and repaints", async () => {
    const claim = await claimOf();
    await claim.runAtRelease(at(ROW, COL));
    expect(h.updates).toEqual([[ROW, COL, "TRUE"]]);
    expect(repaints).toHaveLength(1);
  });

  it("its release flips the value the cell holds AT THE RELEASE, not the one it held at the press", async () => {
    const claim = await claimOf();
    // Something else (a script, a recalculation) set it TRUE while the press was held.
    h.cells.get(`${ROW},${COL}`)!.display = "TRUE";
    await claim.runAtRelease(at(ROW, COL));
    expect(h.updates, "the release wrote the value read at the PRESS").toEqual([[ROW, COL, "FALSE"]]);
  });

  it("a cell that is not a checkbox is NOT claimed: nothing selected, nothing written (Core selects it as before)", async () => {
    expect(await pressOn(ROW, COL + 1)).toBe(false);
    expect(await pressOn(40, 40), "an empty cell").toBe(false);
    expect(h.dispatched).toEqual([]);
    expect(h.updates).toEqual([]);
  });

  it("a cell that stopped being a checkbox before the release is left alone", async () => {
    const claim = await claimOf();
    h.cells.get(`${ROW},${COL}`)!.styleIndex = 0;
    await claim.runAtRelease(at(ROW, COL));
    expect(h.updates, "the release wrote a cell that is no longer a checkbox").toEqual([]);
    expect(repaints).toEqual([]);
  });
});
