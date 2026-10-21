//! FILENAME: app/src/api/reportFilters/publishers.ts
// PURPOSE: What filtering families PUBLISH: a model slicer's kept members on
//          its page, a ribbon filter's kept members on its scope. Each
//          publisher REPLACES its whole list at once.
// CONTEXT: Replaces publishPageFilters / getPageFilters / listPageFilterPages
//          of the deleted @api/pageFilters. A filter now carries a SCOPE (a
//          page, pages, all pages, or named visuals -- a ribbon filter publishes
//          ONCE with its scope, never fanned out per sheet index) and, for a
//          model slicer, the canvas object behind it (`sourceRef`), which is what
//          Edit interactions pairs name. Reading what reaches ONE target is
//          resolve.ts; this file only holds.
//
//          A filter that can match nothing ON PURPOSE is held ([] keeps
//          nothing); a filter that cannot be ADDRESSED (no model, no field, no
//          page, a visuals scope naming no visual) is dropped rather than held
//          as something no target could ever resolve.

import type { ReportFilter, ReportFilterInput, ReportFilterScope, VisualRef } from "./types";
import { runChange } from "./changes";

const VISUAL_KINDS: ReadonlySet<string> = new Set(["chart", "pivot", "slicer"]);

/** Filters by publisher, in the publisher's own order. */
const byPublisher = new Map<string, ReportFilter[]>();

/** A ref this seam can hold, copied; null when it is not one. */
export function cleanVisualRef(ref: unknown): VisualRef | null {
  if (!ref || typeof ref !== "object") return null;
  const r = ref as { kind?: unknown; id?: unknown };
  if (typeof r.kind !== "string" || !VISUAL_KINDS.has(r.kind)) return null;
  if (typeof r.id !== "string" || r.id === "") return null;
  return { kind: r.kind as VisualRef["kind"], id: r.id };
}

function cleanScope(scope: ReportFilterScope | undefined): ReportFilterScope | null {
  if (!scope || typeof scope !== "object") return null;
  switch (scope.kind) {
    case "page":
      return typeof scope.sheetId === "string" && scope.sheetId !== "" ? { kind: "page", sheetId: scope.sheetId } : null;
    case "pages": {
      const ids = [...new Set((scope.sheetIds ?? []).filter((id) => typeof id === "string" && id !== ""))];
      return ids.length > 0 ? { kind: "pages", sheetIds: ids } : null;
    }
    case "all":
      return { kind: "all" };
    case "visuals": {
      const seen = new Set<string>();
      const targets: VisualRef[] = [];
      for (const t of scope.targets ?? []) {
        const ref = cleanVisualRef(t);
        if (!ref || seen.has(`${ref.kind}:${ref.id}`)) continue;
        seen.add(`${ref.kind}:${ref.id}`);
        targets.push(ref);
      }
      return targets.length > 0 ? { kind: "visuals", targets } : null;
    }
    default:
      return null;
  }
}

/**
 * Replace everything `publisher` holds with `filters`. Call it whenever the
 * publisher's state may have moved -- the seam announces only what really
 * changed (and nothing at all when nothing did). Publishing an empty list
 * withdraws the publisher's filters (a store reset, a deactivate).
 */
export function publishReportFilters(publisher: string, filters: readonly ReportFilterInput[]): void {
  const held: ReportFilter[] = [];
  for (const f of filters) {
    if (!f || typeof f.connectionId !== "string" || f.connectionId === "") continue;
    if (typeof f.field !== "string" || f.field === "") continue;
    const scope = cleanScope(f.scope);
    if (!scope) continue;
    held.push({
      publisher,
      sourceId: f.sourceId,
      sourceName: f.sourceName,
      sourceRef: cleanVisualRef(f.sourceRef),
      scope,
      connectionId: String(f.connectionId),
      field: f.field,
      includedKeys: [...f.includedKeys],
      filterLevel: f.filterLevel ?? 1,
    });
  }
  runChange(() => {
    if (held.length === 0) byPublisher.delete(publisher);
    else byPublisher.set(publisher, held);
  });
}

/** Every held filter, every publisher (the bindings mirror, tests). */
export function getReportFilters(): readonly ReportFilter[] {
  const out: ReportFilter[] = [];
  for (const filters of byPublisher.values()) out.push(...filters);
  return out;
}
