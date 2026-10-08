//! FILENAME: app/extensions/Charts/lib/hiddenLinesWatch.ts
// PURPOSE: Re-read a range chart when the rows (or columns) hidden inside its
//          source range change -- an AutoFilter applied or cleared, a table
//          slicer clicked, a group collapsed, rows hidden by hand.
// CONTEXT: A range chart leaves its source's hidden rows out (Excel's default,
//          chartDataReader `withoutHiddenLines`), and its rendered raster is
//          cached until something invalidates it. Nothing that hides rows
//          speaks to Charts: the AutoFilter's own change events are private to
//          that extension, and a table slicer filters THROUGH the AutoFilter.
//          What every such route does do is ask for a repaint (GRID_REFRESH /
//          "grid:refresh", "dimensions:refresh", OUTLINE_CHANGED).
//
//          So the reader remembers, per chart, WHICH lines of its range were
//          hidden when it read them (`rememberHiddenSignature`), and on a
//          repaint request this watch asks the sheet again -- one query per
//          source sheet, coalesced, never per chart -- and invalidates only
//          the charts whose answer moved. A repaint that hid nothing re-reads
//          nothing, so Charts' own GRID_REFRESH after an invalidation ends
//          here instead of looping.

import { getHiddenRowsInfo, getHiddenColsInfo } from "@api/lib";
import { AppEvents, onAppEvent } from "@api/events";
import type { DataRangeRef } from "../types";

/** The range a chart read and which of its lines were hidden then. */
interface Remembered {
  sheetIndex: number;
  startRow: number;
  endRow: number;
  startCol: number;
  endCol: number;
  signature: string;
}

const remembered = new Map<string, Remembered>();

/** One stable spelling of a set of hidden offsets. */
function signatureOf(rows: Iterable<number>, cols: Iterable<number>): string {
  const r = [...rows].sort((a, b) => a - b).join(",");
  const c = [...cols].sort((a, b) => a - b).join(",");
  return `${r}|${c}`;
}

/** Hidden lines of a sheet that fall in the remembered range, as a signature. */
function signatureIn(entry: Omit<Remembered, "signature">, hiddenRows: readonly number[], hiddenCols: readonly number[]): string {
  const rows: number[] = [];
  for (const r of hiddenRows) if (r >= entry.startRow && r <= entry.endRow) rows.push(r - entry.startRow);
  const cols: number[] = [];
  for (const c of hiddenCols) if (c >= entry.startCol && c <= entry.endCol) cols.push(c - entry.startCol);
  return signatureOf(rows, cols);
}

/** Called by the range reader with what it left out (row/col OFFSETS in the range). */
export function rememberHiddenSignature(
  chartId: string,
  ref: Pick<DataRangeRef, "sheetIndex" | "startRow" | "endRow" | "startCol" | "endCol">,
  hidden: { rows: ReadonlySet<number>; cols: ReadonlySet<number> },
): void {
  remembered.set(chartId, {
    sheetIndex: ref.sheetIndex,
    startRow: ref.startRow,
    endRow: ref.endRow,
    startCol: ref.startCol,
    endCol: ref.endCol,
    signature: signatureOf(hidden.rows, hidden.cols),
  });
}

/** A chart that no longer reads a range (deleted, or now plots hidden cells). */
export function forgetHiddenSignature(chartId: string): void {
  remembered.delete(chartId);
}

/** Test seam / document reset. */
export function resetHiddenLinesWatch(): void {
  remembered.clear();
}

/** How a sheet's hidden lines are asked for (injectable for tests). */
export interface HiddenLinesSource {
  rows(sheetIndex: number): Promise<readonly number[]>;
  cols(sheetIndex: number): Promise<readonly number[]>;
}

const liveSource: HiddenLinesSource = {
  rows: async (sheetIndex) => (await getHiddenRowsInfo(sheetIndex)).effective,
  cols: async (sheetIndex) => (await getHiddenColsInfo(sheetIndex)).effective,
};

/**
 * Ask every remembered chart's sheet again and return the charts whose hidden
 * lines moved (their remembered answer is updated, so the same change is
 * reported once). One query pair per distinct sheet. A sheet that cannot be
 * asked (deleted) is skipped: the chart's own read will report that.
 */
export async function changedHiddenLines(source: HiddenLinesSource = liveSource): Promise<string[]> {
  if (remembered.size === 0) return [];
  const bySheet = new Map<number, Array<[string, Remembered]>>();
  for (const entry of remembered) {
    const list = bySheet.get(entry[1].sheetIndex) ?? [];
    list.push(entry);
    bySheet.set(entry[1].sheetIndex, list);
  }
  const changed: string[] = [];
  await Promise.all(
    [...bySheet].map(async ([sheetIndex, entries]) => {
      let rows: readonly number[];
      let cols: readonly number[];
      try {
        [rows, cols] = await Promise.all([source.rows(sheetIndex), source.cols(sheetIndex)]);
      } catch {
        return;
      }
      for (const [chartId, entry] of entries) {
        // The chart may have been forgotten or re-read while we waited.
        if (remembered.get(chartId) !== entry) continue;
        const now = signatureIn(entry, rows, cols);
        if (now !== entry.signature) {
          remembered.set(chartId, { ...entry, signature: now });
          changed.push(chartId);
        }
      }
    }),
  );
  return changed;
}

/** The quiet time a burst of repaint requests is folded into one check. */
export const HIDDEN_LINES_CHECK_DELAY_MS = 120;

/**
 * Install the watch: on every repaint request, at most one check per
 * {@link HIDDEN_LINES_CHECK_DELAY_MS}, and `onChanged` with the charts to
 * re-read. Returns the uninstaller.
 */
export function installHiddenLinesWatch(
  onChanged: (chartIds: string[]) => void,
  source: HiddenLinesSource = liveSource,
): () => void {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let disposed = false;
  const schedule = (): void => {
    if (disposed || timer !== null || remembered.size === 0) return;
    timer = setTimeout(() => {
      timer = null;
      void changedHiddenLines(source).then((ids) => {
        if (!disposed && ids.length > 0) onChanged(ids);
      });
    }, HIDDEN_LINES_CHECK_DELAY_MS);
  };
  const offs: Array<() => void> = [
    onAppEvent(AppEvents.GRID_REFRESH, schedule),
    onAppEvent(AppEvents.OUTLINE_CHANGED, schedule),
  ];
  const windowEvents = ["grid:refresh", "dimensions:refresh"];
  for (const name of windowEvents) window.addEventListener(name, schedule);
  return () => {
    disposed = true;
    if (timer !== null) clearTimeout(timer);
    timer = null;
    for (const off of offs) off();
    for (const name of windowEvents) window.removeEventListener(name, schedule);
  };
}
