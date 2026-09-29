//! FILENAME: app/extensions/Pivot/lib/pivotVisualContextMenu.ts
// PURPOSE: The right-click menu of a CANVAS pivot box: the same pivot menu a
//          worksheet pivot's cells get, with the box's pivot as its target.
// CONTEXT: The pivot menu is registered into the grid context menu
//          (`pivotContextMenu.ts`, items visible when the right-clicked CELL is
//          inside a pivot region), and that menu opens only from
//          `AppEvents.CONTEXT_MENU_REQUEST`, which Core deliberately does not
//          emit for a right-click on a floating object ("cell options on an
//          object right-click are always wrong", Spreadsheet.tsx). A canvas
//          pivot IS a floating object (`pivot-visual`), so right-clicking one
//          did nothing at all (open-items 2.af).
//
//          The worked precedent is Slicer's: a capture-phase `contextmenu`
//          listener claims the gesture when the object is the TOPMOST one
//          under the pointer (`topFloatingRegionAtClient` -- a box covered by
//          a chart leaves the chart its own menu) and shows the family's own
//          menu. The items are the pivot group's own registrations, resolved
//          for a context whose clicked cell is the hidden-grid cell under the
//          pointer (view cell -> anchor + offset, the mapping the double-click
//          uses), so Sort / Filter / Subtotal / Expand act on the field under
//          the pointer exactly as on a worksheet -- and Core's cell items
//          (Cut, Insert Row ...) never appear on a canvas.
//
//          While the menu is open it owns Escape: the canvas's Escape binding
//          asks the object-selection providers first (`ownsKey`,
//          pivotVisualSelection.ts), so Escape closes the menu instead of
//          deselecting the box behind it (the FloatingRange precedent).

import { gridExtensions, type GridContextMenuItem, type GridMenuContext, type Selection } from "@api";
import { topFloatingRegionAtClient } from "@api/gridOverlays";
import { getGridStateSnapshot } from "@api/grid";
import { getPivotVisualRecord, viewCellAtCanvasPoint } from "./pivotVisualHits";
import { PIVOT_VISUAL_REGION_TYPE, pivotIdOfVisual } from "./pivotVisualRegions";
import { notePivotBoxMenuOpened } from "./pivotVisualMenuState";

export { isPivotBoxMenuOpen } from "./pivotVisualMenuState";

/** The grid-menu group every pivot item registers under. */
export const PIVOT_MENU_GROUP = "pivot";

/** What a right-click on a canvas pivot box targets. */
export interface PivotBoxMenuTarget {
  pivotId: string;
  context: GridMenuContext;
}

/**
 * The target of a right-click at a CLIENT point, or null when the topmost
 * floating object there is not a canvas pivot box (or the box has not been
 * painted yet). The clicked cell is the hidden-grid cell under the pointer;
 * a point on no cell (the box's empty area, the scroll gutter) targets the
 * pivot's anchor cell, which still names the pivot.
 */
export function pivotBoxMenuTargetAt(clientX: number, clientY: number): PivotBoxMenuTarget | null {
  const top = topFloatingRegionAtClient(clientX, clientY);
  if (!top || top.type !== PIVOT_VISUAL_REGION_TYPE) return null;
  const pivotId = pivotIdOfVisual(top);
  if (pivotId === null) return null;
  const record = getPivotVisualRecord(pivotId);
  if (!record) return null;

  const area = document.querySelector("[data-grid-area]");
  const state = getGridStateSnapshot();
  if (!area || !state) return null;
  const rect = area.getBoundingClientRect();
  const zoom = state.zoom || 1;
  const at = viewCellAtCanvasPoint(record, (clientX - rect.left) / zoom, (clientY - rect.top) / zoom);
  const row = record.startRow + (at?.viewRow ?? 0);
  const col = record.startCol + (at?.viewCol ?? 0);
  const selection: Selection = { startRow: row, startCol: col, endRow: row, endCol: col, type: "cells" };
  return {
    pivotId,
    context: {
      selection,
      clickedCell: { row, col },
      isWithinSelection: true,
      sheetIndex: state.sheetContext.activeSheetIndex,
      sheetName: state.sheetContext.activeSheetName,
      dimensions: state.dimensions,
    },
  };
}

/** The pivot group's items for a context: visible ones, labels resolved. */
export function pivotBoxMenuItems(context: GridMenuContext): GridContextMenuItem[] {
  return gridExtensions.getContextMenuItemsForContext(context).filter((item) => item.group === PIVOT_MENU_GROUP);
}

// ============================================================================
// The menu
// ============================================================================

/** The open menu's root and its teardown. */
let open: { root: HTMLDivElement; teardown: () => void } | null = null;

/** Close the menu (and every sub-menu); a no-op when none is open. */
export function closePivotBoxMenu(): void {
  const current = open;
  open = null;
  current?.teardown();
}

