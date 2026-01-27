//! FILENAME: app/src/core/extensions/taskPaneExtensions.ts
// PURPOSE: Extension registry for Task Pane views
// CONTEXT: Allows Core and Add-ins to register pane views that appear in the Task Pane

import React from "react";

/**
 * Context keys for conditional pane visibility.
 * Panes can specify which contexts they should appear in.
 */
export type TaskPaneContextKey =
  | "pivot"           // Selection is within a pivot table
  | "chart"           // Selection is within a chart
  | "comment"         // Cell has a comment
  | "formatting"      // Formatting pane requested
  | "properties"      // Generic properties pane
  | "always";         // Always available

/**
 * Definition of a Task Pane view that can be registered.
 */
export interface TaskPaneViewDefinition {
  /** Unique identifier for this pane view */
  id: string;
  /** Display title shown in the tab/header */
  title: string;
  /** Icon to display (React element or string) */
  icon?: React.ReactNode;
  /** The component to render as pane content */
  component: React.ComponentType<TaskPaneViewProps>;
  /** Context keys that trigger this pane to become available */
  contextKeys: TaskPaneContextKey[];
  /** Priority for ordering (higher = shown first in tabs) */
  priority?: number;
  /** Whether this pane can be closed by the user */
  closable?: boolean;
}

/**
 * Props passed to Task Pane view components.
 */
export interface TaskPaneViewProps {
  /** Callback to close this pane */
  onClose?: () => void;
  /** Callback when the pane updates its content (e.g., pivot fields changed) */
  onUpdate?: () => void;
  /** Any additional data passed to the pane */
  data?: Record<string, unknown>;
}

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