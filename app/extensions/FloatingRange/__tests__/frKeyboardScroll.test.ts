//! FILENAME: app/extensions/FloatingRange/__tests__/frKeyboardScroll.test.ts
// PURPOSE: The floating range's keyboard over overflowing content (M7):
//          - an arrow at the WINDOW's last row moves on into the content extent
//            and scrolls the new cell into view; the extent's end still clamps;
//          - F2 / type-to-edit on an active cell that was scrolled away bring it
//            back into view before the editor opens over it;
//          - Delete (the registry binding's command, lib/frKeyRouting.ts) over a
//            selection that reaches past the window is ONE clear of the whole
//            EXTENT-wide selection through the cell target (P3: one undo
//            step, the backing sheet only), and a refusal is REPORTED once --
//            never a silent partial clear;
//          - (P3) arrows step OVER hidden rows / columns and onto a merge as a
//            whole, and leave a merge from its far edge.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { FloatingRangeInfo } from "@api/floatingRanges";

const openFrEditor = vi.fn();
vi.mock("../editor/frEditor", () => ({
  openFrEditor: (...args: unknown[]) => openFrEditor(...args),
  cancelFrEditor: vi.fn(),
  commitFrEditor: vi.fn(),
  getFrEditorCell: vi.fn(() => null),
  getFrEditorSession: vi.fn(() => null),
  isFrEditorOpen: vi.fn(() => false),
  destroyFrEditor: vi.fn(),
}));

vi.mock("@api/editing", () => ({
  isGlobalFormulaMode: () => false,
  getGlobalIsEditing: () => false,
  insertTextIntoActiveFormula: vi.fn(),
  getExternalFormulaTarget: () => null,
  isFormulaReferencePickActive: () => false,
}));

const WINDOW_ROWS = 4;
const updateFloatingRangeCell = vi.fn(async (_id: string, row: number, col: number) => {
  if (row >= WINDOW_ROWS) {
    throw new Error(`Cell (${row},${col}) is outside the floating range's ${WINDOW_ROWS}x3 window`);
  }
  return [];
});
const getFloatingRangeCells = vi.fn(
  async (_id: string, startRow: number, startCol: number, endRow: number, endCol: number) => {
    const out = [];
    for (let r = startRow; r <= endRow; r++) {
      for (let c = startCol; c <= endCol; c++) {
        out.push({ row: r, col: c, type: "text", value: "x", display: "x" });
      }
    }
    return out;
  },
);
vi.mock("@api/floatingRanges", () => ({
  FLOATING_RANGE_MAX_ROWS: 1000,
  FLOATING_RANGE_MAX_COLS: 256,
  FLOATING_RANGE_MIN_COL_W: 8,
  FLOATING_RANGE_MAX_COL_W: 1000,
  FLOATING_RANGE_MIN_ROW_H: 8,
  FLOATING_RANGE_MAX_ROW_H: 500,
  listFloatingRanges: vi.fn(async () => []),
  createFloatingRange: vi.fn(),
  updateFloatingRange: vi.fn(async () => ({})),
  renameFloatingRange: vi.fn(),
  deleteFloatingRange: vi.fn(),
  updateFloatingRangeCell: (...args: [string, number, number]) => updateFloatingRangeCell(...args),
  getFloatingRangeCells: (...args: [string, number, number, number, number]) => getFloatingRangeCells(...args),
}));

const clearRangeWithOptions = vi.fn(async (..._args: unknown[]): Promise<unknown> => ({ count: 0, updatedCells: [] }));
vi.mock("@api/lib", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@api/lib")>()),
  clearRangeWithOptions: (...args: unknown[]) => clearRangeWithOptions(...args),
}));

const showToast = vi.fn();
vi.mock("@api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@api")>()),
  showToast: (...args: unknown[]) => showToast(...args),
}));

import { handleFrKeyDown, deleteFrSelection } from "../index";
import { upsertFromInfo, resetFloatingRangeStore } from "../lib/floatingRangeStore";
import { getLocalSelection, setLocalSelection, clearLocalSelection } from "../lib/frSelection";
import { getFrScroll, setFrScroll } from "../lib/frScroll";
import { recordFrUsedExtent, resetFrExtents } from "../lib/frExtent";
import { FR_DEFAULT_ROW_H } from "../lib/frDimensions";
import { installFrKeyRouting } from "../lib/frKeyRouting";
import { recordFrCellRead, resetFrRenderCaches } from "../rendering/frRenderer";
import { styledRead } from "./helpers/frStyledRead";

const FR_ID = "fr-keys";

