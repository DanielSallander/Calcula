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

export const NUMBER_FORMAT_CATEGORIES: NumberFormatCategory[] = [
  {
    id: "general",
    label: "General",
    description:
      "General format cells have no specific number format. Values are displayed as entered.",
    formats: [{ label: "General", value: "general", example: "1234.5" }],
  },
  {
    id: "number",
    label: "Number",
    description:
      "Number formats are used for general display of numbers. Currency and Accounting offer specialized formatting for monetary values.",
    formats: [
      { label: "1234.00", value: "number", example: "1234.00" },
      { label: "1,234.00", value: "number_sep", example: "1,234.00" },
    ],
  },
  {
    id: "currency",
    label: "Currency",
    description:
      "Currency formats are used for general monetary values. Use Accounting formats to align decimal points in a column.",
    formats: [
      { label: "$ (USD)", value: "currency_usd", example: "$1,234.00" },
      { label: "EUR", value: "currency_eur", example: "EUR 1,234.00" },
      { label: "kr (SEK)", value: "currency_sek", example: "1,234.00 kr" },
    ],
  },
  {
    id: "percentage",
    label: "Percentage",
    description:
      "Percentage formats multiply the cell value by 100 and display the result with a percent symbol.",
    formats: [
      { label: "12.00%", value: "percentage", example: "12.00%" },
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
    id: "custom",
    label: "Custom",
    description:
      "Custom formats let you create your own number format using format codes. " +
      "Use 0 for required digits, # for optional digits, and ; to separate positive, negative, zero, and text sections.",
    formats: [
      { label: "#,##0", value: "#,##0", example: "1,235" },
      { label: "#,##0.00", value: "#,##0.00", example: "1,234.50" },
      { label: "#,##0;(#,##0)", value: "#,##0;(#,##0)", example: "1,235" },
      { label: "#,##0;[Red](#,##0)", value: "#,##0;[Red](#,##0)", example: "1,235" },
      { label: "$#,##0.00", value: "$#,##0.00", example: "$1,234.50" },
      { label: "0%", value: "0%", example: "50%" },
      { label: "0.00%", value: "0.00%", example: "50.00%" },
      { label: "0.00E+00", value: "0.00E+00", example: "1.23E+03" },
      { label: "#,##0.0,", value: "#,##0.0,", example: "1,234.5" },
      { label: "0.00;[Red]-0.00", value: "0.00;[Red]-0.00", example: "1234.50" },
      { label: '0.00" kr"', value: '0.00" kr"', example: "1234.50 kr" },
      { label: ";;;", value: ";;;", example: "(hidden)" },
    ],
  },
];
