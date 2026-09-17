//! FILENAME: app/extensions/Insights/lib/backend.ts
// PURPOSE: Typed wrappers over the four `insights_*` Tauri commands, plus the
//          one BI-connection read the pane needs to know whether a model path
//          exists at all.
// CONTEXT: Every sentence this extension shows is computed in Rust. Nothing in
//          this folder composes a fact, ranks one, or rewords one — the whole
//          frontend job is to ask the right question and render the answer
//          honestly. That is why the wrappers are this thin: a typed name, the
//          request shape the command declares, and no post-processing. If a
//          bundle looks wrong, the bug is in Rust, and keeping this file
//          incapable of "helping" is what makes that statement true.
//
//          The channel is the capability-scoped door (A3), bound once in
//          activate(). Components and the store call through it rather than the
//          raw @api/backend passthrough.

import { createBackendChannel } from "@api/backendCommands";
import type {
  InsightBundle,
  ModelInsightsRequest,
  RangeInsightsRequest,
} from "@api/insightsService";

/** The capability-scoped backend door. Bound in `activate()`. */
export const insightsBackend = createBackendChannel("Insights");

// ============================================================================
// Request shapes that have no home in @api
// ============================================================================

/**
 * One resolved series on its way to `insights_for_series`.
 *
 * `values` is `(number | null)[]` and the `null` is load-bearing: the chart
 * renderer turns an unparseable cell into 0, which is right for drawing a bar
 * and a lie for computing a trend. A blank month must arrive as `null` so the
 * Rust side can exclude it rather than see a collapse that never happened.
 */
export interface SeriesInsightsSeries {
  name: string;
  values: readonly (number | null)[];
}

/**
 * Which connection's strategy applies to which series. Mirrors
 * `SeriesStrategyContext` in `app/src-tauri/src/insights/series_strategy.rs`.
 */
export interface SeriesStrategyContext {
  connectionId: string;
  measures: ReadonlyArray<{ series: string; measure: string }>;
}

/** The `insights_for_series` request. Mirrors `ChartSeriesSnapshot`'s data half. */
export interface SeriesInsightsRequest {
  title: string;
  categories: readonly string[];
  categoryKind: "nominal" | "quantitative" | "temporal";
  categoryValues?: readonly number[];
  series: readonly SeriesInsightsSeries[];
  /**
   * Absent for a chart that knows no strategy. Present, Rust attaches the
   * measure's direction to facts about each bound series and withholds a
   * change below the measure's materiality — the model route's own rules.
   */
  strategy?: SeriesStrategyContext;
}

/** What `insights_create_report_sheet` hands back. */
export interface CreatedReportSheet {
  sheetIndex: number;
  sheetName: string;
}

/** A BI connection, reduced to what the source switch needs. */
export interface InsightsConnection {
  id: string;
  name: string;
}

/** The `bi_get_connections` row shape (only the two fields used here). */
interface BiConnectionRow {
  id: string;
  name: string;
}

// ============================================================================
// Commands
// ============================================================================

/** Deterministic facts about a rectangle of cells. Needs no model and no AI. */
export function analyzeRange(request: RangeInsightsRequest): Promise<InsightBundle> {
  return insightsBackend.invoke<InsightBundle>("insights_analyze_range", { request });
}

/** Facts about MEASURES, with declared direction, additivity and materiality. */
export function analyzeModel(request: ModelInsightsRequest): Promise<InsightBundle> {
  return insightsBackend.invoke<InsightBundle>("insights_analyze_model", { request });
}

/** Facts about an already-resolved set of series (the chart path). */
export function analyzeSeries(request: SeriesInsightsRequest): Promise<InsightBundle> {
  return insightsBackend.invoke<InsightBundle>("insights_for_series", { request });
}

/** Build a report sheet for a model connection. Returns where it landed. */
export function createReportSheet(connectionId: string): Promise<CreatedReportSheet> {
  return insightsBackend.invoke<CreatedReportSheet>("insights_create_report_sheet", {
    request: { connectionId },
  });
}

/**
 * The workbook's BI connections.
 *
 * NOT an `insights_*` command — this is the existing `bi_get_connections` that
 * ControlsPane and Charts already read. The Model source switch has to know
 * whether there is a model at all BEFORE anything is analysed, and inventing an
 * `insights_has_model` for that would have duplicated a fact the backend
 * already publishes.
 */
export async function listConnections(): Promise<InsightsConnection[]> {
  const rows = await insightsBackend.invoke<BiConnectionRow[]>("bi_get_connections");
  if (!Array.isArray(rows)) return [];
  return rows
    .filter((r): r is BiConnectionRow => Boolean(r) && typeof r.id === "string")
    .map((r) => ({ id: r.id, name: typeof r.name === "string" && r.name ? r.name : r.id }));
}
