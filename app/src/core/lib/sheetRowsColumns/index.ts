//! FILENAME: app/src/core/lib/sheetRowsColumns/index.ts
// PURPOSE: Excel's Insert / Delete Sheet Rows / Columns in Core -- the span
//          arithmetic and the four gestures behind the grid commands.

export { sheetSpans, type IndexSpan, type SheetAxis, type SpanAnswer } from "./spans";
export {
  runRowColumnGesture,
  OVERLAPPING_SELECTIONS,
  shiftOffSheetRefusal,
  type RowColumnGestureKind,
  type RowColumnGestureHost,
} from "./rowColumnGestures";
