//! FILENAME: app/extensions/GoToSpecial/lib/goTo.ts
// PURPOSE: Excel's Go To (F5 / Ctrl+G, Home > Find & Select > Go To...): go to
//          what a reference names, and remember where you came FROM so the next
//          Go To offers the way back.
// CONTEXT: Home tab 2026-10-04 (navigate.goTo). F5 used to focus the Name Box
//          and Ctrl+G ran Go To Special. The navigation itself is the Name
//          Box's, through @api/referenceNavigation -- addresses, ranges on other
//          sheets, table references, defined names, tables, a floating grid's
//          own addresses -- so the dialog and the box cannot disagree. What is
//          Go To's own: Excel lists the locations it came from (the four most
//          recent, newest first) above the workbook's names, and puts the
//          newest in the Reference box, so F5 then Enter goes BACK.

import { getGridStateSnapshot } from "@api/grid";
import { getAllNamedRanges } from "@api";
import { getAllTables } from "@api/backend";
import { columnToLetter } from "@api/types";
import { navigateToReference, type ReferenceNavigationResult } from "@api/referenceNavigation";

/** Excel keeps the four most recent locations. */
export const MAX_RECENT_LOCATIONS = 4;

/** Excel's sentence for a reference that names nothing. */
export const REFERENCE_NOT_VALID = "Reference isn't valid.";

let recent: string[] = [];

/** The locations Go To came from, newest first. */
export function recentLocations(): readonly string[] {
  return recent;
}

/** Test hook. */
export function resetRecentLocations(): void {
  recent = [];
}

function rememberLocation(reference: string): void {
  recent = [reference, ...recent.filter((r) => r.toUpperCase() !== reference.toUpperCase())].slice(
    0,
    MAX_RECENT_LOCATIONS,
  );
}

/** A sheet name as a reference spells it: quoted when it is not a plain word. */
export function quoteSheetName(name: string): string {
  return /^[A-Za-z_][A-Za-z0-9_.]*$/.test(name) ? name : `'${name.replace(/'/g, "''")}'`;
}

/** Where the selection is now, as an absolute, sheet-qualified reference
 *  ("Sheet1!$A$1", "'My Sheet'!$B$2:$C$9"), or null with no selection. */
export function currentLocation(): string | null {
  const snapshot = getGridStateSnapshot();
  const sel = snapshot?.selection;
  if (!snapshot || !sel || snapshot.surface === "canvas") return null;
  const abs = (row: number, col: number): string => `$${columnToLetter(col)}$${row + 1}`;
  const r0 = Math.min(sel.startRow, sel.endRow);
  const r1 = Math.max(sel.startRow, sel.endRow);
  const c0 = Math.min(sel.startCol, sel.endCol);
  const c1 = Math.max(sel.startCol, sel.endCol);
  const ref = r0 === r1 && c0 === c1 ? abs(r0, c0) : `${abs(r0, c0)}:${abs(r1, c1)}`;
  return `${quoteSheetName(snapshot.sheetContext.activeSheetName)}!${ref}`;
}

/**
 * Go to `text`. On success the location left behind is remembered (it heads
 * the list and fills the Reference box next time). Text that names nothing is
 * Excel's "Reference isn't valid." -- a problem, like every other refusal.
 */
export async function goToReference(text: string): Promise<ReferenceNavigationResult> {
  const reference = text.trim();
  if (reference === "") return { kind: "problem", message: REFERENCE_NOT_VALID };
  const from = currentLocation();
  const outcome = await navigateToReference(reference);
  if (outcome.kind === "unclaimed") return { kind: "problem", message: REFERENCE_NOT_VALID };
  if (outcome.kind === "done" && from !== null) rememberLocation(from);
  return outcome;
}

/** The Go To list: recent locations first, then every defined name and table
 *  (one namespace), case-insensitively sorted. */
export async function listGoToTargets(): Promise<string[]> {
  const [names, tables] = await Promise.all([
    getAllNamedRanges().catch(() => []),
    getAllTables().catch(() => []),
  ]);
  const workbook = [...new Set([...names.map((n) => n.name), ...tables.map((t) => t.name)])].sort((a, b) => {
    const l = a.toUpperCase();
    const r = b.toUpperCase();
    return l === r ? 0 : l < r ? -1 : 1;
  });
  return [...recent, ...workbook.filter((n) => !recent.includes(n))];
}
