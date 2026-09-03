//! FILENAME: app/extensions/ScriptableObjects/__tests__/formPreviewBridge.test.ts
// PURPOSE: Prove the "Preview form" bridge always answers, seeds from the run
//          it made, and leaves nothing behind.
// CONTEXT: The editor window shows "Previewing…" from the moment it sends a
//          request until a RESULT comes back, so every way the main window can
//          fail has to produce a result rather than a log line. The seeding
//          rule matters just as much: a bound widget's value comes from the
//          COPY the preview ran against (the rung's read-back), never from the
//          live grid — and a binding the copy cannot honour is shown unbound
//          with a reason, never answered from anywhere else.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ---------------------------------------------------------------------------
// Doubles
// ---------------------------------------------------------------------------

const emitted: Array<{ event: string; payload: unknown }> = [];
const handlers = new Map<string, (p: unknown) => void>();
const offs = new Map<string, ReturnType<typeof vi.fn>>();

vi.mock("@api/backend", () => ({
  emitTauriEvent: vi.fn(async (event: string, payload: unknown) => {
    emitted.push({ event, payload });
  }),
  listenTauriEvent: vi.fn(async (event: string, cb: (p: unknown) => void) => {
    handlers.set(event, cb);
    const off = vi.fn();
    offs.set(event, off);
    return off;
  }),
}));

const previewObjectScript = vi.fn();
const showScriptForm = vi.fn();
const defineScriptForm = vi.fn();
const revokeScriptForms = vi.fn();
const revokeScriptDialogs = vi.fn();
vi.mock("@api", () => ({
  previewObjectScript: (...a: unknown[]) => previewObjectScript(...a),
  showScriptForm: (...a: unknown[]) => showScriptForm(...a),
  defineScriptForm: (...a: unknown[]) => defineScriptForm(...a),
  revokeScriptForms: (...a: unknown[]) => revokeScriptForms(...a),
  revokeScriptDialogs: (...a: unknown[]) => revokeScriptDialogs(...a),
}));

import {
  FormPreviewEvents,
  IDLE_FORM_PREVIEW,
  PREVIEW_UNRESOLVED_REASON,
  __resetFormPreviewBridge,
  __resetFormPreviewClient,
  buildFormPreviewSeeds,
  dismissFormPreviewStatus,
  formPreviewStateFor,
  installFormPreviewBridge,
  installFormPreviewClient,
  planFormPreviewSeeds,
  reduceFormPreviewState,
  replayFormPreviewResults,
  requestFormPreview,
  runFormPreview,
  type FormPreviewResultPayload,
} from "../lib/formPreviewBridge";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** The worked example's shape: two same-sheet cells and one on another sheet. */
const LAYOUT = {
  title: "Order entry",
  children: [
    { type: "textbox", name: "customer", label: "Customer", bind: "B2" },
    { type: "number", name: "qty", label: "Quantity", bind: "B3" },
    { type: "textbox", name: "other", label: "Other", bind: "Sheet2!B2" },
    { type: "checkbox", name: "rush", label: "Rush order" },
  ],
};

const REQUEST = {
  requestId: "req-1",
  scriptId: "form-1",
  scriptName: "Order entry",
  source: "function setup(form) { form.define({ children: [] }); }",
};

function applicable(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    ok: true,
    error: null,
    durationMs: 3,
    changes: [],
    truncated: false,
    totalChanges: 0,
    output: [],
    readBack: [],
    unexercisedHooks: [],
    applicable: true,
    declinedReason: null,
    ...over,
  };
}

function declined(reason: string): Record<string, unknown> {
  return applicable({ applicable: false, declinedReason: reason });
}

function results(): FormPreviewResultPayload[] {
  return emitted
    .filter((e) => e.event === FormPreviewEvents.RESULT)
    .map((e) => e.payload as FormPreviewResultPayload);
}

/** Install and wait for the (async) listener registrations to settle. */
async function install(): Promise<() => void> {
  const off = installFormPreviewBridge();
  await Promise.resolve();
  await Promise.resolve();
  return off;
}

