//! FILENAME: app/src/api/reportPages.ts
// PURPOSE: The REPORT'S PAGE LIST -- the canvas pages of the workbook, in tab
//          order, as a report reader's navigator sees them -- kept as one live,
//          synchronous snapshot every consumer reads.
// CONTEXT: A Page Navigator (Power BI's page navigator, D-NAV) shows one
//          button per page and must follow the workbook LIVE: a page added,
//          renamed, moved, hidden, unhidden, deleted, re-sized to a Tooltip
//          page, undone or pulled from an application shows up without the
//          navigator being inserted again. Its items are therefore never
//          stored; they are DERIVED from this snapshot at paint, hit-test,
//          press and pane time. Paint and hit-test run inside a frame and a
//          pointer gesture, where an IPC round trip is not an option, so the
//          snapshot is a synchronous copy of the backend's `get_sheets` answer.
//
//          The page list is not a Controls concern (a future "page list" pane
//          or a script's `pages` wants the same answer), so it is a small
//          feature-neutral seam beside @api/sheetHistory and @api/sheetSwitch.
//
//          WHAT IS A PAGE. A CANVAS sheet. Worksheets are not report pages,
//          but every sheet's ID is still carried (`sheetIdByIndex`) so a caller
//          can name the ACTIVE sheet by id whatever its kind -- a navigate
//          button may target a worksheet.
//
//          WHICH PAGES A NAVIGATOR LISTS is ONE rule, `selectReportPages`:
//          veryHidden never; hidden only with `showHiddenPages`; a Tooltip page
//          (preset type "tooltip") only with `showTooltipPages`.
//
//          WHEN IT RE-READS. Every announcement that can change the list:
//          SHEET_ADDED / SHEET_DELETED / SHEET_RENAMED / SHEET_CHANGED,
//          CANVAS_LAYOUT_CHANGED (a page re-sized to or from Tooltip),
//          AFTER_OPEN / AFTER_NEW (a new document), PACKAGE_UPDATED (a pull),
//          and the bare window event "sheets:refresh" that the Shell's
//          MUTATION_REFRESH translator fires for the "sheets" domain (undo,
//          move, hide/unhide). One "sheets" domain fires BOTH "sheets:refresh"
//          and SHEET_CHANGED synchronously, so requests are COALESCED: a
//          request while one is already scheduled in the same task is merged,
//          and the read starts in a microtask.
//
//          RACES. Each read takes a generation number and only the latest one
//          is applied (the canvasSheetStore pattern): an older `get_sheets`
//          answer arriving last never overwrites a newer one, and a failed read
//          keeps the previous snapshot -- a transient IPC error must not empty
//          every navigator for a frame.
//
//          CHANGE-ONLY PUBLISH. Listeners are told, and `version` bumps, only
//          when the pages, the sheet ids or the active index actually changed;
//          renaming a WORKSHEET alone changes nothing a navigator shows.
//
// LIFETIME. `startReportPages()` installs the listeners and makes the first
// read. It is reference-counted exactly like `startSheetHistory`: the listeners
// go when the last starter stops.

import { getSheets } from "../core/lib/tauri-api";
import type { SheetsResult, SheetVisibility } from "../core/lib/tauri-api";
import { AppEvents, onAppEvent } from "./events";
import { canvasPagePresetType } from "./canvasSheet";

/** One CANVAS page, as a report reader's navigator sees it. */
export interface ReportPage {
  /** Stable sheet uuid; "" when the backend gave none (an older app_lib.dll). */
  sheetId: string;
  name: string;
  /** TRUE sheet index (never a list position). */
  index: number;
  visibility: SheetVisibility;
  /** `canvasPagePresetType(canvasLayout.pagePreset) === "tooltip"` (@api/canvasSheet). */
  isTooltipPage: boolean;
}

export interface ReportPagesSnapshot {
  /** Every canvas, ascending `index` (tab order). Worksheets are not report pages. */
  pages: readonly ReportPage[];
  /**
   * EVERY sheet's id (worksheets and hidden sheets too), keyed by TRUE sheet
   * index; a sheet the backend gave no id is absent. Carried so a caller can
   * name the ACTIVE sheet by id whatever its kind -- a navigate button may
   * target a worksheet.
   */
  sheetIdByIndex: ReadonlyMap<number, string>;
  /** The backend's active sheet index at the last applied read. */
  activeIndex: number;
  /** Bumped on every applied change: a snapshot comparison is one number. */
  version: number;
}

