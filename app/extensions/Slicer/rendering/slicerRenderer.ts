//! FILENAME: app/extensions/Slicer/rendering/slicerRenderer.ts
// PURPOSE: Canvas rendering and hit testing for slicer overlay objects.
// CONTEXT: Renders floating slicer panels on the grid canvas with header bar,
//          item buttons, clear-filter control, and vertical scrolling.
//          Supports vertical, horizontal, and grid arrangements.
//
//          PAINT == HIT (BUG-0258). One layout (`slicerFrameOf`) places the
//          header, the items, the scrollbar and its thumb for the painter, the
//          hit test (`getSlicerHitDetail`, which the zone answer and the
//          content gesture read), the scroll clamp and the item drag
//          (lib/slicerItemDrag.ts): a point shows what a press there does.
//          The keyboard's slots read it too (`slicerSlotStep`,
//          `slicerScrollToShow`; lib/slicerKeys.ts), and the focus ring is
//          painted where `itemCellAt` paints the focused item (M8 S7).

import {
  overlaySheetToCanvas,
  type OverlayRenderContext,
  type OverlayHitTestContext,
  type OverlayZone,
  type OverlayZoneFn,
} from "@api/gridOverlays";
import { drawObjectScriptBadgeIfPresent } from "@api/objectScriptBadge";
import { getSlicerById, getCachedItems } from "../lib/slicerStore";
// The style DATA module, not the gallery component: the canvas renderer must
// not pull a React component (and its @api/layout chrome) into the paint path.
import { SLICER_STYLES_BY_ID } from "../lib/slicerStyles";
import type { Slicer, SlicerItem } from "../lib/slicerTypes";
import { isSlicerFiltered, selectionShownDuringRun } from "../lib/slicerClickSelection";
import { getSlicerRunPreview } from "../lib/slicerGestureView";
import { getSlicerKeyFocus, resolveSlicerFocusSlot } from "../lib/slicerKeyFocus";
import { getSlicerItemRenderer, getSlicerStyleOverrides } from "./customRenderers";
import { getSlicerItemBitmap, hasSlicerItemBitmapRenderer } from "@api";

// ============================================================================
// Style Constants
// ============================================================================

const HEADER_HEIGHT = 32;
const ITEM_HEIGHT = 26;
const CLEAR_BUTTON_SIZE = 20;
const BORDER_RADIUS = 3;
const FONT_FAMILY = "Calibri, Segoe UI, sans-serif";
const SCROLLBAR_WIDTH = 8;
const SCROLLBAR_MIN_THUMB = 20;
const SELECT_ALL_LABEL = "Select all";
/**
 * A header-less slicer's frame band (BUG-0258 design D3): a point this close
 * to any edge is FRAME -- with the default item padding of 0 the items reach
 * the edges, and a slicer with no header needs something to be grabbed by
 * (the floating grid's band precedent). The scrollbar wins over it.
 */
export const SLICER_FRAME_BAND = 4;

/** The fill of an item that has no data while the slicer shows that ("indicate items with no data"). */
export const SLICER_NO_DATA_FILL = "#E8E8E8";

/**
 * The keyboard focus ring (M8 S7, plan decision KD4): a 2px DARK outline with
 * a 1px LIGHT line inside it, drawn inside the focused item's button. Two
 * tones, so that whatever the fill under it -- a preset's selected fill (the
 * #4472C4 family), its unselected fill, the no-data grey, a dark preset's
 * near-black -- one of them reaches 3:1 against it (WCAG 2.2 SC 1.4.11).
 * slicerFocusRingContrast.test.ts measures every preset.
 */
export const SLICER_FOCUS_RING_DARK = "#000000";
export const SLICER_FOCUS_RING_LIGHT = "#ffffff";

// Legacy style presets (for backward compatibility with old IDs). A Map, not
// an object literal: the keys are Excel's stored preset names, which the
// repo's camelCase naming rule would reject as property names.
const LEGACY_STYLE_COLORS: ReadonlyMap<string, StyleColors> = new Map([
  [
    "SlicerStyleLight1",
    {
      bg: "#FFFFFF",
      headerBg: "#4472C4",
      headerFg: "#FFFFFF",
      selectedBg: "#4472C4",
      selectedFg: "#FFFFFF",
      itemBg: "#edf2f9",
      itemFg: "#333333",
      border: "#8faadc",
    },
  ],
  [
    "SlicerStyleLight2",
    {
      bg: "#FFFFFF",
      headerBg: "#ED7D31",
      headerFg: "#FFFFFF",
      selectedBg: "#ED7D31",
      selectedFg: "#FFFFFF",
      itemBg: "#fdf2eb",
      itemFg: "#333333",
      border: "#f4b183",
    },
  ],
  [
    "SlicerStyleDark1",
    {
      bg: "#333333",
      headerBg: "#4472C4",
      headerFg: "#FFFFFF",
      selectedBg: "#4472C4",
      selectedFg: "#FFFFFF",
      itemBg: "#444444",
      itemFg: "#EEEEEE",
      border: "#555555",
    },
  ],
]);

export interface StyleColors {
  bg: string;
  headerBg: string;
  headerFg: string;
  selectedBg: string;
  selectedFg: string;
  itemBg: string;
  itemFg: string;
  border: string;
}

const DEFAULT_COLORS: StyleColors = LEGACY_STYLE_COLORS.get("SlicerStyleLight1")!;

function getStyleColors(preset: string): StyleColors {
  const galleryStyle = SLICER_STYLES_BY_ID.get(preset);
  if (galleryStyle) {
    return galleryStyle.thumb;
  }
  return LEGACY_STYLE_COLORS.get(preset) ?? DEFAULT_COLORS;
}

