//! FILENAME: app/extensions/ScriptableObjects/index.ts
// PURPOSE: ScriptableObjects extension entry point.
// CONTEXT: Manages the lifecycle of all object scripts — loads them from the backend
//          on workbook open, mounts them, and persists changes back. Also registers
//          the "Edit Script" context menu and the Code Tab dialog.

import type { ExtensionModule, ExtensionContext } from "@api/contract";
import { ensureScriptsAllowed } from "@api/scriptSecurity";
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
  resolveCapabilityRequest,
  parseDeclaredCapabilities,
  applyConsentedCapabilities,
  IconScript,
  IconTemplate,
  IconMarketplace,
} from "@api";
import type { CapabilityRequestPayload, CapabilityDecision, CapabilityId } from "@api";
import { listTemplates, stampFromTemplate, loadTemplate } from "./lib/templateManager";
import { loadConsents, recordConsent, isConsentCurrent, getChangedScripts } from "./lib/consentStore";
import type { CapabilityGrant } from "./lib/consentStore";
import { emitAppEvent, onAppEvent } from "@api/events";
import type { ObjectScriptDefinition, ScriptableObjectType } from "@api/scriptableObjects";
import React, { Suspense } from "react";
import ObjectScriptManagerPane from "./components/ObjectScriptManagerPane";
import {
  MountedScriptsSection,
  PolicyTableSection,
  ActivitySection,
} from "./components/PermissionsPanel";
import { CodeInThisFileSection } from "./components/CodeInThisFilePanel";
import ScriptConsentDialog from "./components/ScriptConsentDialog";
import CapabilityRequestDialog from "./components/CapabilityRequestDialog";
import TemplateManagerDialog from "./components/TemplateManagerDialog";
import ScriptMarketplace from "./components/ScriptMarketplace";
import type { DialogProps } from "@api/uiTypes";
import { openObjectScriptEditor } from "./lib/openObjectScriptWindow";
import { registerCellBehaviorUx } from "./lib/cellBehaviorUx";
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
// Script Permissions panel (transparency surface)
// ============================================================================

const PERMISSIONS_PANEL_ID = "scriptable-objects.permissions";
const CODE_IN_FILE_PANEL_ID = "scriptable-objects.codeInThisFile";

/** SVG shield icon for the Script Permissions panel */
const ShieldIcon = React.createElement(
  "svg",
  {
    width: 24,
    height: 24,
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: 1.5,
    strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const,
  },
  // Shield outline
  React.createElement("path", {
    d: "M12 3 L19 6 V11 C19 15.5 16 19.5 12 21 C8 19.5 5 15.5 5 11 V6 Z",
  }),
  // Checkmark
  React.createElement("path", { d: "M9 11.5 L11.2 13.7 L15 9.5" }),
);

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

/** Short, user-facing phrase per capability for the consent prompt. */
const CAPABILITY_DESCRIPTION: Record<CapabilityId, string> = {
  "net.fetch": "Fetch data from the web (https only, no cookies)",
  "bi.query": "Run read-only, model-scoped queries on this workbook's BI connections",
  "bi.sql": "Run read-only RAW SQL against this workbook's BI database (any reachable table)",
  storage: "Store script-private data in this workbook",
  "ui.html": "Render sandboxed HTML inside its object",
  "formula.udf": "Evaluate its functions in worksheet formulas",
  "bi.model": "Modify this workbook's BI model definitions (measures, relationships, ... — undoable; never security roles or connections)",
  "bi.connector": "Feed external data into this workbook's BI model as a data connector",
};

/** Shape of one requested capability in the consent-needed event payload. */
interface RequestedCapability {
  capability: CapabilityId;
  description: string;
  origins: string[];
}

/**
 * The union of capabilities DECLARED across a package's scripts (each script's
 * `// @capability` pragmas). Returns both the rich list for the consent prompt
 * and the CapabilityGrant[] persisted as the package's consent.
 */
function computePackageCapabilities(
  scripts: Array<{ source: string }>,
): { requested: RequestedCapability[]; granted: CapabilityGrant[] } {
  const originsByCap = new Map<CapabilityId, Set<string>>();
  for (const script of scripts) {
    const declared = parseDeclaredCapabilities(script.source);
    for (const cap of declared.caps) {
      if (!originsByCap.has(cap)) originsByCap.set(cap, new Set());
    }
    // Origins only attach to net.fetch (parse already filtered to https origins).
    if (declared.origins.length > 0) {
      const set = originsByCap.get("net.fetch") ?? new Set<string>();
      for (const o of declared.origins) set.add(o);
      originsByCap.set("net.fetch", set);
    }
  }

  const requested: RequestedCapability[] = [];
  const granted: CapabilityGrant[] = [];
  for (const [capability, origins] of originsByCap) {
    const originList = [...origins];
    requested.push({
      capability,
      description: CAPABILITY_DESCRIPTION[capability] ?? capability,
      origins: originList,
    });
    granted.push(
      originList.length > 0 ? { capability, origins: originList } : { capability },
    );
  }
  return { requested, granted };
}

