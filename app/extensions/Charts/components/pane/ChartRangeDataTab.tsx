//! FILENAME: app/extensions/Charts/components/pane/ChartRangeDataTab.tsx
// PURPOSE: The object pane's Data tab for a chart that reads a CELL RANGE (or a
//          defined name over one): the chart dialog's range editor, writing
//          the selected chart directly.
// CONTEXT: WP-C S9c (D-PANE: a range chart has Data | Format). The editor is
//          data/RangeSourceEditor and the rules are data/useRangeSource -- the
//          same ones the Insert/Edit Chart dialog uses -- so a range typed here
//          binds, refuses and detects series exactly as it does there.
//
//          WHEN IT WRITES. The range field commits on blur / Enter, never per
//          keystroke: the stored series must not change under a reader who is
//          still typing. A commit binds the text (a sheet-qualified range, an
//          unprefixed range on the chart's own sheet -- refused on a canvas,
//          which has no cells -- or a defined name, stored BY NAME), decides
//          the series shape (`detectRangeShape`: the one-cell rule and the
//          header row a single cell switched off included) and writes
//          `{data, series, categoryIndex, hasHeaders, seriesOrientation}` as
//          ONE `updateChartSpec` in ONE undo step (lib/chartDataCommit). The
//          header row and the orientation re-detect the series the way the
//          dialog does; the category and the series checkboxes write at once;
//          a series colour writes once per pick (the native change), through
//          the one colour spelling `seriesColors[name]`.
//
//          A refusal is shown under the field and writes nothing. On a
//          subscribed page every control is disabled (the pane's readOnly).

import React, { useCallback, useEffect, useId, useReducer, useRef, useState } from "react";
import { getSheets } from "@api";
import { onRegionChange } from "@api/gridOverlays";
import { AppEvents, onAppEvent } from "@api/events";
import type { SheetInfo } from "@api/lib";
import type { ObjectPaneTabContext } from "@api/objectPane";
import type { ChartDefinition, ChartSpec, DataRangeRef, DataSource, SeriesOrientation } from "../../types";
import { isDataRangeRef } from "../../types";
import { ChartEvents } from "../../lib/chartEvents";
import {
  bindRangeText,
  isCanvasSheet,
  looksLikeDefinedName,
  rangeRefDisplayText,
  RANGE_FORMAT_MESSAGE,
} from "../../lib/chartRangeBinding";
import { commitChartDataPatch, replacementRangeRef } from "../../lib/chartDataCommit";
import { RangeSourceEditor } from "../data/RangeSourceEditor";
import { detectRangeShape, resolveRangeName, useRangeSource, type RangeShape } from "../data/useRangeSource";

export interface ChartRangeDataTabProps {
  ctx: ObjectPaneTabContext;
  chartId: string;
  getChart(chartId: string): ChartDefinition | null;
  /** Open the chart dialog's Data tab (a design query, the Spec tab, ...). */
  onEditInDialog?: () => void;
}

/** The sentence for an empty range field. */
export const EMPTY_RANGE_MESSAGE = "Please enter a data range for the chart.";
/** The sentence for a range whose cells hold nothing to plot. */
export const NO_SERIES_MESSAGE =
  "This range has nothing to plot. Choose a range with at least one column of values.";
/** The sentence while the sheet list is still being read. */
export const SHEETS_PENDING_MESSAGE = "Still reading the workbook's sheets. Try again in a moment.";

/** The text the range field shows for a stored source. */
export function storedRangeText(data: DataSource | null | undefined, sheets: readonly SheetInfo[]): string {
  if (typeof data === "string") return data;
  if (data && isDataRangeRef(data)) return rangeRefDisplayText(data, sheets, null);
  return "";
}

/** The stored source as a patch value (a ref complete, so no stale id survives the merge). */
function dataAsPatch(data: DataSource): DataSource {
  return isDataRangeRef(data) ? replacementRangeRef(data) : data;
}

/** The ONE patch shape every range commit writes. */
export function rangeDataPatch(data: DataSource, shape: RangeShape, orientation: SeriesOrientation): Partial<ChartSpec> {
  return {
    data: dataAsPatch(data),
    series: shape.series,
    categoryIndex: shape.categoryIndex,
    hasHeaders: shape.hasHeaders,
    seriesOrientation: orientation,
  };
}

/** Re-render on every chart edit and every region change (undo, a reload). */
function useChartRevision(): number {
  const [revision, bump] = useReducer((n: number) => n + 1, 0);
  useEffect(() => {
    const onUpdated = (): void => bump();
    window.addEventListener(ChartEvents.CHART_UPDATED, onUpdated);
    const offRegions = onRegionChange(() => bump());
    return () => {
      window.removeEventListener(ChartEvents.CHART_UPDATED, onUpdated);
      offRegions();
    };
  }, []);
  return revision;
}