/** Drive a request through the installed bridge and let the run settle. */
async function request(payload = REQUEST): Promise<void> {
  const handler = handlers.get(FormPreviewEvents.REQUEST);
  expect(handler, "the bridge never subscribed to requests").toBeTruthy();
  handler!(payload);
  // Two preview passes, one show: a handful of microtask turns.
  for (let i = 0; i < 8; i++) await Promise.resolve();
}

/** The `deps` the bridge handed the registry on its last show. */
function lastDeps(): { closed: (showId: string, result: unknown) => void } {
  const call = showScriptForm.mock.calls.at(-1) as [{ deps: { closed: (s: string, r: unknown) => void } }];
  expect(call, "showScriptForm was never called").toBeTruthy();
  return call[0].deps;
}

beforeEach(() => {
  emitted.length = 0;
  handlers.clear();
  offs.clear();
  previewObjectScript.mockReset();
  showScriptForm.mockReset();
  defineScriptForm.mockReset();
  revokeScriptForms.mockReset();
  revokeScriptDialogs.mockReset();
  __resetFormPreviewBridge();
  __resetFormPreviewClient();
});

afterEach(() => {
  __resetFormPreviewBridge();
  __resetFormPreviewClient();
});

// ---------------------------------------------------------------------------
// Seeding (pure)
// ---------------------------------------------------------------------------

describe("planFormPreviewSeeds — only the copied sheet can be honoured", () => {
  it("reads back the same-sheet cells and leaves the rest unbound, with a reason", () => {
    const plan = planFormPreviewSeeds(LAYOUT as never);
    // B2 -> (1,1), B3 -> (2,1): 0-based, as the script API addresses cells.
    expect(plan.cells).toEqual([
      { row: 1, col: 1 },
      { row: 2, col: 1 },
    ]);
    expect([...plan.resolved.keys()]).toEqual(["customer", "qty"]);
    expect(plan.resolved.get("qty")).toEqual({ widgetType: "number", row: 2, col: 1 });
    expect([...plan.unresolved.keys()]).toEqual(["other"]);
    expect(plan.unresolved.get("other")!.reason).toContain("Sheet2");
    expect(plan.unresolved.get("other")!.reason).toContain(PREVIEW_UNRESOLVED_REASON);
  });

  it("does not ask for the same cell twice", () => {
    const plan = planFormPreviewSeeds({
      children: [
        { type: "textbox", name: "a", bind: "B2" },
        { type: "textbox", name: "b", bind: "$B$2" },
      ],
    } as never);
    expect(plan.cells).toEqual([{ row: 1, col: 1 }]);
    expect(plan.resolved.size).toBe(2);
  });

  it("declares a defined name and a control unbound rather than resolving them live", () => {
    const plan = planFormPreviewSeeds({
      children: [
        { type: "textbox", name: "n", bind: { name: "Customer" } },
        { type: "textbox", name: "c", bind: { control: "Region" } },
      ],
    } as never);
    expect(plan.cells).toEqual([]);
    expect(plan.unresolved.get("n")!.reason).toMatch(/defined name "Customer"/);
    expect(plan.unresolved.get("c")!.reason).toMatch(/control "Region"/);
  });

  it("names a numeric sheet index as an index, never as a sheet called \"1\"", () => {
    // `{ cell: "B2", sheet: 1 }` is a documented binding, and the parsed form
    // keeps the NUMBER. Stringifying it here would tell the author their
    // widget is bound to a sheet named "1", which does not exist.
    const plan = planFormPreviewSeeds({
      children: [{ type: "textbox", name: "s", bind: { cell: "B2", sheet: 1 } }],
    } as never);
    expect(plan.cells).toEqual([]);
    expect(plan.unresolved.get("s")!.reason).toContain("sheet index 1");
    expect(plan.unresolved.get("s")!.reason).toContain(PREVIEW_UNRESOLVED_REASON);
  });
});

