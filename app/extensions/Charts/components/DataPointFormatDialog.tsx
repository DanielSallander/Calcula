//! FILENAME: app/extensions/Charts/components/DataPointFormatDialog.tsx
// PURPOSE: Dialog for formatting an individual data point (bar, slice, marker).
// CONTEXT: Opened when a data point is selected and the user clicks "Format Data Point"
//          in the ribbon. Allows setting override color, opacity, border, and explode offset.

import React, { useState, useCallback, useEffect } from "react";
import { css } from "@emotion/css";
import type { DialogProps } from "@api";
import { emitAppEvent, AppEvents } from "@api/events";

import type { ChartSpec, DataPointOverride } from "../types";
import { getChartById, updateChartSpec, syncChartRegions } from "../lib/chartStore";
import { invalidateChartCache } from "../rendering/chartRenderer";
import { ChartEvents } from "../lib/chartEvents";

// ============================================================================
// Styles
// ============================================================================

const s = {
  container: css`
    background: #fff;
    border-radius: 8px;
    width: 320px;
    font-family: "Segoe UI Variable", "Segoe UI", system-ui, sans-serif;
    font-size: 13px;
  `,
  header: css`
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: 12px 16px;
    border-bottom: 1px solid #e0e0e0;
    font-weight: 600;
    font-size: 14px;
  `,
  close: css`
    background: none;
    border: none;
    cursor: pointer;
    font-size: 16px;
    color: #666;
    padding: 2px 6px;
    border-radius: 3px;
    &:hover { background: #e8e8e8; }
  `,
  body: css`
    padding: 12px 16px;
    display: flex;
    flex-direction: column;
    gap: 10px;
  `,
  row: css`
    display: flex;
    align-items: center;
    gap: 8px;
    font-size: 12px;
  `,
  label: css`
    width: 80px;
    flex-shrink: 0;
    color: #555;
  `,
  colorInput: css`
    width: 40px;
    height: 26px;
    padding: 1px;
    border: 1px solid #ccc;
    border-radius: 3px;
    cursor: pointer;
  `,
  textInput: css`
    flex: 1;
    padding: 4px 8px;
    border: 1px solid #ccc;
    border-radius: 3px;
    font-size: 12px;
  `,
  checkbox: css`
    cursor: pointer;
  `,
  footer: css`
    display: flex;
    justify-content: flex-end;
    gap: 8px;
    padding: 12px 16px;
    border-top: 1px solid #e0e0e0;
  `,
  btn: css`
    padding: 5px 16px;
    border: 1px solid #ccc;
    border-radius: 4px;
    background: #fff;
    cursor: pointer;
    font-size: 12px;
    &:hover { background: #f0f0f0; }
  `,
  btnPrimary: css`
    padding: 5px 16px;
    border: 1px solid #005fb8;
    border-radius: 4px;
    background: #005fb8;
    color: #fff;
    cursor: pointer;
    font-size: 12px;
    &:hover { background: #004a99; }
  `,
  info: css`
    font-size: 11px;
    color: #888;
    font-style: italic;
  `,
};

// ============================================================================
// Component
// ============================================================================

