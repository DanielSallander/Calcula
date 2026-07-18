//! FILENAME: app/extensions/Charts/components/tabs/DataTab.tsx
// PURPOSE: Data tab of the chart dialog. Source range, series orientation,
//          category axis, and series selection.

import React from "react";
import type { ConnectionInfo } from "@api";
import type { ChartSpec, ChartSeries, SeriesOrientation } from "../../types";
import { getSeriesColor } from "../../rendering/chartTheme";
import { DesignQueryEditor } from "../DesignQueryEditor";
import {
  FieldGroup,
  Label,
  Input,
  Select,
  Button,
  CheckboxLabel,
  RadioGroup,
  RadioLabel,
  SeriesList,
  SeriesItem,
  ColorSwatch,
} from "../CreateChartDialog.styles";

type SourceMode = "range" | "designQuery";

interface DataTabProps {
  sourceRange: string;
  onSourceRangeChange: (value: string) => void;
  /** Which kind of data source this chart uses. */
  sourceMode: SourceMode;
  onSourceModeChange: (value: SourceMode) => void;
  /** Whether the design-query source is offered (false in pivot mode). */
  designQueryAvailable: boolean;
  /** Design-query DSL text. */
  dslText: string;
  onDslTextChange: (value: string) => void;
  /** Selected BI connection id for the design query. */
  connectionId: string;
  onConnectionIdChange: (value: string) => void;
  /** Available BI connections for the design-query picker. */
  connections: ConnectionInfo[];
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
  /** Opens the floating "inspect data" grid for the current query result. */
  onInspectData?: () => void;
  /** Disable the inspect button (no preview data yet / query broken). */
  inspectDisabled?: boolean;
}

export function DataTab({
  sourceRange,
  onSourceRangeChange,
  sourceMode,
  onSourceModeChange,
  designQueryAvailable,
  dslText,
  onDslTextChange,
  connectionId,
  onConnectionIdChange,
  connections,
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
  onInspectData,
  inspectDisabled,
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
      {/* Source mode: cell range vs design query (BI model) */}
      {designQueryAvailable && (
        <FieldGroup>
          <Label>Data source</Label>
          <RadioGroup>
            <RadioLabel>
              <input
                type="radio"
                name="sourceMode"
                checked={sourceMode === "range"}
                onChange={() => onSourceModeChange("range")}
              />
              Cell range
            </RadioLabel>
            <RadioLabel>
              <input
                type="radio"
                name="sourceMode"
                checked={sourceMode === "designQuery"}
                onChange={() => onSourceModeChange("designQuery")}
              />
              Design query
            </RadioLabel>
          </RadioGroup>
        </FieldGroup>
      )}

      {sourceMode === "designQuery" ? (
        <>
          {/* BI connection */}
          <FieldGroup>
            <Label>Connection</Label>
            <Select
              value={connectionId}
              onChange={(e) => onConnectionIdChange(e.target.value)}
            >
              <option value="">— Select a BI connection —</option>
              {connections.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </Select>
          </FieldGroup>

          {/* Design query DSL (shared pivot-layout-dsl Monaco editor) */}
          <FieldGroup>
            <Label>Design query</Label>
            <DesignQueryEditor
              value={dslText}
              onChange={onDslTextChange}
              connectionId={connectionId}
            />
            <span style={{ fontSize: "11px", color: "var(--text-secondary)", marginTop: "4px" }}>
              Ctrl+Space suggests fields and measures. The query runs against the connection's model — the data lives in the chart, no pivot table needed.
            </span>
            {onInspectData && (
              <div style={{ marginTop: "8px" }}>
                <Button
                  onClick={onInspectData}
                  disabled={inspectDisabled}
                  title={
                    inspectDisabled
                      ? "Run a valid query first"
                      : "Show the query result as a data grid in a floating window"
                  }
                >
                  Inspect data...
                </Button>
              </div>
            )}
          </FieldGroup>
        </>
      ) : (
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
      )}
    </>
  );
}
