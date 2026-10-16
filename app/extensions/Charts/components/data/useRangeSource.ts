//! FILENAME: app/extensions/Charts/components/data/useRangeSource.ts
// PURPOSE: THE range-source state machine of a chart: bind the typed text to a
//          DataRangeRef (a sheet-qualified range, an unprefixed range on the
//          current sheet, or a DEFINED NAME resolved through the workbook's
//          names), say why it cannot be charted, list the axes the range
//          offers, and decide the series shape (the one-cell rule, the header
//          row a single cell switched off, series auto-detection).
// CONTEXT: Extracted from the Insert/Edit Chart dialog (WP-C S9c) so that the
//          dialog's Data tab and the object pane's range Data tab
//          (pane/ChartRangeDataTab) follow ONE set of rules. The dialog keeps
//          its exact behaviour: it hands the hook its own state setters
//          (`detection`) and the hook re-detects series whenever the bound
//          range, the header flag or the orientation changes, step for step as
//          the effect that used to live in CreateChartDialog did.
//
//          The pane does NOT auto-detect while the reader types: it commits on
//          blur / Enter, and asks `detectRangeShape` for the series of the
//          range it is about to store, so the stored series never change under
//          a reader who is still typing. Both callers reach the same decision
//          through `planRangeShape`.
//
//          The one-cell rule (2026-10-08): ONE cell is ONE value -- a Card or a
//          Gauge over it. It has no header row and no category column; the
//          cell itself is the series, named by the defined name or by its
//          address. Detection would find no series at all (it treats the first
//          column as the category). Going back from one cell to a table turns
//          the header row back on -- only when it was the single cell, not the
//          reader, that switched it off.

import { useEffect, useMemo, useRef, useState } from "react";
import { indexToCol } from "@api";
import type { SheetInfo } from "@api/lib";
import type { ChartSeries, DataRangeRef, SeriesOrientation } from "../../types";
import { autoDetectSeries } from "../../lib/chartDataReader";
import { resolveDataSource } from "../../lib/dataSourceResolver";
import {
  bindRangeText,
  canvasSourceMessage,
  looksLikeDefinedName,
  type RangeBinding,
} from "../../lib/chartRangeBinding";

// ============================================================================
// Pure rules
// ============================================================================

/** One column (or row) of the range the category axis can be. */
export interface RangeAxis {
  index: number;
  label: string;
}

/**
 * The axes a range offers: one per column ("A", "B", ...) when series are in
 * columns, one per row ("Row 1", ...) when they are in rows.
 */
export function rangeAxes(ref: DataRangeRef, orientation: SeriesOrientation): RangeAxis[] {
  const axes: RangeAxis[] = [];
  if (orientation === "columns") {
    const numCols = ref.endCol - ref.startCol + 1;
    for (let c = 0; c < numCols; c++) {
      axes.push({ index: c, label: indexToCol(ref.startCol + c) });
    }
  } else {
    const numRows = ref.endRow - ref.startRow + 1;
    for (let r = 0; r < numRows; r++) {
      axes.push({ index: r, label: `Row ${ref.startRow + r + 1}` });
    }
  }
  return axes;
}

/** Whether the range is ONE cell (a Card or a Gauge over one value). */
export function isSingleCellRange(ref: DataRangeRef | null | undefined): boolean {
  return !!ref && ref.startRow === ref.endRow && ref.startCol === ref.endCol;
}

/** "B2" for a one-cell ref: what a single-cell series is called. */
export function rangeCellAddress(ref: DataRangeRef): string {
  return `${indexToCol(ref.startCol)}${ref.startRow + 1}`;
}

/**
 * Primitive identity of a bound range for effects: which cells, on which
 * sheet. The id is left out on purpose -- it names the same sheet the index
 * does, and a key that changed when the sheet list merely ARRIVED would re-run
 * series detection.
 */
export function rangeRefKey(ref: DataRangeRef | null | undefined): string {
  return ref ? `${ref.sheetIndex}|${ref.startRow}|${ref.startCol}|${ref.endRow}|${ref.endCol}` : "";
}

/** The answer for a DEFINED NAME typed as the source, kept with the name it answers. */
export interface NameResolution {
  name: string;
  ref: DataRangeRef | null;
  error: string | null;
}

/**
 * Resolve a defined name through the workbook's names (the same resolver every
 * chart read uses). A name over a CANVAS sheet is refused like a typed canvas
 * range: a canvas has no cells. The sheet's stable id is stamped when known.
 */
