//! FILENAME: app/extensions/ControlsPane/index.ts
// PURPOSE: Controls pane extension entry point — activation and deactivation.
// CONTEXT: Owns both item families of the merged strip: ribbon filters
//          (filterPaneStore, unchanged) and pane controls (controlsPaneStore).
//          Registers the @api/controlValues provider (cross-extension
//          name->value enumeration) and the pane-control store service the
//          script host reads to seed pane-hosted custom-control scripts
//          (instanceId "pane-{controlId}", host.ts snapshot branch).

import type { ExtensionContext, ExtensionModule } from "@api/contract";
import { ExtensionRegistry } from "@api";
import { registerPanel, unregisterPanel } from "@api/ui";
import {
  registerControlValuesProvider,
  type ControlValue,
  type ControlValuesProvider,
} from "@api/controlValues";
import { registerPaneControlStoreService } from "@api/componentStoreRegistry";
import { ObjectScriptManager } from "@api/scriptableObjects";
import { deleteObjectScriptsForInstance } from "@api/objectScriptBackend";
import {
  ControlsPaneManifest,
  ControlsPanePanelDefinition,
  AddFilterDialogDefinition,
  AddControlDialogDefinition,
  CONTROLS_PANE_TAB_ID,
} from "./manifest";
import { refreshCache, clearCache } from "./lib/filterPaneStore";
import {
  refreshControlsCache,
  clearControlsCache,
  getAllControls,
  getControlById,
  buildNamedControlList,
} from "./lib/controlsPaneStore";
import { ControlsPaneEvents } from "./lib/controlsPaneEvents";
import { registerFilterBadge } from "./lib/filterBadge";
import { filterPaneBackend } from "./lib/filterPaneBackend";
import {
  ensureCustomControlWiring,
  disposeCustomControlWiring,
  seedCustomControlRuntime,
  getCustomControlProperties,
  removeCustomControlRuntime,
  paneControlInstanceId,
} from "./components/CustomControlHost";

let unregisterBadge: (() => void) | null = null;
let removeWindowListeners: (() => void) | null = null;

// ============================================================================
// Pane-control service surfaces
// ============================================================================

/** Seed the module-side script runtimes for every custom control so the
 *  script host's mount snapshot finds their persisted properties. */
function seedAllCustomRuntimes(): void {
  for (const control of getAllControls()) {
    if (control.controlType === "custom") {
      seedCustomControlRuntime(control);
    }
  }
}

/** Refresh the pane-control cache, then (re)seed custom-control runtimes. */
function refreshControls(): void {
  void refreshControlsCache().then(seedAllCustomRuntimes);
}

/** @api/controlValues provider: pane controls first, then ribbon filters —
 *  the GET.CONTROLVALUE snapshot precedence order (D9). */
const controlValuesProvider: ControlValuesProvider = {
  list: () => buildNamedControlList(),
  get: (name: string): ControlValue | undefined => {
    const upper = name.toUpperCase();
    return buildNamedControlList().find(
      (c) => c.name.toUpperCase() === upper,
    )?.value;
  },
};

// ============================================================================
// Extension Module
// ============================================================================

