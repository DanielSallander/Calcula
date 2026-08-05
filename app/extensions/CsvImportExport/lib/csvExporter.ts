//! FILENAME: app/extensions/CsvImportExport/lib/csvExporter.ts
// PURPOSE: Serialize cell data to CSV format.
// CONTEXT: Used by the CSV Export dialog to generate CSV text from grid data.
//          The serialization core is the shared @api/csvText module (facade
//          rule), which the script worker's api.text.toCsv also uses.

import { toCsvText } from "@api/csvText";

export interface CsvExportOptions {
  /** Field delimiter character. Default: "," */
  delimiter: string;
  /** Text qualifier character. Default: '"' */
  textQualifier: string;
  /** Line ending. Default: "\r\n" */
  lineEnding: string;
}

/**
 * Create default CSV export options.
 * If a locale decimal separator is provided, the default delimiter is adjusted:
 * locales using ',' as decimal get ';' as CSV delimiter.
 */
export function createDefaultExportOptions(localeDecimalSeparator?: string): CsvExportOptions {
  return {
    delimiter: localeDecimalSeparator === "," ? ";" : ",",
    textQualifier: '"',
    lineEnding: "\r\n",
  };
}

/**
 * Serialize a 2D array of cell values to CSV text.
 * Fields containing the delimiter, qualifier, or newlines are quoted.
 */
export function exportToCsv(
  data: string[][],
  options: CsvExportOptions,
): string {
  const { delimiter, textQualifier, lineEnding } = options;
  return toCsvText(data, delimiter, textQualifier, lineEnding);
}
