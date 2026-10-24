//! FILENAME: app/extensions/_shared/drillThrough/dslFilters.ts
// PURPOSE: How a drill-through's filters -- the clicked datum's members, the
//          page's filters, a pivot's standing filters -- are WRITTEN into the
//          design-query DSL (`bakeDrillFilters`), MERGED per field before that
//          (`mergeDrillSpecs`), and SHOWN to a person (`describeDrillFilters`).
// CONTEXT: docs/design/model-drillthrough.md 2.4. The filters are baked into
//          the DSL text as ONE `FILTERS:` clause rather than carried on the
//          request, so the kept result is an ordinary design-query object whose
//          Design tab SHOWS what it was filtered to. The spelling rules all
//          come from the lexer and the compiler:
//
//          - Field names are BRACKETED, `[Table.Column]`, always: the lexer's
//            bare-identifier charset is [A-Za-z0-9_] (lexer.ts), so an
//            unbracketed `Område` or a dotted table name would fail to lex. The
//            compiler rejoins a bracketed name at the first dot and resolves on
//            the full lower-case key. A name containing `]` has NO spelling in
//            this grammar and is refused.
//          - Values are ALWAYS quoted, a `"` inside a key doubled (`""`): the
//            lexer's one escape. The blank member is `= ("")`: it lexes to the
//            empty string, travels as `includedItems: [""]`, and Rust folds it
//            to the engine's "(Blank)" before the type match. Keys are written
//            AS-IS (Rust respells floats; a Decimal key keeps its scale). A key
//            with a line break cannot be a string literal and is refused.
//          - Terms on ONE field are merged first -- inclusion = INTERSECTION,
//            hidden = UNION -- exactly as compileDesignQuery merges them, so an
//            empty intersection is caught HERE, where it can be told ("the
//            source shows no members here"), instead of running as a query
//            that keeps nothing. So is an inclusion the exclusions cancel
//            completely: Rust keeps "included minus hidden", with the blank
//            member ONE member under either spelling ("" or "(blank)" in any
//            ASCII case, `pivot_engine::is_blank_member_key`), and the same
//            rule is applied here.
//
//          Pure: no IPC, no React. The runner toasts what this refuses.

import type { DrillFilterSpec } from "@api";

/** The label a blank member is shown under; its KEY is "" (CLAUDE.md: never identify a member by its label). */
export const BLANK_MEMBER_LABEL = "(Blank)";

/**
 * A spec the bake cannot write. The runner shows `message` as a toast; the
 * `field` names what it was about.
 */
export class DrillBakeRefusal extends Error {
  readonly field: string;
  constructor(message: string, field: string) {
    super(message);
    this.name = "DrillBakeRefusal";
    this.field = field;
  }
}

/** The merged state of one field while merging. */
interface FieldAccumulator {
  field: string;
  /** null until the first inclusion list arrives; [] after an empty one. */
  included: string[] | null;
  labelByKey: Map<string, string>;
  hidden: string[];
  hiddenSeen: Set<string>;
}

function intersectInOrder(current: string[], next: readonly string[]): string[] {
  const keep = new Set(next);
  return current.filter((k) => keep.has(k));
}

/**
 * Whether `key` spells the blank member: its key "" or the header text
 * "(blank)" in any ASCII case -- Rust's `pivot_engine::is_blank_member_key`
 * (`eq_ignore_ascii_case`). The regex has no `u` flag, so its case folding
 * never maps a non-ASCII letter (the Kelvin sign) onto an ASCII one, exactly
 * like the Rust comparison.
 */
export function isBlankMemberKey(key: string): boolean {
  return key === "" || /^\(blank\)$/i.test(key);
}

/** Whether the merged hidden list hides `key`: exactly, or as the one blank member under either spelling (Rust's `is_hidden`). */
function hiddenHas(acc: FieldAccumulator, key: string): boolean {
  return acc.hiddenSeen.has(key) || (isBlankMemberKey(key) && acc.hidden.some(isBlankMemberKey));
}

