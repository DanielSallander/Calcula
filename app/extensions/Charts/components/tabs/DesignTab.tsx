//! FILENAME: app/extensions/Charts/components/tabs/DesignTab.tsx
// PURPOSE: Design tab of the chart dialog. Chart type, title, axis, legend, palette.

import React from "react";
import type { ChartSpec } from "../../types";
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

export function DesignTab({ spec, onSpecChange }: DesignTabProps): React.ReactElement {
  return (
    <>
      {/* Chart Type */}
      <FieldGroup>
        <Label>Chart Type</Label>
        <Select value={spec.mark} onChange={() => {}}>
          <option value="bar">Bar Chart</option>
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

      {/* X Axis */}
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

      {/* Y Axis */}
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
