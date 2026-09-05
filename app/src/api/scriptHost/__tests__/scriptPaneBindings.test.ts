//! FILENAME: app/src/api/scriptHost/__tests__/scriptPaneBindings.test.ts
// PURPOSE: A task pane's bound cells (M2 S5) through the REAL host: the form's
//          binding pipeline reused at dock, the restricted-tier sheet pin on
//          read and on write, the live watch that exists only while the pane is
//          VISIBLE, the reveal re-read, own-write suppression, and the fan-out
//          cap on a pane refresh.
// CONTEXT: Same FakeWorker harness as hookEventDelivery.test.ts — the worker
//          drives `pane.dock` as a real broker call, so every read and write
//          here takes the audited rows a script's own hand would. The renderer
//          (S4) is a stub on the pane wire: it acknowledges "docked", reports
//          "visible" / "hidden" as its section component would on mount and
//          unmount, and records every patch the host sends it.
//
//          The invariant worth the most: a HIDDEN pane receives NO cell events
//          and performs NO reads. A pane docked on an unselected ribbon tab can
//          live for hours; watching it then would queue an hour of stale
//          `onPaneChange` events for the moment it came back, and spend an
//          audited read per change on a surface nobody can see. On reveal the
//          bound cells are read ONCE and the script hears only what differs.

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
import { FORM_TEXT_CHANGE_DEBOUNCE_MS, MAX_FORM_CHANGE_FANOUT } from "../scriptForms";
import { listScriptPanes, resetScriptPanes } from "../scriptPanes";
import { recordCapabilityGrant, resetAllGrants } from "../capabilities";
import { RESTRICTED_SHEET_CLAMP_MESSAGE } from "../host";
import { clearAudit, getAuditTail } from "../auditRing";
import type { FormSpec } from "../scriptFormSpec";

// ----------------------------------------------------------------------------
// The workbook the pane binds to: a cell map the lib mock reads and writes.
// ----------------------------------------------------------------------------

interface StoredCell {
  value: string | number | boolean | null;
  display: string;
  type: "text" | "number" | "boolean" | "empty";
}

const hoisted = vi.hoisted(() => ({
  activeSheet: 0,
  /**
   * The workbook's sheet list, MUTABLE. Section 8 deletes and reorders sheets
   * under a docked pane — the gesture that makes an index name a DIFFERENT
   * sheet — which a frozen list cannot express.
   */
  sheets: [
    { index: 0, name: "Sheet1" },
    { index: 1, name: "Sheet2" },
  ] as Array<{ index: number; name: string }>,
  cells: new Map<string, { value: string | number | boolean | null; display: string; type: string }>(),
  reads: 0,
  /** Every toast the host showed (a refused close flush has no band left to use). */
  toasts: [] as string[],
}));

const key = (sheet: number, row: number, col: number): string => `${sheet}:${row}:${col}`;

function setCell(sheet: number, row: number, col: number, value: string | number | boolean | null): void {
  const cell: StoredCell =
    value === null
      ? { value: null, display: "", type: "empty" }
      : typeof value === "number"
        ? { value, display: String(value), type: "number" }
        : typeof value === "boolean"
          ? { value, display: value ? "TRUE" : "FALSE", type: "boolean" }
          : { value, display: value, type: "text" };
  hoisted.cells.set(key(sheet, row, col), cell);
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
      hoisted.reads += 1;
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
// The Controls-pane facade, NOT mocked here: section 11 drives a real
// `form.readControl` through the broker, with a provider registered the way the
// ControlsPane extension registers one.
import { CONTROL_VALUE_CHANGED, registerControlValuesProvider, type ControlValue } from "../../controlValues";

// ----------------------------------------------------------------------------
// A fake worker realm that mounts, records, and drives broker calls.
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

  /** Payloads the host forwarded for one hook, in order. */
  events(hook: string): unknown[] {
    return this.received
      .filter((m): m is Extract<H2W, { t: "event" }> => m.t === "event" && m.hook === hook)
      .map((m) => m.payload);
  }

  /** `onPaneChange` payloads whose source is the CELL (the watch or a re-read), by widget name. */
  cellChanges(): Array<{ name: string; value: unknown }> {
    return (this.events("onPaneChange") as Array<{ name: string; value: unknown; source: string }>)
      .filter((p) => p.source === "cell")
      .map((p) => ({ name: p.name, value: p.value }));
  }

  /** The last `pane.values.<id>` mirror the host pushed. */
  lastValues(paneId: string): Record<string, unknown> | undefined {
    const mirrors = this.received.filter(
      (m): m is Extract<H2W, { t: "mirror" }> => m.t === "mirror" && m.path === `pane.values.${paneId}`,
    );
    return mirrors.at(-1)?.value as Record<string, unknown> | undefined;
  }

  /** Drive a broker call and resolve with its callResult message. */
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
// The renderer stub on the pane wire.
// ----------------------------------------------------------------------------

function renderer() {
  const requests: ScriptPaneRequestPayload[] = [];
  const patches: ScriptPanePatchPayload[] = [];
  const closes: ScriptPaneClosePayload[] = [];
  const input = (payload: ScriptPaneInputPayload): void => emitAppEvent(SCRIPT_PANE_INPUT_EVENT, payload);
  const valuesOf = (req: ScriptPaneRequestPayload): ScriptPaneInputPayload["values"] =>
    Object.fromEntries(Object.entries(req.seeds).map(([n, s]) => [n, s.value])) as ScriptPaneInputPayload["values"];
  const onReq = (e: Event): void => {
    const req = (e as CustomEvent).detail as ScriptPaneRequestPayload;
    requests.push(req);
    // Registered on the panel registry: the dock settles. NOT yet visible —
    // the section component reports that separately, when it mounts.
    input({ paneId: req.paneId, kind: "docked", placement: "sidebar", values: valuesOf(req) });
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
    visible: (paneId: string) => input({ paneId, kind: "visible", placement: "sidebar", values: {} }),
    hidden: (paneId: string) => input({ paneId, kind: "hidden", values: {} }),
    change: (paneId: string, name: string, value: string | boolean, values: Record<string, unknown>) =>
      input({ paneId, kind: "change", name, value, values: values as ScriptPaneInputPayload["values"] }),
    close: (paneId: string) => input({ paneId, kind: "close", values: {} }),
    /** Seed patches the host sent (the watch, a reveal re-read, a post-write refresh). */
    seedPatches: () => patches.filter((p) => p.seeds !== undefined),
    /** The band messages the host sent (a refused write). */
    messages: () => patches.map((p) => p.patch?.message).filter((m): m is NonNullable<typeof m> => !!m),
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

const SCRIPT_ID = "pane-bindings-script";
const DEFINITION = {
  id: SCRIPT_ID,
  name: "Status board",
  objectType: "form",
  instanceId: null,
  source: "function setup(context) {}",
  accessLevel: "restricted" as const,
  declaredCapabilities: ["ui.pane"],
  apiVersion: "1.0.0",
};

/** A restricted pane: `a` on the sheet on screen, `b` on another sheet, `c` unbound. */
const SPEC: FormSpec = {
  title: "Status",
  children: [
    { type: "textbox", name: "a", label: "A", bind: "B2" },
    { type: "textbox", name: "b", label: "B", bind: "Sheet2!B2" },
    { type: "textbox", name: "c", label: "C" },
  ],
};

async function mountAndDock(
  spec: FormSpec = SPEC,
  definition: typeof DEFINITION = DEFINITION,
): Promise<{ worker: FakeWorker; paneId: string }> {
  await host.hostMountScript({ ...definition });
  const worker = FakeWorker.last!;
  const result = await worker.call(1, "pane.dock", [spec, undefined]);
  expect(result.ok, `pane.dock must be admitted: ${result.error?.message ?? ""}`).toBe(true);
  return { worker, paneId: (result.value as { paneId: string }).paneId };
}

/** Wait until the lib has served `n` more cell reads than `since`. */
async function untilReads(since: number, n: number): Promise<void> {
  await vi.waitFor(() => expect(hoisted.reads).toBeGreaterThanOrEqual(since + n), { timeout: 2000 });
}

/** Let the watch's 16 ms coalescer and any read it started run to completion. */
async function settle(ms = 60): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, ms));
}

/**
 * A cell changed on `sheet` (the pane's pinned sheet by default).
 *
 * THE `sheetIndex` IS WRITTEN OUT ON PURPOSE. It used to be omitted, which made
 * this helper mean "whatever sheet the HOST last saw a SHEET_CHANGED for" —
 * `activeSheetIndexForEvents`, module-level state in host.ts that no
 * `beforeEach` here can reset (this file deliberately avoids
 * `vi.resetModules()`; see the note in `beforeEach`). After any test that left
 * the active sheet on Sheet2, a `cellChanged()` was attributed to Sheet2, the
 * live watch's pinned-sheet filter dropped it, and a live-watch test appended
 * below section 9 passed while exercising nothing at all. A test must say which
 * sheet it means; it must not inherit that from whichever test ran before it.
 */
function cellChanged(row: number, col: number, value: string, sheet = 0): void {
  setCell(sheet, row, col, value);
  emitAppEvent(AppEvents.CELL_VALUES_CHANGED, {
    changes: [{ row, col, sheetIndex: sheet, oldValue: "", newValue: value }],
    source: "user",
  });
}

/**
 * The sheet COLLECTION moves: a tab deleted, or dragged to another position.
 * `next` is the workbook afterwards, each entry naming which OLD index its
 * cells come from, so the cell store is re-keyed exactly as the real one is —
 * the whole point of these cases is that the cells at a bound (sheet, row, col)
 * belong to a different sheet afterwards.
 */
function reshuffleSheets(next: Array<{ from: number; name: string }>): void {
  const moved = new Map<string, { value: string | number | boolean | null; display: string; type: string }>();
  next.forEach((s, index) => {
    for (const [k, cell] of hoisted.cells) {
      const [sheet, row, col] = k.split(":").map(Number);
      if (sheet === s.from) moved.set(key(index, row, col), cell);
    }
  });
  hoisted.cells.clear();
  for (const [k, v] of moved) hoisted.cells.set(k, v);
  hoisted.sheets = next.map((s, index) => ({ index, name: s.name }));
}

let r: ReturnType<typeof renderer>;

beforeEach(async () => {
  FakeWorker.last = null;
  hoisted.activeSheet = 0;
  hoisted.sheets = [
    { index: 0, name: "Sheet1" },
    { index: 1, name: "Sheet2" },
  ];
  hoisted.cells.clear();
  hoisted.reads = 0;
  hoisted.toasts.length = 0;
  clearAudit();
  setCell(0, 1, 1, "hello");
  setCell(1, 1, 1, "other sheet");
  vi.mocked(lib.updateCell).mockClear();
  vi.mocked(lib.updateCellsBatch).mockClear();
  vi.mocked(lib.beginUndoTransaction).mockClear();
  globalScope.Worker = FakeWorker as unknown as typeof Worker;
  // NO `vi.resetModules()`: `emitAppEvent` above is a static import, and a
  // reset would give the freshly imported host a different events module
  // (eventBackpressure.test.ts explains). Same module every time.
  host = await import("../host");
  // ...which also means the host's `activeSheetIndexForEvents` carries over
  // from the previous test. Put it back where `hoisted.activeSheet` says the
  // workbook is, so nothing in this file depends on declaration order (see
  // `cellChanged`).
  emitAppEvent(AppEvents.SHEET_CHANGED, { sheetIndex: 0 });
  resetScriptPanes();
  resetAllGrants();
  // The capability the row needs, as consent would have recorded it. The
  // ceiling (`declaredCapabilities`) is on the definition.
  recordCapabilityGrant(SCRIPT_ID, "ui.pane");
  r = renderer();
});

