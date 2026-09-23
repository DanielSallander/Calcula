//! FILENAME: app/extensions/Table/lib/tableStyles.ts
// PURPOSE: The table style catalogue (Excel's Light / Medium / Dark gallery) as
//          DATA, the mapping between a gallery id and the style NAME a table
//          stores, and the one write that applies a style to a table.
// CONTEXT: Moved out of components/TableStylesGallery.tsx in the Calcula
//          Clusters redesign. That component is now chrome only (the @api
//          StyleGallery around SVG thumbnails) and sits under the chrome
//          hex-ban in app/eslint.boundaries.js; the palette below is
//          categorical colour DATA — the colours ARE the styles — so it lives
//          here, outside the ban, and every element that paints it sits inside
//          a `data-colour-data` container.
//
//          TWO SPELLINGS OF ONE STYLE, and why both exist. The gallery keys a
//          style as `table-medium-2`; the backend stores Excel's name,
//          `TableStyleMedium2` (`Table.styleName`, which scripts set and read
//          by that name through `table.setStyle`, and which the .cala file
//          persists). `tableStyleNameForId` / `tableStyleIdForName` are the
//          ONLY translation between them, so the gallery's highlight is always
//          derived from what the table actually stores. Before this, the
//          gallery kept its selection in local React state and wrote nothing:
//          a click highlighted a thumbnail, the table was unchanged, and the
//          highlight reset on the next remount.
//
//          ONE STYLE, TWO RENDERINGS. Each style carries its thumbnail colours
//          (`thumb`, what the gallery draws) and the paint it puts on the GRID
//          (`cells`, what lib/tableStyleInterceptor.ts applies per cell).
//          `cells` is DERIVED from `thumb` by `cellPaintFor`, never typed out
//          beside it, so the table a user gets always wears the thumbnail they
//          clicked. The interceptor used to hardcode Medium 2's two colours for
//          every table, so choosing a style in the gallery changed nothing on
//          the sheet.

import { updateTableStyle, type Table } from "@api/backend";
import { refreshCache } from "./tableStore";

// ============================================================================
// Types
// ============================================================================

/** The colours one thumbnail is drawn from (see TableStyleThumbnail). */
export interface TableStyleThumbColors {
  headerBg: string;
  headerFg: string;
  bandBg: string;
  baseBg: string;
  /** Horizontal rule between rows; "" or "transparent" draws none. */
  borderH: string;
  /** Vertical rule between columns; "" draws none. */
  borderV: string;
  outerBorder: string;
  /** Colour of the "text" dashes in body rows. */
  dashColor: string;
  /** Rule under the header row, when the style draws one. */
  headerBorderBottom?: string;
}

export type TableStyleCategory = "light" | "medium" | "dark";

/**
 * What a style paints on the GRID, one fill + text colour per table element.
 * "" paints nothing: the cell keeps its own fill / its own text colour. The
 * header, the total row and the first/last column are also always bold (that
 * is the interceptor's business, not the style's).
 */
export interface TableStyleCellPaint {
  headerBg: string;
  headerFg: string;
  /** Data cells that are not a stripe (Excel's "whole table" body). */
  bodyBg: string;
  bodyFg: string;
  /** The first stripe of banded rows AND of banded columns: Excel's
   *  built-in styles stripe both with the same fill. */
  stripeBg: string;
  stripeFg: string;
  totalBg: string;
  totalFg: string;
  /** First / last column emphasis. */
  edgeBg: string;
  edgeFg: string;
}

export interface TableStyleDef {
  /** Gallery id, e.g. `table-medium-2`. */
  id: string;
  category: TableStyleCategory;
  /** Row of seven within the category (0-based). */
  group: number;
  /** Office theme accent the row is drawn in (0 = neutral). */
  accentIndex: number;
  thumb: TableStyleThumbColors;
  /** The grid paint, derived from `thumb` (see cellPaintFor). */
  cells: TableStyleCellPaint;
}

// ============================================================================
// Accent Color Palette (matches Excel Office theme)
// ============================================================================

interface AccentColor {
  base: string;
  light: string;
  lighter: string;
  medium: string;
  dark: string;
}

