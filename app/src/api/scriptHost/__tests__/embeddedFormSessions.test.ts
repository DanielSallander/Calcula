//! FILENAME: app/src/api/scriptHost/__tests__/embeddedFormSessions.test.ts
// PURPOSE: A form EMBEDDED on a sheet (M3c part 2) through the REAL host: it is
//          a pane session with `placement: "embedded"`, so it must take the
//          FORM's binding pipeline unchanged — the same audited reads, the same
//          restricted-tier sheet pin, the same writes — while the four calls
//          that only make sense for a surface a SCRIPT took are refused or
//          answered honestly.
// CONTEXT: Same FakeWorker harness as scriptPaneBindings.test.ts (a vitest file
//          owns its own module mocks, so the preamble is per-file by
//          construction). The renderer is a stub on the pane wire that
//          acknowledges the request the way lib/scriptEmbedHost.ts does — with
//          `placement: "embedded"`.
//
//          THE CLAIM THIS FILE EXISTS TO PIN: an embedded surface is not a
//          second implementation. If someone gives it its own read path, its
//          own pin check or its own writer, the seeds and the refusal sentences
//          asserted here stop matching the ones scriptPaneBindings.test.ts
//          asserts for the pane — which is the drift the shared registry was
//          chosen to prevent.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type { H2W, W2H } from "../protocol";
import { AppEvents, emitAppEvent } from "../../events";
import {
  SCRIPT_PANE_CLOSE_EVENT,
  SCRIPT_PANE_INPUT_EVENT,
  SCRIPT_PANE_PATCH_EVENT,
  SCRIPT_PANE_REQUEST_EVENT,
  type ScriptPaneClosePayload,
  type ScriptPaneInputPayload,
  type ScriptPanePatchPayload,
  type ScriptPaneRequestPayload,
} from "../scriptPaneSpec";
import { FORM_TEXT_CHANGE_DEBOUNCE_MS } from "../scriptForms";
import { listScriptPanes, resetScriptPanes } from "../scriptPanes";
import {
  EMBEDDED_FORM_ORPHAN_REMEDY,
  __resetEmbeddedFormPlacementsForTests,
  placeEmbeddedForm,
  removeEmbeddedFormPlacement,
} from "../embeddedFormPlacements";
import { recordCapabilityGrant, resetAllGrants } from "../capabilities";
import { RESTRICTED_SHEET_CLAMP_MESSAGE } from "../host";
import { clearAudit, getAuditTail } from "../auditRing";
import type { FormSpec } from "../scriptFormSpec";

// ----------------------------------------------------------------------------
// The workbook the form binds to.
// ----------------------------------------------------------------------------

const hoisted = vi.hoisted(() => ({
  activeSheet: 0,
  sheets: [
    { index: 0, name: "Sheet1" },
    { index: 1, name: "Sheet2" },
  ] as Array<{ index: number; name: string }>,
  cells: new Map<string, { value: string | number | boolean | null; display: string; type: string }>(),
  toasts: [] as string[],
}));

const key = (sheet: number, row: number, col: number): string => `${sheet}:${row}:${col}`;

function setCell(sheet: number, row: number, col: number, value: string): void {
  hoisted.cells.set(key(sheet, row, col), { value, display: value, type: "text" });
}

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
  getActiveSheet: vi.fn(async () => hoisted.activeSheet),
  getSheets: vi.fn(async () => ({
    sheets: hoisted.sheets.map((s) => ({ ...s })),
    activeIndex: hoisted.activeSheet,
  })),
  getRangeCellsTyped: vi.fn(
    async (startRow: number, startCol: number, endRow: number, endCol: number, sheetIndex?: number) => {
      const sheet = sheetIndex ?? hoisted.activeSheet;
      const out: Array<{ row: number; col: number; value: unknown; display: string; type: string }> = [];
      for (let r = startRow; r <= endRow; r++) {
        for (let c = startCol; c <= endCol; c++) {
          const cell = hoisted.cells.get(key(sheet, r, c));
          if (cell) out.push({ row: r, col: c, ...cell });
        }
      }
      return out;
    },
  ),
  updateCell: vi.fn(async (row: number, col: number, value: string) => {
    hoisted.cells.set(key(hoisted.activeSheet, row, col), { value, display: value, type: "text" });
    return { cells: [] };
  }),
  updateCellsBatch: vi.fn(async (updates: Array<{ row: number; col: number; value: string }>) => {
    for (const u of updates) {
      hoisted.cells.set(key(hoisted.activeSheet, u.row, u.col), { value: u.value, display: u.value, type: "text" });
    }
    return [];
  }),
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
vi.mock("../../notifications", async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  showToast: (message: string) => {
    hoisted.toasts.push(message);
  },
}));

