//! FILENAME: app/src/core/hooks/__tests__/clipboardCutModeEnds.test.tsx
// PURPOSE: A Cut stays a pending MOVE only as long as Excel's cut mode does.
//          Esc, starting an edit in any cell, a clear, a format change, a row
//          insert, a document replacement and the cut's own paste END it -- the
//          marching ants go, the system clipboard is emptied, and the next
//          Paste pastes NOTHING -- and so do an undo and any other change that
//          lands on the cut's own cells (the snapshot would be stale). A
//          selection move or a change elsewhere keeps it. Driven through the
//          REAL useClipboard and useEditing hooks, the real clear gesture, the
//          real style-entry announcement and the real document replacement;
//          the backend and the Tauri clipboard plugin are doubles.
// CONTEXT: Bug-ledger fix programme round 7 (lane clipgroup,
//          NEW-cut-survives-esc-and-source-edits). The cut used to stay pending
//          until it was pasted: Cut A1 (5), type 7 into A1, Paste at C1 -> C1
//          got the SNAPSHOT 5 and A1 was cleared, so the 7 was lost without a
//          word; and Cut, Esc, a later Ctrl+V still emptied the source. Excel
//          [LIVE, Excel 16, 2026-10-30, keystrokes posted to a hidden instance
//          and COM, clipgroup/probe-*.ps1]: Esc, a typed character or F2 in any
//          cell, Delete, a format change, Fill Down and inserting rows each end
//          cut mode and empty the clipboard, and a Paste then pastes nothing;
//          the cut's own paste ends it too (a second Paste pastes nothing);
//          an arrow key, a sheet switch, adding or renaming a sheet keep it.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";

interface ModelCell {
  display: string;
  formula: string | null;
  styleIndex: number;
}

/** The cells the doubles serve: "row,col" -> cell. */
const model = vi.hoisted(() => ({ cells: new Map<string, ModelCell>() }));
/** The system clipboard: what readText answers, and every write made to it. */
const sys = vi.hoisted(() => ({ text: null as string | null, written: [] as string[], failWrites: false }));

const api = vi.hoisted(() => ({
  updateCellsBatch: vi.fn(async (_u: unknown[], _o?: unknown) => [] as unknown[]),
  clearCell: vi.fn(async (_row?: number, _col?: number) => {}),
  clearRange: vi.fn(async (..._a: unknown[]) => [] as unknown[]),
  clearRangeWithOptions: vi.fn(async (..._a: unknown[]) => undefined as unknown),
  relocateCellReferences: vi.fn(async (..._args: unknown[]) => [] as unknown[]),
  updateCell: vi.fn(async (row: number, col: number, value: string) => ({
    cells: [{ row, col, display: value, formula: null }],
  })),
  beginUndoTransaction: vi.fn(async (_d?: string) => 7),
  commitUndoTransaction: vi.fn(async (_t?: unknown) => {}),
  cancelUndoTransaction: vi.fn(async (_t?: unknown) => {}),
}));

function cellData(row: number, col: number): unknown {
  const cell = model.cells.get(`${row},${col}`);
  return cell ? { row, col, display: cell.display, formula: cell.formula, styleIndex: cell.styleIndex } : null;
}

