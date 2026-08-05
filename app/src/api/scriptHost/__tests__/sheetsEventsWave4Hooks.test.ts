//! FILENAME: app/src/api/scriptHost/__tests__/sheetsEventsWave4Hooks.test.ts
// PURPOSE: Wave 4 SHEETS/EVENTS cluster — the realm-facing halves, driven
//          through a fake worker speaking the real protocol (the hookNaming
//          harness): the sheet-collection forwarders (onSheetAdd / onSheetDelete
//          / onSheetRename), the cancellable onBeforePrint lifecycle guard, and
//          the cancellable click hooks riding the Core interceptor registries
//          (onBeforeDoubleClick gates edit mode, onBeforeRightClick the
//          context menu) — including teardown, because an unmounted script must
//          never eat a click or veto a print.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type { H2W, W2H } from "../protocol";

// The mount path touches the backend for grants and snapshot seeds; none of it
// is under test here and all of it is defensive against failure.
vi.mock("../../backend", () => ({
  invokeBackend: vi.fn().mockResolvedValue(null),
  getWorkbookProperties: vi.fn().mockRejectedValue(new Error("no backend in test")),
  emitTauriEvent: vi.fn().mockResolvedValue(undefined),
  listenTauriEvent: vi.fn().mockResolvedValue(() => undefined),
}));
vi.mock("../capabilities", async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  restoreAndSyncGrants: vi.fn().mockResolvedValue(undefined),
  revokeBackendCapabilities: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("../mountGate", () => ({
  assertMountAllowed: vi.fn().mockResolvedValue(undefined),
}));

/** A worker realm that registers the hooks the test asks for, then mounts —
 *  and answers relayed method calls (the replying-hook path) with a
 *  configurable verdict. */
class FakeWorker {
  static hooksOnMount: string[] = [];
  /** What the realm answers to ANY relayed methodCall. */
  static methodVerdict: unknown = undefined;
  static last: FakeWorker | null = null;
  onmessage: ((e: MessageEvent<W2H>) => void) | null = null;
  onerror: ((e: unknown) => void) | null = null;
  received: H2W[] = [];
  methodCalls: Array<{ methodName: string; args: unknown[] }> = [];
  terminated = false;

  constructor() {
    FakeWorker.last = this;
  }

  postMessage(msg: H2W): void {
    this.received.push(msg);
    if (msg.t === "mount") {
      for (const hook of FakeWorker.hooksOnMount) {
        this.emit({ t: "hookRegistered", hook });
      }
      this.emit({ t: "mounted", ok: true });
      return;
    }
    if (msg.t === "methodCall") {
      const { callId, methodName, args } = msg as unknown as {
        callId: number; methodName: string; args: unknown[];
      };
      this.methodCalls.push({ methodName, args });
      // Async like a real realm: the host must be awaiting, not inlining.
      setTimeout(() => {
        this.emit({
          t: "methodResult",
          callId,
          ok: true,
          value: FakeWorker.methodVerdict,
        } as W2H);
      }, 0);
    }
  }

  terminate(): void {
    this.terminated = true;
  }

  emit(data: W2H): void {
    this.onmessage?.({ data } as MessageEvent<W2H>);
  }

  /** Events the host pushed INTO the realm — i.e. the forwarder actually fired. */
  events(): Array<{ hook: string; payload: unknown }> {
    return this.received
      .filter((m) => m.t === "event")
      .map((m) => ({
        hook: (m as { hook: string }).hook,
        payload: (m as { payload: unknown }).payload,
      }));
  }
}

const globalScope = globalThis as unknown as Record<string, unknown>;
const originalWorker = globalScope.Worker;

type HostModule = typeof import("../host");
type EventsModule = typeof import("../../events");
type GuardsModule = typeof import("../../../core/lib/lifecycleGuards");
type DblModule = typeof import("../../../core/lib/cellDoubleClickInterceptors");
type CtxModule = typeof import("../../../core/lib/cellContextMenuInterceptors");

let host: HostModule;
let events: EventsModule;
let guards: GuardsModule;
let dbl: DblModule;
let ctxMenu: CtxModule;

const WORKBOOK_SCRIPT = {
  id: "wb-script-1",
  name: "Sheet Auditor",
  objectType: "workbook",
  instanceId: null as string | null,
  source: "function setup(workbook){}",
  accessLevel: "unlocked",
  apiVersion: "1.0.0",
};

const SHEET_SCRIPT = {
  id: "sheet-script-1",
  name: "Click Gate",
  objectType: "sheet",
  instanceId: null as string | null,
  source: "function setup(sheet){}",
  accessLevel: "unlocked",
  apiVersion: "1.0.0",
};

/** Give the fake realm's queued setTimeout replies a chance to land. */
const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 10));

