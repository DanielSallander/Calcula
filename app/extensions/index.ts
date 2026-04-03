//! FILENAME: app/extensions/index.ts
// PURPOSE: Legacy extension loader - kept for backward compatibility.
// CONTEXT: All extensions have been migrated to the manifest-based ExtensionModule pattern.
//          loadExtensions/unloadExtensions are now no-ops.
//          All loading is handled by ExtensionManager.initialize() via manifest.ts.

/**
 * Load extensions (no-op: all extensions now loaded via ExtensionManager).
 */
export function loadExtensions(): void {
  // All extensions migrated to manifest.ts — loaded by ExtensionManager.initialize()
}

/**
 * Unload extensions (no-op: all extensions now managed by ExtensionManager).
 */
export function unloadExtensions(): void {
  // All extensions migrated to manifest.ts — managed by ExtensionManager
}
