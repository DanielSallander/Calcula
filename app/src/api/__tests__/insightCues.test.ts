//! FILENAME: app/src/api/__tests__/insightCues.test.ts
// PURPOSE: IO-2's contract: every fact kind in Rust's own pinned fixture maps
//          to the cue kinds §4.3 says; no cue ever anchors to a datum the fact
//          did not name (the harmful-cue gate); polarity follows the declared
//          direction and is neutral when it is withheld; every refusal has a
//          reason; and the whole thing is deterministic.
// CONTEXT: The facts come from `core/insights/fixtures/every-fact-kind-facts.json`,
//          written by a Rust test from `every_fact_kind_fixture()` and pinned
//          there, so a renamed field fails in Rust first and here second — never
//          silently in a running app. The ORACLE below (`namedDatums`) reads the
//          facts with its own hands rather than through the module under test,
//          which is what makes the gate a gate.

import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import {
  cuesForChart,
  parseFacts,
  polarityFor,
  stepsOf,
  CHART_CUE_FACT_KINDS,
  type FactRecord,
} from "../insightCues";
import type { ChartCue } from "../chartCues";
import type { ChartSeriesSnapshot } from "../chartData";
import type { InsightBundle, InsightProvenance } from "../insightsService";

const FIXTURE = path.resolve(__dirname, "../../../../core/insights/fixtures/every-fact-kind-facts.json");
const factsJson = fs.readFileSync(FIXTURE, "utf8");
const FACTS = parseFacts(factsJson);

// ============================================================================
// The oracle: what each fact NAMES, read independently of the rules
// ============================================================================

interface Named {
  series: string;
  /** "last" = the series' last point, which the fact does not index explicitly. */
  index: number | "last";
  label?: string;
  value?: number;
}

const name = (s: unknown): string => (s as { name: string }).name;

function namedDatums(k: FactRecord["kind"]): Named[] {
  const K = k as Record<string, any>;
  switch (k.fact) {
    case "extremes":
      return [
        { series: name(K.subject), index: K.bestIndex, label: K.bestLabel, value: K.best },
        { series: name(K.subject), index: K.worstIndex, label: K.worstLabel, value: K.worst },
      ];
    case "smoothedPeak":
      return [
        { series: name(K.subject), index: K.peakIndex, label: K.peakLabel },
        { series: name(K.subject), index: K.troughIndex, label: K.troughLabel },
      ];
    case "outliers":
      return (K.points as Array<{ index: number; label: string; value: number }>).map((p) => ({
        series: name(K.subject), index: p.index, label: p.label, value: p.value,
      }));
    case "changePoint":
      return [{ series: name(K.subject), index: K.atIndex, label: K.atLabel }];
    case "crossover":
      return [
        { series: name(K.a), index: K.atIndex, label: K.atLabel },
        { series: name(K.b), index: K.atIndex, label: K.atLabel },
      ];
    case "dominance":
      return K.topIndex === null ? [] : [{ series: K.value, index: K.topIndex, label: K.topCategory }];
    case "pareto":
      return (K.topIndices as Array<number | null>).flatMap((idx, i) => (idx === null ? [] : [{ series: K.value, index: idx, label: K.topCategories[i] }]));
    case "trend":
      return [{ series: name(K.subject), index: "last", value: K.last }];
    case "change":
      return [{ series: name(K.subject), index: "last", label: K.lastLabel, value: K.last }];
    default:
      return [];
  }
}

function subjectsOf(k: FactRecord["kind"]): string[] {
  const K = k as Record<string, any>;
  const out: string[] = [];
  for (const key of ["subject", "a", "b"]) if (K[key] && typeof K[key].name === "string") out.push(K[key].name);
  if (k.fact === "dominance" || k.fact === "pareto") out.push(K.value);
  return out;
}

