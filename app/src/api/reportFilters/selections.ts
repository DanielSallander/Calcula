//! FILENAME: app/src/api/reportFilters/selections.ts
// PURPOSE: Visual cross-filter selections (Power BI's "click a bar, the page
//          follows"): one selection per SOURCE visual, as member-KEY tuples
//          over that visual's grouping fields.
// CONTEXT: P4 (G4). A selection is VIEW STATE: no undo, no dirty flag, never
//          saved. It survives page switches in the session; it is cleared on
//          File > New / Open (the reset `startReportFilters` installs), when its
//          source is deleted (the owning family calls clearCrossFilter), and
//          when its members vanish (pruneCrossFilter). Clear All Slicers does
//          NOT clear it -- Power BI keeps visual selections apart from slicers.
//
//          A selection never holds a label: keys only (P2 `MemberRef.key`, ""
//          for the blank member, ruling Q8).

import { AppEvents, onAppEvent } from "../events";
import type { CrossFilterSelection, MemberPath, VisualRef } from "./types";
import { runChange } from "./changes";
import { cleanVisualRef } from "./publishers";

/** Selections by source ref key ("kind:id"). */
const bySource = new Map<string, CrossFilterSelection>();

function keyOf(ref: VisualRef): string {
  return `${ref.kind}:${ref.id}`;
}

function freezeSelection(sel: CrossFilterSelection): CrossFilterSelection {
  return Object.freeze({
    source: Object.freeze({ ...sel.source }),
    sourceName: sel.sourceName,
    pageSheetId: sel.pageSheetId,
    connectionId: sel.connectionId,
    fields: Object.freeze([...sel.fields]),
    tuples: Object.freeze(sel.tuples.map((t) => Object.freeze([...t]))),
  });
}

/** Distinct tuples, in first-seen order. */
function distinctTuples(tuples: readonly (readonly string[])[]): string[][] {
  const seen = new Set<string>();
  const out: string[][] = [];
  for (const t of tuples) {
    const k = JSON.stringify(t);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push([...t]);
  }
  return out;
}

/**
 * The selection checked and canonical, or a sentence saying why it is not one.
 * A malformed selection is REFUSED (thrown), never half-held: a tuple whose
 * length does not match its fields cannot be read by any target.
 */
function normalized(sel: CrossFilterSelection): CrossFilterSelection | string {
  const source = cleanVisualRef(sel?.source);
  if (!source) return "a cross-filter selection needs a source visual (a chart, pivot or slicer with an id)";
  if (typeof sel.pageSheetId !== "string" || sel.pageSheetId === "") return "a cross-filter selection needs its page's sheet id";
  if (typeof sel.connectionId !== "string" || sel.connectionId === "") return "a cross-filter selection needs a model connection";
  const fields = Array.isArray(sel.fields) ? [...sel.fields] : [];
  if (fields.length === 0 || fields.some((f) => typeof f !== "string" || f === "")) {
    return "a cross-filter selection needs at least one field, each a \"Table.Column\" name";
  }
  if (new Set(fields).size !== fields.length) return "a cross-filter selection names a field twice";
  if (!Array.isArray(sel.tuples)) return "a cross-filter selection needs a list of tuples";
  for (const t of sel.tuples) {
    if (!Array.isArray(t) || t.length !== fields.length || t.some((k) => typeof k !== "string")) {
      return `every tuple must hold one member key per field (${fields.length})`;
    }
  }
  return {
    source,
    sourceName: typeof sel.sourceName === "string" ? sel.sourceName : "",
    pageSheetId: sel.pageSheetId,
    connectionId: sel.connectionId,
    fields,
    tuples: distinctTuples(sel.tuples),
  };
}

/** Replace `sel.source`'s selection with `sel`. No tuples clears it. Throws on a malformed selection. */
export function setCrossFilter(sel: CrossFilterSelection): void {
  const clean = normalized(sel);
  if (typeof clean === "string") throw new Error(clean);
  runChange(() => {
    if (clean.tuples.length === 0) bySource.delete(keyOf(clean.source));
    else bySource.set(keyOf(clean.source), freezeSelection(clean));
  });
}

/**
 * Ctrl+click: toggle one datum in `source`'s selection. A path already held is
 * taken out (the last one out clears the selection); a new one is added. A
 * path over a DIFFERENT field set (a legend entry after a bar) replaces the
 * selection with that one datum on the same page and model.
 *
 * A source with no selection has no page or model to add to: nothing happens,
 * and the caller starts one with setCrossFilter.
 */
