//! FILENAME: app/src/api/cellEditors.ts
// PURPOSE: Custom cell editor registration API for extensions.
// CONTEXT: Extensions can register alternative editors for specific cells
//          (e.g., date picker, dropdown, color picker). When editing starts,
//          the system checks registered editors in priority order. If one
//          matches, it is used instead of the default InlineEditor.

import React from "react";

// ============================================================================
// Types
// ============================================================================

/** Context passed to the cell editor predicate and component */
export interface CellEditorContext {
  /** Row index of the cell being edited */
  row: number;
  /** Column index of the cell being edited */
  col: number;
  /** Active sheet index */
  sheetIndex: number;
  /** Current cell value (as string) */
  value: string;
  /** The pixel bounds of the cell for positioning */
  cellBounds: { x: number; y: number; width: number; height: number };
}

/** Props passed to custom cell editor components */
export interface CellEditorProps {
  /** Context about the cell being edited */
  context: CellEditorContext;
  /** Current value */
  value: string;
  /** Callback to update the value being edited */
  onValueChange: (value: string) => void;
  /** Callback to commit the edit and close the editor */
  onCommit: (value: string) => void;
  /** Callback to cancel the edit */
  onCancel: () => void;
}

/** A registered custom cell editor */
export interface CellEditorRegistration {
  /** Unique identifier for this editor */
  id: string;
  /** Predicate: return true if this editor should handle the given cell */
  canEdit: (context: CellEditorContext) => boolean;
  /** The React component to render as the editor */
  component: React.ComponentType<CellEditorProps>;
  /** Priority (higher = checked first). Default: 0 */
  priority: number;
}

/** Contract for the cell editor API on ExtensionContext */
export interface ICellEditorAPI {
  /** Register a custom cell editor */
  register(
    id: string,
    canEdit: (context: CellEditorContext) => boolean,
    component: React.ComponentType<CellEditorProps>,
    priority?: number,
  ): () => void;
}

// ============================================================================
// State
// ============================================================================

const editors: CellEditorRegistration[] = [];
type ChangeListener = () => void;
const listeners: Set<ChangeListener> = new Set();

// ============================================================================
// Public API
// ============================================================================

/**
 * Register a custom cell editor.
 *
 * @param id Unique identifier for this editor
 * @param canEdit Predicate that determines if this editor handles a given cell
 * @param component React component to render as the editor
 * @param priority Higher priority editors are checked first (default: 0)
 * @returns Cleanup function to unregister the editor
 *
 * @example
 * ```ts
 * const unreg = registerCellEditor(
 *   "date-picker",
 *   (ctx) => isDateCell(ctx.row, ctx.col),
 *   DatePickerEditor,
 *   10
 * );
 * ```
 */
export function registerCellEditor(
  id: string,
  canEdit: (context: CellEditorContext) => boolean,
  component: React.ComponentType<CellEditorProps>,
  priority = 0,
): () => void {
  const registration: CellEditorRegistration = { id, canEdit, component, priority };
  editors.push(registration);
  // Keep sorted by priority (highest first)
  editors.sort((a, b) => b.priority - a.priority);
  notifyChanged();

  return () => {
    const idx = editors.indexOf(registration);
    if (idx >= 0) {
      editors.splice(idx, 1);
      notifyChanged();
    }
  };
}

/**
 * Find the custom editor that should handle a given cell, if any.
 * Called by the editing system when a cell enters edit mode.
 *
 * @returns The matching editor registration, or null to use the default InlineEditor
 */
export function findCellEditor(
  context: CellEditorContext
): CellEditorRegistration | null {
  for (const editor of editors) {
    if (editor.canEdit(context)) {
      return editor;
    }
  }
  return null;
}

/**
 * Check if any custom cell editors are registered.
 */
export function hasCellEditors(): boolean {
  return editors.length > 0;
}

/**
 * Subscribe to editor registry changes.
 */
export function subscribeToCellEditors(callback: ChangeListener): () => void {
  listeners.add(callback);
  return () => listeners.delete(callback);
}

function notifyChanged(): void {
  listeners.forEach((cb) => {
    try {
      cb();
    } catch (e) {
      console.error("[CellEditors] Error in change listener:", e);
    }
  });
}
