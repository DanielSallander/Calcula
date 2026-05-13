//! FILENAME: app/extensions/Charts/components/AxisContextMenu.tsx
// PURPOSE: Context menu for chart axis right-click.
// CONTEXT: Shows axis configuration options (title, scale, gridlines, labels, etc.)
//          when the user right-clicks on an axis region within a chart.

import React, { useEffect, useRef, useCallback } from "react";
import { css } from "@emotion/css";
import type { OverlayProps } from "@api/uiTypes";
import { emitAppEvent, AppEvents, showDialog } from "@api";

import type { ChartSpec, AxisSpec } from "../types";
import { getChartById, updateChartSpec, syncChartRegions } from "../lib/chartStore";
import { invalidateChartCache } from "../rendering/chartRenderer";
import { ChartEvents } from "../lib/chartEvents";

// ============================================================================
// Styles
// ============================================================================

const styles = {
  menu: css`
    position: fixed;
    z-index: 10000;
    background: #fff;
    border: 1px solid #ccc;
    border-radius: 4px;
    box-shadow: 0 4px 12px rgba(0, 0, 0, 0.18);
    min-width: 180px;
    padding: 4px 0;
    font-size: 12px;
    font-family: "Segoe UI Variable", "Segoe UI", system-ui, sans-serif;
  `,
  item: css`
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 6px 16px;
    cursor: pointer;
    white-space: nowrap;

    &:hover {
      background: #e8f0fe;
    }
  `,
  itemCheck: css`
    width: 14px;
    text-align: center;
    font-size: 11px;
    color: #005fb8;
  `,
  divider: css`
    border-top: 1px solid #e8e8e8;
    margin: 4px 0;
  `,
  header: css`
    padding: 4px 16px 2px;
    font-size: 10px;
    font-weight: 600;
    color: #888;
    text-transform: uppercase;
    letter-spacing: 0.3px;
  `,
  subLabel: css`
    flex: 1;
    color: #333;
  `,
};

// ============================================================================
// Component
// ============================================================================

