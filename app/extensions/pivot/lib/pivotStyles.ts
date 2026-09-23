//! FILENAME: app/extensions/Pivot/lib/pivotStyles.ts
// PURPOSE: The PivotTable style DATA module: the Excel style catalogue under
//          the names the rest of the extension imports, the style -> PivotTheme
//          mapping the grid renderer paints with, the gallery thumbnail
//          geometry, and the transient live-preview seam.
// CONTEXT: This used to live inside components/PivotTableStylesGallery.tsx,
//          which mixed three concerns: colour DATA, a canvas renderer and the
//          ribbon widget. The widget is now the @api/layout StyleGallery, and
//          the Clusters redesign bans colour literals from chrome components
//          (app/eslint.boundaries.js lists the gallery file). Every literal a
//          style needs therefore lives HERE, in a data module, and the gallery
//          paints thumbnails from `pivotThumbnailRects` inside an element that
//          carries `data-colour-data`.
//
//          LIVE PREVIEW. Hovering (or keyboard-focusing) a thumbnail must show
//          the pivot in that style WITHOUT changing the document: no
//          PIVOT_LAYOUT_CHANGED (that one schedules a backend pivot update),
//          no undo entry, no dirty flag. The preview is a module-level
//          (pivotId, styleId) pair that the renderer consults before the
//          pivot's own style and that always ends: StyleGallery calls
//          onHover(null) on every way out (leave, blur, choose, close,
//          unmount), which lands in setPivotStylePreview(null, null). That is
//          the transient-write pattern in its simplest form — nothing to
//          snapshot, because nothing persisted is touched.
//
//          Every name components/PivotTableStylesGallery.tsx used to export is
//          exported from here under the same name, and re-exported from there,
//          so existing importers (Pivot/index.ts) keep working unchanged.

import type { PivotTheme } from "../rendering/pivot";
import { requestOverlayRedraw } from "@api/gridOverlays";
import {
  EXCEL_PIVOT_STYLES,
  EXCEL_PIVOT_STYLES_BY_NAME,
  DEFAULT_EXCEL_PIVOT_STYLE,
  type ExcelPivotStyle,
} from "../styles/excelPivotStyles";

// ============================================================================
// The catalogue, under every name callers use
// ============================================================================

export { EXCEL_PIVOT_STYLES, EXCEL_PIVOT_STYLES_BY_NAME, DEFAULT_EXCEL_PIVOT_STYLE };
export type { ExcelPivotStyle };

/** The Excel pivot style list (alias kept for existing importers). */
export { EXCEL_PIVOT_STYLES as PIVOT_STYLES };
/** Style name -> definition (alias kept for existing importers). */
export const PIVOT_STYLES_BY_ID = EXCEL_PIVOT_STYLES_BY_NAME;
/** The style a pivot wears when none was chosen ("PivotStyleLight16"). */
export const DEFAULT_PIVOT_STYLE_ID = DEFAULT_EXCEL_PIVOT_STYLE;

/** Gallery group order: Excel's Light / Medium / Dark sections. */
export const PIVOT_STYLE_CATEGORIES = ["Light", "Medium", "Dark"] as const;
export type PivotStyleCategory = (typeof PIVOT_STYLE_CATEGORIES)[number];

/** Every style, grouped in gallery order (Light, then Medium, then Dark). */
export function orderedPivotStyles(): ExcelPivotStyle[] {
  return PIVOT_STYLE_CATEGORIES.flatMap((category) =>
    EXCEL_PIVOT_STYLES.filter((s) => s.category === category),
  );
}

/**
 * The name a person reads for a style id: "PivotStyleMedium2" ->
 * "Pivot Style Medium 2" (Excel's own wording). Unknown shapes pass through.
 */
export function pivotStyleDisplayName(styleId: string): string {
  const m = /^PivotStyle(Light|Medium|Dark)(\d+)$/.exec(styleId);
  return m ? `Pivot Style ${m[1]} ${m[2]}` : styleId;
}

// ============================================================================
// Colour helpers
// ============================================================================

const WHITE = "#ffffff";
const BLACK = "#000000";

function isWhite(hex: string | undefined): boolean {
  return !!hex && hex.toLowerCase() === WHITE;
}

