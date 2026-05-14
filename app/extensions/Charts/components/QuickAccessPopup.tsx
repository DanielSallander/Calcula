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
import { CHART_STYLE_PRESETS, getPresetColors, buildPresetUpdates, type ChartStylePreset } from "../lib/chartStylePresets";

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

      {/* Line/area chart specific options */}
      {(spec.mark === "line" || spec.mark === "area") && (
        <>
          <div className={styles.divider} />
          <div className={styles.item} onClick={() => {
            const opts = (spec.markOptions ?? {}) as Record<string, unknown>;
            updateSpec({ markOptions: { ...opts, showDropLines: !opts.showDropLines } as any });
          }}>
            <input type="checkbox" checked={(spec.markOptions as any)?.showDropLines ?? false} onChange={() => {}} />
            <label>Drop Lines</label>
          </div>
        </>
      )}
      {spec.mark === "line" && (
        <>
          <div className={styles.item} onClick={() => {
            const opts = (spec.markOptions ?? {}) as Record<string, unknown>;
            updateSpec({ markOptions: { ...opts, showHighLowLines: !opts.showHighLowLines } as any });
          }}>
            <input type="checkbox" checked={(spec.markOptions as any)?.showHighLowLines ?? false} onChange={() => {}} />
            <label>High-Low Lines</label>
          </div>
          <div className={styles.item} onClick={() => {
            const opts = (spec.markOptions ?? {}) as Record<string, unknown>;
            updateSpec({ markOptions: { ...opts, showUpDownBars: !opts.showUpDownBars } as any });
          }}>
            <input type="checkbox" checked={(spec.markOptions as any)?.showUpDownBars ?? false} onChange={() => {}} />
            <label>Up/Down Bars</label>
          </div>
        </>
      )}
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
  const categories: Array<{ key: string; label: string }> = [
    { key: "colorful", label: "Colorful" },
    { key: "monochromatic", label: "Monochromatic" },
    { key: "dark", label: "Dark" },
    { key: "outline", label: "Flat & Outline" },
    { key: "gradient", label: "Gradient" },
  ];

  return (
    <>
      {categories.map(({ key, label }) => {
        const presets = CHART_STYLE_PRESETS.filter((p) => p.category === key);
        if (presets.length === 0) return null;
        return (
          <React.Fragment key={key}>
            <div className={styles.section}>
              <div className={styles.sectionTitle}>{label}</div>
            </div>
            <div style={{ display: "flex", flexWrap: "wrap", gap: 4, padding: "2px 12px 6px" }}>
              {presets.map((preset) => {
                const colors = getPresetColors(preset);
                const bg = preset.theme.background ?? "#fff";
                const isActive = spec.palette === preset.palette &&
                  spec.config?.theme?.background === preset.theme.background;
                return (
                  <div
                    key={preset.id}
                    title={preset.name}
                    onClick={() => {
                      const updates = buildPresetUpdates(preset, spec);
                      updateSpec(updates as Partial<ChartSpec>);
                    }}
                    style={{
                      width: 42,
                      height: 32,
                      borderRadius: 3,
                      border: isActive ? "2px solid #005fb8" : "1px solid #ccc",
                      background: bg,
                      cursor: "pointer",
                      display: "flex",
                      alignItems: "flex-end",
                      justifyContent: "center",
                      gap: 1,
                      padding: "3px 2px",
                    }}
                  >
                    {colors.slice(0, 4).map((c, i) => (
                      <span
                        key={i}
                        style={{
                          width: 7,
                          height: [16, 22, 12, 20][i],
                          backgroundColor: c,
                          borderRadius: preset.barBorderRadius > 0 ? `${Math.min(preset.barBorderRadius, 3)}px ${Math.min(preset.barBorderRadius, 3)}px 0 0` : 0,
                        }}
                      />
                    ))}
                  </div>
                );
              })}
            </div>
          </React.Fragment>
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
