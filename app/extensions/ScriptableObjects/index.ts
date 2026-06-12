//! FILENAME: app/extensions/ScriptableObjects/index.ts
// PURPOSE: ScriptableObjects extension entry point.
// CONTEXT: Manages the lifecycle of all object scripts — loads them from the backend
//          on workbook open, mounts them, and persists changes back. Also registers
//          the "Edit Script" context menu and the Code Tab dialog.

import type { ExtensionModule, ExtensionContext } from "@api/contract";
import {
  AppEvents,
  DialogExtensions,
  ObjectScriptManager,
  resetObjectScriptManager,
  loadAllObjectScripts,
  saveObjectScript,
  deleteObjectScript,
  getScaffoldTemplate,
  showToast,
} from "@api";
import { listTemplates, stampFromTemplate, loadTemplate } from "./lib/templateManager";
import { loadConsents, recordConsent, isConsentCurrent } from "./lib/consentStore";
import { emitAppEvent, onAppEvent } from "@api/events";
import type { ObjectScriptDefinition, ScriptableObjectType } from "@api/scriptableObjects";
import React, { Suspense } from "react";
import ObjectScriptManagerPane from "./components/ObjectScriptManagerPane";
import ScriptConsentDialog from "./components/ScriptConsentDialog";
import TemplateManagerDialog from "./components/TemplateManagerDialog";
import ScriptMarketplace from "./components/ScriptMarketplace";
import type { DialogProps } from "@api/uiTypes";
import { openObjectScriptEditor } from "./lib/openObjectScriptWindow";
import {
  onSaveAndApply,
  onRegisterScript,
  onToggleAccess,
  onEditorClosed,
  emitConsoleOutput,
  emitScriptError,
  emitScriptsChanged,
} from "./lib/crossWindowEvents";

// Lazy-load CodeEditorDialog — Monaco has heavy module-level side effects
// that must not block extension activation.
const LazyCodeEditorDialog = React.lazy(() => import("./components/CodeEditorDialog"));
function CodeEditorDialog(props: DialogProps): React.ReactElement {
  return React.createElement(Suspense, { fallback: null },
    React.createElement(LazyCodeEditorDialog, props));
}

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

/** Track which packages have been consented to run scripts (this session). */
const consentedPackages = new Set<string>();