export async function resolveRangeName(name: string, sheets: readonly SheetInfo[]): Promise<NameResolution> {
  try {
    const ref = await resolveDataSource(name);
    const sheet = sheets.find((sh) => sh.index === ref.sheetIndex);
    if (sheet && sheet.kind === "canvas") {
      return { name, ref: null, error: canvasSourceMessage(sheet.name) };
    }
    const withId: DataRangeRef =
      sheet && typeof sheet.sheetId === "string" && sheet.sheetId !== "" ? { ...ref, sheetId: sheet.sheetId } : ref;
    return { name, ref: withId, error: null };
  } catch (err) {
    const why = err instanceof Error ? err.message : String(err);
    return {
      name,
      ref: null,
      error: `"${name}" is not a range or a defined name in this workbook. ${why}`,
    };
  }
}

/**
 * What the series shape of a bound range is decided by:
 *   - "single": one cell -- no header row, category 0, the cell is the series
 *     (`turnHeadersOff`: the header row is on and the single cell switches it
 *     off, remembering that it did);
 *   - "restoreHeaders": back from one cell to a table, with the header row the
 *     single cell switched off -- switch it back on, then decide again;
 *   - "detect": auto-detect the series (`clearForced`: forget that a single
 *     cell switched the header row off; the reader has it on again anyway).
 */
export type RangeShapePlan =
  | { kind: "single"; series: ChartSeries[]; turnHeadersOff: boolean }
  | { kind: "restoreHeaders" }
  | { kind: "detect"; clearForced: boolean };

export interface RangeShapeInputs {
  hasHeaders: boolean;
  /** True while the header row is off only because the source is one cell. */
  headersForcedOff: boolean;
  /** The defined name the range came from (names the one-cell series), or null. */
  name: string | null;
}

/** Decide the series shape of `ref` (see RangeShapePlan). Pure. */
export function planRangeShape(ref: DataRangeRef, inputs: RangeShapeInputs): RangeShapePlan {
  if (isSingleCellRange(ref)) {
    return {
      kind: "single",
      series: [{ name: inputs.name ?? rangeCellAddress(ref), sourceIndex: 0, color: null }],
      turnHeadersOff: inputs.hasHeaders,
    };
  }
  if (inputs.headersForcedOff && !inputs.hasHeaders) return { kind: "restoreHeaders" };
  return { kind: "detect", clearForced: inputs.headersForcedOff };
}

/** The series shape a range is stored with. */
export interface RangeShape {
  hasHeaders: boolean;
  categoryIndex: number;
  series: ChartSeries[];
  headersForcedOff: boolean;
}

/**
 * The series shape of `ref`, decided in one go (the pane's commit): the same
 * plan the dialog's effect follows step by step, run to its end.
 */
export async function detectRangeShape(ref: DataRangeRef, inputs: RangeShapeInputs): Promise<RangeShape> {
  let hasHeaders = inputs.hasHeaders;
  let forced = inputs.headersForcedOff;
  // At most two rounds: "restoreHeaders" is followed by "detect".
  for (let round = 0; round < 3; round++) {
    const plan = planRangeShape(ref, { hasHeaders, headersForcedOff: forced, name: inputs.name });
    if (plan.kind === "single") {
      return {
        hasHeaders: false,
        categoryIndex: 0,
        series: plan.series,
        headersForcedOff: plan.turnHeadersOff ? true : forced,
      };
    }
    if (plan.kind === "restoreHeaders") {
      hasHeaders = true;
      forced = false;
      continue;
    }
    const detected = await autoDetectSeries({ ...ref }, hasHeaders);
    return { hasHeaders, categoryIndex: detected.categoryIndex, series: detected.series, headersForcedOff: false };
  }
  throw new Error("The chart's series could not be decided.");
}

// ============================================================================
// The hook
// ============================================================================

/** The caller's state the hook keeps in step with the bound range (the dialog). */
export interface RangeSourceDetection {
  hasHeaders: boolean;
  setHasHeaders(value: boolean): void;
  setCategoryIndex(value: number): void;
  setSeries(value: ChartSeries[]): void;
  /** The range stopped binding (the dialog drops its preview data). */
  onUnbound?(): void;
}

export interface UseRangeSourceOptions {
  /** The text in the range field. */
  sourceRange: string;
  /** The workbook's sheets (empty until a `getSheets()` returns). */
  sheets: readonly SheetInfo[];
  /** The sheet the chart is on (an unprefixed range means this sheet). */
  currentSheetIndex: number;
  currentSheetName: string;
  /** The chart's sheet is a canvas: an unprefixed range is refused. */
  currentIsCanvas: boolean;
  /**
   * Whether the source IS a range (false: a PivotTable or a design query). A
   * non-range source never looks up a name and never reports a range error.
   */
  rangeMode: boolean;
  orientation: SeriesOrientation;
  /** Present: re-detect the series whenever the bound range changes (the dialog). */
  detection?: RangeSourceDetection | null;
}

