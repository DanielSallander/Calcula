//! FILENAME: app/extensions/ScriptEditor/index.ts
// PURPOSE: Script Editor extension entry point.
// CONTEXT: Registers the task pane and Developer menu item.
//          Called from extensions/index.ts during app initialization.

import {
  registerTaskPane,
  unregisterTaskPane,
  registerMenu,
  openTaskPane,
  showTaskPaneContainer,
} from "../../src/api";
import { ScriptEditorPane } from "./components/ScriptEditorPane";

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

  // 2. Register Developer menu
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
    ],
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
