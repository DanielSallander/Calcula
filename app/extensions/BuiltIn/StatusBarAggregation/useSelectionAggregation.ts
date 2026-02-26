//! FILENAME: app/extensions/BuiltIn/StatusBarAggregation/useSelectionAggregation.ts
// PURPOSE: Hook that computes aggregations for the current selection.
// CONTEXT: Subscribes to selection changes and CELLS_UPDATED events,
//          debounces, and calls the Rust backend for computation.
//          Includes a circuit breaker to gracefully handle missing backend commands.
//          Supports multi-selection (Ctrl+Click additional ranges).

import { useState, useEffect, useRef, useCallback } from "react";
import {
  ExtensionRegistry,
  AppEvents,
  onAppEvent,
  getSelectionAggregations,
  type SelectionAggregationResult,
} from "../../../src/api";

interface SelectionRange {
  startRow: number;
  startCol: number;
  endRow: number;
  endCol: number;
}

interface SelectionInfo {
  startRow: number;
  startCol: number;
  endRow: number;
  endCol: number;
  type: string;
  additionalRanges?: SelectionRange[];
}

function isMultiCellSelection(sel: SelectionInfo): boolean {
  // Multi-cell if the main range spans multiple cells OR there are additional ranges
  return sel.startRow !== sel.endRow || sel.startCol !== sel.endCol ||
    (sel.additionalRanges !== undefined && sel.additionalRanges.length > 0);
}

/**
 * Combine multiple aggregation results into one.
 * sum = total sum, count = total count, average = total sum / total numericalCount,
 * min = global min, max = global max.
 */
function combineAggregations(results: SelectionAggregationResult[]): SelectionAggregationResult {
  let totalSum = 0;
  let hasNumeric = false;
  let totalCount = 0;
  let totalNumericalCount = 0;
  let globalMin = Infinity;
  let globalMax = -Infinity;

  for (const r of results) {
    totalCount += r.count;
    totalNumericalCount += r.numericalCount;
    if (r.sum !== null) {
      totalSum += r.sum;
      hasNumeric = true;
    }
    if (r.min !== null && r.min < globalMin) {
      globalMin = r.min;
    }
    if (r.max !== null && r.max > globalMax) {
      globalMax = r.max;
    }
  }

  if (!hasNumeric) {
    return {
      sum: null,
      average: null,
      min: null,
      max: null,
      count: totalCount,
      numericalCount: totalNumericalCount,
    };
  }

  return {
    sum: totalSum,
    average: totalNumericalCount > 0 ? totalSum / totalNumericalCount : null,
    min: globalMin === Infinity ? null : globalMin,
    max: globalMax === -Infinity ? null : globalMax,
    count: totalCount,
    numericalCount: totalNumericalCount,
  };
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
      // Build the list of ranges to aggregate
      const ranges: SelectionRange[] = [
        { startRow: sel.startRow, startCol: sel.startCol, endRow: sel.endRow, endCol: sel.endCol },
      ];
      if (sel.additionalRanges) {
        ranges.push(...sel.additionalRanges);
      }

      // Fetch aggregations for all ranges in parallel
      const promises = ranges.map((range) =>
        withTimeout(
          getSelectionAggregations(
            range.startRow,
            range.startCol,
            range.endRow,
            range.endCol,
            sel.type,
          ),
          IPC_TIMEOUT_MS,
        )
      );

      const results = await Promise.all(promises);

      // Combine results if multiple ranges, otherwise use single result directly
      const combined = results.length === 1 ? results[0] : combineAggregations(results);

      // Success - reset circuit breaker
      failCountRef.current = 0;
      setResult(combined);
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
        additionalRanges: sel.additionalRanges,
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
