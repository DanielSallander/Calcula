//! FILENAME: app/extensions/Table/lib/tableStyleInterceptor.ts
// PURPOSE: Style interceptor that applies table formatting (header, banded rows, etc.)
// CONTEXT: Registered with the API style interceptor pipeline so the core renderer
//          draws table cells with appropriate formatting without Core knowing about tables.

import {
  registerStyleInterceptor,
  type IStyleOverride,
  type BaseStyleInfo,
  type CellCoords,
} from "../../../src/api";
import { getTableAtCell, getAllTables, type Table } from "./tableStore";

// ============================================================================
// Style Constants (Excel "TableStyleMedium2"-like theme)
// ============================================================================

/** Header row: dark accent background, white bold text */
const HEADER_BG = "#4472C4";
const HEADER_TEXT = "#FFFFFF";

/** Banded rows: alternating light fills */
const BAND_EVEN_BG = "#D9E2F3";
const BAND_ODD_BG = ""; // transparent (no override)

/** Total row: light background with top border emphasis */
const TOTAL_BG = "#D9E2F3";

/** First/last column: bold text */

// ============================================================================
// Registration
// ============================================================================

let cleanupFn: (() => void) | null = null;

/**
 * Register the table style interceptor.
 * Should be called during extension activation.
 */
export function registerTableStyleInterceptor(): () => void {
  if (cleanupFn) return cleanupFn;

  cleanupFn = registerStyleInterceptor(
    "calcula.table.style",
    tableStyleInterceptor,
    5, // Priority: after conditional formatting (10+)
  );

  return () => {
    if (cleanupFn) {
      cleanupFn();
      cleanupFn = null;
    }
  };
}

// ============================================================================
// Interceptor Logic
// ============================================================================

/**
 * The style interceptor function called for every visible cell during rendering.
 * Checks if the cell is inside a table and applies appropriate formatting.
 */
function tableStyleInterceptor(
  _cellValue: string,
  baseStyle: BaseStyleInfo,
  coords: CellCoords,
): IStyleOverride | null {
  const table = getTableAtCell(coords.row, coords.col);
  if (!table) return null;

  const opts = table.styleOptions;

  // Header row styling
  if (opts.headerRow && coords.row === table.startRow) {
    return {
      backgroundColor: HEADER_BG,
      textColor: HEADER_TEXT,
      bold: true,
    };
  }

  // Totals row styling
  if (opts.totalRow && coords.row === table.endRow) {
    return {
      backgroundColor: TOTAL_BG,
      bold: true,
    };
  }

  // Data area styling
  const dataStartRow = opts.headerRow ? table.startRow + 1 : table.startRow;
  const dataEndRow = opts.totalRow ? table.endRow - 1 : table.endRow;

  if (coords.row >= dataStartRow && coords.row <= dataEndRow) {
    const override: IStyleOverride = {};
    let hasOverride = false;

    // Banded rows
    if (opts.bandedRows) {
      const dataRowIndex = coords.row - dataStartRow;
      if (dataRowIndex % 2 === 0) {
        override.backgroundColor = BAND_EVEN_BG;
        hasOverride = true;
      }
      // Odd rows keep the base style (no override)
    }

    // Banded columns (applied in addition to banded rows)
    if (opts.bandedColumns) {
      const colIndex = coords.col - table.startCol;
      if (colIndex % 2 === 0) {
        // Slightly darker for even columns
        if (!override.backgroundColor) {
          override.backgroundColor = BAND_EVEN_BG;
          hasOverride = true;
        }
      }
    }

    // First column emphasis
    if (opts.firstColumn && coords.col === table.startCol) {
      override.bold = true;
      hasOverride = true;
    }

    // Last column emphasis
    if (opts.lastColumn && coords.col === table.endCol) {
      override.bold = true;
      hasOverride = true;
    }

    return hasOverride ? override : null;
  }

  return null;
}