const MENU_CSS = `
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

/** Keep a menu inside the window. */
function place(menu: HTMLDivElement, left: number, top: number): void {
  const r = menu.getBoundingClientRect();
  const x = left + r.width > window.innerWidth ? Math.max(0, window.innerWidth - r.width - 4) : left;
  const y = top + r.height > window.innerHeight ? Math.max(0, window.innerHeight - r.height - 4) : top;
  menu.style.left = `${x}px`;
  menu.style.top = `${y}px`;
}

/**
 * One menu level. `onSubmenu` is told which row opened which child menu, so a
 * level keeps at most one child open.
 */
function buildLevel(
  items: GridContextMenuItem[],
  context: GridMenuContext,
  menus: HTMLDivElement[],
  depth: number,
): HTMLDivElement {
  const menu = document.createElement("div");
  menu.setAttribute("role", "menu");
  menu.dataset.pivotBoxMenu = String(depth);
  menu.style.cssText = MENU_CSS;
  let child: HTMLDivElement | null = null;
  const closeChild = () => {
    if (!child) return;
    // Every deeper level goes with it.
    for (const m of menus.splice(menus.indexOf(child))) m.remove();
    child = null;
  };

  for (const item of items) {
    const row = document.createElement("div");
    row.setAttribute("role", "menuitem");
    row.dataset.itemId = item.id;
    const disabled = !!item.disabled;
    row.setAttribute("aria-disabled", String(disabled));
    row.style.cssText = `
      padding: 6px 28px 6px 20px;
      cursor: ${disabled ? "default" : "pointer"};
      color: ${disabled ? "#aaa" : "#333"};
      position: relative;
      white-space: nowrap;
    `;
    const label = document.createElement("span");
    label.textContent = typeof item.label === "string" ? item.label : item.label(context);
    row.appendChild(label);
    const hasChildren = !!item.children && item.children.length > 0;
    if (hasChildren) {
      const arrow = document.createElement("span");
      arrow.textContent = ">";
      arrow.style.cssText = "position: absolute; right: 10px;";
      row.appendChild(arrow);
    }

    row.addEventListener("mouseenter", () => {
      if (!disabled) row.style.background = "#e8f0fe";
      closeChild();
      if (hasChildren && !disabled) {
        const sub = buildLevel(item.children!, context, menus, depth + 1);
        document.body.appendChild(sub);
        menus.push(sub);
        child = sub;
        const r = row.getBoundingClientRect();
        place(sub, r.right, r.top - 4);
      }
    });
    row.addEventListener("mouseleave", () => {
      row.style.background = "transparent";
    });
    row.addEventListener("click", (e) => {
      e.stopPropagation();
      if (disabled || hasChildren) return;
      closePivotBoxMenu();
      Promise.resolve()
        .then(() => item.onClick(context))
        .catch((error) => console.error(`[PivotMenu] "${item.id}" failed:`, error));
    });
    menu.appendChild(row);

    if (item.separatorAfter) {
      const sep = document.createElement("div");
      sep.style.cssText = "height: 1px; background: #e0e0e0; margin: 4px 0;";
      menu.appendChild(sep);
    }
  }
  return menu;
}

/** Show the menu for `target` at a client point; false when no item applies. */
export function openPivotBoxMenu(clientX: number, clientY: number, target: PivotBoxMenuTarget): boolean {
  closePivotBoxMenu();
  const items = pivotBoxMenuItems(target.context);
  if (items.length === 0) return false;

  const menus: HTMLDivElement[] = [];
  const root = buildLevel(items, target.context, menus, 0);
  document.body.appendChild(root);
  menus.push(root);
  place(root, clientX, clientY);

  const inside = (node: EventTarget | null) => menus.some((m) => node instanceof Node && m.contains(node));
  const onPointerDown = (e: MouseEvent) => {
    if (!inside(e.target)) closePivotBoxMenu();
  };
  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key !== "Escape") return;
    e.preventDefault();
    e.stopPropagation();
    closePivotBoxMenu();
  };
  const onBlur = () => closePivotBoxMenu();
  // Attached after this event's dispatch, so the right-click that opened the
  // menu cannot close it.
  const attach = setTimeout(() => {
    document.addEventListener("mousedown", onPointerDown, true);
    window.addEventListener("blur", onBlur);
  }, 0);
  document.addEventListener("keydown", onKeyDown, true);
  const release = notePivotBoxMenuOpened();

  open = {
    root,
    teardown: () => {
      release();
      clearTimeout(attach);
      document.removeEventListener("mousedown", onPointerDown, true);
      document.removeEventListener("keydown", onKeyDown, true);
      window.removeEventListener("blur", onBlur);
      for (const m of menus.splice(0)) m.remove();
    },
  };
  return true;
}

/**
 * The capture-phase `contextmenu` handler. Claims the gesture -- the grid's
 * own handler and every later listener stand down -- only when a canvas pivot
 * box is the topmost object under the pointer. Returns whether it claimed.
 */
export function handlePivotBoxContextMenu(e: MouseEvent): boolean {
  // Shift+right-click is the browser's own menu, as on the grid.
  if (e.shiftKey) return false;
  const target = pivotBoxMenuTargetAt(e.clientX, e.clientY);
  if (!target) {
    closePivotBoxMenu();
    return false;
  }
  e.preventDefault();
  e.stopPropagation();
  e.stopImmediatePropagation();
  openPivotBoxMenu(e.clientX, e.clientY, target);
  return true;
}