export interface ReportPageFilter {
  /** List user-hidden pages too (never veryHidden ones). Default false. */
  showHiddenPages?: boolean;
  /** List Tooltip pages too. Default false. */
  showTooltipPages?: boolean;
}

// ----------------------------------------------------------------------------
// Pure helpers
// ----------------------------------------------------------------------------

/** Pure: the canvases of a get_sheets answer, in tab order. */
export function reportPagesFrom(result: SheetsResult): ReportPage[] {
  const pages: ReportPage[] = [];
  for (const s of result.sheets ?? []) {
    if (s.kind !== "canvas") continue;
    const preset = s.canvasLayout?.pagePreset;
    pages.push({
      sheetId: s.sheetId ?? "",
      name: s.name,
      index: s.index,
      visibility: s.visibility ?? "visible",
      isTooltipPage: typeof preset === "string" && canvasPagePresetType(preset) === "tooltip",
    });
  }
  pages.sort((a, b) => a.index - b.index);
  return pages;
}

/**
 * Pure: THE one membership rule (the navigator's items, the insert's default
 * size). veryHidden is never listed; "hidden" only with showHiddenPages;
 * a tooltip page only with showTooltipPages.
 */
export function selectReportPages(pages: readonly ReportPage[], filter?: ReportPageFilter): ReportPage[] {
  const showHidden = filter?.showHiddenPages === true;
  const showTooltip = filter?.showTooltipPages === true;
  return pages.filter((p) => {
    if (p.visibility === "veryHidden") return false;
    if (p.visibility === "hidden" && !showHidden) return false;
    if (p.isTooltipPage && !showTooltip) return false;
    return true;
  });
}

/** The page with this sheetId, else null. */
export function reportPageById(snapshot: ReportPagesSnapshot, sheetId: string): ReportPage | null {
  if (!sheetId) return null;
  return snapshot.pages.find((p) => p.sheetId === sheetId) ?? null;
}

/**
 * The id of the sheet at TRUE index `index` (any kind), else null (no such
 * sheet, or it has no id). Callers pass the grid's
 * `sheetContext.activeSheetIndex` (paint-time truth), never a list position.
 */
export function sheetIdAt(snapshot: ReportPagesSnapshot, index: number | undefined): string | null {
  if (typeof index !== "number" || !Number.isFinite(index)) return null;
  return snapshot.sheetIdByIndex.get(index) ?? null;
}

function sheetIdsFrom(result: SheetsResult): Map<number, string> {
  const ids = new Map<number, string>();
  for (const s of result.sheets ?? []) {
    if (s.sheetId) ids.set(s.index, s.sheetId);
  }
  return ids;
}

function samePages(a: readonly ReportPage[], b: readonly ReportPage[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    const x = a[i];
    const y = b[i];
    if (
      x.sheetId !== y.sheetId ||
      x.name !== y.name ||
      x.index !== y.index ||
      x.visibility !== y.visibility ||
      x.isTooltipPage !== y.isTooltipPage
    ) {
      return false;
    }
  }
  return true;
}

function sameIds(a: ReadonlyMap<number, string>, b: ReadonlyMap<number, string>): boolean {
  if (a.size !== b.size) return false;
  for (const [index, id] of a) {
    if (b.get(index) !== id) return false;
  }
  return true;
}

// ----------------------------------------------------------------------------
// The live snapshot
// ----------------------------------------------------------------------------

function freeze(
  pages: readonly ReportPage[],
  sheetIdByIndex: ReadonlyMap<number, string>,
  activeIndex: number,
  version: number,
): ReportPagesSnapshot {
  return Object.freeze({
    pages: Object.freeze(pages.map((p) => Object.freeze({ ...p }))),
    sheetIdByIndex,
    activeIndex,
    version,
  });
}

let snapshot: ReportPagesSnapshot = freeze([], new Map(), 0, 0);
let generation = 0;
/** Bumped by reset so a request queued before it never reads after it. */
let epoch = 0;
let scheduled = false;
let starters = 0;
let stopListening: (() => void) | null = null;
const listeners = new Set<(snapshot: ReportPagesSnapshot) => void>();

function publish(next: ReportPagesSnapshot): void {
  snapshot = next;
  for (const listener of Array.from(listeners)) {
    try {
      listener(next);
    } catch (err) {
      console.error("[reportPages] a page-list listener threw:", err);
    }
  }
}

