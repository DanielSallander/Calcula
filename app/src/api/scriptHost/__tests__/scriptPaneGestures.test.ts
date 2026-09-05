//! FILENAME: app/src/api/scriptHost/__tests__/scriptPaneGestures.test.ts
// PURPOSE: The reveal gesture window (M2 S6) through the REAL host: where
//          host.ts stamps a USER gesture for a script, and the audit row a
//          refused reveal leaves under the script's handle.
// CONTEXT: Same FakeWorker harness as scriptPaneBindings.test.ts, minus the
//          cells — nothing here is bound. The worker drives `pane.dock` and
//          `pane.reveal` as real broker calls; the renderer stub acknowledges
//          the dock. The two stamp sites a unit test can reach without a
//          debugger session or a keybinding registry are the ones pinned: a
//          click on the BUTTON a script is attached to (the `button:clicked`
//          forwarder) and the user's input on the script's own FORM
//          (`formSessionDeps.forward`). The debugger's Run / Fire and the
//          shortcut runner are stamped at their entry in host.ts and verified
//          by reading; a stamp at a non-user entry (a scheduled job, a cross-
//          script call) is what the negative case here refuses.
//
//          The clock is moved by spying Date.now, not by fake timers: the
//          harness polls callResult with real setTimeout, and the registry's
//          window is a wall-clock rule that only reads Date.now.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type { H2W, W2H } from "../protocol";
import { emitAppEvent } from "../../events";
import {
  PANE_REVEAL_GESTURE_WINDOW_MS,
  SCRIPT_PANE_INPUT_EVENT,
  SCRIPT_PANE_PATCH_EVENT,
  SCRIPT_PANE_REQUEST_EVENT,
  type ScriptPaneInputPayload,
  type ScriptPanePatchPayload,
  type ScriptPaneRequestPayload,
} from "../scriptPaneSpec";
import {
  SCRIPT_FORM_INPUT_EVENT,
  SCRIPT_FORM_REQUEST_EVENT,
  type FormSpec,
  type ScriptFormInputPayload,
  type ScriptFormRequestPayload,
} from "../scriptFormSpec";
import { resetScriptPanes } from "../scriptPanes";
import { resetScriptForms } from "../scriptForms";
import {
  recordCapabilityGrant,
  resetAllGrants,
  resolveCapabilityRequest,
  type CapabilityRequestPayload,
} from "../capabilities";
import { clearAudit, getAuditTail } from "../auditRing";

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
  getSheets: vi.fn(async () => ({ sheets: [{ index: 0, name: "Sheet1" }], activeIndex: 0 })),
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
// Renderer stubs on the pane wire and the form wire.
// ----------------------------------------------------------------------------

function paneRenderer() {
  const requests: ScriptPaneRequestPayload[] = [];
  const patches: ScriptPanePatchPayload[] = [];
  const onReq = (e: Event): void => {
    const req = (e as CustomEvent).detail as ScriptPaneRequestPayload;
    requests.push(req);
    const values = Object.fromEntries(
      Object.entries(req.seeds).map(([n, s]) => [n, s.value]),
    ) as ScriptPaneInputPayload["values"];
    emitAppEvent(SCRIPT_PANE_INPUT_EVENT, { paneId: req.paneId, kind: "docked", placement: "sidebar", values });
  };
  const onPatch = (e: Event): void => {
    patches.push((e as CustomEvent).detail as ScriptPanePatchPayload);
  };
  window.addEventListener(SCRIPT_PANE_REQUEST_EVENT, onReq);
  window.addEventListener(SCRIPT_PANE_PATCH_EVENT, onPatch);
  return {
    requests,
    reveals: () => patches.filter((p) => p.reveal).length,
    stop: () => {
      window.removeEventListener(SCRIPT_PANE_REQUEST_EVENT, onReq);
      window.removeEventListener(SCRIPT_PANE_PATCH_EVENT, onPatch);
    },
  };
}

function formRenderer() {
  const requests: ScriptFormRequestPayload[] = [];
  const onReq = (e: Event): void => {
    const req = (e as CustomEvent).detail as ScriptFormRequestPayload;
    requests.push(req);
    const payload: ScriptFormInputPayload = { showId: req.showId, kind: "shown", values: {} };
    emitAppEvent(SCRIPT_FORM_INPUT_EVENT, payload);
  };
  window.addEventListener(SCRIPT_FORM_REQUEST_EVENT, onReq);
  return {
    requests,
    input: (showId: string, kind: ScriptFormInputPayload["kind"], name?: string) => {
      const payload: ScriptFormInputPayload = { showId, kind, ...(name ? { name } : {}), values: {} };
      emitAppEvent(SCRIPT_FORM_INPUT_EVENT, payload);
    },
    stop: () => window.removeEventListener(SCRIPT_FORM_REQUEST_EVENT, onReq),
  };
}

