//! FILENAME: app/extensions/ScriptEditor/index.ts
// PURPOSE: Script Editor extension entry point.
// CONTEXT: Registers the task pane, Developer menu items, and cross-window event bridge.
//          Called from extensions/index.ts during app initialization.

import {
  registerTaskPane,
  unregisterTaskPane,
  registerMenu,
  openTaskPane,
  showTaskPaneContainer,
} from "../../src/api";
import { ScriptEditorPane } from "./components/ScriptEditorPane";
import { openAdvancedEditor } from "./lib/openEditorWindow";
import { onGridNeedsRefresh } from "./lib/crossWindowEvents";

// ============================================================================
// Constants
// ============================================================================

const SCRIPT_PANE_ID = "script-editor";

// ============================================================================
// Cleanup tracking
// ============================================================================

const cleanupFns: (() => void)[] = [];

// ============================================================================
// Registration
// ============================================================================

export function registerScriptEditorExtension(): void {
  console.log("[ScriptEditor] Registering...");

  // 1. Register task pane
  registerTaskPane({
    id: SCRIPT_PANE_ID,
    title: "Script Editor",
    component: ScriptEditorPane,
    contextKeys: ["always"],
    priority: 50,
    closable: true,
  });
  cleanupFns.push(() => unregisterTaskPane(SCRIPT_PANE_ID));

  // 2. Register Developer menu (simple + advanced editor)
  registerMenu({
    id: "developer",
    label: "Developer",
    order: 90,
    items: [
      {
        id: "developer:scriptEditor",
        label: "Script Editor",
        action: () => {
          openTaskPane(SCRIPT_PANE_ID);
          showTaskPaneContainer();
        },
      },
      {
        id: "developer:advancedScriptEditor",
        label: "Advanced Script Editor",
        action: () => {
          openAdvancedEditor("");
        },
      },
    ],
  });

  // 3. Listen for grid refresh requests from the Advanced Editor window.
  //    The Monaco editor window uses Tauri events (cross-window) instead of
  //    DOM CustomEvents. We bridge them here: Tauri event -> DOM event.
  let unlistenGridRefresh: (() => void) | undefined;
  onGridNeedsRefresh(() => {
    window.dispatchEvent(new CustomEvent("grid:refresh"));
  }).then((fn) => {
    unlistenGridRefresh = fn;
  });
  cleanupFns.push(() => {
    unlistenGridRefresh?.();
  });

  console.log("[ScriptEditor] Registered successfully.");
}

// ============================================================================
// Unregistration
// ============================================================================

export function unregisterScriptEditorExtension(): void {
  console.log("[ScriptEditor] Unregistering...");

  for (const fn of cleanupFns) {
    try {
      fn();
    } catch (err) {
      console.error("[ScriptEditor] Cleanup error:", err);
    }
  }
  cleanupFns.length = 0;

  console.log("[ScriptEditor] Unregistered.");
}
