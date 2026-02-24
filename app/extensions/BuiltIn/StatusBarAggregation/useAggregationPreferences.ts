//! FILENAME: app/extensions/BuiltIn/StatusBarAggregation/useAggregationPreferences.ts
// PURPOSE: Manages which aggregation types are visible in the status bar.
// CONTEXT: Persisted to localStorage so preferences survive page reloads.

import { useState, useCallback } from "react";

/** The six aggregation types available. */
export type AggregationKey = "average" | "count" | "numericalCount" | "min" | "max" | "sum";

const STORAGE_KEY = "calcula.statusbar.aggregation";

/** Default visible aggregations (matching Excel defaults). */
const DEFAULT_VISIBLE: AggregationKey[] = ["average", "count", "sum"];

function loadPreferences(): Set<AggregationKey> {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored) {
      const parsed = JSON.parse(stored) as AggregationKey[];
      return new Set(parsed);
    }
  } catch {
    // Ignore parse errors, use defaults
  }
  return new Set(DEFAULT_VISIBLE);
}

function savePreferences(keys: Set<AggregationKey>): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(Array.from(keys)));
  } catch {
    // Ignore storage errors
  }
}

export interface AggregationPreferences {
  visibleKeys: Set<AggregationKey>;
  toggleKey: (key: AggregationKey) => void;
}

export function useAggregationPreferences(): AggregationPreferences {
  const [visibleKeys, setVisibleKeys] = useState<Set<AggregationKey>>(() => loadPreferences());

  const toggleKey = useCallback((key: AggregationKey) => {
    setVisibleKeys((prev) => {
      const next = new Set(prev);
      if (next.has(key)) {
        next.delete(key);
      } else {
        next.add(key);
      }
      savePreferences(next);
      return next;
    });
  }, []);

  return { visibleKeys, toggleKey };
}
