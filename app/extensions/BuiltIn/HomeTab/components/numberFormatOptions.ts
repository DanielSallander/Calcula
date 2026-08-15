//! FILENAME: app/extensions/BuiltIn/HomeTab/components/numberFormatOptions.ts
// PURPOSE: The rows of Excel's Home > Number dropdown.
// CONTEXT: LABELS AND ORDER ONLY. What each row *means* -- the format code, the
// date pattern, the currency symbol and which side it sits on -- is resolved in
// Rust by `parse_number_format_with_locale` (app/src-tauri/src/commands/
// styles.rs) and read back through `getRibbonNumberFormats()`. That split is
// deliberate: five of these eleven entries are REGIONAL, and Excel resolves
// them from the OS (`[$-x-sysdate]`, `[$-x-systime]`, the OS currency pattern),
// so a format string written down here would be a hard-coded region -- which is
// precisely the defect BUG-0064 filed against the Format Cells dialog.

/** Sentinel for the dropdown's last row; not a format. */
export const MORE_NUMBER_FORMATS_VALUE = "__more-number-formats__";

/** Sentinel for "the cell's format is not one of these eleven entries". */
export const CUSTOM_FORMAT_VALUE = "__custom__";

/** What Excel calls the row when the cell's format matches no entry. */
export const CUSTOM_FORMAT_LABEL = "Custom";

export interface RibbonNumberFormatOption {
  /** Preset keyword sent through applyFormatting; the backend's vocabulary. */
  preset: string;
  /** Excel's own words for the row. */
  label: string;
}

/**
 * Excel's Home > Number dropdown, in Excel's order.
 *
 * `Special` and `Custom` are absent on purpose: they are Format Cells
 * categories, not dropdown rows. The twelfth row, "More Number Formats...",
 * is UI (it opens that dialog) and lives in the component, not here.
 *
 * This array MUST stay identical to `RIBBON_NUMBER_FORMAT_PRESETS` in
 * app/src-tauri/src/commands/styles.rs -- the same mirror discipline that
 * binds types.ts to api_types.rs. Both sides carry a test spelling the list
 * out (`the_dropdown_is_excels_list_in_excels_order` there,
 * `numberFormatOptions.test.ts` here). The backend response drives the render
 * at runtime; this list is what paints before the first response lands, so a
 * drift would show as a one-frame flicker rather than a hard failure.
 */
export const RIBBON_NUMBER_FORMATS: RibbonNumberFormatOption[] = [
  { preset: "general", label: "General" },
  { preset: "number", label: "Number" },
  { preset: "currency", label: "Currency" },
  { preset: "accounting", label: "Accounting" },
  { preset: "date_short", label: "Short Date" },
  { preset: "date_long", label: "Long Date" },
  { preset: "time", label: "Time" },
  { preset: "percentage", label: "Percentage" },
  { preset: "fraction_1", label: "Fraction" },
  { preset: "scientific", label: "Scientific" },
  { preset: "text", label: "Text" },
];

/**
 * Which dropdown row a cell's CURRENT format sits on.
 *
 * `format` is what `get_style` reports -- a DISPLAY NAME
 * ("Number (2 decimals)", "Date (YYYY-MM-DD)", "@"), never a preset keyword --
 * so the answer comes from the backend's own preset/display-name pairs.
 * Anything with no pair is `Custom`, which is what Excel's box shows for a
 * format that is not one of its eleven entries.
 *
 * Before this existed the box compared display names against FORMAT CODES
 * ("0.00", "@"), which never matched: applying Number and re-reading the cell
 * put the box on a greyed-out, unselectable "Number (2 decimals)" row. The
 * dropdown could not report its own result.
 */
export function selectedPresetFor(
  format: string,
  resolved: ReadonlyArray<{ preset: string; displayName: string }>,
): string {
  if (!format) return "general";
  const match = resolved.find((entry) => entry.displayName === format);
  if (match) return match.preset;
  // Before the first backend response lands, only the default is decidable --
  // and "General" is the one the box shows on a brand-new workbook.
  if (resolved.length === 0 && format === "General") return "general";
  return CUSTOM_FORMAT_VALUE;
}
