//! FILENAME: app/extensions/Charts/components/ChartDesignSections.tsx
// PURPOSE: Panel sections for the contextual "Chart Design" panel.
// CONTEXT: Appears (in the ribbon by default) when a chart is selected. One
//          PanelSection per former ribbon group: chart type selector with
//          icons, chart-elements checkboxes, stacking/axes, trendline, color
//          palette swatches, legend controls, filter dropdown, actions and the
//          JSON toggle. The shell owns group chrome and collapse now; internal
//          layout uses @api/layout primitives while the band-designed widgets
//          (type icon gallery, palette swatches, filter dropdown) are kept
//          as-is. Replaces the monolithic ChartDesignTab (useRibbonCollapse).

import React, { useState, useEffect, useCallback, useReducer } from "react";
import { css } from "@emotion/css";
import { emitAppEvent, onAppEvent, AppEvents, showDialog } from "@api";
import type { PanelSection, PanelSectionProps } from "@api/uiTypes";
import { ControlRow, ActionRow, Input } from "@api/layout";

import type { ChartType, ChartSpec, ChartFilters, StackMode, BarMarkOptions, LineMarkOptions, AreaMarkOptions, TrendlineSpec, TrendlineType, ComboMarkOptions, DataLabelSpec, SeriesOrientation } from "../types";
import { isPivotDataSource, isCartesianChart } from "../types";
import { ChartFilterDropdown } from "./ChartFilterDropdown";
import { useJsonToggle, JsonToggleButton, JsonToggleEditor } from "../../_shared/components/jsonToggle";
import { getChartById, updateChartSpec, syncChartRegions } from "../lib/chartStore";
import { invalidateChartCache, getCachedChartData } from "../rendering/chartRenderer";
import { getCurrentChartId, getSubSelection } from "../handlers/selectionHandler";
import { toAuthoringIndices } from "../lib/dataPointOverrides";
import { ChartEvents } from "../lib/chartEvents";
import { PALETTES, PALETTE_NAMES } from "../rendering/chartTheme";
import { CHART_DESIGN_TAB_ID, CHART_DIALOG_ID } from "../manifest";
import { exportChartAsImage } from "../lib/chartExport";
import { autoDetectSeriesForOrientation } from "../lib/chartDataReader";
import { resolveDataSource } from "../lib/dataSourceResolver";

// ============================================================================
// Styles (band-designed widgets kept from the former ChartDesignTab)
// ============================================================================

const s = {
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

  // -- Select dropdowns --
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
  { value: "treemap", label: "Treemap" },
  { value: "stock", label: "Stock" },
  { value: "boxPlot", label: "Box & Whisker" },
  { value: "sunburst", label: "Sunburst" },
  { value: "pareto", label: "Pareto" },
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

function SaveImageIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 20 20" fill="none">
      {/* Image frame */}
      <rect x="2" y="3" width="16" height="14" rx="1.5" stroke="#4472C4" strokeWidth="1.5" fill="#EAF0F9" />
      {/* Mountain/landscape */}
      <path d="M2 14 L7 9 L10 12 L13 8 L18 14 L18 16 L2 16 Z" fill="#4472C4" opacity="0.5" />
      {/* Sun */}
      <circle cx="14" cy="7" r="2" fill="#ED7D31" />
      {/* Download arrow overlay */}
      <path d="M10 11 L10 16" stroke="#333" strokeWidth="1.5" strokeLinecap="round" />
      <path d="M7.5 14 L10 16.5 L12.5 14" stroke="#333" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function SwitchRowColIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 20 20" fill="none">
      {/* Horizontal arrow (row) */}
      <path d="M3 7 L11 7" stroke="#4472C4" strokeWidth="1.8" strokeLinecap="round" />
      <path d="M9 5 L11.5 7 L9 9" stroke="#4472C4" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
      {/* Vertical arrow (column) */}
      <path d="M13 17 L13 9" stroke="#ED7D31" strokeWidth="1.8" strokeLinecap="round" />
      <path d="M11 11 L13 8.5 L15 11" stroke="#ED7D31" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

// ============================================================================
// Shared design state (per-section replacement for the monolith's state)
// ============================================================================

interface ChartDesignState {
  chartId: string | null;
  spec: ChartSpec | null;
  updateSpec: (updates: Partial<ChartSpec>) => void;
  refreshFromStore: () => void;
}

/**
 * Tracks the selected chart's id + spec and provides the shared spec-update
 * pipeline (store write, cache invalidation, region sync, repaint events).
 * The former monolithic tab held this state once; each section now holds its
 * own copy, kept in sync via CHART_UPDATED. Sub-selection advances and
 * chart-to-chart switches don't fire CHART_UPDATED (the monolith caught them
 * through ambient ribbon re-renders), so sections also subscribe to
 * CHART_SELECTION_CHANGED and force a re-render.
 */
function useChartDesignState(): ChartDesignState {
  const [, forceRender] = useReducer((n: number) => n + 1, 0);
  const [chartId, setChartId] = useState<string | null>(() => getCurrentChartId());
  const [spec, setSpec] = useState<ChartSpec | null>(() => {
    const id = getCurrentChartId();
    return id != null ? getChartById(id)?.spec ?? null : null;
  });

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
    const unsubSelection = onAppEvent(AppEvents.CHART_SELECTION_CHANGED, () => {
      refreshFromStore();
      forceRender();
    });
    return () => {
      window.removeEventListener(ChartEvents.CHART_UPDATED, handleRefresh);
      unsubSelection();
    };
  }, [refreshFromStore]);

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

  return { chartId, spec, updateSpec, refreshFromStore };
}

