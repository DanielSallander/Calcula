//! FILENAME: app/src/api/scriptHost/__tests__/tableTypedWrites.test.ts
// PURPOSE: The TABLE write executors must honour the typed-value contract the
//          generated typings promise for EVERY ScriptRange (Wave 1): a number
//          crosses as an INVARIANT write (parse_cell_input_invariant, never
//          delocalized), null CLEARS the cell, undefined is a hole, and an
//          object is refused loudly. Before this cover, table.setCellValue did
//          `String(value)` — so `range.setValue(null)` on a table wrote the
//          TEXT "null", and 42.5 was locale-parsed (sv-SE reads "42.5" as 425).
// CONTEXT: Same FakeWorker harness as hookEventDelivery.test.ts; the writes are
//          driven through api.objectSetState, the exact wire method the worker
//          table handle (contextShims objSet) uses.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type { H2W, W2H } from "../protocol";

const hoisted = vi.hoisted(() => ({
  table: {
    sheetIndex: 0,
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
  updateCell: vi.fn(async () => ({ cells: [] })),
  updateCellsBatch: vi.fn(async () => []),
  updateCellOnSheets: vi.fn(async () => undefined),
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

const globalScope = globalThis as unknown as Record<string, unknown>;
const originalWorker = globalScope.Worker;

type HostModule = typeof import("../host");
type LibModule = typeof import("../../lib");
let host: HostModule;
let lib: { [K in keyof LibModule]: ReturnType<typeof vi.fn> };

const definition = {
  id: "script-table-writer",
  name: "Table writer",
  objectType: "workbook",
  instanceId: null,
  source: "function setup(context) {}",
  accessLevel: "unlocked" as const,
  apiVersion: "1.0.0",
};

/** Drive one table aspect through the SAME wire method the worker handle uses. */
async function setState(worker: FakeWorker, callId: number, aspect: string, args: unknown[]) {
  return worker.call(callId, "api.objectSetState", ["table", "table-1", aspect, args]);
}

describe("table typed writes (own-write conversion parity)", () => {
  beforeEach(async () => {
    FakeWorker.last = null;
    hoisted.table.sheetIndex = 0;
    globalScope.Worker = FakeWorker as unknown as typeof Worker;
    vi.resetModules();
    host = await import("../host");
    lib = (await import("../../lib")) as unknown as typeof lib;
    for (const fn of Object.values(lib)) (fn as ReturnType<typeof vi.fn>).mockClear?.();
    await host.hostMountScript(definition);
  });

  afterEach(() => {
    host.hostResetAll();
    globalScope.Worker = originalWorker;
  });

  it("setCellValue(42.5) crosses as an INVARIANT batch write, not a locale string", async () => {
    const result = await setState(FakeWorker.last!, 1, "table.setCellValue", [0, 0, 42.5]);
    expect(result.ok).toBe(true);
    // Data row 0, col 0 of the table = grid (6, 2) — header row offset.
    expect(lib.updateCellsBatch).toHaveBeenCalledWith([
      { row: 6, col: 2, value: "42.5", invariant: true },
    ]);
    expect(lib.updateCell).not.toHaveBeenCalled();
  });

  it("setCellValue(null) CLEARS the cell (empty input), never writes the text \"null\"", async () => {
    const result = await setState(FakeWorker.last!, 1, "table.setCellValue", [1, 2, null]);
    expect(result.ok).toBe(true);
    // Strings/clears keep the single-cell command (grid row 7, col 4).
    expect(lib.updateCell).toHaveBeenCalledWith(7, 4, "");
    expect(lib.updateCellsBatch).not.toHaveBeenCalled();
  });

  it("setCellValue keeps plain strings on the single-cell command", async () => {
    const result = await setState(FakeWorker.last!, 1, "table.setCellValue", [0, 1, "=SUM(A1:A3)"]);
    expect(result.ok).toBe(true);
    expect(lib.updateCell).toHaveBeenCalledWith(6, 3, "=SUM(A1:A3)");
  });

  it("setCellValue refuses an object with a visible validation error", async () => {
    const result = await setState(FakeWorker.last!, 1, "table.setCellValue", [0, 0, { a: 1 }]);
    expect(result.ok).toBe(false);
    expect(result.error?.message).toContain("string, number, boolean or null");
    expect(lib.updateCell).not.toHaveBeenCalled();
    expect(lib.updateCellsBatch).not.toHaveBeenCalled();
  });

  it("setRangeValues: numbers invariant, null clears, undefined is a hole", async () => {
    const result = await setState(FakeWorker.last!, 1, "table.setRangeValues", [
      0, 0,
      [[1, "x"], [null, undefined]],
    ]);
    expect(result.ok).toBe(true);
    expect(lib.updateCellsBatch).toHaveBeenCalledTimes(1);
    const updates = lib.updateCellsBatch.mock.calls[0][0] as Array<Record<string, unknown>>;
    expect(updates).toEqual([
      { row: 6, col: 2, value: "1", invariant: true },
      { row: 6, col: 3, value: "x", invariant: undefined },
      // null = CLEAR (row 7, col 2) — it used to be silently skipped.
      { row: 7, col: 2, value: "", invariant: undefined },
      // NO entry for the undefined hole (row 7, col 3).
    ]);
  });

  it("a typed write to a table on a NON-active sheet carries the invariant flag", async () => {
    hoisted.table.sheetIndex = 1;
    const result = await setState(FakeWorker.last!, 1, "table.setCellValue", [0, 0, 42.5]);
    expect(result.ok).toBe(true);
    // Bulk off-sheet path: per-cell writes opt OUT of the per-cell recalc
    // (recalc: false) and ONE dependent recalculation follows for the block —
    // without it a formula reading the written cell stayed stale (found live).
    expect(lib.updateCellOnSheets).toHaveBeenCalledWith([1], 6, 2, "42.5", true, false);
    expect(lib.recalculateSheetsAfterScriptWrite).toHaveBeenCalledWith([1]);
    expect(lib.updateCellsBatch).not.toHaveBeenCalled();
  });

  it("sheet.setCellValue to another sheet carries the invariant flag too", async () => {
    const result = await FakeWorker.last!.call(1, "sheet.setCellValue", [0, 0, 42.5, "Sheet2"]);
    expect(result.ok).toBe(true);
    expect(lib.updateCellOnSheets).toHaveBeenCalledWith([1], 0, 0, "42.5", true);
  });

  // ==========================================================================
  // The ACTIVE-SHEET SKIP must never silently drop a write (found live)
  // ==========================================================================
  //
  // `update_cell_on_sheets` refuses to write the sheet that is ACTIVE — right
  // for sheet grouping (update_cell already wrote it), fatal for a script,
  // which has no such prior write. The host resolves "off-sheet" from a
  // get_sheets snapshot, so a sheet that BECOMES active before the command runs
  // (the user switching tabs, or the macro's own setActiveSheet) made the value
  // vanish with no error anywhere. The command now reports the sheets it wrote
  // and the host re-issues anything missing through the active-sheet path.

  it("re-issues an off-sheet write the backend SKIPPED (target became active)", async () => {
    // The backend answers "I wrote nothing" — the target is the active sheet now.
    lib.updateCellOnSheets.mockResolvedValueOnce([]);
    const result = await FakeWorker.last!.call(1, "sheet.setCellValue", [3, 4, 42.5, "Sheet2"]);
    expect(result.ok).toBe(true);
    expect(lib.updateCellOnSheets).toHaveBeenCalledWith([1], 3, 4, "42.5", true);
    // ...and the value was written anyway, through the active-sheet path,
    // still INVARIANT (a locale parse would read "42.5" as 425 under sv-SE).
    expect(lib.updateCellsBatch).toHaveBeenCalledWith([
      { row: 3, col: 4, value: "42.5", invariant: true },
    ]);
  });

  it("does NOT re-issue when the backend reports the sheet was written", async () => {
    lib.updateCellOnSheets.mockResolvedValueOnce([1]);
    const result = await FakeWorker.last!.call(1, "sheet.setCellValue", [3, 4, 42.5, "Sheet2"]);
    expect(result.ok).toBe(true);
    expect(lib.updateCellsBatch).not.toHaveBeenCalled();
    expect(lib.updateCell).not.toHaveBeenCalled();
  });

  it("api.setCellValue honours a sheet NAME in its 4th argument", async () => {
    // The flat VBA idiom. The worker shim used to drop this argument entirely,
    // so the value landed on whatever sheet happened to be active.
    const result = await FakeWorker.last!.call(1, "api.setCellValue", [2, 2, 7, "Sheet2"]);
    expect(result.ok).toBe(true);
    expect(lib.updateCellOnSheets).toHaveBeenCalledWith([1], 2, 2, "7", true);
  });
});