/**
 * Merge specs PER FIELD: the inclusion is the intersection of every
 * `includedKeys` list on the field (first list's order), the hidden list the
 * union of every `hiddenKeys`, labels kept for the surviving keys from whichever
 * spec named them. Fields match case-insensitively (the compiler resolves them
 * that way); the first spelling is kept. Order: first appearance.
 *
 * REFUSES an inclusion that keeps nothing -- an empty list handed in (a
 * slicer's Select None: "the source shows no members here"), an empty
 * intersection (two filters on one field with no member in common), or an
 * inclusion whose every member the hidden union also excludes (a page slicer
 * keeping East over a pivot that hides East) -- rather than write a term the
 * parser rejects (`= ()`), a sentinel, or a pair of terms that runs a query
 * for nothing with no word why.
 */
export function mergeDrillSpecs(specs: readonly DrillFilterSpec[]): DrillFilterSpec[] {
  const byField = new Map<string, FieldAccumulator>();
  for (const spec of specs) {
    const key = spec.field.toLowerCase();
    let acc = byField.get(key);
    if (!acc) {
      acc = { field: spec.field, included: null, labelByKey: new Map(), hidden: [], hiddenSeen: new Set() };
      byField.set(key, acc);
    }
    if (spec.includedKeys) {
      spec.includedKeys.forEach((k, i) => {
        const label = spec.labels?.[i];
        if (label !== undefined && !acc!.labelByKey.has(k)) acc!.labelByKey.set(k, label);
      });
      const distinct = [...new Set(spec.includedKeys)];
      acc.included = acc.included === null ? distinct : intersectInOrder(acc.included, distinct);
    }
    for (const k of spec.hiddenKeys ?? []) {
      if (acc.hiddenSeen.has(k)) continue;
      acc.hiddenSeen.add(k);
      acc.hidden.push(k);
    }
  }

  const out: DrillFilterSpec[] = [];
  for (const acc of byField.values()) {
    const merged: DrillFilterSpec = { field: acc.field };
    if (acc.included !== null) {
      if (acc.included.length === 0) {
        throw new DrillBakeRefusal(
          `The filters on "${acc.field}" keep no member: the source shows no members here, so there is nothing to drill into.`,
          acc.field,
        );
      }
      // Rust keeps "included minus hidden" (headless.rs `is_hidden`): when the
      // exclusions cancel every included member the query keeps nothing.
      if (acc.included.every((k) => hiddenHas(acc, k))) {
        throw new DrillBakeRefusal(
          `The filters on "${acc.field}" keep no member: every member they include is also excluded, so there is nothing to drill into.`,
          acc.field,
        );
      }
      merged.includedKeys = acc.included;
      if (acc.included.every((k) => acc.labelByKey.has(k))) {
        merged.labels = acc.included.map((k) => acc.labelByKey.get(k) as string);
      }
    }
    if (acc.hidden.length > 0) merged.hiddenKeys = acc.hidden;
    if (merged.includedKeys || merged.hiddenKeys) out.push(merged);
  }
  return out;
}

/** A member key as a DSL string literal: quoted, inner quotes doubled. */
export function quoteDrillKey(key: string, field: string): string {
  if (key.includes("\n")) {
    throw new DrillBakeRefusal(
      `Cannot drill on this member of "${field}": its key contains a line break, which a FILTERS value cannot carry.`,
      field,
    );
  }
  return `"${key.replace(/"/g, '""')}"`;
}

/** A field as the FILTERS grammar spells it: bracketed. */
export function bracketDrillField(field: string): string {
  if (field.includes("]")) {
    throw new DrillBakeRefusal(
      `Cannot drill on "${field}": a field name containing "]" has no spelling in the FILTERS grammar.`,
      field,
    );
  }
  return `[${field}]`;
}