/** Lighten a hex color by blending with white. ratio=0 is original, ratio=1 is white. */
function lighten(hex: string, ratio: number): string {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  const lr = Math.round(r + (255 - r) * ratio);
  const lg = Math.round(g + (255 - g) * ratio);
  const lb = Math.round(b + (255 - b) * ratio);
  return `#${lr.toString(16).padStart(2, "0")}${lg.toString(16).padStart(2, "0")}${lb.toString(16).padStart(2, "0")}`;
}

/** Relative luminance of a hex color (0=black, 1=white). */
function luminance(hex: string): number {
  const r = parseInt(hex.slice(1, 3), 16) / 255;
  const g = parseInt(hex.slice(3, 5), 16) / 255;
  const b = parseInt(hex.slice(5, 7), 16) / 255;
  const srgb = (c: number) => (c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));
  return 0.2126 * srgb(r) + 0.7152 * srgb(g) + 0.0722 * srgb(b);
}

/** True if the color is "dark" (needs light text on top). */
function isDarkColor(hex: string): boolean {
  return luminance(hex) < 0.35;
}

// ============================================================================
// Style -> PivotTheme mapping (what the grid renderer paints with)
// ============================================================================

/**
 * Convert an ExcelPivotStyle into PivotTheme overrides.
 * Returns a Partial<PivotTheme> that should be merged with DEFAULT_PIVOT_THEME.
 */
function excelStyleToThemeOverrides(style: ExcelPivotStyle): Partial<PivotTheme> {
  // ---------------------------------------------------------------------------
  // Extract raw values from the Excel style definition
  // ---------------------------------------------------------------------------
  const headerBg = style.headerRow?.bg || "";
  const headerFg = style.headerRow?.fg || style.wholeTable?.fg || BLACK;
  const hasColoredHeader = !!headerBg && !isWhite(headerBg);
  const bodyBg = style.wholeTable?.bg || WHITE;
  const bodyFg = style.wholeTable?.fg || BLACK;
  const isDarkBody = !!bodyBg && !isWhite(bodyBg) && isDarkColor(bodyBg);

  const bandBg = style.rowStripe1?.bg || "";

  // Text color auto-detection for colored backgrounds
  const headerTextColor = hasColoredHeader
    ? (isDarkColor(headerBg) ? WHITE : BLACK)
    : headerFg;
  const labelText = isDarkBody ? (bodyFg || "#e0e0e0") : (bodyFg || "#1f2937");
  const valueText = isDarkBody ? (bodyFg || "#d0d0d0") : (bodyFg || "#374151");

  // ---------------------------------------------------------------------------
  // Totals — use explicit totalRow, fall back to header color (Excel behavior)
  // ---------------------------------------------------------------------------
  const totalBg = style.totalRow?.bg || "";
  const totalFg = style.totalRow?.fg || "";
  const grandTotalBg = totalBg || (hasColoredHeader ? headerBg : (isDarkBody ? lighten(bodyBg, -0.1) : ""));
  const grandTotalFg = totalFg || (hasColoredHeader && !totalBg ? headerTextColor : bodyFg);

  // Subtotals — use explicit subtotalRow1, fall back to lighter total color
  const subtotalBg = style.subtotalRow1?.bg || "";
  const subtotalFg = style.subtotalRow1?.fg || bodyFg;
  const subtotalResultBg = subtotalBg || (totalBg ? lighten(totalBg, 0.3) : "");

  // ---------------------------------------------------------------------------
  // Filter row — use explicit pageFieldLabels/pageFieldValues from Excel style
  // These are Excel's names for filter label and filter dropdown cells
  // ---------------------------------------------------------------------------
  const pageLabels = style.pageFieldLabels;
  const filterLabelBg = pageLabels?.bg || (hasColoredHeader ? headerBg : "");
  const filterLabelFg = pageLabels?.fg || (filterLabelBg && isDarkColor(filterLabelBg) ? WHITE : headerFg);

  // Border color: derive from the accent or banding
  const borderColor = isDarkBody
    ? lighten(bodyBg, 0.15)
    : (bandBg && !isWhite(bandBg) ? lighten(bandBg, 0.3) : "#e8e8e8");

  // Filter button appearance (the combo box inside filter dropdown cells)
  const filterBtnBaseBg = filterLabelBg || (hasColoredHeader ? headerBg : "");
  const filterButtonBorder = filterBtnBaseBg
    ? lighten(filterBtnBaseBg, 0.3)
    : "#C5CDE0";
  const filterButtonHoverBg = filterBtnBaseBg
    ? lighten(filterBtnBaseBg, 0.2)
    : "#E8EEF7";
  const filterDropdownArrow = filterBtnBaseBg && isDarkColor(filterBtnBaseBg)
    ? WHITE
    : "#4b5563";

  // ---------------------------------------------------------------------------
  // Build the overrides
  // ---------------------------------------------------------------------------
  const overrides: Partial<PivotTheme> = {};

  // Header — always set so defaults don't bleed through when switching styles
  overrides.headerBackground = hasColoredHeader ? headerBg : bodyBg;
  overrides.headerBorderColor = hasColoredHeader ? headerBg : borderColor;
  overrides.headerText = headerTextColor;
  overrides.headerFontWeight = style.headerRow?.b ? "700" : "400";

  // Body
  overrides.valueBackground = bodyBg;
  overrides.labelBackground = bodyBg;
  overrides.labelText = labelText;
  overrides.valueText = valueText;

  // Banding
  overrides.alternateRowBackground = bandBg || bodyBg;

  // Grand total — always set; fall back to body bg for styles with no accent
  overrides.grandTotalBackground = grandTotalBg || bodyBg;
  overrides.grandTotalText = grandTotalFg;

  // Subtotals
  overrides.totalBackground = subtotalResultBg || bodyBg;
  overrides.totalText = subtotalFg;

  // Borders
  overrides.borderColor = borderColor;

  // Filter row — uses Excel's pageFieldLabels/pageFieldValues definitions
  overrides.filterRowBackground = filterLabelBg || bodyBg;
  overrides.filterText = filterLabelFg;

  // Filter button
  overrides.filterButtonBackground = filterBtnBaseBg || WHITE;
  overrides.filterButtonBorder = filterButtonBorder;
  overrides.filterButtonHoverBackground = filterButtonHoverBg;
  overrides.filterDropdownArrow = filterDropdownArrow;

  // Icons
  overrides.iconColor = isDarkBody ? "#cccccc" : "#6b7280";
  overrides.iconHoverColor = isDarkBody ? WHITE : "#1f2937";

  return overrides;
}