export function ChartRangeDataTab({ ctx, chartId, getChart, onEditInDialog }: ChartRangeDataTabProps): React.ReactElement {
  useChartRevision();
  const chart = getChart(chartId);
  const spec = chart?.spec ?? null;
  const readOnly = ctx.readOnly;
  const groupName = `chart-pane-orientation-${useId()}`;

  // The workbook's sheets: what the range text binds against (by name -> index
  // + id) and what a stored reference is displayed by (by id).
  const [sheets, setSheets] = useState<SheetInfo[]>([]);
  useEffect(() => {
    let live = true;
    const load = (): void => {
      getSheets()
        .then((r) => {
          if (live) setSheets(r.sheets);
        })
        .catch((err) => console.error("[Charts] The Data tab could not read the sheets:", err));
    };
    load();
    const offs = [
      onAppEvent(AppEvents.SHEET_ADDED, load),
      onAppEvent(AppEvents.SHEET_DELETED, load),
      onAppEvent(AppEvents.SHEET_RENAMED, load),
    ];
    return () => {
      live = false;
      offs.forEach((off) => off());
    };
  }, []);

  // The chart's OWN sheet: an unprefixed range means it, and on a canvas page
  // (no cells) an unprefixed range is refused.
  const chartSheetIndex = chart?.sheetIndex ?? 0;
  const chartSheet = sheets.find((s) => s.index === chartSheetIndex) ?? null;
  const bindingContext = {
    sheets,
    currentSheetIndex: chartSheetIndex,
    currentSheetName: chartSheet?.name ?? "",
    currentIsCanvas: isCanvasSheet(chartSheet),
  };

  const storedText = spec ? storedRangeText(spec.data, sheets) : "";
  const orientation: SeriesOrientation = spec?.seriesOrientation ?? "columns";
  const hasHeaders = spec?.hasHeaders ?? true;

  // The field's text: the stored source until the reader types. A stored
  // change (an undo, a commit, the sheet list arriving) re-seeds the field
  // only while the reader has not typed over the last seed.
  const [draft, setDraft] = useState(storedText);
  const seedRef = useRef(storedText);
  useEffect(() => {
    const previousSeed = seedRef.current;
    if (storedText === previousSeed) return;
    // The updater runs at the next render, after the ref has moved on: it
    // compares against the seed captured HERE.
    setDraft((current) => (current === previousSeed ? storedText : current));
    seedRef.current = storedText;
  }, [storedText]);

  // The STORED source gives the axes and the series list; the TYPED text gives
  // the inline reason it cannot be charted, as the dialog shows it.
  const stored = useRangeSource({
    sourceRange: storedText,
    sheets,
    currentSheetIndex: bindingContext.currentSheetIndex,
    currentSheetName: bindingContext.currentSheetName,
    currentIsCanvas: bindingContext.currentIsCanvas,
    rangeMode: true,
    orientation,
  });
  const typed = useRangeSource({
    sourceRange: draft,
    sheets,
    currentSheetIndex: bindingContext.currentSheetIndex,
    currentSheetName: bindingContext.currentSheetName,
    currentIsCanvas: bindingContext.currentIsCanvas,
    rangeMode: true,
    orientation,
  });

  const [commitError, setCommitError] = useState<string | null>(null);
  // True while the header row is off only because the source is one cell.
  const headersForcedOffRef = useRef(false);
  // The range text being committed, so Enter followed by the blur it causes
  // writes once.
  const pendingTextRef = useRef<string | null>(null);
  // A colour being picked: shown on the swatch until the pick is written.
  const [draftColors, setDraftColors] = useState<Record<string, string> | null>(null);

  const write = useCallback(
    async (patch: Partial<ChartSpec>): Promise<boolean> => {
      try {
        await commitChartDataPatch(chartId, patch);
        setCommitError(null);
        return true;
      } catch (err) {
        setCommitError(err instanceof Error ? err.message : String(err));
        return false;
      }
    },
    [chartId],
  );

  /** Re-decide the series of the STORED source with a new header row / orientation, and write. */
  const rewriteShape = async (next: { hasHeaders: boolean; orientation: SeriesOrientation }): Promise<void> => {
    if (readOnly || !spec) return;
    const ref = stored.boundRef;
    if (!ref) {
      // The stored source does not resolve (its sheet is gone): keep the
      // reader's choice, there is nothing to detect.
      await write({ hasHeaders: next.hasHeaders, seriesOrientation: next.orientation });
      return;
    }
    try {
      const shape = await detectRangeShape(ref, {
        hasHeaders: next.hasHeaders,
        headersForcedOff: headersForcedOffRef.current,
        name: typeof spec.data === "string" ? spec.data : null,
      });
      headersForcedOffRef.current = shape.headersForcedOff;
      await write(rangeDataPatch(spec.data, shape, next.orientation));
    } catch (err) {
      setCommitError(err instanceof Error ? err.message : String(err));
    }
  };

  /** Commit the typed range (blur / Enter). */
  const commitRange = async (): Promise<void> => {
    if (readOnly || !spec) return;
    const text = draft.trim();
    if (text === storedText.trim() || text === pendingTextRef.current) return;
    if (text === "") {
      setCommitError(EMPTY_RANGE_MESSAGE);
      return;
    }
    pendingTextRef.current = text;
    try {
      let ref: DataRangeRef;
      let data: DataSource;
      let name: string | null = null;
      const binding = bindRangeText(text, bindingContext);
      if (binding.ok) {
        ref = binding.ref;
        data = replacementRangeRef(binding.ref);
      } else if (looksLikeDefinedName(text)) {
        const answer = await resolveRangeName(text, sheets);
        if (answer.ref === null) {
          setCommitError(answer.error);
          return;
        }
        ref = answer.ref;
        data = text; // stored BY NAME: the chart follows the name when it is redefined
        name = text;
      } else {
        setCommitError(binding.message ?? (sheets.length === 0 ? SHEETS_PENDING_MESSAGE : RANGE_FORMAT_MESSAGE));
        return;
      }
      const shape = await detectRangeShape(ref, {
        hasHeaders,
        headersForcedOff: headersForcedOffRef.current,
        name,
      });
      const isComposition = !!(spec.concat || spec.facet || spec.repeat);
      if (shape.series.length === 0 && !isComposition) {
        setCommitError(NO_SERIES_MESSAGE);
        return;
      }
      headersForcedOffRef.current = shape.headersForcedOff;
      await write(rangeDataPatch(data, shape, orientation));
    } catch (err) {
      setCommitError(err instanceof Error ? err.message : String(err));
    } finally {
      pendingTextRef.current = null;
    }
  };

  if (!chart || !spec) {
    return (
      <div data-testid="chart-range-data-tab" style={{ padding: "8px 12px", fontSize: 12 }}>
        This chart no longer exists.
      </div>
    );
  }

  const shownSpec: ChartSpec = draftColors
    ? { ...spec, seriesColors: { ...(spec.seriesColors ?? {}), ...draftColors } }
    : spec;
  const shownError = commitError ?? typed.rangeError;

  return (
    <div
      data-testid="chart-range-data-tab"
      data-tab-id={ctx.activeTabId}
      style={{ padding: "8px 12px", display: "flex", flexDirection: "column", gap: 4 }}
    >
      <fieldset
        disabled={readOnly}
        title={readOnly ? (ctx.readOnlyReason ?? undefined) : undefined}
        style={{ border: "none", padding: 0, margin: 0, minWidth: 0 }}
      >
        <RangeSourceEditor
          sourceRange={draft}
          onSourceRangeChange={(value) => {
            setDraft(value);
            setCommitError(null);
          }}
          sourceRangeError={shownError}
          onSourceRangeBlur={() => void commitRange()}
          onSourceRangeEnter={() => void commitRange()}
          hasHeaders={hasHeaders}
          onHasHeadersChange={(value) => void rewriteShape({ hasHeaders: value, orientation })}
          orientation={orientation}
          onOrientationChange={(value) => void rewriteShape({ hasHeaders, orientation: value })}
          categoryIndex={spec.categoryIndex}
          onCategoryIndexChange={(value) => {
            if (!readOnly) void write({ categoryIndex: value });
          }}
          series={spec.series}
          onSeriesChange={(series) => {
            if (!readOnly) void write({ series });
          }}
          spec={shownSpec}
          onSpecChange={(updates) => {
            if (updates.seriesColors) setDraftColors({ ...updates.seriesColors });
          }}
          onSeriesColorCommit={(updates) => {
            if (readOnly) {
              setDraftColors(null);
              return;
            }
            void write(updates).finally(() => setDraftColors(null));
          }}
          // The STORED colours (never the draft): {} when none are stored, because
          // an absent prop means "diff against `spec`" -- which here is the draft.
          storedSeriesColors={spec.seriesColors ?? {}}
          onSeriesColorEnd={() => setDraftColors(null)}
          availableAxes={stored.availableAxes}
          palette={spec.palette ?? "default"}
          orientationGroupName={groupName}
          testIdPrefix="chart-data-range"
        />
      </fieldset>
      {onEditInDialog && (
        <div>
          <button
            type="button"
            data-testid="chart-data-edit-in-dialog"
            disabled={readOnly}
            onClick={onEditInDialog}
            style={{ fontSize: 12 }}
          >
            More data options...
          </button>
        </div>
      )}
    </div>
  );
}
