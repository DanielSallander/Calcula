//! FILENAME: app/extensions/Charts/components/tabs/DataTab.tsx
// PURPOSE: Data tab of the chart dialog. Source range, series orientation,
//          category axis, and series selection.
// CONTEXT: The range half (the range field down to the series list) is
//          data/RangeSourceEditor, shared with the object pane's range Data tab
//          (WP-C S9c); this tab adds the source-mode radio and the design-query
//          editor around it.

import React from "react";
import type { ConnectionInfo } from "@api";
import type { ChartSpec, ChartSeries, SeriesOrientation } from "../../types";
import { DesignQueryEditor } from "../DesignQueryEditor";
import { RangeSourceEditor } from "../data/RangeSourceEditor";
import {
  FieldGroup,
  Label,
  Select,
  Button,
  RadioGroup,
  RadioLabel,
  DesignGrid,
  GridSpan,
} from "../CreateChartDialog.styles";

type SourceMode = "range" | "designQuery";

interface DataTabProps {
  sourceRange: string;
  onSourceRangeChange: (value: string) => void;
  /**
   * Why the typed range cannot be charted (a canvas range without its sheet, a
   * canvas named as the source, an unknown sheet, a malformed range), shown
   * right under the field. Null/absent: nothing to say.
   */
  sourceRangeError?: string | null;
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
  /**
   * The spec being composed, for the one series-colour spelling (OB-1). Null
   * before the source range parses, which is exactly when there are no series
   * to colour either.
   */
  spec: ChartSpec | null;
  /** Emits a spec patch, the way the Design and Spec tabs do. */
  onSpecChange: (updates: Partial<ChartSpec>) => void;
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
  sourceRangeError,
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
  spec,
  onSpecChange,
  availableAxes,
  palette,
  onInspectData,
  inspectDisabled,
}: DataTabProps): React.ReactElement {
  return (
    <DesignGrid>
      {/* Source mode: cell range vs design query (BI model). Spans both columns
          — it decides which fields below even exist, so it reads as a heading
          for them rather than as a peer sitting beside one of them. */}
      {designQueryAvailable && (
        <GridSpan>
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
        </GridSpan>
      )}

      {sourceMode === "designQuery" ? (
        <>
          {/* BI connection — one control, so it keeps a single column and the
              query editor beside it gets the rest. */}
          <FieldGroup>
            <Label>Connection</Label>
            <Select
              value={connectionId}
              onChange={(e) => onConnectionIdChange(e.target.value)}
              style={{ width: "100%" }}
            >
              <option value="">— Select a BI connection —</option>
              {connections.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </Select>
          </FieldGroup>

          {onInspectData && (
            <FieldGroup>
              <Label>Query result</Label>
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
            </FieldGroup>
          )}

          {/* Design query DSL (shared pivot-layout-dsl Monaco editor) — the one
              genuinely wide control here, so it takes the full pane. */}
          <GridSpan>
            <FieldGroup>
              <Label>Design query</Label>
              <DesignQueryEditor
                value={dslText}
                onChange={onDslTextChange}
                connectionId={connectionId}
              />
              <span style={{ fontSize: "11px", color: "var(--text-secondary)", marginTop: "4px", display: "block" }}>
                Ctrl+Space suggests fields and measures. The query runs against the connection's model — the data lives in the chart, no pivot table needed.
              </span>
            </FieldGroup>
          </GridSpan>
        </>
      ) : (
        <RangeSourceEditor
          sourceRange={sourceRange}
          onSourceRangeChange={onSourceRangeChange}
          sourceRangeError={sourceRangeError}
          hasHeaders={hasHeaders}
          onHasHeadersChange={onHasHeadersChange}
          orientation={orientation}
          onOrientationChange={onOrientationChange}
          categoryIndex={categoryIndex}
          onCategoryIndexChange={onCategoryIndexChange}
          series={series}
          onSeriesChange={onSeriesChange}
          spec={spec}
          onSpecChange={onSpecChange}
          availableAxes={availableAxes}
          palette={palette}
        />
      )}
    </DesignGrid>
  );
}