beforeEach(async () => {
  FakeWorker.hooksOnMount = [];
  FakeWorker.methodVerdict = undefined;
  FakeWorker.last = null;
  globalScope.Worker = FakeWorker as unknown as typeof Worker;
  vi.resetModules();
  // Everything is imported from the SAME (fresh) module registry generation,
  // so the registries the host registers into are the ones the test drives.
  host = await import("../host");
  events = await import("../../events");
  guards = await import("../../../core/lib/lifecycleGuards");
  dbl = await import("../../../core/lib/cellDoubleClickInterceptors");
  ctxMenu = await import("../../../core/lib/cellContextMenuInterceptors");
});

afterEach(() => {
  host.hostResetAll();
  guards.resetLifecycleGuards();
  globalScope.Worker = originalWorker;
});

// ============================================================================
// Sheet-collection forwarders
// ============================================================================

describe("workbook sheet-collection hooks", () => {
  it("forwards SHEET_ADDED / SHEET_DELETED / SHEET_RENAMED payloads verbatim", async () => {
    FakeWorker.hooksOnMount = ["onSheetAdd", "onSheetDelete", "onSheetRename"];
    await host.hostMountScript({ ...WORKBOOK_SCRIPT });

    events.emitAppEvent(events.AppEvents.SHEET_ADDED, {
      sheetIndex: 2, sheetName: "March", source: "new",
    });
    events.emitAppEvent(events.AppEvents.SHEET_DELETED, {
      sheetIndex: 1, sheetName: "Draft",
    });
    events.emitAppEvent(events.AppEvents.SHEET_RENAMED, {
      sheetIndex: 0, oldName: "Sheet1", newName: "Data",
    });
    await settle();

    const forwarded = FakeWorker.last?.events() ?? [];
    expect(forwarded).toEqual([
      { hook: "onSheetAdd", payload: { sheetIndex: 2, sheetName: "March", source: "new" } },
      { hook: "onSheetDelete", payload: { sheetIndex: 1, sheetName: "Draft" } },
      { hook: "onSheetRename", payload: { sheetIndex: 0, oldName: "Sheet1", newName: "Data" } },
    ]);
  });

  it("hooks the script never declared are not wired", async () => {
    FakeWorker.hooksOnMount = ["onSheetAdd"];
    await host.hostMountScript({ ...WORKBOOK_SCRIPT });

    events.emitAppEvent(events.AppEvents.SHEET_RENAMED, {
      sheetIndex: 0, oldName: "A", newName: "B",
    });
    await settle();
    expect(FakeWorker.last?.events() ?? []).toEqual([]);
  });
});

// ============================================================================
// onBeforePrint — the third cancellable lifecycle guard
// ============================================================================