import * as lib from "../../lib";

// ----------------------------------------------------------------------------
// The fake worker realm.
// ----------------------------------------------------------------------------

class FakeWorker {
  static last: FakeWorker | null = null;
  onmessage: ((e: MessageEvent<W2H>) => void) | null = null;
  onerror: ((e: unknown) => void) | null = null;
  received: H2W[] = [];
  terminated = false;

  constructor() {
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

  events(hook: string): unknown[] {
    return this.received
      .filter((m): m is Extract<H2W, { t: "event" }> => m.t === "event" && m.hook === hook)
      .map((m) => m.payload);
  }

  /** The index of the first message matching a predicate, or -1 — for ORDER assertions. */
  indexOf(match: (m: H2W) => boolean): number {
    return this.received.findIndex(match);
  }

  async call(
    callId: number,
    method: string,
    args: unknown[],
  ): Promise<{ ok: boolean; value?: unknown; error?: { message?: string } }> {
    this.emit({ t: "call", callId, method, args } as W2H);
    for (let i = 0; i < 400; i++) {
      const result = this.received.find(
        (m): m is Extract<H2W, { t: "callResult" }> => m.t === "callResult" && m.callId === callId,
      );
      if (result) return result as { ok: boolean; value?: unknown; error?: { message?: string } };
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    throw new Error(`callResult for ${method} (id ${callId}) never arrived`);
  }
}

// ----------------------------------------------------------------------------
// The renderer stub — lib/scriptEmbedHost.ts's half of the wire.
// ----------------------------------------------------------------------------

function renderer() {
  const requests: ScriptPaneRequestPayload[] = [];
  const patches: ScriptPanePatchPayload[] = [];
  const closes: ScriptPaneClosePayload[] = [];
  const input = (payload: ScriptPaneInputPayload): void => emitAppEvent(SCRIPT_PANE_INPUT_EVENT, payload);
  const onReq = (e: Event): void => {
    const req = (e as CustomEvent).detail as ScriptPaneRequestPayload;
    requests.push(req);
    // What lib/scriptEmbedHost.ts does: acknowledge from the WIRING, not from
    // the component's mount, and always as "embedded".
    input({
      paneId: req.paneId,
      kind: "docked",
      placement: "embedded",
      values: Object.fromEntries(
        Object.entries(req.seeds).map(([n, s]) => [n, s.value]),
      ) as ScriptPaneInputPayload["values"],
    });
  };
  const onPatch = (e: Event): void => {
    patches.push((e as CustomEvent).detail as ScriptPanePatchPayload);
  };
  const onClose = (e: Event): void => {
    closes.push((e as CustomEvent).detail as ScriptPaneClosePayload);
  };
  window.addEventListener(SCRIPT_PANE_REQUEST_EVENT, onReq);
  window.addEventListener(SCRIPT_PANE_PATCH_EVENT, onPatch);
  window.addEventListener(SCRIPT_PANE_CLOSE_EVENT, onClose);
  return {
    requests,
    patches,
    closes,
    last: () => requests[requests.length - 1],
    visible: (paneId: string) => input({ paneId, kind: "visible", placement: "embedded", values: {} }),
    change: (paneId: string, name: string, value: string, values: Record<string, unknown>) =>
      input({ paneId, kind: "change", name, value, values: values as ScriptPaneInputPayload["values"] }),
    stop: () => {
      window.removeEventListener(SCRIPT_PANE_REQUEST_EVENT, onReq);
      window.removeEventListener(SCRIPT_PANE_PATCH_EVENT, onPatch);
      window.removeEventListener(SCRIPT_PANE_CLOSE_EVENT, onClose);
    },
  };
}

// ----------------------------------------------------------------------------
// Harness
// ----------------------------------------------------------------------------

const globalScope = globalThis as unknown as Record<string, unknown>;
const originalWorker = globalScope.Worker;

type HostModule = typeof import("../host");
let host: HostModule;

const SCRIPT_ID = "embedded-form-script";
const DEFINITION = {
  id: SCRIPT_ID,
  name: "Order entry",
  objectType: "form",
  instanceId: null,
  source: "function setup(context) {}",
  accessLevel: "restricted" as const,
  declaredCapabilities: ["ui.pane"],
  apiVersion: "1.0.0",
};

/** `a` on the sheet the user is looking at, `b` on another sheet, `c` unbound. */
const SPEC: FormSpec = {
  title: "Order",
  children: [
    { type: "textbox", name: "a", label: "A", bind: "B2" },
    { type: "textbox", name: "b", label: "B", bind: "Sheet2!B2" },
    { type: "textbox", name: "c", label: "C" },
  ],
};

let r: ReturnType<typeof renderer>;

/** Mount the script and let it describe its layout, exactly as `form.define` does. */
async function mountAndDefine(spec: FormSpec | null = SPEC): Promise<FakeWorker> {
  await host.hostMountScript({ ...DEFINITION });
  const worker = FakeWorker.last!;
  if (spec) {
    const defined = await worker.call(1, "form.define", [spec]);
    expect(defined.ok, `form.define must be admitted: ${defined.error?.message ?? ""}`).toBe(true);
  }
  return worker;
}

/** Place a form on the sheet, the way the USER does, and open its session. */
async function placeAndOpen(sheetIndex = 0): Promise<{ placementId: string; paneId: string }> {
  const placement = placeEmbeddedForm({ scriptId: SCRIPT_ID, sheetIndex, anchorRow: 5, anchorCol: 2 });
  const answer = await host.openEmbeddedScriptForm(placement.id);
  expect(answer.ok, `the embedded form must open: ${answer.ok ? "" : answer.reason}`).toBe(true);
  return { placementId: placement.id, paneId: (answer as { ok: true; paneId: string }).paneId };
}

async function settle(ms = 60): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, ms));
}

