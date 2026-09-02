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
      // A SHOW IS AN EVENT, and the component has to be able to see it.
      //
      // `DialogContainer` keys by dialog id, so re-showing a dialog that is
      // already open updates its props WITHOUT remounting — every `useState`
      // keeps whatever it held. Measured consequences, all of them silent:
      // a reset dialog re-shown for a DIFFERENT application kept the first
      // one's unticked cells and reported "keeping 3 cells" over a list where
      // everything was ticked; a Publish dialog re-opened from a sheet tab
      // after a successful push kept `pushed = true`, leaving the primary
      // action permanently disabled with a stale success message and no
      // explanation.
      //
      // A monotonic counter is the smallest thing that makes the event
      // observable: a component depends on `data.__openCount` and resets what
      // a fresh open should reset. `data` alone will not do — a caller that
      // passes none leaves the reference unchanged, and one that passes an
      // equal literal is indistinguishable from no show at all.
      const previous = registry.dialogStates.get(dialogId);
      const openCount = ((previous?.data?.__openCount as number | undefined) ?? 0) + 1;
      registry.dialogStates.set(dialogId, {
        isOpen: true,
        data: { ...(data ?? {}), __openCount: openCount },
      });
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