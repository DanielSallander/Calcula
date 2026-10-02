//! FILENAME: app/src/api/objectPosition.ts
// PURPOSE: The SIZE AND POSITION seam (BUG-0258 design phase 5b): the one
//          route that moves and sizes a floating object of ANY family without
//          dragging it, and the menu its grip opens.
// CONTEXT: WCAG 2.2 SC 2.5.7 asks for a way to move an object without a drag,
//          and says arrow-key nudging alone does not meet it. The design's
//          answer is a small dialog -- X, Y, Width, Height -- reached from three
//          doors that must agree about what it may do:
//
//            - the GRIP's menu (Core dispatches `floatingObject:gripClick`,
//              @api/objectGrip; "Size and Position..." is its FIRST item);
//            - every object family's own right-click menu (Slicer, Timeline,
//              Charts, the floating grid, Controls, the canvas pivot box), each
//              of which asks `sizeAndPositionMenuEntry` for its row;
//            - the canvas's Arrange group (CanvasSheet).
//
//          This module owns only the RULES and the registries: what an object
//          may do (`sizeAndPositionAvailability` -- the same three refusals
//          Core's drag applies, `resolveFloatingZone`), who opens the dialog
//          (`registerSizeAndPositionOpener`, last wins: the BuiltIn
//          ObjectPosition extension), and what else the grip's menu lists
//          (`registerObjectGripMenuItem`: the canvas contributes Bring Forward,
//          Send Backward and Lock). The dialog commits through
//          @api/objectGeometry as ONE undo step, so the families never learn a
//          new door -- callers say WHAT, the owning family decides HOW.
//
//          The menu row is ENABLED whenever the dialog can open for the object
//          (a geometry provider owns it and the dialog is installed). An object
//          Core would refuse to move -- locked, on a subscribed page, a
//          run-mode button -- still opens it, READ-ONLY, with the reason: its
//          position is information, and the reason is how the user learns what
//          to change (plan decision D7). Only an object no provider owns gets a
//          disabled row.
//
//          Feature-neutral: nothing here imports an extension. Not on
//          @api/index.ts; import it as "@api/objectPosition".

import type { GridRegion } from "./gridOverlays";
import { canMoveObject, canResizeObject } from "./objectGeometry";
import { getLayoutSurface, isRegionLocked } from "./layoutSurface";
import { getDesignMode } from "./designMode";
import { getGridStateSnapshot } from "../core/state/GridContext";

// ============================================================================
// Names
// ============================================================================

/** The label of the command in every menu that offers it. */
export const SIZE_AND_POSITION_LABEL = "Size and Position...";

/** The command id (the canvas selection's primary object). */
export const SIZE_AND_POSITION_COMMAND = "object.sizeAndPosition";

/** The stable id of the menu row, in every family's menu and the grip's. */
export const SIZE_AND_POSITION_ITEM_ID = "object.sizeAndPosition";

/** The undo step a Size and Position commit records. */
export const SIZE_AND_POSITION_UNDO_LABEL = "Size and Position";

/** The smallest width or height the dialog will set, in logical px. */
export const SIZE_AND_POSITION_MIN_SIZE = 16;

// ============================================================================
// What an object may do
// ============================================================================

/** Why the dialog cannot set anything: no geometry provider owns the object. */
export const SIZE_POSITION_NO_PROVIDER = "This object cannot be moved or sized from here.";
/** Why: the page is a subscribed application page (the layout is the publisher's). */
export const SIZE_POSITION_SUBSCRIBED =
  "This page comes from an application, so its layout is the publisher's. Detach the sheet to change it.";
/** Why: the page locks the object. */
export const SIZE_POSITION_LOCKED = "This object is locked. Unlock it to move or size it.";
/** Why: the family refuses a move outside Design Mode (a run-mode button). */
export const SIZE_POSITION_DESIGN_MODE = "Turn on Design Mode to move or size it.";
/** Why: the family refuses a move for a reason of its own. */
export const SIZE_POSITION_IMMOVABLE = "This object cannot be moved right now.";
/** Why only the size is refused: the family derives it (a floating grid: rows and columns). */
export const SIZE_POSITION_FIXED_SIZE = "Its size follows its content, so only its position can be set here.";
/** Why a menu row is disabled: no Size and Position dialog is installed. */
export const SIZE_POSITION_NOT_INSTALLED = "Size and Position is not available.";

