//! FILENAME: app/extensions/Controls/lib/__tests__/floatingStorePinning.test.ts
// PURPOSE: Pin-to-grid behaviour of the floating control store.
// CONTEXT: Pinning governs two moments — where a drag LANDS (snap) and what
//          happens when the grid moves underneath (re-anchor). Both are here
//          because they are the same user-facing idea.

import { describe, it, expect, beforeEach } from "vitest";
import {
  addFloatingControl,
  getFloatingControl,
  getAllFloatingControls,
  moveFloatingControl,
  reanchorFloatingControls,
  resetFloatingStore,
  setSnapResolver,
  makeFloatingControlId,
  type FloatingControl,
} from "../floatingStore";

function ctrl(row: number, col: number, pinned?: boolean): FloatingControl {
  return {
    id: makeFloatingControlId(0, row, col),
    sheetIndex: 0,
    row,
    col,
    x: 137,
    y: 61,
    width: 80,
    height: 28,
    controlType: "button",
    pinToGrid: pinned,
  } as FloatingControl;
}

// Rows 20px, columns 100px — the resolver the extension installs walks real
// per-row/per-column sizes; a fixed grid is enough to pin the semantics.
const gridSnap = (x: number, y: number) => ({
  x: Math.floor(x / 100) * 100,
  y: Math.floor(y / 20) * 20,
});

const shiftRowsDownBy = (at: number, count: number) =>
  (row: number, col: number) => ({ row: row >= at ? row + count : row, col });

const deleteRow = (at: number) =>
  (row: number, col: number) =>
    row === at ? null : { row: row > at ? row - 1 : row, col };

describe("pin to grid", () => {
  beforeEach(() => {
    resetFloatingStore();
    setSnapResolver(null);
  });

  describe("snapping on drag", () => {
    it("snaps a pinned control to the cell boundary", () => {
      addFloatingControl(ctrl(2, 1, true));
      setSnapResolver(gridSnap);
      moveFloatingControl(makeFloatingControlId(0, 2, 1), 137, 61);
      const c = getFloatingControl(makeFloatingControlId(0, 2, 1))!;
      expect({ x: c.x, y: c.y }).toEqual({ x: 100, y: 60 });
    });

    it("leaves an unpinned control exactly where it was dropped", () => {
      // Nudging a free-floating control by one pixel must stay possible.
      addFloatingControl(ctrl(2, 1, false));
      setSnapResolver(gridSnap);
      moveFloatingControl(makeFloatingControlId(0, 2, 1), 137, 61);
      const c = getFloatingControl(makeFloatingControlId(0, 2, 1))!;
      expect({ x: c.x, y: c.y }).toEqual({ x: 137, y: 61 });
    });

    it("does not snap when no resolver is installed", () => {
      addFloatingControl(ctrl(2, 1, true));
      moveFloatingControl(makeFloatingControlId(0, 2, 1), 137, 61);
      expect(getFloatingControl(makeFloatingControlId(0, 2, 1))!.x).toBe(137);
    });
  });

  describe("re-anchoring on a structural edit", () => {
    const movesWithCells = (c: { pinToGrid?: boolean }) => c.pinToGrid === true;

    it("moves a pinned control's anchor AND its id", () => {
      // The id encodes the anchor, so it has to move with it or the store and
      // the backend disagree about which control is which.
      addFloatingControl(ctrl(5, 1, true));
      const changed = reanchorFloatingControls(0, shiftRowsDownBy(0, 2), movesWithCells);

      expect(changed).toBe(true);
      expect(getFloatingControl(makeFloatingControlId(0, 5, 1))).toBeNull();
      const moved = getFloatingControl(makeFloatingControlId(0, 7, 1));
      expect(moved).not.toBeNull();
      expect(moved!.row).toBe(7);
    });

    it("leaves an unpinned control's anchor and id alone", () => {
      addFloatingControl(ctrl(5, 1, false));
      const changed = reanchorFloatingControls(0, shiftRowsDownBy(0, 2), movesWithCells);

      expect(changed).toBe(false);
      expect(getFloatingControl(makeFloatingControlId(0, 5, 1))).not.toBeNull();
    });

    it("never moves the pixel position, pinned or not", () => {
      // A pinned control's geometry is recomputed from its anchor at render;
      // moving x/y here as well would double-apply the shift.
      addFloatingControl(ctrl(5, 1, true));
      reanchorFloatingControls(0, shiftRowsDownBy(0, 2), movesWithCells);
      expect(getFloatingControl(makeFloatingControlId(0, 7, 1))!.x).toBe(137);
    });

    it("drops a pinned control whose anchor row was deleted", () => {
      addFloatingControl(ctrl(5, 1, true));
      const changed = reanchorFloatingControls(0, deleteRow(5), movesWithCells);
      expect(changed).toBe(true);
      expect(getAllFloatingControls()).toHaveLength(0);
    });

    it("ignores controls on other sheets", () => {
      const other = { ...ctrl(5, 1, true), sheetIndex: 1, id: makeFloatingControlId(1, 5, 1) };
      addFloatingControl(other as FloatingControl);
      const changed = reanchorFloatingControls(0, shiftRowsDownBy(0, 2), movesWithCells);
      expect(changed).toBe(false);
      expect(getFloatingControl(makeFloatingControlId(1, 5, 1))).not.toBeNull();
    });
  });
});
