//! FILENAME: app/src/api/pageFilters.ts
// PURPOSE: Feature-neutral seam for a PAGE's active model filters -- what the
//   filtering objects on a sheet or canvas (model slicers today) currently
//   keep of a model, so the objects that QUERY that model on the same page
//   (design-query charts: Card, KPI, Gauge, any chart on a DSL source) can
//   follow them the way every visual on a Power BI page follows its slicers.
// CONTEXT: Owner decision 5 (2026-10-08): "model slicers on the same canvas
//   filter design-query charts". Before this seam the only thing a model
//   slicer reached was the BI PIVOTS of its page (Slicer/lib/slicerFilterBridge
//   "biConnection" route), and the slicer dialog had to say so: "Charts that
//   query the model directly are not filtered yet".
//
//   Why a seam and not a call: the Seam Rule (CLAUDE.md). Charts must never
//   import the Slicer extension, and the Slicer extension must never learn what
//   a chart is. So a filtering family PUBLISHES its filters here, keyed by the
//   page (sheet index) and the model connection, and a querying family READS
//   them when it builds a query and LISTENS for the change that should re-run
//   it. Neither knows the other exists; a TimelineSlicer that one day filters a
//   model joins by publishing under its own publisher key, and nothing on the
//   chart side changes.
//
//   What a filter IS here: the items of ONE model column ("Table.Column", the
//   `biFieldKey` spelling every model consumer already uses) that are KEPT.
//   That is the slicer's own semantics (`selectedItems`), and it is the form a
//   design query already carries to the backend (`includedItems`, inverted
//   against the query's own result, BUG-0197) -- so no new wire shape is
//   needed anywhere. A slicer with NO selection publishes NOTHING: "every item"
//   is the absence of a filter, never a list of every item (a list would go
//   stale the moment the model gained a member, and silently hide it).
//
//   Change events fire only when what a page holds ACTUALLY changed. A
//   publisher may republish on every store notification (the Slicer store
//   announces once per item refresh, N times per re-read); the seam diffs by
//   page and stays quiet when nothing moved, so a re-read never costs a model
//   re-query of every chart on the page.
//
//   Seams point one way: this file imports nothing from app/extensions.

/** One model filter a page holds, as a publisher hands it in. */
export interface PageFilterInput {
  /** The publishing object's id (e.g. the slicer's id). Stable identity, used
   *  for ordering and diagnostics -- never shown. */
  sourceId: string;
  /** The publishing object's name as the user sees it ("Slicer_Region"). */
  sourceName: string;
  /** The page: the sheet (or canvas) index the filtering object sits on. */
  sheetIndex: number;
  /** The model connection the filter applies to. Only queries against THIS
   *  connection are filtered: another model's column of the same name is a
   *  different column. */
  connectionId: string;
  /** The model column, "Table.Column" (the `biFieldKey` spelling; table names
   *  may contain dots, so a reader splits it against the model's tables). */
  field: string;
  /** The items KEPT, as their display labels ("(blank)" for the blank
   *  member). An empty list keeps nothing. */
  includedItems: readonly string[];
  /** The slicer filter level (1 = ordinary, 2-9 = pinned). Carried so a
   *  reader that can express pinning may; a reader that cannot treats every
   *  level as an ordinary filter (the items kept are the same). */
  filterLevel?: number;
}

/** A filter as the seam holds it: the input plus who published it. */
export interface PageFilter extends Readonly<PageFilterInput> {
  /** The family that published it ("slicer", later "timeline", ...). */
  readonly publisher: string;
  readonly includedItems: readonly string[];
  readonly filterLevel: number;
}

/** One page of one model whose filters changed. */
export interface PageFilterPage {
  sheetIndex: number;
  connectionId: string;
}

/** What a change event carries: every (page, model) whose filters moved. */
export interface PageFiltersChange {
  pages: PageFilterPage[];
}

/** Filters by publisher. Each publisher REPLACES its whole list at once. */
const byPublisher = new Map<string, PageFilter[]>();

const listeners = new Set<(change: PageFiltersChange) => void>();

function pageKey(sheetIndex: number, connectionId: string): string {
  return `${sheetIndex}\u0000${connectionId}`;
}

/**
 * A page's signature: its filters in a canonical order with their items
 * sorted. Order of publication and order of items are not meaning -- a
 * slicer that re-reads its items in another order filters the same rows.
 */