beforeEach(async () => {
  FakeWorker.last = null;
  hoisted.activeSheet = 0;
  hoisted.sheets = [
    { index: 0, name: "Sheet1" },
    { index: 1, name: "Sheet2" },
  ];
  hoisted.cells.clear();
  hoisted.toasts.length = 0;
  clearAudit();
  setCell(0, 1, 1, "hello");
  setCell(1, 1, 1, "other sheet");
  vi.mocked(lib.updateCell).mockClear();
  vi.mocked(lib.updateCellsBatch).mockClear();
  globalScope.Worker = FakeWorker as unknown as typeof Worker;
  // NO `vi.resetModules()` — see scriptPaneBindings.test.ts for why.
  host = await import("../host");
  emitAppEvent(AppEvents.SHEET_CHANGED, { sheetIndex: 0 });
  resetScriptPanes();
  __resetEmbeddedFormPlacementsForTests();
  resetAllGrants();
  recordCapabilityGrant(SCRIPT_ID, "ui.pane");
  r = renderer();
});

afterEach(() => {
  r.stop();
  host.hostUnmountScript(SCRIPT_ID);
  resetScriptPanes();
  __resetEmbeddedFormPlacementsForTests();
  resetAllGrants();
  globalScope.Worker = originalWorker;
});

// ----------------------------------------------------------------------------
// 1. The form's pipeline, unchanged, on a surface the user placed
// ----------------------------------------------------------------------------