// ============================================================================
// Type Section: icon-over-text buttons for common types + dropdown
// ============================================================================

export function ChartTypeSection(_props: PanelSectionProps): React.ReactElement | null {
  const { chartId, spec, updateSpec } = useChartDesignState();
  if (!chartId || !spec) return null;

  const isMainType = MAIN_TYPES.some((t) => t.value === spec.mark);

  return (
    <ControlRow gap={6}>
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
    </ControlRow>
  );
}

// ============================================================================
// Chart Elements Section: title, gridlines, legend, axis labels, data labels
// ============================================================================

export function ChartElementsSection(_props: PanelSectionProps): React.ReactElement | null {
  const { chartId, spec, updateSpec } = useChartDesignState();
  if (!chartId || !spec) return null;

  const cartesian = isCartesianChart(spec.mark);

  return (
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
      <label className={s.checkLabel}>
        <input
          type="checkbox"
          checked={spec.dataLabels?.enabled ?? false}
          onChange={(e) => {
            const dl: DataLabelSpec = { ...(spec.dataLabels ?? { enabled: false }), enabled: e.target.checked };
            updateSpec({ dataLabels: dl });
          }}
        />
        Data Labels
      </label>
    </div>
  );
}

// ============================================================================
// Stacking Section: none / stacked / 100% stacked (bar/hbar/line/area only)
// ============================================================================

export function StackingSection(_props: PanelSectionProps): React.ReactElement | null {
  const { chartId, spec, updateSpec } = useChartDesignState();
  if (!chartId || !spec) return null;

  const supportsStacking =
    spec.mark === "bar" || spec.mark === "horizontalBar" || spec.mark === "line" || spec.mark === "area";
  const isCombo = spec.mark === "combo";
  const comboOpts = (isCombo ? spec.markOptions ?? {} : {}) as ComboMarkOptions;
  const hasSecondaryAxis = comboOpts.secondaryYAxis ?? false;
  if (!supportsStacking) return null;

  const currentStackMode = getStackModeFromSpec(spec);

  return (
    <ControlRow gap={6}>
      <select
        className={s.select}
        value={currentStackMode}
        onChange={(e) => {
          const mode = e.target.value as StackMode;
          updateSpec({ markOptions: setStackModeInOptions(spec, mode) });
        }}
      >
        <option value="none">Grouped</option>
        <option value="stacked">Stacked</option>
        <option value="percentStacked">100% Stacked</option>
      </select>
      {isCombo && (
        <label className={s.checkLabel}>
          <input
            type="checkbox"
            checked={hasSecondaryAxis}
            onChange={(e) => {
              const opts = { ...comboOpts, secondaryYAxis: e.target.checked };
              updateSpec({ markOptions: opts });
            }}
          />
          2nd Axis
        </label>
      )}
    </ControlRow>
  );
}

// ============================================================================
// Axes Section: secondary axis toggle for combo charts (no stacking support)
// ============================================================================

export function AxesSection(_props: PanelSectionProps): React.ReactElement | null {
  const { chartId, spec, updateSpec } = useChartDesignState();
  if (!chartId || !spec) return null;

  const supportsStacking =
    spec.mark === "bar" || spec.mark === "horizontalBar" || spec.mark === "line" || spec.mark === "area";
  const isCombo = spec.mark === "combo";
  if (supportsStacking || !isCombo) return null;

  const comboOpts = (spec.markOptions ?? {}) as ComboMarkOptions;
  const hasSecondaryAxis = comboOpts.secondaryYAxis ?? false;

  return (
    <ControlRow gap={6}>
      <label className={s.checkLabel}>
        <input
          type="checkbox"
          checked={hasSecondaryAxis}
          onChange={(e) => {
            const opts = { ...comboOpts, secondaryYAxis: e.target.checked };
            updateSpec({ markOptions: opts });
          }}
        />
        Secondary Axis
      </label>
    </ControlRow>
  );
}

