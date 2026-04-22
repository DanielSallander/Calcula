//! FILENAME: app/extensions/Controls/index.ts
// PURPOSE: Controls extension entry point (ExtensionModule pattern).
//          Registers Button control, Design Mode, and Properties Pane.
//          Supports both embedded (cell) and floating button modes.
// NOTE: Default exports an ExtensionModule object per the contract.

import type { ExtensionModule, ExtensionContext } from "@api/contract";
import {
  ExtensionRegistry,
  AppEvents,
} from "@api";
import { emitAppEvent } from "@api/events";
import type { OverlayRenderContext, OverlayHitTestContext } from "@api/gridOverlays";
import { drawButton } from "./Button/rendering";
import {
  buttonStyleInterceptor,
  buttonClickInterceptor,
  handleButtonCellChange,
  setCurrentSelection,
  getCurrentSelection,
  refreshStyleCache,
  buttonStyleIndices,
} from "./Button/interceptors";
import {
  renderFloatingButton,
  hitTestFloatingButton,
  invalidateFloatingButtonCache,
  invalidateAllFloatingButtonCaches,
} from "./Button/floatingRenderer";
import {
  renderFloatingShape,
  hitTestFloatingShape,
  invalidateShapeCache,
  invalidateAllShapeCaches,
} from "./Shape/shapeRenderer";
import {
  renderFloatingImage,
  hitTestFloatingImage,
  invalidateImageCache,
  invalidateAllImageCaches,
} from "./Image/imageRenderer";
import React from "react";
import { getShapeDefinition } from "./Shape/shapeCatalog";
import { ShapeGalleryPanel } from "./Shape/ShapeGalleryOverlay";
import {
  selectFloatingControl,
  deselectFloatingControl,
  getSelectedFloatingControl,
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
} from "./lib/floatingStore";
import {
  getDesignMode,
  toggleDesignMode,
  onDesignModeChange,
} from "./lib/designMode";
import { setControlMetadata, getControlMetadata, getAllControls } from "./lib/controlApi";
import { PropertiesPane } from "./PropertiesPane/PropertiesPane";
import { registerControlContextMenu } from "./lib/controlContextMenu";
import {
  copyControl,
  pasteControl,
  duplicateControl,
  hasClipboardControl,
} from "./lib/controlClipboard";

// ============================================================================
// Constants
// ============================================================================

const PROPERTIES_PANE_ID = "control-properties";
const DESIGN_MODE_MENU_ITEM_ID = "developer:designMode";

// ============================================================================
// State
// ============================================================================

let isActivated = false;
const cleanupFns: (() => void)[] = [];

/** Reference to the design mode menu item for toggling its checked state. */
let designModeMenuItem: { checked?: boolean } | null = null;

// ============================================================================
// Overlay Dispatchers (route render/hitTest by controlType)
// ============================================================================

function renderFloatingControl(overlayCtx: OverlayRenderContext): void {
  const controlType = overlayCtx.region.data?.controlType;
  if (controlType === "shape") {
    renderFloatingShape(overlayCtx);
  } else if (controlType === "image") {
    renderFloatingImage(overlayCtx);
  } else {
    renderFloatingButton(overlayCtx);
  }
}

function hitTestFloatingControl(hitCtx: OverlayHitTestContext): boolean {
  const controlType = hitCtx.region.data?.controlType;
  if (controlType === "shape") {
    return hitTestFloatingShape(hitCtx);
  } else if (controlType === "image") {
    return hitTestFloatingImage(hitCtx);
  } else {
    return hitTestFloatingButton(hitCtx);
  }
}

// ============================================================================
// Activation
// ============================================================================

