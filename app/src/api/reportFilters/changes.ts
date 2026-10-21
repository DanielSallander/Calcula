//! FILENAME: app/src/api/reportFilters/changes.ts
// PURPOSE: The ONE change event of the report-filter seam, and the diff behind
//          it: a change fires only when something a target RESOLVES actually
//          moved, and names exactly the (page, connection) pairs and the target
//          visuals that moved.
// CONTEXT: The old @api/pageFilters diffed per (sheet index, connection) so a
//          slicer store that republishes N times per re-read re-ran no chart
//          (pageFilters.ts:97-162). The same discipline, over three kinds of
//          state now:
//            - published filters: a page / pages / all scope moves its page
//              keys ("*" for all pages); a visuals scope moves its TARGETS;
//            - cross-filter selections: move their page (every target on it
//              may resolve differently). The page's `defaultMode` is part of a
//              selection's signature, because it decides what a selection DOES
//              to a target with no pair, and only selections read it;
//            - interaction pairs: move their TARGET, and only while the pair's
//              source is ACTIVE (has a selection, or publishes a filter as its
//              sourceRef). A pair for a source with nothing selected changes
//              nothing anyone resolves.
//          A signature is canonical: publication order and member order are not
//          meaning, so they are sorted out.

import type { ReportFiltersChange, VisualRef } from "./types";
import { getReportFilters } from "./publishers";
import { getCrossFilters } from "./selections";
import { allPageInteractions } from "./interactions";

const listeners = new Set<(change: ReportFiltersChange) => void>();

const SEP = "\u0000";

function pageKey(sheetId: string, connectionId: string): string {
  return `p${SEP}${sheetId}${SEP}${connectionId}`;
}

function targetKey(ref: VisualRef): string {
  return `t${SEP}${ref.kind}${SEP}${ref.id}`;
}

function refKey(ref: VisualRef | null): string {
  return ref ? `${ref.kind}:${ref.id}` : "";
}

/** Every resolvable thing the seam holds, grouped by what it reaches. */
function signature(): Map<string, string> {
  const grouped = new Map<string, string[]>();
  const add = (key: string, entry: string): void => {
    const list = grouped.get(key);
    if (list) list.push(entry);
    else grouped.set(key, [entry]);
  };

  const active = new Set<string>();

  for (const f of getReportFilters()) {
    if (f.sourceRef) active.add(refKey(f.sourceRef));
    const entry = JSON.stringify([
      "f",
      f.publisher,
      f.sourceId,
      f.sourceName,
      refKey(f.sourceRef),
      f.field,
      f.filterLevel,
      [...f.includedKeys].sort(),
    ]);
    switch (f.scope.kind) {
      case "page":
        add(pageKey(f.scope.sheetId, f.connectionId), entry);
        break;
      case "pages":
        for (const id of f.scope.sheetIds) add(pageKey(id, f.connectionId), entry);
        break;
      case "all":
        add(pageKey("*", f.connectionId), entry);
        break;
      case "visuals":
        for (const t of f.scope.targets) add(targetKey(t), entry);
        break;
    }
  }

  const interactions = allPageInteractions();
  for (const sel of getCrossFilters()) {
    active.add(refKey(sel.source));
    const entry = JSON.stringify([
      "s",
      refKey(sel.source),
      sel.sourceName,
      sel.fields,
      sel.tuples.map((t) => JSON.stringify(t)).sort(),
      interactions.get(sel.pageSheetId)?.defaultMode ?? "",
    ]);
    add(pageKey(sel.pageSheetId, sel.connectionId), entry);
  }

  for (const [page, held] of interactions) {
    for (const pair of held.pairs) {
      if (!active.has(refKey(pair.source))) continue;
      add(targetKey(pair.target), JSON.stringify(["i", page, refKey(pair.source), pair.mode]));
    }
  }

  const out = new Map<string, string>();
  for (const [key, list] of grouped) out.set(key, list.sort().join("\u0001"));
  return out;
}

function changeBetween(before: Map<string, string>, after: Map<string, string>): ReportFiltersChange | null {
  const pages: ReportFiltersChange["pages"] = [];
  const targets: VisualRef[] = [];
  for (const key of new Set([...before.keys(), ...after.keys()])) {
    if (before.get(key) === after.get(key)) continue;
    const parts = key.split(SEP);
    if (parts[0] === "p") pages.push({ sheetId: parts[1], connectionId: parts.slice(2).join(SEP) });
    else targets.push({ kind: parts[1] as VisualRef["kind"], id: parts.slice(2).join(SEP) });
  }
  if (pages.length === 0 && targets.length === 0) return null;
  return { pages, targets };
}

/**
 * Run `mutate` (one state change of this seam) and announce what it moved --
 * nothing at all when it moved nothing. Internal to the seam.
 */
export function runChange(mutate: () => void): void {
  const before = signature();
  mutate();
  const change = changeBetween(before, signature());
  if (!change) return;
  for (const listener of [...listeners]) {
    try {
      listener(change);
    } catch (err) {
      // One consumer's failure must not keep the next one stale.
      console.warn("[reportFilters] A listener failed:", err);
    }
  }
}

/** Subscribe to report-filter changes. Returns an unsubscribe function. */
export function onReportFiltersChange(cb: (c: ReportFiltersChange) => void): () => void {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}