vi.mock("../../lib/tauri-api", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  beginUndoTransaction: (d: string) => api.beginUndoTransaction(d),
  commitUndoTransaction: (t?: unknown) => api.commitUndoTransaction(t),
  cancelUndoTransaction: (t?: unknown) => api.cancelUndoTransaction(t),
  // A cut's paste marks the point it is taken back to when the move cannot
  // finish (round 8, rev6A#5): the door joins the paste's step 7.
  beginUndoSavepoint: vi.fn(async () => ({ ticket: null, savepoint: { transaction: 7, changes: 0 } })),
  rollBackToUndoSavepoint: vi.fn(async () => ({ success: true })),
  updateCellsBatch: (u: unknown[], o?: unknown) => api.updateCellsBatch(u, o),
  clearCell: (row: number, col: number) => api.clearCell(row, col),
  clearRange: (...a: unknown[]) => api.clearRange(...a),
  clearRangeWithOptions: (...a: unknown[]) => api.clearRangeWithOptions(...a),
  relocateCellReferences: (...args: unknown[]) => api.relocateCellReferences(...args),
  updateCell: (row: number, col: number, value: string) => api.updateCell(row, col, value),
  updateCellOnSheets: vi.fn(async () => []),
  getSheets: vi.fn(async () => ({
    sheets: [{ index: 0, name: "Sheet1", sheetId: "S1", visibility: "visible" }],
    activeIndex: 0,
  })),
  getMergeInfo: vi.fn(async () => null),
  shiftFormulasBatch: vi.fn(async (inputs: { formula: string }[]) => inputs.map((i) => i.formula)),
  // No typed read: every constant falls back to its display.
  getRangeCellsTyped: vi.fn(async () => {
    throw new Error("no typed read in this double");
  }),
  getCell: vi.fn(async (row: number, col: number) => cellData(row, col)),
  getCollectionTexts: vi.fn(async () => []),
  getComment: vi.fn(async () => null),
  getDataValidation: vi.fn(async () => null),
}));

vi.mock("../../../api/cellTarget", () => ({
  getCellTargetCells: vi.fn(async () => ({ cells: [], merges: [], conditional: [], styles: [], rules: [] })),
  selectTargetCells: vi.fn(),
}));

vi.mock("@tauri-apps/plugin-clipboard-manager", () => ({
  readText: vi.fn(async () => sys.text),
  writeText: vi.fn(async (t: string) => {
    if (sys.failWrites) throw new Error("the clipboard is held open by another process");
    sys.written.push(t);
    sys.text = t;
  }),
  writeHtml: vi.fn(async (_html: string, t: string) => {
    sys.written.push(t);
    sys.text = t;
  }),
}));

vi.mock("../../lib/dialogs", () => ({
  alertAsync: vi.fn(async (_m?: string) => {}),
  confirmAsync: vi.fn(async () => true),
}));

import { useClipboard, getInternalClipboard, isCutModeLive, type UseClipboardReturn } from "../useClipboard";
import { useEditing, setGlobalIsEditing } from "../useEditing";
import { GridProvider, useGridContext } from "../../state/GridContext";
import { setSelection, setSheetContext } from "../../state/gridActions";
import { __resetExternalEditForTests } from "../../lib/formulaEditTarget";
import { runClearGesture } from "../../lib/clearGestures/clearGestures";
import { announceStyleEntries } from "../../lib/tauri-api";
import { announceBackendStateReplaced } from "../../lib/file-api";
import { cellEvents } from "../../lib/cellEvents";
import { emitAppEvent } from "../../lib/events";
import { AppEvents as ApiAppEvents } from "../../../api/events";
import type { FormattingResult, GridState } from "../../types";

Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

let clipboard: UseClipboardReturn;
let editing: ReturnType<typeof useEditing>;
let gridState: GridState;
let dispatchOut: ReturnType<typeof useGridContext>["dispatch"];

function Harness(): React.ReactElement {
  const { state, dispatch } = useGridContext();
  gridState = state;
  dispatchOut = dispatch;
  clipboard = useClipboard();
  editing = useEditing();
  return <div />;
}

let root: Root;
let host: HTMLDivElement;

/** Let promises, timers and one animation frame (cellEvents' flush) run. */
async function settle(): Promise<void> {
  for (let i = 0; i < 3; i++) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
  }
}

async function select(r0: number, c0: number, r1 = r0, c1 = c0): Promise<void> {
  await act(async () => {
    dispatchOut(setSelection({ startRow: r0, startCol: c0, endRow: r1, endCol: c1, type: "cells" }));
  });
  await settle();
}

/** Cut Sheet1!A1, which holds 5. */
async function cutA1(): Promise<void> {
  model.cells.set("0,0", { display: "5", formula: null, styleIndex: 0 });
  await select(0, 0);
  await act(async () => {
    await clipboard.cut();
  });
  await settle();
  expect(isCutModeLive(), "precondition: the cut is pending").toBe(true);
  expect(gridState.clipboard.mode).toBe("cut");
}

