//! FILENAME: app/extensions/Controls/index.ts
// PURPOSE: Controls extension entry point. Registers Button control, Design Mode,
//          and Properties Pane. Supports both embedded (cell) and floating button modes.
// CONTEXT: Called from extensions/index.ts during app initialization.

import {
  registerCellClickInterceptor,
  registerStyleInterceptor,
  registerMenuItem,
  registerTaskPane,
  unregisterTaskPane,
  openTaskPane,
  closeTaskPane,
  ExtensionRegistry,
  onAppEvent,
  AppEvents,
  notifyMenusChanged,
} from "../../src/api";
import { registerCellDecoration } from "../../src/api/cellDecorations";
import { registerGridOverlay } from "../../src/api/gridOverlays";
import { emitAppEvent } from "../../src/api/events";
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

// ============================================================================
// Constants
// ============================================================================

const PROPERTIES_PANE_ID = "control-properties";
const DESIGN_MODE_MENU_ITEM_ID = "developer:designMode";

// ============================================================================
// Cleanup tracking
// ============================================================================

const cleanupFns: (() => void)[] = [];

/** Reference to the design mode menu item for toggling its checked state. */
let designModeMenuItem: { checked?: boolean } | null = null;

// ============================================================================
// Registration
// ============================================================================

export function registerControlsExtension(): void {
  console.log("[Controls] Registering...");

  // 1. Register button cell decoration for rendering (embedded buttons)
  const unregDecoration = registerCellDecoration("button", drawButton, 10);
  cleanupFns.push(unregDecoration);

  // 2. Register style interceptor to suppress default text for embedded buttons
  const unregStyleInterceptor = registerStyleInterceptor(
    "button",
    buttonStyleInterceptor,
    5,
  );
  cleanupFns.push(unregStyleInterceptor);

  // 3. Register cell click interceptor for embedded button behavior
  const unregClickInterceptor = registerCellClickInterceptor(buttonClickInterceptor);
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

  // 6. Refresh style cache on data/style changes
  const unregDataChanged = onAppEvent(AppEvents.DATA_CHANGED, () => {
    refreshStyleCache();
  });
  cleanupFns.push(unregDataChanged);

  // 7. Register Properties Pane as a task pane
  registerTaskPane({
    id: PROPERTIES_PANE_ID,
    title: "Properties",
    component: PropertiesPane,
    contextKeys: ["properties"],
    priority: 40,
    closable: true,
  });
  cleanupFns.push(() => unregisterTaskPane(PROPERTIES_PANE_ID));

  // 8. Register Insert > Controls > Button menu item
  registerMenuItem("insert", {
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

  // 9. Register Developer > Design Mode menu item
  const menuItem = {
    id: DESIGN_MODE_MENU_ITEM_ID,
    label: "Design Mode",
    checked: getDesignMode(),
    action: () => {
      toggleDesignMode();
      menuItem.checked = getDesignMode();
      designModeMenuItem = menuItem;
      notifyMenusChanged();
    },
  };
  designModeMenuItem = menuItem;
  registerMenuItem("developer", menuItem);

  // 10. Listen to design mode changes for auto-show/hide
  const unregDesignMode = onDesignModeChange((_isDesignMode) => {
    if (designModeMenuItem) {
      designModeMenuItem.checked = _isDesignMode;
      notifyMenusChanged();
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
  const unregOverlay = registerGridOverlay({
    type: "floating-control",
    render: renderFloatingButton,
    hitTest: hitTestFloatingButton,
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
  // 16. Load existing floating controls on startup
  // -----------------------------------------------------------------------
  loadFloatingControls();

  console.log("[Controls] Registered successfully");
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
  // Height min 50 matches MIN_FLOATING_SIZE in the core resize handlers
  const btnWidth = Math.max(cellWidth, 80);
  const btnHeight = Math.max(cellHeight, 50);

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

    if (getDesignMode()) {
      // Design mode: select the control and show properties
      selectFloatingControl(controlId);
      lastPropertiesCell = { row: controlRow, col: controlCol };
      openTaskPane(PROPERTIES_PANE_ID, {
        row: controlRow,
        col: controlCol,
        sheetIndex: controlSheet,
        controlType: detail.data?.controlType ?? "button",
      });
      emitAppEvent(AppEvents.GRID_REFRESH);
    } else {
      // Run mode: execute the button's onSelect script
      executeFloatingButtonAction(controlSheet, controlRow, controlCol);
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
  await setControlProperty(ctrl.sheetIndex, ctrl.row, ctrl.col, ctrl.controlType, "x", "static", String(ctrl.x));
  await setControlProperty(ctrl.sheetIndex, ctrl.row, ctrl.col, ctrl.controlType, "y", "static", String(ctrl.y));
  await setControlProperty(ctrl.sheetIndex, ctrl.row, ctrl.col, ctrl.controlType, "width", "static", String(ctrl.width));
  await setControlProperty(ctrl.sheetIndex, ctrl.row, ctrl.col, ctrl.controlType, "height", "static", String(ctrl.height));
}

/**
 * Execute a floating button's onSelect script.
 */
async function executeFloatingButtonAction(sheetIndex: number, row: number, col: number): Promise<void> {
  const { runScript, getScript } = await import("../ScriptEditor/lib/scriptApi");

  const metadata = await getControlMetadata(sheetIndex, row, col);
  if (!metadata) return;

  const onSelect = metadata.properties["onSelect"];
  if (!onSelect || !onSelect.value) return;

  try {
    const script = await getScript(onSelect.value);
    if (script && script.source) {
      const result = await runScript(script.source, script.name || "button_script.js");
      if (result.type === "success" && result.cellsModified > 0) {
        window.dispatchEvent(new CustomEvent("grid:refresh"));
      } else if (result.type === "error") {
        console.error(`[Controls] Button script error: ${result.message}`);
      }
    }
  } catch (err) {
    console.error("[Controls] Failed to execute floating button script:", err);
  }
}

// ============================================================================
// Embedded ↔ Floating Toggle
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

  const controlId = makeFloatingControlId(sheetIndex, row, col);

  if (embedded) {
    // ---- FLOATING → EMBEDDED ----
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
    openTaskPane(PROPERTIES_PANE_ID, {
      row: targetRow,
      col: targetCol,
      sheetIndex,
      controlType: "button",
    });
    lastPropertiesCell = { row: targetRow, col: targetCol };
  } else {
    // ---- EMBEDDED → FLOATING ----
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
    const btnHeight = Math.max(cellHeight, 50);

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
    openTaskPane(PROPERTIES_PANE_ID, {
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
      const isEmbedded = props.embedded?.value !== "false"; // default to embedded for legacy

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
      const gridState = getGridStateSnapshot();
      const sheetIndex = gridState?.config?.activeSheet ?? 0;

      openTaskPane(PROPERTIES_PANE_ID, {
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

function closePropertiesIfOpen(): void {
  if (lastPropertiesCell) {
    lastPropertiesCell = null;
    closeTaskPane(PROPERTIES_PANE_ID);
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
// Unregistration
// ============================================================================

export function unregisterControlsExtension(): void {
  console.log("[Controls] Unregistering...");
  for (const cleanup of cleanupFns) {
    cleanup();
  }
  cleanupFns.length = 0;
  designModeMenuItem = null;
  lastPropertiesCell = null;
  resetFloatingStore();
  deselectFloatingControl();
  invalidateAllFloatingButtonCaches();
  console.log("[Controls] Unregistered");
}
