//! FILENAME: app/extensions/DataValidation/handlers/dropdownHandler.ts
// PURPOSE: Open/close the in-cell list dropdown, and decide which clicks belong
//          to the chevron control.
// CONTEXT: Excel parity — clicking a list-validated cell SELECTS it (so the
//          formula bar works and click-drag selection across the region works);
//          only the chevron button at the cell's right edge opens the list.
//          The click interceptor therefore claims nothing but that button.

import {
  showOverlay,
  hideOverlay,
  hasInCellDropdown,
  dispatchGridAction,
} from "@api";
import { setSelection } from "@api/grid";
import { getOpenDropdownCell, setOpenDropdownCell } from "../lib/validationStore";
import { getCellClientRect, isChevronClick } from "../lib/gridGeometry";
import { DROPDOWN_OVERLAY_ID } from "../lib/overlayIds";
import type { ListDropdownData } from "../types";

/** A point to anchor the list at when the cell rectangle cannot be resolved. */
export interface FallbackAnchor {
  clientX: number;
  clientY: number;
}

/**
 * Show the list for a cell, anchored under the cell itself.
 * The overlay loads the values; this only positions and records it.
 */
export function openDropdown(row: number, col: number, fallback?: FallbackAnchor): void {
  setOpenDropdownCell({ row, col });

  const cellRect = getCellClientRect(row, col);
  const anchorRect = cellRect ?? {
    x: (fallback?.clientX ?? 0) - 50,
    y: fallback?.clientY ?? 0,
    width: 0,
    height: 10,
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
}

/** Hide the list (idempotent — the overlay may already have closed itself). */
export function closeDropdown(): void {
  hideOverlay(DROPDOWN_OVERLAY_ID);
  setOpenDropdownCell(null);
}

/**
 * Cell click interceptor. Returns true ONLY for a click on the chevron button,
 * so every other click on the cell falls through to normal selection / drag.
 */
export async function handleDropdownChevronClick(
  row: number,
  col: number,
  event: { clientX: number; clientY: number }
): Promise<boolean> {
  // Geometry first: it is synchronous and rejects the overwhelming majority of
  // clicks without a backend round-trip.
  if (!isChevronClick(row, col, event.clientX, event.clientY)) return false;

  // Read the open-dropdown state BEFORE any await. The open list also closes
  // itself from a document-level mousedown listener; without this synchronous
  // snapshot the toggle would race that listener and re-open what it just closed.
  const currentOpen = getOpenDropdownCell();
  if (currentOpen && currentOpen.row === row && currentOpen.col === col) {
    closeDropdown();
    return true;
  }

  let hasDropdown = false;
  try {
    hasDropdown = await hasInCellDropdown(row, col);
  } catch {
    return false;
  }
  if (!hasDropdown) return false;

  // Excel selects the cell as well as opening the list. The interceptor
  // suppresses Core's own selection, so make the selection here.
  dispatchGridAction(setSelection(row, col, row, col));

  openDropdown(row, col, { clientX: event.clientX, clientY: event.clientY });
  return true;
}

/**
 * Keyboard entry point (Alt+Down on the active cell), the accessible equivalent
 * of clicking the chevron. Resolves to true when a list was opened or closed.
 */
export async function toggleDropdownFromKeyboard(row: number, col: number): Promise<boolean> {
  const currentOpen = getOpenDropdownCell();
  if (currentOpen && currentOpen.row === row && currentOpen.col === col) {
    closeDropdown();
    return true;
  }

  let hasDropdown = false;
  try {
    hasDropdown = await hasInCellDropdown(row, col);
  } catch {
    return false;
  }
  if (!hasDropdown) return false;

  openDropdown(row, col);
  return true;
}
