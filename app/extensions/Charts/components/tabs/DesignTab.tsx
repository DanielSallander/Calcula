//! FILENAME: app/extensions/Charts/components/tabs/DesignTab.tsx
// PURPOSE: Design tab of the chart dialog. Chart type, title, axis, legend, palette, mark options.

import React from "react";
import type {
  ChartSpec,
  ChartMark,
  DataLabelSpec,
  DataTableOptions,
  ErrorBarOptions,
  StackMode,
  VisualDisplayUnits,
  VisualAggregate,
  ComboMarkOptions,
  ComboSeriesMark,
} from "../../types";
import { comboDefaultSeriesMark } from "../../rendering/comboChartPainter";
import { isCartesianChart, markFurniture } from "../../types";
import { listChartMarks, getChartMarkMeta } from "@api/chartMarks";
import { CHART_TYPES } from "../chartTypeCatalog";
import { getStackModeFromSpec, setStackModeInOptions, stackModesFor } from "../../lib/stackMode";
import { PALETTES, PALETTE_NAMES, getSeriesColor } from "../../rendering/chartTheme";
import { readSeriesColor, seriesColorPatch } from "../../lib/chartDataReader";
// The one answer to "which marks have error bars, and where do their options
// live?" — reader, writer and mark list all from the painter that draws them.
import {
  getErrorBarOptions,
  markSupportsErrorBars,
  withErrorBarOptions,
} from "../../rendering/errorBarPainter";
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

/**
 * Chart-type options for the picker: the CATALOG's built-ins (always present,
 * in the catalog's order and with its names) plus any custom marks registered
 * via the @api chart-mark registry, appended.
 *
 * THIS USED TO BE A THIRD LIST. The dialog kept its own eighteen entries with
 * their own names ("Bar Chart" for the mark Excel and Power BI call a COLUMN
 * chart, "Horizontal Bar Chart" for their BAR chart) beside the band's
 * catalog and the renderer's registry labels, so one chart had two names
 * depending on where the reader looked. It now reads the catalog, and
 * chartTypeNames.test.ts holds the registry's labels to it.
 */
function chartTypeOptions(): Array<{ value: string; label: string }> {
  const builtinValues = new Set<string>(CHART_TYPES.map((t) => t.value));
  const custom = listChartMarks()
    .filter((m) => !builtinValues.has(m))
    .map((m) => ({ value: m, label: getChartMarkMeta(m)?.label ?? m }));
  return [...CHART_TYPES.map((t) => ({ value: t.value as string, label: t.label })), ...custom];
}

