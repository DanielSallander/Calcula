//! FILENAME: app/src/api/scriptHost/__tests__/extensionForms.test.ts
// PURPOSE: The contract for an ADD-IN's host-painted form (M4,
//          docs/design/typescript-forms.md §14). Four families:
//            1. END TO END — a sandboxed extension declares a form, registers
//               it, shows it, is SHOWN a real cell in a bound field, and gets
//               the user's answers back through its one handler — and CANNOT
//               put a value of its own in that field, at show time or later.
//            2. FAIL CLOSED — an undeclared form name, an unregistered name,
//               a missing ui.dialog declaration and a missing/revoked
//               grid.read each refuse in a way the user can SEE.
//            3. THE NARROWING — every shape an add-in's form may not have is
//               refused BY NAME at registration, and the same shape is still
//               legal for an object script (proving the extra rules belong to
//               the surface, not to the tree).
//            4. NO WRITE PATH FROM A BINDING — the promise
//               `CONTRIBUTION_REACH_NOTE.form` makes is kept structurally, not
//               by prose: a bound field never travels back to its cell. The
//               note used to claim MORE than that ("nothing you do in one of
//               its forms is ever written into your workbook") and a second
//               door falsified it, so this family now also PROVES that door —
//               a form button running a script-safe command that writes cells —
//               and pins the disclosure it forced onto both consent screens.
// CONTEXT: Consent text is a promise. Every sentence a user reads here says an
//          add-in's form can SHOW a cell and never write that cell back; these
//          tests are what makes that provable from the code rather than from
//          the comment — including the part where the narrower claim is the
//          only one the code can keep.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "fs";
import * as path from "path";
import {
  CONTRIBUTION_REACH_NOTE,
  CONTRIBUTION_REQUIRED_CAPABILITY,
  EXTENSION_BROKER_METHODS,
  EXTENSION_BUILTIN_ACTION_REACH_NOTE,
  EXTENSION_FORM_HOOKS,
  EXTENSION_FORM_HOOK_RELAY,
  type ExtRegistration,
  type WX2H,
} from "../extensionProtocol";
import {
  SCRIPT_FORM_INPUT_EVENT,
  SCRIPT_FORM_PATCH_EVENT,
  SCRIPT_FORM_REQUEST_EVENT,
  type FormSpec,
  type ScriptFormInputPayload,
  type ScriptFormPatchPayload,
  type ScriptFormRequestPayload,
} from "../scriptFormSpec";
import {
  EXTENSION_FORM_DISPLAY_ONLY,
  EXTENSION_FORM_NO_GRID_READ,
} from "../extensionFormBindings";
import { checkFormSpec } from "../validators";
import { ALLOWLIST } from "../allowlist";

// A refusal must stay OBSERVABLE, so the toast is spied on rather than silenced.
const toasts: string[] = [];
vi.mock("../../notifications", () => ({
  showToast: (message: string) => {
    toasts.push(message);
  },
}));

// The workbook the add-in is shown. `getRangeCellsTyped` is the ONE grid read
// the form pipeline performs; counting its calls is how "zero cells crossed" is
// asserted rather than asserted-about.
const cellReads: Array<{ row: number; col: number; sheetIndex?: number }> = [];
vi.mock("../../lib", () => ({
  getSheets: async () => ({
    sheets: [
      { index: 0, name: "Sheet1" },
      { index: 1, name: "Budget" },
    ],
    activeIndex: 0,
  }),
  getRangeCellsTyped: async (
    startRow: number,
    startCol: number,
    _endRow: number,
    _endCol: number,
    sheetIndex?: number,
  ) => {
    cellReads.push({ row: startRow, col: startCol, sheetIndex });
    // B2 (row 1, col 1) holds a formatted number; everything else is empty.
    if (startRow === 1 && startCol === 1) {
      return [
        {
          row: 1,
          col: 1,
          value: 1234.5,
          display: "1 234,50 kr",
          formula: "=SUM(A1:A9)",
          type: "number",
        },
      ];
    }
    return [];
  },
}));

// ============================================================================
// A fake Worker: the test IS the sandboxed add-in.
// ============================================================================

type HostMessage = { t: string; [k: string]: unknown };

class FakeWorker {
  static last: FakeWorker | null = null;
  listeners = new Map<string, Set<(e: unknown) => void>>();
  received: HostMessage[] = [];
  terminated = false;
  /** Handlers the "add-in" registered, keyed by handlerId. */
  handlers = new Map<number, (...args: unknown[]) => unknown>();

  constructor() {
    FakeWorker.last = this;
  }

  addEventListener(type: string, cb: (e: unknown) => void): void {
    let set = this.listeners.get(type);
    if (!set) {
      set = new Set();
      this.listeners.set(type, set);
    }
    set.add(cb);
  }

  removeEventListener(type: string, cb: (e: unknown) => void): void {
    this.listeners.get(type)?.delete(cb);
  }

  postMessage(msg: HostMessage): void {
    this.received.push(msg);
    if (msg.t === "deactivate") queueMicrotask(() => this.emit({ t: "deactivated" }));
    if (msg.t === "invokeHandler") {
      const fn = this.handlers.get(msg.handlerId as number);
      const reqId = msg.reqId as number;
      const args = msg.args as unknown[];
      void (async () => {
        try {
          const value = await fn?.(...args);
          this.emit({ t: "handlerResult", reqId, ok: true, value });
        } catch (e) {
          this.emit({
            t: "handlerResult",
            reqId,
            ok: false,
            error: { code: "HostError", message: String(e) },
          });
        }
      })();
    }
  }

  terminate(): void {
    this.terminated = true;
  }

  emit(data: WX2H): void {
    for (const cb of this.listeners.get("message") ?? []) {
      cb({ data } as unknown as MessageEvent<WX2H>);
    }
  }

  register(reg: ExtRegistration): void {
    this.emit({ t: "register", reg });
  }

  /** A broker call the way the worker shim makes one; returns the settled result. */
  call(callId: number, method: string, args: unknown[]): void {
    this.emit({ t: "call", callId, method, args });
  }

  /** The host's answer to a `call`, once it has settled. */
  result(callId: number): HostMessage | undefined {
    return this.received.find((m) => m.t === "callResult" && m.callId === callId);
  }
}

const globalScope = globalThis as unknown as Record<string, unknown>;
const WORKER_GLOBAL = "Worker";
const originalWorker = globalScope[WORKER_GLOBAL];

const BASE_MANIFEST = {
  id: "test.formaddin",
  name: "Form Add-in",
  version: "1.0.0",
  workerSupport: true,
};
const SCRIPT_ID = `extension:${BASE_MANIFEST.id}`;

/** The example layout: one field bound to a cell, one the user fills in. */
const FORM: FormSpec = {
  title: "Quote",
  children: [
    { type: "number", name: "rate", label: "Rate from B2", bind: "B2" },
    { type: "textbox", name: "customer", label: "Customer" },
    { type: "button", name: "ok", text: "Quote", role: "submit" },
  ],
};