/**
 * Load, register, and mount all scripts. For distributed scripts,
 * check if the user has consented to run them — either in this session or
 * via a persisted consent in the workbook (keyed by script source hash, so
 * upstream script changes re-prompt).
 */
async function loadAndMountScripts(): Promise<void> {
  // Honor the global Script Security setting: object scripts (button/shape/
  // slicer behaviors) are user-authored code, so a "disabled" — or an
  // unconfirmed "prompt" — setting must keep them inert. This is the primary
  // automation surface; it previously consulted nothing.
  const allowed = await ensureScriptsAllowed(
    "This workbook contains object scripts (e.g. button and shape behaviors). Allow them to run?",
  );
  if (!allowed) {
    return;
  }

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
        // Hydrate path: consent == "all declared" in 4.2a, so re-derive each
        // script's declared caps/origins from its own source and GRANT them
        // into the live set BEFORE mounting, so buildHandleFromDefinition sees
        // them when it builds the handle.
        for (const script of pkgScripts) {
          const declared = parseDeclaredCapabilities(script.source);
          await applyConsentedCapabilities(script.id, declared.caps, declared.origins);
          await ObjectScriptManager.mountScript(script.id);
        }
      } else {
        // Emit consent request event — the UI will show a prompt. Include the
        // union of capabilities the package's scripts declare, plus any scripts
        // whose source CHANGED since last consent (T3) so the prompt can diff
        // old→new instead of asking for a blind re-approval.
        const { requested } = computePackageCapabilities(pkgScripts);
        const changed = await getChangedScripts(persistedConsents, pkg, pkgScripts);
        const changedScripts = changed.map((c) => ({
          id: c.id,
          name: pkgScripts.find((s) => s.id === c.id)?.name ?? c.id,
          oldSource: c.oldSource,
          newSource: c.newSource,
        }));
        emitAppEvent(ScriptableObjectEvents.SCRIPT_CONSENT_NEEDED, {
          packageName: pkg,
          scriptCount: pkgScripts.length,
          scriptNames: pkgScripts.map((s) => s.name),
          scriptIds: pkgScripts.map((s) => s.id),
          requestedCapabilities: requested,
          changedScripts,
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

  // ---- JIT capability-grant dialog + listeners ----
  // When a LOCAL script first calls an ungranted capability, the host emits
  // "scriptable-objects:capability-request" and AWAITS the user's decision via
  // resolveCapabilityRequest(requestId, decision). The dialog (Task 1) signals
  // the choice back through "scriptable-objects:capability-decided"; any close
  // WITHOUT a decision (Escape / overlay / dismiss) must fail closed = "deny".
  const CAPABILITY_DIALOG_ID = "scriptable-objects.capability";
  context.ui.dialogs.register({
    id: CAPABILITY_DIALOG_ID,
    title: "Permission request",
    component: CapabilityRequestDialog,
    width: 460,
    height: 340,
  });
  cleanupFunctions.push(() => context.ui.dialogs.unregister(CAPABILITY_DIALOG_ID));

  // One-at-a-time queue: dialog state is keyed by dialog id, so showing a
  // second request while one is open would overwrite the first.
  const capabilityQueue: CapabilityRequestPayload[] = [];
  let activeCapabilityRequest: CapabilityRequestPayload | null = null;
  // Tracks whether the active request was answered with an explicit decision.
  // When the dialog closes and this is still false (Escape/overlay/dismiss),
  // the request is resolved "deny".
  let activeCapabilityDecided = false;

  const showNextCapability = (): void => {
    if (activeCapabilityRequest !== null) return;
    const next = capabilityQueue.shift();
    if (!next) return;
    activeCapabilityRequest = next;
    activeCapabilityDecided = false;
    context.ui.dialogs.show(CAPABILITY_DIALOG_ID, next as unknown as Record<string, unknown>);
  };

  cleanupFunctions.push(
    onAppEvent("scriptable-objects:capability-request", (detail) => {
      const request = detail as CapabilityRequestPayload;
      // De-dupe by requestId: each request is unique, but guard re-emits.
      if (
        activeCapabilityRequest?.requestId === request.requestId ||
        capabilityQueue.some((r) => r.requestId === request.requestId)
      ) {
        return;
      }
      capabilityQueue.push(request);
      showNextCapability();
    }),
  );

  // The dialog emits the user's choice; record it and resolve the host request.
  cleanupFunctions.push(
    onAppEvent("scriptable-objects:capability-decided", (detail) => {
      const { requestId, decision } = detail as {
        requestId: string;
        decision: CapabilityDecision;
      };
      if (activeCapabilityRequest?.requestId === requestId) {
        activeCapabilityDecided = true;
      }
      resolveCapabilityRequest(requestId, decision);
    }),
  );

  // Advance the queue when the capability dialog closes — covers Allow once,
  // Allow always, Deny, and Escape. If the dialog closed without a decision
  // (Escape/overlay/dismiss), fail closed by resolving "deny".
  cleanupFunctions.push(
    DialogExtensions.onChange(() => {
      if (activeCapabilityRequest === null) return;
      const stillOpen = DialogExtensions.getVisibleDialogs()
        .some((d) => d.definition.id === CAPABILITY_DIALOG_ID);
      if (!stillOpen) {
        const closed = activeCapabilityRequest;
        const decided = activeCapabilityDecided;
        activeCapabilityRequest = null;
        activeCapabilityDecided = false;
        if (!decided) {
          // No explicit answer — dismissed prompts fail closed.
          resolveCapabilityRequest(closed.requestId, "deny");
        }
        showNextCapability();
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
      capabilityQueue.length = 0; // pending JIT prompts belong to the previous workbook
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
      // Mount the distributed scripts for this package. Allowing grants ALL
      // declared capabilities (4.2a). For each script, GRANT its declared
      // caps/origins into the live set BEFORE mounting it, so the broker's
      // handle (built at mount) already carries the consented grants.
      const scripts = ObjectScriptManager.getAllScripts()
        .filter((s) => s.provenance === "distributed" && s.packageName === packageName);
      for (const script of scripts) {
        if (!ObjectScriptManager.isScriptMounted(script.id)) {
          const declared = parseDeclaredCapabilities(script.source);
          await applyConsentedCapabilities(script.id, declared.caps, declared.origins);
          await ObjectScriptManager.mountScript(script.id);
        }
      }
      // Persist the consent in the workbook (durable once the file is saved),
      // keyed by source hash + the granted capability union so changed scripts
      // OR a capability expansion re-prompt.
      try {
        const { granted } = computePackageCapabilities(scripts);
        await recordConsent(
          packageName,
          scripts.map((s) => ({ id: s.id, source: s.source })),
          granted,
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
    icon: IconScript,
    action: () => {
      openObjectScriptEditor();
    },
  });
  context.ui.menus.registerItem("developer", {
    id: "scriptable-objects.templates",
    label: "Script Templates...",
    icon: IconTemplate,
    action: () => {
      context.ui.dialogs.show("scriptable-objects.template-manager");
    },
  });
  context.ui.menus.registerItem("developer", {
    id: "scriptable-objects.marketplace",
    label: "Script Marketplace...",
    icon: IconMarketplace,
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

  // ---- Register the Script Permissions transparency panel ----
  // Sections-based panel API (design §8): mounted scripts, the tier/method
  // policy table rendered directly from ALLOWLIST, and the broker audit tail.
  context.ui.panels.register({
    id: PERMISSIONS_PANEL_ID,
    title: "Script Permissions",
    icon: ShieldIcon,
    sections: [
      {
        id: `${PERMISSIONS_PANEL_ID}.mounted`,
        label: "Mounted scripts",
        component: MountedScriptsSection,
      },
      {
        id: `${PERMISSIONS_PANEL_ID}.policy`,
        label: "What scripts can do",
        component: PolicyTableSection,
      },
      {
        id: `${PERMISSIONS_PANEL_ID}.activity`,
        label: "Activity",
        component: ActivitySection,
      },
    ],
    defaultPlacement: "sidebar",
    priority: 8,
  });
  cleanupFunctions.push(() => context.ui.panels.unregister(PERMISSIONS_PANEL_ID));

  // ---- Register the "Code in This File" transparency inspector (T1) ----
  // A per-workbook inventory of EVERY code unit (object scripts, module scripts,
  // notebooks): where it resides, where it came from, what it can touch, and its
  // source inline. Complements the (runtime-focused) Script Permissions panel by
  // answering the vision's question about the FILE rather than the live session.
  context.ui.panels.register({
    id: CODE_IN_FILE_PANEL_ID,
    title: "Code in This File",
    // Use the "script/code" icon here (a page with code brackets) so the file
    // code-inventory panel is visually distinct from the runtime Script
    // Permissions panel, which keeps the shield-with-checkmark security icon.
    icon: IconScript,
    sections: [
      {
        id: `${CODE_IN_FILE_PANEL_ID}.inventory`,
        label: "Code in This File",
        component: CodeInThisFileSection,
      },
    ],
    defaultPlacement: "sidebar",
    priority: 9,
  });
  cleanupFunctions.push(() => context.ui.panels.unregister(CODE_IN_FILE_PANEL_ID));

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

  // ---- Cell-behavior bindings (granular bricks phase 2) ----
  // Context-menu attach/edit/remove for per-range behavior scripts + the
  // design-mode cell badge. The binding store lives in @api/cellBehaviors.
  cleanupFunctions.push(registerCellBehaviorUx(context));

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
