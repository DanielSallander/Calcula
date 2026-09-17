//! FILENAME: app/extensions/Insights/lib/overlay.ts
// PURPOSE: The overlay's owner: turn it on for a chart, keep it true while the
//          chart's data changes, hold the comments, and say which tier did it.
// CONTEXT: docs/design/insight-overlays.md §4.7-§4.8a, IO-3a. One bundle feeds
//          both the pane's cards and the chart's cues (§4.1): showing the
//          overlay runs the SAME request "Explain this chart" runs and hands
//          the result to both. The cues themselves come from
//          `@api/insightCues`; the painting is Charts'; this module only
//          decides WHEN to recompute and WHAT to hand over.
//
//          OVERLAY OBJECTS ARE NEVER DEAD. Charts announces every data
//          re-resolution (`onChartDataChanged`); for a chart whose overlay is
//          on, this module recomputes the bundle, replaces the cues, and
//          re-anchors the comments by fact id (`overlayComments.ts`) — the
//          three outcomes of §4.8a. Recomputation is an IPC round trip, so it
//          is debounced per chart: a param sweep at 30 frames a second must
//          not become 30 analyses.
//
//          COMMENTS PERSIST IN THE WORKBOOK through `@api/extensionData` under
//          this extension's own id — one blob, keyed by chart id — written
//          undoably. They are NOT chart annotations (D-IO-9): "Keep in chart"
//          is the explicit act that writes one into the spec.
//
//          THE NOTICE names the tier (§14.4 of the strategy layer): with a
//          strategy, "computed from the model's strategy — not guessed";
//          without one, "computed from the numbers; no strategy declares
//          which way is good". Red is never inferred, and the notice says so.

import {
  clearChartCues,
  getChartComments,
  getChartCues,
  getChartOverlay,
  onChartDataChanged,
  setChartComments,
  setChartCueStep,
  setChartCues,
  setSelectedChartCue,
  type ChartCueComment,
} from "@api/chartCues";
import { CHART_SERIES_MAX_POINTS, resolveChartSeries, type ChartSeriesSnapshot } from "@api/chartData";
import { AppEvents, emitAppEvent } from "@api/events";
import { getExtensionData, setExtensionDataUndoable } from "@api/extensionData";
import { cuesForChart, type ChartCueSet } from "@api/insightCues";
import { normalizeOverlayStyle, setDocumentOverlayStyle, type OverlayStyle } from "@api/insightStyle";
import type { InsightBundle } from "@api/insightsService";
import { analyzeSeries } from "./backend";
import { seriesRequestFrom } from "./chartExplain";
import { newComment, reanchorComments } from "./overlayComments";
import { refreshBundleFor } from "./store";
import { InsightsManifest } from "../manifest";

// ============================================================================
// State
// ============================================================================

interface OverlayEntry {
  bundle: InsightBundle;
  snapshot: ChartSeriesSnapshot;
  cueSet: ChartCueSet;
}

/** Charts whose overlay is ON, with what it was computed from. */
const active = new Map<string, OverlayEntry>();
/** Pending debounced recomputations, per chart. */
const pending = new Map<string, ReturnType<typeof setTimeout>>();
/** Persisted comments for every chart of this workbook (the extension-data blob). */
let commentsByChart: Record<string, ChartCueComment[]> = {};
let commentSeq = 0;

export const RECOMPUTE_DEBOUNCE_MS = 250;

interface PersistShape {
  comments?: Record<string, ChartCueComment[]>;
  /** The publisher's overlay style (§4.10); absent means the defaults. */
  style?: unknown;
}

const EXTENSION_ID = InsightsManifest.id;

/** The document's overlay style as last loaded or saved; null = defaults. */
let persistedStyle: OverlayStyle | null = null;

function persistPayload(): PersistShape {
  return { comments: commentsByChart, ...(persistedStyle ? { style: persistedStyle } : {}) };
}

// ============================================================================
// Showing and hiding
// ============================================================================

export type ShowOverlayResult =
  | { outcome: "shown"; chartId: string; cueSet: ChartCueSet; notice: string }
  | { outcome: "refused"; chartId: string; reason: string };

