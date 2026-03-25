//! FILENAME: app/extensions/Charts/components/ChartDesignTab.tsx
// PURPOSE: Ribbon "Design" tab for chart configuration.
// CONTEXT: Appears in the ribbon when a chart is selected. Provides chart type
//          selector with icons, color palette swatches, legend controls, and
//          quick axis/gridline toggles. Matches Excel's Chart Design ribbon style.

import React, { useState, useEffect, useCallback, useRef, useMemo } from "react";
import { css } from "@emotion/css";
import { emitAppEvent, AppEvents, showDialog } from "../../../src/api";
import type { RibbonContext } from "../../../src/api/extensions";
import { useRibbonCollapse, RibbonGroup } from "../../../src/api/ribbonCollapse";

import type { ChartType, ChartSpec } from "../types";
import { isPivotDataSource, isCartesianChart } from "../types";
import { getChartById, updateChartSpec, syncChartRegions } from "../lib/chartStore";
import { invalidateChartCache } from "../rendering/chartRenderer";
import { getCurrentChartId } from "../handlers/selectionHandler";
import { ChartEvents } from "../lib/chartEvents";
import { PALETTES, PALETTE_NAMES } from "../rendering/chartTheme";
import { CHART_DIALOG_ID } from "../manifest";

// ============================================================================
// Styles
// ============================================================================

const s = {
  container: css`
    display: flex;
    gap: 0;
    align-items: stretch;
    height: 100%;
    width: 100%;
    min-width: 0;
    overflow: hidden;
    font-family: "Segoe UI Variable", "Segoe UI", system-ui, sans-serif;
    font-size: 12px;
  `,
  disabledMessage: css`
    display: flex;
    align-items: center;
    justify-content: center;
    width: 100%;
    height: 100%;
    color: #999;
    font-style: italic;
    font-size: 12px;
  `,
  groupContent: css`
    display: flex;
    gap: 6px;
    align-items: center;
    flex: 1;
  `,

  // -- Type group: icon-over-text toggle buttons --
  typeButtonGroup: css`
    display: flex;
    gap: 2px;
  `,
  typeBtn: css`
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 1px;
    padding: 3px 6px;
    background: transparent;
    border: 1px solid transparent;
    border-radius: 3px;
    cursor: pointer;
    font-size: 10px;
    color: #444;
    min-width: 42px;

    &:hover {
      background: #e8e8e8;
      border-color: #d0d0d0;
    }
  `,
  typeBtnActive: css`
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 1px;
    padding: 3px 6px;
    background: #d6e4f0;
    border: 1px solid #a0c0e0;
    border-radius: 3px;
    cursor: pointer;
    font-size: 10px;
    color: #1a1a1a;
    min-width: 42px;
    font-weight: 500;

    &:hover {
      background: #c0d8ec;
    }
  `,
  typeIcon: css`
    width: 24px;
    height: 20px;
    display: flex;
    align-items: center;
    justify-content: center;
  `,

  // -- Chart Elements group --
  checkGrid: css`
    display: grid;
    grid-template-columns: auto auto;
    gap: 1px 12px;
  `,
  checkLabel: css`
    display: flex;
    align-items: center;
    gap: 4px;
    cursor: pointer;
    white-space: nowrap;
    font-size: 11px;
    color: #333;

    input {
      cursor: pointer;
      margin: 0;
    }
  `,

  // -- Colors group: palette swatches --
  paletteGallery: css`
    display: flex;
    gap: 3px;
    align-items: center;
    padding: 3px;
    border: 1px solid #e0e0e0;
    border-radius: 3px;
    background: #fff;
  `,
  paletteSwatch: css`
    width: 28px;
    height: 22px;
    border: 1px solid transparent;
    border-radius: 2px;
    cursor: pointer;
    padding: 2px;
    background: #fff;
    display: flex;
    gap: 1px;
    align-items: center;
    justify-content: center;

    &:hover {
      border-color: #999;
      background: #f5f5f5;
    }
  `,
  paletteSwatchActive: css`
    width: 28px;
    height: 22px;
    border: 2px solid #005fb8;
    border-radius: 2px;
    cursor: pointer;
    padding: 1px;
    background: #e8f0fe;
    display: flex;
    gap: 1px;
    align-items: center;
    justify-content: center;
  `,
  colorDot: css`
    width: 5px;
    height: 16px;
    border-radius: 1px;
  `,

  // -- Legend group --
  select: css`
    padding: 3px 6px;
    border: 1px solid #d0d0d0;
    border-radius: 3px;
    font-size: 11px;
    font-family: inherit;
    background: #fff;
    color: #1a1a1a;
    cursor: pointer;

    &:hover { border-color: #999; }
    &:focus { outline: none; border-color: #0078d4; }
  `,

  // -- Title input --
  titleInput: css`
    padding: 3px 6px;
    border: 1px solid #d0d0d0;
    border-radius: 3px;
    font-size: 11px;
    font-family: inherit;
    background: #fff;
    color: #1a1a1a;
    width: 130px;

    &:hover { border-color: #999; }
    &:focus { outline: none; border-color: #0078d4; }
  `,

  // -- Action buttons --
  actionBtn: css`
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 2px;
    padding: 4px 10px;
    background: transparent;
    border: 1px solid transparent;
    border-radius: 3px;
    cursor: pointer;
    font-size: 10px;
    color: #333;
    white-space: nowrap;
    font-family: inherit;

    &:hover {
      background: #e8e8e8;
      border-color: #d0d0d0;
    }
    &:active {
      background: #d6d6d6;
    }
  `,
  actionIcon: css`
    font-size: 20px;
    line-height: 1;
    height: 24px;
    display: flex;
    align-items: center;
    justify-content: center;
  `,
};

