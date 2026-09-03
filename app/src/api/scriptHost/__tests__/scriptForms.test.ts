//! FILENAME: app/src/api/scriptHost/__tests__/scriptForms.test.ts
// PURPOSE: The host half of script-defined forms — sessions, the shared modal
//          slot, the dismissal streak, the deadlines and the rate buckets.
// CONTEXT: The invariant worth the most: an OPEN form always settles. Cancel,
//          Escape, the deadlines, a script's own close, an unmount and a
//          workbook reset all deliver `closed(showId, null | result)` exactly
//          once, and the modal slot is given back on every one of them — a
//          form that leaked its slot would block every later dialog in the
//          session, which is the wedge the e2e suite could not explain.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

import {
  FORM_IDLE_DEADLINE_MS,
  FORM_MAX_OPEN_MS,
  FORM_SHOWN_ACK_TIMEOUT_MS,
  FORM_TEXT_CHANGE_DEBOUNCE_MS,
  closeScriptForm,
  defineScriptForm,
  getActiveScriptForm,
  getScriptFormSpec,
  refreshScriptFormSeeds,
  resetScriptForms,
  revokeScriptForms,
  showScriptForm,
  updateScriptForm,
  type FormSessionDeps,
} from "../scriptForms";
import {
  FORM_SHOWS_PER_MINUTE,
  FORM_UPDATE_PER_SECOND,
  SCRIPT_FORM_CLOSE_EVENT,
  SCRIPT_FORM_INPUT_EVENT,
  SCRIPT_FORM_PATCH_EVENT,
  SCRIPT_FORM_REQUEST_EVENT,
  type FormSpec,
  type ScriptFormClosePayload,
  type ScriptFormInputPayload,
  type ScriptFormPatchPayload,
  type ScriptFormRequestPayload,
} from "../scriptFormSpec";
import { requestScriptDialog, resetScriptDialogs, getActiveModal } from "../scriptDialogs";
import { emitAppEvent } from "../../events";
import { BrokerError } from "../broker";

// ----------------------------------------------------------------------------
// Harness
// ----------------------------------------------------------------------------

const SPEC: FormSpec = {
  title: "Order entry",
  children: [
    { type: "textbox", name: "customer", label: "Customer", required: true },
    { type: "checkbox", name: "rush", label: "Rush" },
    { type: "button", name: "suggest", text: "Suggest" },
  ],
};

interface RecordingDeps extends FormSessionDeps {
  forwarded: Array<{ hook: string; payload: unknown }>;
  mirrors: Array<{ path: string; value: unknown }>;
  closedWith: Array<{ showId: string; result: unknown }>;
  suspended: number;
  resumed: number;
  relaySubmit: ReturnType<typeof vi.fn>;
}

function recordingDeps(): RecordingDeps {
  const deps: RecordingDeps = {
    forwarded: [],
    mirrors: [],
    closedWith: [],
    suspended: 0,
    resumed: 0,
    relaySubmit: vi.fn(async () => null),
    forward: (hook, payload) => deps.forwarded.push({ hook, payload }),
    mirror: (path, value) => deps.mirrors.push({ path, value }),
    closed: (showId, result) => deps.closedWith.push({ showId, result }),
    suspendDeadlines: () => {
      deps.suspended += 1;
    },
    resumeDeadlines: () => {
      deps.resumed += 1;
    },
  };
  return deps;
}