afterEach(() => {
  r.stop();
  host.hostUnmountScript(SCRIPT_ID);
  resetScriptPanes();
  resetAllGrants();
  globalScope.Worker = originalWorker;
});

// ----------------------------------------------------------------------------
// 1. The form's pipeline at dock, with the restricted-tier pin
// ----------------------------------------------------------------------------

describe("a restricted pane binds through the form's pipeline", () => {
  it("seeds from the sheet on screen, refuses another sheet by name, and pins the pane to the sheet", async () => {
    const { paneId } = await mountAndDock();
    const req = r.last();
    expect(req.paneId).toBe(paneId);
    // The bound cell on the sheet on screen was READ through the audited row.
    expect(req.seeds.a).toEqual({ value: "hello", display: "hello" });
    // The other sheet was refused by the tier clamp — the same refusal the
    // script's own sheet.getCellData("Sheet2") gets — and shows as a DISABLED
    // widget carrying that sentence, never as nothing.
    expect(req.seeds.b.readOnly).toBe(true);
    expect(req.seeds.b.reason).toBe(RESTRICTED_SHEET_CLAMP_MESSAGE);
    // An unbound widget has no seed.
    expect(req.seeds.c).toBeUndefined();
    // The band shows which sheet the pane is pinned to.
    expect(req.pinnedSheetName).toBe("Sheet1");
    expect(listScriptPanes()).toHaveLength(1);
  });

  it("refuses a write when the active sheet differs, with the 'switch back' sentence, and the pane stays open", async () => {
    const { worker, paneId } = await mountAndDock();
    r.visible(paneId);
    await untilReads(0, 2); // the reveal re-read
    // The user switched sheets under the open pane.
    hoisted.activeSheet = 1;
    r.change(paneId, "a", "typed", { a: "typed", b: null, c: "" });
    await vi.waitFor(() => expect(r.messages()).toHaveLength(1), { timeout: 2000 });
    expect(r.messages()[0]).toEqual({
      text: 'switch back to "Sheet1" to save this pane',
      kind: "error",
    });
    // Nothing was written anywhere, and nothing closed.
    expect(lib.updateCell).not.toHaveBeenCalled();
    expect(lib.updateCellsBatch).not.toHaveBeenCalled();
    expect(r.closes).toHaveLength(0);
    expect(listScriptPanes().map((p) => p.paneId)).toEqual([paneId]);
    // The user's own keystroke still reached the script (source: "user").
    expect((worker.events("onPaneChange") as Array<{ source: string }>).map((e) => e.source)).toEqual(["user"]);
  });

  it("writes each committed change (no Submit) through the audited row inside ONE undo batch", async () => {
    const { paneId } = await mountAndDock();
    r.visible(paneId);
    await untilReads(0, 2);
    r.change(paneId, "a", "typed", { a: "typed", b: null, c: "" });
    await vi.waitFor(() => expect(lib.updateCell).toHaveBeenCalledTimes(1), { timeout: 2000 });
    // (row 1, col 1) is B2; the TYPED value, never a display string.
    expect(lib.updateCell).toHaveBeenCalledWith(1, 1, "typed");
    expect(lib.beginUndoTransaction).toHaveBeenCalledWith("Pane: Status board");
    // The unbound widget is never written, whatever the user types into it.
    r.change(paneId, "c", "free text", { a: "typed", b: null, c: "free text" });
    await settle(FORM_TEXT_CHANGE_DEBOUNCE_MS + 40);
    expect(lib.updateCell).toHaveBeenCalledTimes(1);
  });
});

// ----------------------------------------------------------------------------
// 2. The watch exists only while the pane is VISIBLE
// ----------------------------------------------------------------------------

describe("the live watch is visibility-gated", () => {
  it("a docked-but-hidden pane receives NO cell events and performs NO reads", async () => {
    const { worker } = await mountAndDock();
    const readsAtDock = hoisted.reads;
    cellChanged(1, 1, "changed while hidden");
    await settle();
    expect(worker.cellChanges(), "no event may reach a pane nobody can see").toEqual([]);
    expect(hoisted.reads, "no read may be spent on a pane nobody can see").toBe(readsAtDock);
    expect(r.seedPatches()).toEqual([]);
  });

  it("reveal installs the watch; hide tears it down; reveal again re-installs it", async () => {
    const { worker, paneId } = await mountAndDock();
    r.visible(paneId);
    await untilReads(0, 2);
    // Visible: a change to the bound cell reaches the script as source "cell".
    cellChanged(1, 1, "seen");
    await vi.waitFor(() => expect(worker.cellChanges()).toEqual([{ name: "a", value: "seen" }]), { timeout: 2000 });
    expect(r.seedPatches().at(-1)?.seeds.a).toEqual({ value: "seen", display: "seen" });

    // Hidden: the same change delivers nothing and reads nothing.
    r.hidden(paneId);
    const readsWhenHidden = hoisted.reads;
    cellChanged(1, 1, "unseen");
    await settle();
    expect(worker.cellChanges(), "the watch must be torn down on hide").toEqual([{ name: "a", value: "seen" }]);
    expect(hoisted.reads).toBe(readsWhenHidden);

    // Visible again: the re-read delivers what is different now, then the
    // watch is live again.
    r.visible(paneId);
    await vi.waitFor(
      () => expect(worker.cellChanges()).toEqual([{ name: "a", value: "seen" }, { name: "a", value: "unseen" }]),
      { timeout: 2000 },
    );
    cellChanged(1, 1, "live again");
    await vi.waitFor(() => expect(worker.cellChanges().at(-1)).toEqual({ name: "a", value: "live again" }), {
      timeout: 2000,
    });
  });

  it("the pinned-sheet rule applies to the pane's watch: a change on another sheet is never shown", async () => {
    const { worker, paneId } = await mountAndDock();
    r.visible(paneId);
    await untilReads(0, 2);
    const reads = hoisted.reads;
    // The same (row, col) on Sheet2 — the tier clamp would admit it if the
    // user had switched there, but the pane is pinned to Sheet1.
    emitAppEvent(AppEvents.CELL_VALUES_CHANGED, {
      changes: [{ row: 1, col: 1, sheetIndex: 1, oldValue: "", newValue: "elsewhere" }],
      source: "user",
    });
    await settle();
    expect(worker.cellChanges()).toEqual([]);
    expect(hoisted.reads).toBe(reads);
  });

  it("closing the pane tears the watch down", async () => {
    const { worker, paneId } = await mountAndDock();
    r.visible(paneId);
    await untilReads(0, 2);
    r.close(paneId);
    const reads = hoisted.reads;
    cellChanged(1, 1, "after close");
    await settle();
    expect(worker.cellChanges()).toEqual([]);
    expect(hoisted.reads).toBe(reads);
  });
});

// ----------------------------------------------------------------------------
// 3. A reveal re-reads ONCE and announces only what differs
// ----------------------------------------------------------------------------

describe("a reveal re-reads the seeds", () => {
  const TWO: FormSpec = {
    children: [
      { type: "textbox", name: "a", label: "A", bind: "B2" },
      { type: "textbox", name: "c", label: "C", bind: "C2" },
    ],
  };

  it("an hour of changes while hidden collapses to one event per changed widget, none for an unchanged one", async () => {
    setCell(0, 1, 2, "steady");
    const { worker, paneId } = await mountAndDock(TWO);
    r.visible(paneId);
    await untilReads(0, 2);
    r.hidden(paneId);
    // Twenty edits to the bound cell while nobody can see the pane.
    for (let i = 1; i <= 20; i++) cellChanged(1, 1, `v${i}`);
    await settle();
    expect(worker.cellChanges()).toEqual([]);
    // Reveal: the cells are read again (two bound cells), the renderer gets
    // fresh seeds for both, and the script hears exactly ONE change — the
    // current value — and nothing about the widget whose cell did not move.
    const readsBefore = hoisted.reads;
    r.visible(paneId);
    await untilReads(readsBefore, 2);
    await vi.waitFor(() => expect(worker.cellChanges()).toEqual([{ name: "a", value: "v20" }]), { timeout: 2000 });
    await settle();
    expect(worker.cellChanges()).toEqual([{ name: "a", value: "v20" }]);
    const patch = r.seedPatches().at(-1)?.seeds;
    expect(patch?.a).toEqual({ value: "v20", display: "v20" });
    expect(patch?.c).toEqual({ value: "steady", display: "steady" });
    // The mirror carries the current picture in full.
    expect(worker.lastValues(paneId)).toEqual({ a: "v20", c: "steady" });
  });

  it("a reveal with nothing changed announces nothing", async () => {
    setCell(0, 1, 2, "steady");
    const { worker, paneId } = await mountAndDock(TWO);
    r.visible(paneId);
    await untilReads(0, 2);
    r.hidden(paneId);
    r.visible(paneId);
    await untilReads(2, 2);
    await settle();
    expect(worker.cellChanges()).toEqual([]);
  });

  it("a widget the user edited keeps their value across a reveal", async () => {
    const { worker, paneId } = await mountAndDock(TWO);
    r.visible(paneId);
    await untilReads(0, 2);
    // The user typed into `a`; the write lands; then the pane is hidden and
    // somebody else edits the same cell.
    r.change(paneId, "a", "mine", { a: "mine", c: "" });
    await vi.waitFor(() => expect(lib.updateCell).toHaveBeenCalledTimes(1), { timeout: 2000 });
    await settle();
    r.hidden(paneId);
    // Their edit is what the re-read sees; the user's widget is untouched
    // relative to the post-write seed, so it adopts the outside value.
    cellChanged(1, 1, "theirs");
    const readsBefore = hoisted.reads;
    r.visible(paneId);
    await untilReads(readsBefore, 2);
    await vi.waitFor(() => expect(worker.cellChanges()).toEqual([{ name: "a", value: "theirs" }]), { timeout: 2000 });
  });
});

// ----------------------------------------------------------------------------
// 4. The pane's own writes are not echoed back to it
// ----------------------------------------------------------------------------

