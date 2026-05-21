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
  showToast,
} from "@api";
import { listTemplates, stampFromTemplate, loadTemplate } from "./lib/templateManager";
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
  /** Emitted when distributed scripts need user consent to run. */
  SCRIPT_CONSENT_NEEDED: "scriptable-objects:consent-needed",
} as const;

// ============================================================================
// Activation
// ============================================================================

/** Track which packages have been consented to run scripts. */
const consentedPackages = new Set<string>();

/**
 * Load, register, and mount all scripts. For distributed scripts,
 * check if the user has consented to run them.
 */
async function loadAndMountScripts(): Promise<void> {
  const scripts = await loadAllObjectScripts();
  const localScripts = scripts.filter((s) => !s.provenance || s.provenance === "local");
  const distributedScripts = scripts.filter((s) => s.provenance === "distributed");

  // Register and mount all local scripts immediately
  for (const script of localScripts) {
    ObjectScriptManager.registerScript(script);
  }
  for (const script of localScripts) {
    await ObjectScriptManager.mountScript(script.id);
  }

  // For distributed scripts, group by package and check consent
  if (distributedScripts.length > 0) {
    const byPackage = new Map<string, typeof distributedScripts>();
    for (const script of distributedScripts) {
      const pkg = script.packageName || "unknown";
      if (!byPackage.has(pkg)) byPackage.set(pkg, []);
      byPackage.get(pkg)!.push(script);
    }

    for (const [pkg, pkgScripts] of byPackage) {
      // Register all distributed scripts (so they appear in the UI)
      for (const script of pkgScripts) {
        ObjectScriptManager.registerScript(script);
      }

      // Only mount if user has consented (or auto-consent for this session)
      if (consentedPackages.has(pkg)) {
        for (const script of pkgScripts) {
          await ObjectScriptManager.mountScript(script.id);
        }
      } else {
        // Emit consent request event — the UI will show a prompt
        emitAppEvent(ScriptableObjectEvents.SCRIPT_CONSENT_NEEDED, {
          packageName: pkg,
          scriptCount: pkgScripts.length,
          scriptNames: pkgScripts.map((s) => s.name),
        });
      }
    }
  }

  emitAppEvent(ScriptableObjectEvents.SCRIPTS_LOADED, { count: scripts.length });
}

