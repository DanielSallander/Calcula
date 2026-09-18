//! FILENAME: app/src/api/chartCues.ts
// PURPOSE: The transient "points of interest" channel for charts — cues drawn
//          OVER a chart at a datum, the step the reader is on, the cue they
//          selected, and the comments beside the cues. On or off, never in
//          the spec.
// CONTEXT: Every visual state a chart has today is persisted state: layers and
//          dataPointOverrides live in the spec, and `updateChartSpec` is a
//          document mutation that dirties the file and enters undo. An insight
//          overlay is a LENS, not an edit (docs/design/insight-overlays.md §1),
//          so it needs a channel the spec never sees. This is that channel: a
//          store keyed by chart id, cleared on document open/new like every
//          document-scoped store, and read by the Charts painter at composite
//          time — the same place selection highlights and tooltips are drawn.
//
//          THE SEAM RUNS ONE WAY, TWICE. Insights (the consumer) says WHAT: a
//          fact id, a datum, a polarity, a comment's words. Charts (the
//          painter) decides HOW a ring looks on a bar, a line point or a pie
//          slice through its own hit geometry, and it is also the only thing
//          that can write a kept cue INTO the spec or paint a snapshot — so it
//          registers a `ChartCueHost` here (IoC, the `chartParams` shape) and
//          Insights calls `keepChartCue` / `snapshotChart` without importing
//          Charts. Nothing here names pixels; nothing here imports an extension.
//
//          THE ANCHOR CARRIES ITS OWN CHECK. `categoryIndex` is the painter-space
//          index the snapshot (`@api/chartData`) reported, and `categoryLabel`
//          is what the fact said that category is called. The painter refuses
//          to draw when the two disagree — a stale index after a filter or a
//          data change is the encircled wrong bar, and a dropped ring is the
//          only honest answer.
//
//          OVERLAY OBJECTS ARE NEVER DEAD (§4.8a). Charts announces every data
//          re-resolution through `announceChartDataChanged`; Insights listens,
//          recomputes, and re-anchors comments by fact id. A comment whose fact
//          is gone is kept UNATTACHED (anchor null) and drawn in a tray, never
//          left over the wrong bar.
//
//          THE VOCABULARY IS CLOSED (§4.2): five kinds, four anchors, and no
//          sixth of either without a measured reason. `@api/insightCues` is
//          the only producer; the Charts painter is the only consumer.

/** Good / bad come from a declared direction, never from a number's sign. */
export type ChartCuePolarity = "good" | "bad" | "attention" | "neutral";

/** The closed cue vocabulary (docs/design/insight-overlays.md §4.2). */
export type ChartCueKind = "ring" | "emphasis" | "band" | "rule" | "callout";

/**
 * One datum on a chart: a series by NAME (indices shift when a series is
 * hidden; names do not) and a category by painter-space index, with the label
 * the fact used so the painter can validate before it draws.
 */
export interface ChartCueDatumAnchor {
  type: "datum";
  series: string;
  categoryIndex: number;
  categoryLabel: string;
}

/** A whole series (the largest of several, say). */
export interface ChartCueSeriesAnchor {
  type: "series";
  series: string;
}

/** A run of categories, inclusive, in painter-space indices. */
export interface ChartCueSpanAnchor {
  type: "span";
  series?: string;
  from: number;
  to: number;
}

/** A data value on the value axis (a fence, a target). */
export interface ChartCueLevelAnchor {
  type: "level";
  series?: string;
  value: number;
}

export type ChartCueAnchor =
  | ChartCueDatumAnchor
  | ChartCueSeriesAnchor
  | ChartCueSpanAnchor
  | ChartCueLevelAnchor;

export interface ChartCue {
  /**
   * This cue, not its fact. One fact routinely emits SEVERAL cues — `extremes`
   * emits a ring on the highest bar and another on the lowest — so a fact id
   * does not name a cue, and anything that acts on "the cue the reader clicked"
   * (selection, a comment, a kept mark) must carry this instead. Deterministic:
   * the fact's id and the cue's ordinal within that fact.
   */
  cueId: string;
  /** The fact this cue is the picture of. A cue with no fact behind it is a defect. */
  factId: string;
  kind: ChartCueKind;
  polarity: ChartCuePolarity;
  anchor: ChartCueAnchor;
  /** The fact's own deterministic sentence. */
  label?: string;
  /** A few words for the stepper: "Highest Revenue", "Level shift in Cost". Deterministic. */
  description?: string;
}

/**
 * A reader's words beside a point of interest. Anchored to the CUE (the one
 * ring the reader was looking at), which is why it can follow that ring when
 * the data changes and why it can become unattached when the cue is gone.
 * `factId` is kept for grouping and for the tray's wording; it is never what
 * re-anchoring resolves by, because a fact can own several cues.
 */
