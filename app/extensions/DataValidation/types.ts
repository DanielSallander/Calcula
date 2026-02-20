//! FILENAME: app/extensions/DataValidation/types.ts
// PURPOSE: Extension-internal types for Data Validation.
// CONTEXT: Types used only within this extension, not exported to the API.

import type {
  DataValidationAlertStyle,
  DataValidation,
  ValidationRange,
} from "../../src/api";

/** Cached state for the Data Validation extension. */
export interface ValidationState {
  /** All validation ranges for the current sheet (cached). */
  validationRanges: ValidationRange[];
  /** Cells currently marked as invalid (for "Circle Invalid Data"), null = not showing. */
  invalidCells: [number, number][] | null;
  /** Whether the list dropdown is open and for which cell. */
  openDropdownCell: { row: number; col: number } | null;
  /** Whether the input prompt tooltip is showing. */
  promptVisible: boolean;
  /** Which cell the prompt tooltip is showing for. */
  promptCell: { row: number; col: number } | null;
}

/** Data passed to the ListDropdownOverlay. */
export interface ListDropdownData {
  row: number;
  col: number;
  values: string[];
  currentValue: string;
}

/** Data passed to the ErrorAlertModal dialog. */
export interface ErrorAlertData {
  title: string;
  message: string;
  style: DataValidationAlertStyle;
}

/** Data passed to the DataValidationDialog. */
export interface ValidationDialogData {
  startRow: number;
  startCol: number;
  endRow: number;
  endCol: number;
  existingValidation: DataValidation | null;
}
