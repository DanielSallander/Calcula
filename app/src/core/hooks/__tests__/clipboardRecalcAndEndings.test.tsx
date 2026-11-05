//! FILENAME: app/src/core/hooks/__tests__/clipboardRecalcAndEndings.test.tsx
// PURPOSE: A pending copy follows a RECALCULATED value of its copied formulas
//          (Paste Values pastes the current value), and the commands Excel
//          ends the clipboard mode on end it here -- Calculate Now / Calculate
//          Sheet, an AutoFilter's criteria, Group / Ungroup / Clear Outline,
//          Merge / Unmerge -- each through the REAL wrapper every route calls.
//          The system clipboard's text never falls out of step with the
//          internal clipboard's, and a write that lands while a paste is
//          waiting is read again, never refused as "could not be read".
// CONTEXT: Bug-ledger fix programme, round 13 (lane clip5), reviewer rev11B's
//          findings on round 11. Excel 16 [LIVE 2026-10-30]:
//            - rev11B/probe2.ps1: copy B1 (=A1*2, 10), a COM write of 7 into
//              A1, PasteSpecial values -> 14; the clipboard text follows;
//            - rev11B/probe.ps1 and clip5/probe-endings.ps1: Application.
//              Calculate, Worksheet.Calculate, AutoFilter on / criteria /
//              ShowAllData / a column's criteria cleared, Group / Ungroup /
//              ClearOutline, Merge / UnMerge set CutCopyMode to 0;
//              AutoFilter.ApplyFilter, AutoFilterMode = False, ShowLevels,
//              CalculateFull keep it.
//          Round 14 (lane clip6), clip5's NEW item: setting the calculation
//          mode ends it too, either way and even to the mode already in effect
//          [LIVE, clip5/probe-endings.ps1 and clip6/probe-calc.ps1: auto->auto,
//          manual->manual, auto->manual, manual->auto -> CutCopyMode 0].
//          The backend (`invoke`) and the Tauri clipboard plugin are doubles.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";

interface ModelCell {
  display: string;
  formula: string | null;
  styleIndex: number;
  /** The STORED number, when the display (a number format) does not show it whole. */
  value?: number;
}

/** The cells the doubles serve: "row,col" -> cell. */
const model = vi.hoisted(() => ({ cells: new Map<string, ModelCell>() }));
/** The system clipboard: what readText answers, every write, and the hooks a test sets. */
const sys = vi.hoisted(() => ({
  text: null as string | null,
  written: [] as string[],
  /** Every write (HTML and text alike) fails: another process holds the clipboard open. */
  failAllWrites: false,
  /** Called inside the next write, before it lands (once). */
  onWrite: null as null | (() => void),
  /** Called inside the next read, before it answers (once). */
  onRead: null as null | (() => void),
  /** Called inside the next merged-cells read of a paste, before it answers (once). */
  onMerges: null as null | (() => void),
  /** Called inside EVERY merged-cells read (a source that never holds still). */
  everyMerges: null as null | (() => void),
}));

/**
 * What the backend WROTE for each batch (BUG-0657): a write naming its source
 * (`CellUpdateInput.source`) writes what that cell holds when the batch
 * arrives -- the backend reads it under its own guards, before any write --
 * and any other write its `value`. Constants only (these tests copy none of
 * the formulas the backend would shift).
 */
const backend = vi.hoisted(() => ({ wrote: [] as string[][] }));

const api = vi.hoisted(() => ({
  updateCellsBatch: vi.fn(async (u: unknown[], _o?: unknown) => {
    backend.wrote.push(
      (u as Array<{ value: string; source?: { row: number; col: number } }>).map((w) =>
        w.source ? (model.cells.get(`${w.source.row},${w.source.col}`)?.display ?? "") : w.value,
      ),
    );
    return [] as unknown[];
  }),
  clearCell: vi.fn(async (_row?: number, _col?: number) => {}),
  relocateCellReferences: vi.fn(async (..._args: unknown[]) => [] as unknown[]),
  /** The backend's commands the REAL wrappers send: the answer per command. */
  invoke: vi.fn(async (cmd: string, _args?: unknown): Promise<unknown> => {
    if (cmd === "calculate_now" || cmd === "calculate_sheet") return [];
    if (cmd === "merge_cells" || cmd === "unmerge_cells") {
      return { success: true, mergedRegions: [], updatedCells: [], createdRegions: [], removedRegions: [], lossyRegions: 0 };
    }
    return { success: true, hiddenRows: [], visibleRows: [] };
  }),
}));