describe("workbook.onBeforePrint", () => {
  it("registers a lifecycle guard whose cancel verdict stops a print, by name", async () => {
    FakeWorker.hooksOnMount = ["onBeforePrint"];
    FakeWorker.methodVerdict = { cancel: true, reason: "Totals are stale" };
    await host.hostMountScript({ ...WORKBOOK_SCRIPT });
    expect(guards.lifecycleGuardCount()).toBe(1);

    const objection = await guards.checkLifecycleGuards("print", {});
    expect(objection).toEqual({ by: "Sheet Auditor", reason: "Totals are stale" });
    expect(FakeWorker.last?.methodCalls.map((c) => c.methodName)).toEqual([
      "__workbook_onBeforePrint",
    ]);
  });

  it("an allowing verdict lets the print proceed, and a save never asks it", async () => {
    FakeWorker.hooksOnMount = ["onBeforePrint"];
    FakeWorker.methodVerdict = undefined; // handler did work, returned nothing
    await host.hostMountScript({ ...WORKBOOK_SCRIPT });

    expect(await guards.checkLifecycleGuards("print", {})).toBeNull();
    expect(await guards.checkLifecycleGuards("save", {})).toBeNull();
    // Only the print pulled a verdict from the realm.
    expect(FakeWorker.last?.methodCalls.map((c) => c.methodName)).toEqual([
      "__workbook_onBeforePrint",
    ]);
  });

  it("unmount removes the guard — a dead script cannot veto a print", async () => {
    FakeWorker.hooksOnMount = ["onBeforePrint"];
    FakeWorker.methodVerdict = { cancel: true };
    await host.hostMountScript({ ...WORKBOOK_SCRIPT });
    expect(guards.lifecycleGuardCount()).toBe(1);

    host.hostUnmountScript(WORKBOOK_SCRIPT.id);
    expect(guards.lifecycleGuardCount()).toBe(0);
    expect(await guards.checkLifecycleGuards("print", {})).toBeNull();
  });
});

// ============================================================================
// Cancellable click hooks
// ============================================================================

describe("sheet.onBeforeDoubleClick / onBeforeRightClick", () => {
  const clickEvt = { clientX: 10, clientY: 20 };

  it("a cancel verdict suppresses edit-mode entry, with {row, col, address}", async () => {
    FakeWorker.hooksOnMount = ["onBeforeDoubleClick"];
    FakeWorker.methodVerdict = "cancel";
    await host.hostMountScript({ ...SHEET_SCRIPT });

    const handled = await dbl.checkCellDoubleClickInterceptors(3, 1, clickEvt);
    expect(handled).toBe(true);
    expect(FakeWorker.last?.methodCalls).toEqual([
      { methodName: "__sheet_onBeforeDoubleClick", args: [{ row: 3, col: 1, address: "B4" }] },
    ]);
  });

  it("no verdict (or an allowing one) lets the double-click proceed", async () => {
    FakeWorker.hooksOnMount = ["onBeforeDoubleClick"];
    FakeWorker.methodVerdict = undefined;
    await host.hostMountScript({ ...SHEET_SCRIPT });
    expect(await dbl.checkCellDoubleClickInterceptors(0, 0, clickEvt)).toBe(false);
  });

  it("a cancel verdict suppresses the context menu", async () => {
    FakeWorker.hooksOnMount = ["onBeforeRightClick"];
    FakeWorker.methodVerdict = { cancel: true };
    await host.hostMountScript({ ...SHEET_SCRIPT });

    const suppressed = await ctxMenu.checkCellContextMenuInterceptors(6, 26, clickEvt);
    expect(suppressed).toBe(true);
    expect(FakeWorker.last?.methodCalls).toEqual([
      { methodName: "__sheet_onBeforeRightClick", args: [{ row: 6, col: 26, address: "AA7" }] },
    ]);
  });

  it("unmount removes the interceptors — a dead script cannot eat a click", async () => {
    FakeWorker.hooksOnMount = ["onBeforeDoubleClick", "onBeforeRightClick"];
    FakeWorker.methodVerdict = "cancel";
    await host.hostMountScript({ ...SHEET_SCRIPT });
    expect(await dbl.checkCellDoubleClickInterceptors(0, 0, clickEvt)).toBe(true);

    host.hostUnmountScript(SHEET_SCRIPT.id);
    expect(await dbl.checkCellDoubleClickInterceptors(0, 0, clickEvt)).toBe(false);
    expect(await ctxMenu.checkCellContextMenuInterceptors(0, 0, clickEvt)).toBe(false);
  });
});
