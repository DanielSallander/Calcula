//! FILENAME: app/src/core/lib/merge/index.ts
// PURPOSE: Excel's Merge menu in Core -- geometry, the pressed-state read, the
//          words, and the four gestures behind the merge grid commands.

export {
  normaliseBlock,
  selectionBlocks,
  sameBlock,
  intersects,
  blocksOverlap,
  regionsTouching,
  boundingBox,
  isSingleCell,
  cellCount,
  rowsOf,
  colsOf,
  type Block,
} from "./mergeGeometry";
export { readSelectionMergeState, type SelectionMergeState } from "./mergeState";
export {
  MERGE_DISCARDS_VALUES,
  MERGE_ON_PROTECTED_SHEET,
  MERGE_LABELS,
  MERGE_ALIGN_CELL_LIMIT,
  type MergeGestureKind,
} from "./mergeText";
export { runMergeGesture, isMergeGestureRunning, type MergeGestureHost } from "./mergeGestures";
