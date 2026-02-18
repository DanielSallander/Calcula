//! FILENAME: app/src/core/lib/cellEvents.ts
// PURPOSE: Event emitter for cell change notifications.
// CONTEXT: Phase 4.3 introduces a cell event system to decouple components
// that need to respond to cell changes. This enables the canvas to refresh
// when cells change without tight coupling between editing and rendering.

import type { CellChangeEvent } from "../types";
import { AppEvents, emitAppEvent } from "./events";

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
   * Also schedules a debounced CELLS_UPDATED app event so extensions
   * (e.g. Charts) can react to data changes.
   * @param event - The cell change event
   */
  emit(event: CellChangeEvent): void {
    this.listeners.forEach((listener) => {
      try {
        listener(event);
      } catch (error) {
        console.error("Error in cell change listener:", error);
      }
    });

    // Debounce CELLS_UPDATED via requestAnimationFrame so bulk operations
    // (paste, undo, fill) coalesce into a single event per frame.
    if (!this.cellsUpdatedPending) {
      this.cellsUpdatedPending = true;
      requestAnimationFrame(() => {
        this.cellsUpdatedPending = false;
        emitAppEvent(AppEvents.CELLS_UPDATED);
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