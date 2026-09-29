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
import { AppEvents, onAppEvent } from "@api/events";
import { refuseUndoWhileAGestureLands } from "@api/objectGeometry";
import { ObjectScriptManager } from "@api/scriptableObjects";
import { deleteObjectScriptsForInstance } from "@api/objectScriptBackend";
import {
  ControlsPaneManifest,
  ControlsPanePanelDefinition,
  AddFilterDialogDefinition,
  AddControlDialogDefinition,
  CONTROLS_PANE_TAB_ID,
} from "./manifest";
import {
  refreshCache,
  clearCache,
  isRibbonFilterChangeLanding,
  refreshCacheAndReapplyChangedFilters,
} from "./lib/filterPaneStore";
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
  releaseAllPaneControlFrames,
  seedCustomControlRuntime,
  getCustomControlProperties,
  removeCustomControlRuntime,
  paneControlInstanceId,
} from "./components/CustomControlHost";

let unregisterBadge: (() => void) | null = null;
let releaseUndoRefusal: (() => void) | null = null;
let removeWindowListeners: (() => void) | null = null;
/** Unsubscribers for the @api event-bus listeners (the document lifecycle). */
let removeAppEventListeners: Array<() => void> = [];

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
    // Trim + uppercase both sides — the Rust GET.CONTROLVALUE key does the
    // same, so @Name and the formula surface resolve identically.
    const key = name.trim().toUpperCase();
    return buildNamedControlList().find(
      (c) => c.name.trim().toUpperCase() === key,
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

  // Refresh caches after undo/redo restores state (the shell fans the
  // ribbonFilter / paneControl mutation domains out as
  // "filterpane:filters-refreshed" / "controlspane:controls-refreshed").
  // An outside change to a ribbon filter (an undo, a declined change's
  // take-back, a pull) also RE-DERIVES the pivot masks of every ordinary
  // filter whose selection or targets it moved: a level-1 mask records no
  // undo of its own, so an undone change left its pivots masked with the
  // undone selection (BUG-0200). The reconcile records nothing.
  const handleFiltersRefresh = () => {
    void refreshCacheAndReapplyChangedFilters();
  };
  const handleControlsRefresh = () => {
    refreshControls();
  };
  // The SHEET COLLECTION or the active sheet changed (X13). A rename rewrites
  // every dropdown source naming the sheet ("Data!A1:A5" becomes
  // "'My Facts'!A1:A5", in the backend), and a delete turns one into #REF!;
  // the open pane kept the old text -- a sheet that no longer exists -- until
  // the workbook was reopened, because the only listener for this was a
  // "sheet:activated" window event nothing dispatches. SHEET_CHANGED is the
  // hook: the Shell fans the `sheets` mutation domain out as it (every sheet
  // route announces that domain -- the tauri-api wrappers, an MCP tool's
  // backend-initiated refresh, undo and redo), and it is also the plain
  // "the active sheet changed", which a source with no sheet prefix (it reads
  // the ACTIVE sheet) needs as well. Ribbon filters name no sheet by NAME,
  // and a delete or move already announces their own domain.
  const handleSheetChanged = () => {
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
  // The DOCUMENT changed under us (File > New / File > Open, and the .calp
  // checkout that goes through the same announcement). Pane controls belong to
  // the workbook, and so does everything their scripts built: the html a card
  // renders, the properties it declares, and the live-frame budget slot its
  // iframe holds. None of that left with the document — this extension had no
  // document listener at all, and its only other refresh triggers were the
  // mutation-domain fan-out and a "sheet:activated" event nothing dispatches.
  //
  // The budget is the half that bites silently. It is ONE cap of 24 shared with
  // the on-grid shape host and it is per SESSION, so charges the pane never hands
  // back are slots no later workbook gets: a card is unmounted by React when its
  // control disappears, and File > Open unmounted nothing, so the previous
  // workbook's tiles kept their frames — and their charges — for the rest of the
  // session while the next workbook's shapes were refused with "this workbook
  // already has 24".
  //
  // The refresh is the other half and has to run WITH the release, not instead of
  // it: releasing the frames while the pane still lists the departed workbook's
  // controls would leave a strip of permanently empty cards, and refreshing
  // without releasing would leave a card whose id the new document happens to
  // reuse showing the OLD workbook's html. The scripts themselves are re-mounted
  // by ScriptableObjects on this same event, so a control that survives the swap
  // re-declares its html and paints again.
  const handleDocumentReplaced = () => {
    releaseAllPaneControlFrames();
    refreshCache();
    refreshControls();
  };
  for (const evt of [AppEvents.AFTER_OPEN, AppEvents.AFTER_NEW] as const) {
    removeAppEventListeners.push(onAppEvent(evt, handleDocumentReplaced));
  }

  removeAppEventListeners.push(onAppEvent(AppEvents.SHEET_CHANGED, handleSheetChanged));
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

  // A keyboard Ctrl+Z / Ctrl+Y while a ribbon filter change lands is refused
  // with a sentence (the backend refuses it silently): @api/objectGeometry.
  releaseUndoRefusal = refuseUndoWhileAGestureLands(isRibbonFilterChangeLanding);

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
  releaseUndoRefusal?.();
  releaseUndoRefusal = null;
  removeWindowListeners?.();
  removeWindowListeners = null;
  for (const off of removeAppEventListeners) off();
  removeAppEventListeners = [];
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
