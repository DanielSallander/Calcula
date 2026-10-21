//! FILENAME: app/extensions/BuiltIn/HomeTab/__tests__/homeTabStateActions.test.tsx
// PURPOSE: What the Home tab's shared state hook WRITES, against Excel as
//          measured (CONTRACT, home-core job 4): which cell is the active one,
//          Excel's Increase/Decrease Font Size ladder, Excel's Increase Indent,
//          Comma Style, Increase/Decrease Decimal with the active cell first,
//          and the formatting door saying whether it wrote -- and saying a
//          refusal to the USER.
// CONTEXT: Every claim below was a live defect before 2026-10-04:
//          - the ribbon read the style of `startRow/startCol`, the ANCHOR, while
//            the grid draws the active cell at `endRow/endCol` (renderer
//            report, "not fixed" 6): drag from A5 up to A1 and the grid marks
//            A1 active while the ribbon described A5, the cell you started on;
//          - Decrease Font Size went 11 -> 10.5 (the Size LIST's half step);
//            Excel goes 11 -> 10 -> 9 -> 8 -> 8 (rust-format probe1);
//          - Increase Indent only added; Excel turns General/Center into Left,
//            resets an ANGLED rotation, and caps at 250, not 15 (alignment
//            survey, probes 6-9);
//          - Comma wrote "#,##0" (Excel's Comma Style is Accounting with no
//            symbol, two decimals) and the decimal buttons rebuilt a plain
//            "0.00" from the DISPLAY NAME, so Increase Decimal on a Currency
//            cell silently made it a plain number;
//          - a backend refusal of any formatting button (a protected sheet)
//            was console-only.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";

// --- Mocks: the grid, the backend and the dialogs; the hook itself is real ---

type Sel = {
  startRow: number;
  startCol: number;
  endRow: number;
  endCol: number;
  activeRow?: number;
  activeCol?: number;
  additionalRanges?: Array<{ startRow: number; startCol: number; endRow: number; endCol: number }>;
} | null;

const h = vi.hoisted(() => ({
  selection: null as Sel,
  style: {} as Record<string, unknown>,
  alertAsync: vi.fn(),
  execute: vi.fn(async (..._a: unknown[]) => undefined),
  getCell: vi.fn(async (row: number, col: number) => ({ row, col, styleIndex: 1, display: "x2" })),
  getStyle: vi.fn(async (_index: number) => h.style),
  applyFormatting: vi.fn(async (..._a: unknown[]) => ({ cells: [], styles: [] }) as unknown),
  setCellRichText: vi.fn(async (..._a: unknown[]) => undefined),
  adjustNumberFormatDecimals: vi.fn(async (..._a: unknown[]) => ({ cells: [], styles: [] }) as unknown),
  // The undo bracket a multi-block write opens (ticket 7 = this begin OPENED it).
  beginUndoTransaction: vi.fn(async (..._a: unknown[]) => 7 as unknown),
  commitUndoTransaction: vi.fn(async (..._a: unknown[]) => undefined),
  cancelUndoTransaction: vi.fn(async (..._a: unknown[]) => undefined),
}));

vi.mock("@api", () => ({
  useGridState: () => ({ selection: h.selection }),
  cellEvents: { emit: vi.fn() },
}));
vi.mock("@api/grid", () => ({
  getGridStateSnapshot: () => ({ selection: h.selection }),
}));
vi.mock("@api/commands", () => ({
  CommandRegistry: { execute: (...a: unknown[]) => h.execute(...a) },
  CoreCommands: { FORMAT_PAINTER: "core.format.painter", FORMAT_CELLS: "core.format.cells" },
}));
vi.mock("@api/ui", () => ({ DialogExtensions: { openDialog: vi.fn() } }));
vi.mock("@api/dialogs", () => ({ alertAsync: (...a: unknown[]) => h.alertAsync(...a) }));
vi.mock("@api/lib", () => ({
  getCell: (row: number, col: number) => h.getCell(row, col),
  getStyle: (index: number) => h.getStyle(index),
  applyFormatting: (...a: unknown[]) => h.applyFormatting(...a),
  setCellRichText: (...a: unknown[]) => h.setCellRichText(...a),
  adjustNumberFormatDecimals: (...a: unknown[]) => h.adjustNumberFormatDecimals(...a),
  beginUndoTransaction: (...a: unknown[]) => h.beginUndoTransaction(...a),
  commitUndoTransaction: (...a: unknown[]) => h.commitUndoTransaction(...a),
  cancelUndoTransaction: (...a: unknown[]) => h.cancelUndoTransaction(...a),
}));

