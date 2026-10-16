//! FILENAME: app/extensions/Charts/lib/chartBindings.ts
// PURPOSE: A chart's identity in the object-binding store, and the ONE place a
//          chart's bound properties are painted: the resolved values of its
//          bindings laid over its literal spec (`overlayChartBindings`).
// CONTEXT: D-BIND (docs/design/canvas-sheets.md §15). A chart title, an axis
//          title, a series name, a KPI goal ... can be a BINDING: a formula
//          Rust evaluates (cells, names, `[Measure]` refs under the page's
//          slicers) and the seam `@api/objectBindings` caches. The literal stays
//          in the spec; the binding lives in the workbook's one binding store.
//
//          THERE IS NO SECOND SPELLING. A chart used to link a title to a cell
//          by storing the text `=Sheet1!A1` in `spec.title` and resolving it in
//          the reader (`resolveSpecReferences`, deleted). That spelling is gone:
//          a file that still carries it is migrated into a binding on load
//          (Rust `object_bindings/migrate.rs`), and a literal that starts with
//          `=` is TEXT and paints exactly as typed.
//
//          The chart's binding object JSON is its ChartDefinition envelope, so
//          every chart pointer starts `/spec/` and the overlay root is "/spec".
//          This module imports nothing from the renderer or the store, so the
//          data reader (which the renderer imports) can use it without a cycle.

import { overlayResolved, type ObjectBindingRef } from "@api/objectBindings";
import type { ChartSpec } from "../types";

/** The binding kind a chart is stored under. */
export const CHART_BINDING_KIND = "chart" as const;

/** Where a chart's spec sits in its binding object JSON (the envelope). */
export const CHART_SPEC_ROOT_POINTER = "/spec";

/** A chart's binding ref: its chart id IS its stable id (Rust `ChartEntry.id`). */
export function chartBindingRef(chartId: string): ObjectBindingRef {
  return { kind: CHART_BINDING_KIND, id: chartId };
}

/**
 * The spec a chart PAINTS: its literal spec with every resolved binding laid
 * over it, by the seam's rules (a pending value keeps the literal; an error
 * keeps the literal of a non-text slot; a text slot shows its display, errors
 * included). Never mutates `spec`, and returns `spec` itself when the chart has
 * nothing resolved -- the unbound chart costs no copy.
 *
 * `chartId` undefined (a dialog preview of an unsaved chart, a concat child,
 * an export of a bare spec) means "no placed chart", which has no bindings.
 */
export function overlayChartBindings(chartId: string | undefined | null, spec: ChartSpec): ChartSpec {
  if (!chartId) return spec;
  return overlayResolved(chartBindingRef(chartId), CHART_SPEC_ROOT_POINTER, spec);
}
