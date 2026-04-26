//! FILENAME: app/extensions/Slicer/handlers/slicerContextMenu.ts
// PURPOSE: Right-click context menu for slicer overlays.
// CONTEXT: Intercepts contextmenu events on slicers and shows a custom
//          DOM-based context menu with slicer-specific options.

import {
  getAllSlicers,
  getSlicerById,
  updateSlicerSelectionAsync,
  updateSlicerAsync,
  deleteSlicerAsync,
  getCachedItems,
} from "../lib/slicerStore";
import { getGridStateSnapshot } from "@api/state";
import { showDialog } from "@api";
import { SLICER_SETTINGS_DIALOG_ID, SLICER_COMPUTED_PROPS_DIALOG_ID, SLICER_CONNECTIONS_DIALOG_ID } from "../manifest";

// ============================================================================
// State
// ============================================================================

/** The slicer ID that was right-clicked (set during contextmenu, consumed by menu) */
let contextSlicerId: number | null = null;
let activeMenuElement: HTMLDivElement | null = null;

// ============================================================================
// Public API
// ============================================================================

/**
 * Handle the contextmenu event on the grid area.
 * Returns true if the click was on a slicer (and a context menu was shown).
 */
export function handleSlicerContextMenu(
  e: MouseEvent,
  gridContainer: HTMLElement | null,
): boolean {
  closeSlicerContextMenu();

  if (!gridContainer) return false;

  const rect = gridContainer.getBoundingClientRect();
  const gridState = getGridStateSnapshot();
  const zoom = gridState?.zoom ?? 1.0;
  const canvasX = (e.clientX - rect.left) / zoom;
  const canvasY = (e.clientY - rect.top) / zoom;

  // Hit-test against slicers
  const slicerHit = hitTestSlicerAt(canvasX, canvasY);
  if (!slicerHit) return false;

  // Prevent the grid's context menu from showing.
  // Use stopImmediatePropagation to ensure React's synthetic event doesn't fire.
  e.preventDefault();
  e.stopPropagation();
  e.stopImmediatePropagation();

  contextSlicerId = slicerHit.slicerId;
  showContextMenu(e.clientX, e.clientY, slicerHit.slicerId);
  return true;
}

/**
 * Close any open slicer context menu.
 */
export function closeSlicerContextMenu(): void {
  if (activeMenuElement) {
    activeMenuElement.remove();
    activeMenuElement = null;
  }
  contextSlicerId = null;
}

// ============================================================================
// Hit Testing
// ============================================================================

function hitTestSlicerAt(
  canvasX: number,
  canvasY: number,
): { slicerId: number } | null {
  const slicers = getAllSlicers();
  const gridState = getGridStateSnapshot();
  if (!gridState) return null;

  const scrollX = gridState.viewport.scrollX;
  const scrollY = gridState.viewport.scrollY;
  const headerWidth = gridState.config.rowHeaderWidth;
  const headerHeight = gridState.config.colHeaderHeight;
  const activeSheet = gridState.sheetContext.activeSheetIndex;

  // Check slicers in reverse (topmost first), only on the active sheet
  for (let i = slicers.length - 1; i >= 0; i--) {
    const slicer = slicers[i];
    if (slicer.sheetIndex !== activeSheet) continue;
    const bounds = {
      x: slicer.x - scrollX + headerWidth,
      y: slicer.y - scrollY + headerHeight,
      width: slicer.width,
      height: slicer.height,
    };

    if (
      canvasX >= bounds.x &&
      canvasX <= bounds.x + bounds.width &&
      canvasY >= bounds.y &&
      canvasY <= bounds.y + bounds.height
    ) {
      return { slicerId: slicer.id };
    }
  }

  return null;
}

// ============================================================================
// Menu Rendering
// ============================================================================

interface MenuItem {
  label: string;
  onClick?: () => void;
  disabled?: boolean;
  separator?: boolean;
  checked?: boolean;
}

