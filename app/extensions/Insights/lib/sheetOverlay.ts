//! FILENAME: app/extensions/Insights/lib/sheetOverlay.ts
// PURPOSE: The overlay on CELLS — a sheet range's or a pivot's points of
//          interest, drawn on the cells they name and kept true while the
//          cells change.
// CONTEXT: docs/design/insight-overlays.md §4.5-§4.6, IO-4. A pivot's cells are
//          sheet cells inside an overlay region, and the core replays an
//          over-selection cell decoration AFTER that region is painted, so one
//          mechanism serves both targets: analyse the target as a range
//          (`insights_analyze_range`, the same route the pane uses), turn the
//          facts into cell cues (`@api/insightCues` `cuesForSheet`, which reads
//          `rowOrigins` so a fact's dataset row becomes the SHEET row, hidden
//          rows and header included), and hand them to `@api/cellCues` under
//          an owner id. The decoration registered here paints them.
//
//          TWO ROUTES FOR A PIVOT (IO-6). A BI-backed pivot is a query over a
//          model, so its facts are the MODEL's (`insights_analyze_model`, with
//          the strategy's directions) matched to its cells by the labels the
//          headers show (`@api/pivotCues` `pivotCuesFor`): the Gadgets row at
//          the last period, coloured by whether the strategy says a rise there
//          is good. Any other pivot — a sheet-range pivot, one whose model
//          info is missing — is analysed as a range of numbers, neutral. The
//          route is decided per computation, so a pivot re-pointed at a model
//          switches on its next recompute.
//
//          FOLLOWS THE DATA: a cell change inside the owner's rectangle, or a
//          pivot refresh, recomputes after a short debounce; the owner's cues
//          are replaced, never patched.

import { clearCellCues, hasAnyCellCues, cellCuesAt, setCellCues, type CellCue } from "@api/cellCues";
import { registerCellDecoration, type CellDecorationContext } from "@api/cellDecorations";
import { AppEvents, emitAppEvent, onAppEvent, type CellValuesChangedPayload } from "@api/events";
import { getGridStateSnapshot } from "@api/grid";
import { getGridRegions } from "@api/gridOverlays";
import { cuesForSheet, parseFactsDocument, type CellCueDrop } from "@api/insightCues";
import { overlayStyleFor, resolveOverlayStyle } from "@api/insightStyle";
import type { InsightBundle, RangeInsightsRequest } from "@api/insightsService";
import { pivot } from "@api/pivot";
import { pivotCuesFor, type PivotCueDrop } from "@api/pivotCues";
import { PivotEvents } from "../../_shared/lib/pivotEvents";
import { analyzeModel, analyzeRange } from "./backend";
import { refreshBundleFor, type InsightsOrigin } from "./store";

// ============================================================================
// Owners
// ============================================================================

export interface RangeOwner {
  kind: "range";
  request: RangeInsightsRequest;
}

export interface PivotOwner {
  kind: "pivot";
  pivotId: string;
}

export type SheetOverlayOwner = RangeOwner | PivotOwner;

export function ownerId(owner: SheetOverlayOwner): string {
  if (owner.kind === "pivot") return `pivot:${owner.pivotId}`;
  const r = owner.request;
  return `range:${r.sheetIndex}:${r.startRow}:${r.startCol}:${r.endRow}:${r.endCol}`;
}

/** Which facts a target's cues came from. */
export type SheetOverlayRoute = "range" | "model";

/** A cell cue set from either route; a model-route drop carries the pivot reasons. */
export interface SheetCueSet {
  cues: CellCue[];
  dropped: Array<CellCueDrop | PivotCueDrop>;
}

interface Entry {
  owner: SheetOverlayOwner;
  bundle: InsightBundle;
  cueSet: SheetCueSet;
  route: SheetOverlayRoute;
  /** The rectangle analysed (a pivot's region at the time), for change intersection. */
  rect: RangeInsightsRequest;
  /** When set, only this fact's cues are shown (a card's "Show on sheet"). */
  onlyFactId: string | null;
}

const active = new Map<string, Entry>();
const pending = new Map<string, ReturnType<typeof setTimeout>>();
export const SHEET_RECOMPUTE_DEBOUNCE_MS = 250;

// ============================================================================
// Resolution
// ============================================================================

/**
 * The facts name their sheet; the request knew its index. A range bundle is
 * about ONE sheet — the one analysed — so any other name resolves to nothing
 * rather than to whatever sheet is in front.
 */
export function sheetResolverFor(bundle: InsightBundle, rect: RangeInsightsRequest): (name: string) => number | null {
  const source = parseFactsDocument(bundle.factsJson).sourceSheet;
  return (name) => (source !== null && name === source ? rect.sheetIndex : null);
}

