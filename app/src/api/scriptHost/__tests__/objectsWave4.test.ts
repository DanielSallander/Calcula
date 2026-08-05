//! FILENAME: app/src/api/scriptHost/__tests__/objectsWave4.test.ts
// PURPOSE: Wave 4 OBJECTS cluster — table STRUCTURE aspects (the ListObject
//          management family), namedRange.update (definition edit + one-undo
//          rename with script re-key), chart.setGeometry + spec sugar, and the
//          notes/comments API rows.
// COVERS:  (1) the validator gates behind BOTH setState doors (vSetState and
//              vObjectAspect land on the same checkers);
//          (2) the HOST executors over the FakeWorker wire (the exact
//              api.objectSetState / api.* methods the worker shims send):
//              each table aspect dispatches the RIGHT backend command, the
//              active-sheet rule refuses with the fix spelled out, a rename
//              is ONE undo transaction and re-keys attached local scripts
//              (distributed = refused), chart geometry goes to the chart
//              store's PLACEMENT path (never through the spec), and notes
//              round-trip add -> update -> remove;
//          (3) the WORKER shims: handle + own-context dispatch tuples, the
//              chart sugars riding chart.updateSpec (the extension's schema
//              validator stays the single gate), and the namedRange handle
//              re-keying itself after a rename;
//          (4) the generated typings declare the new surface.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "fs";
import * as path from "path";
import type { H2W, W2H, MountSpec } from "../protocol";
import { ALLOWLIST } from "../allowlist";
import {
  vSetState,
  vObjectAspect,
  vSetNote,
  vAddComment,
  vListComments,
  checkTableStructureAspect,
  checkChartGeometryAspect,
  checkNamedRangeUpdate,
  TABLE_STRUCTURE_ASPECTS,
  TABLE_TOTALS_FUNCTIONS,
  MAX_NOTE_TEXT,
} from "../validators";
import { buildWorkerContext, type WorkerRuntime } from "../worker/contextShims";

const hoisted = vi.hoisted(() => ({
  table: {
    id: "table-1",
    name: "Sales",
    sheetIndex: 0,
    startRow: 5,
    startCol: 2,
    endRow: 8,
    endCol: 4,
    styleOptions: {
      bandedRows: true, bandedColumns: false, headerRow: true, totalRow: false,
      firstColumn: false, lastColumn: false, showFilterButton: true,
    },
    styleName: "TableStyleMedium2",
    columns: [
      { id: "c1", name: "Region", totalsRowFunction: "none" },
      { id: "c2", name: "Units", totalsRowFunction: "sum" },
      { id: "c3", name: "Price", totalsRowFunction: "custom", totalsRowFormula: "=MAX(1,2)" },
    ],
  },
  namedRange: {
    name: "MyName",
    sheetIndex: null as number | null,
    refersTo: "=Sheet1!$A$1:$B$2",
    comment: "the comment",
    folder: undefined as string | undefined,
  },
  notes: new Map<string, { id: string; row: number; col: number; content: string; authorName: string }>(),
  objectScripts: [] as Array<{
    id: string; name: string; objectType: string; instanceId: string | null;
    accessLevel: string; provenance?: string | null;
  }>,
}));

const ok = { success: true };

