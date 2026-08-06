//! FILENAME: app/extensions/DataValidation/index.ts
// PURPOSE: Data Validation extension entry point. ExtensionModule lifecycle.
// CONTEXT: Activated by the shell during app initialization.

import type { ExtensionModule, ExtensionContext } from "@api/contract";
import {
  AppEvents,
  ExtensionRegistry,
  showOverlay,
  hideOverlay,
  hideDialog,
  cellEvents,
  getValidationPrompt,
  registerCommitGuard,
  type OverlayRegistration,
} from "@api";
import {
  renderDropdownChevrons,
  hitTestDropdownChevron,
  getDropdownChevronCursor,
} from "./rendering/dropdownChevronRenderer";
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
import { handleDropdownChevronClick } from "./handlers/dropdownHandler";
import { getCellClientRect } from "./lib/gridGeometry";
import {
  registerValidationKeyboardShortcuts,
  unregisterValidationKeyboardShortcuts,
} from "./handlers/keyboardHandler";
import {
  DROPDOWN_OVERLAY_ID,
  PROMPT_OVERLAY_ID,
  ERROR_DIALOG_ID,
  CONFIG_DIALOG_ID,
} from "./lib/overlayIds";
import { DataValidationDialog } from "./components/DataValidationDialog";
import { ErrorAlertModal } from "./components/ErrorAlertModal";
import ListDropdownOverlay from "./components/ListDropdownOverlay";
import InputPromptTooltip from "./components/InputPromptTooltip";

// ============================================================================
// State
// ============================================================================

let isActivated = false;
const cleanupFns: (() => void)[] = [];

// ============================================================================
// Lifecycle
// ============================================================================

