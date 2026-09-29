//! FILENAME: app/extensions/Controls/index.ts
// PURPOSE: Controls extension entry point (ExtensionModule pattern).
//          Registers Button control, Design Mode, and Properties Pane.
//          Supports both embedded (cell) and floating button modes.
// NOTE: Default exports an ExtensionModule object per the contract.

import type { ExtensionModule, ExtensionContext } from "@api/contract";
import type { DeclaredProperty } from "@api/scriptableObjects";
import {
  ExtensionRegistry,
  AppEvents,
  runWorkbookScript,
  IconControls,
  IconButton,
  IconShapes,
  IconImage,
  IconDesignMode,
  isKeyClaimed,
} from "@api";
import { CommandRegistry } from "@api/commands";
import { registerKeybinding, isGridFocused } from "@api/keybindings";
import { registerControlsProvider } from "@api/controlsService";
import type { ControlPropertyValue } from "./lib/types";
import type {
  CreateShapeControlRequest,
  ShapeCatalogEntry,
  ShapeControlHandle,
} from "@api/controlsService";
import {
  registerButtonControlProvider,
  MACRO_REF_PROPERTY,
} from "@api/buttonControlService";
import type {
  ButtonControlAnchor,
  ButtonControlHandle,
  CreateButtonControlRequest,
} from "@api/buttonControlService";
import {
  requireMacroRunProvider,
  hasMacroRunProvider,
} from "@api/macroRunService";
import { getActiveSheet } from "@api/lib";
import { getGridStateSnapshot } from "@api/grid";
import {
  getColumnWidth as getColumnWidthSync,
  getRowHeight as getRowHeightSync,
} from "@api/dimensions";
import { emitAppEvent, onAppEvent } from "@api/events";
import { showToast } from "@api/notifications";
import type { OverlayRenderContext } from "@api/gridOverlays";
import {
  getGridRegions,
  overlayGetRowHeaderWidth,
  overlayGetColHeaderHeight,
  overlaySheetToCanvas,
} from "@api/gridOverlays";
import { runFloatingControlDelete } from "./lib/controlDelete";
import { insertAnchorOrRefuse } from "./lib/insertAnchor";
import { refuseIfSelectionOwned } from "@api/selectionOwner";
import {
  coMovedControlPositions,
  snapshotControlDrag,
  type ControlDragSnapshot,
} from "./lib/controlCoMove";
import {
  loadButtonScriptModules,
  planInlineButtonRun,
} from "../_shared/lib/buttonScriptRun";
// The host -> frame envelope is the shared module's to spell, not this file's.
// It used to be built by hand a few lines below, which made the protocol tag a
// four-way copy the moment the pane host learned to share it.
import { postToScriptFrame } from "../_shared/scriptFrame";
import { drawButton } from "./Button/rendering";
import {
  buttonStyleInterceptor,
  buttonClickInterceptor,
  handleButtonCellChange,
  setCurrentSelection,
  getCurrentSelection,
  refreshStyleCache,
  reportUnavailableButtonModules,
  buttonStyleIndices,
} from "./Button/interceptors";
import {
  renderFloatingButton,
  invalidateFloatingButtonCache,
  invalidateAllFloatingButtonCaches,
} from "./Button/floatingRenderer";
import {
  renderFloatingShape,
  invalidateShapeCache,
  invalidateAllShapeCaches,
  setCustomCanvasRenderer,
  removeCustomCanvasRenderer,
  setShapeHtmlContent,
  removeShapeHtmlOverlay,
  releaseAllShapeHtmlOverlays,
  markShapeHasScript,
  unmarkShapeHasScript,
  getShapeOverlayFrame,
  migrateShapeInstanceId,
} from "./Shape/shapeRenderer";
import { setShapeHitRegions, resetShapeHitRegions } from "./Shape/shapeHitRegions";
import {
  SHAPE_HIT_REGIONS_EVENT,
  type ShapeHitRegion,
} from "@api/scriptHost/shapeHitRegionSpec";
import {
  setDeclaredProperties,
  clearDeclaredProperties,
  migrateDeclaredProperties,
} from "./Shape/shapeProperties";
import { getShapeTemplate } from "./Shape/shapeTemplateCatalog";
import {
  renderFloatingImage,
  invalidateImageCache,
  invalidateAllImageCaches,
  forgetImageControl,
  releaseAllImageMedia,
  getMediaNaturalSize,
} from "./Image/imageRenderer";
import { registerPictureControlProvider } from "@api/pictureControlService";
import type {
  PictureControlAnchor,
  PictureControlHandle,
  CreatePictureControlRequest,
} from "@api/pictureControlService";
import {
  pickValidatedImage,
  initialImageSize,
  pictureLayoutSize,
} from "./Image/imageIngress";
import { isMediaRef } from "./Image/mediaRefs";
import {
  collectUnmigratedInlineImages,
  legacyInlineImageWarning,
} from "./Image/legacyInlineImages";
import React from "react";
import { getShapeDefinition, getShapeCategories } from "./Shape/shapeCatalog";
import { ShapeGalleryPanel } from "./Shape/ShapeGalleryOverlay";
import {
  selectFloatingControl,
  selectFloatingControls,
  toggleFloatingControlSelection,
  deselectFloatingControl,
  getSelectedFloatingControl,
  getSelectedFloatingControls,
  getSelectedControlCount,
  isFloatingControlSelected,
} from "./Button/floatingSelection";
import {
  addFloatingControl,
  removeFloatingControl,
  getFloatingControl,
  moveFloatingControl,
  resizeFloatingControl,
  syncFloatingControlRegions,
  resetFloatingStore,
  makeFloatingControlId,
  parseFloatingControlId,
  getGroupForControl,
  getGroupMembers,
  groupControls,
  ungroupControls,
  moveGroupControls,
  reanchorFloatingControls,
  repositionPinnedControls,
  removeFloatingControlsForSheet,
  recalcPinnedOffset,
  setSnapResolver,
  removeFloatingControlsNotOnSheet,
} from "./lib/floatingStore";
import {
  getDesignMode,
  toggleDesignMode,
  onDesignModeChange,
} from "./lib/designMode";
import {
  diagnoseButtonClick,
  orphanMacroDiagnosis,
  macroRunnerUnavailableDiagnosis,
} from "./lib/buttonClickDiagnosis";
import {
  setControlMetadata,
  getControlMetadata,
  getAllControls,
  setControlProperty,
  setControlGeometry,
} from "./lib/controlApi";
import { registerObjectGeometryProvider, joinUndoTransaction } from "@api/objectGeometry";
import { deleteSelectedObjects, shouldActOnWholeObjectSelection } from "@api/objectSelection";
import { controlGeometryChangesOf, createControlGeometryProvider } from "./lib/controlGeometry";
import { setShapePropertyAsOneStep } from "./lib/shapePropertyStep";
import { withControlAnchor, requestedSize } from "./lib/controlAnchors";
import { registerControlObjectSelection } from "./lib/controlObjectSelection";
import { installControlClipboardKeys } from "./lib/controlKeys";
import { controlsBackend } from "./lib/controlsBackend";
import { PropertiesPane } from "./PropertiesPane/PropertiesPane";
import { registerControlContextMenu } from "./lib/controlContextMenu";
import { installControlObjectMenu } from "./lib/controlObjectMenu";
import { hitTestFloatingControl } from "./lib/controlHitTest";
import {
  copyControls,
  pasteControl,
  pasteControlSnapshots,
  duplicateControls,
  hasClipboardControl,
  snapshotControls,
  setControlCopyCellOrigin,
} from "./lib/controlClipboard";

// ============================================================================
// Constants
// ============================================================================

const PROPERTIES_PANE_ID = "control-properties";
const DESIGN_MODE_MENU_ITEM_ID = "developer:designMode";

// ============================================================================
// Instance-Id Parsing (strict)
// ============================================================================

/**
 * Strictly parse an ON-GRID control instance id of the form
 * "control-<sheetIndex>-<row>-<col>" (as produced by makeFloatingControlId).
 *
 * Returns null for anything else. This guard is REQUIRED at the top of every
 * global shape:* app-event handler in this extension: those events are shared
 * with foreign script surfaces (e.g. pane-hosted controls with instanceId
 * "pane-<uuid>", whose uuid hyphens satisfy a naive split("-").length check
 * while parseInt("pane") yields NaN). No undo transaction and no state
 * mutation may happen unless the id fully parses.
 */
function parseOnGridControlInstanceId(
  instanceId: string,
): { sheetIndex: number; row: number; col: number } | null {
  if (typeof instanceId !== "string") return null;
  const match = /^control-(\d+)-(\d+)-(\d+)$/.exec(instanceId);
  if (!match) return null;
  const sheetIndex = Number(match[1]);
  const row = Number(match[2]);
  const col = Number(match[3]);
  if (
    !Number.isSafeInteger(sheetIndex) ||
    !Number.isSafeInteger(row) ||
    !Number.isSafeInteger(col)
  ) {
    return null;
  }
  return { sheetIndex, row, col };
}

// ============================================================================
// State
// ============================================================================

let isActivated = false;
const cleanupFns: (() => void)[] = [];
/** Re-read the controls from the backend (set in activate). */
let reloadControlsAfterRefusal: (() => Promise<void>) | null = null;

/** Reference to the design mode menu item for toggling its checked state. */
let designModeMenuItem: { checked?: boolean } | null = null;

// ============================================================================
// Overlay Dispatchers (route render/hitTest by controlType)
// ============================================================================

/** Track which groups have had their bounding box drawn this render pass. */
const drawnGroupBounds = new Set<string>();

function renderFloatingControl(overlayCtx: OverlayRenderContext): void {
  const controlType = overlayCtx.region.data?.controlType;
  if (controlType === "shape") {
    renderFloatingShape(overlayCtx);
  } else if (controlType === "image") {
    renderFloatingImage(overlayCtx);
  } else {
    renderFloatingButton(overlayCtx);
  }

  // Draw group bounding rectangle if this control is in a selected group
  const controlId = overlayCtx.region.id;
  if (isFloatingControlSelected(controlId)) {
    const groupId = getGroupForControl(controlId);
    if (groupId && !drawnGroupBounds.has(groupId)) {
      drawnGroupBounds.add(groupId);
      drawGroupBoundingBox(overlayCtx, groupId);
    }

    // Draw multi-selection bounding box (when 2+ controls are selected, even ungrouped)
    const selectedCount = getSelectedControlCount();
    if (selectedCount >= 2 && !drawnGroupBounds.has("__multiselect__")) {
      drawnGroupBounds.add("__multiselect__");
      drawMultiSelectionBoundingBox(overlayCtx);
    }

    // Schedule cleanup of the drawn set for next frame
    if (drawnGroupBounds.size > 0) {
      requestAnimationFrame(() => drawnGroupBounds.clear());
    }
  }
}

/**
 * Draw a dashed bounding rectangle around all members of a group.
 * Called once per group per render frame when the group is selected.
 */
function drawGroupBoundingBox(overlayCtx: OverlayRenderContext, groupId: string): void {
  const memberIds = getGroupMembers(groupId);
  if (memberIds.length === 0) return;

  // Compute the bounding box of all group members in sheet coordinates
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;

  for (const memberId of memberIds) {
    const ctrl = getFloatingControl(memberId);
    if (!ctrl) continue;
    minX = Math.min(minX, ctrl.x);
    minY = Math.min(minY, ctrl.y);
    maxX = Math.max(maxX, ctrl.x + ctrl.width);
    maxY = Math.max(maxY, ctrl.y + ctrl.height);
  }

  if (minX === Infinity) return;

  // Convert to canvas coordinates
  const topLeft = overlaySheetToCanvas(overlayCtx, minX, minY);
  const bottomRight = overlaySheetToCanvas(overlayCtx, maxX, maxY);

  const rowHeaderWidth = overlayGetRowHeaderWidth(overlayCtx);
  const colHeaderHeight = overlayGetColHeaderHeight(overlayCtx);

  const { ctx } = overlayCtx;
  ctx.save();

  // Clip to cell area (not over headers)
  ctx.beginPath();
  ctx.rect(
    rowHeaderWidth,
    colHeaderHeight,
    overlayCtx.canvasWidth - rowHeaderWidth,
    overlayCtx.canvasHeight - colHeaderHeight,
  );
  ctx.clip();

  // Draw dashed bounding rectangle with padding
  const padding = 6;
  const bx = topLeft.canvasX - padding;
  const by = topLeft.canvasY - padding;
  const bw = (bottomRight.canvasX - topLeft.canvasX) + padding * 2;
  const bh = (bottomRight.canvasY - topLeft.canvasY) + padding * 2;

  ctx.strokeStyle = "#0e639c";
  ctx.lineWidth = 1.5;
  ctx.setLineDash([6, 3]);
  ctx.strokeRect(bx, by, bw, bh);
  ctx.setLineDash([]);

  ctx.restore();
}

/**
 * Draw a dashed bounding rectangle around all selected controls (multi-selection).
 * Only drawn when 2+ controls are selected and they are NOT all in one group
 * (to avoid a duplicate bounding box).
 */
function drawMultiSelectionBoundingBox(overlayCtx: OverlayRenderContext): void {
  const selectedIds = getSelectedFloatingControls();
  if (selectedIds.size < 2) return;

  // Check if all selected controls are in the same group -- if so, skip
  // (the group bounding box already covers this)
  let allSameGroup = true;
  let commonGroupId: string | null | undefined = undefined;
  for (const id of selectedIds) {
    const gid = getGroupForControl(id);
    if (commonGroupId === undefined) {
      commonGroupId = gid;
    } else if (commonGroupId !== gid) {
      allSameGroup = false;
      break;
    }
  }
  if (allSameGroup && commonGroupId != null) return;

  // Compute bounding box of all selected controls
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;

  for (const id of selectedIds) {
    const ctrl = getFloatingControl(id);
    if (!ctrl) continue;
    minX = Math.min(minX, ctrl.x);
    minY = Math.min(minY, ctrl.y);
    maxX = Math.max(maxX, ctrl.x + ctrl.width);
    maxY = Math.max(maxY, ctrl.y + ctrl.height);
  }

  if (minX === Infinity) return;

  const topLeft = overlaySheetToCanvas(overlayCtx, minX, minY);
  const bottomRight = overlaySheetToCanvas(overlayCtx, maxX, maxY);

  const rowHeaderWidth = overlayGetRowHeaderWidth(overlayCtx);
  const colHeaderHeight = overlayGetColHeaderHeight(overlayCtx);

  const { ctx } = overlayCtx;
  ctx.save();

  ctx.beginPath();
  ctx.rect(
    rowHeaderWidth,
    colHeaderHeight,
    overlayCtx.canvasWidth - rowHeaderWidth,
    overlayCtx.canvasHeight - colHeaderHeight,
  );
  ctx.clip();

  const padding = 8;
  const bx = topLeft.canvasX - padding;
  const by = topLeft.canvasY - padding;
  const bw = (bottomRight.canvasX - topLeft.canvasX) + padding * 2;
  const bh = (bottomRight.canvasY - topLeft.canvasY) + padding * 2;

  ctx.strokeStyle = "#0078d4";
  ctx.lineWidth = 1;
  ctx.setLineDash([4, 4]);
  ctx.strokeRect(bx, by, bw, bh);
  ctx.setLineDash([]);

  ctx.restore();
}

// `hitTestFloatingControl` moved to lib/controlHitTest.ts, which also answers
// the same question from CLIENT coordinates. The right-click menu needs the
// answer from a `MouseEvent` on `window` while Core supplies an
// `OverlayHitTestContext` — one rule, two callers, one module.

// ============================================================================
// Activation
// ============================================================================

