//! FILENAME: app/extensions/Charts/components/tabs/DesignTab.tsx
// PURPOSE: Design tab of the chart dialog. Chart type, title, axis, legend, palette, mark options.

import React from "react";
import type { ChartSpec, ChartType, ChartMark, DataLabelSpec, DataTableOptions, ErrorBarOptions, BoxPlotMarkOptions, SunburstMarkOptions, ParetoMarkOptions } from "../../types";
import { isCartesianChart } from "../../types";
import { listChartMarks, getChartMarkMeta } from "@api/chartMarks";
import { PALETTES, PALETTE_NAMES, getSeriesColor } from "../../rendering/chartTheme";
import {
  FieldGroup,
  Label,
  Input,
  Select,
  CheckboxLabel,
  PalettePreview,
  PaletteSwatch,
  DesignGrid,
} from "../CreateChartDialog.styles";

interface DesignTabProps {
  spec: ChartSpec;
  onSpecChange: (updates: Partial<ChartSpec>) => void;
  /** Series names from the live preview data — drives the per-series color
   *  pickers (works for range, pivot, and design-query sources alike). */
  previewSeriesNames?: string[];
}

/** Built-in chart types with display names (the canonical, always-present list). */
const CHART_TYPES: Array<{ value: ChartType; label: string }> = [
  { value: "bar", label: "Bar Chart" },
  { value: "horizontalBar", label: "Horizontal Bar Chart" },
  { value: "line", label: "Line Chart" },
  { value: "area", label: "Area Chart" },
  { value: "scatter", label: "Scatter Plot" },
  { value: "pie", label: "Pie Chart" },
  { value: "donut", label: "Donut Chart" },
  { value: "waterfall", label: "Waterfall Chart" },
  { value: "combo", label: "Combo Chart" },
  { value: "radar", label: "Radar Chart" },
  { value: "bubble", label: "Bubble Chart" },
  { value: "histogram", label: "Histogram" },
  { value: "funnel", label: "Funnel Chart" },
  { value: "treemap", label: "Treemap" },
  { value: "stock", label: "Stock (OHLC)" },
  { value: "boxPlot", label: "Box & Whisker" },
  { value: "sunburst", label: "Sunburst" },
  { value: "pareto", label: "Pareto" },
];

/**
 * Chart-type options for the picker: the built-ins (always present) plus any
 * custom marks registered via the @api chart-mark registry, appended.
 */
function chartTypeOptions(): Array<{ value: string; label: string }> {
  const builtinValues = new Set<string>(CHART_TYPES.map((t) => t.value));
  const custom = listChartMarks()
    .filter((m) => !builtinValues.has(m))
    .map((m) => ({ value: m, label: getChartMarkMeta(m)?.label ?? m }));
  return [...CHART_TYPES, ...custom];
}