function cellData(row: number, col: number): unknown {
  const cell = model.cells.get(`${row},${col}`);
  return cell ? { row, col, display: cell.display, formula: cell.formula, styleIndex: cell.styleIndex } : null;
}

vi.mock("@tauri-apps/api/core", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  invoke: (cmd: string, args?: unknown) => api.invoke(cmd, args),
}));

vi.mock("../../lib/tauri-api", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  beginUndoTransaction: vi.fn(async () => 7),
  commitUndoTransaction: vi.fn(async () => {}),
  cancelUndoTransaction: vi.fn(async () => {}),
  beginUndoSavepoint: vi.fn(async () => ({ ticket: null, savepoint: { transaction: 7, changes: 0 } })),
  rollBackToUndoSavepoint: vi.fn(async () => ({ success: true })),
  updateCellsBatch: (u: unknown[], o?: unknown) => api.updateCellsBatch(u, o),
  clearCell: (row: number, col: number) => api.clearCell(row, col),
  relocateCellReferences: (...args: unknown[]) => api.relocateCellReferences(...args),
  getSheets: vi.fn(async () => ({
    sheets: [{ index: 0, name: "Sheet1", sheetId: "S1", visibility: "visible" }],
    activeIndex: 0,
  })),
  getMergedRegions: vi.fn(async () => {
    const hook = sys.onMerges;
    sys.onMerges = null;
    hook?.();
    sys.everyMerges?.();
    return [];
  }),
  shiftFormulasBatch: vi.fn(async (inputs: { formula: string }[]) => inputs.map((i) => i.formula)),
  // The copy's own read (no sheet named) has no typed read: constants fall
  // back to display. The sheet-addressed re-read answers from the model.
  getRangeCellsTyped: vi.fn(async (r0: number, c0: number, r1: number, c1: number, sheet?: number) => {
    if (sheet === undefined) throw new Error("no typed read in this double");
    const out: unknown[] = [];
    for (const [key, cell] of model.cells) {
      const [row, col] = key.split(",").map(Number);
      if (row < r0 || row > r1 || col < c0 || col > c1) continue;
      const n = cell.value ?? Number(cell.display);
      out.push({
        row,
        col,
        display: cell.display,
        formula: cell.formula,
        type: Number.isFinite(n) ? "number" : "text",
        value: Number.isFinite(n) ? n : cell.display,
      });
    }
    return out;
  }),
  getWatchCells: vi.fn(async (requests: [number, number, number][]) => requests.map(([, row, col]) => cellData(row, col))),
  getCommentsForSheet: vi.fn(async () => []),
  getAllDataValidations: vi.fn(async () => []),
  getCell: vi.fn(async (row: number, col: number) => cellData(row, col)),
  getCollectionTexts: vi.fn(async () => []),
  getComment: vi.fn(async () => null),
  getDataValidation: vi.fn(async () => null),
}));

vi.mock("../../../api/cellTarget", () => ({
  getCellTargetCells: vi.fn(async () => ({ cells: [], merges: [], conditional: [], styles: [], rules: [] })),
  selectTargetCells: vi.fn(),
}));

vi.mock("@tauri-apps/plugin-clipboard-manager", () => {
  const write = (t: string): void => {
    const hook = sys.onWrite;
    sys.onWrite = null;
    hook?.();
    if (sys.failAllWrites) throw new Error("the clipboard is held open by another process");
    sys.written.push(t);
    sys.text = t;
  };
  return {
    readText: vi.fn(async () => {
      const hook = sys.onRead;
      sys.onRead = null;
      hook?.();
      return sys.text;
    }),
    writeText: vi.fn(async (t: string) => write(t)),
    writeHtml: vi.fn(async (_html: string, t: string) => write(t)),
  };
});

vi.mock("../../lib/dialogs", () => ({
  alertAsync: vi.fn(async (_m?: string) => {}),
  confirmAsync: vi.fn(async () => true),
}));

import {
  useClipboard,
  getInternalClipboard,
  settledInternalClipboard,
  SNAPSHOT_REFRESH_MAX_READS,
  type ClipboardData,
  type UseClipboardReturn,
} from "../useClipboard";
import { GridProvider, useGridContext } from "../../state/GridContext";
import { setSelection, setSheetContext } from "../../state/gridActions";
import { emitAppEvent } from "../../lib/events";
import {
  calculateNow,
  calculateSheet,
  mergeCells,
  unmergeCells,
  groupRows,
  ungroupColumns,
  clearOutline,
  collapseRowGroup,
  showOutlineLevel,
  recalcWithCube,
  setCalculationMode,
  beginUndoTransaction,
  cancelUndoTransaction,
  getRangeCellsTyped,
} from "../../lib/tauri-api";
import {
  applyAutoFilter,
  setColumnFilterValues,
  clearColumnCriteria,
  clearAutoFilterCriteria,
  reapplyAutoFilter,
  removeAutoFilter,
} from "../../../api/backend";
import { AppEvents as ApiAppEvents } from "../../../api/events";
import * as dialogs from "../../lib/dialogs";
import type { GridState } from "../../types";

Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