describe("own writes are not echoed", () => {
  it("a writeOn:change write refreshes the seed with echo:false and the grid's echo is suppressed by the watch", async () => {
    const { worker, paneId } = await mountAndDock();
    r.visible(paneId);
    await untilReads(0, 2);
    r.change(paneId, "a", "typed", { a: "typed", b: null, c: "" });
    await vi.waitFor(() => expect(lib.updateCell).toHaveBeenCalledTimes(1), { timeout: 2000 });
    // The post-write refresh re-read the cell and handed the renderer the
    // fresh seed...
    await vi.waitFor(() => expect(r.seedPatches().at(-1)?.seeds.a).toEqual({ value: "typed", display: "typed" }), {
      timeout: 2000,
    });
    // ...and the grid's own CELL_VALUES_CHANGED for that write arrives, as it
    // does in production, within the own-write window.
    emitAppEvent(AppEvents.CELL_VALUES_CHANGED, {
      changes: [{ row: 1, col: 1, oldValue: "hello", newValue: "typed" }],
      source: "script",
    });
    await settle();
    // The script heard its user's keystroke once, and its own write never.
    const sources = (worker.events("onPaneChange") as Array<{ source: string }>).map((e) => e.source);
    expect(sources).toEqual(["user"]);
    expect(worker.cellChanges()).toEqual([]);
    // The read count is exactly: reveal re-read (2) + the post-write refresh (1).
    expect(hoisted.reads).toBe(3);
  });
});

// ----------------------------------------------------------------------------
// 5. The fan-out cap applies to a pane refresh
// ----------------------------------------------------------------------------

describe("the fan-out cap", () => {
  it("one flush touching more bound cells than the cap forwards at most MAX_FORM_CHANGE_FANOUT events, with the mirror in full", async () => {
    const count = MAX_FORM_CHANGE_FANOUT + 5;
    const wide: FormSpec = {
      children: Array.from({ length: count }, (_, i) => ({
        type: "textbox" as const,
        name: `t${i}`,
        label: `T${i}`,
        bind: `A${i + 1}`,
      })),
    };
    for (let i = 0; i < count; i++) setCell(0, i, 0, `old${i}`);
    const { worker, paneId } = await mountAndDock(wide);
    r.visible(paneId);
    await untilReads(count, count); // the reveal re-read, all unchanged
    await settle();
    expect(worker.cellChanges()).toEqual([]);
    // A paste over every bound cell: ONE flush, `count` changes.
    for (let i = 0; i < count; i++) setCell(0, i, 0, `new${i}`);
    emitAppEvent(AppEvents.CELL_VALUES_CHANGED, {
      changes: Array.from({ length: count }, (_, i) => ({ row: i, col: 0, oldValue: "", newValue: `new${i}` })),
      source: "user",
    });
    await untilReads(count * 2, count);
    await vi.waitFor(() => expect(worker.cellChanges()).toHaveLength(MAX_FORM_CHANGE_FANOUT), { timeout: 2000 });
    await settle();
    expect(worker.cellChanges()).toHaveLength(MAX_FORM_CHANGE_FANOUT);
    const mirrored = worker.lastValues(paneId)!;
    expect(Object.keys(mirrored)).toHaveLength(count);
    expect(mirrored[`t${count - 1}`]).toBe(`new${count - 1}`);
  });
});

// ----------------------------------------------------------------------------
// 6. Every close path flushes a pending text change FIRST
// ----------------------------------------------------------------------------
//
// A textbox's change waits FORM_TEXT_CHANGE_DEBOUNCE_MS before it is delivered
// and written. `endSession` used to clear that timer, so the last keystrokes
// before the band's X, a `pane.close()` or an unmount were never written —
// while the consent sentence promises "writes it back as soon as you change
// it, and closing the pane does not undo that". Through the REAL host: the
// flush takes the same audited `sheet.setCellValue` row, the same undo batch
// and the same pin check a timer expiry takes.

describe("a close inside the text debounce writes the pending change first", () => {
  const setCellRows = () =>
    getAuditTail().filter((e) => e.scriptId === SCRIPT_ID && e.method === "sheet.setCellValue");

  /** Type into the bound textbox and close INSIDE the debounce window; the cell must hold the text. */
  async function typeThenClose(
    close: (worker: FakeWorker, paneId: string) => void | Promise<void>,
  ): Promise<{ worker: FakeWorker; paneId: string }> {
    const { worker, paneId } = await mountAndDock();
    r.visible(paneId);
    await untilReads(0, 2);
    r.change(paneId, "a", "Paris", { a: "Paris", b: null, c: "" });
    // Inside the window: nothing has been written yet.
    expect(lib.updateCell).not.toHaveBeenCalled();
    await close(worker, paneId);
    await vi.waitFor(() => expect(lib.updateCell).toHaveBeenCalledTimes(1), { timeout: 2000 });
    // The timer that was holding it is gone: the debounce expiry writes nothing twice.
    await settle(FORM_TEXT_CHANGE_DEBOUNCE_MS + 60);
    expect(lib.updateCell).toHaveBeenCalledTimes(1);
    expect(lib.updateCell).toHaveBeenCalledWith(1, 1, "Paris");
    expect(hoisted.cells.get(key(0, 1, 1))?.value).toBe("Paris");
    expect(lib.beginUndoTransaction).toHaveBeenCalledWith("Pane: Status board");
    // Exactly ONE audited write row, and it says ok.
    expect(setCellRows().map((e) => e.ok)).toEqual([true]);
    return { worker, paneId };
  }

  it("the band's X: the cell holds the text, and the script heard the change BEFORE the close", async () => {
    const { worker, paneId } = await typeThenClose((_worker, id) => r.close(id));
    expect(r.closes).toEqual([{ paneId, reason: "user" }]);
    const hooks = worker.received
      .filter((m): m is Extract<H2W, { t: "event" }> => m.t === "event")
      .map((m) => m.hook);
    expect(hooks.filter((h) => h === "onPaneChange")).toHaveLength(1);
    expect(hooks.indexOf("onPaneChange")).toBeLessThan(hooks.indexOf("onPaneClose"));
    expect((worker.events("onPaneChange")[0] as { value: unknown; source: string })).toMatchObject({
      value: "Paris",
      source: "user",
    });
  });

  it("pane.close(): the same", async () => {
    const { paneId } = await typeThenClose(async (worker, id) => {
      const result = await worker.call(2, "pane.close", [id]);
      expect(result.ok, result.error?.message).toBe(true);
    });
    expect(r.closes).toEqual([{ paneId, reason: "script" }]);
  });

  it("the script's unmount: the write is host-executed and still lands; the terminated realm is told nothing", async () => {
    // hostUnmountScript terminates the worker BEFORE it revokes the panes, so
    // the flush runs against a dead realm: the cell write goes through the
    // broker under the script's handle as it would have a moment earlier
    // (the user made this change while the script was alive), and no event
    // is posted into a worker that cannot read it.
    const { worker, paneId } = await typeThenClose(() => host.hostUnmountScript(SCRIPT_ID));
    expect(r.closes).toEqual([{ paneId, reason: "unmount" }]);
    expect(worker.terminated).toBe(true);
    expect(worker.events("onPaneChange")).toEqual([]);
    expect(worker.events("onPaneClose")).toEqual([]);
  });

  /**
   * ...AND THE ONE CLOSE THAT MUST NOT WRITE. `hostResetAll` is the workbook
   * swap (File > New / File > Open / close), and it sweeps from AFTER_OPEN /
   * AFTER_NEW — after the document has already been replaced. It used to reach
   * the panes through the per-script unmounts above, closing them as "unmount",
   * which FLUSHES: the text the user typed into the old workbook was written
   * into the NEW workbook's cell of the same address, in a document they never
   * typed into. The swap now sweeps the panes itself, first, as "reset".
   */
  it("a workbook swap inside the debounce writes NOTHING into the workbook that replaced it, and says so", async () => {
    const { paneId } = await mountAndDock();
    r.visible(paneId);
    await untilReads(0, 2);
    r.change(paneId, "a", "Paris", { a: "Paris", b: null, c: "" });
    expect(lib.updateCell).not.toHaveBeenCalled();
    // File > New / File > Open: the document under the pane is already gone.
    host.hostResetAll();
    await settle(FORM_TEXT_CHANGE_DEBOUNCE_MS + 60);
    expect(lib.updateCell).not.toHaveBeenCalled();
    expect(lib.updateCellsBatch).not.toHaveBeenCalled();
    expect(setCellRows()).toEqual([]);
    expect(hoisted.cells.get(key(0, 1, 1))?.value).toBe("hello");
    // The pane closed as the swap, not as an unmount — that is the difference
    // the flush decision is made on.
    expect(r.closes).toEqual([{ paneId, reason: "reset" }]);
    expect(listScriptPanes()).toEqual([]);
    // ...and the user learns that what they typed reached no cell.
    expect(hoisted.toasts).toHaveLength(1);
    expect(hoisted.toasts[0]).toContain('your last edit to "a" was not saved to its cell');
    expect(hoisted.toasts[0]).toContain("enter the value in the cell directly");
  });

  it("a REFUSED flush (the user had left the pinned sheet) is audited as a refused write and surfaced as a toast", async () => {
    const { paneId } = await mountAndDock();
    r.visible(paneId);
    await untilReads(0, 2);
    r.change(paneId, "a", "Paris", { a: "Paris", b: null, c: "" });
    hoisted.activeSheet = 1;
    r.close(paneId);
    await vi.waitFor(() => expect(hoisted.toasts).toHaveLength(1), { timeout: 2000 });
    // The band is gone, so the refusal cannot go there — and it must not go nowhere.
    expect(r.messages()).toEqual([]);
    expect(hoisted.toasts[0]).toContain('"a" was not saved to its cell when the pane closed');
    expect(hoisted.toasts[0]).toContain('switch back to "Sheet1" to save this pane');
    expect(hoisted.toasts[0]).toContain("enter the value in the cell directly");
    expect(lib.updateCell).not.toHaveBeenCalled();
    expect(hoisted.cells.get(key(0, 1, 1))?.value).toBe("hello");
    // A refusal decided before any broker row still leaves its trace: one
    // refused write row under this script.
    expect(setCellRows().map((e) => [e.ok, e.error])).toEqual([[false, "HostError"]]);
  });
});

// ----------------------------------------------------------------------------
// 7. A reveal while the user is on another sheet honours the pin
// ----------------------------------------------------------------------------
//
// Restricted reads take the ACTIVE sheet. Re-reading a pane pinned to Sheet1
// while the user is on Sheet2 (close the sidebar, switch sheets, open the
// sidebar) used to refuse every bound cell under the tier clamp, charge the
// script a denial per cell for a gesture the USER made, adopt `null` as each
// widget's value and announce it to the script as a cell that became empty.

