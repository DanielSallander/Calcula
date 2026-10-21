//! FILENAME: app/extensions/BuiltIn/StatusBarAggregation/StatusBarAggregationWidget.tsx
// PURPOSE: Status bar widget displaying aggregation values for the current selection.
// CONTEXT: Rendered by the Shell's StatusBar component via the StatusBar API.

import React, { useState, useCallback, useEffect } from "react";
import { useSelectionAggregation } from "./useSelectionAggregation";
import { useAggregationPreferences, type AggregationKey } from "./useAggregationPreferences";
import { AggregationContextMenu } from "./AggregationContextMenu";
import { AppEvents, onAppEvent } from "@api";
import { formatNumber, onLocaleChanged } from "@api/locale";

/**
 * Format an aggregate for the status bar in the app locale: the locale's group
 * and decimal separators, at most 2 decimals (rounded half away from zero, like
 * Excel), trailing zeros dropped. de-DE 1235.5 reads "1.235,5".
 */
export function formatAggregationValue(value: number): string {
  if (!Number.isFinite(value)) return String(value);
  return formatNumber(value, { grouping: true, minDecimals: 0, maxDecimals: 2 });
}

interface AggregationDisplay {
  key: AggregationKey;
  label: string;
  value: string;
}

export function StatusBarAggregationWidget(): React.ReactElement | null {
  const result = useSelectionAggregation();
  const { visibleKeys, toggleKey } = useAggregationPreferences();
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number } | null>(null);
  // Re-render on a locale switch so the shown aggregates take the new separators.
  const [, setLocaleTick] = useState(0);
  useEffect(() => onLocaleChanged(() => setLocaleTick((t) => t + 1)), []);

  const closeContextMenu = useCallback(() => {
    setContextMenu(null);
  }, []);

  // Listen for right-click events on the entire status bar (emitted by Shell).
  // This ensures the context menu opens no matter where on the bar the user clicks.
  useEffect(() => {
    return onAppEvent<{ x: number; y: number }>(
      AppEvents.STATUS_BAR_CONTEXT_MENU,
      (pos) => {
        setContextMenu(pos);
      },
    );
  }, []);

  // Build the list of aggregation items to display
  const displayItems: AggregationDisplay[] = [];

  if (result) {
    if (visibleKeys.has("average") && result.average !== null) {
      displayItems.push({ key: "average", label: "Average", value: formatAggregationValue(result.average) });
    }
    if (visibleKeys.has("count") && result.count > 0) {
      displayItems.push({ key: "count", label: "Count", value: formatAggregationValue(result.count) });
    }
    if (visibleKeys.has("numericalCount") && result.numericalCount > 0) {
      displayItems.push({ key: "numericalCount", label: "Numerical Count", value: formatAggregationValue(result.numericalCount) });
    }
    if (visibleKeys.has("min") && result.min !== null) {
      displayItems.push({ key: "min", label: "Minimum", value: formatAggregationValue(result.min) });
    }
    if (visibleKeys.has("max") && result.max !== null) {
      displayItems.push({ key: "max", label: "Maximum", value: formatAggregationValue(result.max) });
    }
    if (visibleKeys.has("sum") && result.sum !== null) {
      displayItems.push({ key: "sum", label: "Sum", value: formatAggregationValue(result.sum) });
    }
  }

  return (
    <>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "flex-end",
          gap: "16px",
          cursor: "default",
          flex: 1,
          height: "100%",
        }}
      >
        {displayItems.map((item) => (
          <span key={item.key} style={{ whiteSpace: "nowrap" }}>
            <span style={{ opacity: 0.85 }}>{item.label}: </span>
            <span style={{ fontWeight: 600 }}>{item.value}</span>
          </span>
        ))}
      </div>

      {contextMenu && (
        <AggregationContextMenu
          x={contextMenu.x}
          y={contextMenu.y}
          visibleKeys={visibleKeys}
          onToggle={toggleKey}
          onClose={closeContextMenu}
        />
      )}
    </>
  );
}
