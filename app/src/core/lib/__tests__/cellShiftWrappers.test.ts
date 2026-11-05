//! FILENAME: app/src/core/lib/__tests__/cellShiftWrappers.test.ts
// PURPOSE: insertCellsRange / deleteCellsRange at the bridge: what reaches the
//          backend, what is announced, and that a range spanning every column
//          (row) is an ENTIRE-row (column) insert/delete, as Excel's is.
// CONTEXT: Home tab 2026-10-04 (rust-structure lane). A cell shift moves part of
//          the sheet and every store anchored to it, but no whole-row/column
//          coordinates describe it, so the wrapper announces STRUCTURAL_UNDO (the
//          "re-read, no coordinates" announcement) plus the store domains --
//          and only when the shift was APPLIED: a stop to ask about merges
//          changed nothing and must announce nothing. Only Tauri's `invoke` is
//          doubled; the module under test is real.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

const calls: Array<{ cmd: string; args: Record<string, unknown> | undefined }> = [];
let nextResult: unknown = null;

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (cmd: string, args?: Record<string, unknown>) => {
    calls.push({ cmd, args });
    if (cmd === "insert_cells" || cmd === "delete_cells") return Promise.resolve(nextResult);
    if (cmd === "get_active_sheet") return Promise.resolve(0);
    return Promise.resolve([]);
  },
}));
vi.mock("@tauri-apps/api/event", () => ({
  emit: vi.fn(),
  listen: vi.fn(async () => () => {}),
}));

import { insertCellsRange, deleteCellsRange, setGridRecorderHook, type RecordedGridEvent } from "../tauri-api";
import { AppEvents } from "../../../api/events";

const heard: Array<{ type: string; detail: unknown }> = [];
const listener = (e: Event) => heard.push({ type: e.type, detail: (e as CustomEvent).detail });
const WATCHED = [AppEvents.STRUCTURAL_UNDO, AppEvents.MUTATION_REFRESH, AppEvents.ROWS_INSERTED, AppEvents.COLUMNS_DELETED];

beforeEach(() => {
  calls.length = 0;
  heard.length = 0;
  nextResult = { applied: true, confirm: null, wholeLines: false };
  for (const t of WATCHED) window.addEventListener(t, listener);
});
afterEach(() => {
  for (const t of WATCHED) window.removeEventListener(t, listener);
});

