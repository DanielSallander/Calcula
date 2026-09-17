//! FILENAME: app/extensions/Insights/lib/cuePlacement.ts
// PURPOSE: From a bundle's facts and the chart snapshot they were computed on,
//          the cues to draw — IO-0's slice of it: a ring on `Extremes.best`.
// CONTEXT: The overlay is a second VIEW of the bundle, never a second
//          computation (docs/design/insight-overlays.md §4.1). So this module
//          reads `factsJson` — the numbers Rust kept, keyed by the same ids the
//          pane's cards carry — and turns one fact kind into an anchor. It
//          computes nothing about the data: it does not find the maximum, it
//          reads which label Rust said was highest and looks that label up in
//          the snapshot's categories.
//
//          TWO CHECKS BEFORE A CUE EXISTS, because an encircled wrong bar is
//          invisible as an error: the label must occur ONCE among the categories
//          (a chart of Jan..Dec over two years makes "Mar" ambiguous, which is
//          gap 2 and why IO-1 adds indices to every fact kind), and the value
//          at that index must be the fact's own number. A fact that fails
//          either is reported as dropped, with the reason, never placed.
//
//          IO-2 grows this into `@api/insightCues` with the whole §4.3 table.

import type { ChartCue } from "@api/chartCues";
import type { ChartSeriesSnapshot } from "@api/chartData";
import type { InsightBundle } from "@api/insightsService";

/** The `facts` entry shape `build_facts_json` writes (core/insights/src/lib.rs). */
interface FactRecord {
  id: string;
  score: number;
  kind: { fact: string; [k: string]: unknown };
}

interface ExtremesFact {
  id: string;
  series: string;
  bestLabel: string;
  best: number;
}

export type CueDropReason =
  | "series-not-in-snapshot"
  | "label-not-found"
  | "label-ambiguous"
  | "value-mismatch";

export interface CuePlacement {
  cues: ChartCue[];
  dropped: Array<{ factId: string; reason: CueDropReason }>;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
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
    const bestLabel = f.kind.bestLabel;
    const best = f.kind.best;
    if (series === null || typeof bestLabel !== "string" || typeof best !== "number") continue;
    out.push({ id: f.id, series, bestLabel, best });
  }
  return out;
}

/** Indices of every category equal to `label`. */
function occurrences(categories: readonly string[], label: string): number[] {
  const at: number[] = [];
  categories.forEach((c, i) => {
    if (c === label) at.push(i);
  });
  return at;
}

/**
 * A neutral ring on the best point of every `extremes` fact in the bundle.
 *
 * Neutral because the chart path is strategy-blind (gap 1): no direction is
 * declared, so "best" is only "highest", and the honesty rule says a colour
 * nobody declared is a colour nobody gets.
 */
export function ringsOnBest(bundle: InsightBundle, snapshot: ChartSeriesSnapshot): CuePlacement {
  const cues: ChartCue[] = [];
  const dropped: CuePlacement["dropped"] = [];
  const textById = new Map(bundle.insights.map((i) => [i.id, i.text] as const));

  for (const fact of extremesFacts(bundle.factsJson)) {
    const series = snapshot.series.find((s) => s.name === fact.series);
    if (!series) {
      dropped.push({ factId: fact.id, reason: "series-not-in-snapshot" });
      continue;
    }
    const at = occurrences(snapshot.categories, fact.bestLabel);
    if (at.length === 0) {
      dropped.push({ factId: fact.id, reason: "label-not-found" });
      continue;
    }
    if (at.length > 1) {
      dropped.push({ factId: fact.id, reason: "label-ambiguous" });
      continue;
    }
    const categoryIndex = at[0];
    if (series.values[categoryIndex] !== fact.best) {
      dropped.push({ factId: fact.id, reason: "value-mismatch" });
      continue;
    }
    cues.push({
      factId: fact.id,
      kind: "ring",
      polarity: "neutral",
      anchor: { type: "datum", series: fact.series, categoryIndex, categoryLabel: fact.bestLabel },
      ...(textById.has(fact.id) ? { label: textById.get(fact.id) } : {}),
    });
  }

  return { cues, dropped };
}
