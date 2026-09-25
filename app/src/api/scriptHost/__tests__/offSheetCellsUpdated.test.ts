//! FILENAME: app/src/api/scriptHost/__tests__/offSheetCellsUpdated.test.ts
// PURPOSE: A script write to a NON-active sheet must announce itself (canvas
//          sheets, M4). A chart placed on a canvas sheet reads its data from
//          another sheet; Charts invalidates on CELLS_UPDATED, scoped by each
//          change's sheetIndex. Before this, every off-sheet write path in the
//          host called only scheduleGridDataRefresh() — no CELLS_UPDATED at
//          all — so the chart kept drawing the old numbers.
// CONTEXT: Pinned here, per off-sheet writer:
//            - the written cells ride ONE tagged CELLS_UPDATED per frame, each
//              change carrying the target sheetIndex;
//            - exactly ONE bare CELLS_UPDATED per frame follows (the backend
//              recalculated the write's formula dependents and reported none);
//            - NO CELL_VALUES_CHANGED — that event feeds sheet.onDataChange,
//              and the own-write suppression's 250 ms TTL cannot cover a long
//              per-cell off-sheet loop (the timestamp-macro feedback loop);
//            - the active-sheet path is unchanged (cellEvents, untagged, no
//              bare event);
//            - the off-sheet clear announces without re-fetching the canvas
//              (its no-refetch rule is pinned in crossSheetStructural.test.ts);
//            - a deferRepaint bracket holds the announcement until release.
//          Same FakeWorker harness as tableTypedWrites.test.ts; frames are a
//          manual requestAnimationFrame queue so "per frame" is observable.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type { H2W, W2H } from "../protocol";

const hoisted = vi.hoisted(() => ({
  table: {
    sheetIndex: 1,
    startRow: 5,
    startCol: 2,
    endRow: 8,
    endCol: 4,
    styleOptions: { headerRow: true, totalRow: false },
    columns: [{ name: "A" }, { name: "B" }, { name: "C" }],
  },
}));