vi.mock("../../backend", () => ({
  invokeBackend: vi.fn().mockResolvedValue(null),
  getWorkbookProperties: vi.fn().mockRejectedValue(new Error("no backend in test")),
  emitTauriEvent: vi.fn().mockResolvedValue(undefined),
  listenTauriEvent: vi.fn().mockResolvedValue(() => undefined),
  readVirtualFile: vi.fn().mockResolvedValue(null),
  writeVirtualFile: vi.fn().mockResolvedValue(undefined),
  renameTable: vi.fn(async () => ok),
  resizeTable: vi.fn(async () => ok),
  addTableColumn: vi.fn(async () => ok),
  removeTableColumn: vi.fn(async () => ok),
  renameTableColumn: vi.fn(async () => ok),
  toggleTotalsRow: vi.fn(async () => ok),
  setTotalsRowFunction: vi.fn(async () => ok),
  updateTableStyle: vi.fn(async () => ok),
  convertToRange: vi.fn(async () => ok),
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
vi.mock("../../objectScriptBackend", () => ({
  listObjectScripts: vi.fn(async () => hoisted.objectScripts),
  getObjectScript: vi.fn(async (id: string) => ({
    id, name: "attached", objectType: "namedRange", instanceId: "MyName",
    source: "function setup() {}", accessLevel: "restricted", description: null,
  })),
  saveObjectScript: vi.fn(async () => undefined),
  deleteObjectScript: vi.fn(async () => undefined),
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
  updateCellOnSheets: vi.fn(async () => [1]),
  recalculateSheetsAfterScriptWrite: vi.fn(async () => undefined),
  getUndoState: vi.fn(async () => ({ transactionOpen: false })),
  beginUndoTransaction: vi.fn(async () => undefined),
  commitUndoTransaction: vi.fn(async () => undefined),
  cancelUndoTransaction: vi.fn(async () => undefined),
  addTableRow: vi.fn(async () => undefined),
  insertRows: vi.fn(async () => []),
  deleteRows: vi.fn(async () => []),
  // Named ranges
  getNamedRange: vi.fn(async () => hoisted.namedRange),
  updateNamedRange: vi.fn(async () => ({ success: true })),
  deleteNamedRange: vi.fn(async () => ({ success: true })),
  createNamedRange: vi.fn(async () => ({ success: true })),
  // Notes
  getNote: vi.fn(async (row: number, col: number) => hoisted.notes.get(`${row}:${col}`) ?? null),
  addNote: vi.fn(async (params: { row: number; col: number; content: string; authorName: string }) => {
    const note = { id: `note-${params.row}-${params.col}`, ...params };
    hoisted.notes.set(`${params.row}:${params.col}`, note);
    return { success: true, note };
  }),
  updateNote: vi.fn(async (params: { noteId: string; content: string }) => {
    const note = [...hoisted.notes.values()].find((n) => n.id === params.noteId)!;
    note.content = params.content;
    return { success: true, note };
  }),
  deleteNote: vi.fn(async (noteId: string) => {
    for (const [k, n] of hoisted.notes) if (n.id === noteId) hoisted.notes.delete(k);
    return { success: true, note: null };
  }),
  getAllNotes: vi.fn(async () => [...hoisted.notes.values()]),
  // Comments
  addComment: vi.fn(async (params: Record<string, unknown>) => ({
    success: true,
    comment: { id: "comment-1", ...params, resolved: false, replies: [] },
  })),
  addReply: vi.fn(async () => ({ success: true, reply: { id: "reply-1" }, comment: null })),
  resolveComment: vi.fn(async () => ({ success: true, comment: null })),
  deleteComment: vi.fn(async () => ({ success: true, comment: null })),
  getAllComments: vi.fn(async () => [
    { id: "a", row: 1, col: 1, content: "in", authorName: "P", resolved: false,
      replies: [{ id: "r", content: "re", authorName: "Q" }] },
    { id: "b", row: 9, col: 9, content: "out", authorName: "P", resolved: true, replies: [] },
  ]),
  getCommentsForSheet: vi.fn(async () => [
    { id: "c", row: 0, col: 0, content: "other-sheet", authorName: "P", resolved: false, replies: [] },
  ]),
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

  async call(callId: number, method: string, args: unknown[]): Promise<{ ok: boolean; value?: unknown; error?: { message?: string } }> {
    this.emit({ t: "call", callId, method, args } as W2H);
    for (let i = 0; i < 200; i++) {
      const result = this.received.find(
        (m): m is Extract<H2W, { t: "callResult" }> => m.t === "callResult" && m.callId === callId,
      );
      if (result) return result as { ok: boolean; value?: unknown; error?: { message?: string } };
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    throw new Error(`callResult for ${method} (id ${callId}) never arrived`);
  }
}

const globalScope = globalThis as unknown as Record<string, unknown>;
const originalWorker = globalScope.Worker;

type HostModule = typeof import("../host");
type LibModule = typeof import("../../lib");
type BackendModule = typeof import("../../backend");
type ScriptBackendModule = typeof import("../../objectScriptBackend");
let host: HostModule;
let lib: { [K in keyof LibModule]: ReturnType<typeof vi.fn> };
let backend: { [K in keyof BackendModule]: ReturnType<typeof vi.fn> };
let scriptBackend: { [K in keyof ScriptBackendModule]: ReturnType<typeof vi.fn> };
let chartStore: {
  updateChartPlacement: ReturnType<typeof vi.fn>;
  updateChartSpec: ReturnType<typeof vi.fn>;
};

const definition = {
  id: "script-wave4-objects",
  name: "Wave4 objects",
  objectType: "workbook",
  instanceId: null,
  source: "function setup(context) {}",
  accessLevel: "unlocked" as const,
  apiVersion: "1.0.0",
};

let nextCallId = 1;
async function wire(method: string, args: unknown[]) {
  return FakeWorker.last!.call(nextCallId++, method, args);
}
async function setAspect(objectType: string, id: string, aspect: string, args: unknown[]) {
  return wire("api.objectSetState", [objectType, id, aspect, args]);
}
async function getAspect(objectType: string, id: string, aspect: string, args: unknown[]) {
  return wire("api.objectGetState", [objectType, id, aspect, args]);
}

// ============================================================================
// (1) validators: one gate, both doors
// ============================================================================

describe("TABLE_STRUCTURE_ASPECTS", () => {
  it("is exactly the eleven management aspects, with NO allowlist rows", () => {
    expect([...TABLE_STRUCTURE_ASPECTS].sort()).toEqual([
      "table.addColumn", "table.convertToRange", "table.deleteRow",
      "table.insertRow", "table.removeColumn", "table.rename",
      "table.renameColumn", "table.resize", "table.setStyle",
      "table.setTotalsFunction", "table.setTotalsRow",
    ]);
    for (const aspect of TABLE_STRUCTURE_ASPECTS) {
      expect(ALLOWLIST[aspect], aspect).toBeUndefined();
    }
  });
});

describe("checkTableStructureAspect", () => {
  it("rename needs a non-empty name", () => {
    expect(checkTableStructureAspect("table.rename", ["Better"])).toBe(true);
    expect(checkTableStructureAspect("table.rename", ["  "])).toContain("newName");
    expect(checkTableStructureAspect("table.rename", [])).toContain("newName");
  });

  it("resize gets the range-rectangle gate", () => {
    expect(checkTableStructureAspect("table.resize", [0, 0, 5, 3])).toBe(true);
    expect(checkTableStructureAspect("table.resize", [5, 0, 2, 3])).toContain(">= startRow");
    expect(checkTableStructureAspect("table.resize", [0, 0])).not.toBe(true);
  });

  it("addColumn takes an optional integer position", () => {
    expect(checkTableStructureAspect("table.addColumn", ["Qty"])).toBe(true);
    expect(checkTableStructureAspect("table.addColumn", ["Qty", 2])).toBe(true);
    expect(checkTableStructureAspect("table.addColumn", ["Qty", -1])).toContain("position");
    expect(checkTableStructureAspect("table.addColumn", ["Qty", 1.5])).toContain("position");
    expect(checkTableStructureAspect("table.addColumn", [""])).toContain("name");
  });

  it("setTotalsFunction enumerates the backend's vocabulary and gates the custom formula", () => {
    expect([...TABLE_TOTALS_FUNCTIONS]).toContain("countNumbers");
    expect(checkTableStructureAspect("table.setTotalsFunction", ["Units", "sum"])).toBe(true);
    expect(checkTableStructureAspect("table.setTotalsFunction", ["Units", "total"]))
      .toContain("none, average, count");
    // "custom" REQUIRES a formula; any other function refuses one.
    expect(checkTableStructureAspect("table.setTotalsFunction", ["Units", "custom"]))
      .toContain("formula");
    expect(checkTableStructureAspect("table.setTotalsFunction", ["Units", "custom", "=SUM(1)"])).toBe(true);
    expect(checkTableStructureAspect("table.setTotalsFunction", ["Units", "sum", "=SUM(1)"]))
      .toContain("only accepted");
  });

  it("setStyle takes a name, or a patch of the 7 enumerated flags", () => {
    expect(checkTableStructureAspect("table.setStyle", ["TableStyleDark1"])).toBe(true);
    expect(checkTableStructureAspect("table.setStyle", [{ styleOptions: { bandedRows: false } }])).toBe(true);
    expect(checkTableStructureAspect("table.setStyle", [{ styleOptions: { banded: true } }]))
      .toContain("unknown styleOptions key");
    expect(checkTableStructureAspect("table.setStyle", [{ styleOptions: { bandedRows: "yes" } }]))
      .toContain("boolean");
    expect(checkTableStructureAspect("table.setStyle", [{}])).toContain("styleName and/or styleOptions");
    expect(checkTableStructureAspect("table.setStyle", [{ color: "red" }])).toContain("unknown style key");
  });

  it("insertRow position is optional; deleteRow position is required", () => {
    expect(checkTableStructureAspect("table.insertRow", [])).toBe(true);
    expect(checkTableStructureAspect("table.insertRow", [3])).toBe(true);
    expect(checkTableStructureAspect("table.insertRow", [-1])).toContain("position");
    expect(checkTableStructureAspect("table.deleteRow", [0])).toBe(true);
    expect(checkTableStructureAspect("table.deleteRow", [])).toContain("position");
  });

  it("convertToRange takes no arguments", () => {
    expect(checkTableStructureAspect("table.convertToRange", [])).toBe(true);
    expect(checkTableStructureAspect("table.convertToRange", ["x"])).toContain("no arguments");
  });

  it("BOTH doors land on this gate", () => {
    const bad = ["Units", "total"];
    expect(vSetState(["table.setTotalsFunction", bad])).toContain("none, average");
    expect(vObjectAspect(["table", "table-1", "table.setTotalsFunction", bad])).toContain("none, average");
    expect(vSetState(["table.setTotalsFunction", ["Units", "sum"]])).toBe(true);
  });
});

describe("checkNamedRangeUpdate", () => {
  it("requires at least one known key", () => {
    expect(checkNamedRangeUpdate([{}])).toContain("at least one");
    expect(checkNamedRangeUpdate([{ nickname: "x" }])).toContain("unknown named-range update key");
    expect(checkNamedRangeUpdate(["MyName"])).toContain("update object");
    expect(checkNamedRangeUpdate([{ refersTo: "=Sheet1!$A$1" }])).toBe(true);
  });

  it("newName gets the SAME spelling rule createNamedRange enforces", () => {
    expect(checkNamedRangeUpdate([{ newName: "Good_Name.2" }])).toBe(true);
    expect(checkNamedRangeUpdate([{ newName: "has space" }])).toContain("newName");
    expect(checkNamedRangeUpdate([{ newName: "1starts" }])).toContain("letter or underscore");
  });

  it("sheetIndex is tri-state: a sheet ref, or null = workbook scope", () => {
    expect(checkNamedRangeUpdate([{ sheetIndex: 1 }])).toBe(true);
    expect(checkNamedRangeUpdate([{ sheetIndex: "Sheet2" }])).toBe(true);
    expect(checkNamedRangeUpdate([{ sheetIndex: null }])).toBe(true);
    expect(checkNamedRangeUpdate([{ sheetIndex: true }])).toContain("workbook scope");
  });
});

describe("checkChartGeometryAspect", () => {
  it("needs a patch with at least one placement key", () => {
    expect(checkChartGeometryAspect([{}])).toContain("at least one");
    expect(checkChartGeometryAspect([])).toContain("geometry patch");
    expect(checkChartGeometryAspect([{ rotation: 45 }])).toContain("unknown geometry property");
  });

  it("shares vCreateChart's bounds exactly (one decision, two doors)", () => {
    expect(checkChartGeometryAspect([{ x: 40, y: 20, width: 480, height: 320 }])).toBe(true);
    expect(checkChartGeometryAspect([{ width: 5 }])).toContain("between 10 and 20000");
    expect(checkChartGeometryAspect([{ x: 2_000_000 }])).toContain("between -1000000 and 1000000");
    expect(checkChartGeometryAspect([{ sheetIndex: "Sheet2", name: "Q4" }])).toBe(true);
  });
});

describe("notes/comments validators", () => {
  it("setNote: text is a bounded string or null-to-remove", () => {
    expect(vSetNote([0, 0, "hello"])).toBe(true);
    expect(vSetNote([0, 0, null])).toBe(true);
    expect(vSetNote([0, 0, ""])).toContain("null to remove");
    expect(vSetNote([0, 0, "x".repeat(MAX_NOTE_TEXT + 1)])).toContain(`${MAX_NOTE_TEXT}`);
    expect(vSetNote([-1, 0, "x"])).toContain("row");
    expect(vSetNote([0, 0, "x", "Sheet2"])).toBe(true);
  });

  it("addComment needs coordinates and non-empty text", () => {
    expect(vAddComment([1, 2, "hi"])).toBe(true);
    expect(vAddComment([1, 2, ""])).toContain("non-empty");
  });

  it("listComments range is a filter (ordering checked, NO cell ceiling)", () => {
    expect(vListComments([])).toBe(true);
    expect(vListComments([null, "Sheet2"])).toBe(true);
    expect(vListComments([{ startRow: 0, startCol: 0, endRow: 1_000_000, endCol: 0 }])).toBe(true);
    expect(vListComments([{ startRow: 5, startCol: 0, endRow: 1, endCol: 0 }])).toContain(">=");
    expect(vListComments(["A1:B2"])).toContain("object");
  });
});

// ============================================================================
// (2) host executors over the wire
// ============================================================================

describe("Wave 4 host executors", () => {
  beforeEach(async () => {
    FakeWorker.last = null;
    nextCallId = 1;
    hoisted.table.sheetIndex = 0;
    hoisted.namedRange.name = "MyName";
    hoisted.namedRange.sheetIndex = null;
    hoisted.namedRange.refersTo = "=Sheet1!$A$1:$B$2";
    hoisted.namedRange.comment = "the comment";
    hoisted.notes.clear();
    hoisted.objectScripts = [];
    globalScope.Worker = FakeWorker as unknown as typeof Worker;
    vi.resetModules();
    host = await import("../host");
    lib = (await import("../../lib")) as unknown as typeof lib;
    backend = (await import("../../backend")) as unknown as typeof backend;
    scriptBackend = (await import("../../objectScriptBackend")) as unknown as typeof scriptBackend;
    for (const fn of Object.values(lib)) (fn as ReturnType<typeof vi.fn>).mockClear?.();
    for (const fn of Object.values(backend)) (fn as ReturnType<typeof vi.fn>).mockClear?.();
    for (const fn of Object.values(scriptBackend)) (fn as ReturnType<typeof vi.fn>).mockClear?.();
    // The chart store the Charts extension would register (fresh registry
    // after resetModules — host resolves it through the same module).
    const registry = await import("../../componentStoreRegistry");
    chartStore = {
      updateChartPlacement: vi.fn(),
      updateChartSpec: vi.fn(),
    };
    registry.registerChartStoreService({
      getChartById: (id: string) => (id === "chart-1" ? { specJson: "{}" } : null),
      listCharts: () => [],
      createChart: () => "chart-1",
      deleteChart: () => true,
      updateChartSpec: chartStore.updateChartSpec,
      replaceChartSpec: vi.fn(),
      setStyleProperty: vi.fn(),
      updateChartPlacement: chartStore.updateChartPlacement,
    });
    await host.hostMountScript(definition);
  });

  afterEach(() => {
    host.hostResetAll();
    globalScope.Worker = originalWorker;
  });

  // ---- table structure ----

  it("dispatches each table aspect to the RIGHT backend command", async () => {
    expect((await setAspect("table", "table-1", "table.rename", ["Better"])).ok).toBe(true);
    expect(backend.renameTable).toHaveBeenCalledWith("table-1", "Better");

    expect((await setAspect("table", "table-1", "table.resize", [5, 2, 12, 6])).ok).toBe(true);
    expect(backend.resizeTable).toHaveBeenCalledWith({
      tableId: "table-1", startRow: 5, startCol: 2, endRow: 12, endCol: 6,
    });

    expect((await setAspect("table", "table-1", "table.addColumn", ["Qty", 1])).ok).toBe(true);
    expect(backend.addTableColumn).toHaveBeenCalledWith("table-1", "Qty", 1);

    expect((await setAspect("table", "table-1", "table.removeColumn", ["Price"])).ok).toBe(true);
    expect(backend.removeTableColumn).toHaveBeenCalledWith("table-1", "Price");

    expect((await setAspect("table", "table-1", "table.renameColumn", ["Units", "Quantity"])).ok).toBe(true);
    expect(backend.renameTableColumn).toHaveBeenCalledWith("table-1", "Units", "Quantity");

    expect((await setAspect("table", "table-1", "table.setTotalsRow", [true])).ok).toBe(true);
    expect(backend.toggleTotalsRow).toHaveBeenCalledWith("table-1", true);

    expect((await setAspect("table", "table-1", "table.setTotalsFunction", ["Units", "average"])).ok).toBe(true);
    expect(backend.setTotalsRowFunction).toHaveBeenCalledWith({
      tableId: "table-1", columnName: "Units", function: "average", customFormula: undefined,
    });

    expect((await setAspect("table", "table-1", "table.convertToRange", [])).ok).toBe(true);
    expect(backend.convertToRange).toHaveBeenCalledWith("table-1");
  });

  it("setStyle merges a partial flag patch over the STORED options", async () => {
    const result = await setAspect("table", "table-1", "table.setStyle", [
      { styleOptions: { bandedRows: false } },
    ]);
    expect(result.ok).toBe(true);
    expect(backend.updateTableStyle).toHaveBeenCalledWith({
      tableId: "table-1",
      styleName: undefined,
      // bandedRows flipped; the other six flags KEPT from the stored table.
      styleOptions: { ...hoisted.table.styleOptions, bandedRows: false },
    });
    // A plain string sets the style name and leaves the options alone.
    await setAspect("table", "table-1", "table.setStyle", ["TableStyleDark1"]);
    expect(backend.updateTableStyle).toHaveBeenLastCalledWith({
      tableId: "table-1", styleName: "TableStyleDark1", styleOptions: undefined,
    });
  });

  it("insertRow: omitted position APPENDS; a position is a REAL sheet-row insert", async () => {
    expect((await setAspect("table", "table-1", "table.insertRow", [])).ok).toBe(true);
    expect(lib.addTableRow).toHaveBeenCalledWith("table-1");
    expect(lib.insertRows).not.toHaveBeenCalled();
    // Data row 1 of a header-row table anchored at startRow 5 = grid row 7.
    expect((await setAspect("table", "table-1", "table.insertRow", [1])).ok).toBe(true);
    expect(lib.insertRows).toHaveBeenCalledWith(7, 1, 0);
  });

  it("deleteRow deletes the grid row and refuses an out-of-range position with the count", async () => {
    expect((await setAspect("table", "table-1", "table.deleteRow", [2])).ok).toBe(true);
    expect(lib.deleteRows).toHaveBeenCalledWith(8, 1, 0);
    const result = await setAspect("table", "table-1", "table.deleteRow", [3]);
    expect(result.ok).toBe(false);
    expect(result.error?.message).toContain("3 data row(s)");
    expect(lib.deleteRows).toHaveBeenCalledTimes(1);
  });

  it("refuses the whole family when the table's sheet is NOT active, naming the fix", async () => {
    hoisted.table.sheetIndex = 1;
    const result = await setAspect("table", "table-1", "table.rename", ["Better"]);
    expect(result.ok).toBe(false);
    expect(result.error?.message).toContain("setActiveSheet");
    expect(backend.renameTable).not.toHaveBeenCalled();
  });

  it("getColumns / getStyle / getTotals read the stored definition (the read twins)", async () => {
    const cols = await getAspect("table", "table-1", "table.getColumns", []);
    expect(cols.value).toEqual([
      { name: "Region", totalsFunction: "none" },
      { name: "Units", totalsFunction: "sum" },
      { name: "Price", totalsFunction: "custom", totalsFormula: "=MAX(1,2)" },
    ]);
    const style = await getAspect("table", "table-1", "table.getStyle", []);
    expect(style.value).toEqual({
      styleName: "TableStyleMedium2",
      styleOptions: hoisted.table.styleOptions,
    });
    const totals = await getAspect("table", "table-1", "table.getTotals", []);
    expect(totals.value).toEqual({
      shown: false,
      columns: [
        { name: "Region", function: "none" },
        { name: "Units", function: "sum" },
        { name: "Price", function: "custom", formula: "=MAX(1,2)" },
      ],
    });
  });

  // ---- namedRange.update ----

  it("a non-rename update merges over the stored definition (absent = keep)", async () => {
    const result = await setAspect("namedRange", "MyName", "namedRange.update", [
      { refersTo: "=Sheet1!$C$1" },
    ]);
    expect(result.ok).toBe(true);
    expect(result.value).toEqual({ name: "MyName" });
    expect(lib.updateNamedRange).toHaveBeenCalledWith(
      "MyName", null, "=Sheet1!$C$1", "the comment", undefined,
    );
    expect(lib.deleteNamedRange).not.toHaveBeenCalled();
  });

  it("sheetIndex: null clears to workbook scope; a NAME resolves to its index", async () => {
    hoisted.namedRange.sheetIndex = 1;
    await setAspect("namedRange", "MyName", "namedRange.update", [{ sheetIndex: null }]);
    expect(lib.updateNamedRange).toHaveBeenCalledWith(
      "MyName", null, "=Sheet1!$A$1:$B$2", "the comment", undefined,
    );
    await setAspect("namedRange", "MyName", "namedRange.update", [{ sheetIndex: "Sheet2" }]);
    expect(lib.updateNamedRange).toHaveBeenLastCalledWith(
      "MyName", 1, "=Sheet1!$A$1:$B$2", "the comment", undefined,
    );
  });

  it("a RENAME is delete+create inside ONE undo transaction and returns the new name", async () => {
    const result = await setAspect("namedRange", "MyName", "namedRange.update", [
      { newName: "Better", refersTo: "=Sheet1!$D$1" },
    ]);
    expect(result.ok).toBe(true);
    expect(result.value).toEqual({ name: "Better" });
    expect(lib.beginUndoTransaction).toHaveBeenCalledTimes(1);
    expect(lib.deleteNamedRange).toHaveBeenCalledWith("MyName");
    expect(lib.createNamedRange).toHaveBeenCalledWith(
      "Better", null, "=Sheet1!$D$1", "the comment", undefined,
    );
    expect(lib.commitUndoTransaction).toHaveBeenCalledTimes(1);
    expect(lib.cancelUndoTransaction).not.toHaveBeenCalled();
    expect(lib.updateNamedRange).not.toHaveBeenCalled();
  });

  it("a rename RE-KEYS attached local scripts at the new name", async () => {
    hoisted.objectScripts = [{
      id: "s-local", name: "attached", objectType: "namedRange",
      instanceId: "MyName", accessLevel: "restricted", provenance: "local",
    }];
    const result = await setAspect("namedRange", "MyName", "namedRange.update", [{ newName: "Better" }]);
    expect(result.ok).toBe(true);
    expect(scriptBackend.saveObjectScript).toHaveBeenCalledTimes(1);
    expect(scriptBackend.saveObjectScript.mock.calls[0][0]).toMatchObject({
      id: "s-local",
      instanceId: "Better",
    });
  });

  it("a rename is REFUSED while a distributed script is attached (no provenance laundering)", async () => {
    hoisted.objectScripts = [{
      id: "s-dist", name: "attached", objectType: "namedRange",
      instanceId: "MyName", accessLevel: "restricted", provenance: "distributed",
    }];
    const result = await setAspect("namedRange", "MyName", "namedRange.update", [{ newName: "Better" }]);
    expect(result.ok).toBe(false);
    expect(result.error?.message).toContain("distributed script");
    expect(lib.deleteNamedRange).not.toHaveBeenCalled();
    expect(scriptBackend.saveObjectScript).not.toHaveBeenCalled();
  });

  it("a failed create puts the original name back (no silent delete)", async () => {
    lib.createNamedRange.mockResolvedValueOnce({ success: false, error: "collides with a table" });
    const result = await setAspect("namedRange", "MyName", "namedRange.update", [{ newName: "Sales" }]);
    expect(result.ok).toBe(false);
    expect(result.error?.message).toContain("collides");
    // The compensating re-create of the ORIGINAL definition.
    expect(lib.createNamedRange).toHaveBeenLastCalledWith(
      "MyName", null, "=Sheet1!$A$1:$B$2", "the comment", undefined,
    );
    expect(lib.cancelUndoTransaction).toHaveBeenCalledTimes(1);
    expect(lib.commitUndoTransaction).not.toHaveBeenCalled();
  });

  // ---- chart.setGeometry ----

  it("chart.setGeometry goes to the chart store's PLACEMENT path, never the spec", async () => {
    const result = await setAspect("chart", "chart-1", "chart.setGeometry", [
      { x: 40, y: 20, width: 480, sheetIndex: "Sheet2" },
    ]);
    expect(result.ok).toBe(true);
    // The named sheet resolved to its index before reaching the store.
    expect(chartStore.updateChartPlacement).toHaveBeenCalledWith("chart-1", {
      x: 40, y: 20, width: 480, sheetIndex: 1,
    });
    expect(chartStore.updateChartSpec).not.toHaveBeenCalled();
  });

  it("chart.updateSpec (the sugar's aspect) still rides the extension's validator path", async () => {
    const result = await setAspect("chart", "chart-1", "chart.updateSpec", [{ title: "Q4" }]);
    expect(result.ok).toBe(true);
    expect(chartStore.updateChartSpec).toHaveBeenCalledWith("chart-1", { title: "Q4" });
    expect(chartStore.updateChartPlacement).not.toHaveBeenCalled();
  });

  // ---- notes + comments ----

  it("setNote round-trips: add, read, update in place, remove", async () => {
    const added = await wire("api.setNote", [3, 1, "first"]);
    expect(added.ok).toBe(true);
    expect(added.value).toEqual({ id: "note-3-1" });
    expect(lib.addNote).toHaveBeenCalledWith({
      row: 3, col: 1, authorName: "Wave4 objects", content: "first",
    });

    expect((await wire("api.getNote", [3, 1])).value).toBe("first");

    // Second write UPDATES the existing note (id kept — size/position survive).
    const updated = await wire("api.setNote", [3, 1, "second"]);
    expect(updated.value).toEqual({ id: "note-3-1" });
    expect(lib.updateNote).toHaveBeenCalledWith({ noteId: "note-3-1", content: "second" });
    expect(lib.addNote).toHaveBeenCalledTimes(1);

    // null removes; removing again is a no-op resolving null (not an error).
    expect((await wire("api.setNote", [3, 1, null])).value).toBeNull();
    expect(lib.deleteNote).toHaveBeenCalledWith("note-3-1");
    expect((await wire("api.setNote", [3, 1, null])).ok).toBe(true);
    expect(lib.deleteNote).toHaveBeenCalledTimes(1);
    expect((await wire("api.getNote", [3, 1])).value).toBeNull();
  });

  it("notes refuse a NON-active sheet with the fix spelled out", async () => {
    for (const [method, args] of [
      ["api.setNote", [0, 0, "x", "Sheet2"]],
      ["api.getNote", [0, 0, 1]],
      ["api.listNotes", ["Sheet2"]],
    ] as Array<[string, unknown[]]>) {
      const result = await wire(method, args);
      expect(result.ok, method).toBe(false);
      expect(result.error?.message, method).toContain("setActiveSheet");
    }
    expect(lib.addNote).not.toHaveBeenCalled();
  });

  it("listNotes thins to row/col/text/author", async () => {
    await wire("api.setNote", [2, 2, "hello"]);
    const result = await wire("api.listNotes", []);
    expect(result.value).toEqual([
      { row: 2, col: 2, text: "hello", author: "Wave4 objects" },
    ]);
  });

  it("comments: add is signed with the SCRIPT's name; reply/resolve/delete address the id", async () => {
    const added = await wire("api.addComment", [1, 1, "look here"]);
    expect(added.value).toEqual({ id: "comment-1" });
    expect(lib.addComment).toHaveBeenCalledWith({
      row: 1, col: 1, authorEmail: "", authorName: "Wave4 objects", content: "look here",
    });

    const reply = await wire("api.replyToComment", ["comment-1", "agreed"]);
    expect(reply.value).toEqual({ id: "reply-1" });
    expect(lib.addReply).toHaveBeenCalledWith({
      commentId: "comment-1", authorEmail: "", authorName: "Wave4 objects", content: "agreed",
    });

    expect((await wire("api.resolveComment", ["comment-1"])).ok).toBe(true);
    expect(lib.resolveComment).toHaveBeenCalledWith("comment-1", true);
    expect((await wire("api.resolveComment", ["comment-1", false])).ok).toBe(true);
    expect(lib.resolveComment).toHaveBeenLastCalledWith("comment-1", false);

    expect((await wire("api.deleteComment", ["comment-1"])).ok).toBe(true);
    expect(lib.deleteComment).toHaveBeenCalledWith("comment-1");
  });

  it("listComments filters by rectangle and honors a sheet ref (per-sheet backend read)", async () => {
    const all = await wire("api.listComments", []);
    expect((all.value as unknown[]).length).toBe(2);
    const boxed = await wire("api.listComments", [{ startRow: 0, startCol: 0, endRow: 5, endCol: 5 }]);
    expect(boxed.value).toEqual([{
      id: "a", row: 1, col: 1, text: "in", author: "P", resolved: false,
      replies: [{ id: "r", text: "re", author: "Q" }],
    }]);
    const other = await wire("api.listComments", [null, "Sheet2"]);
    expect(lib.getCommentsForSheet).toHaveBeenCalledWith(1);
    expect((other.value as Array<{ text: string }>)[0].text).toBe("other-sheet");
  });
});

// ============================================================================
// (3) worker shims
// ============================================================================

interface PostedCall {
  callId: number;
  method: string;
  args: unknown[];
}

function makeContext(objectType: string, instanceId: string | null): {
  context: Record<string, unknown>;
  rt: WorkerRuntime;
  calls: PostedCall[];
  resolveCall: (callId: number, value: unknown) => void;
  drain: () => void;
} {
  const calls: PostedCall[] = [];
  const spec = {
    protocolVersion: 1,
    scriptId: "wave4-objects-test",
    objectType,
    instanceId,
    tier: "unlocked",
    capabilities: [],
    apiVersion: "1.0.0",
    scriptName: "Wave4Objects",
    packageInfo: null,
    snapshot: {},
    source: "",
  } as unknown as MountSpec;
  const { context, rt } = buildWorkerContext(spec, (msg: W2H) => {
    if (msg.t === "call") calls.push({ callId: msg.callId, method: msg.method, args: msg.args });
  });
  const resolveCall = (callId: number, value: unknown): void => {
    const entry = rt.pending.get(callId);
    if (!entry) throw new Error(`no pending call ${callId}`);
    clearTimeout(entry.timer);
    rt.pending.delete(callId);
    entry.resolve(value);
  };
  const drain = (): void => {
    for (const entry of rt.pending.values()) clearTimeout(entry.timer);
    rt.pending.clear();
  };
  return { context, rt, calls, resolveCall, drain };
}

describe("worker shim: api.table(id) structure methods", () => {
  it("each dispatches api.objectSetState/GetState with the aspect + args", () => {
    const { context, calls, drain } = makeContext("sheet", null);
    const api = context.api as Record<string, unknown>;
    const t = (api.table as (id: string) => Record<string, unknown>)("t9");
    void (t.rename as (...a: unknown[]) => unknown)("Better");
    void (t.resize as (...a: unknown[]) => unknown)(0, 0, 9, 3);
    void (t.addColumn as (...a: unknown[]) => unknown)("Qty", 2);
    void (t.removeColumn as (...a: unknown[]) => unknown)("Qty");
    void (t.renameColumn as (...a: unknown[]) => unknown)("A", "B");
    void (t.setTotalsRow as (...a: unknown[]) => unknown)(true);
    void (t.setTotalsFunction as (...a: unknown[]) => unknown)("Units", "sum");
    void (t.setStyle as (...a: unknown[]) => unknown)("TableStyleDark1");
    void (t.convertToRange as (...a: unknown[]) => unknown)();
    void (t.insertRow as (...a: unknown[]) => unknown)(1);
    void (t.deleteRow as (...a: unknown[]) => unknown)(0);
    void (t.getColumns as (...a: unknown[]) => unknown)();
    void (t.getStyle as (...a: unknown[]) => unknown)();
    void (t.getTotals as (...a: unknown[]) => unknown)();
    expect(calls.map((c) => [c.method, ...c.args])).toEqual([
      ["api.objectSetState", "table", "t9", "table.rename", ["Better"]],
      ["api.objectSetState", "table", "t9", "table.resize", [0, 0, 9, 3]],
      ["api.objectSetState", "table", "t9", "table.addColumn", ["Qty", 2]],
      ["api.objectSetState", "table", "t9", "table.removeColumn", ["Qty"]],
      ["api.objectSetState", "table", "t9", "table.renameColumn", ["A", "B"]],
      ["api.objectSetState", "table", "t9", "table.setTotalsRow", [true]],
      ["api.objectSetState", "table", "t9", "table.setTotalsFunction", ["Units", "sum", undefined]],
      ["api.objectSetState", "table", "t9", "table.setStyle", ["TableStyleDark1"]],
      ["api.objectSetState", "table", "t9", "table.convertToRange", []],
      ["api.objectSetState", "table", "t9", "table.insertRow", [1]],
      ["api.objectSetState", "table", "t9", "table.deleteRow", [0]],
      ["api.objectGetState", "table", "t9", "table.getColumns", []],
      ["api.objectGetState", "table", "t9", "table.getStyle", []],
      ["api.objectGetState", "table", "t9", "table.getTotals", []],
    ]);
    drain();
  });

  it("the own-table context sends the same aspects through object.setState", () => {
    const { context, calls, drain } = makeContext("table", "table-own");
    void (context.rename as (...a: unknown[]) => unknown)("Better");
    void (context.setTotalsRow as (...a: unknown[]) => unknown)(true);
    void (context.insertRow as (...a: unknown[]) => unknown)();
    void (context.getColumns as (...a: unknown[]) => unknown)();
    expect(calls.map((c) => [c.method, ...c.args])).toEqual([
      ["object.setState", "table.rename", ["Better"]],
      ["object.setState", "table.setTotalsRow", [true]],
      ["object.setState", "table.insertRow", [undefined]],
      ["object.getState", "table.getColumns", []],
    ]);
    drain();
  });
});

describe("worker shim: chart geometry + spec sugar", () => {
  it("setTitle/setType/setSourceRange are updateSpec patches — the extension's schema validator stays the single gate", () => {
    const { context, calls, drain } = makeContext("sheet", null);
    const api = context.api as Record<string, unknown>;
    const c = (api.chart as (id: string) => Record<string, unknown>)("c9");
    void (c.setGeometry as (...a: unknown[]) => unknown)({ x: 10, width: 300 });
    void (c.setTitle as (...a: unknown[]) => unknown)("Q4");
    void (c.setTitle as (...a: unknown[]) => unknown)(null);
    void (c.setType as (...a: unknown[]) => unknown)("line");
    void (c.setSourceRange as (...a: unknown[]) => unknown)("Sheet1!A1:D10");
    expect(calls.map((cc) => [cc.method, ...cc.args])).toEqual([
      ["api.objectSetState", "chart", "c9", "chart.setGeometry", [{ x: 10, width: 300 }]],
      ["api.objectSetState", "chart", "c9", "chart.updateSpec", [{ title: "Q4" }]],
      ["api.objectSetState", "chart", "c9", "chart.updateSpec", [{ title: null }]],
      ["api.objectSetState", "chart", "c9", "chart.updateSpec", [{ mark: "line" }]],
      ["api.objectSetState", "chart", "c9", "chart.updateSpec", [{ data: "Sheet1!A1:D10" }]],
    ]);
    drain();
  });

  it("the own-chart context sends the same sugar through object.setState", () => {
    const { context, calls, drain } = makeContext("chart", "chart-own");
    void (context.setGeometry as (...a: unknown[]) => unknown)({ width: 500, height: 300 });
    void (context.setTitle as (...a: unknown[]) => unknown)("T");
    void (context.setType as (...a: unknown[]) => unknown)("pie");
    void (context.setSourceRange as (...a: unknown[]) => unknown)("A1:B2");
    expect(calls.map((cc) => [cc.method, ...cc.args])).toEqual([
      ["object.setState", "chart.setGeometry", [{ width: 500, height: 300 }]],
      ["object.setState", "chart.updateSpec", [{ title: "T" }]],
      ["object.setState", "chart.updateSpec", [{ mark: "pie" }]],
      ["object.setState", "chart.updateSpec", [{ data: "A1:B2" }]],
    ]);
    drain();
  });
});

describe("worker shim: namedRange handle re-keys after a rename", () => {
  it("rename() re-points every later call (and .name) at the host's answer", async () => {
    const { context, calls, resolveCall, drain } = makeContext("sheet", null);
    const api = context.api as Record<string, unknown>;
    const h = (api.namedRange as (name: string) => Record<string, unknown>)("OldName");
    expect(h.name).toBe("OldName");

    const renamed = (h.rename as (n: string) => Promise<{ name: string }>)("NewName");
    expect(calls[0]).toMatchObject({
      method: "api.objectSetState",
      args: ["namedRange", "OldName", "namedRange.update", [{ newName: "NewName" }]],
    });
    resolveCall(calls[0].callId, { name: "NewName" });
    expect(await renamed).toEqual({ name: "NewName" });

    // The handle now addresses the NEW name — the old key would miss.
    expect(h.name).toBe("NewName");
    void (h.setValues as (...a: unknown[]) => unknown)([["1"]]);
    void (h.setRefersTo as (...a: unknown[]) => unknown)("=Sheet1!$A$1");
    expect(calls.slice(1).map((c) => c.args.slice(0, 2))).toEqual([
      ["namedRange", "NewName"],
      ["namedRange", "NewName"],
    ]);
    drain();
  });

  it("update() with a newName re-keys too; without one it keeps the key", async () => {
    const { context, calls, resolveCall, drain } = makeContext("sheet", null);
    const api = context.api as Record<string, unknown>;
    const h = (api.namedRange as (name: string) => Record<string, unknown>)("A");
    const p1 = (h.update as (p: unknown) => Promise<{ name: string }>)({ refersTo: "=X" });
    resolveCall(calls[0].callId, { name: "A" });
    await p1;
    expect(h.name).toBe("A");
    const p2 = (h.update as (p: unknown) => Promise<{ name: string }>)({ newName: "B" });
    resolveCall(calls[1].callId, { name: "B" });
    await p2;
    expect(h.name).toBe("B");
    drain();
  });
});

// ============================================================================
// (4) generated typings
// ============================================================================

describe("generated typings", () => {
  const typingsSrc = fs.readFileSync(
    path.resolve(__dirname, "../../../../extensions/ScriptableObjects/objectContexts.d.ts"),
    "utf8",
  );

  it("declare the table structure family on BOTH the handle and the own-table context", () => {
    for (const member of [
      "rename(newName: string): Promise<void>;",
      "resize(startRow: number, startCol: number, endRow: number, endCol: number): Promise<void>;",
      "addColumn(name: string, position?: number): Promise<void>;",
      "removeColumn(name: string): Promise<void>;",
      "renameColumn(oldName: string, newName: string): Promise<void>;",
      "setTotalsRow(show: boolean): Promise<void>;",
      "setTotalsFunction(column: string, fn: ScriptTableTotalsFunction, customFormula?: string): Promise<void>;",
      "convertToRange(): Promise<void>;",
      "insertRow(position?: number): Promise<void>;",
      "deleteRow(position: number): Promise<void>;",
      "getColumns(): Promise<ScriptTableColumnInfo[]>;",
      "getStyle(): Promise<ScriptTableStyle>;",
      "getTotals(): Promise<ScriptTableTotals>;",
    ]) {
      const hits = typingsSrc.split(member).length - 1;
      expect(hits, member).toBeGreaterThanOrEqual(2);
    }
  });

  it("declare the chart geometry + sugar and the published ScriptChartSpec", () => {
    expect(typingsSrc).toContain("declare interface ScriptChartSpec");
    expect(typingsSrc).toContain("updateSpec(patch: ScriptChartSpec): Promise<void>;");
    for (const member of [
      "setGeometry(patch: ScriptChartGeometry): Promise<void>;",
      "setTitle(title: string | null): Promise<void>;",
      "setType(mark: string): Promise<void>;",
      "setSourceRange(range: string): Promise<void>;",
    ]) {
      const hits = typingsSrc.split(member).length - 1;
      expect(hits, member).toBeGreaterThanOrEqual(2);
    }
  });

  it("declare namedRange.update on handle + context, and the notes/comments API rows", () => {
    for (const member of [
      "update(patch: ScriptNamedRangeUpdate): Promise<{ name: string }>;",
      "setRefersTo(refersTo: string): Promise<void>;",
      "rename(newName: string): Promise<{ name: string }>;",
    ]) {
      const hits = typingsSrc.split(member).length - 1;
      expect(hits, member).toBeGreaterThanOrEqual(2);
    }
    for (const member of [
      "setNote(row: number, col: number, text: string | null, sheet?: SheetRef): Promise<{ id: string } | null>;",
      "getNote(row: number, col: number, sheet?: SheetRef): Promise<string | null>;",
      "listNotes(sheet?: SheetRef): Promise<ScriptNoteInfo[]>;",
      "addComment(row: number, col: number, text: string): Promise<{ id: string }>;",
      "replyToComment(commentId: string, text: string): Promise<{ id: string }>;",
      "resolveComment(commentId: string, resolved?: boolean): Promise<void>;",
      "deleteComment(commentId: string): Promise<void>;",
    ]) {
      expect(typingsSrc, member).toContain(member);
    }
  });
});
