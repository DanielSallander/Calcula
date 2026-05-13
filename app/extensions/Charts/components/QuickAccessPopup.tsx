//! FILENAME: app/extensions/Charts/components/QuickAccessPopup.tsx
// PURPOSE: Popup panel for Quick Access Buttons (Elements, Styles, Filters).
// CONTEXT: Rendered as an overlay when a quick access button is clicked.
//          Positioned next to the buttons, shows contextual controls.

import React, { useState, useEffect, useCallback, useRef } from "react";
import { css } from "@emotion/css";
import type { OverlayProps } from "@api/uiTypes";
import { emitAppEvent, AppEvents } from "@api/events";

import type { ChartSpec, ChartFilters } from "../types";
import { getChartById, updateChartSpec, syncChartRegions } from "../lib/chartStore";
import { invalidateChartCache, getCachedChartData } from "../rendering/chartRenderer";
import { closePopup } from "../rendering/quickAccessButtons";
import { PALETTES, PALETTE_NAMES } from "../rendering/chartTheme";
import { ChartEvents } from "../lib/chartEvents";

// ============================================================================
// Styles
// ============================================================================

const styles = {
  panel: css`
    position: fixed;
    z-index: 2000;
    background: #fff;
    border: 1px solid #ccc;
    border-radius: 6px;
    box-shadow: 0 4px 16px rgba(0, 0, 0, 0.18);
    min-width: 200px;
    max-height: 400px;
    overflow-y: auto;
    padding: 8px 0;
    font-size: 12px;
    font-family: "Segoe UI Variable", "Segoe UI", system-ui, sans-serif;
  `,
  section: css`
    padding: 4px 12px;
  `,
  sectionTitle: css`
    font-weight: 600;
    font-size: 11px;
    color: #555;
    text-transform: uppercase;
    letter-spacing: 0.3px;
    margin-bottom: 4px;
  `,
  item: css`
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 4px 12px;
    cursor: pointer;

    &:hover {
      background: #f0f0f0;
    }

    input {
      cursor: pointer;
      margin: 0;
    }

    label {
      cursor: pointer;
      flex: 1;
    }
  `,
  divider: css`
    border-top: 1px solid #e8e8e8;
    margin: 4px 0;
  `,
  paletteRow: css`
    display: flex;
    gap: 4px;
    padding: 3px 12px;
    cursor: pointer;
    border-radius: 3px;

    &:hover {
      background: #f0f0f0;
    }
  `,
  paletteRowActive: css`
    display: flex;
    gap: 4px;
    padding: 3px 12px;
    cursor: pointer;
    border-radius: 3px;
    background: #e0ecf8;
    border: 1px solid #a0c0e0;
  `,
  colorSwatch: css`
    width: 16px;
    height: 12px;
    border-radius: 2px;
  `,
  filterItem: css`
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 3px 12px;
    cursor: pointer;
    white-space: nowrap;

    &:hover {
      background: #f0f0f0;
    }

    input {
      cursor: pointer;
      margin: 0;
    }

    label {
      cursor: pointer;
      flex: 1;
      overflow: hidden;
      text-overflow: ellipsis;
    }
  `,
  seriesSwatch: css`
    width: 10px;
    height: 10px;
    border-radius: 2px;
    flex-shrink: 0;
  `,
  selectAll: css`
    font-size: 10px;
    color: #005fb8;
    cursor: pointer;
    font-weight: normal;
    text-transform: none;
    letter-spacing: normal;
    display: inline-block;
    margin-left: 8px;

    &:hover {
      text-decoration: underline;
    }
  `,
};

// ============================================================================
// Component
// ============================================================================

