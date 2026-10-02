//! FILENAME: app/extensions/Slicer/handlers/slicerContextMenu.ts
// PURPOSE: Right-click context menu for slicer overlays.
// CONTEXT: Intercepts contextmenu events on slicers and shows a custom
//          DOM-based context menu with slicer-specific options -- and the
//          "Size and Position..." row every object menu carries
//          (@api/objectPosition; BUG-0258 design phase 5b).

import {
  getSlicerById,
  clickSlicerClearFilter,
  updateSlicerAsync,
  deleteSlicerAsync,
  getCachedItems,
} from "../lib/slicerStore";
import { getGridStateSnapshot } from "@api/state";
import { showDialog } from "@api";
import { emitAppEvent } from "@api/events";
import { SLICER_SETTINGS_DIALOG_ID, SLICER_COMPUTED_PROPS_DIALOG_ID, SLICER_CONNECTIONS_DIALOG_ID } from "../manifest";
import { slicerAtCanvasPoint } from "../lib/slicerCanvasGeometry";
import { slicerIdOfRegion } from "../lib/slicerGeometry";
import { getGridRegions, type GridRegion } from "@api/gridOverlays";
import { sizeAndPositionMenuEntry } from "@api/objectPosition";

// ============================================================================
// State
// ============================================================================

/** The slicer ID that was right-clicked (set during contextmenu, consumed by menu) */
let contextSlicerId: string | null = null;
let activeMenuElement: HTMLDivElement | null = null;
/** Removes the open menu's document listeners (Escape, click outside). */
let detachMenuListeners: (() => void) | null = null;

/**
 * Whether a slicer's right-click menu is open: Escape is then the MENU's
 * alone (BUG-0196, slicer part). Asked by the slicer's object-selection
 * provider (`ownsKey`), which a canvas's Escape binding consults before it
 * clears the selection -- that binding runs earlier, in the keybinding
 * dispatcher's window-capture listener, and used to deselect the slicer
 * behind the open menu and leave the menu open (the Floating Range's worked
 * example, FloatingRange/lib/frObjectSelection.ts).
 */
export function isSlicerContextMenuOpen(): boolean {
  return activeMenuElement !== null;
}

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
  // Every way the menu closes (an item, a click outside, Escape, a re-open)
  // takes its listeners down: a stale Escape listener would eat the next
  // Escape the user meant for something else.
  detachMenuListeners?.();
  detachMenuListeners = null;
  contextSlicerId = null;
}

// ============================================================================
// Hit Testing
// ============================================================================

/**
 * The slicer a right-click at this logical canvas point is on, or null.
 * `slicerAtCanvasPoint` uses the PAINTED gutters and refuses a point where
 * another object is on top -- this listener stops immediate propagation, so
 * claiming a covered slicer would also have starved the covering object's own
 * menu.
 */
function hitTestSlicerAt(
  canvasX: number,
  canvasY: number,
): { slicerId: string } | null {
  const slicer = slicerAtCanvasPoint(canvasX, canvasY);
  return slicer ? { slicerId: slicer.id } : null;
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
  /** The row's tooltip (why it is disabled, or what it will show). */
  title?: string;
}

/** The published region of a slicer on the active sheet, or null. */
function slicerRegionOf(slicerId: string): GridRegion | null {
  return getGridRegions().find((r) => r.type === "slicer" && slicerIdOfRegion(r) === slicerId) ?? null;
}

/** The "Size and Position..." row (and its rule) for the slicer's region; none when it is not published. */
function sizeAndPositionRows(slicerId: string): MenuItem[] {
  const region = slicerRegionOf(slicerId);
  if (!region) return [];
  const entry = sizeAndPositionMenuEntry(region);
  return [
    {
      label: entry.label,
      disabled: entry.disabled,
      title: entry.reason ?? undefined,
      onClick: entry.run,
    },
    { label: "", separator: true },
  ];
}

function showContextMenu(clientX: number, clientY: number, slicerId: string): void {
  const slicer = getSlicerById(slicerId);
  if (!slicer) return;

  const isFiltered = slicer.selectedItems !== null;
  const items = getCachedItems(slicerId);

  const menuItems: MenuItem[] = [
    {
      label: "Select All",
      disabled: !isFiltered,
      onClick: () => {
        // Queued behind any click still applying (one gesture, one Ctrl+Z).
        clickSlicerClearFilter(slicerId).catch(console.error);
      },
    },
    {
      label: `Clear Filter from "${slicer.name}"`,
      disabled: !isFiltered,
      onClick: () => {
        // Queued behind any click still applying (one gesture, one Ctrl+Z).
        clickSlicerClearFilter(slicerId).catch(console.error);
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
      label: "Edit Script...",
      onClick: () => {
        emitAppEvent("scriptable-objects:edit-script", {
          objectType: "slicer",
          instanceId: String(slicerId),
          objectName: slicer.name,
        });
      },
    },
    { label: "", separator: true },
    ...sizeAndPositionRows(slicerId),
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

    if (item.title) row.title = item.title;
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
    }
  };
  // Escape closes the menu -- and is CONSUMED: the Escape that closes the
  // menu is the menu's alone, so nothing behind it (the grid's keyboard, the
  // slicer's selection) hears it as well. Capture phase, on document: the
  // canvas's Escape binding runs earlier (window capture) and stands down
  // while the menu is open (`isSlicerContextMenuOpen`, the provider's
  // `ownsKey`).
  const escHandler = (e: KeyboardEvent) => {
    if (e.key !== "Escape") return;
    e.preventDefault();
    e.stopPropagation();
    closeSlicerContextMenu();
  };
  document.addEventListener("keydown", escHandler, true);

  // Delay slightly so the current click doesn't immediately close it
  const timer = setTimeout(() => {
    document.addEventListener("mousedown", closeHandler);
  }, 0);
  detachMenuListeners = () => {
    clearTimeout(timer);
    document.removeEventListener("mousedown", closeHandler);
    document.removeEventListener("keydown", escHandler, true);
  };
}