/**
 * Every preset this renderer can paint a slicer with -- the gallery's and the
 * legacy ids' -- by the id `Slicer.stylePreset` stores. What the focus ring's
 * contrast is measured against (slicerFocusRingContrast.test.ts).
 */
export function slicerPresetColorSets(): Array<{ id: string; colors: StyleColors }> {
  const sets: Array<{ id: string; colors: StyleColors }> = [];
  for (const [id, style] of SLICER_STYLES_BY_ID) sets.push({ id, colors: style.thumb });
  for (const [id, colors] of LEGACY_STYLE_COLORS) sets.push({ id, colors });
  return sets;
}

// ============================================================================
// Layout Helpers
// ============================================================================

interface LayoutInfo {
  cols: number;
  totalItems: number; // items.length + selectAll offset
  itemH: number;
  gap: number;
  cellW: number;
  cellH: number;
  contentHeight: number;
  contentWidth: number;
  needsScroll: boolean;
  isHorizontal: boolean;
  selectAllOffset: number; // 1 if showSelectAll, else 0
  padding: number; // internal padding around items
  buttonRadius: number; // corner radius for item buttons
}

function computeLayout(slicer: Slicer, itemCount: number, viewportW: number, viewportH: number): LayoutInfo {
  const gap = slicer.itemGap ?? 4;
  const padding = slicer.itemPadding ?? 0;
  const buttonRadius = slicer.buttonRadius ?? 2;
  const itemH = ITEM_HEIGHT;
  const selectAllOffset = slicer.showSelectAll ? 1 : 0;
  const total = itemCount + selectAllOffset;
  const innerW = viewportW - padding * 2;
  const innerH = viewportH - padding * 2;

  if (slicer.arrangement === "horizontal") {
    const cols = slicer.columns > 1 ? Math.min(slicer.columns, total) : total;
    const cellW = cols > 0 ? (innerW + gap) / cols - gap : innerW;
    const cellH = itemH;
    const rows = Math.ceil(total / cols);
    const contentWidth = total * (cellW + gap) - gap;
    const contentHeight = rows * (cellH + gap) - gap;
    return {
      cols,
      totalItems: total,
      itemH,
      gap,
      cellW,
      cellH,
      contentHeight,
      contentWidth,
      needsScroll: contentWidth > innerW,
      isHorizontal: true,
      selectAllOffset,
      padding,
      buttonRadius,
    };
  }

  if (slicer.arrangement === "grid") {
    const cols = Math.max(1, slicer.columns);
    const cellW = cols > 0 ? (innerW + gap) / cols - gap : innerW;
    const cellH = itemH;
    const rows = Math.ceil(total / cols);
    const contentHeight = rows * (cellH + gap) - gap;
    return {
      cols,
      totalItems: total,
      itemH,
      gap,
      cellW,
      cellH,
      contentHeight,
      contentWidth: innerW,
      needsScroll: contentHeight > innerH,
      isHorizontal: false,
      selectAllOffset,
      padding,
      buttonRadius,
    };
  }

  // Vertical (default) — still respects slicer.columns so the ribbon
  // "Columns" dropdown works regardless of arrangement mode.
  const cols = Math.max(1, slicer.columns);
  const cellW = cols > 1 ? (innerW + gap) / cols - gap : innerW;
  const cellH = itemH;
  const rows = Math.ceil(total / cols);
  const contentHeight = rows * (cellH + gap) - (rows > 0 ? gap : 0);
  return {
    cols,
    totalItems: total,
    itemH,
    gap,
    cellW,
    cellH,
    contentHeight,
    contentWidth: innerW,
    needsScroll: contentHeight > innerH,
    isHorizontal: false,
    selectAllOffset,
    padding,
    buttonRadius,
  };
}

/**
 * A slicer's layout at a size, everything measured from its top-left corner:
 * the header, the item viewport under it, the item grid, the scrollbar and
 * how far the items scroll. THE one layout -- the painter, the hit test, the
 * scroll clamp and the content gesture all read it.
 */
interface SlicerFrame {
  headerH: number;
  /** The item viewport's height (everything under the header). */
  viewportH: number;
  layout: LayoutInfo;
  /** A vertical scrollbar's width at the right edge, or 0. */
  scrollbarW: number;
  /** A horizontal scrollbar's height at the bottom edge, or 0. */
  scrollbarH: number;
  /** The item area: the viewport less its scrollbar. */
  itemAreaW: number;
  itemAreaH: number;
  /** How far the items scroll, along the layout's axis. */
  maxScroll: number;
}

function slicerFrameOf(slicer: Slicer, itemCount: number, w: number, h: number): SlicerFrame {
  const headerH = slicer.showHeader ? HEADER_HEIGHT : 0;
  const viewportH = h - headerH;
  // Two passes: the full width tells whether a vertical scrollbar is needed,
  // then the items are sized in the width left beside it.
  const preLayout = computeLayout(slicer, itemCount, w, viewportH);
  const scrollbarW = preLayout.needsScroll && !preLayout.isHorizontal ? SCROLLBAR_WIDTH : 0;
  const layout = scrollbarW > 0 ? computeLayout(slicer, itemCount, w - scrollbarW, viewportH) : preLayout;
  const scrollbarH = layout.needsScroll && layout.isHorizontal ? SCROLLBAR_WIDTH : 0;
  const maxScroll = layout.isHorizontal
    ? Math.max(0, layout.contentWidth - (w - scrollbarW))
    : Math.max(0, layout.contentHeight - viewportH);
  return {
    headerH,
    viewportH,
    layout,
    scrollbarW,
    scrollbarH,
    itemAreaW: w - scrollbarW,
    itemAreaH: viewportH - scrollbarH,
    maxScroll,
  };
}

