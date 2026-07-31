//! FILENAME: app/extensions/MacroRecorder/lib/ids.ts
// PURPOSE: The extension's stable identifiers in one place.
// CONTEXT: Shared by index.ts (registration) and the components (which cannot
//          reach the ExtensionContext and address dialogs/commands by id).

export const EXTENSION_ID = "calcula.macro-recorder";

export const START_DIALOG_ID = "macro-recorder:start";
export const RESULT_DIALOG_ID = "macro-recorder:result";

export const STATUS_BAR_ITEM_ID = "macro-recorder:indicator";

/**
 * Command ids. The `macroRecorder.` prefix is load-bearing: the recording
 * session ignores commands under it, so driving the recorder from a menu or a
 * keybinding never records the act of recording.
 */
export const COMMANDS = {
  START: "macroRecorder.start",
  STOP: "macroRecorder.stop",
  PAUSE: "macroRecorder.pause",
  RESUME: "macroRecorder.resume",
  CANCEL: "macroRecorder.cancel",
} as const;
