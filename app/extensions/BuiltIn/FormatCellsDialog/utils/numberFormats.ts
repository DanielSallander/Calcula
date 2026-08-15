//! FILENAME: app/extensions/BuiltIn/FormatCellsDialog/utils/numberFormats.ts
// PURPOSE: Number format category definitions for the Number tab.

export interface NumberFormatCategory {
  id: string;
  label: string;
  description: string;
  formats: NumberFormatPreset[];
}

export interface NumberFormatPreset {
  label: string;
  value: string;
  example?: string;
}

/** Format a number example using locale separators. */
function fmt(n: string, dec = ".", thou = ","): string {
  return n.replace(/\./g, "\x00").replace(/,/g, thou).replace(/\x00/g, dec);
}

/**
 * Get number format categories with locale-aware examples.
 * @param dec Decimal separator (default ".")
 * @param thou Thousands separator (default ",")
 */
export function getNumberFormatCategories(dec = ".", thou = ","): NumberFormatCategory[] {
  return [
  {
    id: "general",
    label: "General",
    description:
      "General format cells have no specific number format. Values are displayed as entered.",
    formats: [{ label: "General", value: "general", example: fmt("1234.5", dec, thou) }],
  },
  {
    id: "number",
    label: "Number",
    description:
      "Number formats are used for general display of numbers. Currency and Accounting offer specialized formatting for monetary values.",
    formats: [
      { label: fmt("1234.00", dec, thou), value: "number", example: fmt("1234.00", dec, thou) },
      { label: fmt("1,234.00", dec, thou), value: "number_sep", example: fmt("1,234.00", dec, thou) },
    ],
  },
  {
    id: "currency",
    label: "Currency",
    description:
      "Currency formats are used for general monetary values. Use Accounting formats to align decimal points in a column.",
    formats: [
      { label: "$ (USD)", value: "currency_usd", example: "$" + fmt("1,234.00", dec, thou) },
      { label: "EUR", value: "currency_eur", example: "EUR " + fmt("1,234.00", dec, thou) },
      { label: "kr (SEK)", value: "currency_sek", example: fmt("1,234.00", dec, thou) + " kr" },
    ],
  },
  {
    id: "percentage",
    label: "Percentage",
    description:
      "Percentage formats multiply the cell value by 100 and display the result with a percent symbol.",
    formats: [
      { label: fmt("12.00", dec, thou) + "%", value: "percentage", example: fmt("12.00", dec, thou) + "%" },
    ],
  },
  {
    id: "scientific",
    label: "Scientific",
    description:
      "Scientific formats display numbers in exponential notation, replacing part of the number with E+n.",
    formats: [
      { label: "1.23E+03", value: "scientific", example: "1.23E+03" },
    ],
  },
  {
    id: "date",
    label: "Date",
    description:
      "Date formats display date and time serial numbers as date values.",
    formats: [
      { label: "2024-01-15 (ISO)", value: "date_iso", example: "2024-01-15" },
      { label: "01/15/2024 (US)", value: "date_us", example: "01/15/2024" },
      { label: "15/01/2024 (EU)", value: "date_eu", example: "15/01/2024" },
    ],
  },
  {
    id: "time",
    label: "Time",
    description: "Time formats display date and time serial numbers as time values.",
    formats: [
      { label: "13:30:00 (24h)", value: "time_24h", example: "13:30:00" },
      { label: "1:30:00 PM (12h)", value: "time_12h", example: "1:30:00 PM" },
    ],
  },
  {
    id: "accounting",
    label: "Accounting",
    description:
      "Accounting formats line up the currency symbols and decimal points in a column. " +
      "Use Currency formats for general monetary values.",
    formats: [
      { label: "$ (USD)", value: "accounting_usd", example: "$ " + fmt("1,234.00", dec, thou) },
      { label: "$ (no decimals)", value: "accounting_usd_0", example: "$ " + fmt("1,234", dec, thou) },
      { label: "EUR", value: "accounting_eur", example: "EUR " + fmt("1,234.00", dec, thou) },
      { label: "kr (SEK)", value: "accounting_sek", example: fmt("1,234.00", dec, thou) + " kr" },
    ],
  },
  {
    id: "fraction",
    label: "Fraction",
    description:
      "Fraction formats display numbers as fractions. Choose the type of fraction you want to display.",
    formats: [
      { label: "Up to one digit (1/4)", value: "fraction_1", example: "1234 1/2" },
      { label: "Up to two digits (21/25)", value: "fraction_2", example: "1234 10/20" },
      { label: "Up to three digits (312/943)", value: "fraction_3", example: "1234 500/1000" },
      { label: "Halves (1/2)", value: "fraction_halves", example: "1234 1/2" },
      { label: "Quarters (2/4)", value: "fraction_quarters", example: "1234 2/4" },
      { label: "Eighths (4/8)", value: "fraction_eighths", example: "1234 4/8" },
      { label: "Sixteenths (8/16)", value: "fraction_sixteenths", example: "1234 8/16" },
      { label: "Tenths (5/10)", value: "fraction_tenths", example: "1234 5/10" },
      { label: "Hundredths (50/100)", value: "fraction_hundredths", example: "1234 50/100" },
    ],
  },
  {
    // Excel HAS a Text category on this tab, and it sits right before Special.
    // Without it the ribbon's Text entry -- which applies the one-section
    // format `@` -- reopened here as "Custom" with a raw format code in a text
    // box, so the dialog described the user's own choice as something they had
    // hand-written.
    id: "text",
    label: "Text",
    description:
      "Text format cells are treated as text even when a number is in the cell. " +
      "The cell is displayed exactly as entered.",
    formats: [{ label: "Text", value: "text", example: fmt("1234.5", dec, thou) }],
  },
  {
    id: "special",
    label: "Special",
    description:
      "Special formats are useful for tracking list and database values. " +
      "These formats apply specific patterns for common data types.",
    formats: [
      { label: "Zip Code", value: "00000", example: "01234" },
      { label: "Zip Code + 4", value: "00000-0000", example: "01234-5678" },
      { label: "Phone Number", value: '[<=9999999]###-####;(###) ###-####', example: "(123) 456-7890" },
      { label: "Social Security Number", value: "000-00-0000", example: "123-45-6789" },
    ],
  },
  {
    id: "custom",
    label: "Custom",
    description:
      "Custom formats let you create your own number format using format codes. " +
      "Use 0 for required digits, # for optional digits, and ; to separate positive, negative, zero, and text sections.",
    formats: [
      { label: "#,##0", value: "#,##0", example: fmt("1,235", dec, thou) },
      { label: "#,##0.00", value: "#,##0.00", example: fmt("1,234.50", dec, thou) },
      { label: "#,##0;(#,##0)", value: "#,##0;(#,##0)", example: fmt("1,235", dec, thou) },
      { label: "#,##0;[Red](#,##0)", value: "#,##0;[Red](#,##0)", example: fmt("1,235", dec, thou) },
      { label: "$#,##0.00", value: "$#,##0.00", example: "$" + fmt("1,234.50", dec, thou) },
      { label: "0%", value: "0%", example: "50%" },
      { label: "0.00%", value: "0.00%", example: fmt("50.00", dec, thou) + "%" },
      { label: "0.00E+00", value: "0.00E+00", example: "1.23E+03" },
      { label: "#,##0.0,", value: "#,##0.0,", example: fmt("1,234.5", dec, thou) },
      { label: "0.00;[Red]-0.00", value: "0.00;[Red]-0.00", example: fmt("1234.50", dec, thou) },
      { label: '0.00" kr"', value: '0.00" kr"', example: fmt("1234.50", dec, thou) + " kr" },
      { label: ";;;", value: ";;;", example: "(hidden)" },
    ],
  },
];
}

