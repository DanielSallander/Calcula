//! FILENAME: app/extensions/index.ts
// PURPOSE: Extension loader - loads all extensions during application initialization.
// CONTEXT: Called from main.tsx to register all extensions before rendering.

import { registerPivotExtension, unregisterPivotExtension } from "./Pivot";
import { registerTableExtension, unregisterTableExtension } from "./Table";
import { registerChartExtension, unregisterChartExtension } from "./Charts";
import { registerAutoFilterExtension, unregisterAutoFilterExtension } from "./AutoFilter";
import { registerGroupingExtension, unregisterGroupingExtension } from "./Grouping";

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