function activate(context: ExtensionContext): void {
  if (isActivated) {
    console.warn("[Controls] Already activated, skipping.");
    return;
  }

  console.log("[Controls] Activating...");

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
  const unregSelectionChange = ExtensionRegistry.onSelectionChange((sel) => {
    setCurrentSelection(sel);
    // Deselect floating control when user clicks on the grid
    deselectFloatingControl();
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
    children: [
      {
        id: "insert.controls.button",
        label: "Button",
        action: insertButton,
      },
    ],
  });

  // 8b. Register Insert > Shapes with gallery submenu
  context.ui.menus.registerItem("insert", {
    id: "insert.shapes",
    label: "Shapes",
    customContent: (onClose) =>
      React.createElement(ShapeGalleryPanel, { insertShape, onClose }),
  });

  // 8c. Register Insert > Image menu item
  context.ui.menus.registerItem("insert", {
    id: "insert.image",
    label: "Image",
    action: insertImage,
  });

  // 9. Register Developer > Design Mode menu item
  const menuItem = {
    id: DESIGN_MODE_MENU_ITEM_ID,
    label: "Design Mode",
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
    }
  };
  window.addEventListener("controls:bounds-changed", handleBoundsChanged);
  cleanupFns.push(() => window.removeEventListener("controls:bounds-changed", handleBoundsChanged));

  // -----------------------------------------------------------------------
  // 18. Delete selected floating control on Delete/Backspace key
  // -----------------------------------------------------------------------
  const handleDeleteKey = (e: KeyboardEvent) => {
    if (e.key !== "Delete" && e.key !== "Backspace") return;

    // Don't intercept when editing a cell or input field
    const target = e.target as HTMLElement;
    if (
      target.tagName === "INPUT" ||
      target.tagName === "TEXTAREA" ||
      target.isContentEditable
    ) return;

    const selectedId = getSelectedFloatingControl();
    if (!selectedId) return;

    // Prevent the grid from also handling this key
    e.preventDefault();
    e.stopPropagation();

    deleteFloatingControl(selectedId);
  };
  document.addEventListener("keydown", handleDeleteKey, true); // capture phase
  cleanupFns.push(() => document.removeEventListener("keydown", handleDeleteKey, true));

  // -----------------------------------------------------------------------
  // 19. Load existing floating controls on startup
  // -----------------------------------------------------------------------
  loadFloatingControls();

  // -----------------------------------------------------------------------
  // 20. Register context menu items for floating controls
  // -----------------------------------------------------------------------
  const unregContextMenu = registerControlContextMenu();
  cleanupFns.push(unregContextMenu);

  // -----------------------------------------------------------------------
  // 21. Handle Ctrl+C / Ctrl+V / Ctrl+D for floating controls
  // -----------------------------------------------------------------------
  const handleControlKeyboard = async (e: KeyboardEvent) => {
    // Don't intercept when editing a cell or input field
    const target = e.target as HTMLElement;
    if (
      target.tagName === "INPUT" ||
      target.tagName === "TEXTAREA" ||
      target.isContentEditable
    ) return;

    const selectedId = getSelectedFloatingControl();

    if (e.ctrlKey && e.key === "c" && selectedId) {
      e.preventDefault();
      e.stopPropagation();
      await copyControl(selectedId);
    } else if (e.ctrlKey && e.key === "v" && selectedId && hasClipboardControl()) {
      // Only intercept Ctrl+V when a floating control is selected,
      // otherwise let the grid handle normal cell paste
      e.preventDefault();
      e.stopPropagation();
      const { getGridStateSnapshot } = await import("../../src/api/grid");
      const gridState = getGridStateSnapshot();
      const sheetIndex = gridState?.config?.activeSheet ?? 0;
      await pasteControl(sheetIndex);
    } else if (e.ctrlKey && e.key === "d" && selectedId) {
      e.preventDefault();
      e.stopPropagation();
      await duplicateControl(selectedId);
    }
  };
  document.addEventListener("keydown", handleControlKeyboard, true);
  cleanupFns.push(() => document.removeEventListener("keydown", handleControlKeyboard, true));

  // -----------------------------------------------------------------------
  // 22. Handle controls:delete-selected event (from context menu)
  // -----------------------------------------------------------------------
  const handleDeleteSelected = () => {
    const selectedId = getSelectedFloatingControl();
    if (selectedId) {
      deleteFloatingControl(selectedId);
    }
  };
  window.addEventListener("controls:delete-selected", handleDeleteSelected);
  cleanupFns.push(() => window.removeEventListener("controls:delete-selected", handleDeleteSelected));

  isActivated = true;
  console.log("[Controls] Activated successfully.");
}

// ============================================================================
// Insert Button Action (Floating by Default)
// ============================================================================

/**
 * Insert a button control on the current selection.
 * Creates a floating button positioned at the selected cell's location.
 */