/**
 * Where item slot `vi` sits (0 is "Select all" when it is shown), from the
 * slicer's top-left, with the items scrolled by `scroll`. The painted button
 * is `cellW` wide and `cellH - 2` tall, 1px below `y`.
 */
function itemCellAt(f: SlicerFrame, vi: number, scroll: number): { x: number; y: number } {
  const L = f.layout;
  if (L.isHorizontal) {
    return { x: L.padding + vi * (L.cellW + L.gap) - scroll, y: f.headerH + L.padding };
  }
  const col = vi % L.cols;
  const row = Math.floor(vi / L.cols);
  return { x: L.padding + col * (L.cellW + L.gap), y: f.headerH + L.padding + row * (L.cellH + L.gap) - scroll };
}

/** The scroll offset the slicer is painted (and hit-tested) at: the stored one, clamped. */
function shownScroll(slicerId: string, f: SlicerFrame): number {
  return Math.min(getScrollOffset(slicerId), f.maxScroll);
}

// ============================================================================
// The keyboard's slots (M8 S7)
// ============================================================================

/** The keys that move the inner focus between a slicer's items. */
export type SlicerFocusKey = "ArrowUp" | "ArrowDown" | "ArrowLeft" | "ArrowRight" | "Home" | "End" | "PageUp" | "PageDown";

/** How many rows (columns, in a horizontal arrangement) one page of the item area shows; at least 1. */
function slotsPerPage(f: SlicerFrame): number {
  const L = f.layout;
  return L.isHorizontal
    ? Math.max(1, Math.floor((f.itemAreaW - L.padding + L.gap) / (L.cellW + L.gap)))
    : Math.max(1, Math.floor((f.itemAreaH - L.padding + L.gap) / (L.cellH + L.gap)));
}

/**
 * The slot the keyboard focus moves to from `fromSlot` on `key` (slot 0 is
 * "Select all" when it is shown), over THE frame the painter and the hit test
 * read, so a key moves the ring to the neighbour the user SEES:
 *
 *   - vertical and grid: row-major, `cols` per row, as `itemCellAt` paints
 *     them. Up / Down move a row, Left / Right a column within the row, and
 *     none of them wraps: at an edge, or where the row below is shorter, the
 *     focus stays (the key is still consumed by the caller);
 *   - horizontal: ONE row, as painted -- even with `columns > 1`, for which
 *     `computeLayout` counts rows it never paints. Left / Right move, Up /
 *     Down stay;
 *   - Home / End: the first / last slot; PageUp / PageDown: one item-area of
 *     rows (columns, horizontally), clamped like the arrows.
 *
 * PURE over its inputs. Returns `fromSlot` (clamped into the list) when the
 * key goes nowhere.
 */
export function slicerSlotStep(
  slicer: Slicer,
  itemCount: number,
  bounds: { width: number; height: number },
  fromSlot: number,
  key: SlicerFocusKey,
): number {
  const f = slicerFrameOf(slicer, itemCount, bounds.width, bounds.height);
  const L = f.layout;
  const total = L.totalItems;
  if (total <= 0) return 0;
  const from = Math.max(0, Math.min(Math.trunc(fromSlot), total - 1));
  if (key === "Home") return 0;
  if (key === "End") return total - 1;

  if (L.isHorizontal) {
    const page = slotsPerPage(f);
    const step =
      key === "ArrowLeft" ? -1 : key === "ArrowRight" ? 1 : key === "PageUp" ? -page : key === "PageDown" ? page : 0;
    return Math.max(0, Math.min(from + step, total - 1));
  }

  const cols = Math.max(1, L.cols);
  const col = from % cols;
  switch (key) {
    case "ArrowLeft":
      return col > 0 ? from - 1 : from;
    case "ArrowRight":
      return col < cols - 1 && from + 1 < total ? from + 1 : from;
    case "ArrowUp":
      return from - cols >= 0 ? from - cols : from;
    case "ArrowDown":
      return from + cols < total ? from + cols : from;
    case "PageUp": {
      let to = from - slotsPerPage(f) * cols;
      while (to < 0) to += cols;
      return Math.min(to, from);
    }
    case "PageDown": {
      let to = from + slotsPerPage(f) * cols;
      while (to >= total) to -= cols;
      return Math.max(to, from);
    }
    default:
      return from;
  }
}

/**
 * The scroll offset that brings slot `slot`'s painted button fully into view,
 * changing the slicer's CURRENT (clamped) offset as little as possible -- the
 * same offset when it is already in view. Clamped to what the items can
 * scroll. Reads the stored scroll offset; writes nothing.
 */
export function slicerScrollToShow(
  slicer: Slicer,
  itemCount: number,
  bounds: { width: number; height: number },
  slot: number,
): number {
  const f = slicerFrameOf(slicer, itemCount, bounds.width, bounds.height);
  const L = f.layout;
  const scroll = shownScroll(slicer.id, f);
  if (f.maxScroll <= 0 || L.totalItems <= 0) return Math.max(0, Math.min(scroll, f.maxScroll));
  const vi = Math.max(0, Math.min(Math.trunc(slot), L.totalItems - 1));
  // Where the button starts and ends along the scrolling axis, unscrolled.
  const start = L.isHorizontal ? L.padding + vi * (L.cellW + L.gap) : L.padding + Math.floor(vi / L.cols) * (L.cellH + L.gap);
  const size = L.isHorizontal ? L.cellW : L.cellH;
  const visible = L.isHorizontal ? f.itemAreaW : f.itemAreaH;
  let next = scroll;
  if (start - L.padding < next) next = start - L.padding;
  else if (start + size + L.padding > next + visible) next = start + size + L.padding - visible;
  return Math.max(0, Math.min(next, f.maxScroll));
}

/**
 * Slot `slot`'s PAINTED button, from the slicer's top-left at the scroll it is
 * painted at: what the focus ring outlines (`itemCellAt`, as renderSlicer
 * places every item). Null for a slot the slicer does not have.
 */
