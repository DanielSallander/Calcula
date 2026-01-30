//! FILENAME: app/src/api/types.ts
// PURPOSE: Public type exports for extensions.
// CONTEXT: Extensions should import types from here instead of core internals.

// Re-export types that extensions are allowed to use
export type {
  // Selection and viewport
  Selection,
  SelectionType,
  Viewport,
  ClipboardMode,

  // Grid configuration
  GridConfig,
  FreezeConfig,
  DimensionOverrides,

  // Editing state
  EditingCell,

  // Cell data
  CellData,
  StyleData,
  DimensionData,

  // Formatting
  FormattingOptions,
  FormattingResult,

  // Functions
  FunctionInfo,

  // Formula references
  FormulaReference,

  // Merged cells
  MergedRegion,
} from "../core/types";

// Re-export default config and utility functions
export { DEFAULT_FREEZE_CONFIG, DEFAULT_GRID_CONFIG, columnToLetter } from "../core/types";
