//! FILENAME: app/extensions/AIChat/lib/selectionContext.ts
// PURPOSE: Tell the model what the user has SELECTED, so "format each selected
//          cell" is a request it can act on rather than guess at.
// CONTEXT: Reported 2026-08-22. The user asked the chat to "format the background
//          color of each selected cell" and the model answered with an invented
//          tool and a hardcoded `["A1","B3","C5"]` — which, given the surface it
//          was handed, was the only thing it COULD do. A grep of chatTools.ts for
//          "selection" returns nothing: not one of the tools exposes it, and the
//          system prompt never mentioned it. The model was not being lazy; it was
//          filling a hole.
//
//          WHY THE PROMPT AND NOT A TOOL. A `get_selection` tool would need an
//          arm in ai/tools.rs (chatToolSurface.test.ts diffs both directions) and
//          a backend that knows the selection — which it does not: selection is
//          frontend state, and the MCP summary path hardcodes
//          `selection_context: None` (mcp/tools.rs). Building that means new IPC,
//          a new command in generate_handler!, and a round trip the model must
//          spend a turn on. One line appended to the system string costs ~30
//          tokens, needs no plumbing, and — unlike a tool — cannot be FORGOTTEN
//          by a weak model, which is the whole failure mode being fixed.
//
//          A tool is still the right answer the day the selection must be read
//          MID-TURN (after the model itself moved it). Nothing here forecloses
//          that; the prompt line is what makes the common case work today.
//
// LIFETIME: one subscription for the pane's lifetime, not one per turn. The
//          latest payload is remembered; the send path reads it synchronously.

import { AppEvents, onAppEvent, a1Rect } from "@api";

/**
 * One rectangle of the selection.
 *
 * Structurally mirrors what the Shell emits (`ExtensionRegistry.ts`, the
 * `AppEvents.SELECTION_CHANGED` emitter). Declared here rather than imported
 * because the Shell's interface is not exported through `@api` and an extension
 * may not reach into `src/shell` — the Facade Rule. It is validated on arrival,
 * so a shape change degrades to "no selection" instead of a wrong answer.
 */
export interface SelectionArea {
  startRow: number;
  startCol: number;
  endRow: number;
  endCol: number;
}

export interface SelectionSnapshot {
  sheetIndex: number;
  /** Every area, primary first. A single-area selection has exactly one. */
  areas: SelectionArea[];
}

let current: SelectionSnapshot | null = null;

function isFiniteInt(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v);
}

/**
 * Read the event payload, or null.
 *
 * The Shell emits `null` when the selection is cleared, and emits areas only
 * when the primary rectangle is fully numeric — so a partial shape is a real
 * possibility rather than defensive paranoia, and treating it as "no selection"
 * is the honest reading. Never throws: a bad payload must not break the chat.
 */
export function readSelectionPayload(payload: unknown): SelectionSnapshot | null {
  if (!payload || typeof payload !== "object") return null;
  const p = payload as Record<string, unknown>;
  const rawAreas = Array.isArray(p.areas) ? p.areas : [];
  const areas: SelectionArea[] = [];
  for (const raw of rawAreas) {
    if (!raw || typeof raw !== "object") continue;
    const a = raw as Record<string, unknown>;
    if (
      !isFiniteInt(a.startRow) || !isFiniteInt(a.startCol) ||
      !isFiniteInt(a.endRow) || !isFiniteInt(a.endCol)
    ) {
      continue;
    }
    // Normalized: a drag upward or leftward produces start > end, and a model
    // told "rows 9 to 2" will write a loop that runs zero times.
    areas.push({
      startRow: Math.min(a.startRow, a.endRow),
      startCol: Math.min(a.startCol, a.endCol),
      endRow: Math.max(a.startRow, a.endRow),
      endCol: Math.max(a.startCol, a.endCol),
    });
  }
  if (areas.length === 0) return null;
  return { sheetIndex: isFiniteInt(p.sheetIndex) ? p.sheetIndex : 0, areas };
}

/**
 * Subscribe for the pane's lifetime. Returns the teardown for a cleanup array.
 */
export function installSelectionTracking(): () => void {
  const off = onAppEvent(AppEvents.SELECTION_CHANGED, (payload: unknown) => {
    current = readSelectionPayload(payload);
  });
  return () => {
    off();
    current = null;
  };
}

/** The last selection seen, or null. */
export function currentSelection(): SelectionSnapshot | null {
  return current;
}

/** Test hook: set the remembered selection directly. */
export function __setSelectionForTest(snapshot: SelectionSnapshot | null): void {
  current = snapshot;
}

/**
 * One line of prompt text describing the selection, or null when there is none.
 *
 * BOTH coordinate systems, deliberately. The tools are 0-based (`read_cell_range`
 * takes `start_row`), and the system prompt says so — but a script the model
 * DRAFTS is read by a human, and every human-facing thing in a spreadsheet is A1.
 * Giving only one spelling means the model converts, and conversion off by one is
 * the single most common arithmetic error a small model makes here.
 */
export function describeSelection(snapshot: SelectionSnapshot | null = current): string | null {
  if (!snapshot || snapshot.areas.length === 0) return null;
  const parts = snapshot.areas.map((a) => {
    const rect = a1Rect(a.startRow, a.startCol, a.endRow, a.endCol);
    return (
      `${rect} (rows ${a.startRow}-${a.endRow}, columns ${a.startCol}-${a.endCol}, 0-based)`
    );
  });
  const head =
    snapshot.areas.length === 1
      ? `THE USER'S CURRENT SELECTION is ${parts[0]}`
      : `THE USER'S CURRENT SELECTION has ${snapshot.areas.length} areas: ${parts.join("; ")}`;
  return `${head}, on sheet index ${snapshot.sheetIndex}. Use these coordinates when the user says "the selection" or "the selected cells".`;
}

/** The system prompt with the selection appended, when there is one. */
export function withSelection(systemPrompt: string): string {
  const line = describeSelection();
  return line ? `${systemPrompt}\n\n${line}` : systemPrompt;
}