/** Default categories using US-English separators (backward compatibility). */
export const NUMBER_FORMAT_CATEGORIES: NumberFormatCategory[] = getNumberFormatCategories();

// ============================================================================
// Backend display-name mapping (BUG-0065)
// ============================================================================
// get_style returns DISPLAY NAMES ("Number (2 decimals, with separators)",
// "Date (yyyy-mm-dd)"), not preset values -- so a dialog opened on a formatted
// cell could never recognize the cell's own format: the category list stayed
// on General and no preset highlighted. The Rust side of the same asymmetry
// (parse_number_format not reading its serializer's names) corrupted the
// format outright on an untouched OK.

/** Backend display name -> preset value, for the shapes that HAVE a preset. */
const DISPLAY_NAME_TO_PRESET: Record<string, string> = {
  "General": "general",
  "Number (2 decimals)": "number",
  "Number (2 decimals, with separators)": "number_sep",
  "Currency ($, 2 decimals)": "currency_usd",
  "Currency (EUR, 2 decimals)": "currency_eur",
  "Currency (kr, 2 decimals)": "currency_sek",
  "Accounting ($, 2 decimals)": "accounting_usd",
  "Accounting ($, 0 decimals)": "accounting_usd_0",
  "Accounting (EUR, 2 decimals)": "accounting_eur",
  "Accounting (kr, 2 decimals)": "accounting_sek",
  "Percentage (2 decimals)": "percentage",
  "Scientific (2 decimals)": "scientific",
  "Fraction (up to 1 digits)": "fraction_1",
  "Fraction (up to 2 digits)": "fraction_2",
  "Fraction (up to 3 digits)": "fraction_3",
  "Fraction (/2 fixed)": "fraction_halves",
  "Fraction (/4 fixed)": "fraction_quarters",
  "Fraction (/8 fixed)": "fraction_eighths",
  "Fraction (/16 fixed)": "fraction_sixteenths",
  "Fraction (/10 fixed)": "fraction_tenths",
  "Fraction (/100 fixed)": "fraction_hundredths",
  "Date (yyyy-mm-dd)": "date_iso",
  "Date (mm/dd/yyyy)": "date_us",
  "Date (dd/mm/yyyy)": "date_eu",
  "Time (hh:mm:ss)": "time_24h",
  "Time (hh:mm:ss AM/PM)": "time_12h",
  // Excel's Text format. `format_number_format_name` emits the raw code for a
  // Custom format, and `@` IS the whole code.
  "@": "text",
};

