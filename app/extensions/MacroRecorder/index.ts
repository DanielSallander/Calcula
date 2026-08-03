//! FILENAME: app/extensions/MacroRecorder/index.ts
// PURPOSE: Macro Recorder extension entry point — record what you do, read the
//          script it produces, edit it, and bind it to a button.
// CONTEXT: VBA's ecosystem was bootstrapped by record -> read -> edit, and this
//          is Calcula's on-ramp to its own (sandboxed, auditable) scripting.
//          A recorder shipped inside the ScriptEditor extension in Wave 4;
//          ScriptEditor was retired and took the recorder with it, leaving the
//          core-side hook with no caller. This is its home now — a normal
//          extension using only @api, exactly like a third party would write.
//
// ONE MENU ITEM, NOT TWO. "Record Macro…" and "Stop Recording" used to both sit
// in the Developer menu permanently, so the app offered to stop a recording that
// was not running. A menu is a statement about the current state; the item's
// LABEL now follows the session, which is also fewer things to read.

import type { ExtensionModule, ExtensionContext } from "@api/contract";
import { ExtensionRegistry, AppEvents } from "@api";
import { registerMacroRunProvider } from "@api/macroRunService";
import { runMacroByRef } from "./lib/macroLibrary";
import { macroRecorderBackend } from "./lib/macroRecorderBackend";
import { showDialog } from "@api/ui";
import { showToast } from "@api/notifications";
import { onAppEvent } from "@api/events";
import { StartRecordingDialog } from "./components/StartRecordingDialog";
import { RecordedMacroDialog } from "./components/RecordedMacroDialog";
import { MacroLibraryDialog } from "./components/MacroLibraryDialog";
import { RecordingIndicator } from "./components/RecordingIndicator";
import {
  cancelRecording,
  getRecorderSnapshot,
  pauseRecording,
  resumeRecording,
  subscribeToRecorder,
} from "./lib/actionRecorder";
import { abandonRecording, finishRecording, setCurrentSelection } from "./lib/flow";
import {
  COMMANDS,
  LIBRARY_DIALOG_ID,
  MENU_ITEMS,
  RESULT_DIALOG_ID,
  START_DIALOG_ID,
  STATUS_BAR_ITEM_ID,
} from "./lib/ids";

const cleanupFns: (() => void)[] = [];
let isActivated = false;

/** The label the record/stop item shows for a given session status. */
export function recordMenuLabel(status: string): string {
  return status === "idle" ? "Record Macro…" : "Stop Recording";
}

// ============================================================================
// Activation
// ============================================================================