export function DesignTab({ spec, onSpecChange, previewSeriesNames }: DesignTabProps): React.ReactElement {
  const cartesian = isCartesianChart(spec.mark);

  return (
    <DesignGrid>
      {/* Chart Type */}
      <FieldGroup>
        <Label>Chart Type</Label>
        <Select
          value={spec.mark}
          onChange={(e) => onSpecChange({ mark: e.target.value as ChartMark })}
        >
          {chartTypeOptions().map(({ value, label }) => (
            <option key={value} value={value}>
              {label}
            </option>
          ))}
        </Select>
      </FieldGroup>

      {/* Title */}
      <FieldGroup>
        <Label>Chart Title</Label>
        <Input
          type="text"
          value={spec.title ?? ""}
          onChange={(e) =>
            onSpecChange({ title: e.target.value || null })
          }
          placeholder="Enter chart title (optional)"
        />
      </FieldGroup>

      {/* Mark-specific options */}
      <MarkOptions spec={spec} onSpecChange={onSpecChange} />

      {/* X Axis (cartesian only) */}
      {cartesian && (
        <FieldGroup>
          <Label>X Axis</Label>
          <CheckboxLabel>
            <input
              type="checkbox"
              checked={spec.xAxis.showLabels}
              onChange={(e) =>
                onSpecChange({
                  xAxis: { ...spec.xAxis, showLabels: e.target.checked },
                })
              }
            />
            Show labels
          </CheckboxLabel>
          {spec.xAxis.showLabels && (
            <div style={{ display: "flex", alignItems: "center", gap: "8px", marginBottom: "4px" }}>
              <span style={{ fontSize: "12px", color: "var(--text-secondary)" }}>Label angle:</span>
              <Select
                value={spec.xAxis.labelAngle}
                onChange={(e) =>
                  onSpecChange({
                    xAxis: { ...spec.xAxis, labelAngle: parseInt(e.target.value, 10) },
                  })
                }
              >
                <option value={0}>Horizontal</option>
                <option value={45}>45 degrees</option>
                <option value={90}>Vertical</option>
              </Select>
            </div>
          )}
          <div style={{ display: "flex", alignItems: "center", gap: "8px", marginBottom: "4px" }}>
            <span style={{ fontSize: "12px", color: "var(--text-secondary)" }}>Title:</span>
            <Input
              type="text"
              value={spec.xAxis.title ?? ""}
              placeholder="auto"
              onChange={(e) =>
                onSpecChange({ xAxis: { ...spec.xAxis, title: e.target.value || null } })
              }
              style={{ width: "160px" }}
            />
          </div>
        </FieldGroup>
      )}

      {/* Y Axis (cartesian only) */}
      {cartesian && (
        <FieldGroup>
          <Label>Y Axis</Label>
          <CheckboxLabel>
            <input
              type="checkbox"
              checked={spec.yAxis.showLabels}
              onChange={(e) =>
                onSpecChange({
                  yAxis: { ...spec.yAxis, showLabels: e.target.checked },
                })
              }
            />
            Show labels
          </CheckboxLabel>
          <CheckboxLabel>
            <input
              type="checkbox"
              checked={spec.yAxis.gridLines}
              onChange={(e) =>
                onSpecChange({
                  yAxis: { ...spec.yAxis, gridLines: e.target.checked },
                })
              }
            />
            Show grid lines
          </CheckboxLabel>
          <div style={{ display: "flex", alignItems: "center", gap: "8px", marginBottom: "4px" }}>
            <span style={{ fontSize: "12px", color: "var(--text-secondary)" }}>Title:</span>
            <Input
              type="text"
              value={spec.yAxis.title ?? ""}
              placeholder="auto"
              onChange={(e) =>
                onSpecChange({ yAxis: { ...spec.yAxis, title: e.target.value || null } })
              }
              style={{ width: "160px" }}
            />
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: "8px", marginBottom: "4px" }}>
            <span style={{ fontSize: "12px", color: "var(--text-secondary)" }}>Min:</span>
            <Input
              type="number"
              value={spec.yAxis.min ?? ""}
              placeholder="auto"
              onChange={(e) =>
                onSpecChange({
                  yAxis: { ...spec.yAxis, min: e.target.value === "" ? null : Number(e.target.value) },
                })
              }
              style={{ width: "70px" }}
            />
            <span style={{ fontSize: "12px", color: "var(--text-secondary)" }}>Max:</span>
            <Input
              type="number"
              value={spec.yAxis.max ?? ""}
              placeholder="auto"
              onChange={(e) =>
                onSpecChange({
                  yAxis: { ...spec.yAxis, max: e.target.value === "" ? null : Number(e.target.value) },
                })
              }
              style={{ width: "70px" }}
            />
          </div>
        </FieldGroup>
      )}

      {/* Legend */}
      <FieldGroup>
        <Label>Legend</Label>
        <CheckboxLabel>
          <input
            type="checkbox"
            checked={spec.legend.visible}
            onChange={(e) =>
              onSpecChange({
                legend: { ...spec.legend, visible: e.target.checked },
              })
            }
          />
          Show legend
        </CheckboxLabel>
        {spec.legend.visible && (
          <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
            <span style={{ fontSize: "12px", color: "var(--text-secondary)" }}>Position:</span>
            <Select
              value={spec.legend.position}
              onChange={(e) =>
                onSpecChange({
                  legend: {
                    ...spec.legend,
                    position: e.target.value as "top" | "bottom" | "left" | "right",
                  },
                })
              }
            >
              <option value="bottom">Bottom</option>
              <option value="top">Top</option>
              <option value="right">Right</option>
              <option value="left">Left</option>
            </Select>
          </div>
        )}
      </FieldGroup>

      {/* Data Labels */}
      <FieldGroup>
        <Label>Data Labels</Label>
        <CheckboxLabel>
          <input
            type="checkbox"
            checked={spec.dataLabels?.enabled ?? false}
            onChange={(e) => {
              const dl: DataLabelSpec = { ...(spec.dataLabels ?? { enabled: false }), enabled: e.target.checked };
              onSpecChange({ dataLabels: dl });
            }}
          />
          Show data labels
        </CheckboxLabel>
        {spec.dataLabels?.enabled && (
          <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
            <span style={{ fontSize: "12px", color: "var(--text-secondary)" }}>Position:</span>
            <Select
              value={spec.dataLabels?.position ?? "auto"}
              onChange={(e) => {
                const dl: DataLabelSpec = { ...(spec.dataLabels ?? { enabled: true }), position: e.target.value as DataLabelSpec["position"] };
                onSpecChange({ dataLabels: dl });
              }}
            >
              <option value="auto">Auto</option>
              <option value="above">Above</option>
              <option value="below">Below</option>
              <option value="center">Center</option>
              <option value="inside">Inside</option>
              <option value="outside">Outside</option>
            </Select>
          </div>
        )}
      </FieldGroup>

      {/* Error Bars (bar, line, scatter only) */}
      {(spec.mark === "bar" || spec.mark === "horizontalBar" || spec.mark === "line" || spec.mark === "scatter") && (
        <ErrorBarsSection spec={spec} onSpecChange={onSpecChange} />
      )}

      {/* Data Table (cartesian charts only) */}
      {cartesian && (
        <DataTableSection spec={spec} onSpecChange={onSpecChange} />
      )}

      {/* Palette */}
      <FieldGroup>
        <Label>Color Palette</Label>
        <Select
          value={spec.palette}
          onChange={(e) => onSpecChange({ palette: e.target.value })}
        >
          {PALETTE_NAMES.map((name) => (
            <option key={name} value={name}>
              {name.charAt(0).toUpperCase() + name.slice(1)}
            </option>
          ))}
        </Select>
        <PalettePreview>
          {(PALETTES[spec.palette] ?? PALETTES.default).map((color, i) => (
            <PaletteSwatch key={i} $color={color} />
          ))}
        </PalettePreview>
      </FieldGroup>

      {/* Per-series color overrides (cartesian charts, needs preview data) */}
      {cartesian && previewSeriesNames && previewSeriesNames.length > 0 && (
        <FieldGroup>
          <Label>Series Colors</Label>
          {previewSeriesNames.slice(0, 16).map((name, i) => {
            const override = spec.seriesColors?.[name];
            const effective = override ?? getSeriesColor(spec.palette, i, null);
            return (
              <div
                key={name}
                style={{ display: "flex", alignItems: "center", gap: "8px", marginBottom: "4px" }}
              >
                <input
                  type="color"
                  value={/^#[0-9A-Fa-f]{6}$/.test(effective) ? effective : "#4E79A7"}
                  onChange={(e) =>
                    onSpecChange({
                      seriesColors: { ...(spec.seriesColors ?? {}), [name]: e.target.value },
                    })
                  }
                  title={`Color for "${name}"`}
                  style={{
                    width: 24,
                    height: 18,
                    padding: 0,
                    border: "1px solid var(--border-default)",
                    borderRadius: 3,
                    cursor: "pointer",
                  }}
                />
                <span
                  style={{
                    fontSize: "12px",
                    flex: 1,
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                  }}
                >
                  {name}
                </span>
                {override && (
                  <button
                    onClick={() => {
                      const next = { ...(spec.seriesColors ?? {}) };
                      delete next[name];
                      onSpecChange({ seriesColors: next });
                    }}
                    style={{
                      fontSize: "11px",
                      padding: "1px 8px",
                      cursor: "pointer",
                      background: "transparent",
                      border: "1px solid var(--border-default)",
                      borderRadius: 3,
                      color: "var(--text-secondary)",
                    }}
                    title="Reset to palette color"
                  >
                    Auto
                  </button>
                )}
              </div>
            );
          })}
          {previewSeriesNames.length > 16 && (
            <div style={{ fontSize: "11px", color: "var(--text-secondary)" }}>
              Showing the first 16 of {previewSeriesNames.length} series.
            </div>
          )}
        </FieldGroup>
      )}
    </DesignGrid>
  );
}