/** Display-name prefix -> category id, for named shapes with no exact preset
 *  (e.g. "Number (5 decimals)" after ribbon increase-decimal). */
const DISPLAY_PREFIX_TO_CATEGORY: Array<[string, string]> = [
  ["Number (", "number"],
  ["Currency (", "currency"],
  ["Accounting (", "accounting"],
  ["Percentage (", "percentage"],
  ["Scientific (", "scientific"],
  ["Fraction (", "fraction"],
  ["Date (", "date"],
  ["Time (", "time"],
];

const PRESET_VALUE_TO_CATEGORY: Record<string, string> = Object.fromEntries(
  NUMBER_FORMAT_CATEGORIES.flatMap((cat) =>
    cat.id !== "custom" ? cat.formats.map((f) => [f.value, cat.id] as [string, string]) : []
  )
);

/** Case-folded index of the static map, built once. */
const DISPLAY_NAME_TO_PRESET_CI: Record<string, string> = Object.fromEntries(
  Object.entries(DISPLAY_NAME_TO_PRESET).map(([name, preset]) => [
    name.toLowerCase(),
    preset,
  ])
);

// ============================================================================
// The ribbon seam
// ============================================================================
// The Home > Number dropdown resolves its eleven entries IN RUST, against the
// current locale, because five of them are regional (Excel writes Short/Long
// Date and Time as `[$-x-sysdate]`-style handles and takes Currency and
// Accounting from the OS currency pattern). It then reads the cell's format
// back by comparing `get_style`'s DISPLAY NAME against that same backend
// response -- it never inverts the mapping itself.
//
// The dialog did invert it, in `DISPLAY_NAME_TO_PRESET` above, and so could not
// see three of those eleven: `Date (YYYY-MM-DD)` missed on CASE alone (the
// locale table spells the pattern uppercase, this table's `date_iso` spells the
// SAME pattern lowercase, and the engine's date formatter is case-insensitive),
// `Currency ( kr, 2 decimals)` missed on the sv-SE symbol's leading space, and
// Long Date had no row to highlight at all. The dialog opened on the right
// category showing nothing selected: it could not report the cell's own format,
// which is the defect BUG-0065 and BUG-0069 were each an instance of.
//
// Adding those three names here would have left the same hole open for the
// other seventeen locale arms. So the dialog now consults the SAME backend
// response the ribbon does, and the static table below stays only as the
// offline fallback for the dialog's own presets, which that response does not
// contain.

/** One row of `get_ribbon_number_formats`, as the dialog needs it. */
export interface RibbonResolvedFormat {
  preset: string;
  displayName: string;
  sample?: string;
}