/** A pivot's rectangle on the active sheet, from the grid regions. */
export function pivotRect(pivotId: string): RangeInsightsRequest | null {
  const region = getGridRegions().find((r) => r.type === "pivot" && r.data?.pivotId === pivotId && !r.data?.isEmpty);
  if (!region) return null;
  const grid = getGridStateSnapshot();
  const sheetIndex = (grid?.sheetContext as { activeSheetIndex: number } | undefined)?.activeSheetIndex ?? 0;
  const g = region as unknown as { startRow: number; startCol: number; endRow: number; endCol: number };
  return { sheetIndex, startRow: g.startRow, startCol: g.startCol, endRow: g.endRow, endCol: g.endCol };
}

function rectOf(owner: SheetOverlayOwner): RangeInsightsRequest | null {
  return owner.kind === "range" ? owner.request : pivotRect(owner.pivotId);
}

/** The model a BI-backed pivot queries, or null for any other pivot. */
async function modelConnectionOf(rect: RangeInsightsRequest): Promise<string | null> {
  try {
    const info = await pivot.getAtCell(rect.startRow, rect.startCol);
    const id = info?.biModel?.connectionId;
    return typeof id === "string" && id !== "" ? id : null;
  } catch {
    return null;
  }
}

/** The model route: the model's facts on the pivot's cells, offset into the sheet. */
async function computeFromModel(pivotId: string, connectionId: string, rect: RangeInsightsRequest): Promise<{ bundle: InsightBundle; cueSet: SheetCueSet } | string> {
  const [bundle, view, hierarchies] = await Promise.all([
    analyzeModel({ connectionId }),
    pivot.getView(pivotId),
    pivot.getHierarchies(pivotId),
  ]);
  if (view.isWindowed) return "This pivot is too large to place points of interest on its cells.";
  const set = pivotCuesFor(bundle, view, hierarchies.dataHierarchies.map((d) => d.name));
  const cues: CellCue[] = set.cues.map((c) => ({
    factId: c.factId,
    polarity: c.polarity,
    description: c.description,
    ...(c.label ? { label: c.label } : {}),
    sheetIndex: rect.sheetIndex,
    row: rect.startRow + c.viewRow,
    col: rect.startCol + c.viewCol,
  }));
  return { bundle, cueSet: { cues, dropped: set.dropped } };
}

async function compute(owner: SheetOverlayOwner): Promise<Entry | string> {
  const rect = rectOf(owner);
  if (!rect) return "This pivot is not on the active sheet.";
  if (owner.kind === "pivot") {
    const connectionId = await modelConnectionOf(rect);
    if (connectionId !== null) {
      const result = await computeFromModel(owner.pivotId, connectionId, rect);
      if (typeof result === "string") return result;
      return { owner, bundle: result.bundle, cueSet: result.cueSet, route: "model", rect, onlyFactId: null };
    }
  }
  const bundle = await analyzeRange({ ...rect, expandToRegion: false });
  const cueSet = cuesForSheet(bundle, sheetResolverFor(bundle, rect));
  return { owner, bundle, cueSet, route: "range", rect, onlyFactId: null };
}

function shown(entry: Entry): CellCue[] {
  return entry.onlyFactId === null ? entry.cueSet.cues : entry.cueSet.cues.filter((c) => c.factId === entry.onlyFactId);
}

function publish(id: string, entry: Entry): void {
  active.set(id, entry);
  setCellCues(id, shown(entry));
  const origin: InsightsOrigin = entry.owner.kind === "pivot"
    ? { kind: "pivot", pivotId: entry.owner.pivotId }
    : { kind: "range", request: entry.owner.request };
  refreshBundleFor(origin, entry.bundle);
  emitAppEvent(AppEvents.GRID_REFRESH);
}

// ============================================================================
// Showing and hiding
// ============================================================================

export type ShowSheetOverlayResult =
  | { outcome: "shown"; ownerId: string; cueSet: SheetCueSet; route: SheetOverlayRoute; notice: string }
  | { outcome: "refused"; ownerId: string; reason: string };

export function sheetNotice(cueSet: SheetCueSet, route: SheetOverlayRoute = "range"): string {
  const n = new Set(cueSet.cues.map((c) => c.factId)).size;
  const points = `${n} point${n === 1 ? "" : "s"} of interest`;
  if (route === "model") {
    const judged = cueSet.cues.some((c) => c.polarity === "good" || c.polarity === "bad");
    return judged
      ? `${points} from the model; colours follow the strategy's declared directions.`
      : `${points} from the model; no declared direction reached them, so none is coloured good or bad.`;
  }
  return `${points}, computed from the numbers; no strategy declares which way is good.`;
}

export async function showSheetOverlay(owner: SheetOverlayOwner, options: { onlyFactId?: string } = {}): Promise<ShowSheetOverlayResult> {
  const id = ownerId(owner);
  let entry: Entry | string;
  try {
    entry = await compute(owner);
  } catch (err) {
    return { outcome: "refused", ownerId: id, reason: err instanceof Error ? err.message : "The range could not be analysed." };
  }
  if (typeof entry === "string") return { outcome: "refused", ownerId: id, reason: entry };
  entry.onlyFactId = options.onlyFactId ?? null;
  publish(id, entry);
  return { outcome: "shown", ownerId: id, cueSet: entry.cueSet, route: entry.route, notice: sheetNotice(entry.cueSet, entry.route) };
}

