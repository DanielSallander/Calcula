//! FILENAME: app/extensions/Charts/lib/markOptionsForMark.ts
// PURPOSE: What a chart's mark options become when its TYPE changes: only the
//          keys the new mark's *MarkOptions definition declares, with a value
//          that definition accepts.
// CONTEXT: The Insert Chart dialog's type select and the Chart Design band's
//          type gallery used to change `mark` alone and keep every option the
//          old type had. The Visuals gallery pre-seeds options (Stacked column
//          -> `{ stackMode: "stacked" }`), so picking Card in the dialog saved a
//          card with `stackMode` -- a spec the schema refuses ("unknown property
//          'stackMode'"). Nothing refused it on the way in (the dialog never
//          validated), but every later script edit of that chart was refused by
//          the broker's merged-spec check, and the load canary warned on every
//          open. The options belong to the type; a new type keeps only what it
//          understands.

import type { ChartSpec, MarkOptions } from "../types";
import { chartSpecJsonSchema, markOptionsDefinitionFor } from "./chartSpecSchema";
import { schemaViolations } from "./jsonSchemaCheck";

/* eslint-disable @typescript-eslint/no-explicit-any */

/**
 * `options` narrowed to `mark`: keys the mark's definition does not declare are
 * dropped, and so is a declared key whose value the definition refuses (a
 * combo's 100% stack, an enum value another type allowed). A mark the schema
 * does not narrow (a registered custom mark) keeps everything: its options are
 * its own to define. Returns undefined when nothing is left. Pure.
 */
export function markOptionsForMark(mark: string, options: MarkOptions | undefined): MarkOptions | undefined {
  if (options === undefined) return undefined;
  const defName = markOptionsDefinitionFor(mark);
  if (defName === null) return options;
  const schema = chartSpecJsonSchema as any;
  const def = schema.definitions?.[defName];
  const props: Record<string, unknown> = def?.properties ?? {};
  const kept: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(options as Record<string, unknown>)) {
    if (value === undefined || !(key in props)) continue;
    const one = schemaViolations(value, { ...props[key] as object, definitions: schema.definitions });
    if (one.length === 0) kept[key] = value;
  }
  return Object.keys(kept).length > 0 ? (kept as MarkOptions) : undefined;
}

/**
 * The patch that switches a STORED chart to `mark`. `updateChartSpec`
 * deep-merges objects key by key, so an option the new type does not keep is
 * written as an explicit `undefined` (which the merge copies and JSON then
 * omits); leaving it out would keep it.
 */
export function markSwitchPatch(spec: Pick<ChartSpec, "mark" | "markOptions">, mark: string): Partial<ChartSpec> {
  const next = markOptionsForMark(mark, spec.markOptions);
  const before = (spec.markOptions ?? {}) as Record<string, unknown>;
  const patch: Record<string, unknown> = { ...((next ?? {}) as Record<string, unknown>) };
  for (const key of Object.keys(before)) if (!(key in patch)) patch[key] = undefined;
  return {
    mark: mark as ChartSpec["mark"],
    ...(Object.keys(patch).length > 0 ? { markOptions: patch as MarkOptions } : {}),
  };
}
