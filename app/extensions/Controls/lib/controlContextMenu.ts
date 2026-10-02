//! FILENAME: app/extensions/Controls/lib/controlContextMenu.ts
// PURPOSE: The item MODEL and the actions for a floating control's own
//          right-click menu (Duplicate, Copy, Paste, Group, Order, Flip, Edit
//          Script, Apply Template, Size and Position, Make this my own…,
//          Delete).
// CONTEXT: Every item here used to be registered into `gridExtensions`, the
//          registry only `GridContextMenuHost` renders — and that host opens
//          solely on `AppEvents.CONTEXT_MENU_REQUEST`, which Core deliberately
//          does NOT emit for a right-click that lands on a floating object
//          ("Cell options on an object right-click are always wrong",
//          Spreadsheet.tsx). Right-clicking a button, a shape or a picture
//          therefore produced NOTHING: fifteen items, registered, ordered,
//          gated, and unreachable.
//
//          The working precedent is Charts / Slicer / TimelineSlicer / the
//          Floating Range: the object's own extension owns a capture-phase
//          `contextmenu` listener and shows its OWN overlay menu. That listener
//          is `lib/controlObjectMenu.ts`; this module is the part worth
//          keeping — the items and what they do — so there is still exactly one
//          place that decides what a control's menu offers.
//
//          TWO items stay registered with `gridExtensions`, because their
//          context is a CELL, not a floating object, and Core does open the
//          cell menu there: "Paste" ("put the copied control here"), and
//          "Make this my own…" on an IN-CELL button control (below).
//
//          "Make this my own…" (owner question 8, 2026-10-02) is the one item
//          that needs a backend READ to be offered: the floating store knows a
//          control's type and geometry, never its code. So the object menu
//          opens at once with what the store knows, and
//          `refineControlObjectMenu` hands it the whole list again once the
//          read says the BUTTON holds an application's code. An IN-CELL button
//          control has no object menu -- its right-click is Core's cell menu,
//          asked synchronously -- so there the answer is read AHEAD of the
//          right-click (lib/heldEmbeddedButtons.ts). Either way, choosing it
//          runs the Properties pane's own flow (`makeHeldButtonCodeOwnAt`),
//          in run mode as in Design Mode: it runs no button, and its confirm
//          shows the code before anything moves. A button CELL (Cell Type:
//          Button) is not a control and gets no such entry anywhere: its held
//          action keeps "give it an action of your own" (owner decision Q4).

import { gridExtensions } from "@api";
import { AppEvents } from "@api";
import { emitAppEvent } from "@api/events";
import { showToast } from "@api/notifications";
import { readHeldButtonCode, type HeldButtonCode } from "@api/heldButtonCode";
import { getGridRegions } from "@api/gridOverlays";
import { getObjectStackingService, type ObjectStackingCommand } from "@api/objectStacking";
import { sizeAndPositionMenuEntry } from "@api/objectPosition";
import type { GridContextMenuItem, GridMenuContext } from "@api/extensions";
import {
  getSelectedFloatingControls,
  getSelectedControlCount,
} from "../Button/floatingSelection";
import {
  getFloatingControl,
  bringToFront,
  sendToBack,
  bringForward,
  sendBackward,
  syncFloatingControlRegions,
  groupControls,
  ungroupControls,
  getGroupForControl,
  getGroupMembers,
} from "./floatingStore";
import {
  setControlProperty,
  getControlMetadata,
  adoptHeldButtonCode,
} from "./controlApi";
import { requestHeldAdoption, type HeldAdoptionShown } from "../PropertiesPane/HeldCodeSection";
import { inCellButtonHoldsCode, installInCellButtonUpkeep } from "./heldEmbeddedButtons";
import {
  copyControls,
  pasteControl,
  duplicateControls,
  hasClipboardControl,
} from "./controlClipboard";
import {
  canvasOwnsObjectClipboard,
  copySelectedObjects,
  duplicateSelectedObjects,
  runObjectClipboardAction,
} from "@api/objectClipboard";
import {
  invalidateShapeCache,
} from "../Shape/shapeRenderer";
import {
  invalidateImageCache,
} from "../Image/imageRenderer";
import {
  invalidateFloatingButtonCache,
} from "../Button/floatingRenderer";

