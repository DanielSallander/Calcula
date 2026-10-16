//! FILENAME: app/extensions/Controls/PageNavigator/navigatorModel.ts
// PURPOSE: The pure model of a Page Navigator: its settings read from the
//          resolved properties, its items derived from the live page list, and
//          WHERE each item is inside the navigator's box (WP-B, D-NAV).
// CONTEXT: Four callers must agree about which item is where -- the paint, the
//          zone (hover + press routing), the run-mode press, and the Properties
//          pane -- or a reader sees one item and clicks another. So they all
//          ask HERE, and nothing here reads a store, a cache or the backend:
//          every function is pure and takes what it needs.
//
//          ITEMS ARE DERIVED, NEVER STORED. `navigatorItems` turns the
//          @api/reportPages snapshot into one item per listed page (the ONE
//          membership rule is `selectReportPages`), applying the per-page
//          overrides by the seam's ONE matching rule
//          (`matchPageNavigatorOverride`: id first, name only for an override
//          whose id names no live page).
//
//          THE CURRENT PAGE IS DECIDED BY ID. `currentPageKey` goes from the
//          grid's active sheet INDEX to the snapshot's page at that index and
//          returns its key (the sheet id). A page renamed while active is still
//          current; a name is never compared.
//
//          PADDING IS APPLIED IN ONE PLACE. `navigatorItemArea` is the
//          navigator's CONTENT RECT -- `visualContentRectFor(...)`, the one
//          rect Core painted the visual container (WP-C D-FORMAT) round and
//          answers its zone band from -- and `layoutNavigatorItems` divides
//          what it is given and applies none. The container's padding IS the
//          navigator's own `padding` key (WP-B owns it, its 0..64 clamp and its
//          Properties row; the Format pane shows no Padding rows for a
//          navigator), so Core's band, the item layout, the hit and the E2E
//          `describe` rects agree for every stored value, and the padding can
//          never be applied twice. A title or a border the Format pane turns on
//          moves the items inside that same rect.

import {
  PAGE_NAVIGATOR_ORIENTATIONS,
  matchPageNavigatorOverride,
  parsePageNavigatorOverrides,
  type PageNavigatorOrientation,
  type PageNavigatorOverride,
} from "@api/buttonControlService";
import { selectReportPages, type ReportPage } from "@api/reportPages";
import { BASE_CONTAINER_DEFAULTS, type ResolvedVisualContainer } from "@api/visualContainer";
import { visualContentRectFor } from "@api/visualContainerPaint";
import { PAGE_NAVIGATOR_DEFAULTS } from "./pageNavigatorRecipe";

/** A rectangle in whatever coordinate space the caller works in. */
export interface NavigatorRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** A navigator's settings, parsed and clamped (never a raw string). */
export interface PageNavigatorProps {
  orientation: PageNavigatorOrientation;
  /** Space between items, 0..64 px. */
  gap: number;
  /** THE container padding: the inset between the box and its items, 0..64 px. */
  padding: number;
  /** Default-state item face. */
  fill: string;
  /** Default-state caption colour. */
  color: string;
  /** Item border, every state. */
  borderColor: string;
  /** Caption size, 6..72. */
  fontSize: number;
  /** The CURRENT page's item face. */
  selectedFill: string;
  /** The CURRENT page's caption colour. */
  selectedColor: string;
  /** List user-hidden pages (painted disabled; a press says why it cannot open). */
  showHiddenPages: boolean;
  /** List Tooltip pages. */
  showTooltipPages: boolean;
  /** Per-page overrides, tolerantly parsed. */
  overrides: PageNavigatorOverride[];
}

/** One button of a navigator: one listed page, with its style resolved. */
export interface NavigatorItem {
  /** `navigatorItemKey(page)`: the sheet id, or `name:<name>` for a page without one. */
  key: string;
  sheetId: string;
  sheetName: string;
  /** TRUE sheet index. */
  index: number;
  /** The override's caption, else the page name. */
  caption: string;
  /** The page is not visible (listed only with showHiddenPages). */
  hiddenPage: boolean;
  /** The page is a Tooltip page (listed only with showTooltipPages). */
  tooltipPage: boolean;
  /** Default-state face: the override's, else the navigator's. */
  fill: string;
  /** Default-state caption colour: the override's, else the navigator's. */
  color: string;
  /** Border colour: the override's, else the navigator's. */
  borderColor: string;
}

/** The zone part a press or hover on the space between items carries. */
export const NAV_GAP_PART = "navGap";

/** The prefix of an item's zone part. */
const NAV_ITEM_PART_PREFIX = "navItem:";

const GAP_MIN = 0;
const GAP_MAX = 64;
const PADDING_MIN = 0;
const PADDING_MAX = 64;
const FONT_MIN = 6;
const FONT_MAX = 72;

