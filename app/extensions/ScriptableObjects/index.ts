//! FILENAME: app/extensions/ScriptableObjects/index.ts
// PURPOSE: ScriptableObjects extension entry point.
// CONTEXT: Manages the lifecycle of all object scripts — loads them from the backend
//          on workbook open, mounts them, and persists changes back. Also registers
//          the "Edit Script" context menu and the Code Tab dialog.

import type { ExtensionModule, ExtensionContext } from "@api/contract";
import {
  AppEvents,
  ObjectScriptManager,
  resetObjectScriptManager,
  loadAllObjectScripts,
  saveObjectScript,
  deleteObjectScript,
  getScaffoldTemplate,
} from "@api";
import { emitAppEvent, onAppEvent } from "@api/events";
import type { ObjectScriptDefinition, ScriptableObjectType } from "@api/scriptableObjects";

// ============================================================================
// Manifest
// ============================================================================

const manifest = {
  id: "calcula.scriptable-objects",
  name: "Scriptable Objects",
  version: "1.0.0",
  description: "Enables user-scriptable objects with per-type lifecycle hooks and Monaco editor integration.",
};

// ============================================================================
// Module State
// ============================================================================

const cleanupFunctions: Array<() => void> = [];

// ============================================================================
// Custom Events
// ============================================================================

export const ScriptableObjectEvents = {
  /** Emitted when an object script is opened for editing. */
  EDIT_SCRIPT: "scriptable-objects:edit-script",
  /** Emitted when scripts have been loaded/reloaded. */
  SCRIPTS_LOADED: "scriptable-objects:scripts-loaded",
  /** Emitted when a script is saved. */
  SCRIPT_SAVED: "scriptable-objects:script-saved",
} as const;

// ============================================================================
// Activation
// ============================================================================

async function activate(context: ExtensionContext): Promise<void> {
  // ---- Load object scripts from backend on startup ----
  try {
    const scripts = await loadAllObjectScripts();
    for (const script of scripts) {
      ObjectScriptManager.registerScript(script);
    }
    // Mount all scripts
    for (const script of scripts) {
      await ObjectScriptManager.mountScript(script.id);
    }
    emitAppEvent(ScriptableObjectEvents.SCRIPTS_LOADED, { count: scripts.length });
  } catch (e) {
    console.warn("[ScriptableObjects] Failed to load object scripts:", e);
  }

  // ---- Re-load scripts when a workbook is opened ----
  cleanupFunctions.push(
    onAppEvent(AppEvents.AFTER_OPEN, async () => {
      resetObjectScriptManager();
      try {
        const scripts = await loadAllObjectScripts();
        for (const script of scripts) {
          ObjectScriptManager.registerScript(script);
        }
        for (const script of scripts) {
          await ObjectScriptManager.mountScript(script.id);
        }
        emitAppEvent(ScriptableObjectEvents.SCRIPTS_LOADED, { count: scripts.length });
      } catch (e) {
        console.warn("[ScriptableObjects] Failed to reload object scripts:", e);
      }
    }),
  );

  // ---- Clear scripts on workbook close / new ----
  cleanupFunctions.push(
    onAppEvent(AppEvents.BEFORE_CLOSE, () => {
      resetObjectScriptManager();
    }),
  );
  cleanupFunctions.push(
    onAppEvent(AppEvents.AFTER_NEW, () => {
      resetObjectScriptManager();
    }),
  );

  // ---- Register the Code Tab dialog ----
  context.ui.dialogs.register({
    id: "scriptable-objects.code-editor",
    title: "Object Script Editor",
    component: () => import("./components/CodeEditorDialog"),
    width: 800,
    height: 600,
  });
  cleanupFunctions.push(() => context.ui.dialogs.unregister("scriptable-objects.code-editor"));

  // ---- Register Developer menu items ----
  context.ui.menus.registerItem("developer", {
    id: "scriptable-objects.manage",
    label: "Object Scripts...",
    action: () => {
      context.ui.dialogs.show("scriptable-objects.code-editor");
    },
  });

  // ---- Register task pane for script management ----
  context.ui.taskPanes.register({
    viewId: "scriptable-objects.manager",
    title: "Object Scripts",
    component: () => import("./components/ObjectScriptManagerPane"),
    icon: "code",
  });
  cleanupFunctions.push(() => context.ui.taskPanes.unregister("scriptable-objects.manager"));

  // ---- Listen for edit-script requests (from context menus or property panels) ----
  cleanupFunctions.push(
    onAppEvent(ScriptableObjectEvents.EDIT_SCRIPT, (detail) => {
      const { objectType, instanceId, objectName } = detail as {
        objectType: ScriptableObjectType;
        instanceId?: string | null;
        objectName?: string;
      };

      // Check if a script exists for this object
      let script = ObjectScriptManager.getScript(objectType, instanceId);

      if (!script) {
        // Create a new script with the scaffold template
        const id = crypto.randomUUID();
        const name = objectName || `${objectType} Script`;
        script = {
          id,
          name,
          objectType,
          instanceId: instanceId || null,
          source: getScaffoldTemplate(objectType, objectName),
          accessLevel: "restricted",
        };
        ObjectScriptManager.registerScript(script);
        // Persist to backend
        saveObjectScript(script).catch((e) => {
          console.warn("[ScriptableObjects] Failed to save new script:", e);
        });
      }

      // Open the code editor dialog with this script
      context.ui.dialogs.show("scriptable-objects.code-editor", {
        scriptId: script.id,
        objectType,
        instanceId,
      });
    }),
  );

  // ---- Auto-persist script changes ----
  cleanupFunctions.push(
    onAppEvent(AppEvents.BEFORE_SAVE, () => {
      // All scripts are already persisted on save via the persistence layer
      // (AppState.object_scripts is written to the .cala file)
    }),
  );
}

// ============================================================================
// Deactivation
// ============================================================================

function deactivate(): void {
  // Unmount all scripts
  resetObjectScriptManager();

  // Clean up all registrations
  for (let i = cleanupFunctions.length - 1; i >= 0; i--) {
    try {
      cleanupFunctions[i]();
    } catch (error) {
      console.error("[ScriptableObjects] Cleanup error:", error);
    }
  }
  cleanupFunctions.length = 0;
}

// ============================================================================
// Export
// ============================================================================

const extension: ExtensionModule = {
  manifest,
  activate,
  deactivate,
};

export default extension;
