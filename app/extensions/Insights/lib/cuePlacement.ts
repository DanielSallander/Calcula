//! FILENAME: app/extensions/Insights/lib/cuePlacement.ts
// PURPOSE: From a bundle's facts and the chart snapshot they were computed on,
//          the cues to draw — IO-0's slice of it: a ring on `Extremes.best`.
// CONTEXT: The overlay is a second VIEW of the bundle, never a second
//          computation (docs/design/insight-overlays.md §4.1). So this module
//          reads `factsJson` — the numbers Rust kept, keyed by the same ids the
//          pane's cards carry — and turns one fact kind into an anchor. It
//          computes nothing about the data: it does not find the maximum, it
//          reads which position Rust said was highest and checks that the
//          label and the value at that position are the ones Rust named.
//
//          THE INDEX IS THE MECHANISM AND THE LABEL IS THE CHECK (IO-1). A fact
//          carries `bestIndex`, a position in the series as the chart supplied
//          it, gaps counted — which is the snapshot's own index. The label at
//          that index must be the fact's label and the value must be the
//          fact's number, or the cue is dropped with a reason: a chart of
//          Jan..Dec over two years has two "Mar"s, and an index that points at
//          the wrong one is exactly the encircled wrong bar.
//
//          POLARITY COMES FROM PROVENANCE, NEVER FROM THE NUMBER. A bound
//          series' facts carry `direction` (`series_strategy.rs`): the best
//          point of a higherIsBetter measure is good, of a lowerIsBetter one is
//          bad, and a withheld or absent direction is neutral — the honesty
//          rule from model.rs, restated for colour.
//
//          IO-2 grows this into `@api/insightCues` with the whole §4.3 table.

import type { ChartCue, ChartCuePolarity } from "@api/chartCues";
import type { ChartSeriesSnapshot } from "@api/chartData";
import type { Insight, InsightBundle } from "@api/insightsService";

/** The `facts` entry shape `build_facts_json` writes (core/insights/src/lib.rs). */
interface FactRecord {
  id: string;
  score: number;
  kind: { fact: string; [k: string]: unknown };
}

export interface ExtremesFact {
  id: string;
  series: string;
  bestLabel: string;
  bestIndex: number;
  best: number;
}

export type CueDropReason =
  | "series-not-in-snapshot"
  | "index-out-of-range"
  | "label-mismatch"
  | "value-mismatch";

export interface CuePlacement {
  cues: ChartCue[];
  dropped: Array<{ factId: string; reason: CueDropReason }>;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

function isIndex(v: unknown): v is number {
  return typeof v === "number" && Number.isInteger(v) && v >= 0;
}

/** Every `extremes` fact in the bundle's facts document, or [] for anything malformed. */
export function extremesFacts(factsJson: string): ExtremesFact[] {
  let doc: unknown;
  try {
    doc = JSON.parse(factsJson);
  } catch {
    return [];
  }
  if (!isRecord(doc) || !Array.isArray(doc.facts)) return [];

  const out: ExtremesFact[] = [];
  for (const raw of doc.facts as unknown[]) {
    if (!isRecord(raw) || typeof raw.id !== "string" || !isRecord(raw.kind)) continue;
    const f = raw as unknown as FactRecord;
    if (f.kind.fact !== "extremes") continue;
    const subject = f.kind.subject;
    const series = isRecord(subject) && typeof subject.name === "string" ? subject.name : null;
    const { bestLabel, bestIndex, best } = f.kind;
    if (series === null || typeof bestLabel !== "string" || !isIndex(bestIndex) || typeof best !== "number") continue;
    out.push({ id: f.id, series, bestLabel, bestIndex, best });
  }
  return out;
}

/**
 * The polarity of a measure's BEST point, from the fact's own provenance.
 *
 * "withheld: …" (a rule that covers only some members), "targetBand",
 * "neutral" and no direction at all are all neutral: red is never inferred.
 */
export function bestPolarity(insight: Pick<Insight, "provenance"> | undefined): ChartCuePolarity {
  const direction = insight?.provenance.find((p) => p.attribute === "direction")?.value;
  if (direction === "higherIsBetter") return "good";
  if (direction === "lowerIsBetter") return "bad";
  return "neutral";
}

/**
 * A ring on the best point of every `extremes` fact in the bundle, coloured
 * by the measure's declared direction where one reached the fact.
 */
export function ringsOnBest(bundle: InsightBundle, snapshot: ChartSeriesSnapshot): CuePlacement {
  const cues: ChartCue[] = [];
  const dropped: CuePlacement["dropped"] = [];
  const byId = new Map(bundle.insights.map((i) => [i.id, i] as const));

  for (const fact of extremesFacts(bundle.factsJson)) {
    const series = snapshot.series.find((s) => s.name === fact.series);
    if (!series) {
      dropped.push({ factId: fact.id, reason: "series-not-in-snapshot" });
      continue;
    }
    const categoryIndex = fact.bestIndex;
    if (categoryIndex >= snapshot.categories.length) {
      dropped.push({ factId: fact.id, reason: "index-out-of-range" });
      continue;
    }
    if (snapshot.categories[categoryIndex] !== fact.bestLabel) {
      dropped.push({ factId: fact.id, reason: "label-mismatch" });
      continue;
    }
    if (series.values[categoryIndex] !== fact.best) {
      dropped.push({ factId: fact.id, reason: "value-mismatch" });
      continue;
    }
    const insight = byId.get(fact.id);
    cues.push({
      factId: fact.id,
      kind: "ring",
      polarity: bestPolarity(insight),
      anchor: { type: "datum", series: fact.series, categoryIndex, categoryLabel: fact.bestLabel },
      ...(insight ? { label: insight.text } : {}),
    });
  }

  return { cues, dropped };
}