// ============================================================================
// Chart Type Definitions with SVG Icons
// ============================================================================

/** Compact chart type entries for the main button row. */
const MAIN_TYPES: Array<{ value: ChartType; label: string; icon: React.ReactNode }> = [
  { value: "bar", label: "Bar", icon: <BarIcon /> },
  { value: "horizontalBar", label: "H-Bar", icon: <HBarIcon /> },
  { value: "line", label: "Line", icon: <LineIcon /> },
  { value: "area", label: "Area", icon: <AreaIcon /> },
  { value: "pie", label: "Pie", icon: <PieIcon /> },
  { value: "scatter", label: "Scatter", icon: <ScatterIcon /> },
];

/** Additional chart types accessible via dropdown. */
const MORE_TYPES: Array<{ value: ChartType; label: string }> = [
  { value: "donut", label: "Donut" },
  { value: "waterfall", label: "Waterfall" },
  { value: "combo", label: "Combo" },
  { value: "radar", label: "Radar" },
  { value: "bubble", label: "Bubble" },
  { value: "histogram", label: "Histogram" },
  { value: "funnel", label: "Funnel" },
];

// ============================================================================
// Mini SVG Icons for Chart Types
// ============================================================================

function BarIcon() {
  return (
    <svg width="20" height="16" viewBox="0 0 20 16">
      <rect x="2" y="8" width="4" height="8" fill="#4472C4" rx="0.5" />
      <rect x="8" y="3" width="4" height="13" fill="#ED7D31" rx="0.5" />
      <rect x="14" y="6" width="4" height="10" fill="#A5A5A5" rx="0.5" />
    </svg>
  );
}

function HBarIcon() {
  return (
    <svg width="20" height="16" viewBox="0 0 20 16">
      <rect x="0" y="1" width="12" height="4" fill="#4472C4" rx="0.5" />
      <rect x="0" y="6" width="18" height="4" fill="#ED7D31" rx="0.5" />
      <rect x="0" y="11" width="8" height="4" fill="#A5A5A5" rx="0.5" />
    </svg>
  );
}

function LineIcon() {
  return (
    <svg width="20" height="16" viewBox="0 0 20 16">
      <polyline points="1,12 5,6 10,9 15,3 19,7" fill="none" stroke="#4472C4" strokeWidth="1.8" strokeLinejoin="round" />
      <polyline points="1,14 5,10 10,11 15,8 19,10" fill="none" stroke="#ED7D31" strokeWidth="1.4" strokeLinejoin="round" />
    </svg>
  );
}

function AreaIcon() {
  return (
    <svg width="20" height="16" viewBox="0 0 20 16">
      <polygon points="1,14 5,8 10,10 15,5 19,8 19,16 1,16" fill="#4472C4" opacity="0.5" />
      <polyline points="1,14 5,8 10,10 15,5 19,8" fill="none" stroke="#4472C4" strokeWidth="1.5" strokeLinejoin="round" />
    </svg>
  );
}

