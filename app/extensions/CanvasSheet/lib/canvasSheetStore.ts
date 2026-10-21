//! FILENAME: app/extensions/CanvasSheet/lib/canvasSheetStore.ts
// PURPOSE: The canvas sheet extension's one cache: which sheets are canvases,
//          each canvas's LAYOUT, which of them are subscribed from an
//          application, and which sheet is active.
// CONTEXT: The authority for all of it is the backend (`get_sheets` carries
//          each sheet's kind and layout; `calp_get_sheet_provenance` says which
//          sheets were pulled). This store is a synchronous copy because the
//          layout-surface provider is asked from inside a pointer gesture and a
//          paint, where an IPC round trip is not an option.
//
//          Refreshes race: a sheet switch, a layout write and a document swap
//          can all ask at once, and an older `get_sheets` answer arriving last
//          must never overwrite a newer one. Each refresh takes a generation
//          number and only the latest one is applied.
//
//          Keyed two ways on purpose. BY INDEX for the provider (Core asks by
//          true sheet index) and BY SHEET ID for provenance (an index shifts on
//          insert/delete/move; the id does not, and matching by name would bind
//          a collision-renamed pulled sheet to the subscriber's own).
//
//          Edit interactions (P4 S10). Every applied layout and every refresh
//          also PUBLISHES each canvas's `interactions` to @api/reportFilters
//          (by sheet id), and withdraws (null) the pages that are no longer
//          canvases, so the cross-filter resolver answers synchronously from
//          the same copy the ribbon and the overlay read. A page is published
//          again only when its interactions actually changed.

import { getSheets } from "@api";
import type { CanvasLayout, SheetInfo } from "@api";
import { getSheetProvenance } from "@api/collaboration";
import { publishPageInteractions, type PageInteractions } from "@api/reportFilters";

/** One canvas sheet as the store knows it. */
export interface CanvasSheetEntry {
  index: number;
  sheetId: string | null;
  name: string;
  layout: CanvasLayout;
}

/** The immutable view React sections and the painter read. */
export interface CanvasSheetSnapshot {
  /** The backend's active sheet index at the last refresh. */
  activeIndex: number;
  /** The active sheet when it is a canvas, else null. */
  active: CanvasSheetEntry | null;
  /** Whether the active canvas is subscribed from an application. */
  activeSubscribed: boolean;
  /** Bumped on every change, so a snapshot comparison is one number. */
  version: number;
}

let canvases = new Map<number, CanvasSheetEntry>();
let subscribedIds = new Set<string>();
let activeIndex = 0;
let version = 0;
let generation = 0;
let snapshot: CanvasSheetSnapshot = freeze();
const listeners = new Set<() => void>();
/** What was last published to @api/reportFilters, per sheet id (JSON, for the change test). */
let publishedInteractions = new Map<string, string>();

/**
 * A layout's `interactions` in the seam's shape, or null at the default (no
 * pairs, no default mode). Pure; exported for tests.
 */
export function pageInteractionsOf(layout: CanvasLayout | null | undefined): PageInteractions | null {
  const held = layout?.interactions;
  if (!held) return null;
  const pairs = (held.pairs ?? []).map((p) => ({
    source: { kind: p.source.kind, id: p.source.id },
    target: { kind: p.target.kind, id: p.target.id },
    mode: p.mode,
  })) as PageInteractions["pairs"];
  const defaultMode = held.defaultMode === "filter" || held.defaultMode === "highlight" ? held.defaultMode : undefined;
  if (pairs.length === 0 && defaultMode === undefined) return null;
  return defaultMode === undefined ? { pairs } : { defaultMode, pairs };
}

/**
 * Publish every canvas's interactions (by sheet id) and withdraw the pages no
 * longer present. Unchanged pages are not re-published.
 */
function syncPublishedInteractions(): void {
  const next = new Map<string, string>();
  const values = new Map<string, PageInteractions | null>();
  for (const entry of canvases.values()) {
    if (!entry.sheetId) continue;
    const value = pageInteractionsOf(entry.layout);
    next.set(entry.sheetId, JSON.stringify(value));
    values.set(entry.sheetId, value);
  }
  for (const sheetId of publishedInteractions.keys()) {
    if (!next.has(sheetId)) safePublish(sheetId, null);
  }
  for (const [sheetId, json] of next) {
    if (publishedInteractions.get(sheetId) !== json) safePublish(sheetId, values.get(sheetId) ?? null);
  }
  publishedInteractions = next;
}

