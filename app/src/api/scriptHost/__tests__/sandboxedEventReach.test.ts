//! FILENAME: app/src/api/scriptHost/__tests__/sandboxedEventReach.test.ts
// PURPOSE: What the HOST HANDS a mounted object script, as opposed to what the
//          script may ask for. Every other guard in this directory tests the
//          PULL door (the broker allowlist); these test the PUSH door, which is
//          where the reach nobody counted kept turning up:
//            1. the workbook's full filesystem PATH, delivered by
//               workbook.onOpen / onAfterSave and by the cancellable
//               onBeforeSave detail — to a script with no capabilities at all;
//            2. cell contents from a sheet a RESTRICTED script may not read,
//               delivered by sheet.onDataChange / cell.onEdit because those two
//               forwarded the whole CELL_VALUES_CHANGED array unfiltered.
// CONTEXT: The sibling forwarders range.onChange / namedRange.onChange already
//          filter by their object's sheet; these two had no object to filter by
//          and so filtered by nothing. api.workbookFileName already withholds
//          the directory by hand — these events were the door it left open.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type { H2W, W2H } from "../protocol";
import { AppEvents, emitAppEvent } from "../../events";

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

  /** Args of the relayed methodCall for one method name. */
  relayedArgs(methodName: string): unknown[] | undefined {
    const m = this.received.find(
      (x): x is Extract<H2W, { t: "methodCall" }> =>
        x.t === "methodCall" && x.methodName === methodName,
    );
    return m?.args;
  }
}

const globalScope = globalThis as unknown as Record<string, unknown>;
const originalWorker = globalScope.Worker;

type HostModule = typeof import("../host");
let host: HostModule;

function definition(accessLevel: "restricted" | "unlocked", objectType = "workbook") {
  return {
    id: `script-${objectType}-${accessLevel}`,
    name: "Test script",
    objectType,
    instanceId: null,
    source: "function setup(context) {}",
    accessLevel,
    apiVersion: "1.0.0",
  };
}

/** Flush the coalescing rAF the host uses for some hooks. */
async function settle(): Promise<void> {
  await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
}