describe("an embedded form binds through the FORM's pipeline", () => {
  it("seeds from the sheet on screen, refuses another sheet by name, and pins to that sheet", async () => {
    await mountAndDefine();
    const { placementId, paneId } = await placeAndOpen();

    const req = r.last();
    expect(req.paneId).toBe(paneId);
    // The identity that reaches the renderer is the PLACEMENT's minted id — not
    // its anchor, and not a per-session id the placement could not be found by.
    expect(req.embedPlacementId).toBe(placementId);
    expect(req.scriptName).toBe("Order entry");
    expect(req.origin).toEqual({ kind: "local" });

    // Read through the audited row, exactly as a pane's dock reads.
    expect(req.seeds.a).toEqual({ value: "hello", display: "hello" });
    // THE RESTRICTED-TIER PIN, unchanged: the other sheet is refused with the
    // same sentence the script's own sheet.getCellData("Sheet2") gets, and
    // shows as a disabled widget carrying it — never as nothing.
    expect(req.seeds.b.readOnly).toBe(true);
    expect(req.seeds.b.reason).toBe(RESTRICTED_SHEET_CLAMP_MESSAGE);
    expect(req.pinnedSheetName).toBe("Sheet1");
  });

  it("binds to the sheet the form was PLACED on, not the tab that happened to be in front", async () => {
    // The user is on Sheet1; the form is an object sitting on Sheet2. This is
    // not an exotic case: the renderer opens every placement in the workbook,
    // so at load EVERY form on a sheet other than the first opened from behind
    // Sheet1.
    await mountAndDefine();
    hoisted.activeSheet = 0;
    const { paneId } = await placeAndOpen(1);
    const req = r.last();

    // `a` binds the bare "B2" — which means B2 on the sheet this form lives on.
    // It used to mean Sheet1!B2, so this widget opened holding "hello": another
    // sheet's value, painted inside a box drawn on Sheet2, with nothing saying
    // where it came from.
    expect(req.seeds.a.value).toBe(null);
    expect(req.seeds.a.readOnly).toBe(true);
    expect(req.seeds.a.reason).toBe('switch back to "Sheet2" to see and save this pane\'s cells');
    // And the pin is the object's own sheet, so the sentence the user reads on
    // Sheet1 names the sheet they must go to — not the one they are standing on.
    expect(req.pinnedSheetName).toBe("Sheet2");

    // The binding is DEFERRED, never dropped: the moment the user arrives on
    // Sheet2 the surface is painted, the watch arms and every bound cell is
    // read for the first time.
    hoisted.activeSheet = 1;
    emitAppEvent(AppEvents.SHEET_CHANGED, { sheetIndex: 1 });
    r.visible(paneId);
    await settle();
    const seeded = r.patches.filter((p) => p.seeds?.a !== undefined).pop();
    expect(seeded?.seeds?.a.value).toBe("other sheet");
    // And the deferral is LIFTED, not merely overwritten: a widget still marked
    // read-only would take no typing however right its value looked.
    expect(seeded?.seeds?.a.readOnly).toBeFalsy();

    // ...and what the user types goes to the cell under the form, on Sheet2.
    r.change(paneId, "a", "typed here", { a: "typed here", b: "", c: "" });
    await settle(FORM_TEXT_CHANGE_DEBOUNCE_MS + 80);
    expect(hoisted.cells.get(key(1, 1, 1))?.value).toBe("typed here");
    // Sheet1's B2 — the cell the old resolution would have written — is intact.
    expect(hoisted.cells.get(key(0, 1, 1))?.value).toBe("hello");
  });

  it("writes a changed widget back to its cell through the audited row", async () => {
    await mountAndDefine();
    const { paneId } = await placeAndOpen();
    r.visible(paneId);
    await settle();

    r.change(paneId, "a", "typed", { a: "typed", b: "", c: "" });
    // A textbox is debounced, like every text-like widget on every surface.
    await settle(FORM_TEXT_CHANGE_DEBOUNCE_MS + 60);

    expect(hoisted.cells.get(key(0, 1, 1))?.value).toBe("typed");
    const wrote = getAuditTail(200).some((row) => row.scriptId === SCRIPT_ID && row.class === "mutate" && row.ok);
    expect(wrote, "the write must appear in the audit ring under this script").toBe(true);
  });

  it("refuses the write when the user has left the pinned sheet, and says so in the band", async () => {
    await mountAndDefine();
    const { paneId } = await placeAndOpen();
    r.visible(paneId);
    await settle();

    hoisted.activeSheet = 1;
    emitAppEvent(AppEvents.SHEET_CHANGED, { sheetIndex: 1 });
    await settle();

    r.change(paneId, "a", "typed elsewhere", { a: "typed elsewhere", b: "", c: "" });
    await settle(FORM_TEXT_CHANGE_DEBOUNCE_MS + 80);

    // The cell on Sheet1 is untouched: the pin is the same pin the pane obeys.
    expect(hoisted.cells.get(key(0, 1, 1))?.value).toBe("hello");
    const said = r.patches.some((p) => p.patch?.message !== undefined || p.hostBindingNotice != null);
    expect(said, "the user must be told why nothing was saved").toBe(true);
  });
});

// ----------------------------------------------------------------------------
// 2. What the script is told, and what it is refused
// ----------------------------------------------------------------------------