// ============================================================================
// Menu Item Model
// ============================================================================

/**
 * One entry in a floating control's object menu.
 *
 * There is no `enabled` flag on purpose: `buildControlObjectMenu` returns only
 * the items that apply to the control that was actually clicked, so the rule
 * "a Flip that cannot flip is never offered" lives in ONE function instead of
 * being re-decided by whatever paints the list.
 */
export interface ControlMenuItem {
  id: string;
  label: string;
  shortcut?: string;
  separatorAfter?: boolean;
  /** Marks a destructive action so the menu can paint it as one. */
  destructive?: boolean;
  /** A submenu (Order). Children are always offered when the parent is. */
  children?: ControlMenuItem[];
  run(): void;
}

/**
 * "Paste" — the one id that appears in BOTH menus, because it is the one action
 * whose question ("where should the copy go?") a cell can answer as well as an
 * object can. Spelled once so the two menus cannot drift apart.
 */
const PASTE_ITEM_ID = "controls.paste";

// ============================================================================
// Helpers
// ============================================================================

/** Check if multiple controls are selected (for grouping). */
function isMultipleControlsSelected(): boolean {
  return getSelectedControlCount() >= 2;
}

/**
 * Toggle a flip property on one control.
 *
 * The id is passed in rather than re-read from the selection: the menu opens
 * for the object the pointer is over, and with two controls selected the
 * selection's "primary" is whichever was picked first — acting on that one
 * would flip a shape the user did not right-click.
 */
async function toggleFlip(id: string, property: "flipH" | "flipV"): Promise<void> {
  const ctrl = getFloatingControl(id);
  if (!ctrl) return;

  const metadata = await getControlMetadata(ctrl.sheetIndex, ctrl.row, ctrl.col);
  if (!metadata) return;

  const currentValue = metadata.properties[property]?.value === "true";
  const newValue = !currentValue;

  await setControlProperty(
    ctrl.sheetIndex,
    ctrl.row,
    ctrl.col,
    ctrl.controlType,
    property,
    "static",
    String(newValue),
  );

  // Invalidate cache and refresh
  invalidateShapeCache(id);
  invalidateImageCache(id);
  invalidateFloatingButtonCache(id);
  emitAppEvent(AppEvents.GRID_REFRESH);
}

/**
 * Delete the selected floating control(s).
 *
 * Still routed through the `controls:delete-selected` event that index.ts owns:
 * deletion has to release backend metadata, render caches, group membership and
 * the properties pane together, and that whole sequence lives with the
 * lifecycle owner rather than being re-derived here.
 */
function deleteSelectedControl(): void {
  window.dispatchEvent(new CustomEvent("controls:delete-selected"));
}

// ============================================================================
// Group / Ungroup Handlers
// ============================================================================

function handleGroup(): void {
  const selectedIds = getSelectedFloatingControls();
  if (selectedIds.size < 2) return;

  groupControls([...selectedIds]);
  syncFloatingControlRegions();
  emitAppEvent(AppEvents.GRID_REFRESH);
}

function handleUngroup(id: string): void {
  const groupId = getGroupForControl(id);
  if (!groupId) return;

  ungroupControls(groupId);
  syncFloatingControlRegions();
  emitAppEvent(AppEvents.GRID_REFRESH);
}

// ============================================================================
// Z-Order Handlers
// ============================================================================

/**
 * ON A CANVAS the page owns the paint order of EVERY object
 * (`CanvasLayout.zOrder`) and Core paints and hit-tests by it, so this
 * extension's own order -- its store array, session-only -- would compete with
 * it and silently lose. When the page's stacking service (@api/objectStacking)
 * orders the control, the command goes there instead: the control and its
 * group members move as one block in the page's order. Returns false (the
 * caller falls back to the store's own order) on a worksheet.
 */