function signatures(): Map<string, string> {
  const grouped = new Map<string, string[]>();
  for (const [publisher, filters] of byPublisher) {
    for (const f of filters) {
      const key = pageKey(f.sheetIndex, f.connectionId);
      const one = JSON.stringify([
        publisher,
        f.sourceId,
        f.field,
        f.filterLevel,
        [...f.includedItems].sort(),
      ]);
      const list = grouped.get(key);
      if (list) list.push(one);
      else grouped.set(key, [one]);
    }
  }
  const out = new Map<string, string>();
  for (const [key, list] of grouped) out.set(key, list.sort().join("\u0001"));
  return out;
}

function splitKey(key: string): PageFilterPage {
  const at = key.indexOf("\u0000");
  return { sheetIndex: Number(key.slice(0, at)), connectionId: key.slice(at + 1) };
}

/**
 * Replace everything `publisher` holds with `filters`. Call it whenever the
 * publisher's state may have moved -- the seam announces only the pages whose
 * filters really changed (and nothing at all when none did). Publishing an
 * empty list withdraws the publisher's filters (a store reset, a deactivate).
 */
export function publishPageFilters(publisher: string, filters: readonly PageFilterInput[]): void {
  const before = signatures();
  const held: PageFilter[] = filters
    .filter((f) => Number.isInteger(f.sheetIndex) && f.sheetIndex >= 0 && f.connectionId !== "" && f.field !== "")
    .map((f) => ({
      publisher,
      sourceId: f.sourceId,
      sourceName: f.sourceName,
      sheetIndex: f.sheetIndex,
      connectionId: String(f.connectionId),
      field: f.field,
      includedItems: [...f.includedItems],
      filterLevel: f.filterLevel ?? 1,
    }));
  if (held.length === 0) byPublisher.delete(publisher);
  else byPublisher.set(publisher, held);
  const after = signatures();

  const changed: PageFilterPage[] = [];
  for (const key of new Set([...before.keys(), ...after.keys()])) {
    if (before.get(key) !== after.get(key)) changed.push(splitKey(key));
  }
  if (changed.length === 0) return;
  const change: PageFiltersChange = { pages: changed };
  for (const listener of [...listeners]) {
    try {
      listener(change);
    } catch (err) {
      // One consumer's failure must not keep the next one stale.
      console.warn("[pageFilters] A listener failed:", err);
    }
  }
}

/**
 * The filters a page holds, optionally only those on one model connection.
 * Ordered by publisher, then source id, so a query built from them is the same
 * text every time (a cache keyed on it stays warm).
 */
export function getPageFilters(sheetIndex: number, connectionId?: string): PageFilter[] {
  const out: PageFilter[] = [];
  for (const filters of byPublisher.values()) {
    for (const f of filters) {
      if (f.sheetIndex !== sheetIndex) continue;
      if (connectionId !== undefined && f.connectionId !== String(connectionId)) continue;
      out.push(f);
    }
  }
  return out.sort((a, b) =>
    a.publisher === b.publisher
      ? a.sourceId.localeCompare(b.sourceId)
      : a.publisher.localeCompare(b.publisher),
  );
}

/**
 * Every (page, model) that currently holds at least one filter, ordered by
 * page then connection. What a consumer that mirrors the WHOLE state needs
 * (`@api/objectBindings` sends Rust the full snapshot, D §3.8): without it a
 * mirror could only learn about pages whose filters changed after it started.
 */
export function listPageFilterPages(): PageFilterPage[] {
  const seen = new Map<string, PageFilterPage>();
  for (const filters of byPublisher.values()) {
    for (const f of filters) {
      const key = pageKey(f.sheetIndex, f.connectionId);
      if (!seen.has(key)) seen.set(key, { sheetIndex: f.sheetIndex, connectionId: f.connectionId });
    }
  }
  return [...seen.values()].sort((a, b) =>
    a.sheetIndex === b.sheetIndex ? a.connectionId.localeCompare(b.connectionId) : a.sheetIndex - b.sheetIndex,
  );
}

/** Subscribe to page-filter changes. Returns an unsubscribe function. */
export function onPageFiltersChange(cb: (change: PageFiltersChange) => void): () => void {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}
