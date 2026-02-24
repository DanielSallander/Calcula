//! FILENAME: app/extensions/BuiltIn/StatusBarAggregation/useSelectionAggregation.ts
// PURPOSE: Hook that computes aggregations for the current selection.
// CONTEXT: Subscribes to selection changes and CELLS_UPDATED events,
//          debounces, and calls the Rust backend for computation.
//          Includes a circuit breaker to gracefully handle missing backend commands.

import { useState, useEffect, useRef, useCallback } from "react";
import {
  ExtensionRegistry,
  AppEvents,
  onAppEvent,
  getSelectionAggregations,
  type SelectionAggregationResult,
} from "../../../src/api";

interface SelectionInfo {
  startRow: number;
  startCol: number;
  endRow: number;
  endCol: number;
  type: string;
}

function isMultiCellSelection(sel: SelectionInfo): boolean {
  return sel.startRow !== sel.endRow || sel.startCol !== sel.endCol;
}

/** Wrap a promise with a timeout to prevent indefinite hangs. */
function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("IPC timeout")), ms);
    promise.then(
      (val) => { clearTimeout(timer); resolve(val); },
      (err) => { clearTimeout(timer); reject(err); },
    );
  });
}

const IPC_TIMEOUT_MS = 2000;
const CIRCUIT_BREAKER_THRESHOLD = 3;
const CIRCUIT_BREAKER_COOLDOWN_MS = 10000;

export function useSelectionAggregation(): SelectionAggregationResult | null {
  const [result, setResult] = useState<SelectionAggregationResult | null>(null);
  const selectionRef = useRef<SelectionInfo | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Circuit breaker state
  const failCountRef = useRef(0);
  const circuitOpenUntilRef = useRef(0);

  const fetchAggregations = useCallback(async (sel: SelectionInfo) => {
    // Circuit breaker: skip calls while open
    const now = Date.now();
    if (failCountRef.current >= CIRCUIT_BREAKER_THRESHOLD) {
      if (now < circuitOpenUntilRef.current) {
        return; // Circuit is open, skip this call
      }
      // Cooldown elapsed, allow a retry (half-open)
      failCountRef.current = CIRCUIT_BREAKER_THRESHOLD - 1;
    }

    try {
      const data = await withTimeout(
        getSelectionAggregations(
          sel.startRow,
          sel.startCol,
          sel.endRow,
          sel.endCol,
          sel.type,
        ),
        IPC_TIMEOUT_MS,
      );
      // Success - reset circuit breaker
      failCountRef.current = 0;
      setResult(data);
    } catch (err) {
      failCountRef.current += 1;
      if (failCountRef.current >= CIRCUIT_BREAKER_THRESHOLD) {
        circuitOpenUntilRef.current = Date.now() + CIRCUIT_BREAKER_COOLDOWN_MS;
        console.warn(
          "[StatusBarAggregation] Circuit breaker open after",
          failCountRef.current,
          "failures. Pausing IPC calls for",
          CIRCUIT_BREAKER_COOLDOWN_MS / 1000,
          "seconds.",
        );
      }
      setResult(null);
    }
  }, []);

  const debouncedFetch = useCallback(
    (sel: SelectionInfo) => {
      if (timerRef.current) {
        clearTimeout(timerRef.current);
      }
      timerRef.current = setTimeout(() => {
        fetchAggregations(sel);
      }, 150);
    },
    [fetchAggregations],
  );

  useEffect(() => {
    // Subscribe to selection changes
    const unsubSelection = ExtensionRegistry.onSelectionChange((sel) => {
      // sel is Selection | null - must guard against null before accessing fields
      const info: SelectionInfo | null = sel ? {
        startRow: sel.startRow,
        startCol: sel.startCol,
        endRow: sel.endRow,
        endCol: sel.endCol,
        type: sel.type,
      } : null;
      selectionRef.current = info;
      if (info && isMultiCellSelection(info)) {
        debouncedFetch(info);
      } else {
        setResult(null);
        if (timerRef.current) {
          clearTimeout(timerRef.current);
          timerRef.current = null;
        }
      }
    });

    // Re-fetch when cells are updated (data changed while selection active)
    const unsubCellsUpdated = onAppEvent(AppEvents.CELLS_UPDATED, () => {
      const sel = selectionRef.current;
      if (sel && isMultiCellSelection(sel)) {
        debouncedFetch(sel);
      }
    });

    return () => {
      unsubSelection();
      unsubCellsUpdated();
      if (timerRef.current) {
        clearTimeout(timerRef.current);
      }
    };
  }, [debouncedFetch]);

  return result;
}