export function slicerItemButton(
  slicer: Slicer,
  itemCount: number,
  bounds: { width: number; height: number },
  slot: number,
): { x: number; y: number; width: number; height: number } | null {
  const f = slicerFrameOf(slicer, itemCount, bounds.width, bounds.height);
  if (slot < 0 || slot >= f.layout.totalItems) return null;
  const cell = itemCellAt(f, slot, shownScroll(slicer.id, f));
  return { x: cell.x, y: cell.y + 1, width: f.layout.cellW, height: f.layout.cellH - 2 };
}

/** The focus ring inside an item's painted button (x, y, w, h: the button, in canvas px). */
function drawFocusRing(c: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, radius: number): void {
  if (w < 6 || h < 6) return;
  c.save();
  c.strokeStyle = SLICER_FOCUS_RING_DARK;
  c.lineWidth = 2;
  c.beginPath();
  c.roundRect(x + 1, y + 1, w - 2, h - 2, radius);
  c.stroke();
  c.strokeStyle = SLICER_FOCUS_RING_LIGHT;
  c.lineWidth = 1;
  c.beginPath();
  c.roundRect(x + 2.5, y + 2.5, w - 5, h - 5, Math.max(0, radius - 1));
  c.stroke();
  c.restore();
}

// ============================================================================
// Scroll State
// ============================================================================

const scrollOffsets = new Map<string, number>();

export function getScrollOffset(slicerId: string): number {
  return scrollOffsets.get(slicerId) ?? 0;
}

export function setScrollOffset(slicerId: string, offset: number): void {
  const max = getMaxScrollOffset(slicerId);
  scrollOffsets.set(slicerId, Math.max(0, Math.min(offset, max)));
}

export function getMaxScrollOffset(slicerId: string): number {
  const slicer = getSlicerById(slicerId);
  if (!slicer) return 0;
  const items = getCachedItems(slicerId) ?? [];
  return slicerFrameOf(slicer, items.length, slicer.width, slicer.height).maxScroll;
}

export function resetScrollOffsets(): void {
  scrollOffsets.clear();
}

// ============================================================================
// Renderer
// ============================================================================