/** Stand in for the trusted renderer: capture what the host emits, answer back. */
function renderer() {
  const requests: ScriptFormRequestPayload[] = [];
  const patches: ScriptFormPatchPayload[] = [];
  const closes: ScriptFormClosePayload[] = [];
  const onReq = (e: Event) => requests.push((e as CustomEvent).detail as ScriptFormRequestPayload);
  const onPatch = (e: Event) => patches.push((e as CustomEvent).detail as ScriptFormPatchPayload);
  const onClose = (e: Event) => closes.push((e as CustomEvent).detail as ScriptFormClosePayload);
  window.addEventListener(SCRIPT_FORM_REQUEST_EVENT, onReq);
  window.addEventListener(SCRIPT_FORM_PATCH_EVENT, onPatch);
  window.addEventListener(SCRIPT_FORM_CLOSE_EVENT, onClose);
  const input = (payload: ScriptFormInputPayload) => emitAppEvent(SCRIPT_FORM_INPUT_EVENT, payload);
  return {
    requests,
    patches,
    closes,
    last: () => requests[requests.length - 1],
    shown: (showId: string, values: Record<string, unknown> = {}) =>
      input({ showId, kind: "shown", values: values as ScriptFormInputPayload["values"] }),
    change: (showId: string, name: string, value: unknown, values: Record<string, unknown>) =>
      input({
        showId,
        kind: "change",
        name,
        value: value as ScriptFormInputPayload["value"],
        values: values as ScriptFormInputPayload["values"],
      }),
    click: (showId: string, name: string) => input({ showId, kind: "click", name, values: {} }),
    interaction: (showId: string) => input({ showId, kind: "interaction", values: {} }),
    submit: (showId: string, values: Record<string, unknown>) =>
      input({ showId, kind: "submit", values: values as ScriptFormInputPayload["values"] }),
    cancel: (showId: string) => input({ showId, kind: "cancel", values: {} }),
    stop: () => {
      window.removeEventListener(SCRIPT_FORM_REQUEST_EVENT, onReq);
      window.removeEventListener(SCRIPT_FORM_PATCH_EVENT, onPatch);
      window.removeEventListener(SCRIPT_FORM_CLOSE_EVENT, onClose);
    },
  };
}

const OWNER = { scriptId: "form-1", scriptName: "Order entry", scriptOrigin: "local" };

/** Define + show + acknowledge, the happy start every session shares. */
async function open(
  r: ReturnType<typeof renderer>,
  deps: RecordingDeps,
  owner = OWNER,
): Promise<string> {
  defineScriptForm(owner.scriptId, SPEC);
  const promise = showScriptForm({ ...owner, deps });
  const { showId } = r.last();
  r.shown(showId, { customer: "", rush: false });
  await expect(promise).resolves.toEqual({ showId });
  return showId;
}

