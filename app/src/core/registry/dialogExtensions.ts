//! FILENAME: app/src/core/registry/dialogExtensions.ts
// PURPOSE: Registry for dialogs that extensions can register.
// CONTEXT: Allows extensions to contribute modal dialogs without shell hardcoding.

// Type definitions are canonical in api/uiTypes.ts (the API contract layer).
import type { DialogProps, DialogDefinition } from "../../api/uiTypes";
export type { DialogProps, DialogDefinition };

interface DialogState {
  isOpen: boolean;
  data?: Record<string, unknown>;
}

interface DialogRegistry {
  dialogs: Map<string, DialogDefinition>;
  dialogStates: Map<string, DialogState>;
  listeners: Set<() => void>;
}

const registry: DialogRegistry = {
  dialogs: new Map(),
  dialogStates: new Map(),
  listeners: new Set(),
};

function notifyListeners(): void {
  registry.listeners.forEach((listener) => listener());
}

/**
 * Dialog Extensions API.
 * Extensions use this to register dialogs that can be opened programmatically.
 */
export const DialogExtensions = {
  /**
   * Register a dialog definition.
   * @param definition - The dialog to register
   */
  registerDialog(definition: DialogDefinition): void {
    registry.dialogs.set(definition.id, definition);
    registry.dialogStates.set(definition.id, { isOpen: false });
    notifyListeners();
  },

  /**
   * Unregister a dialog.
   * @param dialogId - The dialog ID to unregister
   */
  unregisterDialog(dialogId: string): void {
    registry.dialogs.delete(dialogId);
    registry.dialogStates.delete(dialogId);
    notifyListeners();
  },

  /**
   * Open a dialog by ID.
   * @param dialogId - The dialog ID to open
   * @param data - Optional data to pass to the dialog
   */
  openDialog(dialogId: string, data?: Record<string, unknown>): void {
    const state = registry.dialogStates.get(dialogId);
    if (state) {
      registry.dialogStates.set(dialogId, { isOpen: true, data });
      notifyListeners();
    } else {
      console.warn(`[DialogExtensions] Dialog not found: ${dialogId}`);
    }
  },

  /**
   * Close a dialog by ID.
   * @param dialogId - The dialog ID to close
   */
  closeDialog(dialogId: string): void {
    const state = registry.dialogStates.get(dialogId);
    if (state) {
      registry.dialogStates.set(dialogId, { isOpen: false, data: state.data });
      notifyListeners();
    }
  },

  /**
   * Get a dialog definition by ID.
   * @param dialogId - The dialog ID to get
   */
  getDialog(dialogId: string): DialogDefinition | undefined {
    return registry.dialogs.get(dialogId);
  },

  /**
   * Get all active (open) dialogs with their state.
   */
  getActiveDialogs(): Array<{
    definition: DialogDefinition;
    state: DialogState;
  }> {
    const active: Array<{ definition: DialogDefinition; state: DialogState }> = [];

    for (const [id, definition] of registry.dialogs) {
      const state = registry.dialogStates.get(id);
      if (state?.isOpen) {
        active.push({ definition, state });
      }
    }

    // Sort by priority (higher priority = later in array = on top)
    return active.sort(
      (a, b) => (a.definition.priority ?? 0) - (b.definition.priority ?? 0)
    );
  },

  /**
   * Get all registered dialogs (for debugging).
   */
  getAllDialogs(): DialogDefinition[] {
    return Array.from(registry.dialogs.values());
  },

  /**
   * Subscribe to registry changes.
   * @param listener - Callback when dialogs change
   * @returns Cleanup function
   */
  onChange(listener: () => void): () => void {
    registry.listeners.add(listener);
    return () => registry.listeners.delete(listener);
  },
};