export function renderSlicer(ctx: OverlayRenderContext): void {
  const slicerId = ctx.region.data?.slicerId as string | undefined;
  if (slicerId == null) return;

  const slicer = getSlicerById(slicerId);
  if (slicer == null) return;

  const items = getCachedItems(slicerId) ?? [];
  const c = ctx.ctx;
  const colors = getStyleColors(slicer.stylePreset);

  const { canvasX, canvasY } = overlaySheetToCanvas(ctx, slicer.x, slicer.y);
  const w = slicer.width;
  const h = slicer.height;

  const frame = slicerFrameOf(slicer, items.length, w, h);
  const { headerH, viewportH, layout, itemAreaW, itemAreaH } = frame;
  // Clamped (handles mode switches where the old offset is too large).
  const scrollVal = shownScroll(slicerId, frame);

  // A drag across the items (lib/slicerItemDrag.ts) is painted as the
  // selection its release would commit -- and a released one until its commit
  // lands. Nothing is written while the button is held.
  const preview = getSlicerRunPreview(slicerId);
  const shownSelection = preview
    ? selectionShownDuringRun(slicer, items, preview.values, preview.additive)
    : undefined;
  const shownSet = shownSelection ? new Set(shownSelection) : null;
  const isShownSelected = (item: SlicerItem): boolean =>
    shownSelection === undefined ? item.selected : shownSelection === null || shownSet!.has(item.value);
  const allShownSelected = shownSelection === undefined ? slicer.selectedItems === null : shownSelection === null;

  // Clip to slicer bounds
  c.save();
  c.beginPath();
  c.roundRect(canvasX, canvasY, w, h, BORDER_RADIUS);
  c.clip();

  // Background
  c.fillStyle = colors.bg;
  c.fillRect(canvasX, canvasY, w, h);

  // Header bar
  if (slicer.showHeader) {
    c.fillStyle = colors.headerBg;
    c.fillRect(canvasX, canvasY, w, HEADER_HEIGHT);

    // Pin badge for level-2+ slicers: the pin survives measure CLEAR/RESET,
    // which changes what those measures compute — it must be visible.
    const pinned = (slicer.filterLevel ?? 1) >= 2;
    let textX = canvasX + 10;
    if (pinned) {
      drawPinGlyph(c, textX, canvasY + HEADER_HEIGHT / 2, colors.headerFg);
      textX += 14;
    }

    c.fillStyle = colors.headerFg;
    c.font = `bold 12px ${FONT_FAMILY}`;
    c.textAlign = "left";
    c.textBaseline = "middle";
    c.fillText(
      slicer.headerText ?? slicer.name,
      textX,
      canvasY + HEADER_HEIGHT / 2,
      w - CLEAR_BUTTON_SIZE - 24 - (pinned ? 14 : 0),
    );

    const btnX = canvasX + w - CLEAR_BUTTON_SIZE - 4;
    const btnY = canvasY + (HEADER_HEIGHT - CLEAR_BUTTON_SIZE) / 2;
    drawClearFilterButton(c, btnX, btnY, CLEAR_BUTTON_SIZE, isSlicerFiltered(slicer), colors.headerFg);
  }

  // Item list — clip to item viewport
  const itemAreaTop = canvasY + headerH;
  const itemAreaLeft = canvasX;
  const btnR = layout.buttonRadius;

  c.save();
  c.beginPath();
  c.rect(itemAreaLeft, itemAreaTop, itemAreaW, viewportH);
  c.clip();

  c.font = `11px ${FONT_FAMILY}`;
  c.textAlign = "left";
  c.textBaseline = "middle";

  const { cellW, cellH, selectAllOffset } = layout;

  // Render each item (including "Select all" at index 0 if enabled)
  for (let vi = 0; vi < layout.totalItems; vi++) {
    const isSelectAll = vi < selectAllOffset;
    const item: SlicerItem | null = isSelectAll
      ? null
      : items[vi - selectAllOffset];

    const cell = itemCellAt(frame, vi, scrollVal);

    // Skip items outside visible area
    if (layout.isHorizontal) {
      if (cell.x + cellW < 0) continue;
      if (cell.x > itemAreaW) break;
    } else {
      if (cell.y + cellH < headerH) continue;
      if (cell.y > headerH + itemAreaH) break;
    }

    const ix = canvasX + cell.x;
    const iy = canvasY + cell.y;

    // Check for custom item renderer
    const customRenderer = getSlicerItemRenderer(slicer.id);
    const styleOvr = getSlicerStyleOverrides(slicer.id);

    // Apply style overrides to colors
    const effColors = styleOvr ? {
      ...colors,
      ...(styleOvr.itemBackgroundColor && { itemBg: styleOvr.itemBackgroundColor }),
      ...(styleOvr.itemTextColor && { itemFg: styleOvr.itemTextColor }),
      ...(styleOvr.selectedBackgroundColor && { selectedBg: styleOvr.selectedBackgroundColor }),
      ...(styleOvr.selectedTextColor && { selectedFg: styleOvr.selectedTextColor }),
    } : colors;

    if (isSelectAll) {
      // "Select all" row
      c.fillStyle = allShownSelected ? effColors.selectedBg : effColors.itemBg;
      c.beginPath();
      c.roundRect(ix, iy + 1, cellW, cellH - 2, btnR);
      c.fill();
      c.fillStyle = allShownSelected ? effColors.selectedFg : effColors.itemFg;
      c.fillText(SELECT_ALL_LABEL, ix + 8, iy + cellH / 2, cellW - 16);
    } else if (item) {
      const selected = isShownSelected(item);
      // Worker-realm scripts provide cached bitmaps instead of functions
      // (sandbox design §6.2): blit inside a clip so a script can never
      // paint outside its item region. Missing bitmap = single-flight
      // request already queued; fall through to default rendering this
      // frame (graceful degradation).
      let bitmapDrawn = false;
      if (hasSlicerItemBitmapRenderer(String(slicer.id))) {
        const bmp = getSlicerItemBitmap(
          String(slicer.id),
          { text: item.value, selected, hasData: item.hasData },
          cellW,
          cellH - 2,
          window.devicePixelRatio || 1,
        );
        if (bmp) {
          c.save();
          c.beginPath();
          c.rect(ix, iy + 1, cellW, cellH - 2);
          c.clip();
          c.drawImage(bmp, ix, iy + 1, cellW, cellH - 2);
          c.restore();
          bitmapDrawn = true;
        }
      }
      if (bitmapDrawn) {
        // bitmap covers the item
      } else if (customRenderer) {
        customRenderer(
          { text: item.value, selected, hasData: item.hasData, index: vi - selectAllOffset },
          c,
          { x: ix, y: iy + 1, width: cellW, height: cellH - 2 },
        );
      } else {
        // Default rendering
        const showAsNoData = !item.hasData && slicer.indicateNoData;

        if (selected && !showAsNoData) {
          c.fillStyle = effColors.selectedBg;
          c.beginPath();
          c.roundRect(ix, iy + 1, cellW, cellH - 2, btnR);
          c.fill();
          c.fillStyle = effColors.selectedFg;
        } else {
          c.fillStyle = showAsNoData ? SLICER_NO_DATA_FILL : effColors.itemBg;
          c.beginPath();
          c.roundRect(ix, iy + 1, cellW, cellH - 2, btnR);
          c.fill();
          c.fillStyle = showAsNoData
            ? "#BBBBBB"
            : selected
              ? effColors.selectedFg
              : effColors.itemFg;
        }

        c.fillText(item.value, ix + 8, iy + cellH / 2, cellW - 16);
      }
    }
  }

  // The keyboard's focus ring (M8 S7), on the slot the next key acts on
  // (`resolveSlicerFocusSlot`, which the key handler asks too), placed by
  // `itemCellAt` like the item itself -- inside the item clip, so a focused
  // item scrolled out of view shows no ring.
  const keyFocus = getSlicerKeyFocus();
  if (keyFocus !== null && keyFocus.slicerId === slicerId) {
    const at = resolveSlicerFocusSlot(
      keyFocus,
      items.map((i) => i.value),
      selectAllOffset > 0,
    );
    if (at !== null) {
      const cell = itemCellAt(frame, at.slot, scrollVal);
      drawFocusRing(c, canvasX + cell.x, canvasY + cell.y + 1, cellW, cellH - 2, btnR);
    }
  }

  c.restore(); // restore item-area clip

  // Scrollbar: the track, and the thumb where the gesture grabs it.
  const track = scrollTrackOf(frame, w);
  if (track) {
    drawScrollbar(c, canvasX, canvasY, track, slicerScrollThumb(track.start, track.length, track.contentExtent, scrollVal));
  }

  // Border
  c.strokeStyle = colors.border;
  c.lineWidth = 1;
  c.beginPath();
  c.roundRect(canvasX, canvasY, w, h, BORDER_RADIUS);
  c.stroke();

  // A selected slicer's outline and resize handles are Core's (core/lib/
  // gridRenderer/rendering/floatingObjectChrome.ts, BUG-0258 design phase 3):
  // the half-clipped border this drew is gone, and the handles its corners had
  // -- live, but never painted -- now are.

  c.restore(); // restore slicer clip

  // T4: script-presence badge (design mode only) — see code on the object.
  drawObjectScriptBadgeIfPresent(c, "slicer", slicerId, canvasX, canvasY, w);
}

