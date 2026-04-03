//! FILENAME: app/extensions/AutoFilter/index.ts
// PURPOSE: AutoFilter extension entry point (ExtensionModule pattern).
// CONTEXT: Registers grid overlay, cell click interceptor, menu, events, and keyboard shortcuts.
// NOTE: Default exports an ExtensionModule object per the contract.

import type { ExtensionModule, ExtensionContext } from "@api/contract";
import {
  ExtensionRegistry,
  showOverlay,
  hideOverlay,
  indexToCol,
  AppEvents,
  type OverlayRegistration,
} from "@api";
import { emitAppEvent } from "@api/events";
import { renderFilterChevrons, hitTestFilterChevron, isClickOnChevronButton, isMouseOverAnyChevronButton, getFilterChevronCanvas } from "./rendering/filterChevronRenderer";
import {
  refreshFilterState,
  setCurrentSelection,
  setOpenDropdownCol,
  getAutoFilterInfo,
  getOpenDropdownCol,
  resetState,
  toggleFilter,
} from "./lib/filterStore";
import { registerDataMenu } from "./handlers/dataMenuBuilder";
import { FilterEvents } from "./lib/filterEvents";
import FilterDropdownOverlay from "./components/FilterDropdownOverlay";
import type { FilterDropdownData } from "./types";

// ============================================================================
// Constants
// ============================================================================

const OVERLAY_ID = "autofilter-dropdown";
const REGION_TYPE = "autofilter";

// ============================================================================
// State
// ============================================================================

let isActivated = false;
const cleanupFns: (() => void)[] = [];

// ============================================================================
// Keyboard shortcut handler
// ============================================================================

function handleKeyDown(e: KeyboardEvent): void {
  // Ctrl+Shift+L = Toggle Filter
  if (e.ctrlKey && e.shiftKey && e.key === "L") {
    e.preventDefault();
    e.stopPropagation();
    toggleFilter();
  }
}

// ============================================================================
// Activation
// ============================================================================