function activate(context: ExtensionContext): void {
  if (isActivated) {
    console.warn("[MacroRecorder] Already activated, skipping.");
    return;
  }
  console.log("[MacroRecorder] Activating...");

  // 0. Bind the capability-scoped backend door for lib helpers (the delete
  //    warning's `list_controls_referencing_macro` query goes through it).
  macroRecorderBackend.set(context.invokeBackend);

  // 1. Dialogs.
  context.ui.dialogs.register({
    id: START_DIALOG_ID,
    component: StartRecordingDialog,
    priority: 100,
  });
  cleanupFns.push(() => context.ui.dialogs.unregister(START_DIALOG_ID));

  context.ui.dialogs.register({
    id: RESULT_DIALOG_ID,
    component: RecordedMacroDialog,
    priority: 100,
  });
  cleanupFns.push(() => context.ui.dialogs.unregister(RESULT_DIALOG_ID));

  context.ui.dialogs.register({
    id: LIBRARY_DIALOG_ID,
    component: MacroLibraryDialog,
    priority: 100,
  });
  cleanupFns.push(() => context.ui.dialogs.unregister(LIBRARY_DIALOG_ID));

  // 2. Commands. Registered under the `macroRecorder.` prefix, which the
  //    session's ignore rule keys off — driving the recorder never records.
  context.commands.register(COMMANDS.START, () => {
    if (getRecorderSnapshot().status !== "idle") {
      // Returned, not fire-and-forget: a failed auto-save must reach whoever
      // pressed Ctrl+Shift+R or picked the menu item, not just the console.
      return finishRecording();
    }
    showDialog(START_DIALOG_ID);
    return undefined;
  });
  context.commands.register(COMMANDS.STOP, () => finishRecording());
  context.commands.register(COMMANDS.PAUSE, () => pauseRecording());
  context.commands.register(COMMANDS.RESUME, () => resumeRecording());
  // `abandonRecording`, not the bare `cancelRecording`: discarding must ALSO
  // drop the previous recording held for the review dialog, or a later "Discard"
  // leaves a stale result behind that the dialog would happily re-open.
  context.commands.register(COMMANDS.CANCEL, () => abandonRecording());
  context.commands.register(COMMANDS.LIBRARY, () => showDialog(LIBRARY_DIALOG_ID));
  cleanupFns.push(() => {
    for (const id of Object.values(COMMANDS)) context.commands.unregister(id);
  });

  // 3. Developer menu items. The menu itself belongs to ScriptNotebook (it took
  //    it over from the retired ScriptEditor), so items are contributed to it
  //    rather than re-registering the menu.
  context.ui.menus.registerItem("developer", {
    id: MENU_ITEMS.RECORD,
    label: recordMenuLabel(getRecorderSnapshot().status),
    commandId: COMMANDS.START,
    shortcut: "Ctrl+Shift+R",
    order: 10,
  });
  context.ui.menus.registerItem("developer", {
    id: MENU_ITEMS.LIBRARY,
    label: "Macros…",
    commandId: COMMANDS.LIBRARY,
    order: 11,
  });
  cleanupFns.push(() => {
    context.ui.menus.unregisterItem("developer", MENU_ITEMS.RECORD);
    context.ui.menus.unregisterItem("developer", MENU_ITEMS.LIBRARY);
  });

  // 3b. Keep the item honest. Every end path — Stop, Discard, an activation
  //     failure, a workbook swap — funnels through the recorder's snapshot, so
  //     subscribing to it (rather than patching the label at each call site) is
  //     what guarantees the menu and the status-bar indicator can never disagree.
  const syncRecordMenuItem = () => {
    context.ui.menus.updateItem("developer", MENU_ITEMS.RECORD, {
      label: recordMenuLabel(getRecorderSnapshot().status),
    });
  };
  cleanupFns.push(subscribeToRecorder(syncRecordMenuItem));

  // 4. The recording indicator. Always mounted; it renders nothing while idle.
  context.ui.statusBar.register({
    id: STATUS_BAR_ITEM_ID,
    component: RecordingIndicator,
    alignment: "right",
    priority: 90,
  });
  cleanupFns.push(() => context.ui.statusBar.unregister(STATUS_BAR_ITEM_ID));

  // 5. Track the selection so a generated button gets a sensible anchor cell.
  cleanupFns.push(ExtensionRegistry.onSelectionChange(setCurrentSelection));

  // 5b. The LINK mechanism. A button carrying a `macroRef` runs the CURRENT
  //     macro of that id through this seam on each click — so this registration
  //     is what makes a macro-linked button actually do anything. Registered
  //     here (not in Controls) because running a macro means loading the module
  //     and routing on its runtime marker, which is the recorder's knowledge,
  //     not Controls'.
  cleanupFns.push(registerMacroRunProvider({ runMacroByRef }));

  // 6. A recording cannot outlive the workbook it was taken in: its actions
  //    address sheets and cells that are about to be replaced, and the module it
  //    auto-saves into belongs to the OUTGOING workbook. So a swap ends the
  //    session — which stores what was captured while the store still exists,
  //    shows the source, and (because the indicator and the menu both derive
  //    from the session) leaves neither of them claiming a recording is live.
  for (const event of [
    AppEvents.BEFORE_OPEN,
    AppEvents.BEFORE_NEW,
    AppEvents.BEFORE_CLOSE,
  ]) {
    cleanupFns.push(
      onAppEvent(event, () => {
        if (getRecorderSnapshot().status === "idle") return;
        void finishRecording();
      }),
    );
  }

  // 7. Ctrl+Shift+R toggles record/stop — the gesture people expect, and the
  //    reason stopping never requires finding a menu.
  const onKeyDown = (e: KeyboardEvent) => {
    if (e.ctrlKey && e.shiftKey && (e.key === "R" || e.key === "r")) {
      e.preventDefault();
      void context.commands.execute(COMMANDS.START).catch((err) => {
        // A keyboard shortcut that fails silently is a shortcut the user will
        // press again, harder. Console output is not feedback.
        console.error("[MacroRecorder] Ctrl+Shift+R failed:", err);
        showToast(
          `Record Macro (Ctrl+Shift+R) failed: ${err instanceof Error ? err.message : String(err)}`,
          { type: "error" },
        );
      });
    }
  };
  window.addEventListener("keydown", onKeyDown, true);
  cleanupFns.push(() => window.removeEventListener("keydown", onKeyDown, true));

  isActivated = true;
  console.log("[MacroRecorder] Activated successfully.");
}

// ============================================================================
// Deactivation
// ============================================================================

function deactivate(): void {
  if (!isActivated) return;
  console.log("[MacroRecorder] Deactivating...");

  // Uninstall the observation hooks before anything else: leaving them behind
  // would keep every cell write flowing into a session nobody can stop.
  cancelRecording();

  for (const fn of cleanupFns) {
    try {
      fn();
    } catch (err) {
      console.error("[MacroRecorder] Cleanup error:", err);
    }
  }
  cleanupFns.length = 0;
  isActivated = false;
  console.log("[MacroRecorder] Deactivated.");
}

// ============================================================================
// Extension Module Export
// ============================================================================

const extension: ExtensionModule = {
  manifest: {
    id: "calcula.macro-recorder",
    name: "Macro Recorder",
    version: "1.0.0",
    description:
      "Record grid actions into a saved workbook module script — read it, edit it, run it, and bind it to a button.",
  },
  activate,
  deactivate,
};

export default extension;