const STYLE_ACCENTS: AccentColor[] = [
  // 0: No accent (gray/neutral)
  { base: "#999999", light: "#f2f2f2", lighter: "#f8f8f8", medium: "#d9d9d9", dark: "#595959" },
  // 1: Blue (Accent 1). `light` is #d9e2f3 exactly: it is the stripe the grid
  // has always painted under the default Medium 2 (#4472c4 header), and the
  // visual E2E goldens (tables, comments-notes, zz-workbook-residue) photograph
  // those two colours.
  { base: "#4472c4", light: "#d9e2f3", lighter: "#edf2f9", medium: "#8faadc", dark: "#2f5496" },
  // 2: Orange (Accent 2)
  { base: "#ed7d31", light: "#fbe5d6", lighter: "#fdf2eb", medium: "#f4b183", dark: "#c55a11" },
  // 3: Gray (Accent 3)
  { base: "#a5a5a5", light: "#ededed", lighter: "#f6f6f6", medium: "#c9c9c9", dark: "#7f7f7f" },
  // 4: Gold (Accent 4)
  { base: "#ffc000", light: "#fff2cc", lighter: "#fff9e5", medium: "#ffd966", dark: "#bf9000" },
  // 5: Light Blue (Accent 5)
  { base: "#5b9bd5", light: "#deeaf6", lighter: "#eff5fb", medium: "#9bc2e6", dark: "#2e75b6" },
  // 6: Green (Accent 6)
  { base: "#70ad47", light: "#e2efda", lighter: "#f0f7ec", medium: "#a9d18e", dark: "#548235" },
];

// ============================================================================
// Style Generation
// ============================================================================

/** The sheet's own background: a thumbnail fill of pure white is "no fill". */
const SHEET_WHITE = "#ffffff";

/**
 * The grid paint a style's thumbnail promises, derived rather than typed out
 * so the two can never disagree:
 *
 *  - header, stripe and body fills are the thumbnail's header, band and base
 *    rows, with white meaning "paint nothing" (a white fill would only hide
 *    the gridlines the sheet shows under an unstyled cell);
 *  - the header's text is the thumbnail's header text colour;
 *  - body and stripe text turn white exactly when the thumbnail draws its
 *    "text" dashes white (the darkest styles); otherwise the cell keeps its
 *    own text colour;
 *  - Light and Medium styles total the table in the stripe fill (Medium 2's
 *    total row has always been its stripe) and mark the first/last column by
 *    weight alone; Dark styles give both the header's paint, because a stripe
 *    or a bold weight is invisible against a dark body.
 */
function cellPaintFor(
  category: TableStyleCategory,
  thumb: TableStyleThumbColors,
): TableStyleCellPaint {
  const fill = (colour: string): string =>
    colour.toLowerCase() === SHEET_WHITE ? "" : colour;
  const headerBg = fill(thumb.headerBg);
  const headerFg = thumb.headerFg;
  const bodyText = thumb.dashColor.toLowerCase() === SHEET_WHITE ? SHEET_WHITE : "";
  const bodyBg = fill(thumb.baseBg);
  const stripeBg = fill(thumb.bandBg);
  const dark = category === "dark";
  return {
    headerBg,
    headerFg,
    bodyBg,
    bodyFg: bodyBg ? bodyText : "",
    stripeBg,
    stripeFg: stripeBg ? bodyText : "",
    totalBg: dark ? headerBg : stripeBg,
    totalFg: dark ? headerFg : "",
    edgeBg: dark ? headerBg : "",
    edgeFg: dark ? headerFg : "",
  };
}

function addStyle(
  styles: TableStyleDef[],
  category: TableStyleCategory,
  group: number,
  accentIndex: number,
  thumb: TableStyleThumbColors,
): void {
  const num = group * 7 + accentIndex + 1;
  styles.push({
    id: `table-${category}-${num}`,
    category,
    group,
    accentIndex,
    thumb,
    cells: cellPaintFor(category, thumb),
  });
}