const INFO = {
  id: FR_ID,
  backingSheetId: "backing",
  hostSheetId: "host",
  x: 100,
  y: 100,
  rotation: 0,
  pinToGrid: false,
  rowCount: WINDOW_ROWS,
  colCount: 3,
  colWidths: {},
  rowHeights: {},
  showTitle: true,
  showColumnHeaders: true,
  showRowHeaders: true,
  name: "Float1",
  backingSheetIndex: 1,
  hostSheetIndex: 0,
} as FloatingRangeInfo;

function key(k: string, init: KeyboardEventInit = {}): KeyboardEvent {
  return new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true, ...init });
}

function selectCell(row: number, col: number): void {
  setLocalSelection({ frId: FR_ID, anchorRow: row, anchorCol: col, endRow: row, endCol: col });
}

async function flush(): Promise<void> {
  for (let i = 0; i < 20; i++) await Promise.resolve();
}

beforeEach(() => {
  openFrEditor.mockClear();
  updateFloatingRangeCell.mockClear();
  getFloatingRangeCells.mockClear();
  showToast.mockClear();
  clearRangeWithOptions.mockClear();
  resetFloatingRangeStore();
  resetFrRenderCaches();
  resetFrExtents();
  clearLocalSelection();
  upsertFromInfo(INFO);
  recordFrUsedExtent(FR_ID, 8, 3); // content reaches row 7; the window shows 4
});

afterEach(() => {
  resetFloatingRangeStore();
  resetFrExtents();
  clearLocalSelection();
  vi.restoreAllMocks();
});

describe("arrow keys navigate the content extent", () => {
  it("moves past the window's last row and scrolls the new cell into view", () => {
    selectCell(WINDOW_ROWS - 1, 0);
    const e = key("ArrowDown");
    handleFrKeyDown(e);
    expect(e.defaultPrevented).toBe(true);
    expect(getLocalSelection()).toMatchObject({ anchorRow: WINDOW_ROWS, endRow: WINDOW_ROWS });
    expect(getFrScroll(FR_ID)).toEqual({ left: 0, top: FR_DEFAULT_ROW_H });
  });

  it("clamps at the EXTENT's last row", () => {
    selectCell(7, 0);
    handleFrKeyDown(key("ArrowDown"));
    expect(getLocalSelection()).toMatchObject({ anchorRow: 7 });
  });

  it("Shift extends to the extent and keeps the MOVING end in view", () => {
    selectCell(2, 0);
    for (let i = 0; i < 4; i++) handleFrKeyDown(key("ArrowDown", { shiftKey: true }));
    expect(getLocalSelection()).toMatchObject({ anchorRow: 2, endRow: 6 });
    expect(getFrScroll(FR_ID).top).toBe(3 * FR_DEFAULT_ROW_H);
  });

  it("moving back up scrolls back", () => {
    setFrScroll(FR_ID, 0, 4 * FR_DEFAULT_ROW_H);
    selectCell(4, 0);
    handleFrKeyDown(key("ArrowUp"));
    expect(getLocalSelection()).toMatchObject({ anchorRow: 3 });
    expect(getFrScroll(FR_ID).top).toBe(3 * FR_DEFAULT_ROW_H);
  });
});

describe("editing a scrolled-away active cell", () => {
  it("F2 brings the cell back into view, then opens the editor there", () => {
    selectCell(6, 1);
    handleFrKeyDown(key("F2"));
    expect(getFrScroll(FR_ID).top).toBe(3 * FR_DEFAULT_ROW_H);
    expect(openFrEditor).toHaveBeenCalledWith(FR_ID, 6, 1, null);
  });

  it("type-to-edit does the same, seeded with the key", () => {
    setFrScroll(FR_ID, 0, 4 * FR_DEFAULT_ROW_H);
    selectCell(0, 0);
    handleFrKeyDown(key("7"));
    expect(getFrScroll(FR_ID).top).toBe(0);
    expect(openFrEditor).toHaveBeenCalledWith(FR_ID, 0, 0, "7");
  });

  // E13: Windows reports AltGr as Ctrl+Alt; on sv-SE "@" is AltGr+2.
  it("an AltGr character (Ctrl+Alt, as Windows reports it) types too", () => {
    selectCell(0, 0);
    const e = key("@", { ctrlKey: true, altKey: true });
    handleFrKeyDown(e);
    expect(e.defaultPrevented).toBe(true);
    expect(openFrEditor).toHaveBeenCalledWith(FR_ID, 0, 0, "@");
  });

  it("control: a Ctrl+Alt LETTER is a shortcut, and a key the dispatcher already took is not typed", () => {
    selectCell(0, 0);
    handleFrKeyDown(key("v", { ctrlKey: true, altKey: true }));
    const taken = key("[", { ctrlKey: true, altKey: true });
    taken.preventDefault();
    handleFrKeyDown(taken);
    expect(openFrEditor).not.toHaveBeenCalled();
  });
});

