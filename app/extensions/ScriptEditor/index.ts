//! FILENAME: app/extensions/ScriptEditor/index.ts
// PURPOSE: Script Editor extension entry point. ExtensionModule lifecycle pattern.
// CONTEXT: Registers the task pane, Developer menu items, and cross-window event bridge.

import type { ExtensionModule, ExtensionContext } from "@api/contract";
import { scrollToCell, setSelection } from "@api/grid";
import { dispatchGridAction } from "@api/gridDispatch";
import { ScriptEditorPane } from "./components/ScriptEditorPane";
import { openAdvancedEditor } from "./lib/openEditorWindow";
import { onGridNeedsRefresh, onDeferredActions } from "./lib/crossWindowEvents";
import type { DeferredAction } from "./types";

// ============================================================================
// Constants
// ============================================================================

const SCRIPT_PANE_ID = "script-editor";

// ============================================================================
// State
// ============================================================================

let isActivated = false;
const cleanupFns: (() => void)[] = [];

// ============================================================================
// Lifecycle
// ============================================================================

function activate(context: ExtensionContext): void {
  if (isActivated) {
    console.warn("[ScriptEditor] Already activated, skipping.");
    return;
  }

  console.log("[ScriptEditor] Activating...");

  // 1. Register task pane
  context.ui.taskPanes.register({
    id: SCRIPT_PANE_ID,
    title: "Script Editor",
    component: ScriptEditorPane,
    contextKeys: ["always"],
    priority: 50,
    closable: true,
  });
  cleanupFns.push(() => context.ui.taskPanes.unregister(SCRIPT_PANE_ID));

  // 2. Register Developer menu (simple + advanced editor)
  context.ui.menus.register({
    id: "developer",
    label: "Developer",
    order: 90,
    items: [
      {
        id: "developer:scriptEditor",
        label: "Script Editor",
        action: () => {
          context.ui.taskPanes.open(SCRIPT_PANE_ID);
          context.ui.taskPanes.showContainer();
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

  // 3. Listen for deferred actions from Application object (goto, calculate, statusBar)
  const handleDeferredActions = (e: Event) => {
    const actions = (e as CustomEvent).detail as DeferredAction[];
    if (!Array.isArray(actions)) return;
    for (const action of actions) {
      switch (action.action) {
        case "goto":
          dispatchGridAction(setSelection(action.row, action.col, action.row, action.col));
          dispatchGridAction(scrollToCell(action.row, action.col, false));
          break;
        case "calculate":
          // Trigger a full grid data re-fetch (equivalent to recalculation)
          window.dispatchEvent(new CustomEvent("grid:refresh"));
          break;
        case "setStatusBar":
          // Dispatch status bar update (extensions can listen via statusBar API)
          window.dispatchEvent(
            new CustomEvent("script:status-bar", { detail: action.message })
          );
          break;
      }
    }
  };
  window.addEventListener("script:deferred-actions", handleDeferredActions);
  cleanupFns.push(() => window.removeEventListener("script:deferred-actions", handleDeferredActions));

  // 4. Listen for grid refresh requests from the Advanced Editor window.
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

  // 5. Listen for deferred actions from the Advanced Editor window (cross-window).
  let unlistenDeferredActions: (() => void) | undefined;
  onDeferredActions((payload) => {
    if (Array.isArray(payload.actions)) {
      window.dispatchEvent(
        new CustomEvent("script:deferred-actions", { detail: payload.actions })
      );
    }
  }).then((fn) => {
    unlistenDeferredActions = fn;
  });
  cleanupFns.push(() => {
    unlistenDeferredActions?.();
  });

  isActivated = true;
  console.log("[ScriptEditor] Activated successfully.");
}

function deactivate(): void {
  if (!isActivated) return;

  console.log("[ScriptEditor] Deactivating...");

  for (const fn of cleanupFns) {
    try {
      fn();
    } catch (err) {
      console.error("[ScriptEditor] Cleanup error:", err);
    }
  }
  cleanupFns.length = 0;

  isActivated = false;
  console.log("[ScriptEditor] Deactivated.");
}

// ============================================================================
// Extension Module Export
// ============================================================================

const extension: ExtensionModule = {
  manifest: {
    id: "calcula.script-editor",
    name: "Script Editor",
    version: "1.0.0",
    description: "In-app script editor and advanced Monaco editor for TypeScript scripting.",
  },
  activate,
  deactivate,
};

export default extension;