/** One sentence naming the tier, per §14.4. */
export function overlayNotice(entry: Pick<OverlayEntry, "snapshot" | "cueSet">): string {
  const n = new Set(entry.cueSet.cues.map((c) => c.factId)).size;
  const points = `${n} point${n === 1 ? "" : "s"} of interest`;
  const hasStrategy = (entry.snapshot.strategy?.measures.length ?? 0) > 0;
  return hasStrategy
    ? `${points}, computed from the model's strategy — not guessed.`
    : `${points}, computed from the numbers; no strategy declares which way is good.`;
}

async function compute(chartId: string): Promise<OverlayEntry | string> {
  const snapshot = await resolveChartSeries(chartId, CHART_SERIES_MAX_POINTS);
  if (!snapshot) return "This chart has no single set of series to place points of interest on.";
  const bundle = await analyzeSeries(seriesRequestFrom(snapshot));
  return { bundle, snapshot, cueSet: cuesForChart(bundle, snapshot) };
}

function publish(chartId: string, entry: OverlayEntry): void {
  active.set(chartId, entry);
  setChartCues(chartId, entry.cueSet.cues);
  // Comments follow the facts, and the persisted copy follows the comments.
  const before = commentsByChart[chartId] ?? getChartComments(chartId);
  const after = reanchorComments(before, entry.cueSet.cues);
  if (JSON.stringify(after) !== JSON.stringify(before)) {
    commentsByChart[chartId] = after;
  }
  setChartComments(chartId, commentsByChart[chartId] ?? after);
  refreshBundleFor({ kind: "chart", chartId }, entry.bundle);
}

/**
 * Turn the overlay on for a chart (recomputing if it already is). With
 * `stepToFactId`, land the stepper on that fact and select it — the pane's
 * "Show on chart" for one card.
 */
export async function showOverlay(chartId: string, options: { stepToFactId?: string } = {}): Promise<ShowOverlayResult> {
  let entry: OverlayEntry | string;
  try {
    entry = await compute(chartId);
  } catch (err) {
    return { outcome: "refused", chartId, reason: err instanceof Error ? err.message : "The chart could not be analysed." };
  }
  if (typeof entry === "string") return { outcome: "refused", chartId, reason: entry };
  publish(chartId, entry);
  if (options.stepToFactId) {
    const steps = [...new Set(entry.cueSet.cues.map((c) => c.factId))];
    const at = steps.indexOf(options.stepToFactId);
    if (at >= 0) {
      setChartCueStep(chartId, at);
      setSelectedChartCue(chartId, options.stepToFactId);
    }
  }
  return { outcome: "shown", chartId, cueSet: entry.cueSet, notice: overlayNotice(entry) };
}

export function hideOverlay(chartId: string): void {
  active.delete(chartId);
  const t = pending.get(chartId);
  if (t) {
    clearTimeout(t);
    pending.delete(chartId);
  }
  clearChartCues(chartId);
}

export function isOverlayOn(chartId: string): boolean {
  return active.has(chartId);
}

export function toggleOverlay(chartId: string): Promise<ShowOverlayResult> | void {
  if (isOverlayOn(chartId)) {
    hideOverlay(chartId);
    return;
  }
  return showOverlay(chartId);
}

/** What the overlay on a chart was last computed from, for the pane and tests. */
export function overlayEntry(chartId: string): OverlayEntry | null {
  return active.get(chartId) ?? null;
}

/** The notice for a chart whose overlay is on, or null. */
export function noticeFor(chartId: string): string | null {
  const e = active.get(chartId);
  return e ? overlayNotice(e) : null;
}

// ============================================================================
// Following the data
// ============================================================================

/** Recompute a chart's overlay after its data changed (debounced). Exported for tests. */
export function scheduleRecompute(chartId: string, delayMs: number = RECOMPUTE_DEBOUNCE_MS): void {
  if (!active.has(chartId)) return;
  const prev = pending.get(chartId);
  if (prev) clearTimeout(prev);
  pending.set(
    chartId,
    setTimeout(() => {
      pending.delete(chartId);
      if (!active.has(chartId)) return;
      void compute(chartId).then((entry) => {
        if (typeof entry === "string" || !active.has(chartId)) return;
        publish(chartId, entry);
      }).catch(() => {
        // The chart could not be analysed right now; the last honest overlay
        // stays until it can (its cues still validate against the geometry).
      });
    }, delayMs),
  );
}

/** Subscribe to Charts' data-changed announcements. Returns the unsubscribe. */
export function followChartData(): () => void {
  return onChartDataChanged((chartId) => scheduleRecompute(chartId));
}

