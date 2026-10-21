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
//          Below the pivot's own items sit "Size and Position...", the row
//          every object menu carries (@api/objectPosition; BUG-0258 design
//          phase 5b): the no-drag route to place and size the box -- and
//          "Format...", the object pane's door every family menu carries
//          (@api/objectPane `objectPaneMenuEntry`, WP-C review R2-15b).
//
//          While the menu is open it owns Escape: the canvas's Escape binding
//          asks the object-selection providers first (`ownsKey`,
//          pivotVisualSelection.ts), so Escape closes the menu instead of
//          deselecting the box behind it (the FloatingRange precedent).

import { gridExtensions, showToast, type GridContextMenuItem, type GridMenuContext, type Selection } from "@api";
import { topFloatingRegionAtClient, type GridRegion } from "@api/gridOverlays";
import { sizeAndPositionMenuEntry } from "@api/objectPosition";
import { objectPaneMenuEntry } from "@api/objectPane";
import { getGridStateSnapshot } from "@api/grid";
import { selectObject } from "@api/objectSelection";
import { getPivotVisualRecord, viewCellAtCanvasPoint } from "./pivotVisualHits";
import { PIVOT_VISUAL_REGION_TYPE, pivotIdOfVisual } from "./pivotVisualRegions";
import { notePivotBoxMenuOpened } from "./pivotVisualMenuState";
import {
  getPivotCellSelection,
  isViewCellSelected,
  pivotCellGridRange,
  setPivotCellAnchor,
} from "./pivotVisualCellSelection";
import { isPivotVisualSelected } from "../handlers/selectionHandler";
import { clearSelectionsFiltering, isShowingFilteredView } from "./pivotCrossFilterView";

export { isPivotBoxMenuOpen } from "./pivotVisualMenuState";

/** The grid-menu group every pivot item registers under. */
export const PIVOT_MENU_GROUP = "pivot";

/** What a right-click on a canvas pivot box targets. */
export interface PivotBoxMenuTarget {
  pivotId: string;
  context: GridMenuContext;
  /** The box's published region (what Size and Position opens for). */
  region: GridRegion;
  /** The VIEW cell under the pointer, or null (blank area, the scroll gutter). */
  viewCell: { viewRow: number; viewCol: number } | null;
}

/**
 * The target of a right-click at a CLIENT point, or null when the topmost
 * floating object there is not a canvas pivot box (or the box has not been
 * painted yet). PURE: it states the context the menu will run with once
 * `handlePivotBoxContextMenu` has selected the box and placed the cells.
 *
 *   - The clicked cell is the hidden-grid cell under the pointer.
 *   - On a cell INSIDE the box's current cell selection (D-CELLS), the menu's
 *     selection is that whole rectangle mapped to the hidden grid; on a cell
 *     outside it (or with none) the right-click re-anchors there, so the
 *     selection is that one cell -- Excel's rule for a right-click on cells.
 *   - A point on no cell (the box's empty area, the scroll gutter) targets the
 *     pivot's anchor cell, which still names the pivot.
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
  let selection: Selection = { startRow: row, startCol: col, endRow: row, endCol: col, type: "cells" };
  const cells = getPivotCellSelection();
  if (at && cells !== null && cells.pivotId === pivotId && isViewCellSelected(at.viewRow, at.viewCol)) {
    selection = { ...pivotCellGridRange(cells, record.startRow, record.startCol), type: "cells" };
  }
  return {
    pivotId,
    region: top,
    viewCell: at,
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

/** The id of the box menu's "Size and Position..." row. */
export const PIVOT_BOX_SIZE_POSITION_ITEM_ID = "pivot.box.sizeAndPosition";
/** The id of the box menu's "Format..." row (opens the object pane on Format). */
export const PIVOT_BOX_FORMAT_ITEM_ID = "pivot.box.format";
/** The id of the filtered box's "Clear visual selection" row (P4 S7). */
export const PIVOT_BOX_CLEAR_SELECTION_ITEM_ID = "pivot.box.clearVisualSelection";
/** The one pivot item a FILTERED box's cells keep: Copy (it copies what is shown). */
const FILTERED_BOX_KEPT_ITEM_IDS: ReadonlySet<string> = new Set(["pivot:copy"]);

