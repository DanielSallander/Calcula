//! FILENAME: app/extensions/Table/lib/tableStyleInterceptor.ts
// PURPOSE: Style interceptor that paints a table in its STORED style (header,
//          banded rows/columns, total row, first/last column).
// CONTEXT: Registered with the API style interceptor pipeline so the core renderer
//          draws table cells with appropriate formatting without Core knowing about tables.
//
//          The style is the table's own `styleName` (`TableStyleMedium2`, what the
//          Table Styles gallery writes and `table.setStyle` sets), resolved through
//          the catalogue in ./tableStyles.ts. This file names no colour: it used to
//          hardcode Medium 2's header (#4472C4) and stripe (#D9E2F3) for EVERY
//          table, so the gallery wrote a new style name and the sheet never
//          changed. The catalogue derives each style's grid paint from its
//          thumbnail, so the table wears what the user clicked.
//
//          This is the per-cell render path: every visible cell of every table
//          comes through here on every frame. Each stored style name is resolved
//          ONCE into frozen override objects (header, total, and the four data-
//          cell variants) and cached by name; the per-cell work is a cache hit
//          and a few comparisons, with no allocation.

import {
  registerStyleInterceptor,
  type IStyleOverride,
  type BaseStyleInfo,
  type CellCoords,
} from "@api";
import { getTableAtCell, type Table } from "./tableStore";
import {
  DEFAULT_TABLE_STYLE_ID,
  TABLE_STYLE_NONE_ID,
  TABLE_STYLES_BY_ID,
  tableStyleIdForName,
  type TableStyleCellPaint,
} from "./tableStyles";

// ============================================================================
// Style resolution (cached per stored style name)
// ============================================================================

/** A style's paint, ready for the per-cell path. */
export interface ResolvedTablePaint {
  header: IStyleOverride;
  total: IStyleOverride;
  /** Data cells, `[edge][stripe]` (0 = no, 1 = yes); null paints nothing. */
  data: readonly [
    readonly [IStyleOverride | null, IStyleOverride | null],
    readonly [IStyleOverride | null, IStyleOverride | null],
  ];
}

/** One override: a fill and a text colour ("" = leave the cell's own), plus weight. */
function override(bg: string, fg: string, bold: boolean): IStyleOverride | null {
  const out: IStyleOverride = {};
  if (bg) out.backgroundColor = bg;
  if (fg) out.textColor = fg;
  if (bold) out.bold = true;
  return Object.keys(out).length > 0 ? Object.freeze(out) : null;
}

/** A data cell: the body, then a stripe over it, then the edge emphasis over
 *  both. A layer that paints its own fill brings its own text colour with it,
 *  so light text never lands on a light fill. */
function dataOverride(p: TableStyleCellPaint, edge: boolean, stripe: boolean): IStyleOverride | null {
  let bg = p.bodyBg;
  let fg = p.bodyFg;
  if (stripe && p.stripeBg) {
    bg = p.stripeBg;
    fg = p.stripeFg;
  }
  if (edge && p.edgeBg) {
    bg = p.edgeBg;
    fg = p.edgeFg;
  }
  return override(bg, fg, edge);
}

function resolvePaint(p: TableStyleCellPaint): ResolvedTablePaint {
  return {
    header: override(p.headerBg, p.headerFg, true) ?? Object.freeze({ bold: true }),
    total: override(p.totalBg, p.totalFg, true) ?? Object.freeze({ bold: true }),
    data: [
      [dataOverride(p, false, false), dataOverride(p, false, true)],
      [dataOverride(p, true, false), dataOverride(p, true, true)],
    ],
  };
}

const paintByStyleName = new Map<string, ResolvedTablePaint | null>();

/**
 * The paint for a stored style name, or null for the None style (the table
 * keeps its data and wears no style at all). A name the catalogue cannot draw
 * (an imported custom style, `TableStyleMedium29`) falls back to the default
 * Medium 2, which is what every table painted before styles were resolved.
 * Exported for tests.
 */
export function resolveTablePaint(styleName: string | null | undefined): ResolvedTablePaint | null {
  const key = styleName ?? "";
  const cached = paintByStyleName.get(key);
  if (cached !== undefined) return cached;

  // tableStyleIdForName returns the None id, a catalogue id, or null.
  const id = tableStyleIdForName(key);
  const def = id === TABLE_STYLE_NONE_ID ? undefined : TABLE_STYLES_BY_ID.get(id ?? DEFAULT_TABLE_STYLE_ID);
  const resolved = def ? resolvePaint(def.cells) : null;
  paintByStyleName.set(key, resolved);
  return resolved;
}

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
 * What a table paints on one of its cells, or null for no override. The
 * style-option flags decide WHICH element a cell is (header, total, stripe,
 * edge column); the table's stored style decides what that element looks like.
 * Exported for tests.
 */
export function tableCellStyle(table: Table, row: number, col: number): IStyleOverride | null {
  const paint = resolveTablePaint(table.styleName);
  if (!paint) return null;

  const opts = table.styleOptions;

  // Header row
  if (opts.headerRow && row === table.startRow) {
    return paint.header;
  }

  // Totals row
  if (opts.totalRow && row === table.endRow) {
    return paint.total;
  }

  // Data area
  const dataStartRow = opts.headerRow ? table.startRow + 1 : table.startRow;
  const dataEndRow = opts.totalRow ? table.endRow - 1 : table.endRow;
  if (row < dataStartRow || row > dataEndRow) return null;

  // Banded rows stripe every other data row starting with the first; banded
  // columns stripe every other column starting with the first. A cell striped
  // either way wears the stripe once.
  const stripe =
    (opts.bandedRows && (row - dataStartRow) % 2 === 0) ||
    (opts.bandedColumns && (col - table.startCol) % 2 === 0);
  const edge =
    (opts.firstColumn && col === table.startCol) || (opts.lastColumn && col === table.endCol);

  return paint.data[edge ? 1 : 0][stripe ? 1 : 0];
}

/**
 * The style interceptor function called for every visible cell during rendering.
 * Checks if the cell is inside a table and applies its style.
 */
function tableStyleInterceptor(
  _cellValue: string,
  _baseStyle: BaseStyleInfo,
  coords: CellCoords,
): IStyleOverride | null {
  const table = getTableAtCell(coords.row, coords.col);
  if (!table) return null;
  return tableCellStyle(table, coords.row, coords.col);
}
