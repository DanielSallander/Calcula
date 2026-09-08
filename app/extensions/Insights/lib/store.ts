//! FILENAME: app/extensions/Insights/lib/store.ts
// PURPOSE: The Insights pane's state, held OUTSIDE React so a command, a grid
//          context-menu item and a chart's "Explain this chart" can all drive
//          the same pane whether or not it happens to be mounted.
// CONTEXT: Three things about this store are deliberate.
//
//          1. NOTHING HERE RUNS ON SELECTION CHANGE. The pane shows the range
//             it WOULD analyse and waits for a click. A pane that recomputes on
//             every arrow key is a pane people close, and every recompute is an
//             IPC round trip over a rectangle the user is still in the middle of
//             choosing.
//
//          2. RUNS ARE SEQUENCED. Two clicks, or a click and an "Explain this
//             chart", overlap freely; the later run wins and an earlier reply
//             that lands afterwards is DISCARDED rather than allowed to
//             overwrite the newer answer. Without the token, the slower of two
//             requests decides what the reader sees.
//
//          3. THE SNAPSHOT IS IMMUTABLE. `useSyncExternalStore` compares with
//             `Object.is`, so a getter that rebuilt an object per call would
//             re-render forever. Every mutation replaces the whole state object
//             once and notifies once.

import { getGridStateSnapshot } from "@api/grid";
import { columnToLetter } from "@api/types";
import type { InsightBundle, RangeInsightsRequest } from "@api/insightsService";
import {
  analyzeModel as analyzeModelCommand,
  analyzeRange as analyzeRangeCommand,
  listConnections,
  type InsightsConnection,
} from "./backend";

// ============================================================================
// State
// ============================================================================

/** Which question the pane is set up to ask. */
export type InsightsSource = "selection" | "model";

export type InsightsStatus = "idle" | "running" | "ready" | "error";

export interface InsightsPaneState {
  /** The source switch's position. Never changes on its own. */
  source: InsightsSource;
  status: InsightsStatus;
  /** The bundle on screen, or null when nothing has been asked yet. */
  bundle: InsightBundle | null;
  /** A refusal the reader can act on. Never a stack trace. */
  error: string | null;
  /** What the shown bundle was computed FROM, e.g. "Sheet1!B2:D40". */
  originLabel: string | null;
  /** When it was computed (epoch ms). The model path renders this as "as of". */
  computedAt: number | null;
  /** The workbook's BI connections. Empty means there is no model path at all. */
  connections: readonly InsightsConnection[];
  /** The connection the model path will ask about. */
  connectionId: string | null;
  /** Insight ids whose provenance ("why") list is expanded. */
  expandedWhy: readonly string[];
}

const INITIAL: InsightsPaneState = {
  source: "selection",
  status: "idle",
  bundle: null,
  error: null,
  originLabel: null,
  computedAt: null,
  connections: [],
  connectionId: null,
  expandedWhy: [],
};

let state: InsightsPaneState = INITIAL;
const listeners = new Set<() => void>();

/**
 * Monotonic run token. Only the newest run may publish a result; a reply from
 * an older run is dropped on arrival.
 */
let runToken = 0;

function set(patch: Partial<InsightsPaneState>): void {
  state = { ...state, ...patch };
  for (const l of [...listeners]) l();
}

export function getState(): InsightsPaneState {
  return state;
}

export function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

// ============================================================================
// Plain state changes
// ============================================================================

export function setSource(source: InsightsSource): void {
  if (state.source === source) return;
  set({ source });
}

export function setConnectionId(connectionId: string | null): void {
  if (state.connectionId === connectionId) return;
  set({ connectionId });
}

/** Expand or collapse one insight's provenance list. */
export function toggleWhy(insightId: string): void {
  const open = state.expandedWhy.includes(insightId);
  set({
    expandedWhy: open
      ? state.expandedWhy.filter((id) => id !== insightId)
      : [...state.expandedWhy, insightId],
  });
}

/** True when this workbook has a semantic model to analyse at all. */
export function hasModel(): boolean {
  return state.connections.length > 0;
}

/**
 * Re-read the workbook's BI connections.
 *
 * Called at activation and whenever the document is replaced. A workbook with
 * no connections renders NO source switch — not a disabled one — so this is the
 * fact that decides whether half the pane exists.
 */