let clipboard: UseClipboardReturn;
let gridState: GridState;
let dispatchOut: ReturnType<typeof useGridContext>["dispatch"];

function Harness(): React.ReactElement {
  const { state, dispatch } = useGridContext();
  gridState = state;
  dispatchOut = dispatch;
  clipboard = useClipboard();
  return <div />;
}

let root: Root;
let host: HTMLDivElement;

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

async function copyAt(row: number, col: number, cut = false): Promise<void> {
  await select(row, col);
  await act(async () => {
    if (cut) await clipboard.cut();
    else await clipboard.copy();
  });
  await settle();
  expect(getInternalClipboard(), "precondition: the copy is pending").not.toBeNull();
}

async function pasteAt(row: number, col: number): Promise<void> {
  await select(row, col);
  await act(async () => {
    await clipboard.paste();
  });
  await settle();
}

type Update = {
  row: number;
  col: number;
  value: string;
  styleIndex?: number;
  invariant?: boolean;
  source?: { sheetIndex: number; row: number; col: number; unshifted?: boolean };
};

/** The first write of the paste. */
function firstUpdate(): Update {
  const [updates] = api.updateCellsBatch.mock.calls[0] as unknown as [Update[]];
  return updates[0];
}

/** A value change on (row, col), as the backend's recalculation announces it. */
function announceChange(row: number, col: number, newValue: string, formula: string | null, source = "script"): void {
  emitAppEvent(ApiAppEvents.CELL_VALUES_CHANGED, { changes: [{ row, col, newValue, formula }], source });
}

beforeEach(async () => {
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  model.cells.clear();
  sys.text = null;
  sys.written = [];
  sys.failAllWrites = false;
  sys.onWrite = null;
  sys.onRead = null;
  sys.onMerges = null;
  sys.everyMerges = null;
  api.updateCellsBatch.mockClear();
  backend.wrote = [];
  api.clearCell.mockClear();
  api.relocateCellReferences.mockClear();
  api.invoke.mockClear();
  vi.mocked(dialogs.alertAsync).mockClear();
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
  await act(async () => {
    clipboard.clearClipboardState();
  });
  await act(async () => root.unmount());
  host.remove();
  vi.restoreAllMocks();
});

describe("a copied formula's value follows its recalculation [LIVE rev11B/probe2]", () => {
  it("copy B1 (=A1*2, 10); a script writes 7 into A1 and B1 recalculates to 14: the copy carries 14", async () => {
    model.cells.set("0,1", { display: "10", formula: "=A1*2", styleIndex: 0 });
    await copyAt(0, 1);
    model.cells.set("0,1", { display: "14", formula: "=A1*2", styleIndex: 0 });
    await act(async () => {
      // The formula is unchanged: only its VALUE moved.
      announceChange(0, 1, "14", "=A1*2");
    });
    await settle();
    const clip = await settledInternalClipboard();
    expect(clip, "the recalculation ended the copy (Excel keeps it)").not.toBeNull();
    expect(clip?.values?.[0]?.[0], "Paste Values would paste the stale 10 (Excel pastes 14)").toEqual({ type: "number", value: 14 });
    expect(clip?.cells[0]?.[0]?.display).toBe("14");
  });

  // Round 15 (lane clip7, rev13B MAJOR): the change announces the DISPLAY, and
  // Paste Values pastes the STORED value. This used to be a control that
  // pinned the opposite ("a change that leaves the formula AND the value as
  // copied reads nothing again"); it compared display text, so a number format
  // that shows 110 for both 110 and 110.22 kept the old value. Changed
  // deliberately: Excel pastes the recalculated value [LIVE rev11B/probe2].
  it("copy B1 (=A1*1.1 under the format 0, showing 110 = 110); A1 moves and B1 is 110.22, STILL showing 110: Paste Values carries 110.22", async () => {
    model.cells.set("0,1", { display: "110", formula: "=A1*1.1", styleIndex: 4, value: 110 });
    await copyAt(0, 1);
    model.cells.set("0,1", { display: "110", formula: "=A1*1.1", styleIndex: 4, value: 110.22 });
    await act(async () => {
      // Formula and shown text both as copied: only the stored value moved.
      announceChange(0, 1, "110", "=A1*1.1");
    });
    await settle();
    const clip = await settledInternalClipboard();
    expect(clip, "the recalculation ended the copy (Excel keeps it)").not.toBeNull();
    expect(clip?.values?.[0]?.[0], "Paste Values would paste the stale 110 (Excel pastes 110.22)").toEqual({ type: "number", value: 110.22 });
  });
});