async function insertButton(): Promise<void> {
  const { restoreFocusToGrid } = await import("../../src/api/events");
  const { getGridStateSnapshot } = await import("../../src/api/grid");
  const { getColumnWidth, getRowHeight } = await import("../../src/api/dimensions");

  // Get current selection
  const sel = getCurrentSelectionFromInterceptor();
  if (!sel) return;

  const row = sel.endRow;
  const col = sel.endCol;

  // Get grid state for position calculation
  const gridState = getGridStateSnapshot();
  if (!gridState) return;

  const sheetIndex = gridState.config?.activeSheet ?? 0;
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
  const cellWidth = getColumnWidth(col, defaultCellWidth, columnWidths);
  const cellHeight = getRowHeight(row, defaultCellHeight, rowHeights);

  // Button size: at least the cell size, with a reasonable minimum
  const btnWidth = Math.max(cellWidth, 80);
  const btnHeight = Math.max(cellHeight, 28);

  // Create control metadata with floating defaults
  await setControlMetadata(sheetIndex, row, col, {
    controlType: "button",
    properties: {
      text: { valueType: "static", value: "Button" },
      fill: { valueType: "static", value: "#e0e0e0" },
      color: { valueType: "static", value: "#000000" },
      borderColor: { valueType: "static", value: "#999999" },
      fontSize: { valueType: "static", value: "11" },
      embedded: { valueType: "static", value: "false" },
      x: { valueType: "static", value: String(cellX) },
      y: { valueType: "static", value: String(cellY) },
      width: { valueType: "static", value: String(btnWidth) },
      height: { valueType: "static", value: String(btnHeight) },
      onSelect: { valueType: "static", value: "" },
      tooltip: { valueType: "static", value: "" },
    },
  });

  // Add to floating store
  const controlId = makeFloatingControlId(sheetIndex, row, col);
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

  // Sync overlay regions and refresh
  syncFloatingControlRegions();
  emitAppEvent(AppEvents.GRID_REFRESH);
  restoreFocusToGrid();
}

/** Helper to get selection from interceptors module. */
function getCurrentSelectionFromInterceptor() {
  return getCurrentSelection();
}

// ============================================================================
// Insert Shape Action (Always Floating)
// ============================================================================

/**
 * Insert a shape control on the current selection.
 * Creates a floating shape positioned at the selected cell's location.
 */
async function insertShape(shapeType: string): Promise<void> {
  const { restoreFocusToGrid } = await import("../../src/api/events");
  const { getGridStateSnapshot } = await import("../../src/api/grid");
  const { getColumnWidth, getRowHeight } = await import("../../src/api/dimensions");

  const shapeDef = getShapeDefinition(shapeType);
  if (!shapeDef) return;

  // Get current selection
  const sel = getCurrentSelectionFromInterceptor();
  if (!sel) return;

  const row = sel.endRow;
  const col = sel.endCol;

  // Get grid state for position calculation
  const gridState = getGridStateSnapshot();
  if (!gridState) return;

  const sheetIndex = gridState.config?.activeSheet ?? 0;
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

  const shapeWidth = shapeDef.defaultWidth;
  const shapeHeight = shapeDef.defaultHeight;

  // Create control metadata for the shape
  await setControlMetadata(sheetIndex, row, col, {
    controlType: "shape",
    properties: {
      shapeType: { valueType: "static", value: shapeType },
      fill: { valueType: "static", value: "#4472C4" },
      stroke: { valueType: "static", value: "#2F528F" },
      strokeWidth: { valueType: "static", value: "1" },
      text: { valueType: "static", value: "" },
      textColor: { valueType: "static", value: "#FFFFFF" },
      fontSize: { valueType: "static", value: "11" },
      fontBold: { valueType: "static", value: "false" },
      fontItalic: { valueType: "static", value: "false" },
      textAlign: { valueType: "static", value: "center" },
      opacity: { valueType: "static", value: "1" },
      rotation: { valueType: "static", value: "0" },
      x: { valueType: "static", value: String(cellX) },
      y: { valueType: "static", value: String(cellY) },
      width: { valueType: "static", value: String(shapeWidth) },
      height: { valueType: "static", value: String(shapeHeight) },
    },
  });

  // Add to floating store
  const controlId = makeFloatingControlId(sheetIndex, row, col);
  addFloatingControl({
    id: controlId,
    sheetIndex,
    row,
    col,
    x: cellX,
    y: cellY,
    width: shapeWidth,
    height: shapeHeight,
    controlType: "shape",
  });

  // Sync overlay regions and refresh
  syncFloatingControlRegions();
  emitAppEvent(AppEvents.GRID_REFRESH);
  restoreFocusToGrid();
}