// ============================================================================
// Mark-Specific Options
// ============================================================================

function MarkOptions({ spec, onSpecChange }: DesignTabProps): React.ReactElement | null {
  const opts = spec.markOptions ?? {};

  const updateMarkOptions = (updates: Record<string, unknown>) => {
    onSpecChange({ markOptions: { ...opts, ...updates } });
  };

  switch (spec.mark) {
    case "bar":
      return (
        <FieldGroup>
          <Label>Bar Options</Label>
          <div style={{ display: "flex", alignItems: "center", gap: "8px", marginBottom: "4px" }}>
            <span style={{ fontSize: "12px", color: "var(--text-secondary)" }}>Gap width %:</span>
            <Input
              type="number"
              min={0}
              max={500}
              step={10}
              value={(opts as any).gapWidth ?? 150}
              onChange={(e) => {
                const v = Number(e.target.value);
                updateMarkOptions({ gapWidth: Number.isNaN(v) ? 150 : v });
              }}
              style={{ width: "60px" }}
              title="Gap between category groups, as % of bar width (Excel: Gap Width)"
            />
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: "8px", marginBottom: "4px" }}>
            <span style={{ fontSize: "12px", color: "var(--text-secondary)" }}>Series overlap %:</span>
            <Input
              type="number"
              min={-100}
              max={100}
              step={5}
              value={(opts as any).seriesOverlap ?? 0}
              onChange={(e) => {
                const v = Number(e.target.value);
                updateMarkOptions({ seriesOverlap: Number.isNaN(v) ? 0 : v });
              }}
              style={{ width: "60px" }}
              title="Overlap between series bars; negative adds a gap (Excel: Series Overlap)"
            />
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: "8px", marginBottom: "4px" }}>
            <span style={{ fontSize: "12px", color: "var(--text-secondary)" }}>Corner radius:</span>
            <Input
              type="number"
              min={0}
              max={20}
              value={(opts as any).borderRadius ?? 2}
              onChange={(e) => {
                const v = Number(e.target.value);
                updateMarkOptions({ borderRadius: Number.isNaN(v) ? 2 : v });
              }}
              style={{ width: "60px" }}
            />
          </div>
        </FieldGroup>
      );

    case "line":
      return (
        <FieldGroup>
          <Label>Line Options</Label>
          <div style={{ display: "flex", alignItems: "center", gap: "8px", marginBottom: "4px" }}>
            <span style={{ fontSize: "12px", color: "var(--text-secondary)" }}>Interpolation:</span>
            <Select
              value={(opts as any).interpolation ?? "linear"}
              onChange={(e) => updateMarkOptions({ interpolation: e.target.value })}
            >
              <option value="linear">Linear</option>
              <option value="smooth">Smooth</option>
              <option value="step">Step</option>
            </Select>
          </div>
          <CheckboxLabel>
            <input
              type="checkbox"
              checked={(opts as any).showMarkers ?? true}
              onChange={(e) => updateMarkOptions({ showMarkers: e.target.checked })}
            />
            Show point markers
          </CheckboxLabel>
        </FieldGroup>
      );

    case "area":
      return (
        <FieldGroup>
          <Label>Area Options</Label>
          <div style={{ display: "flex", alignItems: "center", gap: "8px", marginBottom: "4px" }}>
            <span style={{ fontSize: "12px", color: "var(--text-secondary)" }}>Interpolation:</span>
            <Select
              value={(opts as any).interpolation ?? "linear"}
              onChange={(e) => updateMarkOptions({ interpolation: e.target.value })}
            >
              <option value="linear">Linear</option>
              <option value="smooth">Smooth</option>
              <option value="step">Step</option>
            </Select>
          </div>
          <CheckboxLabel>
            <input
              type="checkbox"
              checked={(opts as any).stacked ?? false}
              onChange={(e) => updateMarkOptions({ stacked: e.target.checked })}
            />
            Stacked areas
          </CheckboxLabel>
        </FieldGroup>
      );

    case "scatter":
      return (
        <FieldGroup>
          <Label>Scatter Options</Label>
          <div style={{ display: "flex", alignItems: "center", gap: "8px", marginBottom: "4px" }}>
            <span style={{ fontSize: "12px", color: "var(--text-secondary)" }}>Point shape:</span>
            <Select
              value={(opts as any).pointShape ?? "circle"}
              onChange={(e) => updateMarkOptions({ pointShape: e.target.value })}
            >
              <option value="circle">Circle</option>
              <option value="square">Square</option>
              <option value="diamond">Diamond</option>
              <option value="triangle">Triangle</option>
            </Select>
          </div>
        </FieldGroup>
      );

    case "pie":
    case "donut":
      return (
        <FieldGroup>
          <Label>{spec.mark === "pie" ? "Pie" : "Donut"} Options</Label>
          <CheckboxLabel>
            <input
              type="checkbox"
              checked={(opts as any).showLabels ?? true}
              onChange={(e) => updateMarkOptions({ showLabels: e.target.checked })}
            />
            Show labels
          </CheckboxLabel>
          {(opts as any).showLabels !== false && (
            <div style={{ display: "flex", alignItems: "center", gap: "8px", marginBottom: "4px" }}>
              <span style={{ fontSize: "12px", color: "var(--text-secondary)" }}>Label format:</span>
              <Select
                value={(opts as any).labelFormat ?? "percent"}
                onChange={(e) => updateMarkOptions({ labelFormat: e.target.value })}
              >
                <option value="percent">Percentage</option>
                <option value="value">Value</option>
                <option value="both">Both</option>
              </Select>
            </div>
          )}
        </FieldGroup>
      );

    case "waterfall":
      return (
        <FieldGroup>
          <Label>Waterfall Options</Label>
          <CheckboxLabel>
            <input
              type="checkbox"
              checked={(opts as any).showConnectors ?? true}
              onChange={(e) => updateMarkOptions({ showConnectors: e.target.checked })}
            />
            Show connector lines
          </CheckboxLabel>
        </FieldGroup>
      );

    case "combo":
      return (
        <FieldGroup>
          <Label>Combo Options</Label>
          <CheckboxLabel>
            <input
              type="checkbox"
              checked={(opts as any).secondaryYAxis ?? false}
              onChange={(e) => updateMarkOptions({ secondaryYAxis: e.target.checked })}
            />
            Secondary Y axis (right)
          </CheckboxLabel>
          <div style={{ fontSize: "11px", color: "var(--text-secondary)", marginTop: "4px" }}>
            First series renders as bars, others as lines. Customize in Spec tab.
          </div>
        </FieldGroup>
      );

    case "radar":
      return (
        <FieldGroup>
          <Label>Radar Options</Label>
          <CheckboxLabel>
            <input
              type="checkbox"
              checked={(opts as any).showFill ?? true}
              onChange={(e) => updateMarkOptions({ showFill: e.target.checked })}
            />
            Show fill
          </CheckboxLabel>
          <CheckboxLabel>
            <input
              type="checkbox"
              checked={(opts as any).showMarkers ?? true}
              onChange={(e) => updateMarkOptions({ showMarkers: e.target.checked })}
            />
            Show point markers
          </CheckboxLabel>
          <div style={{ display: "flex", alignItems: "center", gap: "8px", marginBottom: "4px" }}>
            <span style={{ fontSize: "12px", color: "var(--text-secondary)" }}>Fill opacity:</span>
            <Input
              type="number"
              min={0}
              max={1}
              step={0.1}
              value={(opts as any).fillOpacity ?? 0.2}
              onChange={(e) => updateMarkOptions({ fillOpacity: parseFloat(e.target.value) || 0.2 })}
              style={{ width: "60px" }}
            />
          </div>
        </FieldGroup>
      );

    case "bubble":
      return (
        <FieldGroup>
          <Label>Bubble Options</Label>
          <div style={{ display: "flex", alignItems: "center", gap: "8px", marginBottom: "4px" }}>
            <span style={{ fontSize: "12px", color: "var(--text-secondary)" }}>Min bubble size:</span>
            <Input
              type="number"
              min={1}
              max={50}
              value={(opts as any).minBubbleSize ?? 4}
              onChange={(e) => updateMarkOptions({ minBubbleSize: parseInt(e.target.value, 10) || 4 })}
              style={{ width: "60px" }}
            />
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: "8px", marginBottom: "4px" }}>
            <span style={{ fontSize: "12px", color: "var(--text-secondary)" }}>Max bubble size:</span>
            <Input
              type="number"
              min={5}
              max={100}
              value={(opts as any).maxBubbleSize ?? 30}
              onChange={(e) => updateMarkOptions({ maxBubbleSize: parseInt(e.target.value, 10) || 30 })}
              style={{ width: "60px" }}
            />
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: "8px", marginBottom: "4px" }}>
            <span style={{ fontSize: "12px", color: "var(--text-secondary)" }}>Opacity:</span>
            <Input
              type="number"
              min={0}
              max={1}
              step={0.1}
              value={(opts as any).bubbleOpacity ?? 0.7}
              onChange={(e) => updateMarkOptions({ bubbleOpacity: parseFloat(e.target.value) || 0.7 })}
              style={{ width: "60px" }}
            />
          </div>
        </FieldGroup>
      );

    case "histogram":
      return (
        <FieldGroup>
          <Label>Histogram Options</Label>
          <div style={{ display: "flex", alignItems: "center", gap: "8px", marginBottom: "4px" }}>
            <span style={{ fontSize: "12px", color: "var(--text-secondary)" }}>Number of bins:</span>
            <Input
              type="number"
              min={2}
              max={100}
              value={(opts as any).binCount ?? 10}
              onChange={(e) => updateMarkOptions({ binCount: parseInt(e.target.value, 10) || 10 })}
              style={{ width: "60px" }}
            />
          </div>
        </FieldGroup>
      );

    case "funnel":
      return (
        <FieldGroup>
          <Label>Funnel Options</Label>
          <CheckboxLabel>
            <input
              type="checkbox"
              checked={(opts as any).showLabels ?? true}
              onChange={(e) => updateMarkOptions({ showLabels: e.target.checked })}
            />
            Show labels
          </CheckboxLabel>
          {(opts as any).showLabels !== false && (
            <div style={{ display: "flex", alignItems: "center", gap: "8px", marginBottom: "4px" }}>
              <span style={{ fontSize: "12px", color: "var(--text-secondary)" }}>Label format:</span>
              <Select
                value={(opts as any).labelFormat ?? "both"}
                onChange={(e) => updateMarkOptions({ labelFormat: e.target.value })}
              >
                <option value="value">Value</option>
                <option value="percent">Percentage</option>
                <option value="both">Both</option>
              </Select>
            </div>
          )}
          <div style={{ display: "flex", alignItems: "center", gap: "8px", marginBottom: "4px" }}>
            <span style={{ fontSize: "12px", color: "var(--text-secondary)" }}>Neck width ratio:</span>
            <Input
              type="number"
              min={0.05}
              max={0.9}
              step={0.05}
              value={(opts as any).neckWidthRatio ?? 0.3}
              onChange={(e) => updateMarkOptions({ neckWidthRatio: parseFloat(e.target.value) || 0.3 })}
              style={{ width: "60px" }}
            />
          </div>
        </FieldGroup>
      );

    case "treemap":
      return (
        <FieldGroup>
          <Label>Treemap Options</Label>
          <CheckboxLabel>
            <input
              type="checkbox"
              checked={(opts as any).showLabels ?? true}
              onChange={(e) => updateMarkOptions({ showLabels: e.target.checked })}
            />
            Show labels
          </CheckboxLabel>
          {(opts as any).showLabels !== false && (
            <div style={{ display: "flex", alignItems: "center", gap: "8px", marginBottom: "4px" }}>
              <span style={{ fontSize: "12px", color: "var(--text-secondary)" }}>Label format:</span>
              <Select
                value={(opts as any).labelFormat ?? "both"}
                onChange={(e) => updateMarkOptions({ labelFormat: e.target.value })}
              >
                <option value="category">Category only</option>
                <option value="value">Value only</option>
                <option value="both">Both</option>
              </Select>
            </div>
          )}
        </FieldGroup>
      );

    case "stock":
      return (
        <FieldGroup>
          <Label>Stock Options</Label>
          <div style={{ display: "flex", alignItems: "center", gap: "8px", marginBottom: "4px" }}>
            <span style={{ fontSize: "12px", color: "var(--text-secondary)" }}>Style:</span>
            <Select
              value={(opts as any).style ?? "candlestick"}
              onChange={(e) => updateMarkOptions({ style: e.target.value })}
            >
              <option value="candlestick">Candlestick</option>
              <option value="ohlc">OHLC Bars</option>
            </Select>
          </div>
          <div style={{ fontSize: "11px", color: "var(--text-secondary)", marginTop: "4px" }}>
            Requires 4 series: Open, High, Low, Close
          </div>
        </FieldGroup>
      );

    case "boxPlot":
      return (
        <FieldGroup>
          <Label>Box &amp; Whisker Options</Label>
          <CheckboxLabel>
            <input
              type="checkbox"
              checked={(opts as any).showOutliers ?? true}
              onChange={(e) => updateMarkOptions({ showOutliers: e.target.checked })}
            />
            Show outliers
          </CheckboxLabel>
          <CheckboxLabel>
            <input
              type="checkbox"
              checked={(opts as any).showMean ?? false}
              onChange={(e) => updateMarkOptions({ showMean: e.target.checked })}
            />
            Show mean marker
          </CheckboxLabel>
          <div style={{ display: "flex", alignItems: "center", gap: "8px", marginBottom: "4px" }}>
            <span style={{ fontSize: "12px", color: "var(--text-secondary)" }}>Box width:</span>
            <Input
              type="number"
              min={0.1}
              max={0.9}
              step={0.1}
              value={(opts as any).boxWidth ?? 0.5}
              onChange={(e) => updateMarkOptions({ boxWidth: parseFloat(e.target.value) || 0.5 })}
              style={{ width: "60px" }}
            />
          </div>
          <div style={{ fontSize: "11px", color: "var(--text-secondary)", marginTop: "4px" }}>
            Multiple series values per category define the distribution.
          </div>
        </FieldGroup>
      );

    case "sunburst":
      return (
        <FieldGroup>
          <Label>Sunburst Options</Label>
          <CheckboxLabel>
            <input
              type="checkbox"
              checked={(opts as any).showLabels ?? true}
              onChange={(e) => updateMarkOptions({ showLabels: e.target.checked })}
            />
            Show labels
          </CheckboxLabel>
          {(opts as any).showLabels !== false && (
            <div style={{ display: "flex", alignItems: "center", gap: "8px", marginBottom: "4px" }}>
              <span style={{ fontSize: "12px", color: "var(--text-secondary)" }}>Label format:</span>
              <Select
                value={(opts as any).labelFormat ?? "category"}
                onChange={(e) => updateMarkOptions({ labelFormat: e.target.value })}
              >
                <option value="category">Category only</option>
                <option value="value">Value only</option>
                <option value="percent">Percentage</option>
                <option value="both">Category + Value</option>
              </Select>
            </div>
          )}
          <div style={{ display: "flex", alignItems: "center", gap: "8px", marginBottom: "4px" }}>
            <span style={{ fontSize: "12px", color: "var(--text-secondary)" }}>Level separator:</span>
            <Input
              type="text"
              value={(opts as any).levelSeparator ?? " > "}
              onChange={(e) => updateMarkOptions({ levelSeparator: e.target.value })}
              style={{ width: "60px" }}
            />
          </div>
          <div style={{ fontSize: "11px", color: "var(--text-secondary)", marginTop: "4px" }}>
            Use separator in category names to define hierarchy (e.g., "A &gt; B &gt; C").
          </div>
        </FieldGroup>
      );

    case "pareto":
      return (
        <FieldGroup>
          <Label>Pareto Options</Label>
          <CheckboxLabel>
            <input
              type="checkbox"
              checked={(opts as any).showMarkers ?? true}
              onChange={(e) => updateMarkOptions({ showMarkers: e.target.checked })}
            />
            Show line markers
          </CheckboxLabel>
          <CheckboxLabel>
            <input
              type="checkbox"
              checked={(opts as any).show80PercentLine ?? true}
              onChange={(e) => updateMarkOptions({ show80PercentLine: e.target.checked })}
            />
            Show 80% reference line
          </CheckboxLabel>
          <div style={{ fontSize: "11px", color: "var(--text-secondary)", marginTop: "4px" }}>
            Bars are auto-sorted descending. Cumulative % line uses right axis.
          </div>
        </FieldGroup>
      );

    default:
      return null;
  }
}

