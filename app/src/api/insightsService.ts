//! FILENAME: app/src/api/insightsService.ts
// PURPOSE: The feature-neutral seam for "tell me what is going on in this data".
// CONTEXT: Two callers reach it today, and neither imports the Insights
//          extension. The AI chat's "analyse" pre-route (AIChat/lib/tierZero.ts)
//          asks it BEFORE the model sees the message, so "what is going on
//          here" is answered from a computed bundle the model puts into words
//          rather than from an impression it forms over raw cells. The
//          Insights pane's "Send to chat" hands the same bundle over as a
//          prompt. Until 2026-09-10 this header said the chat "wants" the seam,
//          and nothing in the chat called it — a seam whose only consumer was
//          the extension that registered it.
//
//          A caller asks about a RANGE or a MEASURE and gets facts back.
//          Whether those facts came from the model-aware path (measures,
//          declared additivity, contribution decomposition) or from the
//          raw-grid fallback is reported in the result, so a caller can say
//          where the answer came from — but it is never something a caller has
//          to branch on before asking.
//
//          THE WORDING RULES LIVE HERE TOO. `describeBundleForModel` is the one
//          text a model is ever handed — by the pane's prefill and by the chat's
//          pre-route alike — so the three things it must carry (the notes, the
//          dropped count, the ban on causes) are written once and tested once.

/** Where a fact's evidence lives, so clicking it can select something. */
export interface InsightEvidence {
  kind: "range" | "query";
  /** For a range: "Sheet1!B2:B25". For a query: a human-readable description. */
  label: string;
  sheetIndex?: number;
  startRow?: number;
  startCol?: number;
  endRow?: number;
  endCol?: number;
  /** For a model query: enough to open it as a real pivot. */
  measures?: readonly string[];
  groupBy?: readonly string[];
}

/** One attribute that influenced a fact, and where it came from. */
export interface InsightProvenance {
  attribute: string;
  value: string;
  /** "base" | "inferred" | "kpi:<name>" | "strategy" | "rule:<id>" */
  source: string;
}

export interface Insight {
  id: string;
  /** The fact kind, e.g. "trend", "contribution", "outliers". */
  kind: string;
  /** 0..1. Used for ranking; shown as a weight, never as a probability. */
  score: number;
  /** The sentence a person reads. Deterministic, and never claims a cause. */
  text: string;
  evidence: readonly InsightEvidence[];
  /**
   * Which declared attributes decided this fact.
   *
   * Empty for a raw-grid fact. Non-empty whenever the strategy layer took part,
   * so a reader can always ask "why does it think a rise here is bad?" and get
   * a named answer rather than a shrug.
   */
  provenance: readonly InsightProvenance[];
}

export interface InsightBundle {
  /** "range" when computed from cells, "model" when computed from measures. */
  source: "range" | "model";
  insights: readonly Insight[];
  /** How many facts the cap discarded, so the pane can say "and 7 more". */
  dropped: number;
  /** The whole bundle as text, for a chat tool and for Copy as text. */
  markdown: string;
  /** Numbers only, no prose. What a Tier-1 narrator is given to work from. */
  factsJson: string;
  /** Sampling, hidden rows excluded, an unreachable dimension: stated, not hidden. */
  notes: readonly string[];
}

export interface RangeInsightsRequest {
  sheetIndex: number;
  startRow: number;
  startCol: number;
  endRow: number;
  endCol: number;
  /** Expand a single cell to its surrounding block first. */
  expandToRegion?: boolean;
}

export interface ModelInsightsRequest {
  connectionId: string;
  /** Empty means "the measures the strategy layer ranks highest". */
  measures?: readonly string[];
}

/** A BI connection the model path can be asked about. */
export interface ModelConnection {
  id: string;
  name: string;
}