import { useHomeTabState } from "../components/useHomeTabState";
import { registerSelectionOwner } from "@api/selectionOwner";
import { registerToastSink, type ToastPayload } from "@api/notifications";

/** The options a write on Core's own selection carries: no target (P3). */
const GRID = { target: undefined };

// --- Harness ----------------------------------------------------------------

let container: HTMLDivElement;
let root: Root;
let latest: ReturnType<typeof useHomeTabState> | null = null;
const toasts: ToastPayload[] = [];
let release: (() => void) | null = null;

function Probe(): React.ReactElement | null {
  latest = useHomeTabState();
  return null;
}

async function flush(): Promise<void> {
  await act(async () => {
    await new Promise((r) => setTimeout(r, 0));
    await Promise.resolve();
    await Promise.resolve();
  });
}

/** Mount with this active-cell style and selection. */
async function mount(style: Record<string, unknown>, selection: Sel = { startRow: 0, startCol: 0, endRow: 0, endCol: 0 }) {
  h.style = style;
  h.selection = selection;
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root.render(<Probe />);
  });
  await flush();
}

async function click(id: string): Promise<void> {
  await act(async () => {
    await latest!.handleItemClick({ id, label: id } as never);
  });
  await flush();
}

/** The formatting object of the ONE applyFormatting call. */
function written(): Record<string, unknown> {
  expect(h.applyFormatting).toHaveBeenCalledTimes(1);
  return h.applyFormatting.mock.calls[0][2] as Record<string, unknown>;
}

beforeEach(() => {
  for (const fn of [h.alertAsync, h.execute, h.getCell, h.getStyle, h.applyFormatting, h.setCellRichText, h.adjustNumberFormatDecimals, h.beginUndoTransaction, h.commitUndoTransaction, h.cancelUndoTransaction]) {
    fn.mockClear();
  }
  h.beginUndoTransaction.mockImplementation(async () => 7);
  h.applyFormatting.mockImplementation(async () => ({ cells: [], styles: [] }));
  h.adjustNumberFormatDecimals.mockImplementation(async () => ({ cells: [], styles: [] }));
  toasts.length = 0;
  registerToastSink((t) => toasts.push(t));
});

afterEach(async () => {
  release?.();
  release = null;
  await act(async () => {
    root.unmount();
  });
  container.remove();
  latest = null;
});

// ============================================================================
// The active cell
// ============================================================================

describe("the ribbon describes the ACTIVE cell, where the grid draws it", () => {
  it("reads end, not the anchor, when the selection was dragged", async () => {
    // Anchored at A1, dragged to C4: the active cell is C4.
    await mount({ bold: true }, { startRow: 0, startCol: 0, endRow: 3, endCol: 2 });
    expect(h.getCell).toHaveBeenLastCalledWith(3, 2);
  });

  it("reads activeRow/activeCol when the grid sets them (Enter cycling inside a range)", async () => {
    await mount({ bold: true }, { startRow: 0, startCol: 0, endRow: 3, endCol: 2, activeRow: 1, activeCol: 1 });
    expect(h.getCell).toHaveBeenLastCalledWith(1, 1);
  });

  it("re-reads the ACTIVE cell after a write", async () => {
    await mount({ bold: false }, { startRow: 5, startCol: 5, endRow: 2, endCol: 4 });
    h.getCell.mockClear();
    await click("bold");
    expect(h.getCell).toHaveBeenCalledWith(2, 4);
    expect(h.getCell).not.toHaveBeenCalledWith(5, 5);
  });

  it("superscript reads and writes the ACTIVE cell's rich text", async () => {
    await mount({}, { startRow: 0, startCol: 0, endRow: 3, endCol: 2 });
    await click("superscript");
    expect(h.setCellRichText).toHaveBeenCalledTimes(1);
    expect(h.setCellRichText.mock.calls[0].slice(0, 2)).toEqual([3, 2]);
  });
});