function PieIcon() {
  return (
    <svg width="20" height="16" viewBox="0 0 20 16">
      <circle cx="10" cy="8" r="7" fill="#ED7D31" />
      <path d="M10,8 L10,1 A7,7 0 0,1 16.5,4.5 Z" fill="#4472C4" />
      <path d="M10,8 L16.5,4.5 A7,7 0 0,1 17,8 L10,8 Z" fill="#A5A5A5" />
    </svg>
  );
}

function ScatterIcon() {
  return (
    <svg width="20" height="16" viewBox="0 0 20 16">
      <circle cx="4" cy="11" r="2" fill="#4472C4" />
      <circle cx="8" cy="6" r="2" fill="#4472C4" />
      <circle cx="13" cy="9" r="2" fill="#ED7D31" />
      <circle cx="16" cy="4" r="2" fill="#ED7D31" />
    </svg>
  );
}

// ============================================================================
// Collapse configuration
// ============================================================================

const GROUP_DEFS = [
  { collapseOrder: 4, expandedWidth: 310 }, // Type
  { collapseOrder: 3, expandedWidth: 140 }, // Chart Elements
  { collapseOrder: 2, expandedWidth: 220 }, // Colors
  { collapseOrder: 1, expandedWidth: 130 }, // Legend
  { collapseOrder: 5, expandedWidth: 80 },  // Actions
];

// ============================================================================
// Component
// ============================================================================