// ============================================================================
// Error Bars Section
// ============================================================================

function ErrorBarsSection({ spec, onSpecChange }: DesignTabProps): React.ReactElement {
  const opts = spec.markOptions ?? {};
  const errorBars: ErrorBarOptions = (opts as any).errorBars ?? {
    enabled: false,
    type: "standardError",
    direction: "both",
  };

  const updateErrorBars = (updates: Partial<ErrorBarOptions>) => {
    const newEB = { ...errorBars, ...updates };
    onSpecChange({ markOptions: { ...opts, errorBars: newEB } as any });
  };

  return (
    <FieldGroup>
      <Label>Error Bars</Label>
      <CheckboxLabel>
        <input
          type="checkbox"
          checked={errorBars.enabled}
          onChange={(e) => updateErrorBars({ enabled: e.target.checked })}
        />
        Show error bars
      </CheckboxLabel>
      {errorBars.enabled && (
        <>
          <div style={{ display: "flex", alignItems: "center", gap: "8px", marginBottom: "4px" }}>
            <span style={{ fontSize: "12px", color: "var(--text-secondary)" }}>Type:</span>
            <Select
              value={errorBars.type}
              onChange={(e) =>
                updateErrorBars({ type: e.target.value as ErrorBarOptions["type"] })
              }
            >
              <option value="standardError">Standard Error</option>
              <option value="percentage">Percentage</option>
              <option value="standardDeviation">Standard Deviation</option>
              <option value="custom">Custom (fixed value)</option>
            </Select>
          </div>
          {(errorBars.type === "percentage" || errorBars.type === "standardDeviation" || errorBars.type === "custom") && (
            <div style={{ display: "flex", alignItems: "center", gap: "8px", marginBottom: "4px" }}>
              <span style={{ fontSize: "12px", color: "var(--text-secondary)" }}>
                {errorBars.type === "percentage" ? "Percentage:" : errorBars.type === "standardDeviation" ? "Multiplier:" : "Value:"}
              </span>
              <Input
                type="number"
                min={0}
                step={errorBars.type === "percentage" ? 1 : 0.1}
                value={errorBars.value ?? (errorBars.type === "percentage" ? 10 : 1)}
                onChange={(e) => updateErrorBars({ value: parseFloat(e.target.value) || 0 })}
                style={{ width: "70px" }}
              />
            </div>
          )}
          <div style={{ display: "flex", alignItems: "center", gap: "8px", marginBottom: "4px" }}>
            <span style={{ fontSize: "12px", color: "var(--text-secondary)" }}>Direction:</span>
            <Select
              value={errorBars.direction}
              onChange={(e) =>
                updateErrorBars({ direction: e.target.value as ErrorBarOptions["direction"] })
              }
            >
              <option value="both">Both</option>
              <option value="plus">Plus only</option>
              <option value="minus">Minus only</option>
            </Select>
          </div>
        </>
      )}
    </FieldGroup>
  );
}

