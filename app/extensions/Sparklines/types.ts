//! FILENAME: app/extensions/Sparklines/types.ts
// PURPOSE: Type definitions for the Sparklines extension.
// CONTEXT: Defines sparkline data model used by the store, renderer, and dialog.

/** Type of sparkline visualization */
export type SparklineType = "line" | "column" | "winloss";

/**
 * A Sparkline Group defines a mapping from a Data Range to a Location Range.
 *
 * Location Range rules:
 *   - Must be 1x1 (single cell), 1xN (single row), or Nx1 (single column).
 *   - Cannot be a 2D block (e.g. 2x3).
 *
 * Data Range rules:
 *   - Can be 1D or 2D.
 *   - For a single-cell location, the data range must be 1D.
 *   - For a multi-cell location, the "major dimension" of the data range
 *     must match the location length.
 *
 * Mapping:
 *   - Column location (Nx1): each row of data maps to a location cell.
 *   - Row location (1xN): each column of data maps to a location cell.
 */
export interface SparklineGroup {
  /** Unique ID for this group */
  id: number;
  /** Location range (where sparklines are drawn) */
  location: CellRange;
  /** Data source range (the numbers) */
  dataRange: CellRange;
  /** Sparkline type */
  type: SparklineType;
  /** Line color (for line type) or positive bar color */
  color: string;
  /** Negative bar color (for column/winloss) */
  negativeColor: string;
  /** Whether to show markers on all data points (line sparklines) */
  showMarkers: boolean;
  /** Line width for line sparklines */
  lineWidth: number;

  // -- Point visibility flags --
  /** Whether to highlight the highest data point */
  showHighPoint: boolean;
  /** Whether to highlight the lowest data point */
  showLowPoint: boolean;
  /** Whether to highlight the first data point */
  showFirstPoint: boolean;
  /** Whether to highlight the last data point */
  showLastPoint: boolean;
  /** Whether to highlight negative data points */
  showNegativePoints: boolean;

  // -- Point colors --
  /** Color for the high point marker */
  highPointColor: string;
  /** Color for the low point marker */
  lowPointColor: string;
  /** Color for the first point marker */
  firstPointColor: string;
  /** Color for the last point marker */
  lastPointColor: string;
  /** Color for negative point markers */
  negativePointColor: string;
  /** Color for general markers (all data points) */
  markerColor: string;
}

/** A contiguous rectangular cell range (0-based, inclusive) */
export interface CellRange {
  startRow: number;
  startCol: number;
  endRow: number;
  endCol: number;
}

/** Orientation of data slicing when mapping data rows/cols to location cells */
export type DataOrientation = "byRow" | "byCol";

// ============================================================================
// Validation
// ============================================================================

export interface ValidationResult {
  valid: boolean;
  error?: string;
  /** Number of sparklines that will be created */
  count?: number;
  /** How data is sliced: each row or each column becomes one sparkline */
  orientation?: DataOrientation;
}

/**
 * Validate the relationship between a Location Range and a Data Range.
 * Returns a result indicating whether the combination is valid, and if so,
 * how many sparklines will be created and the data orientation.
 */
export function validateSparklineRanges(
  location: CellRange,
  dataRange: CellRange,
): ValidationResult {
  const locRows = location.endRow - location.startRow + 1;
  const locCols = location.endCol - location.startCol + 1;
  const dataRows = dataRange.endRow - dataRange.startRow + 1;
  const dataCols = dataRange.endCol - dataRange.startCol + 1;

  // Rule: Location must be 1D (single cell, single row, or single column)
  if (locRows > 1 && locCols > 1) {
    return {
      valid: false,
      error: "The location range is not valid. It must be a single cell, a single row, or a single column.",
    };
  }

  const locLength = Math.max(locRows, locCols);

  // Single-cell location
  if (locLength === 1) {
    // Data range must be 1D (single row or single column)
    if (dataRows > 1 && dataCols > 1) {
      return {
        valid: false,
        error: "A single-cell location cannot display a 2D data range. Use a 1D data range (single row or column).",
      };
    }
    // Orientation: read the 1D array as-is
    const orientation: DataOrientation = dataRows === 1 ? "byRow" : "byCol";
    return { valid: true, count: 1, orientation };
  }

  // Multi-cell location (1xN row or Nx1 column)
  const isLocColumn = locCols === 1; // Nx1
  const isLocRow = locRows === 1;    // 1xN

  // Data range is 1D
  if (dataRows === 1 || dataCols === 1) {
    const dataLength = Math.max(dataRows, dataCols);
    if (dataLength === 1) {
      // Single data cell mapped to multiple location cells: each gets the same single value
      // This is technically valid but not very useful; allow it
      return {
        valid: true,
        count: locLength,
        orientation: isLocColumn ? "byRow" : "byCol",
      };
    }
    // 1D data with multi-cell location: the location length must match data length
    // Each location cell gets just one data point (not very useful for sparklines)
    // More likely the user meant something else, but still allow if dimensions match
    if (dataLength !== locLength) {
      return {
        valid: false,
        error: `The data range and location range must have the same number of ${isLocColumn ? "rows" : "columns"}. Location has ${locLength}, data has ${dataLength}.`,
      };
    }
    return {
      valid: true,
      count: locLength,
      orientation: isLocColumn ? "byRow" : "byCol",
    };
  }

  // Data range is 2D
  if (isLocColumn) {
    // Location is Nx1 column: the major data dimension is rows
    if (dataRows === locLength) {
      return { valid: true, count: locLength, orientation: "byRow" };
    }
    // Check if columns match instead (shouldn't by spec, but provide helpful error)
    return {
      valid: false,
      error: `The data range and location range must have the same number of rows. Location has ${locLength} rows, data has ${dataRows} rows.`,
    };
  }

  if (isLocRow) {
    // Location is 1xN row: the major data dimension is columns
    if (dataCols === locLength) {
      return { valid: true, count: locLength, orientation: "byCol" };
    }
    return {
      valid: false,
      error: `The data range and location range must have the same number of columns. Location has ${locLength} columns, data has ${dataCols} columns.`,
    };
  }

  return { valid: false, error: "Invalid range combination." };
}
