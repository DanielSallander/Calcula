//! FILENAME: app/extensions/AutoFilter/index.ts
// PURPOSE: AutoFilter extension entry point. Registers/unregisters all components.
// CONTEXT: Called from extensions/index.ts during app initialization.

import {
  registerGridOverlay,
  registerCellClickInterceptor,
  onAppEvent,
  AppEvents,
  emitAppEvent,
  ExtensionRegistry,
  showOverlay,
  hideOverlay,
  registerOverlay,
  unregisterOverlay,
  indexToCol,
  type OverlayRegistration,
} from "../../src/api";
import { renderFilterChevrons, hitTestFilterChevron } from "./rendering/filterChevronRenderer";
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
// Cleanup tracking
// ============================================================================

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
// Registration
// ============================================================================

export function registerAutoFilterExtension(): void {
  console.log("[AutoFilter] Registering...");

  // 1. Register grid overlay for chevrons/funnels
  const unregOverlay = registerGridOverlay({
    type: REGION_TYPE,
    render: renderFilterChevrons,
    hitTest: hitTestFilterChevron,
    priority: 20, // Above tables and pivots
  } as OverlayRegistration);
  cleanupFns.push(unregOverlay);

  // 2. Register the dropdown overlay component
  registerOverlay({
    id: OVERLAY_ID,
    component: FilterDropdownOverlay,
    layer: "dropdown",
  });
  cleanupFns.push(() => unregisterOverlay(OVERLAY_ID));

  // 3. Register cell click interceptor for chevron clicks
  const unregClick = registerCellClickInterceptor(async (row, col, event) => {
    const info = getAutoFilterInfo();
    if (!info || !info.enabled) return false;

    // Only intercept clicks on the header row within the filter range
    if (row !== info.startRow) return false;
    if (col < info.startCol || col > info.endCol) return false;

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
  registerDataMenu();

  // 5. Register keyboard shortcut
  window.addEventListener("keydown", handleKeyDown, true);
  cleanupFns.push(() => window.removeEventListener("keydown", handleKeyDown, true));

  // 6. Subscribe to events
  const unsubSheet = onAppEvent(AppEvents.SHEET_CHANGED, () => {
    hideOverlay(OVERLAY_ID);
    setOpenDropdownCol(null);
    refreshFilterState();
  });
  cleanupFns.push(unsubSheet);

  const unsubSelection = ExtensionRegistry.onSelectionChange((sel) => {
    setCurrentSelection(sel);
  });
  cleanupFns.push(unsubSelection);

  // 7. Load initial filter state
  refreshFilterState();

  console.log("[AutoFilter] Registered successfully.");
}

// ============================================================================
// Unregistration
// ============================================================================

export function unregisterAutoFilterExtension(): void {
  console.log("[AutoFilter] Unregistering...");

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

  console.log("[AutoFilter] Unregistered.");
}
