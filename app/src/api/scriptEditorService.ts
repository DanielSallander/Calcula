//! FILENAME: app/src/api/scriptEditorService.ts
// PURPOSE: The feature-neutral seam through which any extension can OPEN a
//          recorded macro in the full Object Script Editor window, without
//          knowing that a ScriptableObjects extension owns that window.
// CONTEXT: Inversion of Control, the same shape buttonControlService.ts and
//          macroRunService.ts use. The ScriptableObjects extension OWNS the
//          Object Script Editor: the separate Tauri window, its Monaco surface,
//          its debugger and its cross-window event channel. The Macro Recorder
//          needs to send the user there — "double-click a macro to edit it",
//          "Edit in Object Script Editor" — but it must not import
//          ScriptableObjects internals (the Facade Rule), and @api owns nothing
//          about that window except this one contract.
//
// DIRECTION OF OWNERSHIP. This FILE is authored on the Macro Recorder's side of
// the fence (a non-scriptHost @api seam), but the PROVIDER is implemented and
// registered by the ScriptableObjects extension, which is the only place that
// can focus/create the editor window and deliver a "load this module macro"
// event into it. The Macro Recorder is purely a consumer:
// `requireScriptEditorProvider().openMacroInEditor(macroId)`.
//
// WHY `macroId` AND NOT A SCRIPT OBJECT. A recorded macro is a MODULE script
// (`macro-<slug>`) in the workbook script store, not an object script. The editor
// resolves the authoritative record itself from the id, so the seam carries only
// the id — the one durable handle both sides already agree on.

/** What the ScriptableObjects extension provides: open a macro for editing. */
export interface ScriptEditorProvider {
  /**
   * Focus (or create) the Object Script Editor window and load the module macro
   * with this id into it. Rejects if the editor window cannot be reached.
   */
  openMacroInEditor(macroId: string): Promise<void>;
}

let provider: ScriptEditorProvider | null = null;

/**
 * Register the editor driver. Called once by the ScriptableObjects extension at
 * activation; returns the unregister function for its cleanup list.
 *
 * Last registration wins, and unregistering only clears the provider if it is
 * still the one that was registered.
 */
export function registerScriptEditorProvider(next: ScriptEditorProvider): () => void {
  provider = next;
  return () => {
    if (provider === next) provider = null;
  };
}

/** Whether the Object Script Editor can currently be opened on a macro. */
export function hasScriptEditorProvider(): boolean {
  return provider !== null;
}

/**
 * The registered provider.
 *
 * THROWS when none is registered (the ScriptableObjects extension is disabled or
 * failed to load). The caller turns the throw into a message the user can read
 * rather than a menu action that silently does nothing.
 */
export function requireScriptEditorProvider(): ScriptEditorProvider {
  if (!provider) {
    throw new Error(
      "The Object Script Editor is unavailable: the ScriptableObjects extension is not loaded. Enable it and try again.",
    );
  }
  return provider;
}

/** Test/reset hook: forget the registered provider. */
export function resetScriptEditorProvider(): void {
  provider = null;
}
