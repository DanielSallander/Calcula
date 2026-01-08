// FILENAME: app/src/hooks/useMouseSelection/utils/index.ts
// PURPOSE: Public API for utility functions used in mouse selection.
// CONTEXT: Re-exports all utility functions from the utils subdirectory
// for convenient importing in other modules.

export { calculateAutoScrollDelta } from "./autoScrollUtils";
export { getCellFromMousePosition, getCurrentDimensionSize } from "./cellUtils";
export { createFillHandleCursorChecker } from "./fillHandleUtils";