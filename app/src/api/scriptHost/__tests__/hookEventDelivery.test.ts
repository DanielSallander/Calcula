//! FILENAME: app/src/api/scriptHost/__tests__/hookEventDelivery.test.ts
// PURPOSE: Behavioural cover for what the event forwarders DELIVER to a mounted
//          object script — three Wave-1 fixes:
//            1. OWN-WRITE ECHO GUARD on sheet.onDataChange / cell.onEdit: the
//               typings promise a script's own writes never re-fire its
//               handlers, but only range.onChange filtered them. The canonical
//               VBA timestamp macro (a change handler writing a neighbouring
//               cell) therefore looped forever on these two hooks.
//            2. workbook.onOpen REPLAY AT MOUNT: scripts mount FROM the
//               AFTER_OPEN handler, so the live subscription is wired only
//               after the open it exists to observe was broadcast. An
//               open-mount replays that one thinned delivery — once, never on
//               remount.
//            3. onDataChange COALESCING: two CELL_VALUES_CHANGED flushes inside
//               one animation frame used to OVERWRITE each other (latest-wins),
//               so audit scripts silently missed edits under paste/fill load.
//               Batches now concatenate, bounded, with `truncated: true` on
//               overflow — and each change carries its A1 `address`.
// CONTEXT: Same FakeWorker harness as sandboxedEventReach.test.ts. The write
//          that arms the echo guard is a REAL broker call (api.setCellValue)
//          through handleCall, so the attribution path under test is the one
//          production writes take.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type { H2W, W2H } from "../protocol";
import { AppEvents, emitAppEvent } from "../../events";

const hoisted = vi.hoisted(() => ({
  currentFilePath: null as string | null,
  binding: null as null | {
    enabled: boolean;
    orphaned: boolean;
    sheetIndex: number;
    startRow: number;
    endRow: number;
    startCol: number;
    endCol: number;
  },
}));

// The mount path touches the backend for grants and snapshot seeds; none of
// that is under test here, and all of it is defensive against failure.
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
// The write executors' collaborators: no writeback regions, a recording lib.
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
  getRangeCellsTyped: vi.fn(async () => []),
  updateCell: vi.fn(async () => ({ cells: [] })),
  updateCellsBatch: vi.fn(async () => []),
  updateCellOnSheets: vi.fn(async () => undefined),
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
// The onOpen replay reads the current file through the filesystem facade — the
// exact source api.workbookFileName reads.
vi.mock("../../filesystem", async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  getCurrentFilePath: vi.fn(async () => hoisted.currentFilePath),
}));
vi.mock("../../cellBehaviors", async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  getCellBehaviorById: vi.fn(() => hoisted.binding),
}));

// ============================================================================
// A fake worker realm that only has to mount and record.
// ============================================================================

class FakeWorker {
  static instances: FakeWorker[] = [];
  static last: FakeWorker | null = null;
  onmessage: ((e: MessageEvent<W2H>) => void) | null = null;
  onerror: ((e: unknown) => void) | null = null;
  received: H2W[] = [];
  terminated = false;

  constructor() {
    FakeWorker.instances.push(this);
    FakeWorker.last = this;
  }

  postMessage(msg: H2W): void {
    this.received.push(msg);
    if (msg.t === "mount") this.emit({ t: "mounted", ok: true });
  }

  terminate(): void {
    this.terminated = true;
  }

  emit(data: W2H): void {
    this.onmessage?.({ data } as MessageEvent<W2H>);
  }

  /** Declare a hook, exactly as a real realm's registerHook does. */
  declareHook(hook: string): void {
    this.emit({ t: "hookRegistered", hook });
  }

  /** Payloads the host forwarded for one hook, in order. */
  events(hook: string): unknown[] {
    return this.received
      .filter((m): m is Extract<H2W, { t: "event" }> => m.t === "event" && m.hook === hook)
      .map((m) => m.payload);
  }

