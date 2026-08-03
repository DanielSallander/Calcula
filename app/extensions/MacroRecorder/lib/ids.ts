//! FILENAME: app/extensions/MacroRecorder/lib/ids.ts
// PURPOSE: The extension's stable identifiers in one place.
// CONTEXT: Shared by index.ts (registration) and the components (which cannot
//          reach the ExtensionContext and address dialogs/commands by id).

export const EXTENSION_ID = "calcula.macro-recorder";

export const START_DIALOG_ID = "macro-recorder:start";
export const RESULT_DIALOG_ID = "macro-recorder:result";
export const LIBRARY_DIALOG_ID = "macro-recorder:library";

export const STATUS_BAR_ITEM_ID = "macro-recorder:indicator";

/**
 * Developer-menu item ids.
 *
 * RECORD is ONE item whose label toggles between "Record Macro…" and "Stop
 * Recording". There used to be two permanent items, so the menu offered to stop
 * a recording that was not running — a menu that describes a state the app is
 * not in. One stateful item is both correct and less to read.
 */
export const MENU_ITEMS = {
  RECORD: "developer:record-macro",
  LIBRARY: "developer:macro-library",
} as const;

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
  LIBRARY: "macroRecorder.library",
} as const;
