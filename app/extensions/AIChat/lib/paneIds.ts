//! FILENAME: app/extensions/AIChat/lib/paneIds.ts
// PURPOSE: The task-pane ids AIChat registers.
// CONTEXT: Extracted from `index.ts` so `lib/` can name a pane without importing
//          the activation module. `completionProvider.openModelPicker()` has to
//          raise the model pane from a module-level function that has no
//          `ExtensionContext`, and an id re-typed there would be a second source
//          of truth that drifts the first time a pane is renamed.

/** The chat itself. */
export const AI_CHAT_PANE_ID = "ai-chat";

/** The model picker: provider choice, key entry, downloads, probes. */
export const AI_CHAT_LLM_PANE_ID = "ai-chat-llm";
