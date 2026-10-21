//! FILENAME: app/src/api/cellPaint.ts
// PURPOSE: The cell-painting primitive, for extensions whose objects show cells
//          of their own (a floating grid): `paintStyledCellBox` paints ONE
//          formatted cell -- fill, borders, text with every alignment, wrap,
//          indent, rotation, accounting and rich-text rule the sheet uses --
//          into a box the caller positions.
// CONTEXT: Imported by its own path (`@api/cellPaint`). The implementation is
//          Core's (`core/lib/gridRenderer/rendering/styledCellBox.ts`), built on
//          the same helpers the grid painter uses, so a cell painted here looks
//          like the same cell on the sheet.
//
// USAGE:
//   import { paintStyledCellBox } from "@api/cellPaint";
//   import { conditionalResultsToOverride } from "@api/conditionalFormatPaint";
//
//   paintStyledCellBox(ctx, { x, y, width, height }, {
//     cell,                 // the backend's CellData for the cell
//     style,                // the style cache entry for cell.styleIndex
//     valueKind: "number",  // the backend's value kind (General alignment)
//     conditional: conditionalResultsToOverride(cfResultsForThisCell),
//   });
//
// The painter never consults the style interceptors: those answer for the
// ACTIVE sheet's (row, col), and an object's cell lives somewhere else. Pass the
// cell's own conditional result as `conditional` instead.

export {
  paintStyledCellBox,
  paintStyledCellEdges,
  effectiveCellStyle,
  type CellBox,
  type CellValueKind,
  type StyledCellPaint,
  type StyledCellTheme,
} from "../core/lib/gridRenderer/rendering/styledCellBox";