describe("buildFormPreviewSeeds — typed from the run's read-back, never from the live grid", () => {
  it("types the seed per widget and carries the display", () => {
    const plan = planFormPreviewSeeds(LAYOUT as never);
    const seeds = buildFormPreviewSeeds(plan, [
      { row: 1, col: 1, value: "Acme" },
      { row: 2, col: 1, value: "42" },
    ]);
    expect(seeds.customer).toEqual({ value: "Acme", display: "Acme" });
    // A NUMBER, not the text "42": the widget edits what the cell holds.
    expect(seeds.qty).toEqual({ value: 42, display: "42" });
    expect(seeds.other).toEqual({
      value: null,
      readOnly: true,
      reason: expect.stringContaining(PREVIEW_UNRESOLVED_REASON),
    });
    // An unbound widget gets no seed at all — its own default applies.
    expect(seeds.rush).toBeUndefined();
  });

  it("shows a formula cell read-only with its formula text, never a guessed value", () => {
    const plan = planFormPreviewSeeds(LAYOUT as never);
    const seeds = buildFormPreviewSeeds(plan, [
      { row: 1, col: 1, value: "=A1&\" Ltd\"" },
      { row: 2, col: 1, value: "" },
    ]);
    expect(seeds.customer.formula).toBe("=A1&\" Ltd\"");
    expect(seeds.customer.display).toBe("=A1&\" Ltd\"");
    expect(seeds.customer.readOnly).toBe(true);
    expect(seeds.customer.reason).toMatch(/formula/);
    expect(seeds.qty).toEqual({ value: null, display: "" });
  });

  it("marks a resolved cell the run did not read back as unbound", () => {
    const plan = planFormPreviewSeeds(LAYOUT as never);
    const seeds = buildFormPreviewSeeds(plan, []);
    expect(seeds.customer.readOnly).toBe(true);
    expect(seeds.customer.reason).toContain(PREVIEW_UNRESOLVED_REASON);
  });
});

// ---------------------------------------------------------------------------
// The run
// ---------------------------------------------------------------------------

