//! FILENAME: app/src/shell/registries/activityBarExtensions.ts
// PURPOSE: Extension registry for Activity Bar views
// CONTEXT: Allows extensions to register views that appear in the Activity Bar side panel

import type { ActivityViewDefinition } from "../../api/uiTypes";
export type { ActivityViewDefinition };

/**
 * Internal registry storage.
 */
interface ActivityBarRegistry {
  views: Map<string, ActivityViewDefinition>;
  listeners: Set<() => void>;
}

const registry: ActivityBarRegistry = {
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
 * Activity Bar Extension Registry.
 * Provides API for registering and managing activity views.
 */
export const ActivityBarExtensions = {
  /**
   * Register a new activity view.
   */
  registerView(definition: ActivityViewDefinition): void {
    if (registry.views.has(definition.id)) {
      console.warn(`[ActivityBar] View "${definition.id}" already registered, replacing`);
    }
    registry.views.set(definition.id, {
      ...definition,
      priority: definition.priority ?? 0,
      bottom: definition.bottom ?? false,
    });
    console.log(`[ActivityBar] Registered view: ${definition.id}`);
    notifyListeners();
  },

  /**
   * Unregister an activity view.
   */
  unregisterView(viewId: string): void {
    if (registry.views.delete(viewId)) {
      console.log(`[ActivityBar] Unregistered view: ${viewId}`);
      notifyListeners();
    }
  },

  /**
   * Get a registered view by ID.
   */
  getView(viewId: string): ActivityViewDefinition | undefined {
    return registry.views.get(viewId);
  },

  /**
   * Get all registered views, sorted by priority (higher first).
   */
  getAllViews(): ActivityViewDefinition[] {
    return Array.from(registry.views.values()).sort(
      (a, b) => (b.priority ?? 0) - (a.priority ?? 0)
    );
  },

  /**
   * Get views for the top section (bottom !== true).
   */
  getTopViews(): ActivityViewDefinition[] {
    return this.getAllViews().filter((v) => !v.bottom);
  },

  /**
   * Get views for the bottom section (bottom === true).
   */
  getBottomViews(): ActivityViewDefinition[] {
    return this.getAllViews().filter((v) => v.bottom);
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
   * Clear all registered views.
   */
  clear(): void {
    registry.views.clear();
    notifyListeners();
  },
};