/**
 * Get PivotTheme overrides for a given style ID (e.g. "PivotStyleLight16").
 * Returns empty object if style not found (will use default theme).
 */
export function getThemeOverridesForStyle(styleId: string): Partial<PivotTheme> {
  if (!styleId) return {};
  const style = EXCEL_PIVOT_STYLES_BY_NAME.get(styleId);
  if (!style) return {};
  return excelStyleToThemeOverrides(style);
}

// ============================================================================
// Gallery thumbnails — a miniature pivot: header row, banded body, outline
// ============================================================================

/** Rows (header + body) and columns a thumbnail draws. */
export const PIVOT_THUMB_ROWS = 5;
export const PIVOT_THUMB_COLS = 4;

/** The colours one thumbnail paints with, derived from a style. */
export interface PivotThumbColors {
  headerBg: string;
  headerFg: string;
  bandBg: string;
  baseBg: string;
  borderColor: string;
  accentColor: string;
  /** The content dash colour in body rows. */
  bodyDash: string;
}

/** Derive thumbnail colours from an ExcelPivotStyle. */
export function getPivotThumbColors(style: ExcelPivotStyle): PivotThumbColors {
  const headerBg = style.headerRow?.bg || WHITE;
  const headerFg = style.headerRow?.fg || style.wholeTable?.fg || BLACK;
  const baseBg = style.wholeTable?.bg || WHITE;
  const bandBg = style.rowStripe1?.bg || style.rowStripe2?.bg || baseBg;

  // Accent: use the most prominent non-white color
  const accentColor = (!isWhite(headerBg) && headerBg)
    || style.subtotalRow1?.bg
    || style.totalRow?.bg
    || style.pageFieldLabels?.bg
    || bandBg
    || "#d0d0d0";

  const borderColor = !isWhite(baseBg)
    ? lighten(baseBg, 0.15)
    : (bandBg !== baseBg ? lighten(bandBg, 0.3) : "#e0e0e0");

  return {
    headerBg,
    headerFg: !isWhite(headerBg)
      ? (isDarkColor(headerBg) ? WHITE : "#333333")
      : headerFg,
    bandBg,
    baseBg,
    borderColor,
    accentColor,
    bodyDash: !isWhite(baseBg) ? lighten(baseBg, 0.6) : "#999999",
  };
}

