//! FILENAME: app/extensions/MacroRecorder/index.ts
// PURPOSE: Macro Recorder extension entry point — record what you do, read the
//          script it produces, edit it, and bind it to a button.
// CONTEXT: VBA's ecosystem was bootstrapped by record -> read -> edit, and this
//          is Calcula's on-ramp to its own (sandboxed, auditable) scripting.
//          A recorder shipped inside the ScriptEditor extension in Wave 4;
//          ScriptEditor was retired and took the recorder with it, leaving the
//          core-side hook with no caller. This is its home now — a normal
//          extension using only @api, exactly like a third party would write.

import type { ExtensionModule, ExtensionContext } from "@api/contract";
import { ExtensionRegistry } from "@api";
import { showDialog } from "@api/ui";
import { StartRecordingDialog } from "./components/StartRecordingDialog";
import { RecordedMacroDialog } from "./components/RecordedMacroDialog";
import { RecordingIndicator } from "./components/RecordingIndicator";
import {
  cancelRecording,
  getRecorderSnapshot,
  pauseRecording,
  resumeRecording,
} from "./lib/actionRecorder";
import { finishRecording, setCurrentSelection } from "./lib/flow";
import { bindBackend, unbindBackend } from "./lib/buttonScript";
import {
  COMMANDS,
  RESULT_DIALOG_ID,
  START_DIALOG_ID,
  STATUS_BAR_ITEM_ID,
} from "./lib/ids";

const cleanupFns: (() => void)[] = [];
let isActivated = false;

// ============================================================================
// Activation
// ============================================================================

function activate(context: ExtensionContext): void {
  if (isActivated) {
    console.warn("[MacroRecorder] Already activated, skipping.");
    return;
  }
  console.log("[MacroRecorder] Activating...");

  // The capability-scoped backend door, needed to create the button control
  // that "save as button script" binds to.
  bindBackend(context.invokeBackend.bind(context));
  cleanupFns.push(() => unbindBackend());

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

  // 2. Commands. Registered under the `macroRecorder.` prefix, which the
  //    session's ignore rule keys off — driving the recorder never records.
  context.commands.register(COMMANDS.START, () => {
    if (getRecorderSnapshot().status !== "idle") {
      finishRecording();
      return;
    }
    showDialog(START_DIALOG_ID);
  });
  context.commands.register(COMMANDS.STOP, () => finishRecording());
  context.commands.register(COMMANDS.PAUSE, () => pauseRecording());
  context.commands.register(COMMANDS.RESUME, () => resumeRecording());
  context.commands.register(COMMANDS.CANCEL, () => cancelRecording());
  cleanupFns.push(() => {
    for (const id of Object.values(COMMANDS)) context.commands.unregister(id);
  });

  // 3. Developer menu items. The menu itself belongs to ScriptNotebook (it took
  //    it over from the retired ScriptEditor), so items are contributed to it
  //    rather than re-registering the menu.
  context.ui.menus.registerItem("developer", {
    id: "developer:record-macro",
    label: "Record Macro…",
    commandId: COMMANDS.START,
    order: 10,
  });
  context.ui.menus.registerItem("developer", {
    id: "developer:stop-macro",
    label: "Stop Recording",
    commandId: COMMANDS.STOP,
    order: 11,
  });

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

  // 6. Ctrl+Shift+R toggles record/stop — the gesture people expect, and the
  //    reason stopping never requires finding a menu.
  const onKeyDown = (e: KeyboardEvent) => {
    if (e.ctrlKey && e.shiftKey && (e.key === "R" || e.key === "r")) {
      e.preventDefault();
      void context.commands.execute(COMMANDS.START);
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
      "Record grid actions and generate runnable Calcula script source — object script or notebook cell — and bind it to a button.",
  },
  activate,
  deactivate,
};

export default extension;
