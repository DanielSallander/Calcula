//! FILENAME: app/extensions/Distribution/__tests__/inspectorFormPreviewBridge.test.ts
// PURPOSE: The MAIN-window half of the Application Inspector's form preview —
//          the half that actually runs `previewFormLayout` and paints, because
//          the inspector window has no renderer of its own.
// CONTEXT: 2026-09-03, rebuild. The inspector shows "Opening the preview…" from
//          the moment it sends a request until a RESULT comes back, so every way
//          this side can fail has to produce a result rather than a log line.
//
//          THE SEEDING RULES ARE NOT HERE. Running the draft, seeding its
//          widgets from the copy the run used and opening the renderer in
//          preview mode is `previewFormLayout` (app/src/api/scriptFormPreview.ts),
//          shared with the Object Script Editor and proved in its own test. What
//          this file pins is what only this surface owns: the two arguments that
//          keep somebody else's application out of this workbook and out of this
//          workbook's IDENTITY, the English each outcome is reported in, and the
//          wire.

import { describe, it, expect, vi, beforeEach } from "vitest";

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
  IDLE_INSPECTOR_PREVIEW,
  __resetInspectorFormPreview,
  describeInspectorPreviewFailure,
  describeInspectorPreviewShown,
  inspectorPreviewKey,
  inspectorPreviewStateFor,
  installInspectorFormPreviewBridge,
  installInspectorFormPreviewClient,
  reduceInspectorPreviewState,
  requestInspectorFormPreview,
  runInspectorFormPreview,
} from "../lib/inspectorFormPreview";
import { InspectorFormPreviewEvents } from "../lib/inspectorWindowEvents";
import type { InspectorFormPreviewResult } from "../lib/inspectorWindowEvents";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const REQUEST = {
  requestId: "ifp-1",
  packageName: "vendor-kpis",
  scriptId: "form-1",
  scriptName: "Expense claim",
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

function results(): InspectorFormPreviewResult[] {
  return emitted
    .filter((e) => e.event === InspectorFormPreviewEvents.RESULT)
    .map((e) => e.payload as InspectorFormPreviewResult);
}

/** The `onClosed` the bridge handed the core on its last run. */
function lastOnClosed(): () => void {
  const call = previewFormLayout.mock.calls.at(-1) as [{ onClosed: () => void }];
  expect(call, "previewFormLayout was never called").toBeTruthy();
  return call[0].onClosed;
}

/** Install and wait for the (async) listener registration to settle. */
async function installBridge(): Promise<() => void> {
  const off = installInspectorFormPreviewBridge();
  await Promise.resolve();
  await Promise.resolve();
  return off;
}

beforeEach(() => {
  emitted.length = 0;
  handlers.clear();
  offs.clear();
  previewFormLayout.mockReset();
  __resetInspectorFormPreview();
});

// ---------------------------------------------------------------------------
// What the main window asks the core for
// ---------------------------------------------------------------------------

describe("runInspectorFormPreview — the request it composes", () => {
  it("names the APPLICATION as a package origin, and never reads this workbook's controls", async () => {
    previewFormLayout.mockResolvedValue(outcome());
    await runInspectorFormPreview(REQUEST, () => {});
    const args = previewFormLayout.mock.calls[0][0];
    expect(args).toMatchObject({
      source: REQUEST.source,
      scriptName: "Expense claim",
      // Somebody ELSE'S application, before consent: a `{ control }` binding must
      // not be answered out of the Controls pane of the inspecting workbook.
      readControls: false,
      // Stable per inspected script, so pressing the action twice REPLACES the
      // open preview rather than colliding with it in the shared modal slot —
      // and two applications carrying a script of the same id do not share one
      // preview identity.
      previewId: "preview:inspector:vendor-kpis:form-1",
    });
    expect(typeof args.onClosed).toBe("function");
  });

  it("cannot be made to claim a form is local, even by an application NAMED local", async () => {
    // THE IMPERSONATION THIS EXISTS TO PREVENT. Provenance used to be the
    // string `scriptOrigin`, in which "local" was the sentinel for "a script in
    // this workbook" and every other value was an application name — so
    // publishing under the name `local` bought the local phrasing on the one
    // line of the dialog the reviewer is meant to trust. `origin` is a
    // discriminated shape now: the name is content, `kind` is the verdict.
    previewFormLayout.mockResolvedValue(outcome());
    await runInspectorFormPreview({ ...REQUEST, packageName: "local" }, () => {});
    const args = previewFormLayout.mock.calls[0][0];
    expect(args.origin).toEqual({ kind: "package", name: "local" });
    expect(args.origin.kind).not.toBe("local");
  });
});

// ---------------------------------------------------------------------------
// Every path answers
// ---------------------------------------------------------------------------

describe("runInspectorFormPreview — it always answers", () => {
  it("reports 'shown', then 'closed' when the core says the dialog went away", async () => {
    previewFormLayout.mockResolvedValue(outcome());
    const reported: InspectorFormPreviewResult[] = [];
    await runInspectorFormPreview(REQUEST, (r) => reported.push(r));
    expect(reported.map((r) => r.outcome)).toEqual(["shown"]);
    expect(reported[0].shown).toBe(true);
    expect(reported[0].reason).toMatch(/main Calcula window, behind this one/);

    lastOnClosed()();
    expect(reported.map((r) => r.outcome)).toEqual(["shown", "closed"]);
    expect(reported[1]).toMatchObject({
      requestId: "ifp-1",
      packageName: "vendor-kpis",
      scriptId: "form-1",
      shown: false,
      reason: "",
    });
  });

  it("does not report 'closed' for a close that happened BEFORE anything was shown", async () => {
    // A refusal already reports itself; a second, contradictory result would
    // wipe the reason the reviewer needs to read.
    previewFormLayout.mockImplementation(async (req: { onClosed: () => void }) => {
      req.onClosed();
      return outcome({ shown: false, status: "refused", reason: "the slot is held" });
    });
    const reported: InspectorFormPreviewResult[] = [];
    await runInspectorFormPreview(REQUEST, (r) => reported.push(r));
    expect(reported.map((r) => r.outcome)).toEqual(["refused"]);
  });

  it("carries each failure status through with its own lead", async () => {
    for (const [status, lead] of [
      ["noLayout", "No layout to show"],
      ["declined", "No preview"],
      ["refused", "The preview could not open"],
      ["error", "The preview could not run"],
    ] as const) {
      previewFormLayout.mockResolvedValue(outcome({ shown: false, status, reason: "because" }));
      const reported: InspectorFormPreviewResult[] = [];
      await runInspectorFormPreview(REQUEST, (r) => reported.push(r));
      expect(reported).toHaveLength(1);
      expect(reported[0].outcome).toBe(status);
      expect(reported[0].shown).toBe(false);
      expect(reported[0].reason).toBe(`${lead}: because`);
    }
  });

  it("answers a thrown core rather than leaving the inspector waiting", async () => {
    previewFormLayout.mockRejectedValue(new Error("the realm went away"));
    const reported: InspectorFormPreviewResult[] = [];
    await runInspectorFormPreview(REQUEST, (r) => reported.push(r));
    expect(reported).toHaveLength(1);
    expect(reported[0].outcome).toBe("error");
    expect(reported[0].reason).toContain("the realm went away");
  });

  it("says what a preview could not fill in", async () => {
    previewFormLayout.mockResolvedValue(
      outcome({ unresolved: ["approver"], unresolvedSources: ["logo"] }),
    );
    const reported: InspectorFormPreviewResult[] = [];
    await runInspectorFormPreview(REQUEST, (r) => reported.push(r));
    expect(reported[0].reason).toContain("Left unfilled in a preview: approver, logo.");
  });
});

// ---------------------------------------------------------------------------
// The wire
// ---------------------------------------------------------------------------

describe("the cross-window wire", () => {
  it("runs a request that arrives on the channel and emits the result back", async () => {
    previewFormLayout.mockResolvedValue(outcome());
    await installBridge();
    const handler = handlers.get(InspectorFormPreviewEvents.REQUEST);
    expect(handler, "the main window never subscribed to inspector requests").toBeTruthy();
    handler!(REQUEST);
    for (let i = 0; i < 8; i++) await Promise.resolve();

    expect(previewFormLayout).toHaveBeenCalledTimes(1);
    expect(results()).toHaveLength(1);
    expect(results()[0]).toMatchObject({ requestId: "ifp-1", scriptId: "form-1", shown: true });
  });

  it("unsubscribes on teardown, so deactivate leaves no listener behind", async () => {
    const off = await installBridge();
    off();
    expect(offs.get(InspectorFormPreviewEvents.REQUEST)).toHaveBeenCalled();
  });

  it("ignores a malformed request rather than starting a run for it", async () => {
    await installBridge();
    handlers.get(InspectorFormPreviewEvents.REQUEST)!({ requestId: "", scriptId: "" });
    for (let i = 0; i < 4; i++) await Promise.resolve();
    expect(previewFormLayout).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// The inspector-side status store
// ---------------------------------------------------------------------------

describe("the inspector's status store", () => {
  const KEY = inspectorPreviewKey("vendor-kpis", "form-1");

  it("keys on the APPLICATION as well as the script", async () => {
    // Two applications may each carry a script with the same id; a reviewer
    // switching between them must not read one's note under the other's button.
    expect(inspectorPreviewKey("a", "s1")).not.toBe(inspectorPreviewKey("b", "s1"));
  });

  it("enters 'running' with a message naming the other window", () => {
    requestInspectorFormPreview({
      packageName: "vendor-kpis",
      scriptId: "form-1",
      scriptName: "Expense claim",
      source: "x",
    });
    const state = inspectorPreviewStateFor(KEY);
    expect(state.phase).toBe("running");
    expect(state.message).toMatch(/main Calcula window/);
    expect(emitted.map((e) => e.event)).toEqual([InspectorFormPreviewEvents.REQUEST]);
  });

  it("folds a result in, and drops back to idle when the preview closes", () => {
    const shown = {
      requestId: "r1",
      packageName: "vendor-kpis",
      scriptId: "form-1",
      shown: true,
      outcome: "shown",
      reason: "Preview open.",
    } as const;
    const running = { phase: "running", message: "…", requestId: "r1" } as const;
    expect(reduceInspectorPreviewState(running, shown)).toMatchObject({
      phase: "shown",
      message: "Preview open.",
    });
    expect(
      reduceInspectorPreviewState(running, { ...shown, outcome: "closed", shown: false }),
    ).toBe(IDLE_INSPECTOR_PREVIEW);
  });

  it("ignores a result for a request it superseded", () => {
    // Otherwise a refusal for the newest ask is wiped by an older preview
    // finally closing.
    const running = { phase: "running", message: "…", requestId: "r2" } as const;
    const stale = {
      requestId: "r1",
      packageName: "vendor-kpis",
      scriptId: "form-1",
      shown: false,
      outcome: "closed",
      reason: "",
    } as const;
    expect(reduceInspectorPreviewState(running, stale)).toBe(running);
  });

  it("routes a delivered result to the right script's state", async () => {
    const off = installInspectorFormPreviewClient();
    await Promise.resolve();
    requestInspectorFormPreview({
      packageName: "vendor-kpis",
      scriptId: "form-1",
      scriptName: "Expense claim",
      source: "x",
    });
    const requestId = (emitted[0].payload as { requestId: string }).requestId;
    handlers.get(InspectorFormPreviewEvents.RESULT)!({
      requestId,
      packageName: "vendor-kpis",
      scriptId: "form-1",
      shown: false,
      outcome: "refused",
      reason: "the slot is held",
    });
    expect(inspectorPreviewStateFor(KEY)).toMatchObject({
      phase: "failed",
      message: "the slot is held",
    });
    off();
  });

  it("stops waiting if the main window never answers", () => {
    vi.useFakeTimers();
    try {
      requestInspectorFormPreview({
        packageName: "vendor-kpis",
        scriptId: "form-1",
        scriptName: "Expense claim",
        source: "x",
      });
      expect(inspectorPreviewStateFor(KEY).phase).toBe("running");
      vi.advanceTimersByTime(60_000);
      // A button stuck on "Previewing…" forever is the failure this whole
      // module exists to remove; silence must become a sentence.
      expect(inspectorPreviewStateFor(KEY)).toMatchObject({ phase: "failed" });
      expect(inspectorPreviewStateFor(KEY).message).toMatch(/did not answer/);
    } finally {
      vi.useRealTimers();
    }
  });
});

// ---------------------------------------------------------------------------
// The English
// ---------------------------------------------------------------------------

describe("what the reviewer is told", () => {
  it("names the other window AND whose data seeded the values", () => {
    const text = describeInspectorPreviewShown(
      outcome() as unknown as Parameters<typeof describeInspectorPreviewShown>[0],
    );
    expect(text).toMatch(/main Calcula window, behind this one/);
    expect(text).toMatch(/copy of YOUR active sheet/);
    expect(text).toMatch(/nothing is written anywhere/);
  });

  it("leads a failure with its status and keeps the core's reason", () => {
    const text = describeInspectorPreviewFailure(
      outcome({
        shown: false,
        status: "noLayout",
        reason: "the script never called form.define during setup",
      }) as unknown as Parameters<typeof describeInspectorPreviewFailure>[0],
    );
    expect(text).toBe(
      "No layout to show: the script never called form.define during setup",
    );
  });
});
