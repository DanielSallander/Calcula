//! FILENAME: app/extensions/CanvasSheet/lib/arrange.ts
// PURPOSE: ALIGN and DISTRIBUTE on a canvas: the pure geometry, and the two
//          commands that commit it through the object-geometry seam.
// CONTEXT: The Canvas tab's Arrange section acts on the canvas-wide selection
//          set (@api/objectSelection), across families. The math is pure and
//          works on plain rectangles; the commands turn the result into
//          `ObjectGeometryChange`s and hand them to `commitObjectGeometry`
//          (@api/objectGeometry), which persists every family's share inside
//          ONE undo transaction.
//
//          The rules:
//            - ALIGN to the SELECTION's bounds (left / center / right edge,
//              top / middle / bottom edge). With ONE object selected there is
//              nothing to align it with, so it aligns to the PAGE (Power BI's
//              and PowerPoint's rule for a single shape).
//            - DISTRIBUTE needs three or more objects: the two outermost stay
//              where they are and the ones between are spaced with EQUAL gaps
//              (a negative gap -- the objects are wider than the span -- is an
//              equal overlap). Order is by centre along the axis.
//            - A LOCKED object (the canvas layout's `locked`) and one whose
//              family says `data.movable === false` never move -- but they
//              still count for the reference bounds and hold their slot in a
//              distribution, so "lock one, align the rest to it" works.
//            - Every result is rounded to whole px and kept on the page
//              (`clampMoveToPage`), exactly as a drag would be.

import type { GridRegion } from "@api/gridOverlays";
import { clampMoveToPage, type LayoutRect } from "@api/layoutSurface";
import { canMoveObject, commitObjectGeometry, type ObjectGeometryChange } from "@api/objectGeometry";
import { getSelectedObjectRegions } from "@api/objectSelection";
import { getCanvasSheetSnapshot } from "./canvasSheetStore";
import { isLockedOnActiveCanvas } from "./canvasLocks";

/** An alignment edge (or centre line). */
export type AlignEdge = "left" | "center" | "right" | "top" | "middle" | "bottom";

/** A distribution axis. */
export type DistributeAxis = "horizontal" | "vertical";

/** The page, in logical px (null = unbounded). */
export type PageSize = { width: number; height: number } | null;

/** One object for the pure math: an id, its rectangle, and whether it may move. */
export interface ArrangeItem {
  id: string;
  rect: LayoutRect;
  /** False for a locked object or one whose family refuses moves: it stays put. */
  movable: boolean;
}

/** The fewest objects Distribute accepts. */
export const DISTRIBUTE_MIN_OBJECTS = 3;

/** The display name of each alignment, for undo labels and the ribbon. */
export const ALIGN_LABELS: Readonly<Record<AlignEdge, string>> = {
  left: "Align Left",
  center: "Align Center",
  right: "Align Right",
  top: "Align Top",
  middle: "Align Middle",
  bottom: "Align Bottom",
};

/** The display name of each distribution. */
export const DISTRIBUTE_LABELS: Readonly<Record<DistributeAxis, string>> = {
  horizontal: "Distribute Horizontally",
  vertical: "Distribute Vertically",
};

// ============================================================================
// Pure geometry
// ============================================================================

/** The union of `rects`, or null for none. */
export function boundsOf(rects: readonly LayoutRect[]): LayoutRect | null {
  if (rects.length === 0) return null;
  let left = Infinity;
  let top = Infinity;
  let right = -Infinity;
  let bottom = -Infinity;
  for (const r of rects) {
    left = Math.min(left, r.x);
    top = Math.min(top, r.y);
    right = Math.max(right, r.x + r.width);
    bottom = Math.max(bottom, r.y + r.height);
  }
  return { x: left, y: top, width: right - left, height: bottom - top };
}

/** `rect` rounded to whole px and kept on the page. */
function settle(rect: LayoutRect, page: PageSize): LayoutRect {
  return clampMoveToPage({ ...rect, x: Math.round(rect.x), y: Math.round(rect.y) }, page);
}

/** Whether two rectangles are at the same place (sizes never change here). */
function samePlace(a: LayoutRect, b: LayoutRect): boolean {
  return a.x === b.x && a.y === b.y;
}

/**
 * Where each MOVABLE item goes when `items` are aligned on `edge`. The
 * reference is the bounds of every item (movable or not); a single item is
 * aligned to the page instead (and with no page, stays put). Only items that
 * actually move are returned.
 */
export function alignItems(
  items: readonly ArrangeItem[],
  edge: AlignEdge,
  page: PageSize,
): Map<string, LayoutRect> {
  const out = new Map<string, LayoutRect>();
  if (items.length === 0) return out;
  const ref =
    items.length === 1
      ? page
        ? { x: 0, y: 0, width: page.width, height: page.height }
        : null
      : boundsOf(items.map((i) => i.rect));
  if (!ref) return out;
  for (const item of items) {
    if (!item.movable) continue;
    const r = item.rect;
    let x = r.x;
    let y = r.y;
    switch (edge) {
      case "left":
        x = ref.x;
        break;
      case "center":
        x = ref.x + (ref.width - r.width) / 2;
        break;
      case "right":
        x = ref.x + ref.width - r.width;
        break;
      case "top":
        y = ref.y;
        break;
      case "middle":
        y = ref.y + (ref.height - r.height) / 2;
        break;
      case "bottom":
        y = ref.y + ref.height - r.height;
        break;
    }
    const next = settle({ ...r, x, y }, page);
    if (!samePlace(next, r)) out.set(item.id, next);
  }
  return out;
}

