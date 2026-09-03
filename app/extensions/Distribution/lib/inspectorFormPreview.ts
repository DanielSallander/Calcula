// FILENAME: app/extensions/Distribution/lib/inspectorFormPreview.ts
// PURPOSE: "Preview layout" for a FORM script inside an unconsented .calp — the
//          half that has to live in the MAIN window, plus the per-script status
//          the Application Inspector renders beside its button.
// CONTEXT: 2026-09-03. Modelled on ScriptableObjects/lib/formPreviewBridge.ts,
//          which solves the identical problem for the Object Script Editor.
//
//          WHY THE CALL CANNOT HAPPEN IN THE INSPECTOR. The Application
//          Inspector is a standalone Tauri window (app/src/packageInspectorMain.tsx,
//          label "package-inspector") that mounts `ApplicationInspectorApp` and
//          deliberately loads NO Shell — so no extension is activated inside it.
//          `previewFormLayout` ends in `showScriptForm`, which emits
//          SCRIPT_FORM_REQUEST_EVENT, and the only listener for that is the
//          ScriptableObjects extension in the MAIN window. Called from the
//          inspector the request reached nobody: nothing painted, no renderer
//          ever acknowledged "shown", and the show failed ten seconds later on
//          FORM_SHOWN_ACK_TIMEOUT_MS — a button that could not work by
//          construction, whose only symptom was a pause and then a refusal.
//
//          So the WIRE goes between the windows, not the call. The inspector
//          sends the source; this module, running in the main window, runs the
//          preview and paints it there; the outcome comes back and the
//          inspector renders it inline beside the action. The reviewer is TOLD
//          the dialog opens in the main window — a form appearing behind the
//          window you are reading, with no explanation, is worse than no
//          feature.
//
//          NO REPLAY STORE, DELIBERATELY. The editor's bridge keeps its last
//          result per script and replays it on EDITOR_READY, because that
//          window is reopened onto the same script it was editing. This one is
//          not: a reopened inspector starts at the workspace picker with no
//          application loaded and no script rows on screen, so a replayed note
//          would have nowhere to land. What IS wired is the other half of that
//          lifecycle — when the preview dialog closes in the main window the
//          inspector's note clears, instead of claiming a form is open that is
//          not.

import { previewFormLayout, previewScriptId } from "@api";
import type { FormLayoutPreviewOutcome, FormLayoutPreviewStatus } from "@api";
import {
  emitInspectorFormPreviewRequest,
  emitInspectorFormPreviewResult,
  onInspectorFormPreviewRequest,
  onInspectorFormPreviewResult,
  type InspectorFormPreviewOutcome,
  type InspectorFormPreviewRequest,
  type InspectorFormPreviewResult,
} from "./inspectorWindowEvents";

// ============================================================================
// Messages (pure) — composed in the MAIN window, which is the side that holds
// the outcome, and rendered verbatim by the inspector.
// ============================================================================

/**
 * How each failed preview is introduced. Typed on the core status union so a new
 * status fails the build instead of falling through to a bare reason string.
 */
const PREVIEW_FAILURE_LEAD: Record<FormLayoutPreviewStatus, string> = {
  // Never rendered: `shown` is the success path.
  shown: "Preview open",
  noLayout: "No layout to show",
  declined: "No preview",
  refused: "The preview could not open",
  error: "The preview could not run",
};

/**
 * What the reviewer is looking at, said out loud.
 *
 * TWO THINGS THAT WOULD OTHERWISE MISLEAD. The dialog is in the OTHER window —
 * the one behind the inspector — so a reviewer who is told only "preview open"
 * looks at the inspector and sees nothing. And the LAYOUT is the application's
 * while every VALUE in it was seeded from a copy of the inspecting user's own
 * active sheet (that is the only grid the preview rung has), which unsaid
 * invites reading your own numbers as data the package brought with it.
 */
export function describeInspectorPreviewShown(outcome: FormLayoutPreviewOutcome): string {
  const parts = [
    "Preview open in the main Calcula window, behind this one. The layout is this application's; any values in it were seeded from a copy of YOUR active sheet, and nothing is written anywhere.",
  ];
  const stuck = [...outcome.unresolved, ...outcome.unresolvedSources];
  if (stuck.length > 0) parts.push(`Left unfilled in a preview: ${stuck.join(", ")}.`);
  return parts.join(" ");
}

export function describeInspectorPreviewFailure(outcome: FormLayoutPreviewOutcome): string {
  const lead = PREVIEW_FAILURE_LEAD[outcome.status] ?? "No preview";
  return outcome.reason ? `${lead}: ${outcome.reason}` : `${lead}.`;
}