  /** Drive a broker call and resolve with its callResult message. */
  async call(callId: number, method: string, args: unknown[]): Promise<{ ok: boolean }> {
    this.emit({ t: "call", callId, method, args } as W2H);
    for (let i = 0; i < 200; i++) {
      const result = this.received.find(
        (m): m is Extract<H2W, { t: "callResult" }> => m.t === "callResult" && m.callId === callId,
      );
      if (result) return result;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    throw new Error(`callResult for ${method} (id ${callId}) never arrived`);
  }
}

const globalScope = globalThis as unknown as Record<string, unknown>;
const originalWorker = globalScope.Worker;

type HostModule = typeof import("../host");
let host: HostModule;

function definition(
  accessLevel: "restricted" | "unlocked",
  objectType = "workbook",
  extras: { instanceId?: string; mountCause?: "open"; id?: string } = {},
) {
  return {
    id: extras.id ?? `script-${objectType}-${accessLevel}`,
    name: "Test script",
    objectType,
    instanceId: extras.instanceId ?? null,
    source: "function setup(context) {}",
    accessLevel,
    apiVersion: "1.0.0",
    ...(extras.mountCause ? { mountCause: extras.mountCause } : {}),
  };
}

/** Flush the coalescing rAF the host uses for some hooks. */
async function settle(): Promise<void> {
  await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
}

/** Wait until the worker holds `count` events for `hook` (replay is async). */
async function untilEvents(worker: FakeWorker, hook: string, count: number): Promise<unknown[]> {
  for (let i = 0; i < 200; i++) {
    if (worker.events(hook).length >= count) return worker.events(hook);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  return worker.events(hook);
}

describe("event delivery to mounted object scripts", () => {
  beforeEach(async () => {
    FakeWorker.instances = [];
    FakeWorker.last = null;
    hoisted.currentFilePath = null;
    hoisted.binding = null;
    globalScope.Worker = FakeWorker as unknown as typeof Worker;
    vi.resetModules();
    host = await import("../host");
  });

  afterEach(() => {
    host.hostResetAll();
    globalScope.Worker = originalWorker;
  });

  // --------------------------------------------------------------------------
  // 1. Own-write echo guard (sheet.onDataChange / cell.onEdit)
  // --------------------------------------------------------------------------

  it("sheet.onDataChange drops the script's OWN write but delivers the user's edit", async () => {
    const def = definition("unlocked", "sheet");
    await host.hostMountScript(def);
    const worker = FakeWorker.last!;
    worker.declareHook("onDataChange");

    // A REAL broker write: this is what records the attribution the guard reads.
    const result = await worker.call(1, "api.setCellValue", [3, 2, "hello"]);
    expect(result.ok, "the broker write itself must succeed").toBe(true);

    // One flush carrying the script's own echo AND a user edit.
    emitAppEvent(AppEvents.CELL_VALUES_CHANGED, {
      changes: [
        { row: 3, col: 2, oldValue: "", newValue: "hello" },
        { row: 9, col: 9, oldValue: "", newValue: "user-edit" },
      ],
      source: "user",
    });
    await settle();

    const payloads = worker.events("onDataChange") as Array<{
      changes: Array<{ row: number; col: number; address: string; newValue: string }>;
    }>;
    expect(payloads, "the user's edit must still be delivered").toHaveLength(1);
    expect(payloads[0].changes).toHaveLength(1);
    expect(payloads[0].changes[0].row).toBe(9);
    expect(payloads[0].changes[0].col).toBe(9);
    expect(
      JSON.stringify(payloads),
      "the script's own write must never re-fire its handler",
    ).not.toContain("hello");
  });

  it("an echo-only flush does not fire sheet.onDataChange at all", async () => {
    const def = definition("unlocked", "sheet");
    await host.hostMountScript(def);
    const worker = FakeWorker.last!;
    worker.declareHook("onDataChange");

    await worker.call(1, "api.setCellValue", [3, 2, "stamp"]);
    emitAppEvent(AppEvents.CELL_VALUES_CHANGED, {
      changes: [{ row: 3, col: 2, oldValue: "", newValue: "stamp" }],
      source: "user",
    });
    await settle();

    expect(worker.events("onDataChange")).toHaveLength(0);
  });

  it("cell.onEdit gets the same guard — the VBA timestamp loop is closed", async () => {
    const def = definition("unlocked", "cell");
    await host.hostMountScript(def);
    const worker = FakeWorker.last!;
    worker.declareHook("onEdit");

    // The timestamp macro's write (what an onEdit handler would do)...
    await worker.call(1, "api.setCellValue", [5, 1, "2026-08-04T10:00:00"]);
    // ...must not come back; the edit that TRIGGERED the handler still does.
    emitAppEvent(AppEvents.CELL_VALUES_CHANGED, {
      changes: [
        { row: 5, col: 1, oldValue: "", newValue: "2026-08-04T10:00:00" },
        { row: 5, col: 0, oldValue: "", newValue: "edited by user" },
      ],
      source: "user",
    });
    await settle();

    const payloads = worker.events("onEdit") as Array<{
      changes: Array<{ row: number; col: number }>;
    }>;
    expect(payloads).toHaveLength(1);
    expect(payloads[0].changes).toEqual([
      { row: 5, col: 0, sheetIndex: 0, oldValue: "", newValue: "edited by user", formula: undefined },
    ]);

    // An echo-only follow-up flush fires nothing.
    emitAppEvent(AppEvents.CELL_VALUES_CHANGED, {
      changes: [{ row: 5, col: 1, oldValue: "", newValue: "2026-08-04T10:00:00" }],
      source: "user",
    });
    await settle();
    expect(worker.events("onEdit")).toHaveLength(1);
  });

  it("range.onChange keeps its existing per-change filter (unchanged behavior)", async () => {
    hoisted.binding = {
      enabled: true,
      orphaned: false,
      sheetIndex: 0,
      startRow: 0,
      endRow: 9,
      startCol: 0,
      endCol: 9,
    };
    const def = definition("unlocked", "range", { instanceId: "binding-1" });
    await host.hostMountScript(def);
    const worker = FakeWorker.last!;
    worker.declareHook("onChange");

    await worker.call(1, "api.setCellValue", [2, 2, "own"]);
    emitAppEvent(AppEvents.CELL_VALUES_CHANGED, {
      changes: [
        { row: 2, col: 2, newValue: "own" },
        { row: 4, col: 4, newValue: "user" },
      ],
      source: "user",
    });
    await settle();

    const payloads = worker.events("onChange") as Array<{
      changes: Array<{ row: number; col: number; newValue: string }>;
    }>;
    expect(payloads).toHaveLength(1);
    expect(payloads[0].changes).toEqual([{ row: 4, col: 4, newValue: "user" }]);
  });

  // --------------------------------------------------------------------------
  // 2. workbook.onOpen replay at mount
  // --------------------------------------------------------------------------

  it("an open-mount replays ONE thinned onOpen delivery — file name, never the folder", async () => {
    hoisted.currentFilePath = "C:\\Users\\Jane Doe\\Consulting\\ClientX\\Q4 bid.cala";
    const def = definition("unlocked", "workbook", { mountCause: "open" });
    await host.hostMountScript(def);
    const worker = FakeWorker.last!;
    worker.declareHook("onOpen");

    const payloads = await untilEvents(worker, "onOpen", 1);
    expect(payloads).toEqual([{ fileName: "Q4 bid.cala" }]);
    const wire = JSON.stringify(payloads);
    expect(wire).not.toContain("Jane Doe");
    expect(wire, "no path separator may cross into the sandbox").not.toMatch(/[\\/]/);

    // Re-declaring the hook must not replay again (the flag was consumed).
    worker.declareHook("onOpen");
    await settle();
    expect(worker.events("onOpen")).toHaveLength(1);

    // The LIVE subscription is still wired: a real open still delivers.
    emitAppEvent(AppEvents.AFTER_OPEN, { path: "D:\\Elsewhere\\next.cala" });
    await settle();
    expect(worker.events("onOpen")).toEqual([
      { fileName: "Q4 bid.cala" },
      { fileName: "next.cala" },
    ]);
  });

  it("a REMOUNT of the same definition never replays (Save & Apply, crash respawn)", async () => {
    hoisted.currentFilePath = "C:\\Books\\report.cala";
    const def = definition("unlocked", "workbook", { mountCause: "open" });
    await host.hostMountScript(def);
    FakeWorker.last!.declareHook("onOpen");
    await untilEvents(FakeWorker.last!, "onOpen", 1);

    // The mount CONSUMED the cause from the definition object itself, so
    // remounting the very same object cannot replay.
    await host.hostMountScript(def);
    const remounted = FakeWorker.last!;
    remounted.declareHook("onOpen");
    await settle();
    await settle();
    expect(remounted.events("onOpen")).toHaveLength(0);
  });

  it("a mount WITHOUT the open cause never replays", async () => {
    hoisted.currentFilePath = "C:\\Books\\report.cala";
    await host.hostMountScript(definition("unlocked", "workbook"));
    const worker = FakeWorker.last!;
    worker.declareHook("onOpen");
    await settle();
    await settle();
    expect(worker.events("onOpen")).toHaveLength(0);
  });

  it("an open-mount of an UNSAVED workbook replays { fileName: null }", async () => {
    hoisted.currentFilePath = null;
    const def = definition("unlocked", "workbook", { mountCause: "open", id: "untitled-wb" });
    await host.hostMountScript(def);
    const worker = FakeWorker.last!;
    worker.declareHook("onOpen");
    const payloads = await untilEvents(worker, "onOpen", 1);
    expect(payloads).toEqual([{ fileName: null }]);
  });

  // --------------------------------------------------------------------------
  // 3. onDataChange coalescing: concatenate, bound, truncated flag, addresses
  // --------------------------------------------------------------------------

  it("two flushes in one frame CONCATENATE — the first batch is not lost", async () => {
    await host.hostMountScript(definition("unlocked", "sheet"));
    const worker = FakeWorker.last!;
    worker.declareHook("onDataChange");

    emitAppEvent(AppEvents.CELL_VALUES_CHANGED, {
      changes: [
        { row: 1, col: 1, newValue: "a" },
        { row: 2, col: 2, newValue: "b" },
      ],
      source: "user",
    });
    emitAppEvent(AppEvents.CELL_VALUES_CHANGED, {
      changes: [{ row: 3, col: 3, newValue: "c" }],
      source: "user",
    });
    await settle();

    const payloads = worker.events("onDataChange") as Array<{
      changes: Array<{ row: number; address: string; newValue: string }>;
      truncated?: boolean;
    }>;
    expect(payloads, "still ONE delivery per frame").toHaveLength(1);
    expect(payloads[0].changes.map((c) => c.newValue)).toEqual(["a", "b", "c"]);
    expect(payloads[0].changes.map((c) => c.address)).toEqual(["B2", "C3", "D4"]);
    expect(payloads[0].truncated, "an intact batch does not claim truncation").toBeUndefined();
  });

  it("the merged batch is BOUNDED and says so: truncated, not silently short", async () => {
    await host.hostMountScript(definition("unlocked", "sheet"));
    const worker = FakeWorker.last!;
    worker.declareHook("onDataChange");

    const flush = (offset: number, n: number) =>
      emitAppEvent(AppEvents.CELL_VALUES_CHANGED, {
        changes: Array.from({ length: n }, (_, i) => ({
          row: offset + i,
          col: 0,
          newValue: `v${offset + i}`,
        })),
        source: "user",
      });
    flush(0, 600);
    flush(600, 600);
    await settle();

    const payloads = worker.events("onDataChange") as Array<{
      changes: unknown[];
      truncated?: boolean;
    }>;
    expect(payloads).toHaveLength(1);
    expect(payloads[0].changes).toHaveLength(1000);
    expect(payloads[0].truncated).toBe(true);
  });

  it("address enrichment covers multi-letter columns", async () => {
    await host.hostMountScript(definition("unlocked", "sheet"));
    const worker = FakeWorker.last!;
    worker.declareHook("onDataChange");

    emitAppEvent(AppEvents.CELL_VALUES_CHANGED, {
      changes: [
        { row: 6, col: 1, newValue: "x" },
        { row: 0, col: 26, newValue: "y" },
        { row: 99, col: 701, newValue: "z" },
      ],
      source: "user",
    });
    await settle();

    const payload = worker.events("onDataChange")[0] as {
      changes: Array<{ address: string }>;
    };
    expect(payload.changes.map((c) => c.address)).toEqual(["B7", "AA1", "ZZ100"]);
  });

  it("latest-state hooks still coalesce by OVERWRITE (onSheetChange)", async () => {
    await host.hostMountScript(definition("unlocked", "workbook"));
    const worker = FakeWorker.last!;
    worker.declareHook("onSheetChange");

    emitAppEvent(AppEvents.SHEET_CHANGED, { sheetIndex: 1, sheetName: "Sheet2" });
    emitAppEvent(AppEvents.SHEET_CHANGED, { sheetIndex: 0, sheetName: "Sheet1" });
    await settle();

    expect(worker.events("onSheetChange")).toEqual([{ sheetIndex: 0, sheetName: "Sheet1" }]);
  });
});