describe("a reveal while the user is on another sheet", () => {
  const TWO: FormSpec = {
    children: [
      { type: "textbox", name: "a", label: "A", bind: "B2" },
      { type: "textbox", name: "c", label: "C", bind: "C2" },
    ],
  };
  const PIN = 'switch back to "Sheet1" to see and save this pane\'s cells';
  const switchTo = (index: number): void => {
    hoisted.activeSheet = index;
    emitAppEvent(AppEvents.SHEET_CHANGED, { sheetIndex: index });
  };
  const deniedReads = () =>
    getAuditTail().filter((e) => e.scriptId === SCRIPT_ID && e.method === "sheet.getCellData" && !e.ok);

  it("reads nothing, announces nothing, disables the bound widgets under the PIN sentence — and comes back when the user does", async () => {
    setCell(0, 1, 2, "steady");
    const { worker, paneId } = await mountAndDock(TWO);
    r.visible(paneId);
    // The reveal re-read must have LANDED (the dock's two reads satisfy
    // `untilReads(0, 2)` on their own) before the sheet switches, or the reads
    // still in flight are what gets refused.
    await untilReads(2, 2);
    r.hidden(paneId);
    switchTo(1);
    const readsBefore = hoisted.reads;
    const patchesBefore = r.patches.length;
    r.visible(paneId);
    await vi.waitFor(() => expect(r.patches.length).toBeGreaterThan(patchesBefore), { timeout: 2000 });
    await settle();
    // No read was spent (none could have been admitted), no denial was charged
    // to the script, nothing was announced, and the mirror is untouched.
    expect(hoisted.reads).toBe(readsBefore);
    expect(deniedReads()).toEqual([]);
    expect(worker.cellChanges()).toEqual([]);
    expect(worker.lastValues(paneId)).toEqual({ a: "hello", c: "steady" });
    // The widgets keep their LAST value and are disabled under the pin
    // sentence — the write refusal's family, never the tier clamp's.
    const off = r.patches[r.patches.length - 1];
    expect(off.seeds?.a).toEqual({ value: "hello", display: "hello", readOnly: true, reason: PIN });
    expect(off.seeds?.c).toEqual({ value: "steady", display: "steady", readOnly: true, reason: PIN });
    // HOST chrome, in the host's own slot — never the script's `message`.
    expect(off.patch).toBeUndefined();
    expect(off.hostBindingNotice?.kind).toBe("warning");
    expect(off.hostBindingNotice?.text).toContain(PIN);
    expect(off.hostBindingNotice?.text).not.toContain(RESTRICTED_SHEET_CLAMP_MESSAGE);
    // Off-sheet the live watch is NOT installed: a change on the pinned sheet
    // reads nothing now...
    setCell(0, 1, 1, "moved");
    emitAppEvent(AppEvents.CELL_VALUES_CHANGED, {
      changes: [{ row: 1, col: 1, sheetIndex: 0, oldValue: "hello", newValue: "moved" }],
      source: "user",
    });
    await settle();
    expect(hoisted.reads).toBe(readsBefore);
    expect(worker.cellChanges()).toEqual([]);
    // ...and the user's return re-reads ONCE: the banner is taken back, the
    // widgets come back enabled with the cells' current values, and the
    // script hears only what differs.
    switchTo(0);
    await untilReads(readsBefore, 2);
    await vi.waitFor(() => expect(worker.cellChanges()).toEqual([{ name: "a", value: "moved" }]), { timeout: 2000 });
    await settle();
    expect(hoisted.reads).toBe(readsBefore + 2);
    expect(worker.cellChanges()).toEqual([{ name: "a", value: "moved" }]);
    expect(r.patches.some((p) => p.hostBindingNotice === null)).toBe(true);
    // The clear names the HOST's slot only: nothing the host sends here can
    // touch a message the script put up while the user was away.
    expect(r.patches.every((p) => p.patch?.message !== null)).toBe(true);
    const back = r.seedPatches()[r.seedPatches().length - 1].seeds;
    expect(back.a).toEqual({ value: "moved", display: "moved" });
    expect(back.c).toEqual({ value: "steady", display: "steady" });
    expect(worker.lastValues(paneId)).toEqual({ a: "moved", c: "steady" });
    // The watch is live again.
    cellChanged(1, 1, "live");
    await vi.waitFor(() => expect(worker.cellChanges()[worker.cellChanges().length - 1]).toEqual({ name: "a", value: "live" }), {
      timeout: 2000,
    });
  });

  it("hiding the pane while off-sheet drops the return listener: coming back to the sheet then reads nothing", async () => {
    setCell(0, 1, 2, "steady");
    const { worker, paneId } = await mountAndDock(TWO);
    r.visible(paneId);
    // The reveal re-read must have LANDED (the dock's two reads satisfy
    // `untilReads(0, 2)` on their own) before the sheet switches, or the reads
    // still in flight are what gets refused.
    await untilReads(2, 2);
    r.hidden(paneId);
    switchTo(1);
    r.visible(paneId);
    await vi.waitFor(() => expect(r.patches[r.patches.length - 1]?.hostBindingNotice?.kind).toBe("warning"), {
      timeout: 2000,
    });
    r.hidden(paneId);
    const reads = hoisted.reads;
    switchTo(0);
    await settle();
    expect(hoisted.reads).toBe(reads);
    expect(worker.cellChanges()).toEqual([]);
  });

  it("an unlocked script is not pinned: the reveal re-reads its cells whatever sheet the user is on", async () => {
    setCell(0, 1, 2, "steady");
    const { worker, paneId } = await mountAndDock(TWO, { ...DEFINITION, accessLevel: "unlocked" });
    expect(r.last().pinnedSheetName).toBeUndefined();
    r.visible(paneId);
    // The reveal re-read must have LANDED (the dock's two reads satisfy
    // `untilReads(0, 2)` on their own) before the sheet switches, or the reads
    // still in flight are what gets refused.
    await untilReads(2, 2);
    r.hidden(paneId);
    switchTo(1);
    setCell(0, 1, 1, "moved");
    const readsBefore = hoisted.reads;
    r.visible(paneId);
    await untilReads(readsBefore, 2);
    await vi.waitFor(() => expect(worker.cellChanges()).toEqual([{ name: "a", value: "moved" }]), { timeout: 2000 });
    const last = r.patches[r.patches.length - 1];
    expect(last.seeds?.a).toEqual({ value: "moved", display: "moved" });
    expect(last.patch?.message).toBeUndefined();
    expect(r.patches.every((p) => p.hostBindingNotice === undefined)).toBe(true);
    expect(hoisted.toasts).toEqual([]);
  });

  // The notice is the host's sentence about a lock the host is applying, so it
  // must not share a slot with the script's own text. It did: it went out as
  // `patch: { message }`, which gave one slot two owners — the script painted
  // over the host's sentence while the host kept its widgets disabled, and the
  // host's clear on the user's return deleted the script's message.
  it("the off-sheet notice is host chrome: a script's message cannot displace it, and the return does not wipe the script's message", async () => {
    setCell(0, 1, 2, "steady");
    const { worker, paneId } = await mountAndDock(TWO);
    r.visible(paneId);
    await untilReads(2, 2);
    r.hidden(paneId);
    switchTo(1);
    r.visible(paneId);
    await vi.waitFor(() => expect(r.patches[r.patches.length - 1]?.hostBindingNotice?.kind).toBe("warning"), {
      timeout: 2000,
    });
    // The script says its own thing while the user is away. It lands in the
    // script's slot and leaves the host's notice standing (the host slot is
    // absent from the patch, so the renderer's store keeps what it has).
    const scriptSays = { text: "Refreshing your figures...", kind: "info" as const };
    const said = await worker.call(9, "pane.update", [paneId, { message: scriptSays }]);
    expect(said.ok, said.error?.message).toBe(true);
    await settle();
    const fromScript = r.patches[r.patches.length - 1];
    expect(fromScript.patch?.message).toEqual(scriptSays);
    expect(fromScript.hostBindingNotice).toBeUndefined();
    // The user comes back: the host takes its OWN notice down and says nothing
    // at all about `message`, so what the script put up is still up.
    switchTo(0);
    await vi.waitFor(() => expect(r.patches.some((p) => p.hostBindingNotice === null)).toBe(true), { timeout: 2000 });
    await settle();
    expect(r.patches.filter((p) => p.patch?.message !== undefined).map((p) => p.patch?.message)).toEqual([scriptSays]);
  });

  // The renderer's store outlives the section component, so a notice put up
  // before a hide is still on the pane at the next reveal. The clear on the
  // pinned sheet is therefore unconditional, not gated on "this visibility
  // announced it" — otherwise the sentence stayed over re-enabled widgets.
  it("a notice left over from a hidden pane is cleared by the next reveal on the pinned sheet", async () => {
    setCell(0, 1, 2, "steady");
    const { paneId } = await mountAndDock(TWO);
    r.visible(paneId);
    await untilReads(2, 2);
    r.hidden(paneId);
    switchTo(1);
    r.visible(paneId);
    await vi.waitFor(() => expect(r.patches[r.patches.length - 1]?.hostBindingNotice?.kind).toBe("warning"), {
      timeout: 2000,
    });
    // Hidden while off-sheet (the return listener goes with it), then the user
    // walks back to Sheet1 and reveals the pane again.
    r.hidden(paneId);
    switchTo(0);
    await settle();
    const before = r.patches.length;
    r.visible(paneId);
    await vi.waitFor(() => expect(r.patches.slice(before).some((p) => p.hostBindingNotice === null)).toBe(true), {
      timeout: 2000,
    });
  });

  // The notice is only HALF of what an off-sheet reveal leaves in the renderer's
  // store. The same patch disables every bound widget under the pin sentence,
  // and a seed stands until a later seed replaces it — so taking the sentence
  // down without re-seeding would hand the user a pane whose widgets are locked
  // with nothing on screen saying why, which is a worse lie than the stale
  // sentence. The reveal back on the pinned sheet owes the pane BOTH: the
  // sentence retracted and every bound name re-seeded from the cell as it
  // stands now. The test above stops at the sentence; this one is the widgets.
  it("the bound widgets an off-sheet hide left disabled come back enabled, and holding what the cells hold now", async () => {
    setCell(0, 1, 2, "steady");
    const { worker, paneId } = await mountAndDock(TWO);
    r.visible(paneId);
    await untilReads(2, 2);
    r.hidden(paneId);
    switchTo(1);
    r.visible(paneId);
    await vi.waitFor(() => expect(r.patches[r.patches.length - 1]?.hostBindingNotice?.kind).toBe("warning"), {
      timeout: 2000,
    });
    // Both bound widgets are locked under the pin sentence at this point.
    const off = r.patches[r.patches.length - 1];
    expect(off.seeds?.a).toEqual({ value: "hello", display: "hello", readOnly: true, reason: PIN });
    expect(off.seeds?.c).toEqual({ value: "steady", display: "steady", readOnly: true, reason: PIN });
    // Hidden while off-sheet, so the return listener goes with it: nothing is
    // watching when the user walks back, and a cell moves while nobody looks.
    r.hidden(paneId);
    switchTo(0);
    setCell(0, 1, 1, "moved");
    await settle();
    const reads = hoisted.reads;
    const patchesBefore = r.patches.length;
    const seedsBefore = r.seedPatches().length;
    r.visible(paneId);
    await untilReads(reads, 2);
    await vi.waitFor(() => expect(r.seedPatches().length).toBeGreaterThan(seedsBefore), { timeout: 2000 });
    await settle();
    // Every bound name is re-seeded WITHOUT the lock — an exact match, so a
    // lingering `readOnly` / `reason` fails here — and with the cell's value as
    // it stands now, not the one the widget was frozen at.
    const back = r.seedPatches()[r.seedPatches().length - 1].seeds;
    expect(back.a).toEqual({ value: "moved", display: "moved" });
    expect(back.c).toEqual({ value: "steady", display: "steady" });
    // ...and the sentence that explained the lock comes down in the same reveal.
    expect(r.patches.slice(patchesBefore).some((p) => p.hostBindingNotice === null)).toBe(true);
    // The script's mirror agrees with what the user can now see and edit.
    expect(worker.lastValues(paneId)).toEqual({ a: "moved", c: "steady" });
  });
});

