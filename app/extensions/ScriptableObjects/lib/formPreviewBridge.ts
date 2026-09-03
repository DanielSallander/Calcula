//! FILENAME: app/extensions/ScriptableObjects/lib/formPreviewBridge.ts
// PURPOSE: "Preview form" — paint a FORM script's layout from the code on
//          screen without saving, mounting, writing or auditing anything.
// CONTEXT: 2026-09-03 (TypeScript Forms, release one; the shared-core split is
//          the 2026-09-03 follow-up). Modelled on aiEditBridge.ts /
//          aiEditClient.ts: the Object Script Editor is a separate Tauri window
//          that activates no extensions, and both halves of a preview belong to
//          the MAIN window — the preview realm snapshots the live workbook
//          there, and the modal slot a form claims is that window's. So the
//          editor compiles its buffer and sends the JavaScript over the Tauri
//          event bridge; this, running in the main window, runs it and paints
//          the result. Results are replayed on EDITOR_READY, the same
//          "re-delivery is safe" rule the AI-edit bridge follows.
//
//          WHAT THIS FILE IS, AND WHAT IT IS NOT. Running the draft, seeding
//          its widgets and opening the renderer in preview mode is
//          `previewFormLayout` (`@api`, app/src/api/scriptFormPreview.ts) — the
//          package inspector needs the identical procedure, and a copy of it
//          here would be a second set of seeding rules that drifts on the
//          owner's first change. What is left here is what only this surface
//          has: the Tauri wire between the editor window and the main one, the
//          per-script status the editor renders beside the action, and the
//          English those statuses are written in.
//
//          EVERY FAILURE PATH ANSWERS. "No layout defined", a declined run, a
//          held modal slot and a thrown error all become a RESULT the editor
//          renders as a status line beside the action — never a global alert,
//          and never silence.

import { emitTauriEvent, listenTauriEvent } from "@api/backend";
import type { UnlistenFn } from "@api/backend";
import { previewFormLayout, previewScriptId } from "@api";
import type { FormLayoutPreviewOutcome, WorkerPreviewReport } from "@api";

// ============================================================================
// Wire (Editor <-> Main)
// ============================================================================

export const FormPreviewEvents = {
  /** Editor -> Main: preview this form from this JavaScript. */
  REQUEST: "objscript:form-preview-request",
  /** Main -> Editor: what became of the request (shown / closed / why not). */
  RESULT: "objscript:form-preview-result",
  /** Editor -> Main: the author dismissed the note; forget the stored result. */
  DISMISS: "objscript:form-preview-dismiss",
} as const;

export interface FormPreviewRequestPayload {
  /** Correlates the reply. The editor ignores a result for a superseded request. */
  requestId: string;
  scriptId: string;
  scriptName: string;
  /**
   * JAVASCRIPT — the buffer compiled through the same gate a save uses, but
   * NOT stored. The preview realm runs JavaScript; the buffer may be
   * TypeScript. Compiling in the editor keeps the compiler's message in the
   * window the author is typing in.
   */
  source: string;
}

export type FormPreviewOutcome =
  /** The dialog is on screen in the main window. */
  | "shown"
  /** The dialog closed (Close, Escape, X, backdrop, a reset). */
  | "closed"
  /** The run completed but `form.define` was never called during setup. */
  | "noLayout"
  /** The preview rung could draw no conclusion (`applicable: false`). */
  | "declined"
  /** The registry refused to open the dialog (a modal slot already held, a mute). */
  | "refused"
  /** The run itself threw. */
  | "error";

export interface FormPreviewResultPayload {
  requestId: string;
  scriptId: string;
  outcome: FormPreviewOutcome;
  /** One line for the status strip. Empty only for "closed". */
  message: string;
}

export interface FormPreviewDismissPayload {
  scriptId: string;
}

export async function emitFormPreviewRequest(payload: FormPreviewRequestPayload): Promise<void> {
  await emitTauriEvent(FormPreviewEvents.REQUEST, payload);
}

export async function emitFormPreviewResult(payload: FormPreviewResultPayload): Promise<void> {
  await emitTauriEvent(FormPreviewEvents.RESULT, payload);
}

export async function emitFormPreviewDismiss(payload: FormPreviewDismissPayload): Promise<void> {
  await emitTauriEvent(FormPreviewEvents.DISMISS, payload);
}