// ----------------------------------------------------------------------------
// Harness
// ----------------------------------------------------------------------------

const globalScope = globalThis as unknown as Record<string, unknown>;
const originalWorker = globalScope.Worker;

type HostModule = typeof import("../host");
let host: HostModule;

const BUTTON_SCRIPT = {
  id: "gesture-button-script",
  name: "Refresh button",
  objectType: "button",
  instanceId: "btn-1",
  source: "function setup(context) {}",
  accessLevel: "restricted" as const,
  declaredCapabilities: ["ui.pane"],
  apiVersion: "1.0.0",
};

const FORM_SCRIPT = {
  id: "gesture-form-script",
  name: "Order form",
  objectType: "form",
  instanceId: null,
  source: "function setup(context) {}",
  accessLevel: "restricted" as const,
  declaredCapabilities: ["ui.pane", "ui.dialog"],
  apiVersion: "1.0.0",
};

/**
 * The script the OTHER two are not: it holds no grant when it mounts, so its
 * first `pane.dock` raises a REAL ui.pane consent dialog inside the broker call.
 * `storage` is declared beside it to drive the negative case — a JIT grant of
 * something that is not the pane capability.
 */
const JIT_SCRIPT = {
  id: "gesture-jit-script",
  name: "First-run pane",
  objectType: "button",
  instanceId: "btn-jit",
  source: "function setup(context) {}",
  accessLevel: "restricted" as const,
  declaredCapabilities: ["ui.pane", "storage"],
  apiVersion: "1.0.0",
};

const PANE_SPEC: FormSpec = {
  title: "Status",
  children: [{ type: "textbox", name: "note", label: "Note" }],
};
const FORM_SPEC: FormSpec = {
  title: "Order",
  children: [{ type: "button", name: "go", text: "Go" }],
};

let r: ReturnType<typeof paneRenderer>;
let f: ReturnType<typeof formRenderer>;
let clock: ReturnType<typeof vi.spyOn> | null = null;
let callSeq = 0;

/** Move the wall clock the registry reads (Date.now) without touching timers. */
function setClock(ms: number): void {
  clock?.mockRestore();
  clock = vi.spyOn(Date, "now").mockReturnValue(ms);
}

async function reveal(worker: FakeWorker, paneId: string): Promise<{ revealed: boolean; reason?: string }> {
  const result = await worker.call(++callSeq, "pane.reveal", [paneId]);
  expect(result.ok, `pane.reveal must be admitted by the broker: ${result.error?.message ?? ""}`).toBe(true);
  return result.value as { revealed: boolean; reason?: string };
}

async function mountAndDock(definition: typeof BUTTON_SCRIPT | typeof FORM_SCRIPT): Promise<{ worker: FakeWorker; paneId: string }> {
  await host.hostMountScript({ ...definition });
  const worker = FakeWorker.last!;
  const result = await worker.call(++callSeq, "pane.dock", [PANE_SPEC, undefined]);
  expect(result.ok, `pane.dock must be admitted: ${result.error?.message ?? ""}`).toBe(true);
  return { worker, paneId: (result.value as { paneId: string }).paneId };
}

function refusalRows(scriptId: string) {
  return getAuditTail()
    .filter((e) => e.scriptId === scriptId && e.method === "pane.reveal" && !e.ok)
    .map((e) => ({ scriptName: e.scriptName, class: e.class, error: e.error }));
}

beforeEach(async () => {
  FakeWorker.last = null;
  callSeq = 0;
  globalScope.Worker = FakeWorker as unknown as typeof Worker;
  // NO `vi.resetModules()`: the static `emitAppEvent` import above must be
  // the same events module the host listens on (eventBackpressure.test.ts).
  host = await import("../host");
  resetScriptPanes();
  resetScriptForms();
  resetAllGrants();
  clearAudit();
  recordCapabilityGrant(BUTTON_SCRIPT.id, "ui.pane");
  recordCapabilityGrant(FORM_SCRIPT.id, "ui.pane");
  recordCapabilityGrant(FORM_SCRIPT.id, "ui.dialog");
  r = paneRenderer();
  f = formRenderer();
});

afterEach(() => {
  clock?.mockRestore();
  clock = null;
  r.stop();
  f.stop();
  host.hostUnmountScript(BUTTON_SCRIPT.id);
  host.hostUnmountScript(FORM_SCRIPT.id);
  host.hostUnmountScript(JIT_SCRIPT.id);
  resetScriptPanes();
  resetScriptForms();
  resetAllGrants();
  clearAudit();
  globalScope.Worker = originalWorker;
});