// ----------------------------------------------------------------------------
// 8. The pin is a sheet IDENTITY, not a sheet index
// ----------------------------------------------------------------------------
//
// A sheet index is not a stable identity in this workbook: deleting a tab or
// dragging one makes another sheet inherit an index. The pane recorded its pin
// as an index and compared it as one on every reveal and on every live-watch
// intersection, so a workbook the USER reorganised with a pane docked left the
// pane aimed at whatever sheet had taken that index — it re-read THAT sheet's
// cells at the pinned coordinates, painted them in its widgets and announced
// them to the script as its bound values, and raised or retracted its off-sheet
// notice against the wrong sheet ("switch back to Sheet1" to a user already
// standing on Sheet1, which no navigation can satisfy).
//
// The write path had asked by NAME since the forms work of 2026-09-03
// (`sheetIdentityRefusal`); the read path had inherited only half of that rule.

describe("the pane's pinned sheet is an identity, not an index", () => {
  const ONE: FormSpec = { children: [{ type: "textbox", name: "a", label: "A", bind: "B2" }] };
  /** What `sheetIdentityRefusal` says when the PIN's index no longer names the pinned sheet. */
  const GONE =
    '"Sheet1" is no longer where this pane opened (the workbook\'s sheets changed) — close the pane and open it again';
  const lastPatch = (): ScriptPanePatchPayload => r.patches[r.patches.length - 1];
  const refusedReads = () => getAuditTail().filter((e) => e.scriptId === SCRIPT_ID && !e.ok && e.class === "read");

  it("deleting the pinned sheet: the reveal reads NOTHING from the sheet that inherited its index", async () => {
    // Sheet2 holds a value at the very address the pane is bound to. If the
    // pane follows the INDEX, this is what it reads, paints and announces.
    setCell(1, 1, 1, "SHEET2 PRIVATE");
    const { worker, paneId } = await mountAndDock(ONE);
    expect(r.last().seeds.a).toEqual({ value: "hello", display: "hello" });
    expect(r.last().pinnedSheetName).toBe("Sheet1");
    r.visible(paneId);
    await untilReads(1, 1);
    r.hidden(paneId);
    // The user deletes Sheet1. Sheet2 becomes index 0 — the pane's pin — and is
    // what the user is now looking at.
    reshuffleSheets([{ from: 1, name: "Sheet2" }]);
    const readsBefore = hoisted.reads;
    const patchesBefore = r.patches.length;
    r.visible(paneId);
    await vi.waitFor(() => expect(r.patches.length).toBeGreaterThan(patchesBefore), { timeout: 2000 });
    await settle();
    // Not one cell was read, and no other sheet's value reached the script —
    // neither as an onPaneChange nor over the mirror.
    expect(worker.cellChanges()).toEqual([]);
    expect(hoisted.reads).toBe(readsBefore);
    expect(worker.lastValues(paneId)).toEqual({ a: "hello" });
    // The widget keeps its last value, disabled under a sentence that is TRUE
    // (Sheet1 is gone) and followable (closing the pane is something the user
    // can do; switching back to a deleted sheet is not).
    expect(lastPatch().seeds?.a).toEqual({ value: "hello", display: "hello", readOnly: true, reason: GONE });
    expect(lastPatch().hostBindingNotice).toEqual({ text: GONE, kind: "error" });
    // HOST chrome, in the host's own slot — never the script's `message`.
    expect(lastPatch().patch).toBeUndefined();
    // A reveal that reads nothing must not look, in the transparency panel,
    // like a pane that simply had nothing to do.
    expect(refusedReads().map((e) => [e.method, e.error])).toEqual([["sheet.getCellData", "HostError"]]);
  });

  it("reordering so another sheet takes the pinned index: the pane refuses instead of re-aiming", async () => {
    setCell(1, 1, 1, "SHEET2 PRIVATE");
    const { worker, paneId } = await mountAndDock(ONE);
    r.visible(paneId);
    await untilReads(1, 1);
    r.hidden(paneId);
    // The user drags Sheet2 in front. Sheet1 is index 1 now — and the user is
    // standing on Sheet1, the sheet the pane is bound to.
    reshuffleSheets([
      { from: 1, name: "Sheet2" },
      { from: 0, name: "Sheet1" },
    ]);
    hoisted.activeSheet = 1;
    const readsBefore = hoisted.reads;
    const patchesBefore = r.patches.length;
    r.visible(paneId);
    await vi.waitFor(() => expect(r.patches.length).toBeGreaterThan(patchesBefore), { timeout: 2000 });
    await settle();
    expect(hoisted.reads).toBe(readsBefore);
    expect(worker.cellChanges()).toEqual([]);
    // The PIN sentence would be a lie here — it would tell a user already on
    // Sheet1 to switch back to Sheet1 — and unfollowable, because the index it
    // is waiting for belongs to another sheet now.
    expect(lastPatch().hostBindingNotice).toEqual({ text: GONE, kind: "error" });
    expect(lastPatch().hostBindingNotice?.text).not.toContain("switch back");
    // The WRITE says what the reveal said. Both refusals apply here — the user
    // is off the pinned INDEX and the pinned NAME has moved — and the write
    // must reach for the identity one first, because the pin's would again be
    // the impossible "switch back to Sheet1" aimed at someone on Sheet1.
    r.change(paneId, "a", "typed", { a: "typed" });
    await vi.waitFor(() => expect(r.messages()).toHaveLength(1), { timeout: 2000 });
    expect(r.messages()[0]).toEqual({ text: GONE, kind: "error" });
    expect(lib.updateCell).not.toHaveBeenCalled();
    // Walking onto the sheet that INHERITED the pinned index does not satisfy
    // the pin: nothing is read, nothing is announced, the lock stays up.
    const afterRefusal = r.patches.length;
    hoisted.activeSheet = 0;
    emitAppEvent(AppEvents.SHEET_CHANGED, { sheetIndex: 0 });
    await settle();
    expect(hoisted.reads).toBe(readsBefore);
    expect(worker.cellChanges()).toEqual([]);
    expect(r.patches.slice(afterRefusal).some((p) => p.hostBindingNotice === null)).toBe(false);
    // Sheet2's cell — the one at the pinned index — is untouched.
    expect(hoisted.cells.get(key(0, 1, 1))?.value).toBe("SHEET2 PRIVATE");
  });

  it("sheets moved while the pane is ARMED: the live watch reads nothing and locks the pane", async () => {
    setCell(1, 1, 1, "SHEET2 PRIVATE");
    const { worker, paneId } = await mountAndDock(ONE);
    r.visible(paneId);
    await untilReads(1, 1);
    // A script or an MCP tool drags Sheet2 in front while the pane is visible.
    // No SHEET_CHANGED follows, so nothing re-settles and the watch is still
    // armed on index 0 — which is Sheet2 now.
    reshuffleSheets([
      { from: 1, name: "Sheet2" },
      { from: 0, name: "Sheet1" },
    ]);
    const readsBefore = hoisted.reads;
    const patchesBefore = r.patches.length;
    emitAppEvent(AppEvents.CELL_VALUES_CHANGED, {
      changes: [{ row: 1, col: 1, sheetIndex: 0, oldValue: "", newValue: "SHEET2 PRIVATE" }],
      source: "user",
    });
    await vi.waitFor(() => expect(r.patches.length).toBeGreaterThan(patchesBefore), { timeout: 2000 });
    await settle();
    expect(hoisted.reads).toBe(readsBefore);
    expect(worker.cellChanges()).toEqual([]);
    expect(lastPatch().hostBindingNotice).toEqual({ text: GONE, kind: "error" });
    // The watch goes down with the identity: a second change spends nothing.
    emitAppEvent(AppEvents.CELL_VALUES_CHANGED, {
      changes: [{ row: 1, col: 1, sheetIndex: 0, oldValue: "", newValue: "again" }],
      source: "user",
    });
    await settle();
    expect(hoisted.reads).toBe(readsBefore);
    expect(worker.cellChanges()).toEqual([]);
  });

  // The unlocked tier was the WORSE half of this: with no pin at all it skipped
  // the sheet comparison entirely and re-read `cell.sheetIndex` outright, with
  // no tier clamp behind it either. The identity is what both tiers share.
  it("an UNLOCKED pane is not pinned, and still may not follow a deleted sheet's index", async () => {
    setCell(1, 1, 1, "SHEET2 PRIVATE");
    const { worker, paneId } = await mountAndDock(ONE, { ...DEFINITION, accessLevel: "unlocked" });
    expect(r.last().pinnedSheetName).toBeUndefined();
    r.visible(paneId);
    await untilReads(1, 1);
    r.hidden(paneId);
    reshuffleSheets([{ from: 1, name: "Sheet2" }]);
    const readsBefore = hoisted.reads;
    const patchesBefore = r.patches.length;
    r.visible(paneId);
    await vi.waitFor(() => expect(r.patches.length).toBeGreaterThan(patchesBefore), { timeout: 2000 });
    await settle();
    expect(hoisted.reads).toBe(readsBefore);
    expect(worker.cellChanges()).toEqual([]);
    // No pin to name, so the refusal names the BINDING whose sheet moved.
    expect(lastPatch().hostBindingNotice).toEqual({
      text:
        '"a" was read from "Sheet1", which has moved or been removed (that position now holds "Sheet2") — ' +
        "close the pane and open it again",
      kind: "error",
    });
  });

  // The identity check must not fire on a workbook that did not change: the
  // ordinary "you walked off the pinned sheet" case is a WARNING that lifts by
  // itself when the user walks back, and must keep saying so.
  it("an unchanged workbook still gets the ordinary off-sheet notice, and the return still re-reads", async () => {
    const { paneId } = await mountAndDock(ONE);
    r.visible(paneId);
    await untilReads(1, 1);
    r.hidden(paneId);
    hoisted.activeSheet = 1;
    emitAppEvent(AppEvents.SHEET_CHANGED, { sheetIndex: 1 });
    const patchesBefore = r.patches.length;
    r.visible(paneId);
    await vi.waitFor(() => expect(r.patches.length).toBeGreaterThan(patchesBefore), { timeout: 2000 });
    await settle();
    expect(lastPatch().hostBindingNotice?.kind).toBe("warning");
    expect(lastPatch().hostBindingNotice?.text).toContain('switch back to "Sheet1" to see and save this pane\'s cells');
    expect(lastPatch().hostBindingNotice?.text).not.toContain("no longer where this pane opened");
    // The user walks back: the notice comes down and the cell is re-read.
    const afterOff = r.patches.length;
    const readsBefore = hoisted.reads;
    setCell(0, 1, 1, "moved");
    hoisted.activeSheet = 0;
    emitAppEvent(AppEvents.SHEET_CHANGED, { sheetIndex: 0 });
    await untilReads(readsBefore, 1);
    await vi.waitFor(() => expect(r.patches.slice(afterOff).some((p) => p.hostBindingNotice === null)).toBe(true), {
      timeout: 2000,
    });
  });
});