describe("scriptForms — sessions", () => {
  let r: ReturnType<typeof renderer>;
  let deps: RecordingDeps;

  beforeEach(() => {
    resetScriptDialogs();
    resetScriptForms();
    r = renderer();
    deps = recordingDeps();
  });
  afterEach(() => {
    r.stop();
    resetScriptForms();
    resetScriptDialogs();
    vi.useRealTimers();
  });

  it("refuses to show a form nobody defined", async () => {
    await expect(showScriptForm({ ...OWNER, deps })).rejects.toBeInstanceOf(BrokerError);
    expect(r.requests).toHaveLength(0);
    expect(getActiveModal()).toBeNull();
  });

  it("remembers the layout per script", () => {
    defineScriptForm(OWNER.scriptId, SPEC);
    expect(getScriptFormSpec(OWNER.scriptId)).toBe(SPEC);
    expect(getScriptFormSpec("nobody")).toBeNull();
  });

  it("emits a data-only request with HOST-supplied identity and resolves when SHOWN", async () => {
    defineScriptForm(OWNER.scriptId, SPEC);
    const promise = showScriptForm({
      ...OWNER,
      initial: { customer: "Ada", notAWidget: 1, suggest: "x" },
      deps,
    });
    expect(r.requests).toHaveLength(1);
    const req = r.last();
    expect(req.scriptName).toBe("Order entry");
    expect(req.scriptOrigin).toBe("local");
    expect(req.spec).toBe(SPEC);
    // Only INPUT widgets are seeded — a button and an unknown name are dropped.
    expect(Object.keys(req.seeds)).toEqual(["customer"]);
    expect(req.seeds.customer).toEqual({ value: "Ada" });
    expect(getActiveScriptForm()?.showId).toBe(req.showId);
    // Not resolved yet: nothing acknowledged the paint.
    let settled = false;
    void promise.then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);
    r.shown(req.showId, { customer: "Ada", rush: false });
    await expect(promise).resolves.toEqual({ showId: req.showId });
    expect(deps.suspended).toBe(1);
    expect(deps.mirrors).toContainEqual({ path: "form.isOpen", value: true });
    expect(deps.forwarded[0]).toEqual({ hook: "onShow", payload: { values: { customer: "Ada", rush: false } } });
  });

  it("cancel closes as null, forwards onClose, resumes the clock and frees the slot", async () => {
    const showId = await open(r, deps);
    r.cancel(showId);
    expect(r.closes).toEqual([{ showId, reason: "cancel" }]);
    expect(deps.closedWith).toEqual([{ showId, result: null }]);
    expect(deps.forwarded.at(-1)).toEqual({ hook: "onClose", payload: { reason: "cancel", values: { customer: "", rush: false } } });
    expect(deps.resumed).toBe(1);
    expect(deps.mirrors.at(-1)).toEqual({ path: "form.isOpen", value: false });
    expect(getActiveModal()).toBeNull();
    // The slot is free: the next show works.
    const again = showScriptForm({ ...OWNER, deps });
    r.shown(r.last().showId);
    await expect(again).resolves.toBeTruthy();
  });

  it("closes exactly once however many terminal events arrive", async () => {
    const showId = await open(r, deps);
    r.cancel(showId);
    r.cancel(showId);
    r.submit(showId, { customer: "x" });
    expect(deps.closedWith).toHaveLength(1);
    expect(r.closes).toHaveLength(1);
  });

  it("submit with no objection closes with the typed values", async () => {
    const showId = await open(r, deps);
    r.submit(showId, { customer: "Ada", rush: true });
    await vi.waitFor(() => expect(deps.closedWith).toHaveLength(1));
    expect(deps.relaySubmit).toHaveBeenCalledWith({ customer: "Ada", rush: true });
    expect(deps.closedWith[0]).toEqual({ showId, result: { customer: "Ada", rush: true } });
    expect(r.closes[0].reason).toBe("submit");
  });

  it("a cancelling verdict keeps the form open and paints the errors", async () => {
    deps.relaySubmit.mockResolvedValueOnce({ cancel: true, errors: { customer: "Unknown customer" }, message: "Check the name" });
    const showId = await open(r, deps);
    r.submit(showId, { customer: "Bob", rush: false });
    await vi.waitFor(() => expect(r.patches).toHaveLength(1));
    expect(r.patches[0]).toEqual({
      showId,
      refused: true,
      errors: { customer: "Unknown customer" },
      message: { text: "Check the name", kind: "error" },
    });
    expect(deps.closedWith).toHaveLength(0);
    expect(getActiveScriptForm()?.showId).toBe(showId);
    // A second submit, now accepted, closes it.
    r.submit(showId, { customer: "Ada", rush: false });
    await vi.waitFor(() => expect(deps.closedWith).toHaveLength(1));
    expect(deps.closedWith[0].result).toEqual({ customer: "Ada", rush: false });
  });

  it("a BARE refusal still says 'refused', so the renderer can leave its pending state", async () => {
    // `false` and `"cancel"` both normalize to `{ cancel: true }` with no
    // errors and no message (normalizeFormSubmitVerdict, host.ts) — VBA's
    // `Cancel = True`. A renderer that infers refusal from errors-or-message
    // reads this payload as "not refused" and leaves Submit and Cancel
    // disabled showing "Working…" forever; the only way out was to close the
    // dialog, which orphaned the session holding the app-wide modal slot.
    deps.relaySubmit.mockResolvedValueOnce({ cancel: true });
    const showId = await open(r, deps);
    r.submit(showId, { customer: "Ada", rush: false });
    await vi.waitFor(() => expect(r.patches).toHaveLength(1));
    expect(r.patches[0]).toEqual({ showId, refused: true, errors: undefined, message: undefined });
    expect(deps.closedWith).toHaveLength(0);
    expect(getActiveScriptForm()?.showId).toBe(showId);
    // ...and the form is still usable: a second submit, accepted, closes it.
    r.submit(showId, { customer: "Ada", rush: false });
    await vi.waitFor(() => expect(deps.closedWith).toHaveLength(1));
  });

  it("a script's value patch is coerced like the widget, so form.values agrees with the screen", async () => {
    // `form.control("amount").set("7")` lands as the NUMBER 7 on a number
    // widget; mirroring the raw "7" made form.values disagree with the form
    // and with what a submit would write, until the next thing the user did.
    defineScriptForm(OWNER.scriptId, {
      children: [
        { type: "number", name: "amount", label: "Amount" },
        { type: "checkbox", name: "rush", label: "Rush" },
        { type: "listbox", name: "tags", label: "Tags", options: ["a", "b"], multi: true },
        { type: "listbox", name: "one", label: "One", options: ["a", "b"] },
      ],
    });
    const promise = showScriptForm({ ...OWNER, deps });
    const showId = r.last().showId;
    r.shown(showId, { amount: null, rush: false, tags: [], one: "" });
    await promise;
    updateScriptForm(OWNER.scriptId, {
      values: { amount: "7", rush: "TRUE", tags: "a", one: ["b"] },
    });
    expect(deps.mirrors.at(-1)?.value).toMatchObject({
      amount: 7,
      rush: true,
      tags: ["a"],
      one: "b",
    });
    void showId;
  });

  it("the script can close its own form and choose the answer", async () => {
    const showId = await open(r, deps);
    closeScriptForm(OWNER.scriptId, { customer: "from script" });
    expect(r.closes).toEqual([{ showId, reason: "script" }]);
    expect(deps.closedWith).toEqual([{ showId, result: { customer: "from script" } }]);
    // Closing again is a no-op.
    expect(() => closeScriptForm(OWNER.scriptId, null)).not.toThrow();
    expect(deps.closedWith).toHaveLength(1);
  });

  it("clicks and changes reach the worker; text changes are debounced, discrete ones are not", async () => {
    vi.useFakeTimers();
    const showId = await open(r, deps);
    r.click(showId, "suggest");
    expect(deps.forwarded.at(-1)).toEqual({ hook: "onClick", payload: { name: "suggest", values: {} } });
    r.change(showId, "rush", true, { customer: "", rush: true });
    expect(deps.forwarded.at(-1)).toEqual({
      hook: "onChange",
      payload: { name: "rush", value: true, values: { customer: "", rush: true }, source: "user" },
    });
    r.change(showId, "customer", "A", { customer: "A", rush: true });
    r.change(showId, "customer", "Ad", { customer: "Ad", rush: true });
    // Nothing yet: the keystrokes are being coalesced.
    expect(deps.forwarded.filter((f) => f.hook === "onChange")).toHaveLength(1);
    vi.advanceTimersByTime(FORM_TEXT_CHANGE_DEBOUNCE_MS + 1);
    const text = deps.forwarded.filter((f) => f.hook === "onChange");
    expect(text).toHaveLength(2);
    expect(text[1].payload).toEqual({ name: "customer", value: "Ad", values: { customer: "Ad", rush: true }, source: "user" });
    // The mirror always carries the latest values, debounce or not.
    expect(deps.mirrors.at(-1)).toEqual({ path: "form.values", value: { customer: "Ad", rush: true } });
  });

  it("update patches the renderer, merges values and drops a flood beyond the bucket", async () => {
    const showId = await open(r, deps);
    updateScriptForm(OWNER.scriptId, { values: { customer: "Zed", suggest: "not an input" }, controls: { total: { text: "1" } } });
    expect(r.patches).toHaveLength(1);
    expect(r.patches[0].showId).toBe(showId);
    expect(deps.mirrors.at(-1)).toEqual({ path: "form.values", value: { customer: "Zed", rush: false } });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    for (let i = 0; i < FORM_UPDATE_PER_SECOND + 5; i++) {
      updateScriptForm(OWNER.scriptId, { message: { text: `m${i}` } });
    }
    // One was spent above; the bucket admits FORM_UPDATE_PER_SECOND in total.
    expect(r.patches).toHaveLength(FORM_UPDATE_PER_SECOND);
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();
    // No session: a no-op, never a throw.
    expect(() => updateScriptForm("nobody", { message: null })).not.toThrow();
  });
});