export interface ChartCueComment {
  /** Stable id, so an edit or a removal names one comment. */
  id: string;
  cueId: string;
  factId: string;
  text: string;
  /** Where it is drawn now; `null` when its fact no longer exists (the tray). */
  anchor: ChartCueDatumAnchor | null;
  /** The label the fact named when the comment was written, when that has since changed. */
  movedFrom?: string;
}

/** Which cues are on screen: one step (a fact's cues) or all of them. */
export type ChartCueStep = number | "all";

export interface ChartOverlayState {
  cues: readonly ChartCue[];
  comments: readonly ChartCueComment[];
  step: ChartCueStep;
  /** The cue the reader clicked, or null. Never the fact: a fact owns many cues. */
  selectedCueId: string | null;
}

type Listener = (chartId: string) => void;
type DataListener = (chartId: string) => void;

const overlays = new Map<string, ChartOverlayState>();
const listeners = new Set<Listener>();
const dataListeners = new Set<DataListener>();

const EMPTY: ChartOverlayState = Object.freeze({
  cues: Object.freeze([]) as readonly ChartCue[],
  comments: Object.freeze([]) as readonly ChartCueComment[],
  step: 0,
  selectedCueId: null,
});

function notify(chartId: string): void {
  for (const l of [...listeners]) l(chartId);
}

function stateOf(chartId: string): ChartOverlayState {
  return overlays.get(chartId) ?? EMPTY;
}

function freezeCues(cues: readonly ChartCue[]): readonly ChartCue[] {
  return Object.freeze(cues.map((c) => ({ ...c, anchor: { ...c.anchor } })));
}

function freezeComments(comments: readonly ChartCueComment[]): readonly ChartCueComment[] {
  return Object.freeze(comments.map((c) => ({ ...c, anchor: c.anchor ? { ...c.anchor } : null })));
}

/** Distinct fact ids in cue order — the steps. */
function factOrder(cues: readonly ChartCue[]): string[] {
  const out: string[] = [];
  for (const c of cues) if (!out.includes(c.factId)) out.push(c.factId);
  return out;
}

function put(chartId: string, next: ChartOverlayState): void {
  if (next.cues.length === 0 && next.comments.length === 0) {
    if (!overlays.delete(chartId)) return;
  } else {
    overlays.set(chartId, Object.freeze(next));
  }
  notify(chartId);
}

// ============================================================================
// Cues
// ============================================================================

/**
 * Replace a chart's cues. The step is kept if the fact it showed is still
 * present (a re-resolution after a filter keeps the reader where they were),
 * else reset to the first; the selection is kept on the same rule. The stored
 * list is a frozen copy, so a caller mutating its own array afterwards changes
 * nothing.
 */
export function setChartCues(chartId: string, cues: readonly ChartCue[]): void {
  const prev = stateOf(chartId);
  const prevFacts = factOrder(prev.cues);
  const nextFacts = factOrder(cues);
  let step: ChartCueStep = prev.step;
  if (typeof step === "number") {
    const shown = prevFacts[step];
    const at = shown === undefined ? -1 : nextFacts.indexOf(shown);
    step = at >= 0 ? at : 0;
  }
  const selectedCueId =
    prev.selectedCueId !== null && cues.some((c) => c.cueId === prev.selectedCueId) ? prev.selectedCueId : null;
  put(chartId, { ...prev, cues: freezeCues(cues), step, selectedCueId });
}

/** Drop one chart's cues, selection and step; comments stay (they may be unattached). */
export function clearChartCues(chartId: string): void {
  const prev = stateOf(chartId);
  if (prev.cues.length === 0 && prev.selectedCueId === null) return;
  put(chartId, { ...prev, cues: EMPTY.cues, step: 0, selectedCueId: null });
}

/** Drop everything for every chart — document open/new, extension teardown. */
export function clearAllChartCues(): void {
  const ids = [...overlays.keys()];
  overlays.clear();
  for (const id of ids) notify(id);
}

/** A chart's current cues, or an empty (frozen) list. */
export function getChartCues(chartId: string): readonly ChartCue[] {
  return stateOf(chartId).cues;
}

/** The whole overlay state of a chart (frozen). */
export function getChartOverlay(chartId: string): ChartOverlayState {
  return stateOf(chartId);
}

/** Chart ids that currently carry at least one cue or comment. */
export function listChartsWithCues(): string[] {
  return [...overlays.keys()];
}

// ============================================================================
// Stepping
// ============================================================================

/** The facts a chart's cues step through, in order (one step per fact). */
export function chartCueSteps(chartId: string): string[] {
  return factOrder(stateOf(chartId).cues);
}

export function getChartCueStep(chartId: string): ChartCueStep {
  return stateOf(chartId).step;
}