/**
 * Re-read now. Resolves true when THIS read was applied (false: superseded by
 * a newer read, or the read failed -- the previous snapshot is kept).
 */
export async function refreshReportPages(): Promise<boolean> {
  const mine = ++generation;
  let result: SheetsResult;
  try {
    result = await getSheets();
  } catch (err) {
    if (mine === generation) {
      console.warn("[reportPages] get_sheets failed; keeping the previous page list:", err);
    }
    return false;
  }
  if (mine !== generation) return false;
  // A malformed answer is a failed read too: the previous snapshot is kept.
  // The read runs from a fire-and-forget refresh, so a throw here would be an
  // unhandled rejection rather than a refusal anybody hears.
  let pages: ReportPage[];
  let ids: Map<number, string>;
  try {
    pages = reportPagesFrom(result);
    ids = sheetIdsFrom(result);
  } catch (err) {
    console.warn("[reportPages] get_sheets answered something that is not a sheet list; keeping the previous page list:", err);
    return false;
  }
  const activeIndex = typeof result.activeIndex === "number" ? result.activeIndex : snapshot.activeIndex;
  if (samePages(snapshot.pages, pages) && sameIds(snapshot.sheetIdByIndex, ids) && snapshot.activeIndex === activeIndex) {
    return true;
  }
  publish(freeze(pages, ids, activeIndex, snapshot.version + 1));
  return true;
}

/** Ask for a re-read; every request made in the same task becomes ONE read. */
function requestRefresh(): void {
  if (scheduled) return;
  scheduled = true;
  const mine = epoch;
  queueMicrotask(() => {
    if (mine !== epoch) return;
    scheduled = false;
    void refreshReportPages();
  });
}

/**
 * The announcements that can change the page list (see the header). Built when
 * the listeners are installed, never at module load: this module is imported
 * (through the Controls page navigator's model) by code whose unit tests mock
 * @api/events partially, and a top-level read of `AppEvents` would fail every
 * such suite at import even though none of them starts the page list.
 */
function refreshEvents(): string[] {
  return [
    AppEvents.SHEET_ADDED,
    AppEvents.SHEET_DELETED,
    AppEvents.SHEET_RENAMED,
    AppEvents.SHEET_CHANGED,
    AppEvents.CANVAS_LAYOUT_CHANGED,
    AppEvents.AFTER_OPEN,
    AppEvents.AFTER_NEW,
    AppEvents.PACKAGE_UPDATED,
  ];
}

/** The bare window event the Shell fans the "sheets" mutation domain out to. */
const SHEETS_REFRESH_EVENT = "sheets:refresh";

function install(): () => void {
  const offs = refreshEvents().map((name) => onAppEvent(name, () => requestRefresh()));
  const onSheetsRefresh = (): void => requestRefresh();
  window.addEventListener(SHEETS_REFRESH_EVENT, onSheetsRefresh);
  return () => {
    for (const off of offs) off();
    window.removeEventListener(SHEETS_REFRESH_EVENT, onSheetsRefresh);
  };
}

/**
 * Start following the page list: installs the listeners and makes the first
 * read. Returns the stop function for the caller's cleanup list; the listeners
 * go when the last starter stops (reference-counted like startSheetHistory).
 */
export function startReportPages(): () => void {
  starters++;
  if (!stopListening) {
    stopListening = install();
    requestRefresh();
  }
  let stopped = false;
  return () => {
    if (stopped) return;
    stopped = true;
    starters = Math.max(0, starters - 1);
    if (starters === 0 && stopListening) {
      stopListening();
      stopListening = null;
    }
  };
}

/** The current snapshot (synchronous; safe inside paint and zoneAt). */
export function getReportPagesSnapshot(): ReportPagesSnapshot {
  return snapshot;
}

/** Called after every APPLIED change; returns unsubscribe. Listener errors are caught and logged. */
export function onReportPagesChanged(listener: (snapshot: ReportPagesSnapshot) => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Test/reset hook: forget snapshot, listeners and starters. */
export function resetReportPages(): void {
  if (stopListening) {
    stopListening();
    stopListening = null;
  }
  starters = 0;
  listeners.clear();
  generation++;
  epoch++;
  scheduled = false;
  snapshot = freeze([], new Map(), 0, 0);
}
