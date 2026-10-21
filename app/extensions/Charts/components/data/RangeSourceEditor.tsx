//! FILENAME: app/extensions/Charts/components/data/RangeSourceEditor.tsx
// PURPOSE: The RANGE half of a chart's data editor: the data range field (with
//          the inline reason it cannot be charted), series in columns / rows,
//          the header row, the category axis and the series list with each
//          series' colour.
// CONTEXT: Extracted from the chart dialog's Data tab (WP-C S9c). The dialog's
//          Data tab renders it under its source-mode radio, unchanged; the
//          object pane's range Data tab (pane/ChartRangeDataTab) renders it for
//          the chart that is selected. It renders two blocks -- what the data
//          IS, then which of it gets PLOTTED -- as siblings, so the caller's
//          grid decides whether they sit side by side (the dialog) or stack
//          (the narrow pane).
//
//          The series colour goes through the ONE spelling (OB-1): it reads and
//          writes `spec.seriesColors[name]` via `readSeriesColor` /
//          `seriesColorPatch`, never `spec.series[i].color` (the base the
//          override wins over). The patch is emitted through `onSpecChange` on
//          every step of the picker, as the dialog always did; a caller that
//          must WRITE once per pick (the pane: one undo step) also passes
//          `onSeriesColorCommit`, which fires on the native `change` event --
//          when the picker closes -- not on every step of the drag. The picker
//          is driven by the shared `useNativeColorPick` (round 2, G1).
//
//          A caller that SHOWS a draft (the pane puts every step into a draft
//          and passes the drafted spec as `spec`) passes its STORED colours as
//          `storedSeriesColors`: the commit patch is diffed against those,
//          never against the draft on screen. Diffed against the draft, the
//          picked colour already "was" the series colour, the patch came out
//          empty and the pick never persisted (round 2, review R1-2). A pick
//          that changes nothing calls `onSeriesColorEnd` instead, so the caller
//          can drop its draft.

import React from "react";
import type { ChartSpec, ChartSeries, SeriesOrientation } from "../../types";
import { getSeriesColor } from "../../rendering/chartTheme";
import { readSeriesColor, seriesColorPatch } from "../../lib/chartDataReader";
import { useNativeColorPick } from "../../../_shared/components/colorPick";
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
import type { RangeAxis } from "./useRangeSource";

export interface RangeSourceEditorProps {
  sourceRange: string;
  onSourceRangeChange: (value: string) => void;
  /**
   * Why the typed range cannot be charted (a canvas range without its sheet, a
   * canvas named as the source, an unknown sheet, a malformed range), shown
   * right under the field. Null/absent: nothing to say.
   */
  sourceRangeError?: string | null;
  /** The range field lost focus (the pane commits the typed range here). */
  onSourceRangeBlur?: () => void;
  /** Enter in the range field (the pane commits the typed range here). */
  onSourceRangeEnter?: () => void;
  hasHeaders: boolean;
  onHasHeadersChange: (value: boolean) => void;
  orientation: SeriesOrientation;
  onOrientationChange: (value: SeriesOrientation) => void;
  categoryIndex: number;
  onCategoryIndexChange: (value: number) => void;
  series: ChartSeries[];
  onSeriesChange: (series: ChartSeries[]) => void;
  /**
   * The spec being edited, for the one series-colour spelling (OB-1). Null
   * before the source range parses, which is exactly when there are no series
   * to colour either.
   */
  spec: ChartSpec | null;
  /** Emits a spec patch (the series colour), the way the Design and Spec tabs do. */
  onSpecChange: (updates: Partial<ChartSpec>) => void;
  /** Fires once per colour PICK (the native change), with the same patch. */
  onSeriesColorCommit?: (updates: Partial<ChartSpec>) => void;
  /**
   * The STORED series colours, the base a colour commit is diffed against.
   * Default `spec.seriesColors`. A caller whose `spec` is a DRAFT carrying the
   * previewed colour must pass its stored colours here -- `{}` when none are
   * stored, never `undefined` (which falls back to the draft) -- or every pick
   * diffs to "no change" and is never written.
   */
  storedSeriesColors?: Record<string, string>;
  /** A colour pick ended without a write (the stored colour picked back, or
   *  the picker closed without a change): drop any draft of the steps. */
  onSeriesColorEnd?: () => void;
  /** Available column/row labels for the category dropdown. */
  availableAxes: RangeAxis[];
  /** Palette name for colour previews. */
  palette: string;
  /** The radio group's name (unique per editor on the page). */
  orientationGroupName?: string;
  /** Test hook prefix for the pane ("chart-data-range"); absent in the dialog. */
  testIdPrefix?: string;
}

/** A series colour swatch that reports the end of a pick separately from its
 *  steps: every `input` step is `onStep`, the native `change` is ONE
 *  `onCommit`, and a pick that ends on the colour it started from is `onEnd`. */
function SeriesColorSwatch({
  value,
  onStep,
  onCommit,
  onEnd,
  testId,
}: {
  value: string;
  onStep: (hex: string) => void;
  onCommit: (hex: string) => void;
  onEnd?: () => void;
  testId?: string;
}): React.ReactElement {
  const picker = useNativeColorPick({ value, onStep, onCommit, onEnd });
  return <ColorSwatch {...picker} title="Series color" data-testid={testId} />;
}