export function DataPointFormatDialog({ onClose, data }: DialogProps): React.ReactElement {
  const chartId = data?.chartId as number | undefined;
  const seriesIndex = data?.seriesIndex as number | undefined;
  const categoryIndex = data?.categoryIndex as number | undefined;
  const isPieOrDonut = data?.isPieOrDonut as boolean | undefined;

  const chart = chartId != null ? getChartById(chartId) : undefined;
  const spec = chart?.spec;

  // Find existing override
  const existingOverride = spec?.dataPointOverrides?.find(
    (o) => o.seriesIndex === seriesIndex && o.categoryIndex === categoryIndex,
  );

  const [color, setColor] = useState(existingOverride?.color ?? "");
  const [useColor, setUseColor] = useState(!!existingOverride?.color);
  const [opacity, setOpacity] = useState<string>(
    existingOverride?.opacity !== undefined ? String(existingOverride.opacity) : "",
  );
  const [borderColor, setBorderColor] = useState(existingOverride?.borderColor ?? "");
  const [useBorder, setUseBorder] = useState(!!existingOverride?.borderColor);
  const [borderWidth, setBorderWidth] = useState<string>(
    existingOverride?.borderWidth !== undefined ? String(existingOverride.borderWidth) : "2",
  );
  const [exploded, setExploded] = useState<string>(
    existingOverride?.exploded !== undefined ? String(existingOverride.exploded) : "0",
  );

  const handleApply = useCallback(() => {
    if (chartId == null || seriesIndex == null || categoryIndex == null || !spec) return;

    const overrides = [...(spec.dataPointOverrides ?? [])];
    const idx = overrides.findIndex(
      (o) => o.seriesIndex === seriesIndex && o.categoryIndex === categoryIndex,
    );

    const override: DataPointOverride = {
      seriesIndex,
      categoryIndex,
    };

    if (useColor && color) override.color = color;
    if (opacity !== "") {
      const val = parseFloat(opacity);
      if (!isNaN(val) && val >= 0 && val <= 1) override.opacity = val;
    }
    if (useBorder && borderColor) {
      override.borderColor = borderColor;
      const bw = parseFloat(borderWidth);
      if (!isNaN(bw) && bw > 0) override.borderWidth = bw;
    }
    if (isPieOrDonut) {
      const exp = parseFloat(exploded);
      if (!isNaN(exp) && exp > 0) override.exploded = exp;
    }

    // Check if override has any actual values
    const hasValues = override.color || override.opacity !== undefined || override.borderColor || override.exploded;
    if (hasValues) {
      if (idx >= 0) {
        overrides[idx] = override;
      } else {
        overrides.push(override);
      }
    } else if (idx >= 0) {
      // Remove empty override
      overrides.splice(idx, 1);
    }

    updateChartSpec(chartId, { dataPointOverrides: overrides.length > 0 ? overrides : undefined });
    invalidateChartCache(chartId);
    syncChartRegions();
    window.dispatchEvent(new Event(ChartEvents.CHART_UPDATED));
    emitAppEvent(AppEvents.GRID_REFRESH);
    onClose();
  }, [chartId, seriesIndex, categoryIndex, spec, useColor, color, opacity, useBorder, borderColor, borderWidth, exploded, isPieOrDonut, onClose]);

  const handleReset = useCallback(() => {
    if (chartId == null || seriesIndex == null || categoryIndex == null || !spec) return;

    const overrides = (spec.dataPointOverrides ?? []).filter(
      (o) => !(o.seriesIndex === seriesIndex && o.categoryIndex === categoryIndex),
    );

    updateChartSpec(chartId, { dataPointOverrides: overrides.length > 0 ? overrides : undefined });
    invalidateChartCache(chartId);
    syncChartRegions();
    window.dispatchEvent(new Event(ChartEvents.CHART_UPDATED));
    emitAppEvent(AppEvents.GRID_REFRESH);
    onClose();
  }, [chartId, seriesIndex, categoryIndex, spec, onClose]);

  if (chartId == null || seriesIndex == null || categoryIndex == null) {
    return (
      <div style={{ position: "fixed", inset: 0, zIndex: 1050, background: "rgba(0,0,0,0.45)", display: "flex", alignItems: "center", justifyContent: "center" }}
        onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
        <div className={s.container}>
          <div className={s.header}>Format Data Point<button className={s.close} onClick={onClose}>X</button></div>
          <div className={s.body}><div className={s.info}>No data point selected. Select a single data point first.</div></div>
        </div>
      </div>
    );
  }

  const seriesName = chart?.spec.series[seriesIndex]?.name ?? `Series ${seriesIndex + 1}`;
  const categoryName = data?.categoryName as string ?? `Point ${categoryIndex + 1}`;

  return (
    <div
      style={{ position: "fixed", inset: 0, zIndex: 1050, background: "rgba(0,0,0,0.45)", display: "flex", alignItems: "center", justifyContent: "center" }}
      onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div className={s.container} onKeyDown={(e) => { if (e.key === "Escape") onClose(); if (e.key === "Enter") handleApply(); }}>
        <div className={s.header}>
          Format Data Point
          <button className={s.close} onClick={onClose}>X</button>
        </div>

        <div className={s.body}>
          <div className={s.info}>
            {seriesName} - {categoryName}
          </div>

          {/* Fill Color */}
          <div className={s.row}>
            <input type="checkbox" className={s.checkbox} checked={useColor} onChange={(e) => setUseColor(e.target.checked)} />
            <span className={s.label}>Fill Color</span>
            <input
              type="color"
              className={s.colorInput}
              value={color || "#4472C4"}
              onChange={(e) => { setColor(e.target.value); setUseColor(true); }}
              disabled={!useColor}
            />
          </div>

          {/* Opacity */}
          <div className={s.row}>
            <span style={{ width: 16 }} />
            <span className={s.label}>Opacity</span>
            <input
              type="text"
              className={s.textInput}
              value={opacity}
              onChange={(e) => setOpacity(e.target.value)}
              placeholder="0.0 - 1.0"
              style={{ width: 80 }}
            />
          </div>

          {/* Border */}
          <div className={s.row}>
            <input type="checkbox" className={s.checkbox} checked={useBorder} onChange={(e) => setUseBorder(e.target.checked)} />
            <span className={s.label}>Border</span>
            <input
              type="color"
              className={s.colorInput}
              value={borderColor || "#000000"}
              onChange={(e) => { setBorderColor(e.target.value); setUseBorder(true); }}
              disabled={!useBorder}
            />
            <input
              type="text"
              className={s.textInput}
              value={borderWidth}
              onChange={(e) => setBorderWidth(e.target.value)}
              placeholder="Width"
              style={{ width: 50 }}
              disabled={!useBorder}
            />
            <span style={{ fontSize: 11, color: "#888" }}>px</span>
          </div>

          {/* Explode (pie/donut only) */}
          {isPieOrDonut && (
            <div className={s.row}>
              <span style={{ width: 16 }} />
              <span className={s.label}>Explode</span>
              <input
                type="text"
                className={s.textInput}
                value={exploded}
                onChange={(e) => setExploded(e.target.value)}
                placeholder="Offset in px"
                style={{ width: 80 }}
              />
              <span style={{ fontSize: 11, color: "#888" }}>px</span>
            </div>
          )}
        </div>

        <div className={s.footer}>
          {existingOverride && (
            <button className={s.btn} onClick={handleReset}>Reset</button>
          )}
          <button className={s.btn} onClick={onClose}>Cancel</button>
          <button className={s.btnPrimary} onClick={handleApply}>Apply</button>
        </div>
      </div>
    </div>
  );
}
