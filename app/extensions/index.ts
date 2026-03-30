//! FILENAME: app/extensions/index.ts
// PURPOSE: Extension loader - loads all extensions during application initialization.
// CONTEXT: Called from main.tsx to register all extensions before rendering.

import { registerPivotExtension, unregisterPivotExtension } from "./Pivot";
import { registerTableExtension, unregisterTableExtension } from "./Table";
import { registerChartExtension, unregisterChartExtension } from "./Charts";
import { registerAutoFilterExtension, unregisterAutoFilterExtension } from "./AutoFilter";
import { registerGroupingExtension, unregisterGroupingExtension } from "./Grouping";
import { registerRemoveDuplicatesExtension, unregisterRemoveDuplicatesExtension } from "./RemoveDuplicates";
import { registerTextToColumnsExtension, unregisterTextToColumnsExtension } from "./TextToColumns";
import { registerDataValidationExtension, unregisterDataValidationExtension } from "./DataValidation";
import { registerConditionalFormattingExtension, unregisterConditionalFormattingExtension } from "./ConditionalFormatting";
import { registerGoalSeekExtension, unregisterGoalSeekExtension } from "./GoalSeek";
import { registerProtectionExtension, unregisterProtectionExtension } from "./Protection";
import { registerTracingExtension, unregisterTracingExtension } from "./Tracing";
import { registerDefinedNamesExtension, unregisterDefinedNamesExtension } from "./DefinedNames";
import { registerEvaluateFormulaExtension, unregisterEvaluateFormulaExtension } from "./EvaluateFormula";
import { registerFormulaVisualizerExtension, unregisterFormulaVisualizerExtension } from "./FormulaVisualizer";
import { registerConsolidateExtension, unregisterConsolidateExtension } from "./Consolidate";
import { registerSortingExtension, unregisterSortingExtension } from "./Sorting";
import { registerCheckboxExtension, unregisterCheckboxExtension } from "./Checkbox";
import { registerSparklineExtension, unregisterSparklineExtension } from "./Sparklines";
import { registerReviewExtension, unregisterReviewExtension } from "./Review";
import { registerCalculationOptionsExtension, unregisterCalculationOptionsExtension } from "./CalculationOptions";
import { registerScriptEditorExtension, unregisterScriptEditorExtension } from "./ScriptEditor";
import { registerControlsExtension, unregisterControlsExtension } from "./Controls";
import { registerBiExtension, unregisterBiExtension } from "./BusinessIntelligence";
import { registerPrintExtension, unregisterPrintExtension } from "./Print";
import { registerAIChatExtension, unregisterAIChatExtension } from "./AIChat";
import { registerFileExplorerExtension, unregisterFileExplorerExtension } from "./FileExplorer";
import { registerSearchExtension, unregisterSearchExtension } from "./Search";
import { registerExtensionsManagerExtension, unregisterExtensionsManagerExtension } from "./ExtensionsManager";
import { registerSettingsExtension, unregisterSettingsExtension } from "./Settings";
import { registerReportStoreExtension, unregisterReportStoreExtension } from "./ReportStore";
import { registerSlicerExtension, unregisterSlicerExtension } from "./Slicer";
import { registerFlashFillExtension, unregisterFlashFillExtension } from "./FlashFill";
import { registerAdvancedFilterExtension, unregisterAdvancedFilterExtension } from "./AdvancedFilter";
import { registerSubtotalsExtension, unregisterSubtotalsExtension } from "./Subtotals";
import { registerCustomFillListsExtension, unregisterCustomFillListsExtension } from "./CustomFillLists";
import { registerGoToSpecialExtension, unregisterGoToSpecialExtension } from "./GoToSpecial";

/**
 * Load all extensions.
 * Called once during application initialization.
 */
export function loadExtensions(): void {
  console.log("[Extensions] Loading extensions...");

  // Load built-in extensions
  // Note: StandardMenus and FindReplace are now loaded via ExtensionManager
  registerPivotExtension();
  registerTableExtension();
  registerChartExtension();
  registerSlicerExtension();
  registerAutoFilterExtension();
  registerSortingExtension();
  registerGroupingExtension();
  registerRemoveDuplicatesExtension();
  registerTextToColumnsExtension();
  registerDataValidationExtension();
  registerConditionalFormattingExtension();
  registerGoalSeekExtension();
  registerProtectionExtension();
  registerTracingExtension();
  registerDefinedNamesExtension();
  registerEvaluateFormulaExtension();
  registerFormulaVisualizerExtension();
  registerCalculationOptionsExtension();
  registerConsolidateExtension();
  registerFlashFillExtension();
  registerAdvancedFilterExtension();
  registerSubtotalsExtension();
  registerCustomFillListsExtension();
  registerGoToSpecialExtension();
  registerCheckboxExtension();
  registerSparklineExtension();
  registerReviewExtension();
  registerScriptEditorExtension();
  registerControlsExtension();
  registerBiExtension();
  registerPrintExtension();
  registerAIChatExtension();
  registerReportStoreExtension();

  // Activity Bar views
  registerFileExplorerExtension();
  registerSearchExtension();
  registerExtensionsManagerExtension();
  registerSettingsExtension();

  // Future: Load user extensions from config

  console.log("[Extensions] All extensions loaded");
}