describe("the commands Excel ends the clipboard mode on end it here [LIVE]", () => {
  async function expectEndedBy(why: string, run: () => Promise<unknown>, cut = false): Promise<void> {
    model.cells.set("0,5", { display: "f1", formula: null, styleIndex: 0 });
    await copyAt(0, 5, cut);
    await act(async () => {
      await run();
    });
    await settle();
    expect(getInternalClipboard(), `${why} left the ${cut ? "cut" : "copy"} pasteable (Excel ends it)`).toBeNull();
    expect(gridState.clipboard.mode, `${why}: the marching ants stayed up`).toBe("none");
  }

  async function expectKeptBy(why: string, run: () => Promise<unknown>): Promise<void> {
    model.cells.set("0,5", { display: "f1", formula: null, styleIndex: 0 });
    await copyAt(0, 5);
    await act(async () => {
      await run();
    });
    await settle();
    expect(getInternalClipboard(), `${why} ended the copy (Excel keeps it)`).not.toBeNull();
    await act(async () => {
      clipboard.clearClipboardState();
    });
  }

  it("Calculate Now (F9) and Calculate Sheet (Shift+F9), a copy's and a cut's", async () => {
    await expectEndedBy("Calculate Now", () => calculateNow());
    await expectEndedBy("Calculate Sheet", () => calculateSheet());
    await expectEndedBy("Calculate Now", () => calculateNow(), true);
  });

  it("[LIVE] a change of the calculation mode, either way and to the mode in effect, a copy's and a cut's", async () => {
    await expectEndedBy("Calculation Options > Manual", () => setCalculationMode("manual"));
    await expectEndedBy("Calculation Options > Automatic", () => setCalculationMode("automatic"), true);
    await expectEndedBy("Automatic again (the mode already in effect)", () => setCalculationMode("automatic"));
  });

  it("control: a calculation-mode switch the backend refused ends nothing", async () => {
    const prior = api.invoke.getMockImplementation()!;
    api.invoke.mockImplementation(async (cmd: string, args?: unknown) => {
      if (cmd === "set_calculation_mode") throw new Error("refused");
      return prior(cmd, args);
    });
    try {
      await expectKeptBy("a refused calculation-mode switch", () => setCalculationMode("manual").catch(() => "refused"));
    } finally {
      api.invoke.mockImplementation(prior);
    }
  });

  it("an AutoFilter turned on, its criteria applied, a column's or all criteria cleared", async () => {
    await expectEndedBy("AutoFilter on", () => applyAutoFilter(0, 0, 5, 1));
    await expectEndedBy("AutoFilter criteria", () => setColumnFilterValues(0, ["Al"]));
    await expectEndedBy("a column's criteria cleared", () => clearColumnCriteria(0));
    await expectEndedBy("Clear (all criteria)", () => clearAutoFilterCriteria(), true);
  });

  it("Group, Ungroup and Clear Outline", async () => {
    await expectEndedBy("Group rows", () => groupRows(2, 3));
    await expectEndedBy("Ungroup columns", () => ungroupColumns(2, 3));
    await expectEndedBy("Clear Outline", () => clearOutline(), true);
  });

  it("Merge and Unmerge", async () => {
    await expectEndedBy("Merge", () => mergeCells(1, 0, 1, 1));
    await expectEndedBy("Unmerge", () => unmergeCells(1, 0), true);
  });

  it("controls: reapplying or removing a filter, collapsing or showing a level, a merge probe and CalculateFull keep it", async () => {
    await expectKeptBy("Reapply", () => reapplyAutoFilter());
    await expectKeptBy("removing the AutoFilter", () => removeAutoFilter());
    await expectKeptBy("collapsing a group", () => collapseRowGroup(3));
    await expectKeptBy("Show level 1", () => showOutlineLevel(1));
    await expectKeptBy("a merge probe", () => mergeCells(1, 0, 1, 1, undefined, { probe: true }));
    await expectKeptBy("a full recalculation with cubes (CalculateFull)", () => recalcWithCube());
  });

  it("a REFUSED command ends nothing", async () => {
    api.invoke.mockImplementation(async (cmd: string) => {
      if (cmd === "calculate_now") return [];
      return { success: false, error: "refused", hiddenRows: [], visibleRows: [], mergedRegions: [], updatedCells: [] };
    });
    await expectKeptBy("a refused filter", () => setColumnFilterValues(0, ["Al"]));
    await expectKeptBy("a refused merge", () => mergeCells(1, 0, 1, 1));
    await expectKeptBy("a refused group", () => groupRows(2, 3));
  });
});