async function activate(context: ExtensionContext): Promise<void> {
  // ---- Load object scripts from backend on startup ----
  try {
    await loadAndMountScripts();
  } catch (e) {
    console.warn("[ScriptableObjects] Failed to load object scripts:", e);
  }

  // ---- Re-load scripts when a workbook is opened ----
  cleanupFunctions.push(
    onAppEvent(AppEvents.AFTER_OPEN, async () => {
      resetObjectScriptManager();
      consentedPackages.clear();
      try {
        await loadAndMountScripts();
      } catch (e) {
        console.warn("[ScriptableObjects] Failed to reload object scripts:", e);
      }
    }),
  );

  // ---- Handle consent responses ----
  cleanupFunctions.push(
    onAppEvent("scriptable-objects:consent-granted", async (detail) => {
      const { packageName } = detail as { packageName: string };
      consentedPackages.add(packageName);
      // Mount the distributed scripts for this package
      const scripts = ObjectScriptManager.getAllScripts()
        .filter((s) => s.provenance === "distributed" && s.packageName === packageName);
      for (const script of scripts) {
        if (!ObjectScriptManager.isScriptMounted(script.id)) {
          await ObjectScriptManager.mountScript(script.id);
        }
      }
      showToast(`Scripts from "${packageName}" enabled.`, { type: "success" });
    }),
  );

  cleanupFunctions.push(
    onAppEvent("scriptable-objects:consent-denied", (detail) => {
      const { packageName } = detail as { packageName: string };
      showToast(`Scripts from "${packageName}" blocked. Objects will use default behavior.`, { type: "info" });
    }),
  );

  // ---- Script-aware workbook close: warn if scripts have unsaved changes ----
  cleanupFunctions.push(
    onAppEvent(AppEvents.BEFORE_CLOSE, () => {
      // Check for any mounted scripts (they'll lose state on close)
      const allScripts = ObjectScriptManager.getAllScripts();
      const mountedCount = allScripts.filter((s) => ObjectScriptManager.isScriptMounted(s.id)).length;
      if (mountedCount > 0) {
        // Scripts are persisted in the workbook, so close is safe.
        // Unmount all running scripts cleanly before the workbook goes away.
        resetObjectScriptManager();
      }
    }),
  );
  cleanupFunctions.push(
    onAppEvent(AppEvents.AFTER_NEW, () => {
      resetObjectScriptManager();
    }),
  );

  // ---- Register consent dialog ----
  context.ui.dialogs.register({
    id: "scriptable-objects.consent",
    title: "Script Security",
    component: () => import("./components/ScriptConsentDialog"),
    width: 460,
    height: 400,
  });
  cleanupFunctions.push(() => context.ui.dialogs.unregister("scriptable-objects.consent"));

  // Show consent dialog when distributed scripts need approval
  cleanupFunctions.push(
    onAppEvent(ScriptableObjectEvents.SCRIPT_CONSENT_NEEDED, (detail) => {
      context.ui.dialogs.show("scriptable-objects.consent", detail as Record<string, unknown>);
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

  // ---- Register the Template Manager dialog ----
  context.ui.dialogs.register({
    id: "scriptable-objects.template-manager",
    title: "Script Templates",
    component: () => import("./components/TemplateManagerDialog"),
    width: 600,
    height: 450,
  });
  cleanupFunctions.push(() => context.ui.dialogs.unregister("scriptable-objects.template-manager"));

  // ---- Register the Marketplace dialog ----
  context.ui.dialogs.register({
    id: "scriptable-objects.marketplace",
    title: "Script Marketplace",
    component: () => import("./components/ScriptMarketplace"),
    width: 550,
    height: 500,
  });
  cleanupFunctions.push(() => context.ui.dialogs.unregister("scriptable-objects.marketplace"));

  // ---- Register Developer menu items ----
  context.ui.menus.registerItem("developer", {
    id: "scriptable-objects.manage",
    label: "Object Scripts...",
    action: () => {
      context.ui.dialogs.show("scriptable-objects.code-editor");
    },
  });
  context.ui.menus.registerItem("developer", {
    id: "scriptable-objects.templates",
    label: "Script Templates...",
    action: () => {
      context.ui.dialogs.show("scriptable-objects.template-manager");
    },
  });
  context.ui.menus.registerItem("developer", {
    id: "scriptable-objects.marketplace",
    label: "Script Marketplace...",
    action: () => {
      context.ui.dialogs.show("scriptable-objects.marketplace");
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

  // ---- Auto-mount on component creation ----
  // When a slicer, chart, or pivot is created, check if a matching template exists
  // and offer to apply it.
  const componentCreationEvents = [
    "slicer:created",
    "chart:created",
    "pivot:created",
  ];
  for (const eventName of componentCreationEvents) {
    cleanupFunctions.push(
      onAppEvent(eventName, async (detail) => {
        const d = detail as { id?: number; slicerId?: number; chartId?: number; pivotId?: number; name?: string };
        const instanceId = String(d.id ?? d.slicerId ?? d.chartId ?? d.pivotId ?? "");
        const objectType = eventName.split(":")[0] as ScriptableObjectType;
        const objectName = d.name || `${objectType} ${instanceId}`;

        // Check if there are any templates for this object type
        try {
          const templates = await listTemplates();
          const matching = templates.filter((t) => t.objectType === objectType);
          if (matching.length === 1) {
            // Single matching template — auto-apply
            const template = await loadTemplate(matching[0].id);
            if (template) {
              const stamped = stampFromTemplate(template, instanceId, objectName);
              ObjectScriptManager.registerScript(stamped);
              await saveObjectScript(stamped);
              await ObjectScriptManager.mountScript(stamped.id);
              showToast(`Applied template "${template.name}" to ${objectName}`, { type: "info" });
            }
          } else if (matching.length > 1) {
            // Multiple templates — notify the user they can edit the script
            showToast(`${matching.length} script templates available for ${objectType}s. Right-click to edit script.`, { type: "info" });
          }
        } catch {
          // Templates not loaded yet, skip
        }
      }),
    );
  }
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
