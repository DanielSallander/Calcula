//! FILENAME: app/src/core/lib/cellEvents.ts
// PURPOSE: Event emitter for cell change notifications.
// CONTEXT: Phase 4.3 introduces a cell event system to decouple components
// that need to respond to cell changes. This enables the canvas to refresh
// when cells change without tight coupling between editing and rendering.

import type { CellChangeEvent, CellData } from "../types";
import { AppEvents, emitAppEvent } from "./events";

import type { CellValueChange, CellValuesChangedPayload } from "../../api/events";

/**
 * Source of a cell value change, used in the CELL_VALUES_CHANGED payload.
 */
export type CellChangeSource = CellValuesChangedPayload["source"];

/**
 * Map a backend CellData (the shape returned by fill/edit/paste ops) to a
 * CellChangeEvent for emit/emitBatch. Carries the cell's `sheetIndex` THROUGH
 * (undefined = active sheet) so cross-sheet edits stay tagged with their own
 * sheet — sheet-aware consumers (renderCache, chart invalidation, script hooks)
 * then attribute them correctly instead of the previous active-sheet-only filter
 * which silently dropped off-sheet cells.
 */
export function cellToChange(c: CellData): CellChangeEvent {
  return {
    row: c.row,
    col: c.col,
    sheetIndex: c.sheetIndex,
    newValue: c.display,
    formula: c.formula,
  };
}

/**
 * Callback type for cell change listeners.
 */
export type CellChangeListener = (event: CellChangeEvent) => void;

/**
 * Simple event emitter for cell changes.
 * Allows components to subscribe to cell updates without direct coupling.
 */
class CellEventEmitter {
  private listeners: Set<CellChangeListener> = new Set();
  private cellsUpdatedPending = false;

  /**
   * Accumulated changes for the current debounce window.
   * Flushed alongside CELLS_UPDATED via requestAnimationFrame.
   */
  private pendingChanges: CellValueChange[] = [];
  private pendingSource: CellChangeSource = "user";

  /**
   * Subscribe to cell change events.
   * @param listener - Callback function to invoke on cell changes
   * @returns Unsubscribe function
   */
  subscribe(listener: CellChangeListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /**
   * Emit a cell change event to all listeners.
   * Also schedules a debounced CELLS_UPDATED and CELL_VALUES_CHANGED app event
   * so extensions can react to data changes.
   * @param event - The cell change event
   * @param source - What triggered the change (default: "user")
   */
  emit(event: CellChangeEvent, source: CellChangeSource = "user"): void {
    this.listeners.forEach((listener) => {
      try {
        listener(event);
      } catch (error) {
        console.error("Error in cell change listener:", error);
      }
    });

    this.accumulateChange(event, source);
    this.scheduleCellsUpdated();
  }

  /**
   * Emit a batch of cell change events efficiently.
   * Listeners are called ONCE with the last event (for selection tracking),
   * while CELLS_UPDATED and CELL_VALUES_CHANGED fire once for all extensions.
   * Use this for bulk operations (fill, paste) instead of calling emit() per cell.
   * @param events - Array of cell change events
   * @param source - What triggered the changes (default: "user")
   */
  emitBatch(events: CellChangeEvent[], source: CellChangeSource = "user"): void {
    if (events.length === 0) return;

    // Notify listeners once with a summary — listeners that care about
    // individual cells (like useSpreadsheetSelection) only need the last event
    // to update the active cell display.  Listeners that just invalidate caches
    // (like ConditionalFormatting) only need one call.
    const lastEvent = events[events.length - 1];
    this.listeners.forEach((listener) => {
      try {
        listener(lastEvent);
      } catch (error) {
        console.error("Error in cell change listener:", error);
      }
    });

    for (const event of events) {
      this.accumulateChange(event, source);
    }
    this.scheduleCellsUpdated();
  }

  /**
   * Accumulate a change into the pending buffer for CELL_VALUES_CHANGED.
   */
  private accumulateChange(event: CellChangeEvent, source: CellChangeSource): void {
    this.pendingChanges.push({
      row: event.row,
      col: event.col,
      sheetIndex: event.sheetIndex,
      oldValue: event.oldValue,
      newValue: event.newValue,
      formula: event.formula,
    });
    // The source of the last operation wins for the batch.
    this.pendingSource = source;
  }

  /**
   * Schedule a debounced CELLS_UPDATED app event via requestAnimationFrame.
   * Also flushes accumulated changes as a CELL_VALUES_CHANGED event.
   */
  private scheduleCellsUpdated(): void {
    // Debounce CELLS_UPDATED via requestAnimationFrame so bulk operations
    // (paste, undo, fill) coalesce into a single event per frame.
    if (!this.cellsUpdatedPending) {
      this.cellsUpdatedPending = true;
      requestAnimationFrame(() => {
        this.cellsUpdatedPending = false;

        // Flush accumulated changes as CELL_VALUES_CHANGED.
        const changes = this.pendingChanges;
        if (changes.length > 0) {
          const payload: CellValuesChangedPayload = {
            changes,
            source: this.pendingSource,
          };
          this.pendingChanges = [];
          this.pendingSource = "user";
          emitAppEvent(AppEvents.CELL_VALUES_CHANGED, payload);
        }

        // CELLS_UPDATED stays a fire-on-every-change signal, but carries the same
        // changes when known so subscribers can scope their work (else bare).
        emitAppEvent(AppEvents.CELLS_UPDATED, changes.length > 0 ? { changes } : undefined);
      });
    }
  }

  /**
   * Get the current number of listeners.
   */
  get listenerCount(): number {
    return this.listeners.size;
  }

  /**
   * Remove all listeners.
   */
  clear(): void {
    this.listeners.clear();
  }
}

/**
 * Global cell event emitter instance.
 * Components can import this to subscribe to or emit cell changes.
 */
export const cellEvents = new CellEventEmitter();