function activate(context: ExtensionContext): void {
  if (isActivated) {
    console.warn("[Controls] Already activated, skipping.");
    return;
  }

  // Bind the capability-scoped backend channel BEFORE any code that could
  // trigger a backend call (A3). All Controls lib/store/component backend
  // access flows through this scoped door instead of the raw @api/backend.
  controlsBackend.set(context.invokeBackend);

  console.log("[Controls] Activating...");

  // Expose the whole cell-anchored control surface (IoC) through ONE seam:
  // enumeration (so the script host's api.listObjects("shape") can list
  // buttons/shapes/pictures without importing Controls internals), the shape
  // CATALOG (so 123 shapes are discoverable instead of an unwritable enum in a
  // consent string), CREATE and DELETE. Enumeration is identity + anchor only —
  // property VALUES may be formulas over the user's data and are read through
  // their own paths.
  //
  // Create and delete live here rather than in the caller for the reason the
  // button seam already exists: the Macro Recorder hand-rolled control metadata
  // once, got a successful backend response, and drew an INVISIBLE button.
  cleanupFns.push(
    registerControlsProvider({
      listShapeCatalog: listShapeCatalogEntries,
      createShape: createShapeControlAt,
      deleteControl: deleteControlByInstanceId,
      async listControls(sheetIndex: number) {
        const entries = await getAllControls(sheetIndex);
        return entries.map((e) => ({
          sheetIndex: e.sheetIndex,
          row: e.row,
          col: e.col,
          controlType: e.metadata.controlType,
          name: e.metadata.properties?.name?.value,
        }));
      },
    }),
  );

  // Expose button CREATION (IoC). Placing a real, visible button is three
  // coordinated writes plus a geometry calculation, all of which live here; the
  // seam lets any extension ask for one without re-deriving that recipe (the
  // Macro Recorder's "save as button" wrote control metadata by hand and drew
  // nothing at all). Callers get the instanceId back — the id `button:clicked`
  // carries and an object script must bind to — so nobody has to guess it.
  cleanupFns.push(
    registerButtonControlProvider({
      createButton: createButtonControlAt,
      removeButton: removeButtonControlAt,
    }),
  );

  // 0c. Register the PICTURE driver on the same seam, for the same reason: a
  //     caller that writes control metadata itself gets a successful backend
  //     response and no picture on the grid. `api.createPicture` rejects with
  //     "the Controls extension is not loaded" until this runs.
  cleanupFns.push(
    registerPictureControlProvider({
      createPicture: createPictureControlAt,
      removePicture: removePictureControlAt,
    }),
  );

  // 0d. Keyboard / programmatic SELECTION (@api/objectSelection). A canvas
  //     sheet cycles its objects with Tab, and `floatingObject:selected` cannot
  //     be the route: that event means "a left press landed here", and its
  //     handler below RUNS a button's script in run mode, emits shape:clicked
  //     and opens the Properties pane. The provider selects and does nothing
  //     else -- and takes Controls' share of a canvas-wide Delete, and of every
  //     Copy / Paste / Duplicate through the object clipboard (W25).
  cleanupFns.push(
    registerControlObjectSelection({
      deleteControls: deleteControlsWithGroups,
      copyControls: snapshotControls,
      pasteControls: pasteControlSnapshots,
    }),
  );

  // 0e. GEOMETRY without a pointer gesture (@api/objectGeometry): the canvas's
  //     align, distribute, nudge and group drag. One `set_control_geometry`
  //     batch per commit; a refused batch puts the controls back.
  cleanupFns.push(
    registerObjectGeometryProvider(
      createControlGeometryProvider({
        cellOrigin: cellOriginPixels,
        invalidate: (controlId) => {
          invalidateFloatingButtonCache(controlId);
          invalidateShapeCache(controlId);
          invalidateImageCache(controlId);
        },
        refresh: () => emitAppEvent(AppEvents.GRID_REFRESH),
        afterPersist: (controlIds) => announceMetadataRefresh(controlIds),
      }),
    ),
  );

  // 1. Register button cell decoration for rendering (embedded buttons)
  const unregDecoration = context.grid.decorations.register("button", drawButton, 10);
  cleanupFns.push(unregDecoration);

  // 2. Register style interceptor to suppress default text for embedded buttons
  const unregStyleInterceptor = context.grid.styleInterceptors.register(
    "button",
    buttonStyleInterceptor,
    5,
  );
  cleanupFns.push(unregStyleInterceptor);

  // 3. Register cell click interceptor for embedded button behavior
  const unregClickInterceptor = context.grid.cellClicks.registerClickInterceptor(buttonClickInterceptor);
  cleanupFns.push(unregClickInterceptor);

  // 4. Track selection changes for design mode interactions
  //
  // Only deselect floating controls on a GENUINE grid-selection change (a real
  // click on a cell), not on spurious re-emits of the same selection. Selecting
  // a shape opens the Properties pane, which re-renders the grid and can emit an
  // identical selection with a fresh object reference; deselecting on that would
  // clear the just-selected shape before the user can press Delete on it.
  let lastSelectionSig: string | null = null;
  const unregSelectionChange = ExtensionRegistry.onSelectionChange((sel) => {
    setCurrentSelection(sel);
    const sig = sel
      ? `${sel.type ?? ""}:${sel.startRow},${sel.startCol},${sel.endRow},${sel.endCol}`
      : "none";
    if (sig !== lastSelectionSig) {
      lastSelectionSig = sig;
      // Deselect floating control when the user actually moves the grid selection
      deselectFloatingControl();
    }
    handleSelectionChange(sel);
  });
  cleanupFns.push(unregSelectionChange);

  // 5. Handle cell value changes (Delete key removes embedded button)
  const unregCellChange = ExtensionRegistry.onCellChange(
    (row, col, oldValue, newValue) => {
      handleButtonCellChange(row, col, oldValue, newValue);
    },
  );
  cleanupFns.push(unregCellChange);

  // 6. Re-evaluate formula-driven properties whenever cells are updated.
  //    CELLS_UPDATED fires reliably on every cell change (typing, paste,
  //    undo/redo, fill, delete, scripts, etc.) via the Core cellEvents system.
  const unregCellsUpdated = context.events.on(AppEvents.CELLS_UPDATED, () => {
    refreshStyleCache();
    invalidateAllFloatingButtonCaches();
    invalidateAllShapeCaches();
    invalidateAllImageCaches();
    emitAppEvent(AppEvents.GRID_REFRESH);
  });
  cleanupFns.push(unregCellsUpdated);

  // 6b. Re-evaluate formula-driven properties whenever named ranges change.
  //     Named ranges can be referenced in control property formulas (e.g., =test).
  const unregNamedRangesChanged = context.events.on(AppEvents.NAMED_RANGES_CHANGED, () => {
    invalidateAllFloatingButtonCaches();
    invalidateAllShapeCaches();
    invalidateAllImageCaches();
    emitAppEvent(AppEvents.GRID_REFRESH);
  });
  cleanupFns.push(unregNamedRangesChanged);

    // 6b-4. Pinned controls follow a row/column RESIZE too.
  //
  //     Insert and delete are handled by re-anchoring — the anchor row/col
  //     moves. A resize moves no anchors at all, so without this a pinned
  //     control keeps a stale pixel position the moment a row above it grows.
  //     Position is replayed as anchorOrigin + offset, so a control the user
  //     nudged off the boundary keeps that relationship.
  const onGridResized = () => {
    void (async () => {
      const sheetIndex = await getActiveSheet();
      if (!repositionPinnedControls(sheetIndex, cellOriginPixels)) return;
      invalidateAllFloatingButtonCaches();
      invalidateAllShapeCaches();
      invalidateAllImageCaches();
      syncFloatingControlRegions();
      emitAppEvent(AppEvents.GRID_REFRESH);
    })();
  };
  for (const evt of [AppEvents.ROW_RESIZED, AppEvents.COLUMN_RESIZED] as const) {
    cleanupFns.push(context.events.on(evt, onGridResized));
  }

// 6b-2. SNAP TO GRID for pinned controls.
  //
  //     Pinning and snapping are the same idea at two different moments: a
  //     pinned control follows its cells when the grid changes, so it should
  //     also LAND on a cell boundary when dragged. Unpinned controls are never
  //     snapped — nudging one by a single pixel has to stay possible.
  //
  //     The store owns no pixel geometry, so it calls back here for the nearest
  //     cell origin.
  setSnapResolver((x, y) => {
    const gridState = getGridStateSnapshot();
    if (!gridState) return { x, y };
    const defaultCellWidth = gridState.config?.defaultCellWidth ?? 100;
    const defaultCellHeight = gridState.config?.defaultCellHeight ?? 24;
    const columnWidths = gridState.dimensions?.columnWidths ?? new Map();
    const rowHeights = gridState.dimensions?.rowHeights ?? new Map();

    // Walk to the last boundary at or before the drop point. Columns and rows
    // can each have custom sizes, so this cannot be a modulo.
    let snappedX = 0;
    for (let c = 0; snappedX <= x; c++) {
      const next = snappedX + getColumnWidthSync(c, defaultCellWidth, columnWidths);
      if (next > x) break;
      snappedX = next;
    }
    let snappedY = 0;
    for (let r = 0; snappedY <= y; r++) {
      const next = snappedY + getRowHeightSync(r, defaultCellHeight, rowHeights);
      if (next > y) break;
      snappedY = next;
    }
    return { x: snappedX, y: snappedY };
  });
  cleanupFns.push(() => setSnapResolver(null));
  // A PINNED control's pasted / duplicated copy measures its offsets from its
  // OWN (new) anchor with the same walk the reposition pass replays
  // (lib/controlClipboard.ts `pinCopyToAnchor`).
  setControlCopyCellOrigin(cellOriginPixels);
  cleanupFns.push(() => setControlCopyCellOrigin(null));

  // 6b-3. Keep the floating store's pin flag in step with the metadata the
  //     Properties Pane just wrote, so the re-anchor above can read it
  //     synchronously during a structural edit.
  const onPinChanged = (e: Event) => {
    const d = (e as CustomEvent).detail as {
      sheetIndex: number; row: number; col: number; pinned: boolean;
    };
    const id = makeFloatingControlId(d.sheetIndex, d.row, d.col);
    const ctrl = getFloatingControl(id);
    if (!ctrl) return;
    ctrl.pinToGrid = d.pinned;
    // Capture where it sits relative to its anchor AT THE MOMENT of pinning,
    // so turning the toggle on never makes the control jump — and persist the
    // offsets so the relationship survives a reload.
    if (d.pinned) {
      recalcPinnedOffset(id, cellOriginPixels);
      void persistFloatingGeometry([id]);
    }
  };
  window.addEventListener("controls:pin-changed", onPinChanged);
  cleanupFns.push(() => window.removeEventListener("controls:pin-changed", onPinChanged));

  // 6c. STRUCTURAL EDITS. Controls are anchored to a cell, and the backend
  //     shifts that anchor when rows/columns are inserted or deleted — but this
  //     extension had NO structural subscription at all, so the floating store
  //     and its render caches kept the OLD anchors. The store's ids
  //     (`control-<sheet>-<row>-<col>`) then disagreed with the backend about
  //     which control is which.
  //
  //     Placement decides what moves, mirroring the backend rule: a control
  //     marked `free` holds its pixel position and its anchor; anything else
  //     follows the grid.
  const shiftForEvent = (
    kind: "rowInsert" | "rowDelete" | "colInsert" | "colDelete",
    at: number,
    count: number,
  ) => (row: number, col: number): { row: number; col: number } | null => {
    switch (kind) {
      case "rowInsert":
        return { row: row >= at ? row + count : row, col };
      case "colInsert":
        return { row, col: col >= at ? col + count : col };
      case "rowDelete":
        if (row >= at + count) return { row: row - count, col };
        if (row >= at) return null; // The anchor row itself was deleted.
        return { row, col };
      case "colDelete":
        if (col >= at + count) return { row, col: col - count };
        if (col >= at) return null;
        return { row, col };
    }
  };

  // Mirrors controls::moves_with_cells. A floating control only follows the
  // grid when the user has pinned it; in-cell controls are not in this store.
  const movesWithCells = (ctrl: { pinToGrid?: boolean }): boolean =>
    ctrl.pinToGrid === true;

  // Structural events are SERIALIZED through this chain: each handler awaits
  // an IPC round trip (getActiveSheet) before mutating the store, so two rapid
  // edits could otherwise interleave and apply their shifts out of order.
  let structuralQueue: Promise<void> = Promise.resolve();

  const onStructuralEdit = (
    kind: "rowInsert" | "rowDelete" | "colInsert" | "colDelete",
  ) => (detail: unknown) => {
    const d = (detail ?? {}) as { startRow?: number; startCol?: number; count?: number };
    // The structural events carry no sheet index — these commands always act on
    // the active sheet — so it is resolved here.
    const at = kind.startsWith("row") ? d.startRow : d.startCol;
    const count = d.count;
    if (at === undefined || count === undefined) return;

    structuralQueue = structuralQueue.then(async () => {
      const sheetIndex = await getActiveSheet();
      reanchorFloatingControls(sheetIndex, shiftForEvent(kind, at, count), movesWithCells, {
        // Migrate id-keyed side state with the re-key: a scripted pinned
        // shape otherwise loses its renderer/HTML content and leaks its
        // iframe under the old id.
        onRename: (oldId, newId) => {
          migrateShapeInstanceId(oldId, newId);
          migrateDeclaredProperties(oldId, newId);
        },
        onRemove: (id) => {
          removeShapeHtmlOverlay(id);
          removeCustomCanvasRenderer(id);
          clearDeclaredProperties(id);
        },
      });
      // Pinned controls must FOLLOW the edit visually, not merely re-anchor:
      // the anchor row moved, so anchorOrigin + offset lands on new pixels.
      // Without this the move only became visible on the next row resize.
      repositionPinnedControls(sheetIndex, cellOriginPixels);

      invalidateAllFloatingButtonCaches();
      invalidateAllShapeCaches();
      invalidateAllImageCaches();
      syncFloatingControlRegions();
      emitAppEvent(AppEvents.GRID_REFRESH);
    }).catch((err) => {
      console.error("[Controls] Structural re-anchor failed:", err);
    });
  };

  for (const [evt, kind] of [
    [AppEvents.ROWS_INSERTED, "rowInsert"],
    [AppEvents.ROWS_DELETED, "rowDelete"],
    [AppEvents.COLUMNS_INSERTED, "colInsert"],
    [AppEvents.COLUMNS_DELETED, "colDelete"],
  ] as const) {
    cleanupFns.push(context.events.on(evt, onStructuralEdit(kind)));
  }

  // Undo of a structural edit carries no coordinates, so the only correct
  // response is to re-read the anchors from the backend — which is what this
  // does now: drop the active sheet's store entries and reload them from
  // metadata (cache invalidation alone left the frontend anchored one row off).
  cleanupFns.push(
    context.events.on(AppEvents.STRUCTURAL_UNDO, () => {
      structuralQueue = structuralQueue.then(async () => {
        const sheetIndex = await getActiveSheet();
        removeFloatingControlsForSheet(sheetIndex);
        await loadFloatingControls();
        repositionPinnedControls(sheetIndex, cellOriginPixels);

        invalidateAllFloatingButtonCaches();
        invalidateAllShapeCaches();
        invalidateAllImageCaches();
        syncFloatingControlRegions();
        emitAppEvent(AppEvents.GRID_REFRESH);
      }).catch((err) => {
        console.error("[Controls] Structural-undo reload failed:", err);
      });
    }),
  );

  // 7. Register Properties Pane as a task pane
  context.ui.taskPanes.register({
    id: PROPERTIES_PANE_ID,
    title: "Properties",
    component: PropertiesPane,
    contextKeys: ["properties"],
    priority: 40,
    closable: true,
  });
  cleanupFns.push(() => context.ui.taskPanes.unregister(PROPERTIES_PANE_ID));

  // 8. Register Insert > Controls > Button menu item
  context.ui.menus.registerItem("insert", {
    id: "insert.controls",
    label: "Controls",
    icon: IconControls,
    children: [
      {
        id: "insert.controls.button",
        label: "Button",
        icon: IconButton,
        action: insertButton,
      },
    ],
  });

  // 8b. Register Insert > Shapes with gallery submenu
  context.ui.menus.registerItem("insert", {
    id: "insert.shapes",
    label: "Shapes",
    icon: IconShapes,
    customContent: (onClose) =>
      React.createElement(ShapeGalleryPanel, { insertShape, onClose }),
  });

  // 8c. Register Insert > Image menu item
  context.ui.menus.registerItem("insert", {
    id: "insert.image",
    label: "Image",
    icon: IconImage,
    action: insertImage,
  });

  // 9. Register Developer > Design Mode menu item
  const menuItem = {
    id: DESIGN_MODE_MENU_ITEM_ID,
    label: "Design Mode",
    icon: IconDesignMode,
    checked: getDesignMode(),
    action: () => {
      toggleDesignMode();
      menuItem.checked = getDesignMode();
      designModeMenuItem = menuItem;
      context.ui.menus.notifyChanged();
    },
  };
  designModeMenuItem = menuItem;
  context.ui.menus.registerItem("developer", menuItem);

  // 9b. Take back the menu items above -- this extension's OWN ids only (wave
  // E, Y14). Insert > Controls holds its Button as a CHILD, so the submenu is
  // left to go with its last child, as any submenu another extension could add
  // a control to; Insert and Developer belong to other extensions.
  cleanupFns.push(() => {
    context.ui.menus.unregisterItem("insert", "insert.controls.button");
    context.ui.menus.unregisterItem("insert", "insert.shapes");
    context.ui.menus.unregisterItem("insert", "insert.image");
    context.ui.menus.unregisterItem("developer", DESIGN_MODE_MENU_ITEM_ID);
  });

  // 10. Listen to design mode changes for auto-show/hide
  const unregDesignMode = onDesignModeChange((_isDesignMode) => {
    if (designModeMenuItem) {
      designModeMenuItem.checked = _isDesignMode;
      context.ui.menus.notifyChanged();
    }
    // Re-evaluate whether properties pane should be open
    evaluatePropertiesPaneVisibility();
    // Redraw floating controls to update design mode indicators
    syncFloatingControlRegions();
    emitAppEvent(AppEvents.GRID_REFRESH);
  });
  cleanupFns.push(unregDesignMode);

  // 11. Register cursor change for embedded button cells
  const unregCursor = setupButtonCursor();
  cleanupFns.push(unregCursor);

  // 12. Initial style cache load
  refreshStyleCache();

  // -----------------------------------------------------------------------
  // 13. Register floating button overlay renderer
  // -----------------------------------------------------------------------
  const unregOverlay = context.grid.overlays.register({
    type: "floating-control",
    render: renderFloatingControl,
    hitTest: hitTestFloatingControl,
    priority: 12, // Above table (5), below charts (15)
  });
  cleanupFns.push(unregOverlay);

  // -----------------------------------------------------------------------
  // 14. Handle floating object events (move/resize from Core mouse handlers)
  // -----------------------------------------------------------------------
  setupFloatingObjectEvents();

  // -----------------------------------------------------------------------
  // 15. Handle embedded toggle event from PropertiesPane
  // -----------------------------------------------------------------------
  const handleEmbeddedChanged = (e: Event) => {
    const detail = (e as CustomEvent).detail;
    if (detail) {
      handleEmbeddedToggle(detail.sheetIndex, detail.row, detail.col, detail.embedded);
    }
  };
  window.addEventListener("controls:embedded-changed", handleEmbeddedChanged);
  cleanupFns.push(() => window.removeEventListener("controls:embedded-changed", handleEmbeddedChanged));

  // -----------------------------------------------------------------------
  // 16. Handle cache invalidation from PropertiesPane (visual property edits)
  // -----------------------------------------------------------------------
  const handleCacheInvalidation = (e: Event) => {
    const detail = (e as CustomEvent).detail;
    if (detail) {
      const controlId = makeFloatingControlId(detail.sheetIndex, detail.row, detail.col);
      invalidateFloatingButtonCache(controlId);
      invalidateShapeCache(controlId);
      invalidateImageCache(controlId);
      emitAppEvent(AppEvents.GRID_REFRESH);
    }
  };
  window.addEventListener("controls:invalidate-cache", handleCacheInvalidation);
  cleanupFns.push(() => window.removeEventListener("controls:invalidate-cache", handleCacheInvalidation));

  // -----------------------------------------------------------------------
  // 17. Handle bounds changes from PropertiesPane (width/height edits)
  // -----------------------------------------------------------------------
  const handleBoundsChanged = (e: Event) => {
    const detail = (e as CustomEvent).detail;
    if (detail) {
      updateFloatingBoundsFromMetadata(detail.sheetIndex, detail.row, detail.col);
      // Emit shape:resized for scriptable objects
      const controlId = makeFloatingControlId(detail.sheetIndex, detail.row, detail.col);
      const ctrl = getFloatingControl(controlId);
      if (ctrl && ctrl.controlType === "shape") {
        emitAppEvent("shape:resized", {
          instanceId: controlId,
          width: ctrl.width,
          height: ctrl.height,
        });
      }
    }
  };
  window.addEventListener("controls:bounds-changed", handleBoundsChanged);
  cleanupFns.push(() => window.removeEventListener("controls:bounds-changed", handleBoundsChanged));

  // -----------------------------------------------------------------------
  // 18. Delete selected floating control(s) on Delete/Backspace key
  //
  // THROUGH THE REGISTRY, NOT A DOCUMENT LISTENER. This used to be a
  // capture-phase `document` keydown listener, and it worked only because the
  // grid did not hold focus after a Design-Mode click on a shape. Once
  // `gridShouldTakeKeyboardFocus` (core/components/Spreadsheet/gridPointerEntry.ts)
  // started focusing `[data-focus-container="spreadsheet"]` on every unclaimed
  // grid mousedown, `isGridFocused()` became TRUE with a control selected, so
  // the built-in Delete binding (`core.clearContents`, GRID_SCOPED_COMMANDS)
  // matched in the registry's WINDOW-capture dispatcher — which runs strictly
  // before any `document` listener — and it called preventDefault() AND
  // stopPropagation(). This listener was never reached again. The measured
  // consequence was not an inert dead key: the control SURVIVED and the cells
  // under the selection were CLEARED instead. Silent data loss, proved live by
  // `e2e/journeys/shapes-hometab.spec.ts` test 5.
  //
  // The only honest way to say "the control owns this key WHILE a control is
  // selected" is a `when` predicate: the dispatcher prefers a guarded binding
  // over the unguarded built-in precisely because registration order cannot
  // express that. This is the same shape Charts uses for its own Delete
  // (`ext.charts.deleteSelection`, extensions/Charts/index.ts), and going
  // through the registry brings the three gates the old listener hand-rolled:
  //   * `context: "not-editing"` IS `isEditing() || isClaimedKeystroke(event)`
  //     — the INPUT/TEXTAREA/contentEditable tag list AND the `isKeyClaimed`
  //     check, without this file re-spelling either of them;
  //   * `isGridFocused()` in the guard is the gate the old listener never had,
  //     which is what made "select a shape, click a button in a task pane,
  //     press Delete" destroy the shape (the identical defect Charts fixed);
  //   * the dispatcher does the preventDefault/stopPropagation itself.
  // -----------------------------------------------------------------------
  const CONTROLS_DELETE_SELECTION_COMMAND = "ext.controls.deleteSelection";
  CommandRegistry.register(CONTROLS_DELETE_SELECTION_COMMAND, () => {
    if (getSelectedFloatingControls().size === 0) return;
    deleteSelectedControls();
  });
  cleanupFns.push(() => CommandRegistry.unregister(CONTROLS_DELETE_SELECTION_COMMAND));
  // Backspace carries no built-in binding, so it was never pre-empted and the
  // old listener still served it. It is registered here all the same: leaving
  // one key on a retired listener and one on the registry would be two answers
  // to one question, and the next change to either would only move the bug.
  for (const combo of ["Delete", "Backspace"] as const) {
    cleanupFns.push(
      registerKeybinding(
        {
          id: `ext.controls.deleteSelection.${combo.toLowerCase()}`,
          combo,
          commandId: CONTROLS_DELETE_SELECTION_COMMAND,
          label: "Delete Selected Control",
          category: "Editing",
          context: "not-editing",
          source: "extension",
          extensionId: "calcula.controls",
        },
        () => getSelectedFloatingControls().size > 0 && isGridFocused(),
      ),
    );
  }

  // -----------------------------------------------------------------------
  // 19. Load existing floating controls on startup
  //
  // This is the FIRST link of the reload queue declared below rather than a
  // free-floating call. Activation and the two reloaders must share one chain:
  // a workbook restored at startup can emit AFTER_OPEN / SHEET_CHANGED while
  // this first read is still in flight, and an unserialised startup load would
  // then race the reload that supersedes it. Chaining makes the last write win
  // by ORDER instead of by whichever IPC round trip returned first.
  // -----------------------------------------------------------------------
  let documentReloadQueue: Promise<void> = loadFloatingControls();

  // -----------------------------------------------------------------------
  // 19b. Re-load them when the DOCUMENT changes underneath us.
  //
  // Until now this extension read controls exactly once, at activation, so
  // opening a second workbook in the same session left the grid holding the
  // first one's controls (CellTypes and CellBehaviors already reload on
  // AFTER_OPEN; this one did not). Embedded media makes that worse than stale
  // geometry: the host's legacy-image migration runs during the load, and a
  // `media:` handle belonging to the workbook that just closed resolves against
  // the newly opened document's media store and correctly fails. So the whole
  // frontend picture cache is released here, not merely invalidated.
  //
  // AFTER_NEW for the same reason with a simpler ending: the new document has no
  // controls, so the reload finds none and the previous document's stop being
  // painted.
  // -----------------------------------------------------------------------
  // ONE queue for both reloaders. `announceBackendStateReplaced()` (core's
  // file-api) emits SHEET_CHANGED as well as AFTER_OPEN / AFTER_NEW — correctly,
  // because the sheet list really is replaced — so opening a workbook fires both
  // handlers. Serialising them makes the outcome deterministic instead of
  // whichever await resolved first: the document reload runs to completion, and
  // the sheet handler then finds `loadedSheetIndex` already correct and does
  // nothing. (The queue itself is declared at step 19, seeded with the startup
  // load, so activation is the first link rather than an unserialised racer.)

  const reloadForNewDocument = () => {
    documentReloadQueue = documentReloadQueue.then(async () => {
      resetFloatingStore();
      loadedSheetIndex = null;
      deselectFloatingControl();
      releaseAllImageMedia();
      // The html shapes' frames go the same way, and for the same reason the
      // picture cache does: they belong to the document that just closed. A
      // frame left behind keeps its share of the live-frame budget — which is
      // capped per SESSION, so the next workbook opens with fewer frames
      // available than it has shapes — and, because a control's id derives from
      // its anchor cell, an ordinary shape in the new document at a matching
      // anchor would paint the old document's html.
      releaseAllShapeHtmlOverlays();
      reportedLegacyInlineImages.clear();
      invalidateAllFloatingButtonCaches();
      invalidateAllShapeCaches();
      await loadFloatingControls();
      emitAppEvent(AppEvents.GRID_REFRESH);
    }).catch((err) => {
      console.error("[Controls] Document-change reload failed:", err);
    });
  };
  for (const evt of [AppEvents.AFTER_OPEN, AppEvents.AFTER_NEW] as const) {
    cleanupFns.push(context.events.on(evt, reloadForNewDocument));
  }

  // -----------------------------------------------------------------------
  // 19c. Re-load them when the ACTIVE SHEET changes.
  //
  // `loadFloatingControls` reads ONE sheet — the active one — and the floating
  // store had no other loader, so until now the store held whatever sheet
  // happened to be active at activation, forever. Two symptoms, both silent:
  //
  //   * the OTHER sheet's controls never appeared, because nothing ever read
  //     them; and
  //   * the FIRST sheet's controls kept painting on top of every other sheet,
  //     because `syncFloatingControlRegions` is sheet-BLIND — it publishes an
  //     overlay region for every entry in the store, with no sheet filter — and
  //     a click on one of those phantoms edited a control on a sheet the user
  //     was not looking at.
  //
  // So the store holds exactly one sheet at a time, and this is where it is
  // swapped. `removeFloatingControlsForSheet` (not `resetFloatingStore`) because
  // it also unpicks group membership for the departing sheet, and the sheet we
  // loaded is tracked rather than guessed — SHEET_CHANGED carries the new index,
  // not the old one.
  //
  // Bitmap caches are INVALIDATED, never released: the media blob URLs are
  // keyed by content hash and the controls will very likely be back the moment
  // the user switches sheets again, so revoking them would re-pull every
  // picture's bytes on every tab click.
  // -----------------------------------------------------------------------
  const reloadForSheetChange = () => {
    documentReloadQueue = documentReloadQueue.then(async () => {
      const nextSheet = await getActiveSheet();
      // The store holds ONE sheet. A control of another sheet can still be in it
      // (an insert on a sheet the store had not loaded yet), so every sheet
      // other than the next one is purged -- not only the one we recorded.
      const purged = removeFloatingControlsNotOnSheet(nextSheet);
      if (nextSheet === loadedSheetIndex && purged.length === 0) return;
      deselectFloatingControl();
      const { closeTaskPane: closeTP } = await import("../../src/api/ui");
      closeTP(PROPERTIES_PANE_ID);
      lastPropertiesCell = null;
      invalidateAllFloatingButtonCaches();
      invalidateAllShapeCaches();
      invalidateAllImageCaches();

      await loadFloatingControls(nextSheet);
      emitAppEvent(AppEvents.GRID_REFRESH);
    }).catch((err) => {
      console.error("[Controls] Sheet-change reload failed:", err);
    });
  };
  cleanupFns.push(context.events.on(AppEvents.SHEET_CHANGED, reloadForSheetChange));

  // -----------------------------------------------------------------------
  // 19d. Re-load them when the BACKEND's control store changed underneath us.
  //
  // Undo and redo of a control create/delete are the reason this exists. Both
  // rewrite `workbook.controls` in Rust and neither goes through any of this
  // extension's own delete/create paths, so the frontend store — which holds one
  // sheet's controls and is otherwise only ever swapped on a sheet change — kept
  // describing the state the user just undid. Repainting does not help: the
  // repaint reads the same stale store, so an undone deletion left the shape
  // gone and an undone creation left it on screen, both permanently.
  //
  // Same queue as the other two reloaders, for the same reason (ordering, not
  // luck, decides which read wins). Unlike `reloadForSheetChange` this does NOT
  // early-return when the sheet index is unchanged — the sheet is exactly what
  // has not changed here; the store's CONTENTS have.
  const reloadForBackendChange = (): Promise<void> => {
    documentReloadQueue = documentReloadQueue.then(async () => {
      if (loadedSheetIndex !== null) removeFloatingControlsForSheet(loadedSheetIndex);
      deselectFloatingControl();
      // A control that was just restored or removed must not keep painting from
      // a cached bitmap keyed by its (anchor-derived) id.
      invalidateAllFloatingButtonCaches();
      invalidateAllShapeCaches();
      invalidateAllImageCaches();
      // `loadFloatingControls` reads the ACTIVE sheet and records which one it
      // loaded, so the index stays owned by one function.
      await loadFloatingControls();
      syncFloatingControlRegions();
      emitAppEvent(AppEvents.GRID_REFRESH);
    }).catch((err) => {
      console.error("[Controls] Backend-change reload failed:", err);
    });
    return documentReloadQueue;
  };
  cleanupFns.push(context.events.on(AppEvents.CONTROLS_CHANGED, reloadForBackendChange));
  // A refused geometry batch (persistFloatingGeometry) re-reads the store the
  // same way: the controls go back to where the workbook has them.
  reloadControlsAfterRefusal = () => reloadForBackendChange();
  cleanupFns.push(() => {
    reloadControlsAfterRefusal = null;
  });

  // -----------------------------------------------------------------------
  // 20. Context menus for floating controls
  //
  // TWO surfaces, because they answer two different questions. The OBJECT menu
  // (Duplicate, Order, Flip, Edit Script, Delete…) is opened by this
  // extension's own capture-phase contextmenu listener, since Core deliberately
  // emits nothing for a right-click on a floating object — that is what left
  // every one of these items unreachable. The CELL menu keeps exactly one item,
  // "Paste", whose context is a cell rather than an object.
  // -----------------------------------------------------------------------
  cleanupFns.push(installControlObjectMenu());
  const unregContextMenu = registerControlContextMenu();
  cleanupFns.push(unregContextMenu);

  // -----------------------------------------------------------------------
  // 21. Ctrl+C / Ctrl+V / Ctrl+D / Ctrl+G for floating controls go through the
  //     keybinding REGISTRY (lib/controlKeys.ts): as a `document` listener
  //     they were pre-empted by the built-in Copy / Paste / Fill Down / Go To
  //     Special, which then acted on the cells under the control. Only
  //     Ctrl+Shift+G (ungroup), which no built-in binds, stays on the listener
  //     below.
  // -----------------------------------------------------------------------
  cleanupFns.push(
    installControlClipboardKeys("calcula.controls", {
      selectedIds: () => [...getSelectedFloatingControls()],
      hasClipboard: hasClipboardControl,
      copy: copyControls,
      // Synchronous up to the paste: it takes its place on the object
      // clipboard's queue in the order the keys were pressed (a dynamic
      // import awaited first let a later Ctrl+D queue ahead of it).
      paste: () => pasteControl(getGridStateSnapshot()?.sheetContext?.activeSheetIndex ?? 0),
      duplicate: duplicateControls,
      group: (ids) => {
        groupControls(ids);
        syncFloatingControlRegions();
        emitAppEvent(AppEvents.GRID_REFRESH);
      },
    }),
  );

  const handleControlKeyboard = async (e: KeyboardEvent) => {
    // A keystroke aimed at a surface stacked ON the grid -- an on-grid form's
    // field, a shape's declared hit rectangle -- is not this extension's.
    // The tag list below cannot see a <select> or a <button>; the claim can.
    // See core/lib/pointerClaims.ts, and the census in
    // core/lib/globalInputListeners.ts (a new global listener adds a row).
    if (isKeyClaimed(e)) return;
    // Don't intercept when editing a cell or input field
    const target = e.target as HTMLElement;
    if (
      target.tagName === "INPUT" ||
      target.tagName === "TEXTAREA" ||
      target.isContentEditable
    ) return;

    const selectedId = getSelectedFloatingControl();

    if (e.ctrlKey && e.shiftKey && e.key === "G" && selectedId) {
      // Ctrl+Shift+G: Ungroup
      e.preventDefault();
      e.stopPropagation();
      const groupId = getGroupForControl(selectedId);
      if (groupId) {
        ungroupControls(groupId);
        syncFloatingControlRegions();
        emitAppEvent(AppEvents.GRID_REFRESH);
      }
    }
  };
  document.addEventListener("keydown", handleControlKeyboard, true);
  cleanupFns.push(() => document.removeEventListener("keydown", handleControlKeyboard, true));

  // -----------------------------------------------------------------------
  // 22. Handle controls:delete-selected event (from context menu)
  // -----------------------------------------------------------------------
  const handleDeleteSelected = () => {
    deleteSelectedControls();
  };
  window.addEventListener("controls:delete-selected", handleDeleteSelected);
  cleanupFns.push(() => window.removeEventListener("controls:delete-selected", handleDeleteSelected));

  // -----------------------------------------------------------------------
  // 23. Shape scripting event wiring
  // -----------------------------------------------------------------------

  // Handle shape:setProperty from scripts (script calls shape.setProperty)
  const unsubSetProperty = onAppEvent("shape:setProperty", async (detail) => {
    const d = detail as { instanceId: string; key: string; value: string; oldValue: string };
    // Strict guard BEFORE any undo transaction or state mutation: foreign ids
    // (e.g. pane-hosted "pane-<uuid>") are handled by their own host, not here.
    const loc = parseOnGridControlInstanceId(d.instanceId);
    if (!loc) return;
    const { sheetIndex: si, row: r, col: c } = loc;

    // One undo step so the change is reversible -- GUARANTEED to close when
    // this handler opened it, and closing NOTHING when the script that set the
    // property holds its own open batch: the write joins that batch and the
    // script closes it (wave F, Z6; lib/shapePropertyStep.ts).
    try {
      await setShapePropertyAsOneStep(d.key, () =>
        setControlProperty(si, r, c, "shape", d.key, "static", d.value),
      );
    } catch (err) {
      // Property write (or commit) failed: skip the refresh/propertyChanged
      // fan-out below — nothing actually changed.
      console.error("[Controls] shape:setProperty failed for", d.instanceId, err);
      return;
    }

    // Invalidate cache and redraw
    window.dispatchEvent(new CustomEvent("controls:invalidate-cache", {
      detail: { sheetIndex: si, row: r, col: c },
    }));
    window.dispatchEvent(new CustomEvent("styles:refresh"));
    // Refresh Properties pane so it shows the updated value
    window.dispatchEvent(new CustomEvent("controls:metadata-refresh", {
      detail: { row: r, col: c },
    }));
    // Emit property changed event for script listeners
    emitAppEvent("shape:propertyChanged", {
      instanceId: d.instanceId,
      key: d.key,
      oldValue: d.oldValue,
      newValue: d.value,
    });
  });
  cleanupFns.push(unsubSetProperty);

  // Handle shape:setCanvasRenderer from scripts
  const unsubSetRenderer = onAppEvent("shape:setCanvasRenderer", (detail) => {
    const d = detail as { instanceId: string; renderer: (ctx: CanvasRenderingContext2D, bounds: { x: number; y: number; width: number; height: number }) => void };
    if (!parseOnGridControlInstanceId(d.instanceId)) return;
    setCustomCanvasRenderer(d.instanceId, d.renderer);
    invalidateShapeCache(d.instanceId);
    emitAppEvent(AppEvents.GRID_REFRESH);
  });
  cleanupFns.push(unsubSetRenderer);

  // Handle shape:removeCanvasRenderer from scripts
  const unsubRemoveRenderer = onAppEvent("shape:removeCanvasRenderer", (detail) => {
    const d = detail as { instanceId: string };
    if (!parseOnGridControlInstanceId(d.instanceId)) return;
    removeCustomCanvasRenderer(d.instanceId);
    invalidateShapeCache(d.instanceId);
    emitAppEvent(AppEvents.GRID_REFRESH);
  });
  cleanupFns.push(unsubRemoveRenderer);

  // Handle shape:setHtmlContent from scripts
  const unsubSetHtml = onAppEvent("shape:setHtmlContent", (detail) => {
    const d = detail as { instanceId: string; html: string };
    // Foreign ids (pane-hosted controls) must not pollute the on-grid html
    // overlay map or trigger spurious grid refreshes per pane-script render.
    if (!parseOnGridControlInstanceId(d.instanceId)) return;
    setShapeHtmlContent(d.instanceId, d.html);
    invalidateShapeCache(d.instanceId);
    emitAppEvent(AppEvents.GRID_REFRESH);
  });
  cleanupFns.push(unsubSetHtml);

  // Handle shape:setHitRegions from scripts (M3b) — the rectangles of its own
  // HTML frame a script wants pointer input in. An EMPTY list releases the
  // frame, and that is also the message the script host sends on unmount, so
  // "released because the script asked" and "released because the script is
  // gone" take one code path.
  const unsubHitRegions = onAppEvent(SHAPE_HIT_REGIONS_EVENT, (detail) => {
    const d = detail as { instanceId: string | null; regions: ShapeHitRegion[] };
    // Same filter as setHtmlContent: a pane-hosted control's id is not an
    // on-grid id, and its frame has no grid pixels to claim.
    if (!d.instanceId || !parseOnGridControlInstanceId(d.instanceId)) return;
    setShapeHitRegions(d.instanceId, d.regions);
    emitAppEvent(AppEvents.GRID_REFRESH);
  });
  cleanupFns.push(unsubHitRegions);
  // Deactivating the extension takes the grid down with it; a shim is a DOM
  // element in the canvas parent and would otherwise survive as an invisible
  // click-eater with nothing left to forward to. An overlay frame is the same
  // element problem plus a budget charge that nothing would ever hand back, so
  // a deactivate/activate cycle would come back with the frame cap already
  // spent on frames that no longer exist.
  cleanupFns.push(() => releaseAllShapeHtmlOverlays());
  cleanupFns.push(() => resetShapeHitRegions());

  // Handle shape:sendMessage from scripts (forward to iframe). The envelope is
  // posted by the shared module, which owns both ends of the protocol tag — the
  // pane host's forwarder goes through the same function, so the two hosts
  // cannot drift into posting different spellings at one bridge.
  const unsubSendMsg = onAppEvent("shape:sendMessage", (detail) => {
    const d = detail as { instanceId: string; type: string; data: unknown };
    if (!parseOnGridControlInstanceId(d.instanceId)) return;
    postToScriptFrame(getShapeOverlayFrame(d.instanceId), d.instanceId, d.type, d.data);
  });
  cleanupFns.push(unsubSendMsg);

  // Handle shape:declareProperties from scripts
  const unsubDeclareProps = onAppEvent("shape:declareProperties", (detail) => {
    const d = detail as { instanceId: string; props: DeclaredProperty[] };
    // Pane-hosted controls declare properties via their own host wiring.
    const loc = parseOnGridControlInstanceId(d.instanceId);
    if (!loc) return;
    setDeclaredProperties(d.instanceId, d.props);
    // Refresh the properties pane if it's open for this shape
    window.dispatchEvent(new CustomEvent("controls:metadata-refresh", {
      detail: { row: loc.row, col: loc.col },
    }));
  });
  cleanupFns.push(unsubDeclareProps);

  // Track shape script status for badge indicator
  // When a script is created/saved for a shape, mark it; when edit-script fires, check & mark
  const unsubScriptEdit = onAppEvent("scriptable-objects:edit-script", (detail) => {
    const d = detail as { objectType: string; instanceId: string };
    // Pane-hosted custom controls are also objectType "shape" but use
    // "pane-<uuid>" ids — only badge genuine on-grid shapes.
    if (d.objectType === "shape" && d.instanceId && parseOnGridControlInstanceId(d.instanceId)) {
      markShapeHasScript(d.instanceId);
      emitAppEvent(AppEvents.GRID_REFRESH);
    }
  });
  cleanupFns.push(unsubScriptEdit);

  // Scan for existing shape scripts on activation
  (async () => {
    try {
      const { listObjectScripts } = await import("../../src/api/objectScriptBackend");
      const scripts = await listObjectScripts();
      for (const script of scripts) {
        if (
          script.objectType === "shape" &&
          script.instanceId &&
          parseOnGridControlInstanceId(script.instanceId)
        ) {
          markShapeHasScript(script.instanceId);
        }
      }
      emitAppEvent(AppEvents.GRID_REFRESH);
    } catch {
      // Ignore errors during initial scan
    }
  })();

  // Handle shape:applyTemplate — apply a built-in template to a shape
  const applyingTemplates = new Set<string>();
  const unsubApplyTemplate = onAppEvent("shape:applyTemplate", async (detail) => {
    const d = detail as { instanceId: string; templateId: string };
    // Strict guard BEFORE any state mutation: templates only apply to
    // on-grid shapes, never to foreign ids (e.g. pane-hosted controls).
    const loc = parseOnGridControlInstanceId(d.instanceId);
    if (!loc) return;
    // Guard against double-click / rapid re-entry
    if (applyingTemplates.has(d.instanceId)) return;
    applyingTemplates.add(d.instanceId);

    const template = getShapeTemplate(d.templateId);
    if (!template) {
      applyingTemplates.delete(d.instanceId);
      return;
    }

    try {
      const { saveObjectScript, deleteObjectScriptsForInstance } = await import("../../src/api/objectScriptBackend");
      const { ObjectScriptManager } = await import("../../src/api/scriptableObjects");

      const { sheetIndex: si, row: r, col: c } = loc;

      // Clean up any existing script and overlay for this shape
      const existingScript = ObjectScriptManager.getScript("shape", d.instanceId);
      if (existingScript) {
        ObjectScriptManager.removeScript(existingScript.id);
      }
      await deleteObjectScriptsForInstance(d.instanceId);
      removeShapeHtmlOverlay(d.instanceId);
      removeCustomCanvasRenderer(d.instanceId);

      // Save the template script as an object script
      const scriptId = crypto.randomUUID();
      const scriptDef = {
        id: scriptId,
        name: template.name,
        objectType: "shape" as const,
        instanceId: d.instanceId,
        source: template.scriptSource,
        accessLevel: "restricted" as const,
        description: template.description,
      };
      await saveObjectScript(scriptDef);

      // Register and mount the script so it executes immediately
      ObjectScriptManager.registerScript(scriptDef);
      await ObjectScriptManager.mountScript(scriptId);

      // Resize shape to template defaults if different
      const ctrl = getFloatingControl(d.instanceId);
      if (ctrl && (ctrl.width !== template.defaultWidth || ctrl.height !== template.defaultHeight)) {
        resizeFloatingControl(d.instanceId, ctrl.x, ctrl.y, template.defaultWidth, template.defaultHeight);
        await setControlProperty(si, r, c, "shape", "width", "static", String(template.defaultWidth));
        await setControlProperty(si, r, c, "shape", "height", "static", String(template.defaultHeight));
        syncFloatingControlRegions();
      }

      // Mark script badge
      markShapeHasScript(d.instanceId);

      invalidateShapeCache(d.instanceId);
      emitAppEvent(AppEvents.GRID_REFRESH);

      // Refresh properties pane
      window.dispatchEvent(new CustomEvent("controls:metadata-refresh", {
        detail: { row: r, col: c },
      }));
    } catch (err) {
      // mountScript throws now (a declined Script Security prompt included), so
      // this is reachable for a reason the user caused and can undo.
      console.error("[Controls] Failed to apply template:", err);
      showToast(
        `The shape template could not be applied: ${err instanceof Error ? err.message : String(err)}`,
        { type: "error" },
      );
    } finally {
      applyingTemplates.delete(d.instanceId);
    }
  });
  cleanupFns.push(unsubApplyTemplate);

  // Handle shape:openTemplateGallery — open the template gallery overlay
  const unsubOpenGallery = onAppEvent("shape:openTemplateGallery", (detail) => {
    const d = detail as { instanceId: string };
    // The template gallery targets on-grid shapes only.
    if (!parseOnGridControlInstanceId(d.instanceId)) return;
    // Render the gallery as a React portal
    import("react-dom/client").then(({ createRoot }) => {
      import("react").then((React) => {
        import("./Shape/ShapeTemplateGallery").then(({ ShapeTemplateGallery }) => {
          const container = document.createElement("div");
          document.body.appendChild(container);
          const root = createRoot(container);
          const handleClose = () => {
            root.unmount();
            container.remove();
          };
          root.render(
            React.createElement(ShapeTemplateGallery, {
              onSelect: (tpl: { id: string }) => {
                emitAppEvent("shape:applyTemplate", { instanceId: d.instanceId, templateId: tpl.id });
              },
              onClose: handleClose,
            }),
          );
        });
      });
    });
  });
  cleanupFns.push(unsubOpenGallery);

  isActivated = true;
  console.log("[Controls] Activated successfully.");
}