// ============================================================================
// Excel's font-size ladder
// ============================================================================

describe("Increase / Decrease Font Size follow Excel's ladder", () => {
  const cases: Array<[string, number, number | null]> = [
    // [button, from, to] -- null = Excel changes nothing, so nothing is written.
    ["decreaseFontSize", 11, 10], // NOT 10.5: the half step is the Size list's, not the ladder's
    ["decreaseFontSize", 10, 9],
    ["decreaseFontSize", 9, 8],
    ["decreaseFontSize", 8, null], // measured: 8 -> 8
    ["decreaseFontSize", 10.3, 10], // measured
    ["decreaseFontSize", 10.5, 10],
    ["decreaseFontSize", 36, 28],
    ["increaseFontSize", 11, 12],
    ["increaseFontSize", 10.5, 11],
    ["increaseFontSize", 28, 36],
    ["increaseFontSize", 48, 72],
    ["increaseFontSize", 72, null], // measured: 72 -> 72
    ["increaseFontSize", 400, null], // measured: 400 -> 400
  ];
  for (const [button, from, to] of cases) {
    it(`${button} from ${from} ${to === null ? "changes nothing" : `gives ${to}`}`, async () => {
      await mount({ fontSize: from });
      await click(button);
      if (to === null) expect(h.applyFormatting).not.toHaveBeenCalled();
      else expect(written()).toEqual({ fontSize: to });
    });
  }
});

// ============================================================================
// Excel's Increase / Decrease Indent
// ============================================================================

describe("Increase Indent is Excel's", () => {
  it("turns General into Left", async () => {
    await mount({ indent: 0, textAlign: "general", textRotation: "none" });
    await click("increaseIndent");
    expect(written()).toEqual({ indent: 1, textAlign: "left" });
  });

  it("turns Center into Left", async () => {
    await mount({ indent: 0, textAlign: "center", textRotation: "none" });
    await click("increaseIndent");
    expect(written()).toEqual({ indent: 1, textAlign: "left" });
  });

  it("keeps Right right, and Left left", async () => {
    await mount({ indent: 2, textAlign: "right", textRotation: "none" });
    await click("increaseIndent");
    expect(written()).toEqual({ indent: 3 });
  });

  it("puts ANGLED text back to horizontal and leaves the alignment alone", async () => {
    // Measured: rot 45 + IncreaseIndent gave orientation horizontal, h General.
    await mount({ indent: 0, textAlign: "general", textRotation: "custom:45" });
    await click("increaseIndent");
    expect(written()).toEqual({ indent: 1, textRotation: "none" });
  });

  it("keeps STACKED text stacked and sets Left", async () => {
    await mount({ indent: 0, textAlign: "general", textRotation: "vertical" });
    await click("increaseIndent");
    expect(written()).toEqual({ indent: 1, textAlign: "left" });
  });

  it("caps at Excel's 250, not 15", async () => {
    await mount({ indent: 15, textAlign: "left", textRotation: "none" });
    await click("increaseIndent");
    expect(written()).toEqual({ indent: 16 });
  });

  it("changes nothing at 250", async () => {
    await mount({ indent: 250, textAlign: "left", textRotation: "none" });
    await click("increaseIndent");
    expect(h.applyFormatting).not.toHaveBeenCalled();
  });

  it("Decrease steps down, and changes nothing at 0", async () => {
    await mount({ indent: 3, textAlign: "left" });
    await click("decreaseIndent");
    expect(written()).toEqual({ indent: 2 });
    h.applyFormatting.mockClear();
    await act(async () => {
      root.unmount();
    });
    container.remove();
    await mount({ indent: 0, textAlign: "left" });
    await click("decreaseIndent");
    expect(h.applyFormatting).not.toHaveBeenCalled();
  });
});