describe("Delete past the window (P3: one clear through the cell target)", () => {
  // The floating grid's owner claim, as the extension installs it: the Delete
  // door asks the cell-target question like every Clear door.
  let uninstall: () => void = () => {};
  beforeEach(() => {
    uninstall = installFrKeyRouting({ extensionId: "test", deleteSelection: deleteFrSelection });
  });
  afterEach(() => uninstall());

  it("clears the EXTENT-wide selection in ONE call with the target, never cell by cell", async () => {
    setLocalSelection({ frId: FR_ID, anchorRow: 0, anchorCol: 0, endRow: 7, endCol: 0 });
    deleteFrSelection();
    await flush();
    expect(clearRangeWithOptions).toHaveBeenCalledTimes(1);
    expect(clearRangeWithOptions).toHaveBeenCalledWith(0, 0, 7, 0, "contents", undefined, {
      target: { kind: "floatingRange", id: FR_ID },
    });
    expect(updateFloatingRangeCell).not.toHaveBeenCalled();
    expect(showToast).not.toHaveBeenCalled();
  });

  it("reports a refusal ONCE, visibly", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    clearRangeWithOptions.mockRejectedValueOnce(new Error("Cell A5 is outside floating grid 'Float1'. Nothing was changed."));
    setLocalSelection({ frId: FR_ID, anchorRow: 0, anchorCol: 0, endRow: 7, endCol: 0 });
    deleteFrSelection();
    await flush();
    expect(showToast).toHaveBeenCalledTimes(1);
    expect(String(showToast.mock.calls[0][0])).toMatch(/^The cells could not be cleared: .*outside floating grid/);
    expect(showToast.mock.calls[0][1]).toEqual({ type: "error" });
  });

  it("a multi-area selection is one call per area", async () => {
    setLocalSelection({
      frId: FR_ID,
      anchorRow: 0,
      anchorCol: 0,
      endRow: 0,
      endCol: 0,
      areas: [{ startRow: 2, startCol: 1, endRow: 3, endCol: 2 }],
    });
    deleteFrSelection();
    await flush();
    expect(clearRangeWithOptions.mock.calls.map((c) => c.slice(0, 4))).toEqual([
      [0, 0, 0, 0],
      [2, 1, 3, 2],
    ]);
  });
});

describe("arrows over hidden lines and merges (P3)", () => {
  it("steps OVER a hidden row, both ways", () => {
    upsertFromInfo({ ...INFO, hiddenRows: [1, 2] } as FloatingRangeInfo);
    selectCell(0, 0);
    handleFrKeyDown(key("ArrowDown"));
    expect(getLocalSelection()).toMatchObject({ anchorRow: 3, endRow: 3 });
    handleFrKeyDown(key("ArrowUp"));
    expect(getLocalSelection()).toMatchObject({ anchorRow: 0, endRow: 0 });
  });

  it("steps over a hidden column, and Shift-extend skips it too", () => {
    upsertFromInfo({ ...INFO, hiddenCols: [1] } as FloatingRangeInfo);
    selectCell(0, 0);
    handleFrKeyDown(key("ArrowRight", { shiftKey: true }));
    expect(getLocalSelection()).toMatchObject({ anchorCol: 0, endCol: 2 });
  });

  it("lands on a merge as a whole and leaves it from its far edge", () => {
    // B1:C2 merged.
    recordFrCellRead(FR_ID, { startRow: 0, startCol: 0, endRow: 7, endCol: 2 }, styledRead(
      { startRow: 0, startCol: 0, endRow: 7, endCol: 2 },
      () => null,
      {},
      { merges: [{ startRow: 0, startCol: 1, endRow: 1, endCol: 2 }] },
    ));
    selectCell(0, 0);
    handleFrKeyDown(key("ArrowRight"));
    expect(getLocalSelection()).toMatchObject({ anchorRow: 0, anchorCol: 1, endRow: 1, endCol: 2 });
    // Down from the merge leaves from its BOTTOM edge: row 2, not row 1.
    handleFrKeyDown(key("ArrowDown"));
    expect(getLocalSelection()).toMatchObject({ anchorRow: 2, anchorCol: 1, endRow: 2, endCol: 1 });
  });
});