vi.mock("../../backend", () => ({
  invokeBackend: vi.fn().mockResolvedValue(null),
  getWorkbookProperties: vi.fn().mockRejectedValue(new Error("no backend in test")),
  emitTauriEvent: vi.fn().mockResolvedValue(undefined),
  listenTauriEvent: vi.fn().mockResolvedValue(() => undefined),
  readVirtualFile: vi.fn().mockResolvedValue(null),
  writeVirtualFile: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("../capabilities", async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  restoreAndSyncGrants: vi.fn().mockResolvedValue(undefined),
  revokeBackendCapabilities: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("../mountGate", () => ({
  assertMountAllowed: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("../writebackWriteGuard", () => ({
  captureWritebackWrite: vi.fn(async () => false),
  captureWritebackWrites: vi.fn(async (_id: string, writes: unknown[]) => ({
    plain: [...(writes as Array<Record<string, unknown>>)],
    drafted: [],
  })),
  workbookHasWritebackRegions: vi.fn(async () => false),
}));
vi.mock("../../lib", () => ({
  getActiveSheet: vi.fn(async () => 0),
  getSheets: vi.fn(async () => ({
    sheets: [{ index: 0, name: "Sheet1" }, { index: 1, name: "Sheet2" }],
    activeIndex: 0,
  })),
  getCell: vi.fn(async () => null),
  getTableById: vi.fn(async () => hoisted.table),
  getRangeCellsTyped: vi.fn(async () => []),
  updateCell: vi.fn(async (row: number, col: number, value: string) => ({
    cells: [{ row, col, display: value, formula: null, styleIndex: 0 }],
  })),
  updateCellsBatch: vi.fn(async () => []),
  // The backend reports the sheets it WROTE: sheet 1, the off-sheet target.
  updateCellOnSheets: vi.fn(async () => [1]),
  recalculateSheetsAfterScriptWrite: vi.fn(async () => undefined),
  getUndoState: vi.fn(async () => ({ transactionOpen: false })),
  beginUndoTransaction: vi.fn(async () => undefined),
  commitUndoTransaction: vi.fn(async () => undefined),
  cancelUndoTransaction: vi.fn(async () => undefined),
}));
vi.mock("../../grid", () => ({
  refreshGridData: vi.fn(),
  refreshGridDimensions: vi.fn(),
  convertFormulaStyle: vi.fn(async (f: string) => f),
}));

class FakeWorker {
  static last: FakeWorker | null = null;
  onmessage: ((e: MessageEvent<W2H>) => void) | null = null;
  onerror: ((e: unknown) => void) | null = null;
  received: H2W[] = [];

  constructor() {
    FakeWorker.last = this;
  }

  postMessage(msg: H2W): void {
    this.received.push(msg);
    if (msg.t === "mount") this.emit({ t: "mounted", ok: true });
  }

  terminate(): void {
    /* nothing to clean up */
  }

  emit(data: W2H): void {
    this.onmessage?.({ data } as MessageEvent<W2H>);
  }

  async call(callId: number, method: string, args: unknown[]): Promise<{ ok: boolean; error?: { message?: string } }> {
    this.emit({ t: "call", callId, method, args } as W2H);
    for (let i = 0; i < 200; i++) {
      const result = this.received.find(
        (m): m is Extract<H2W, { t: "callResult" }> => m.t === "callResult" && m.callId === callId,
      );
      if (result) return result as { ok: boolean; error?: { message?: string } };
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    throw new Error(`callResult for ${method} (id ${callId}) never arrived`);
  }
}

// ---- Manual frame queue ------------------------------------------------------

let frameQueue: FrameRequestCallback[] = [];

/** Run every frame callback queued so far (and any queued while running). */
async function runFrames(): Promise<void> {
  for (let guard = 0; guard < 10 && frameQueue.length > 0; guard++) {
    const batch = frameQueue;
    frameQueue = [];
    for (const cb of batch) cb(0);
    // Let the fire closure's dynamic import("../grid") settle.
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

// ---- Event capture -----------------------------------------------------------

const CELLS_UPDATED = "app:cells-updated";
const CELL_VALUES_CHANGED = "app:cell-values-changed";

interface Captured {
  cellsUpdated: Array<{ changes?: Array<Record<string, unknown>> } | null | undefined>;
  cellValuesChanged: unknown[];
}

let captured: Captured;
const listeners: Array<[string, (e: Event) => void]> = [];

function listen(name: string, push: (detail: unknown) => void): void {
  const handler = (e: Event): void => push((e as CustomEvent).detail);
  window.addEventListener(name, handler);
  listeners.push([name, handler]);
}

function tagged(): Array<Array<Record<string, unknown>>> {
  return captured.cellsUpdated
    .filter((d): d is { changes: Array<Record<string, unknown>> } => !!d && Array.isArray(d.changes))
    .map((d) => d.changes);
}

function bareCount(): number {
  // A bare emitAppEvent(name) arrives as detail null (CustomEvent's default).
  return captured.cellsUpdated.filter((d) => d == null).length;
}

const globalScope = globalThis as unknown as Record<string, unknown>;
const originalWorker = globalScope.Worker;

type HostModule = typeof import("../host");
type LibModule = typeof import("../../lib");
type GridModule = typeof import("../../grid");
let host: HostModule;
let lib: { [K in keyof LibModule]: ReturnType<typeof vi.fn> };
let grid: { [K in keyof GridModule]: ReturnType<typeof vi.fn> };

const definition = {
  id: "script-off-sheet-writer",
  name: "Off-sheet writer",
  objectType: "workbook",
  instanceId: null,
  source: "function setup(context) {}",
  accessLevel: "unlocked" as const,
  apiVersion: "1.0.0",
};

describe("off-sheet script writes announce a TAGGED CELLS_UPDATED (canvas sheets, M4)", () => {
  beforeEach(async () => {
    FakeWorker.last = null;
    hoisted.table.sheetIndex = 1;
    frameQueue = [];
    vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => {
      frameQueue.push(cb);
      return frameQueue.length;
    });
    globalScope.Worker = FakeWorker as unknown as typeof Worker;
    vi.resetModules();
    host = await import("../host");
    lib = (await import("../../lib")) as unknown as typeof lib;
    grid = (await import("../../grid")) as unknown as typeof grid;
    for (const fn of Object.values(lib)) (fn as ReturnType<typeof vi.fn>).mockClear?.();
    await host.hostMountScript(definition);
    // Drain whatever the mount itself scheduled, THEN start recording.
    await runFrames();
    for (const fn of Object.values(grid)) (fn as ReturnType<typeof vi.fn>).mockClear?.();
    captured = { cellsUpdated: [], cellValuesChanged: [] };
    listen(CELLS_UPDATED, (d) => captured.cellsUpdated.push(d as Captured["cellsUpdated"][number]));
    listen(CELL_VALUES_CHANGED, (d) => captured.cellValuesChanged.push(d));
  });

  afterEach(async () => {
    for (const [name, handler] of listeners.splice(0)) window.removeEventListener(name, handler);
    host.hostResetAll();
    await runFrames();
    vi.unstubAllGlobals();
    globalScope.Worker = originalWorker;
  });

  it("sheet.setCellValue to another sheet: one tagged change + ONE bare event, no CELL_VALUES_CHANGED", async () => {
    const result = await FakeWorker.last!.call(1, "sheet.setCellValue", [2, 3, 42.5, "Sheet2"]);
    expect(result.ok).toBe(true);
    expect(lib.updateCellOnSheets).toHaveBeenCalledWith([1], 2, 3, "42.5", true);

    // Nothing until the frame: the announcement is coalesced like cellEvents'.
    expect(captured.cellsUpdated).toHaveLength(0);
    await runFrames();

    expect(tagged()).toEqual([
      [{ row: 2, col: 3, sheetIndex: 1, newValue: "42.5", formula: null }],
    ]);
    expect(bareCount()).toBe(1);
    expect(captured.cellsUpdated).toHaveLength(2);
    expect(captured.cellValuesChanged).toEqual([]);
    // The existing canvas refresh still happens for a cell write.
    expect(grid.refreshGridData).toHaveBeenCalledTimes(1);
  });

  it("many off-sheet writes in one frame: ONE tagged event carrying all of them + exactly ONE bare", async () => {
    const w = FakeWorker.last!;
    expect((await w.call(1, "api.setCellValue", [0, 0, 1, "Sheet2"])).ok).toBe(true);
    expect((await w.call(2, "api.setCellValue", [1, 0, "=A1*2", "Sheet2"])).ok).toBe(true);
    expect((await w.call(3, "sheet.setCellValue", [2, 0, "x", 1])).ok).toBe(true);
    await runFrames();

    const t = tagged();
    expect(t).toHaveLength(1);
    expect(t[0]).toEqual([
      { row: 0, col: 0, sheetIndex: 1, newValue: "1", formula: null },
      { row: 1, col: 0, sheetIndex: 1, newValue: "=A1*2", formula: "=A1*2" },
      { row: 2, col: 0, sheetIndex: 1, newValue: "x", formula: null },
    ]);
    expect(bareCount()).toBe(1);
    expect(captured.cellValuesChanged).toEqual([]);

    // The NEXT frame owes nothing: the debt was paid once and cleared.
    captured.cellsUpdated.length = 0;
    await runFrames();
    expect(captured.cellsUpdated).toHaveLength(0);
  });

  it("a second frame of writes gets its OWN bare event (one per frame, not one ever)", async () => {
    const w = FakeWorker.last!;
    expect((await w.call(1, "sheet.setCellValue", [0, 0, 1, "Sheet2"])).ok).toBe(true);
    await runFrames();
    expect((await w.call(2, "sheet.setCellValue", [0, 1, 2, "Sheet2"])).ok).toBe(true);
    await runFrames();
    expect(bareCount()).toBe(2);
    expect(tagged()).toEqual([
      [{ row: 0, col: 0, sheetIndex: 1, newValue: "1", formula: null }],
      [{ row: 0, col: 1, sheetIndex: 1, newValue: "2", formula: null }],
    ]);
  });

  it("table on another sheet, typed write (writeCellsOnSheet bulk path) is tagged", async () => {
    const result = await FakeWorker.last!.call(1, "api.objectSetState", [
      "table", "table-1", "table.setCellValue", [0, 0, 42.5],
    ]);
    expect(result.ok).toBe(true);
    expect(lib.updateCellOnSheets).toHaveBeenCalledWith([1], 6, 2, "42.5", true, false);
    expect(lib.recalculateSheetsAfterScriptWrite).toHaveBeenCalledWith([1]);
    await runFrames();
    expect(tagged()).toEqual([
      [{ row: 6, col: 2, sheetIndex: 1, newValue: "42.5", formula: null }],
    ]);
    expect(bareCount()).toBe(1);
    expect(captured.cellValuesChanged).toEqual([]);
  });

  it("table on another sheet, string write (writeCellOnSheet single path) is tagged", async () => {
    const result = await FakeWorker.last!.call(1, "api.objectSetState", [
      "table", "table-1", "table.setCellValue", [1, 1, "hello"],
    ]);
    expect(result.ok).toBe(true);
    expect(lib.updateCellOnSheets).toHaveBeenCalledWith([1], 7, 3, "hello");
    await runFrames();
    expect(tagged()).toEqual([
      [{ row: 7, col: 3, sheetIndex: 1, newValue: "hello", formula: null }],
    ]);
    expect(bareCount()).toBe(1);
    expect(captured.cellValuesChanged).toEqual([]);
  });

  it("a write the backend SKIPPED (target became active) is announced by the ACTIVE path, untagged", async () => {
    lib.updateCellOnSheets.mockResolvedValueOnce([]);
    const result = await FakeWorker.last!.call(1, "sheet.setCellValue", [3, 4, "v", "Sheet2"]);
    expect(result.ok).toBe(true);
    await runFrames();
    // No off-sheet debt: nothing landed off-sheet.
    expect(bareCount()).toBe(0);
    expect(tagged()).toEqual([
      [expect.objectContaining({ row: 3, col: 4, newValue: "v" })],
    ]);
    expect(tagged()[0][0].sheetIndex).toBeUndefined();
  });

  it("an ACTIVE-sheet write is unchanged: cellEvents path, untagged, no bare event", async () => {
    const result = await FakeWorker.last!.call(1, "sheet.setCellValue", [0, 0, "x"]);
    expect(result.ok).toBe(true);
    expect(lib.updateCell).toHaveBeenCalledWith(0, 0, "x");
    expect(lib.updateCellOnSheets).not.toHaveBeenCalled();
    await runFrames();
    expect(captured.cellValuesChanged).toHaveLength(1);
    expect(captured.cellValuesChanged[0]).toMatchObject({
      source: "script",
      changes: [{ row: 0, col: 0, newValue: "x" }],
    });
    expect(tagged()).toHaveLength(1);
    expect(tagged()[0][0].sheetIndex).toBeUndefined();
    expect(bareCount()).toBe(0);
    expect(grid.refreshGridData).toHaveBeenCalledTimes(1);
  });

  it("off-sheet clearRange: announced with ONE bare event, canvas NOT re-fetched", async () => {
    const clearLib = {
      getActiveSheet: vi.fn(async () => 0),
      getSheets: vi.fn(async () => ({
        sheets: [{ index: 0, name: "Sheet1" }, { index: 1, name: "Sheet2" }],
        activeIndex: 0,
      })),
      // The backend's off-sheet clear returns no cell list.
      clearRangeWithOptions: vi.fn(async () => ({ count: 4, updatedCells: [] })),
    };
    await host.executeClearRange(
      clearLib as never, definition.id, 0, 0, 1, 1, { applyTo: "contents" }, "Sheet2",
    );
    expect(clearLib.clearRangeWithOptions).toHaveBeenCalledWith(0, 0, 1, 1, "contents", 1);
    await runFrames();
    expect(bareCount()).toBe(1);
    expect(tagged()).toEqual([]);
    expect(captured.cellValuesChanged).toEqual([]);
    expect(grid.refreshGridData).not.toHaveBeenCalled();
  });

  it("a deferRepaint bracket holds the announcement until release, then pays it once", async () => {
    host.acquireDeferredRepaint(definition.id);
    expect((await FakeWorker.last!.call(1, "sheet.setCellValue", [0, 0, 1, "Sheet2"])).ok).toBe(true);
    expect((await FakeWorker.last!.call(2, "sheet.setCellValue", [0, 1, 2, "Sheet2"])).ok).toBe(true);
    await runFrames();
    expect(captured.cellsUpdated).toHaveLength(0);

    host.releaseDeferredRepaint(definition.id);
    await runFrames();
    expect(tagged()).toEqual([
      [
        { row: 0, col: 0, sheetIndex: 1, newValue: "1", formula: null },
        { row: 0, col: 1, sheetIndex: 1, newValue: "2", formula: null },
      ],
    ]);
    expect(bareCount()).toBe(1);
  });

  it("hostResetAll (workbook swap) drops an unpaid announcement for the outgoing document", async () => {
    host.acquireDeferredRepaint(definition.id);
    expect((await FakeWorker.last!.call(1, "sheet.setCellValue", [0, 0, 1, "Sheet2"])).ok).toBe(true);
    host.resetDeferredRepaint();
    await runFrames();
    expect(captured.cellsUpdated).toHaveLength(0);
  });
});
