//! FILENAME: app/src/api/scriptAssistantService.ts
// PURPOSE: The feature-neutral seam through which the owner of a script editor
//          can ask "an AI" to EDIT the code on screen, without knowing that an
//          AIChat extension owns the model selection, the job store, the
//          streaming call and the repair loop.
// CONTEXT: The MIRROR of scriptEditorService.ts. That seam points AIChat -> the
//          editor ("open this draft"); this one points the editor -> AIChat
//          ("rewrite this for me"). Neither extension imports the other; both
//          reach through @api, which imports from neither. Two seams in opposite
//          directions between the same pair of extensions LOOKS circular and is
//          not — the cycle would only exist if either side named the other.
//
// WHY THE EDITOR DOES NOT READ THE MODEL SELECTION ITSELF. The choice lives in
// AIChat's own extension-settings namespace under keys only AIChat should know.
// A second reader would hand-copy those keys and become a second source of truth
// that drifts on AIChat's first rename. The seam answers `isConfigured()` and
// `modelLabel()` instead, so the editor can explain itself without owning
// anything.
//
// WHY THE EDITOR CANNOT JUST RUN THE PIPELINE. Every backend command it needs is
// window-guarded to `main` (`ai_chat_complete_stream`, `ai_chat_run_tool`,
// `ai_dry_run_script` all call `require_label(&window, MAIN)`), and the Object
// Script Editor is a SEPARATE Tauri window that activates no extensions at all.
// A run started there would fail at the first model call — and even if the guard
// were widened, the job store is module-level per realm, so it would create a
// second invisible job universe with no status-bar indicator, no completion
// toast, no route back, and a job that dies with the window.

/** Which store the document being edited lives in. Reported, never acted on. */
export type ScriptDocumentKind = "module" | "objectScript" | "aiDraft";

export interface ScriptEditRequest {
  /** The editor's id for the open document. Echoed on the result. */
  documentId: string;
  /** Display name, for the job list and the completion toast. */
  documentName: string;
  /** "button" / "sheet" / ... — decides which API slice the model is shown. */
  objectType: string;
  documentKind: ScriptDocumentKind;
  /**
   * The code ON SCREEN right now.
   *
   * Deliberately not "the stored copy": the user may have typed since the last
   * save, and editing anything other than what they are looking at would
   * silently discard that.
   */
  currentSource: string;
  /** What the user asked for, in their words. */
  instruction: string;
  /** Called exactly once when the job ends, however it ends. */
  onDone: (result: ScriptEditResult) => void;
  /** Called as the run progresses, so a six-minute local model is not silent. */
  onProgress?: (phase: string, live?: string) => void;
}

export interface ScriptEditResult {
  /**
   * Echoed back so a late result cannot be applied to a document the user has
   * since navigated away from. A local model can take minutes; the user is not
   * required to sit still for them.
   */
  documentId: string;
  ok: boolean;
  /** The proposed WHOLE script. Present even when `ok` is false — the best attempt. */
  source: string;
  /** One sentence for the user. */
  summary: string;
  /** The model returned the script unchanged. Not a failure; still worth saying. */
  unchanged?: boolean;
}

export interface ScriptAssistantProvider {
  /**
   * False when no provider/model has been chosen yet.
   *
   * Gates nothing — it EXPLAINS. A disabled button with no reason is the failure
   * mode this whole feature has been fixing.
   */
  isConfigured(): boolean;
  /** e.g. "qwen2.5-coder:7b", for the composer's caption. */
  modelLabel(): string;
  /**
   * Start an edit in the background. Returns a job id IMMEDIATELY.
   *
   * Not a promise: a caller that awaited a run would re-create the coupling the
   * background job store exists to remove, and the editor would freeze for the
   * minutes a local model takes.
   */
  startScriptEdit(req: ScriptEditRequest): string;
  /** Stop a running edit. Safe to call on a job that has already ended. */
  cancelScriptEdit(jobId: string): void;
  /** Bring the running job's own UI to the front. */
  showJob(jobId: string): void;
}

let provider: ScriptAssistantProvider | null = null;

/**
 * Register the assistant. Called once by the AIChat extension at activation;
 * returns the unregister function for its cleanup list.
 *
 * Last registration wins, and unregistering only clears the provider if it is
 * still the one that was registered — so a re-activation cannot leave a dead
 * assistant installed.
 */
export function registerScriptAssistantProvider(next: ScriptAssistantProvider): () => void {
  provider = next;
  return () => {
    if (provider === next) provider = null;
  };
}

/** Whether AI script editing can currently be offered at all. */
export function hasScriptAssistantProvider(): boolean {
  return provider !== null;
}

/**
 * The registered assistant.
 *
 * THROWS when none is registered (the AIChat extension is disabled or failed to
 * load). The caller turns the throw into a message the user can read rather
 * than a button that silently does nothing.
 */
export function requireScriptAssistantProvider(): ScriptAssistantProvider {
  if (!provider) {
    throw new Error(
      "AI script editing is unavailable: the AI Chat extension is not loaded. Enable it and try again.",
    );
  }
  return provider;
}

/** Test/reset hook: forget the registered assistant. */
export function resetScriptAssistantProvider(): void {
  provider = null;
}
