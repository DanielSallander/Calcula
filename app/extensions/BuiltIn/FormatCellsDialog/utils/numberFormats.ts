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