// ============================================================================
// Insert Button Action (Floating by Default)
// ============================================================================

/**
 * Top-left pixel of a cell, in sheet coordinates (no scroll offset).
 *
 * Shared by the snap resolver and the pinned-control reposition pass so the two
 * can never disagree about where a cell starts. Walks per-column/per-row rather
 * than multiplying, because custom widths and heights make the grid irregular.
 */
function cellOriginPixels(row: number, col: number): { x: number; y: number } {
  const gridState = getGridStateSnapshot();
  if (!gridState) return { x: 0, y: 0 };
  const defaultCellWidth = gridState.config?.defaultCellWidth ?? 100;
  const defaultCellHeight = gridState.config?.defaultCellHeight ?? 24;
  const columnWidths = gridState.dimensions?.columnWidths ?? new Map();
  const rowHeights = gridState.dimensions?.rowHeights ?? new Map();

  let x = 0;
  for (let c = 0; c < col; c++) x += getColumnWidthSync(c, defaultCellWidth, columnWidths);
  let y = 0;
  for (let r = 0; r < row; r++) y += getRowHeightSync(r, defaultCellHeight, rowHeights);
  return { x, y };
}

/** The smallest button the anchored path makes, and the size of a positioned
 *  button nobody gave a size to. */
const BUTTON_MIN_WIDTH = 80;
const BUTTON_MIN_HEIGHT = 28;

