//! FILENAME: app/extensions/ScriptableObjects/lib/aiEditBridge.ts
// PURPOSE: The main-window half of "Edit with AI": hear a request from the
//          editor window, run it through the `@api/scriptAssistantService` seam,
//          and send the proposal back.
// CONTEXT: 2026-08-25. The Object Script Editor is a separate Tauri window that
//          activates NO extensions, and every AI backend command is
//          window-guarded to `main`. So the editor cannot run a model even in
//          principle — it sends the buffer and an instruction over the Tauri
//          event bridge, and this, running in the main window where AIChat is
//          alive, does the work.
//
//          EVERY FAILURE PATH EMITS. A bridge that swallowed an error would
//          leave the editor showing a spinner for a run that is never coming
//          back — which is the exact failure this whole feature has spent three
//          days removing. No provider, a provider that throws, a run that
//          fails: all three become an `ok: false` RESULT the editor can render.
//
//          IT NEVER APPLIES ANYTHING. The proposal goes back as text. Whether it
//          reaches the buffer is the user's decision, taken in the editor in
//          front of a diff — for a recorded macro especially, where applying
//          auto-persists within a second.

import { hasScriptAssistantProvider, requireScriptAssistantProvider } from "@api";
import {
  emitAiEditProgress,
  emitAiEditResult,
  onAiEditCancel,
  onAiEditRequest,
  type AiEditRequestPayload,
  type AiEditResultPayload,
} from "./crossWindowEvents";

/**
 * The last proposal per document, for re-delivery.
 *
 * The editor window can be CLOSED while a six-minute run is in flight, and a
 * result emitted at a window that no longer exists is simply lost. The main
 * window is the only side that still knows, so it keeps the answer and re-sends
 * it when an editor announces itself ready — the same "READY is definitive,
 * re-delivery is safe" rule the initial open payload already follows.
 */
const lastResults = new Map<string, AiEditResultPayload>();

/** Job ids by document, so a cancel from the editor can name the right run. */
const jobsByDocument = new Map<string, string>();

/** Test hook: forget everything this module remembers. */
export function __resetAiEditBridge(): void {
  lastResults.clear();
  jobsByDocument.clear();
}

/** Re-send whatever the editor missed while it was gone. */
export function replayAiEditResults(): void {
  for (const result of lastResults.values()) {
    void emitAiEditResult(result);
  }
}

function fail(req: AiEditRequestPayload, summary: string): void {
  const payload: AiEditResultPayload = {
    documentId: req.documentId,
    jobId: "",
    ok: false,
    // Empty, never the current source: a "proposal" identical to what is on
    // screen would invite the user to apply a no-op and think something happened.
    source: "",
    summary,
  };
  lastResults.set(req.documentId, payload);
  void emitAiEditResult(payload);
}

function handle(req: AiEditRequestPayload): void {
  if (!hasScriptAssistantProvider()) {
    fail(req, "AI editing is unavailable: the AI Chat extension is not loaded.");
    return;
  }

  let assistant;
  try {
    assistant = requireScriptAssistantProvider();
  } catch (e) {
    fail(req, `${e}`);
    return;
  }

  if (!assistant.isConfigured()) {
    // A refusal with an instruction, not a dead button. The user cannot pick a
    // model from the editor window, so the message has to say where to go.
    fail(req, "No AI model is selected. Open the AI Chat pane, choose a provider and model, then try again.");
    return;
  }

  try {
    const jobId = assistant.startScriptEdit({
      documentId: req.documentId,
      documentName: req.documentName,
      objectType: req.objectType,
      documentKind: req.documentKind,
      currentSource: req.currentSource,
      instruction: req.instruction,
      onProgress: (phase, live) => {
        void emitAiEditProgress({
          documentId: req.documentId,
          jobId: jobsByDocument.get(req.documentId) ?? "",
          phase,
          live,
        });
      },
      onDone: (result) => {
        const payload: AiEditResultPayload = {
          documentId: result.documentId,
          jobId: jobsByDocument.get(req.documentId) ?? "",
          ok: result.ok,
          source: result.source,
          summary: result.summary,
          unchanged: result.unchanged,
        };
        lastResults.set(result.documentId, payload);
        jobsByDocument.delete(req.documentId);
        void emitAiEditResult(payload);
      },
    });
    jobsByDocument.set(req.documentId, jobId);
  } catch (e) {
    // A provider that throws SYNCHRONOUSLY still has to reach the editor, or
    // the composer sits there waiting for a run that never started.
    fail(req, `Could not start the edit: ${e}`);
  }
}

/**
 * Listen for edit requests for the lifetime of the extension.
 *
 * Returns a synchronous teardown suitable for `cleanupFunctions`, which also
 * covers the window where the listeners are still being registered.
 */
export function installAiEditBridge(): () => void {
  let disposers: Array<() => void> = [];
  let disposed = false;

  // A channel that cannot be subscribed must not abort activation of the whole
  // extension; it means AI editing is unavailable, nothing more.
  const track = (make: () => Promise<() => void>): void => {
    let p: Promise<() => void>;
    try {
      p = make();
    } catch (e) {
      console.warn("[ScriptableObjects] Could not subscribe to an AI-edit channel:", e);
      return;
    }
    void p
      .then((off) => {
        if (disposed) off();
        else disposers.push(off);
      })
      .catch((e) => {
        console.warn("[ScriptableObjects] Failed to subscribe to an AI-edit channel:", e);
      });
  };

  track(() => onAiEditRequest(handle));
  track(() =>
    onAiEditCancel((payload) => {
      if (!payload?.documentId) return;
      // A cancel means "I am done with this run" — whether the author stopped
      // it, accepted the proposal or threw it away. Forgetting the stored
      // result is the important half: without it, a proposal the author already
      // REJECTED would be replayed the next time the editor window opens.
      lastResults.delete(payload.documentId);
      // The editor may not know the job id (a replayed proposal carries no live
      // job); this window always does.
      const jobId = payload.jobId || jobsByDocument.get(payload.documentId) || "";
      jobsByDocument.delete(payload.documentId);
      if (!jobId || !hasScriptAssistantProvider()) return;
      try {
        requireScriptAssistantProvider().cancelScriptEdit(jobId);
      } catch (e) {
        console.warn("[ScriptableObjects] Failed to cancel an AI edit:", e);
      }
    }),
  );

  return () => {
    disposed = true;
    for (const off of disposers) off();
    disposers = [];
    __resetAiEditBridge();
  };
}