export interface InsightsProvider {
  /** Deterministic facts about a rectangle of cells. Needs no model and no AI. */
  analyzeRange(req: RangeInsightsRequest): Promise<InsightBundle>;
  /**
   * Facts about MEASURES, with declared direction, additivity and materiality.
   *
   * Separate from `analyzeRange` because the unit of analysis is genuinely
   * different: a measure knows what it means, which column of numbers does not.
   */
  analyzeModel(req: ModelInsightsRequest): Promise<InsightBundle>;
  /** True when the workbook has a semantic model to analyse at all. */
  hasModel(): boolean;
  /**
   * The workbook's BI connections, from the provider's own cache.
   *
   * Synchronous by the same contract as `hasModel`: a chat deciding whether
   * "what is going on" is a question about the model cannot spend a round trip
   * finding out whether there is one. Empty when there is none.
   */
  modelConnections(): readonly ModelConnection[];
}

// ============================================================================
// The words a model is handed
// ============================================================================

/**
 * The rules a narrator is held to. Exported so a test can name them and so a
 * caller that builds its own framing still quotes the same four sentences.
 */
export const INSIGHT_NARRATION_RULES: readonly string[] = [
  "Write a short plain-language summary of the facts below.",
  "Use only the numbers given. Do not compute new ones and do not round away detail that changes the meaning.",
  "Do not suggest a cause for any movement. The facts deliberately do not claim one.",
  "Repeat every limitation listed below rather than dropping it.",
];

/**
 * A bundle as the text a model reads: the facts verbatim, the rules, the cap
 * and the stated limits.
 *
 * THREE THINGS THIS MUST DO, and each is a defect if it stops doing it:
 *
 * - Carry the notes. "Sampled to 10,000 points", "hidden rows excluded" are the
 *   caveats that make a number honest; a summary written without them is
 *   confidently wrong and the reader has no way to tell.
 * - Carry the `dropped` count, so a capped list is never presented as the
 *   complete picture.
 * - Forbid causes. Every sentence Rust produces is careful not to claim WHY
 *   something moved; a narrator that adds "because of the price change" undoes
 *   that in one clause.
 *
 * `originLabel` is what the bundle was computed FROM ("Sheet1!B2:D40", a
 * connection name, a chart title). A summary that does not say what it
 * summarises is unusable once it is pasted anywhere else.
 */
export function describeBundleForModel(
  bundle: InsightBundle,
  originLabel?: string | null,
): string {
  const parts: string[] = [];

  const where = originLabel ? ` for ${originLabel}` : "";
  parts.push(
    `Calcula computed the following facts${where}. They are deterministic — ` +
      `no model produced them — and they came from the ` +
      `${bundle.source === "model" ? "semantic model" : "cell range"}.`,
  );

  parts.push(INSIGHT_NARRATION_RULES.map((r) => `- ${r}`).join("\n"));

  parts.push("Facts:");
  parts.push(bundle.markdown.trim().length > 0 ? bundle.markdown.trim() : "(none)");

  if (bundle.dropped > 0) {
    parts.push(
      `${bundle.dropped} further fact${bundle.dropped === 1 ? " was" : "s were"} ranked ` +
        `below the cut and are not listed. Do not present this as the complete picture.`,
    );
  }

  if (bundle.notes.length > 0) {
    parts.push(`Stated limits:\n${bundle.notes.map((n) => `- ${n}`).join("\n")}`);
  }

  return parts.join("\n\n");
}

let provider: InsightsProvider | null = null;

export function registerInsightsProvider(next: InsightsProvider): () => void {
  provider = next;
  return () => {
    if (provider === next) provider = null;
  };
}

export function hasInsightsProvider(): boolean {
  return provider !== null;
}

export function getInsightsProvider(): InsightsProvider | null {
  return provider;
}

export function requireInsightsProvider(): InsightsProvider {
  if (!provider) {
    throw new Error("Insights are unavailable: the Insights extension is not loaded.");
  }
  return provider;
}

export function resetInsightsProvider(): void {
  provider = null;
}
