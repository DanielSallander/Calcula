// FILENAME: addins/index.ts
// PURPOSE: Add-in loader
// CONTEXT: Registers all enabled add-ins with the ExtensionRegistry

import { ExtensionRegistry } from "../core/extensions";

/**
 * Load and register all enabled add-ins.
 * 
 * Add-ins in the _disabled folder are not loaded.
 * To enable an add-in, move it out of _disabled and import it here.
 */
export function loadAddIns(): void {
  console.log("[AddIns] Loading add-ins...");

  // =========================================================================
  // ENABLED ADD-INS
  // =========================================================================
  
  // Currently no add-ins are enabled.
  // The core is being developed with minimal UI.
  
  // Example of how to enable an add-in:
  // import { FormattingAddIn } from "./formatting";
  // ExtensionRegistry.registerAddIn(FormattingAddIn.manifest);

  // =========================================================================
  // STATUS REPORT
  // =========================================================================
  
  const addins = ExtensionRegistry.getRegisteredAddIns();
  const tabs = ExtensionRegistry.getRibbonTabs();
  
  console.log(`[AddIns] Loaded ${addins.length} add-in(s)`);
  console.log(`[AddIns] Registered ${tabs.length} ribbon tab(s)`);
  
  if (addins.length === 0) {
    console.log("[AddIns] No add-ins enabled. Ribbon will be empty.");
    console.log("[AddIns] This is expected during core development.");
  }
}