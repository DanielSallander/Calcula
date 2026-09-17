//! FILENAME: app/src/api/cellCues.ts
// PURPOSE: The transient "points of interest" channel for CELLS — a sheet
//          range's or a pivot's facts, drawn on the cells they name. On or
//          off, never a style, never in the document.
// CONTEXT: docs/design/insight-overlays.md §4.6, IO-4. The chart channel
//          (`@api/chartCues`) anchors to data through a chart's geometry; a
//          cell cue anchors to a CELL — sheet index, row, column — because for
//          a sheet range and for a pivot (whose cells are sheet cells inside an
//          overlay region) the cell IS the datum. Insights sets them from
//          facts (`@api/insightCues` `cuesForSheet`); the grid paints them
//          through an over-selection cell decoration Insights registers, which
//          the core replays AFTER the pivot overlay and the selection chrome
//          (`gridRenderer/core.ts`), so the same mechanism reaches a pivot's
//          cells and a plain range's. No pivot seam was needed; the design's
//          `setCellEmphasis` is superseded by this store.
//
//          Cues are grouped by OWNER — "range:…" or "pivot:…" — so one target
//          can be turned off without touching another's, and re-resolved when
//          its data changes. The store is document-scoped: cleared on open/new.

import type { ChartCuePolarity } from "./chartCues";

export interface CellCue {
  factId: string;
  polarity: ChartCuePolarity;
  /** "Highest Revenue", "Outlier in Cost". */
  description: string;
  /** The fact's own sentence. */
  label?: string;
  sheetIndex: number;
  row: number;
  col: number;
}

type Listener = (ownerId: string) => void;

const byOwner = new Map<string, readonly CellCue[]>();
const listeners = new Set<Listener>();
/** `${sheetIndex}:${row}:${col}` → the cues on that cell, across owners. */
let index = new Map<string, CellCue[]>();

function key(sheetIndex: number, row: number, col: number): string {
  return `${sheetIndex}:${row}:${col}`;
}

function rebuildIndex(): void {
  const next = new Map<string, CellCue[]>();
  for (const cues of byOwner.values()) {
    for (const c of cues) {
      const k = key(c.sheetIndex, c.row, c.col);
      const list = next.get(k);
      if (list) list.push(c);
      else next.set(k, [c]);
    }
  }
  index = next;
}

function notify(ownerId: string): void {
  for (const l of [...listeners]) l(ownerId);
}

/** Replace an owner's cues (frozen copy). Empty clears the owner. */
export function setCellCues(ownerId: string, cues: readonly CellCue[]): void {
  if (cues.length === 0) {
    clearCellCues(ownerId);
    return;
  }
  byOwner.set(ownerId, Object.freeze(cues.map((c) => ({ ...c }))));
  rebuildIndex();
  notify(ownerId);
}

export function clearCellCues(ownerId: string): void {
  if (!byOwner.delete(ownerId)) return;
  rebuildIndex();
  notify(ownerId);
}

export function clearAllCellCues(): void {
  const ids = [...byOwner.keys()];
  byOwner.clear();
  index = new Map();
  for (const id of ids) notify(id);
}

const NONE: readonly CellCue[] = Object.freeze([]);

export function getCellCues(ownerId: string): readonly CellCue[] {
  return byOwner.get(ownerId) ?? NONE;
}

export function listCellCueOwners(): string[] {
  return [...byOwner.keys()];
}

/** The cues on one cell, from every owner. Cheap: a map lookup per cell per frame. */
export function cellCuesAt(sheetIndex: number, row: number, col: number): readonly CellCue[] {
  return index.get(key(sheetIndex, row, col)) ?? NONE;
}

export function hasAnyCellCues(): boolean {
  return byOwner.size > 0;
}

export function onCellCuesChanged(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