function generateTableStyles(): TableStyleDef[] {
  const styles: TableStyleDef[] = [];

  STYLE_ACCENTS.forEach((accent, i) => {
    // --- LIGHT Group 0 (Light 1-7): Very minimal, thin borders ---
    addStyle(styles, "light", 0, i, {
      headerBg: "#ffffff", headerFg: accent.dark, bandBg: "#ffffff", baseBg: "#ffffff",
      borderH: accent.medium, borderV: "", outerBorder: accent.medium, dashColor: accent.medium,
      headerBorderBottom: accent.base,
    });
    // --- LIGHT Group 1 (Light 8-14): Header accent border, subtle banding ---
    addStyle(styles, "light", 1, i, {
      headerBg: "#ffffff", headerFg: accent.dark, bandBg: accent.lighter, baseBg: "#ffffff",
      borderH: "#e8e8e8", borderV: "", outerBorder: "#cccccc", dashColor: "#999999",
      headerBorderBottom: accent.base,
    });
    // --- LIGHT Group 2 (Light 15-21): Colored header, banded rows ---
    addStyle(styles, "light", 2, i, {
      headerBg: accent.base, headerFg: "#ffffff", bandBg: accent.light, baseBg: "#ffffff",
      borderH: "transparent", borderV: "", outerBorder: accent.medium, dashColor: "#777777",
    });
    // --- LIGHT Group 3 (Light 22-28): Colored header, banded rows, grid lines ---
    addStyle(styles, "light", 3, i, {
      headerBg: accent.base, headerFg: "#ffffff", bandBg: accent.light, baseBg: "#ffffff",
      borderH: accent.medium, borderV: accent.medium, outerBorder: accent.base, dashColor: "#666666",
    });

    // --- MEDIUM Group 0 (Medium 1-7): Colored header, banded rows, accent
    // horizontal lines. Excel's familiar default row: Medium 2 is the blue
    // header over light-blue stripes every new table wears. ---
    addStyle(styles, "medium", 0, i, {
      headerBg: accent.base, headerFg: "#ffffff", bandBg: accent.light, baseBg: "#ffffff",
      borderH: accent.medium, borderV: "", outerBorder: accent.base, dashColor: "#777777",
    });
    // --- MEDIUM Group 1 (Medium 8-14): Colored header, subtle banding ---
    addStyle(styles, "medium", 1, i, {
      headerBg: accent.base, headerFg: "#ffffff", bandBg: accent.lighter, baseBg: "#ffffff",
      borderH: "transparent", borderV: "", outerBorder: accent.base, dashColor: "#777777",
    });
    // --- MEDIUM Group 2 (Medium 15-21): Dark header, strong banding, borders ---
    addStyle(styles, "medium", 2, i, {
      headerBg: accent.dark, headerFg: "#ffffff", bandBg: accent.light, baseBg: "#ffffff",
      borderH: accent.medium, borderV: accent.medium, outerBorder: accent.dark, dashColor: "#555555",
    });
    // --- MEDIUM Group 3 (Medium 22-28): Dark header, full grid, strong bands ---
    addStyle(styles, "medium", 3, i, {
      headerBg: accent.dark, headerFg: "#ffffff", bandBg: accent.light, baseBg: accent.lighter,
      borderH: accent.base, borderV: accent.base, outerBorder: accent.dark, dashColor: "#555555",
    });

    // --- DARK Group 0 (Dark 1-7): Dark header, medium body ---
    addStyle(styles, "dark", 0, i, {
      headerBg: accent.dark, headerFg: "#ffffff", bandBg: accent.light, baseBg: accent.lighter,
      borderH: "transparent", borderV: "", outerBorder: accent.dark, dashColor: accent.dark,
    });
    // --- DARK Group 1 (Dark 8-14): Very dark, accent fills ---
    addStyle(styles, "dark", 1, i, {
      headerBg: accent.dark, headerFg: "#ffffff", bandBg: accent.base, baseBg: accent.medium,
      borderH: "transparent", borderV: "", outerBorder: accent.dark, dashColor: "#ffffff",
    });
    // --- DARK Group 2 (Dark 15-21): Black header, dark accent body ---
    addStyle(styles, "dark", 2, i, {
      headerBg: "#333333", headerFg: "#ffffff", bandBg: accent.dark, baseBg: accent.base,
      borderH: "transparent", borderV: "", outerBorder: "#333333", dashColor: "#ffffff",
    });
  });

  // Sort by category order (light, medium, dark), then by id number
  const catOrder: Record<TableStyleCategory, number> = { light: 0, medium: 1, dark: 2 };
  styles.sort((a, b) => {
    const catDiff = catOrder[a.category] - catOrder[b.category];
    if (catDiff !== 0) return catDiff;
    return tableStyleNumber(a.id) - tableStyleNumber(b.id);
  });

  return styles;
}