// rev11B finding 2 (MAJOR, PLAUSIBLE): when the re-read's system-clipboard
// write failed, the NEW text was still stored internally, so the system
// clipboard's OLD text looked like another program's newer copy and a later
// Ctrl+V pasted it as constants -- formula and format lost, a cut not moved.
describe("the internal text never disagrees with what the system clipboard holds", () => {
  it("a failed write keeps the old text: a later Paste pastes the fresh cells, not the old text", async () => {
    model.cells.set("0,0", { display: "5", formula: null, styleIndex: 3 });
    await copyAt(0, 0);
    expect(sys.text).toBe("5");
    sys.failAllWrites = true;
    model.cells.set("0,0", { display: "77", formula: null, styleIndex: 3 });
    await act(async () => {
      announceChange(0, 0, "77", null);
    });
    await settle();
    expect(sys.text, "precondition: the system clipboard still holds the old text").toBe("5");
    expect(getInternalClipboard()?.text, "the internal text moved on while the system clipboard did not").toBe("5");
    await pasteAt(0, 2);
    const update = firstUpdate();
    expect(update.value).toBe("77");
    expect(update.styleIndex, "the paste took the system clipboard's old text for another program's copy").toBe(3);
  });

  it("a write that lands while the copy's source FOLLOWED a shift: the followed copy takes the text written", async () => {
    model.cells.set("1,0", { display: "5", formula: null, styleIndex: 3 });
    await copyAt(1, 0);
    // The re-read's write of "77": meanwhile a script inserts a row above the
    // copy, which moves its source to A3 (and the 77 with it).
    sys.onWrite = () => {
      model.cells.delete("1,0");
      model.cells.set("2,0", { display: "77", formula: null, styleIndex: 3 });
      emitAppEvent(ApiAppEvents.STRUCTURAL_EDIT_ELSEWHERE, {
        descriptions: ["Insert Rows"],
        edits: [{ sheetIndex: 0, kind: "rowInsert", at: 0, count: 1 }],
      });
    };
    model.cells.set("1,0", { display: "77", formula: null, styleIndex: 3 });
    await act(async () => {
      announceChange(1, 0, "77", null);
    });
    await settle();
    expect(sys.text).toBe("77");
    expect(getInternalClipboard()?.sourceSelection.startRow, "precondition: the copy followed the insert").toBe(2);
    expect(getInternalClipboard()?.text, "the followed copy kept the old text the system clipboard no longer holds").toBe("77");
    await pasteAt(0, 2);
    const update = firstUpdate();
    expect(update.value).toBe("77");
    expect(update.styleIndex, "the paste took our own text for another program's copy").toBe(3);
  });
});

