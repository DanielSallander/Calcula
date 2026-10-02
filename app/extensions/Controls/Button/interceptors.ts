//! FILENAME: app/extensions/Controls/Button/interceptors.ts
// PURPOSE: Click, style, and cursor interceptors for in-cell button controls.
// CONTEXT: Handles button click behavior (design mode vs. run mode),
//          suppresses default cell text for button cells,
//          and changes cursor on hover.

import type { Selection, StyleData } from "@api";
import type {
  IStyleOverride,
  BaseStyleInfo,
  CellCoords,
} from "@api/styleInterceptors";
import { showToast } from "@api/notifications";
import { mintExplicitMacroRun } from "@api/explicitMacroRun";
import { actOnCellRelease, type CellClickAnswer } from "@api/cellClickInterceptors";
import type { ButtonGesturePass } from "../../_shared/lib/buttonClickDoor";
import { getDesignMode } from "../lib/designMode";
import { clickButtonControl } from "../lib/controlClick";

// ============================================================================
// State
// ============================================================================

/** Module-level style cache, refreshed from getAllStyles() API calls. */
let cachedStyles: Map<number, StyleData> = new Map();
/** Set of style indices that have button=true (for synchronous lookups). */
export const buttonStyleIndices: Set<number> = new Set();
let currentSelection: Selection | null = null;

/**
 * Refresh the module-level style cache from the backend.
 * Called on extension init and whenever styles may have changed.
 */
export async function refreshStyleCache(): Promise<void> {
  const { getAllStyles } = await import("../../../src/api/lib");
  const styles = await getAllStyles();
  cachedStyles = new Map();
  buttonStyleIndices.clear();
  styles.forEach((style, index) => {
    cachedStyles.set(index, style);
    if (style.button) {
      buttonStyleIndices.add(index);
    }
  });
}

/**
 * Track the current selection for button interactions.
 */
export function setCurrentSelection(sel: Selection | null): void {
  currentSelection = sel;
}

/**
 * Get the current selection.
 */
export function getCurrentSelection(): Selection | null {
  return currentSelection;
}

// ============================================================================
// Style Interceptor - Suppress default text rendering for button cells
// ============================================================================

/**
 * Style interceptor that makes text invisible for button cells.
 * The button decoration draws the text itself with proper centering.
 */
export function buttonStyleInterceptor(
  _cellValue: string,
  baseStyle: BaseStyleInfo,
  _coords: CellCoords,
): IStyleOverride | null {
  const style = cachedStyles.get(baseStyle.styleIndex);
  if (!style || !style.button) {
    return null;
  }

  // Make text color fully transparent - the button decoration draws its own text
  return { textColor: "rgba(0,0,0,0)" };
}

// ============================================================================
// Cell Click Interceptor - Design mode vs. run mode
// ============================================================================

/**
 * Cell click interceptor for buttons.
 * - Design mode ON: let default selection happen (return false)
 * - Design mode OFF: CLAIM the press for its release (a release claim): the
 *   button runs only when the press is RELEASED on this same cell, and sliding
 *   off cancels -- the standard Windows button rule, the owner's answer for
 *   every button (BUG-0258 design phase 4; the floating button has done this
 *   since M7, ../lib/buttonPress.ts). While held over the cell it shows
 *   PRESSED (rendering.ts asks `isCellPressed`).
 *
 * THIS IS A PERSON'S GESTURE: Core calls the cell click interceptors only from
 * its mouse-down handler (`checkCellClickInterceptors`,
 * src/core/components/Spreadsheet/useSpreadsheetSelection.ts), and runs a
 * release claim only from that press's release (core/lib/cellPressRelease.ts).
 * So this -- and nothing it calls -- mints the one-time explicit-run pass for
 * the macro the click runs (owner decision B; @api/explicitMacroRun): an
 * APPROVED application macro the button links may then change cells for that
 * one run. The census in src/api/__tests__/explicitMacroRun.test.ts pins the
 * mint to this body.
 */
export async function buttonClickInterceptor(
  row: number,
  col: number,
  _event: { clientX: number; clientY: number },
): Promise<CellClickAnswer> {
  const { getCell } = await import("../../../src/api/lib");

  const cellData = await getCell(row, col);
  if (!cellData) return false;

  // Check if cell is a button
  const style = cachedStyles.get(cellData.styleIndex);
  if (!style || !style.button) return false;

  // Design mode: allow normal selection, don't intercept
  if (getDesignMode()) {
    return false;
  }

  // Run mode: the press is the button's, and its RELEASE on this cell runs the
  // button's action -- the person's click, handed down to whichever macro the
  // door's answer turns out to run. A release anywhere else runs nothing.
  return actOnCellRelease(
    row,
    col,
    () => executeButtonAction(row, col, (macroId) => mintExplicitMacroRun("button", macroId)),
    { pressedLook: true },
  );
}

/**
 * Execute the button's associated action, through the Rust button door
 * (phase 4 of BUG-0257) -- exactly as a floating button does (../lib/controlClick.ts).
 *
 * The click names the button (the active sheet, read ONCE, and this cell) and
 * nothing else; the door reads what it runs from its own store. A macro link
 * runs through the phase-3 route; the user's own inline code runs with the
 * user's own modules; an application's HELD inline code runs as its exact
 * bytes, only after the approval of those bytes, and the door says so when it
 * does not. This path used to ignore `macroRef` entirely, so a linked button
 * did nothing once it sat in a cell; and it used to compose the user's modules
 * around `onSelect` on this page (the deleted `planInlineButtonRun`) -- the
 * rule now lives in app/src-tauri/src/scripting/control_action.rs.
 *
 * `gesture` is the person's click from `buttonClickInterceptor` -- its release
 * on the button -- its only caller (owner decision B).
 */
async function executeButtonAction(row: number, col: number, gesture: ButtonGesturePass): Promise<void> {
  const { getGridStateSnapshot } = await import("../../../src/api/grid");
  const gridState = getGridStateSnapshot();
  const sheetIndex = gridState?.sheetContext?.activeSheetIndex ?? 0;

  await clickButtonControl(sheetIndex, row, col, (message) => {
    // An in-cell button with nothing on it has nothing more to say than the
    // door's own reason, when it gave one.
    if (message) showToast(message, { variant: "info" });
  }, gesture);
}

// ============================================================================
// Non-boolean Input Handler - Remove button when non-button content entered
// ============================================================================

/**
 * Handle cell value changes for button cells.
 * If a button cell is cleared (Delete key), remove the button formatting and metadata.
 */
export async function handleButtonCellChange(
  row: number,
  col: number,
  _oldValue: string | null,
  newValue: string | null,
): Promise<void> {
  const { getCell, applyFormatting } = await import("../../../src/api/lib");

  const cellData = await getCell(row, col);
  if (!cellData) return;

  const style = cachedStyles.get(cellData.styleIndex);
  if (!style || !style.button) return;

  // If the cell was cleared, remove button formatting and metadata
  if (newValue === null || newValue === "") {
    await applyFormatting([row], [col], { button: false });

    const { removeControlMetadata } = await import("../lib/controlApi");
    const { getGridStateSnapshot } = await import("../../../src/api/grid");
    const gridState = getGridStateSnapshot();
    const sheetIndex = gridState?.sheetContext?.activeSheetIndex ?? 0;
    await removeControlMetadata(sheetIndex, row, col);

    await refreshStyleCache();
  }
}
