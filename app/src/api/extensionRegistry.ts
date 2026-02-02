//! FILENAME: app/src/api/extensionRegistry.ts
// PURPOSE: Registry for extension-related notifications (e.g., selection changes).
// CONTEXT: Allows extensions to react to grid events without coupling to React state.

import type { Selection } from "../core/types";

// ============================================================================
// Types
// ============================================================================

type SelectionChangeCallback = (selection: Selection | null) => void;

// ============================================================================
// Extension Registry Implementation
// ============================================================================

class ExtensionRegistryImpl {
  private selectionChangeCallbacks: Set<SelectionChangeCallback> = new Set();

  /**
   * Register a callback to be notified when the grid selection changes.
   * @param callback The callback to invoke
   * @returns Unsubscribe function
   */
  onSelectionChange(callback: SelectionChangeCallback): () => void {
    this.selectionChangeCallbacks.add(callback);
    return () => {
      this.selectionChangeCallbacks.delete(callback);
    };
  }

  /**
   * Notify all registered callbacks of a selection change.
   * Called by the Shell when grid selection updates.
   * @param selection The new selection (or null)
   */
  notifySelectionChange(selection: Selection | null): void {
    this.selectionChangeCallbacks.forEach((cb) => {
      try {
        cb(selection);
      } catch (error) {
        console.error("[ExtensionRegistry] Error in selection change callback:", error);
      }
    });
  }

  /**
   * Clear all registered callbacks (for testing).
   */
  clear(): void {
    this.selectionChangeCallbacks.clear();
  }
}

// ============================================================================
// Singleton Export
// ============================================================================

export const ExtensionRegistry = new ExtensionRegistryImpl();