// ============================================================================
// Insert Image Action (Always Floating)
// ============================================================================

/**
 * Insert an image control on the current selection.
 * Opens a file picker, reads the selected image as a base64 data URL,
 * and creates a floating image positioned at the selected cell.
 */
async function insertImage(): Promise<void> {
  const { restoreFocusToGrid } = await import("../../src/api/events");
  const { getGridStateSnapshot } = await import("../../src/api/grid");
  const { getColumnWidth, getRowHeight } = await import("../../src/api/dimensions");

  // Use a hidden file input to pick an image file
  const dataUrl = await pickImageFile();
  if (!dataUrl) return;

  // Get current selection
  const sel = getCurrentSelectionFromInterceptor();
  if (!sel) return;

  const row = sel.endRow;
  const col = sel.endCol;

  // Get grid state for position calculation
  const gridState = getGridStateSnapshot();
  if (!gridState) return;

  const sheetIndex = gridState.config?.activeSheet ?? 0;
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

  // Determine image natural size to set initial dimensions
  const naturalSize = await getImageNaturalSize(dataUrl);
  let imgWidth = naturalSize.width;
  let imgHeight = naturalSize.height;

  // Cap to reasonable max while preserving aspect ratio
  const maxDim = 400;
  if (imgWidth > maxDim || imgHeight > maxDim) {
    const scale = maxDim / Math.max(imgWidth, imgHeight);
    imgWidth = Math.round(imgWidth * scale);
    imgHeight = Math.round(imgHeight * scale);
  }

  // Minimum size
  imgWidth = Math.max(imgWidth, 50);
  imgHeight = Math.max(imgHeight, 50);

  // Create control metadata for the image
  await setControlMetadata(sheetIndex, row, col, {
    controlType: "image",
    properties: {
      src: { valueType: "static", value: dataUrl },
      opacity: { valueType: "static", value: "1" },
      rotation: { valueType: "static", value: "0" },
      x: { valueType: "static", value: String(cellX) },
      y: { valueType: "static", value: String(cellY) },
      width: { valueType: "static", value: String(imgWidth) },
      height: { valueType: "static", value: String(imgHeight) },
    },
  });

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

/**
 * Open a native file picker for image files and return the selected file as a data URL.
 * Returns null if the user cancels.
 */
function pickImageFile(): Promise<string | null> {
  return new Promise((resolve) => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = "image/png,image/jpeg,image/gif,image/bmp,image/webp,image/svg+xml";
    input.style.display = "none";
    document.body.appendChild(input);

    input.onchange = () => {
      const file = input.files?.[0];
      document.body.removeChild(input);
      if (!file) {
        resolve(null);
        return;
      }

      const reader = new FileReader();
      reader.onload = () => {
        resolve(reader.result as string);
      };
      reader.onerror = () => {
        console.error("[Controls] Failed to read image file");
        resolve(null);
      };
      reader.readAsDataURL(file);
    };

    input.oncancel = () => {
      document.body.removeChild(input);
      resolve(null);
    };

    input.click();
  });
}

/**
 * Get the natural dimensions of an image from its data URL.
 */