function activate(context: ExtensionContext): void {
  // Bind the capability-scoped backend door before any code can trigger a backend call.
  filterPaneBackend.set(context.invokeBackend);

  console.log("[ControlsPane Extension] Registering...");

  // Register add-in manifest
  ExtensionRegistry.registerAddIn({
    id: ControlsPaneManifest.id,
    name: ControlsPaneManifest.name,
    version: ControlsPaneManifest.version,
    description: ControlsPaneManifest.description,
  });

  // Register the permanent "Controls" panel (ribbon-placed by default)
  registerPanel(ControlsPanePanelDefinition);

  // Register dialogs
  context.ui.dialogs.register(AddFilterDialogDefinition);
  context.ui.dialogs.register(AddControlDialogDefinition);

  // Custom scripted controls: wire the shape:* render events + iframe bridge
  // once, module-wide, so the value convention (setProperty("value", ...))
  // works even while the pane is closed.
  ensureCustomControlWiring();

  // Cross-extension surfaces (IoC — unregistered with null on deactivate):
  // name->value enumeration for @api/controlValues consumers, and the
  // property snapshot the script host seeds pane-control scripts from.
  registerControlValuesProvider(controlValuesProvider);
  registerPaneControlStoreService({
    getProperties: (controlId: string): Record<string, string> | undefined => {
      const control = getControlById(controlId);
      if (!control || control.controlType !== "custom") return undefined;
      // Seed persisted config/value into the runtime first, so a script
      // mounting before its card ever rendered still sees its properties.
      seedCustomControlRuntime(control);
      return getCustomControlProperties(controlId);
    },
  });

  // Refresh caches on sheet change, and after undo/redo restores state (the
  // shell fans the ribbonFilter / paneControl mutation domains out as
  // "filterpane:filters-refreshed" / "controlspane:controls-refreshed").
  const handleFiltersRefresh = () => {
    refreshCache();
  };
  const handleControlsRefresh = () => {
    refreshControls();
  };
  const handleSheetActivated = () => {
    refreshCache();
    refreshControls();
  };
  // Deleting a control also unmounts + deletes its object scripts
  // (instanceId "pane-{id}", custom AND button controls) — on-grid parity
  // with Controls' deleteFloatingControl. Without this the worker keeps
  // running headless (it can still write cells), re-seeds the runtime maps
  // on every publish, and re-mounts on reload. Script deletion happens ONLY
  // here: workbook close / extension deactivate must never delete scripts.
  const handleControlDeleted = (e: Event) => {
    const detail = (e as CustomEvent<{ controlId?: string }>).detail;
    if (!detail?.controlId) return;
    const instanceId = paneControlInstanceId(detail.controlId);
    // Unmount + deregister first (removeScript unmounts a mounted script and
    // terminates its worker), THEN drop the runtime maps — otherwise a still-
    // running script could repopulate them via getOrCreateRuntime.
    for (const script of ObjectScriptManager.getAllScripts()) {
      if (script.instanceId === instanceId) {
        ObjectScriptManager.removeScript(script.id);
      }
    }
    removeCustomControlRuntime(detail.controlId);
    // Delete the persisted scripts so they don't re-mount on reload.
    void deleteObjectScriptsForInstance(instanceId).catch(() => {
      // Ignore — the control may never have had a script.
    });
  };
  window.addEventListener("sheet:activated", handleSheetActivated);
  window.addEventListener("filterpane:filters-refreshed", handleFiltersRefresh);
  window.addEventListener(
    "controlspane:controls-refreshed",
    handleControlsRefresh,
  );
  window.addEventListener(
    ControlsPaneEvents.CONTROL_DELETED,
    handleControlDeleted,
  );
  removeWindowListeners = () => {
    window.removeEventListener("sheet:activated", handleSheetActivated);
    window.removeEventListener(
      "filterpane:filters-refreshed",
      handleFiltersRefresh,
    );
    window.removeEventListener(
      "controlspane:controls-refreshed",
      handleControlsRefresh,
    );
    window.removeEventListener(
      ControlsPaneEvents.CONTROL_DELETED,
      handleControlDeleted,
    );
  };

  // Track applied filters and show count badge on the Controls tab
  unregisterBadge = registerFilterBadge();

  // Initial cache loads
  refreshCache();
  refreshControls();

  console.log("[ControlsPane Extension] Registered.");
}

function deactivate(): void {
  // NOTE: deactivate tears down wiring/caches ONLY — it must never unregister
  // or delete pane-control object scripts (they belong to the workbook; only
  // explicit control deletion via handleControlDeleted removes them).
  console.log("[ControlsPane Extension] Deactivating...");
  unregisterBadge?.();
  unregisterBadge = null;
  removeWindowListeners?.();
  removeWindowListeners = null;
  registerControlValuesProvider(null);
  registerPaneControlStoreService(null);
  disposeCustomControlWiring();
  unregisterPanel(CONTROLS_PANE_TAB_ID);
  clearCache();
  clearControlsCache();
}

const ControlsPaneExtension: ExtensionModule = {
  manifest: ControlsPaneManifest,
  activate,
  deactivate,
};

export default ControlsPaneExtension;
