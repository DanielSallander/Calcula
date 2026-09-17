//! FILENAME: app/src/api/pivotCues.ts
// PURPOSE: The member-based pivot route — a MODEL's facts (measures judged by
//          the strategy) matched to the cells of a BI pivot by the labels the
//          pivot shows. Pure over a pivot view. IO-6 of
//          docs/design/insight-overlays.md.
// CONTEXT: A BI pivot's cells are a query over the model, so the honest facts
//          about them are the model's (`insights_analyze_model`): a change in a
//          measure judged by its declared direction, a member's contribution to
//          that change, a level shift in the measure's own series. Those facts
//          name MEMBERS and PERIODS by label and MEASURES by name; a pivot's view
//          names its cells by `(fieldIndex, valueId)` pairs and shows the labels
//          in its header cells. This module joins the two:
//
//          - every header cell teaches which labels a pair shows (a subtotal
//            header shows "Gadgets Total" for the same pair as "Gadgets", so a
//            pair keeps a SET of labels);
//          - every data cell is a set of pairs plus the measure its column
//            carries (from the caption row, or the pivot's only value field);
//          - a fact becomes REQUIREMENTS — "a pair on field Product.Category
//            showing Gadgets", "any pair showing 2024-Q2" — and the cells that
//            satisfy them are its targets.
//
//          THE CELL THAT IS THE FACT, ELSE EVERY CELL THE FACT COVERS. A fact
//          about Gadgets in Q2 is the cell whose pairs are exactly {Gadgets, Q2}
//          (a leaf when those are the only axes, a subtotal when there are
//          more). When no cell has exactly those pairs, every cell containing
//          them is marked — Gadgets under each region — because each of those
//          cells IS Gadgets, and the fact's description names what was judged.
//
//          POLARITY IS THE STRATEGY'S, NEVER THE NUMBER'S. A change or variance
//          fact carries Rust's `favourability`, which already applied the
//          direction (and the withheld case: `None` → neutral). A member fact
//          borrows the direction that reached its measure's change fact, through
//          `polarityFor`; a measure whose direction was withheld colours nothing.
//
//          Spellings, as the writers spell them: a fact's `dimension` is
//          `Table[Column]` (strategy `ColumnRef`), a pivot field summary is
//          `Table.Column` (`pivot/commands.rs`), a BI value field is `[Measure]`
//          (`pivot/commands.rs` 5353) and its caption may be a custom name — a
//          renamed caption is `measure-not-in-pivot`, never a guess.

import type { ChartCuePolarity } from "./chartCues";
import type { InsightBundle } from "./insightsService";
import { directionOf, parseFacts, polarityFor, type CueTone, type FactRecord } from "./insightCues";
import type { PivotCellData, PivotViewResponse } from "./pivotTypes";

// ============================================================================
// Output
// ============================================================================

/** A cue on one cell of the VIEW; the caller adds the region's origin. */
export interface PivotCue {
  factId: string;
  polarity: ChartCuePolarity;
  description: string;
  label?: string;
  viewRow: number;
  viewCol: number;
}

export type PivotCueDropReason =
  | "measure-not-in-pivot"
  | "dimension-not-in-pivot"
  | "member-not-in-pivot"
  | "period-not-in-pivot"
  | "no-position-in-fact"
  | "malformed-fact";

export interface PivotCueDrop {
  factId: string;
  reason: PivotCueDropReason;
}

export interface PivotCueSet {
  /** In the bundle's rank order; the cues of one fact stay adjacent. */
  cues: PivotCue[];
  dropped: PivotCueDrop[];
}

// ============================================================================
// Reading the view
// ============================================================================

/**
 * A header is a LABELLED cell with a group path — a row or column header, or a
 * subtotal's label cell ("Gadgets Total"), whose path ends in the pair it
 * names. A data cell is a NUMBER with a group path in a data row — a leaf, a
 * subtotal's number, a grand total's; the engine types a subtotal row's numbers
 * `RowSubtotal`, so the value decides, not the cell type.
 */
