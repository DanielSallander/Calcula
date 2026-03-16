//! FILENAME: app/extensions/Charts/components/tabs/DesignTab.tsx
// PURPOSE: Design tab of the chart dialog. Chart type, title, axis, legend, palette, mark options.

import React from "react";
import type { ChartSpec, ChartType } from "../../types";
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

    default:
      return null;
  }
}
