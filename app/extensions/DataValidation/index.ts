//! FILENAME: app/extensions/DataValidation/index.ts
// PURPOSE: Data Validation extension entry point. Registers/unregisters all components.
// CONTEXT: Called from extensions/index.ts during app initialization.

import {
  registerGridOverlay,
  registerCellClickInterceptor,
  registerOverlay,
  unregisterOverlay,
  registerDialog,
  unregisterDialog,
  registerCommitGuard,
  onAppEvent,
  AppEvents,
  ExtensionRegistry,
  showOverlay,
  hideOverlay,
  hideDialog,
  cellEvents,
  getValidationPrompt,
  hasInCellDropdown,
  type OverlayRegistration,
} from "../../src/api";
import { renderDropdownChevrons, hitTestDropdownChevron } from "./rendering/dropdownChevronRenderer";
import { renderInvalidCells, hitTestInvalidCell } from "./rendering/invalidCellRenderer";
import {
  refreshValidationState,
  setCurrentSelection,
  setOpenDropdownCell,
  getOpenDropdownCell,
  setPromptState,
  getValidationState,
  resetState,
  clearCircles,
} from "./lib/validationStore";
import { validationCommitGuard, clearErrorAlertResolver } from "./handlers/commitGuardHandler";
import { registerDataValidationMenuItems } from "./handlers/dataMenuBuilder";
import { DataValidationDialog } from "./components/DataValidationDialog";
import { ErrorAlertModal } from "./components/ErrorAlertModal";
import ListDropdownOverlay from "./components/ListDropdownOverlay";
import InputPromptTooltip from "./components/InputPromptTooltip";
import type { ListDropdownData } from "./types";

// ============================================================================
// Constants
// ============================================================================

const DROPDOWN_OVERLAY_ID = "validation-list-dropdown";
const PROMPT_OVERLAY_ID = "validation-prompt";
const ERROR_DIALOG_ID = "data-validation-error";
const CONFIG_DIALOG_ID = "data-validation-dialog";

// ============================================================================
// Cleanup tracking
// ============================================================================

const cleanupFns: (() => void)[] = [];

// ============================================================================
// Registration
// ============================================================================