const CHROME_TYPES: ReadonlySet<string> = new Set(["Corner", "Blank", "FilterLabel", "FilterDropdown"]);

interface Pair {
  field: string;
  labels: ReadonlySet<string>;
}

interface DataCell {
  viewRow: number;
  viewCol: number;
  /** The measure this cell's column carries, bracket-stripped; null when unknown. */
  measure: string | null;
  pairs: Pair[];
}

/** `[Total Sales]` → `Total Sales`; anything else unchanged. */
export function stripBrackets(name: string): string {
  return name.length >= 2 && name.startsWith("[") && name.endsWith("]") ? name.slice(1, -1) : name;
}

/** `Table[Column]` → `Table.Column`; a string in neither spelling is returned as is. */
export function dimensionToFieldName(dimension: string): string {
  const m = /^(.+?)\[(.+)\]$/.exec(dimension);
  return m ? `${m[1]}.${m[2]}` : dimension;
}

function labelOf(cell: PivotCellData): string | null {
  const v = cell.value;
  if (typeof v === "string") return v === "" ? null : v;
  if (typeof v === "number") return String(v);
  return null;
}

function pairKey(p: readonly [number, number]): string {
  return `${p[0]}:${p[1]}`;
}

interface ViewIndex {
  fieldNames: Set<string>;
  /** Every label shown anywhere, for the period check. */
  allLabels: Set<string>;
  cells: DataCell[];
  /** Bracket-stripped measures some data cell carries. */
  measures: Set<string>;
}

/** Read a full (non-windowed) view once. */
function indexView(view: PivotViewResponse, valueFields: readonly string[]): ViewIndex {
  const fieldNameOf = new Map<number, string>();
  for (const s of [...view.rowFieldSummaries, ...view.columnFieldSummaries]) fieldNameOf.set(s.fieldIndex, s.fieldName);

  // Pass 1: what each pair shows, and which columns carry which measure.
  const labelsByPair = new Map<string, Set<string>>();
  const allLabels = new Set<string>();
  const stripped = valueFields.map(stripBrackets);
  const captionByCol = new Map<number, string>();
  for (const row of view.rows) {
    row.cells.forEach((cell, viewCol) => {
      const label = labelOf(cell);
      if (label === null) return;
      if (typeof cell.value === "string" && !CHROME_TYPES.has(cell.cellType) && cell.groupPath && cell.groupPath.length > 0) {
        const k = pairKey(cell.groupPath[cell.groupPath.length - 1]);
        const set = labelsByPair.get(k) ?? new Set<string>();
        set.add(label);
        labelsByPair.set(k, set);
        allLabels.add(label);
      }
      if (row.rowType === "ColumnHeader" && cell.cellType === "ColumnHeader") {
        const idx = stripped.indexOf(stripBrackets(label));
        if (idx >= 0) captionByCol.set(viewCol, stripped[idx]);
      }
    });
  }
  const only = stripped.length === 1 ? stripped[0] : null;

  // Pass 2: the data cells.
  //
  // A BLANK MEMBER (a category whose name is empty or null) has no pair at
  // all: the engine skips `VALUE_ID_EMPTY` when it builds a group path, so the
  // blank member's LEAF cell carries the same pairs as a subtotal one level up
  // and would pass for "the cell that IS the fact". A fact never names a blank
  // member, so a leaf (`Data`) cell with fewer pairs than the pivot has axis
  // fields is left out — found live on a model whose product category was
  // null for some sales, where the month's change cue landed on that column
  // as well as on the Grand Total.
  const axisFields = view.rowFieldSummaries.length + view.columnFieldSummaries.length;
  const cells: DataCell[] = [];
  const measures = new Set<string>();
  view.rows.forEach((row, viewRow) => {
    if (row.rowType === "ColumnHeader" || row.rowType === "FilterRow") return;
    row.cells.forEach((cell, viewCol) => {
      if (typeof cell.value !== "number" || CHROME_TYPES.has(cell.cellType) || !cell.groupPath) return;
      if (cell.cellType === "Data" && cell.groupPath.length < axisFields) return;
      const pairs: Pair[] = [];
      for (const p of cell.groupPath) {
        const field = fieldNameOf.get(p[0]);
        if (field === undefined) return; // a pair on a field the summaries do not name: not addressable
        pairs.push({ field, labels: labelsByPair.get(pairKey(p)) ?? new Set() });
      }
      const measure = captionByCol.get(viewCol) ?? only;
      if (measure !== null) measures.add(measure);
      cells.push({ viewRow, viewCol, measure, pairs });
    });
  });

  return { fieldNames: new Set(fieldNameOf.values()), allLabels, cells, measures };
}