export interface RangeSourceState {
  binding: RangeBinding;
  /** The text, when it is not a range and has a defined name's shape. */
  nameCandidate: string | null;
  /** The resolver's answer for `nameCandidate` (null while it is being asked). */
  nameAnswer: NameResolution | null;
  nameRef: DataRangeRef | null;
  /** The cells the text names (a range, or the range a name resolves to). */
  boundRef: DataRangeRef | null;
  boundRefKey: string;
  isSingleCell: boolean;
  /** Why the text cannot be charted, in the reader's terms (null: fine, or nothing to say yet). */
  rangeError: string | null;
  availableAxes: RangeAxis[];
  /** Forget the last name answer (a new chart starts clean). */
  resetNameResolution(): void;
}

export function useRangeSource(opts: UseRangeSourceOptions): RangeSourceState {
  const { sourceRange, sheets, currentSheetIndex, currentSheetName, currentIsCanvas, rangeMode, orientation } = opts;
  const detection = opts.detection ?? null;

  const binding = useMemo<RangeBinding>(
    () =>
      bindRangeText(sourceRange, {
        sheets,
        currentSheetIndex,
        currentSheetName,
        currentIsCanvas,
      }),
    [sourceRange, sheets, currentSheetIndex, currentSheetName, currentIsCanvas],
  );

  // A DEFINED NAME as the source ("TotalSales"): resolved through the
  // workbook's names and STORED by name, so the chart follows the name when it
  // is redefined. The answer is kept with the text it answers, so a stale
  // resolution never binds new text.
  const [nameResolution, setNameResolution] = useState<NameResolution | null>(null);
  const nameCandidate =
    rangeMode && !binding.ok && looksLikeDefinedName(sourceRange) ? sourceRange.trim() : null;
  const nameAnswer = nameCandidate !== null && nameResolution?.name === nameCandidate ? nameResolution : null;
  const nameRef = nameAnswer?.ref ?? null;
  const boundRef: DataRangeRef | null = binding.ok ? binding.ref : nameRef;
  const isSingleCell = isSingleCellRange(boundRef);
  const boundRefKey = rangeRefKey(boundRef);
  const rangeError =
    nameCandidate !== null
      ? (nameAnswer?.error ?? null)
      : rangeMode && !binding.ok
        ? binding.message
        : null;

  useEffect(() => {
    if (nameCandidate === null) return;
    let live = true;
    void resolveRangeName(nameCandidate, sheets).then((answer) => {
      if (live) setNameResolution(answer);
    });
    return () => {
      live = false;
    };
  }, [nameCandidate, sheets]);

  // boundRefKey stands for boundRef (see rangeRefKey).
  const availableAxes = useMemo<RangeAxis[]>(
    () => (boundRef ? rangeAxes(boundRef, orientation) : []),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [boundRefKey, orientation],
  );

  // The caller's setters, read through a ref so their identity never re-runs
  // detection (only the range, the header flag and the orientation do).
  const detectionRef = useRef(detection);
  detectionRef.current = detection;
  const headersForcedOffRef = useRef(false);
  const detectionOn = detection !== null;
  const hasHeaders = detection?.hasHeaders ?? false;

  // Re-detect the series when the BOUND range changes (its cells or its sheet).
  useEffect(() => {
    const d = detectionRef.current;
    if (!d) return;
    if (!boundRef) {
      d.setSeries([]);
      d.onUnbound?.();
      return;
    }
    // Read from the sheet the text names (index + id), not the active sheet.
    const dataRange: DataRangeRef = { ...boundRef };
    const plan = planRangeShape(dataRange, {
      hasHeaders,
      headersForcedOff: headersForcedOffRef.current,
      name: nameCandidate,
    });
    if (plan.kind === "single") {
      if (plan.turnHeadersOff) {
        headersForcedOffRef.current = true;
        d.setHasHeaders(false);
      }
      d.setCategoryIndex(0);
      d.setSeries(plan.series);
      return;
    }
    if (plan.kind === "restoreHeaders") {
      headersForcedOffRef.current = false;
      d.setHasHeaders(true);
      return; // this effect runs again with the header row
    }
    if (plan.clearForced) headersForcedOffRef.current = false;
    autoDetectSeries(dataRange, hasHeaders)
      .then((detected) => {
        const now = detectionRef.current;
        if (!now) return;
        now.setCategoryIndex(detected.categoryIndex);
        now.setSeries(detected.series);
      })
      .catch((err) => {
        console.error("[CreateChartDialog] Series detection failed:", err);
      });
    // boundRefKey stands for boundRef (see rangeRefKey).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [detectionOn, boundRefKey, hasHeaders, orientation, nameCandidate]);

  return {
    binding,
    nameCandidate,
    nameAnswer,
    nameRef,
    boundRef,
    boundRefKey,
    isSingleCell,
    rangeError,
    availableAxes,
    resetNameResolution: () => setNameResolution(null),
  };
}