function showContextMenu(clientX: number, clientY: number, slicerId: number): void {
  const slicer = getSlicerById(slicerId);
  if (!slicer) return;

  const isFiltered = slicer.selectedItems !== null;
  const items = getCachedItems(slicerId);

  const menuItems: MenuItem[] = [
    {
      label: "Select All",
      disabled: !isFiltered,
      onClick: () => {
        updateSlicerSelectionAsync(slicerId, null).catch(console.error);
      },
    },
    {
      label: `Clear Filter from "${slicer.name}"`,
      disabled: !isFiltered,
      onClick: () => {
        updateSlicerSelectionAsync(slicerId, null).catch(console.error);
      },
    },
    { label: "", separator: true },
    {
      label: "Standard Selection",
      checked: slicer.selectionMode === "standard",
      onClick: () => {
        updateSlicerAsync(slicerId, { selectionMode: "standard" }).catch(console.error);
      },
    },
    {
      label: "Single Selection Only",
      checked: slicer.selectionMode === "single",
      onClick: () => {
        updateSlicerAsync(slicerId, { selectionMode: "single" }).catch(console.error);
      },
    },
    {
      label: "Multi-Select (No Ctrl)",
      checked: slicer.selectionMode === "multi",
      onClick: () => {
        updateSlicerAsync(slicerId, { selectionMode: "multi" }).catch(console.error);
      },
    },
    { label: "", separator: true },
    {
      label: "Slicer Settings...",
      onClick: () => {
        showDialog(SLICER_SETTINGS_DIALOG_ID, { slicerId });
      },
    },
    {
      label: "Report Connections...",
      onClick: () => {
        showDialog(SLICER_CONNECTIONS_DIALOG_ID, { slicerId });
      },
    },
    {
      label: "Computed Properties...",
      onClick: () => {
        showDialog(SLICER_COMPUTED_PROPS_DIALOG_ID, { slicerId });
      },
    },
    {
      label: "Remove Slicer",
      onClick: () => {
        deleteSlicerAsync(slicerId).catch(console.error);
      },
    },
  ];

  renderMenu(clientX, clientY, menuItems);
}

function renderMenu(clientX: number, clientY: number, items: MenuItem[]): void {
  const menu = document.createElement("div");
  menu.style.cssText = `
    position: fixed;
    z-index: 10000;
    background: #ffffff;
    border: 1px solid #d0d0d0;
    border-radius: 4px;
    box-shadow: 0 4px 12px rgba(0,0,0,0.15);
    padding: 4px 0;
    min-width: 200px;
    font-family: "Segoe UI", Calibri, sans-serif;
    font-size: 12px;
    color: #333;
  `;

  for (const item of items) {
    if (item.separator) {
      const sep = document.createElement("div");
      sep.style.cssText = `
        height: 1px;
        background: #e0e0e0;
        margin: 4px 0;
      `;
      menu.appendChild(sep);
      continue;
    }

    const row = document.createElement("div");
    row.style.cssText = `
      padding: 6px 28px 6px 28px;
      cursor: ${item.disabled ? "default" : "pointer"};
      color: ${item.disabled ? "#aaa" : "#333"};
      position: relative;
      white-space: nowrap;
    `;

    if (!item.disabled) {
      row.addEventListener("mouseenter", () => {
        row.style.background = "#e8f0fe";
      });
      row.addEventListener("mouseleave", () => {
        row.style.background = "transparent";
      });
      row.addEventListener("click", () => {
        closeSlicerContextMenu();
        item.onClick?.();
      });
    }

    // Checkmark for checked items
    if (item.checked) {
      const check = document.createElement("span");
      check.style.cssText = `
        position: absolute;
        left: 8px;
        top: 50%;
        transform: translateY(-50%);
        font-size: 14px;
        line-height: 1;
      `;
      check.textContent = "\u2713";
      row.appendChild(check);
    }

    const label = document.createElement("span");
    label.textContent = item.label;
    row.appendChild(label);

    menu.appendChild(row);
  }

  // Position menu, adjusting if it would go off-screen
  document.body.appendChild(menu);

  const menuRect = menu.getBoundingClientRect();
  let left = clientX;
  let top = clientY;

  if (left + menuRect.width > window.innerWidth) {
    left = window.innerWidth - menuRect.width - 4;
  }
  if (top + menuRect.height > window.innerHeight) {
    top = window.innerHeight - menuRect.height - 4;
  }

  menu.style.left = `${left}px`;
  menu.style.top = `${top}px`;

  activeMenuElement = menu;

  // Close on click outside or escape
  const closeHandler = (e: MouseEvent) => {
    if (!menu.contains(e.target as Node)) {
      closeSlicerContextMenu();
      document.removeEventListener("mousedown", closeHandler);
    }
  };
  const escHandler = (e: KeyboardEvent) => {
    if (e.key === "Escape") {
      closeSlicerContextMenu();
      document.removeEventListener("keydown", escHandler);
    }
  };

  // Delay slightly so the current click doesn't immediately close it
  setTimeout(() => {
    document.addEventListener("mousedown", closeHandler);
    document.addEventListener("keydown", escHandler);
  }, 0);
}
