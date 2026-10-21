//! FILENAME: app/extensions/Slicer/lib/slicerVisualConstraints.ts
// PURPOSE: A MODEL slicer as a cross-filter TARGET (P4, G4, S8): the other
//   visuals' selections on its canvas page narrow which of its items still
//   have data (dimmed, or hidden per the slicer's "hide items with no data"),
//   exactly as a click on a bar in Power BI greys the slicer's other values.
//   Its SELECTION never moves: a visual's selection is view state, the
//   slicer's selection is the user's filter.
// CONTEXT: The resolver (@api/reportFilters) answers which selections reach
//   the slicer -- a pair set to None in Edit interactions drops a source, a
//   highlight is a filter for a slicer -- and this module turns that answer
//   into `get_slicer_items`' optional `visualConstraints` argument (Rust
//   S4d: has-data only; a non-model slicer ignores it).
//
//   ONLY visual selections ("visualSelectionsOnly"): the page's model slicers
//   and the ribbon filters already reach a slicer's has-data through the
//   backend's own sibling path (model_slicer_cross_filters), which also
//   honours a slicer -> slicer None pair. Sending them here as well would
//   apply them twice and ignore that pair.
//
//   EVERY constraint goes on the wire as a TUPLE filter, a rectangular
//   selection's per-column IN as a one-column tuple filter. The wire's plain
//   `filters` entry names a column by (table, column), and only the backend
//   knows the model's table names (a table name may hold a dot); a tuple
//   filter's "Table.Column" fields are split by Rust against the model, and a
//   field the model does not have drops that one filter instead of failing
//   the whole item read (the BUG-0527 rule). Rust folds a one-column tuple
//   filter into a plain IN, so nothing is lost.
//
//   WHEN: every items read of a model slicer computes the argument at the
//   time it reads (slicerStore.refreshSlicerItems). A report-filter change
//   re-reads the model slicers it can have moved: one the change names as a
//   target (an interaction pair whose source is active), and one on a page
//   the change names whose argument is now different from the one its last
//   read sent. A slicer's own click republishes its page's filters and is
//   NOT a reason to re-read anyone here: those filters never enter this
//   argument, so the comparison finds nothing moved.

import {
  onReportFiltersChange,
  resolveFiltersFor,
  type ReportFiltersChange,
} from "@api/reportFilters";
import { getReportPagesSnapshot, sheetIdAt, type ReportPagesSnapshot } from "@api/reportPages";
import type { SlicerVisualConstraints, TupleFilterWire } from "@api/types";
import type { Slicer } from "./slicerTypes";

/** A slicer reads a model when its source is a model connection. */
export function isModelSlicer(slicer: Pick<Slicer, "sourceType">): boolean {
  return slicer.sourceType === "biConnection";
}

/**
 * The other visuals' selections that reach `slicer`, as `get_slicer_items`
 * takes them, or undefined when none do (a table or pivot slicer, a sheet the
 * page list does not know yet, no selection on its page). Pure over the seam
 * and the page list.
 */
export function slicerVisualConstraints(
  slicer: Pick<Slicer, "id" | "sheetIndex" | "sourceType" | "cacheSourceId">,
  pages: ReportPagesSnapshot = getReportPagesSnapshot(),
): SlicerVisualConstraints | undefined {
  if (!isModelSlicer(slicer)) return undefined;
  const connectionId = String(slicer.cacheSourceId ?? "");
  if (connectionId === "") return undefined;
  const sheetId = sheetIdAt(pages, slicer.sheetIndex);
  if (!sheetId) return undefined;
  const resolved = resolveFiltersFor(
    sheetId,
    { ref: { kind: "slicer", id: String(slicer.id) }, canHighlight: false },
    connectionId,
    { include: "visualSelectionsOnly" },
  );
  const tuples: TupleFilterWire[] = [];
  for (const f of resolved.filters) {
    tuples.push({ fields: [f.field], tuples: f.includedKeys.map((k) => [k]) });
  }
  for (const t of resolved.tupleFilters) {
    tuples.push({ fields: [...t.fields], tuples: t.tuples.map((row) => [...row]) });
  }
  // A slicer cannot paint a highlight: the resolver turns one into a filter
  // for a target that says so, so `highlights` is null here. Read nothing
  // from it rather than trust that twice.
  if (tuples.length === 0) return undefined;
  return { filters: [], tuples };
}

/** A comparable spelling of an argument (absent = ""). */
export function visualConstraintsSignature(c: SlicerVisualConstraints | undefined): string {
  return c ? JSON.stringify(c) : "";
}

/** What each slicer's last items read SENT, by slicer id. */
const lastSent = new Map<string, string>();

/** Record what an items read is about to send (slicerStore.refreshSlicerItems). */
export function noteVisualConstraintsSent(slicerId: string, c: SlicerVisualConstraints | undefined): void {
  lastSent.set(String(slicerId), visualConstraintsSignature(c));
}

/** Forget every record (File > New / Open, deactivation, tests). */
export function resetVisualConstraintsSent(): void {
  lastSent.clear();
}

/**
 * The model slicers whose items `change` can have moved, pure over the
 * slicers, the page list and the seam: those it names as a target, and those
 * on a page (and connection) it names whose argument differs from what their
 * last read sent.
 */
export function slicersToReread(
  change: ReportFiltersChange,
  slicers: readonly Slicer[],
  pages: ReportPagesSnapshot = getReportPagesSnapshot(),
): string[] {
  const named = new Set(change.targets.filter((t) => t.kind === "slicer").map((t) => String(t.id)));
  const out: string[] = [];
  for (const slicer of slicers) {
    if (!isModelSlicer(slicer)) continue;
    const id = String(slicer.id);
    if (named.has(id)) {
      out.push(id);
      continue;
    }
    const sheetId = sheetIdAt(pages, slicer.sheetIndex);
    const connectionId = String(slicer.cacheSourceId ?? "");
    const onPage = change.pages.some(
      (p) => p.connectionId === connectionId && (p.sheetId === "*" || p.sheetId === sheetId),
    );
    if (!onPage) continue;
    const now = visualConstraintsSignature(slicerVisualConstraints(slicer, pages));
    if (now !== (lastSent.get(id) ?? "")) out.push(id);
  }
  return out;
}

/**
 * Re-read a model slicer's items whenever a report-filter change can have
 * moved them, for as long as the extension is active. `refresh` is the
 * store's items read (it computes and records the argument itself).
 */
export function installSlicerVisualConstraintRefresh(deps: {
  getSlicers: () => readonly Slicer[];
  refresh: (slicerId: string) => Promise<unknown>;
}): () => void {
  const off = onReportFiltersChange((change) => {
    for (const id of slicersToReread(change, deps.getSlicers())) {
      void deps.refresh(id).catch((err) => {
        console.warn(`[Slicer] Could not re-read slicer "${id}" after a visual's selection changed:`, err);
      });
    }
  });
  return () => {
    off();
    resetVisualConstraintsSent();
  };
}
