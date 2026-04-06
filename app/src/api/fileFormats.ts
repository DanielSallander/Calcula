//! FILENAME: app/src/api/fileFormats.ts
// PURPOSE: File format importer/exporter registration API for extensions.
// CONTEXT: Extensions can register handlers for custom file formats (e.g., XLSX, JSON,
//          TSV, custom binary formats). The system uses these handlers when opening
//          or saving files with matching extensions.

// ============================================================================
// Types
// ============================================================================

/** Cell data used for import/export (simplified for extension use) */
export interface ImportCellData {
  /** Sheet index (0-based) */
  sheetIndex: number;
  /** Row index (0-based) */
  row: number;
  /** Column index (0-based) */
  col: number;
  /** Cell value as string */
  value: string;
  /** Whether the value is a formula */
  isFormula?: boolean;
}

/** Sheet metadata for imports that create multiple sheets */
export interface ImportSheetData {
  /** Sheet name */
  name: string;
  /** Cells in this sheet */
  cells: ImportCellData[];
}

/** Result of an import operation */
export interface ImportResult {
  /** Sheets and their cell data */
  sheets: ImportSheetData[];
}

/** Context for export operations */
export interface ExportContext {
  /** Total number of sheets */
  sheetCount: number;
  /** Sheet names */
  sheetNames: string[];
  /** Function to read a cell value */
  getCell: (sheetIndex: number, row: number, col: number) => Promise<{ value: string; formula?: string } | null>;
  /** Function to get the used range of a sheet */
  getUsedRange: (sheetIndex: number) => Promise<{ endRow: number; endCol: number } | null>;
}

/** A file format handler registration */
export interface FileFormatRegistration {
  /** Unique format ID (e.g., "xlsx", "json", "tsv") */
  id: string;
  /** Display name (e.g., "Excel Workbook", "JSON Data") */
  name: string;
  /** File extensions this format handles (without dots, e.g., ["xlsx", "xls"]) */
  extensions: string[];
  /** Import handler: receives file content as ArrayBuffer, returns cell data */
  importer?: (data: ArrayBuffer, fileName: string) => Promise<ImportResult>;
  /** Export handler: receives export context, returns file content as ArrayBuffer */
  exporter?: (context: ExportContext) => Promise<ArrayBuffer>;
  /** Priority for format selection (higher = preferred when multiple formats match) */
  priority?: number;
}

/** Contract for the file format API on ExtensionContext */
export interface IFileFormatAPI {
  /** Register a file format handler */
  registerFormat(registration: FileFormatRegistration): () => void;
  /** Get all registered formats */
  getFormats(): FileFormatRegistration[];
}

// ============================================================================
// State
// ============================================================================

const formats: FileFormatRegistration[] = [];
type ChangeListener = () => void;
const listeners: Set<ChangeListener> = new Set();

// ============================================================================
// Public API
// ============================================================================

/**
 * Register a file format handler.
 *
 * @param registration The format registration
 * @returns Cleanup function to unregister the format
 *
 * @example
 * ```ts
 * const unreg = registerFileFormat({
 *   id: "json",
 *   name: "JSON Data",
 *   extensions: ["json"],
 *   importer: async (data) => {
 *     const text = new TextDecoder().decode(data);
 *     const json = JSON.parse(text);
 *     // Convert JSON to ImportResult...
 *     return { sheets: [{ name: "Sheet1", cells: [...] }] };
 *   },
 *   exporter: async (context) => {
 *     // Read cells and convert to JSON...
 *     const json = JSON.stringify(data);
 *     return new TextEncoder().encode(json).buffer;
 *   },
 * });
 * ```
 */
export function registerFileFormat(registration: FileFormatRegistration): () => void {
  formats.push(registration);
  // Sort by priority (highest first)
  formats.sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0));
  notifyChanged();

  return () => {
    const idx = formats.indexOf(registration);
    if (idx >= 0) {
      formats.splice(idx, 1);
      notifyChanged();
    }
  };
}

/**
 * Find the importer for a file based on its extension.
 */
export function findImporter(
  fileName: string
): FileFormatRegistration | null {
  const ext = fileName.split(".").pop()?.toLowerCase();
  if (!ext) return null;
  return formats.find((f) => f.importer && f.extensions.includes(ext)) ?? null;
}

/**
 * Find the exporter for a file based on its extension.
 */
export function findExporter(
  fileName: string
): FileFormatRegistration | null {
  const ext = fileName.split(".").pop()?.toLowerCase();
  if (!ext) return null;
  return formats.find((f) => f.exporter && f.extensions.includes(ext)) ?? null;
}

/**
 * Get all registered file formats.
 */
export function getFileFormats(): FileFormatRegistration[] {
  return [...formats];
}

/**
 * Get file dialog filter entries for all registered formats.
 * Useful for building file picker dialogs with custom format support.
 */
export function getFileDialogFilters(): Array<{ name: string; extensions: string[] }> {
  return formats.map((f) => ({
    name: f.name,
    extensions: f.extensions,
  }));
}

/**
 * Subscribe to format registry changes.
 */
export function subscribeToFileFormats(callback: ChangeListener): () => void {
  listeners.add(callback);
  return () => listeners.delete(callback);
}

function notifyChanged(): void {
  listeners.forEach((cb) => {
    try {
      cb();
    } catch (e) {
      console.error("[FileFormats] Error in change listener:", e);
    }
  });
}