/**
 * Create a floating button control — THE one place a button is made, for the
 * ribbon's "Insert Button" and for every @api caller that comes through the
 * ButtonControlProvider seam.
 *
 * It is one function on purpose. The recorded-macro "save as button" path used
 * to write its own control metadata and produced nothing visible, because a
 * button is three writes (backend metadata with the RIGHT property names,
 * floating-store registration, overlay region sync) and it only did the first.
 * Anything that duplicates this list drifts the next time a default changes.
 *
 * WHERE IT GOES. At the anchor cell's walked origin and at least the cell's
 * size — the historical path, unchanged — or, when the request gives `x`/`y`,
 * at exactly that point (a canvas sheet has no cells to walk). A request with a
 * position and no anchor gets one ALLOCATED inside the same serialised step as
 * the metadata write (`withControlAnchor`): a button REPLACES whatever an
 * occupied anchor holds, so an anchor chosen outside that step could wipe a
 * control another insert had just made.
 */
export async function createButtonControlAt(
  request: CreateButtonControlRequest,
): Promise<ButtonControlHandle> {
  const { getColumnWidth, getRowHeight } = await import("../../src/api/dimensions");
  const { getGridStateSnapshot } = await import("../../src/api/grid");

  const { sheetIndex } = request;
  const askedWidth = requestedSize("A button's width", request.width);
  const askedHeight = requestedSize("A button's height", request.height);

  return withControlAnchor(request, async ({ row, col }, position) => {
    let btnX: number;
    let btnY: number;
    let btnWidth: number;
    let btnHeight: number;
    if (position) {
      // Exactly where the caller asked. The anchor is identity only here, so
      // its cell's size says nothing about this button's.
      btnX = position.x;
      btnY = position.y;
      btnWidth = askedWidth ?? BUTTON_MIN_WIDTH;
      btnHeight = askedHeight ?? BUTTON_MIN_HEIGHT;
    } else {
      const gridState = getGridStateSnapshot();
      const defaultCellWidth = gridState?.config?.defaultCellWidth ?? 100;
      const defaultCellHeight = gridState?.config?.defaultCellHeight ?? 24;
      const columnWidths = gridState?.dimensions?.columnWidths ?? new Map();
      const rowHeights = gridState?.dimensions?.rowHeights ?? new Map();

      // Calculate pixel position from cell bounds (sheet coordinates, no scroll)
      let cellX = 0;
      for (let c = 0; c < col; c++) {
        cellX += getColumnWidth(c, defaultCellWidth, columnWidths);
      }
      let cellY = 0;
      for (let r = 0; r < row; r++) {
        cellY += getRowHeight(r, defaultCellHeight, rowHeights);
      }
      const cellWidth = getColumnWidth(col, defaultCellWidth, columnWidths);
      const cellHeight = getRowHeight(row, defaultCellHeight, rowHeights);

      btnX = cellX;
      btnY = cellY;
      // Button size: at least the cell size, with a reasonable minimum
      btnWidth = askedWidth ?? Math.max(cellWidth, BUTTON_MIN_WIDTH);
      btnHeight = askedHeight ?? Math.max(cellHeight, BUTTON_MIN_HEIGHT);
    }

    // Create control metadata with floating defaults
    await setControlMetadata(sheetIndex, row, col, {
      controlType: "button",
      properties: {
        text: { valueType: "static", value: request.label },
        fill: { valueType: "static", value: "#e0e0e0" },
        color: { valueType: "static", value: "#000000" },
        borderColor: { valueType: "static", value: "#999999" },
        fontSize: { valueType: "static", value: "11" },
        embedded: { valueType: "static", value: "false" },
        // Explicit: floating controls default UNPINNED, and the backend's
        // moves_with_cells defaults an ABSENT property to "moves" (the right
        // default for in-cell controls). Without writing it, the backend
        // shifted this control's anchor on row inserts while the frontend held
        // its pixels — divergence on the very first structural edit.
        pinToGrid: { valueType: "static", value: "false" },
        x: { valueType: "static", value: String(btnX) },
        y: { valueType: "static", value: String(btnY) },
        width: { valueType: "static", value: String(btnWidth) },
        height: { valueType: "static", value: String(btnHeight) },
        onSelect: { valueType: "static", value: request.onSelect ?? "" },
        tooltip: { valueType: "static", value: request.tooltip ?? "" },
        // LINK to a recorded macro by id, when asked. A macro-linked button holds
        // only this 12-byte reference — no copied body — and the run-mode click
        // path resolves+runs the CURRENT macro through @api/macroRunService. Only
        // written when present, so ordinary buttons stay free of the property.
        ...(request.macroRef
          ? { [MACRO_REF_PROPERTY]: { valueType: "static", value: request.macroRef } }
          : {}),
      },
    });

    // Add to floating store
    const controlId = makeFloatingControlId(sheetIndex, row, col);
    addFloatingControl({
      id: controlId,
      sheetIndex,
      row,
      col,
      x: btnX,
      y: btnY,
      width: btnWidth,
      height: btnHeight,
      controlType: "button",
    });

    // Sync overlay regions and refresh
    invalidateFloatingButtonCache(controlId);
    syncFloatingControlRegions();
    emitAppEvent(AppEvents.GRID_REFRESH);

    return {
      instanceId: controlId,
      sheetIndex,
      row,
      col,
      x: btnX,
      y: btnY,
      width: btnWidth,
      height: btnHeight,
    };
  });
}