// ============================================================================
// Data Table Section
// ============================================================================

function DataTableSection({ spec, onSpecChange }: DesignTabProps): React.ReactElement {
  const dt: DataTableOptions = spec.dataTable ?? {
    enabled: false,
    showLegendKeys: true,
    showHorizontalBorder: true,
    showVerticalBorder: true,
    showOutlineBorder: true,
  };

  const updateDataTable = (updates: Partial<DataTableOptions>) => {
    const newDT = { ...dt, ...updates };
    onSpecChange({ dataTable: newDT });
  };

  return (
    <FieldGroup>
      <Label>Data Table</Label>
      <CheckboxLabel>
        <input
          type="checkbox"
          checked={dt.enabled}
          onChange={(e) => updateDataTable({ enabled: e.target.checked })}
        />
        Show data table below chart
      </CheckboxLabel>
      {dt.enabled && (
        <>
          <CheckboxLabel>
            <input
              type="checkbox"
              checked={dt.showLegendKeys !== false}
              onChange={(e) => updateDataTable({ showLegendKeys: e.target.checked })}
            />
            Show legend keys
          </CheckboxLabel>
          <CheckboxLabel>
            <input
              type="checkbox"
              checked={dt.showHorizontalBorder !== false}
              onChange={(e) => updateDataTable({ showHorizontalBorder: e.target.checked })}
            />
            Horizontal borders
          </CheckboxLabel>
          <CheckboxLabel>
            <input
              type="checkbox"
              checked={dt.showVerticalBorder !== false}
              onChange={(e) => updateDataTable({ showVerticalBorder: e.target.checked })}
            />
            Vertical borders
          </CheckboxLabel>
          <CheckboxLabel>
            <input
              type="checkbox"
              checked={dt.showOutlineBorder !== false}
              onChange={(e) => updateDataTable({ showOutlineBorder: e.target.checked })}
            />
            Outline border
          </CheckboxLabel>
        </>
      )}
    </FieldGroup>
  );
}