export function routeToPageStacking(controlId: string, command: ObjectStackingCommand): boolean {
  const regions = getGridRegions();
  const own = regions.find((r) => r.id === controlId);
  if (!own) return false;
  const service = getObjectStackingService(own);
  if (!service) return false;
  const groupId = getGroupForControl(controlId);
  const ids = new Set(groupId ? getGroupMembers(groupId) : [controlId]);
  ids.add(controlId);
  void service.restack(
    command,
    regions.filter((r) => ids.has(r.id)),
  );
  return true;
}

function handleBringToFront(id: string): void {
  if (routeToPageStacking(id, "bringToFront")) return;
  bringToFront(id);
  syncFloatingControlRegions();
  emitAppEvent(AppEvents.GRID_REFRESH);
}

function handleSendToBack(id: string): void {
  if (routeToPageStacking(id, "sendToBack")) return;
  sendToBack(id);
  syncFloatingControlRegions();
  emitAppEvent(AppEvents.GRID_REFRESH);
}

function handleBringForward(id: string): void {
  if (routeToPageStacking(id, "bringForward")) return;
  bringForward(id);
  syncFloatingControlRegions();
  emitAppEvent(AppEvents.GRID_REFRESH);
}

function handleSendBackward(id: string): void {
  if (routeToPageStacking(id, "sendBackward")) return;
  sendBackward(id);
  syncFloatingControlRegions();
  emitAppEvent(AppEvents.GRID_REFRESH);
}

// ============================================================================
// Copy / Paste / Duplicate Handlers
// ============================================================================

// The menu's Copy and Duplicate do what their keys do (the shortcuts they
// show): on a CANVAS they act on the WHOLE object selection through the object
// clipboard -- every family's objects, one undo step (W25; the right-click made
// this control part of the selection, lib/controlObjectMenu.ts) -- and on a
// worksheet on EVERY selected control (lib/controlKeys.ts), not only the one
// right-clicked. Before, the menu copied or duplicated the clicked control
// alone while Ctrl+C / Ctrl+D took the whole selection.
//
// Like the keys, the worksheet acts run on the object clipboard's queue
// (`runObjectClipboardAction`), reading the subject when their turn comes, so
// a menu Duplicate right behind a Ctrl+D still landing is its own undo step.

/** The controls the menu acts on: the selection when it holds `id`, else `id`. */
function menuSubject(id: string): string[] {
  const selected = [...getSelectedFloatingControls()];
  return selected.includes(id) ? selected : [id];
}

async function handleCopy(id: string): Promise<void> {
  if (canvasOwnsObjectClipboard()) {
    await copySelectedObjects();
    return;
  }
  await runObjectClipboardAction(() => copyControls(menuSubject(id)), { copies: true });
}

async function handlePaste(sheetIndex: number): Promise<void> {
  await pasteControl(sheetIndex);
}

async function handleDuplicate(id: string): Promise<void> {
  if (canvasOwnsObjectClipboard()) {
    await duplicateSelectedObjects();
    return;
  }
  await runObjectClipboardAction(() => duplicateControls(menuSubject(id)));
}

// ============================================================================
// "Make this my own…" (owner question 8)
// ============================================================================

/**
 * The id of "Make this my own…" on a button CONTROL's right-click menu (owner
 * question 8, 2026-10-02): a floating button's object menu and, for an
 * in-cell button control, Core's cell menu -- one id, like Paste's, so the two
 * menus cannot drift apart. Button CONTROLS only: a button CELL keeps its own
 * remedy, "give it an action of your own" (owner decision Q4) -- dropping its
 * stamp would WIDEN what it runs.
 */
export const MAKE_HELD_CODE_OWN_ITEM_ID = "controls.makeHeldCodeOwn";

/**
 * What the object menu can know only from a backend READ: the floating store
 * holds a control's type and geometry, never its code.
 */
export interface ControlMenuFacts {
  /** The application code a BUTTON holds (`readHeldButtonCode`); null or absent for none. */
  heldCode?: HeldButtonCode | null;
}