/** Delete the control at an anchor cell. Mirrors createButtonControlAt so a
 *  caller whose second step failed can roll the button back cleanly. */
async function removeButtonControlAt(anchor: ButtonControlAnchor): Promise<void> {
  const { removeControlMetadata } = await import("./lib/controlApi");
  const { sheetIndex, row, col } = anchor;
  const controlId = makeFloatingControlId(sheetIndex, row, col);

  await removeControlMetadata(sheetIndex, row, col);
  removeFloatingControl(controlId);
  invalidateFloatingButtonCache(controlId);
  syncFloatingControlRegions();
  emitAppEvent(AppEvents.GRID_REFRESH);
}

// ============================================================================
// Picture Control Provider (@api/pictureControlService)
// ============================================================================

/**
 * Place a picture the document ALREADY HOLDS, for any caller that asks through
 * the feature-neutral seam (today: `api.createPicture` from the script broker,
 * and a canvas sheet's Insert Picture at a snapped rectangle).
 *
 * The one image argument is a `media:` handle, and this is a PLACEMENT path, not
 * an ingress: there is no parameter here that could carry bytes, a path or a
 * URL. Bytes enter a document through exactly one door — the user picking a file
 * in a native dialog, read and validated by the host — and this is not it.
 *
 * Two refusals, both deliberate:
 *
 *   * A `src` that is not a well-formed handle is a programming error, not a
 *     value to store. Storing it would leave the CSP as the only thing between a
 *     control property and a tracking beacon.
 *   * A handle this document cannot resolve produces NO control. A picture that
 *     can never paint is worse than an error: it is a permanent broken-image box
 *     the user has to hunt down and delete, created by an operation that
 *     reported success.
 *
 * WHERE IT GOES: the anchor cell's walked origin, or exactly `x`/`y` when the
 * request gives a position — with an anchor ALLOCATED, in the same serialised
 * step as the write, when it names none (`withControlAnchor`). Both refusals
 * run first, so a bad request never waits behind other inserts.
 */
export async function createPictureControlAt(
  request: CreatePictureControlRequest,
): Promise<PictureControlHandle> {
  const { sheetIndex, mediaRef } = request;

  if (!isMediaRef(mediaRef)) {
    throw new Error(
      `A picture's source must be a media handle ("media:" + 64 hex characters), not ${JSON.stringify(mediaRef)}. Import the image first — the handle comes back from the picker.`,
    );
  }

  // Ask the renderer, which resolves through the same single-flight cache the
  // paint uses: this costs the pull that was about to happen anyway.
  const natural = await getMediaNaturalSize(mediaRef);
  if (!natural) {
    throw new Error(
      `This workbook holds no image ${mediaRef}. A picture can only be placed for media already stored in the document.`,
    );
  }

  const { getColumnWidth, getRowHeight } = await import("../../src/api/dimensions");

  return withControlAnchor(request, async ({ row, col }, position) => {
    let picX: number;
    let picY: number;
    if (position) {
      picX = position.x;
      picY = position.y;
    } else {
      const gridState = getGridStateSnapshot();
      const defaultCellWidth = gridState?.config?.defaultCellWidth ?? 100;
      const defaultCellHeight = gridState?.config?.defaultCellHeight ?? 24;
      const columnWidths = gridState?.dimensions?.columnWidths ?? new Map();
      const rowHeights = gridState?.dimensions?.rowHeights ?? new Map();

      let cellX = 0;
      for (let c = 0; c < col; c++) {
        cellX += getColumnWidth(c, defaultCellWidth, columnWidths);
      }
      let cellY = 0;
      for (let r = 0; r < row; r++) {
        cellY += getRowHeight(r, defaultCellHeight, rowHeights);
      }
      picX = cellX;
      picY = cellY;
    }

    // A decode failure (natural size 0) after the bytes RESOLVED is not a reason
    // to refuse: the host already proved the header, so the picture exists and
    // will paint. `pictureLayoutSize` lays it out at the standard box instead.
    const { width, height } = pictureLayoutSize(request, natural);

    await setControlMetadata(sheetIndex, row, col, {
      controlType: "image",
      properties: {
        src: { valueType: "static", value: mediaRef },
        opacity: { valueType: "static", value: "1" },
        rotation: { valueType: "static", value: "0" },
        // Explicit unpinned — see the floating-button creation above.
        pinToGrid: { valueType: "static", value: "false" },
        x: { valueType: "static", value: String(picX) },
        y: { valueType: "static", value: String(picY) },
        width: { valueType: "static", value: String(width) },
        height: { valueType: "static", value: String(height) },
        // Only written when asked for: `listControls` reads this property for the
        // object list, and an empty one would name every picture "".
        ...(request.name ? { name: { valueType: "static", value: request.name } } : {}),
      },
    });

    const controlId = makeFloatingControlId(sheetIndex, row, col);
    addFloatingControl({
      id: controlId,
      sheetIndex,
      row,
      col,
      x: picX,
      y: picY,
      width,
      height,
      controlType: "image",
    });

    invalidateImageCache(controlId);
    syncFloatingControlRegions();
    emitAppEvent(AppEvents.GRID_REFRESH);

    return { instanceId: controlId, sheetIndex, row, col, x: picX, y: picY, width, height };
  });
}

/** Delete the control at an anchor (no-op when there is none). */
async function removePictureControlAt(anchor: PictureControlAnchor): Promise<void> {
  const { removeControlMetadata } = await import("./lib/controlApi");
  const { sheetIndex, row, col } = anchor;
  const controlId = makeFloatingControlId(sheetIndex, row, col);

  await removeControlMetadata(sheetIndex, row, col);
  removeFloatingControl(controlId);
  // Forget, not invalidate: the control is gone, so its picture's blob URL has
  // nothing left referencing it.
  forgetImageControl(controlId);
  syncFloatingControlRegions();
  emitAppEvent(AppEvents.GRID_REFRESH);
}

/**
 * Insert a button control on the current selection.
 * Creates a floating button positioned at the selected cell's location.
 */
async function insertButton(): Promise<void> {
  const { restoreFocusToGrid } = await import("../../src/api/events");
  const { getGridStateSnapshot } = await import("../../src/api/grid");

  // Get current selection -- unless another feature owns it (wave-B B8:
  // Core's selection is then a cell hidden under that object).
  const sel = insertAnchorOrRefuse("Insert Button", getCurrentSelectionFromInterceptor);
  if (!sel) return;

  // Get grid state for the active sheet
  const gridState = getGridStateSnapshot();
  if (!gridState) return;

  // A REFUSAL IS SAID, once -- as the shape insert says it. A sheet protected
  // against object edits refuses the button at the backend (wave-B B5), and
  // this menu action used to drop the rejection: nothing appeared and nothing
  // said why (found live 2026-09-29, e2e fixall-canvas B5).
  try {
    await createButtonControlAt({
      sheetIndex: gridState.sheetContext?.activeSheetIndex ?? 0,
      row: sel.endRow,
      col: sel.endCol,
      label: "Button",
    });
  } catch (err) {
    showToast(
      `The button could not be inserted: ${err instanceof Error ? err.message : String(err)}`,
      { type: "error", duration: 9000 },
    );
  }

  restoreFocusToGrid();
}

/** Helper to get selection from interceptors module. */
function getCurrentSelectionFromInterceptor() {
  return getCurrentSelection();
}

// ============================================================================
// Shape Controls Provider (@api/controlsService)
// ============================================================================

/** The shape catalog, flattened out of its categories — the feature-neutral
 *  answer to "what can createShape draw?". Built once: the catalog is a module
 *  constant, so nothing about it can change during a session. */
let flattenedShapeCatalog: ShapeCatalogEntry[] | null = null;

function listShapeCatalogEntries(): ShapeCatalogEntry[] {
  if (!flattenedShapeCatalog) {
    flattenedShapeCatalog = getShapeCategories().flatMap((cat) =>
      cat.shapes.map((s) => ({
        id: s.id,
        label: s.label,
        categoryId: cat.id,
        categoryLabel: cat.label,
        defaultWidth: s.defaultWidth,
        defaultHeight: s.defaultHeight,
        isLine: s.isLine === true,
      })),
    );
  }
  return flattenedShapeCatalog;
}

/**
 * Create a floating SHAPE — THE one place a shape is made, for the ribbon's
 * shape gallery and for every @api caller that comes through the
 * ControlsProvider seam.
 *
 * One recipe, two callers, for `createButtonControlAt`'s hard-won reason: a
 * shape is SEVENTEEN property keys, plus a pixel walk, plus three registrations,
 * and a caller that reproduces only some of them gets a successful backend
 * response and nothing on the grid. Three of those seventeen are load-bearing in
 * ways nobody guesses:
 *
 *   * `pinToGrid` is written EXPLICITLY as "false". The backend's
 *     `moves_with_cells` defaults an ABSENT pin property to TRUE (correct for
 *     in-cell controls), so omitting it makes the backend shift this control's
 *     anchor on the first row insert while the frontend holds its pixels —
 *     divergence on the very first structural edit.
 *   * The caption property is `text`, never `label`. Writing `label` succeeds
 *     and draws an empty shape; that exact bug shipped once, for buttons.
 *   * `x`/`y` are a per-column/per-row WALK, not `col * defaultWidth`. Column
 *     widths and row heights are irregular the moment a user resizes anything.
 *     The one exception is a request that gives its own `x`/`y` (a canvas
 *     sheet's snapped rectangle): then the shape goes exactly there.
 *
 * A request with a position and no anchor gets one ALLOCATED inside the same
 * serialised step as the metadata write (`withControlAnchor`), so two inserts
 * in flight can never be handed the same cell.
 *
 * TWO REFUSALS, both loud on purpose:
 *
 *   * An unknown `shapeType` THROWS, naming every id the catalog accepts. It
 *     used to `return` silently, which the caller cannot tell apart from a
 *     shape that was created and failed to paint.
 *   * An anchor that already holds a control THROWS rather than replacing it.
 *     `set_control_metadata` is a plain map insert, so creating over an occupied
 *     cell wipes the existing control — and because a control's instanceId is
 *     derived from its ANCHOR, the wiped control's object script stays bound to
 *     that id and the new control silently inherits someone else's code.
 */
export async function createShapeControlAt(
  request: CreateShapeControlRequest,
): Promise<ShapeControlHandle> {
  const { sheetIndex, shapeType } = request;

  const shapeDef = getShapeDefinition(shapeType);
  if (!shapeDef) {
    const ids = listShapeCatalogEntries().map((s) => s.id);
    throw new Error(
      `Unknown shape "${shapeType}". Calcula draws ${ids.length} shapes; ` +
        `the accepted ids are: ${ids.join(", ")}.`,
    );
  }

  return withControlAnchor(request, async ({ row, col }, position) => {
    // Inside the serialised step, so no other insert can claim this anchor
    // between the check and the write below.
    const { getControlMetadata } = await import("./lib/controlApi");
    const occupant = await getControlMetadata(sheetIndex, row, col);
    if (occupant) {
      throw new Error(
        `The cell at row ${row}, column ${col} on sheet ${sheetIndex} already holds a ` +
          `${occupant.controlType} control. One cell anchors at most one control, and a ` +
          `control's script binding is derived from its anchor — creating here would ` +
          `delete that control and hand its script to the new one. Delete it first, or ` +
          `choose an empty cell.`,
      );
    }

    const { x: shapeX, y: shapeY } = position ?? cellOriginPixels(row, col);
    const shapeWidth = request.width ?? shapeDef.defaultWidth;
    const shapeHeight = request.height ?? shapeDef.defaultHeight;

    // Create control metadata for the shape
    await setControlMetadata(sheetIndex, row, col, {
      controlType: "shape",
      properties: {
        shapeType: { valueType: "static", value: shapeType },
        fill: { valueType: "static", value: "#4472C4" },
        stroke: { valueType: "static", value: "#2F528F" },
        strokeWidth: { valueType: "static", value: "1" },
        // `text`, never `label` — see the header.
        text: { valueType: "static", value: request.text ?? "" },
        textColor: { valueType: "static", value: "#FFFFFF" },
        fontSize: { valueType: "static", value: "11" },
        fontBold: { valueType: "static", value: "false" },
        fontItalic: { valueType: "static", value: "false" },
        textAlign: { valueType: "static", value: "center" },
        opacity: { valueType: "static", value: "1" },
        rotation: { valueType: "static", value: "0" },
        // Explicit unpinned — see the floating-button creation above.
        pinToGrid: { valueType: "static", value: "false" },
        x: { valueType: "static", value: String(shapeX) },
        y: { valueType: "static", value: String(shapeY) },
        width: { valueType: "static", value: String(shapeWidth) },
        height: { valueType: "static", value: String(shapeHeight) },
        // Only written when asked for: `listControls` reads this property for the
        // object list, and an empty one would name every shape "".
        ...(request.name ? { name: { valueType: "static", value: request.name } } : {}),
      },
    });

    // Add to floating store
    const controlId = makeFloatingControlId(sheetIndex, row, col);
    addFloatingControl({
      id: controlId,
      sheetIndex,
      row,
      col,
      x: shapeX,
      y: shapeY,
      width: shapeWidth,
      height: shapeHeight,
      controlType: "shape",
    });

    // Sync overlay regions and refresh. The cache invalidate was MISSING from the
    // ribbon path: the shape renderer keys its bitmap cache by control id, and a
    // fresh control at an id a deleted one used to hold repainted the OLD shape.
    invalidateShapeCache(controlId);
    syncFloatingControlRegions();
    emitAppEvent(AppEvents.GRID_REFRESH);

    return {
      instanceId: controlId,
      shapeType,
      sheetIndex,
      row,
      col,
      x: shapeX,
      y: shapeY,
      width: shapeWidth,
      height: shapeHeight,
    };
  });
}

/**
 * Delete a control by its instance id, with the FULL teardown.
 *
 * Routes to `deleteFloatingControl`, never to `removeButtonControlAt`: that one
 * is the button seam's ROLLBACK for a half-made control and deliberately skips
 * object-script cleanup, declared properties, the HTML overlay, the selection
 * and the Properties pane. Using it as a delete path would leave exactly the
 * orphans this seam exists to avoid.
 *
 * Returns false when no control has that id; throws when a control exists at
 * that anchor but is not a floating one (an in-cell button, whose deletion is a
 * cell-style operation the user performs from the grid).
 *
 * A MISS IN THE STORE MEANS TWO DIFFERENT THINGS, and they must not share one
 * message. The floating store holds ONE SHEET at a time (see step 19c), so a
 * perfectly ordinary shape on a sheet the user is not looking at is also absent
 * from it. Telling that caller "this is an in-cell control" would be a confident
 * wrong answer to a question it never asked — so the two are separated by the
 * SAME embedded predicate `loadFloatingControls` uses to decide what enters the
 * store, and the cross-sheet case names the sheet and the fix.
 */
async function deleteControlByInstanceId(instanceId: string): Promise<boolean> {
  if (getFloatingControl(instanceId)) {
    await deleteFloatingControl(instanceId);
    return true;
  }

  const anchor = parseFloatingControlId(instanceId);
  if (!anchor) return false;

  const { getControlMetadata } = await import("./lib/controlApi");
  const meta = await getControlMetadata(anchor.sheetIndex, anchor.row, anchor.col);
  if (!meta) return false;

  if (!isEmbeddedControl(meta.controlType, meta.properties)) {
    throw new Error(
      `"${instanceId}" is on sheet ${anchor.sheetIndex}, which is not the sheet ` +
        `currently shown. On-grid controls are deleted on their own sheet — switch to ` +
        `it first.`,
    );
  }

  throw new Error(
    `"${instanceId}" is an in-cell ${meta.controlType} control, not a floating one. ` +
      `In-cell controls are part of their cell's formatting — clear the cell to remove one.`,
  );
}

// ============================================================================
// Insert Shape Action (Always Floating)
// ============================================================================

/**
 * Insert a shape control on the current selection.
 * Creates a floating shape positioned at the selected cell's location.
 *
 * The whole recipe lives in `createShapeControlAt`; this is the selection and
 * error-reporting wrapper around it. A refusal HAS to be shown: the gallery and
 * the menu both call this without awaiting, so an unhandled rejection would
 * leave the user watching nothing happen.
 */