/** Show one fact's cues (by step index, clamped) or all of them. */
export function setChartCueStep(chartId: string, step: ChartCueStep): void {
  const prev = stateOf(chartId);
  if (prev.cues.length === 0) return;
  const n = factOrder(prev.cues).length;
  const next: ChartCueStep = step === "all" ? "all" : Math.min(Math.max(0, Math.floor(step)), n - 1);
  if (next === prev.step) return;
  put(chartId, { ...prev, step: next });
}

/** Move one step forward or back, wrapping. From "all", +1 goes to the first, -1 to the last. */
export function stepChartCues(chartId: string, delta: 1 | -1): void {
  const prev = stateOf(chartId);
  const n = factOrder(prev.cues).length;
  if (n === 0) return;
  const next = prev.step === "all" ? (delta === 1 ? 0 : n - 1) : (prev.step + delta + n) % n;
  setChartCueStep(chartId, next);
}

/** The cues on screen right now: the active step's, or all. */
export function visibleChartCues(chartId: string): readonly ChartCue[] {
  const s = stateOf(chartId);
  if (s.step === "all") return s.cues;
  const fact = factOrder(s.cues)[s.step];
  return fact === undefined ? s.cues : s.cues.filter((c) => c.factId === fact);
}

// ============================================================================
// Selection
// ============================================================================

/**
 * Select ONE cue by its own id. A fact id is not accepted: passing one selects
 * nothing, which is the honest outcome — the alternative is silently selecting
 * the fact's first cue, and that is exactly how a comment on the 2023 bar
 * landed on 2025.
 */
export function setSelectedChartCue(chartId: string, cueId: string | null): void {
  const prev = stateOf(chartId);
  const next = cueId !== null && prev.cues.some((c) => c.cueId === cueId) ? cueId : null;
  if (next === prev.selectedCueId) return;
  put(chartId, { ...prev, selectedCueId: next });
}

export function getSelectedChartCue(chartId: string): ChartCue | null {
  const s = stateOf(chartId);
  return s.selectedCueId === null ? null : (s.cues.find((c) => c.cueId === s.selectedCueId) ?? null);
}

/** The first cue of a fact, for callers that step by FACT (the stepper). */
export function firstCueOfFact(chartId: string, factId: string): ChartCue | null {
  return stateOf(chartId).cues.find((c) => c.factId === factId) ?? null;
}

// ============================================================================
// Comments
// ============================================================================

/** Replace a chart's comments (frozen copy). Insights owns their persistence. */
export function setChartComments(chartId: string, comments: readonly ChartCueComment[]): void {
  const prev = stateOf(chartId);
  put(chartId, { ...prev, comments: freezeComments(comments) });
}

export function getChartComments(chartId: string): readonly ChartCueComment[] {
  return stateOf(chartId).comments;
}

// ============================================================================
// Change notification
// ============================================================================

/** Subscribe to per-chart overlay changes. Returns the unsubscribe. */
export function onChartCuesChanged(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/**
 * Charts calls this after a chart's data has been re-resolved and repainted
 * — a filter, an edit, a param sweep. The overlay's owner recomputes from it.
 */
export function announceChartDataChanged(chartId: string): void {
  for (const l of [...dataListeners]) l(chartId);
}

export function onChartDataChanged(listener: DataListener): () => void {
  dataListeners.add(listener);
  return () => {
    dataListeners.delete(listener);
  };
}

// ============================================================================
// The host: what only Charts can do (IoC, the chartParams shape)
// ============================================================================

export interface ChartCueHost {
  /** Write a cue into the chart's spec as a persisted annotation (undoable). */
  keepCue(chartId: string, cue: ChartCue): Promise<void>;
  /** Write a comment into the chart's spec as a text annotation (undoable). */
  keepComment(chartId: string, comment: ChartCueComment): Promise<void>;
  /**
   * The chart as a PNG WITH its visible cues and comments, on the clipboard
   * and, when a path is asked for, in a file. Resolves to the saved path or
   * null.
   */
  snapshot(chartId: string, options?: { saveToFile?: boolean }): Promise<string | null>;
}

let host: ChartCueHost | null = null;

/** Called once by Charts in activate(), and with null on deactivate. */
export function registerChartCueHost(impl: ChartCueHost | null): void {
  host = impl;
}

export function getChartCueHost(): ChartCueHost | null {
  return host;
}

export function keepChartCue(chartId: string, cue: ChartCue): Promise<void> {
  return host ? host.keepCue(chartId, cue) : Promise.reject(new Error("Charts is not available."));
}

export function keepChartComment(chartId: string, comment: ChartCueComment): Promise<void> {
  return host ? host.keepComment(chartId, comment) : Promise.reject(new Error("Charts is not available."));
}

export function snapshotChart(chartId: string, options?: { saveToFile?: boolean }): Promise<string | null> {
  return host ? host.snapshot(chartId, options) : Promise.reject(new Error("Charts is not available."));
}