export function RangeSourceEditor({
  sourceRange,
  onSourceRangeChange,
  sourceRangeError,
  onSourceRangeBlur,
  onSourceRangeEnter,
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
  onSeriesColorCommit,
  storedSeriesColors,
  onSeriesColorEnd,
  availableAxes,
  palette,
  orientationGroupName = "orientation",
  testIdPrefix,
}: RangeSourceEditorProps): React.ReactElement {
  const tid = (part: string): string | undefined => (testIdPrefix ? `${testIdPrefix}-${part}` : undefined);

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

  /**
   * Set the colour of a series — through the ONE spelling (OB-1).
   *
   * This used to write `spec.series[i].color`, which is the BASE that
   * `applySeriesColorOverrides` overwrites from `spec.seriesColors[name]`. So a
   * series that had ever been coloured from the Format pane or the Design tab
   * ignored this swatch, and the swatch went on showing the colour it had
   * written rather than the one the chart was drawn with. It now reads and
   * writes the same name-keyed field every other surface does, through
   * `readSeriesColor` / `seriesColorPatch`.
   *
   * The patch goes to `onSpecChange` rather than `onSeriesChange` because
   * `seriesColors` is not one of the dialog's managed fields; the dialog keeps
   * it in the spec overlay, which REPLACES a key — the form the shared writer
   * already builds for.
   */
  const handleSeriesColorChange = (seriesName: string, color: string) => {
    const patch = seriesColorPatch(spec ?? {}, seriesName, color);
    if (patch !== null) onSpecChange(patch);
  };
  // The ONE write of a pick, diffed against the STORED colours (never the
  // draft this editor may be showing). Without a committing caller (the
  // dialog, which writes on OK), the pick's last colour goes to the dialog's
  // spec overlay like every step does.
  const handleSeriesColorCommit = (seriesName: string, color: string) => {
    if (!onSeriesColorCommit) {
      handleSeriesColorChange(seriesName, color);
      return;
    }
    const base = { seriesColors: storedSeriesColors ?? spec?.seriesColors };
    const patch = seriesColorPatch(base, seriesName, color);
    if (patch !== null) onSeriesColorCommit(patch);
    else onSeriesColorEnd?.();
  };

  // Build all possible series indices (all axes except the category axis)
  const allSeriesIndices = availableAxes
    .filter((a) => a.index !== categoryIndex)
    .map((a) => a.index);

  const activeSources = new Set(series.map((s) => s.sourceIndex));

  return (
    <>
      {/* What the data IS. */}
      <div>
        <FieldGroup>
          <Label>Data Range</Label>
          <Input
            type="text"
            value={sourceRange}
            onChange={(e) => onSourceRangeChange(e.target.value)}
            onBlur={onSourceRangeBlur ? () => onSourceRangeBlur() : undefined}
            onKeyDown={
              onSourceRangeEnter
                ? (e) => {
                    if (e.key === "Enter") {
                      e.preventDefault();
                      onSourceRangeEnter();
                    }
                  }
                : undefined
            }
            placeholder="e.g., Sheet1!A1:D10"
            aria-invalid={sourceRangeError ? true : undefined}
            data-testid={tid("input")}
          />
          {sourceRangeError && (
            <span
              data-testid="chart-range-error"
              aria-live="polite"
              style={{ fontSize: "11px", color: "var(--text-error, #c42b1c)", marginTop: "4px", display: "block" }}
            >
              {sourceRangeError}
            </span>
          )}
        </FieldGroup>

        <FieldGroup>
          <Label>Series in</Label>
          <RadioGroup>
            <RadioLabel>
              <input
                type="radio"
                name={orientationGroupName}
                checked={orientation === "columns"}
                onChange={() => onOrientationChange("columns")}
                data-testid={tid("columns")}
              />
              Columns
            </RadioLabel>
            <RadioLabel>
              <input
                type="radio"
                name={orientationGroupName}
                checked={orientation === "rows"}
                onChange={() => onOrientationChange("rows")}
                data-testid={tid("rows")}
              />
              Rows
            </RadioLabel>
          </RadioGroup>
          <CheckboxLabel>
            <input
              type="checkbox"
              checked={hasHeaders}
              onChange={(e) => onHasHeadersChange(e.target.checked)}
              data-testid={tid("headers")}
            />
            First row contains headers
          </CheckboxLabel>
        </FieldGroup>

        {availableAxes.length > 0 && (
          <FieldGroup>
            <Label>Category axis ({orientation === "columns" ? "column" : "row"})</Label>
            <Select
              value={categoryIndex}
              onChange={(e) => onCategoryIndexChange(parseInt(e.target.value, 10))}
              style={{ width: "100%" }}
              data-testid={tid("category")}
            >
              {availableAxes.map((axis) => (
                <option key={axis.index} value={axis.index}>
                  {axis.label}
                </option>
              ))}
            </Select>
          </FieldGroup>
        )}
      </div>

      {/* Which of it gets PLOTTED. The series list is the one control here
          that grows with the data, so it gets its own block instead of being
          the thing that pushes everything else off screen. */}
      <div>
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
                    data-testid={tid(`series-${idx}`)}
                  />
                  <span style={{ flex: 1 }}>{axisLabel}</span>
                  {isActive && seriesDef && (
                    <SeriesColorSwatch
                      value={
                        readSeriesColor(spec ?? {}, seriesDef.name)
                        ?? seriesDef.color
                        ?? getSeriesColor(palette, colorIndex, null)
                      }
                      onStep={(hex) => handleSeriesColorChange(seriesDef.name, hex)}
                      onCommit={(hex) => handleSeriesColorCommit(seriesDef.name, hex)}
                      onEnd={onSeriesColorEnd}
                      testId={tid(`series-color-${idx}`)}
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
      </div>
    </>
  );
}
