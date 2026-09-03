//! FILENAME: app/src/api/scriptHost/scriptPreview/formSources.ts
// PURPOSE: Resolve a captured form layout's RANGE-FED content against the very
//          grid the preview run used — a choice list from `options: { range }`,
//          a table's `rows: { range }` — so those widgets paint with data
//          instead of empty.
// CONTEXT: 2026-09-03, TypeScript Forms follow-up (docs/design/open-items.md
//          §2.ab). The editor's form preview could seed a `bind`ing and nothing
//          else: a dropdown fed from A2:A20 opened with no entries at all, and
//          a table fed from a range painted no rows, which is the one thing an
//          author previews a form to check.
//
//          WHY HERE AND NOT IN THE BRIDGE. The preview grid is the run's own
//          copy of the workbook and it never leaves the rung — the report
//          carries cell VALUES for the cells the caller asked to read back, not
//          the grid. So the only place that can answer "what is in A2:A20" for
//          the run that just happened is the rung itself, at the moment it
//          still holds the copy. The alternative — handing the bridge a second
//          read of the live workbook — would seed the dropdown from data the
//          script never saw, which is exactly the lie the two-pass read-back
//          discipline exists to prevent.
//
//          THE SAME PURE HELPERS THE PRODUCTION HOST USES. `parseFormRange`,
//          `optionsFromCells` and `rowsFromCells` are `scriptFormBindings.ts`'s,
//          not re-implementations, so a preview's dropdown carries exactly the
//          entries a real `form.show` would build from the same cells —
//          deduplicated the same way, and clamped by the SAME
//          MAX_FORM_OPTIONS / MAX_FORM_TABLE_CELLS budgets. Two implementations
//          of one truth is one implementation and one lie.
//
//          PURE, so it is testable without a Worker. The rung's realm half
//          cannot run under jsdom at all (there is no `Worker`), and everything
//          decidable without one lives in a file like this for that reason.

import {
  collectFormSources,
  optionsFromCells,
  parseFormRange,
  rowsFromCells,
} from "../scriptFormBindings";
import { MAX_RANGE_CELLS } from "../validators";
import type { FormOption, FormSpec, FormValue } from "../scriptFormSpec";
import type { ScriptCell } from "../../scriptableObjects";
import { cellShape, type PreviewGrid } from "./grid";

/**
 * One widget's range-fed (or media-fed) content, as the preview resolved it.
 *
 * Either the content is here (`options` / `rows`) or `reason` says why a
 * preview could not produce it. Never both, and never neither: a widget whose
 * source resolved to nothing without a reason would paint empty and look like
 * a workbook with no data in it.
 */
export interface PreviewFormSourceSeed {
  name: string;
  kind: "options" | "rows" | "image";
  options?: FormOption[];
  rows?: FormValue[][];
  /** Why this source is unresolved in a preview; absent when it resolved. */
  reason?: string;
}

/**
 * An IMAGE is not resolvable here and is not guessed at.
 *
 * A `media:{sha256}` handle is resolved by the host's filesystem facade against
 * the workbook's media store — an IPC the preview realm has no business making,
 * and one whose answer is a data URL. Inventing a placeholder URL would paint
 * SOMETHING where the real form paints the author's picture, which is worse
 * than an empty frame that says why.
 */
export const PREVIEW_IMAGE_REASON =
  "an image is resolved from the workbook's media store; a preview does not resolve one";

/** Only the active sheet is copied for a preview — the rung's standing limit. */
export function offSheetSourceReason(sheetName: string): string {
  return `this range is on "${sheetName}"; only the active sheet is copied for a preview`;
}

/**
 * Resolve every range-fed source in a captured layout against the preview grid.
 *
 * The sheet rule is the rung's own: the copy holds ONE sheet, so a range
 * qualified with another sheet's name is declared unresolved rather than
 * answered from the active sheet's cells at the same coordinates — which would
 * be a different range's data under the right widget's label.
 */
export function resolveFormSourcesFromPreviewGrid(opts: {
  spec: FormSpec;
  grid: PreviewGrid;
  sheetNames: readonly string[];
  activeSheet: number;
}): PreviewFormSourceSeed[] {
  const { spec, grid, sheetNames, activeSheet } = opts;
  const activeName = sheetNames[activeSheet];
  const out: PreviewFormSourceSeed[] = [];
  for (const src of collectFormSources(spec)) {
    if (src.source.kind === "image") {
      out.push({ name: src.name, kind: "image", reason: PREVIEW_IMAGE_REASON });
      continue;
    }
    const kind = src.source.kind;
    try {
      const box = parseFormRange(src.source.range);
      if (box.sheetName !== null && !namesTheActiveSheet(box.sheetName, activeName)) {
        out.push({ name: src.name, kind, reason: offSheetSourceReason(box.sheetName) });
        continue;
      }
      const cells = readRectangle(grid, box);
      out.push(
        kind === "options"
          ? { name: src.name, kind, options: optionsFromCells(cells) }
          : { name: src.name, kind, rows: rowsFromCells(cells) },
      );
    } catch (e) {
      out.push({ name: src.name, kind, reason: e instanceof Error ? e.message : String(e) });
    }
  }
  return out;
}

/**
 * Exact first, then ignoring case — the host's own sheet-name rule
 * (resolveSheetRefIn).
 *
 * EXPORTED because a CELL `bind` has to answer the same question as a `range`
 * source. They did not: `options: { range: "Sheet1!A1:A3" }` resolved against
 * the copy while `bind: "Sheet1!B2"` — the very same sheet, spelled the very
 * same way — was declared off-sheet and previewed disabled. Two rules for one
 * question is one rule and one bug.
 *
 * Fails CLOSED on an unknown active sheet: with no name to compare against,
 * every qualified reference is treated as off-sheet rather than assumed to be
 * this one.
 */
export function namesTheActiveSheet(sheetName: string, activeName: string | undefined): boolean {
  if (activeName === undefined) return false;
  return sheetName === activeName || sheetName.toLowerCase() === activeName.toLowerCase();
}

/**
 * The cells of one range, as the shapes a script sees.
 *
 * Bounded by the SAME `MAX_RANGE_CELLS` the broker's range rows enforce in
 * production, and refused rather than clamped: `optionsFromCells` would happily
 * take the first 500 entries of a materialized 100-million-cell rectangle, but
 * materializing it is what the bound exists to prevent, and a preview must not
 * be the one surface where a runaway range is served.
 */
function readRectangle(
  grid: PreviewGrid,
  box: { startRow: number; startCol: number; endRow: number; endCol: number },
): ScriptCell[][] {
  const height = box.endRow - box.startRow + 1;
  const width = box.endCol - box.startCol + 1;
  const cellCount = height * width;
  if (cellCount > MAX_RANGE_CELLS) {
    throw new Error(
      `this range covers ${cellCount} cells; a range read is limited to ${MAX_RANGE_CELLS}`,
    );
  }
  const rows: ScriptCell[][] = [];
  for (let r = box.startRow; r <= box.endRow; r++) {
    const row: ScriptCell[] = [];
    for (let c = box.startCol; c <= box.endCol; c++) row.push(cellShape(grid, r, c));
    rows.push(row);
  }
  return rows;
}