// ============================================================================
// Comments
// ============================================================================

async function persistComments(description: string): Promise<void> {
  await setExtensionDataUndoable(EXTENSION_ID, persistPayload(), description);
}

// ============================================================================
// The overlay style (the publisher's, in a published application)
// ============================================================================

/**
 * Save the document's overlay style (null restores the defaults), undoably,
 * and make every painter use it at once. It rides in the same blob as the
 * comments, so it is published and pulled with the application.
 */
export async function saveOverlayStyle(style: OverlayStyle | null): Promise<void> {
  persistedStyle = style === null ? null : normalizeOverlayStyle(style);
  setDocumentOverlayStyle(persistedStyle);
  await setExtensionDataUndoable(EXTENSION_ID, persistPayload(), style === null ? "Reset overlay style" : "Change overlay style");
  emitAppEvent(AppEvents.GRID_REFRESH);
}

/** The document's declared style, or null (the defaults). */
export function documentOverlayStyle(): OverlayStyle | null {
  return persistedStyle;
}

/** Add a comment on a fact of a chart, anchored where its cue is now. */
export async function addComment(chartId: string, factId: string, text: string): Promise<ChartCueComment> {
  commentSeq += 1;
  const id = `k${Date.now().toString(36)}-${commentSeq}`;
  const comment = newComment(id, factId, text, getChartCues(chartId));
  const list = [...(commentsByChart[chartId] ?? []), comment];
  commentsByChart = { ...commentsByChart, [chartId]: list };
  setChartComments(chartId, list);
  await persistComments("Add comment");
  return comment;
}

export async function removeComment(chartId: string, commentId: string): Promise<void> {
  const list = (commentsByChart[chartId] ?? []).filter((c) => c.id !== commentId);
  commentsByChart = { ...commentsByChart, [chartId]: list };
  if (list.length === 0) delete commentsByChart[chartId];
  setChartComments(chartId, list);
  await persistComments("Remove comment");
}

export async function editComment(chartId: string, commentId: string, text: string): Promise<void> {
  const list = (commentsByChart[chartId] ?? []).map((c) => (c.id === commentId ? { ...c, text } : c));
  commentsByChart = { ...commentsByChart, [chartId]: list };
  setChartComments(chartId, list);
  await persistComments("Edit comment");
}

/** The comments of a chart, from the persisted copy. */
export function commentsOf(chartId: string): readonly ChartCueComment[] {
  return commentsByChart[chartId] ?? [];
}

/**
 * Reload the persisted comments (activation, File > Open, undo/redo) and push
 * them into the transient store so Charts paints them. Attached comments
 * whose chart has no overlay on are pushed as they were saved; they re-anchor
 * the next time the overlay is shown.
 */
export async function loadComments(): Promise<void> {
  let stored: PersistShape | null = null;
  try {
    stored = await getExtensionData<PersistShape>(EXTENSION_ID);
  } catch {
    stored = null;
  }
  const comments = stored?.comments;
  commentsByChart = {};
  if (comments && typeof comments === "object") {
    for (const [chartId, list] of Object.entries(comments)) {
      if (Array.isArray(list)) commentsByChart[chartId] = list.filter(isComment);
    }
  }
  // The style travels with the workbook: what the file declares, normalised
  // field by field, becomes what every painter draws with.
  persistedStyle = stored && stored.style !== undefined && stored.style !== null ? normalizeOverlayStyle(stored.style) : null;
  setDocumentOverlayStyle(persistedStyle);
  for (const chartId of new Set([...Object.keys(commentsByChart), ...activeChartIdsWithComments()])) {
    setChartComments(chartId, commentsByChart[chartId] ?? []);
  }
}

function activeChartIdsWithComments(): string[] {
  return [...active.keys()].filter((id) => getChartOverlay(id).comments.length > 0);
}

function isComment(v: unknown): v is ChartCueComment {
  return typeof v === "object" && v !== null && typeof (v as ChartCueComment).id === "string" && typeof (v as ChartCueComment).factId === "string" && typeof (v as ChartCueComment).text === "string";
}

/** Drop everything (File > New, deactivate). */
export function resetOverlays(): void {
  for (const chartId of [...active.keys()]) hideOverlay(chartId);
  for (const t of pending.values()) clearTimeout(t);
  pending.clear();
  commentsByChart = {};
  persistedStyle = null;
  setDocumentOverlayStyle(null);
}