async function pasteAt(row: number, col: number): Promise<void> {
  await select(row, col);
  await act(async () => {
    await clipboard.paste();
  });
  await settle();
}

/** The cut ENDED: no pending move, no ants, the clipboard emptied. */
function expectCutEnded(why: string): void {
  expect(isCutModeLive(), `${why}: the cut is still a pending move`).toBe(false);
  expect(getInternalClipboard(), `${why}: the ended cut is still on the internal clipboard`).toBeNull();
  expect(gridState.clipboard.mode, `${why}: the marching ants stayed up`).toBe("none");
  expect(sys.text, `${why}: the system clipboard still holds the cut's text`).toBe("");
}

/** A Paste after the cut ended pastes NOTHING: no write, the source untouched. */
function expectNothingPasted(why: string): void {
  expect(api.updateCellsBatch, `${why}: the paste still wrote the cut's snapshot`).not.toHaveBeenCalled();
  expect(api.clearCell, `${why}: the paste still emptied the cut's source`).not.toHaveBeenCalled();
  expect(api.relocateCellReferences).not.toHaveBeenCalled();
}

beforeEach(async () => {
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  model.cells.clear();
  sys.text = null;
  sys.written = [];
  sys.failWrites = false;
  for (const fn of Object.values(api)) fn.mockClear();
  __resetExternalEditForTests();
  setGlobalIsEditing(false);
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
  await act(async () => {
    dispatchOut(setSheetContext(0, "Sheet1", undefined, "S1"));
  });
  await settle();
});

afterEach(async () => {
  // Whatever a test left pending ends here, so the next one starts clean.
  await act(async () => {
    clipboard.clearClipboardState();
  });
  await act(async () => root.unmount());
  host.remove();
  setGlobalIsEditing(false);
  __resetExternalEditForTests();
  vi.restoreAllMocks();
});

describe("the reported loss: an edit of the cut cell, and Esc", () => {
  it("Cut A1 (5), type 7 into A1 and Enter, Paste at C1: nothing is pasted and A1 keeps the 7", async () => {
    await cutA1();
    await act(async () => {
      await editing.startEdit(0, 0, "7");
    });
    await settle();
    // Excel ends cut mode as the edit STARTS, before anything is stored.
    expectCutEnded("typing into the cut cell");
    await act(async () => {
      await editing.commitEdit();
    });
    await settle();
    expect(api.updateCell).toHaveBeenCalledWith(0, 0, "7");
    for (const fn of Object.values(api)) if (fn !== api.updateCell) fn.mockClear();

    await pasteAt(0, 2);
    expectNothingPasted("type 7 into A1, then Paste");
  });

  it("an edit started in ANOTHER cell ends it too, even one abandoned with Esc (Excel's F2 + Esc)", async () => {
    await cutA1();
    await act(async () => {
      await editing.startEdit(4, 4);
    });
    await settle();
    await act(async () => {
      await editing.cancelEdit();
    });
    await settle();
    expectCutEnded("F2 on E5, then Esc");
    await pasteAt(0, 2);
    expectNothingPasted("an abandoned edit elsewhere, then Paste");
  });

  it("Cut, Esc, a later Paste: nothing is pasted and the source is left alone", async () => {
    await cutA1();
    await act(async () => {
      clipboard.clearClipboardState();
    });
    await settle();
    expectCutEnded("Esc");
    await pasteAt(0, 2);
    expectNothingPasted("Cut, Esc, Paste");
  });

  it("if the clipboard cannot be emptied, a Paste still pastes nothing -- never the ended cut's text as a copy", async () => {
    await cutA1();
    sys.failWrites = true;
    await act(async () => {
      clipboard.clearClipboardState();
    });
    await settle();
    expect(isCutModeLive()).toBe(false);
    expect(sys.text, "precondition: the cut's text is still on the system clipboard").toBe("5");
    await pasteAt(0, 2);
    expectNothingPasted("Esc with the clipboard held open, then Paste");
  });
});

