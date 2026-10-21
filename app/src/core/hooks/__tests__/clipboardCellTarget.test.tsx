//! FILENAME: app/src/core/hooks/__tests__/clipboardCellTarget.test.tsx
// PURPOSE: Copy, Cut and Paste on a floating grid's cells (P3 S10, owner
//          finding G3), through the REAL clipboard hook: the grid-command door
//          hands the hook the OBJECT target (`ctx.target`), and
//            - Copy reads the grid's cells through its styled read and records
//              the grid as the source (name "Float1", index -1, never a sheet);
//            - Paste writes the grid's cells with ONE targeted batch, Excel's
//              relative shift applied on the grid's own coordinates, and moves
//              the GRID's selection (never Core's, hidden under it);
//            - a Cut from Float1!B2 pasted on the HOST at the same B2 clears
//              its source with ONE targeted clearRangeWithOptions -- the raw
//              coordinates are the same, the cells are not, and reading them
//              as one skipped the clear and silently turned the cut into a copy;
//            - a cut and paste INSIDE the same grid keeps the overlap rule.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";

const api = vi.hoisted(() => ({
  beginUndoTransaction: vi.fn(async () => 9),
  commitUndoTransaction: vi.fn(async () => undefined),
  cancelUndoTransaction: vi.fn(async () => undefined),
  updateCellsBatch: vi.fn(async () => [] as unknown[]),
  clearCell: vi.fn(async () => {}),
  clearRangeWithOptions: vi.fn(async () => undefined),
  getCell: vi.fn(async () => null),
  getViewportCells: vi.fn(async () => [] as unknown[]),
  shiftFormulasBatch: vi.fn(async (inputs: { formula: string; rowDelta: number; colDelta: number }[]) =>
    inputs.map((i) => `${i.formula}@${i.rowDelta},${i.colDelta}`),
  ),
}));
const seam = vi.hoisted(() => ({
  getCellTargetCells: vi.fn(),
  selectTargetCells: vi.fn(),
}));

vi.mock("../../lib/tauri-api", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  beginUndoTransaction: (d: string) => api.beginUndoTransaction(d),
  commitUndoTransaction: (t?: number | null) => api.commitUndoTransaction(t),
  cancelUndoTransaction: (t?: number | null) => api.cancelUndoTransaction(t),
  updateCellsBatch: (...a: unknown[]) => api.updateCellsBatch(...a),
  clearCell: (...a: unknown[]) => api.clearCell(...a),
  clearRangeWithOptions: (...a: unknown[]) => api.clearRangeWithOptions(...a),
  getCell: (...a: unknown[]) => api.getCell(...a),
  getViewportCells: (...a: unknown[]) => api.getViewportCells(...a),
  shiftFormulasBatch: (inputs: never) => api.shiftFormulasBatch(inputs),
  getCollectionTexts: vi.fn(async () => []),
  getComment: vi.fn(async () => null),
  getDataValidation: vi.fn(async () => null),
}));
vi.mock("../../../api/cellTarget", () => seam);
vi.mock("@tauri-apps/plugin-clipboard-manager", () => ({
  readText: vi.fn(async () => null),
  writeText: vi.fn(async () => {}),
  writeHtml: vi.fn(async () => {}),
}));
vi.mock("../../lib/dialogs", () => ({
  alertAsync: vi.fn(async () => {}),
  confirmAsync: vi.fn(async () => true),
}));

import { useClipboard, getInternalClipboard, type UseClipboardReturn } from "../useClipboard";
import { GridProvider, useGridContext } from "../../state/GridContext";
import { setSelection } from "../../state/gridActions";
import type { CellTargetRef, Selection } from "../../types";
import type { CellTarget } from "../../lib/selectionOwner";

Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

const REF: CellTargetRef = { kind: "floatingRange", id: "fr-1" };

let hook: UseClipboardReturn;
let dispatchOut: ReturnType<typeof useGridContext>["dispatch"];
let gridSelection: Selection | null = null;