/**
 * Load, register, and mount all scripts. For distributed scripts,
 * check if the user has consented to run them — either in this session or
 * via a persisted consent in the workbook (keyed by script source hash, so
 * upstream script changes re-prompt).
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
    const persistedConsents = await loadConsents();

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

      // Hydrate session consent from the persisted record when the package's
      // current script sources still match what was consented to.
      if (!consentedPackages.has(pkg)) {
        try {
          if (await isConsentCurrent(persistedConsents, pkg, pkgScripts)) {
            consentedPackages.add(pkg);
          }
        } catch (e) {
          console.warn("[ScriptableObjects] Consent check failed:", e);
        }
      }

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
          scriptIds: pkgScripts.map((s) => s.id),
        });
      }
    }
  }

  emitAppEvent(ScriptableObjectEvents.SCRIPTS_LOADED, { count: scripts.length });
}

async function activate(context: ExtensionContext): Promise<void> {
  // ---- Consent dialog + listeners FIRST ----
  // loadAndMountScripts emits SCRIPT_CONSENT_NEEDED synchronously; if the
  // dialog/listeners register after the initial load, a workbook that
  // already contains distributed scripts at activation loses its consent
  // prompt for the whole session.
  context.ui.dialogs.register({
    id: "scriptable-objects.consent",
    title: "Script Security",
    component: ScriptConsentDialog,
    width: 460,
    height: 400,
  });
  cleanupFunctions.push(() => context.ui.dialogs.unregister("scriptable-objects.consent"));

  // Consent prompts are shown one at a time: dialog state is keyed by dialog
  // id, so showing a second package's prompt while one is open would
  // overwrite the first before React ever renders it.
  const consentQueue: Array<Record<string, unknown>> = [];
  let activeConsentPackage: string | null = null;

  const showNextConsent = (): void => {
    if (activeConsentPackage !== null) return;
    const next = consentQueue.shift();
    if (!next) return;
    activeConsentPackage = next.packageName as string;
    context.ui.dialogs.show("scriptable-objects.consent", next);
  };

  cleanupFunctions.push(
    onAppEvent(ScriptableObjectEvents.SCRIPT_CONSENT_NEEDED, (detail) => {
      const request = detail as Record<string, unknown>;
      const pkg = request.packageName as string;
      // De-dupe: this package is already being prompted or is queued
      if (activeConsentPackage === pkg || consentQueue.some((r) => r.packageName === pkg)) {
        return;
      }
      consentQueue.push(request);
      showNextConsent();
    }),
  );

  // Advance the queue when the consent dialog closes — covers Allow, Block,
  // and Escape (the dialog container closes on Escape without firing any
  // consent event, so the granted/denied handlers alone would stall the queue).
  cleanupFunctions.push(
    DialogExtensions.onChange(() => {
      if (activeConsentPackage === null) return;
      const stillOpen = DialogExtensions.getVisibleDialogs()
        .some((d) => d.definition.id === "scriptable-objects.consent");
      if (!stillOpen) {
        activeConsentPackage = null;
        showNextConsent();
      }
    }),
  );

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
      consentQueue.length = 0; // queued prompts belong to the previous workbook
      try {
        await loadAndMountScripts();
      } catch (e) {
        console.warn("[ScriptableObjects] Failed to reload object scripts:", e);
      }
    }),
  );

  // ---- Re-load scripts when a .calp pull materializes new ones ----
  // Without this, freshly pulled distributed scripts would not appear (or
  // prompt for consent) until the workbook is saved and reopened.
  cleanupFunctions.push(
    onAppEvent("calp:scripts-pulled", async () => {
      try {
        await loadAndMountScripts();
      } catch (e) {
        console.warn("[ScriptableObjects] Failed to load pulled scripts:", e);
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
      // Persist the consent in the workbook (durable once the file is saved),
      // keyed by source hash so changed scripts re-prompt.
      try {
        await recordConsent(
          packageName,
          scripts.map((s) => ({ id: s.id, source: s.source })),
        );
      } catch (e) {
        console.warn("[ScriptableObjects] Failed to persist consent:", e);
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

  // ---- Register the Code Tab dialog ----
  context.ui.dialogs.register({
    id: "scriptable-objects.code-editor",
    title: "Object Script Editor",
    component: CodeEditorDialog,
    width: 800,
    height: 600,
  });
  cleanupFunctions.push(() => context.ui.dialogs.unregister("scriptable-objects.code-editor"));

  // ---- Register the Template Manager dialog ----
  context.ui.dialogs.register({
    id: "scriptable-objects.template-manager",
    title: "Script Templates",
    component: TemplateManagerDialog,
    width: 600,
    height: 450,
  });
  cleanupFunctions.push(() => context.ui.dialogs.unregister("scriptable-objects.template-manager"));

  // ---- Register the Marketplace dialog ----
  context.ui.dialogs.register({
    id: "scriptable-objects.marketplace",
    title: "Script Marketplace",
    component: ScriptMarketplace,
    width: 550,
    height: 500,
  });
  cleanupFunctions.push(() => context.ui.dialogs.unregister("scriptable-objects.marketplace"));

  // ---- Register Developer menu items ----
  context.ui.menus.registerItem("developer", {
    id: "scriptable-objects.manage",
    label: "Object Scripts...",
    action: () => {
      openObjectScriptEditor();
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
    id: "scriptable-objects.manager",
    title: "Object Scripts",
    component: ObjectScriptManagerPane,
    icon: "code",
    contextKeys: ["always"],
    closable: true,
  });
  cleanupFunctions.push(() => context.ui.taskPanes.unregister("scriptable-objects.manager"));

  // ---- Cross-window event bridge: Object Script Editor separate window ----

  // Handle save-and-apply requests from the editor window
  onSaveAndApply(async (payload) => {
    const script = payload.script;
    ObjectScriptManager.registerScript(script);

    // Remount to apply changes
    if (ObjectScriptManager.isScriptMounted(script.id)) {
      ObjectScriptManager.unmountScript(script.id);
    }
    await ObjectScriptManager.mountScript(script.id);

    // Restore original source (the payload may contain instrumented source)
    // The editor window already persisted the original source to backend
    showToast("Script saved and applied.", { type: "success" });
  }).then((fn) => cleanupFunctions.push(fn));

  // Handle register-script requests from the editor window
  onRegisterScript((payload) => {
    ObjectScriptManager.registerScript(payload.script);
  }).then((fn) => cleanupFunctions.push(fn));

  // Handle toggle-access requests from the editor window
  onToggleAccess((payload) => {
    ObjectScriptManager.registerScript(payload.script);
  }).then((fn) => cleanupFunctions.push(fn));

  // Forward console output to the editor window
  cleanupFunctions.push(
    onAppEvent("objectscript:console", (detail) => {
      const d = detail as { scriptId: string; level: string; args: unknown[] };
      emitConsoleOutput({ scriptId: d.scriptId, level: d.level, args: d.args });
    }),
  );

  cleanupFunctions.push(
    onAppEvent("objectscript:error", (detail) => {
      const d = detail as { scriptId: string; scriptName: string; error: string; stack?: string };
      emitScriptError({ scriptId: d.scriptId, scriptName: d.scriptName, error: d.error, stack: d.stack });
    }),
  );

  // Notify editor window when scripts change externally
  cleanupFunctions.push(
    ObjectScriptManager.onScriptChange(() => {
      const scripts = ObjectScriptManager.getAllScripts();
      emitScriptsChanged(scripts);
    }),
  );

  // ---- Listen for edit-script requests (from context menus or property panels) ----
  cleanupFunctions.push(
    onAppEvent(ScriptableObjectEvents.EDIT_SCRIPT, async (detail) => {
      const { objectType, instanceId, objectName, scriptId } = detail as {
        objectType: ScriptableObjectType;
        instanceId?: string | null;
        objectName?: string;
        scriptId?: string;
      };

      // An explicit scriptId targets an existing script (e.g. inspecting a
      // package's distributed scripts from the consent prompt) — never scaffold.
      let script = scriptId
        ? (ObjectScriptManager.getAllScripts().find((s) => s.id === scriptId) ?? null)
        : ObjectScriptManager.getScript(objectType, instanceId);

      if (scriptId && !script) {
        console.warn(`[ScriptableObjects] Script not found: ${scriptId}`);
        return;
      }

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
        // Persist to backend before opening editor (so loadAllObjectScripts finds it)
        try {
          await saveObjectScript(script);
        } catch (e) {
          console.warn("[ScriptableObjects] Failed to save new script:", e);
        }
      }

      // Open the code editor in a separate window with this script
      await openObjectScriptEditor(script.id);

      // Re-emit scripts list so the editor window picks up any newly created scripts
      // (the SCRIPTS_CHANGED event from registerScript may have fired before the window existed)
      const allScripts = ObjectScriptManager.getAllScripts();
      emitScriptsChanged(allScripts);
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
        const d = detail as { id?: string; slicerId?: string; chartId?: string; pivotId?: string; name?: string };
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
