//! FILENAME: app/src/api/reportFilters/interactions.ts
// PURPOSE: Which visual filters which on a canvas page (Power BI's Edit
//          interactions): per page, an optional default for visual sources and
//          explicit (source, target, mode) pairs.
// CONTEXT: The PERSISTED copy is `CanvasLayout.interactions` (Rust
//          core/persistence `CanvasInteractions`); the CanvasSheet family
//          publishes each page's copy here (P4 S10) so the resolver can answer
//          synchronously. The Power BI defaults, in order:
//            1. an explicit pair wins;
//            2. a SLICER source filters (slicers never highlight);
//            3. a VISUAL source gives the page's defaultMode, else "highlight";
//          and a highlight a target cannot paint is a filter. `defaultMode`
//          never yields "none": "none" is said pair by pair.
//
//          A pair naming an object that no longer exists is inert by
//          construction (DC-2a): its source never has a selection and its
//          target is never resolved.

import type { InteractionMode, PageInteractions, ResolveTarget, VisualRef } from "./types";
import { runChange } from "./changes";
import { cleanVisualRef } from "./publishers";

export type { PageInteractions } from "./types";

const MODES: ReadonlySet<string> = new Set(["filter", "highlight", "none"]);

/** Interactions by page sheet id (pages with none are absent). */
const byPage = new Map<string, PageInteractions>();

function refKey(ref: VisualRef): string {
  return `${ref.kind}:${ref.id}`;
}

/**
 * The interactions canonical: bad pairs dropped, a pair from a visual to
 * itself dropped, duplicates collapsed with the LAST one winning (the latest
 * edit, as Rust `CanvasInteractions::sanitized`), a defaultMode that is not
 * filter/highlight dropped. Null when nothing is left.
 */
function normalized(interactions: PageInteractions | null): PageInteractions | null {
  if (!interactions || typeof interactions !== "object") return null;
  const defaultMode =
    interactions.defaultMode === "filter" || interactions.defaultMode === "highlight" ? interactions.defaultMode : undefined;
  const byPair = new Map<string, PageInteractions["pairs"][number]>();
  for (const p of Array.isArray(interactions.pairs) ? interactions.pairs : []) {
    const source = cleanVisualRef(p?.source);
    const target = cleanVisualRef(p?.target);
    if (!source || !target || !MODES.has(p.mode)) continue;
    if (refKey(source) === refKey(target)) continue;
    const k = `${refKey(source)}>${refKey(target)}`;
    byPair.delete(k);
    byPair.set(k, { source, target, mode: p.mode });
  }
  const pairs = [...byPair.values()];
  if (defaultMode === undefined && pairs.length === 0) return null;
  return defaultMode === undefined ? { pairs } : { defaultMode, pairs };
}

/** Publish (replace) one page's interactions; null or empty withdraws them. */
export function publishPageInteractions(pageSheetId: string, interactions: PageInteractions | null): void {
  if (typeof pageSheetId !== "string" || pageSheetId === "") return;
  const clean = normalized(interactions);
  runChange(() => {
    if (clean) byPage.set(pageSheetId, clean);
    else byPage.delete(pageSheetId);
  });
}

/** Every page's interactions (the change diff; internal to the seam). */
export function allPageInteractions(): ReadonlyMap<string, PageInteractions> {
  return byPage;
}

/**
 * How `source`'s filter or selection reaches `target` on the page. A null
 * source (a ribbon filter: not on the page, no pairs) always filters.
 */
export function interactionFor(
  pageSheetId: string,
  source: VisualRef | null,
  target: ResolveTarget,
  sourceIsSlicer: boolean,
): InteractionMode {
  if (!source) return "filter";
  const held = byPage.get(pageSheetId);
  const explicit = held?.pairs.find(
    (p) => refKey(p.source) === refKey(source) && refKey(p.target) === refKey(target.ref),
  )?.mode;
  let mode: InteractionMode;
  if (explicit !== undefined) mode = explicit;
  else if (sourceIsSlicer) mode = "filter";
  else mode = held?.defaultMode ?? "highlight";
  if (mode === "highlight" && (sourceIsSlicer || !target.canHighlight)) return "filter";
  return mode;
}