/**
 * Ribbon presets that have no equivalent row in the categories above, and the
 * row each one should become.
 *
 * These are exactly Excel's locale-responsive entries -- the ones Excel marks
 * with an asterisk and re-resolves from Region settings. Their format strings
 * are deliberately absent: the label is all this side knows, and the sample
 * comes from the backend that resolved it.
 */
const RIBBON_ROWS: ReadonlyArray<{ preset: string; category: string; label: string }> = [
  { preset: "currency", category: "currency", label: "Currency (regional)" },
  { preset: "accounting", category: "accounting", label: "Accounting (regional)" },
  { preset: "date_short", category: "date", label: "Short Date" },
  { preset: "date_long", category: "date", label: "Long Date" },
  { preset: "time", category: "time", label: "Time (regional)" },
];

/**
 * Fold the ribbon's locale-resolved presets into the category list, so every
 * format the ribbon can apply is a row the dialog can highlight.
 *
 * Rows are PREPENDED, matching Excel: its Date list leads with Short Date and
 * Long Date, and its Currency list leads with the regional symbol.
 */
export function withRibbonPresets(
  categories: NumberFormatCategory[],
  ribbon: ReadonlyArray<RibbonResolvedFormat>
): NumberFormatCategory[] {
  if (ribbon.length === 0) return categories;
  const byPreset = new Map(ribbon.map((r) => [r.preset, r]));
  return categories.map((cat) => {
    const additions = RIBBON_ROWS.filter(
      (r) =>
        r.category === cat.id &&
        byPreset.has(r.preset) &&
        !cat.formats.some((f) => f.value === r.preset)
    ).map((r) => ({
      label: r.label,
      value: r.preset,
      example: byPreset.get(r.preset)?.sample,
    }));
    return additions.length === 0
      ? cat
      : { ...cat, formats: [...additions, ...cat.formats] };
  });
}

/** Preset -> category for the ribbon rows, so `categoryForFormat` can place them. */
const RIBBON_PRESET_TO_CATEGORY: Record<string, string> = Object.fromEntries(
  RIBBON_ROWS.map((r) => [r.preset, r.category])
);

/**
 * Normalize a format string (preset value OR backend display name) to a preset
 * value, or null if no preset is equivalent.
 *
 * `ribbon` is the backend's own preset/display-name pairs for the current
 * locale, and is consulted FIRST: it is authoritative, it is regional, and it
 * costs nothing to be right about. The static table is the offline fallback.
 */
export function normalizeToPresetValue(
  format: string,
  ribbon: ReadonlyArray<RibbonResolvedFormat> = []
): string | null {
  if (!format) return null;
  if (PRESET_VALUE_TO_CATEGORY[format]) return format;
  const lower = format.toLowerCase();
  if (PRESET_VALUE_TO_CATEGORY[lower]) return lower;
  // The backend resolved these against the live locale -- exact match first.
  const resolved = ribbon.find((r) => r.displayName === format);
  if (resolved) return resolved.preset;
  const resolvedCi = ribbon.find((r) => r.displayName.toLowerCase() === lower);
  if (resolvedCi) return resolvedCi.preset;
  // Case-insensitively, because `Date (YYYY-MM-DD)` and `Date (yyyy-mm-dd)` are
  // the SAME format to the engine's date formatter and must not be two here.
  return DISPLAY_NAME_TO_PRESET[format] ?? DISPLAY_NAME_TO_PRESET_CI[lower] ?? null;
}

/**
 * Which category a format string belongs to: preset values and backend
 * display names land in their real category; anything else with format
 * characters is custom; empty/general falls back to general.
 */
export function categoryForFormat(
  format: string,
  ribbon: ReadonlyArray<RibbonResolvedFormat> = []
): string {
  const preset = normalizeToPresetValue(format, ribbon);
  if (preset) {
    return PRESET_VALUE_TO_CATEGORY[preset] ?? RIBBON_PRESET_TO_CATEGORY[preset] ?? "general";
  }
  if (!format || format.toLowerCase().includes("general")) return "general";
  for (const [prefix, category] of DISPLAY_PREFIX_TO_CATEGORY) {
    if (format.startsWith(prefix) && format.endsWith(")")) return category;
  }
  return "custom";
}