export function addToCrossFilter(source: VisualRef, path: MemberPath): void {
  const ref = cleanVisualRef(source);
  if (!ref) return;
  const held = bySource.get(keyOf(ref));
  if (!held) return;
  const coords = [...(path ?? [])];
  if (coords.length === 0 || coords.some((c) => typeof c?.field !== "string" || typeof c?.key !== "string")) return;
  const pathFields = coords.map((c) => c.field);
  if (new Set(pathFields).size !== pathFields.length) return;

  const sameFields = pathFields.length === held.fields.length && held.fields.every((f) => pathFields.includes(f));
  if (!sameFields) {
    setCrossFilter({ ...held, fields: pathFields, tuples: [coords.map((c) => c.key)] });
    return;
  }
  const tuple = held.fields.map((f) => coords.find((c) => c.field === f)!.key);
  const k = JSON.stringify(tuple);
  const without = held.tuples.filter((t) => JSON.stringify(t) !== k);
  const tuples = without.length === held.tuples.length ? [...held.tuples, tuple] : without;
  setCrossFilter({ ...held, tuples });
}

/** Clear one source's selection (its source was deleted, or the user cleared it). */
export function clearCrossFilter(source: VisualRef): void {
  const ref = cleanVisualRef(source);
  if (!ref || !bySource.has(keyOf(ref))) return;
  runChange(() => {
    bySource.delete(keyOf(ref));
  });
}

/** Clear every selection on one page, or (undefined) every selection anywhere. */
export function clearCrossFilters(pageSheetId?: string): void {
  const doomed = [...bySource.entries()].filter(([, s]) => pageSheetId === undefined || s.pageSheetId === pageSheetId);
  if (doomed.length === 0) return;
  runChange(() => {
    for (const [k] of doomed) bySource.delete(k);
  });
}

/** The selections on one page, or every selection; ordered by source ("kind:id"). */
export function getCrossFilters(pageSheetId?: string): readonly CrossFilterSelection[] {
  return [...bySource.entries()]
    .filter(([, s]) => pageSheetId === undefined || s.pageSheetId === pageSheetId)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([, s]) => s);
}

/**
 * Keep only the tuples of `source`'s selection that still exist (its members
 * were refreshed away). A selection left with no tuple is cleared.
 */
export function pruneCrossFilter(
  source: VisualRef,
  liveTuples: (fields: readonly string[], tuple: readonly string[]) => boolean,
): void {
  const ref = cleanVisualRef(source);
  if (!ref) return;
  const held = bySource.get(keyOf(ref));
  if (!held) return;
  const kept = held.tuples.filter((t) => liveTuples(held.fields, t));
  if (kept.length === held.tuples.length) return;
  setCrossFilter({ ...held, tuples: kept });
}

/**
 * Clear every selection whose SOURCE (a visual of `kind`) is no longer among
 * `liveIds` -- optionally only the selections held on page `pageSheetId`.
 * A family calls it from its store reload, so a visual that vanished by ANY
 * route (undo of its creation, a script/MCP/AI removal, a sheet delete, a
 * reload) takes its selection with it, as an explicit Delete does: a page must
 * never stay filtered by a visual that is no longer there.
 */
export function pruneMissingCrossFilterSources(
  kind: VisualRef["kind"],
  liveIds: Iterable<string>,
  pageSheetId?: string,
): void {
  const live = new Set(liveIds);
  const doomed = [...bySource.entries()].filter(
    ([, s]) =>
      s.source.kind === kind &&
      !live.has(s.source.id) &&
      (pageSheetId === undefined || s.pageSheetId === pageSheetId),
  );
  if (doomed.length === 0) return;
  runChange(() => {
    for (const [k] of doomed) bySource.delete(k);
  });
}

/** Whether `source` has a selection now. */
export function isCrossFilterSource(source: VisualRef): boolean {
  const ref = cleanVisualRef(source);
  return ref !== null && bySource.has(keyOf(ref));
}

/**
 * Install the File > New / Open reset. Reads AppEvents only HERE, never at
 * module load (suites that mock @api/events partially must still import this
 * module; reportPages.ts:266-273). Called by startReportFilters.
 */
export function installSelectionReset(): () => void {
  const offs = [AppEvents.AFTER_NEW, AppEvents.AFTER_OPEN].map((name) => onAppEvent(name, () => clearCrossFilters()));
  return () => {
    for (const off of offs) off();
  };
}
