//! FILENAME: app/extensions/Charts/components/tabs/DesignTab.tsx
// PURPOSE: Design tab of the chart dialog. Chart type, title, axis, legend, palette, mark options.

import React from "react";
import type { ChartSpec, ChartType, DataLabelSpec } from "../../types";
import { isCartesianChart } from "../../types";
import { PALETTES, PALETTE_NAMES } from "../../rendering/chartTheme";
import {
  FieldGroup,
  Label,
  Input,
  Select,
  CheckboxLabel,
  PalettePreview,
  PaletteSwatch,
} from "../CreateChartDialog.styles";

interface DesignTabProps {
  spec: ChartSpec;
  onSpecChange: (updates: Partial<ChartSpec>) => void;
}

/** All available chart types with display names. */
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
];

export function DesignTab({ spec, onSpecChange }: DesignTabProps): React.ReactElement {
  const cartesian = isCartesianChart(spec.mark);

  return (
    <>
      {/* Chart Type */}
      <FieldGroup>
        <Label>Chart Type</Label>
        <Select
          value={spec.mark}
          onChange={(e) => onSpecChange({ mark: e.target.value as ChartType })}
        >
          {CHART_TYPES.map(({ value, label }) => (
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
    </>
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

    default:
      return null;
  }
}
