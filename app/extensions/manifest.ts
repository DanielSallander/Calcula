//! FILENAME: app/extensions/manifest.ts
// PURPOSE: Static manifest of built-in extensions.
// CONTEXT: This is the ONLY file allowed to import from extensions/BuiltIn/*.
//          The ExtensionManager imports from here to load built-ins.
// NOTE: Runtime extensions will be loaded dynamically via URL import.

import type { ExtensionModule } from "../src/api/contract";

// ============================================================================
// Built-in Extension Imports
// IMPORTANT: This is the ONLY place that imports from extensions/BuiltIn/
// ============================================================================

import FindReplaceExtension from "./BuiltIn/FindReplaceDialog";
import StandardMenusExtension from "./BuiltIn/StandardMenus";
import FormatCellsExtension from "./BuiltIn/FormatCellsDialog";
import FormulaAutocompleteExtension from "./BuiltIn/FormulaAutocomplete";

// ============================================================================
// Built-in Extension Manifest
// ============================================================================

/**
 * List of all built-in extensions to be loaded at startup.
 * Order matters: extensions are activated in array order.
 */
export const builtInExtensions: ExtensionModule[] = [
  // StandardMenus should load first (registers File, Edit, View, Insert menus)
  StandardMenusExtension,
  // FindReplace depends on Edit menu being registered
  FindReplaceExtension,
  // FormatCells depends on Format menu being registered
  FormatCellsExtension,
  // Formula Autocomplete (Intellisense)
  FormulaAutocompleteExtension,
];

/**
 * Get all built-in extension IDs.
 */
export function getBuiltInExtensionIds(): string[] {
  return builtInExtensions.map((ext) => ext.manifest.id);
}