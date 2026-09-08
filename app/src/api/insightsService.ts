//! FILENAME: app/src/api/insightsService.ts
// PURPOSE: The feature-neutral seam for "tell me what is going on in this data".
// CONTEXT: The AI chat wants it so an "analyse this" message becomes a
//          DETERMINISTIC answer rather than a model's impression; the grid
//          context menu wants it; a report generator wants it. None of them may
//          import the Insights extension, and none of them should have to know
//          whether a workbook has a semantic model.
//
//          THAT LAST POINT IS THE DESIGN. A caller asks about a RANGE or a
//          MEASURE and gets facts back. Whether those facts came from the
//          model-aware path (measures, declared additivity, contribution
//          decomposition) or from the raw-grid fallback is reported in the
//          result, so a caller can say where the answer came from — but it is
//          never something a caller has to branch on before asking.

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