/**
 * Unload all extensions.
 * Called during application shutdown or hot reload.
 */
export function unloadExtensions(): void {
  console.log("[Extensions] Unloading extensions...");

  // Unload in reverse order
  unregisterSettingsExtension();
  unregisterExtensionsManagerExtension();
  unregisterSearchExtension();
  unregisterFileExplorerExtension();
  unregisterReportStoreExtension();
  unregisterAIChatExtension();
  unregisterPrintExtension();
  unregisterBiExtension();
  unregisterControlsExtension();
  unregisterScriptEditorExtension();
  unregisterReviewExtension();
  unregisterSparklineExtension();
  unregisterCheckboxExtension();
  unregisterSubtotalsExtension();
  unregisterGoToSpecialExtension();
  unregisterCustomFillListsExtension();
  unregisterAdvancedFilterExtension();
  unregisterFlashFillExtension();
  unregisterConsolidateExtension();
  unregisterCalculationOptionsExtension();
  unregisterFormulaVisualizerExtension();
  unregisterEvaluateFormulaExtension();
  unregisterDefinedNamesExtension();
  unregisterTracingExtension();
  unregisterProtectionExtension();
  unregisterGoalSeekExtension();
  unregisterConditionalFormattingExtension();
  unregisterDataValidationExtension();
  unregisterTextToColumnsExtension();
  unregisterRemoveDuplicatesExtension();
  unregisterGroupingExtension();
  unregisterSortingExtension();
  unregisterAutoFilterExtension();
  unregisterSlicerExtension();
  unregisterChartExtension();
  unregisterTableExtension();
  unregisterPivotExtension();

  console.log("[Extensions] All extensions unloaded");
}

// Re-export individual extension registration functions for granular control
export { registerPivotExtension, unregisterPivotExtension };
export { registerTableExtension, unregisterTableExtension };
export { registerChartExtension, unregisterChartExtension };
export { registerAutoFilterExtension, unregisterAutoFilterExtension };
export { registerGroupingExtension, unregisterGroupingExtension };
export { registerRemoveDuplicatesExtension, unregisterRemoveDuplicatesExtension };
export { registerTextToColumnsExtension, unregisterTextToColumnsExtension };
export { registerDataValidationExtension, unregisterDataValidationExtension };
export { registerConditionalFormattingExtension, unregisterConditionalFormattingExtension };
export { registerGoalSeekExtension, unregisterGoalSeekExtension };
export { registerProtectionExtension, unregisterProtectionExtension };
export { registerTracingExtension, unregisterTracingExtension };
export { registerDefinedNamesExtension, unregisterDefinedNamesExtension };
export { registerEvaluateFormulaExtension, unregisterEvaluateFormulaExtension };
export { registerFormulaVisualizerExtension, unregisterFormulaVisualizerExtension };
export { registerConsolidateExtension, unregisterConsolidateExtension };
export { registerSortingExtension, unregisterSortingExtension };
export { registerCheckboxExtension, unregisterCheckboxExtension };
export { registerSparklineExtension, unregisterSparklineExtension };
export { registerReviewExtension, unregisterReviewExtension };
export { registerCalculationOptionsExtension, unregisterCalculationOptionsExtension };
export { registerScriptEditorExtension, unregisterScriptEditorExtension };
export { registerControlsExtension, unregisterControlsExtension };
export { registerBiExtension, unregisterBiExtension };
export { registerPrintExtension, unregisterPrintExtension };
export { registerAIChatExtension, unregisterAIChatExtension };
export { registerFileExplorerExtension, unregisterFileExplorerExtension };
export { registerSearchExtension, unregisterSearchExtension };
export { registerExtensionsManagerExtension, unregisterExtensionsManagerExtension };
export { registerSettingsExtension, unregisterSettingsExtension };
export { registerReportStoreExtension, unregisterReportStoreExtension };
export { registerSlicerExtension, unregisterSlicerExtension };
export { registerFlashFillExtension, unregisterFlashFillExtension };
export { registerAdvancedFilterExtension, unregisterAdvancedFilterExtension };
export { registerSubtotalsExtension, unregisterSubtotalsExtension };
export { registerCustomFillListsExtension, unregisterCustomFillListsExtension };
export { registerGoToSpecialExtension, unregisterGoToSpecialExtension };
