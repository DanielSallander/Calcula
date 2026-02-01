//! FILENAME: app/src/shell/registries/dialogExtensions.ts
// PURPOSE: Registry for dialogs (modals) that extensions can register.
// CONTEXT: Allows extensions to contribute modal dialogs without shell hardcoding.
// NOTE: Moved from core/registry to shell/registries per microkernel architecture.

// Type definitions are canonical in api/uiTypes.ts (the API contract layer).
import type { DialogDefinition, DialogProps } from "../../api/uiTypes";
export type { DialogDefinition, DialogProps };

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
 * Extensions use this to register modal dialogs.
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
    const definition = registry.dialogs.get(dialogId);
    if (definition) {
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
      registry.dialogStates.set(dialogId, { isOpen: false });
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
   * Get all open dialogs with their state.
   */
  getOpenDialogs(): Array<{ definition: DialogDefinition; state: DialogState }> {
    const open: Array<{ definition: DialogDefinition; state: DialogState }> = [];

    for (const [id, definition] of registry.dialogs) {
      const state = registry.dialogStates.get(id);
      if (state?.isOpen) {
        open.push({ definition, state });
      }
    }

    // Sort by priority (higher = on top)
    return open.sort(
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