// ============================================================================
// Rules: facts → requirements
// ============================================================================

/** "A pair on this field (or any field) that shows this label." */
interface Requirement {
  field: string | null;
  label: string;
  /** What is missing when no cell satisfies it. */
  missing: "member-not-in-pivot" | "period-not-in-pivot";
}

interface PivotDraft {
  measure: string;
  requirements: Requirement[];
  /** Either the strategy's verdict (change/variance) or a tone to colour by direction. */
  polarity: ChartCuePolarity | { tone: CueTone };
  description: string;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

/** Rust's `Option<Favourability>`, already judged by the direction (withheld → null). */
function polarityOfFavourability(v: unknown): ChartCuePolarity {
  if (v === "better") return "good";
  if (v === "worse") return "bad";
  return "neutral";
}

const pct = (v: number): string => `${Math.round(Math.abs(v) * 100)}%`;

function movement(delta: number, pctValue: unknown): string {
  const word = delta > 0 ? "up" : delta < 0 ? "down" : "unchanged";
  return typeof pctValue === "number" && delta !== 0 ? `${word} ${pct(pctValue)}` : word;
}

function memberDrafts(kind: FactRecord["kind"], members: Array<{ member: string; delta: number }>, lastLabel: string | null): PivotDraft[] | PivotCueDropReason {
  if (typeof kind.measure !== "string" || typeof kind.dimension !== "string") return "malformed-fact";
  const field = dimensionToFieldName(kind.dimension);
  return members.map((m) => ({
    measure: kind.measure as string,
    requirements: [
      { field, label: m.member, missing: "member-not-in-pivot" },
      ...(lastLabel !== null ? [{ field: null, label: lastLabel, missing: "period-not-in-pivot" as const }] : []),
    ],
    polarity: { tone: m.delta > 0 ? "high" : m.delta < 0 ? "low" : "neutral" },
    description: `${m.member}: ${kind.measure} ${m.delta > 0 ? "up" : m.delta < 0 ? "down" : "unchanged"}`,
  }));
}

/** The label at which a series fact points, per inner kind; null for kinds without one. */
function seriesDrafts(inner: Record<string, unknown>): PivotDraft[] | PivotCueDropReason | null {
  const subject = inner.subject;
  const measure = isRecord(subject) && typeof subject.name === "string" ? subject.name : null;
  if (measure === null) return "malformed-fact";
  const at = (label: unknown, tone: CueTone, description: string): PivotDraft | PivotCueDropReason =>
    typeof label === "string"
      ? { measure, requirements: [{ field: null, label, missing: "period-not-in-pivot" }], polarity: { tone }, description }
      : "malformed-fact";
  const collect = (items: Array<PivotDraft | PivotCueDropReason>): PivotDraft[] | PivotCueDropReason => {
    const bad = items.find((i) => typeof i === "string");
    return typeof bad === "string" ? bad : (items as PivotDraft[]);
  };
  switch (inner.fact) {
    case "extremes":
      return collect([at(inner.bestLabel, "high", `Highest ${measure}`), at(inner.worstLabel, "low", `Lowest ${measure}`)]);
    case "smoothedPeak":
      return collect([at(inner.peakLabel, "high", `Peak of ${measure} (smoothed)`), at(inner.troughLabel, "low", `Trough of ${measure} (smoothed)`)]);
    case "outliers":
      if (!Array.isArray(inner.points)) return "malformed-fact";
      return collect((inner.points as unknown[]).map((p) => at(isRecord(p) ? p.label : undefined, "attention", `Outlier in ${measure}`)));
    case "changePoint":
      return collect([at(inner.atLabel, "attention", `Level shift in ${measure}`)]);
    default:
      // trend/change/seasonality/crossover/leader…: no single period, or two measures.
      return null;
  }
}

/**
 * The rules. `lastLabelOf` answers "which period does this measure's change
 * fact end at", so a member fact can land on the member's LAST-period cell when
 * the pivot has that period, and on the member alone when it has not.
 */
function draftsFor(kind: FactRecord["kind"], lastLabelOf: (measure: string) => string | null): PivotDraft[] | PivotCueDropReason | null {
  switch (kind.fact) {
    case "change": {
      if (typeof kind.measure !== "string" || typeof kind.lastLabel !== "string" || typeof kind.delta !== "number") return "malformed-fact";
      return [{
        measure: kind.measure,
        requirements: [{ field: null, label: kind.lastLabel, missing: "period-not-in-pivot" }],
        polarity: polarityOfFavourability(kind.favourability),
        description: `${kind.measure} ${movement(kind.delta, kind.pct)}`,
      }];
    }
    case "variance": {
      if (typeof kind.measure !== "string" || typeof kind.periodLabel !== "string" || typeof kind.delta !== "number") return "malformed-fact";
      const side = kind.delta > 0 ? "above" : kind.delta < 0 ? "below" : "on";
      return [{
        measure: kind.measure,
        requirements: [{ field: null, label: kind.periodLabel, missing: "period-not-in-pivot" }],
        polarity: polarityOfFavourability(kind.favourability),
        description: `${kind.measure} ${side} target`,
      }];
    }
    case "contribution": {
      if (!Array.isArray(kind.members)) return "malformed-fact";
      const members: Array<{ member: string; delta: number }> = [];
      for (const m of kind.members as unknown[]) {
        if (!isRecord(m) || typeof m.member !== "string" || typeof m.delta !== "number") return "malformed-fact";
        members.push({ member: m.member, delta: m.delta });
      }
      return memberDrafts(kind, members, typeof kind.measure === "string" ? lastLabelOf(kind.measure) : null);
    }
    case "memberMove": {
      if (typeof kind.member !== "string" || typeof kind.delta !== "number") return "malformed-fact";
      return memberDrafts(kind, [{ member: kind.member, delta: kind.delta }], typeof kind.measure === "string" ? lastLabelOf(kind.measure) : null);
    }
    case "series":
      return isRecord(kind.inner) && typeof kind.inner.fact === "string" ? seriesDrafts(kind.inner) : "malformed-fact";
    case "definitionalDriver":
      // Its parts are OTHER measures at no period; there is no cell that is this fact.
      return "no-position-in-fact";
    default:
      return null;
  }
}

/** The fact kinds this route turns into pivot cues. Exported for the tests. */
export const PIVOT_CUE_FACT_KINDS: readonly string[] = Object.freeze(["change", "variance", "contribution", "memberMove", "series"]);

// ============================================================================
// Matching and assembly
// ============================================================================

function satisfies(cell: DataCell, r: Requirement): boolean {
  return cell.pairs.some((p) => (r.field === null || p.field === r.field) && p.labels.has(r.label));
}

/** The cells that ARE the draft (exact pair count), else every cell that covers it. */
function targetsOf(draft: PivotDraft, index: ViewIndex): DataCell[] {
  const covering = index.cells.filter((c) => c.measure === stripBrackets(draft.measure) && draft.requirements.every((r) => satisfies(c, r)));
  const exact = covering.filter((c) => c.pairs.length === draft.requirements.length);
  return exact.length > 0 ? exact : covering;
}

/** Why a draft matched nothing: the first requirement nothing in the view shows. */
function whyNothing(draft: PivotDraft, index: ViewIndex): PivotCueDropReason {
  if (!index.measures.has(stripBrackets(draft.measure))) return "measure-not-in-pivot";
  for (const r of draft.requirements) {
    if (r.field !== null && !index.fieldNames.has(r.field)) return "dimension-not-in-pivot";
    if (!index.cells.some((c) => satisfies(c, r))) return r.missing;
  }
  // Every requirement is met somewhere, just never in one cell of this measure.
  return draft.requirements.find((r) => r.field !== null)?.missing ?? "period-not-in-pivot";
}

/** The measure a fact is about, for the direction lookup. */
function measureOf(kind: FactRecord["kind"]): string | null {
  if (typeof kind.measure === "string") return kind.measure;
  if (kind.fact === "series" && isRecord(kind.inner) && isRecord(kind.inner.subject) && typeof kind.inner.subject.name === "string") return kind.inner.subject.name;
  return null;
}

/**
 * Every cue the model bundle justifies on this pivot view, in rank order.
 *
 * `valueFields` are the pivot's value-field names (`[Measure]` or a custom
 * name), from `pivot.getHierarchies(...).dataHierarchies`. Deterministic; a
 * fact whose every draft matched nothing appears once in `dropped` with the
 * first reason met; a kind that points at nothing on a pivot appears in
 * neither list. A windowed view carries only some rows; call this on a full
 * one.
 */
export function pivotCuesFor(bundle: InsightBundle, view: PivotViewResponse, valueFields: readonly string[]): PivotCueSet {
  const cues: PivotCue[] = [];
  const dropped: PivotCueDrop[] = [];
  const facts = parseFacts(bundle.factsJson);
  const insightsById = new Map(bundle.insights.map((i) => [i.id, i] as const));
  const index = indexView(view, valueFields);

  // The change fact of each measure: where its period ends and which direction judged it.
  const lastLabelByMeasure = new Map<string, string>();
  const directionByMeasure = new Map<string, string>();
  for (const fact of facts) {
    const measure = measureOf(fact.kind);
    if (measure === null) continue;
    if (fact.kind.fact === "change" && typeof fact.kind.lastLabel === "string" && !lastLabelByMeasure.has(measure)) {
      lastLabelByMeasure.set(measure, fact.kind.lastLabel);
    }
    const direction = directionOf(insightsById.get(fact.id));
    if (direction !== null && !directionByMeasure.has(measure)) directionByMeasure.set(measure, direction);
  }

  for (const fact of facts) {
    const drafts = draftsFor(fact.kind, (m) => lastLabelByMeasure.get(m) ?? null);
    if (drafts === null) continue;
    if (typeof drafts === "string") {
      dropped.push({ factId: fact.id, reason: drafts });
      continue;
    }
    const insight = insightsById.get(fact.id);
    const measure = measureOf(fact.kind);
    const direction = directionOf(insight) ?? (measure !== null ? directionByMeasure.get(measure) ?? null : null);
    let firstFailure: PivotCueDropReason | null = null;
    let placed = 0;
    for (const draft of drafts) {
      const targets = targetsOf(draft, index);
      if (targets.length === 0) {
        firstFailure ??= whyNothing(draft, index);
        continue;
      }
      const polarity = typeof draft.polarity === "string" ? draft.polarity : polarityFor(draft.polarity.tone, direction);
      for (const t of targets) {
        cues.push({
          factId: fact.id,
          polarity,
          description: draft.description,
          ...(insight && insight.text ? { label: insight.text } : {}),
          viewRow: t.viewRow,
          viewCol: t.viewCol,
        });
        placed++;
      }
    }
    if (placed === 0 && firstFailure) dropped.push({ factId: fact.id, reason: firstFailure });
  }

  return { cues, dropped };
}