/** What the dialog may do for one object right now. */
export interface SizeAndPositionAvailability {
  /** A geometry provider owns the object: the dialog can read (and maybe set) its rectangle. */
  provided: boolean;
  /** Its position may change now. */
  move: boolean;
  /** Its size may change now (never without `move`). */
  resize: boolean;
  /** Why nothing may change (`move` false), or null. */
  reason: string | null;
  /** Why only the SIZE may not change (`move` true, `resize` false), or null. */
  sizeReason: string | null;
  /** The page the object must stay on (a canvas), or null (a worksheet: unbounded). */
  page: { width: number; height: number } | null;
}

function activeSurface() {
  return getLayoutSurface(getGridStateSnapshot()?.sheetContext.activeSheetIndex ?? 0);
}

/**
 * What Size and Position may do for the object behind `region`, by the rule
 * Core's own drag applies (@api/gridOverlays `resolveFloatingZone`):
 *
 *   - no geometry provider owns it (or it is cell-anchored): nothing;
 *   - the active page is not editable (a subscribed canvas): nothing;
 *   - the page locks it: nothing;
 *   - its family published `movable: false` (a run-mode button): nothing;
 *   - otherwise it moves, and it resizes where its provider allows
 *     (`canResizeObject`: a floating grid's size is its rows and columns).
 *
 * Checked in that order, so the reason is the first thing to change.
 */
export function sizeAndPositionAvailability(region: GridRegion): SizeAndPositionAvailability {
  const surface = activeSurface();
  const page = surface?.page ? { width: surface.page.width, height: surface.page.height } : null;
  const refuse = (provided: boolean, reason: string): SizeAndPositionAvailability => ({
    provided,
    move: false,
    resize: false,
    reason,
    sizeReason: null,
    page,
  });
  if (!canMoveObject(region)) return refuse(false, SIZE_POSITION_NO_PROVIDER);
  if (surface && !surface.editable) return refuse(true, SIZE_POSITION_SUBSCRIBED);
  if (isRegionLocked(surface, region)) return refuse(true, SIZE_POSITION_LOCKED);
  if (region.data?.movable === false) {
    return refuse(true, getDesignMode() ? SIZE_POSITION_IMMOVABLE : SIZE_POSITION_DESIGN_MODE);
  }
  const resize = canResizeObject(region);
  return {
    provided: true,
    move: true,
    resize,
    reason: null,
    sizeReason: resize ? null : SIZE_POSITION_FIXED_SIZE,
    page,
  };
}

// ============================================================================
// Who opens the dialog
// ============================================================================