/**
 * The pivot group's items for a context (visible ones, labels resolved) and,
 * given the box's `region`, the "Size and Position..." and "Format..." rows
 * under them.
 */
export function pivotBoxMenuItems(context: GridMenuContext, region: GridRegion | null = null): GridContextMenuItem[] {
  let items = gridExtensions.getContextMenuItemsForContext(context).filter((item) => item.group === PIVOT_MENU_GROUP);
  // A box showing a FILTERED view (P4 S7): its cells are a transient view's,
  // and every pivot item acts on the REAL pivot by a cell's groupPath or field
  // index -- so the cells offer only Copy (what is shown) and "Clear visual
  // selection" (back to the real view). The object rows below stay.
  const pivotId = region ? pivotIdOfVisual(region) : null;
  if (pivotId !== null && isShowingFilteredView(pivotId)) {
    items = items.filter((item) => FILTERED_BOX_KEPT_ITEM_IDS.has(item.id));
    items.push({
      id: PIVOT_BOX_CLEAR_SELECTION_ITEM_ID,
      label: "Clear visual selection",
      group: PIVOT_MENU_GROUP,
      onClick: () => clearSelectionsFiltering(pivotId),
    });
  }
  if (!region) return items;
  const entry = sizeAndPositionMenuEntry(region);
  const last = items[items.length - 1];
  const out = last && !last.separatorAfter ? [...items.slice(0, -1), { ...last, separatorAfter: true }] : [...items];
  out.push({
    id: PIVOT_BOX_SIZE_POSITION_ITEM_ID,
    label: entry.label,
    group: PIVOT_MENU_GROUP,
    disabled: entry.disabled,
    onClick: () => entry.run(),
  });
  const format = objectPaneMenuEntry(region);
  out.push({
    id: PIVOT_BOX_FORMAT_ITEM_ID,
    label: format.label,
    group: PIVOT_MENU_GROUP,
    disabled: format.disabled,
    ...(format.reason ? { disabledReason: format.reason } : {}),
    onClick: () => format.run(),
  });
  return out;
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
 * The disabled reason of an item as text: the registry hands it resolved, but
 * an item built here (or a test double) may still carry the function form.
 */
function disabledReasonText(item: GridContextMenuItem, context: GridMenuContext): string | null {
  const reason = typeof item.disabledReason === "function" ? item.disabledReason(context) : item.disabledReason;
  return typeof reason === "string" && reason !== "" ? reason : null;
}

/**
 * A row's action failed: tell the USER (BUG-0096 -- never the console alone).
 * The pivot items report their own failures; this catches whatever reaches
 * the box menu unreported (Size and Position, a future item).
 */
function reportBoxMenuFailure(item: GridContextMenuItem, context: GridMenuContext, error: unknown): void {
  console.error(`[PivotMenu] "${item.id}" failed:`, error);
  const label = typeof item.label === "string" ? item.label : item.label(context);
  const msg = error instanceof Error ? error.message : String(error);
  showToast(`${label.replace(/\.\.\.$/, "")} failed: ${msg}`, { variant: "error" });
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
    // A disabled row says WHY (the registry resolved the reason to a string).
    const reason = disabled ? disabledReasonText(item, context) : null;
    if (reason) {
      row.title = reason;
      row.setAttribute("aria-description", reason);
    }
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
        .catch((error) => reportBoxMenuFailure(item, context, error));
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
  const items = pivotBoxMenuItems(target.context, target.region);
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
 *
 * Before the menu opens, the right-click does what it does on every other
 * family: an unselected box is SELECTED first (`selectObject`, keyboard
 * semantics -- no pane opens), and a right-click on a cell outside the box's
 * cell selection re-anchors the selection there (D-CELLS), so the menu acts
 * on what the user sees selected.
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
  if (!isPivotVisualSelected(target.pivotId)) selectObject(target.region);
  const at = target.viewCell;
  if (at) {
    const cells = getPivotCellSelection();
    const inside = cells !== null && cells.pivotId === target.pivotId && isViewCellSelected(at.viewRow, at.viewCol);
    if (!inside) setPivotCellAnchor(target.pivotId, at.viewRow, at.viewCol);
  }
  openPivotBoxMenu(e.clientX, e.clientY, target);
  return true;
}