describe("the script's side of an embedded surface", () => {
  it("is told the surface opened — the id is relayed BEFORE the hook that announces it", async () => {
    const worker = await mountAndDefine();
    const { placementId, paneId } = await placeAndOpen();

    const open = worker.events("onPaneOpen") as Array<{ paneId: string; placementId: string; placement: string }>;
    expect(open).toHaveLength(1);
    expect(open[0]).toMatchObject({ paneId, placementId, placement: "embedded" });

    // ORDER MATTERS: a handler that calls pane.update(...) must address the
    // surface it was just told about, and both travel as messages on one port.
    const relayAt = worker.indexOf((m) => m.t === "methodCall" && m.methodName === "__pane_opened");
    const hookAt = worker.indexOf((m) => m.t === "event" && m.hook === "onPaneOpen");
    expect(relayAt).toBeGreaterThanOrEqual(0);
    expect(relayAt).toBeLessThan(hookAt);
  });

  it("refuses pane.close, and the refusal names what the script CAN do", async () => {
    const worker = await mountAndDefine();
    const { paneId } = await placeAndOpen();
    const result = await worker.call(50, "pane.close", [paneId]);
    expect(result.ok).toBe(false);
    expect(result.error?.message).toMatch(/embedded on a sheet/);
    expect(result.error?.message).toMatch(/pane\.update/);
    // ...and the surface is still there.
    expect(listScriptPanes().map((p) => p.paneId)).toEqual([paneId]);
  });

  it("answers pane.reveal honestly instead of reporting a success nobody can see", async () => {
    const worker = await mountAndDefine();
    const { paneId } = await placeAndOpen();
    const result = await worker.call(51, "pane.reveal", [paneId]);
    expect(result.ok).toBe(true);
    expect(result.value).toMatchObject({ revealed: false });
    expect((result.value as { reason: string }).reason).toMatch(/embedded on a sheet/);
  });

  it("lists its own surfaces, and only its own", async () => {
    const worker = await mountAndDefine();
    const { paneId } = await placeAndOpen();
    const result = await worker.call(52, "pane.list", []);
    expect(result.ok).toBe(true);
    expect(result.value).toEqual([
      { paneId, placement: "embedded", embedded: true, visible: false, badge: null },
    ]);
  });

  it("still accepts pane.update — changing what the surface shows is the whole point", async () => {
    const worker = await mountAndDefine();
    const { paneId } = await placeAndOpen();
    const result = await worker.call(53, "pane.update", [paneId, { message: { text: "saved", kind: "info" } }]);
    expect(result.ok).toBe(true);
    expect(r.patches.some((p) => p.patch?.message?.text === "saved")).toBe(true);
  });
});

// ----------------------------------------------------------------------------
// 3. The session's lifetime is the PLACEMENT's, not the script's wish
// ----------------------------------------------------------------------------

