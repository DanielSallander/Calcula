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
import ColumnValueAutocompleteExtension from "./BuiltIn/ColumnValueAutocomplete";
import FormatPainterExtension from "./BuiltIn/FormatPainter";
import PasteSpecialExtension from "./BuiltIn/PasteSpecial";
import StatusBarAggregationExtension from "./BuiltIn/StatusBarAggregation";
import ComputedPropertiesExtension from "./BuiltIn/ComputedProperties";
import CellBookmarksExtension from "./BuiltIn/CellBookmarks";
import ZoomSliderExtension from "./BuiltIn/ZoomSlider";
import HomeTabExtension from "./BuiltIn/HomeTab";
import DocumentThemeExtension from "./BuiltIn/DocumentTheme";
import CollectionPreviewExtension from "./BuiltIn/CollectionPreview";

// Dev-only extensions
import TestRunnerExtension from "./TestRunner";

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
  // Home Tab (always-visible ribbon tab with quick-access formatting)
  HomeTabExtension,
  // Document Theme (Page Layout tab with theme gallery, fonts, colors)
  DocumentThemeExtension,
  // Format Painter (depends on Edit menu being registered)
  FormatPainterExtension,
  // Paste Special (depends on Edit menu being registered)
  PasteSpecialExtension,
  // Formula Autocomplete (Intellisense)
  FormulaAutocompleteExtension,
  // Column Value Autocomplete (Excel-style same-column suggestions)
  ColumnValueAutocompleteExtension,
  // Status Bar Aggregation (Average, Count, Sum for selections)
  StatusBarAggregationExtension,
  // Computed Properties (formula-driven attributes for columns, rows, cells)
  ComputedPropertiesExtension,
  // Cell Bookmarks (mark, navigate, manage bookmarks - extensibility test)
  CellBookmarksExtension,
  // Zoom Slider (Excel-style zoom control in status bar)
  ZoomSliderExtension,
  // Collection Preview (sidebar panel for List/Dict cells)
  CollectionPreviewExtension,
  // Test Runner (dev-only, macro-based integration tests)
  ...(import.meta.env.DEV ? [TestRunnerExtension] : []),
];

/**
 * Get all built-in extension IDs.
 */
export function getBuiltInExtensionIds(): string[] {
  return builtInExtensions.map((ext) => ext.manifest.id);
}