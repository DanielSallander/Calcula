//! FILENAME: app/extensions/Charts/lib/chartSpecValidate.ts
// PURPOSE: Runtime validation of a ChartSpec authored by an untrusted source —
//          a sandboxed object script (broker chart.updateSpec/replaceSpec) or, in
//          a later B8 slice, the AI. The schema (chartSpecSchema.ts) was Monaco-
//          editor-only; this puts it in front of the broker write path so a
//          script can no longer blind-merge arbitrary / garbage / wrong-typed
//          keys into a chart (the deep-merge previously cast Record<string,unknown>
//          straight to Partial<ChartSpec> with no gate).
// CONTEXT: Lives in the Charts extension (the schema's home) so the @api broker
//          seam stays schema-agnostic — Alien Rule preserved.

import type { ChartSpec } from "../types";
import { chartSpecJsonSchema } from "./chartSpecSchema";
import { schemaViolations } from "./jsonSchemaCheck";

/**
 * Reserved internal key prefix. setStyleProperty stores canvas-style overrides as
 * `_style_<name>` keys directly on the spec; they are not part of the public
 * schema. They are inert (nothing renders them today) but must round-trip, so
 * validation tolerates them rather than rejecting a spec that carries them.
 */
export const RESERVED_SPEC_PREFIX = "_style_";

/** A shallow copy of `spec` with reserved (`_style_*`) top-level keys removed,
 *  so the schema check sees only public, schema-governed properties. */
function withoutReserved(spec: unknown): unknown {
  if (typeof spec !== "object" || spec === null || Array.isArray(spec)) return spec;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(spec as Record<string, unknown>)) {
    if (k.startsWith(RESERVED_SPEC_PREFIX)) continue;
    out[k] = v;
  }
  return out;
}

/**
 * Validate a COMPLETE ChartSpec against the schema. Returns the list of
 * violations (empty = valid). Reserved `_style_*` keys are ignored. Pure.
 */
export function validateChartSpec(spec: unknown): string[] {
  return schemaViolations(withoutReserved(spec), chartSpecJsonSchema);
}

/**
 * Validate the RESULT of applying a partial patch — i.e. the already-deep-merged
 * spec. A merge patch can't be validated on its own (missing-required would fire
 * for every absent top-level field); validating the merged whole instead catches
 * unknown keys, wrong types, and bad enums introduced by the patch while a
 * partial-but-valid edit passes. `merged` is the spec the store would persist.
 */
export function validateMergedSpec(merged: ChartSpec): string[] {
  return validateChartSpec(merged);
}
