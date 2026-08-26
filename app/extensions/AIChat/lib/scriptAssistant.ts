//! FILENAME: app/extensions/AIChat/lib/scriptAssistant.ts
// PURPOSE: AIChat's implementation of the `@api/scriptAssistantService` seam —
//          the thing the Object Script Editor reaches through when the user
//          presses "Edit with AI".
// CONTEXT: 2026-08-25. The owner asked for AI to be "optionally part of the
//          entire process, creation and editing", without copying code into a
//          chat window.
//
//          WHY THIS LIVES IN AICHAT AND RUNS IN THE MAIN WINDOW. Every backend
//          command the pipeline needs is window-guarded to `main`
//          (`ai_chat_complete_stream`, `ai_chat_run_tool`, `ai_dry_run_script`
//          all call `require_label(&window, MAIN)`), and the Object Script
//          Editor is a separate Tauri window that activates no extensions at
//          all. So the editor cannot run this even if it wanted to — and should
//          not: the job store is module-level per realm, so an editor-window run
//          would be a second invisible job universe with no status-bar
//          indicator, no toast, no route back, and a job that dies with the
//          window.
//
//          THE SEAM IS DELIBERATELY THIN. It answers "is a model configured",
//          "which one", "start this", "stop that", "show me" — and nothing about
//          providers, tiers, prompts or repair rounds. The editor should not
//          learn any of that, and a fat seam is a coupling that outlives the
//          feature.

import { startAuthorJob, cancelJob } from "./authorJobs";
import { requestJobView } from "./jobFocus";
import { isComplete, readSelection } from "./providerSelection";
import type { ScriptAssistantProvider, ScriptEditRequest } from "@api";

/**
 * The object type to author against when the editor does not know one.
 *
 * A MODULE script (a recorded macro) has no object type at all — it is not
 * attached to anything. "workbook" is the honest stand-in: its context is the
 * plain one, so the model is shown the shared grid surface and no hooks that do
 * not exist. `draftGate` falls back to "button" for the opposite reason (its
 * drafts really are usually buttons); guessing "button" HERE would show a macro
 * an onClick hook it can never receive.
 */
const MODULE_OBJECT_TYPE = "workbook";

function objectTypeFor(req: ScriptEditRequest): string {
  if (req.documentKind === "module") return MODULE_OBJECT_TYPE;
  return req.objectType || MODULE_OBJECT_TYPE;
}

/** AIChat's implementation of the seam. Registered once, at activation. */
export function buildScriptAssistant(): ScriptAssistantProvider {
  return {
    isConfigured: () => isComplete(readSelection()),

    modelLabel: () => readSelection().model || "",

    startScriptEdit: (req: ScriptEditRequest): string =>
      startAuthorJob({
        intent: req.instruction,
        objectType: objectTypeFor(req),
        // Its PRESENCE is what switches the pipeline into edit mode, so it is
        // passed even when empty — an empty script being "edited" is still an
        // edit, and telling the model it is authoring from nothing would be a
        // different and wrong instruction.
        baseSource: req.currentSource,
        documentName: req.documentName,
        providerId: readSelection().providerId,
        model: readSelection().model,
        baseUrl: readSelection().baseUrl || undefined,
        onPhaseForCaller: (phase, live) => req.onProgress?.(phase, live),
        onDone: (result) =>
          req.onDone({
            // Echoed so a late result cannot land on a document the user left.
            documentId: req.documentId,
            ok: result.ok,
            source: result.source,
            summary: result.summary,
            unchanged: result.unchanged,
            // NOT DEAD ON THIS PATH. A module document is authored as
            // "workbook", whose context declares ten hooks and not one the
            // preview can synthesize a payload for — so an edit to a recorded
            // macro that registers any of them reports every one of them here.
            unexercisedHooks: result.unexercisedHooks,
          }),
      }),

    cancelScriptEdit: (jobId: string) => cancelJob(jobId),

    showJob: () => requestJobView(),
  };
}
