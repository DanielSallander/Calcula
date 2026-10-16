//! FILENAME: app/extensions/pivot/styles/excelPivotStyles.ts
// PURPOSE: Excel-compatible pivot table style definitions -- the typed view of
//          the ONE preset data file, ./excelPivotStyles.json.
// CONTEXT: Ruling R3 (WP-C S10b, 2026-10-15). The catalogue used to be a
//          TypeScript literal here, which the backend could not read, so the
//          hidden grid under a pivot (and so every copy of its cells) wore
//          fixed colours whatever style the box showed. The data now lives in
//          the JSON file, which the backend `include_str!`s
//          (app/src-tauri/src/pivot/grid_theme.rs). Never copy a preset into a
//          second list on either side: Pivot/__tests__/pivotStyleSourceDrift
//          and the grid_theme.rs tests pin both readers to this file.

import pivotStyleData from "./excelPivotStyles.json";

// ============================================================================
// Types
// ============================================================================

/** Style properties for a single pivot table element (e.g. HeaderRow, TotalRow). */
export interface ElementStyle {
  /** Bold */
  b?: boolean;
  /** Italic */
  i?: boolean;
  /** Font/text color (hex) */
  fg?: string;
  /** Fill/background color (hex) */
  bg?: string;
}

/** Full Excel pivot table style definition with per-element formatting. */
export interface ExcelPivotStyle {
  name: string;
  category: 'Light' | 'Medium' | 'Dark';
  wholeTable?: ElementStyle;
  headerRow?: ElementStyle;
  totalRow?: ElementStyle;
  firstColumn?: ElementStyle;
  lastColumn?: ElementStyle;
  rowStripe1?: ElementStyle;
  rowStripe2?: ElementStyle;
  colStripe1?: ElementStyle;
  colStripe2?: ElementStyle;
  firstHeaderCell?: ElementStyle;
  lastHeaderCell?: ElementStyle;
  subtotalRow1?: ElementStyle;
  subtotalRow2?: ElementStyle;
  subtotalRow3?: ElementStyle;
  subtotalCol1?: ElementStyle;
  subtotalCol2?: ElementStyle;
  subtotalCol3?: ElementStyle;
  colSubheading1?: ElementStyle;
  colSubheading2?: ElementStyle;
  colSubheading3?: ElementStyle;
  rowSubheading1?: ElementStyle;
  rowSubheading2?: ElementStyle;
  rowSubheading3?: ElementStyle;
  blankRow?: ElementStyle;
  pageFieldLabels?: ElementStyle;
  pageFieldValues?: ElementStyle;
}

/**
 * The PivotTheme keys a style decides (colours, plus the header font weight
 * "700" / "400"). Spelled by the data file's `fallbackTheme`, so a key the
 * file loses or gains changes this type and the compiler finds every reader.
 */
export type PivotStyleThemeKey = keyof typeof pivotStyleData.fallbackTheme;

/** A style's resolved theme: every {@link PivotStyleThemeKey} -> its value. */
export type PivotStyleTheme = Readonly<Record<PivotStyleThemeKey, string>>;

/** One preset as the data file holds it: Excel's elements plus the theme the box paints with. */
type PresetRecord = ExcelPivotStyle & { theme: PivotStyleTheme };

const PRESETS = pivotStyleData.styles as PresetRecord[];

// ============================================================================
// Style Definitions
// ============================================================================

/** Every Excel pivot style, in the data file's order. */
export const EXCEL_PIVOT_STYLES: ExcelPivotStyle[] = PRESETS;

/** Map from style name to style definition for O(1) lookups. */
export const EXCEL_PIVOT_STYLES_BY_NAME = new Map(
  EXCEL_PIVOT_STYLES.map((s) => [s.name, s]),
);

/** Style name -> the PivotTheme values that style paints with (the data file's `theme`). */
export const EXCEL_PIVOT_STYLE_THEMES: ReadonlyMap<string, PivotStyleTheme> = new Map(
  PRESETS.map((s) => [s.name, s.theme]),
);

/** What a style id the catalogue does not know paints with (DEFAULT_PIVOT_THEME's style keys). */
export const FALLBACK_PIVOT_STYLE_THEME: PivotStyleTheme = pivotStyleData.fallbackTheme;

/** The default pivot style (matches Excel default). */
export const DEFAULT_EXCEL_PIVOT_STYLE: string = pivotStyleData.defaultStyle;
