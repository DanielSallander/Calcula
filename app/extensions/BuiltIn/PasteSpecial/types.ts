//! FILENAME: app/extensions/BuiltIn/PasteSpecial/types.ts
// PURPOSE: Type definitions for Paste Special options.
// CONTEXT: Defines the configuration matrix for the Paste Special dialog.

// ============================================================================
// Paste Attribute (The "Paste" Group)
// ============================================================================

/**
 * Which layer of the clipboard cell data to paste.
 * - "all": Full cell object (content + formatting + logic)
 * - "formulas": Formula text only (preserves target formatting)
 * - "values": Flattened scalar results only (no formulas, no formatting)
 * - "formats": Style/formatting only (font, color, borders, alignment)
 * - "comments": Cell comments/notes only
 * - "validation": Data validation rules only
 * - "columnWidths": Column width dimensions only (ignores cell contents)
 */
export type PasteAttribute =
  | "all"
  | "formulas"
  | "values"
  | "formats"
  | "comments"
  | "validation"
  | "columnWidths";

// ============================================================================
// Mathematical Operation (The "Operation" Group)
// ============================================================================

/**
 * Mathematical operation to apply between source and target values.
 * - "none": Overwrite target with source
 * - "add": Target_New = Target_Old + Source
 * - "subtract": Target_New = Target_Old - Source
 * - "multiply": Target_New = Target_Old * Source
 * - "divide": Target_New = Target_Old / Source
 */
export type PasteOperation = "none" | "add" | "subtract" | "multiply" | "divide";

// ============================================================================
// Paste Special Options
// ============================================================================

/**
 * The full configuration for a Paste Special operation.
 */
export interface PasteSpecialOptions {
  /** Which attribute layer to paste */
  pasteAttribute: PasteAttribute;
  /** Mathematical operation to apply */
  operation: PasteOperation;
  /** If true, empty source cells don't overwrite target data */
  skipBlanks: boolean;
  /** If true, rotate the paste array (rows become columns) */
  transpose: boolean;
}

// ============================================================================
// Default Options
// ============================================================================

export const DEFAULT_PASTE_SPECIAL_OPTIONS: PasteSpecialOptions = {
  pasteAttribute: "all",
  operation: "none",
  skipBlanks: false,
  transpose: false,
};