// ============================================================================
// Trendline Section: type selector + equation / R-squared toggles
// ============================================================================

export function TrendlineSection(_props: PanelSectionProps): React.ReactElement | null {
  const { chartId, spec, updateSpec } = useChartDesignState();
  if (!chartId || !spec) return null;

  const cartesian = isCartesianChart(spec.mark);
  const supportsTrendline = cartesian && spec.mark !== "waterfall" && spec.mark !== "histogram";
  if (!supportsTrendline) return null;

  const currentTrendline: TrendlineSpec | null = spec.trendlines?.[0] ?? null;

  return (
    <ControlRow gap={6}>
      <select
        className={s.select}
        value={currentTrendline?.type ?? "none"}
        onChange={(e) => {
          const type = e.target.value;
          if (type === "none") {
            updateSpec({ trendlines: [] });
          } else {
            const tl: TrendlineSpec = {
              type: type as TrendlineType,
              seriesIndex: currentTrendline?.seriesIndex ?? 0,
              ...(type === "polynomial" ? { polynomialDegree: currentTrendline?.polynomialDegree ?? 2 } : {}),
              ...(type === "movingAverage" ? { movingAveragePeriod: currentTrendline?.movingAveragePeriod ?? 3 } : {}),
            };
            updateSpec({ trendlines: [tl] });
          }
        }}
      >
        <option value="none">None</option>
        <option value="linear">Linear</option>
        <option value="exponential">Exponential</option>
        <option value="polynomial">Polynomial</option>
        <option value="logarithmic">Logarithmic</option>
        <option value="power">Power</option>
        <option value="movingAverage">Moving Avg</option>
      </select>
      {currentTrendline && (
        <label className={s.checkLabel}>
          <input
            type="checkbox"
            checked={currentTrendline.showEquation ?? false}
            onChange={(e) => {
              updateSpec({
                trendlines: [{ ...currentTrendline, showEquation: e.target.checked }],
              });
            }}
          />
          Equation
        </label>
      )}
      {currentTrendline && (
        <label className={s.checkLabel}>
          <input
            type="checkbox"
            checked={currentTrendline.showRSquared ?? false}
            onChange={(e) => {
              updateSpec({
                trendlines: [{ ...currentTrendline, showRSquared: e.target.checked }],
              });
            }}
          />
          R<sup>2</sup>
        </label>
      )}
    </ControlRow>
  );
}

// ============================================================================
// Colors Section: palette swatches
// ============================================================================

export function ColorsSection(_props: PanelSectionProps): React.ReactElement | null {
  const { chartId, spec, updateSpec } = useChartDesignState();
  if (!chartId || !spec) return null;

  return (
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
  );
}

// ============================================================================
// Legend Section: position selector + chart title input
// ============================================================================

export function LegendSection(_props: PanelSectionProps): React.ReactElement | null {
  const { chartId, spec, updateSpec } = useChartDesignState();
  if (!chartId || !spec) return null;

  return (
    <ControlRow gap={6}>
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
        <Input
          type="text"
          width={130}
          value={spec.title}
          onChange={(e) => updateSpec({ title: e.target.value || null })}
          placeholder="Chart title"
        />
      )}
    </ControlRow>
  );
}

// ============================================================================
// Filter Section: series/category visibility dropdown
// ============================================================================

export function FilterSection(_props: PanelSectionProps): React.ReactElement | null {
  const { chartId, spec, updateSpec } = useChartDesignState();
  if (!chartId || !spec) return null;

  return (
    <ControlRow gap={6}>
      <ChartFilterDropdown
        spec={spec}
        unfilteredData={chartId != null ? getCachedChartData(chartId)?.unfilteredData : undefined}
        onFiltersChange={(newFilters: ChartFilters) => {
          updateSpec({ filters: newFilters });
        }}
      />
    </ControlRow>
  );
}

// ============================================================================
// Actions Section: Switch Row/Col, Edit Chart, Save Image, Format Point
// ============================================================================