describe("opening, refusing and ending an embedded session", () => {
  it("refuses with a sentence when the script is not running", async () => {
    const placement = placeEmbeddedForm({ scriptId: SCRIPT_ID, sheetIndex: 0, anchorRow: 1, anchorCol: 1 });
    const answer = await host.openEmbeddedScriptForm(placement.id);
    expect(answer.ok).toBe(false);
    expect((answer as { reason: string }).reason).toMatch(/not running/);
  });

  it("refuses with a sentence when the script has described no layout", async () => {
    await mountAndDefine(null);
    const placement = placeEmbeddedForm({ scriptId: SCRIPT_ID, sheetIndex: 0, anchorRow: 1, anchorCol: 1 });
    const answer = await host.openEmbeddedScriptForm(placement.id);
    expect(answer.ok).toBe(false);
    expect((answer as { reason: string }).reason).toMatch(/has not described a layout/);
  });

  it("refuses an ORPHANED placement, and says what the user can do about it", async () => {
    await mountAndDefine();
    const placement = placeEmbeddedForm({ scriptId: SCRIPT_ID, sheetIndex: 0, anchorRow: 5, anchorCol: 2 });
    const { shiftEmbeddedFormPlacements, structuralAnchorShift } = await import("../embeddedFormPlacements");
    shiftEmbeddedFormPlacements(0, structuralAnchorShift("rowDelete", 5, 1));
    const answer = await host.openEmbeddedScriptForm(placement.id);
    expect(answer.ok).toBe(false);
    const reason = (answer as { reason: string }).reason;
    expect(reason).toMatch(/anchored to was deleted/);
    // ...and "what the user can do" is the SHARED remedy, not a third spelling.
    // This refusal, the inert sentence and the orphan card all said "drag it
    // onto a cell to put it back" while nothing in the app implements a drag of
    // an embedded form; the gesture that works is the grid menu on the anchor
    // cell, and all three now quote it from one constant.
    expect(reason).toContain(EMBEDDED_FORM_ORPHAN_REMEDY);
    expect(reason).not.toMatch(/drag/i);
  });

  it("a second open of one placement reports the SAME session, never a second one", async () => {
    await mountAndDefine();
    const { placementId, paneId } = await placeAndOpen();
    const again = await host.openEmbeddedScriptForm(placementId);
    expect(again).toEqual({ ok: true, paneId });
    expect(listScriptPanes()).toHaveLength(1);
  });

  it("closes as 'orphaned' when the anchor goes, and the placement is what survives", async () => {
    const worker = await mountAndDefine();
    const { placementId } = await placeAndOpen();
    host.closeEmbeddedScriptForm(placementId, "orphaned");

    expect(r.closes.at(-1)?.reason).toBe("orphaned");
    expect(listScriptPanes()).toEqual([]);
    const closed = worker.events("onPaneClose") as Array<{ reason: string }>;
    expect(closed.at(-1)?.reason).toBe("orphaned");
  });

  it("closes as 'user' when the object is removed from the sheet", async () => {
    await mountAndDefine();
    const { placementId } = await placeAndOpen();
    removeEmbeddedFormPlacement(placementId);
    host.closeEmbeddedScriptForm(placementId, "user");
    expect(r.closes.at(-1)?.reason).toBe("user");
    expect(listScriptPanes()).toEqual([]);
  });

  it("unmounting the script closes the surface, and the placement stays", async () => {
    await mountAndDefine();
    const { placementId } = await placeAndOpen();
    host.hostUnmountScript(SCRIPT_ID);
    expect(r.closes.at(-1)?.reason).toBe("unmount");
    expect(listScriptPanes()).toEqual([]);
    const { getEmbeddedFormPlacement } = await import("../embeddedFormPlacements");
    expect(getEmbeddedFormPlacement(placementId)).not.toBeNull();
  });
});

// ----------------------------------------------------------------------------
// 4. The transparency row
// ----------------------------------------------------------------------------

describe("the registry reports an embedded surface as embedded", () => {
  it("says where it is, and names the placement so the panel can point at it", async () => {
    await mountAndDefine();
    const { placementId, paneId } = await placeAndOpen();
    const [row] = listScriptPanes();
    expect(row).toMatchObject({
      paneId,
      scriptId: SCRIPT_ID,
      scriptName: "Order entry",
      placement: "embedded",
      embedPlacementId: placementId,
      // ONE, not two: `b` names another sheet and the restricted-tier pin
      // refused it, so it resolved to no cell at all. The panel reports the
      // cells this surface actually reads and writes, which is the pane's rule
      // unchanged — a count that included a refused binding would tell the user
      // a script reaches a cell it cannot.
      boundCells: 1,
    });
  });

  it("cannot be talked out of 'embedded' by a renderer that claims another placement", async () => {
    await mountAndDefine();
    const placement = placeEmbeddedForm({ scriptId: SCRIPT_ID, sheetIndex: 0, anchorRow: 5, anchorCol: 2 });
    // A renderer that acknowledged "sidebar" for an embedded surface would put
    // a lie in the transparency panel — the user would look for the surface in
    // the panel list, where it is not.
    // The honest stub has to go FIRST: `markDocked` is idempotent, so with both
    // installed the honest acknowledgement would settle the session and this
    // test would pass without ever exercising the guard (it did, once).
    r.stop();
    const onReq = (e: Event): void => {
      const req = (e as CustomEvent).detail as ScriptPaneRequestPayload;
      emitAppEvent(SCRIPT_PANE_INPUT_EVENT, {
        paneId: req.paneId,
        kind: "docked",
        placement: "sidebar",
        values: {},
      } satisfies ScriptPaneInputPayload);
    };
    window.addEventListener(SCRIPT_PANE_REQUEST_EVENT, onReq);
    try {
      const answer = await host.openEmbeddedScriptForm(placement.id);
      expect(answer.ok).toBe(true);
      expect(listScriptPanes()[0].placement).toBe("embedded");
    } finally {
      window.removeEventListener(SCRIPT_PANE_REQUEST_EVENT, onReq);
    }
  });
});
