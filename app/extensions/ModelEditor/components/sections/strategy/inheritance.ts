// FILENAME: app/extensions/ModelEditor/components/sections/strategy/inheritance.ts
// PURPOSE: Reading the resolver's answer — where an attribute's value CAME
//          from, and how to say so.
// CONTEXT: Implements property (7). NOTHING here re-derives a resolved value:
//          no band ordering, no KPI lookup, no direction inference. One
//          implementation decides and it is the Rust resolver; these only read
//          what it sent back. See the numbered list in ../StrategySection.tsx.

import type { Applied, AttrSource, ResolvedMeasure } from "../../../lib/strategyBackend";
import {
  formatAggregationSpec,
  formatMaterialitySpec,
  formatTargetSpec,
} from "../../../lib/strategyTypes";

// ===========================================================================


/** The rule id, when a rule is what decided this attribute. */
export function sourceRuleId(source: AttrSource): string | null {
  return typeof source === "object" && "rule" in source ? source.rule : null;
}

/** The KPI name, when a model KPI is what supplied this attribute. */
export function sourceKpiName(source: AttrSource): string | null {
  return typeof source === "object" && "kpi" in source ? source.kpi : null;
}

/**
 * The source as a short token, for the "why" list: `attribute: value (source)`.
 *
 * A KPI and a rule are NAMED. "inherited" is not an answer anybody can go and
 * check; "KPI 'Margin % KPI'" is one they can open.
 */
export function sourceLabel(source: AttrSource): string {
  const kpi = sourceKpiName(source);
  if (kpi !== null) return kpi === "" ? "the model's KPI" : `KPI '${kpi}'`;
  const rule = sourceRuleId(source);
  if (rule !== null) return `rule '${rule}'`;
  return source as "base" | "inferred" | "strategy";
}

/**
 * The source as a phrase for a control that is showing an inherited value.
 *
 * The empty-KPI case is real rather than defensive: the resolver stamps
 * `Kpi(name)` from an `Option`, so a KPI with no name arrives as `{"kpi": ""}`
 * and "from KPI ''" would read as a bug in the tab rather than a gap in the
 * model.
 */
export function inheritedFrom(source: AttrSource): string {
  const kpi = sourceKpiName(source);
  if (kpi !== null) return kpi === "" ? "from the model's KPI" : `from KPI '${kpi}'`;
  const rule = sourceRuleId(source);
  if (rule !== null) return `from rule '${rule}'`;
  switch (source) {
    case "base":
      return "from the model";
    case "inferred":
      return "inferred from the model";
    default:
      return "from this measure's entry";
  }
}

/**
 * What an empty control says instead of a blank: the value it already
 * inherits, and where from — "higherIsBetter — from KPI 'Margin % KPI'".
 *
 * `null` when nothing is inherited, which is the only case where a blank is
 * the truth.
 */
export function inheritedOption<T>(
  applied: Applied<T> | null | undefined,
  format: (value: T) => string,
): string | null {
  // `== null`, deliberately, and the same at every other site that takes an
  // `Applied`. The resolver's `Option<Applied<T>>` fields carry no
  // `skip_serializing_if`, so an attribute nothing decided arrives as an
  // explicit `null`. This read `=== undefined` and crashed the Model Editor on
  // the first measure with no KPI and no strategy entry — which is most
  // measures of most models.
  if (applied == null) return null;
  const text = format(applied.value);
  if (text === "") return null;
  return `${text} — ${inheritedFrom(applied.source)}`;
}

/**
 * What an EMPTY control should say — or null when the document itself carries
 * the value, in which case the control shows the document, which is what it
 * edits.
 */
export function inheritedFor<T>(
  carried: T | undefined,
  applied: Applied<T> | null | undefined,
  format: (value: T) => string,
): string | null {
  // `carried` comes from the DOCUMENT, whose fields do skip when absent, so
  // `undefined` is the right test for it — the asymmetry with `applied` is real
  // and is why both spellings appear in one function.
  if (carried !== undefined) return null;
  return inheritedOption(applied, format);
}

/**
 * The rule that OVERRIDES a value the document carries, if there is one.
 *
 * Only meaningful where the document states something: a rule that supplied an
 * absent value is already named in the inherited note, and saying it twice in
 * two spellings is how one of them comes to be wrong.
 */
export function overridingRule<T>(
  carried: T | undefined,
  applied: Applied<T> | null | undefined,
): string | null {
  if (carried === undefined || applied == null) return null;
  return sourceRuleId(applied.source);
}

/**
 * The whole resolved measure, one attribute per line, with provenance.
 *
 * The SUPPRESSIONS are here because "no favourability here, because rule X
 * disagrees" is the single most confusing thing the engine can do, and this
 * tooltip is the only place a person can learn it. A suppressed attribute has
 * no value to show anywhere else — that is what suppression means.
 */
export function whyLines(resolved: ResolvedMeasure): string[] {
  const lines: string[] = [];
  function add<T>(
    attribute: string,
    applied: Applied<T> | null | undefined,
    format: (value: T) => string,
  ): void {
    if (applied == null) return;
    const text = format(applied.value);
    lines.push(`${attribute}: ${text === "" ? "(none)" : text} (${sourceLabel(applied.source)})`);
  }
  add("direction", resolved.direction, (d) => d);
  add("aggregation", resolved.aggregation, (a) => formatAggregationSpec(a));
  add("unit", resolved.unit, (u) => u);
  add("target", resolved.target, (t) => formatTargetSpec(t));
  add("materiality", resolved.materiality, (m) => formatMaterialitySpec(m));
  add("cadence", resolved.cadence, (c) => c);
  add("priority", resolved.priority, (p) => String(p));
  add("rankWeight", resolved.rankWeight, (w) => String(w));
  if (resolved.analysisDimensions.length > 0) {
    lines.push(`analysis dimensions: ${resolved.analysisDimensions.join(", ")}`);
  }
  if (resolved.neverSliceBy.length > 0) {
    lines.push(`never slice by: ${resolved.neverSliceBy.join(", ")}`);
  }
  if (resolved.suppressedKinds.length > 0) {
    lines.push(`suppressed fact kinds: ${resolved.suppressedKinds.join(", ")}`);
  }
  for (const s of resolved.suppressions) {
    lines.push(`${s.attribute}: WITHHELD by rule '${s.rule}' — ${s.reason}`);
  }
  if (lines.length === 0) {
    lines.push("Nothing is decided for this measure — not by the model, not by the strategy.");
  }
  return lines;
}

/** The per-row "why": everything the resolver decided, as a tooltip.
 *
 *  Deliberately NOT a popover. The question it answers ("where did this number
 *  come from?") is asked while looking at one cell, and a panel that has to be
 *  opened and closed is a worse answer than one that is already there. */