function Harness(): React.ReactElement {
  const ctx = useGridContext();
  dispatchOut = ctx.dispatch;
  gridSelection = ctx.state.selection;
  hook = useClipboard();
  return <div />;
}

let root: Root;
let host: HTMLDivElement;

async function settle(): Promise<void> {
  for (let i = 0; i < 3; i++) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

function range(startRow: number, startCol: number, endRow: number, endCol: number): Selection {
  return { startRow, startCol, endRow, endCol, type: "cells" };
}

async function selectSheet(sel: Selection): Promise<void> {
  await act(async () => {
    dispatchOut(setSelection(sel));
  });
  await settle();
}

/** The door's answer for a floating grid's selection. */
function grid(selection: Selection): { target: CellTarget } {
  return {
    target: {
      kind: "object",
      ownerId: "floatingRange",
      ref: REF,
      selection,
      bounds: { rows: 10, cols: 5 },
      label: "Float1",
      wholeObject: false,
    },
  };
}

const cell = (row: number, col: number, display: string, formula: string | null = null, styleIndex = 0) => ({
  row,
  col,
  display,
  formula,
  styleIndex,
  valueKind: "text",
});

beforeEach(async () => {
  for (const fn of Object.values(api)) fn.mockClear();
  seam.getCellTargetCells.mockReset();
  seam.selectTargetCells.mockReset();
  seam.getCellTargetCells.mockResolvedValue({
    cells: [cell(1, 1, "B2"), cell(1, 2, "3", "=A1+1", 4)],
    merges: [],
    conditional: [],
    styles: [],
    rules: [],
  });
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root.render(
      <GridProvider>
        <Harness />
      </GridProvider>,
    );
  });
  await settle();
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
});

describe("Copy from a floating grid's cells", () => {
  it("reads the grid's cells through its target and records the grid as the source", async () => {
    await act(async () => {
      await hook.copy(undefined, grid(range(1, 1, 1, 2)));
    });
    expect(seam.getCellTargetCells).toHaveBeenCalledWith(REF, { startRow: 1, startCol: 1, endRow: 1, endCol: 2 });
    expect(api.getCell, "read Core's hidden cell under the grid").not.toHaveBeenCalled();
    const clip = getInternalClipboard()!;
    expect(clip.sourceTarget).toEqual(REF);
    expect(clip.sourceSheetName).toBe("Float1");
    expect(clip.sourceSheetIndex, "an object source is never a sheet index").toBe(-1);
    expect(clip.cells[0].map((c) => c?.display)).toEqual(["B2", "3"]);
  });
});

describe("Paste into a floating grid's cells", () => {
  it("writes ONE targeted batch with Excel's relative shift on the grid's coordinates, and selects in the GRID", async () => {
    // Copy B2:C2 of the grid, paste at D5 of the same grid.
    await act(async () => {
      await hook.copy(undefined, grid(range(1, 1, 1, 2)));
    });
    await act(async () => {
      await hook.paste(undefined, grid(range(4, 3, 4, 3)));
    });
    expect(api.updateCellsBatch).toHaveBeenCalledTimes(1);
    const [updates, opts] = api.updateCellsBatch.mock.calls[0] as unknown as [
      Array<{ row: number; col: number; value: string; styleIndex?: number }>,
      unknown,
    ];
    expect(opts).toEqual({ target: REF });
    expect(updates).toEqual([
      { row: 4, col: 3, value: "B2", styleIndex: 0 },
      { row: 4, col: 4, value: "=A1+1@3,2", styleIndex: 4 },
    ]);
    expect(seam.selectTargetCells).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "object" }),
      { startRow: 4, startCol: 3, endRow: 4, endCol: 4, type: "cells" },
    );
    expect(gridSelection?.startRow, "moved Core's hidden selection").not.toBe(4);
  });

  it("from the floating grid to the SHEET: a plain batch with the same relative shift", async () => {
    await act(async () => {
      await hook.copy(undefined, grid(range(1, 1, 1, 2)));
    });
    await selectSheet(range(9, 0, 9, 0));
    await act(async () => {
      await hook.paste();
    });
    expect(api.updateCellsBatch).toHaveBeenCalledTimes(1);
    const call = api.updateCellsBatch.mock.calls[0] as unknown as [Array<{ value: string }>, unknown?];
    expect(call[1], "a sheet paste named a target").toBeUndefined();
    expect(call[0].map((u) => u.value)).toEqual(["B2", "=A1+1@8,-1"]);
  });

  it("the paste is clamped to the GRID's extent, not the sheet's", async () => {
    await act(async () => {
      await hook.copy(undefined, grid(range(1, 1, 1, 2)));
    });
    // The grid is 5 columns wide: pasting two cells at its last column keeps one.
    await act(async () => {
      await hook.paste(undefined, grid(range(0, 4, 0, 4)));
    });
    const [updates] = api.updateCellsBatch.mock.calls[0] as unknown as [Array<{ col: number }>];
    expect(updates.map((u) => u.col)).toEqual([4]);
  });
});