function safePublish(sheetId: string, value: PageInteractions | null): void {
  try {
    publishPageInteractions(sheetId, value);
  } catch (err) {
    console.error("[CanvasSheet] publishing a page's interactions failed:", err);
  }
}

function freeze(): CanvasSheetSnapshot {
  const active = canvases.get(activeIndex) ?? null;
  return Object.freeze({
    activeIndex,
    active,
    activeSubscribed: !!active?.sheetId && subscribedIds.has(active.sheetId),
    version,
  });
}

function publish(): void {
  version += 1;
  snapshot = freeze();
  for (const l of Array.from(listeners)) {
    try {
      l();
    } catch (err) {
      console.error("[CanvasSheet] store listener threw:", err);
    }
  }
}

/** Build the index map from a sheet list. Pure; exported for tests. */
export function canvasEntriesFrom(sheets: readonly SheetInfo[]): Map<number, CanvasSheetEntry> {
  const map = new Map<number, CanvasSheetEntry>();
  for (const s of sheets) {
    if (s.kind !== "canvas" || !s.canvasLayout) continue;
    map.set(s.index, {
      index: s.index,
      sheetId: s.sheetId ?? null,
      name: s.name,
      layout: s.canvasLayout,
    });
  }
  return map;
}

/**
 * Re-read every sheet's kind and layout from the backend. Resolves true when
 * this call's answer was applied, false when a newer refresh superseded it or
 * the read failed (a failed read keeps the previous answer: a transient IPC
 * error must not turn every canvas into a worksheet for a frame).
 */
export async function refreshCanvasSheets(): Promise<boolean> {
  const mine = ++generation;
  try {
    const result = await getSheets();
    if (mine !== generation) return false;
    canvases = canvasEntriesFrom(result.sheets);
    activeIndex = result.activeIndex;
    syncPublishedInteractions();
    publish();
    return true;
  } catch (err) {
    console.warn("[CanvasSheet] get_sheets failed; keeping the previous canvas list:", err);
    return false;
  }
}

/**
 * Re-read which sheets are SUBSCRIBED (pulled from an application). A working
 * copy is the application itself and stays editable, so only `subscribed`
 * counts. A failed read keeps the previous answer.
 */
export async function refreshCanvasProvenance(): Promise<void> {
  try {
    const rows = await getSheetProvenance();
    const next = new Set<string>();
    for (const r of rows) {
      if (r.role === "subscribed" && r.sheetId) next.add(r.sheetId);
    }
    subscribedIds = next;
    publish();
  } catch (err) {
    console.warn("[CanvasSheet] provenance read failed; keeping the previous answer:", err);
  }
}

/** Apply a layout the backend just returned for sheet `index`, at once. */
export function applyCanvasLayout(index: number, layout: CanvasLayout): void {
  const entry = canvases.get(index);
  if (!entry) return;
  const next = new Map(canvases);
  next.set(index, { ...entry, layout });
  canvases = next;
  syncPublishedInteractions();
  publish();
}

/** The canvas at `index`, or null for a worksheet (or an unknown index). */
export function canvasAt(index: number): CanvasSheetEntry | null {
  return canvases.get(index) ?? null;
}

/** The canvas whose sheet id is `sheetId`, or null. */
export function canvasBySheetId(sheetId: string): CanvasSheetEntry | null {
  for (const entry of canvases.values()) {
    if (entry.sheetId === sheetId) return entry;
  }
  return null;
}

/** Whether the canvas at `index` is subscribed from an application. */
export function isSubscribedCanvas(index: number): boolean {
  const entry = canvases.get(index);
  return !!entry?.sheetId && subscribedIds.has(entry.sheetId);
}

export function getCanvasSheetSnapshot(): CanvasSheetSnapshot {
  return snapshot;
}

export function subscribeCanvasSheets(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Forget everything (extension deactivate, tests). */
export function resetCanvasSheetStore(): void {
  generation += 1;
  canvases = new Map();
  subscribedIds = new Set();
  activeIndex = 0;
  syncPublishedInteractions();
  publish();
}