// ----------------------------------------------------------------------------
// 9. Leaving the sheet with the pane ON SCREEN is the same event as revealing
//    it off-sheet
// ----------------------------------------------------------------------------
//
// The off-sheet rule above was produced only by a REVEAL: `visible` -> settle.
// So hiding the pane, switching sheets and revealing it announced the pin —
// while switching sheets with the pane in front of the user did NOTHING. They
// were left looking at fully enabled widgets holding the PREVIOUS sheet's
// values, and learned the truth only afterwards, when their typing was refused
// into the script's own message slot. Every other surface in this family says
// it before the user types.
//
// The pin is a fact about the workbook, not about which renderer input arrived,
// so the SHEET_CHANGED watch runs for as long as a pinned pane is visible: it
// sees the departure and the return alike, and nothing while the pane is
// hidden or closed.

describe("the sheet under a VISIBLE pane is watched, not only the reveal", () => {
  const TWO: FormSpec = {
    children: [
      { type: "textbox", name: "a", label: "A", bind: "B2" },
      { type: "textbox", name: "c", label: "C", bind: "C2" },
    ],
  };
  const PIN = 'switch back to "Sheet1" to see and save this pane\'s cells';
  const switchTo = (index: number): void => {
    hoisted.activeSheet = index;
    emitAppEvent(AppEvents.SHEET_CHANGED, { sheetIndex: index });
  };
  const deniedReads = () =>
    getAuditTail().filter((e) => e.scriptId === SCRIPT_ID && e.method === "sheet.getCellData" && !e.ok);

  /**
   * SHEET_CHANGED listeners added minus removed on `window` since this was
   * installed — so it is a DELTA and needs no assumption about how many
   * listeners the host already holds (`wireActiveSheet` adds one, once, at the
   * first mount of the session).
   *
   * THE TEARDOWN HAS TO BE ASSERTED DIRECTLY. Two independent guards silence a
   * leaked sheet watch: `stopWatching` bumps `epoch`, AND it drops the
   * listener. A test that only checks "the hidden pane read nothing and was
   * told nothing" therefore stays green with `sheetWatch?.(); sheetWatch =
   * null;` deleted — it pins the epoch guard and says nothing about the
   * listener, which would then sit on `window` for the rest of the workbook's
   * session, waking a settle per sheet tab the user clicks, for every pane ever
   * hidden. `onAppEvent` is `window.addEventListener`, so counting is the whole
   * probe.
   */
  function sheetWatchCounter(): { net: () => number; stop: () => void } {
    const added = vi.spyOn(window, "addEventListener");
    const removed = vi.spyOn(window, "removeEventListener");
    const count = (spy: typeof added): number =>
      spy.mock.calls.filter((call) => call[0] === AppEvents.SHEET_CHANGED).length;
    return {
      net: () => count(added) - count(removed),
      stop: () => {
        added.mockRestore();
        removed.mockRestore();
      },
    };
  }

  /** A visible, armed pane on its pinned sheet, with both bound cells read once. */
  async function visibleOnSheet1(): Promise<{ worker: FakeWorker; paneId: string }> {
    setCell(0, 1, 2, "steady");
    const { worker, paneId } = await mountAndDock(TWO);
    r.visible(paneId);
    // The reveal re-read must have LANDED before the sheet moves, or what the
    // departure tears down is a read already in flight.
    await untilReads(2, 2);
    await settle();
    return { worker, paneId };
  }

  it("the user switches sheets with the pane in front of them: the notice goes up, nothing is read and nothing is announced", async () => {
    const { worker, paneId } = await visibleOnSheet1();
    const readsBefore = hoisted.reads;
    const patchesBefore = r.patches.length;
    // No hide: the pane is on screen the whole time, exactly as it is when the
    // user clicks another sheet tab.
    switchTo(1);
    await vi.waitFor(() => expect(r.patches.length).toBeGreaterThan(patchesBefore), { timeout: 2000 });
    await settle();
    // The same settlement a reveal off-sheet produces: no read was spent, no
    // denial was charged to the script for the USER's gesture, nothing was
    // announced, and the mirror still holds what the widgets hold.
    expect(hoisted.reads).toBe(readsBefore);
    expect(deniedReads()).toEqual([]);
    expect(worker.cellChanges()).toEqual([]);
    expect(worker.lastValues(paneId)).toEqual({ a: "hello", c: "steady" });
    const off = r.patches[r.patches.length - 1];
    expect(off.seeds?.a).toEqual({ value: "hello", display: "hello", readOnly: true, reason: PIN });
    expect(off.seeds?.c).toEqual({ value: "steady", display: "steady", readOnly: true, reason: PIN });
    // HOST chrome, in the host's own slot — never the script's `message`.
    expect(off.patch).toBeUndefined();
    expect(off.hostBindingNotice).toEqual({
      text: `The cells this pane is bound to are on "Sheet1" — ${PIN}`,
      kind: "warning",
    });
    // The live watch went down with the departure: a change on the pinned sheet
    // is neither read nor announced while the user is away.
    setCell(0, 1, 1, "moved");
    emitAppEvent(AppEvents.CELL_VALUES_CHANGED, {
      changes: [{ row: 1, col: 1, sheetIndex: 0, oldValue: "hello", newValue: "moved" }],
      source: "user",
    });
    await settle();
    expect(hoisted.reads).toBe(readsBefore);
    expect(worker.cellChanges()).toEqual([]);
    // Walking on to a THIRD sheet is still one departure: the notice is not
    // re-announced per sheet tab the user visits.
    const afterOff = r.patches.length;
    hoisted.sheets = [...hoisted.sheets, { index: 2, name: "Sheet3" }];
    switchTo(2);
    await settle();
    expect(r.patches.slice(afterOff)).toEqual([]);
  });

  it("the user walks back: the notice comes down, the widgets are enabled again, and only what changed is announced", async () => {
    const { worker, paneId } = await visibleOnSheet1();
    switchTo(1);
    await vi.waitFor(() => expect(r.patches[r.patches.length - 1]?.hostBindingNotice?.kind).toBe("warning"), {
      timeout: 2000,
    });
    // A cell moves while the pane is locked and nobody is reading it.
    setCell(0, 1, 1, "moved");
    await settle();
    const readsBefore = hoisted.reads;
    const patchesBefore = r.patches.length;
    switchTo(0);
    await untilReads(readsBefore, 2);
    await vi.waitFor(() => expect(worker.cellChanges()).toEqual([{ name: "a", value: "moved" }]), { timeout: 2000 });
    await settle();
    // Both bound cells are re-read once; only the one that differs is
    // announced to the script.
    expect(hoisted.reads).toBe(readsBefore + 2);
    expect(worker.cellChanges()).toEqual([{ name: "a", value: "moved" }]);
    expect(r.patches.slice(patchesBefore).some((p) => p.hostBindingNotice === null)).toBe(true);
    // Every bound name comes back WITHOUT the lock — an exact match, so a
    // lingering `readOnly` / `reason` fails here.
    const back = r.seedPatches()[r.seedPatches().length - 1].seeds;
    expect(back.a).toEqual({ value: "moved", display: "moved" });
    expect(back.c).toEqual({ value: "steady", display: "steady" });
    expect(worker.lastValues(paneId)).toEqual({ a: "moved", c: "steady" });
    // And the live watch is armed again.
    cellChanged(1, 1, "live");
    await vi.waitFor(
      () => expect(worker.cellChanges()[worker.cellChanges().length - 1]).toEqual({ name: "a", value: "live" }),
      { timeout: 2000 },
    );
  });

  it("hiding the pane takes the sheet watch with it: the listener is REMOVED, not merely silenced", async () => {
    const { worker, paneId } = await visibleOnSheet1();
    // Installed with the pane already armed, so the watch's own registration is
    // before the window: hiding must show exactly one net REMOVAL and no add.
    const watchers = sheetWatchCounter();
    expect(watchers.net()).toBe(0);
    r.hidden(paneId);
    expect(watchers.net(), "the SHEET_CHANGED listener must be removed on hide, not just ignored").toBe(-1);
    watchers.stop();
    const readsBefore = hoisted.reads;
    const patchesBefore = r.patches.length;
    switchTo(1);
    await settle();
    // A hidden pane must never read, and must not be painted either: the
    // renderer's store keeps what it had until the next reveal settles it.
    expect(hoisted.reads).toBe(readsBefore);
    expect(r.patches.slice(patchesBefore)).toEqual([]);
    expect(worker.cellChanges()).toEqual([]);
    // The reveal is what settles it — off-sheet, so the notice goes up there.
    r.visible(paneId);
    await vi.waitFor(() => expect(r.patches[r.patches.length - 1]?.hostBindingNotice?.kind).toBe("warning"), {
      timeout: 2000,
    });
    expect(hoisted.reads).toBe(readsBefore);
  });

  it("closing the pane takes the sheet watch with it: the listener is REMOVED, not merely silenced", async () => {
    const { worker, paneId } = await visibleOnSheet1();
    const watchers = sheetWatchCounter();
    expect(watchers.net()).toBe(0);
    r.close(paneId);
    await settle();
    expect(watchers.net(), "the SHEET_CHANGED listener must be removed on close, not just ignored").toBe(-1);
    watchers.stop();
    const readsBefore = hoisted.reads;
    const patchesBefore = r.patches.length;
    switchTo(1);
    await settle();
    expect(hoisted.reads).toBe(readsBefore);
    expect(r.patches.slice(patchesBefore)).toEqual([]);
    expect(worker.cellChanges()).toEqual([]);
    expect(listScriptPanes()).toEqual([]);
  });

  it("an UNLOCKED pane is not pinned: switching sheets under it changes nothing, and its watch stays armed", async () => {
    setCell(0, 1, 2, "steady");
    const { worker, paneId } = await mountAndDock(TWO, { ...DEFINITION, accessLevel: "unlocked" });
    expect(r.last().pinnedSheetName).toBeUndefined();
    r.visible(paneId);
    // The reveal owes an unpinned pane no sentence about sheets — asserted
    // BEFORE the re-read is waited on, because a pane that answered the pin
    // here would be off-sheet for the rest of the test and never read at all.
    await settle();
    expect(r.patches.every((p) => p.hostBindingNotice === undefined)).toBe(true);
    await untilReads(2, 2);
    await settle();
    const patchesBefore = r.patches.length;
    switchTo(1);
    await settle();
    // Nothing to say: an unlocked script is not held to one sheet, so leaving
    // "its" sheet is not an event.
    expect(r.patches.slice(patchesBefore)).toEqual([]);
    expect(r.patches.every((p) => p.hostBindingNotice === undefined)).toBe(true);
    // ...and its watch was not torn down by the switch: a change to a bound
    // cell still reaches the script.
    setCell(0, 1, 1, "moved");
    emitAppEvent(AppEvents.CELL_VALUES_CHANGED, {
      changes: [{ row: 1, col: 1, sheetIndex: 0, oldValue: "hello", newValue: "moved" }],
      source: "user",
    });
    await vi.waitFor(() => expect(worker.cellChanges()).toEqual([{ name: "a", value: "moved" }]), { timeout: 2000 });
  });

  // Every settlement asks the backend where the user is standing, so two sheet
  // changes in quick succession put two questions in flight over IPC at once —
  // and nothing promises the older one answers first. Acting on the older
  // answer raises the pin against a sheet the user has already come back from,
  // and the notice then stays up until the NEXT sheet change: "switch back to
  // Sheet1" read by someone standing on Sheet1.
  it("two sheet changes in flight at once: the stale answer is dropped, not painted", async () => {
    const { worker } = await visibleOnSheet1();
    // The departure's question hangs (the backend is slow, or busy recalcing).
    let answerDeparture: (v: { sheets: Array<{ index: number; name: string }>; activeIndex: number }) => void = () =>
      undefined;
    vi.mocked(lib.getSheets).mockImplementationOnce(
      () => new Promise((resolve) => (answerDeparture = resolve)),
    );
    switchTo(1);
    await settle();
    // Nothing painted yet — the host has not been told where the user is.
    expect(r.patches[r.patches.length - 1]?.hostBindingNotice).toBeUndefined();
    // The user walks back before the answer arrives. This question is answered
    // straight away (the mock's `once` is spent), and settles the pane.
    switchTo(0);
    await settle();
    const patchesBefore = r.patches.length;
    // NOW the stale answer lands, still saying "the user is on Sheet2".
    answerDeparture({ sheets: hoisted.sheets.map((s) => ({ ...s })), activeIndex: 1 });
    await settle();
    // It is dropped: no notice, no widget locked, and the watch the return
    // installed is still live.
    expect(r.patches.slice(patchesBefore)).toEqual([]);
    cellChanged(1, 1, "live");
    await vi.waitFor(
      () => expect(worker.cellChanges()[worker.cellChanges().length - 1]).toEqual({ name: "a", value: "live" }),
      { timeout: 2000 },
    );
  });

  // A pane with NO CELL BINDINGS has no case here and no test, because there is
  // no sabotage that could give it one: `visible` settles the sheet only for a
  // pane that has cell bindings (a controls-only pane arms straight away — a
  // Controls-pane value is reached by name, not by sheet), and the pin itself is
  // derived from the cells (`resolveFormBindings` sets `pinnedSheet` only when
  // `cells.length > 0`), so a bindings-less pane answers the unpinned branch
  // even if it reaches one. Two independent reasons, neither of which a test in
  // this file can red.
});