/**
 * The application code a button control holds right now, read from the
 * backend through the same reading the Properties pane uses
 * (`readHeldButtonCode`). Null when it holds none, or is no longer a button.
 * Rejects when the read fails: each caller decides what that means.
 */
async function readButtonHeldCode(ctrl: {
  sheetIndex: number;
  row: number;
  col: number;
}): Promise<HeldButtonCode | null> {
  const metadata = await getControlMetadata(ctrl.sheetIndex, ctrl.row, ctrl.col);
  return metadata?.controlType === "button" ? readHeldButtonCode(metadata.properties) : null;
}

/** A refused or failed adoption, in the Properties pane's words (PropertiesPane.handleAdoptHeld). */
function sayAdoptionFailed(err: unknown): void {
  showToast(`Could not make the application's code your own: ${String(err)}`, { type: "error" });
}

/**
 * "Make this my own…" chosen from a button's right-click menu: the Properties
 * pane's flow, step for step, so the two doors cannot drift apart --
 *
 *   1. read what the button holds NOW (the menu may have been open a while);
 *   2. capture exactly the texts the confirm is about to show, BEFORE it is
 *      asked (HeldCodeSection's rule);
 *   3. `requestHeldAdoption` -- the pane's own confirm, which SHOWS the code
 *      and says what follows; `confirmAsync`, awaited, failing closed;
 *   4. on an explicit yes only, `adoptHeldButtonCode` with the shown texts.
 *      Rust MOVES the held code into the live slots as ONE undo step and
 *      writes the always-on `ButtonCodeAdopted` row; it refuses, with nothing
 *      written, code that changed after it was shown;
 *   5. a refusal is said in the pane's words.
 *
 * Then an open Properties pane on this button re-reads it: it shows the held
 * view and its own "Make this my own…" step, which Rust would refuse once the
 * code has moved.
 */
export async function makeHeldButtonCodeOwn(controlId: string): Promise<void> {
  const ctrl = getFloatingControl(controlId);
  if (!ctrl || ctrl.controlType !== "button") return;
  await makeHeldButtonCodeOwnAt(ctrl);
}

/**
 * The same flow for the button control anchored at a cell -- how the cell
 * menu reaches an IN-CELL button control, which is not in the floating store.
 * The read in step 1 is what decides: a cell that holds no button control, or
 * one whose code is no longer held, is said and nothing is changed.
 */
export async function makeHeldButtonCodeOwnAt(at: {
  sheetIndex: number;
  row: number;
  col: number;
}): Promise<void> {
  const { sheetIndex, row, col } = at;

  let held: HeldButtonCode | null;
  try {
    held = await readButtonHeldCode(at);
  } catch (err) {
    sayAdoptionFailed(err);
    return;
  }
  if (!held) {
    showToast("This button no longer holds code that came with an application; nothing was changed.", {
      type: "warning",
    });
    return;
  }

  // Exactly what the confirm is about to show: if the held code changes while
  // the dialog is open, Rust refuses these texts -- a read after the confirm
  // would adopt code the author never saw.
  const shown: HeldAdoptionShown = { onSelect: held.onSelect, macroRef: held.macroRef };
  if (!(await requestHeldAdoption(held))) return;

  try {
    await adoptHeldButtonCode(sheetIndex, row, col, shown.onSelect, shown.macroRef);
  } catch (err) {
    sayAdoptionFailed(err);
  }
  window.dispatchEvent(
    new CustomEvent("controls:metadata-refresh", { detail: { sheetIndex, row, col } }),
  );
}

/**
 * The object menu once the facts only a backend read can give are known:
 * resolves to the WHOLE list again, now with "Make this my own…" when the
 * BUTTON holds an application's code, or null when the read adds nothing -- the
 * menu then keeps the list it opened with. Only a button is read. A read that
 * fails offers nothing more; the Properties pane still shows the code and its
 * own step.
 */
