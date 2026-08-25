//! FILENAME: app/extensions/ScriptableObjects/lib/aiEditClient.ts
// PURPOSE: The editor-window side of "Edit with AI" — ask, watch, and hold the
//          proposal until the author accepts or rejects it.
// CONTEXT: 2026-08-25. The one rule this file exists to keep:
//
//              A PROPOSAL NEVER REACHES THE BUFFER BY ITSELF.
//
//          It arrives here and STOPS. The editor shows a diff; only the Accept
//          button writes anything. That matters most for a recorded macro,
//          whose live-edit policy auto-persists within about a second of a
//          buffer change — so an auto-applied proposal would be SAVED before
//          the author had read it, with the previous version already gone.
//
//          State is kept PER DOCUMENT, not per window. A six-minute run must
//          survive the author switching to another script and back; that is the
//          same reason the main window keeps jobs outside React.

import {
  emitAiEditCancel,
  emitAiEditRequest,
  onAiEditProgress,
  onAiEditResult,
  type AiEditDocumentKind,
} from "./crossWindowEvents";

export type AiEditPhase = "idle" | "running" | "proposed" | "error";

export interface AiEditState {
  phase: AiEditPhase;
  /** Coarse step, e.g. "Round 2 of 3". */
  progress: string;
  /** The live sub-line under it — what the model is doing right now. */
  live: string;
  /** The proposed replacement source. Empty unless `phase === "proposed"`. */
  proposal: string;
  /** What the run says it did, or why it could not. */
  summary: string;
  /** The model looked and decided nothing needed changing. */
  unchanged: boolean;
  /** The instruction that produced this, echoed back for the banner. */
  instruction: string;
  jobId: string;
}

const IDLE: AiEditState = {
  phase: "idle",
  progress: "",
  live: "",
  proposal: "",
  summary: "",
  unchanged: false,
  instruction: "",
  jobId: "",
};

/**
 * One state per document.
 *
 * NEVER MUTATED IN PLACE. `useSyncExternalStore` compares snapshots with
 * `Object.is`, so an in-place update is a change React cannot see — the exact
 * bug that made the main window's Stop button look dead. Every write replaces
 * the entry.
 */
const states = new Map<string, AiEditState>();
const listeners = new Set<() => void>();

function notify(): void {
  for (const fn of listeners) fn();
}

function set(documentId: string, patch: Partial<AiEditState>): void {
  states.set(documentId, { ...(states.get(documentId) ?? IDLE), ...patch });
  notify();
}

/** Subscribe to any change. Returns the unsubscribe. */
export function subscribeToAiEdits(fn: () => void): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

/**
 * The state for one document.
 *
 * Returns the SHARED idle object when there is nothing, never a fresh literal:
 * a new object per call is a new snapshot every render, which
 * `useSyncExternalStore` treats as an endless change and answers with
 * "Maximum update depth exceeded".
 */
export function aiEditStateFor(documentId: string | null): AiEditState {
  if (!documentId) return IDLE;
  return states.get(documentId) ?? IDLE;
}

/** True when any document in this window has a run in flight. */
export function anyAiEditRunning(): boolean {
  for (const s of states.values()) if (s.phase === "running") return true;
  return false;
}

/** Test hook. */
export function __resetAiEditClient(): void {
  states.clear();
  listeners.clear();
}

export interface AskOptions {
  documentId: string;
  documentName: string;
  objectType: string;
  documentKind: AiEditDocumentKind;
  /** The text ON SCREEN — including edits the author has not saved. */
  currentSource: string;
  instruction: string;
}

/** Send an edit request to the main window and enter the running state. */
export function askAiToEdit(opts: AskOptions): void {
  set(opts.documentId, {
    phase: "running",
    progress: "Sending to the model",
    live: "",
    proposal: "",
    summary: "",
    unchanged: false,
    instruction: opts.instruction,
    jobId: "",
  });
  void emitAiEditRequest({
    documentId: opts.documentId,
    documentName: opts.documentName,
    objectType: opts.objectType,
    documentKind: opts.documentKind,
    currentSource: opts.currentSource,
    instruction: opts.instruction,
  }).catch((e) => {
    // The request never left the window. Nothing is coming back, so say so
    // here rather than wait for a result that cannot arrive.
    set(opts.documentId, { phase: "error", summary: `Could not reach the main window: ${e}` });
  });
}

/** Ask the main window to stop the run for this document. */
export function cancelAiEdit(documentId: string): void {
  const state = aiEditStateFor(documentId);
  void emitAiEditCancel({ documentId, jobId: state.jobId });
  set(documentId, { phase: "idle", progress: "", live: "", summary: "" });
}

/**
 * Dismiss a proposal WITHOUT applying it.
 *
 * The buffer is not touched, which is the point: after Reject the document is
 * byte-identical to what it was before the author pressed the button.
 *
 * It also tells the main window to forget the run. That window keeps the last
 * result per document so it can re-deliver one the editor missed; without this,
 * a proposal the author threw away would come BACK the next time the window
 * opened.
 */
export function rejectAiEdit(documentId: string): void {
  void emitAiEditCancel({ documentId, jobId: aiEditStateFor(documentId).jobId });
  set(documentId, { phase: "idle", progress: "", live: "", proposal: "", summary: "", unchanged: false });
}

/**
 * Clear the state after the author has ACCEPTED.
 *
 * Applying the text is the editor's job — this only forgets the proposal, so
 * the diff cannot be accepted twice or replayed into a later session.
 */
export function clearAiEdit(documentId: string): void {
  rejectAiEdit(documentId);
}

/** Wire the window to the two inbound channels. Returns a synchronous teardown. */
export function installAiEditClient(): () => void {
  let disposers: Array<() => void> = [];
  let disposed = false;

  // Subscribing must never take the WINDOW down with it. This runs in the
  // editor's mount effect, and an AI channel that cannot be reached is a
  // missing optional feature — not a reason to leave the author staring at a
  // blank window with their script in it.
  const track = (make: () => Promise<() => void>): void => {
    let p: Promise<() => void>;
    try {
      p = make();
    } catch (e) {
      console.warn("[ObjectScriptEditor] Could not subscribe to an AI-edit channel:", e);
      return;
    }
    void p
      .then((off) => {
        if (disposed) off();
        else disposers.push(off);
      })
      .catch((e) => {
        console.warn("[ObjectScriptEditor] Failed to subscribe to an AI-edit channel:", e);
      });
  };

  track(() =>
    onAiEditProgress((p) => {
      // Progress for a run this window is no longer waiting on (cancelled, or
      // already answered) must not resurrect a spinner.
      if (aiEditStateFor(p.documentId).phase !== "running") return;
      set(p.documentId, { progress: p.phase, live: p.live ?? "", jobId: p.jobId || aiEditStateFor(p.documentId).jobId });
    }),
  );

  track(() =>
    onAiEditResult((r) => {
      const current = aiEditStateFor(r.documentId);
      // A REPLAYED result for a document the author already dealt with must not
      // reopen the diff. The main window re-sends on READY because it cannot
      // know whether the first delivery landed; deciding that is this side's job.
      if (current.phase === "proposed" || current.phase === "error") return;
      if (!r.ok) {
        set(r.documentId, { phase: "error", summary: r.summary, progress: "", live: "", proposal: "" });
        return;
      }
      set(r.documentId, {
        phase: "proposed",
        proposal: r.source,
        summary: r.summary,
        unchanged: !!r.unchanged,
        progress: "",
        live: "",
        jobId: r.jobId || current.jobId,
      });
    }),
  );

  return () => {
    disposed = true;
    for (const off of disposers) off();
    disposers = [];
  };
}