/**
 * A LIVE form: the shipped example's shape. A dropdown (whose change is
 * delivered at once), a textbox (whose change waits out the keystroke debounce),
 * an ordinary button and a submit button — one of each hook-producing widget, so
 * a whole session's worth of hooks can be driven through it.
 */
const LIVE_FORM: FormSpec = {
  title: "Quote",
  children: [
    { type: "dropdown", name: "country", label: "Country", options: ["SE", "DE"], default: "SE" },
    { type: "textbox", name: "customer", label: "Customer" },
    { type: "button", name: "recalc", text: "Recalculate" },
    { type: "button", name: "ok", text: "Quote", role: "submit" },
  ],
};

/** Stand in for the trusted renderer (ScriptFormDialog). */
function renderer() {
  const requests: ScriptFormRequestPayload[] = [];
  // What the host sends an OPEN form. Captured because `landFormPatch` acts on
  // this payload alone (scriptFormState.ts) — a name the host meant to refuse
  // but left in the payload is painted anyway, so the payload is the only place
  // that refusal is observable.
  const patches: ScriptFormPatchPayload[] = [];
  const onReq = (e: Event) => requests.push((e as CustomEvent).detail as ScriptFormRequestPayload);
  const onPatch = (e: Event) => patches.push((e as CustomEvent).detail as ScriptFormPatchPayload);
  window.addEventListener(SCRIPT_FORM_REQUEST_EVENT, onReq);
  window.addEventListener(SCRIPT_FORM_PATCH_EVENT, onPatch);
  return {
    requests,
    patches,
    last: () => requests[requests.length - 1],
    lastPatch: () => patches[patches.length - 1],
    input: (payload: ScriptFormInputPayload) => {
      window.dispatchEvent(new CustomEvent(SCRIPT_FORM_INPUT_EVENT, { detail: payload }));
    },
    stop: () => {
      window.removeEventListener(SCRIPT_FORM_REQUEST_EVENT, onReq);
      window.removeEventListener(SCRIPT_FORM_PATCH_EVENT, onPatch);
    },
  };
}

