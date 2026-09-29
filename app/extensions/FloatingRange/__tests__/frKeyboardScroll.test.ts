//! FILENAME: app/extensions/FloatingRange/__tests__/frKeyboardScroll.test.ts
// PURPOSE: The floating range's keyboard over overflowing content (M7):
//          - an arrow at the WINDOW's last row moves on into the content extent
//            and scrolls the new cell into view; the extent's end still clamps;
//          - F2 / type-to-edit on an active cell that was scrolled away bring it
//            back into view before the editor opens over it;
//          - Delete (the registry binding's command, lib/frKeyRouting.ts) over a
//            selection that reaches past the window clears what
//            the backend accepts and REPORTS what it refuses (until the
//            backend's write gate follows the extent, cells past the window are
//            refused) -- never a silent partial clear.

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
  resetFloatingRangeStore();
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

describe("Delete past the window", () => {
  it("clears what the backend accepts and reports what it refuses, once", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    setLocalSelection({ frId: FR_ID, anchorRow: 0, anchorCol: 0, endRow: 7, endCol: 0 });
    deleteFrSelection();
    await flush();

    // Every non-empty cell of the EXTENT-wide selection was attempted...
    expect(getFloatingRangeCells).toHaveBeenCalledWith(FR_ID, 0, 0, 7, 0);
    expect(updateFloatingRangeCell.mock.calls.map((c) => c[1])).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
    // ...and the four the backend refused are not lost in silence.
    expect(showToast).toHaveBeenCalledTimes(1);
    expect(String(showToast.mock.calls[0][0])).toMatch(/^4 cells could not be cleared: .*outside/);
    expect(showToast.mock.calls[0][1]).toEqual({ type: "error" });
  });

  it("says nothing when every cell cleared", async () => {
    setLocalSelection({ frId: FR_ID, anchorRow: 0, anchorCol: 0, endRow: 3, endCol: 2 });
    deleteFrSelection();
    await flush();
    expect(updateFloatingRangeCell).toHaveBeenCalledTimes(12);
    expect(showToast).not.toHaveBeenCalled();
  });
});