/** A finite number from a stored string, clamped; `fallback` (the default) otherwise. */
function clampedNumber(raw: string | undefined, min: number, max: number, fallback: number): number {
  if (typeof raw !== "string" || raw.trim() === "") return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

/** A stored colour (any non-blank string the canvas may parse); `fallback` otherwise. */
function colourOr(raw: string | undefined, fallback: string): string {
  return typeof raw === "string" && raw.trim() !== "" ? raw.trim() : fallback;
}

/**
 * The navigator's settings from its RESOLVED properties (formula values already
 * evaluated). Every absent or malformed value falls back to PAGE_NAVIGATOR_DEFAULTS,
 * so `readPageNavigatorProps({})` is exactly the defaults table, parsed.
 */
export function readPageNavigatorProps(
  resolved: Readonly<Record<string, string>> | null | undefined,
): PageNavigatorProps {
  const r: Readonly<Record<string, string | undefined>> = resolved ?? {};
  const d = PAGE_NAVIGATOR_DEFAULTS;
  const orientationRaw = r.orientation;
  const orientation: PageNavigatorOrientation = (PAGE_NAVIGATOR_ORIENTATIONS as readonly string[]).includes(
    orientationRaw ?? "",
  )
    ? (orientationRaw as PageNavigatorOrientation)
    : d.orientation;
  return {
    orientation,
    gap: clampedNumber(r.gap, GAP_MIN, GAP_MAX, Number(d.gap)),
    padding: clampedNumber(r.padding, PADDING_MIN, PADDING_MAX, Number(d.padding)),
    fill: colourOr(r.fill, d.fill),
    color: colourOr(r.color, d.color),
    borderColor: colourOr(r.borderColor, d.borderColor),
    fontSize: clampedNumber(r.fontSize, FONT_MIN, FONT_MAX, Number(d.fontSize)),
    selectedFill: colourOr(r.selectedFill, d.selectedFill),
    selectedColor: colourOr(r.selectedColor, d.selectedColor),
    showHiddenPages: (r.showHiddenPages ?? d.showHiddenPages) === "true",
    showTooltipPages: (r.showTooltipPages ?? d.showTooltipPages) === "true",
    overrides: parsePageNavigatorOverrides(r.pageOverrides ?? d.pageOverrides),
  };
}

/** An item's key: the sheet id, or `name:<name>` for a page the backend gave no id. */
export function navigatorItemKey(page: { sheetId?: string; name: string }): string {
  return page.sheetId ? page.sheetId : `name:${page.name}`;
}

/** The zone part of the item with this key. */
export function navItemPart(key: string): string {
  return `${NAV_ITEM_PART_PREFIX}${key}`;
}

/** The item key a zone part names, or null (a gap, a button part, nothing). */
export function parseNavItemPart(part: string | null | undefined): string | null {
  if (typeof part !== "string" || !part.startsWith(NAV_ITEM_PART_PREFIX)) return null;
  const key = part.slice(NAV_ITEM_PART_PREFIX.length);
  return key === "" ? null : key;
}

/**
 * The navigator's items, in tab order: the pages `selectReportPages` lists
 * under this navigator's show-hidden / show-tooltip settings, minus every page
 * an override hides, each with its override's caption and colours applied.
 * `pages` is the WHOLE page list (the snapshot's), so an override whose id
 * belongs to an unlisted live page still never applies to another page by name.
 */
export function navigatorItems(pages: readonly ReportPage[], props: PageNavigatorProps): NavigatorItem[] {
  const listed = selectReportPages(pages, {
    showHiddenPages: props.showHiddenPages,
    showTooltipPages: props.showTooltipPages,
  });
  const items: NavigatorItem[] = [];
  for (const page of listed) {
    const override = matchPageNavigatorOverride(props.overrides, page, pages);
    if (override?.hidden === true) continue;
    items.push({
      key: navigatorItemKey(page),
      sheetId: page.sheetId,
      sheetName: page.name,
      index: page.index,
      caption: override?.text ? override.text : page.name,
      hiddenPage: page.visibility !== "visible",
      tooltipPage: page.isTooltipPage,
      fill: override?.fill ?? props.fill,
      color: override?.color ?? props.color,
      borderColor: override?.borderColor ?? props.borderColor,
    });
  }
  return items;
}

/**
 * A navigator's visual-container DEFAULTS (WP-C D-FORMAT): what the box looks
 * like round its items before the Format pane changes anything -- exactly what
 * it has always looked like: no background, no border, no title, no shadow
 * (each item paints its own face and border). Core paints whatever the user
 * turns on (`paint` all "core"); the padding is the navigator's own `padding`
 * key, read into the container by the format provider.
 */
export function pageNavigatorContainerDefaults(): ResolvedVisualContainer {
  const b = BASE_CONTAINER_DEFAULTS;
  return {
    padding: { ...b.padding },
    lockAspect: false,
    title: { ...b.title },
    subtitle: { ...b.subtitle },
    divider: { ...b.divider },
    spacing: { ...b.spacing },
    background: { ...b.background, show: false },
    border: { ...b.border, show: false },
    shadow: { ...b.shadow },
    paint: { background: "core", border: "core", title: "core", shadow: "core" },
  };
}

/**
 * The container a navigator has before its first properties read published
 * one: the defaults with the navigator's own uniform `padding` -- the same
 * container the format provider derives from the same props, so the item area
 * does not move when the real one arrives.
 */
export function pageNavigatorFallbackContainer(padding: number): ResolvedVisualContainer {
  const p = Number.isFinite(padding) ? Math.max(0, padding) : 0;
  return { ...pageNavigatorContainerDefaults(), padding: { top: p, right: p, bottom: p, left: p } };
}

/**
 * Which navigator a layout question is about, and its published container:
 * the region id names Core's painted layout (the measured title lines), the
 * container is `region.container` (the format provider's resolved one).
 */
export interface NavigatorContainerArea {
  regionId: string;
  container?: ResolvedVisualContainer;
}

/**
 * THE ONE place the container is applied: the navigator's CONTENT RECT,
 * `visualContentRectFor(regionId, box, container)` -- the rect Core painted the
 * container round and answers its zone band from (border, padding, a title).
 * Without a published container (the first properties read is on its way, or
 * a pure caller) the container is the defaults with `props.padding`, which is
 * what the provider will publish. Never below 0 x 0.
 */
export function navigatorItemArea(
  box: NavigatorRect,
  props: Pick<PageNavigatorProps, "padding">,
  area?: NavigatorContainerArea,
): NavigatorRect {
  const container = area?.container ?? pageNavigatorFallbackContainer(props.padding);
  return visualContentRectFor(area?.regionId ?? "", box, container);
}

/**
 * The item area divided EQUALLY along the orientation, `gap` apart. When the
 * gaps would leave less than 1 px per item the gap shrinks (the item count
 * never does). Applies NO padding (`navigatorItemArea` did). Pure.
 */
export function layoutNavigatorItems(
  itemArea: NavigatorRect,
  count: number,
  props: Pick<PageNavigatorProps, "orientation" | "gap">,
): NavigatorRect[] {
  const n = Number.isFinite(count) ? Math.max(0, Math.floor(count)) : 0;
  if (n === 0) return [];
  const horizontal = props.orientation !== "vertical";
  const along = Math.max(0, horizontal ? itemArea.width : itemArea.height);
  let gap = Number.isFinite(props.gap) ? Math.max(0, props.gap) : 0;
  if (n > 1 && (along - (n - 1) * gap) / n < 1) {
    gap = Math.max(0, (along - n) / (n - 1));
  }
  const itemLength = n > 0 ? Math.max(0, (along - (n - 1) * gap) / n) : 0;
  const rects: NavigatorRect[] = [];
  for (let i = 0; i < n; i++) {
    const offset = i * (itemLength + gap);
    rects.push(
      horizontal
        ? { x: itemArea.x + offset, y: itemArea.y, width: itemLength, height: Math.max(0, itemArea.height) }
        : { x: itemArea.x, y: itemArea.y + offset, width: Math.max(0, itemArea.width), height: itemLength },
    );
  }
  return rects;
}

/**
 * The item under `point`, given the navigator's REGION box in the same
 * coordinate space (the item area is derived here, from `area`'s container).
 * null on a gap, on the container band (padding, border, title), or outside.
 * An edge shared by two touching items belongs to the first.
 */
export function navigatorItemAt(
  box: NavigatorRect,
  items: readonly NavigatorItem[],
  props: PageNavigatorProps,
  point: { x: number; y: number },
  area?: NavigatorContainerArea,
): NavigatorItem | null {
  const rects = layoutNavigatorItems(navigatorItemArea(box, props, area), items.length, props);
  for (let i = 0; i < rects.length; i++) {
    const r = rects[i];
    if (r.width <= 0 || r.height <= 0) continue;
    if (point.x >= r.x && point.x <= r.x + r.width && point.y >= r.y && point.y <= r.y + r.height) {
      return items[i];
    }
  }
  return null;
}

/**
 * The key of the page active now: the grid's active sheet INDEX -> the page at
 * that index -> its key. null when the active sheet is not a report page (a
 * worksheet) or the index is unknown. Never compares a name.
 */
export function currentPageKey(pages: readonly ReportPage[], activeSheetIndex: number | undefined): string | null {
  if (typeof activeSheetIndex !== "number" || !Number.isFinite(activeSheetIndex)) return null;
  const page = pages.find((p) => p.index === activeSheetIndex);
  return page ? navigatorItemKey(page) : null;
}
