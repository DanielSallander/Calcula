//! FILENAME: app/src/core/hooks/useCellEvents.ts
// PURPOSE: React hook for subscribing to cell change events.
// CONTEXT: Phase 4.3 introduces this hook to allow components to react
// to cell changes without tight coupling. Components like GridCanvas
// can use this to refresh when any cell changes.

import { useEffect, useRef } from "react";
import { cellEvents } from "../lib/cellEvents";
import type { CellChangeListener } from "../lib/cellEvents";
import type { CellChangeEvent } from "../types";

/**
 * Hook to subscribe to cell change events.
 * The callback is called whenever any cell changes.
 *
 * @param callback - Function to call when a cell changes
 * @param deps - Dependencies array (callback will be re-subscribed when deps change)
 */
export function useCellEvents(
  callback: CellChangeListener,
  deps: React.DependencyList = []
): void {
  const callbackRef = useRef(callback);
  
  // Keep callback ref up to date
  useEffect(() => {
    callbackRef.current = callback;
  }, [callback]);

  useEffect(() => {
    const listener = (event: CellChangeEvent) => {
      callbackRef.current(event);
    };
    
    const unsubscribe = cellEvents.subscribe(listener);
    return unsubscribe;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
}

/**
 * Hook to subscribe to changes for a specific cell.
 *
 * @param row - Row index to watch
 * @param col - Column index to watch
 * @param callback - Function to call when the cell changes
 */
export function useCellChange(
  row: number,
  col: number,
  callback: (event: CellChangeEvent) => void
): void {
  useCellEvents(
    (event) => {
      if (event.row === row && event.col === col) {
        callback(event);
      }
    },
    [row, col, callback]
  );
}