export function QuickAccessPopup({ onClose, data }: OverlayProps): React.ReactElement | null {
  const chartId = data?.chartId as number | undefined;
  const buttonType = data?.buttonType as string | undefined;
  const screenX = data?.screenX as number | undefined;
  const screenY = data?.screenY as number | undefined;

  const panelRef = useRef<HTMLDivElement>(null);
  const [, forceUpdate] = useState(0);

  const chart = chartId != null ? getChartById(chartId) : undefined;
  const spec = chart?.spec;

  // Close on outside click
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (panelRef.current && !panelRef.current.contains(e.target as Node)) {
        closePopup();
        onClose();
      }
    };
    // Delay to avoid closing immediately from the click that opened us
    const timer = setTimeout(() => {
      document.addEventListener("mousedown", handler, true);
    }, 100);
    return () => {
      clearTimeout(timer);
      document.removeEventListener("mousedown", handler, true);
    };
  }, [onClose]);

  // Close on Escape
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        closePopup();
        onClose();
      }
    };
    document.addEventListener("keydown", handler, true);
    return () => document.removeEventListener("keydown", handler, true);
  }, [onClose]);

  // Close on chart deselection
  useEffect(() => {
    const handler = () => {
      closePopup();
      onClose();
    };
    window.addEventListener("chart:quickAccessPopup", (e: Event) => {
      const detail = (e as CustomEvent).detail;
      if (!detail) {
        // Popup was closed
        onClose();
      }
    });
    return () => {};
  }, [onClose]);

  const updateSpec = useCallback(
    (updates: Partial<ChartSpec>) => {
      if (chartId == null) return;
      updateChartSpec(chartId, updates);
      invalidateChartCache(chartId);
      syncChartRegions();
      window.dispatchEvent(new Event(ChartEvents.CHART_UPDATED));
      emitAppEvent(AppEvents.GRID_REFRESH);
      forceUpdate((c) => c + 1);
    },
    [chartId],
  );

  if (!spec || !chartId || !buttonType || screenX == null || screenY == null) return null;

  const panelStyle: React.CSSProperties = {
    left: screenX + 34,
    top: screenY,
  };

  return (
    <div ref={panelRef} className={styles.panel} style={panelStyle}>
      {buttonType === "elements" && <ElementsPanel spec={spec} updateSpec={updateSpec} />}
      {buttonType === "styles" && <StylesPanel spec={spec} updateSpec={updateSpec} />}
      {buttonType === "filters" && <FiltersPanel spec={spec} chartId={chartId} updateSpec={updateSpec} />}
    </div>
  );
}

// ============================================================================
// Elements Panel (+)
// ============================================================================

function ElementsPanel({
  spec,
  updateSpec,
}: {
  spec: ChartSpec;
  updateSpec: (u: Partial<ChartSpec>) => void;
}): React.ReactElement {
  return (
    <>
      <div className={styles.section}>
        <div className={styles.sectionTitle}>Chart Elements</div>
      </div>
      <div className={styles.item} onClick={() => updateSpec({ title: spec.title ? null : "Chart" })}>
        <input type="checkbox" checked={spec.title !== null} onChange={() => {}} />
        <label>Chart Title</label>
      </div>
      <div className={styles.item} onClick={() => updateSpec({ xAxis: { ...spec.xAxis, title: spec.xAxis.title ? null : "X Axis" } })}>
        <input type="checkbox" checked={spec.xAxis.title !== null} onChange={() => {}} />
        <label>X Axis Title</label>
      </div>
      <div className={styles.item} onClick={() => updateSpec({ yAxis: { ...spec.yAxis, title: spec.yAxis.title ? null : "Y Axis" } })}>
        <input type="checkbox" checked={spec.yAxis.title !== null} onChange={() => {}} />
        <label>Y Axis Title</label>
      </div>
      <div className={styles.divider} />
      <div className={styles.item} onClick={() => updateSpec({ legend: { ...spec.legend, visible: !spec.legend.visible } })}>
        <input type="checkbox" checked={spec.legend.visible} onChange={() => {}} />
        <label>Legend</label>
      </div>
      <div className={styles.item} onClick={() => updateSpec({ yAxis: { ...spec.yAxis, gridLines: !spec.yAxis.gridLines } })}>
        <input type="checkbox" checked={spec.yAxis.gridLines} onChange={() => {}} />
        <label>Gridlines</label>
      </div>
      <div className={styles.item} onClick={() => updateSpec({ xAxis: { ...spec.xAxis, showLabels: !spec.xAxis.showLabels } })}>
        <input type="checkbox" checked={spec.xAxis.showLabels !== false} onChange={() => {}} />
        <label>Axis Labels</label>
      </div>
      <div className={styles.divider} />
      <div className={styles.item} onClick={() => {
        const current = spec.dataLabels?.enabled ?? false;
        updateSpec({ dataLabels: { ...(spec.dataLabels ?? {}), enabled: !current } as any });
      }}>
        <input type="checkbox" checked={spec.dataLabels?.enabled ?? false} onChange={() => {}} />
        <label>Data Labels</label>
      </div>
      <div className={styles.item} onClick={() => {
        const current = spec.dataTable?.enabled ?? false;
        updateSpec({ dataTable: { ...(spec.dataTable ?? {}), enabled: !current } as any });
      }}>
        <input type="checkbox" checked={spec.dataTable?.enabled ?? false} onChange={() => {}} />
        <label>Data Table</label>
      </div>
    </>
  );
}

// ============================================================================
// Styles Panel (Paintbrush)
// ============================================================================

