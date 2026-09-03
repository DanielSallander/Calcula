//! FILENAME: app/extensions/ScriptableObjects/__tests__/formPreviewBridge.test.ts
// PURPOSE: Prove the "Preview form" bridge always answers, asks the shared core
//          for the right thing, and leaves nothing behind.
// CONTEXT: The editor window shows "Previewing…" from the moment it sends a
//          request until a RESULT comes back, so every way the main window can
//          fail has to produce a result rather than a log line.
//
//          THE SEEDING RULES ARE NOT HERE ANY MORE. Running the draft, seeding
//          its widgets from the copy the run used and opening the renderer in
//          preview mode is `previewFormLayout` (app/src/api/scriptFormPreview.ts),
//          shared with the package inspector and proved in its own test. What
//          this file pins is what only this surface owns: the request the
//          bridge composes (a stable preview identity, and live control reads
//          because the author is previewing their OWN draft), the English each
//          outcome is reported in, and the wire.

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

const previewFormLayout = vi.fn();
vi.mock("@api", () => ({
  previewFormLayout: (...a: unknown[]) => previewFormLayout(...a),
  previewScriptId: (id: string) => `preview:${id}`,
}));

import {
  FormPreviewEvents,
  IDLE_FORM_PREVIEW,
  __resetFormPreviewBridge,
  __resetFormPreviewClient,
  describeFormPreviewOutcome,
  dismissFormPreviewStatus,
  formPreviewStateFor,
  installFormPreviewBridge,
  installFormPreviewClient,
  reduceFormPreviewState,
  replayFormPreviewResults,
  requestFormPreview,
  runFormPreview,
  type FormPreviewResultPayload,
} from "../lib/formPreviewBridge";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const REQUEST = {
  requestId: "req-1",
  scriptId: "form-1",
  scriptName: "Order entry",
  source: "function setup(form) { form.define({ children: [] }); }",
};

/** An outcome shaped like the core's, with nothing seeded unless asked. */
function outcome(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    shown: true,
    status: "shown",
    seeded: [],
    controls: [],
    unresolved: [],
    sources: [],
    unresolvedSources: [],
    ...over,
  };
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
  for (let i = 0; i < 8; i++) await Promise.resolve();
}

/** The `onClosed` the bridge handed the core on its last run. */
function lastOnClosed(): () => void {
  const call = previewFormLayout.mock.calls.at(-1) as [{ onClosed: () => void }];
  expect(call, "previewFormLayout was never called").toBeTruthy();
  return call[0].onClosed;
}

beforeEach(() => {
  emitted.length = 0;
  handlers.clear();
  offs.clear();
  previewFormLayout.mockReset();
  __resetFormPreviewBridge();
  __resetFormPreviewClient();
});

afterEach(() => {
  __resetFormPreviewBridge();
  __resetFormPreviewClient();
});

// ---------------------------------------------------------------------------
// What the bridge asks for
// ---------------------------------------------------------------------------

describe("runFormPreview — the request it composes", () => {
  it("asks for a local preview under a stable identity, WITH live control reads", async () => {
    previewFormLayout.mockResolvedValue(outcome());
    await runFormPreview(REQUEST, () => {});
    const args = previewFormLayout.mock.calls[0][0];
    expect(args).toMatchObject({
      source: REQUEST.source,
      scriptName: "Order entry",
      origin: { kind: "local" },
      // The author is previewing their own draft in their own editor, so a
      // `{ control }` binding shows the live value instead of painting unbound.
      readControls: true,
      // Stable per script, so a second preview REPLACES the first in the
      // shared modal slot rather than colliding with it.
      previewId: "preview:form-1",
    });
    expect(typeof args.onClosed).toBe("function");
  });

  it("reports 'shown', then 'closed' when the core says the dialog went away", async () => {
    previewFormLayout.mockResolvedValue(outcome());
    const reported: FormPreviewResultPayload[] = [];
    await runFormPreview(REQUEST, (r) => reported.push(r));
    expect(reported.map((r) => r.outcome)).toEqual(["shown"]);
    lastOnClosed()();
    expect(reported.map((r) => r.outcome)).toEqual(["shown", "closed"]);
    expect(reported[1]).toMatchObject({ requestId: "req-1", scriptId: "form-1", message: "" });
  });

  it("does not report a close that happened BEFORE the show was acknowledged", async () => {
    // A muted preview closes at once; the refusal is the whole story, and a
    // trailing "closed" would clear the note the author needs to read.
    previewFormLayout.mockImplementation(async (req: { onClosed: () => void }) => {
      req.onClosed();
      return outcome({ shown: false, status: "refused", reason: "muted" });
    });
    const reported: FormPreviewResultPayload[] = [];
    await runFormPreview(REQUEST, (r) => reported.push(r));
    expect(reported.map((r) => r.outcome)).toEqual(["refused"]);
  });

  it("turns a thrown core into a result rather than an unhandled rejection", async () => {
    previewFormLayout.mockRejectedValue(new Error("realm exploded"));
    const reported: FormPreviewResultPayload[] = [];
    await runFormPreview(REQUEST, (r) => reported.push(r));
    expect(reported).toEqual([
      expect.objectContaining({ outcome: "error", message: expect.stringContaining("realm exploded") }),
    ]);
  });

  it.each([
    ["declined", "No preview:"],
    ["noLayout", "No layout defined"],
    ["refused", "The preview could not open:"],
    ["error", "The preview could not run:"],
  ])("passes a %s outcome through as its own status line", async (status, lead) => {
    previewFormLayout.mockResolvedValue(outcome({ shown: false, status, reason: "because" }));
    const reported: FormPreviewResultPayload[] = [];
    await runFormPreview(REQUEST, (r) => reported.push(r));
    expect(reported).toHaveLength(1);
    expect(reported[0].outcome).toBe(status);
    expect(reported[0].message).toContain(lead);
    expect(reported[0].message).toContain("because");
  });
});

