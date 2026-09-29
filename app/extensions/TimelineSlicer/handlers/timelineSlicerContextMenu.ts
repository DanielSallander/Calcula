//! FILENAME: app/extensions/TimelineSlicer/handlers/timelineSlicerContextMenu.ts
// PURPOSE: Context menu handling for timeline slicer right-click.

import { getGridStateSnapshot } from "@api/state";
import { showDialog } from "@api";
import {
  getTimelineById,
  deleteTimelineAsync,
  updateTimelineSelectionAsync,
} from "../lib/timelineSlicerStore";
import {
  isTimelineSelected,
  selectTimeline,
} from "./selectionHandler";
import { timelineAtCanvasPoint } from "../lib/timelineCanvasGeometry";
import { TIMELINE_SETTINGS_DIALOG_ID } from "../manifest";

let activeMenuElement: HTMLDivElement | null = null;

// ============================================================================
// Public API
// ============================================================================

/**
 * Handle right-click context menu on a timeline slicer.
 */
export function handleTimelineContextMenu(
  e: MouseEvent,
  gridContainer: HTMLElement | null,
): void {
  if (!gridContainer) return;

  const rect = gridContainer.getBoundingClientRect();
  const gridState = getGridStateSnapshot();
  if (!gridState) return;

  const zoom = gridState.zoom ?? 1.0;
  const canvasX = (e.clientX - rect.left) / zoom;
  const canvasY = (e.clientY - rect.top) / zoom;

  // The PAINTED gutters, and the topmost object decides: a timeline covered by
  // another object is not what the user right-clicked (that object's own menu
  // answers).
  const tl = timelineAtCanvasPoint(canvasX, canvasY);
  if (!tl) return;

  e.preventDefault();
  e.stopPropagation();

  if (!isTimelineSelected(tl.id)) {
    selectTimeline(tl.id, false);
  }

  showContextMenu(e.clientX, e.clientY, tl.id);
}

export function closeTimelineContextMenu(): void {
  if (activeMenuElement) {
    activeMenuElement.remove();
    activeMenuElement = null;
  }
}

// ============================================================================
// Internal
// ============================================================================

interface MenuItem {
  label: string;
  onClick?: () => void;
  disabled?: boolean;
  separator?: boolean;
}

function showContextMenu(
  clientX: number,
  clientY: number,
  timelineId: string,
): void {
  closeTimelineContextMenu();

  const tl = getTimelineById(timelineId);
  if (!tl) return;

  const hasFilter = tl.selectionStart !== null;

  const menuItems: MenuItem[] = [
    {
      label: `Clear Timeline Filter`,
      disabled: !hasFilter,
      onClick: () => {
        // A USER gesture: a clear that grows a pivot over the user's cells is
        // asked about once, and a decline takes it back (the review of S2).
        updateTimelineSelectionAsync(timelineId, null, null, { askBeforeOverwrite: true }).catch(
          console.error,
        );
      },
    },
    { label: "", separator: true },
    {
      label: "Timeline Settings...",
      onClick: () => {
        showDialog(TIMELINE_SETTINGS_DIALOG_ID, { timelineId });
      },
    },
    { label: "", separator: true },
    {
      label: "Remove Timeline",
      onClick: () => {
        deleteTimelineAsync(timelineId).catch(console.error);
      },
    },
  ];

  renderMenu(clientX, clientY, menuItems);
}

function renderMenu(
  clientX: number,
  clientY: number,
  items: MenuItem[],
): void {
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
      padding: 6px 24px 6px 12px;
      cursor: ${item.disabled ? "default" : "pointer"};
      color: ${item.disabled ? "#aaa" : "#333"};
      white-space: nowrap;
    `;
    row.textContent = item.label;

    if (!item.disabled && item.onClick) {
      const onClick = item.onClick;
      row.addEventListener("mouseenter", () => {
        row.style.background = "#e8e8e8";
      });
      row.addEventListener("mouseleave", () => {
        row.style.background = "transparent";
      });
      row.addEventListener("click", () => {
        closeTimelineContextMenu();
        onClick();
      });
    }

    menu.appendChild(row);
  }

  // Position (ensure visible)
  menu.style.left = `${clientX}px`;
  menu.style.top = `${clientY}px`;
  document.body.appendChild(menu);

  // Adjust if off-screen
  const menuRect = menu.getBoundingClientRect();
  if (menuRect.right > window.innerWidth) {
    menu.style.left = `${window.innerWidth - menuRect.width - 4}px`;
  }
  if (menuRect.bottom > window.innerHeight) {
    menu.style.top = `${window.innerHeight - menuRect.height - 4}px`;
  }

  activeMenuElement = menu;

  // Close on click outside
  const closeHandler = (e: MouseEvent) => {
    if (!menu.contains(e.target as Node)) {
      closeTimelineContextMenu();
      window.removeEventListener("mousedown", closeHandler, true);
    }
  };
  window.addEventListener("mousedown", closeHandler, true);
}
