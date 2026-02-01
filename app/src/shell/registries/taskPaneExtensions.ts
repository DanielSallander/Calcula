//! FILENAME: app/src/shell/registries/taskPaneExtensions.ts
// PURPOSE: Extension registry for Task Pane views
// CONTEXT: Allows Shell and Add-ins to register pane views that appear in the Task Pane
// NOTE: Moved from core/registry to shell/registries per microkernel architecture.

// Type definitions are canonical in api/uiTypes.ts (the API contract layer).
import type { TaskPaneContextKey, TaskPaneViewDefinition, TaskPaneViewProps } from "../../api/uiTypes";
export type { TaskPaneContextKey, TaskPaneViewDefinition, TaskPaneViewProps };

/**
 * Internal registry storage.
 */
interface TaskPaneRegistry {
  views: Map<string, TaskPaneViewDefinition>;
  listeners: Set<() => void>;
}

const registry: TaskPaneRegistry = {
  views: new Map(),
  listeners: new Set(),
};

/**
 * Notify all listeners that the registry has changed.
 */
function notifyListeners(): void {
  registry.listeners.forEach((listener) => listener());
}

/**
 * Task Pane Extension Registry.
 * Provides API for registering and managing task pane views.
 */
export const TaskPaneExtensions = {
  /**
   * Register a new task pane view.
   */
  registerView(definition: TaskPaneViewDefinition): void {
    if (registry.views.has(definition.id)) {
      console.warn(
        `[TaskPane] View "${definition.id}" already registered, replacing`
      );
    }
    registry.views.set(definition.id, {
      ...definition,
      priority: definition.priority ?? 0,
      closable: definition.closable ?? true,
    });
    console.log(`[TaskPane] Registered view: ${definition.id}`);
    notifyListeners();
  },

  /**
   * Unregister a task pane view.
   */
  unregisterView(viewId: string): void {
    if (registry.views.delete(viewId)) {
      console.log(`[TaskPane] Unregistered view: ${viewId}`);
      notifyListeners();
    }
  },

  /**
   * Get a registered view by ID.
   */
  getView(viewId: string): TaskPaneViewDefinition | undefined {
    return registry.views.get(viewId);
  },

  /**
   * Get all registered views.
   */
  getAllViews(): TaskPaneViewDefinition[] {
    return Array.from(registry.views.values()).sort(
      (a, b) => (b.priority ?? 0) - (a.priority ?? 0)
    );
  },

  /**
   * Get views that match the given context keys.
   */
  getViewsForContext(
    activeContextKeys: TaskPaneContextKey[]
  ): TaskPaneViewDefinition[] {
    return this.getAllViews().filter((view) =>
      view.contextKeys.some(
        (key) => key === "always" || activeContextKeys.includes(key)
      )
    );
  },

  /**
   * Subscribe to registry changes.
   * Returns an unsubscribe function.
   */
  onRegistryChange(listener: () => void): () => void {
    registry.listeners.add(listener);
    return () => {
      registry.listeners.delete(listener);
    };
  },

  /**
   * Clear all registered views (useful for testing).
   */
  clear(): void {
    registry.views.clear();
    notifyListeners();
  },
};