/**
 * Where each MOVABLE item goes when `items` are distributed along `axis` with
 * equal gaps: ordered by centre, the first and last keep their place and the
 * rest are spaced so every gap between neighbours is the same. Fewer than
 * {@link DISTRIBUTE_MIN_OBJECTS} items: nothing moves. Only items that
 * actually move are returned.
 */
export function distributeItems(
  items: readonly ArrangeItem[],
  axis: DistributeAxis,
  page: PageSize,
): Map<string, LayoutRect> {
  const out = new Map<string, LayoutRect>();
  if (items.length < DISTRIBUTE_MIN_OBJECTS) return out;
  const horizontal = axis === "horizontal";
  const start = (r: LayoutRect) => (horizontal ? r.x : r.y);
  const size = (r: LayoutRect) => (horizontal ? r.width : r.height);
  const ordered = [...items].sort((a, b) => {
    const ca = start(a.rect) + size(a.rect) / 2;
    const cb = start(b.rect) + size(b.rect) / 2;
    return ca - cb || start(a.rect) - start(b.rect) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  });
  const first = ordered[0].rect;
  const last = ordered[ordered.length - 1].rect;
  const span = start(last) + size(last) - start(first);
  const total = ordered.reduce((n, i) => n + size(i.rect), 0);
  const gap = (span - total) / (ordered.length - 1);
  let cursor = start(first);
  for (let i = 0; i < ordered.length; i++) {
    const item = ordered[i];
    const r = item.rect;
    const at = cursor;
    cursor += size(r) + gap;
    // The outermost two define the span: they never move.
    if (i === 0 || i === ordered.length - 1 || !item.movable) continue;
    const next = settle(horizontal ? { ...r, x: at } : { ...r, y: at }, page);
    if (!samePlace(next, r)) out.set(item.id, next);
  }
  return out;
}

// ============================================================================
// Selection -> items -> changes
// ============================================================================

/**
 * Whether the object behind `region` may be moved by an arrange command: a
 * floating object some family can move through the geometry seam, whose
 * family does not refuse moves (`data.movable === false`) and which the
 * active canvas does not lock.
 */
export function isArrangeMovable(region: GridRegion): boolean {
  if (!region.floating || !canMoveObject(region)) return false;
  if (region.data?.movable === false) return false;
  return !isLockedOnActiveCanvas(region);
}

/** The selection as arrange items (floating regions only). */
export function arrangeItemsOf(regions: readonly GridRegion[]): ArrangeItem[] {
  return regions
    .filter((r) => !!r.floating)
    .map((r) => ({ id: r.id, rect: { ...r.floating! }, movable: isArrangeMovable(r) }));
}

/** Turn a plan (region id -> new rect) into geometry changes. */
export function changesFromPlan(
  regions: readonly GridRegion[],
  plan: ReadonlyMap<string, LayoutRect>,
): ObjectGeometryChange[] {
  const changes: ObjectGeometryChange[] = [];
  for (const region of regions) {
    const next = plan.get(region.id);
    if (!next || !region.floating) continue;
    changes.push({ region, ...next, from: { ...region.floating } });
  }
  return changes;
}

/** The active canvas's page, or null (not on a canvas). */
function activePage(): PageSize {
  const active = getCanvasSheetSnapshot().active;
  return active ? { width: active.layout.pageWidth, height: active.layout.pageHeight } : null;
}

/** Whether the active canvas may be arranged (a subscribed one is the publisher's). */
function arrangeAllowed(): boolean {
  const snap = getCanvasSheetSnapshot();
  return snap.active !== null && !snap.activeSubscribed;
}

/** Align the selected objects on `edge`. Resolves the number of objects moved. */
export async function alignSelectedObjects(
  edge: AlignEdge,
  regions: readonly GridRegion[] = getSelectedObjectRegions(),
): Promise<number> {
  if (!arrangeAllowed()) return 0;
  const plan = alignItems(arrangeItemsOf(regions), edge, activePage());
  const changes = changesFromPlan(regions, plan);
  if (changes.length === 0) return 0;
  const outcome = await commitObjectGeometry(changes, ALIGN_LABELS[edge]);
  return outcome.committed;
}

/** Distribute the selected objects along `axis`. Resolves the number moved. */
export async function distributeSelectedObjects(
  axis: DistributeAxis,
  regions: readonly GridRegion[] = getSelectedObjectRegions(),
): Promise<number> {
  if (!arrangeAllowed()) return 0;
  const plan = distributeItems(arrangeItemsOf(regions), axis, activePage());
  const changes = changesFromPlan(regions, plan);
  if (changes.length === 0) return 0;
  const outcome = await commitObjectGeometry(changes, DISTRIBUTE_LABELS[axis]);
  return outcome.committed;
}