export function hideSheetOverlay(owner: SheetOverlayOwner | string): void {
  const id = typeof owner === "string" ? owner : ownerId(owner);
  active.delete(id);
  const t = pending.get(id);
  if (t) {
    clearTimeout(t);
    pending.delete(id);
  }
  clearCellCues(id);
  emitAppEvent(AppEvents.GRID_REFRESH);
}

export function isSheetOverlayOn(owner: SheetOverlayOwner | string): boolean {
  return active.has(typeof owner === "string" ? owner : ownerId(owner));
}

export function sheetOverlayNotice(owner: SheetOverlayOwner | string): string | null {
  const e = active.get(typeof owner === "string" ? owner : ownerId(owner));
  return e ? sheetNotice(e.cueSet, e.route) : null;
}

export function resetSheetOverlays(): void {
  for (const id of [...active.keys()]) hideSheetOverlay(id);
  for (const t of pending.values()) clearTimeout(t);
  pending.clear();
}

// ============================================================================
// Following the data
// ============================================================================

export function scheduleSheetRecompute(id: string, delayMs: number = SHEET_RECOMPUTE_DEBOUNCE_MS): void {
  const entry = active.get(id);
  if (!entry) return;
  const prev = pending.get(id);
  if (prev) clearTimeout(prev);
  pending.set(
    id,
    setTimeout(() => {
      pending.delete(id);
      const current = active.get(id);
      if (!current) return;
      void compute(current.owner)
        .then((next) => {
          if (typeof next === "string" || !active.has(id)) return;
          next.onlyFactId = current.onlyFactId;
          publish(id, next);
        })
        .catch(() => {
          // Keep the last honest overlay until the range can be analysed again.
        });
    }, delayMs),
  );
}

function intersects(rect: RangeInsightsRequest, change: { row: number; col: number; sheetIndex?: number }, activeSheet: number): boolean {
  if ((change.sheetIndex ?? activeSheet) !== rect.sheetIndex) return false;
  return change.row >= rect.startRow && change.row <= rect.endRow && change.col >= rect.startCol && change.col <= rect.endCol;
}

/** Subscribe to cell changes and pivot refreshes. Returns the unsubscribe. */
export function followSheetData(): () => void {
  const offCells = onAppEvent<CellValuesChangedPayload>(AppEvents.CELL_VALUES_CHANGED, (payload) => {
    if (!payload || !Array.isArray(payload.changes) || active.size === 0) return;
    const grid = getGridStateSnapshot();
    const activeSheet = (grid?.sheetContext as { activeSheetIndex: number } | undefined)?.activeSheetIndex ?? 0;
    for (const [id, entry] of active) {
      if (payload.changes.some((c) => intersects(entry.rect, c, activeSheet))) scheduleSheetRecompute(id);
    }
  });
  const offPivots = onAppEvent(PivotEvents.PIVOT_REGIONS_UPDATED, () => {
    for (const [id, entry] of active) {
      if (entry.owner.kind === "pivot") scheduleSheetRecompute(id);
    }
  });
  return () => {
    offCells();
    offPivots();
  };
}

// ============================================================================
// Painting
// ============================================================================

/** Draw the cues on one cell: an inset frame per polarity, a corner dot when several. Pure over the context. */
export function drawCellCues(context: CellDecorationContext, cues: readonly CellCue[]): void {
  if (cues.length === 0) return;
  const { ctx, cellLeft, cellTop, cellRight, cellBottom } = context;
  const first = cues[0];
  // The document's style (the publisher's, in a published application).
  const style = overlayStyleFor(first.polarity);
  ctx.save();
  ctx.strokeStyle = style.color;
  ctx.lineWidth = resolveOverlayStyle().lineWidth;
  ctx.setLineDash([...style.dash]);
  ctx.strokeRect(cellLeft + 1.5, cellTop + 1.5, Math.max(0, cellRight - cellLeft - 3), Math.max(0, cellBottom - cellTop - 3));
  if (cues.length > 1) {
    ctx.setLineDash([]);
    ctx.fillStyle = style.color;
    ctx.beginPath();
    ctx.arc(cellRight - 5, cellTop + 5, 2.5, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.restore();
}

/** Register the over-selection decoration that paints cell cues. Returns the unregister. */
export function registerCellCueDecoration(): () => void {
  return registerCellDecoration(
    "insights-cell-cues",
    (context) => {
      if (!hasAnyCellCues()) return;
      const grid = getGridStateSnapshot();
      const sheetIndex = (grid?.sheetContext as { activeSheetIndex: number } | undefined)?.activeSheetIndex;
      if (sheetIndex === undefined) return;
      drawCellCues(context, cellCuesAt(sheetIndex, context.row, context.col));
    },
    30,
    "over-selection",
  );
}