function getImageNaturalSize(dataUrl: string): Promise<{ width: number; height: number }> {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => {
      resolve({ width: img.naturalWidth, height: img.naturalHeight });
    };
    img.onerror = () => {
      resolve({ width: 200, height: 150 }); // fallback
    };
    img.src = dataUrl;
  });
}

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

  // Remove backend metadata
  await removeControlMetadata(ctrl.sheetIndex, ctrl.row, ctrl.col);

  // Remove from in-memory store
  removeFloatingControl(controlId);

  // Clear selection and close properties pane
  deselectFloatingControl();
  const { closeTaskPane: closeTP } = await import("../../src/api/ui");
  closeTP(PROPERTIES_PANE_ID);
  lastPropertiesCell = null;

  // Invalidate caches and refresh
  invalidateFloatingButtonCache(controlId);
  invalidateShapeCache(controlId);
  invalidateImageCache(controlId);
  syncFloatingControlRegions();
  emitAppEvent(AppEvents.GRID_REFRESH);
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

    const ctrlType = detail.data?.controlType ?? "button";

    if (getDesignMode() || ctrlType === "shape" || ctrlType === "image") {
      // Design mode, shape, or image: select the control and show properties
      // (shapes and images are always selectable regardless of design mode)
      selectFloatingControl(controlId);
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
    } else {
      // Run mode: only buttons execute scripts
      if (ctrlType === "button") {
        executeFloatingButtonAction(controlSheet, controlRow, controlCol);
      }
    }
  };
  window.addEventListener("floatingObject:selected", handleFloatingSelected);
  cleanupFns.push(() => window.removeEventListener("floatingObject:selected", handleFloatingSelected));

  // Handle floating object move preview (live position during drag)
  const handleMovePreview = (e: Event) => {
    const detail = (e as CustomEvent).detail;
    if (detail.regionType !== "floating-control") return;
    moveFloatingControl(detail.regionId, detail.x, detail.y);
    syncFloatingControlRegions();
    emitAppEvent(AppEvents.GRID_REFRESH);
  };
  window.addEventListener("floatingObject:movePreview", handleMovePreview);
  cleanupFns.push(() => window.removeEventListener("floatingObject:movePreview", handleMovePreview));

  // Handle floating object move complete
  const handleMoveComplete = (e: Event) => {
    const detail = (e as CustomEvent).detail;
    if (detail.regionType !== "floating-control") return;
    moveFloatingControl(detail.regionId, detail.x, detail.y);
    syncFloatingControlRegions();
    // Persist the new position to metadata
    persistFloatingPosition(detail.regionId);
    emitAppEvent(AppEvents.GRID_REFRESH);
  };
  window.addEventListener("floatingObject:moveComplete", handleMoveComplete);
  cleanupFns.push(() => window.removeEventListener("floatingObject:moveComplete", handleMoveComplete));

  // Handle floating object resize preview
  const handleResizePreview = (e: Event) => {
    const detail = (e as CustomEvent).detail;
    if (detail.regionType !== "floating-control") return;
    resizeFloatingControl(detail.regionId, detail.x, detail.y, detail.width, detail.height);
    syncFloatingControlRegions();
    emitAppEvent(AppEvents.GRID_REFRESH);
  };
  window.addEventListener("floatingObject:resizePreview", handleResizePreview);
  cleanupFns.push(() => window.removeEventListener("floatingObject:resizePreview", handleResizePreview));

  // Handle floating object resize complete
  const handleResizeComplete = (e: Event) => {
    const detail = (e as CustomEvent).detail;
    if (detail.regionType !== "floating-control") return;
    resizeFloatingControl(detail.regionId, detail.x, detail.y, detail.width, detail.height);
    syncFloatingControlRegions();
    invalidateFloatingButtonCache(detail.regionId);
    // Persist the new size to metadata
    persistFloatingPosition(detail.regionId);
    emitAppEvent(AppEvents.GRID_REFRESH);
  };
  window.addEventListener("floatingObject:resizeComplete", handleResizeComplete);
  cleanupFns.push(() => window.removeEventListener("floatingObject:resizeComplete", handleResizeComplete));
}

/**
 * Persist a floating control's current position to backend metadata.
 */