export function ActionsSection(_props: PanelSectionProps): React.ReactElement | null {
  const { chartId, spec, updateSpec } = useChartDesignState();
  if (!chartId || !spec) return null;

  const isPivot = isPivotDataSource(spec.data);

  return (
    <ActionRow gap={6}>
      {!isPivot && (
        <button
          className={s.actionBtn}
          onClick={async () => {
            if (chartId == null || !spec) return;
            try {
              const dataRef = await resolveDataSource(spec.data);
              const newOrientation: SeriesOrientation =
                spec.seriesOrientation === "columns" ? "rows" : "columns";
              const detected = await autoDetectSeriesForOrientation(
                dataRef, spec.hasHeaders, newOrientation,
              );
              updateSpec({
                seriesOrientation: newOrientation,
                categoryIndex: detected.categoryIndex,
                series: detected.series,
                seriesRefs: undefined,
              });
            } catch (err) {
              console.error("[Charts] Switch Row/Column failed:", err);
            }
          }}
          title="Switch between rows and columns as data series"
        >
          <span className={s.actionIcon}><SwitchRowColIcon /></span>
          Switch Row/Col
        </button>
      )}
      <button
        className={s.actionBtn}
        onClick={() => {
          if (isPivot) {
            const pivotId = (spec.data as { pivotId: string }).pivotId;
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
      <button
        className={s.actionBtn}
        onClick={async () => {
          if (chartId == null) return;
          try {
            await exportChartAsImage(chartId);
          } catch (err) {
            console.error("[Charts] Export failed:", err);
            alert("Failed to export chart: " + String(err));
          }
        }}
        title="Save chart as PNG image"
      >
        <span className={s.actionIcon}><SaveImageIcon /></span>
        Save Image
      </button>
      {(() => {
        const subSel = getSubSelection();
        if (subSel.level === "dataPoint" && chartId != null) {
          const isPieOrDonut = spec.mark === "pie" || spec.mark === "donut";
          const cachedData = getCachedChartData(chartId);
          // subSel indices are PAINTER (post-filter) space; the painted point's
          // label is in the same space (the filtered data's categories).
          const categoryName = cachedData?.data?.categories?.[subSel.categoryIndex ?? 0] ?? "";
          // dataPointOverrides are keyed in AUTHORING (unfiltered) space — translate
          // the painter sub-selection so the override anchors to the right datum
          // even with a series/category filter active.
          const authoring = cachedData
            ? toAuthoringIndices(cachedData.data, subSel.seriesIndex ?? 0, subSel.categoryIndex ?? 0)
            : { seriesIndex: subSel.seriesIndex ?? 0, categoryIndex: subSel.categoryIndex ?? 0 };
          return (
            <button
              className={s.actionBtn}
              onClick={() => {
                showDialog("chart:dataPointFormat", {
                  chartId,
                  seriesIndex: authoring.seriesIndex,
                  categoryIndex: authoring.categoryIndex,
                  categoryName,
                  isPieOrDonut,
                });
              }}
              title="Format the selected data point"
            >
              <span className={s.actionIcon}>&#127912;</span>
              Format Point
            </button>
          );
        }
        return null;
      })()}
    </ActionRow>
  );
}

// ============================================================================
// JSON Section: GUI/JSON toggle (Phase C)
// ============================================================================

export function JsonSection(_props: PanelSectionProps): React.ReactElement | null {
  const { chartId, refreshFromStore } = useChartDesignState();

  const jsonToggle = useJsonToggle(
    "chart",
    chartId != null ? String(chartId) : "",
    refreshFromStore,
  );

  if (!chartId) return null;

  return (
    <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 4, padding: "2px 6px" }}>
      <JsonToggleButton isActive={jsonToggle.isJsonMode} onClick={jsonToggle.toggle} />
      {jsonToggle.isJsonMode && (
        <div style={{ position: "fixed", right: 8, top: 140, width: 420, height: 400, zIndex: 500, border: "1px solid #555", borderRadius: 6, overflow: "hidden", boxShadow: "0 4px 16px rgba(0,0,0,0.4)" }}>
          <JsonToggleEditor
            json={jsonToggle.json}
            onChange={jsonToggle.setJson}
            onApply={jsonToggle.apply}
            onRevert={jsonToggle.revert}
            dirty={jsonToggle.dirty}
            error={jsonToggle.error}
            loading={jsonToggle.loading}
          />
        </div>
      )}
    </div>
  );
}

// ============================================================================
// Section list builder
// ============================================================================

/**
 * Build the section list for the currently selected chart. The former tab
 * rendered the Stacking/Axes/Trendline groups conditionally on the chart type;
 * with shell-owned sections that conditionality moves here — the selection
 * handler re-registers the panel when the applicable set changes (see
 * handlers/selectionHandler.ts). collapsePriority values carry over the old
 * GROUP_DEFS collapseOrder semantics (lower collapses to a launcher first).
 */
export function buildChartDesignSections(): PanelSection[] {
  const chartId = getCurrentChartId();
  const spec = chartId != null ? getChartById(chartId)?.spec ?? null : null;

  const supportsStacking =
    spec != null &&
    (spec.mark === "bar" || spec.mark === "horizontalBar" || spec.mark === "line" || spec.mark === "area");
  const isCombo = spec?.mark === "combo";
  const cartesian = spec != null && isCartesianChart(spec.mark);
  const supportsTrendline =
    spec != null && cartesian && spec.mark !== "waterfall" && spec.mark !== "histogram";

  const sections: PanelSection[] = [
    {
      id: `${CHART_DESIGN_TAB_ID}.type`,
      label: "Chart Type",
      component: ChartTypeSection,
      ribbonPresentation: "inline",
      collapsePriority: 6,
    },
    {
      id: `${CHART_DESIGN_TAB_ID}.elements`,
      label: "Chart Elements",
      component: ChartElementsSection,
      ribbonPresentation: "auto",
      collapsePriority: 5,
    },
  ];

  if (supportsStacking) {
    sections.push({
      id: `${CHART_DESIGN_TAB_ID}.stacking`,
      label: "Stacking",
      component: StackingSection,
      ribbonPresentation: "auto",
      collapsePriority: 2,
    });
  } else if (isCombo) {
    sections.push({
      id: `${CHART_DESIGN_TAB_ID}.axes`,
      label: "Axes",
      component: AxesSection,
      ribbonPresentation: "auto",
      collapsePriority: 2,
    });
  }

  if (supportsTrendline) {
    sections.push({
      id: `${CHART_DESIGN_TAB_ID}.trendline`,
      label: "Trendline",
      component: TrendlineSection,
      ribbonPresentation: "auto",
      collapsePriority: 1,
    });
  }

  sections.push(
    {
      id: `${CHART_DESIGN_TAB_ID}.colors`,
      label: "Colors",
      component: ColorsSection,
      ribbonPresentation: "inline",
      collapsePriority: 4,
    },
    {
      id: `${CHART_DESIGN_TAB_ID}.legend`,
      label: "Legend",
      component: LegendSection,
      ribbonPresentation: "auto",
      collapsePriority: 3,
    },
    {
      id: `${CHART_DESIGN_TAB_ID}.filter`,
      label: "Filter",
      component: FilterSection,
      ribbonPresentation: "inline",
      collapsePriority: 8,
    },
    {
      id: `${CHART_DESIGN_TAB_ID}.actions`,
      label: "Actions",
      component: ActionsSection,
      ribbonPresentation: "auto",
      collapsePriority: 7,
    },
    // The old tab hardcoded the JSON group as never-collapsing; a very high
    // collapsePriority keeps it inline until every other section is a launcher.
    {
      id: `${CHART_DESIGN_TAB_ID}.json`,
      label: "JSON",
      component: JsonSection,
      ribbonPresentation: "inline",
      collapsePriority: 100,
    },
  );

  return sections;
}

// ============================================================================
// Stack Mode Helpers
// ============================================================================

/** Read the current stack mode from spec.markOptions based on chart type. */
function getStackModeFromSpec(spec: ChartSpec): StackMode {
  const opts = spec.markOptions ?? {};
  switch (spec.mark) {
    case "bar":
    case "horizontalBar":
      return (opts as BarMarkOptions).stackMode ?? "none";
    case "line":
      return (opts as LineMarkOptions).stackMode ?? "none";
    case "area": {
      const areaOpts = opts as AreaMarkOptions;
      return areaOpts.stackMode ?? (areaOpts.stacked ? "stacked" : "none");
    }
    default:
      return "none";
  }
}

/** Create updated markOptions with a new stack mode, preserving other fields. */
function setStackModeInOptions(spec: ChartSpec, mode: StackMode): BarMarkOptions | LineMarkOptions | AreaMarkOptions {
  const opts = spec.markOptions ?? {};
  switch (spec.mark) {
    case "bar":
    case "horizontalBar":
      return { ...(opts as BarMarkOptions), stackMode: mode };
    case "line":
      return { ...(opts as LineMarkOptions), stackMode: mode };
    case "area":
      return { ...(opts as AreaMarkOptions), stackMode: mode, stacked: mode !== "none" };
    default:
      return opts as BarMarkOptions;
  }
}
