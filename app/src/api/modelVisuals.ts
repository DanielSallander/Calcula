//! FILENAME: app/src/api/modelVisuals.ts
// PURPOSE: @api/modelVisuals -- which visuals of the workbook READ A MODEL, and
//          what role each can play in cross-filtering: a source (its datums
//          filter others), a target (it follows others), whether it can paint a
//          highlight, and, when it is neither, the sentence that says why.
// CONTEXT: P4 (G4). Edit interactions draws a Filter / Highlight / None icon on
//          every OTHER visual of the page, a ribbon filter's "Selected visuals"
//          lists every model visual of its connection, and the script API checks
//          that both refs of a pair exist. None of them may import the Charts,
//          Pivot or Slicer extension (the Seam Rule), so each family REGISTERS
//          a provider here that lists its own objects, and readers ask.
//
//          Who registers what:
//            - Charts: design-query charts from the mark's cross-filter
//              capability (@api/chartMarks chartMarkCrossFilter); range charts
//              with connectionId null, both roles false, reason "Reads cells,
//              not the model".
//            - Pivot: BI pivots (source on canvas only, target, no highlight);
//              range pivots with the same reason.
//            - Slicer: model slicers (source, target, no highlight); other
//              slicers with "Filters cells, not the model".
//
//          No effect registry: the one side effect of an interaction change (a
//          model slicer -> BI pivot pair moving to or from none) is applied by
//          Rust inside set_canvas_layout's own undo step, on every door (DC-9).
//
//          Seams point one way: this file imports nothing from app/extensions.

import type { VisualRef } from "./reportFilters/types";

/** One visual as the cross-filter surfaces see it. */
export interface ModelVisualInfo {
  ref: VisualRef;
  name: string;
  /** TRUE sheet index of the visual's sheet. */
  sheetIndex: number;
  /** The sheet's stable id, or null when the page list has none for it yet. */
  sheetId: string | null;
  /** null = not a model visual (a range chart, a range pivot, a table slicer). */
  connectionId: string | null;
  /** `reason` says why, when the visual is not a source or not a target. */
  role: { source: boolean; target: boolean; canHighlight: boolean; reason: string | null };
  /** What the visual is, for menus and tooltips: "Column chart", "PivotTable", "Card", "Slicer". */
  label: string;
}

/** A family's lister. `list()` is synchronous: it reads the family's own store. */
export interface ModelVisualProvider {
  kind: VisualRef["kind"];
  list(): readonly ModelVisualInfo[];
}

/** Registered providers, in registration order. */
const providers: ModelVisualProvider[] = [];

/** Register a family's provider. Returns its unregister function. */
export function registerModelVisualProvider(p: ModelVisualProvider): () => void {
  providers.push(p);
  return () => {
    const at = providers.indexOf(p);
    if (at >= 0) providers.splice(at, 1);
  };
}

/**
 * Every visual the providers list, in provider registration order, optionally
 * only those on one model connection and/or one page (sheet id). A provider
 * whose list throws is skipped (and said in the console): one family's failure
 * must not hide every other family's visuals.
 */
export function listModelVisuals(filter?: { connectionId?: string; sheetId?: string }): ModelVisualInfo[] {
  const out: ModelVisualInfo[] = [];
  for (const p of [...providers]) {
    let listed: readonly ModelVisualInfo[];
    try {
      listed = p.list();
    } catch (err) {
      console.warn(`[modelVisuals] The ${p.kind} provider failed to list its visuals:`, err);
      continue;
    }
    for (const v of listed) {
      if (filter?.connectionId !== undefined && v.connectionId !== String(filter.connectionId)) continue;
      if (filter?.sheetId !== undefined && v.sheetId !== filter.sheetId) continue;
      out.push(v);
    }
  }
  return out;
}

/** The visual `ref` names, or null when no provider lists it (it does not exist, or its family is not loaded). */
export function modelVisualOf(ref: VisualRef): ModelVisualInfo | null {
  for (const v of listModelVisuals()) {
    if (v.ref.kind === ref.kind && v.ref.id === ref.id) return v;
  }
  return null;
}