// ============================================================================
// The Number group
// ============================================================================

describe("Comma Style and the decimal buttons", () => {
  it("Comma Style writes the backend's `comma` preset (Accounting, no symbol)", async () => {
    await mount({ numberFormat: "General" });
    await click("commaFormat");
    expect(written()).toEqual({ numberFormat: "comma" });
  });

  it("Increase Decimal asks the backend, ACTIVE cell's row and column first", async () => {
    // Anchor (0,0), active (2,1): the backend reads the active cell from
    // rows[0] / cols[0], so the order IS the argument.
    await mount({}, { startRow: 0, startCol: 0, endRow: 2, endCol: 1 });
    await click("increaseDecimal");
    expect(h.applyFormatting, "no format code is computed in the ribbon").not.toHaveBeenCalled();
    expect(h.adjustNumberFormatDecimals.mock.calls).toEqual([[[2, 0, 1], [1, 0], 1, GRID]]);
  });

  it("Decrease Decimal does the same with -1, honouring activeRow/activeCol", async () => {
    await mount({}, { startRow: 0, startCol: 0, endRow: 2, endCol: 1, activeRow: 1, activeCol: 0 });
    await click("decreaseDecimal");
    expect(h.adjustNumberFormatDecimals.mock.calls).toEqual([[[1, 0, 2], [0, 1], -1, GRID]]);
  });

  it("a written step makes the ribbon re-read the active cell", async () => {
    await mount({}, { startRow: 0, startCol: 0, endRow: 0, endCol: 0 });
    h.adjustNumberFormatDecimals.mockImplementation(async () => ({
      cells: [{ row: 0, col: 0, display: "1.0" }],
      styles: [],
    }));
    h.getStyle.mockClear();
    await click("increaseDecimal");
    expect(h.getStyle).toHaveBeenCalled();
  });

  it("a refusal reaches the user once; a selection owner refuses before the backend is asked", async () => {
    await mount({});
    h.adjustNumberFormatDecimals.mockRejectedValueOnce(new Error("The cell is locked."));
    await click("increaseDecimal");
    expect(h.alertAsync.mock.calls).toEqual([["The cell is locked."]]);

    h.adjustNumberFormatDecimals.mockClear();
    release = registerSelectionOwner({ id: "t", label: "the test object's cells", ownsSelection: () => true });
    await click("decreaseDecimal");
    expect(h.adjustNumberFormatDecimals).not.toHaveBeenCalled();
    expect(toasts).toHaveLength(1);
  });
});

// ============================================================================
// applyFormat: says whether it wrote, and says a refusal to the user
// ============================================================================