function activate(context: ExtensionContext): void {
  if (isActivated) {
    console.warn("[DataValidation] Already activated, skipping.");
    return;
  }

  console.log("[DataValidation] Activating...");

  // 1. Register grid overlay for dropdown chevrons
  const unregChevronOverlay = context.grid.overlays.register({
    type: "validation-dropdown",
    render: renderDropdownChevrons,
    hitTest: hitTestDropdownChevron,
    getCursor: getDropdownChevronCursor,
    priority: 15,
  } as OverlayRegistration);
  cleanupFns.push(unregChevronOverlay);

  // 2. Register grid overlay for invalid cell circles
  const unregInvalidOverlay = context.grid.overlays.register({
    type: "validation-invalid",
    render: renderInvalidCells,
    hitTest: hitTestInvalidCell,
    priority: 10,
  } as OverlayRegistration);
  cleanupFns.push(unregInvalidOverlay);

  // 3. Register the list dropdown overlay component
  context.ui.overlays.register({
    id: DROPDOWN_OVERLAY_ID,
    component: ListDropdownOverlay,
    layer: "dropdown",
  });
  cleanupFns.push(() => context.ui.overlays.unregister(DROPDOWN_OVERLAY_ID));

  // 4. Register the input prompt tooltip overlay
  context.ui.overlays.register({
    id: PROMPT_OVERLAY_ID,
    component: InputPromptTooltip,
    layer: "tooltip",
  });
  cleanupFns.push(() => context.ui.overlays.unregister(PROMPT_OVERLAY_ID));

  // 5. Register the error alert dialog
  context.ui.dialogs.register({
    id: ERROR_DIALOG_ID,
    component: ErrorAlertModal,
    priority: 100,
  });
  cleanupFns.push(() => context.ui.dialogs.unregister(ERROR_DIALOG_ID));

  // 6. Register the config dialog
  context.ui.dialogs.register({
    id: CONFIG_DIALOG_ID,
    component: DataValidationDialog,
    priority: 50,
  });
  cleanupFns.push(() => context.ui.dialogs.unregister(CONFIG_DIALOG_ID));

  // 7. Register cell click interceptor for dropdown chevron clicks.
  //
  // It claims ONLY the chevron button (see handlers/dropdownHandler +
  // lib/chevronGeometry). Claiming the whole cell — as this once did — made
  // list-validated cells unselectable: no formula bar, and no click-drag
  // selection across a validated region.
  const unregClick = context.grid.cellClicks.registerClickInterceptor(
    handleDropdownChevronClick
  );
  cleanupFns.push(unregClick);

  // 7b. Alt+Down / Alt+Up: the keyboard equivalent of the chevron button.
  registerValidationKeyboardShortcuts();
  cleanupFns.push(unregisterValidationKeyboardShortcuts);

  // 8. Register the commit guard
  const unregGuard = registerCommitGuard(validationCommitGuard);
  cleanupFns.push(unregGuard);

  // 9. Register data menu items
  registerDataValidationMenuItems(context);

  // 10. Subscribe to events

  // Selection changed: show/hide input prompt tooltip
  const unsubSelection = ExtensionRegistry.onSelectionChange(async (sel) => {
    setCurrentSelection(sel);
    if (!sel) return;

    const activeRow = sel.endRow;
    const activeCol = sel.endCol;

    // Close dropdown if selection moves away
    const openDd = getOpenDropdownCell();
    if (openDd && (activeRow !== openDd.row || activeCol !== openDd.col)) {
      hideOverlay(DROPDOWN_OVERLAY_ID);
      setOpenDropdownCell(null);
    }

    // Show or hide input prompt
    try {
      const prompt = await getValidationPrompt(activeRow, activeCol);
      if (prompt && prompt.showPrompt && (prompt.title || prompt.message)) {
        setPromptState(true, { row: activeRow, col: activeCol });

        // Anchor the tooltip to the active cell's real on-screen rectangle.
        // (The old fixed 80x20 arithmetic ignored scroll, zoom and custom
        // row/column sizes, so the tip drifted away from the cell.)
        const anchorRect = getCellClientRect(activeRow, activeCol) ?? {
          x: activeCol * 80 + 60,
          y: activeRow * 20 + 40,
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
  const unsubSheet = context.events.on(AppEvents.SHEET_CHANGED, () => {
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

  // Structural edits: the backend now SHIFTS validation ranges through
  // row/column insert & delete, so the cached ranges (and the per-cell dropdown
  // / invalid-circle grid regions built from them) must be re-read. A pure
  // structural UNDO carries no updated cells, so the cellEvents path above
  // never fires for it — hence STRUCTURAL_UNDO here.
  //
  // DATA_CHANGED is the announce non-dialog writers make for NON-cell document
  // state (script api.setDataValidation, paste-special of validation, the
  // hyperlink dialog's convention): no cell value moved, so the cellEvents
  // path stays silent, yet the rule set this extension caches just changed.
  //
  // Any open dropdown or prompt is anchored to a pre-shift cell, so close it.
  const onValidationStale = () => {
    hideOverlay(DROPDOWN_OVERLAY_ID);
    hideOverlay(PROMPT_OVERLAY_ID);
    setOpenDropdownCell(null);
    setPromptState(false, null);
    refreshValidationState();
  };
  for (const evt of [
    AppEvents.DATA_CHANGED,
    AppEvents.ROWS_INSERTED,
    AppEvents.COLUMNS_INSERTED,
    AppEvents.ROWS_DELETED,
    AppEvents.COLUMNS_DELETED,
    AppEvents.STRUCTURAL_UNDO,
  ]) {
    cleanupFns.push(context.events.on(evt, onValidationStale));
  }

  // 11. Load initial validation state
  refreshValidationState();

  isActivated = true;
  console.log("[DataValidation] Activated successfully.");
}

// ============================================================================
// Helpers
// ============================================================================

function promptIsVisible(): boolean {
  return getValidationState().promptVisible;
}

// ============================================================================
// Deactivation
// ============================================================================

function deactivate(): void {
  if (!isActivated) return;

  console.log("[DataValidation] Deactivating...");

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

  isActivated = false;
  console.log("[DataValidation] Deactivated.");
}

// ============================================================================
// Extension Module Export
// ============================================================================

const extension: ExtensionModule = {
  manifest: {
    id: "calcula.data-validation",
    name: "Data Validation",
    version: "1.0.0",
    description: "Data validation rules, input prompts, error alerts, dropdown lists, and invalid data highlighting.",
  },
  activate,
  deactivate,
};

export default extension;