// ---------------------------------------------------------------------------
// The English
// ---------------------------------------------------------------------------

describe("describeFormPreviewOutcome — the author must be able to tell WHY a widget is empty", () => {
  it("counts the bound widgets and names everything it could not reach", () => {
    const message = describeFormPreviewOutcome(
      outcome({
        seeded: ["customer", "qty"],
        controls: ["band"],
        unresolved: ["other"],
        sources: ["region", "lines"],
        unresolvedSources: ["logo"],
      }) as never,
    );
    expect(message).toContain("Preview open in the main window.");
    expect(message).toContain("2 of 4 bound widgets seeded from a copy of the active sheet.");
    expect(message).toContain("Read from live control values: band.");
    expect(message).toContain("Filled from a range in that copy: region, lines.");
    expect(message).toContain("Not resolved in a preview: other, logo.");
  });

  it("says nothing about bindings when the layout has none", () => {
    expect(describeFormPreviewOutcome(outcome() as never)).toBe("Preview open in the main window.");
  });

  it("adds the script's own error to a missing layout", () => {
    const message = describeFormPreviewOutcome(
      outcome({
        shown: false,
        status: "noLayout",
        reason: "the script never called form.define during setup",
        report: { ok: false, error: "setup(context) threw: boom" },
      }) as never,
    );
    expect(message).toContain("No layout defined");
    expect(message).toContain("setup(context) threw: boom");
  });

  it("surfaces a run error alongside a form that still opened", () => {
    const message = describeFormPreviewOutcome(
      outcome({ report: { ok: false, error: "onShow threw" } }) as never,
    );
    expect(message).toContain("The script also reported: onShow threw.");
  });
});

// ---------------------------------------------------------------------------
// The bridge (main window)
// ---------------------------------------------------------------------------

describe("installFormPreviewBridge — request in, result out, replay on READY", () => {
  it("answers a request over the wire and replays the last result", async () => {
    previewFormLayout.mockResolvedValue(
      outcome({ shown: false, status: "declined", reason: "this environment has no Worker realm" }),
    );
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
    previewFormLayout.mockResolvedValue(outcome({ shown: false, status: "declined", reason: "nope" }));
    await install();
    await request();
    handlers.get(FormPreviewEvents.DISMISS)!({ scriptId: "form-1" });

    emitted.length = 0;
    replayFormPreviewResults();
    expect(results()).toHaveLength(0);
  });

  it("keeps a shown form for replay and drops it once it closes", async () => {
    previewFormLayout.mockResolvedValue(outcome());
    await install();
    await request();
    expect(results().map((r) => r.outcome)).toEqual(["shown"]);

    emitted.length = 0;
    replayFormPreviewResults();
    expect(results().map((r) => r.outcome)).toEqual(["shown"]);

    emitted.length = 0;
    lastOnClosed()();
    expect(results().map((r) => r.outcome)).toEqual(["closed"]);
    emitted.length = 0;
    replayFormPreviewResults();
    expect(results()).toHaveLength(0);
  });

  it("unsubscribes on teardown and forgets stored results", async () => {
    previewFormLayout.mockResolvedValue(outcome({ shown: false, status: "declined", reason: "nope" }));
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