describe("runFormPreview — two passes, one show, a clean exit", () => {
  it("runs setup only, seeds from the second pass's read-back, and shows a preview", async () => {
    previewObjectScript
      .mockResolvedValueOnce(applicable({ formLayout: LAYOUT }))
      .mockResolvedValueOnce(
        applicable({
          formLayout: LAYOUT,
          readBack: [
            { row: 1, col: 1, value: "Acme" },
            { row: 2, col: 1, value: "42" },
          ],
        }),
      );
    showScriptForm.mockResolvedValue({ showId: "form-9" });
    const reported: FormPreviewResultPayload[] = [];

    await runFormPreview(REQUEST, (r) => reported.push(r));

    // Pass one learns the layout; pass two reads back exactly what it binds.
    expect(previewObjectScript).toHaveBeenCalledTimes(2);
    expect(previewObjectScript.mock.calls[0][0]).toEqual({
      source: REQUEST.source,
      objectType: "form",
      event: [],
      eventOptional: true,
    });
    expect(previewObjectScript.mock.calls[1][0]).toEqual({
      source: REQUEST.source,
      objectType: "form",
      event: [],
      eventOptional: true,
      readBack: [
        { row: 1, col: 1 },
        { row: 2, col: 1 },
      ],
    });

    // The layout is registered under the preview identity and shown as a preview.
    expect(defineScriptForm).toHaveBeenCalledWith("preview:form-1", LAYOUT);
    expect(showScriptForm).toHaveBeenCalledTimes(1);
    const shown = showScriptForm.mock.calls[0][0];
    expect(shown).toMatchObject({
      scriptId: "preview:form-1",
      scriptName: "Order entry",
      scriptOrigin: "local",
      preview: true,
    });
    expect(shown.seeds.customer).toEqual({ value: "Acme", display: "Acme" });
    expect(shown.seeds.qty).toEqual({ value: 42, display: "42" });
    expect(shown.seeds.other.reason).toContain(PREVIEW_UNRESOLVED_REASON);

    expect(reported).toHaveLength(1);
    expect(reported[0]).toMatchObject({ requestId: "req-1", scriptId: "form-1", outcome: "shown" });
    expect(reported[0].message).toContain("2 of 3 bound widgets");
    expect(reported[0].message).toContain("other");
  });

  it("runs once when the layout binds nothing", async () => {
    previewObjectScript.mockResolvedValue(
      applicable({ formLayout: { children: [{ type: "label", text: "Hello" }] } }),
    );
    showScriptForm.mockResolvedValue({ showId: "form-2" });
    const reported: FormPreviewResultPayload[] = [];
    await runFormPreview(REQUEST, (r) => reported.push(r));
    expect(previewObjectScript).toHaveBeenCalledTimes(1);
    expect(reported[0].outcome).toBe("shown");
    expect(reported[0].message).not.toContain("bound widget");
  });

  it("reports the close, and clears BOTH registries so previews can never mute themselves", async () => {
    previewObjectScript.mockResolvedValue(applicable({ formLayout: { children: [] } }));
    showScriptForm.mockResolvedValue({ showId: "form-3" });
    const reported: FormPreviewResultPayload[] = [];
    await runFormPreview(REQUEST, (r) => reported.push(r));
    // The pre-show replace has already run once (see "replaces an open
    // preview" below). What matters here is that an OPEN preview is never
    // revoked again until it actually closes.
    revokeScriptForms.mockClear();
    revokeScriptDialogs.mockClear();
    expect(revokeScriptForms).not.toHaveBeenCalled();

    lastDeps().closed("form-3", null);

    expect(reported.map((r) => r.outcome)).toEqual(["shown", "closed"]);
    // scriptForms: the layout + show bucket. scriptDialogs: the dismissal
    // streak — a cancelled preview counts as a dismissal there, and three of
    // them would silently close every later preview.
    expect(revokeScriptForms).toHaveBeenCalledWith("preview:form-1");
    expect(revokeScriptDialogs).toHaveBeenCalledWith("preview:form-1");
  });

  it("reports 'no layout defined' with the rung's own note", async () => {
    previewObjectScript.mockResolvedValue(
      applicable({
        output: ["[preview] no layout was captured: the script never called form.define during setup"],
      }),
    );
    const reported: FormPreviewResultPayload[] = [];
    await runFormPreview(REQUEST, (r) => reported.push(r));
    expect(reported).toHaveLength(1);
    expect(reported[0].outcome).toBe("noLayout");
    expect(reported[0].message).toContain("No layout defined");
    expect(reported[0].message).toContain("never called form.define during setup");
    expect(showScriptForm).not.toHaveBeenCalled();
  });

  it("carries the script's own error when setup threw before defining", async () => {
    previewObjectScript.mockResolvedValue(
      applicable({ ok: false, error: "setup(context) threw: boom" }),
    );
    const reported: FormPreviewResultPayload[] = [];
    await runFormPreview(REQUEST, (r) => reported.push(r));
    expect(reported[0].outcome).toBe("noLayout");
    expect(reported[0].message).toContain("setup(context) threw: boom");
  });

  it("reports a declined run with its reason, and shows nothing", async () => {
    previewObjectScript.mockResolvedValue(
      declined("the preview cannot perform net.fetch (the \"net.fetch\" capability)"),
    );
    const reported: FormPreviewResultPayload[] = [];
    await runFormPreview(REQUEST, (r) => reported.push(r));
    expect(reported).toHaveLength(1);
    expect(reported[0].outcome).toBe("declined");
    expect(reported[0].message).toContain("net.fetch");
    expect(defineScriptForm).not.toHaveBeenCalled();
    expect(showScriptForm).not.toHaveBeenCalled();
  });

  it("reports a thrown run as an error", async () => {
    previewObjectScript.mockRejectedValue(new Error("realm exploded"));
    const reported: FormPreviewResultPayload[] = [];
    await runFormPreview(REQUEST, (r) => reported.push(r));
    expect(reported).toEqual([
      expect.objectContaining({ outcome: "error", message: expect.stringContaining("realm exploded") }),
    ]);
  });

  it("surfaces a held modal slot as a refusal, in the registry's words, and cleans up", async () => {
    previewObjectScript.mockResolvedValue(applicable({ formLayout: { children: [] } }));
    showScriptForm.mockRejectedValue(
      new Error('another script ("Order entry") is showing a dialog; try again once the user has answered it'),
    );
    const reported: FormPreviewResultPayload[] = [];
    await runFormPreview(REQUEST, (r) => reported.push(r));
    expect(reported).toHaveLength(1);
    expect(reported[0].outcome).toBe("refused");
    expect(reported[0].message).toContain('another script ("Order entry") is showing a dialog');
    expect(revokeScriptForms).toHaveBeenCalledWith("preview:form-1");
    expect(revokeScriptDialogs).toHaveBeenCalledWith("preview:form-1");
  });

  it("treats a muted 'closed at once' answer as a refusal, not a silent nothing", async () => {
    previewObjectScript.mockResolvedValue(applicable({ formLayout: { children: [] } }));
    showScriptForm.mockImplementation(async (args: { deps: { closed: (s: string, r: unknown) => void } }) => {
      queueMicrotask(() => args.deps.closed("form-4", null));
      return { showId: "form-4", closed: true };
    });
    const reported: FormPreviewResultPayload[] = [];
    await runFormPreview(REQUEST, (r) => reported.push(r));
    await Promise.resolve();
    expect(reported.map((r) => r.outcome)).toEqual(["refused"]);
  });

  it("replaces an open preview of the same script instead of being refused by it", async () => {
    previewObjectScript.mockResolvedValue(applicable({ formLayout: { children: [] } }));
    showScriptForm.mockResolvedValue({ showId: "form-6" });
    const reported: FormPreviewResultPayload[] = [];
    await runFormPreview(REQUEST, (r) => reported.push(r));
    revokeScriptForms.mockClear();
    revokeScriptDialogs.mockClear();

    await runFormPreview({ ...REQUEST, requestId: "req-2" }, (r) => reported.push(r));

    // BOTH previews opened. Without the pre-show release the modal slot is
    // still held by the first ("this script already has a dialog open"), and
    // the author loses the open form to a refusal note.
    expect(reported.map((r) => r.outcome)).toEqual(["shown", "shown"]);
    expect(revokeScriptForms).toHaveBeenCalledWith("preview:form-1");
    expect(revokeScriptDialogs).toHaveBeenCalledWith("preview:form-1");
    // ...and BEFORE the second show claimed the slot, not after it failed.
    expect(revokeScriptForms.mock.invocationCallOrder[0]).toBeLessThan(
      showScriptForm.mock.invocationCallOrder.at(-1)!,
    );
  });
});