describe("what the host HANDS a sandboxed object script", () => {
  beforeEach(async () => {
    FakeWorker.instances = [];
    FakeWorker.last = null;
    globalScope.Worker = FakeWorker as unknown as typeof Worker;
    vi.resetModules();
    host = await import("../host");
  });

  afterEach(() => {
    host.hostResetAll();
    globalScope.Worker = originalWorker;
  });

  // --------------------------------------------------------------------------
  // 1. The workbook PATH
  // --------------------------------------------------------------------------

  it("workbook.onOpen receives the file NAME, never the folder", async () => {
    await host.hostMountScript(definition("restricted"));
    const worker = FakeWorker.last!;
    worker.declareHook("onOpen");

    emitAppEvent(AppEvents.AFTER_OPEN, {
      path: "C:\\Users\\Jane Doe\\Consulting\\ClientX\\Q4 bid.cala",
    });
    await settle();

    const payloads = worker.events("onOpen");
    expect(payloads, "the hook must still fire — this is thinning, not a mute").toHaveLength(1);
    expect(payloads[0]).toEqual({ fileName: "Q4 bid.cala" });
    const wire = JSON.stringify(payloads);
    expect(wire).not.toContain("Jane Doe");
    expect(wire, "no path separator may cross into the sandbox").not.toMatch(/[\\/]/);
  });

  it("workbook.onAfterSave receives the file NAME, never the folder", async () => {
    await host.hostMountScript(definition("restricted"));
    const worker = FakeWorker.last!;
    worker.declareHook("onAfterSave");

    emitAppEvent(AppEvents.AFTER_SAVE, { path: "/home/jane/clients/acme/2026 model.cala" });
    await settle();

    expect(worker.events("onAfterSave")).toEqual([{ fileName: "2026 model.cala" }]);
  });

  it("an UNLOCKED script gets the same thinning — this is not a tier question", async () => {
    // The path is withheld because a sandboxed realm has no path-taking API and
    // the directory names the user's account and clients. That is true at both
    // tiers; a tier buys grid reach, not the user's folder layout.
    await host.hostMountScript(definition("unlocked"));
    const worker = FakeWorker.last!;
    worker.declareHook("onOpen");
    emitAppEvent(AppEvents.AFTER_OPEN, { path: "D:\\Secret\\Deal\\book.cala" });
    await settle();
    expect(worker.events("onOpen")).toEqual([{ fileName: "book.cala" }]);
  });

  it("the cancellable onBeforeSave detail is thinned before it is relayed", async () => {
    // This one does NOT travel as an app event: Core pulls it through the
    // lifecycle-guard registry and the host relays it as a method call, so it
    // never passes thinAppEventForScripts. It carried `{ path }` verbatim.
    const def = definition("restricted");
    await host.hostMountScript(def);
    const worker = FakeWorker.last!;

    const pending = host.callWorkbookBeforeLifecycle(def.id, "save", {
      path: "C:\\Users\\Jane Doe\\Consulting\\ClientX\\Q4 bid.cala",
    });
    const args = worker.relayedArgs("__workbook_onBeforeSave");
    expect(args).toEqual([{ fileName: "Q4 bid.cala" }]);
    expect(JSON.stringify(args)).not.toContain("Consulting");

    const relayed = worker.received.find((m) => m.t === "methodCall") as { callId: number };
    worker.emit({ t: "methodResult", callId: relayed.callId, ok: true, value: undefined });
    await expect(pending).resolves.toBeNull();
  });

  it("onBeforeClose gets the same shape, so the contract is one shape", async () => {
    const def = definition("restricted");
    await host.hostMountScript(def);
    const worker = FakeWorker.last!;
    const pending = host.callWorkbookBeforeLifecycle(def.id, "close", {});
    expect(worker.relayedArgs("__workbook_onBeforeClose")).toEqual([{ fileName: null }]);
    const relayed = worker.received.find((m) => m.t === "methodCall") as { callId: number };
    worker.emit({ t: "methodResult", callId: relayed.callId, ok: true, value: undefined });
    await expect(pending).resolves.toBeNull();
  });

  // --------------------------------------------------------------------------
  // 2. Cross-sheet cell CONTENTS
  // --------------------------------------------------------------------------
  //
  // The active sheet in these tests is 0 (activeSheetIndexForEvents starts
  // there and no SHEET_CHANGED is emitted), so a change tagged sheetIndex 2 is
  // a change on a sheet a restricted script's own broker calls would refuse.

  const CROSS_SHEET_CHANGES = [
    { row: 0, col: 0, sheetIndex: 0, oldValue: "1", newValue: "2", formula: null },
    { row: 7, col: 3, sheetIndex: 2, oldValue: "", newValue: "SECRET-PAYROLL", formula: null },
  ];

  it("sheet.onDataChange withholds changes on a sheet a RESTRICTED script cannot read", async () => {
    await host.hostMountScript(definition("restricted", "sheet"));
    const worker = FakeWorker.last!;
    worker.declareHook("onDataChange");

    emitAppEvent(AppEvents.CELL_VALUES_CHANGED, { changes: CROSS_SHEET_CHANGES, source: "user" });
    await settle();

    const payloads = worker.events("onDataChange") as Array<{
      changes: Array<{ row: number; sheetIndex: number }>;
    }>;
    expect(payloads).toHaveLength(1);
    expect(payloads[0].changes.map((c) => c.sheetIndex)).toEqual([0]);
    expect(
      JSON.stringify(payloads),
      "a restricted script must not be handed a cell it could not have asked for",
    ).not.toContain("SECRET-PAYROLL");
  });

  it("cell.onEdit withholds the same changes", async () => {
    await host.hostMountScript(definition("restricted", "cell"));
    const worker = FakeWorker.last!;
    worker.declareHook("onEdit");

    emitAppEvent(AppEvents.CELL_VALUES_CHANGED, { changes: CROSS_SHEET_CHANGES, source: "user" });
    await settle();

    const payloads = worker.events("onEdit") as Array<{ changes: Array<{ sheetIndex: number }> }>;
    expect(payloads).toHaveLength(1);
    expect(payloads[0].changes.map((c) => c.sheetIndex)).toEqual([0]);
    expect(JSON.stringify(payloads)).not.toContain("SECRET-PAYROLL");
  });

  it("an UNLOCKED script keeps the whole stream — it may read any sheet anyway", async () => {
    await host.hostMountScript(definition("unlocked", "sheet"));
    const worker = FakeWorker.last!;
    worker.declareHook("onDataChange");

    emitAppEvent(AppEvents.CELL_VALUES_CHANGED, { changes: CROSS_SHEET_CHANGES, source: "user" });
    await settle();

    const payloads = worker.events("onDataChange") as Array<{
      changes: Array<{ sheetIndex: number }>;
    }>;
    expect(payloads[0].changes.map((c) => c.sheetIndex)).toEqual([0, 2]);
  });

  it("each change CARRIES its own sheetIndex, so none is re-stamped with the active sheet", async () => {
    // The old payload had ONE sheetIndex at the top and passed `changes`
    // through verbatim. A script reading `{ sheetIndex, change.row, change.col }`
    // therefore addressed the wrong sheet's cell for any cross-sheet change —
    // silently wrong data, not merely extra data.
    await host.hostMountScript(definition("unlocked", "sheet"));
    const worker = FakeWorker.last!;
    worker.declareHook("onDataChange");

    emitAppEvent(AppEvents.CELL_VALUES_CHANGED, {
      changes: [{ row: 1, col: 1, newValue: "a" }, { row: 2, col: 2, sheetIndex: 3, newValue: "b" }],
      source: "user",
    });
    await settle();

    const payload = worker.events("onDataChange")[0] as {
      sheetIndex: number;
      changes: Array<{ sheetIndex: number; newValue: string }>;
    };
    expect(payload.sheetIndex, "the top-level field still names the sheet on screen").toBe(0);
    // An untagged change means "the active sheet" (the historical contract);
    // a tagged one keeps its own sheet.
    expect(payload.changes[0].sheetIndex).toBe(0);
    expect(payload.changes[1].sheetIndex).toBe(3);
  });
});