// ----------------------------------------------------------------------------
// 10. A coalesced batch already in flight does not survive the teardown
// ----------------------------------------------------------------------------
//
// The watch's cleanup used to unsubscribe the listener and nothing else, while
// the batch it had already started ran on: a 16 ms coalescing timer whose body
// AWAITS an identity IPC and then one read IPC per changed cell. Human-speed
// timing is enough — a bound cell changes, the batch reaches its identity call,
// the user clicks another sheet tab.
//
// The departure settled the pane correctly (last values, read-only, under the
// pin warning) and the stale batch then CLOBBERED that settlement: the widget
// that had been showing its value came back EMPTY, disabled under the tier
// clamp's sentence — which nothing had clamped — beneath a pin warning that
// still said "switch back to Sheet1"; the script was told the cell had become
// `null`; and the script was charged one denied `sheet.getCellData` for a
// gesture the USER made. Worse, for that sequence, than before the departure
// was watched at all. The same batch made a HIDDEN pane read and announce.
//
// So the identity call and every read are re-checked against the teardown, and
// the timer itself is cancelled.

describe("a live-watch batch in flight is dropped by the teardown that overtakes it", () => {
  const TWO: FormSpec = {
    children: [
      { type: "textbox", name: "a", label: "A", bind: "B2" },
      { type: "textbox", name: "c", label: "C", bind: "C2" },
    ],
  };
  const PIN = 'switch back to "Sheet1" to see and save this pane\'s cells';
  const switchTo = (index: number): void => {
    hoisted.activeSheet = index;
    emitAppEvent(AppEvents.SHEET_CHANGED, { sheetIndex: index });
  };
  const deniedReads = () =>
    getAuditTail().filter((e) => e.scriptId === SCRIPT_ID && e.method === "sheet.getCellData" && !e.ok);

  /**
   * A visible, armed pane whose coalesced batch is PARKED on the identity call
   * it makes before reading anything — the window the teardown has to survive.
   * The returned `release` answers that call, as the backend eventually would.
   */
  async function armedWithBatchInFlight(): Promise<{
    worker: FakeWorker;
    paneId: string;
    release: (activeIndex?: number) => void;
  }> {
    setCell(0, 1, 2, "steady");
    const { worker, paneId } = await mountAndDock(TWO);
    r.visible(paneId);
    await untilReads(2, 2);
    await settle();
    // Hold the NEXT getSheets. The reveal's settlement is already done, so the
    // next caller is the batch below.
    let answer: (v: { sheets: Array<{ index: number; name: string }>; activeIndex: number }) => void = () => undefined;
    vi.mocked(lib.getSheets).mockImplementationOnce(() => new Promise((resolve) => (answer = resolve)));
    const readsAtArm = hoisted.reads;
    cellChanged(1, 1, "moved");
    await settle();
    expect(hoisted.reads, "the batch must be parked on the identity call, before any read").toBe(readsAtArm);
    return {
      worker,
      paneId,
      release: (activeIndex = 0) => answer({ sheets: hoisted.sheets.map((s) => ({ ...s })), activeIndex }),
    };
  }

  it("a departure overtakes it: nothing is announced, no denial is charged, and the pin settlement stands", async () => {
    const { worker, paneId, release } = await armedWithBatchInFlight();
    const readsBefore = hoisted.reads;
    // The user clicks another sheet tab with the batch still parked.
    switchTo(1);
    await vi.waitFor(() => expect(r.patches[r.patches.length - 1]?.hostBindingNotice?.kind).toBe("warning"), {
      timeout: 2000,
    });
    await settle();
    const patchesAfterDeparture = r.patches.length;
    // NOW the batch's identity answer lands, describing the workbook as it was
    // before the user moved.
    release(0);
    await settle();
    expect(worker.cellChanges(), "a batch the departure overtook must announce nothing").toEqual([]);
    expect(deniedReads(), "and must not charge the script a denial for the USER's gesture").toEqual([]);
    expect(hoisted.reads).toBe(readsBefore);
    expect(r.patches.slice(patchesAfterDeparture), "nor repaint over the settlement").toEqual([]);
    // What the user's gesture settled still stands, to the letter.
    const last = r.patches[r.patches.length - 1];
    expect(last.seeds?.a).toEqual({ value: "hello", display: "hello", readOnly: true, reason: PIN });
    expect(last.hostBindingNotice?.kind).toBe("warning");
    expect(worker.lastValues(paneId)).toEqual({ a: "hello", c: "steady" });
    // The clamp sentence is the wrong sentence here and must appear nowhere.
    expect(JSON.stringify(r.patches)).not.toContain(RESTRICTED_SHEET_CLAMP_MESSAGE);
  });

  it("a hide overtakes it: the hidden pane reads nothing and is told nothing", async () => {
    const { worker, paneId, release } = await armedWithBatchInFlight();
    const readsBefore = hoisted.reads;
    const patchesBefore = r.patches.length;
    r.hidden(paneId);
    await settle();
    release();
    await settle();
    // The invariant this file's header states: a pane nobody can see performs
    // no reads and receives no cell events.
    expect(worker.cellChanges(), "a hidden pane must hear nothing").toEqual([]);
    expect(hoisted.reads, "a hidden pane must spend no read").toBe(readsBefore);
    expect(r.patches.slice(patchesBefore)).toEqual([]);
  });

  it("a close overtakes it: no audited read is spent on a pane that is gone", async () => {
    const { worker, paneId, release } = await armedWithBatchInFlight();
    const readsBefore = hoisted.reads;
    r.close(paneId);
    await settle();
    release();
    await settle();
    // The registry swallows a publish to a closed pane, so the READ is what a
    // leaked batch actually costs here: an audited row under the script for a
    // surface the user has already dismissed.
    expect(hoisted.reads, "a closed pane's batch must not spend an audited read").toBe(readsBefore);
    expect(worker.cellChanges()).toEqual([]);
    expect(listScriptPanes()).toEqual([]);
  });

  it("a change overtaken BEFORE the 16 ms coalescer fires costs no IPC at all", async () => {
    setCell(0, 1, 2, "steady");
    const { paneId } = await mountAndDock(TWO);
    r.visible(paneId);
    await untilReads(2, 2);
    await settle();
    const identityCalls = vi.mocked(lib.getSheets).mock.calls.length;
    // The cell changes and the user hides the pane in the same turn — inside
    // the coalescing window, before the batch body has run at all. Cancelling
    // the timer is what makes this cost nothing; without it the body still runs
    // and spends the identity IPC before discovering it has been disposed.
    cellChanged(1, 1, "moved");
    r.hidden(paneId);
    await settle();
    expect(vi.mocked(lib.getSheets).mock.calls.length, "a cancelled batch must not ask the backend anything").toBe(
      identityCalls,
    );
  });

  it("an UNDISTURBED batch still publishes when its identity answer lands", async () => {
    const { worker, release } = await armedWithBatchInFlight();
    const readsBefore = hoisted.reads;
    release();
    await vi.waitFor(() => expect(worker.cellChanges()).toEqual([{ name: "a", value: "moved" }]), { timeout: 2000 });
    // Exactly the one cell the batch coalesced — the unchanged widget is not
    // re-read by the watch.
    expect(hoisted.reads).toBe(readsBefore + 1);
    expect(r.seedPatches()[r.seedPatches().length - 1]?.seeds.a).toEqual({ value: "moved", display: "moved" });
  });
});

// ----------------------------------------------------------------------------
// 11. The Controls-pane half of the same watch
// ----------------------------------------------------------------------------
//
// Section 10 fixed the CELL batch. The Controls-pane half of the same watch
// awaits an audited `form.readControl` and then published without asking the
// same question: a control the user committed in the same turn they hid the
// pane painted the HIDDEN surface and forwarded the script one `onPaneChange`
// for a widget nobody could see — this file's headline invariant, broken for
// any pane with a Controls-pane binding.
//
// It was deferred once as "untestable, because the handle cannot complete a
// real form.readControl". It can: the executor is inline (it answers from the
// change itself), the row is restricted tier with no capability, and the
// facade takes a provider through IoC. Thirty lines of this file's own harness.