// ---------------------------------------------------------------------------
// The bridge (main window)
// ---------------------------------------------------------------------------

describe("installFormPreviewBridge — request in, result out, replay on READY", () => {
  it("answers a request over the wire and replays the last result", async () => {
    previewObjectScript.mockResolvedValue(declined("this environment has no Worker realm"));
    await install();
    await request();

    expect(results()).toHaveLength(1);
    expect(results()[0]).toMatchObject({ requestId: "req-1", scriptId: "form-1", outcome: "declined" });
    expect(results()[0].message).toContain("no Worker realm");

    emitted.length = 0;
    replayFormPreviewResults();
    expect(results()).toHaveLength(1);
    expect(results()[0].outcome).toBe("declined");
  });

  it("forgets a result the editor dismissed", async () => {
    previewObjectScript.mockResolvedValue(declined("nope"));
    await install();
    await request();
    handlers.get(FormPreviewEvents.DISMISS)!({ scriptId: "form-1" });

    emitted.length = 0;
    replayFormPreviewResults();
    expect(results()).toHaveLength(0);
  });

  it("keeps a shown form for replay and drops it once it closes", async () => {
    previewObjectScript.mockResolvedValue(applicable({ formLayout: { children: [] } }));
    showScriptForm.mockResolvedValue({ showId: "form-5" });
    await install();
    await request();
    expect(results().map((r) => r.outcome)).toEqual(["shown"]);

    emitted.length = 0;
    replayFormPreviewResults();
    expect(results().map((r) => r.outcome)).toEqual(["shown"]);

    emitted.length = 0;
    lastDeps().closed("form-5", null);
    expect(results().map((r) => r.outcome)).toEqual(["closed"]);
    emitted.length = 0;
    replayFormPreviewResults();
    expect(results()).toHaveLength(0);
  });

  it("unsubscribes on teardown and forgets stored results", async () => {
    previewObjectScript.mockResolvedValue(declined("nope"));
    const off = await install();
    await request();
    off();
    expect(offs.get(FormPreviewEvents.REQUEST)).toHaveBeenCalled();
    expect(offs.get(FormPreviewEvents.DISMISS)).toHaveBeenCalled();
    emitted.length = 0;
    replayFormPreviewResults();
    expect(results()).toHaveLength(0);
  });

  it("unsubscribes even when teardown beats the async registration", async () => {
    const off = installFormPreviewBridge();
    off();
    await Promise.resolve();
    await Promise.resolve();
    expect(offs.get(FormPreviewEvents.REQUEST)).toHaveBeenCalled();
    expect(offs.get(FormPreviewEvents.DISMISS)).toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// The client (editor window)
// ---------------------------------------------------------------------------

describe("the editor client — ask, fold results, dismiss", () => {
  it("sends the compiled source and enters the running state", () => {
    const requestId = requestFormPreview({ scriptId: "form-1", scriptName: "Order entry", source: "js" });
    const sent = emitted.filter((e) => e.event === FormPreviewEvents.REQUEST);
    expect(sent).toHaveLength(1);
    expect(sent[0].payload).toEqual({ requestId, scriptId: "form-1", scriptName: "Order entry", source: "js" });
    expect(formPreviewStateFor("form-1")).toMatchObject({ phase: "running", requestId });
    // Nothing for another script, and the SAME idle object every time.
    expect(formPreviewStateFor("form-2")).toBe(IDLE_FORM_PREVIEW);
  });

  it("folds a result for its own request, and ignores one for a superseded request", async () => {
    const off = installFormPreviewClient();
    await Promise.resolve();
    await Promise.resolve();
    const requestId = requestFormPreview({ scriptId: "form-1", scriptName: "n", source: "js" });
    const deliver = handlers.get(FormPreviewEvents.RESULT)!;

    deliver({ requestId: "stale", scriptId: "form-1", outcome: "closed", message: "" });
    expect(formPreviewStateFor("form-1").phase).toBe("running");

    deliver({ requestId, scriptId: "form-1", outcome: "declined", message: "No preview: nope." });
    expect(formPreviewStateFor("form-1")).toEqual({ phase: "failed", message: "No preview: nope.", requestId });
    off();
  });

  it("accepts a replayed result while idle, then goes idle again on close", () => {
    const shown = reduceFormPreviewState(IDLE_FORM_PREVIEW, {
      requestId: "replayed",
      scriptId: "form-1",
      outcome: "shown",
      message: "Preview open in the main window.",
    });
    expect(shown).toMatchObject({ phase: "shown", requestId: "replayed" });
    expect(
      reduceFormPreviewState(shown, { requestId: "replayed", scriptId: "form-1", outcome: "closed", message: "" }),
    ).toBe(IDLE_FORM_PREVIEW);
  });

  it("dismissing hides the note and tells the main window to forget it", () => {
    const requestId = requestFormPreview({ scriptId: "form-1", scriptName: "n", source: "js" });
    expect(formPreviewStateFor("form-1").requestId).toBe(requestId);
    dismissFormPreviewStatus("form-1");
    expect(formPreviewStateFor("form-1")).toBe(IDLE_FORM_PREVIEW);
    const dismissed = emitted.filter((e) => e.event === FormPreviewEvents.DISMISS);
    expect(dismissed).toEqual([{ event: FormPreviewEvents.DISMISS, payload: { scriptId: "form-1" } }]);
  });
});