async function insertShape(shapeType: string): Promise<void> {
  const { restoreFocusToGrid } = await import("../../src/api/events");

  // Get current selection -- unless another feature owns it (wave-B B8).
  const sel = insertAnchorOrRefuse("Insert Shape", getCurrentSelectionFromInterceptor);
  if (!sel) return;

  // Get grid state for the active sheet
  const gridState = getGridStateSnapshot();
  if (!gridState) return;

  try {
    await createShapeControlAt({
      sheetIndex: gridState.sheetContext?.activeSheetIndex ?? 0,
      row: sel.endRow,
      col: sel.endCol,
      shapeType,
    });
  } catch (err) {
    showToast(
      `The shape could not be inserted: ${err instanceof Error ? err.message : String(err)}`,
      { type: "error", duration: 9000 },
    );
  }

  restoreFocusToGrid();
}

// ============================================================================
// Insert Image Action (Always Floating)
// ============================================================================

/**
 * Insert an image control on the current selection.
 *
 * THE INGRESS, AND WHY IT LOOKS LIKE THIS
 *
 * What shipped before this: a hidden `<input type="file">` in the WebView,
 * `FileReader.readAsDataURL` over the whole file, and the resulting base64
 * stored verbatim as the control's `src`. No size cap, no format check, no
 * dimension check — `input.accept` is a dialog filter hint, and "All Files"
 * exists. A file that failed to decode fell back to a 200x150 placeholder over
 * bytes that were ALREADY in the document, and everything travelled on into the
 * saved `.cala` and into published `.calp` artifacts under the signature.
 *
 * Now: the user picks a file in the NATIVE dialog, the host reads it, proves the
 * format from its magic bytes, enforces the byte and dimension caps, files the
 * bytes under their content hash, and hands back a handle. The WebView never
 * sees the bytes and never produces any. Three consequences are deliberate:
 *
 *   * `src` holds a ~70-byte `media:{sha256}` handle, so `controls.json` stops
 *     carrying whole files and the 64 KiB property bound is never in danger.
 *   * The initial size comes from the HEADER the host parsed, not from decoding
 *     the picture in the WebView. There is no fallback size, because there is no
 *     case left where we hold a picture we could not read.
 *   * A refusal is a REFUSAL: the user is told which rule the file broke, by
 *     name and number, and NO control is created. Nothing is embedded.
 */
async function insertImage(): Promise<void> {
  const { restoreFocusToGrid } = await import("../../src/api/events");
  const { getGridStateSnapshot } = await import("../../src/api/grid");
  const { getColumnWidth, getRowHeight } = await import("../../src/api/dimensions");

  // The selection owner is asked FIRST (wave-B B8): while another feature owns
  // the selection there is no anchor to place a picture at, and choosing a file
  // only to be refused afterwards would waste the user's pick.
  if (refuseIfSelectionOwned("Insert Image")) {
    restoreFocusToGrid();
    return;
  }

  // The NATIVE picker, because the host needs a PATH: a WebView `<input
  // type="file">` yields a File object whose bytes only the WebView can read,
  // which is precisely the ingress being retired. `pickValidatedImage` returns
  // null for BOTH a cancel and a refusal — and in the refusal case has already
  // told the user which rule the file broke. Either way: create nothing.
  const media = await pickValidatedImage();
  if (!media) {
    restoreFocusToGrid();
    return;
  }

  // Get current selection -- asked again: the picker was open in between.
  const sel = insertAnchorOrRefuse("Insert Image", getCurrentSelectionFromInterceptor);
  if (!sel) return;

  const row = sel.endRow;
  const col = sel.endCol;

  // Get grid state for position calculation
  const gridState = getGridStateSnapshot();
  if (!gridState) return;

  const sheetIndex = gridState.sheetContext?.activeSheetIndex ?? 0;
  const defaultCellWidth = gridState.config?.defaultCellWidth ?? 100;
  const defaultCellHeight = gridState.config?.defaultCellHeight ?? 24;
  const columnWidths = gridState.dimensions?.columnWidths ?? new Map();
  const rowHeights = gridState.dimensions?.rowHeights ?? new Map();

  // Calculate pixel position from cell bounds (sheet coordinates, no scroll)
  let cellX = 0;
  for (let c = 0; c < col; c++) {
    cellX += getColumnWidth(c, defaultCellWidth, columnWidths);
  }
  let cellY = 0;
  for (let r = 0; r < row; r++) {
    cellY += getRowHeight(r, defaultCellHeight, rowHeights);
  }

  // Initial size comes from the HEADER the host parsed — no decode in the
  // WebView, and no `{200, 150}` fallback (that fallback is what turned "this
  // file is not an image" into "here is a placeholder over the file anyway").
  const { width: imgWidth, height: imgHeight } = initialImageSize(media.width, media.height);

  // Create control metadata for the image. `src` is the HANDLE — the bytes are
  // in the document's media store and never enter `controls.json`, a script
  // realm, or an IPC payload. A backend refusal here (the 64 KiB property
  // bound, a lock failure) still has to be shown: `MenuBar.tsx` calls
  // `item.action()` without awaiting, so an unhandled rejection would leave the
  // user watching nothing happen.
  try {
    await setControlMetadata(sheetIndex, row, col, {
      controlType: "image",
      properties: {
        src: { valueType: "static", value: media.ref },
        opacity: { valueType: "static", value: "1" },
        rotation: { valueType: "static", value: "0" },
        // Explicit unpinned — see the floating-button creation above.
        pinToGrid: { valueType: "static", value: "false" },
        x: { valueType: "static", value: String(cellX) },
        y: { valueType: "static", value: String(cellY) },
        width: { valueType: "static", value: String(imgWidth) },
        height: { valueType: "static", value: String(imgHeight) },
      },
    });
  } catch (err) {
    const { showToast } = await import("../../src/api/notifications");
    showToast(
      `The image could not be inserted: ${err instanceof Error ? err.message : String(err)}`,
      { type: "error", duration: 9000 },
    );
    restoreFocusToGrid();
    return;
  }

  // Add to floating store
  const controlId = makeFloatingControlId(sheetIndex, row, col);
  addFloatingControl({
    id: controlId,
    sheetIndex,
    row,
    col,
    x: cellX,
    y: cellY,
    width: imgWidth,
    height: imgHeight,
    controlType: "image",
  });

  // Sync overlay regions and refresh
  syncFloatingControlRegions();
  emitAppEvent(AppEvents.GRID_REFRESH);
  restoreFocusToGrid();
}

// `pickImageFile` (hidden `<input type="file">` + `FileReader.readAsDataURL`)
// and `getImageNaturalSize` (decode-in-WebView, `{200, 150}` on failure) used to
// live here. Both are deleted rather than deprecated: they were the unvalidated
// ingress and its silent-failure mode. The picker is now the native dialog via
// `importImageViaPicker`, and the dimensions come from the header the host
// parsed. There is deliberately no remaining function in this extension that
// turns a file into bytes inside the WebView.

// ============================================================================
// Delete Floating Control
// ============================================================================

/**
 * Delete a floating control by its store ID.
 * Removes from in-memory store, backend metadata, and refreshes the grid.
 */
async function deleteFloatingControl(controlId: string): Promise<void> {
  const ctrl = getFloatingControl(controlId);
  if (!ctrl) return;

  const { removeControlMetadata } = await import("./lib/controlApi");

  // THE BACKEND FIRST (wave-B B6, `runFloatingControlDelete`). The script and
  // the side tables used to go before the backend was asked, so a REFUSED
  // delete (a sheet protecting its objects) left the control standing with its
  // script gone. A refusal now rejects before anything below is touched.
  await runFloatingControlDelete({
    removeMetadata: () => removeControlMetadata(ctrl.sheetIndex, ctrl.row, ctrl.col),

    // Instance-keyed cleanup: scripts, declared properties, custom renderers,
    // HTML overlays.
    //
    // THIS USED TO BE GATED ON `controlType === "shape"`, and that gate leaked a
    // control's OBJECT SCRIPT on every other type. An instanceId is derived from
    // the ANCHOR, so a button deleted at B3 left `control-0-2-1`'s script behind,
    // and the next control created at B3 — a button, a picture, anything —
    // silently INHERITED it: code the new control's author never wrote, running on
    // their click. The side tables below are keyed by the same id and have the
    // same failure mode. Nothing here is shape-specific; deleting an entry that
    // does not exist is a no-op for every one of them, so the honest gate is no
    // gate at all.
    deleteScripts: async () => {
      const { deleteObjectScriptsForInstance } = await import("../../src/api/objectScriptBackend");
      await deleteObjectScriptsForInstance(controlId);
    },
    clearSideTables: () => {
      clearDeclaredProperties(controlId);
      removeCustomCanvasRenderer(controlId);
      removeShapeHtmlOverlay(controlId);
      unmarkShapeHasScript(controlId);
    },

    finish: async () => {
      // Remove from in-memory store
      removeFloatingControl(controlId);

      // Clear selection and close properties pane
      deselectFloatingControl();
      const { closeTaskPane: closeTP } = await import("../../src/api/ui");
      closeTP(PROPERTIES_PANE_ID);
      lastPropertiesCell = null;

      // Invalidate caches and refresh. The image cache is FORGOTTEN rather than
      // marked stale: the control is gone, so the blob URL held for its picture has
      // nothing left pointing at it and must be revoked, not re-fetched.
      invalidateFloatingButtonCache(controlId);
      invalidateShapeCache(controlId);
      forgetImageControl(controlId);
      syncFloatingControlRegions();
      emitAppEvent(AppEvents.GRID_REFRESH);
    },
  });
}

// ============================================================================
// Delete Selected Controls (Multi-select / Group aware)
// ============================================================================

/**
 * Delete all currently selected floating controls.
 * If a grouped control is selected, all group members are also deleted.
 */
async function deleteSelectedControls(): Promise<void> {
  const selectedIds = getSelectedFloatingControls();
  if (selectedIds.size === 0) return;

  // A canvas MULTI-selection that also holds objects of other families (a
  // chart, a slicer) is deleted WHOLE, as one undo step
  // (@api/objectSelection `deleteSelectedObjects`, which hands Controls its
  // share back through `deleteControlsWithGroups`). Deleting only the controls
  // left the rest selected and standing (open-items 2.af row 1). CANVAS ONLY
  // (the seam's one rule): a worksheet keeps every family's own Delete.
  if (shouldActOnWholeObjectSelection()) {
    await deleteSelectedObjects();
    return;
  }

  try {
    await deleteControlsWithGroups([...selectedIds]);
  } catch (err) {
    // The backend REFUSED (wave-B B5/B6: a sheet protecting its objects). The
    // control stands, with everything that hangs off it; say why, once.
    showToast(`The control could not be deleted: ${err instanceof Error ? err.message : String(err)}`, {
      type: "error",
    });
  }
}

/**
 * Delete these controls and, for each grouped one, its whole group -- the
 * rule Controls' Delete has always followed. Resolves when every backend
 * delete has landed.
 */
async function deleteControlsWithGroups(controlIds: readonly string[]): Promise<void> {
  // Collect all IDs to delete (expand groups)
  const idsToDelete = new Set<string>();
  for (const id of controlIds) {
    idsToDelete.add(id);
    const groupId = getGroupForControl(id);
    if (groupId) {
      for (const memberId of getGroupMembers(groupId)) {
        idsToDelete.add(memberId);
      }
    }
  }

  // Delete each control
  for (const id of idsToDelete) {
    await deleteFloatingControl(id);
  }
}

// ============================================================================
// Group / Multi-Selection Helpers
// ============================================================================

/**
 * Get the full set of control IDs that should co-move with a dragged control.
 * This includes: the control itself, all group members if grouped,
 * and all other selected controls (multi-select).
 */
function getCoMovingControlIds(controlId: string): Set<string> {
  const ids = new Set<string>();
  ids.add(controlId);

  // Add group members
  const groupId = getGroupForControl(controlId);
  if (groupId) {
    for (const memberId of getGroupMembers(groupId)) {
      ids.add(memberId);
    }
  }

  // Add all selected controls
  const selected = getSelectedFloatingControls();
  for (const selId of selected) {
    ids.add(selId);
    // Also add group members of selected controls
    const selGroupId = getGroupForControl(selId);
    if (selGroupId) {
      for (const memberId of getGroupMembers(selGroupId)) {
        ids.add(memberId);
      }
    }
  }

  return ids;
}

// ============================================================================
// Floating Object Event Handlers
// ============================================================================