export async function refineControlObjectMenu(controlId: string): Promise<ControlMenuItem[] | null> {
  const ctrl = getFloatingControl(controlId);
  if (!ctrl || ctrl.controlType !== "button") return null;
  let heldCode: HeldButtonCode | null;
  try {
    heldCode = await readButtonHeldCode(ctrl);
  } catch (err) {
    console.warn("[Controls] The button's code could not be read; its menu offers no \"Make this my own\":", err);
    return null;
  }
  return heldCode ? buildControlObjectMenu(controlId, { heldCode }) : null;
}

// ============================================================================
// The Object Menu
// ============================================================================

/**
 * Build the right-click menu for ONE floating control.
 *
 * Evaluated at OPEN time, against the control the pointer is actually over, so
 * the offer matches the object: a button has no Flip and no Edit Script, a
 * shape has both, and Group appears only when a second control is selected to
 * group it with. `facts` carries what only a backend read can say
 * ({@link refineControlObjectMenu}); without them nothing that depends on them
 * is offered.
 *
 * Items that do not apply are OMITTED, never greyed out — the same rule the
 * `visible()` predicates carried when these items still lived in the grid
 * registry.
 */
export function buildControlObjectMenu(controlId: string, facts: ControlMenuFacts = {}): ControlMenuItem[] {
  const ctrl = getFloatingControl(controlId);
  if (!ctrl) return [];

  const isShape = ctrl.controlType === "shape";
  const isFlippable = isShape || ctrl.controlType === "image";
  const items: ControlMenuItem[] = [];

  items.push({
    id: "controls.duplicate",
    label: "Duplicate",
    shortcut: "Ctrl+D",
    run: () => void handleDuplicate(controlId),
  });

  items.push({
    id: "controls.copy",
    label: "Copy",
    shortcut: "Ctrl+C",
    run: () => void handleCopy(controlId),
  });

  if (hasClipboardControl()) {
    items.push({
      id: PASTE_ITEM_ID,
      label: "Paste",
      shortcut: "Ctrl+V",
      // The control's OWN sheet, not the active sheet: the menu is anchored to
      // an object, and the object knows which sheet it lives on.
      run: () => void handlePaste(ctrl.sheetIndex),
    });
  }

  if (isMultipleControlsSelected()) {
    items.push({
      id: "controls.group",
      label: "Group",
      shortcut: "Ctrl+G",
      run: handleGroup,
    });
  }

  if (getGroupForControl(controlId) !== null) {
    items.push({
      id: "controls.ungroup",
      label: "Ungroup",
      shortcut: "Ctrl+Shift+G",
      run: () => handleUngroup(controlId),
    });
  }

  items.push({
    id: "controls.order",
    label: "Order",
    separatorAfter: true,
    run: () => {
      /* Parent of a submenu: opening it is the whole action. */
    },
    children: [
      {
        id: "controls.order.bringToFront",
        label: "Bring to Front",
        run: () => handleBringToFront(controlId),
      },
      {
        id: "controls.order.bringForward",
        label: "Bring Forward",
        run: () => handleBringForward(controlId),
      },
      {
        id: "controls.order.sendBackward",
        label: "Send Backward",
        run: () => handleSendBackward(controlId),
      },
      {
        id: "controls.order.sendToBack",
        label: "Send to Back",
        run: () => handleSendToBack(controlId),
      },
    ],
  });

  if (isFlippable) {
    items.push({
      id: "controls.flipH",
      label: "Flip Horizontal",
      run: () => void toggleFlip(controlId, "flipH"),
    });
    items.push({
      id: "controls.flipV",
      label: "Flip Vertical",
      separatorAfter: true,
      run: () => void toggleFlip(controlId, "flipV"),
    });
  }

  if (isShape) {
    items.push({
      id: "controls.editScript",
      label: "Edit Script...",
      run: () => {
        emitAppEvent("scriptable-objects:edit-script", {
          objectType: "shape",
          instanceId: controlId,
          objectName: `Shape (${ctrl.row}, ${ctrl.col})`,
        });
      },
    });
    items.push({
      id: "controls.applyTemplate",
      label: "Apply Template...",
      separatorAfter: true,
      run: () => emitAppEvent("shape:openTemplateGallery", { instanceId: controlId }),
    });
  }

  // Size and Position (@api/objectPosition; BUG-0258 design phase 5b): the
  // no-drag route to place and size the control, the row every object menu
  // carries. Omitted (this menu greys nothing out) only when no dialog can
  // open for it; a RUN-MODE button opens it read-only, saying that Design Mode
  // is what lets it move.
  const region = getGridRegions().find((r) => r.id === controlId);
  const sizePos = region ? sizeAndPositionMenuEntry(region) : null;
  if (sizePos && !sizePos.disabled) {
    items.push({
      id: "controls.sizeAndPosition",
      label: sizePos.label,
      separatorAfter: true,
      run: sizePos.run,
    });
  }

  // "Make this my own…" (owner question 8): only when a read found an
  // application's code on this BUTTON. In its own group right above Delete, so
  // when the read answers after the menu opened, only Delete moves.
  if (ctrl.controlType === "button" && facts.heldCode) {
    items.push({
      id: MAKE_HELD_CODE_OWN_ITEM_ID,
      label: "Make this my own…",
      separatorAfter: true,
      run: () => void makeHeldButtonCodeOwn(controlId),
    });
  }

  items.push({
    id: "controls.delete",
    label: "Delete",
    shortcut: "Del",
    destructive: true,
    run: deleteSelectedControl,
  });

  // A separator declared by an item that ended up LAST would paint a rule under
  // the menu's bottom edge. The flag is a "there is more below" marker, so the
  // last item never carries one.
  const last = items[items.length - 1];
  if (last?.separatorAfter) items[items.length - 1] = { ...last, separatorAfter: false };

  return items;
}

