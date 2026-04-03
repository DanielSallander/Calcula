//! FILENAME: app/extensions/manifest.ts
// PURPOSE: Static manifest of built-in extensions.
// CONTEXT: This is the ONLY file allowed to import from extensions/BuiltIn/*.
//          The ExtensionManager imports from here to load built-ins.
// NOTE: Runtime extensions will be loaded dynamically via URL import.

import type { ExtensionModule } from "@api/contract";

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

// Activity Bar views (migrated from Path B)
import FileExplorerExtension from "./FileExplorer";
import SearchExtension from "./Search";
import ExtensionsManagerExtension from "./ExtensionsManager";
import SettingsExtension from "./Settings";

// Batch 2: Simple dialogs/menus (migrated from Path B)
import SortingExtension from "./Sorting";
import RemoveDuplicatesExtension from "./RemoveDuplicates";
import TextToColumnsExtension from "./TextToColumns";
import GoalSeekExtension from "./GoalSeek";
import GoToSpecialExtension from "./GoToSpecial";
import FlashFillExtension from "./FlashFill";
import CustomFillListsExtension from "./CustomFillLists";
import AdvancedFilterExtension from "./AdvancedFilter";
import SubtotalsExtension from "./Subtotals";
import CsvImportExportExtension from "./CsvImportExport";
import WatchWindowExtension from "./WatchWindow";
import CalculationOptionsExtension from "./CalculationOptions";
import ReviewExtension from "./Review";
import EvaluateFormulaExtension from "./EvaluateFormula";
import FormulaVisualizerExtension from "./FormulaVisualizer";

// Batch 3: Medium complexity (migrated from Path B)
import DataValidationExtension from "./DataValidation";
import ConditionalFormattingExtension from "./ConditionalFormatting";
import ProtectionExtension from "./Protection";
import TracingExtension from "./Tracing";
import DefinedNamesExtension from "./DefinedNames";
import ConsolidateExtension from "./Consolidate";
import ScenarioManagerExtension from "./ScenarioManager";
import DataTablesExtension from "./DataTables";
import SolverExtension from "./Solver";
import CheckboxExtension from "./Checkbox";
import SparklinesExtension from "./Sparklines";
import GroupingExtension from "./Grouping";
import PrintExtension from "./Print";
import ScriptEditorExtension from "./ScriptEditor";
import ScriptNotebookExtension from "./ScriptNotebook";

// Batch 4: Complex extensions (migrated from Path B)
import ChartExtension from "./Charts";
import PivotExtension from "./Pivot";
import TableExtension from "./Table";
import SlicerExtension from "./Slicer";
import TimelineSlicerExtension from "./TimelineSlicer";
import AutoFilterExtension from "./AutoFilter";
import ControlsExtension from "./Controls";
import BusinessIntelligenceExtension from "./BusinessIntelligence";
import AIChatExtension from "./AIChat";
import ReportStoreExtension from "./ReportStore";

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
  // AutoFilter creates the "data" menu — must load before extensions that add to it
  AutoFilterExtension,
  // Activity Bar views
  FileExplorerExtension,
  SearchExtension,
  ExtensionsManagerExtension,
  SettingsExtension,
  // Simple dialogs/menus
  SortingExtension,
  RemoveDuplicatesExtension,
  TextToColumnsExtension,
  GoalSeekExtension,
  GoToSpecialExtension,
  FlashFillExtension,
  CustomFillListsExtension,
  AdvancedFilterExtension,
  SubtotalsExtension,
  CsvImportExportExtension,
  WatchWindowExtension,
  CalculationOptionsExtension,
  ReviewExtension,
  EvaluateFormulaExtension,
  FormulaVisualizerExtension,
  // Medium complexity extensions
  DataValidationExtension,
  ConditionalFormattingExtension,
  ProtectionExtension,
  TracingExtension,
  DefinedNamesExtension,
  ConsolidateExtension,
  ScenarioManagerExtension,
  DataTablesExtension,
  SolverExtension,
  CheckboxExtension,
  SparklinesExtension,
  GroupingExtension,
  PrintExtension,
  ScriptEditorExtension,
  ScriptNotebookExtension,
  // Complex extensions
  ChartExtension,
  PivotExtension,
  TableExtension,
  SlicerExtension,
  TimelineSlicerExtension,
  ControlsExtension,
  BusinessIntelligenceExtension,
  AIChatExtension,
  ReportStoreExtension,
  // Test Runner (dev-only, macro-based integration tests)
  ...(import.meta.env.DEV ? [TestRunnerExtension] : []),
];

/**
 * Get all built-in extension IDs.
 */
export function getBuiltInExtensionIds(): string[] {
  return builtInExtensions.map((ext) => ext.manifest.id);
}