describe("scriptForms — bindings (the host's write-back callbacks)", () => {
  let r: ReturnType<typeof renderer>;
  let deps: RecordingDeps;

  beforeEach(() => {
    resetScriptDialogs();
    resetScriptForms();
    r = renderer();
    deps = recordingDeps();
  });
  afterEach(() => {
    r.stop();
    resetScriptForms();
    resetScriptDialogs();
    vi.useRealTimers();
  });

  it("seeds from bound reads travel to the renderer; `initial` overrides a seed's value and drops its display", async () => {
    defineScriptForm(OWNER.scriptId, SPEC);
    const promise = showScriptForm({
      ...OWNER,
      seeds: { customer: { value: "From cell", display: "From cell" }, rush: { value: true, display: "TRUE" } },
      initial: { rush: false },
      pinnedSheetName: "Sheet1",
      deps,
    });
    const req = r.last();
    expect(req.seeds).toEqual({
      customer: { value: "From cell", display: "From cell" },
      rush: { value: false, display: undefined },
    });
    expect(req.pinnedSheetName).toBe("Sheet1");
    r.shown(req.showId, { customer: "From cell", rush: false });
    await promise;
    expect(deps.forwarded[0]).toEqual({ hook: "onShow", payload: { values: { customer: "From cell", rush: false } } });
  });

  it("an accepted submit writes the bindings BEFORE closing; a refused write keeps the form open with the reason", async () => {
    const writeBindings = vi.fn(async () => ["customer"]);
    deps.writeBindings = writeBindings;
    const showId = await open(r, deps);
    r.submit(showId, { customer: "Ada", rush: false });
    await vi.waitFor(() => expect(deps.closedWith).toHaveLength(1));
    expect(writeBindings).toHaveBeenCalledWith(showId, { customer: "Ada", rush: false }, null);
    expect(r.closes[0].reason).toBe("submit");

    // Second session: the write refuses (the user switched sheets).
    deps.writeBindings = vi.fn(async () => {
      throw new Error('switch back to "Sheet1" to save this form');
    });
    const second = await open(r, deps);
    r.submit(second, { customer: "Bob", rush: false });
    await vi.waitFor(() => expect(r.patches).toHaveLength(1));
    expect(r.patches[0]).toEqual({
      showId: second,
      // Stated, so the renderer leaves its pending state on this path too.
      refused: true,
      message: { text: 'switch back to "Sheet1" to save this form', kind: "error" },
    });
    expect(deps.closedWith).toHaveLength(1);
    expect(getActiveScriptForm()?.showId).toBe(second);
  });

  it("the host is told the form is open (for its live cell watch) exactly when the renderer acknowledges", async () => {
    const opened = vi.fn();
    deps.opened = opened;
    defineScriptForm(OWNER.scriptId, SPEC);
    const promise = showScriptForm({ ...OWNER, deps });
    expect(opened).not.toHaveBeenCalled();
    r.shown(r.last().showId);
    await promise;
    expect(opened).toHaveBeenCalledWith(r.last().showId);
  });

  it("writeOn: change writes that one widget after its change is delivered", async () => {
    vi.useFakeTimers();
    const writeBindings = vi.fn(async () => ["customer"]);
    deps.writeBindings = writeBindings;
    defineScriptForm(OWNER.scriptId, SPEC);
    const promise = showScriptForm({ ...OWNER, writeOnChange: ["customer"], deps });
    const showId = r.last().showId;
    r.shown(showId, { customer: "", rush: false });
    await promise;
    r.change(showId, "customer", "Ada", { customer: "Ada", rush: false });
    expect(writeBindings).not.toHaveBeenCalled();
    vi.advanceTimersByTime(FORM_TEXT_CHANGE_DEBOUNCE_MS + 1);
    expect(writeBindings).toHaveBeenCalledWith(showId, { customer: "Ada", rush: false }, ["customer"]);
    // A widget without writeOn: change never triggers a write.
    r.change(showId, "rush", true, { customer: "Ada", rush: true });
    expect(writeBindings).toHaveBeenCalledTimes(1);
  });

  it("a cell changing underneath refreshes the renderer's seeds and tells the script source: cell", async () => {
    const showId = await open(r, deps);
    refreshScriptFormSeeds(showId, { customer: { value: "Edited in the grid", display: "Edited in the grid" } });
    expect(r.patches).toEqual([
      { showId, seeds: { customer: { value: "Edited in the grid", display: "Edited in the grid" } } },
    ]);
    expect(deps.forwarded.at(-1)).toEqual({
      hook: "onChange",
      payload: {
        name: "customer",
        value: "Edited in the grid",
        values: { customer: "Edited in the grid", rush: false },
        source: "cell",
      },
    });
    // Unknown session: a no-op.
    expect(() => refreshScriptFormSeeds("form-nope", { customer: { value: "x" } })).not.toThrow();
  });

  it("a widget the USER edited keeps their value: form.values says what is on screen", async () => {
    // The renderer keeps a dirty widget's text and marks it stale rather than
    // overwriting it. A host that adopted the cell's new value anyway made
    // `form.values` report a number nobody could see, and an onChange handler
    // computing a total from it would be computing from the wrong one.
    const showId = await open(r, deps);
    r.change(showId, "customer", "Typed by the user", { customer: "Typed by the user", rush: false });
    await vi.waitFor(() =>
      expect(deps.forwarded.filter((f) => f.hook === "onChange")).toHaveLength(1),
    );
    const before = deps.forwarded.length;

    refreshScriptFormSeeds(showId, { customer: { value: "Changed in the grid" } });

    // The renderer is still told (it paints the stale marker), the script is not.
    expect(r.patches.at(-1)).toEqual({ showId, seeds: { customer: { value: "Changed in the grid" } } });
    expect(deps.forwarded).toHaveLength(before);
    expect(deps.mirrors.at(-1)?.value).toEqual({ customer: "Typed by the user", rush: false });

    // Submitting reports what the user has on screen, not the cell.
    r.submit(showId, { customer: "Typed by the user", rush: false });
    await vi.waitFor(() => expect(deps.closedWith).toHaveLength(1));
    expect(deps.closedWith[0].result).toEqual({ customer: "Typed by the user", rush: false });
  });

  it("the form's OWN write-back does not come back to the script as an outside edit", async () => {
    // writeOn:"change" writes the cell, re-reads it and refreshes the seed.
    // Forwarding that as `source: "cell"` told the script an external edit had
    // landed on the value it had just written — the echo `isOwnScriptWrite`
    // suppresses on the live watch itself.
    const showId = await open(r, deps);
    const before = deps.forwarded.filter((f) => f.hook === "onChange").length;
    refreshScriptFormSeeds(showId, { customer: { value: "Written by the form", display: "Written by the form" } }, { echo: false });
    expect(r.patches.at(-1)?.seeds?.customer.value).toBe("Written by the form");
    expect(deps.forwarded.filter((f) => f.hook === "onChange")).toHaveLength(before);
    // The mirror still tracks it — the value really did change.
    expect(deps.mirrors.at(-1)?.value).toEqual({ customer: "Written by the form", rush: false });
  });
});