/** A rectangle in CLIENT px (a menu or a grip the dialog was opened from). */
export interface SizeAndPositionAnchor {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Opens the Size and Position dialog for one object. */
export type SizeAndPositionOpener = (region: GridRegion, anchor?: SizeAndPositionAnchor) => void;

let opener: SizeAndPositionOpener | null = null;

/**
 * Install THE Size and Position dialog. Last registration wins; the cleanup
 * removes only what is still this registration (a stale cleanup cannot remove
 * a newer one -- the controlsService precedent).
 */
export function registerSizeAndPositionOpener(open: SizeAndPositionOpener): () => void {
  opener = open;
  return () => {
    if (opener === open) opener = null;
  };
}

/** Whether a Size and Position dialog is installed. */
export function hasSizeAndPositionOpener(): boolean {
  return opener !== null;
}

/**
 * Open the dialog for the object behind `region`. False when no dialog is
 * installed (or the opener threw, logged).
 */
export function openSizeAndPosition(region: GridRegion, anchor?: SizeAndPositionAnchor): boolean {
  const open = opener;
  if (!open) return false;
  try {
    open(region, anchor);
    return true;
  } catch (err) {
    console.error("[objectPosition] the Size and Position opener threw:", err);
    return false;
  }
}

// ============================================================================
// The menu row every family adds
// ============================================================================

/** One family menu's "Size and Position..." row. */
export interface SizeAndPositionMenuEntry {
  /** SIZE_AND_POSITION_ITEM_ID: the row's stable handle in every menu. */
  id: string;
  /** SIZE_AND_POSITION_LABEL. */
  label: string;
  /**
   * True only when the row can do nothing: no provider owns the object, or no
   * dialog is installed. A family whose menu OMITS rows that do not apply
   * (Controls, the floating grid, Charts) leaves it out then; one that greys
   * rows out shows it greyed with `reason`.
   */
  disabled: boolean;
  /** Why the row is disabled, or why the dialog will open read-only; null otherwise. */
  reason: string | null;
  /** Open the dialog for the object (a no-op when disabled). */
  run(): void;
}

/** The "Size and Position..." row for the object behind `region`. */
export function sizeAndPositionMenuEntry(region: GridRegion): SizeAndPositionMenuEntry {
  const availability = sizeAndPositionAvailability(region);
  const installed = opener !== null;
  const disabled = !availability.provided || !installed;
  const reason = !availability.provided
    ? availability.reason
    : !installed
      ? SIZE_POSITION_NOT_INSTALLED
      : availability.reason;
  return {
    id: SIZE_AND_POSITION_ITEM_ID,
    label: SIZE_AND_POSITION_LABEL,
    disabled,
    reason,
    run: () => {
      if (disabled) return;
      openSizeAndPosition(region);
    },
  };
}

// ============================================================================
// What else the grip's menu lists
// ============================================================================

/** An item another extension adds to the grip's menu, below Size and Position. */
export interface ObjectGripMenuItem {
  /** Unique id; registering the same id again replaces the item. */
  id: string;
  label: string;
  /** Lower first; equal orders keep registration order. Default 0. */
  order?: number;
  /** Whether the item applies to this object at all (default true). A throw hides it (logged). */
  visible?(region: GridRegion): boolean;
  /** Whether it can run now (default true). A throw disables it (logged). */
  enabled?(region: GridRegion): boolean;
  /** Act on THIS object -- never on the whole selection. A returned promise is awaited for its errors only. */
  run(region: GridRegion): unknown;
}

/** A grip-menu item resolved for one object. */
export interface ResolvedObjectGripMenuItem {
  id: string;
  label: string;
  enabled: boolean;
  /** Run it for the object it was resolved for (errors are logged, never thrown). */
  run(): void;
}

interface GripItemEntry {
  item: ObjectGripMenuItem;
  seq: number;
}

const gripItems = new Map<string, GripItemEntry>();
let gripSeq = 0;

/**
 * Add an item to the grip's menu. Returns the cleanup, which removes only
 * what is still this registration.
 */
export function registerObjectGripMenuItem(item: ObjectGripMenuItem): () => void {
  const entry: GripItemEntry = { item, seq: ++gripSeq };
  gripItems.set(item.id, entry);
  return () => {
    if (gripItems.get(item.id) === entry) gripItems.delete(item.id);
  };
}

function guarded(what: string, id: string, fn: () => boolean, fallback: boolean): boolean {
  try {
    return fn();
  } catch (err) {
    console.error(`[objectPosition] grip menu item "${id}" ${what} threw:`, err);
    return fallback;
  }
}

/**
 * The registered grip-menu items that apply to the object behind `region`, in
 * order (`order`, then registration), each bound to that object.
 */
export function objectGripMenuItems(region: GridRegion): ResolvedObjectGripMenuItem[] {
  return Array.from(gripItems.values())
    .sort((a, b) => (a.item.order ?? 0) - (b.item.order ?? 0) || a.seq - b.seq)
    .filter(({ item }) => (item.visible ? guarded("visible()", item.id, () => item.visible!(region) === true, false) : true))
    .map(({ item }) => ({
      id: item.id,
      label: item.label,
      enabled: item.enabled ? guarded("enabled()", item.id, () => item.enabled!(region) === true, false) : true,
      run: () => {
        void Promise.resolve()
          .then(() => item.run(region))
          .catch((err) => console.error(`[objectPosition] grip menu item "${item.id}" failed:`, err));
      },
    }));
}

// ============================================================================
// Whether the grip's menu is open
// ============================================================================

/** Open grip menus (each open registers once; its cleanup unregisters once). */
let gripMenusOpen = 0;

/**
 * The grip's menu says it is open: its keys (arrows, Home, End, Enter, Space,
 * Escape) are the menu's. Returns the cleanup that says it closed (safe to
 * call twice). The menu listens on DOCUMENT capture, so a WINDOW-capture key
 * listener -- a slicer's or a timeline's inner keyboard focus (M8 S7/S8) --
 * runs BEFORE it and must ask {@link isObjectGripMenuOpen} and stand down,
 * or it would take the menu's arrows.
 */
export function noteObjectGripMenuOpen(): () => void {
  gripMenusOpen += 1;
  let closed = false;
  return () => {
    if (closed) return;
    closed = true;
    gripMenusOpen = Math.max(0, gripMenusOpen - 1);
  };
}

/** Whether an object's grip menu is open (its keys are its own). */
export function isObjectGripMenuOpen(): boolean {
  return gripMenusOpen > 0;
}

/** Test hook: forget the opener, every grip-menu item and the open-menu count. */
export function resetObjectPosition(): void {
  opener = null;
  gripItems.clear();
  gripSeq = 0;
  gripMenusOpen = 0;
}