describe("add-in forms (M4)", () => {
  let host: typeof import("../extensionWorkerHost");
  let forms: typeof import("../scriptForms");
  let dialogs: typeof import("../scriptDialogs");
  let caps: typeof import("../capabilities");
  let audit: typeof import("../auditRing");
  let r: ReturnType<typeof renderer>;

  beforeEach(async () => {
    vi.resetModules();
    toasts.length = 0;
    cellReads.length = 0;
    globalScope[WORKER_GLOBAL] = FakeWorker;
    // Imported AFTER resetModules so every module below shares one fresh graph
    // with the host under test — a stale `scriptForms` would hold sessions the
    // host cannot see.
    host = await import("../extensionWorkerHost");
    forms = await import("../scriptForms");
    dialogs = await import("../scriptDialogs");
    caps = await import("../capabilities");
    audit = await import("../auditRing");
    forms.resetScriptForms();
    dialogs.resetScriptDialogs();
    caps.resetAllGrants();
    audit.clearAudit();
    r = renderer();
  });

  afterEach(async () => {
    r.stop();
    await host.resetWorkerExtensions();
    forms.resetScriptForms();
    dialogs.resetScriptDialogs();
    globalScope[WORKER_GLOBAL] = originalWorker;
  });

  /** Mount an add-in whose worker is the FakeWorker above. */
  async function mount(manifest: Record<string, unknown>): Promise<FakeWorker> {
    const pending = host.mountWorkerExtension(
      "/* bundle */",
      String(manifest.name ?? ""),
      manifest as never,
    );
    await Promise.resolve();
    const worker = FakeWorker.last as FakeWorker;
    worker.emit({ t: "manifest", manifest: manifest as never });
    await Promise.resolve();
    await Promise.resolve();
    worker.emit({ t: "activated", ok: true });
    await pending;
    return worker;
  }

  /**
   * Mount + register the form + pre-grant ui.dialog. The grant stands in for
   * the JIT consent prompt an add-in's FIRST `ext.formShow` raises; every test
   * below is about what happens after the person said yes.
   */
  async function mountWithForm(
    overrides: Record<string, unknown> = {},
    spec: FormSpec = FORM,
  ): Promise<FakeWorker> {
    const worker = await mount({
      ...BASE_MANIFEST,
      capabilities: ["ui.dialog", "grid.read"],
      contributes: { forms: ["quote"] },
      ...overrides,
    });
    worker.register({ kind: "form", regId: 1, name: "quote", spec, handlerId: 7 });
    caps.recordCapabilityGrant(SCRIPT_ID, "ui.dialog");
    return worker;
  }

  /**
   * Let the host settle. A macrotask turn, not a microtask drain: the bound
   * reads go through a dynamic `import("../lib")` and a real broker call, and
   * counting microtasks would make these tests fail the day either grows a hop.
   */
  async function settle(turns = 4): Promise<void> {
    for (let i = 0; i < turns; i++) await new Promise<void>((res) => setTimeout(res, 0));
  }

  /** Show the form and let the renderer acknowledge it. */
  async function show(worker: FakeWorker, callId = 100): Promise<ScriptFormRequestPayload> {
    worker.call(callId, "ext.formShow", ["quote"]);
    await settle();
    const request = r.last();
    expect(
      request,
      `the host must have asked the renderer to paint a form; host answer: ${JSON.stringify(worker.result(callId))}`,
    ).toBeDefined();
    r.input({ showId: request.showId, kind: "shown", values: {} });
    await settle(2);
    return request;
  }

  // --------------------------------------------------------------------------
  // 1. End to end
  // --------------------------------------------------------------------------

  it("a declared form is registered, painted by the host, and shows a real cell", async () => {
    const worker = await mountWithForm();

    const contribution = host.listExtensionContributions().find((c) => c.kind === "form");
    expect(contribution?.id).toBe("quote");
    expect(contribution?.refusedReason).toBeUndefined();
    // The label says the reach, the way the cellStyle label does: "adds a form"
    // would hide that the form is shown the user's cells.
    expect(contribution?.label).toContain("1 cell");

    const request = await show(worker);

    // Identity is HOST-supplied and structural — no manifest field selects it.
    expect(request.origin).toEqual({ kind: "package", name: BASE_MANIFEST.id });
    expect(request.scriptId).toBe(SCRIPT_ID);
    expect(request.spec.title).toBe("Quote");
    // The bound field really was seeded from B2 on the ACTIVE sheet...
    expect(cellReads).toEqual([{ row: 1, col: 1, sheetIndex: 0 }]);
    expect(request.seeds.rate.value).toBe(1234.5);
    expect(request.seeds.rate.formula).toBe("=SUM(A1:A9)");
    expect(request.pinnedSheetName).toBe("Sheet1");
    // ...and is DISPLAY ONLY, with the sentence the user reads on the field.
    expect(request.seeds.rate.readOnly).toBe(true);
    expect(request.seeds.rate.reason).toBe(EXTENSION_FORM_DISPLAY_ONLY);
    // The unbound field is an ordinary editable box — no seed, no refusal.
    expect(request.seeds.customer).toBeUndefined();

    // The read went through the BROKER, so the transparency trail has it under
    // this add-in rather than nowhere.
    const row = audit.getAuditTail().find((e) => e.method === "sheet.getCellData");
    expect(row?.scriptId).toBe(SCRIPT_ID);
    expect(row?.ok).toBe(true);
  });

  // --------------------------------------------------------------------------
  // 1b. The cell's value and the host's caption on it are ONE fact
  //
  // A bound field on this surface is the only place in Calcula where an add-in's
  // dialog carries HOST-authored provenance: it is switched off and it says "an
  // add-in's form can show you this cell; it can never change it". That marking
  // is what makes the number beside it read as the workbook's rather than as the
  // add-in's, so nothing the add-in supplies may end up underneath it.
  // --------------------------------------------------------------------------

  it("an add-in's `initial` cannot put its own number in a field the host captions as your cell", async () => {
    const worker = await mountWithForm();
    // `rate` is bound to B2 (1234.5, formatted, formula-backed); `customer` is
    // the add-in's own field and claims nothing about the workbook.
    worker.call(100, "ext.formShow", ["quote", { initial: { rate: 999999, customer: "Acme" } }]);
    await settle();
    const request = r.last();
    expect(
      request,
      `the form must still open; host answer: ${JSON.stringify(worker.result(100))}`,
    ).toBeDefined();

    // The seed is the CELL, whole. The merge used to keep the read-only
    // marking, the reason and the real formula and swap in the add-in's number
    // — a greyed box captioned "an add-in's form can show you this cell; it can
    // never change it", showing 999999, with =SUM(A1:A9) appearing on focus.
    // `CONTRIBUTION_REACH_NOTE.form` promises Calcula shows you that cell's
    // contents; these five assertions are that promise at the point of use.
    expect(request.seeds.rate.value).toBe(1234.5);
    expect(request.seeds.rate.display).toBe("1 234,50 kr");
    expect(request.seeds.rate.formula).toBe("=SUM(A1:A9)");
    expect(request.seeds.rate.readOnly).toBe(true);
    expect(request.seeds.rate.reason).toBe(EXTENSION_FORM_DISPLAY_ONLY);
    // NARROW, not a blanket refusal of `initial`: the add-in's OWN field still
    // opens on the default it asked for. The rule is about seeds the host
    // marked, not about who called show().
    expect(request.seeds.customer?.value).toBe("Acme");
  });

  it("nor can a patch once the form is up — the name never reaches the renderer", async () => {
    const worker = await mountWithForm();
    const request = await show(worker);
    expect(request.seeds.rate.value).toBe(1234.5);

    worker.call(101, "ext.formUpdate", [
      { values: { rate: 999999, customer: "Bo" }, message: { text: "quote ready" } },
    ]);
    await settle(2);

    const patch = r.lastPatch()?.patch;
    expect(patch, "the update must still have reached the renderer").toBeDefined();
    // STRIPPED FROM THE PAYLOAD, not merely from the host's copy of the values:
    // `landFormPatch` applies `patch.values` on its own and consults no seed, so
    // a name left standing here would paint the add-in's number in the
    // read-only field a tick after the show refused it — and mark the widget
    // dirty, which is what stops the cell's display text from masking it.
    expect(patch!.values).toEqual({ customer: "Bo" });
    // Everything else in the patch travels untouched: this is one rule about
    // one field, not a quarantine on updating an add-in's form.
    expect(patch!.message).toEqual({ text: "quote ready" });
  });

  it("a bound field the add-in was REFUSED a read of cannot be filled in by the add-in either", async () => {
    const worker = await mountWithForm({ capabilities: ["ui.dialog"] });
    worker.call(100, "ext.formShow", ["quote", { initial: { rate: 42 } }]);
    await settle();
    const request = r.last();
    expect(request).toBeDefined();
    // The box says "this add-in has not been allowed to be shown your cells".
    // A number sitting beside that sentence would make the refusal itself read
    // as a reading — the one case where the empty box IS the message.
    expect(request.seeds.rate.value).toBeNull();
    expect(request.seeds.rate.reason).toBe(EXTENSION_FORM_NO_GRID_READ);
    expect(cellReads).toEqual([]);
  });

  it("the user's answers reach the add-in through its one handler, and its verdict is honoured", async () => {
    const worker = await mountWithForm();
    const seen: Array<{ hook: string; detail: unknown }> = [];
    let refuseOnce = true;
    worker.handlers.set(7, (msg) => {
      seen.push(msg as { hook: string; detail: unknown });
      const hook = (msg as { hook: string }).hook;
      if (hook === "submit" && refuseOnce) {
        refuseOnce = false;
        return { cancel: true, message: "pick a customer" };
      }
      return undefined;
    });

    const request = await show(worker);
    const showId = request.showId;

    // A refused submit keeps the form open — the add-in said so.
    r.input({ showId, kind: "submit", values: { rate: 1234.5, customer: "" } });
    await settle(2);
    expect(seen.some((s) => s.hook === "submit")).toBe(true);
    expect(forms.getActiveScriptForm()?.showId).toBe(showId);

    // ...and an accepted one closes it and hands the answers over.
    r.input({ showId, kind: "submit", values: { rate: 1234.5, customer: "Acme" } });
    await settle(2);
    const closed = seen.find((s) => s.hook === "closed");
    expect(closed?.detail).toEqual({
      showId,
      values: { rate: 1234.5, customer: "Acme" },
    });
    expect(forms.getActiveScriptForm()).toBeNull();
  });

  // --------------------------------------------------------------------------
  // 1c. The hook NAMES the add-in is given
  //
  // The registry calls its session deps back with onShow/onChange/onClick/
  // onClose. Those are HOST-INTERNAL names; what an author writes against is the
  // `ui.forms` JSDoc and the shipped example, both of which say "show", "change",
  // "click", "submit", "closed". Relaying the internal spelling through made the
  // example's own `event.hook === "change"` branch unreachable — its live VAT
  // caption stayed empty for the entire session, with no error anywhere — and
  // only "submit" and "closed" matched, because those two are the only names the
  // relay supplied itself. The two tests below drive a real session and pin the
  // delivered names exactly, including that a close is announced ONCE.
  // --------------------------------------------------------------------------

  it("the add-in's handler is given the PUBLISHED hook names, in order", async () => {
    const worker = await mountWithForm({}, LIVE_FORM);
    const seen: string[] = [];
    worker.handlers.set(7, (msg) => {
      seen.push((msg as { hook: string }).hook);
      return undefined;
    });

    const request = await show(worker);
    const showId = request.showId;

    // A dropdown change is delivered at once — this is the example's Country
    // field, the exact interaction whose caption never updated.
    r.input({ showId, kind: "change", name: "country", value: "DE", values: { country: "DE" } });
    await settle(2);
    // A text change waits out the keystroke debounce and must arrive under the
    // same published name; the debounced path forwards from its own timer, so a
    // translation applied at only one call site would miss it.
    r.input({
      showId,
      kind: "change",
      name: "customer",
      value: "Ac",
      values: { country: "DE", customer: "Ac" },
    });
    await new Promise<void>((res) =>
      setTimeout(res, forms.FORM_TEXT_CHANGE_DEBOUNCE_MS + 100),
    );
    await settle(2);

    r.input({ showId, kind: "click", name: "recalc", values: { country: "DE", customer: "Ac" } });
    await settle(2);
    r.input({ showId, kind: "submit", values: { country: "DE", customer: "Ac" } });
    await settle(2);

    expect(seen).toEqual(["show", "change", "change", "click", "submit", "closed"]);
    // Not one host-internal spelling reached the add-in...
    expect(seen.filter((h) => h.startsWith("on"))).toEqual([]);
    // ...and every name delivered is one the JSDoc promised.
    for (const hook of seen) expect(EXTENSION_FORM_HOOKS).toContain(hook);
  });

  it("a dismissed form announces its teardown ONCE, as the hook that carries the answers", async () => {
    const worker = await mountWithForm({}, LIVE_FORM);
    const seen: Array<{ hook: string; detail: unknown }> = [];
    worker.handlers.set(7, (msg) => {
      seen.push(msg as { hook: string; detail: unknown });
      return undefined;
    });

    const request = await show(worker);
    r.input({ showId: request.showId, kind: "cancel", values: {} });
    await settle(2);

    // The registry announces a close twice (forward("onClose") then closed());
    // the add-in's contract names one. Two teardowns would make an author's
    // cleanup run twice with no way to tell the events apart.
    expect(seen.map((s) => s.hook)).toEqual(["show", "closed"]);
    expect(seen[1].detail).toEqual({ showId: request.showId, values: null });
  });

  it("every hook the registry can forward has a published name or an explicit refusal to deliver", () => {
    // A DRIFT guard, not a restatement: the defect was a new-ish registry hook
    // reaching an add-in under a name no author could match, and the next hook
    // added to scriptForms.ts would do it again silently. Reading the registry's
    // own source is what makes that impossible to miss.
    const registry = fs.readFileSync(path.resolve(__dirname, "../scriptForms.ts"), "utf8");
    const forwarded = new Set(
      [...registry.matchAll(/forward\(\s*"([A-Za-z]+)"/g)].map((m) => m[1]),
    );
    expect(forwarded.size, "the registry must still forward hooks by literal name").toBeGreaterThan(
      0,
    );
    for (const hook of forwarded) {
      expect(
        Object.prototype.hasOwnProperty.call(EXTENSION_FORM_HOOK_RELAY, hook),
        `scriptForms.ts forwards "${hook}" but EXTENSION_FORM_HOOK_RELAY does not say what an add-in should be told`,
      ).toBe(true);
    }
  });

  it("the JSDoc an add-in author reads names exactly the hooks the host sends", () => {
    // CONSENT-TEXT DISCIPLINE APPLIED TO THE AUTHOR CONTRACT: `ui.forms` appears
    // in no generated .d.ts, so this JSDoc IS the published contract. It said
    // "change"/"click" while the host sent "onChange"/"onClick".
    const shim = fs.readFileSync(
      path.resolve(__dirname, "../worker/extensionWorkerContext.ts"),
      "utf8",
    );
    const sentence = /vocabulary is: ([^\n]*)/.exec(shim);
    expect(sentence, "the ui.forms JSDoc must still state the hook vocabulary").not.toBeNull();
    const documented = [...sentence![1].matchAll(/"([a-z]+)"/g)].map((m) => m[1]);
    expect(documented).toEqual([...EXTENSION_FORM_HOOKS]);
  });

  it("an add-in's open form is in the transparency panel's held state, owned by the add-in", async () => {
    const worker = await mountWithForm();
    const request = await show(worker);

    // NOT a second registry: `getActiveScriptForm` is the object-script one, so
    // an add-in form is enumerable for free — which is the reason M4 reuses it.
    const inventory = await import("../../codeInventory");
    const state = await inventory.getScriptHeldState([]);
    expect(state.forms).toHaveLength(1);
    expect(state.forms[0].showId).toBe(request.showId);
    expect(state.forms[0].scriptId).toBe(SCRIPT_ID);
    expect(state.forms[0].ownerName).toBe("Form Add-in");
    expect(state.forms[0].ownerProvenance).toBe("distributed");
  });

  it("unmounting the add-in takes its form down and gives the modal slot back", async () => {
    const worker = await mountWithForm();
    await show(worker);
    expect(forms.getActiveScriptForm()).not.toBeNull();

    await host.resetWorkerExtensions();
    expect(forms.getActiveScriptForm()).toBeNull();
    expect(dialogs.getActiveModal()).toBeNull();
    // ...and the LAYOUT is forgotten too. Asserted separately because the
    // registration teardown alone closes the session — a sabotage that deleted
    // `revokeScriptForms` left this test green until it also asked this. What
    // `revokeScriptForms` uniquely does is forget the layout the show defined
    // and reset the show bucket, so a remount starts clean rather than
    // inheriting a spec from code that is gone.
    expect(forms.getScriptFormSpec(SCRIPT_ID)).toBeNull();
  });

  // --------------------------------------------------------------------------
  // 2. Fail closed
  // --------------------------------------------------------------------------

  it("an UNDECLARED form name is refused, loudly, and can never be shown", async () => {
    const worker = await mount({
      ...BASE_MANIFEST,
      capabilities: ["ui.dialog"],
      contributes: { forms: ["quote"] },
    });
    worker.register({ kind: "form", regId: 1, name: "sneaky", spec: FORM, handlerId: 7 });

    const refusal = host.listExtensionContributions().find((c) => c.id === "sneaky");
    expect(refusal?.refusedReason).toContain("does not list");
    expect(toasts.join(" ")).toContain("sneaky");

    caps.recordCapabilityGrant(SCRIPT_ID, "ui.dialog");
    worker.call(1, "ext.formShow", ["sneaky"]);
    await settle(2);
    expect(r.requests).toHaveLength(0);
    const result = worker.result(1);
    expect(result?.ok).toBe(false);
    expect((result?.error as { message: string }).message).toContain("no form called");
  });

  it("a form kind is refused outright when the add-in did not declare ui.dialog", async () => {
    // The unsigned case too: an unsigned sidecar arrives with its capability
    // list ZEROED, so it lands here and its form never exists.
    const worker = await mount({
      ...BASE_MANIFEST,
      capabilities: [],
      contributes: { forms: ["quote"] },
    });
    worker.register({ kind: "form", regId: 1, name: "quote", spec: FORM, handlerId: 7 });
    const refusal = host.listExtensionContributions().find((c) => c.id === "quote");
    // `?? ""` so a form that was ADMITTED (no refusal at all) fails on the
    // sentence rather than on `toContain(undefined)`, which reads as a broken
    // test instead of a broken gate.
    expect(refusal?.refusedReason ?? "").toContain("ui.dialog");
    expect(CONTRIBUTION_REQUIRED_CAPABILITY.form).toBe("ui.dialog");
  });

  it("without grid.read the form still OPENS, every bound field says why, and NO cell is read", async () => {
    const worker = await mountWithForm({ capabilities: ["ui.dialog"] });
    const request = await show(worker);

    expect(request.seeds.rate.readOnly).toBe(true);
    expect(request.seeds.rate.reason).toBe(EXTENSION_FORM_NO_GRID_READ);
    expect(request.seeds.rate.value).toBeNull();
    // The point of the whole gate: not one cell crossed.
    expect(cellReads).toEqual([]);
    // Degraded, not blank: the user can still see and use the rest of the form.
    expect(request.spec.children).toHaveLength(3);
  });

  it("a grid.read REVOKE bites the next show — the question is asked at delivery, not cached", async () => {
    const worker = await mountWithForm();
    const first = await show(worker, 100);
    expect(first.seeds.rate.value).toBe(1234.5);
    r.input({ showId: first.showId, kind: "cancel", values: {} });
    await settle(2);

    await caps.revokeCapability(SCRIPT_ID, "grid.read");
    cellReads.length = 0;
    const second = await show(worker, 101);
    expect(second.seeds.rate.reason).toBe(EXTENSION_FORM_NO_GRID_READ);
    expect(cellReads).toEqual([]);
  });

  it("...and it still bites after a WORKBOOK SWAP, which does not unmount the add-in", async () => {
    // THE PROMISE ABOVE WAS TRUE ONLY UNTIL THE USER'S FIRST File > Open.
    // `handle.grants` is a live reference to the Set inside the grant store,
    // taken once at mount; `resetAllGrants` was `grantState.clear()`, which
    // drops the Map entry and leaves that Set intact and still referenced. And
    // nothing unmounts a distributed add-in on a workbook swap — no caller of
    // `resetWorkerExtensions` sits on the AFTER_OPEN / AFTER_NEW path — so the
    // add-in kept the orphan: the panel still offered a revoke button,
    // `revokeCapability` returned at its `if (!s) return;` guard, and the next
    // show read the cell anyway (1234.5, reason EXTENSION_FORM_DISPLAY_ONLY).
    const worker = await mountWithForm();
    const first = await show(worker, 100);
    expect(first.seeds.rate.value).toBe(1234.5);
    r.input({ showId: first.showId, kind: "cancel", values: {} });
    await settle(2);

    // The workbook swap. This is the real call, not a stand-in for one — see the
    // hostResetAll assertion below.
    caps.resetAllGrants();

    // Installing the add-in was the consent for grid.read ("granted by
    // installing ... with no further prompt"), and the add-in is still loaded,
    // so the capability is still live — and the STORE says the same thing the
    // handle does, which is what makes the panel's revoke button real.
    expect(caps.getScriptGrants(SCRIPT_ID).caps).toContain("grid.read");
    // ui.dialog was PROMPTED, and that dialog scopes itself to "this workbook",
    // so the next show asks again. This grant stands in for the person saying
    // yes — and it also proves the second half of the orphan: recorded after the
    // reset, it has to land in the very set the handle is holding.
    expect(caps.getScriptGrants(SCRIPT_ID).caps).not.toContain("ui.dialog");
    caps.recordCapabilityGrant(SCRIPT_ID, "ui.dialog");

    // The transparency panel's Revoke button, pressed in the NEW workbook.
    await caps.revokeCapability(SCRIPT_ID, "grid.read");
    expect(caps.getScriptGrants(SCRIPT_ID).caps).not.toContain("grid.read");

    cellReads.length = 0;
    const second = await show(worker, 101);
    expect(second.seeds.rate.reason).toBe(EXTENSION_FORM_NO_GRID_READ);
    expect(second.seeds.rate.value).toBeNull();
    expect(cellReads, "not one cell may cross a revoke made after a workbook swap").toEqual([]);
  });

  it("the workbook swap above is the real File > Open path, not a test-only shortcut", () => {
    // `resetAllGrants()` is what the test calls; hostResetAll is what File >
    // Open and File > New call (ScriptableObjects/index.ts AFTER_OPEN /
    // AFTER_NEW -> resetObjectScriptManager -> hostResetAll). Read from source
    // so the test above cannot go on standing in for a path that has moved.
    const src = fs.readFileSync(path.resolve(__dirname, "../host.ts"), "utf8");
    const start = src.indexOf("export function hostResetAll()");
    expect(start, "hostResetAll must still exist under that name").toBeGreaterThan(-1);
    const next = src.indexOf("\nexport ", start + 1);
    const body = src.slice(start, next === -1 ? undefined : next);
    expect(body).toContain("resetAllGrants()");
  });

  /**
   * Mount an add-in with TWO declared bound forms and register only the first,
   * then have the user revoke grid.read. Returns the worker, primed for the
   * registration that used to put the capability straight back.
   */
  async function registerThenRevoke(): Promise<FakeWorker> {
    const worker = await mount({
      ...BASE_MANIFEST,
      capabilities: ["ui.dialog", "grid.read"],
      contributes: { forms: ["quote", "other"] },
    });
    worker.register({ kind: "form", regId: 1, name: "quote", spec: FORM, handlerId: 7 });
    caps.recordCapabilityGrant(SCRIPT_ID, "ui.dialog");
    // Asserted, not assumed: without the grant actually arriving first, the
    // revoke below would have nothing to bite and this test would pass empty.
    expect(caps.getScriptGrants(SCRIPT_ID).caps).toContain("grid.read");

    // The transparency panel's Revoke button, exactly (PermissionsPanel.tsx).
    await caps.revokeCapability(SCRIPT_ID, "grid.read");
    expect(caps.getScriptGrants(SCRIPT_ID).caps).not.toContain("grid.read");
    return worker;
  }

  /** A second declared form, also tied to B2. */
  const OTHER_BOUND_FORM = {
    title: "Other",
    children: [{ type: "number", name: "rate", label: "Rate from B2", bind: "B2" }],
  } as FormSpec;

  it("a REVOKED grid.read is not put back by registering another bound form", async () => {
    // `register` is a message the worker may post at any moment after activate —
    // from a command click, an event handler, a scheduled job — so registration
    // is an attacker-timed event. Writing the grant down unconditionally let an
    // add-in undo the user's revoke by declaring a second form and registering
    // it: the grant set came back as ["ui.dialog","grid.read"], with no prompt
    // and no toast, and the delivery-time check in resolveExtensionFormBindings
    // was then handed a set the user had already emptied.
    const worker = await registerThenRevoke();

    worker.register({
      kind: "form",
      regId: 2,
      name: "other",
      spec: OTHER_BOUND_FORM,
      handlerId: 8,
    });

    expect(
      caps.getScriptGrants(SCRIPT_ID).caps,
      "registering a form must never restore a capability the user revoked",
    ).not.toContain("grid.read");

    // ...and the panel says so rather than promising a reach this form has not
    // got: "shows you 1 cell" beside a field the user will see greyed out is the
    // transparency panel contradicting the form.
    const listed = host.listExtensionContributions().find((c) => c.id === "other");
    expect(listed?.refusedReason).toBeUndefined();
    expect(listed?.label).toContain("not allowed to be shown");

    // The consequence the user actually sees: the next show still refuses.
    cellReads.length = 0;
    const request = await show(worker, 101);
    expect(request.seeds.rate.reason).toBe(EXTENSION_FORM_NO_GRID_READ);
    expect(request.seeds.rate.value).toBeNull();
    expect(cellReads, "not one cell may cross after the revoke").toEqual([]);
  });

  it("a REVOKED grid.read is not put back by re-registering the SAME form", async () => {
    // The cheaper variant, and the one that needs no second declared form at
    // all: `unregister` runs the cleanup that drops the name, so registering it
    // again passes the duplicate refusal and reached the grant write. A one-form
    // add-in could therefore restore a revoked grid.read on demand, in a loop.
    const worker = await registerThenRevoke();

    worker.emit({ t: "unregister", regId: 1 });
    worker.register({ kind: "form", regId: 3, name: "quote", spec: FORM, handlerId: 9 });

    expect(
      caps.getScriptGrants(SCRIPT_ID).caps,
      "unregister/re-register must not launder a revoked capability",
    ).not.toContain("grid.read");

    cellReads.length = 0;
    const request = await show(worker, 102);
    expect(request.seeds.rate.reason).toBe(EXTENSION_FORM_NO_GRID_READ);
    expect(cellReads).toEqual([]);
  });

  it("the withheld grant is AUDITED, so the user can confirm their revoke took", async () => {
    const worker = await registerThenRevoke();
    worker.register({
      kind: "form",
      regId: 2,
      name: "other",
      spec: OTHER_BOUND_FORM,
      handlerId: 8,
    });
    const withheld = audit
      .getAuditTail()
      .filter((e) => e.method === "ext.withheld.grid.read.form");
    expect(withheld).toHaveLength(1);
    expect(withheld[0].scriptId).toBe(SCRIPT_ID);
    expect(withheld[0].ok).toBe(false);
  });

  it("unregistering a DIFFERENT form leaves the open one alone", async () => {
    // An add-in may declare several forms. Closing on every unregister took the
    // user's open dialog away mid-answer because an unrelated registration was
    // torn down; the SESSION a registration opened is what says which form is
    // actually up. (The two "after a REFUSED show" tests below cover the case
    // this one cannot: with only successful shows, the registry's defined
    // layout happens to agree, so this test passed for the wrong reason too.)
    const worker = await mount({
      ...BASE_MANIFEST,
      capabilities: ["ui.dialog", "grid.read"],
      contributes: { forms: ["quote", "other"] },
    });
    worker.register({ kind: "form", regId: 1, name: "quote", spec: FORM, handlerId: 7 });
    worker.register({
      kind: "form",
      regId: 2,
      name: "other",
      spec: { children: [{ type: "label", text: "hi" }] } as FormSpec,
      handlerId: 8,
    });
    caps.recordCapabilityGrant(SCRIPT_ID, "ui.dialog");
    await show(worker);
    expect(forms.getActiveScriptForm()).not.toBeNull();

    worker.emit({ t: "unregister", regId: 2 });
    expect(forms.getActiveScriptForm(), "the OPEN form was 'quote', not 'other'").not.toBeNull();
  });

  it("unregistering the form drops it and closes the session it was painting", async () => {
    const worker = await mountWithForm();
    await show(worker);
    expect(forms.getActiveScriptForm()).not.toBeNull();

    worker.emit({ t: "unregister", regId: 1 });
    expect(forms.getActiveScriptForm()).toBeNull();
    expect(host.listExtensionContributions().filter((c) => c.kind === "form")).toEqual([]);

    worker.call(2, "ext.formShow", ["quote"]);
    await settle(2);
    expect(worker.result(2)?.ok).toBe(false);
  });

  /**
   * Two declared forms: show "quote", then let a show of "other" be REFUSED by
   * the per-script modal slot. Returns the request that is actually on screen.
   *
   * THE REFUSAL IS THE WHOLE POINT. `ext.formShow` re-declares the registry's
   * single "form" layout BEFORE calling showScriptForm, and every guard in
   * there — both modal slots, the show bucket, the dismissal mute — refuses
   * AFTER that swap. So the defined layout ends up naming a form nobody was
   * ever shown, and anything that reads the layout as "which form is up" is
   * then wrong about the form the user is looking at.
   */
  async function showQuoteThenRefuseOther(): Promise<{
    worker: FakeWorker;
    open: ScriptFormRequestPayload;
  }> {
    const worker = await mount({
      ...BASE_MANIFEST,
      capabilities: ["ui.dialog", "grid.read"],
      contributes: { forms: ["quote", "other"] },
    });
    worker.register({ kind: "form", regId: 1, name: "quote", spec: FORM, handlerId: 7 });
    worker.register({
      kind: "form",
      regId: 2,
      name: "other",
      spec: { children: [{ type: "label", text: "hi" }] } as FormSpec,
      handlerId: 8,
    });
    caps.recordCapabilityGrant(SCRIPT_ID, "ui.dialog");
    const open = await show(worker);

    worker.call(900, "ext.formShow", ["other"]);
    await settle(2);
    const refused = worker.result(900);
    // Asserted, not assumed: if this show ever starts SUCCEEDING the two tests
    // below would still pass while testing nothing at all.
    expect(refused?.ok, "the second show must be refused for these tests to mean anything").toBe(
      false,
    );
    expect((refused?.error as { message: string }).message).toContain("already has a dialog open");
    expect(forms.getActiveScriptForm()?.showId).toBe(open.showId);
    return { worker, open };
  }

  it("after a REFUSED show, unregistering the OPEN form still closes it", async () => {
    // The registration whose form is on screen goes away — its own disposer
    // deleted the worker-side handler before posting this, so a session left up
    // relays Submit into nothing, and a failed relay is read as ACCEPT: the
    // user's answers would go nowhere while the app-wide modal slot stayed
    // held. Keyed on the layout, the identity check missed this entirely, since
    // the refused show had re-pointed the layout at "other".
    const { worker, open } = await showQuoteThenRefuseOther();

    worker.emit({ t: "unregister", regId: 1 });
    expect(
      forms.getActiveScriptForm(),
      `the open form (${open.showId}) outlived the registration that opened it`,
    ).toBeNull();
    // ...and the shared slot came back with it, so another script can ask.
    expect(dialogs.getActiveModal()).toBeNull();
  });

  it("after a REFUSED show, unregistering the form that was refused leaves the open one alone", async () => {
    // The mirror direction, and the worse of the two: the user is half way
    // through "quote" and an unrelated registration going away must not take it
    // off the screen. The sibling test above (no refused show) passed on the
    // layout check by luck; with the layout re-pointed it closed the wrong one.
    const { worker, open } = await showQuoteThenRefuseOther();

    worker.emit({ t: "unregister", regId: 2 });
    expect(
      forms.getActiveScriptForm()?.showId,
      "unregistering the form that was never shown took the user's open form away",
    ).toBe(open.showId);
  });

  // --------------------------------------------------------------------------
  // 3. The narrowing — refused BY NAME, and only on this surface
  // --------------------------------------------------------------------------

  describe("what an add-in's form may not ask for", () => {
    /** One input widget carrying `extra`, wrapped in a minimal legal form. */
    const withInput = (extra: Record<string, unknown>): FormSpec =>
      ({
        children: [{ type: "textbox", name: "f", label: "F", ...extra }],
      }) as unknown as FormSpec;

    const CASES: Array<{ what: string; spec: FormSpec; says: RegExp }> = [
      {
        what: "a defined name",
        // The message is asserted PRECISELY, not just for the words "defined
        // name": the fallback A1-shape check refuses the same tree with a
        // different sentence, so a loose regex passed with the `{ name }` arm
        // deleted — which a sabotage caught. The two guards are distinguishable
        // here because the assertion names the sentence only the `{ name }` arm
        // produces.
        spec: withInput({ bind: { name: "TaxRate" } }),
        says: /the same name means a different range in every workbook/i,
      },
      {
        what: "a Controls-pane value",
        spec: withInput({ bind: { control: "Region" } }),
        says: /Controls pane/i,
      },
      {
        what: "a sheet-qualified cell",
        spec: withInput({ bind: "Budget!B2" }),
        says: /resolves differently in every workbook/i,
      },
      {
        what: "an explicit sheet",
        spec: withInput({ bind: { cell: "B2", sheet: "Budget" } }),
        says: /sheet you were looking at/i,
      },
      {
        what: "a bare defined name as a string",
        spec: withInput({ bind: "TaxRate" }),
        says: /resolves differently in every workbook/i,
      },
      {
        what: "writing back on change",
        spec: withInput({ bind: "B2", writeOn: "change" }),
        says: /never written back/i,
      },
      {
        what: "writing back on submit",
        spec: withInput({ bind: "B2", writeOn: "submit" }),
        says: /never written back/i,
      },
      {
        what: "a form-level writeOn",
        spec: { writeOn: "change", children: [{ type: "label", text: "hi" }] } as FormSpec,
        says: /never written back/i,
      },
      {
        what: "a choice list read from the workbook",
        spec: {
          children: [
            { type: "dropdown", name: "d", label: "D", options: { range: "A1:A9" } },
          ],
        } as unknown as FormSpec,
        says: /cannot be read from a range/i,
      },
      {
        what: "a table read from the workbook",
        spec: {
          children: [
            { type: "table", columns: ["A"], rows: { range: "A1:A9" } },
          ],
        } as unknown as FormSpec,
        says: /cannot be read from a range/i,
      },
      {
        what: "a picture out of the workbook",
        spec: {
          children: [
            {
              type: "image",
              src: `media:${"a1b2c3d4".repeat(8)}`,
            },
          ],
        } as unknown as FormSpec,
        says: /cannot show a picture stored in your workbook/i,
      },
    ];

    for (const c of CASES) {
      it(`refuses ${c.what} — by name, with the reason`, async () => {
        // The wire validator refuses it...
        const verdict = checkFormSpec(c.spec, "extension");
        expect(verdict, `${c.what} must be refused`).not.toBe(true);
        expect(String(verdict)).toMatch(c.says);
        // ...and the SAME tree is still legal for an object script, so the extra
        // rules belong to the SURFACE and not to the widget vocabulary.
        expect(checkFormSpec(c.spec), `${c.what} must stay legal for a script`).toBe(true);

        // ...and the host refuses the CONTRIBUTION with that same sentence, so
        // the author meets it at registration rather than at show time.
        const worker = await mountWithForm({}, c.spec);
        const refusal = host.listExtensionContributions().find((c2) => c2.id === "quote");
        expect(refusal?.refusedReason).toMatch(c.says);
        worker.terminate();
      });
    }

    it("a plain cell on the sheet in front of the user is what remains", () => {
      expect(checkFormSpec(withInput({ bind: "B2" }), "extension")).toBe(true);
      expect(checkFormSpec(withInput({ bind: { cell: "$B$2" } }), "extension")).toBe(true);
    });
  });

  // --------------------------------------------------------------------------
  // 4. No write path — the promise, kept structurally
  // --------------------------------------------------------------------------

  describe("an add-in's form never writes its bound cell", () => {
    it("the reach note promises the BINDING, and no longer the absolute claim", () => {
      const note = CONTRIBUTION_REACH_NOTE.form!;
      expect(note).toContain("grid.read");
      expect(note).toMatch(/display only/i);
      // The narrow claim — the one the code below keeps structurally.
      expect(note).toMatch(/never writes that cell back/i);
      // ...and NOT the absolute one this note used to end with ("nothing you do
      // in one of its forms is ever written into your workbook"). A form's
      // button relays into the add-in's own handler, which can call
      // `ext.executeCommand` and run a script-safe command that writes cells —
      // reproduced end to end two tests below. A consent sentence a reachable
      // door falsifies is the defect class this whole file exists for.
      expect(note).not.toMatch(/nothing you do in one of its forms is ever written/i);
    });

    it("a button in an add-in's form CAN change cells, through the command door", async () => {
      // THE FAILURE SCENARIO THE CONSENT TEXT USED TO DENY, run for real. The
      // add-in declares `forms` and nothing else; its submit handler makes the
      // same broker call `context.commands.executeCommand` makes inside the
      // worker (worker/extensionWorkerContext.ts). Nothing here is exotic — this
      // is a form with a button, which the extension-surface validator allows.
      const { CommandRegistry, CoreCommands } = await import("../../commands");
      const ran: unknown[] = [];
      CommandRegistry.register(
        "vendor.flashfill",
        (args: unknown) => {
          ran.push(args);
          return "wrote 3 cells";
        },
        // The opt-in a real feature makes: extensions/FlashFill/index.ts
        // registers `flashfill.execute` exactly this way, and it commits cell
        // writes inside a "Flash Fill" undo transaction.
        { scriptSafe: true },
      );
      try {
        const worker = await mountWithForm();
        worker.handlers.set(7, (msg: unknown) => {
          const { hook } = msg as { hook: string };
          if (hook === "submit") {
            worker.call(200, "ext.executeCommand", ["vendor.flashfill", { range: "A1:A3" }]);
          }
          return undefined;
        });
        const request = await show(worker);
        r.input({
          showId: request.showId,
          kind: "submit",
          values: { rate: 999, customer: "Acme" },
        });
        await settle(4);

        // The user pressed the form's button; a cell-writing command ran.
        expect(ran).toEqual([{ range: "A1:A3" }]);
        expect(worker.result(200)).toMatchObject({ ok: true, value: "wrote 3 cells" });
        worker.terminate();
      } finally {
        CommandRegistry.unregister("vendor.flashfill");
      }

      // It cost NOTHING: no capability on the row (so no JIT prompt), and the
      // add-in declared no `commands` contribution — which is why the
      // disclosure cannot hang off a declared kind and is stated once, for
      // every add-in, in EXTENSION_BUILTIN_ACTION_REACH_NOTE.
      expect(ALLOWLIST["ext.executeCommand"].capability).toBeUndefined();
      // And Calcula's own mutating commands need no registration at all to be
      // script-safe — the reason that note names clearing, filling and deleting
      // rows rather than only "commands the add-in installed".
      expect(CommandRegistry.isScriptSafe(CoreCommands.CLEAR_ALL)).toBe(true);
      expect(CommandRegistry.isScriptSafe(CoreCommands.DELETE_ROW)).toBe(true);
      expect(CommandRegistry.isScriptSafe(CoreCommands.FILL_DOWN)).toBe(true);
    });

    it("every surface that describes a form's reach discloses that door", () => {
      // DERIVED FROM THE DOOR, not from prose: the disclosure is owed only while
      // `ext.executeCommand` is genuinely reachable from this realm with no
      // capability. Close that door and this test is what tells you the
      // sentences may go back to the absolute form.
      expect(EXTENSION_BROKER_METHODS.has("ext.executeCommand")).toBe(true);
      expect(ALLOWLIST["ext.executeCommand"].capability).toBeUndefined();

      const dialog = fs.readFileSync(
        path.resolve(__dirname, "../../../../extensions/ExtensionsManager/InstallAddInDialog.tsx"),
        "utf8",
      );
      const manager = fs.readFileSync(
        path.resolve(__dirname, "../../../shell/registries/ExtensionManager.ts"),
        "utf8",
      );
      const surfaces: Array<{ where: string; text: string }> = [
        { where: "CONTRIBUTION_REACH_NOTE.form", text: CONTRIBUTION_REACH_NOTE.form! },
        { where: "InstallAddInDialog.tsx", text: dialog },
        { where: "ExtensionManager.ts (mount consent prompt)", text: manager },
      ];
      for (const { where, text } of surfaces) {
        expect(text, `${where} still makes the absolute claim`).not.toMatch(
          /nothing you do in one of its forms is ever written/i,
        );
      }
      // Both consent SCREENS render the shared sentence rather than a copy of
      // it — one door, one sentence, so neither can drift on its own. Matched on
      // the RENDER form (`{...}` in JSX, `${...}` in the prompt's template), not
      // on the bare identifier: an import line alone would satisfy that and the
      // sentence would reach nobody.
      expect(dialog, "the install screen must RENDER the shared note").toContain(
        "{EXTENSION_BUILTIN_ACTION_REACH_NOTE}",
      );
      expect(manager, "the mount consent prompt must RENDER the shared note").toContain(
        "${EXTENSION_BUILTIN_ACTION_REACH_NOTE}",
      );
      // ...and the sentence itself says the two things a user needs: that these
      // actions are Calcula's own, and that they CHANGE the workbook.
      expect(EXTENSION_BUILTIN_ACTION_REACH_NOTE).toMatch(/CHANGE your workbook/);
      expect(EXTENSION_BUILTIN_ACTION_REACH_NOTE).toMatch(/no permission/i);
    });

    it("no method that lets an add-in NAME a cell is reachable from this realm", () => {
      // SCOPE, stated because this guard was once read as proving more than it
      // does: it says the add-in cannot address a cell of its own choosing. It
      // does NOT say the realm cannot cause a write — `ext.executeCommand` runs
      // script-safe commands over the user's SELECTION and passes this prefix
      // test while being a cell-writing door by proxy (the test above).
      for (const method of EXTENSION_BROKER_METHODS) {
        expect(method, `${method} would let an add-in name a cell`).not.toMatch(
          /^(sheet|api|base)\./,
        );
        expect(ALLOWLIST[method], `${method} has no policy row`).toBeDefined();
      }
      // Nor by proxy through the object-script form doors.
      for (const method of ["form.define", "form.show", "cap.formsShow", "form.readControl"]) {
        expect(EXTENSION_BROKER_METHODS.has(method), method).toBe(false);
      }
    });

    it("the session the host hands the registry carries NO writeBindings dep", async () => {
      // The registry writes a cell only when this dep is present; its absence
      // IS the read-only guarantee, so it is asserted rather than trusted.
      const worker = await mountWithForm();
      const captured: Array<Record<string, unknown>> = [];
      const realShow = forms.showScriptForm;
      const spy = vi
        .spyOn(forms, "showScriptForm")
        .mockImplementation(async (args: Parameters<typeof realShow>[0]) => {
          captured.push(args.deps as unknown as Record<string, unknown>);
          return realShow(args);
        });
      await show(worker);
      spy.mockRestore();
      expect(captured).toHaveLength(1);
      expect(captured[0].writeBindings).toBeUndefined();
    });

    it("every ext.form* call is written to the per-workbook audit trail by the broker", async () => {
      // No Rust gate sees any of these, so the broker's write-through is the
      // ONLY record that survives a reload — and "which add-in put a form in
      // front of me" is precisely the question an add-in makes urgent, because
      // its code lives outside the workbook and follows the user into every one.
      const { capabilityAuditClassification } = await import("../broker");
      const { brokerAudited, serverAudited } = capabilityAuditClassification();
      for (const method of ["ext.formShow", "ext.formUpdate", "ext.formClose"]) {
        expect(brokerAudited.has(method), method).toBe(true);
        expect(serverAudited.has(method), method).toBe(false);
      }
    });

    it("the add-in surface adds NO second form registry and NO second painter", () => {
      // Read from source, because "it uses the same registry" is exactly the
      // kind of claim that survives in prose after a copy has been pasted. The
      // whole value of M4 riding scriptForms.ts is that the modal slot, the
      // deadlines, the dismissal mute and the transparency row are ONE
      // implementation; a second one here would be a second place for each of
      // them to drift, and the user-visible cost is a form nobody can enumerate.
      const src = fs.readFileSync(
        path.resolve(__dirname, "../extensionWorkerHost.ts"),
        "utf8",
      );
      expect(src).toMatch(/from "\.\/scriptForms"/);
      expect(src).toContain("showScriptForm(");
      // No registry of its own: no session map, no modal-slot claim, no ack
      // timer, no renderer event emitted from this module.
      expect(src).not.toContain("claimModalSlot");
      expect(src).not.toContain("SCRIPT_FORM_REQUEST_EVENT");
      expect(src).not.toMatch(/FORM_SHOWN_ACK_TIMEOUT_MS/);
      // ...and no widget painting: the tree is DATA here and stays data.
      expect(src).not.toContain("FormWidgetTree");
      expect(src).not.toMatch(/case "textbox"/);
    });

    it("submitting writes nothing to the grid", async () => {
      const worker = await mountWithForm();
      worker.handlers.set(7, () => undefined);
      const request = await show(worker);
      cellReads.length = 0;
      r.input({
        showId: request.showId,
        kind: "submit",
        values: { rate: 999, customer: "Acme" },
      });
      await settle(2);
      // The mocked lib exposes NO write function at all, so a write would have
      // thrown; this asserts the weaker, stabler property — the pipeline did
      // not even go back to the grid.
      expect(cellReads).toEqual([]);
      expect(forms.getActiveScriptForm()).toBeNull();
    });
  });
});