async function persistFloatingPosition(controlId: string): Promise<void> {
  const ctrl = getFloatingControl(controlId);
  if (!ctrl) return;

  const { setControlProperty } = await import("./lib/controlApi");
  await setControlProperty(ctrl.sheetIndex, ctrl.row, ctrl.col, ctrl.controlType, "x", "static", String(Math.round(ctrl.x)));
  await setControlProperty(ctrl.sheetIndex, ctrl.row, ctrl.col, ctrl.controlType, "y", "static", String(Math.round(ctrl.y)));
  await setControlProperty(ctrl.sheetIndex, ctrl.row, ctrl.col, ctrl.controlType, "width", "static", String(Math.round(ctrl.width)));
  await setControlProperty(ctrl.sheetIndex, ctrl.row, ctrl.col, ctrl.controlType, "height", "static", String(Math.round(ctrl.height)));

  // Notify PropertiesPane to re-read metadata (e.g., after drag-resize)
  window.dispatchEvent(new CustomEvent("controls:metadata-refresh", {
    detail: { row: ctrl.row, col: ctrl.col },
  }));
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

/**
 * Sanitize a script module name into a valid JavaScript identifier.
 */
function sanitizeScriptName(name: string): string {
  let sanitized = name.replace(/[^a-zA-Z0-9_]/g, "_");
  if (sanitized && /^[0-9]/.test(sanitized)) {
    sanitized = "_" + sanitized;
  }
  return sanitized || "_unnamed";
}

/**
 * Build a preamble that wraps all script modules as callable functions.
 * Each module's source is wrapped as: function ModuleName() { ...source... }
 */
async function buildScriptPreamble(): Promise<string> {
  const { listScripts, getScript } = await import("../ScriptEditor/lib/scriptApi");
  const summaries = await listScripts();
  if (summaries.length === 0) return "";

  const parts: string[] = [];
  for (const summary of summaries) {
    try {
      const script = await getScript(summary.id);
      if (script && script.source) {
        const fnName = sanitizeScriptName(script.name);
        parts.push(`function ${fnName}() {\n${script.source}\n}`);
      }
    } catch {
      // Skip modules that fail to load
    }
  }
  return parts.length > 0 ? parts.join("\n") + "\n" : "";
}

/**
 * Execute a floating button's OnSelect action.
 * The onSelect value is inline code that runs directly in the script engine.
 * Custom script modules from the Script Editor are available as callable functions.
 */
async function executeFloatingButtonAction(sheetIndex: number, row: number, col: number): Promise<void> {
  const { runScript } = await import("../ScriptEditor/lib/scriptApi");

  const metadata = await getControlMetadata(sheetIndex, row, col);
  if (!metadata) return;

  const onSelect = metadata.properties["onSelect"];
  if (!onSelect || !onSelect.value) return;

  try {
    // Prepend script modules as callable functions, then append the OnSelect code
    const preamble = await buildScriptPreamble();
    const fullSource = preamble + onSelect.value;
    const result = await runScript(fullSource, "button_onSelect.js");
    if (result.type === "success" && result.cellsModified > 0) {
      window.dispatchEvent(new CustomEvent("grid:refresh"));
    } else if (result.type === "error") {
      console.error(`[Controls] Button OnSelect error: ${result.message}`);
    }
  } catch (err) {
    console.error("[Controls] Failed to execute floating button OnSelect:", err);
  }
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

    // Update metadata with floating position
    await setControlProperty(sheetIndex, row, col, "button", "x", "static", String(cellX));
    await setControlProperty(sheetIndex, row, col, "button", "y", "static", String(cellY));
    await setControlProperty(sheetIndex, row, col, "button", "width", "static", String(btnWidth));
    await setControlProperty(sheetIndex, row, col, "button", "height", "static", String(btnHeight));

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
 * Load all floating controls from backend metadata into the floating store.
 */
async function loadFloatingControls(): Promise<void> {
  try {
    const { getGridStateSnapshot } = await import("../../src/api/grid");
    const gridState = getGridStateSnapshot();
    const sheetIndex = gridState?.config?.activeSheet ?? 0;

    const controls = await getAllControls(sheetIndex);
    for (const entry of controls) {
      const props = entry.metadata.properties;
      // Buttons default to embedded for legacy; shapes are always floating
      const isEmbedded = entry.metadata.controlType === "button"
        ? (props.embedded?.value !== "false")
        : false;

      if (!isEmbedded) {
        const x = parseFloat(props.x?.value ?? "0");
        const y = parseFloat(props.y?.value ?? "0");
        const width = parseFloat(props.width?.value ?? "80");
        const height = parseFloat(props.height?.value ?? "28");

        addFloatingControl({
          id: makeFloatingControlId(entry.sheetIndex, entry.row, entry.col),
          sheetIndex: entry.sheetIndex,
          row: entry.row,
          col: entry.col,
          x,
          y,
          width,
          height,
          controlType: entry.metadata.controlType,
        });
      }
    }

    syncFloatingControlRegions();
  } catch (err) {
    console.error("[Controls] Failed to load floating controls:", err);
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
      const sheetIndex = gridState?.config?.activeSheet ?? 0;

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