describe("scriptForms — guards shared with dialogs", () => {
  let r: ReturnType<typeof renderer>;
  let deps: RecordingDeps;

  beforeEach(() => {
    resetScriptDialogs();
    resetScriptForms();
    r = renderer();
    deps = recordingDeps();
  });
  afterEach(() => {
    r.stop();
    resetScriptForms();
    resetScriptDialogs();
    vi.useRealTimers();
  });

  it("one form per script, one modal app-wide, rejected not queued", async () => {
    await open(r, deps);
    // Same script again.
    await expect(showScriptForm({ ...OWNER, deps: recordingDeps() })).rejects.toBeInstanceOf(BrokerError);
    // Another script's form.
    defineScriptForm("form-2", SPEC);
    await expect(
      showScriptForm({ scriptId: "form-2", scriptName: "Other", scriptOrigin: "local", deps: recordingDeps() }),
    ).rejects.toThrow(/Order entry/);
    // Another script's DIALOG is refused by the same slot...
    await expect(
      requestScriptDialog({ scriptId: "s9", scriptName: "Alert", scriptOrigin: "local", kind: "alert", message: "hi" }),
    ).rejects.toBeInstanceOf(BrokerError);
    // ...and so is the owner's own dialog (no stacking in release one).
    await expect(
      requestScriptDialog({ ...OWNER, kind: "alert", message: "hi" }),
    ).rejects.toThrow(/already has a dialog open/);
    expect(r.requests).toHaveLength(1);
  });

  it("a form is refused while a DIALOG holds the slot", async () => {
    const dialog = requestScriptDialog({ scriptId: "s9", scriptName: "Alert", scriptOrigin: "local", kind: "alert", message: "hi" });
    defineScriptForm(OWNER.scriptId, SPEC);
    await expect(showScriptForm({ ...OWNER, deps })).rejects.toThrow(/Alert/);
    resetScriptDialogs();
    await dialog;
  });

  it("three consecutive cancels mute the script's forms (a muted show answers null at once)", async () => {
    for (let i = 0; i < 3; i++) {
      const showId = await open(r, deps);
      r.cancel(showId);
    }
    const muted = await showScriptForm({ ...OWNER, deps });
    expect(muted).toEqual({ showId: expect.any(String), closed: true });
    await vi.waitFor(() => expect(deps.closedWith).toHaveLength(4));
    expect(deps.closedWith[3]).toEqual({ showId: muted.showId, result: null });
    // Nothing was painted and no slot is held.
    expect(r.requests).toHaveLength(3);
    expect(getActiveModal()).toBeNull();
  });

  it("a submit resets the dismissal streak", async () => {
    for (let i = 0; i < 2; i++) {
      const showId = await open(r, deps);
      r.cancel(showId);
    }
    const showId = await open(r, deps);
    r.submit(showId, { customer: "Ada" });
    await vi.waitFor(() => expect(deps.closedWith).toHaveLength(3));
    for (let i = 0; i < 2; i++) {
      const id = await open(r, deps);
      r.cancel(id);
    }
    // Only two in a row since the submit: still not muted, so it really opens.
    const again = await open(r, deps);
    expect(r.requests.at(-1)?.showId).toBe(again);
    r.cancel(again);
  });

  it("a close NOBODY chose leaves the streak alone — neither muting nor resetting it", async () => {
    // Only the user's decision moves the streak. A script closing its own form
    // (a wizard stepping to the next page) is not the user refusing, and an
    // unmount is the HOST closing it — counting those as dismissals muted a
    // wizard after three steps, and counting them as engagement would have let
    // a script reset the streak between the user's refusals and never be muted.
    for (let i = 0; i < 3; i++) {
      const showId = await open(r, deps);
      expect(r.requests.at(-1)?.showId).toBe(showId); // really painted, three times
      closeScriptForm(OWNER.scriptId, null);
    }
    // Not muted by its own closes: the next show still reaches the renderer.
    const stillOpens = await open(r, deps);
    expect(r.requests.at(-1)?.showId).toBe(stillOpens);

    // ...and it cannot launder a user refusal either: two cancels, a
    // script-close in between, and the third cancel still mutes.
    r.cancel(stillOpens);
    const second = await open(r, deps);
    r.cancel(second);
    const third = await open(r, deps);
    closeScriptForm(OWNER.scriptId, null); // does NOT reset the streak
    void third;
    const fourth = await open(r, deps);
    r.cancel(fourth);
    const muted = await showScriptForm({ ...OWNER, deps });
    expect(muted.closed).toBe(true);
  });

  it("bounds the number of shows per minute", async () => {
    // Every session is SUBMITTED, so the dismissal mute never enters the
    // picture: this test is about the show bucket alone.
    for (let i = 0; i < FORM_SHOWS_PER_MINUTE; i++) {
      const showId = await open(r, deps);
      r.submit(showId, { customer: `c${i}` });
      await vi.waitFor(() => expect(deps.closedWith).toHaveLength(i + 1));
    }
    await expect(showScriptForm({ ...OWNER, deps })).rejects.toThrow(/last minute/);
    expect(r.requests).toHaveLength(FORM_SHOWS_PER_MINUTE);
  });
});

