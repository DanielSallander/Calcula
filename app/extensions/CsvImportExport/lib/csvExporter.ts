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
 * The default delimiter is the app locale's LIST separator (pass
 * `listSeparator()` from `@api/locale`): "," in en-US, ";" in de-DE and
 * sv-SE -- the same character Excel's "CSV" uses in that region, and the one
 * a decimal-comma locale needs so "1,5" stays one field. No separator = ",".
 */
export function createDefaultExportOptions(listSeparator?: string): CsvExportOptions {
  return {
    delimiter: listSeparator ? listSeparator : ",",
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