// ============================================================================
// Scrollbar
// ============================================================================

/**
 * A slicer's scrollbar track, measured from the slicer's top-left: a vertical
 * bar at the right edge under the header, or a horizontal bar along the
 * bottom of a horizontal arrangement. `start` / `length` run along `axis`.
 */
export interface SlicerScrollTrack {
  axis: "x" | "y";
  x: number;
  y: number;
  width: number;
  height: number;
  start: number;
  length: number;
  /** How long the items are along the axis (what scrolls under the track). */
  contentExtent: number;
}

function scrollTrackOf(f: SlicerFrame, w: number): SlicerScrollTrack | null {
  const L = f.layout;
  if (!L.needsScroll) return null;
  if (L.isHorizontal) {
    return {
      axis: "x",
      x: 0,
      y: f.headerH + f.viewportH - SCROLLBAR_WIDTH,
      width: f.itemAreaW,
      height: SCROLLBAR_WIDTH,
      start: 0,
      length: f.itemAreaW,
      contentExtent: L.contentWidth,
    };
  }
  return {
    axis: "y",
    x: w - SCROLLBAR_WIDTH,
    y: f.headerH,
    width: SCROLLBAR_WIDTH,
    height: f.viewportH,
    start: f.headerH,
    length: f.viewportH,
    contentExtent: L.contentHeight,
  };
}

/** The scrollbar track of a slicer at its canvas bounds' size, or null when nothing scrolls. */
export function slicerScrollTrack(
  slicer: Slicer,
  items: readonly SlicerItem[],
  bounds: { width: number; height: number },
): SlicerScrollTrack | null {
  return scrollTrackOf(slicerFrameOf(slicer, items.length, bounds.width, bounds.height), bounds.width);
}

/**
 * THE thumb: where it starts along the track and how long it is, for a
 * scroll offset. The painter draws it here and the scrollbar drag grabs it
 * here (lib/slicerItemDrag.ts), so paint == hit.
 */
export function slicerScrollThumb(
  trackStart: number,
  trackLength: number,
  contentExtent: number,
  scrollOffset: number,
): { start: number; length: number } {
  const ratio = contentExtent > 0 ? trackLength / contentExtent : 1;
  const length = Math.max(SCROLLBAR_MIN_THUMB, trackLength * ratio);
  const scrollRange = contentExtent - trackLength;
  const thumbRange = trackLength - length;
  const start = scrollRange > 0 ? trackStart + (scrollOffset / scrollRange) * thumbRange : trackStart;
  return { start, length };
}

/** The scroll offset that puts the thumb's start at `thumbStart` (the inverse of `slicerScrollThumb`). */
export function slicerScrollOffsetForThumb(
  trackStart: number,
  trackLength: number,
  contentExtent: number,
  thumbStart: number,
): number {
  const { length } = slicerScrollThumb(trackStart, trackLength, contentExtent, 0);
  const thumbRange = trackLength - length;
  const scrollRange = contentExtent - trackLength;
  if (thumbRange <= 0 || scrollRange <= 0) return 0;
  return Math.max(0, Math.min(1, (thumbStart - trackStart) / thumbRange)) * scrollRange;
}

function drawScrollbar(
  c: CanvasRenderingContext2D,
  originX: number,
  originY: number,
  track: SlicerScrollTrack,
  thumb: { start: number; length: number },
): void {
  c.fillStyle = "rgba(0, 0, 0, 0.05)";
  c.fillRect(originX + track.x, originY + track.y, track.width, track.height);

  c.fillStyle = "rgba(0, 0, 0, 0.25)";
  c.beginPath();
  if (track.axis === "y") {
    c.roundRect(originX + track.x + 1, originY + thumb.start, track.width - 2, thumb.length, (track.width - 2) / 2);
  } else {
    c.roundRect(originX + thumb.start, originY + track.y + 1, thumb.length, track.height - 2, (track.height - 2) / 2);
  }
  c.fill();
}

// ============================================================================
// Pin Glyph (level-2+ slicers)
// ============================================================================

/** A small pin glyph drawn left of the header text for pinned (level-2+)
 * slicers: a filled circle head on a short angled needle. */
function drawPinGlyph(
  c: CanvasRenderingContext2D,
  x: number,
  centerY: number,
  color: string,
): void {
  c.save();
  c.strokeStyle = color;
  c.fillStyle = color;
  c.lineWidth = 1.5;
  // Head: filled circle, upper-left.
  c.beginPath();
  c.arc(x + 4, centerY - 2.5, 3, 0, Math.PI * 2);
  c.fill();
  // Needle: angled line toward lower-right.
  c.beginPath();
  c.moveTo(x + 5.5, centerY - 0.5);
  c.lineTo(x + 9, centerY + 4);
  c.stroke();
  c.restore();
}

// ============================================================================
// Clear Filter Button
// ============================================================================

function drawClearFilterButton(
  c: CanvasRenderingContext2D,
  x: number,
  y: number,
  size: number,
  isActive: boolean,
  headerFg: string,
): void {
  const cx = x + size / 2;
  const cy = y + size / 2;
  const sc = size * 0.4;

  if (isActive) {
    c.strokeStyle = headerFg;
    c.fillStyle = headerFg;
    c.globalAlpha = 1.0;
  } else {
    c.strokeStyle = headerFg;
    c.fillStyle = headerFg;
    c.globalAlpha = 0.3;
  }

  c.lineWidth = 1.5;
  c.beginPath();
  c.moveTo(cx - sc, cy - sc * 0.8);
  c.lineTo(cx + sc, cy - sc * 0.8);
  c.lineTo(cx + sc * 0.2, cy + sc * 0.1);
  c.lineTo(cx + sc * 0.2, cy + sc * 0.8);
  c.lineTo(cx - sc * 0.2, cy + sc * 0.8);
  c.lineTo(cx - sc * 0.2, cy + sc * 0.1);
  c.closePath();
  c.fill();

  if (isActive) {
    c.globalAlpha = 1.0;
    c.strokeStyle = "#FF4444";
    c.lineWidth = 2;
    const xOff = sc * 0.6;
    c.beginPath();
    c.moveTo(cx - xOff, cy - xOff);
    c.lineTo(cx + xOff, cy + xOff);
    c.moveTo(cx + xOff, cy - xOff);
    c.lineTo(cx - xOff, cy + xOff);
    c.stroke();
  }

  c.globalAlpha = 1.0;
}