/** The FILTERS terms of one (merged) spec: `[F] = (...)` and/or `[F] NOT IN (...)`. */
export function drillFilterTerms(spec: DrillFilterSpec): string[] {
  const name = bracketDrillField(spec.field);
  const terms: string[] = [];
  if (spec.includedKeys && spec.includedKeys.length > 0) {
    terms.push(`${name} = (${spec.includedKeys.map((k) => quoteDrillKey(k, spec.field)).join(", ")})`);
  }
  if (spec.hiddenKeys && spec.hiddenKeys.length > 0) {
    terms.push(`${name} NOT IN (${spec.hiddenKeys.map((k) => quoteDrillKey(k, spec.field)).join(", ")})`);
  }
  return terms;
}

/**
 * The DSL with the drill's filters baked in as ONE more `FILTERS:` line
 * (comma-separated terms). With no term to write, the text comes back
 * unchanged. The parser accumulates clauses, and compileDesignQuery merges
 * same-field terms, so an author's own `FILTERS:` on the same field ANDs with
 * the baked one instead of being replaced.
 *
 * Throws {@link DrillBakeRefusal} for a field or key that has no spelling, or
 * an inclusion that keeps nothing.
 */
export function bakeDrillFilters(dslText: string, specs: readonly DrillFilterSpec[]): string {
  const terms = mergeDrillSpecs(specs).flatMap(drillFilterTerms);
  if (terms.length === 0) return dslText;
  const line = `FILTERS: ${terms.join(", ")}`;
  const body = dslText.replace(/\s+$/, "");
  return body ? `${body}\n${line}` : line;
}

/**
 * A member's display text: its label; the blank member (key "") is always
 * "(Blank)" whatever label rode beside it, so the blank has ONE spelling.
 * Only called once every non-blank key is known to have a label.
 */
function memberText(key: string, label: string | undefined): string {
  if (key === "") return BLANK_MEMBER_LABEL;
  return label !== undefined && label !== "" ? label : BLANK_MEMBER_LABEL;
}

/**
 * The filters as a person reads them -- "Product.Category: Bikes; Geo.Region:
 * East, West" -- for captions and titles. Renders LABELS and "(Blank)", never
 * a key: when a kept member has no label the field shows "<field>: N selected"
 * instead. Hidden-only fields show "<field>: N excluded". Specs are merged per
 * field first, so the text matches what was baked. Empty when nothing filters.
 */
export function describeDrillFilters(specs: readonly DrillFilterSpec[]): string {
  const parts: string[] = [];
  for (const spec of mergeDrillSpecs(specs)) {
    if (spec.includedKeys && spec.includedKeys.length > 0) {
      const labels = spec.labels;
      const allLabelled =
        labels !== undefined &&
        labels.length === spec.includedKeys.length &&
        spec.includedKeys.every((k, i) => k === "" || (labels[i] !== undefined && labels[i] !== ""));
      parts.push(
        allLabelled
          ? `${spec.field}: ${spec.includedKeys.map((k, i) => memberText(k, labels[i])).join(", ")}`
          : `${spec.field}: ${spec.includedKeys.length} selected`,
      );
    }
    if (spec.hiddenKeys && spec.hiddenKeys.length > 0) {
      parts.push(`${spec.field}: ${spec.hiddenKeys.length} excluded`);
    }
  }
  return parts.join("; ");
}

/**
 * The labels of the CLICKED members alone ("Bikes" / "Bikes, 2024"), for a
 * title's second half. Same rules as {@link describeDrillFilters} but without
 * the field names; a member with no label contributes nothing.
 */
export function drillMemberLabels(specs: readonly DrillFilterSpec[]): string {
  const labels: string[] = [];
  for (const spec of specs) {
    if (!spec.includedKeys) continue;
    spec.includedKeys.forEach((k, i) => {
      const label = spec.labels?.[i];
      if (k === "") labels.push(BLANK_MEMBER_LABEL);
      else if (label !== undefined && label !== "") labels.push(label);
    });
  }
  return labels.join(", ");
}