// ----------------------------------------------------------------------------
// The window through the real host
// ----------------------------------------------------------------------------

describe("pane.reveal through the real host", () => {
  it("is admitted after the dock, refused 'no-gesture' once the window has passed — and the refusal is an audit row under the script", async () => {
    const { worker, paneId } = await mountAndDock(BUTTON_SCRIPT);
    const base = Date.now();
    expect(await reveal(worker, paneId)).toEqual({ revealed: true });
    expect(r.reveals()).toBe(1);
    setClock(base + PANE_REVEAL_GESTURE_WINDOW_MS + 1);
    expect(await reveal(worker, paneId)).toEqual({ revealed: false, reason: "no-gesture" });
    expect(r.reveals()).toBe(1);
    // The broker's own row says the call succeeded (a reveal returns an
    // answer); THIS row is the one that says the registry refused it.
    expect(refusalRows(BUTTON_SCRIPT.id)).toEqual([{ scriptName: "Refresh button", class: "ui", error: "NoGesture" }]);
  });

  it("a click on the BUTTON the script is attached to opens the window; a click on another button does not", async () => {
    const { worker, paneId } = await mountAndDock(BUTTON_SCRIPT);
    // The script registered onClick, so the host wired the button:clicked forwarder.
    worker.emit({ t: "hookRegistered", hook: "onClick" });
    await new Promise((resolve) => setTimeout(resolve, 10));
    const base = Date.now();
    setClock(base + PANE_REVEAL_GESTURE_WINDOW_MS + 1);
    expect((await reveal(worker, paneId)).reason).toBe("no-gesture");
    emitAppEvent("button:clicked", { instanceId: "btn-1", x: 3, y: 4 });
    expect(worker.events("onClick")).toEqual([{ x: 3, y: 4 }]);
    expect(await reveal(worker, paneId)).toEqual({ revealed: true });
    // Another button's click reaches neither the script nor its window.
    setClock(base + 2 * (PANE_REVEAL_GESTURE_WINDOW_MS + 1));
    emitAppEvent("button:clicked", { instanceId: "btn-other", x: 0, y: 0 });
    expect(worker.events("onClick")).toHaveLength(1);
    expect((await reveal(worker, paneId)).reason).toBe("no-gesture");
  });

  it("the user's click on the script's FORM opens the window; the form's onShow (the script opened it) does not", async () => {
    const { worker, paneId } = await mountAndDock(FORM_SCRIPT);
    const base = Date.now();
    setClock(base + PANE_REVEAL_GESTURE_WINDOW_MS + 1);
    expect((await reveal(worker, paneId)).reason).toBe("no-gesture");
    // The script shows its form: the renderer stub acknowledges "shown", the
    // host forwards onShow — not a user gesture.
    expect((await worker.call(++callSeq, "form.define", [FORM_SPEC])).ok).toBe(true);
    const shown = await worker.call(++callSeq, "form.show", [undefined]);
    expect(shown.ok, `form.show must be admitted: ${shown.error?.message ?? ""}`).toBe(true);
    expect(f.requests).toHaveLength(1);
    expect(worker.events("onShow")).toHaveLength(1);
    expect((await reveal(worker, paneId)).reason).toBe("no-gesture");
    // The USER clicks a button on that form: the window opens.
    f.input(f.requests[0].showId, "click", "go");
    expect(worker.events("onClick")).toEqual([{ name: "go", values: {} }]);
    expect(await reveal(worker, paneId)).toEqual({ revealed: true });
  });
});

// ----------------------------------------------------------------------------
// The DOCK rides the same window, through the real host
// ----------------------------------------------------------------------------

describe("pane.dock through the real host", () => {
  it("the mount is the gesture the first dock rides; a re-dock on the script's own clock registers without opening", async () => {
    // Mounting IS the user's doing — they applied the script, opened the
    // workbook that holds it, or re-linked it — and a task pane that appears
    // when its script is set up is the point of the surface (host.ts,
    // `mountWorker`).
    const { worker, paneId } = await mountAndDock(BUTTON_SCRIPT);
    expect(r.requests.at(-1)!.open, "the dock right after the mount must take the screen").toBe(true);

    // Now the loop: the script closes its own pane and docks again, with no
    // user gesture in between. The dock's own acknowledgement stamped a gesture
    // (so that a dock may be followed by a reveal), and feeding that back into
    // the next DOCK is what made this a self-renewing sidebar takeover.
    expect((await worker.call(++callSeq, "pane.close", [paneId])).ok).toBe(true);
    const again = await worker.call(++callSeq, "pane.dock", [PANE_SPEC, undefined]);
    expect(again.ok, `the re-dock must still be admitted: ${again.error?.message ?? ""}`).toBe(true);
    // Refused the SCREEN, not the pane: it is docked, and the script is told.
    expect(again.value).toMatchObject({ opened: false, placement: "sidebar" });
    expect(r.requests.at(-1)!.open).toBe(false);
  });
});