// ============================================================================
// Hit Testing
// ============================================================================

/**
 * What a point of a slicer is. `border` is the 4px frame band of a slicer
 * whose header is hidden (design D3); `body` is everything that is no part
 * (the header's text, the padding, the gaps between items, empty space).
 */
export interface SlicerHitResult {
  type: "header" | "clearButton" | "item" | "selectAll" | "body" | "scrollbar" | "border";
  itemIndex?: number;
  itemValue?: string;
}

export function hitTestSlicer(ctx: OverlayHitTestContext): boolean {
  if (!ctx.floatingCanvasBounds) return false;

  const { x, y, width, height } = ctx.floatingCanvasBounds;
  return (
    ctx.canvasX >= x &&
    ctx.canvasX <= x + width &&
    ctx.canvasY >= y &&
    ctx.canvasY <= y + height
  );
}

/**
 * The part of the slicer under a logical canvas point (the slicer at
 * `bounds`). An item is its PAINTED button -- the gap around it is body, so
 * what shows as a button is what a press there works (paint == hit). Earlier
 * rows win: the header, the scrollbar, a header-less slicer's frame band,
 * then the items.
 *
 * Reads the slicer, its cached items and its scroll offset; writes nothing.
 */
export function getSlicerHitDetail(
  canvasX: number,
  canvasY: number,
  bounds: { x: number; y: number; width: number; height: number },
  slicerId: string,
): SlicerHitResult | null {
  const slicer = getSlicerById(slicerId);
  if (!slicer) return null;

  const items = getCachedItems(slicerId) ?? [];
  const relX = canvasX - bounds.x;
  const relY = canvasY - bounds.y;

  // Header area
  if (slicer.showHeader && relY < HEADER_HEIGHT) {
    if (relX > bounds.width - CLEAR_BUTTON_SIZE - 4) {
      return { type: "clearButton" };
    }
    return { type: "header" };
  }

  const frame = slicerFrameOf(slicer, items.length, bounds.width, bounds.height);

  // Scrollbar: the painted track.
  const track = scrollTrackOf(frame, bounds.width);
  if (
    track &&
    relX >= track.x &&
    relX <= track.x + track.width &&
    relY >= track.y &&
    relY <= track.y + track.height
  ) {
    return { type: "scrollbar" };
  }

  // A header-less slicer's frame band (D3): with the default padding of 0
  // its items reach the edges, so this is what is left to grab it by (and
  // the gaps between the items).
  if (
    !slicer.showHeader &&
    (relX < SLICER_FRAME_BAND ||
      relY < SLICER_FRAME_BAND ||
      relX > bounds.width - SLICER_FRAME_BAND ||
      relY > bounds.height - SLICER_FRAME_BAND)
  ) {
    return { type: "border" };
  }

  const vi = paintedSlotAt(frame, relX, relY, shownScroll(slicerId, frame));
  if (vi !== null) {
    if (vi < frame.layout.selectAllOffset) return { type: "selectAll" };
    const itemIndex = vi - frame.layout.selectAllOffset;
    if (itemIndex < items.length) {
      return { type: "item", itemIndex, itemValue: items[itemIndex].value };
    }
  }

  return { type: "body" };
}

/**
 * The item slot whose PAINTED button covers a point (from the slicer's
 * top-left), or null -- a gap, the padding, empty space, or outside the item
 * area. The painted button is `cellW` wide and `cellH - 2` tall, 1px below
 * its cell's top (renderSlicer).
 */
function paintedSlotAt(f: SlicerFrame, relX: number, relY: number, scroll: number): number | null {
  const L = f.layout;
  if (relX < 0 || relX >= f.itemAreaW || relY < f.headerH || relY >= f.headerH + f.itemAreaH) return null;
  const pitchX = L.cellW + L.gap;
  const pitchY = L.cellH + L.gap;
  let vi: number;
  let inX: number;
  let inY: number;
  if (L.isHorizontal) {
    const px = relX - L.padding + scroll;
    vi = Math.floor(px / pitchX);
    inX = px - vi * pitchX;
    inY = relY - f.headerH - L.padding;
  } else {
    const px = relX - L.padding;
    const col = Math.floor(px / pitchX);
    if (col < 0 || col >= L.cols) return null;
    const py = relY - f.headerH - L.padding + scroll;
    const row = Math.floor(py / pitchY);
    if (row < 0) return null;
    vi = row * L.cols + col;
    inX = px - col * pitchX;
    inY = py - row * pitchY;
  }
  if (vi < 0 || vi >= L.totalItems) return null;
  if (inX < 0 || inX >= L.cellW) return null;
  if (inY < 1 || inY >= L.cellH - 1) return null;
  return vi;
}

/**
 * The item (an index into the slicer's items; never "Select all") nearest a
 * point measured from the slicer's top-left -- for a drag across the items
 * (lib/slicerItemDrag.ts). The point is clamped into the item area first, so
 * the answer is always a VISIBLE item: a pointer in a gap takes the item
 * before it, a pointer above, below or beside the items the edge item the
 * area shows (the auto-scroll brings more into view). Grid layouts answer in
 * ROW-MAJOR order, so a run is the items between two in reading order. Null
 * when the slicer has no items.
 */