/** One filled rectangle of a thumbnail. */
export interface PivotThumbRect {
  x: number;
  y: number;
  w: number;
  h: number;
  fill: string;
}

/** Everything a renderer needs to draw one thumbnail at w x h. */
export interface PivotThumbnail {
  /** Back-to-front fills: ground, row fills, row borders, content dashes. */
  rects: PivotThumbRect[];
  /** The 1px outline colour (stroked on the half-pixel inset). */
  outline: string;
}

/**
 * The thumbnail geometry: five rows (a header then a banded body) separated by
 * 1px borders, four columns of content dashes, and an accent outline. Pure, so
 * a canvas, an SVG or a test can consume the same drawing.
 */
export function pivotThumbnailRects(thumb: PivotThumbColors, w: number, h: number): PivotThumbnail {
  const borderW = 1;
  const rowH = Math.floor((h - borderW * (PIVOT_THUMB_ROWS - 1)) / PIVOT_THUMB_ROWS);
  const colW = Math.floor(w / PIVOT_THUMB_COLS);
  const dashMarginX = 3;
  const dashH = 1.5;
  const headerDashH = 2;

  // The ground: rows are floored to whole pixels, so without it a sliver at the
  // bottom would show whatever the thumbnail sits on.
  const rects: PivotThumbRect[] = [{ x: 0, y: 0, w, h, fill: thumb.baseBg }];

  let y = 0;
  for (let r = 0; r < PIVOT_THUMB_ROWS; r++) {
    const isHeader = r === 0;
    const isBanded = r > 0 && r % 2 === 0;
    const bg = isHeader ? thumb.headerBg : isBanded ? thumb.bandBg : thumb.baseBg;
    rects.push({ x: 0, y, w, h: rowH, fill: bg });

    const fg = isHeader ? thumb.headerFg : thumb.bodyDash;
    const dh = isHeader ? headerDashH : dashH;
    for (let c = 0; c < PIVOT_THUMB_COLS; c++) {
      rects.push({
        x: c * colW + dashMarginX,
        y: y + (rowH - dh) / 2,
        w: colW - dashMarginX * 2,
        h: dh,
        fill: fg,
      });
    }

    y += rowH;
    if (r < PIVOT_THUMB_ROWS - 1) {
      rects.push({ x: 0, y, w, h: borderW, fill: thumb.borderColor });
      y += borderW;
    }
  }

  return { rects, outline: thumb.accentColor };
}

// ============================================================================
// Live preview — transient, never persisted
// ============================================================================

interface PreviewState {
  pivotId: string;
  styleId: string;
}

let preview: PreviewState | null = null;
const previewListeners = new Set<() => void>();

/**
 * Show `styleId` on `pivotId` for as long as the gallery pointer or focus rests
 * on it; pass nulls to end the preview. Touches no document state: the grid
 * renderer asks {@link getPivotStylePreview} before the pivot's own style and
 * repaints on the overlay redraw requested here.
 */
export function setPivotStylePreview(pivotId: string | null, styleId: string | null): void {
  const next: PreviewState | null =
    pivotId !== null && pivotId !== "" && styleId !== null && styleId !== ""
      ? { pivotId, styleId }
      : null;
  if (
    (next === null && preview === null) ||
    (next !== null && preview !== null && next.pivotId === preview.pivotId && next.styleId === preview.styleId)
  ) {
    return;
  }
  preview = next;
  for (const listener of Array.from(previewListeners)) {
    listener();
  }
  requestOverlayRedraw();
}

/** The style being previewed on `pivotId`, or null when none is. */
export function getPivotStylePreview(pivotId: string): string | null {
  return preview !== null && preview.pivotId === pivotId ? preview.styleId : null;
}

/** Be told whenever a preview starts, moves or ends. Returns the unsubscribe. */
export function subscribePivotStylePreview(listener: () => void): () => void {
  previewListeners.add(listener);
  return () => {
    previewListeners.delete(listener);
  };
}