describe("insertCellsRange / deleteCellsRange", () => {
  it("send the range, the shift and the merge answer to the backend", async () => {
    await insertCellsRange(1, 1, 2, 2, "down");
    await deleteCellsRange(4, 3, 4, 5, "left", { unmergeCutMerges: true });
    expect(calls.filter((c) => c.cmd.endsWith("_cells"))).toEqual([
      { cmd: "insert_cells", args: { startRow: 1, startCol: 1, endRow: 2, endCol: 2, shift: "down", unmergeCutMerges: false } },
      { cmd: "delete_cells", args: { startRow: 4, startCol: 3, endRow: 4, endCol: 5, shift: "left", unmergeCutMerges: true } },
    ]);
  });

  it("an applied shift announces its band shift as coordinates (source edit) and the store domains", async () => {
    const delta = { kind: "colInsert", sheetIndex: 0, at: 1, count: 2, band: { start: 1, end: 2 } };
    nextResult = { applied: true, confirm: null, wholeLines: false, delta };
    await insertCellsRange(1, 1, 2, 2, "right");
    expect(heard.map((h) => h.type)).toEqual([AppEvents.STRUCTURAL_UNDO, AppEvents.MUTATION_REFRESH]);
    // The backend's own delta, handed on as it came (@api/structuralFollow follows it).
    expect(heard[0].detail).toEqual({ description: "Insert Cells", source: "edit", deltas: [delta] });
    const domains = (heard[1].detail as { domains: string[] }).domains;
    for (const d of ["annotations", "hyperlinks", "validations", "conditionalFormats", "controls", "objects"]) {
      expect(domains).toContain(d);
    }
  });

  it("a stop to ask about merges announces nothing", async () => {
    nextResult = { applied: false, confirm: "This operation will cause some merged cells to unmerge.", wholeLines: false };
    const result = await deleteCellsRange(1, 1, 2, 2, "up");
    expect(result.applied).toBe(false);
    expect(heard).toEqual([]);
  });

  it("a range spanning every column inserts entire rows through insert_rows", async () => {
    const result = await insertCellsRange(4, 0, 5, 16383, "right");
    expect(result).toEqual({ applied: true, confirm: null, wholeLines: true });
    expect(calls.some((c) => c.cmd === "insert_cells")).toBe(false);
    expect(calls.find((c) => c.cmd === "insert_rows")?.args).toEqual({ row: 4, count: 2 });
    expect(heard.map((h) => h.type)).toContain(AppEvents.ROWS_INSERTED);
  });

  it("a range spanning every row deletes entire columns through delete_columns", async () => {
    await deleteCellsRange(0, 2, 1048575, 2, "up");
    expect(calls.find((c) => c.cmd === "delete_columns")?.args).toEqual({ col: 2, count: 1 });
    expect(heard.map((h) => h.type)).toContain(AppEvents.COLUMNS_DELETED);
  });

  // BUG-0358: the macro recorder hears an APPLIED shift -- the block, the
  // shift, and the person's answer to unmerging -- and nothing for a stop to
  // ask; a whole-line range is recorded as the row / column edit it is.
  // SABOTAGE: drop the recordGridEvent call in insertCellsRange -> red.
  it("BUG-0358 records an applied Insert / Delete Cells for the macro recorder, never a stop to ask", async () => {
    const recorded: RecordedGridEvent[] = [];
    setGridRecorderHook((e) => recorded.push(e));
    try {
      await insertCellsRange(1, 1, 2, 2, "down");
      await deleteCellsRange(4, 3, 4, 5, "left", { unmergeCutMerges: true });
      nextResult = { applied: false, confirm: "This operation will cause some merged cells to unmerge.", wholeLines: false };
      await insertCellsRange(7, 7, 8, 8, "right");
      await insertCellsRange(4, 0, 5, 16383, "right");
    } finally {
      setGridRecorderHook(null);
    }
    expect(recorded).toEqual([
      { kind: "insertCells", startRow: 1, startCol: 1, endRow: 2, endCol: 2, shift: "down", unmergeCutMerges: false },
      { kind: "deleteCells", startRow: 4, startCol: 3, endRow: 4, endCol: 5, shift: "left", unmergeCutMerges: true },
      { kind: "insertRows", startRow: 4, count: 2 },
    ]);
  });

  // BUG-0399: the whole-line route has a sheet-size bound of its own -- an
  // end past the sheet is the sheet's last line, and a coordinate that is no
  // cell index reaches no backend command at all.
  it("BUG-0399 a whole-line range running past the sheet is bounded by the sheet", async () => {
    await insertCellsRange(1048000, 0, 5_000_000, 16383, "down");
    expect(calls.find((c) => c.cmd === "insert_rows")?.args).toEqual({ row: 1048000, count: 576 });
    await deleteCellsRange(0, 16000, 1048575, 99_999, "left");
    expect(calls.find((c) => c.cmd === "delete_columns")?.args).toEqual({ col: 16000, count: 384 });
  });

  it("BUG-0399 a coordinate that is no cell index of the sheet is refused before any call", async () => {
    await expect(insertCellsRange(-1, 0, 4, 16383, "down")).rejects.toThrow(/startRow/);
    await expect(deleteCellsRange(0, 0, 1.5, 2, "up")).rejects.toThrow(/endRow/);
    await expect(insertCellsRange(2_000_000, 0, 2_000_001, 16383, "down")).rejects.toThrow(/outside the sheet/);
    await expect(deleteCellsRange(0, Number.NaN, 4, 4, "left")).rejects.toThrow(/startCol/);
    expect(calls).toEqual([]);
  });

  // rust-followup (2026-10-04): the whole-line route moved the backend's row
  // heights / column widths (and an inserted line now TAKES its neighbour's
  // size), but the extension behind it re-reads only the cells, so the grid
  // kept painting the old sizes on the old lines. The wrapper tells the grid
  // to re-read its dimensions; a cell shift (no line moved) does not.
  it("a whole-line route asks the grid to re-read its row heights / column widths", async () => {
    const asked: string[] = [];
    const onRefresh = (e: Event) => asked.push(e.type);
    window.addEventListener("dimensions:refresh", onRefresh);
    try {
      await insertCellsRange(4, 0, 5, 16383, "right");
      await deleteCellsRange(0, 2, 1048575, 2, "up");
      expect(asked).toEqual(["dimensions:refresh", "dimensions:refresh"]);
      asked.length = 0;
      await insertCellsRange(1, 1, 2, 2, "down");
      expect(asked, "a cell shift moves no line").toEqual([]);
    } finally {
      window.removeEventListener("dimensions:refresh", onRefresh);
    }
  });
});
