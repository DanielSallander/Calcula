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
 * NEW is the first item of the menu (Developer > New Macro, 2026-10-22): it
 * creates a macro from a working example and opens it, so a user who asks
 * "where do I write a macro?" is answered by the first line they see.
 *
 * RECORD is ONE item whose label toggles between "Record Macro…" and "Stop
 * Recording". There used to be two permanent items, so the menu offered to stop
 * a recording that was not running — a menu that describes a state the app is
 * not in. One stateful item is both correct and less to read.
 *
 * SEPARATOR closes the macro cluster (New, Record, Macros…, and the Object
 * Script Editor item ScriptableObjects owns) off from the rest of Developer.
 */
export const MENU_ITEMS = {
  NEW: "developer:new-macro",
  RECORD: "developer:record-macro",
  LIBRARY: "developer:macro-library",
  SEPARATOR: "developer:macro-separator",
} as const;

/**
 * Command ids. The `macroRecorder.` prefix is load-bearing: the recording
 * session ignores commands under it, so driving the recorder from a menu or a
 * keybinding never records the act of recording. NEW carries it for the same
 * reason -- creating a macro while recording must not land in the recording.
 */
export const COMMANDS = {
  START: "macroRecorder.start",
  STOP: "macroRecorder.stop",
  PAUSE: "macroRecorder.pause",
  RESUME: "macroRecorder.resume",
  CANCEL: "macroRecorder.cancel",
  LIBRARY: "macroRecorder.library",
  NEW: "macroRecorder.new",
} as const;