function activate(context: ExtensionContext): void {
  if (isActivated) {
    console.warn("[AutoFilter] Already activated, skipping.");
    return;
  }

  console.log("[AutoFilter] Activating...");

  // 1. Register grid overlay for chevrons/funnels
  const unregOverlay = context.grid.overlays.register({
    type: REGION_TYPE,
    render: renderFilterChevrons,
    hitTest: hitTestFilterChevron,
    priority: 20, // Above tables and pivots
  } as OverlayRegistration);
  cleanupFns.push(unregOverlay);

  // 2. Register the dropdown overlay component
  context.ui.overlays.register({
    id: OVERLAY_ID,
    component: FilterDropdownOverlay,
    layer: "dropdown",
  });
  cleanupFns.push(() => context.ui.overlays.unregister(OVERLAY_ID));

  // 3. Register cell click interceptor for chevron clicks
  const unregClick = context.grid.cellClicks.registerClickInterceptor(async (row, col, event) => {
    const info = getAutoFilterInfo();
    if (!info || !info.enabled) return false;

    // Only intercept clicks on the header row within the filter range
    if (row !== info.startRow) return false;
    if (col < info.startCol || col > info.endCol) return false;

    // Only intercept if the click is on the actual chevron button, not the whole cell
    if (!isClickOnChevronButton(col, event.clientX, event.clientY)) return false;

    const currentOpen = getOpenDropdownCol();
    if (currentOpen === col) {
      // Close the dropdown if clicking the same chevron
      hideOverlay(OVERLAY_ID);
      setOpenDropdownCol(null);
      emitAppEvent(FilterEvents.FILTER_DROPDOWN_CLOSE);
      return true;
    }

    // Open the dropdown for this column
    const relCol = col - info.startCol;
    setOpenDropdownCol(col);

    // Calculate anchor position from the click event
    // The dropdown should appear below the header cell
    const anchorRect = {
      x: event.clientX - 50, // Offset to center-ish the dropdown
      y: event.clientY + 10, // Just below the click
      width: 0,
      height: 0,
    };

    const columnName = indexToCol(col);
    const dropdownData: FilterDropdownData = {
      absoluteCol: col,
      relativeCol: relCol,
      columnName,
      uniqueValues: [],  // Will be loaded by the overlay component
      hasBlanks: false,
      selectedValues: null,
      includeBlanks: true,
    };

    emitAppEvent(FilterEvents.FILTER_DROPDOWN_OPEN, { column: col });
    showOverlay(OVERLAY_ID, {
      data: dropdownData as unknown as Record<string, unknown>,
      anchorRect,
    });

    return true; // Prevent default cell selection
  });
  cleanupFns.push(unregClick);

  // 4. Register the Data menu
  registerDataMenu(context);

  // 5. Register keyboard shortcut
  window.addEventListener("keydown", handleKeyDown, true);
  cleanupFns.push(() => window.removeEventListener("keydown", handleKeyDown, true));

  // 6. Mousemove handler for pointer cursor on chevron hover
  let chevronCursorOverride = false;
  const handleChevronMouseMove = (event: MouseEvent) => {
    const canvas = getFilterChevronCanvas();
    if (!canvas) return;

    const isTarget = event.target === canvas || canvas.contains(event.target as Node);
    if (isTarget && isMouseOverAnyChevronButton(event.clientX, event.clientY)) {
      if (!chevronCursorOverride) {
        canvas.style.cursor = "pointer";
        chevronCursorOverride = true;
      }
    } else if (chevronCursorOverride) {
      canvas.style.cursor = "";
      chevronCursorOverride = false;
    }
  };
  document.addEventListener("mousemove", handleChevronMouseMove);
  cleanupFns.push(() => {
    document.removeEventListener("mousemove", handleChevronMouseMove);
    if (chevronCursorOverride) {
      const canvas = getFilterChevronCanvas();
      if (canvas) canvas.style.cursor = "";
    }
  });

  // 6b. Listen for filter button clicks from the column header area
  // (dispatched by the Table extension when the table header row is scrolled out of view)
  const handleFilterHeaderClick = (e: Event) => {
    const col = (e as CustomEvent).detail?.col;
    if (col == null) return;

    const info = getAutoFilterInfo();
    if (!info || !info.enabled) return;
    if (col < info.startCol || col > info.endCol) return;

    const currentOpen = getOpenDropdownCol();
    if (currentOpen === col) {
      hideOverlay(OVERLAY_ID);
      setOpenDropdownCol(null);
      emitAppEvent(FilterEvents.FILTER_DROPDOWN_CLOSE);
      return;
    }

    const relCol = col - info.startCol;
    setOpenDropdownCol(col);

    // Position the dropdown below the column header area
    // Use a fixed Y position since the click was in the column header
    const canvas = getFilterChevronCanvas();
    const canvasRect = canvas?.getBoundingClientRect();
    const colHeaderHeight = 24; // Default column header height
    const anchorRect = {
      x: canvasRect ? canvasRect.left + 50 : 100,
      y: canvasRect ? canvasRect.top + colHeaderHeight : colHeaderHeight,
      width: 0,
      height: 0,
    };

    const columnName = indexToCol(col);
    const dropdownData: FilterDropdownData = {
      absoluteCol: col,
      relativeCol: relCol,
      columnName,
      uniqueValues: [],
      hasBlanks: false,
      selectedValues: null,
      includeBlanks: true,
    };

    emitAppEvent(FilterEvents.FILTER_DROPDOWN_OPEN, { column: col });
    showOverlay(OVERLAY_ID, {
      data: dropdownData as unknown as Record<string, unknown>,
      anchorRect,
    });
  };
  window.addEventListener("table:filterHeaderClick", handleFilterHeaderClick);
  cleanupFns.push(() => window.removeEventListener("table:filterHeaderClick", handleFilterHeaderClick));

  // 7. Subscribe to events
  const unsubSheet = context.events.on(AppEvents.SHEET_CHANGED, () => {
    hideOverlay(OVERLAY_ID);
    setOpenDropdownCol(null);
    refreshFilterState();
  });
  cleanupFns.push(unsubSheet);

  // Refresh filter state when a table is created or updated (tables create/expand
  // AutoFilters for their header row so the chevron icons appear on the table headers).
  const handleTableChanged = () => {
    refreshFilterState();
  };
  window.addEventListener("app:table-created", handleTableChanged);
  window.addEventListener("app:table-definitions-updated", handleTableChanged);
  cleanupFns.push(() => {
    window.removeEventListener("app:table-created", handleTableChanged);
    window.removeEventListener("app:table-definitions-updated", handleTableChanged);
  });

  const unsubSelection = ExtensionRegistry.onSelectionChange((sel) => {
    setCurrentSelection(sel);
  });
  cleanupFns.push(unsubSelection);

  // 8. Load initial filter state
  refreshFilterState();

  isActivated = true;
  console.log("[AutoFilter] Activated successfully.");
}

// ============================================================================
// Deactivation
// ============================================================================

function deactivate(): void {
  if (!isActivated) return;

  console.log("[AutoFilter] Deactivating...");

  hideOverlay(OVERLAY_ID);

  for (const fn of cleanupFns) {
    try {
      fn();
    } catch (err) {
      console.error("[AutoFilter] Cleanup error:", err);
    }
  }
  cleanupFns.length = 0;

  resetState();

  isActivated = false;
  console.log("[AutoFilter] Deactivated.");
}

// ============================================================================
// Extension Module Export
// ============================================================================

const extension: ExtensionModule = {
  manifest: {
    id: "calcula.auto-filter",
    name: "AutoFilter",
    version: "1.0.0",
    description: "Column filtering with dropdown value selection, sort, and search.",
  },
  activate,
  deactivate,
};

export default extension;
