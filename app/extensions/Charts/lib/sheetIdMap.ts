//! FILENAME: app/extensions/Charts/lib/sheetIdMap.ts
// PURPOSE: The workbook's sheet list as a two-way map between the stable sheet
//          id and the live sheet index -- read once, cached, and dropped on
//          every sheet-collection event.
// CONTEXT: A DataRangeRef names its sheet by `sheetId` (M4, canvas sheets): an
//          index shifts on every insert / delete / move, a name on every rename.
//          The resolver (dataSourceResolver.ts) maps the id to the index at read
//          time; the store (chartStore.ts) maps an index to the id when it
//          stamps a ref. Both go through this ONE module so an id and an index
//          can never come from two different moments of the sheet list.
//
//          Kept apart from the resolver on purpose: the store needs the map but
//          must not pull the resolver's imports (the whole `@api` facade, the
//          grid state) into every module that imports the store. This file
//          imports only `@api/lib` and `@api/events`, and reads neither at
//          module-evaluation time.
//
//          THE CACHE ONLY EXISTS WHILE SOMETHING CAN INVALIDATE IT.
//          `installSheetIdCacheInvalidation` (called from the extension's
//          activate) subscribes to the sheet-collection events and turns
//          caching on. A context that never installs it -- a unit test, a
//          secondary window that never hears the main window's sheet events --
//          reads a fresh list every time, because a cache nobody clears is a
//          stale answer waiting to be given.

import { getSheets } from "@api/lib";
import type { SheetInfo } from "@api/lib";
import { onAppEvent, AppEvents } from "@api/events";

/**
 * One snapshot of the workbook's sheet list, indexed both ways. Built from ONE
 * `getSheets()` call.
 */
export interface SheetIdMap {
  /** sheetId -> live 0-based index. */
  byId: ReadonlyMap<string, number>;
  /** live 0-based index -> sheetId (only sheets that report an id). */
  idByIndex: ReadonlyMap<number, string>;
  /** The sheets themselves, in the order the backend listed them. */
  sheets: readonly SheetInfo[];
}

/** Build the two-way map from a sheet list. Pure. */
export function buildSheetIdMap(sheets: readonly SheetInfo[]): SheetIdMap {
  const byId = new Map<string, number>();
  const idByIndex = new Map<number, string>();
  for (const s of sheets) {
    if (typeof s.sheetId === "string" && s.sheetId !== "") {
      byId.set(s.sheetId, s.index);
      idByIndex.set(s.index, s.sheetId);
    }
  }
  return { byId, idByIndex, sheets };
}

/**
 * The cached map (as a promise, so a burst of chart reads after a sheet switch
 * shares ONE backend call) and its settled value (so the synchronous paths --
 * the cell-change invalidation, the store's synchronous create -- can peek).
 */
let cachedMapPromise: Promise<SheetIdMap> | null = null;
let cachedMap: SheetIdMap | null = null;
/** Bumped on every clear; a read that started before a clear may not store its result. */
let cacheGeneration = 0;
/** How many live installations of the invalidation listeners exist. */
let invalidationInstalls = 0;

/**
 * The sheet list as a two-way id/index map. Cached while the invalidation
 * listeners are installed; a fresh `getSheets()` otherwise. A failed read is
 * never cached, and even a synchronous throw from the backend door arrives as
 * a rejection.
 */
export function loadSheetIdMap(): Promise<SheetIdMap> {
  const caching = invalidationInstalls > 0;
  if (caching && cachedMapPromise) return cachedMapPromise;
  const generation = cacheGeneration;
  const promise = Promise.resolve()
    .then(() => getSheets())
    .then((result) => {
      const map = buildSheetIdMap(result.sheets);
      if (invalidationInstalls > 0 && generation === cacheGeneration) cachedMap = map;
      return map;
    });
  if (caching) {
    cachedMapPromise = promise;
    promise.catch(() => {
      if (cachedMapPromise === promise) cachedMapPromise = null;
    });
  }
  return promise;
}

/**
 * The id of the sheet at `sheetIndex`, from the CACHED list only (synchronous).
 * Undefined when the cache is cold or no sheet has that index.
 */
export function peekSheetIdForIndex(sheetIndex: number): string | undefined {
  return cachedMap?.idByIndex.get(sheetIndex);
}

/**
 * The live index of the sheet with id `sheetId`, from the CACHED list only.
 * `"cold"` when there is no cached list yet (it is then warmed in the
 * background for the next call), `"missing"` when the list has no such sheet.
 */
export function peekSheetIndexForId(sheetId: string): number | "cold" | "missing" {
  if (cachedMap === null) {
    if (invalidationInstalls > 0) void loadSheetIdMap().catch(() => {});
    return "cold";
  }
  const index = cachedMap.byId.get(sheetId);
  return index === undefined ? "missing" : index;
}

/**
 * Forget the cached sheet list (the next read asks the backend again). When
 * the list was in use and caching is on, it is re-read straight away in the
 * background, so the synchronous peeks find a warm cache instead of a cold one.
 */
export function clearSheetIdCache(): void {
  const wasInUse = cachedMap !== null || cachedMapPromise !== null;
  cacheGeneration++;
  cachedMapPromise = null;
  cachedMap = null;
  if (wasInUse && invalidationInstalls > 0) void loadSheetIdMap().catch(() => {});
}

/**
 * The events after which a cached id -> index map may be wrong: the active
 * sheet changed (also what the Shell fans the `sheets` mutation domain out to,
 * so a move, a copy and an undone sheet operation arrive here too), a sheet was
 * added, deleted or renamed, or the whole workbook was replaced. A function,
 * not a constant, so nothing is read from `@api/events` at import time.
 */
export function sheetIdCacheInvalidatingEvents(): string[] {
  return [
    AppEvents.SHEET_CHANGED,
    AppEvents.SHEET_ADDED,
    AppEvents.SHEET_DELETED,
    AppEvents.SHEET_RENAMED,
    AppEvents.AFTER_OPEN,
    AppEvents.AFTER_NEW,
  ];
}

/**
 * Subscribe the cache to the sheet-collection events and turn caching on.
 * Returns the cleanup; after the last cleanup caching is off again and the
 * cache is empty.
 */
export function installSheetIdCacheInvalidation(): () => void {
  invalidationInstalls++;
  const offs = sheetIdCacheInvalidatingEvents().map((evt) => onAppEvent(evt, () => clearSheetIdCache()));
  let disposed = false;
  return () => {
    if (disposed) return;
    disposed = true;
    for (const off of offs) off();
    invalidationInstalls = Math.max(0, invalidationInstalls - 1);
    clearSheetIdCache();
  };
}

/** Test hook: forget the cache AND every installation. */
export function resetSheetIdCacheForTests(): void {
  invalidationInstalls = 0;
  clearSheetIdCache();
}