function StylesPanel({
  spec,
  updateSpec,
}: {
  spec: ChartSpec;
  updateSpec: (u: Partial<ChartSpec>) => void;
}): React.ReactElement {
  return (
    <>
      <div className={styles.section}>
        <div className={styles.sectionTitle}>Color Palette</div>
      </div>
      {PALETTE_NAMES.map((name) => {
        const colors = PALETTES[name];
        if (!colors) return null;
        const isActive = spec.palette === name;

        return (
          <div
            key={name}
            className={isActive ? styles.paletteRowActive : styles.paletteRow}
            onClick={() => updateSpec({ palette: name })}
            title={name}
          >
            {colors.slice(0, 6).map((color, i) => (
              <span
                key={i}
                className={styles.colorSwatch}
                style={{ backgroundColor: color }}
              />
            ))}
          </div>
        );
      })}
    </>
  );
}

// ============================================================================
// Filters Panel (Funnel)
// ============================================================================

function FiltersPanel({
  spec,
  chartId,
  updateSpec,
}: {
  spec: ChartSpec;
  chartId: number;
  updateSpec: (u: Partial<ChartSpec>) => void;
}): React.ReactElement {
  const cachedData = getCachedChartData(chartId);
  const unfilteredData = cachedData?.unfilteredData;

  const filters = spec.filters ?? { hiddenSeries: [], hiddenCategories: [] };
  const hiddenSeriesSet = new Set(filters.hiddenSeries ?? []);
  const hiddenCategoriesSet = new Set(filters.hiddenCategories ?? []);

  const allSeries = unfilteredData?.series ?? [];
  const allCategories = unfilteredData?.categories ?? [];

  const setFilters = (newFilters: ChartFilters) => updateSpec({ filters: newFilters });

  const toggleSeries = (i: number) => {
    const newHidden = new Set(hiddenSeriesSet);
    if (newHidden.has(i)) newHidden.delete(i); else newHidden.add(i);
    setFilters({ hiddenSeries: Array.from(newHidden), hiddenCategories: filters.hiddenCategories ?? [] });
  };

  const toggleCategory = (i: number) => {
    const newHidden = new Set(hiddenCategoriesSet);
    if (newHidden.has(i)) newHidden.delete(i); else newHidden.add(i);
    setFilters({ hiddenSeries: filters.hiddenSeries ?? [], hiddenCategories: Array.from(newHidden) });
  };

  return (
    <>
      {allSeries.length > 0 && (
        <>
          <div className={styles.section}>
            <div className={styles.sectionTitle}>
              Series
              {hiddenSeriesSet.size > 0 && (
                <span className={styles.selectAll} onClick={() => setFilters({ hiddenSeries: [], hiddenCategories: filters.hiddenCategories ?? [] })}>
                  Show All
                </span>
              )}
            </div>
          </div>
          {allSeries.map((series, i) => (
            <div key={`s-${i}`} className={styles.filterItem} onClick={() => toggleSeries(i)}>
              <input type="checkbox" checked={!hiddenSeriesSet.has(i)} onChange={() => {}} />
              {series.color && <span className={styles.seriesSwatch} style={{ backgroundColor: series.color }} />}
              <label>{series.name || `Series ${i + 1}`}</label>
            </div>
          ))}
        </>
      )}

      {allSeries.length > 0 && allCategories.length > 0 && <div className={styles.divider} />}

      {allCategories.length > 0 && allCategories.length <= 50 && (
        <>
          <div className={styles.section}>
            <div className={styles.sectionTitle}>
              Categories
              {hiddenCategoriesSet.size > 0 && (
                <span className={styles.selectAll} onClick={() => setFilters({ hiddenSeries: filters.hiddenSeries ?? [], hiddenCategories: [] })}>
                  Show All
                </span>
              )}
            </div>
          </div>
          {allCategories.map((cat, i) => (
            <div key={`c-${i}`} className={styles.filterItem} onClick={() => toggleCategory(i)}>
              <input type="checkbox" checked={!hiddenCategoriesSet.has(i)} onChange={() => {}} />
              <label>{cat || "(empty)"}</label>
            </div>
          ))}
        </>
      )}

      {(hiddenSeriesSet.size > 0 || hiddenCategoriesSet.size > 0) && (
        <>
          <div className={styles.divider} />
          <div className={styles.section}>
            <span
              className={styles.selectAll}
              onClick={() => setFilters({ hiddenSeries: [], hiddenCategories: [] })}
              style={{ fontSize: 11, fontWeight: 600 }}
            >
              Clear All Filters
            </span>
          </div>
        </>
      )}
    </>
  );
}
