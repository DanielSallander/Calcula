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
import { registerConsolidateExtension, unregisterConsolidateExtension } from "./Consolidate";

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
  registerAutoFilterExtension();
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
  registerConsolidateExtension();

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
  unregisterConsolidateExtension();
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
  unregisterAutoFilterExtension();
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
export { registerConsolidateExtension, unregisterConsolidateExtension };
