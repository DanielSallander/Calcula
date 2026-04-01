//! FILENAME: app/extensions/CsvImportExport/lib/csvExporter.ts
// PURPOSE: Serialize cell data to CSV format.
// CONTEXT: Used by the CSV Export dialog to generate CSV text from grid data.

export interface CsvExportOptions {
  /** Field delimiter character. Default: "," */
  delimiter: string;
  /** Text qualifier character. Default: '"' */
  textQualifier: string;
  /** Line ending. Default: "\r\n" */
  lineEnding: string;
}

export function createDefaultExportOptions(): CsvExportOptions {
  return {
    delimiter: ",",
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
  const needsQuoting = new RegExp(
    `[${escapeRegex(delimiter)}${escapeRegex(textQualifier)}\r\n]`,
  );

  const lines: string[] = [];

  for (const row of data) {
    const fields = row.map((value) => {
      if (needsQuoting.test(value)) {
        // Escape qualifier by doubling it
        const escaped = value.replace(
          new RegExp(escapeRegex(textQualifier), "g"),
          textQualifier + textQualifier,
        );
        return textQualifier + escaped + textQualifier;
      }
      return value;
    });
    lines.push(fields.join(delimiter));
  }

  return lines.join(lineEnding);
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
