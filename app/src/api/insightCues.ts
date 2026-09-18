//! FILENAME: app/src/api/insightCues.ts
// PURPOSE: The cue rules — which facts become which marks, where, in what
//          colour, with what three-word description. Pure. IO-2 of
//          docs/design/insight-overlays.md.
// CONTEXT: The overlay is a second VIEW of a bundle, never a second
//          computation (§4.1). This module reads `factsJson` — the numbers Rust
//          kept, keyed by the ids the pane's cards carry — and turns each fact
//          into cues through the §4.3 table, written here as data. It finds no
//          maximum and computes no threshold; every number it places came out
//          of Rust, and every cue it emits names the fact it came from.
//
//          THE INDEX IS THE MECHANISM AND THE LABEL IS THE CHECK (IO-1). A
//          fact's index is a position in the series as the chart supplied it,
//          gaps counted — the snapshot's own index. Before a cue exists, the
//          label at that index must be the fact's label and, where the fact
//          carries the datum's value, the value must match. A cue that fails is
//          RETURNED AS DROPPED with a reason, never guessed: the chart of
//          Jan..Dec over two years, the chart whose data changed under a cached
//          bundle, the smoothed peak whose value is not any bar's value.
//
//          POLARITY COMES FROM PROVENANCE, NEVER FROM THE NUMBER. A bound
//          series' facts carry `direction` (`series_strategy.rs`). A "high"
//          tone (the best month, a rising trend) is good under higherIsBetter
//          and bad under lowerIsBetter; a "low" tone is the reverse; a withheld
//          or absent direction is neutral. Red is never inferred from a fall.
//
//          THE DESCRIPTION IS THE FACT KIND PLUS THE SUBJECT. "Highest Revenue",
//          "Level shift in Cost", "Sales and Cost cross". Tier 0, a template
//          over the same numbers; the narrator's full sentence rides along as
//          `label` for the tooltip.

import type { ChartCue, ChartCueAnchor, ChartCuePolarity } from "./chartCues";
import type { CellCue } from "./cellCues";
import type { ChartSeriesSnapshot } from "./chartData";
import type { Insight, InsightBundle } from "./insightsService";

// ============================================================================
// The facts document, as Rust writes it
// ============================================================================