export function slicerItemIndexNear(
  slicer: Slicer,
  items: readonly SlicerItem[],
  bounds: { width: number; height: number },
  relX: number,
  relY: number,
): number | null {
  if (items.length === 0) return null;
  const f = slicerFrameOf(slicer, items.length, bounds.width, bounds.height);
  const L = f.layout;
  const scroll = shownScroll(slicer.id, f);
  const x = Math.max(0, Math.min(relX, f.itemAreaW - 1));
  const y = Math.max(f.headerH, Math.min(relY, f.headerH + f.itemAreaH - 1));
  let vi: number;
  if (L.isHorizontal) {
    vi = Math.floor((x - L.padding + scroll) / (L.cellW + L.gap));
  } else {
    const col = Math.max(0, Math.min(L.cols - 1, Math.floor((x - L.padding) / (L.cellW + L.gap))));
    const row = Math.max(0, Math.floor((y - f.headerH - L.padding + scroll) / (L.cellH + L.gap)));
    vi = row * L.cols + col;
  }
  vi = Math.max(L.selectAllOffset, Math.min(vi, L.totalItems - 1));
  return vi - L.selectAllOffset;
}

/** How close to the item area's edge (px) an item drag starts scrolling it. */
export const SLICER_AUTOSCROLL_EDGE = 8;
const AUTOSCROLL_MIN_STEP = 6;
const AUTOSCROLL_MAX_STEP = 40;

/**
 * The scroll step (px per tick) for an item drag's pointer at a point from
 * the slicer's top-left: negative near or past the start of the item area
 * (its top; its left in a horizontal arrangement), positive near or past its
 * end, faster the further out, and 0 in between or when nothing scrolls.
 */
export function slicerAutoScrollStep(
  slicer: Slicer,
  items: readonly SlicerItem[],
  bounds: { width: number; height: number },
  relX: number,
  relY: number,
): number {
  const f = slicerFrameOf(slicer, items.length, bounds.width, bounds.height);
  if (f.maxScroll <= 0) return 0;
  const horizontal = f.layout.isHorizontal;
  const pos = horizontal ? relX : relY;
  const lo = horizontal ? 0 : f.headerH;
  const hi = horizontal ? f.itemAreaW : f.headerH + f.itemAreaH;
  const edge = SLICER_AUTOSCROLL_EDGE;
  if (pos < lo + edge) {
    return -Math.min(AUTOSCROLL_MAX_STEP, AUTOSCROLL_MIN_STEP + Math.round((lo + edge - pos) / 2));
  }
  if (pos > hi - edge) {
    return Math.min(AUTOSCROLL_MAX_STEP, AUTOSCROLL_MIN_STEP + Math.round((pos - (hi - edge)) / 2));
  }
  return 0;
}

// ============================================================================
// The zone answer (BUG-0258)
// ============================================================================

/**
 * What a part of the slicer is FOR (design phase 4): the items, "Select all",
 * a LIT clear button and the scrollbar are CONTENT -- a press there is the
 * slicer's own gesture (lib/slicerItemDrag.ts: a click filters, Ctrl+click
 * toggles, a drag selects the run, the scrollbar drags) and never moves it;
 * a header-less slicer's frame band is FRAME by name; the rest (the header,
 * a DIMMED clear button, padding, the gaps, empty space) is plain frame
 * (null: Core's 'move', or 'default' where the slicer cannot move). The clear
 * button is content only while the slicer is filtered (D9): unfiltered it is
 * painted dimmed and does nothing, so its corner moves the slicer like the
 * rest of the header -- the timeline's precedent.
 */
export function slicerZoneOfHit(slicer: Pick<Slicer, "selectedItems">, hit: SlicerHitResult): OverlayZone | null {
  switch (hit.type) {
    case "item":
      return { kind: "content", cursor: "pointer", part: "item" };
    case "selectAll":
      return { kind: "content", cursor: "pointer", part: "selectAll" };
    case "clearButton":
      return isSlicerFiltered(slicer) ? { kind: "content", cursor: "pointer", part: "clearButton" } : null;
    case "scrollbar":
      return { kind: "content", cursor: "default", part: "scrollbar" };
    case "border":
      return { kind: "frame", part: "border" };
    default:
      return null;
  }
}

/**
 * The slicer's ONE zone answer (BUG-0258), from which Core derives the press,
 * the pointer and the meaning of Ctrl/Shift: `slicerZoneOfHit` of the part
 * under the point. A CONTENT press reaches the slicer as
 * `floatingObject:bodyDragStart` (index.ts hands it to lib/slicerItemDrag.ts),
 * after Core selected the slicer as a PLAIN press -- so a Ctrl+click on an
 * item toggles the ITEM and keeps the slicer selected -- and whatever the
 * lock or the subscription: filtering is reading the report, not editing it.
 *
 * PURE: it reads the slicer, its cached items and its scroll offset. While
 * the item drag holds the button, the pointer is the gesture's through Core's
 * seam (`holdContentGestureCursor`), never a second answer from here.
 */
export const slicerZoneAt: OverlayZoneFn = (ctx) => {
  if (!ctx.floatingCanvasBounds) return null;

  const slicerId = ctx.region.data?.slicerId as string | undefined;
  if (slicerId == null) return null;
  const slicer = getSlicerById(slicerId);
  if (!slicer) return null;

  const hit = getSlicerHitDetail(
    ctx.canvasX,
    ctx.canvasY,
    ctx.floatingCanvasBounds,
    slicerId,
  );
  if (!hit) return null;
  return slicerZoneOfHit(slicer, hit);
};