function setupFloatingObjectEvents(): void {
  // Handle floating object selection (mousedown on floating control body)
  const handleFloatingSelected = (e: Event) => {
    const detail = (e as CustomEvent).detail;
    if (detail.regionType !== "floating-control") return;

    const controlId = detail.regionId as string;
    const controlRow = detail.data?.row as number;
    const controlCol = detail.data?.col as number;
    const controlSheet = detail.data?.sheetIndex as number;
    const ctrlKey = detail.ctrlKey === true;

    const ctrlType = detail.data?.controlType ?? "button";

    if (getDesignMode() || ctrlType === "shape" || ctrlType === "image") {
      // Design mode, shape, or image: select the control and show properties
      // (shapes and images are always selectable regardless of design mode)

      // A button clicked in Design Mode gets SELECTED, not run. That branch was
      // silent, so a user who left Design Mode on an hour ago clicks their macro
      // button and sees nothing happen — with no way to guess why. A save-time
      // hint cannot reach them; the click has to say it. Throttled, because
      // arranging controls is a legitimate reason to click many of them.
      if (ctrlType === "button" && getDesignMode()) {
        announceDesignModeClick();
      }

      if (ctrlKey) {
        // Ctrl+Click: toggle selection (multi-select)
        toggleFloatingControlSelection(controlId);
      } else {
        // Normal click: check if this control belongs to a group
        const groupId = getGroupForControl(controlId);
        if (groupId && !isFloatingControlSelected(controlId)) {
          // Select all members of the group
          const memberIds = getGroupMembers(groupId);
          selectFloatingControls(memberIds);
        } else if (!isFloatingControlSelected(controlId)) {
          // Single select (replace)
          selectFloatingControl(controlId);
        }
        // If already selected (and no Ctrl), keep selection as is for dragging
      }

      // Show properties pane for the clicked control (even in multi-select)
      lastPropertiesCell = { row: controlRow, col: controlCol };
      import("../../src/api/ui").then(({ openTaskPane: openTP }) => {
        openTP(PROPERTIES_PANE_ID, {
          row: controlRow,
          col: controlCol,
          sheetIndex: controlSheet,
          controlType: ctrlType,
        });
      });
      emitAppEvent(AppEvents.GRID_REFRESH);
      // Emit shape click event for scriptable objects
      if (ctrlType === "shape") {
        emitAppEvent("shape:clicked", { instanceId: controlId, x: 0, y: 0 });
      }
    } else {
      // Run mode: only buttons execute scripts
      if (ctrlType === "button") {
        // Fire the scriptable button's onClick hook (the #1 VBA entry point)
        // FIRST, synchronously, so a mounted object script starts without
        // waiting on the metadata round trip the inline path needs.
        emitAppEvent("button:clicked", { instanceId: controlId, x: 0, y: 0 });
        // Not fire-and-forget: an unhandled rejection here used to be the whole
        // story a user got for a button that did nothing.
        void runFloatingButtonClick(
          controlSheet,
          controlRow,
          controlCol,
          controlId,
        ).catch((err) => {
          showToast(
            `The button could not run: ${err instanceof Error ? err.message : String(err)}`,
            { type: "error" },
          );
        });
      }
      // Emit shape click event for scriptable objects (run mode too)
      if (ctrlType === "shape") {
        emitAppEvent("shape:clicked", { instanceId: controlId, x: 0, y: 0 });
      }
    }
  };
  window.addEventListener("floatingObject:selected", handleFloatingSelected);
  cleanupFns.push(() => window.removeEventListener("floatingObject:selected", handleFloatingSelected));

  // THE PRESS-TIME PICTURE of a control-led drag (lib/controlCoMove.ts): every
  // control the drag moves (the rest of the selection, the dragged control's
  // group) where it was when the drag began. Taken at the drag's first preview
  // frame -- BEFORE the lead moves -- and dropped at its moveComplete and at
  // every press, so a click that never became a drag leaves nothing behind for
  // the next one. Each frame then places a co-moved control at its press-time
  // rect shifted by the lead's TOTAL (snapped) move, through the seam's one
  // co-move rule: kept on a canvas page, a locked control stays put -- the
  // rule a Core-led canvas group drag applies. It used to add each frame's
  // increment to the current position and clamp at 0 only, which pushed
  // members off the page, moved locked ones, and drifted after an edge.
  let controlDrag: ControlDragSnapshot | null = null;
  const dropControlDrag = () => {
    controlDrag = null;
  };
  window.addEventListener("floatingObject:selected", dropControlDrag);
  cleanupFns.push(() => window.removeEventListener("floatingObject:selected", dropControlDrag));

  /** The drag's snapshot for `controlId`, taken now when this is its first frame. */
  const controlDragFor = (controlId: string): ControlDragSnapshot => {
    if (!controlDrag || controlDrag.leadId !== controlId) {
      controlDrag = snapshotControlDrag(controlId, getCoMovingControlIds(controlId), (id) => {
        const c = getFloatingControl(id);
        return c ? { x: c.x, y: c.y, width: c.width, height: c.height } : null;
      });
    }
    return controlDrag;
  };

  /**
   * Put every co-moved control where the lead's current position says; returns
   * the ids that ended somewhere other than where the drag found them.
   */
  const placeCoMovedControls = (
    snapshot: ControlDragSnapshot,
    controlId: string,
    recalcPinned: boolean,
  ): string[] => {
    const lead = getFloatingControl(controlId);
    if (!lead) return [];
    const moved: string[] = [];
    const positions = coMovedControlPositions(
      snapshot,
      { x: lead.x, y: lead.y },
      lead.sheetIndex,
      (id) => getGridRegions().find((r) => r.id === id) ?? null,
    );
    for (const [otherId, at] of positions) {
      if (!getFloatingControl(otherId)) continue;
      moveFloatingControl(otherId, at.x, at.y);
      if (recalcPinned) recalcPinnedOffset(otherId, cellOriginPixels);
      const from = snapshot.rects.get(otherId);
      if (!from || from.x !== at.x || from.y !== at.y) moved.push(otherId);
    }
    return moved;
  };

  // Handle floating object move preview (live position during drag)
  const handleMovePreview = (e: Event) => {
    const detail = (e as CustomEvent).detail;
    if (detail.regionType !== "floating-control") return;

    const controlId = detail.regionId as string;
    const newX = detail.x as number;
    const newY = detail.y as number;

    if (!getFloatingControl(controlId)) return;
    // Before the lead moves: the first frame of a drag takes the picture.
    const snapshot = controlDragFor(controlId);

    // Move the dragged control
    moveFloatingControl(controlId, newX, newY);
    // Re-derive the offset from the anchor so a later row/column resize
    // replays where the user actually put it, not a stale value.
    recalcPinnedOffset(controlId, cellOriginPixels);

    // Every other selected/grouped control follows the lead's EFFECTIVE total
    // move, measured after snapping (a pinned lead snaps to cell boundaries,
    // so raw-pointer deltas differ from how far it actually moved).
    placeCoMovedControls(snapshot, controlId, true);

    syncFloatingControlRegions();
    emitAppEvent(AppEvents.GRID_REFRESH);
  };
  window.addEventListener("floatingObject:movePreview", handleMovePreview);
  cleanupFns.push(() => window.removeEventListener("floatingObject:movePreview", handleMovePreview));

  // Handle floating object move complete
  const handleMoveComplete = (e: Event) => {
    const detail = (e as CustomEvent).detail;
    if (detail.regionType !== "floating-control") return;

    const controlId = detail.regionId as string;
    const newX = detail.x as number;
    const newY = detail.y as number;

    if (!getFloatingControl(controlId)) {
      controlDrag = null;
      return;
    }
    // The drag's press-time picture (taken now if no preview frame took it).
    const snapshot = controlDragFor(controlId);
    controlDrag = null;

    // Move the dragged control
    moveFloatingControl(controlId, newX, newY);
    recalcPinnedOffset(controlId, cellOriginPixels);

    // Same rule as the move preview above: the co-moved controls follow the
    // lead's total move from where the drag found them.
    const moved = placeCoMovedControls(snapshot, controlId, true);

    syncFloatingControlRegions();

    // Persist every control that moved in ONE batch (one undo step). A locked
    // or edge-bound member that ended where it started is not rewritten.
    void persistFloatingGeometry([controlId, ...moved]);

    emitAppEvent(AppEvents.GRID_REFRESH);
  };
  window.addEventListener("floatingObject:moveComplete", handleMoveComplete);
  cleanupFns.push(() => window.removeEventListener("floatingObject:moveComplete", handleMoveComplete));

  // Handle floating object resize preview (group-aware)
  const handleResizePreview = (e: Event) => {
    const detail = (e as CustomEvent).detail;
    if (detail.regionType !== "floating-control") return;

    const controlId = detail.regionId as string;
    const groupId = getGroupForControl(controlId);

    if (groupId) {
      // For grouped controls, compute scale from the dragged control's old vs new bounds
      // and apply proportionally to all group members
      const oldCtrl = getFloatingControl(controlId);
      if (oldCtrl) {
        const scaleX = oldCtrl.width > 0 ? (detail.width as number) / oldCtrl.width : 1;
        const scaleY = oldCtrl.height > 0 ? (detail.height as number) / oldCtrl.height : 1;
        const deltaX = (detail.x as number) - oldCtrl.x;
        const deltaY = (detail.y as number) - oldCtrl.y;

        const members = getGroupMembers(groupId);
        for (const memberId of members) {
          if (memberId === controlId) continue;
          const member = getFloatingControl(memberId);
          if (!member) continue;

          // Apply position delta and scale
          const relX = member.x - oldCtrl.x;
          const relY = member.y - oldCtrl.y;
          resizeFloatingControl(
            memberId,
            oldCtrl.x + deltaX + relX * scaleX,
            oldCtrl.y + deltaY + relY * scaleY,
            Math.max(10, member.width * scaleX),
            Math.max(10, member.height * scaleY),
          );
        }
      }
    }

    resizeFloatingControl(controlId, detail.x, detail.y, detail.width, detail.height);
    syncFloatingControlRegions();
    emitAppEvent(AppEvents.GRID_REFRESH);
  };
  window.addEventListener("floatingObject:resizePreview", handleResizePreview);
  cleanupFns.push(() => window.removeEventListener("floatingObject:resizePreview", handleResizePreview));

  // Handle floating object resize complete (group-aware)
  const handleResizeComplete = (e: Event) => {
    const detail = (e as CustomEvent).detail;
    if (detail.regionType !== "floating-control") return;

    const controlId = detail.regionId as string;
    const groupId = getGroupForControl(controlId);
    // Every control this resize changed: persisted as ONE batch below.
    const resizedIds: string[] = [];

    if (groupId) {
      const oldCtrl = getFloatingControl(controlId);
      if (oldCtrl) {
        const scaleX = oldCtrl.width > 0 ? (detail.width as number) / oldCtrl.width : 1;
        const scaleY = oldCtrl.height > 0 ? (detail.height as number) / oldCtrl.height : 1;
        const deltaX = (detail.x as number) - oldCtrl.x;
        const deltaY = (detail.y as number) - oldCtrl.y;

        const members = getGroupMembers(groupId);
        for (const memberId of members) {
          if (memberId === controlId) continue;
          const member = getFloatingControl(memberId);
          if (!member) continue;

          const relX = member.x - oldCtrl.x;
          const relY = member.y - oldCtrl.y;
          resizeFloatingControl(
            memberId,
            oldCtrl.x + deltaX + relX * scaleX,
            oldCtrl.y + deltaY + relY * scaleY,
            Math.max(10, member.width * scaleX),
            Math.max(10, member.height * scaleY),
          );
          invalidateFloatingButtonCache(memberId);
          invalidateShapeCache(memberId);
          invalidateImageCache(memberId);
          resizedIds.push(memberId);
        }
      }
    }

    resizeFloatingControl(controlId, detail.x, detail.y, detail.width, detail.height);
    syncFloatingControlRegions();
    invalidateFloatingButtonCache(controlId);
    invalidateShapeCache(controlId);
    invalidateImageCache(controlId);
    // Persist the new geometry of the control and its group in ONE batch.
    void persistFloatingGeometry([controlId, ...resizedIds]);
    emitAppEvent(AppEvents.GRID_REFRESH);
  };
  window.addEventListener("floatingObject:resizeComplete", handleResizeComplete);
  cleanupFns.push(() => window.removeEventListener("floatingObject:resizeComplete", handleResizeComplete));
}

/** Tell the Properties pane to re-read the metadata of these controls. */
function announceMetadataRefresh(controlIds: readonly string[]): void {
  for (const id of controlIds) {
    const ctrl = getFloatingControl(id);
    if (!ctrl) continue;
    window.dispatchEvent(new CustomEvent("controls:metadata-refresh", {
      detail: { row: ctrl.row, col: ctrl.col },
    }));
  }
}

/**
 * Persist the CURRENT geometry of every control of one gesture as ONE
 * `set_control_geometry` batch: one backend call, one undo record (a drag of
 * three co-selected controls is one Ctrl+Z, and a canvas group drag's open
 * transaction is joined so the whole gesture stays one step), atomic. It used
 * to be four to six `set_control_property` calls PER CONTROL, none undoable.
 *
 * The batch carries x / y / width / height and, for a pinned control, both
 * offsets -- persisting only the pixel position regressed the offsets to zero
 * on reload, snapping the control onto its anchor's corner.
 *
 * A refused batch (a protected sheet that disallows editing objects) wrote
 * nothing: the controls are re-read from the backend -- they go back where the
 * workbook has them -- and the user is told ONCE. Resolves true when it landed.
 */
async function persistFloatingGeometry(controlIds: readonly string[]): Promise<boolean> {
  const changes = controlGeometryChangesOf(controlIds);
  if (changes.length === 0) return true;
  try {
    await joinUndoTransaction(() => setControlGeometry(changes));
  } catch (err) {
    console.error("[Controls] The backend refused the control geometry batch:", err);
    await reloadControlsAfterRefusal?.();
    const what = changes.length === 1 ? "The control" : `${changes.length} controls`;
    showToast(
      `${what} could not be moved: ${err instanceof Error ? err.message : String(err)}`,
      { type: "error", duration: 8000 },
    );
    return false;
  }
  announceMetadataRefresh(controlIds);
  return true;
}

/**
 * Update a floating control's bounds from its backend metadata.
 * Called when width/height are changed from the PropertiesPane.
 */
async function updateFloatingBoundsFromMetadata(
  sheetIndex: number,
  row: number,
  col: number,
): Promise<void> {
  const controlId = makeFloatingControlId(sheetIndex, row, col);
  const ctrl = getFloatingControl(controlId);
  if (!ctrl) return;

  const metadata = await getControlMetadata(sheetIndex, row, col);
  if (!metadata) return;

  const newWidth = parseFloat(metadata.properties.width?.value ?? String(ctrl.width));
  const newHeight = parseFloat(metadata.properties.height?.value ?? String(ctrl.height));

  if (!isNaN(newWidth) && newWidth > 0) ctrl.width = newWidth;
  if (!isNaN(newHeight) && newHeight > 0) ctrl.height = newHeight;

  resizeFloatingControl(controlId, ctrl.x, ctrl.y, ctrl.width, ctrl.height);
  syncFloatingControlRegions();
  invalidateFloatingButtonCache(controlId);
  emitAppEvent(AppEvents.GRID_REFRESH);
}

/** Last time the Design-Mode explanation was shown (throttle, ms since epoch). */
let lastDesignModeNoticeAt = 0;

/** Tell the user, at most once every few seconds, why their click selected
 *  instead of ran. */
function announceDesignModeClick(): void {
  const now = Date.now();
  if (now - lastDesignModeNoticeAt < 4000) return;
  lastDesignModeNoticeAt = now;
  showToast(
    "Design Mode is on, so clicking a button selects it instead of running it. " +
      "Turn it off (Developer ▸ Design Mode) to run the button's macro.",
    { type: "info" },
  );
}

/**
 * Execute a floating button's OnSelect action.
 * The onSelect value is inline code that runs directly in the script engine.
 * Custom script modules from the Script Editor are available as callable functions.
 *
 * Returns whether inline source actually RAN, so the caller can tell "this
 * button did something" apart from "this button has no inline action" — the
 * distinction the no-op diagnosis below is built on. Throws on failure rather
 * than logging: the caller turns it into a message the user can read.
 */
/**
 * Read the `macroRef` link off a control, or null when it carries none.
 *
 * A non-empty value is the module id of the recorded macro this button LINKS —
 * the sole thing a macro-linked button stores. An empty string is treated as no
 * link (it is how an ordinary button's absent property would read if ever set).
 */
async function readMacroRef(
  sheetIndex: number,
  row: number,
  col: number,
): Promise<string | null> {
  const metadata = await getControlMetadata(sheetIndex, row, col);
  const ref = metadata?.properties[MACRO_REF_PROPERTY]?.value;
  return ref && ref.length > 0 ? ref : null;
}

async function executeFloatingButtonAction(
  sheetIndex: number,
  row: number,
  col: number,
): Promise<boolean> {
  const metadata = await getControlMetadata(sheetIndex, row, col);
  if (!metadata) return false;

  const onSelect = metadata.properties["onSelect"];
  if (!onSelect || !onSelect.value) return false;

  // ONE RULE, shared with the in-cell button path and the button cell type:
  // the user's OWN modules are prepended as callable functions; a module that
  // arrived in an application is never spliced into anything, and an inline
  // action that is exactly an invocation of one runs that module's stored source
  // unchanged so the Rust consent gate can rule on it.
  // See extensions/_shared/lib/buttonScriptRun.ts.
  const plan = planInlineButtonRun(onSelect.value, await loadButtonScriptModules());
  if (plan.kind === "refuse") {
    throw new Error(plan.message);
  }
  reportUnavailableButtonModules(plan.unavailable);
  const result = await runWorkbookScript(plan.source, plan.filename);
  if (result.type === "error") {
    throw new Error(result.message);
  }
  // Refresh unconditionally on success: `cellsModified > 0` is the backend's
  // count of cells IT wrote, and a script can change the grid through paths it
  // does not tally. A redundant refetch costs one round trip; a missed one
  // leaves the user looking at stale numbers and calling the button broken.
  window.dispatchEvent(new CustomEvent("grid:refresh"));
  return true;
}

/**
 * A run-mode click on a floating button: run whatever is bound to it, and — if
 * NOTHING is — say so.
 *
 * "Nothing happened" has been the report on this feature twice. A click that
 * finds no inline action and no mounted object script is not a quiet no-op; it
 * is the single most informative moment available, because the user is looking
 * right at the control they expected to work. Each branch names the cause and
 * what to do about it.
 */
async function runFloatingButtonClick(
  sheetIndex: number,
  row: number,
  col: number,
  instanceId: string,
): Promise<void> {
  // THE LINK MODEL, CHECKED FIRST. A button that carries `macroRef` runs the
  // CURRENT recorded macro of that id through @api/macroRunService — there is no
  // copied body on the button, and no object script to mount. This branch RETURNS
  // (it never falls through to the inline/object-script paths below), so a
  // macro-linked button runs exactly once, and every outcome — including "the
  // macro is gone" — is voiced, never silent.
  const macroRef = await readMacroRef(sheetIndex, row, col);
  if (macroRef) {
    if (!hasMacroRunProvider()) {
      // The macro exists (or not) but nothing can run one: the Macro Recorder is
      // not loaded. Say so with the specific remedy rather than a generic error.
      const diag = macroRunnerUnavailableDiagnosis(
        `This button links the recorded macro "${macroRef}", but the Macro Recorder ` +
          "extension is not loaded, so nothing can run it. Enable it and try again.",
      );
      showToast(diag.message, { type: diag.variant });
      return;
    }
    const outcome = await requireMacroRunProvider().runMacroByRef(macroRef);
    if (outcome.status === "notFound") {
      const diag = orphanMacroDiagnosis(outcome.macroId);
      showToast(diag.message, { type: diag.variant });
    } else if (outcome.status === "failed") {
      showToast(`"${outcome.name}" failed: ${outcome.message}`, { type: "error" });
    } else {
      // The macro ran. It drives the grid through paths Controls does not tally,
      // so refetch unconditionally — the same reason the inline path refreshes.
      window.dispatchEvent(new CustomEvent("grid:refresh"));
    }
    return;
  }

  const ranInline = await executeFloatingButtonAction(sheetIndex, row, col);

  // Dynamic, like the other ObjectScriptManager use in this file: the script
  // host pulls in the worker bootstrap, and Controls activates long before any
  // script does.
  const { ObjectScriptManager, mountedScriptHasHook } = await import("@api");
  const script = ObjectScriptManager.getScript("button", instanceId);
  const mounted = script ? ObjectScriptManager.isScriptMounted(script.id) : false;

  const diagnosis = diagnoseButtonClick({
    ranInline,
    script: script ? { id: script.id, name: script.name } : null,
    mounted,
    hasClickHandler:
      script && mounted ? mountedScriptHasHook(script.id, "button.onClick") : false,
  });
  if (diagnosis) showToast(diagnosis.message, { type: diagnosis.variant });
}

// ============================================================================
// Embedded <-> Floating Toggle
// ============================================================================

/**
 * Handle toggling the embedded property for a button control.
 */