describe("Cut: the source is cleared where it IS, not where its coordinates point", () => {
  it("cut Float1!B2, paste on the HOST's B2: ONE targeted clearRangeWithOptions over the source (the cut is not a copy)", async () => {
    seam.getCellTargetCells.mockResolvedValue({ cells: [cell(1, 1, "moved")], merges: [], conditional: [], styles: [], rules: [] });
    await act(async () => {
      await hook.cut(undefined, grid(range(1, 1, 1, 1)));
    });
    await selectSheet(range(1, 1, 1, 1));
    await act(async () => {
      await hook.paste();
    });
    expect(api.updateCellsBatch).toHaveBeenCalledTimes(1);
    expect(api.clearRangeWithOptions, "the cut source was not cleared: the cut became a copy").toHaveBeenCalledTimes(1);
    expect(api.clearRangeWithOptions).toHaveBeenCalledWith(1, 1, 1, 1, "all", undefined, { target: REF });
    expect(api.clearCell, "cleared the HOST's cell instead").not.toHaveBeenCalled();
    // Inside the paste's ONE undo step.
    expect(api.beginUndoTransaction).toHaveBeenCalledTimes(1);
    expect(api.commitUndoTransaction).toHaveBeenCalledTimes(1);
  });

  it("cut and paste INSIDE the same grid at overlapping coordinates keeps the overlap rule", async () => {
    seam.getCellTargetCells.mockResolvedValue({
      cells: [cell(1, 1, "a"), cell(1, 2, "b")],
      merges: [],
      conditional: [],
      styles: [],
      rules: [],
    });
    await act(async () => {
      await hook.cut(undefined, grid(range(1, 1, 1, 2)));
    });
    // B2:C2 pasted at C2: C2 is pasted over, only B2 is cleared.
    await act(async () => {
      await hook.paste(undefined, grid(range(1, 2, 1, 2)));
    });
    expect(api.clearRangeWithOptions.mock.calls).toEqual([[1, 1, 1, 1, "all", undefined, { target: REF }]]);
    expect(api.clearCell).not.toHaveBeenCalled();
  });

  it("positive control: a SHEET cut pasted on the same sheet keeps today's per-cell overlap clear", async () => {
    api.getCell.mockImplementation((async (r: number, c: number) => ({ row: r, col: c, display: "v", formula: null, styleIndex: 0 })) as never);
    await selectSheet(range(0, 0, 0, 1));
    await act(async () => {
      await hook.cut();
    });
    await selectSheet(range(0, 1, 0, 1));
    await act(async () => {
      await hook.paste();
    });
    expect(api.clearCell.mock.calls).toEqual([[0, 0]]);
    expect(api.clearRangeWithOptions).not.toHaveBeenCalled();
  });
});