export function registerDataValidationExtension(): void {
  console.log("[DataValidation] Registering...");

  // 1. Register grid overlay for dropdown chevrons
  const unregChevronOverlay = registerGridOverlay({
    type: "validation-dropdown",
    render: renderDropdownChevrons,
    hitTest: hitTestDropdownChevron,
    priority: 15,
  } as OverlayRegistration);
  cleanupFns.push(unregChevronOverlay);

  // 2. Register grid overlay for invalid cell circles
  const unregInvalidOverlay = registerGridOverlay({
    type: "validation-invalid",
    render: renderInvalidCells,
    hitTest: hitTestInvalidCell,
    priority: 10,
  } as OverlayRegistration);
  cleanupFns.push(unregInvalidOverlay);

  // 3. Register the list dropdown overlay component
  registerOverlay({
    id: DROPDOWN_OVERLAY_ID,
    component: ListDropdownOverlay,
    layer: "dropdown",
  });
  cleanupFns.push(() => unregisterOverlay(DROPDOWN_OVERLAY_ID));

  // 4. Register the input prompt tooltip overlay
  registerOverlay({
    id: PROMPT_OVERLAY_ID,
    component: InputPromptTooltip,
    layer: "tooltip",
  });
  cleanupFns.push(() => unregisterOverlay(PROMPT_OVERLAY_ID));

  // 5. Register the error alert dialog
  registerDialog({
    id: ERROR_DIALOG_ID,
    component: ErrorAlertModal,
    priority: 100,
  });
  cleanupFns.push(() => unregisterDialog(ERROR_DIALOG_ID));

  // 6. Register the config dialog
  registerDialog({
    id: CONFIG_DIALOG_ID,
    component: DataValidationDialog,
    priority: 50,
  });
  cleanupFns.push(() => unregisterDialog(CONFIG_DIALOG_ID));

  // 7. Register cell click interceptor for dropdown chevron clicks
  const unregClick = registerCellClickInterceptor(async (row, col, event) => {
    // Check if this cell has an in-cell dropdown
    let hasDropdown = false;
    try {
      hasDropdown = await hasInCellDropdown(row, col);
    } catch {
      return false;
    }

    if (!hasDropdown) return false;

    const currentOpen = getOpenDropdownCell();
    if (currentOpen && currentOpen.row === row && currentOpen.col === col) {
      // Close the dropdown if clicking the same cell
      hideOverlay(DROPDOWN_OVERLAY_ID);
      setOpenDropdownCell(null);
      return true;
    }

    // Open the dropdown for this cell
    setOpenDropdownCell({ row, col });

    const anchorRect = {
      x: event.clientX - 50,
      y: event.clientY + 10,
      width: 0,
      height: 0,
    };

    const dropdownData: ListDropdownData = {
      row,
      col,
      values: [], // Loaded by the overlay component
      currentValue: "",
    };

    showOverlay(DROPDOWN_OVERLAY_ID, {
      data: dropdownData as unknown as Record<string, unknown>,
      anchorRect,
    });

    return true; // Prevent default cell selection
  });
  cleanupFns.push(unregClick);

  // 8. Register the commit guard
  const unregGuard = registerCommitGuard(validationCommitGuard);
  cleanupFns.push(unregGuard);

  // 9. Register data menu items
  registerDataValidationMenuItems();

  // 10. Subscribe to events

  // Selection changed: show/hide input prompt tooltip
  const unsubSelection = ExtensionRegistry.onSelectionChange(async (sel) => {
    setCurrentSelection(sel);

    // Close dropdown if selection moves away
    const openDd = getOpenDropdownCell();
    if (openDd && (sel.activeRow !== openDd.row || sel.activeCol !== openDd.col)) {
      hideOverlay(DROPDOWN_OVERLAY_ID);
      setOpenDropdownCell(null);
    }

    // Show or hide input prompt
    try {
      const prompt = await getValidationPrompt(sel.activeRow, sel.activeCol);
      if (prompt && prompt.show && (prompt.title || prompt.message)) {
        setPromptState(true, { row: sel.activeRow, col: sel.activeCol });

        // Position the tooltip relative to the click/selection
        // Use a small offset from the selection coordinates
        const anchorRect = {
          x: sel.activeCol * 80 + 60, // Approximate, will be adjusted
          y: sel.activeRow * 20 + 40,
          width: 80,
          height: 20,
        };

        showOverlay(PROMPT_OVERLAY_ID, {
          data: {
            title: prompt.title,
            message: prompt.message,
          } as unknown as Record<string, unknown>,
          anchorRect,
        });
      } else {
        if (promptIsVisible()) {
          hideOverlay(PROMPT_OVERLAY_ID);
          setPromptState(false, null);
        }
      }
    } catch {
      // Silently ignore prompt errors
    }
  });
  cleanupFns.push(unsubSelection);

  // Sheet changed: refresh validation state
  const unsubSheet = onAppEvent(AppEvents.SHEET_CHANGED, () => {
    hideOverlay(DROPDOWN_OVERLAY_ID);
    hideOverlay(PROMPT_OVERLAY_ID);
    setOpenDropdownCell(null);
    setPromptState(false, null);
    clearCircles();
    refreshValidationState();
  });
  cleanupFns.push(unsubSheet);

  // Cell value changes: refresh if circles are active
  const unsubCells = cellEvents.subscribe(() => {
    // Debounced refresh of validation state happens in the store
    refreshValidationState();
  });
  cleanupFns.push(unsubCells);

  // 11. Load initial validation state
  refreshValidationState();

  console.log("[DataValidation] Registered successfully.");
}

// ============================================================================
// Helpers
// ============================================================================

function promptIsVisible(): boolean {
  return getValidationState().promptVisible;
}

// ============================================================================
// Unregistration
// ============================================================================

export function unregisterDataValidationExtension(): void {
  console.log("[DataValidation] Unregistering...");

  // Clear pending error alert resolver
  clearErrorAlertResolver();

  // Close overlays and dialogs
  hideOverlay(DROPDOWN_OVERLAY_ID);
  hideOverlay(PROMPT_OVERLAY_ID);
  hideDialog(ERROR_DIALOG_ID);
  hideDialog(CONFIG_DIALOG_ID);

  // Run cleanup functions
  for (const fn of cleanupFns) {
    try {
      fn();
    } catch (err) {
      console.error("[DataValidation] Cleanup error:", err);
    }
  }
  cleanupFns.length = 0;

  // Reset state
  resetState();

  console.log("[DataValidation] Unregistered.");
}