describe("the other endings Excel has", () => {
  it("Delete (the clear gesture) on another cell ends it", async () => {
    await cutA1();
    await act(async () => {
      await runClearGesture("clearContents", {
        selection: { startRow: 4, startCol: 4, endRow: 4, endCol: 4, type: "cells" },
        refresh: async () => {},
      });
    });
    await settle();
    expect(api.clearRange).toHaveBeenCalledTimes(1);
    expectCutEnded("Delete on E5");
    api.clearRange.mockClear();
    await pasteAt(0, 2);
    expectNothingPasted("Delete, then Paste");
  });

  it("a format change (every formatting door announces its style entries) ends it", async () => {
    await cutA1();
    await act(async () => {
      announceStyleEntries({ cells: [], styles: [{ index: 3 }] } as unknown as FormattingResult);
    });
    await settle();
    expectCutEnded("a Bold on another cell");
  });

  it("inserting rows (the wrappers' ROWS_INSERTED) ends it", async () => {
    await cutA1();
    await act(async () => {
      emitAppEvent(ApiAppEvents.ROWS_INSERTED, { startRow: 9, count: 1 });
    });
    await settle();
    expectCutEnded("Insert Sheet Rows");
  });

  it("a document replacement (File > New / Open, a checkout) ends it", async () => {
    await cutA1();
    await act(async () => {
      announceBackendStateReplaced();
    });
    await settle();
    expectCutEnded("File > Open");
  });

  it("the cut's own paste ends it: a SECOND Paste pastes nothing (it used to paste the snapshot again)", async () => {
    await cutA1();
    await pasteAt(0, 2);
    expect(api.updateCellsBatch).toHaveBeenCalledTimes(1);
    expect(api.clearCell.mock.calls).toEqual([[0, 0]]);
    expectCutEnded("the cut's own paste");
    for (const fn of Object.values(api)) fn.mockClear();
    await pasteAt(0, 4);
    expectNothingPasted("a second Paste after the cut was pasted");
  });
});

describe("the deliberate difference: a stale snapshot never moves", () => {
  it("an undo ends it (Excel keeps cut mode and moves what the source holds THEN; this cut holds a snapshot)", async () => {
    await cutA1();
    await act(async () => {
      emitAppEvent(ApiAppEvents.MUTATION_REFRESH, { domains: ["styles"], source: "undo" });
    });
    await settle();
    expectCutEnded("Ctrl+Z");
  });

  it("a script's write ONTO the cut cell ends it", async () => {
    await cutA1();
    await act(async () => {
      cellEvents.emitBatch([{ row: 0, col: 0, newValue: "8", formula: null }], "script");
    });
    await settle();
    expectCutEnded("a script writing A1");
    await pasteAt(0, 2);
    expectNothingPasted("a script wrote A1, then Paste");
  });

  it("control: a script's write ELSEWHERE, a recalculated formula in the cut and a selection move keep it -- and Paste moves it", async () => {
    model.cells.set("0,1", { display: "10", formula: "=A1*2", styleIndex: 0 });
    model.cells.set("0,0", { display: "5", formula: null, styleIndex: 0 });
    await select(0, 0, 0, 1);
    await act(async () => {
      await clipboard.cut();
    });
    await settle();
    await act(async () => {
      cellEvents.emitBatch([{ row: 6, col: 6, newValue: "8", formula: null }], "script");
      // B1's formula only recalculated: the cut moves the formula, not its value.
      cellEvents.emitBatch([{ row: 0, col: 1, newValue: "12", formula: "=A1*2" }], "user");
    });
    await select(5, 5);
    expect(isCutModeLive(), "a change that does not touch the cut's cells ended it").toBe(true);
    expect(gridState.clipboard.mode).toBe("cut");

    await pasteAt(0, 3);
    expect(api.updateCellsBatch).toHaveBeenCalledTimes(1);
    expect(api.clearCell.mock.calls).toEqual([
      [0, 0],
      [0, 1],
    ]);
  });
});