function describeError(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

// ============================================================================
// The run (main window)
// ============================================================================

/**
 * Run one inspector preview to completion, reporting each step through `report`.
 *
 * Reports at most two results: a terminal failure, OR "shown" followed later by
 * "closed". Resolves once the dialog is on screen or the failure is known —
 * never waits for the reviewer to close it.
 *
 * TWO DELIBERATE ARGUMENTS TO `previewFormLayout`:
 *  - `readControls: false`. This is somebody ELSE'S application, being looked at
 *    before anyone has agreed to run it. A `{ control }` binding would otherwise
 *    be answered out of THIS workbook's live Controls pane, which is exactly the
 *    reach the reviewer has not granted. Those widgets paint unbound with their
 *    reason on them, which is the honest answer.
 *  - `origin: { kind: "package", name }`. The renderer's identity band branches
 *    on `kind`, so a form out of an unconsented package can never present itself
 *    as one of this workbook's own — not even by being published under the name
 *    `local`, which is what the old bare-string `scriptOrigin` allowed.
 *
 * What actually keeps this safe is none of the above and none of the "forms
 * only" gate at the call site: it is the rung. `previewFormLayout` runs the
 * source in the Worker-realm preview harness under `buildPreviewHandle` — an
 * EMPTY capability ceiling and empty grants, nothing mounted, a throwaway copy
 * of the active sheet as the whole backend, and no audit rows. Consent remains
 * the only thing that can really run this code.
 */
export async function runInspectorFormPreview(
  req: InspectorFormPreviewRequest,
  report: (result: InspectorFormPreviewResult) => void,
): Promise<void> {
  const reply = (outcome: InspectorFormPreviewOutcome, reason: string): void => {
    report({
      requestId: req.requestId,
      packageName: req.packageName,
      scriptId: req.scriptId,
      shown: outcome === "shown",
      outcome,
      reason,
    });
  };
  let shownAcked = false;
  let outcome: FormLayoutPreviewOutcome;
  try {
    outcome = await previewFormLayout({
      source: req.source,
      scriptName: req.scriptName,
      origin: { kind: "package", name: req.packageName },
      readControls: false,
      // Stable per inspected script, so pressing the action twice REPLACES the
      // open preview instead of colliding with itself in the shared modal slot
      // — and so two applications carrying a script of the same name do not
      // share one preview identity.
      previewId: previewScriptId(`inspector:${req.packageName}:${req.scriptId}`),
      onClosed: () => {
        // A close before "shown" is a refusal `previewFormLayout` reports itself.
        if (shownAcked) reply("closed", "");
      },
    });
  } catch (e) {
    // Documented not to throw, but an unhandled rejection here would be
    // invisible: the inspector has no devtools and no address bar (BUG-0083).
    reply("error", `The preview could not run: ${describeError(e)}`);
    return;
  }
  if (!outcome.shown) {
    // Every core status is also a wire outcome; only "closed" is this file's
    // own, and it is reported from `onClosed` above.
    reply(outcome.status, describeInspectorPreviewFailure(outcome));
    return;
  }
  shownAcked = true;
  reply("shown", describeInspectorPreviewShown(outcome));
}

/**
 * Listen, in the MAIN window, for preview requests from the inspector.
 *
 * Returns a synchronous teardown suitable for the Distribution extension's
 * `cleanupFns`, which also covers the window where the listener is still being
 * registered.
 */
export function installInspectorFormPreviewBridge(): () => void {
  let disposers: Array<() => void> = [];
  let disposed = false;

  let p: Promise<() => void>;
  try {
    p = onInspectorFormPreviewRequest((req) => {
      if (!req?.requestId || !req.scriptId) return;
      void runInspectorFormPreview(req, (result) => {
        void emitInspectorFormPreviewResult(result);
      });
    });
  } catch (e) {
    // A channel that cannot be subscribed must not abort activation of the
    // whole extension; it means the inspector's preview is unavailable.
    console.warn("[Distribution] Could not subscribe to the inspector form-preview channel:", e);
    return () => {};
  }
  void p
    .then((off) => {
      if (disposed) off();
      else disposers.push(off);
    })
    .catch((e) => {
      console.warn("[Distribution] Failed to subscribe to the inspector form-preview channel:", e);
    });

  return () => {
    disposed = true;
    for (const off of disposers) off();
    disposers = [];
  };
}

// ============================================================================
// Inspector-window client: ask, hold the status, hear the answer
// ============================================================================

/**
 * How long the inspector waits for the main window before saying so.
 *
 * The main window answers on every path `previewFormLayout` has, so silence
 * means the channel itself is gone (the main window reloaded, or Distribution
 * deactivated). Generous, because the answer legitimately waits for two passes
 * through a Worker realm plus the renderer's 10 s "shown" acknowledgement — but
 * bounded, because a button stuck on "Previewing…" forever is the failure this
 * whole file exists to remove.
 */
export const INSPECTOR_PREVIEW_REPLY_TIMEOUT_MS = 60_000;

export type InspectorPreviewPhase = "idle" | "running" | "shown" | "failed";

export interface InspectorPreviewState {
  phase: InspectorPreviewPhase;
  /** The status line beside the action. */
  message: string;
  /** The request this state answers; "" when idle. */
  requestId: string;
}

/**
 * ONE idle object, returned by identity: `useSyncExternalStore` compares
 * snapshots with `Object.is`, and a fresh literal per read is an endless change
 * ("Maximum update depth exceeded").
 */
export const IDLE_INSPECTOR_PREVIEW: InspectorPreviewState = Object.freeze({
  phase: "idle",
  message: "",
  requestId: "",
}) as InspectorPreviewState;

/**
 * One state per inspected script. The APPLICATION is part of the key: two
 * applications may each carry a script with the same id, and a reviewer
 * switching between them must not see one's note under the other's button.
 */
export function inspectorPreviewKey(packageName: string, scriptId: string): string {
  return JSON.stringify([packageName, scriptId]);
}

/**
 * Fold one result into the state for its script.
 *
 * A result for a request this state did not make is accepted only while the
 * state is IDLE; one for a superseded request is ignored, so a refusal for the
 * newest ask is never wiped by an older preview finally closing.
 */
export function reduceInspectorPreviewState(
  prev: InspectorPreviewState,
  result: InspectorFormPreviewResult,
): InspectorPreviewState {
  if (prev.requestId !== "" && result.requestId !== prev.requestId) return prev;
  switch (result.outcome) {
    case "closed":
      return IDLE_INSPECTOR_PREVIEW;
    case "shown":
      return { phase: "shown", message: result.reason, requestId: result.requestId };
    default:
      return { phase: "failed", message: result.reason, requestId: result.requestId };
  }
}

const states = new Map<string, InspectorPreviewState>();
const listeners = new Set<() => void>();
let requestSeq = 0;

function notify(): void {
  for (const fn of listeners) fn();
}

function set(key: string, next: InspectorPreviewState): void {
  if (next === IDLE_INSPECTOR_PREVIEW) states.delete(key);
  else states.set(key, next);
  notify();
}

/** Subscribe to any change. Returns the unsubscribe. */
export function subscribeToInspectorPreviews(fn: () => void): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

/** The state for one inspected script; the shared idle object when there is none. */
export function inspectorPreviewStateFor(key: string | null): InspectorPreviewState {
  if (!key) return IDLE_INSPECTOR_PREVIEW;
  return states.get(key) ?? IDLE_INSPECTOR_PREVIEW;
}

/** Test hook: forget everything this module remembers. */
// eslint-disable-next-line @typescript-eslint/naming-convention -- the repo's `__reset*` test-hook convention (formPreviewBridge.ts)
export function __resetInspectorFormPreview(): void {
  states.clear();
  listeners.clear();
  requestSeq = 0;
}

/** Ask the main window to preview this form, and enter the running state. */
export function requestInspectorFormPreview(opts: {
  packageName: string;
  scriptId: string;
  scriptName: string;
  source: string;
}): string {
  const key = inspectorPreviewKey(opts.packageName, opts.scriptId);
  const requestId = `ifp-${Date.now().toString(36)}-${++requestSeq}`;
  set(key, {
    phase: "running",
    message: "Opening the preview in the main Calcula window…",
    requestId,
  });
  void emitInspectorFormPreviewRequest({
    requestId,
    packageName: opts.packageName,
    scriptId: opts.scriptId,
    scriptName: opts.scriptName,
    source: opts.source,
  }).catch((e) => {
    // The request never left this window. Nothing is coming back, so say so
    // here rather than sit on "Opening…" waiting for a reply that cannot come.
    if (inspectorPreviewStateFor(key).requestId !== requestId) return;
    set(key, {
      phase: "failed",
      message: `Could not reach the main Calcula window: ${describeError(e)}`,
      requestId,
    });
  });
  setTimeout(() => {
    const current = inspectorPreviewStateFor(key);
    if (current.requestId !== requestId || current.phase !== "running") return;
    set(key, {
      phase: "failed",
      message:
        "The main Calcula window did not answer. Check that it is still open, then try again.",
      requestId,
    });
  }, INSPECTOR_PREVIEW_REPLY_TIMEOUT_MS);
  return requestId;
}

/** Wire the inspector window to the result channel. Returns a synchronous teardown. */
export function installInspectorFormPreviewClient(): () => void {
  let disposers: Array<() => void> = [];
  let disposed = false;

  let p: Promise<() => void>;
  try {
    p = onInspectorFormPreviewResult((result) => {
      if (!result?.scriptId) return;
      const key = inspectorPreviewKey(result.packageName, result.scriptId);
      set(key, reduceInspectorPreviewState(inspectorPreviewStateFor(key), result));
    });
  } catch (e) {
    // Subscribing must never take the WINDOW down with it: a preview channel
    // that cannot be reached is a missing optional feature, not a blank window.
    console.warn("[ApplicationInspector] Could not subscribe to the form-preview channel:", e);
    return () => {};
  }
  void p
    .then((off) => {
      if (disposed) off();
      else disposers.push(off);
    })
    .catch((e) => {
      console.warn("[ApplicationInspector] Failed to subscribe to the form-preview channel:", e);
    });

  return () => {
    disposed = true;
    for (const off of disposers) off();
    disposers = [];
  };
}
