//! FILENAME: app/extensions/Charts/components/tabs/DataTab.tsx
// PURPOSE: Data tab of the chart dialog. Source range, series orientation,
//          category axis, and series selection.

import React from "react";
import type { ChartSpec, ChartSeries, SeriesOrientation } from "../../types";
import { getSeriesColor } from "../../rendering/chartTheme";
import {
  FieldGroup,
  Label,
  Input,
  Select,
  CheckboxLabel,
  RadioGroup,
  RadioLabel,
  SeriesList,
  SeriesItem,
  ColorSwatch,
} from "../CreateChartDialog.styles";

interface DataTabProps {
  sourceRange: string;
  onSourceRangeChange: (value: string) => void;
  hasHeaders: boolean;
  onHasHeadersChange: (value: boolean) => void;
  orientation: SeriesOrientation;
  onOrientationChange: (value: SeriesOrientation) => void;
  categoryIndex: number;
  onCategoryIndexChange: (value: number) => void;
  series: ChartSeries[];
  onSeriesChange: (series: ChartSeries[]) => void;
  /** Available column/row labels for category dropdown. */
  availableAxes: Array<{ index: number; label: string }>;
  /** Palette name for color previews. */
  palette: string;
}

export function DataTab({
  sourceRange,
  onSourceRangeChange,
  hasHeaders,
  onHasHeadersChange,
  orientation,
  onOrientationChange,
  categoryIndex,
  onCategoryIndexChange,
  series,
  onSeriesChange,
  availableAxes,
  palette,
}: DataTabProps): React.ReactElement {
  const handleSeriesToggle = (sourceIndex: number, checked: boolean) => {
    if (checked) {
      // Add series back
      const axisLabel = availableAxes.find((a) => a.index === sourceIndex);
      const newSeries: ChartSeries = {
        name: axisLabel?.label ?? `Series ${sourceIndex}`,
        sourceIndex,
        color: null,
      };
      onSeriesChange([...series, newSeries].sort((a, b) => a.sourceIndex - b.sourceIndex));
    } else {
      // Remove series
      onSeriesChange(series.filter((s) => s.sourceIndex !== sourceIndex));
    }
  };

  const handleSeriesColorChange = (sourceIndex: number, color: string) => {
    onSeriesChange(
      series.map((s) =>
        s.sourceIndex === sourceIndex ? { ...s, color } : s,
      ),
    );
  };

  // Build all possible series indices (all axes except the category axis)
  const allSeriesIndices = availableAxes
    .filter((a) => a.index !== categoryIndex)
    .map((a) => a.index);

  const activeSources = new Set(series.map((s) => s.sourceIndex));

  return (
    <>
      {/* Source Range */}
      <FieldGroup>
        <Label>Data Range</Label>
        <Input
          type="text"
          value={sourceRange}
          onChange={(e) => onSourceRangeChange(e.target.value)}
          placeholder="e.g., Sheet1!A1:D10"
        />
      </FieldGroup>

      {/* Has Headers */}
      <FieldGroup>
        <CheckboxLabel>
          <input
            type="checkbox"
            checked={hasHeaders}
            onChange={(e) => onHasHeadersChange(e.target.checked)}
          />
          First row contains headers
        </CheckboxLabel>
      </FieldGroup>

      {/* Series Orientation */}
      <FieldGroup>
        <Label>Series in</Label>
        <RadioGroup>
          <RadioLabel>
            <input
              type="radio"
              name="orientation"
              checked={orientation === "columns"}
              onChange={() => onOrientationChange("columns")}
            />
            Columns
          </RadioLabel>
          <RadioLabel>
            <input
              type="radio"
              name="orientation"
              checked={orientation === "rows"}
              onChange={() => onOrientationChange("rows")}
            />
            Rows
          </RadioLabel>
        </RadioGroup>
      </FieldGroup>

      {/* Category Axis */}
      {availableAxes.length > 0 && (
        <FieldGroup>
          <Label>Category axis ({orientation === "columns" ? "column" : "row"})</Label>
          <Select
            value={categoryIndex}
            onChange={(e) => onCategoryIndexChange(parseInt(e.target.value, 10))}
          >
            {availableAxes.map((axis) => (
              <option key={axis.index} value={axis.index}>
                {axis.label}
              </option>
            ))}
          </Select>
        </FieldGroup>
      )}

      {/* Series Selection */}
      <FieldGroup>
        <Label>Series</Label>
        <SeriesList>
          {allSeriesIndices.map((idx) => {
            const axisLabel = availableAxes.find((a) => a.index === idx)?.label ?? `Column ${idx}`;
            const seriesDef = series.find((s) => s.sourceIndex === idx);
            const isActive = activeSources.has(idx);
            const colorIndex = series.findIndex((s) => s.sourceIndex === idx);

            return (
              <SeriesItem key={idx}>
                <input
                  type="checkbox"
                  checked={isActive}
                  onChange={(e) => handleSeriesToggle(idx, e.target.checked)}
                />
                <span style={{ flex: 1 }}>{axisLabel}</span>
                {isActive && (
                  <ColorSwatch
                    type="color"
                    value={seriesDef?.color ?? getSeriesColor(palette, colorIndex, null)}
                    onChange={(e) => handleSeriesColorChange(idx, e.target.value)}
                    title="Series color"
                  />
                )}
              </SeriesItem>
            );
          })}
          {allSeriesIndices.length === 0 && (
            <SeriesItem>
              <span style={{ color: "var(--text-secondary)", fontStyle: "italic" }}>
                No series available. Select a data range with multiple columns.
              </span>
            </SeriesItem>
          )}
        </SeriesList>
      </FieldGroup>
    </>
  );
}