/** The cue kinds §4.3 promises per fact kind, in order. */
const EXPECTED: Record<string, (k: FactRecord["kind"]) => string[]> = {
  extremes: () => ["ring", "ring"],
  smoothedPeak: () => ["ring", "ring"],
  // Outliers: a ring per point, then a rule on the value axis at each fence.
  outliers: (k) => [...(k as any).points.map(() => "ring"), "rule", "rule"],
  // A level shift: the ring, the band from it, and the two means as rules.
  changePoint: () => ["ring", "band", "rule", "rule"],
  crossover: () => ["ring", "ring"],
  leader: () => ["emphasis"],
  dominance: (k) => ((k as any).topIndex === null ? [] : ["emphasis"]),
  // Pareto: an emphasis per named member that sits in exactly one row.
  pareto: (k) => (k as any).topIndices.filter((i: number | null) => i !== null).map(() => "emphasis"),
  trend: () => ["callout"],
  change: () => ["callout"],
};

// ============================================================================
// A snapshot consistent with one fact, built from what the fact names
// ============================================================================

const N = 12;

function snapshotFor(fact: FactRecord): ChartSeriesSnapshot {
  const named = namedDatums(fact.kind);
  const maxIndex = Math.max(N - 1, ...named.map((d) => (d.index === "last" ? N - 1 : d.index)));
  const n = maxIndex + 1;
  const categories = Array.from({ length: n }, (_, i) => `C${i}`);
  const series = new Map<string, (number | null)[]>();
  for (const s of subjectsOf(fact.kind)) series.set(s, Array.from({ length: n }, (_, i) => i + 1));
  for (const d of named) {
    const at = d.index === "last" ? n - 1 : d.index;
    if (d.label !== undefined) categories[at] = d.label;
    if (!series.has(d.series)) series.set(d.series, Array.from({ length: n }, (_, i) => i + 1));
    if (d.value !== undefined) series.get(d.series)![at] = d.value;
  }
  return {
    chartId: "chart-1", name: "Chart 1", title: null, sheetIndex: 0, mark: "bar",
    categories, categoryKind: "nominal",
    series: [...series].map(([nm, values]) => ({ name: nm, values })),
    truncated: false,
  };
}

function bundleOf(facts: FactRecord[], provenance: InsightProvenance[] = [], text = ""): InsightBundle {
  return {
    source: "range",
    insights: facts.map((f) => ({ id: f.id, kind: f.kind.fact, score: f.score, text, evidence: [], provenance })),
    dropped: 0,
    markdown: "",
    factsJson: JSON.stringify({ engineVersion: 1, localeId: "en-US", source: {}, facts }),
    notes: [],
  };
}

const direction = (value: string): InsightProvenance[] => [{ attribute: "direction", value, source: "strategy" }];
const factOf = (kind: string): FactRecord => {
  const f = FACTS.find((x) => x.kind.fact === kind);
  if (!f) throw new Error(`fixture has no ${kind}`);
  return f;
};

// ============================================================================
// The fixture itself
// ============================================================================

describe("the pinned facts fixture", () => {
  it("carries one of every fact kind the cue table names, and parses", () => {
    expect(FACTS.length).toBeGreaterThanOrEqual(20);
    const kinds = new Set(FACTS.map((f) => f.kind.fact));
    for (const k of CHART_CUE_FACT_KINDS) expect(kinds.has(k), k).toBe(true);
    expect(kinds.has("pareto")).toBe(true);
  });
});

// ============================================================================
// The table
// ============================================================================