// ----------------------------------------------------------------------------
// The JIT consent dialog is itself the gesture the first dock rides
// ----------------------------------------------------------------------------

/**
 * Answer the next capability request(s) the host raises, at `answerAt` on the
 * clock the registry reads. Returns the capabilities that were asked for, so a
 * test can prove a REAL prompt happened rather than a silent pre-grant.
 */
function answerCapabilityPrompts(
  answerAt: number,
  decision: "once" | "always" | "deny",
): { asked: string[]; stop: () => void } {
  const asked: string[] = [];
  const onRequest = (e: Event): void => {
    const req = (e as CustomEvent).detail as CapabilityRequestPayload;
    asked.push(req.capability);
    // The person is READING the dialog: the clock moves before they answer.
    setClock(answerAt);
    resolveCapabilityRequest(req.requestId, decision);
  };
  window.addEventListener("scriptable-objects:capability-request", onRequest);
  return {
    asked,
    stop: () => window.removeEventListener("scriptable-objects:capability-request", onRequest),
  };
}

describe("the ui.pane consent dialog a first dock waits on", () => {
  it("is the gesture that dock rides, however long the user took to read it", async () => {
    // Every other pane suite pre-grants ui.pane, which is why none of them saw
    // this: on a local script's FIRST run `handleCall` awaits a real modal
    // before the executor reaches dockScriptPane, and the only stamp behind a
    // setup() dock is the mount's. A user who took 10 s over the prompt had the
    // pane they had just allowed registered in the panel list and never shown.
    const answers = answerCapabilityPrompts(Date.now() + 2 * PANE_REVEAL_GESTURE_WINDOW_MS, "once");
    try {
      await host.hostMountScript({ ...JIT_SCRIPT });
      const worker = FakeWorker.last!;
      const result = await worker.call(++callSeq, "pane.dock", [PANE_SPEC, undefined]);
      expect(result.ok, `pane.dock must be admitted: ${result.error?.message ?? ""}`).toBe(true);
      // A genuine prompt, not a pre-grant: this is the harness gap itself.
      expect(answers.asked).toEqual(["ui.pane"]);
      expect(result.value).toMatchObject({ opened: true, placement: "sidebar" });
      expect(r.requests.at(-1)!.open, "the pane the user just consented to must take the screen").toBe(true);
      // And the script still has a route to its own pane afterwards, because
      // markDocked stamps only for a dock that OPENED.
      const paneId = (result.value as { paneId: string }).paneId;
      expect(await reveal(worker, paneId)).toEqual({ revealed: true });
    } finally {
      answers.stop();
    }
  });

  it("is the ONLY grant that opens the window — allowing storage does not hand a pane to code on its own clock", async () => {
    // The stamp is scoped to ui.pane on purpose. If any grant stamped, a script
    // looping on setInterval could take the sidebar the moment the user allowed
    // an unrelated permission — the thing the window exists to refuse.
    recordCapabilityGrant(JIT_SCRIPT.id, "ui.pane");
    await host.hostMountScript({ ...JIT_SCRIPT });
    const worker = FakeWorker.last!;
    const base = Date.now();
    setClock(base + PANE_REVEAL_GESTURE_WINDOW_MS + 1); // the mount stamp is dead
    const answers = answerCapabilityPrompts(base + PANE_REVEAL_GESTURE_WINDOW_MS + 2, "once");
    try {
      const stored = await worker.call(++callSeq, "cap.storageGet", ["k"]);
      expect(stored.ok, `cap.storageGet must be admitted: ${stored.error?.message ?? ""}`).toBe(true);
      expect(answers.asked).toEqual(["storage"]);
      const result = await worker.call(++callSeq, "pane.dock", [PANE_SPEC, undefined]);
      expect(result.ok, `pane.dock must be admitted: ${result.error?.message ?? ""}`).toBe(true);
      expect(result.value).toMatchObject({ opened: false, placement: "sidebar" });
      expect(r.requests.at(-1)!.open, "a storage grant must not open a pane window").toBe(false);
    } finally {
      answers.stop();
    }
  });
});