describe("the Controls-pane half of the watch is dropped by the teardown too", () => {
  const CONTROL_ONLY: FormSpec = {
    children: [
      { type: "textbox", name: "region", label: "Region", bind: { control: "Region" } },
      { type: "textbox", name: "note", label: "Note" },
    ],
  };
  const READ_ONLY_REASON = "a control value can be read, not written";
  let controlValue: ControlValue = { kind: "text", value: "North" };

  /** The user committed a new value on the Controls pane (never a mid-drag frame). */
  const commit = (value: string): void => {
    controlValue = { kind: "text", value };
    emitAppEvent(CONTROL_VALUE_CHANGED, { id: "ctrl-1", name: "Region", value: controlValue, transient: false });
  };

  beforeEach(() => {
    controlValue = { kind: "text", value: "North" };
    registerControlValuesProvider({
      list: () => [
        { id: "ctrl-1", name: "Region", source: "paneControl", controlType: "dropdown", value: controlValue },
      ],
      get: (name) => (name.toLowerCase() === "region" ? controlValue : undefined),
    });
  });

  afterEach(() => {
    registerControlValuesProvider(null);
  });

  /** A docked, VISIBLE pane whose only binding is a Controls-pane value. */
  async function visibleControlPane(): Promise<{ worker: FakeWorker; paneId: string }> {
    const { worker, paneId } = await mountAndDock(CONTROL_ONLY);
    expect(r.last().seeds.region).toEqual({ value: "North", readOnly: true, reason: READ_ONLY_REASON });
    r.visible(paneId);
    // The subscription is reached through a DYNAMIC import, so it exists only
    // after the microtask queue has drained.
    await settle();
    return { worker, paneId };
  }

  /**
   * The user changes the slicer and closes the sidebar in one gesture: the
   * audited read is already in flight when the teardown runs. Two separate
   * tests, because the defect had two separate costs and an assertion that
   * never runs proves nothing about the one below it.
   */
  async function commitThenHide(): Promise<{ worker: FakeWorker; patchesBefore: number; changesBefore: number }> {
    const { worker, paneId } = await visibleControlPane();
    const patchesBefore = r.patches.length;
    const changesBefore = worker.events("onPaneChange").length;
    commit("South");
    r.hidden(paneId);
    await settle();
    return { worker, patchesBefore, changesBefore };
  }

  it("a hide in the same turn as the committed change: the script is told nothing", async () => {
    const { worker, changesBefore } = await commitThenHide();
    expect(worker.events("onPaneChange").length, "a pane nobody can see must be told nothing").toBe(changesBefore);
  });

  it("a hide in the same turn as the committed change: the hidden pane is not painted", async () => {
    const { patchesBefore } = await commitThenHide();
    expect(r.patches.slice(patchesBefore), "a pane nobody can see must not be painted").toEqual([]);
  });

  // A CLOSE in the same turn has no test here on purpose: `refreshScriptPaneSeeds`
  // already swallows every publish to a closed pane, so both assertions above
  // stay green with this guard deleted. The cost of a close overtaking a read is
  // the READ, and that one belongs to the re-read (section 12) — this half spends
  // its read before the teardown can be observed at all.

  // The positive control, without which the guard above could be "never publish
  // a control change at all" and still pass.
  it("an UNDISTURBED committed change still reaches the visible pane and the script", async () => {
    const { worker, paneId } = await visibleControlPane();
    const changesBefore = worker.events("onPaneChange").length;
    commit("South");
    await vi.waitFor(() => expect(worker.events("onPaneChange").length).toBe(changesBefore + 1), { timeout: 2000 });
    expect(worker.events("onPaneChange").at(-1)).toMatchObject({ name: "region", value: "South" });
    expect(r.seedPatches().at(-1)?.seeds.region).toEqual({
      value: "South",
      readOnly: true,
      reason: READ_ONLY_REASON,
    });
    expect(worker.lastValues(paneId)).toMatchObject({ region: "South" });
  });

  // ...and the subscription itself was already torn down correctly, which is
  // why the defect needed the SAME turn: a change committed after the hide has
  // settled reaches nothing at all.
  it("a change committed after the hide has settled is not even read", async () => {
    const { worker, paneId } = await visibleControlPane();
    r.hidden(paneId);
    await settle();
    const patchesBefore = r.patches.length;
    const changesBefore = worker.events("onPaneChange").length;
    commit("South");
    await settle();
    expect(worker.events("onPaneChange").length).toBe(changesBefore);
    expect(r.patches.slice(patchesBefore)).toEqual([]);
  });
});

// ----------------------------------------------------------------------------
// 12. The reveal re-read stops when the surface it is reading for is gone
// ----------------------------------------------------------------------------
//
// `rereadBoundSeeds` awaits ONE read IPC per bound cell with nothing between
// them, and only its final publish was epoch-guarded. So a pane hidden, closed
// or walked off its pinned sheet while the first cell was in flight went on
// reading the rest — audited rows charged to the script for a surface that is
// gone, and off the pinned sheet one PermissionDenied per remaining cell for a
// gesture the USER made (exactly the row section 10 forbids for the coalesced
// batch).
//
// And it wrote each seed into `bound.seeds` as it arrived, so the settlement
// the user's own gesture had just painted was overwritten underneath: the next
// off-sheet reveal painted a widget that had been showing "steady" as
// `{ value: null }` under the pin sentence — a sentence whose whole promise is
// that it shows the LAST value read.

describe("a reveal re-read in flight is stopped by the teardown that overtakes it", () => {
  const TWO: FormSpec = {
    children: [
      { type: "textbox", name: "a", label: "A", bind: "B2" },
      { type: "textbox", name: "c", label: "C", bind: "C2" },
    ],
  };
  const PIN = 'switch back to "Sheet1" to see and save this pane\'s cells';
  const switchTo = (index: number): void => {
    hoisted.activeSheet = index;
    emitAppEvent(AppEvents.SHEET_CHANGED, { sheetIndex: index });
  };
  const deniedReads = () =>
    getAuditTail().filter((e) => e.scriptId === SCRIPT_ID && e.method === "sheet.getCellData" && !e.ok);
  /**
   * Calls to the typed-cell read, which is one AUDITED row each. `hoisted.reads`
   * cannot serve here: the parked read below increments it only when it is
   * finally released, and a read REFUSED by the tier clamp never reaches the lib
   * at all — the two cases this section has to tell apart.
   */
  const cellReads = (): number => vi.mocked(lib.getRangeCellsTyped).mock.calls.length;
  /** The lib mock's own body, so a PARKED read still answers with the real cells. */
  const baseCellRead = vi.mocked(lib.getRangeCellsTyped).getMockImplementation()!;

  /**
   * A pane whose FIRST reveal is PARKED on the first of its two bound-cell
   * reads — the window a hide, a close or a sheet change has to survive. `a`'s
   * cell was moved while the pane was still hidden, so an undisturbed re-read
   * has exactly one thing to announce and a stopped one visibly does not.
   */
  async function revealParkedOnFirstRead(): Promise<{ worker: FakeWorker; paneId: string; release: () => void }> {
    setCell(0, 1, 2, "steady");
    const { worker, paneId } = await mountAndDock(TWO);
    setCell(0, 1, 1, "moved");
    const readsAtDock = cellReads();
    let unpark: () => void = () => undefined;
    vi.mocked(lib.getRangeCellsTyped).mockImplementationOnce(async (...args) => {
      await new Promise<void>((resolve) => {
        unpark = resolve;
      });
      return baseCellRead(...args);
    });
    r.visible(paneId);
    await settle();
    expect(cellReads(), "the re-read must be parked on its FIRST bound cell, before the second").toBe(readsAtDock + 1);
    return { worker, paneId, release: () => unpark() };
  }

  it("a hide overtakes it: the remaining bound cells are never read", async () => {
    const { worker, paneId, release } = await revealParkedOnFirstRead();
    const readsBefore = cellReads();
    const patchesBefore = r.patches.length;
    r.hidden(paneId);
    await settle();
    release();
    await settle();
    expect(cellReads(), "a hidden pane must not go on reading its remaining bound cells").toBe(readsBefore);
    expect(deniedReads()).toEqual([]);
    expect(worker.cellChanges(), "a hidden pane must hear nothing").toEqual([]);
    expect(r.patches.slice(patchesBefore)).toEqual([]);
  });

  it("a close overtakes it: no audited read is spent on a pane that is gone", async () => {
    const { worker, paneId, release } = await revealParkedOnFirstRead();
    const readsBefore = cellReads();
    r.close(paneId);
    await settle();
    release();
    await settle();
    expect(cellReads(), "a closed pane's re-read must not spend another audited read").toBe(readsBefore);
    expect(deniedReads()).toEqual([]);
    expect(worker.cellChanges()).toEqual([]);
    expect(listScriptPanes()).toEqual([]);
  });

  it("a departure overtakes it: the USER's gesture charges the script no denial", async () => {
    const { worker, paneId, release } = await revealParkedOnFirstRead();
    const readsBefore = cellReads();
    // The user clicks another sheet tab with the first read still in flight.
    // Every remaining bound cell is on the sheet they LEFT, so the tier clamp
    // refuses it — one `PermissionDenied` per cell, charged to the script.
    switchTo(1);
    await vi.waitFor(() => expect(r.patches[r.patches.length - 1]?.hostBindingNotice?.kind).toBe("warning"), {
      timeout: 2000,
    });
    await settle();
    const patchesAfterDeparture = r.patches.length;
    release();
    await settle();
    expect(deniedReads(), "no denial may be charged for the user's own sheet change").toEqual([]);
    expect(cellReads()).toBe(readsBefore);
    expect(worker.cellChanges()).toEqual([]);
    expect(r.patches.slice(patchesAfterDeparture), "nor may it repaint over the settlement").toEqual([]);
    expect(listScriptPanes().map((p) => p.paneId)).toEqual([paneId]);
  });

  it("the seeds a stopped re-read computed are not adopted: the pin sentence still shows the last GOOD value", async () => {
    const { paneId, release } = await revealParkedOnFirstRead();
    switchTo(1);
    await vi.waitFor(() => expect(r.patches[r.patches.length - 1]?.hostBindingNotice?.kind).toBe("warning"), {
      timeout: 2000,
    });
    release();
    await settle();
    // Hide and reveal, still off-sheet: the off-sheet notice paints from
    // `bound.seeds`, which is where a stale run's `{ value: null }` landed.
    r.hidden(paneId);
    await settle();
    // A NEW patch, counted — not "the last patch is a warning", which the
    // departure's own patch already satisfies, so that spelling would read the
    // notice painted BEFORE the stale run could clobber anything.
    const patchesBefore = r.patches.length;
    r.visible(paneId);
    await vi.waitFor(() => expect(r.patches.length).toBeGreaterThan(patchesBefore), { timeout: 2000 });
    await settle();
    const off = r.patches[r.patches.length - 1];
    expect(off.hostBindingNotice?.kind).toBe("warning");
    expect(off.seeds?.c, "the widget the stopped run never reached must keep its last value").toEqual({
      value: "steady",
      display: "steady",
      readOnly: true,
      reason: PIN,
    });
    expect(off.seeds?.a).toEqual({ value: "hello", display: "hello", readOnly: true, reason: PIN });
    // The clamp sentence is the wrong sentence here and must appear nowhere.
    expect(JSON.stringify(r.patches)).not.toContain(RESTRICTED_SHEET_CLAMP_MESSAGE);
  });

  it("an UNDISTURBED reveal still reads every bound cell and announces what changed", async () => {
    const { worker, release } = await revealParkedOnFirstRead();
    const readsBefore = cellReads();
    release();
    await vi.waitFor(() => expect(worker.cellChanges()).toEqual([{ name: "a", value: "moved" }]), { timeout: 2000 });
    expect(cellReads(), "the second bound cell is still read").toBe(readsBefore + 1);
    const seeds = r.seedPatches()[r.seedPatches().length - 1]?.seeds;
    expect(seeds?.a).toEqual({ value: "moved", display: "moved" });
    expect(seeds?.c).toEqual({ value: "steady", display: "steady" });
  });
});