describe("cuesForChart maps every fact kind to the cue kinds §4.3 names", () => {
  for (const fact of FACTS) {
    it(`${fact.kind.fact} → [${(EXPECTED[fact.kind.fact]?.(fact.kind) ?? []).join(", ")}]`, () => {
      const { cues, dropped } = cuesForChart(bundleOf([fact]), snapshotFor(fact));
      expect(cues.map((c) => c.kind)).toEqual(EXPECTED[fact.kind.fact]?.(fact.kind) ?? []);
      expect(dropped).toEqual([]);
      if (fact.kind.fact === "pareto") {
        // The fixture plants one placeable member (Gadgets, row 3) and one
        // summed across rows (Widgets, null): the first is emphasised on ITS
        // bar, the second is not guessed at.
        expect(cues.map((c) => c.anchor)).toEqual([{ type: "datum", series: "Revenue", categoryIndex: 3, categoryLabel: "Gadgets" }]);
        expect(cues[0].description).toBe("Gadgets: top 2 of Product");
      }
      for (const c of cues) {
        expect(c.factId).toBe(fact.id);
        expect(c.description).toBeTruthy();
      }
    });
  }
});

// ============================================================================
// The harmful-cue gate
// ============================================================================

describe("the harmful-cue gate: no cue anchors to a datum the fact did not name", () => {
  for (const fact of FACTS) {
    it(`${fact.kind.fact}`, () => {
      const snapshot = snapshotFor(fact);
      const named = namedDatums(fact.kind).map((d) => ({ ...d, index: d.index === "last" ? snapshot.categories.length - 1 : d.index }));
      const subjects = subjectsOf(fact.kind);
      const { cues } = cuesForChart(bundleOf([fact]), snapshot);
      for (const c of cues) {
        const a = c.anchor;
        if (a.type === "datum") {
          expect(named.some((d) => d.series === a.series && d.index === a.categoryIndex), JSON.stringify(a)).toBe(true);
          expect(snapshot.categories[a.categoryIndex]).toBe(a.categoryLabel);
        } else if (a.type === "series") {
          expect(subjects).toContain(a.series);
        } else if (a.type === "span") {
          expect(named.some((d) => d.index === a.from), JSON.stringify(a)).toBe(true);
          if (a.series !== undefined) expect(subjects).toContain(a.series);
          expect(a.to).toBeLessThan(snapshot.categories.length);
        } else {
          // A level is a VALUE the fact carries (a fence, a mean) on a subject
          // series; it names no datum, so the gate checks the series and that
          // the value is one of the fact's own numbers.
          const K = fact.kind as Record<string, unknown>;
          const own = [K.lowFence, K.highFence, K.beforeMean, K.afterMean].filter((v) => typeof v === "number");
          expect(a.series !== undefined && subjects.includes(a.series), JSON.stringify(a)).toBe(true);
          expect(own, JSON.stringify(a)).toContain(a.value);
        }
      }
    });
  }
});

// ============================================================================
// Polarity
// ============================================================================