// ============================================================================
// Cell Menu Registration
// ============================================================================

/**
 * Register the control items whose context is a CELL rather than an object:
 *
 *   - "Paste", which answers "put the copied control HERE". Core does open its
 *     cell menu on an empty cell, so this item — unlike the fourteen object
 *     items that used to sit beside it — has always been reachable, and it is
 *     the only route to paste a control when none is selected (the Ctrl+V
 *     handler in index.ts requires a selected control before it intercepts).
 *   - "Make this my own…" on an IN-CELL button control that holds an
 *     application's code (owner question 8): its right-click IS this cell
 *     menu. Offered from the answer read ahead of the right-click
 *     (lib/heldEmbeddedButtons.ts, kept current by the upkeep installed here);
 *     choosing it reads the button again and runs the pane's flow.
 *
 * Returns a cleanup function that unregisters both and stops the upkeep.
 */
export function registerControlContextMenu(): () => void {
  const items: GridContextMenuItem[] = [
    {
      id: PASTE_ITEM_ID,
      label: "Paste",
      shortcut: "Ctrl+V",
      group: "controls",
      order: 3,
      visible: () => hasClipboardControl(),
      onClick: (context: GridMenuContext) => void handlePaste(context.sheetIndex),
    },
    {
      id: MAKE_HELD_CODE_OWN_ITEM_ID,
      label: "Make this my own…",
      group: "controls",
      order: 4,
      visible: (context: GridMenuContext) =>
        context.clickedCell !== null &&
        inCellButtonHoldsCode(context.sheetIndex, context.clickedCell.row, context.clickedCell.col),
      onClick: (context: GridMenuContext) => {
        const cell = context.clickedCell;
        if (!cell) return;
        void makeHeldButtonCodeOwnAt({ sheetIndex: context.sheetIndex, row: cell.row, col: cell.col });
      },
    },
  ];

  gridExtensions.registerContextMenuItems(items);
  const stopUpkeep = installInCellButtonUpkeep();

  return () => {
    stopUpkeep();
    gridExtensions.unregisterContextMenuItem(PASTE_ITEM_ID);
    gridExtensions.unregisterContextMenuItem(MAKE_HELD_CODE_OWN_ITEM_ID);
  };
}