describe("applyFormat, the formatting door", () => {
  it("answers true when the write landed", async () => {
    await mount({});
    let answer: unknown;
    await act(async () => {
      answer = await latest!.applyFormat({ bold: true }, "Bold");
    });
    expect(answer).toBe(true);
    expect(h.alertAsync).not.toHaveBeenCalled();
  });

  it("shows a backend refusal to the user (it was console-only) and answers false", async () => {
    await mount({});
    h.applyFormatting.mockRejectedValueOnce(new Error("Sheet1 is protected."));
    let answer: unknown;
    await act(async () => {
      answer = await latest!.applyFormat({ bold: true }, "Bold");
    });
    expect(answer).toBe(false);
    expect(h.alertAsync.mock.calls).toEqual([["Sheet1 is protected."]]);
  });

  it("a refused BUTTON says it ONCE: the door shows it, and the click's own catch sees nothing", async () => {
    await mount({ bold: false });
    h.applyFormatting.mockRejectedValueOnce(new Error("Sheet1 is protected."));
    await click("bold");
    expect(h.alertAsync).toHaveBeenCalledTimes(1);
  });

  it("answers false, writing nothing, while a selection owner holds the selection", async () => {
    await mount({});
    release = registerSelectionOwner({ id: "t", label: "the test object's cells", ownsSelection: () => true });
    let answer: unknown;
    await act(async () => {
      answer = await latest!.applyFormat({ bold: true }, "Bold");
    });
    expect(answer).toBe(false);
    expect(h.applyFormatting).not.toHaveBeenCalled();
  });
});

// ============================================================================
// Multi-area selections: every block, one undo step (review finding, 2026-10-04)
// ============================================================================