describe("polarity follows the declared direction and is neutral when withheld", () => {
  it("polarityFor: the table", () => {
    expect(polarityFor("high", "higherIsBetter")).toBe("good");
    expect(polarityFor("low", "higherIsBetter")).toBe("bad");
    expect(polarityFor("high", "lowerIsBetter")).toBe("bad");
    expect(polarityFor("low", "lowerIsBetter")).toBe("good");
    for (const d of ["withheld: rule r1 covers only some members", "targetBand", "neutral", null]) {
      expect(polarityFor("high", d), String(d)).toBe("neutral");
      expect(polarityFor("low", d), String(d)).toBe("neutral");
    }
    expect(polarityFor("attention", "higherIsBetter")).toBe("attention");
    expect(polarityFor("neutral", "lowerIsBetter")).toBe("neutral");
  });

  it("extremes: best is bad and worst is good on a lowerIsBetter measure", () => {
    const f = factOf("extremes");
    const { cues } = cuesForChart(bundleOf([f], direction("lowerIsBetter")), snapshotFor(f));
    expect(cues.map((c) => c.polarity)).toEqual(["bad", "good"]);
    const up = cuesForChart(bundleOf([f], direction("higherIsBetter")), snapshotFor(f));
    expect(up.cues.map((c) => c.polarity)).toEqual(["good", "bad"]);
  });

  it("a withheld direction makes every colourable cue neutral", () => {
    for (const kind of ["extremes", "smoothedPeak", "leader", "dominance", "trend", "change"]) {
      const f = factOf(kind);
      const { cues } = cuesForChart(bundleOf([f], direction("withheld: rule r1 covers only some members")), snapshotFor(f));
      expect(cues.length, kind).toBeGreaterThan(0);
      for (const c of cues) expect(c.polarity, kind).toBe("neutral");
    }
  });

  it("outliers and level shifts are attention regardless of direction; a crossing is neutral", () => {
    for (const [kind, want] of [["outliers", "attention"], ["changePoint", "attention"], ["crossover", "neutral"]] as const) {
      const f = factOf(kind);
      const { cues } = cuesForChart(bundleOf([f], direction("higherIsBetter")), snapshotFor(f));
      for (const c of cues) expect(c.polarity, kind).toBe(want);
    }
  });

  it("a rising trend and a positive change are good under higherIsBetter and bad under lowerIsBetter", () => {
    const t = factOf("trend");
    expect((t.kind as any).direction).toBe("rising");
    expect(cuesForChart(bundleOf([t], direction("higherIsBetter")), snapshotFor(t)).cues[0].polarity).toBe("good");
    expect(cuesForChart(bundleOf([t], direction("lowerIsBetter")), snapshotFor(t)).cues[0].polarity).toBe("bad");
    const c = factOf("change");
    expect((c.kind as any).pct).toBeGreaterThan(0);
    expect(cuesForChart(bundleOf([c], direction("lowerIsBetter")), snapshotFor(c)).cues[0].polarity).toBe("bad");
  });
});

// ============================================================================
// Refusals
// ============================================================================

describe("every refusal has a reason and places nothing", () => {
  it("label mismatch: the data changed under the bundle", () => {
    const f = factOf("extremes");
    const s = snapshotFor(f);
    s.categories[(f.kind as any).bestIndex] = "Q9";
    s.categories[(f.kind as any).worstIndex] = "Q8";
    const r = cuesForChart(bundleOf([f]), s);
    expect(r.cues).toEqual([]);
    expect(r.dropped).toEqual([{ factId: f.id, reason: "label-mismatch" }]);
  });

  it("value mismatch on a fact that carries the datum's value; a smoothed peak carries none and is not checked", () => {
    const f = factOf("extremes");
    const s = snapshotFor(f);
    const series = s.series.find((x) => x.name === name((f.kind as any).subject))!;
    (series.values as (number | null)[])[(f.kind as any).bestIndex] = 123456;
    const r = cuesForChart(bundleOf([f]), s);
    expect(r.cues.map((c) => c.description)).toEqual([`Lowest ${series.name}`]);

    const p = factOf("smoothedPeak");
    const ps = snapshotFor(p);
    const pseries = ps.series.find((x) => x.name === name((p.kind as any).subject))!;
    (pseries.values as (number | null)[])[(p.kind as any).peakIndex] = 999;
    expect(cuesForChart(bundleOf([p]), ps).cues).toHaveLength(2);
  });

  it("index out of range and a missing series", () => {
    const f = factOf("outliers");
    const s = snapshotFor(f);
    const short = { ...s, categories: s.categories.slice(0, 2), series: s.series.map((x) => ({ ...x, values: x.values.slice(0, 2) })) };
    // The points are past the end, so no ring; the fences are values on the
    // series the chart still shows, so the two rules remain and the fact is
    // placed, not dropped.
    const shortened = cuesForChart(bundleOf([f]), short);
    expect(shortened.cues.map((c) => c.kind)).toEqual(["rule", "rule"]);
    expect(shortened.dropped).toEqual([]);
    const none = { ...s, series: [] };
    expect(cuesForChart(bundleOf([f]), none).dropped).toEqual([{ factId: f.id, reason: "series-not-in-snapshot" }]);
  });

  it("a dominant category summed across rows has no single row and is refused, never guessed", () => {
    const f = factOf("dominance");
    const summed: FactRecord = { ...f, kind: { ...f.kind, topIndex: null } };
    const r = cuesForChart(bundleOf([summed]), snapshotFor(f));
    expect(r.cues).toEqual([]);
    expect(r.dropped).toEqual([{ factId: f.id, reason: "no-single-row" }]);
  });

  it("a malformed fact is refused, not thrown on", () => {
    const f = factOf("extremes");
    const broken: FactRecord = { ...f, kind: { fact: "extremes", subject: (f.kind as any).subject } };
    expect(cuesForChart(bundleOf([broken]), snapshotFor(f)).dropped).toEqual([{ factId: f.id, reason: "malformed-fact" }]);
    expect(cuesForChart({ ...bundleOf([]), factsJson: "not json" }, snapshotFor(f))).toEqual({ cues: [], dropped: [] });
  });

  it("a change whose series ends in a blank anchors to the last NUMBER", () => {
    const f = factOf("change");
    const s = snapshotFor(f);
    const series = s.series.find((x) => x.name === name((f.kind as any).subject))!;
    const values = [...series.values, null, null];
    const categories = [...s.categories, "Jan", "Feb"];
    const r = cuesForChart(bundleOf([f]), { ...s, categories, series: [{ ...series, values }] });
    expect(r.cues[0].anchor).toMatchObject({ type: "datum", categoryIndex: s.categories.length - 1 });
  });
});

