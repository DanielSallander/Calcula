//! FILENAME: app/extensions/Controls/Button/interceptors.ts
// PURPOSE: Click, style, and cursor interceptors for in-cell button controls.
// CONTEXT: Handles button click behavior (design mode vs. run mode),
//          suppresses default cell text for button cells,
//          and changes cursor on hover.

import type { Selection, StyleData } from "@api";
import { runWorkbookScript } from "@api";
import type {
  IStyleOverride,
  BaseStyleInfo,
  CellCoords,
} from "@api/styleInterceptors";
import type { UnavailableModule } from "../../_shared/lib/buttonScriptRun";
import {
  loadButtonScriptModules,
  planInlineButtonRun,
} from "../../_shared/lib/buttonScriptRun";
import { showToast } from "@api/notifications";
import { getDesignMode } from "../lib/designMode";

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
 * - Design mode OFF: execute the button's onSelect script (return true)
 */
export async function buttonClickInterceptor(
  row: number,
  col: number,
  _event: { clientX: number; clientY: number },
): Promise<boolean> {
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

  // Run mode: execute the button's onSelect script
  await executeButtonAction(row, col);
  return true; // Consume the click
}

/**
 * Module ids already reported as uncallable, so repeated clicking does not
 * re-toast the same explanation. Shared with the floating-button path in
 * ../index.ts — one notice per module per session, not one per surface.
 */
const reportedUnavailableModules = new Set<string>();

/**
 * Tell the user, once per module, why a module a button expected is not
 * callable — including the case that matters most here: it belongs to an
 * application, so it is not spliced into anything.
 *
 * Silence is the failure mode this replaces. A click that finds `X()` undefined
 * and says nothing is indistinguishable from a broken button.
 */
export function reportUnavailableButtonModules(
  unavailable: readonly UnavailableModule[],
): void {
  for (const entry of unavailable) {
    console.warn(`[Controls] Script module "${entry.name}" not callable: ${entry.message}`);
    if (reportedUnavailableModules.has(entry.id)) continue;
    reportedUnavailableModules.add(entry.id);
    showToast(entry.message, { type: entry.reason === "distributed" ? "info" : "warning" });
  }
}

/** Test seam: forget which notices have already been shown. */
export function resetButtonModuleNoticesForTest(): void {
  reportedUnavailableModules.clear();
}

/**
 * Execute the button's associated OnSelect action.
 *
 * The onSelect value is inline code. The user's OWN modules are prepended as
 * callable functions exactly as before; a module that arrived in an application
 * is never spliced in — see extensions/_shared/lib/buttonScriptRun.ts for the
 * rule and the two defects that made it necessary.
 */
async function executeButtonAction(row: number, col: number): Promise<void> {
  const { getControlMetadata } = await import("../lib/controlApi");

  // Get the active sheet index
  const { getGridStateSnapshot } = await import("../../../src/api/grid");
  const gridState = getGridStateSnapshot();
  const sheetIndex = gridState?.config?.activeSheet ?? 0;

  const metadata = await getControlMetadata(sheetIndex, row, col);
  if (!metadata) return;

  const onSelect = metadata.properties["onSelect"];
  if (!onSelect || !onSelect.value) return;

  try {
    const plan = planInlineButtonRun(onSelect.value, await loadButtonScriptModules());
    if (plan.kind === "refuse") {
      showToast(plan.message, { variant: "error" });
      return;
    }
    reportUnavailableButtonModules(plan.unavailable);
    const result = await runWorkbookScript(plan.source, plan.filename);

    if (result.type === "success" && result.cellsModified > 0 && result.screenUpdating !== false) {
      // Refresh grid if cells were modified and screenUpdating is on
      window.dispatchEvent(new CustomEvent("grid:refresh"));
    } else if (result.type === "error") {
      // Degraded-mode transparency: a button whose script is blocked / refused /
      // errored must SHOW it, not silently do nothing (a click that quietly
      // produces nothing is itself a transparency failure).
      console.error(`[Controls] Button OnSelect error: ${result.message}`);
      showToast(`Button script couldn't run: ${result.message}`, { variant: "error" });
    }
  } catch (err) {
    console.error("[Controls] Failed to execute button OnSelect:", err);
    const msg = err instanceof Error ? err.message : String(err);
    showToast(`Button script couldn't run: ${msg}`, { variant: "error" });
  }
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
    const sheetIndex = gridState?.config?.activeSheet ?? 0;
    await removeControlMetadata(sheetIndex, row, col);

    await refreshStyleCache();
  }
}