describe("scriptForms — deadlines and sweeps", () => {
  let r: ReturnType<typeof renderer>;
  let deps: RecordingDeps;

  beforeEach(() => {
    vi.useFakeTimers();
    resetScriptDialogs();
    resetScriptForms();
    r = renderer();
    deps = recordingDeps();
  });
  afterEach(() => {
    r.stop();
    resetScriptForms();
    resetScriptDialogs();
    vi.useRealTimers();
  });

  it("a renderer that never acknowledges fails the show and frees the slot", async () => {
    defineScriptForm(OWNER.scriptId, SPEC);
    const promise = showScriptForm({ ...OWNER, deps });
    vi.advanceTimersByTime(FORM_SHOWN_ACK_TIMEOUT_MS + 1);
    await expect(promise).rejects.toThrow(/did not open/);
    expect(getActiveModal()).toBeNull();
    expect(deps.closedWith).toEqual([{ showId: r.last().showId, result: null }]);
  });

  it("the idle deadline closes a forgotten form and any interaction re-arms it", async () => {
    const showId = await open(r, deps);
    vi.advanceTimersByTime(FORM_IDLE_DEADLINE_MS - 1000);
    r.interaction(showId);
    vi.advanceTimersByTime(FORM_IDLE_DEADLINE_MS - 1000);
    expect(r.closes).toHaveLength(0);
    vi.advanceTimersByTime(2000);
    expect(r.closes).toEqual([{ showId, reason: "deadline" }]);
    expect(deps.closedWith).toEqual([{ showId, result: null }]);
    expect(deps.resumed).toBe(1);
  });

  it("the absolute cap closes even a busy form", async () => {
    const showId = await open(r, deps);
    const step = 10 * 60_000;
    for (let elapsed = 0; elapsed < FORM_MAX_OPEN_MS - step; elapsed += step) {
      vi.advanceTimersByTime(step);
      r.interaction(showId);
    }
    expect(r.closes).toHaveLength(0);
    vi.advanceTimersByTime(step + 1);
    expect(r.closes).toEqual([{ showId, reason: "deadline" }]);
  });

  it("revokeScriptForms closes the script's form as unmount and forgets its layout", async () => {
    const showId = await open(r, deps);
    revokeScriptForms(OWNER.scriptId);
    expect(r.closes).toEqual([{ showId, reason: "unmount" }]);
    expect(deps.closedWith).toEqual([{ showId, result: null }]);
    expect(getActiveModal()).toBeNull();
    expect(getScriptFormSpec(OWNER.scriptId)).toBeNull();
    await expect(showScriptForm({ ...OWNER, deps })).rejects.toThrow(/form.define/);
  });

  it("the CALLER's unmount closes a form it opened on another script's behalf", async () => {
    defineScriptForm(OWNER.scriptId, SPEC);
    const promise = showScriptForm({ ...OWNER, callerName: "Button", callerScriptId: "btn-1", deps });
    const req = r.last();
    expect(req.callerName).toBe("Button");
    r.shown(req.showId);
    await promise;
    revokeScriptForms("btn-1");
    expect(r.closes).toEqual([{ showId: req.showId, reason: "unmount" }]);
    expect(deps.closedWith).toEqual([{ showId: req.showId, result: null }]);
    expect(getActiveModal()).toBeNull();
    // The OWNER's layout is untouched — only the caller went away.
    expect(getScriptFormSpec(OWNER.scriptId)).toBe(SPEC);
  });

  it("resetScriptForms closes every session and forgets every layout", async () => {
    const showId = await open(r, deps);
    defineScriptForm("form-2", SPEC);
    resetScriptForms();
    expect(r.closes).toEqual([{ showId, reason: "unmount" }]);
    expect(getScriptFormSpec("form-2")).toBeNull();
    expect(getActiveScriptForm()).toBeNull();
  });
});