export function ChartDesignTab({
  context: _context,
}: {
  context: RibbonContext;
}): React.ReactElement {
  const containerRef = useRef<HTMLDivElement>(null);
  const groupDefs = useMemo(() => GROUP_DEFS, []);
  const collapsed = useRibbonCollapse(containerRef, groupDefs, 0);

  const [chartId, setChartId] = useState<number | null>(null);
  const [spec, setSpec] = useState<ChartSpec | null>(null);

  // Refresh state from store
  const refreshFromStore = useCallback(() => {
    const id = getCurrentChartId();
    setChartId(id);
    if (id != null) {
      const chart = getChartById(id);
      setSpec(chart?.spec ?? null);
    } else {
      setSpec(null);
    }
  }, []);

  useEffect(() => {
    refreshFromStore();
    const handleRefresh = () => refreshFromStore();
    window.addEventListener(ChartEvents.CHART_UPDATED, handleRefresh);
    return () => window.removeEventListener(ChartEvents.CHART_UPDATED, handleRefresh);
  }, [refreshFromStore]);

  // Re-sync when the currently selected chart changes
  useEffect(() => {
    refreshFromStore();
  });

  const updateSpec = useCallback(
    (updates: Partial<ChartSpec>) => {
      if (chartId == null) return;
      updateChartSpec(chartId, updates);
      invalidateChartCache(chartId);
      syncChartRegions();
      window.dispatchEvent(new Event(ChartEvents.CHART_UPDATED));
      emitAppEvent(AppEvents.GRID_REFRESH);
      const chart = getChartById(chartId);
      if (chart) setSpec({ ...chart.spec });
    },
    [chartId],
  );

  if (!chartId || !spec) {
    return (
      <div className={s.disabledMessage}>
        Select a chart to see design options
      </div>
    );
  }

  const isPivot = isPivotDataSource(spec.data);
  const cartesian = isCartesianChart(spec.mark);
  const isMainType = MAIN_TYPES.some((t) => t.value === spec.mark);

  return (
    <div ref={containerRef} className={s.container}>
      {/* ================================================================ */}
      {/* Type Group: icon-over-text buttons for common types + dropdown   */}
      {/* ================================================================ */}
      <RibbonGroup label="Chart Type" collapsed={collapsed[0]}>
        <div className={s.groupContent}>
          <div className={s.typeButtonGroup}>
            {MAIN_TYPES.map(({ value, label, icon }) => (
              <button
                key={value}
                className={spec.mark === value ? s.typeBtnActive : s.typeBtn}
                onClick={() => updateSpec({ mark: value })}
                title={label}
              >
                <span className={s.typeIcon}>{icon}</span>
                {label}
              </button>
            ))}
          </div>
          {/* More types dropdown */}
          <select
            className={s.select}
            value={isMainType ? "" : spec.mark}
            onChange={(e) => {
              if (e.target.value) updateSpec({ mark: e.target.value as ChartType });
            }}
            style={{ minWidth: 60 }}
          >
            <option value="" disabled>More...</option>
            {MORE_TYPES.map(({ value, label }) => (
              <option key={value} value={value}>{label}</option>
            ))}
          </select>
        </div>
      </RibbonGroup>

      {/* ================================================================ */}
      {/* Chart Elements: title, gridlines, axis labels                    */}
      {/* ================================================================ */}
      <RibbonGroup label="Chart Elements" collapsed={collapsed[1]}>
        <div className={s.groupContent}>
          <div className={s.checkGrid}>
            <label className={s.checkLabel}>
              <input
                type="checkbox"
                checked={!!spec.title}
                onChange={(e) => updateSpec({ title: e.target.checked ? (spec.title || "Chart") : null })}
              />
              Title
            </label>
            {cartesian && (
              <label className={s.checkLabel}>
                <input
                  type="checkbox"
                  checked={spec.yAxis.gridLines}
                  onChange={(e) => updateSpec({ yAxis: { ...spec.yAxis, gridLines: e.target.checked } })}
                />
                Gridlines
              </label>
            )}
            <label className={s.checkLabel}>
              <input
                type="checkbox"
                checked={spec.legend.visible}
                onChange={(e) => updateSpec({ legend: { ...spec.legend, visible: e.target.checked } })}
              />
              Legend
            </label>
            {cartesian && (
              <label className={s.checkLabel}>
                <input
                  type="checkbox"
                  checked={spec.xAxis.showLabels}
                  onChange={(e) => updateSpec({ xAxis: { ...spec.xAxis, showLabels: e.target.checked } })}
                />
                Axis Labels
              </label>
            )}
          </div>
        </div>
      </RibbonGroup>

      {/* ================================================================ */}
      {/* Colors: palette swatches                                          */}
      {/* ================================================================ */}
      <RibbonGroup label="Colors" collapsed={collapsed[2]}>
        <div className={s.groupContent}>
          <div className={s.paletteGallery}>
            {PALETTE_NAMES.map((name) => {
              const colors = PALETTES[name];
              const isActive = spec.palette === name;
              return (
                <button
                  key={name}
                  className={isActive ? s.paletteSwatchActive : s.paletteSwatch}
                  onClick={() => updateSpec({ palette: name })}
                  title={name}
                >
                  {colors.slice(0, 4).map((c, i) => (
                    <span key={i} className={s.colorDot} style={{ backgroundColor: c }} />
                  ))}
                </button>
              );
            })}
          </div>
        </div>
      </RibbonGroup>

      {/* ================================================================ */}
      {/* Legend: position selector                                          */}
      {/* ================================================================ */}
      <RibbonGroup label="Legend" collapsed={collapsed[3]}>
        <div className={s.groupContent}>
          {spec.legend.visible && (
            <select
              className={s.select}
              value={spec.legend.position}
              onChange={(e) =>
                updateSpec({ legend: { ...spec.legend, position: e.target.value as "top" | "bottom" | "left" | "right" } })
              }
            >
              <option value="bottom">Bottom</option>
              <option value="top">Top</option>
              <option value="left">Left</option>
              <option value="right">Right</option>
            </select>
          )}
          {spec.title != null && (
            <input
              className={s.titleInput}
              type="text"
              value={spec.title}
              onChange={(e) => updateSpec({ title: e.target.value || null })}
              placeholder="Chart title"
            />
          )}
        </div>
      </RibbonGroup>

      {/* ================================================================ */}
      {/* Actions: Edit Chart button                                        */}
      {/* ================================================================ */}
      <RibbonGroup label="Actions" collapsed={collapsed[4]}>
        <div className={s.groupContent}>
          <button
            className={s.actionBtn}
            onClick={() => {
              if (isPivot) {
                const pivotId = (spec.data as { pivotId: number }).pivotId;
                showDialog(CHART_DIALOG_ID, { pivotId, editChartId: chartId });
              } else {
                showDialog(CHART_DIALOG_ID, { editChartId: chartId });
              }
            }}
            title="Open full chart editor dialog"
          >
            <span className={s.actionIcon}>&#9998;</span>
            Edit Chart
          </button>
        </div>
      </RibbonGroup>
    </div>
  );
}