export function DesignTab({ spec, onSpecChange, previewSeriesNames }: DesignTabProps): React.ReactElement {
  const cartesian = isCartesianChart(spec.mark);
  // A title-only mark (Card, Multi-row card, KPI, Gauge) draws its own labels
  // and nothing else: offering it a legend, data labels or a data table would
  // write settings the painter never reads (contract §4.2).
  const fullFurniture = markFurniture(spec.mark) === "full";

  return (
    <DesignGrid>
      {/* Chart Type */}
      <FieldGroup>
        <Label>Chart Type</Label>
        <Select
          value={spec.mark}
          data-testid="chart-dialog-type"
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

      {/* Stacking: one control, through the one writer, for every mark that stacks */}
      <StackingSection spec={spec} onSpecChange={onSpecChange} />
      <ComboSeriesMarksSection spec={spec} onSpecChange={onSpecChange} previewSeriesNames={previewSeriesNames} />

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
      {fullFurniture && (
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
      )}

      {/* Data Labels */}
      {fullFurniture && (
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
      )}

      {/* Error Bars — the mark list is the painter's, not a fourth copy of it. */}
      {markSupportsErrorBars(spec.mark) && (
        <ErrorBarsSection spec={spec} onSpecChange={onSpecChange} />
      )}

      {/* Data Table (cartesian charts only — never a title-only tile) */}
      {cartesian && fullFurniture && (
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
            const override = readSeriesColor(spec, name);
            const effective = override ?? getSeriesColor(spec.palette, i, null);
            // The ONE writer, shared with the Format pane and the ribbon
            // Design panel. The dialog's own overlay REPLACES a spec key while
            // the live store MERGES it, so the explicit-undefined clear this
            // builds is the only form that is correct under both.
            const write = (hex: string | null): void => {
              const patch = seriesColorPatch(spec, name, hex);
              if (patch !== null) onSpecChange(patch);
            };
            return (
              <div
                key={name}
                style={{ display: "flex", alignItems: "center", gap: "8px", marginBottom: "4px" }}
              >
                <input
                  type="color"
                  value={/^#[0-9A-Fa-f]{6}$/.test(effective) ? effective : "#4E79A7"}
                  onChange={(e) => write(e.target.value)}
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
                    onClick={() => write(null)}
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
          {/* Stacking is the Stacking section above, through the one writer.
              The checkbox that lived here wrote `stacked` alone, which the
              painter's stackMode-first rule could ignore (charts.md §7.1). */}
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
            First series renders as bars, others as lines. Stacking above sets
            clustered or stacked columns. Customize in Spec tab.
          </div>
        </FieldGroup>
      );

    case "card":
    case "multiRowCard":
    case "kpi":
    case "gauge":
      return <VisualOptions spec={spec} onSpecChange={onSpecChange} />;

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
// Stacking (every mark that stacks, through lib/stackMode.ts)
// ============================================================================

const STACK_LABELS: Record<StackMode, string> = {
  none: "Grouped (clustered)",
  stacked: "Stacked",
  percentStacked: "100% stacked",
};

/**
 * Grouped / Stacked / 100% for the marks that stack — the modes the mark can
 * actually draw (`stackModesFor`: a combo has no 100%), read and written by
 * the ONE reader/writer the Chart Design band uses. Power BI's Visuals gallery
 * presets these at insert time; this is where they are changed afterwards
 * without leaving the dialog.
 */
function StackingSection({ spec, onSpecChange }: DesignTabProps): React.ReactElement | null {
  const modes = stackModesFor(spec.mark);
  if (modes.length === 0) return null;
  return (
    <FieldGroup>
      <Label>Stacking</Label>
      <Select
        value={getStackModeFromSpec(spec)}
        data-testid="chart-dialog-stacking"
        onChange={(e) => onSpecChange({ markOptions: setStackModeInOptions(spec, e.target.value as StackMode) })}
      >
        {modes.map((m) => (
          <option key={m} value={m}>
            {STACK_LABELS[m]}
          </option>
        ))}
      </Select>
    </FieldGroup>
  );
}

const COMBO_SERIES_MARK_LABELS: Record<ComboSeriesMark, string> = {
  bar: "Column",
  line: "Line",
  area: "Area",
};

/**
 * Column or line, per series, on a combo (Power BI's "Column y-axis" and
 * "Line y-axis" wells). Without it the only way to make a second series a
 * column -- and so to give "Line and stacked column" more than one column to
 * stack -- was the JSON Spec tab. Each row shows what the painter draws today
 * (the default the stack mode implies, `comboDefaultSeriesMark`) and writes
 * `markOptions.seriesMarks` only when changed.
 */
function ComboSeriesMarksSection({ spec, onSpecChange, previewSeriesNames }: DesignTabProps): React.ReactElement | null {
  if (spec.mark !== "combo") return null;
  const names = previewSeriesNames && previewSeriesNames.length > 0
    ? previewSeriesNames
    : spec.series.map((s) => s.name);
  if (names.length === 0) return null;
  const opts = (spec.markOptions ?? {}) as ComboMarkOptions;
  const stacked = opts.stackMode === "stacked";
  const current = (si: number): ComboSeriesMark =>
    opts.seriesMarks?.[si] ?? comboDefaultSeriesMark(si, names.length, stacked);
  const setMark = (si: number, mark: ComboSeriesMark): void => {
    // Every row is written, so the choice cannot shift when the series count
    // (and with it the default) changes later.
    const seriesMarks: Record<number, ComboSeriesMark> = {};
    for (let i = 0; i < names.length; i++) seriesMarks[i] = i === si ? mark : current(i);
    onSpecChange({ markOptions: { ...opts, seriesMarks } });
  };
  return (
    <FieldGroup>
      <Label>Series as</Label>
      {names.map((name, si) => (
        <div key={`${si}:${name}`} style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <span style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{name}</span>
          <Select
            value={current(si)}
            aria-label={`${name} as`}
            data-testid={`chart-dialog-combo-series-${si}`}
            onChange={(e) => setMark(si, e.target.value as ComboSeriesMark)}
          >
            {(Object.keys(COMBO_SERIES_MARK_LABELS) as ComboSeriesMark[]).map((m) => (
              <option key={m} value={m}>
                {COMBO_SERIES_MARK_LABELS[m]}
              </option>
            ))}
          </Select>
        </div>
      ))}
    </FieldGroup>
  );
}

// ============================================================================
// Tile visuals: Card, Multi-row card, KPI, Gauge
// ============================================================================

const DISPLAY_UNITS: ReadonlyArray<{ value: VisualDisplayUnits; label: string }> = [
  { value: "auto", label: "Auto" },
  { value: "none", label: "None (as the source shows it)" },
  { value: "thousands", label: "Thousands" },
  { value: "millions", label: "Millions" },
  { value: "billions", label: "Billions" },
  { value: "trillions", label: "Trillions" },
];

const AGGREGATES: ReadonlyArray<{ value: VisualAggregate; label: string }> = [
  { value: "auto", label: "Auto (sum numbers, first text)" },
  { value: "sum", label: "Sum" },
  { value: "average", label: "Average" },
  { value: "min", label: "Minimum" },
  { value: "max", label: "Maximum" },
  { value: "count", label: "Count" },
  { value: "first", label: "First" },
  { value: "last", label: "Last" },
];

/**
 * The options of the four tile visuals (Power BI's Format pane cards for them,
 * reduced to what the painters read). A number field left EMPTY removes its key
 * — "no fixed maximum" is the absence of one, and a 0 written in its place
 * would pin a gauge to 0..0.
 */
function VisualOptions({ spec, onSpecChange }: DesignTabProps): React.ReactElement {
  const opts = (spec.markOptions ?? {}) as Record<string, unknown>;
  const set = (key: string, value: unknown): void => {
    const next: Record<string, unknown> = { ...opts };
    if (value === undefined || value === "") delete next[key];
    else next[key] = value;
    onSpecChange({ markOptions: next as ChartSpec["markOptions"] });
  };
  const numberField = (key: string, label: string, testId: string): React.ReactElement => (
    <div style={{ display: "flex", alignItems: "center", gap: "8px", marginBottom: "4px" }}>
      <span style={{ fontSize: "12px", color: "var(--text-secondary)" }}>{label}</span>
      <Input
        type="number"
        data-testid={testId}
        value={typeof opts[key] === "number" ? (opts[key] as number) : ""}
        placeholder="auto"
        onChange={(e) => {
          const raw = e.target.value;
          const n = Number(raw);
          set(key, raw === "" || !Number.isFinite(n) ? undefined : n);
        }}
        style={{ width: "80px" }}
      />
    </div>
  );
  const unitsField = (
    <div style={{ display: "flex", alignItems: "center", gap: "8px", marginBottom: "4px" }}>
      <span style={{ fontSize: "12px", color: "var(--text-secondary)" }}>Display units:</span>
      <Select
        value={(opts.displayUnits as string) ?? "auto"}
        data-testid="chart-dialog-display-units"
        onChange={(e) => set("displayUnits", e.target.value)}
      >
        {DISPLAY_UNITS.map((u) => (
          <option key={u.value} value={u.value}>{u.label}</option>
        ))}
      </Select>
    </div>
  );
  const aggregateField = (
    <div style={{ display: "flex", alignItems: "center", gap: "8px", marginBottom: "4px" }}>
      <span style={{ fontSize: "12px", color: "var(--text-secondary)" }}>Summarize:</span>
      <Select
        value={(opts.aggregate as string) ?? "auto"}
        data-testid="chart-dialog-aggregate"
        onChange={(e) => set("aggregate", e.target.value)}
      >
        {AGGREGATES.map((a) => (
          <option key={a.value} value={a.value}>{a.label}</option>
        ))}
      </Select>
    </div>
  );

  switch (spec.mark) {
    case "card":
      return (
        <FieldGroup>
          <Label>Card Options</Label>
          {unitsField}
          {aggregateField}
          {numberField("decimals", "Decimals:", "chart-dialog-decimals")}
          <CheckboxLabel>
            <input
              type="checkbox"
              checked={opts.showCategoryLabel !== false}
              onChange={(e) => set("showCategoryLabel", e.target.checked ? undefined : false)}
            />
            Show category label
          </CheckboxLabel>
          <div style={{ fontSize: "11px", color: "var(--text-secondary)", marginTop: "4px" }}>
            One card per series. A text value is shown as its text.
          </div>
        </FieldGroup>
      );
    case "multiRowCard":
      return (
        <FieldGroup>
          <Label>Multi-row Card Options</Label>
          {unitsField}
          {numberField("decimals", "Decimals:", "chart-dialog-decimals")}
          <CheckboxLabel>
            <input
              type="checkbox"
              checked={opts.showAccentBar !== false}
              onChange={(e) => set("showAccentBar", e.target.checked ? undefined : false)}
            />
            Accent bar
          </CheckboxLabel>
          <CheckboxLabel>
            <input
              type="checkbox"
              checked={opts.showRowTitle !== false}
              onChange={(e) => set("showRowTitle", e.target.checked ? undefined : false)}
            />
            Category as row title
          </CheckboxLabel>
        </FieldGroup>
      );
    case "kpi":
      return (
        <FieldGroup>
          <Label>KPI Options</Label>
          <div style={{ display: "flex", alignItems: "center", gap: "8px", marginBottom: "4px" }}>
            <span style={{ fontSize: "12px", color: "var(--text-secondary)" }}>Direction:</span>
            <Select
              value={(opts.direction as string) ?? "higherIsBetter"}
              data-testid="chart-dialog-kpi-direction"
              onChange={(e) => set("direction", e.target.value)}
            >
              <option value="higherIsBetter">High is good</option>
              <option value="lowerIsBetter">Low is good</option>
            </Select>
          </div>
          {numberField("goal", "Fixed goal:", "chart-dialog-kpi-goal")}
          {unitsField}
          <CheckboxLabel>
            <input
              type="checkbox"
              checked={opts.showTrend !== false}
              onChange={(e) => set("showTrend", e.target.checked ? undefined : false)}
            />
            Trend axis
          </CheckboxLabel>
          <CheckboxLabel>
            <input
              type="checkbox"
              checked={opts.showGoal !== false}
              onChange={(e) => set("showGoal", e.target.checked ? undefined : false)}
            />
            Goal and distance
          </CheckboxLabel>
          <div style={{ fontSize: "11px", color: "var(--text-secondary)", marginTop: "4px" }}>
            Categories are the trend axis (sorted ascending); series 1 is the indicator, series 2 the goal.
          </div>
        </FieldGroup>
      );
    default:
      return (
        <FieldGroup>
          <Label>Gauge Options</Label>
          {numberField("min", "Minimum:", "chart-dialog-gauge-min")}
          {numberField("max", "Maximum:", "chart-dialog-gauge-max")}
          {numberField("target", "Target:", "chart-dialog-gauge-target")}
          {unitsField}
          {aggregateField}
          <div style={{ fontSize: "11px", color: "var(--text-secondary)", marginTop: "4px" }}>
            Empty = Power BI's defaults: minimum 0, maximum twice the value; the target comes from a second series.
          </div>
        </FieldGroup>
      );
  }
}

// ============================================================================
// Error Bars Section
// ============================================================================

function ErrorBarsSection({ spec, onSpecChange }: DesignTabProps): React.ReactElement {
  // Read and write through the painter's own accessors. This section used to
  // reach into `spec.markOptions` with two `as any` casts, which is how a write
  // could land in a slot the painter never reads — the cast silences exactly
  // the check that would have caught it.
  const errorBars: ErrorBarOptions = getErrorBarOptions(spec) ?? {
    enabled: false,
    type: "standardError",
    direction: "both",
  };

  const updateErrorBars = (updates: Partial<ErrorBarOptions>) => {
    const patch = withErrorBarOptions(spec, { ...errorBars, ...updates });
    if (patch) onSpecChange(patch);
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
