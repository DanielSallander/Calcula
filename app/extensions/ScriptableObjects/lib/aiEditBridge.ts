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
    // Nothing ran, so nothing was left unexercised. Empty is the honest answer,
    // and the field is required so a later arm cannot forget to decide.
    unexercisedHooks: [],
    // REFUSED EARNS ITS OWN ARM. Telling an author their model could not write
    // the script when no model was ever selected sends them tuning the wrong
    // thing. Nothing was asked, so every measured field is zero and says so.
    run: {
      // "" IS THE STRUCTURAL UNPERSISTABLE MARKER: `append_run` refuses an
      // empty run id, and the editor's `recordDecision` skips a run without
      // one — a refusal is shown, never written into the authoring log.
      runId: "",
      kind: "edit",
      outcome: "refused",
      startedAt: new Date().toISOString(),
      elapsedMs: 0,
      instruction: req.instruction,
      objectType: req.objectType,
      providerId: "",
      model: "",
      tier: "",
      surfaceTokens: 0,
      surfaceTruncated: false,
      summary,
      attempts: [],
      notices: [],
      changedNothing: false,
      unexercisedHooks: [],
    },
    instruction: req.instruction,
    askedAgainst: req.currentSource,
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
    // Assigned when `startScriptEdit` returns; both callbacks close over it.
    // A late onProgress/onDone from a run this document is no longer waiting
    // on — cancelled (mapping deleted) or superseded (mapping now holds the
    // NEXT run's id) — must not be relayed: it would re-store a stopped
    // result for replay at every EDITOR_READY, stamp this run's payload with
    // the next run's id, and delete the next run's mapping. The `jobId &&`
    // half keeps the guard permissive for a provider that answers
    // synchronously from inside `startScriptEdit`, before any id exists to
    // compare — that completion must still reach the editor.
    let jobId = "";
    jobId = assistant.startScriptEdit({
      documentId: req.documentId,
      documentName: req.documentName,
      objectType: req.objectType,
      documentKind: req.documentKind,
      currentSource: req.currentSource,
      instruction: req.instruction,
      onProgress: (phase, live) => {
        if (jobId && jobsByDocument.get(req.documentId) !== jobId) return;
        void emitAiEditProgress({
          documentId: req.documentId,
          jobId,
          phase,
          live,
        });
      },
      onDone: (result) => {
        if (jobId && jobsByDocument.get(req.documentId) !== jobId) return;
        const payload: AiEditResultPayload = {
          documentId: result.documentId,
          jobId,
          ok: result.ok,
          source: result.source,
          summary: result.summary,
          unchanged: result.unchanged,
          // THE ONE PLACE THE SEAM'S OPTIONAL FIELD BECOMES A REQUIRED ONE. A
          // third-party assistant provider may run no dry run at all, so the
          // seam leaves it optional; everything downstream of this line — the
          // wire payload, the editor state, the diff — treats it as an array.
          unexercisedHooks: result.unexercisedHooks ?? [],
          // `?? null` for the same reason: the seam leaves it optional because a
          // third-party assistant runs no repair loop and has no run to report,
          // and absent must not cross the wire as a silent `undefined`.
          run: result.run ?? null,
          // From the REQUEST, not the result: the request is what the author
          // typed and what the model was handed, and a replayed payload has to
          // carry both or the diff can only guess at them.
          instruction: req.instruction,
          askedAgainst: req.currentSource,
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