export function onFormPreviewRequest(
  callback: (payload: FormPreviewRequestPayload) => void,
): Promise<UnlistenFn> {
  return listenTauriEvent<FormPreviewRequestPayload>(FormPreviewEvents.REQUEST, callback);
}

export function onFormPreviewResult(
  callback: (payload: FormPreviewResultPayload) => void,
): Promise<UnlistenFn> {
  return listenTauriEvent<FormPreviewResultPayload>(FormPreviewEvents.RESULT, callback);
}

export function onFormPreviewDismiss(
  callback: (payload: FormPreviewDismissPayload) => void,
): Promise<UnlistenFn> {
  return listenTauriEvent<FormPreviewDismissPayload>(FormPreviewEvents.DISMISS, callback);
}

// ============================================================================
// Messages (pure)
// ============================================================================

function describeError(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** The script's own error, in parentheses, when the run also failed. */
function alsoFailed(report: WorkerPreviewReport | undefined): string {
  return report && !report.ok && report.error ? ` (${report.error})` : "";
}

/**
 * The status line for one outcome.
 *
 * The counts are said out loud because an author looking at an unbound widget
 * needs to know whether the preview COULD not reach it or the layout never
 * asked it to: a silent empty dropdown reads as "my range is wrong".
 */
export function describeFormPreviewOutcome(outcome: FormLayoutPreviewOutcome): string {
  if (outcome.status === "declined") {
    return `No preview: ${outcome.reason ?? "this script cannot be previewed"}.`;
  }
  if (outcome.status === "noLayout") {
    const note = outcome.reason ?? "the script never called form.define during setup";
    return `No layout defined — ${note}${alsoFailed(outcome.report)}.`;
  }
  if (outcome.status === "error") {
    return `The preview could not run: ${outcome.reason ?? "unknown error"}`;
  }
  if (outcome.status === "refused") {
    return `The preview could not open: ${outcome.reason ?? "the registry refused it"}.`;
  }
  const bound = outcome.seeded.length + outcome.controls.length + outcome.unresolved.length;
  const parts = ["Preview open in the main window."];
  if (bound > 0) {
    parts.push(
      `${outcome.seeded.length} of ${bound} bound widget${bound === 1 ? "" : "s"} seeded from a copy of the active sheet.`,
    );
  }
  if (outcome.controls.length > 0) {
    parts.push(`Read from live control values: ${outcome.controls.join(", ")}.`);
  }
  if (outcome.sources.length > 0) {
    parts.push(`Filled from a range in that copy: ${outcome.sources.join(", ")}.`);
  }
  const stuck = [...outcome.unresolved, ...outcome.unresolvedSources];
  if (stuck.length > 0) {
    parts.push(`Not resolved in a preview: ${stuck.join(", ")}.`);
  }
  if (outcome.report && !outcome.report.ok && outcome.report.error) {
    parts.push(`The script also reported: ${outcome.report.error}.`);
  }
  return parts.join(" ");
}

// ============================================================================
// The run (main window)
// ============================================================================

/**
 * Run one preview to completion, reporting each step through `report`.
 *
 * Reports at most two results: a terminal failure, OR "shown" followed later
 * by "closed". Resolves once the dialog is on screen or the failure is
 * reported — never waits for the user to close the form.
 *
 * Callable directly by main-window code (the in-app CodeEditorDialog) and by
 * the bridge below on behalf of the editor window.
 */
export async function runFormPreview(
  req: FormPreviewRequestPayload,
  report: (result: FormPreviewResultPayload) => void,
): Promise<void> {
  const reply = (outcome: FormPreviewOutcome, message: string): void => {
    report({ requestId: req.requestId, scriptId: req.scriptId, outcome, message });
  };
  let shownAcked = false;
  let outcome: FormLayoutPreviewOutcome;
  try {
    outcome = await previewFormLayout({
      source: req.source,
      scriptName: req.scriptName,
      // The author's own buffer, in the author's own workbook. Structural, so
      // no name anywhere can select or spoof this phrasing.
      origin: { kind: "local" },
      // The author is previewing their OWN draft in their own editor, so a
      // `{ control }` binding is read from the live Controls pane rather than
      // shown unbound. It is a read-only seed either way — see readControlSeeds
      // for why this is the trusted path and not the audited one.
      readControls: true,
      // A stable identity per script, so a second preview REPLACES the first
      // instead of colliding with it in the shared modal slot.
      previewId: previewScriptId(req.scriptId),
      onClosed: () => {
        // A close before "shown" is a refusal `previewFormLayout` reports itself.
        if (shownAcked) reply("closed", "");
      },
    });
  } catch (e) {
    reply("error", `The preview could not run: ${describeError(e)}`);
    return;
  }
  const message = describeFormPreviewOutcome(outcome);
  if (!outcome.shown) {
    // Every core status is also a wire outcome; only "closed" is this file's
    // own, and it is reported from `onClosed` above.
    reply(outcome.status, message);
    return;
  }
  shownAcked = true;
  reply("shown", message);
}

// ============================================================================
// Main-window bridge: hear the editor, run, answer, replay
// ============================================================================

/**
 * The last result per script, for re-delivery on EDITOR_READY.
 *
 * A "closed" result is the one that is NOT kept: after it there is nothing on
 * screen and nothing to say, and a reopened editor is correctly idle.
 */
const lastResults = new Map<string, FormPreviewResultPayload>();

/** Test hook: forget everything this module remembers. */
// eslint-disable-next-line @typescript-eslint/naming-convention -- the repo's `__reset*` test-hook convention (aiEditBridge.ts)
export function __resetFormPreviewBridge(): void {
  lastResults.clear();
}

/** Re-send whatever the editor missed while it was gone. */
export function replayFormPreviewResults(): void {
  for (const result of lastResults.values()) {
    void emitFormPreviewResult(result);
  }
}

function deliver(result: FormPreviewResultPayload): void {
  if (result.outcome === "closed") lastResults.delete(result.scriptId);
  else lastResults.set(result.scriptId, result);
  void emitFormPreviewResult(result);
}

function handle(req: FormPreviewRequestPayload): void {
  lastResults.delete(req.scriptId);
  void runFormPreview(req, deliver);
}

/**
 * Listen for preview requests for the lifetime of the extension.
 *
 * Returns a synchronous teardown suitable for `cleanupFunctions`, which also
 * covers the window where the listeners are still being registered.
 */
export function installFormPreviewBridge(): () => void {
  let disposers: Array<() => void> = [];
  let disposed = false;

  // A channel that cannot be subscribed must not abort activation of the whole
  // extension; it means the editor's preview is unavailable, nothing more.
  const track = (make: () => Promise<() => void>): void => {
    let p: Promise<() => void>;
    try {
      p = make();
    } catch (e) {
      console.warn("[ScriptableObjects] Could not subscribe to a form-preview channel:", e);
      return;
    }
    void p
      .then((off) => {
        if (disposed) off();
        else disposers.push(off);
      })
      .catch((e) => {
        console.warn("[ScriptableObjects] Failed to subscribe to a form-preview channel:", e);
      });
  };

  track(() => onFormPreviewRequest(handle));
  track(() =>
    onFormPreviewDismiss((payload) => {
      if (!payload?.scriptId) return;
      lastResults.delete(payload.scriptId);
    }),
  );

  return () => {
    disposed = true;
    for (const off of disposers) off();
    disposers = [];
    __resetFormPreviewBridge();
  };
}

// ============================================================================
// Editor-window client: ask, hold the status, dismiss
// ============================================================================

export type FormPreviewPhase = "idle" | "running" | "shown" | "failed";

export interface FormPreviewState {
  phase: FormPreviewPhase;
  /** The status line beside the action. */
  message: string;
  /** The request this state answers; "" when idle. */
  requestId: string;
}

/**
 * ONE idle object, returned by identity: `useSyncExternalStore` compares
 * snapshots with `Object.is`, and a fresh literal per read is an endless
 * change ("Maximum update depth exceeded").
 */
export const IDLE_FORM_PREVIEW: FormPreviewState = Object.freeze({
  phase: "idle",
  message: "",
  requestId: "",
}) as FormPreviewState;

/**
 * Fold one result into the state for its script.
 *
 * A result for a request this state did not make is accepted only while the
 * state is IDLE (a replayed delivery); one for a superseded request is
 * ignored, so a refusal for the newest ask is never wiped by the older form
 * finally closing.
 */
export function reduceFormPreviewState(
  prev: FormPreviewState,
  result: FormPreviewResultPayload,
): FormPreviewState {
  if (prev.requestId !== "" && result.requestId !== prev.requestId) return prev;
  switch (result.outcome) {
    case "closed":
      return IDLE_FORM_PREVIEW;
    case "shown":
      return { phase: "shown", message: result.message, requestId: result.requestId };
    default:
      return { phase: "failed", message: result.message, requestId: result.requestId };
  }
}

/** One state per script. NEVER mutated in place — every write replaces the entry. */
const states = new Map<string, FormPreviewState>();
const listeners = new Set<() => void>();
let requestSeq = 0;

function notify(): void {
  for (const fn of listeners) fn();
}

function set(scriptId: string, next: FormPreviewState): void {
  if (next === IDLE_FORM_PREVIEW) states.delete(scriptId);
  else states.set(scriptId, next);
  notify();
}

/** Subscribe to any change. Returns the unsubscribe. */
export function subscribeToFormPreviews(fn: () => void): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

/** The state for one script; the shared idle object when there is none. */
export function formPreviewStateFor(scriptId: string | null): FormPreviewState {
  if (!scriptId) return IDLE_FORM_PREVIEW;
  return states.get(scriptId) ?? IDLE_FORM_PREVIEW;
}

/** Test hook. */
// eslint-disable-next-line @typescript-eslint/naming-convention -- the repo's `__reset*` test-hook convention (aiEditClient.ts)
export function __resetFormPreviewClient(): void {
  states.clear();
  listeners.clear();
  requestSeq = 0;
}

function mintRequestId(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${++requestSeq}`;
}

/** Send a preview request to the main window and enter the running state. */
export function requestFormPreview(opts: {
  scriptId: string;
  scriptName: string;
  /** JavaScript — already through the save gate. */
  source: string;
}): string {
  const requestId = mintRequestId("fp");
  set(opts.scriptId, { phase: "running", message: "Previewing the form in the main window…", requestId });
  void emitFormPreviewRequest({
    requestId,
    scriptId: opts.scriptId,
    scriptName: opts.scriptName,
    source: opts.source,
  }).catch((e) => {
    // The request never left the window. Nothing is coming back, so say so
    // here rather than wait for a result that cannot arrive.
    set(opts.scriptId, {
      phase: "failed",
      message: `Could not reach the main window: ${describeError(e)}`,
      requestId,
    });
  });
  return requestId;
}

/**
 * A failure found BEFORE asking (the buffer does not compile). Minted under
 * its own request id, so a late result for an earlier ask cannot replace it.
 */
export function reportFormPreviewFailure(scriptId: string, message: string): void {
  set(scriptId, { phase: "failed", message, requestId: mintRequestId("local") });
}

/**
 * Hide the status line, and tell the main window to forget the result — or a
 * note the author already read would come back the next time the window opens.
 */
export function dismissFormPreviewStatus(scriptId: string): void {
  set(scriptId, IDLE_FORM_PREVIEW);
  void emitFormPreviewDismiss({ scriptId }).catch(() => {});
}

/** Wire the editor window to the result channel. Returns a synchronous teardown. */
export function installFormPreviewClient(): () => void {
  let disposers: Array<() => void> = [];
  let disposed = false;

  // Subscribing must never take the WINDOW down with it: a preview channel that
  // cannot be reached is a missing optional feature, not a blank editor.
  const track = (make: () => Promise<() => void>): void => {
    let p: Promise<() => void>;
    try {
      p = make();
    } catch (e) {
      console.warn("[ObjectScriptEditor] Could not subscribe to the form-preview channel:", e);
      return;
    }
    void p
      .then((off) => {
        if (disposed) off();
        else disposers.push(off);
      })
      .catch((e) => {
        console.warn("[ObjectScriptEditor] Failed to subscribe to the form-preview channel:", e);
      });
  };

  track(() =>
    onFormPreviewResult((result) => {
      if (!result?.scriptId) return;
      set(result.scriptId, reduceFormPreviewState(formPreviewStateFor(result.scriptId), result));
    }),
  );

  return () => {
    disposed = true;
    for (const off of disposers) off();
    disposers = [];
  };
}