// ============================================================================
// Order, steps, determinism
// ============================================================================

describe("order and determinism", () => {
  it("keeps the bundle's rank order and keeps one fact's cues adjacent, so steps are per fact", () => {
    const facts = [factOf("changePoint"), factOf("extremes"), factOf("leader")];
    const s = snapshotFor(facts[0]);
    // One consistent snapshot: overlay the labels the other facts name.
    for (const f of facts.slice(1)) {
      const t = snapshotFor(f);
      t.categories.forEach((c, i) => { if (!c.startsWith("C")) s.categories[i] = c; });
      for (const ts of t.series) {
        const mine = s.series.find((x) => x.name === ts.name);
        if (!mine) (s.series as unknown[]).push(ts);
        else namedDatums(f.kind).forEach((d) => { if (d.value !== undefined && d.series === ts.name) (mine.values as (number | null)[])[d.index as number] = d.value; });
      }
    }
    const { cues, dropped } = cuesForChart(bundleOf(facts), s);
    expect(dropped).toEqual([]);
    // The level shift is four cues (ring, band, two mean rules), all adjacent.
    expect(cues.map((c) => c.factId)).toEqual([facts[0].id, facts[0].id, facts[0].id, facts[0].id, facts[1].id, facts[1].id, facts[2].id]);
    const steps = stepsOf(cues);
    expect(steps.map((st) => [st.factId, st.cues.length])).toEqual([[facts[0].id, 4], [facts[1].id, 2], [facts[2].id, 1]]);
    expect(steps.map((st) => st.description)).toEqual(["Level shift in Revenue", "Highest Revenue", "Largest series: Revenue"]);
  });

  it("is deterministic over the whole fixture", () => {
    for (const f of FACTS) {
      const first = JSON.stringify(cuesForChart(bundleOf([f]), snapshotFor(f)));
      for (let i = 0; i < 10; i++) expect(JSON.stringify(cuesForChart(bundleOf([f]), snapshotFor(f)))).toBe(first);
    }
  });

  it("carries the narrator's sentence as the label when the bundle has it", () => {
    const f = factOf("extremes");
    const { cues } = cuesForChart(bundleOf([f], [], "Revenue is highest at Aug."), snapshotFor(f));
    for (const c of cues as ChartCue[]) expect(c.label).toBe("Revenue is highest at Aug.");
  });
});