/** The trailing number of a gallery id (`table-medium-2` -> 2). */
export function tableStyleNumber(id: string): number {
  const n = parseInt(id.split("-").pop() ?? "", 10);
  return Number.isFinite(n) ? n : 0;
}

/** Every built-in style, Light 1..28, Medium 1..28, Dark 1..21, in gallery order. */
export const TABLE_STYLES: TableStyleDef[] = generateTableStyles();
export const TABLE_STYLES_BY_ID = new Map(TABLE_STYLES.map((s) => [s.id, s]));

/** Default style (Excel's TableStyleMedium2 equivalent) — what a new table gets. */
export const DEFAULT_TABLE_STYLE_ID = "table-medium-2";

// ============================================================================
// "None" — Excel's first Light tile, and what the old gallery's Clear did
// ============================================================================

/** Gallery id of the "None" style: the table keeps its data and structure but
 *  wears no style. Stored as an EMPTY style name, Excel's own spelling of
 *  "no style" (`ListObject.TableStyle = ""`). */
export const TABLE_STYLE_NONE_ID = "table-none";

/** A plain grid: what a table with no style looks like. */
export const TABLE_STYLE_NONE_THUMB: TableStyleThumbColors = {
  headerBg: "#ffffff",
  headerFg: "#595959",
  bandBg: "#ffffff",
  baseBg: "#ffffff",
  borderH: "#d9d9d9",
  borderV: "#d9d9d9",
  outerBorder: "#bfbfbf",
  dashColor: "#8c8c8c",
};

// ============================================================================
// Names
// ============================================================================

/** Category headings, in gallery order. */
export const TABLE_STYLE_CATEGORY_LABELS: Record<TableStyleCategory, string> = {
  light: "Light",
  medium: "Medium",
  dark: "Dark",
};

/** What a user calls a style: "Medium 2". */
export function tableStyleDisplayName(def: TableStyleDef): string {
  return `${TABLE_STYLE_CATEGORY_LABELS[def.category]} ${tableStyleNumber(def.id)}`;
}

const STYLE_NAME_PATTERN = /^TableStyle(Light|Medium|Dark)(\d+)$/i;

/**
 * The style NAME the backend stores for a gallery id: `table-medium-2` ->
 * `TableStyleMedium2`, the "None" id -> "" (no style). An id the catalogue
 * does not know is passed through unchanged rather than guessed at.
 */
export function tableStyleNameForId(id: string): string {
  if (id === TABLE_STYLE_NONE_ID) return "";
  const def = TABLE_STYLES_BY_ID.get(id);
  if (!def) return id;
  return `TableStyle${TABLE_STYLE_CATEGORY_LABELS[def.category]}${tableStyleNumber(def.id)}`;
}

/**
 * The gallery id for a stored style NAME: `TableStyleMedium2` ->
 * `table-medium-2`, "" -> the "None" id, anything the gallery cannot draw
 * (an imported custom style, `TableStyleMedium29`) -> null, so no thumbnail
 * claims to be the applied style when none is.
 */
export function tableStyleIdForName(name: string | null | undefined): string | null {
  if (name === null || name === undefined) return null;
  const trimmed = name.trim();
  if (trimmed === "") return TABLE_STYLE_NONE_ID;
  const match = STYLE_NAME_PATTERN.exec(trimmed);
  if (!match) return null;
  const id = `table-${match[1].toLowerCase()}-${parseInt(match[2], 10)}`;
  return TABLE_STYLES_BY_ID.has(id) ? id : null;
}

// ============================================================================
// The write
// ============================================================================

/**
 * Apply a gallery style to a table: the backend stores the style NAME (the
 * seven style-option flags are left exactly as they are), then the local
 * table cache is refreshed so every synchronous reader sees the new name.
 * Returns the updated table, or null when the backend refused (a protected
 * sheet, a table that no longer exists).
 */
export async function applyTableStyleAsync(
  tableId: string,
  styleId: string,
): Promise<Table | null> {
  const result = await updateTableStyle({
    tableId,
    styleName: tableStyleNameForId(styleId),
  });
  if (result.success && result.table) {
    await refreshCache();
    return result.table;
  }
  return null;
}
