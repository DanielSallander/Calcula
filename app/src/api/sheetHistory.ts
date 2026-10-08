//! FILENAME: app/src/api/sheetHistory.ts
// PURPOSE: The PAGE HISTORY a "Back" button walks (Canvas contract §3/§4.4,
//          Power BI's Back action): which sheets were active, in order, so
//          Back can go to the one before -- and a second Back to the one
//          before that.
// CONTEXT: Nothing in Calcula remembered where the reader came from: Ctrl+Page
//          Up (`previousSheet`) is the ADJACENT sheet, not the previous one,
//          and the Name Box / Go To keep no trail. A Back button needs exactly
//          that trail, and it is not a Controls concern -- a future keyboard
//          shortcut or a hyperlink "back" wants the same list -- so it is a
//          small feature-neutral seam beside @api/sheetSwitch, which already
//          owns HOW a switch is made.
//
//          WHAT IS A VISIT. Every active-sheet change announces itself on the
//          bus as AppEvents.SHEET_CHANGED -- the tab strip, the Name Box, Go To,
//          @api/sheetSwitch, a script's activate -- so the history listens
//          there and to nothing else. A repeat of the page it already ends on
//          is not a visit.
//
//          WHY BACK'S OWN SWITCH IS NOT A VISIT. Back POPS the page being left
//          and switches to the page the history now ends on; the switch's own
//          SHEET_CHANGED then names that same last page and is dropped as a
//          repeat. Recording it would make a second Back bounce between two
//          pages instead of walking further back, which is not what Power BI's
//          Back -- or a browser's -- does.
//
//          KEYED BY NAME, RESOLVED LIVE. A sheet's index shifts when a sheet is
//          inserted, deleted or moved before it, and the bus's SHEET_CHANGED
//          carries the index and the name, not the stable uuid. Names are
//          unique in a workbook, and the bus also announces a rename
//          (SHEET_RENAMED, the entries follow) and a delete (SHEET_DELETED, the
//          entries go). Back resolves the name against the LIVE sheet list at
//          the moment of the click, and skips a page that has since been
//          deleted or hidden rather than switching to the wrong one.
//
//          A NEW DOCUMENT STARTS AFRESH (AFTER_OPEN / AFTER_NEW): "back" never
//          crosses into a workbook that is no longer open.
//
// LIFETIME. `startSheetHistory()` installs the listeners and seeds the history
// with the page active now (without the seed, Back from the second page a
// reader opens would have nowhere to go). It is reference-counted: the Controls
// extension starts it for its Back buttons, and any other consumer may too;
// the listeners go when the last starter stops.

import { getSheets } from "../core/lib/tauri-api";
import { AppEvents, onAppEvent } from "./events";
import { activateSheet } from "./sheetSwitch";

/** The most pages the history keeps; older ones fall off the front. */
export const SHEET_HISTORY_LIMIT = 50;

/** What a Back did. `moved: false` is "there is no earlier page to go to". */
export type GoBackOutcome = { moved: true; sheetName: string } | { moved: false };

let history: string[] = [];
let starters = 0;
let stopListening: (() => void) | null = null;

function visit(name: string | undefined): void {
  if (!name) return;
  if (history[history.length - 1] === name) return;
  history.push(name);
  if (history.length > SHEET_HISTORY_LIMIT) history = history.slice(history.length - SHEET_HISTORY_LIMIT);
}

/** Drop consecutive repeats (a deleted page between two visits of another). */
function collapseRepeats(): void {
  history = history.filter((name, i) => i === 0 || history[i - 1] !== name);
}

async function seedFromActiveSheet(): Promise<void> {
  try {
    const { sheets, activeIndex } = await getSheets();
    const active = sheets.find((s) => s.index === activeIndex);
    if (history.length === 0) visit(active?.name);
  } catch (err) {
    // No history is an honest answer ("nothing to go back to"); a guess is not.
    console.warn("[sheetHistory] Could not read the active sheet to seed the history:", err);
  }
}

function install(): () => void {
  const offs = [
    onAppEvent<{ sheetName?: string }>(AppEvents.SHEET_CHANGED, (d) => visit(d?.sheetName)),
    onAppEvent<{ oldName?: string; newName?: string }>(AppEvents.SHEET_RENAMED, (d) => {
      if (!d?.oldName || !d.newName) return;
      history = history.map((n) => (n === d.oldName ? d.newName! : n));
    }),
    onAppEvent<{ sheetName?: string }>(AppEvents.SHEET_DELETED, (d) => {
      if (!d?.sheetName) return;
      history = history.filter((n) => n !== d.sheetName);
      collapseRepeats();
    }),
    onAppEvent(AppEvents.AFTER_OPEN, () => {
      history = [];
      void seedFromActiveSheet();
    }),
    onAppEvent(AppEvents.AFTER_NEW, () => {
      history = [];
      void seedFromActiveSheet();
    }),
  ];
  return () => {
    for (const off of offs) off();
  };
}

/**
 * Start recording the page history. Returns the stop function for the
 * caller's cleanup list; the listeners go when the last starter stops.
 */
export function startSheetHistory(): () => void {
  starters++;
  if (!stopListening) {
    stopListening = install();
    void seedFromActiveSheet();
  }
  let stopped = false;
  return () => {
    if (stopped) return;
    stopped = true;
    starters = Math.max(0, starters - 1);
    if (starters === 0 && stopListening) {
      stopListening();
      stopListening = null;
    }
  };
}

/** Whether a Back has an earlier page to try (it may still find it deleted). */
export function canGoBack(): boolean {
  return history.length > 1;
}

/**
 * Go to the page before the current one, as a tab click would
 * (@api/sheetSwitch). Pages deleted or hidden since they were visited are
 * skipped. Resolves `{ moved: false }`, switching nothing, when there is no
 * earlier page.
 */
export async function goBackSheet(): Promise<GoBackOutcome> {
  const { sheets, activeIndex } = await getSheets();
  const visible = (name: string) =>
    sheets.find((s) => s.name === name && (s.visibility ?? "visible") === "visible");
  const current = sheets.find((s) => s.index === activeIndex)?.name;
  // The bus may have missed a switch (one made before the history started):
  // the history must end on the page the reader is actually looking at, or
  // Back would "go back" to it.
  if (current && history[history.length - 1] !== current) visit(current);
  if (history.length < 2) return { moved: false };

  const leaving = history.pop()!;
  while (history.length > 0) {
    const candidate = history[history.length - 1];
    const sheet = visible(candidate);
    if (sheet && candidate !== leaving) {
      await activateSheet(sheet.index);
      return { moved: true, sheetName: candidate };
    }
    history.pop();
  }
  // Nothing earlier survives: the page being left is the whole history again.
  history = [leaving];
  return { moved: false };
}

/** Test seam: the history as it stands, oldest first. */
export function readSheetHistoryForTest(): string[] {
  return [...history];
}

/** Test/reset hook: forget the history and every listener. */
export function resetSheetHistory(): void {
  history = [];
  starters = 0;
  if (stopListening) {
    stopListening();
    stopListening = null;
  }
}
