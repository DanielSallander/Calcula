//! FILENAME: app/src/api/reportFilters/resolve.ts
// PURPOSE: THE resolver: what ONE target visual on ONE page reads of every
//          published filter and every cross-filter selection, under the page's
//          interactions. Pure over the seam's state; the rules live here once.
// CONTEXT: The rules, in order (P4 spec 2.1):
//          1. Page and ribbon filters: kept when the connection matches, the
//             scope reaches the target (page / pages: the target's page is one
//             of them; all: always; visuals: the target is named) and the
//             options do not exclude them. A filter with a sourceRef (a model
//             slicer) then goes through interactionFor: "none" drops it,
//             anything else keeps it as a FILTER -- slicers never highlight.
//             A filter never reaches its own source object.
//          2. Cross-filter selections on the page, same connection: the
//             target's OWN selection is dropped; interactionFor decides the
//             mode ("none" drops, a highlight the target cannot paint is a
//             filter). A RECTANGULAR selection becomes one field filter per
//             field; a non-rectangular one becomes one tuple filter.
//          3. Output order: published filters by publisher, then sourceId, then
//             field; then selections by source. A query built from the answer is
//             the same text every time, which keeps caches warm (the contract of
//             the old getPageFilters, pageFilters.ts:164-183). Code-unit order,
//             never a locale collation: this is identity, not display.

import type {
  CrossFilterSelection,
  ReportFilter,
  ResolvedFieldFilter,
  ResolvedFilters,
  ResolvedTupleFilter,
  ResolveOptions,
  ResolveTarget,
  VisualRef,
} from "./types";
import { getReportFilters } from "./publishers";
import { getCrossFilters } from "./selections";
import { interactionFor } from "./interactions";

function sameRef(a: VisualRef | null, b: VisualRef | null): boolean {
  return !!a && !!b && a.kind === b.kind && a.id === b.id;
}

function cmp(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function ordered(filters: readonly ReportFilter[]): ReportFilter[] {
  return [...filters].sort(
    (a, b) => cmp(a.publisher, b.publisher) || cmp(a.sourceId, b.sourceId) || cmp(a.field, b.field),
  );
}

/** Whether a page / pages / all scope reaches `pageSheetId` (a visuals scope never does). */
function reachesPage(f: ReportFilter, pageSheetId: string): boolean {
  switch (f.scope.kind) {
    case "page":
      return f.scope.sheetId === pageSheetId;
    case "pages":
      return f.scope.sheetIds.includes(pageSheetId);
    case "all":
      return true;
    default:
      return false;
  }
}

function fieldFilterOf(f: ReportFilter): ResolvedFieldFilter {
  return { field: f.field, includedKeys: [...f.includedKeys], level: f.filterLevel, from: f.sourceName };
}

function emptyResolved(): ResolvedFilters {
  return { filters: [], tupleFilters: [], highlights: null, sources: [] };
}

function addSource(out: ResolvedFilters, name: string, ref: VisualRef | null, mode: "filter" | "highlight"): void {
  if (out.sources.some((s) => s.name === name && s.mode === mode && (s.ref === ref || sameRef(s.ref, ref)))) return;
  out.sources.push({ name, ref: ref ? { ...ref } : null, mode });
}

/**
 * Whether a selection is RECTANGULAR: its tuple set is the cross product of
 * each field's distinct keys (so per-field IN filters say exactly the same).
 * One field is always rectangular.
 */
export function isRectangular(sel: Pick<CrossFilterSelection, "fields" | "tuples">): boolean {
  if (sel.fields.length <= 1) return true;
  const distinct = new Set(sel.tuples.map((t) => JSON.stringify(t)));
  let product = 1;
  for (let i = 0; i < sel.fields.length; i++) {
    product *= new Set(sel.tuples.map((t) => t[i])).size;
  }
  return product === distinct.size;
}

/** A selection as the filters a consumer applies. */
function selectionFilters(sel: CrossFilterSelection): { filters: ResolvedFieldFilter[]; tupleFilters: ResolvedTupleFilter[] } {
  if (isRectangular(sel)) {
    const filters = sel.fields.map((field, i) => ({
      field,
      includedKeys: [...new Set(sel.tuples.map((t) => t[i]))],
      level: 1,
      from: sel.sourceName,
    }));
    return { filters, tupleFilters: [] };
  }
  return {
    filters: [],
    tupleFilters: [{ fields: [...sel.fields], tuples: sel.tuples.map((t) => [...t]), from: sel.sourceName }],
  };
}

/**
 * The page-level base every target on the page starts from: page / pages /
 * all-scoped filters only (no visual-scoped filter, no selection, no
 * interaction). resolveFiltersFor builds on the same rule; the bindings mirror
 * sends it as the page set. The ONLY base path: there is no synthetic "page"
 * target.
 */
export function resolvePageBase(pageSheetId: string, connectionId: string): ResolvedFilters {
  const out = emptyResolved();
  for (const f of ordered(getReportFilters())) {
    if (f.connectionId !== String(connectionId) || !reachesPage(f, pageSheetId)) continue;
    out.filters.push(fieldFilterOf(f));
    addSource(out, f.sourceName, f.sourceRef, "filter");
  }
  return out;
}

/** What `target` on `pageSheetId` reads of model `connectionId` (see the header for the rules). */
export function resolveFiltersFor(
  pageSheetId: string,
  target: ResolveTarget,
  connectionId: string,
  options?: ResolveOptions,
): ResolvedFilters {
  const out = emptyResolved();
  const conn = String(connectionId);

  if (options?.include !== "visualSelectionsOnly") {
    for (const f of ordered(getReportFilters())) {
      if (f.connectionId !== conn) continue;
      const reaches =
        f.scope.kind === "visuals" ? f.scope.targets.some((t) => sameRef(t, target.ref)) : reachesPage(f, pageSheetId);
      if (!reaches) continue;
      if (f.sourceRef) {
        if (sameRef(f.sourceRef, target.ref)) continue;
        if (interactionFor(pageSheetId, f.sourceRef, target, f.sourceRef.kind === "slicer") === "none") continue;
      }
      out.filters.push(fieldFilterOf(f));
      addSource(out, f.sourceName, f.sourceRef, "filter");
    }
  }

  for (const sel of getCrossFilters(pageSheetId)) {
    if (sel.connectionId !== conn) continue;
    if (sameRef(sel.source, target.ref)) continue;
    const mode = interactionFor(pageSheetId, sel.source, target, sel.source.kind === "slicer");
    if (mode === "none") continue;
    const parts = selectionFilters(sel);
    if (mode === "highlight") {
      out.highlights = out.highlights ?? { filters: [], tupleFilters: [] };
      out.highlights.filters.push(...parts.filters);
      out.highlights.tupleFilters.push(...parts.tupleFilters);
    } else {
      out.filters.push(...parts.filters);
      out.tupleFilters.push(...parts.tupleFilters);
    }
    addSource(out, sel.sourceName, sel.source, mode);
  }
  return out;
}