async function handleEmbeddedToggle(
  sheetIndex: number,
  row: number,
  col: number,
  embedded: boolean,
): Promise<void> {
  const { applyFormatting, updateCell } = await import("../../src/api/lib");
  const { getGridStateSnapshot, getCellFromPixel } = await import("../../src/api/grid");
  const { getColumnWidth, getRowHeight } = await import("../../src/api/dimensions");
  const { setControlProperty } = await import("./lib/controlApi");
  const { openTaskPane: openTP } = await import("../../src/api/ui");

  const controlId = makeFloatingControlId(sheetIndex, row, col);

  if (embedded) {
    // ---- FLOATING -> EMBEDDED ----
    const ctrl = getFloatingControl(controlId);
    if (!ctrl) return;

    // Find the cell at the button's center
    const gridState = getGridStateSnapshot();
    if (!gridState) return;

    const centerX = ctrl.x + ctrl.width / 2;
    const centerY = ctrl.y + ctrl.height / 2;

    // Convert sheet coords to canvas coords for getCellFromPixel
    const rhw = gridState.config?.rowHeaderWidth ?? 50;
    const chh = gridState.config?.colHeaderHeight ?? 24;
    const canvasX = rhw + centerX - gridState.viewport.scrollX;
    const canvasY = chh + centerY - gridState.viewport.scrollY;

    const targetCell = getCellFromPixel(
      canvasX,
      canvasY,
      gridState.config,
      gridState.viewport,
      gridState.dimensions,
    );

    const targetRow = targetCell?.row ?? row;
    const targetCol = targetCell?.col ?? col;

    // Apply button formatting to the target cell
    await applyFormatting([targetRow], [targetCol], { button: true });

    // Get the button text from metadata to set as cell value
    const meta = await getControlMetadata(sheetIndex, row, col);
    const buttonText = meta?.properties?.text?.value ?? "Button";
    await updateCell(targetRow, targetCol, buttonText);

    // If the target cell changed, move metadata
    if (targetRow !== row || targetCol !== col) {
      // Create metadata at new location
      if (meta) {
        meta.properties.embedded = { valueType: "static", value: "true" };
        await setControlMetadata(sheetIndex, targetRow, targetCol, meta);
        // Remove old metadata
        const { removeControlMetadata } = await import("./lib/controlApi");
        await removeControlMetadata(sheetIndex, row, col);
      }
    }
    // An in-cell control's position IS its anchor: it must move with the grid.
    // Clear the floating-era pinToGrid=false or the backend would hold the
    // anchor still while the cell moves out from under it.
    await setControlProperty(sheetIndex, targetRow, targetCol, "button", "pinToGrid", "static", "true");

    // Remove from floating store
    removeFloatingControl(controlId);
    deselectFloatingControl();
    syncFloatingControlRegions();

    // Refresh style caches
    await refreshStyleCache();
    window.dispatchEvent(new CustomEvent("styles:refresh"));
    emitAppEvent(AppEvents.GRID_REFRESH);

    // Re-open properties pane at new location
    openTP(PROPERTIES_PANE_ID, {
      row: targetRow,
      col: targetCol,
      sheetIndex,
      controlType: "button",
    });
    lastPropertiesCell = { row: targetRow, col: targetCol };
  } else {
    // ---- EMBEDDED -> FLOATING ----
    const gridState = getGridStateSnapshot();
    if (!gridState) return;

    const defaultCellWidth = gridState.config?.defaultCellWidth ?? 100;
    const defaultCellHeight = gridState.config?.defaultCellHeight ?? 24;
    const columnWidths = gridState.dimensions?.columnWidths ?? new Map();
    const rowHeights = gridState.dimensions?.rowHeights ?? new Map();

    // Calculate pixel position from cell bounds
    let cellX = 0;
    for (let c = 0; c < col; c++) {
      cellX += getColumnWidth(c, defaultCellWidth, columnWidths);
    }
    let cellY = 0;
    for (let r = 0; r < row; r++) {
      cellY += getRowHeight(r, defaultCellHeight, rowHeights);
    }
    const cellWidth = getColumnWidth(col, defaultCellWidth, columnWidths);
    const cellHeight = getRowHeight(row, defaultCellHeight, rowHeights);

    const btnWidth = Math.max(cellWidth, 80);
    const btnHeight = Math.max(cellHeight, 28);

    // Remove button formatting and clear cell text
    await applyFormatting([row], [col], { button: false });
    await updateCell(row, col, "");

    // Update metadata with floating position. pinToGrid becomes explicit here:
    // a newly-floating control is UNPINNED (see the creation sites), while the
    // backend treats an absent property as "moves with cells".
    await setControlProperty(sheetIndex, row, col, "button", "x", "static", String(cellX));
    await setControlProperty(sheetIndex, row, col, "button", "y", "static", String(cellY));
    await setControlProperty(sheetIndex, row, col, "button", "width", "static", String(btnWidth));
    await setControlProperty(sheetIndex, row, col, "button", "height", "static", String(btnHeight));
    await setControlProperty(sheetIndex, row, col, "button", "pinToGrid", "static", "false");

    // Add to floating store
    addFloatingControl({
      id: controlId,
      sheetIndex,
      row,
      col,
      x: cellX,
      y: cellY,
      width: btnWidth,
      height: btnHeight,
      controlType: "button",
    });

    syncFloatingControlRegions();

    // Refresh style caches
    await refreshStyleCache();
    window.dispatchEvent(new CustomEvent("styles:refresh"));
    emitAppEvent(AppEvents.GRID_REFRESH);

    // Select the floating control and re-open properties pane
    selectFloatingControl(controlId);
    openTP(PROPERTIES_PANE_ID, {
      row,
      col,
      sheetIndex,
      controlType: "button",
    });
    lastPropertiesCell = { row, col };
  }
}

// ============================================================================
// Load Floating Controls on Startup
// ============================================================================

/**
 * Controls already reported as holding a legacy inline picture, so a structural
 * undo (which reloads the sheet) does not re-toast the same news.
 */
const reportedLegacyInlineImages = new Set<string>();

/**
 * Load all floating controls from backend metadata into the floating store.
 *
 * ON THE LEGACY CORPUS. The image migration itself is the HOST's and has already
 * run by the time this reads anything; what is left for the frontend is telling
 * the user about the pictures it could not convert. Both the reasoning and the
 * wording live in `Image/legacyInlineImages.ts` — including why a migration
 * deliberately does not dirty the document, and why a refused picture is kept
 * rather than dropped.
 */
/**
 * The sheet whose controls are currently IN the floating store.
 *
 * The store holds one sheet at a time (the overlay regions are sheet-blind, so
 * two sheets' worth of controls would paint on top of each other), and
 * SHEET_CHANGED reports the sheet being switched TO — so the departing sheet has
 * to be remembered rather than derived. null = nothing loaded yet.
 */
let loadedSheetIndex: number | null = null;

/**
 * Is this control IN-CELL (part of its cell's formatting) rather than floating?
 *
 * The single definition of the rule, because two places ask it and a
 * disagreement between them is silent: `loadFloatingControls` uses it to decide
 * what enters the floating store, and `deleteControlByInstanceId` uses it to
 * tell "in-cell, cannot delete through this path" apart from "floating, but on
 * another sheet". If those two ever answered differently, a control would be
 * refused with a reason that does not describe it.
 *
 * Only BUTTONS can be embedded, and only legacy ones are by default — shapes
 * and pictures are always floating.
 */
function isEmbeddedControl(
  controlType: string,
  properties: Record<string, ControlPropertyValue>,
): boolean {
  return controlType === "button" ? properties.embedded?.value !== "false" : false;
}

/**
 * Load the floating controls of ONE sheet into the store: `sheetIndex` when the
 * caller already knows it (the sheet-change reload asks the backend), else the
 * backend's active sheet.
 *
 * It used to read `gridState.config.activeSheet`, a GridConfig field nothing in
 * Core ever set, so every load fell back to sheet 0: a canvas's (or any later
 * sheet's) own shapes never came back after a reopen, Sheet1's controls were
 * loaded wherever the user was, and `loadedSheetIndex` said 0 on every sheet --
 * which is how a shape inserted on a canvas stayed published on Sheet1 (found
 * live 2026-09-29, e2e fixall-canvas LIVE-1). The backend is the one answer
 * `reloadForSheetChange` already uses, so the two cannot disagree.
 */
async function loadFloatingControls(knownSheetIndex?: number): Promise<void> {
  try {
    const sheetIndex = knownSheetIndex ?? (await getActiveSheet());
    loadedSheetIndex = sheetIndex;

    const controls = await getAllControls(sheetIndex);
    const unmigrated = collectUnmigratedInlineImages(
      controls,
      makeFloatingControlId,
      reportedLegacyInlineImages,
    );
    for (const entry of controls) {
      const props = entry.metadata.properties;
      // Buttons default to embedded for legacy; shapes are always floating.
      // One predicate, shared with the delete path — see isEmbeddedControl.
      const isEmbedded = isEmbeddedControl(entry.metadata.controlType, props);

      if (!isEmbedded) {
        const x = parseFloat(props.x?.value ?? "0");
        const y = parseFloat(props.y?.value ?? "0");
        const width = parseFloat(props.width?.value ?? "80");
        const height = parseFloat(props.height?.value ?? "28");
        // Pinning survives reload: the metadata property is authoritative.
        // Without restoring it (and the anchor offsets) here, every pinned
        // control came back unpinned and stopped following the grid.
        const pinToGrid = props.pinToGrid?.value === "true";
        const offsetX = props.offsetX ? parseFloat(props.offsetX.value) : undefined;
        const offsetY = props.offsetY ? parseFloat(props.offsetY.value) : undefined;

        addFloatingControl({
          id: makeFloatingControlId(entry.sheetIndex, entry.row, entry.col),
          sheetIndex: entry.sheetIndex,
          row: entry.row,
          col: entry.col,
          pinToGrid,
          offsetX: Number.isFinite(offsetX) ? offsetX : undefined,
          offsetY: Number.isFinite(offsetY) ? offsetY : undefined,
          x,
          y,
          width,
          height,
          controlType: entry.metadata.controlType,
        });
        if (pinToGrid && offsetX === undefined && offsetY === undefined) {
          // Older pinned controls have no stored offsets — derive them from
          // the loaded pixel position so the first resize doesn't snap the
          // control to its anchor origin.
          recalcPinnedOffset(
            makeFloatingControlId(entry.sheetIndex, entry.row, entry.col),
            cellOriginPixels,
          );
        }
      }
    }

    if (unmigrated.length > 0) {
      showToast(legacyInlineImageWarning(unmigrated.length), {
        type: "warning",
        duration: 12000,
      });
    }
  } catch (err) {
    // The visible consequence is "my buttons are gone after reopening the
    // file". Logging that to the console tells the person who can fix it
    // nothing, because they are not looking at the console.
    console.error("[Controls] Failed to load floating controls:", err);
    showToast(
      "This workbook's on-grid controls (buttons, shapes, images) could not be " +
        `loaded: ${err instanceof Error ? err.message : String(err)} ` +
        "They are missing from the sheet until this is resolved.",
      { type: "error", duration: 0 },
    );
  } finally {
    // PUBLISHED ON EVERY EXIT, the failure above included. Every caller reaches
    // this loader having ALREADY emptied the store for the departing sheet
    // (`removeFloatingControlsForSheet`), so a publication that lived only at
    // the end of the `try` left the OLD sheet's overlay regions standing
    // whenever the backend read threw: the departed shape kept being rendered
    // over the sheet the user switched TO, and — because this publication is
    // also the announcement that releases the per-control DOM a renderer parks
    // outside the canvas (`announceFloatingControlRegions` ->
    // `releaseUnpaintedShapeOverlays`) — its pointer-claiming shims kept
    // swallowing clicks on a sheet its shape is not even on. Publishing here
    // republishes exactly what the store holds, which is the truth on both
    // paths, and it is what makes the refusal above TRUE: "missing from the
    // sheet" must not mean "still painted, and still eating clicks".
    syncFloatingControlRegions();
  }
}

// ============================================================================
// Selection Change Handler (Auto-show/hide Properties Pane)
// ============================================================================

/** Track the last cell we opened properties for to avoid redundant open/close. */
let lastPropertiesCell: { row: number; col: number } | null = null;

/**
 * Handle selection changes: auto-show/hide the Properties Pane.
 */
async function handleSelectionChange(
  sel: { startRow: number; startCol: number; endRow: number; endCol: number } | null,
): Promise<void> {
  if (!sel) {
    closePropertiesIfOpen();
    return;
  }

  evaluatePropertiesPaneVisibility(sel);
}

/**
 * Evaluate whether the Properties Pane should be open or closed.
 */
async function evaluatePropertiesPaneVisibility(
  sel?: { startRow: number; startCol: number; endRow: number; endCol: number } | null,
): Promise<void> {
  if (!getDesignMode()) {
    closePropertiesIfOpen();
    return;
  }

  // If a floating control is selected, keep properties pane open for it
  if (getSelectedFloatingControl()) {
    return;
  }

  // Get current selection if not passed
  if (!sel) {
    sel = getCurrentSelectionFromInterceptor();
  }
  if (!sel) {
    closePropertiesIfOpen();
    return;
  }

  const row = sel.endRow;
  const col = sel.endCol;

  // Check if the selected cell is an embedded button control
  const { getCell } = await import("../../src/api/lib");
  const cellData = await getCell(row, col);
  if (!cellData) {
    closePropertiesIfOpen();
    return;
  }

  const isButton = buttonStyleIndices.has(cellData.styleIndex);

  if (isButton) {
    // Only open if it's a different cell or pane isn't already open
    if (
      !lastPropertiesCell ||
      lastPropertiesCell.row !== row ||
      lastPropertiesCell.col !== col
    ) {
      lastPropertiesCell = { row, col };

      const { getGridStateSnapshot } = await import("../../src/api/grid");
      const { openTaskPane: openTP } = await import("../../src/api/ui");
      const gridState = getGridStateSnapshot();
      const sheetIndex = gridState?.sheetContext?.activeSheetIndex ?? 0;

      openTP(PROPERTIES_PANE_ID, {
        row,
        col,
        sheetIndex,
        controlType: "button",
      });
    }
  } else {
    closePropertiesIfOpen();
  }
}

async function closePropertiesIfOpen(): Promise<void> {
  if (lastPropertiesCell) {
    lastPropertiesCell = null;
    const { closeTaskPane: closeTP } = await import("../../src/api/ui");
    closeTP(PROPERTIES_PANE_ID);
  }
}

// ============================================================================
// Cursor Change for Embedded Button Cells
// ============================================================================

/**
 * Set up a mousemove listener that changes the cursor to "pointer"
 * when hovering over an embedded button cell in run mode (not design mode).
 */
function setupButtonCursor(): () => void {
  let lastCanvas: HTMLCanvasElement | null = null;
  let pendingLookup = false;

  const handleMouseMove = async (event: MouseEvent) => {
    const target = event.target;
    if (!(target instanceof HTMLCanvasElement)) {
      if (lastCanvas) {
        lastCanvas.style.cursor = "";
        lastCanvas = null;
      }
      return;
    }

    // Don't change cursor in design mode
    if (getDesignMode()) {
      if (lastCanvas) {
        target.style.cursor = "";
        lastCanvas = null;
      }
      return;
    }

    // Quick exit: no button styles registered
    if (buttonStyleIndices.size === 0) {
      if (lastCanvas) {
        target.style.cursor = "";
        lastCanvas = null;
      }
      return;
    }

    // Throttle
    if (pendingLookup) return;
    pendingLookup = true;

    try {
      const { getCellFromPixel, getGridStateSnapshot } = await import(
        "../../src/api/grid"
      );
      const { getCell } = await import("../../src/api/lib");

      const gridState = getGridStateSnapshot();
      if (!gridState) return;

      const rect = target.getBoundingClientRect();
      const mouseX = event.clientX - rect.left;
      const mouseY = event.clientY - rect.top;

      const cell = getCellFromPixel(
        mouseX,
        mouseY,
        gridState.config,
        gridState.viewport,
        gridState.dimensions,
      );
      if (!cell) {
        if (lastCanvas) {
          target.style.cursor = "";
          lastCanvas = null;
        }
        return;
      }

      const cellData = await getCell(cell.row, cell.col);
      if (cellData && buttonStyleIndices.has(cellData.styleIndex)) {
        target.style.cursor = "pointer";
        lastCanvas = target;
      } else {
        if (lastCanvas) {
          target.style.cursor = "";
          lastCanvas = null;
        }
      }
    } finally {
      pendingLookup = false;
    }
  };

  document.addEventListener("mousemove", handleMouseMove);
  return () => {
    document.removeEventListener("mousemove", handleMouseMove);
  };
}

// ============================================================================
// Deactivation
// ============================================================================

function deactivate(): void {
  if (!isActivated) return;

  console.log("[Controls] Deactivating...");
  for (const cleanup of cleanupFns) {
    cleanup();
  }
  cleanupFns.length = 0;
  designModeMenuItem = null;
  lastPropertiesCell = null;
  resetFloatingStore();
  deselectFloatingControl();
  invalidateAllFloatingButtonCaches();
  invalidateAllShapeCaches();
  invalidateAllImageCaches();
  // Teardown, not invalidation: revoke every object URL this session created.
  releaseAllImageMedia();
  isActivated = false;
  console.log("[Controls] Deactivated.");
}

// ============================================================================
// Extension Module Export
// ============================================================================

const extension: ExtensionModule = {
  manifest: {
    id: "calcula.controls",
    name: "Controls",
    version: "1.0.0",
    description: "Button, Shape, and Image controls with floating and embedded modes.",
  },
  activate,
  deactivate,
};

export default extension;