export function AxisContextMenu({ onClose, data }: OverlayProps): React.ReactElement | null {
  const chartId = data?.chartId as number | undefined;
  const axisType = data?.axisType as "x" | "y" | undefined;
  const screenX = data?.screenX as number | undefined;
  const screenY = data?.screenY as number | undefined;

  const menuRef = useRef<HTMLDivElement>(null);

  const chart = chartId != null ? getChartById(chartId) : undefined;
  const spec = chart?.spec;

  // Close on outside click
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        onClose();
      }
    };
    setTimeout(() => document.addEventListener("mousedown", handler, true), 50);
    return () => document.removeEventListener("mousedown", handler, true);
  }, [onClose]);

  // Close on Escape
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", handler, true);
    return () => document.removeEventListener("keydown", handler, true);
  }, [onClose]);

  const updateSpec = useCallback(
    (updates: Partial<ChartSpec>) => {
      if (chartId == null) return;
      updateChartSpec(chartId, updates);
      invalidateChartCache(chartId);
      syncChartRegions();
      window.dispatchEvent(new Event(ChartEvents.CHART_UPDATED));
      emitAppEvent(AppEvents.GRID_REFRESH);
    },
    [chartId],
  );

  if (!spec || chartId == null || !axisType || screenX == null || screenY == null) return null;

  const axis = axisType === "x" ? spec.xAxis : spec.yAxis;
  const axisKey = axisType === "x" ? "xAxis" : "yAxis";
  const axisLabel = axisType === "x" ? "Horizontal" : "Vertical";

  const toggleAxisProp = (prop: keyof AxisSpec, current: boolean | undefined) => {
    updateSpec({ [axisKey]: { ...axis, [prop]: !current } });
    onClose();
  };

  const setAxisTitle = (hasTitle: boolean) => {
    updateSpec({ [axisKey]: { ...axis, title: hasTitle ? `${axisLabel} Axis` : null } });
    onClose();
  };

  const setScale = (scale: string) => {
    updateSpec({ [axisKey]: { ...axis, scale: { ...(axis.scale ?? {}), type: scale as any } } });
    onClose();
  };

  const setLabelAngle = (angle: number) => {
    updateSpec({ [axisKey]: { ...axis, labelAngle: angle } });
    onClose();
  };

  return (
    <div ref={menuRef} className={styles.menu} style={{ left: screenX, top: screenY }}>
      <div className={styles.header}>{axisLabel} Axis</div>

      <div className={styles.item} onClick={() => setAxisTitle(axis.title == null)}>
        <span className={styles.itemCheck}>{axis.title != null ? "\u2713" : ""}</span>
        <span className={styles.subLabel}>Axis Title</span>
      </div>

      <div className={styles.item} onClick={() => toggleAxisProp("showLabels", axis.showLabels !== false)}>
        <span className={styles.itemCheck}>{axis.showLabels !== false ? "\u2713" : ""}</span>
        <span className={styles.subLabel}>Show Labels</span>
      </div>

      <div className={styles.item} onClick={() => toggleAxisProp("gridLines", axis.gridLines)}>
        <span className={styles.itemCheck}>{axis.gridLines ? "\u2713" : ""}</span>
        <span className={styles.subLabel}>Gridlines</span>
      </div>

      <div className={styles.divider} />

      {axisType === "x" && (
        <>
          <div className={styles.header}>Label Angle</div>
          <div className={styles.item} onClick={() => setLabelAngle(0)}>
            <span className={styles.itemCheck}>{(axis.labelAngle ?? 0) === 0 ? "\u2713" : ""}</span>
            <span className={styles.subLabel}>Horizontal (0)</span>
          </div>
          <div className={styles.item} onClick={() => setLabelAngle(45)}>
            <span className={styles.itemCheck}>{axis.labelAngle === 45 ? "\u2713" : ""}</span>
            <span className={styles.subLabel}>Diagonal (45)</span>
          </div>
          <div className={styles.item} onClick={() => setLabelAngle(90)}>
            <span className={styles.itemCheck}>{axis.labelAngle === 90 ? "\u2713" : ""}</span>
            <span className={styles.subLabel}>Vertical (90)</span>
          </div>
          <div className={styles.divider} />
        </>
      )}

      {axisType === "y" && (
        <>
          <div className={styles.header}>Scale Type</div>
          <div className={styles.item} onClick={() => setScale("linear")}>
            <span className={styles.itemCheck}>{(!axis.scale?.type || axis.scale.type === "linear") ? "\u2713" : ""}</span>
            <span className={styles.subLabel}>Linear</span>
          </div>
          <div className={styles.item} onClick={() => setScale("log")}>
            <span className={styles.itemCheck}>{axis.scale?.type === "log" ? "\u2713" : ""}</span>
            <span className={styles.subLabel}>Logarithmic</span>
          </div>
          <div className={styles.item} onClick={() => setScale("sqrt")}>
            <span className={styles.itemCheck}>{axis.scale?.type === "sqrt" ? "\u2713" : ""}</span>
            <span className={styles.subLabel}>Square Root</span>
          </div>
          <div className={styles.divider} />
        </>
      )}

      <div className={styles.item} onClick={() => toggleAxisProp("reverse", (axis as any).reverse)}>
        <span className={styles.itemCheck}>{(axis as any).reverse ? "\u2713" : ""}</span>
        <span className={styles.subLabel}>Reverse Axis</span>
      </div>

      <div className={styles.divider} />

      <div className={styles.item} onClick={() => {
        onClose();
        showDialog("chart:formatAxisDialog", { chartId, axisType });
      }}>
        <span className={styles.itemCheck}></span>
        <span className={styles.subLabel} style={{ fontWeight: 600 }}>Format Axis...</span>
      </div>
    </div>
  );
}
