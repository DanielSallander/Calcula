//! FILENAME: app/extensions/Charts/handlers/chartWidgetValues.ts
// PURPOSE: Ephemeral per-chart live values for bound param widgets (C5 S5).
//          Keyed by chartId then param name. A live widget value OVERRIDES the
//          param's literal/cell default at read time (resolveParams), but is
//          never serialized — only the bind declaration persists. Mirrors the
//          chartPointSelection store; cleared on chart delete / file open /
//          deactivation. The on-canvas control that SETS these is a follow-up;
//          this store + the resolveParams precedence are the foundation.

import type { ParamBinding } from "../types";
import type { FormulaValue } from "../lib/chartFormula";

const store = new Map<string, Record<string, FormulaValue>>();

/** The live value for one bound param on a chart, or undefined when unset. */
export function getWidgetValue(chartId: string, paramName: string): FormulaValue | undefined {
  return store.get(chartId)?.[paramName];
}

/** Set the live value for one bound param on a chart. */
export function setWidgetValue(chartId: string, paramName: string, value: FormulaValue): void {
  const existing = store.get(chartId);
  if (existing) existing[paramName] = value;
  else store.set(chartId, { [paramName]: value });
}

/** Clear all live widget values for a chart. Returns true if anything cleared. */
export function clearWidgetValues(chartId: string): boolean {
  return store.delete(chartId);
}

/** Clear every chart's live widget values (file open / deactivation). */
export function clearAllWidgetValues(): void {
  store.clear();
}

/**
 * Next value for a stepper/cycle/segment control given the current value and a
 * direction (+1 / -1). Pure — used by the (follow-up) on-canvas control and
 * unit-tested now so the interaction semantics are locked. Stepper clamps to
 * min/max by step; cycle/segment wrap over options.
 */
export function nextWidgetValue(
  bind: ParamBinding,
  current: FormulaValue | undefined,
  dir: 1 | -1,
): FormulaValue {
  if (bind.input === "stepper") {
    const step = bind.step ?? 1;
    const base = typeof current === "number" ? current : (bind.min ?? 0);
    let next = base + dir * step;
    if (bind.min != null) next = Math.max(bind.min, next);
    if (bind.max != null) next = Math.min(bind.max, next);
    return next;
  }
  // cycle / segment: move through options with wraparound.
  const options = bind.options ?? [];
  if (options.length === 0) return current ?? "";
  const idx = options.findIndex((o) => o === current);
  const nextIdx = ((idx < 0 ? 0 : idx + dir) % options.length + options.length) % options.length;
  return options[nextIdx];
}