/** One entry of `factsJson.facts` (`build_facts_json`, core/insights/src/lib.rs). */
export interface FactRecord {
  id: string;
  score: number;
  evidenceA1: string[];
  kind: { fact: string } & Record<string, unknown>;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

function isIndex(v: unknown): v is number {
  return typeof v === "number" && Number.isInteger(v) && v >= 0;
}

/** The facts document: the facts plus the sheet row behind each dataset row. */
export interface FactsDocument {
  facts: FactRecord[];
  /** `rowOrigins[i]` is the SHEET ROW of dataset row `i`; empty for a chart's series. */
  rowOrigins: number[];
  /** The sheet the dataset was read from, by name; null for a chart's series. */
  sourceSheet: string | null;
}

const EMPTY_DOCUMENT: FactsDocument = { facts: [], rowOrigins: [], sourceSheet: null };

/** The whole document; empty for anything malformed. */
export function parseFactsDocument(factsJson: string): FactsDocument {
  let doc: unknown;
  try {
    doc = JSON.parse(factsJson);
  } catch {
    return { ...EMPTY_DOCUMENT };
  }
  if (!isRecord(doc) || !Array.isArray(doc.facts)) return { ...EMPTY_DOCUMENT };
  const sourceSheet = isRecord(doc.source) && typeof doc.source.sheet === "string" && doc.source.sheet !== "" ? doc.source.sheet : null;
  const facts: FactRecord[] = [];
  for (const raw of doc.facts as unknown[]) {
    if (!isRecord(raw) || typeof raw.id !== "string" || !isRecord(raw.kind)) continue;
    if (typeof raw.kind.fact !== "string") continue;
    facts.push({
      id: raw.id,
      score: typeof raw.score === "number" ? raw.score : 0,
      evidenceA1: Array.isArray(raw.evidenceA1) ? (raw.evidenceA1 as string[]) : [],
      kind: raw.kind as FactRecord["kind"],
    });
  }
  const rowOrigins = Array.isArray(doc.rowOrigins) ? (doc.rowOrigins as unknown[]).filter(isIndex) : [];
  return { facts, rowOrigins, sourceSheet };
}

/** The facts in a bundle's document, in Rust's kept (ranked) order; [] for anything malformed. */
export function parseFacts(factsJson: string): FactRecord[] {
  return parseFactsDocument(factsJson).facts;
}

/** A subject's name: `{ type: "column" | "measure", name, … }`. */
function subjectName(v: unknown): string | null {
  return isRecord(v) && typeof v.name === "string" ? v.name : null;
}

// ============================================================================
// Polarity
// ============================================================================

/** What a fact's tone means before a direction is known. */
export type CueTone = "high" | "low" | "attention" | "neutral";

/** The declared direction that reached this fact, or null. */
export function directionOf(insight: Pick<Insight, "provenance"> | undefined): string | null {
  return insight?.provenance.find((p) => p.attribute === "direction")?.value ?? null;
}

/**
 * The honesty rule from model.rs, restated for colour: only `higherIsBetter`
 * and `lowerIsBetter` colour anything; `withheld: …`, `targetBand`, `neutral`
 * and no direction at all are neutral.
 */
export function polarityFor(tone: CueTone, direction: string | null): ChartCuePolarity {
  if (tone === "attention") return "attention";
  if (tone === "neutral") return "neutral";
  if (direction === "higherIsBetter") return tone === "high" ? "good" : "bad";
  if (direction === "lowerIsBetter") return tone === "high" ? "bad" : "good";
  return "neutral";
}

// ============================================================================
// The table (§4.3), as data
// ============================================================================

/** What a rule asks for before validation: an anchor plus what to check at it. */
interface CueDraft {
  kind: ChartCue["kind"];
  tone: CueTone;
  anchor: ChartCueAnchor;
  description: string;
  /** The label the fact named at this datum, if it named one. */
  expectLabel?: string;
  /** The datum's value the fact carries, if it carries the DATUM's value. */
  expectValue?: number;
}

export type CueDropReason =
  | "series-not-in-snapshot"
  | "index-out-of-range"
  | "label-mismatch"
  | "value-mismatch"
  | "no-single-row"
  | "no-position-in-fact"
  | "malformed-fact";

export interface CueDrop {
  factId: string;
  reason: CueDropReason;
}

/** Where the drafts of one fact end up. `null` in a slot means "this fact points at nothing on a chart". */
type Rule = (kind: FactRecord["kind"], snapshot: ChartSeriesSnapshot) => CueDraft[] | CueDropReason | null;

function datum(series: string, categoryIndex: number, categoryLabel: string): ChartCueAnchor {
  return { type: "datum", series, categoryIndex, categoryLabel };
}

/** The last supplied index whose value is a number, for "at the last point". */
function lastPointOf(snapshot: ChartSeriesSnapshot, series: string): number | null {
  const s = snapshot.series.find((x) => x.name === series);
  if (!s) return null;
  for (let i = s.values.length - 1; i >= 0; i--) {
    if (typeof s.values[i] === "number") return i;
  }
  return null;
}

const pct = (v: number): string => `${Math.round(Math.abs(v) * 100)}%`;

/**
 * The §4.3 table. Kinds absent here point at nothing on a chart (summaries,
 * correlation, seasonality, shape) or belong to the sheet target (IO-4: the
 * hygiene kinds), and produce neither a cue nor a drop.
 */
const RULES: Readonly<Record<string, Rule>> = {
  extremes: (k) => {
    const s = subjectName(k.subject);
    if (
      s === null ||
      typeof k.bestLabel !== "string" || !isIndex(k.bestIndex) || typeof k.best !== "number" ||
      typeof k.worstLabel !== "string" || !isIndex(k.worstIndex) || typeof k.worst !== "number"
    ) return "malformed-fact";
    return [
      { kind: "ring", tone: "high", anchor: datum(s, k.bestIndex, k.bestLabel), description: `Highest ${s}`, expectLabel: k.bestLabel, expectValue: k.best },
      { kind: "ring", tone: "low", anchor: datum(s, k.worstIndex, k.worstLabel), description: `Lowest ${s}`, expectLabel: k.worstLabel, expectValue: k.worst },
    ];
  },

  smoothedPeak: (k) => {
    const s = subjectName(k.subject);
    if (
      s === null ||
      typeof k.peakLabel !== "string" || !isIndex(k.peakIndex) ||
      typeof k.troughLabel !== "string" || !isIndex(k.troughIndex)
    ) return "malformed-fact";
    // `peak`/`trough` are SMOOTHED values, not any bar's own, so only the label is checked.
    return [
      { kind: "ring", tone: "high", anchor: datum(s, k.peakIndex, k.peakLabel), description: `Peak of ${s} (smoothed)`, expectLabel: k.peakLabel },
      { kind: "ring", tone: "low", anchor: datum(s, k.troughIndex, k.troughLabel), description: `Trough of ${s} (smoothed)`, expectLabel: k.troughLabel },
    ];
  },

  outliers: (k) => {
    const s = subjectName(k.subject);
    if (s === null || !Array.isArray(k.points)) return "malformed-fact";
    const drafts: CueDraft[] = [];
    for (const p of k.points as unknown[]) {
      if (!isRecord(p) || !isIndex(p.index) || typeof p.label !== "string" || typeof p.value !== "number") return "malformed-fact";
      drafts.push({ kind: "ring", tone: "attention", anchor: datum(s, p.index, p.label), description: `Outlier in ${s}`, expectLabel: p.label, expectValue: p.value });
    }
    // The fences the points are beyond: a rule on the value axis at each, so
    // the ring is explainable from the chart alone. Drawn only where the
    // painter has a value scale (a cartesian mark); a pie has no fence to draw.
    if (typeof k.highFence === "number" && Number.isFinite(k.highFence)) {
      drafts.push({ kind: "rule", tone: "attention", anchor: { type: "level", series: s, value: k.highFence }, description: `Outlier fence for ${s}` });
    }
    if (typeof k.lowFence === "number" && Number.isFinite(k.lowFence)) {
      drafts.push({ kind: "rule", tone: "attention", anchor: { type: "level", series: s, value: k.lowFence }, description: `Outlier fence for ${s}` });
    }
    return drafts;
  },

  changePoint: (k, snapshot) => {
    const s = subjectName(k.subject);
    if (s === null || typeof k.atLabel !== "string" || !isIndex(k.atIndex)) return "malformed-fact";
    const last = snapshot.categories.length - 1;
    const description = `Level shift in ${s}`;
    const drafts: CueDraft[] = [
      { kind: "ring", tone: "attention", anchor: datum(s, k.atIndex, k.atLabel), description, expectLabel: k.atLabel },
    ];
    if (k.atIndex <= last) {
      drafts.push({ kind: "band", tone: "attention", anchor: { type: "span", series: s, from: k.atIndex, to: last }, description });
    }
    // The two levels the shift is between, as rules on the value axis.
    if (typeof k.beforeMean === "number" && Number.isFinite(k.beforeMean)) {
      drafts.push({ kind: "rule", tone: "attention", anchor: { type: "level", series: s, value: k.beforeMean }, description: `Mean before ${k.atLabel}` });
    }
    if (typeof k.afterMean === "number" && Number.isFinite(k.afterMean)) {
      drafts.push({ kind: "rule", tone: "attention", anchor: { type: "level", series: s, value: k.afterMean }, description: `Mean from ${k.atLabel}` });
    }
    return drafts;
  },

  crossover: (k) => {
    const a = subjectName(k.a);
    const b = subjectName(k.b);
    if (a === null || b === null || typeof k.atLabel !== "string" || !isIndex(k.atIndex)) return "malformed-fact";
    const description = `${a} and ${b} cross`;
    return [
      { kind: "ring", tone: "neutral", anchor: datum(a, k.atIndex, k.atLabel), description, expectLabel: k.atLabel },
      { kind: "ring", tone: "neutral", anchor: datum(b, k.atIndex, k.atLabel), description, expectLabel: k.atLabel },
    ];
  },

  leader: (k) => {
    const s = subjectName(k.subject);
    if (s === null) return "malformed-fact";
    return [{ kind: "emphasis", tone: "high", anchor: { type: "series", series: s }, description: `Largest series: ${s}` }];
  },

  dominance: (k) => {
    if (typeof k.value !== "string" || typeof k.topCategory !== "string") return "malformed-fact";
    // A top category summed across several rows has no single row to point at.
    if (k.topIndex === null || k.topIndex === undefined) return "no-single-row";
    if (!isIndex(k.topIndex)) return "malformed-fact";
    return [{ kind: "emphasis", tone: "high", anchor: datum(k.value, k.topIndex, k.topCategory), description: `${k.topCategory} dominates ${k.value}`, expectLabel: k.topCategory }];
  },

  trend: (k, snapshot) => {
    const s = subjectName(k.subject);
    if (s === null || typeof k.last !== "number" || typeof k.direction !== "string") return "malformed-fact";
    const at = lastPointOf(snapshot, s);
    if (at === null) return "series-not-in-snapshot";
    const tone: CueTone = k.direction === "rising" ? "high" : k.direction === "falling" ? "low" : "neutral";
    const word = k.direction === "rising" ? "rising" : k.direction === "falling" ? "falling" : "flat";
    return [{ kind: "callout", tone, anchor: datum(s, at, snapshot.categories[at]), description: `${s} ${word}`, expectValue: k.last }];
  },

  change: (k, snapshot) => {
    const s = subjectName(k.subject);
    if (s === null || typeof k.lastLabel !== "string" || typeof k.last !== "number" || typeof k.pct !== "number") return "malformed-fact";
    const at = lastPointOf(snapshot, s);
    if (at === null) return "series-not-in-snapshot";
    const tone: CueTone = k.pct > 0 ? "high" : k.pct < 0 ? "low" : "neutral";
    const word = k.pct > 0 ? `up ${pct(k.pct)}` : k.pct < 0 ? `down ${pct(k.pct)}` : "unchanged";
    return [{ kind: "callout", tone, anchor: datum(s, at, k.lastLabel), description: `${s} ${word}`, expectLabel: k.lastLabel, expectValue: k.last }];
  },

  // Pareto names its top-k members (`topCategories`, largest first) and, per
  // member, the supplied row when there is exactly one (`topIndices`, the
  // Dominance rule). Each placeable member is emphasised; a member summed
  // across several rows has no bar to point at. A fact whose no member is
  // placeable is `no-single-row`, never a band over "the top two".
  pareto: (k) => {
    if (typeof k.value !== "string" || typeof k.category !== "string" || !Array.isArray(k.topCategories) || !Array.isArray(k.topIndices)) return "malformed-fact";
    const names = k.topCategories as unknown[];
    const indices = k.topIndices as unknown[];
    if (names.length !== indices.length || names.some((n) => typeof n !== "string")) return "malformed-fact";
    const drafts: CueDraft[] = [];
    indices.forEach((idx, i) => {
      if (idx === null || idx === undefined) return;
      if (!isIndex(idx)) return;
      const name = names[i] as string;
      drafts.push({ kind: "emphasis", tone: "high", anchor: datum(k.value as string, idx, name), description: `${name}: top ${names.length} of ${k.category}`, expectLabel: name });
    });
    return drafts.length > 0 ? drafts : "no-single-row";
  },
};

/** The fact kinds this table turns into chart cues. Exported for the tests. */
export const CHART_CUE_FACT_KINDS: readonly string[] = Object.freeze(Object.keys(RULES));

// ============================================================================
// Validation and assembly
// ============================================================================

function validate(draft: CueDraft, snapshot: ChartSeriesSnapshot): CueDropReason | null {
  const a = draft.anchor;
  const seriesOf = (name: string) => snapshot.series.find((s) => s.name === name);
  switch (a.type) {
    case "datum": {
      const s = seriesOf(a.series);
      if (!s) return "series-not-in-snapshot";
      if (a.categoryIndex >= snapshot.categories.length) return "index-out-of-range";
      if (draft.expectLabel !== undefined && snapshot.categories[a.categoryIndex] !== draft.expectLabel) return "label-mismatch";
      if (draft.expectValue !== undefined && s.values[a.categoryIndex] !== draft.expectValue) return "value-mismatch";
      return null;
    }
    case "series":
      return seriesOf(a.series) ? null : "series-not-in-snapshot";
    case "span": {
      if (a.series !== undefined && !seriesOf(a.series)) return "series-not-in-snapshot";
      if (a.from > a.to || a.to >= snapshot.categories.length) return "index-out-of-range";
      return null;
    }
    case "level":
      return a.series !== undefined && !seriesOf(a.series) ? "series-not-in-snapshot" : null;
  }
}

export interface ChartCueSet {
  /** In the bundle's rank order; the cues of one fact stay adjacent. */
  cues: ChartCue[];
  dropped: CueDrop[];
}

/**
 * Every cue the bundle justifies on this chart, validated, in rank order.
 *
 * Deterministic: the same bundle and snapshot always yield the same list.
 * A fact whose every datum failed validation appears once in `dropped` with
 * the first reason met; a fact of a kind that points at nothing on a chart
 * appears in neither list.
 */
export function cuesForChart(bundle: InsightBundle, snapshot: ChartSeriesSnapshot): ChartCueSet {
  const cues: ChartCue[] = [];
  const dropped: CueDrop[] = [];
  const insightsById = new Map(bundle.insights.map((i) => [i.id, i] as const));

  for (const fact of parseFacts(bundle.factsJson)) {
    const rule = RULES[fact.kind.fact];
    if (!rule) continue;
    const drafts = rule(fact.kind, snapshot);
    if (drafts === null) continue;
    if (typeof drafts === "string") {
      dropped.push({ factId: fact.id, reason: drafts });
      continue;
    }
    const insight = insightsById.get(fact.id);
    const direction = directionOf(insight);
    let firstFailure: CueDropReason | null = null;
    let placed = 0;
    for (const [ordinal, draft] of drafts.entries()) {
      const failure = validate(draft, snapshot);
      if (failure) {
        firstFailure ??= failure;
        continue;
      }
      cues.push({
        // The DRAFT's ordinal, not the placed count: a rule emits its drafts in
        // a fixed order (extremes = highest, then lowest), so cue `…#1` is the
        // same point of interest whether or not `…#0` survived validation. A
        // placed counter would renumber the survivor and move a comment.
        cueId: `${fact.id}#${ordinal}`,
        factId: fact.id,
        kind: draft.kind,
        polarity: polarityFor(draft.tone, direction),
        anchor: draft.anchor,
        description: draft.description,
        ...(insight && insight.text ? { label: insight.text } : {}),
      });
      placed++;
    }
    if (placed === 0 && firstFailure) dropped.push({ factId: fact.id, reason: firstFailure });
  }

  return { cues, dropped };
}

// ============================================================================
// Cells: the sheet and pivot targets (IO-4)
// ============================================================================

/** A column subject as Rust writes it: `{ type: "column", name, sheet, range }`. */
function columnOf(v: unknown): { name: string; sheet: string; startCol: number } | null {
  if (!isRecord(v) || v.type !== "column" || typeof v.name !== "string" || typeof v.sheet !== "string") return null;
  const range = v.range;
  if (!isRecord(range) || !isIndex(range.startCol)) return null;
  return { name: v.name, sheet: v.sheet, startCol: range.startCol };
}

export type CellCueDropReason = "sheet-not-open" | "row-not-in-dataset" | "no-position-in-fact" | "malformed-fact";

export interface CellCueDrop {
  factId: string;
  reason: CellCueDropReason;
}

export interface CellCueSet {
  cues: CellCue[];
  dropped: CellCueDrop[];
}

interface CellDraft {
  tone: CueTone;
  /** A dataset row (index into rowOrigins), or an absolute sheet row for kinds that carry one. */
  row: { dataset: number } | { sheet: number };
  col: number;
  sheet: string;
  description: string;
}

type CellRule = (kind: FactRecord["kind"]) => CellDraft[] | CellCueDropReason | null;

/**
 * The §4.3 table for cells: the kinds whose index names a dataset row become
 * a cue on the cell at (that row's sheet row, the subject column). Summaries,
 * correlation, seasonality point at nothing; `dominance` names a category
 * value in a column the facts document does not locate; `errors` and
 * `mixedTypes` name a column, not a row (a column-wide cue is a later kind).
 */
const CELL_RULES: Readonly<Record<string, CellRule>> = {
  extremes: (k) => {
    const c = columnOf(k.subject);
    if (!c || !isIndex(k.bestIndex) || !isIndex(k.worstIndex)) return "malformed-fact";
    return [
      { tone: "high", row: { dataset: k.bestIndex }, col: c.startCol, sheet: c.sheet, description: `Highest ${c.name}` },
      { tone: "low", row: { dataset: k.worstIndex }, col: c.startCol, sheet: c.sheet, description: `Lowest ${c.name}` },
    ];
  },
  smoothedPeak: (k) => {
    const c = columnOf(k.subject);
    if (!c || !isIndex(k.peakIndex) || !isIndex(k.troughIndex)) return "malformed-fact";
    return [
      { tone: "high", row: { dataset: k.peakIndex }, col: c.startCol, sheet: c.sheet, description: `Peak of ${c.name} (smoothed)` },
      { tone: "low", row: { dataset: k.troughIndex }, col: c.startCol, sheet: c.sheet, description: `Trough of ${c.name} (smoothed)` },
    ];
  },
  outliers: (k) => {
    const c = columnOf(k.subject);
    if (!c || !Array.isArray(k.points)) return "malformed-fact";
    const out: CellDraft[] = [];
    for (const p of k.points as unknown[]) {
      if (!isRecord(p) || !isIndex(p.index)) return "malformed-fact";
      out.push({ tone: "attention", row: { dataset: p.index }, col: c.startCol, sheet: c.sheet, description: `Outlier in ${c.name}` });
    }
    return out;
  },
  changePoint: (k) => {
    const c = columnOf(k.subject);
    if (!c || !isIndex(k.atIndex)) return "malformed-fact";
    return [{ tone: "attention", row: { dataset: k.atIndex }, col: c.startCol, sheet: c.sheet, description: `Level shift in ${c.name}` }];
  },
  crossover: (k) => {
    const a = columnOf(k.a);
    const b = columnOf(k.b);
    if (!a || !b || !isIndex(k.atIndex)) return "malformed-fact";
    const description = `${a.name} and ${b.name} cross`;
    return [
      { tone: "neutral", row: { dataset: k.atIndex }, col: a.startCol, sheet: a.sheet, description },
      { tone: "neutral", row: { dataset: k.atIndex }, col: b.startCol, sheet: b.sheet, description },
    ];
  },
  duplicates: (k) => {
    // `exampleRow` is a SHEET row already (hygiene.rs: "must be the sheet row").
    if (!isIndex(k.exampleRow)) return "malformed-fact";
    return null; // needs the dataset's first column; handled by the caller with the source range
  },
  pareto: () => "no-position-in-fact",
  dominance: () => "no-position-in-fact",
};

/** The fact kinds this table turns into cell cues. Exported for the tests. */
export const CELL_CUE_FACT_KINDS: readonly string[] = Object.freeze(["extremes", "smoothedPeak", "outliers", "changePoint", "crossover"]);

/**
 * Every cell cue the bundle justifies, in rank order.
 *
 * `sheetIndexOf` turns a sheet NAME (what the facts carry) into the open
 * workbook's index; a name that resolves to nothing drops the fact with
 * `sheet-not-open` rather than marking a cell on whatever sheet is in front.
 * A dataset row past `rowOrigins` — the bundle predates a change that shrank
 * the range — drops with `row-not-in-dataset`.
 */
export function cuesForSheet(
  bundle: InsightBundle,
  sheetIndexOf: (sheetName: string) => number | null,
): CellCueSet {
  const cues: CellCue[] = [];
  const dropped: CellCueDrop[] = [];
  const { facts, rowOrigins } = parseFactsDocument(bundle.factsJson);
  const insightsById = new Map(bundle.insights.map((i) => [i.id, i] as const));

  for (const fact of facts) {
    const rule = CELL_RULES[fact.kind.fact];
    if (!rule) continue;
    const drafts = rule(fact.kind);
    if (drafts === null) continue;
    if (typeof drafts === "string") {
      dropped.push({ factId: fact.id, reason: drafts });
      continue;
    }
    const insight = insightsById.get(fact.id);
    const direction = directionOf(insight);
    let firstFailure: CellCueDropReason | null = null;
    let placed = 0;
    for (const d of drafts) {
      const sheetIndex = sheetIndexOf(d.sheet);
      if (sheetIndex === null) {
        firstFailure ??= "sheet-not-open";
        continue;
      }
      let row: number;
      if ("sheet" in d.row) {
        row = d.row.sheet;
      } else {
        const origin = rowOrigins[d.row.dataset];
        if (origin === undefined) {
          firstFailure ??= "row-not-in-dataset";
          continue;
        }
        row = origin;
      }
      cues.push({
        factId: fact.id,
        polarity: polarityFor(d.tone, direction),
        description: d.description,
        ...(insight && insight.text ? { label: insight.text } : {}),
        sheetIndex,
        row,
        col: d.col,
      });
      placed++;
    }
    if (placed === 0 && firstFailure) dropped.push({ factId: fact.id, reason: firstFailure });
  }
  return { cues, dropped };
}

/**
 * The stepper's order: one entry per FACT, in rank order, carrying that fact's
 * cues together — stepping shows a point of interest, and a level shift is one
 * point of interest drawn as a ring and a band.
 */
export function stepsOf(cues: readonly ChartCue[]): Array<{ factId: string; description: string; cues: ChartCue[] }> {
  const steps: Array<{ factId: string; description: string; cues: ChartCue[] }> = [];
  for (const cue of cues) {
    const last = steps[steps.length - 1];
    if (last && last.factId === cue.factId) {
      last.cues.push(cue);
    } else {
      steps.push({ factId: cue.factId, description: cue.description ?? "", cues: [cue] });
    }
  }
  return steps;
}