export async function refreshConnections(): Promise<void> {
  let connections: InsightsConnection[] = [];
  try {
    connections = await listConnections();
  } catch {
    // A workbook with no BI support at all is not an error state for a pane
    // whose primary path is the grid. Fall back to "no model".
    connections = [];
  }
  const keep = connections.some((c) => c.id === state.connectionId)
    ? state.connectionId
    : (connections[0]?.id ?? null);
  const nextSource: InsightsSource =
    connections.length === 0 && state.source === "model" ? "selection" : state.source;
  set({ connections, connectionId: keep, source: nextSource });
}

/** Drop everything. Used on deactivate and when the document is replaced. */
export function reset(): void {
  runToken += 1;
  state = INITIAL;
  for (const l of [...listeners]) l();
}

// ============================================================================
// What the Selection source would analyse
// ============================================================================

export interface SelectionTarget {
  request: RangeInsightsRequest;
  /** "Sheet1!B2:D40" — shown next to the button so the click is predictable. */
  label: string;
  /** True when the request will expand a single cell to its block first. */
  expanded: boolean;
}

function a1(row: number, col: number): string {
  return `${columnToLetter(col)}${row + 1}`;
}

/**
 * The rectangle the Analyse button would send, read from the live grid state.
 *
 * Returns null when nothing is selected. Reading this per render is fine and
 * cheap; what must never happen is ANALYSING per render.
 */
export function describeSelection(): SelectionTarget | null {
  const grid = getGridStateSnapshot();
  const sel = grid?.selection;
  if (!grid || !sel) return null;

  const startRow = Math.min(sel.startRow, sel.endRow);
  const endRow = Math.max(sel.startRow, sel.endRow);
  const startCol = Math.min(sel.startCol, sel.endCol);
  const endCol = Math.max(sel.startCol, sel.endCol);
  const sheetIndex = grid.sheetContext.activeSheetIndex;
  const sheetName = grid.sheetContext.activeSheetName;

  const single = startRow === endRow && startCol === endCol;
  const address = single
    ? a1(startRow, startCol)
    : `${a1(startRow, startCol)}:${a1(endRow, endCol)}`;

  return {
    request: { sheetIndex, startRow, startCol, endRow, endCol, expandToRegion: single },
    label: `${sheetName}!${address}`,
    expanded: single,
  };
}

// ============================================================================
// Runs
// ============================================================================

/**
 * Claim the next run token and put the pane into "running".
 *
 * Exported because the chart path resolves its series in TypeScript BEFORE it
 * has anything to send, and the pane should say it is working during that
 * resolution rather than sitting on the previous answer.
 */
export function beginRun(originLabel: string): number {
  runToken += 1;
  set({ status: "running", error: null, originLabel, expandedWhy: [] });
  return runToken;
}

/** Publish a bundle, unless a newer run has already started. */
export function completeRun(token: number, bundle: InsightBundle, originLabel?: string): void {
  if (token !== runToken) return;
  set({
    status: "ready",
    bundle,
    error: null,
    computedAt: Date.now(),
    ...(originLabel === undefined ? {} : { originLabel }),
  });
}

/** Publish a refusal, unless a newer run has already started. */
export function failRun(token: number, message: string): void {
  if (token !== runToken) return;
  set({ status: "error", error: message, bundle: null, computedAt: null });
}

/** Turn an unknown throw into a sentence a reader can act on. */
export function describeError(err: unknown): string {
  if (err instanceof Error && err.message) return err.message;
  if (typeof err === "string" && err) return err;
  return "The analysis could not be completed.";
}

/** Analyse the current selection. Explicit — never wired to selection change. */
export async function analyzeSelection(): Promise<void> {
  const target = describeSelection();
  if (!target) {
    const token = beginRun("the selection");
    failRun(token, "Select a range on the grid first, then analyse it.");
    return;
  }
  const token = beginRun(target.label);
  try {
    const bundle = await analyzeRangeCommand(target.request);
    completeRun(token, bundle);
  } catch (err) {
    failRun(token, describeError(err));
  }
}

/** Analyse the selected model connection's measures. */
export async function analyzeModel(): Promise<void> {
  const connectionId = state.connectionId;
  const name =
    state.connections.find((c) => c.id === connectionId)?.name ?? connectionId ?? "the model";
  const token = beginRun(name);
  if (!connectionId) {
    failRun(token, "This workbook has no semantic model to analyse.");
    return;
  }
  try {
    const bundle = await analyzeModelCommand({ connectionId });
    completeRun(token, bundle);
  } catch (err) {
    failRun(token, describeError(err));
  }
}

/** Run whichever source the switch is on. */
export function analyzeCurrentSource(): Promise<void> {
  return state.source === "model" ? analyzeModel() : analyzeSelection();
}