// rev11B finding 4 (minor, PLAUSIBLE): a stale-mark that landed between the
// paste's settle and its "unreadable" check refused the paste untruly ("what
// they hold now could not be read") and ENDED the mode, though no read failed.
describe("a write that lands while a paste waits is read again, never refused", () => {
  it("Cut A1 (5); a script writes 9 into A1 while the paste reads the clipboard: the paste moves 9", async () => {
    model.cells.set("0,0", { display: "5", formula: null, styleIndex: 0 });
    await copyAt(0, 0, true);
    await select(0, 2);
    sys.onRead = () => {
      model.cells.set("0,0", { display: "9", formula: null, styleIndex: 0 });
      announceChange(0, 0, "9", null);
    };
    await act(async () => {
      await clipboard.paste();
    });
    await settle();
    expect(vi.mocked(dialogs.alertAsync).mock.calls.map((c) => c[0]), "the paste was refused as unreadable").toEqual([]);
    expect(api.updateCellsBatch, "nothing was pasted").toHaveBeenCalledTimes(1);
    expect(firstUpdate().value, "the paste moved the stale 5").toBe("9");
    expect(api.clearCell.mock.calls).toEqual([[0, 0]]);
  });

  // Round 15 (lane clip7, rev13B minor): a write that lands AFTER the settle --
  // during the paste's own later awaits (here: the merged-cells read of a tiled
  // paste) -- left the paste writing the snapshot it had taken. Round 15 made
  // the paste start again for it; round C (BUG-0657) names each write's SOURCE
  // instead, so the backend writes what A1 holds AT THE WRITE and the paste
  // never restarts for a value. (Was: "the batch's values are 9, 9", which only
  // a restart could give; the values are the backend's now.)
  it("Copy A1 (5); a script writes 9 into A1 while the paste reads the merges of D1:D2: both tiles name A1 and get 9", async () => {
    model.cells.set("0,0", { display: "5", formula: null, styleIndex: 0 });
    await copyAt(0, 0);
    await select(0, 3, 1, 3);
    sys.onMerges = () => {
      model.cells.set("0,0", { display: "9", formula: null, styleIndex: 0 });
      announceChange(0, 0, "9", null);
    };
    await act(async () => {
      await clipboard.paste();
    });
    await settle();
    expect(vi.mocked(dialogs.alertAsync).mock.calls.map((c) => c[0]), "the paste was refused").toEqual([]);
    expect(api.updateCellsBatch, "the paste wrote more than once").toHaveBeenCalledTimes(1);
    const [updates] = api.updateCellsBatch.mock.calls[0] as unknown as [Update[]];
    expect(updates.map((u) => u.source), "a tile did not name its source").toEqual([
      { sheetIndex: 0, row: 0, col: 0 },
      { sheetIndex: 0, row: 0, col: 0 },
    ]);
    expect(backend.wrote, "the paste wrote the snapshot the write had replaced").toEqual([["9", "9"]]);
    expect(getInternalClipboard(), "the copy ended").not.toBeNull();
  });

  // Round 16 (clip7's remaining (a)): the check above ran BEFORE the undo step
  // opened, so a write landing while it opened (beginUndoTransaction, a cut's
  // move point) still left the paste writing the snapshot it had taken. Round
  // 16 closed the step and started again; round C (BUG-0657): the write names
  // A1 and the backend writes what it holds at the write -- one step, no
  // restart. (Was: "value 9 and the stale attempt's step cancelled once".)
  it("Copy A1 (5); a script writes 9 into A1 while the paste's undo step opens: the backend writes 9, nothing starts again", async () => {
    model.cells.set("0,0", { display: "5", formula: null, styleIndex: 0 });
    await copyAt(0, 0);
    await select(0, 3);
    vi.mocked(cancelUndoTransaction).mockClear();
    vi.mocked(beginUndoTransaction).mockImplementationOnce(async () => {
      model.cells.set("0,0", { display: "9", formula: null, styleIndex: 0 });
      announceChange(0, 0, "9", null);
      return 7;
    });
    await act(async () => {
      await clipboard.paste();
    });
    await settle();
    expect(vi.mocked(dialogs.alertAsync).mock.calls.map((c) => c[0]), "the paste was refused").toEqual([]);
    expect(api.updateCellsBatch, "the paste wrote more than once").toHaveBeenCalledTimes(1);
    expect(firstUpdate().source, "the write did not name its source").toEqual({ sheetIndex: 0, row: 0, col: 0 });
    expect(backend.wrote, "the paste wrote the snapshot the write had replaced (5)").toEqual([["9"]]);
    expect(vi.mocked(cancelUndoTransaction), "the paste started again for a value").not.toHaveBeenCalled();
    expect(getInternalClipboard(), "the copy ended").not.toBeNull();
  });

  // Round 16 (clip7's remaining (b)): every Paste Special door reads through
  // settledInternalClipboard(). When marks kept landing past its bounded
  // settle -- here each re-read is overtaken by a write onto A1 AND by a sheet
  // inserted ahead of the source, which replaces the snapshot under the read
  // -- it handed back the stale, never-read snapshot with no notice. It now
  // answers null with the copy kept and tells the user to paste again once.
  it("settledInternalClipboard: a source that never holds still is refused once, the copy kept, never the stale snapshot", async () => {
    model.cells.set("0,0", { display: "5", formula: null, styleIndex: 0 });
    await copyAt(0, 0);
    const reads = vi.mocked(getRangeCellsTyped);
    const real = reads.getMockImplementation()!;
    let n = 10;
    let flip = false;
    reads.mockImplementation(async (r0, c0, r1, c1, sheet) => {
      const out = await real(r0, c0, r1, c1, sheet);
      if (sheet !== undefined && n < 60) {
        n += 1;
        model.cells.set("0,0", { display: String(n), formula: null, styleIndex: 0 });
        announceChange(0, 0, String(n), null);
        flip = !flip;
        window.dispatchEvent(
          new CustomEvent("sheet:reorder", {
            detail: flip ? { fromIndex: Number.MAX_SAFE_INTEGER, toIndex: 0 } : { fromIndex: 0, toIndex: Number.MAX_SAFE_INTEGER },
          }),
        );
      }
      return out;
    });
    try {
      // A write onto A1 marks the snapshot stale: the background re-read starts.
      model.cells.set("0,0", { display: "6", formula: null, styleIndex: 0 });
      announceChange(0, 0, "6", null);
      let answer: unknown = "unset";
      await act(async () => {
        answer = await settledInternalClipboard();
      });
      expect(answer, "a snapshot its source no longer holds was handed to Paste Special").toBeNull();
      expect(vi.mocked(dialogs.alertAsync).mock.calls.map((c) => String(c[0]))).toEqual([
        expect.stringContaining("kept changing"),
      ]);
      expect(getInternalClipboard(), "the refusal ended the copy").not.toBeNull();
    } finally {
      reads.mockImplementation(real);
    }
  });

  // Round 17 (rev15B minor): the re-read loop ran while the snapshot was stale,
  // and the settle waited while a re-read existed -- so a writer that writes
  // the copied cells on EVERY re-read (an animation, a scheduled job) kept
  // Paste Special waiting for as long as it ran. The writer here gives up only
  // after WRITER_LIMIT re-reads, so the unbounded loop still ends and the read
  // count is the evidence.
  //
  // Round 19 (misc19): past the bound it answered null and told the user to
  // paste again, for as long as the writer ran. Excel [LIVE, misc19/probe3.ps1]
  // pastes what the source holds at the paste, so it now answers the snapshot
  // of its LAST re-read -- what A1 held then -- never the copy-time 5 and with
  // no refusal. (This assertion was "answer toBeNull + one 'kept changing'
  // alert"; changed deliberately for Excel's rule.)
  it("a writer that writes on every re-read: the settle ends after a bounded number of reads and answers its last read, the copy kept", async () => {
    const WRITER_LIMIT = 400;
    model.cells.set("0,0", { display: "5", formula: null, styleIndex: 0 });
    await copyAt(0, 0);
    const reads = vi.mocked(getRangeCellsTyped);
    const real = reads.getMockImplementation()!;
    let rereads = 0;
    reads.mockImplementation(async (r0, c0, r1, c1, sheet) => {
      const out = await real(r0, c0, r1, c1, sheet);
      if (sheet !== undefined) {
        rereads += 1;
        if (rereads <= WRITER_LIMIT) {
          model.cells.set("0,0", { display: String(100 + rereads), formula: null, styleIndex: 0 });
          announceChange(0, 0, String(100 + rereads), null);
        }
      }
      return out;
    });
    try {
      model.cells.set("0,0", { display: "6", formula: null, styleIndex: 0 });
      announceChange(0, 0, "6", null);
      let answer: unknown = "unset";
      await act(async () => {
        answer = await settledInternalClipboard();
      });
      expect(
        rereads,
        "the settle kept reading for as long as the writer wrote (unbounded under a writer that outpaces the re-read)",
      ).toBeLessThanOrEqual(SNAPSHOT_REFRESH_MAX_READS * 12);
      const got = answer as ClipboardData | null;
      expect(got, "a source that kept changing was refused instead of pasted as it stood").not.toBeNull();
      const shown = got?.cells[0]?.[0]?.display;
      expect(shown, "the copy-time snapshot was handed back instead of the last read").not.toBe("5");
      expect(Number(shown), "the answer is a value A1 held during the settle").toBeGreaterThanOrEqual(6);
      expect(vi.mocked(dialogs.alertAsync).mock.calls.map((c) => String(c[0])), "the paste was refused").toEqual([]);
      expect(getInternalClipboard(), "the settle ended the copy").not.toBeNull();
    } finally {
      reads.mockImplementation(real);
      // Let a background refresh the last mark started finish against the real double.
      await settle();
    }
  });

  // Round 19 (misc19): this paste was refused after its bounded restarts, for as
  // long as the writer ran. Excel [LIVE, misc19/probe3.ps1] pastes what the
  // source holds at the paste; round 19 wrote the snapshot of its last re-read,
  // which the writer had already outrun (BUG-0657). Round C: the writes name
  // A1 and the backend writes what A1 holds AT THE WRITE -- once, no restart,
  // no refusal. (Was: "the batch's values are a value read during the paste".)
  it("a source that never holds still is pasted as it stands AT THE WRITE, once, the copy kept", async () => {
    model.cells.set("0,0", { display: "5", formula: null, styleIndex: 0 });
    await copyAt(0, 0);
    await select(0, 3, 1, 3);
    let n = 10;
    sys.everyMerges = () => {
      n += 1;
      model.cells.set("0,0", { display: String(n), formula: null, styleIndex: 0 });
      announceChange(0, 0, String(n), null);
    };
    await act(async () => {
      await clipboard.paste();
    });
    await settle();
    expect(vi.mocked(dialogs.alertAsync).mock.calls.map((c) => String(c[0])), "a source that kept changing was refused").toEqual([]);
    expect(api.updateCellsBatch, "the paste wrote other than once").toHaveBeenCalledTimes(1);
    expect(backend.wrote, "the paste wrote a value A1 no longer held at the write").toEqual([[String(n), String(n)]]);
    expect(getInternalClipboard(), "the paste ended the copy").not.toBeNull();
  });

  // BUG-0657 (round C). The writer runs on EVERY call the paste makes to the
  // backend -- the settle's reads, the sheet list, the merges, the undo step --
  // so every frontend read is stale by the time the batch lands. The batch
  // names its source cells, and what lands is what they hold at the write.
  // SABOTAGE: drop `update.source = pasteSourceOf(..)` in the paste's write
  // builder -- fails at "STALE".
  it("a source written on every backend call: Copy + Paste and Cut + Paste land what it holds AT THE WRITE", async () => {
    for (const cut of [false, true]) {
      model.cells.set("0,0", { display: "5", formula: null, styleIndex: 0 });
      await copyAt(0, 0, cut);
      await select(0, 3);
      api.updateCellsBatch.mockClear();
      backend.wrote = [];
      let n = 100;
      const prior = api.invoke.getMockImplementation()!;
      const tick = (): void => {
        n += 1;
        model.cells.set("0,0", { display: String(n), formula: null, styleIndex: 0 });
      };
      api.invoke.mockImplementation(async (cmd: string, a?: unknown) => {
        tick();
        return prior(cmd, a);
      });
      sys.everyMerges = tick;
      vi.mocked(beginUndoTransaction).mockImplementationOnce(async () => {
        tick();
        return 7;
      });
      try {
        await act(async () => {
          await clipboard.paste();
        });
        await settle();
      } finally {
        api.invoke.mockImplementation(prior);
        sys.everyMerges = null;
      }
      expect(vi.mocked(dialogs.alertAsync).mock.calls.map((c) => String(c[0])), "the paste was refused").toEqual([]);
      expect(api.updateCellsBatch).toHaveBeenCalledTimes(1);
      expect(backend.wrote, `STALE: the ${cut ? "cut" : "copy"} pasted a value A1 no longer held`).toEqual([[String(n)]]);
      expect(firstUpdate().value, "precondition: the frontend's own read was stale").not.toBe(String(n));
      expect(firstUpdate().source, "a cut names its source as a MOVE (unshifted), a copy as a copy").toEqual(
        cut ? { sheetIndex: 0, row: 0, col: 0, unshifted: true } : { sheetIndex: 0, row: 0, col: 0 },
      );
      await act(async () => {
        clipboard.clearClipboardState();
      });
    }
  });

  // A copy that FOLLOWED a shift while the paste was under way names other
  // cells now: the paste starts again (bounded) and names where the source
  // stands at the write. SABOTAGE: make `sourceMovedDuringPaste` answer false
  // -- fails at "OLD ADDRESS".
  it("a copy that follows an insert during the paste names its source where it stands now", async () => {
    model.cells.set("1,0", { display: "5", formula: null, styleIndex: 0 });
    await copyAt(1, 0);
    await select(5, 3, 6, 3);
    sys.onMerges = () => {
      model.cells.delete("1,0");
      model.cells.set("2,0", { display: "5", formula: null, styleIndex: 0 });
      emitAppEvent(ApiAppEvents.STRUCTURAL_EDIT_ELSEWHERE, {
        descriptions: ["Insert Rows"],
        edits: [{ sheetIndex: 0, kind: "rowInsert", at: 0, count: 1 }],
      });
    };
    await act(async () => {
      await clipboard.paste();
    });
    await settle();
    expect(getInternalClipboard()?.sourceSelection.startRow, "precondition: the copy followed the insert").toBe(2);
    expect(api.updateCellsBatch).toHaveBeenCalledTimes(1);
    const [updates] = api.updateCellsBatch.mock.calls[0] as unknown as [Update[]];
    expect(updates.map((u) => u.source?.row), "OLD ADDRESS: the paste named the cell the copy left").toEqual([2, 2]);
    expect(backend.wrote).toEqual([["5", "5"]]);
  });
});