describe("a Ctrl+click / Go To Special selection: every block, ONE undo step", () => {
  /** The [rows, cols, formatting] of every applyFormatting call. */
  function writes(): unknown[][] {
    return h.applyFormatting.mock.calls.map((c) => c.slice(0, 3));
  }

  it("Bold over A1 + Ctrl+click C3 bolds BOTH blocks inside one owned transaction", async () => {
    // Excel formats every area. It used to bold only the main range.
    await mount({ bold: false }, { startRow: 0, startCol: 0, endRow: 0, endCol: 0, additionalRanges: [{ startRow: 2, startCol: 2, endRow: 2, endCol: 2 }] });
    await click("bold");
    expect(writes()).toEqual([
      [[0], [0], { bold: true }],
      [[2], [2], { bold: true }],
    ]);
    expect(h.beginUndoTransaction.mock.calls).toEqual([["bold"]]);
    expect(h.commitUndoTransaction.mock.calls).toEqual([[7]]);
    expect(h.cancelUndoTransaction).not.toHaveBeenCalled();
    // The bracket opens before the first write and closes after the last.
    const begun = h.beginUndoTransaction.mock.invocationCallOrder[0];
    const committed = h.commitUndoTransaction.mock.invocationCallOrder[0];
    for (const order of h.applyFormatting.mock.invocationCallOrder) {
      expect(order).toBeGreaterThan(begun);
      expect(order).toBeLessThan(committed);
    }
    expect(h.alertAsync).not.toHaveBeenCalled();
  });

  it("a Go To Special result (anchor at the far corner, scattered areas, a repeat) formats each area once", async () => {
    // selectionForMatches writes the main range with start = end (the first
    // match is the active cell) and every other match as its own range.
    await mount({}, {
      startRow: 4, startCol: 1, endRow: 3, endCol: 1,
      additionalRanges: [
        { startRow: 7, startCol: 2, endRow: 7, endCol: 2 },
        { startRow: 10, startCol: 0, endRow: 11, endCol: 3 },
        { startRow: 3, startCol: 1, endRow: 4, endCol: 1 }, // the main range again
      ],
    });
    let answer: unknown;
    await act(async () => {
      answer = await latest!.applyFormat({ backgroundColor: "#ffff00" }, "Fill Color");
    });
    expect(answer).toBe(true);
    expect(writes()).toEqual([
      [[3, 4], [1], { backgroundColor: "#ffff00" }],
      [[7], [2], { backgroundColor: "#ffff00" }],
      [[10, 11], [0, 1, 2, 3], { backgroundColor: "#ffff00" }],
    ]);
    expect(h.beginUndoTransaction.mock.calls).toEqual([["Fill Color"]]);
    expect(h.commitUndoTransaction).toHaveBeenCalledTimes(1);
  });

  it("a block refused part-way: what landed is committed (one Ctrl+Z restores it), the refusal is said once", async () => {
    await mount({}, { startRow: 0, startCol: 0, endRow: 0, endCol: 0, additionalRanges: [{ startRow: 5, startCol: 5, endRow: 5, endCol: 5 }] });
    h.applyFormatting
      .mockImplementationOnce(async () => ({ cells: [{ row: 0, col: 0, display: "x" }], styles: [] }))
      .mockRejectedValueOnce(new Error("F6 is on a locked range."));
    let answer: unknown;
    await act(async () => {
      answer = await latest!.applyFormat({ italic: true }, "Italic");
    });
    expect(answer, "a write landed").toBe(true);
    expect(h.commitUndoTransaction).toHaveBeenCalledTimes(1);
    expect(h.cancelUndoTransaction).not.toHaveBeenCalled();
    expect(h.alertAsync.mock.calls).toEqual([["F6 is on a locked range."]]);
  });

  it("the FIRST block refused: nothing landed, the empty step is cancelled, the answer is false", async () => {
    await mount({}, { startRow: 0, startCol: 0, endRow: 0, endCol: 0, additionalRanges: [{ startRow: 5, startCol: 5, endRow: 5, endCol: 5 }] });
    h.applyFormatting.mockRejectedValueOnce(new Error("Sheet1 is protected."));
    let answer: unknown;
    await act(async () => {
      answer = await latest!.applyFormat({ italic: true }, "Italic");
    });
    expect(answer).toBe(false);
    expect(h.applyFormatting, "stops at the refusal").toHaveBeenCalledTimes(1);
    expect(h.cancelUndoTransaction).toHaveBeenCalledTimes(1);
    expect(h.commitUndoTransaction).not.toHaveBeenCalled();
    expect(h.alertAsync).toHaveBeenCalledTimes(1);
  });

  it("one block opens no transaction (the backend's own step is the one undo step)", async () => {
    await mount({ bold: false });
    await click("bold");
    expect(h.applyFormatting).toHaveBeenCalledTimes(1);
    expect(h.beginUndoTransaction).not.toHaveBeenCalled();
  });

  it("Increase Decimal: the ACTIVE cell decides (main block, active first), every other block takes its result", async () => {
    // Main B1:A3 dragged to (2,1) -- the active cell -- plus D6:D7 Ctrl+clicked.
    await mount({}, { startRow: 0, startCol: 0, endRow: 2, endCol: 1, additionalRanges: [{ startRow: 5, startCol: 3, endRow: 6, endCol: 3 }] });
    h.adjustNumberFormatDecimals.mockImplementation(async () => ({
      cells: [{ row: 2, col: 1, display: "1.235" }],
      styles: [{ index: 4, style: { numberFormat: "Number (3 decimals)" } }],
    }));
    await click("increaseDecimal");
    expect(h.adjustNumberFormatDecimals.mock.calls).toEqual([[[2, 0, 1], [1, 0], 1, GRID]]);
    expect(writes()).toEqual([[[5, 6], [3], { numberFormat: "Number (3 decimals)" }]]);
    expect(h.beginUndoTransaction.mock.calls).toEqual([["increaseDecimal"]]);
    expect(h.commitUndoTransaction).toHaveBeenCalledTimes(1);
    expect(h.adjustNumberFormatDecimals.mock.invocationCallOrder[0]).toBeLessThan(h.applyFormatting.mock.invocationCallOrder[0]);
  });

  it("Decrease Decimal where the active cell changes nothing (text, a date) writes no other block either", async () => {
    await mount({}, { startRow: 0, startCol: 0, endRow: 0, endCol: 0, additionalRanges: [{ startRow: 5, startCol: 3, endRow: 6, endCol: 3 }] });
    await click("decreaseDecimal");
    expect(h.adjustNumberFormatDecimals).toHaveBeenCalledTimes(1);
    expect(h.applyFormatting).not.toHaveBeenCalled();
  });
});
