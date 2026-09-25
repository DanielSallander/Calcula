//! FILENAME: app/src/core/state/__tests__/gridReducer-canvasSurface.test.ts
// PURPOSE: The CANVAS SURFACE in Core's reducer. The surface is resolved in the
//          SAME reduce step as the sheet context (the BUG-0052 one-flush
//          contract): a frame painted between "the active sheet changed" and
//          "it is a canvas" would paint a canvas as a grid of cells.
//          On a canvas there is no cell selection: every selection action is a
//          no-op, and leaving the canvas restores a cell cursor at A1.

import { describe, it, expect } from "vitest";
import { gridReducer, getInitialState } from "../gridReducer";
import {
  addToSelection,
  extendSelection,
  moveSelection,
  scrollToCell,
  setActiveSheet,
  setSelection,
  setSheetContext,
  setSheetSurfaces,
} from "../gridActions";
import type { GridState } from "../../types";

function onCanvas(): GridState {
  return gridReducer(getInitialState(), setSheetContext(1, "Dashboard", "canvas"));
}

describe("entering a sheet resolves its surface in one step", () => {
  it("an explicit canvas surface lands with the context and clears the selection", () => {
    const s = onCanvas();
    expect(s.sheetContext.activeSheetIndex).toBe(1);
    expect(s.surface).toBe("canvas");
    expect(s.selection).toBeNull();
    expect(s.sheetSurfaces[1]).toBe("canvas");
  });

  it("without an explicit surface, the remembered map decides", () => {
    let s = gridReducer(getInitialState(), setSheetSurfaces({ 2: "canvas" }));
    s = gridReducer(s, setActiveSheet(2, "Page 2"));
    expect(s.surface).toBe("canvas");
    s = gridReducer(s, setActiveSheet(0, "Sheet1"));
    expect(s.surface).toBe("grid");
  });

  it("leaving a canvas restores a cell cursor at A1", () => {
    const s = gridReducer(onCanvas(), setSheetContext(0, "Sheet1", "grid"));
    expect(s.surface).toBe("grid");
    expect(s.selection).toMatchObject({ startRow: 0, startCol: 0, endRow: 0, endCol: 0 });
  });

  it("a worksheet-to-worksheet switch keeps its selection handling unchanged", () => {
    let s = gridReducer(getInitialState(), setSelection(3, 3, 5, 5));
    s = gridReducer(s, setSheetContext(1, "Sheet2", "grid"));
    expect(s.surface).toBe("grid");
    expect(s.selection).toMatchObject({ startRow: 3, startCol: 3 });
  });
});

describe("on a canvas, selection actions are no-ops", () => {
  it("SET_SELECTION leaves the selection null (a Name Box jump, a script, a click)", () => {
    const s = gridReducer(onCanvas(), setSelection(1, 1, 1, 1));
    expect(s.selection).toBeNull();
  });

  it("POSITIVE CONTROL: the same action on a worksheet selects", () => {
    const s = gridReducer(getInitialState(), setSelection(1, 1, 1, 1));
    expect(s.selection).toMatchObject({ startRow: 1, startCol: 1 });
  });

  it("MOVE / ADD / EXTEND leave it null too (a null selection must not become a hidden A1 cursor)", () => {
    const c = onCanvas();
    expect(gridReducer(c, moveSelection(1, 0, false)).selection).toBeNull();
    expect(gridReducer(c, addToSelection(2, 2)).selection).toBeNull();
    expect(gridReducer(c, extendSelection(3, 3)).selection).toBeNull();
  });

  it("POSITIVE CONTROL: MOVE and ADD on a worksheet do select", () => {
    const g = getInitialState();
    expect(gridReducer(g, moveSelection(1, 0, false)).selection).not.toBeNull();
    expect(gridReducer(g, addToSelection(2, 2)).selection).not.toBeNull();
  });

  it("scrolling to a cell does nothing: a canvas's extent is its page", () => {
    const c = onCanvas();
    const after = gridReducer(c, scrollToCell(999, 25));
    expect(after.viewport.scrollY).toBe(c.viewport.scrollY);
    expect(after.viewport.scrollX).toBe(c.viewport.scrollX);
  });
});

describe("the surfaces MAP never flips the active surface", () => {
  it("a list that is ahead of the context (a sheet move in flight) leaves the active surface alone", () => {
    // Worksheet active at 0; the new list already says index 0 is a canvas.
    const s = gridReducer(getInitialState(), setSheetSurfaces({ 0: "canvas" }));
    expect(s.surface).toBe("grid");
    expect(s.sheetSurfaces[0]).toBe("canvas");
    // The switch that follows carries the surface in the same step.
    expect(gridReducer(s, setActiveSheet(0, "Canvas1", "canvas")).surface).toBe("canvas");
  });
});
