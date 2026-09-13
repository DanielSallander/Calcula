//! FILENAME: app/extensions/Sorting/lib/sortHelpers.ts
// PURPOSE: Helper functions for the Sort dialog.
// CONTEXT: Detects sort range, reads column headers, and scans for unique colors.

import {
  detectDataRegion,
  getViewportCells,
  indexToCol,
  getStyle,
  getRangeIcons,
} from "@api/lib";
import type { IconSetType } from "@api/lib";
import type { Selection } from "@api/types";

// ============================================================================
// Range Detection
// ============================================================================

/**
 * Detect the sort range from the current selection.
 * If the selection is a single cell, expands to the contiguous data region.
 * Otherwise, uses the selection bounds directly.
 */
export async function detectSortRange(
  selection: Selection,
): Promise<{ startRow: number; startCol: number; endRow: number; endCol: number } | null> {
  const sr = Math.min(selection.startRow, selection.endRow);
  const sc = Math.min(selection.startCol, selection.endCol);
  const er = Math.max(selection.startRow, selection.endRow);
  const ec = Math.max(selection.startCol, selection.endCol);

  // Single cell: auto-detect region
  if (sr === er && sc === ec) {
    const region = await detectDataRegion(sr, sc);
    if (!region) return null;
    return {
      startRow: region[0],
      startCol: region[1],
      endRow: region[2],
      endCol: region[3],
    };
  }

  // Multi-cell selection: use as-is
  return { startRow: sr, startCol: sc, endRow: er, endCol: ec };
}

// ============================================================================
// Column Headers
// ============================================================================

/**
 * Get display names for columns in a range.
 * If hasHeaders is true, reads the first row values as header names.
 * Falls back to column letters (A, B, C...) for empty headers or when hasHeaders is false.
 */
export async function getColumnDisplayNames(
  startRow: number,
  startCol: number,
  endCol: number,
  hasHeaders: boolean,
): Promise<string[]> {
  const colCount = endCol - startCol + 1;
  const headers: string[] = [];

  if (hasHeaders) {
    const cells = await getViewportCells(startRow, startCol, startRow, endCol);
    const cellMap = new Map(cells.map((c) => [c.col, c.display]));

    for (let col = startCol; col <= endCol; col++) {
      const display = cellMap.get(col);
      if (display && display.trim().length > 0) {
        headers.push(display.trim());
      } else {
        // Fallback to column letter for empty header cells
        headers.push(`Column ${indexToCol(col)}`);
      }
    }
  } else {
    for (let col = startCol; col <= endCol; col++) {
      headers.push(`Column ${indexToCol(col)}`);
    }
  }

  return headers;
}

/**
 * Get row display names for left-to-right sorting.
 * Reads the first column values or falls back to row numbers.
 */
export async function getRowDisplayNames(
  startRow: number,
  endRow: number,
  startCol: number,
  hasHeaders: boolean,
): Promise<string[]> {
  const names: string[] = [];

  if (hasHeaders) {
    const cells = await getViewportCells(startRow, startCol, endRow, startCol);
    const cellMap = new Map(cells.map((c) => [c.row, c.display]));

    for (let row = startRow; row <= endRow; row++) {
      const display = cellMap.get(row);
      if (display && display.trim().length > 0) {
        names.push(display.trim());
      } else {
        names.push(`Row ${row + 1}`);
      }
    }
  } else {
    for (let row = startRow; row <= endRow; row++) {
      names.push(`Row ${row + 1}`);
    }
  }

  return names;
}

// ============================================================================
// Color Scanning
// ============================================================================

/**
 * Scan a column for unique background or font colors.
 * Returns an array of distinct CSS color strings found in the column.
 */
export async function getUniqueColorsInColumn(
  startRow: number,
  endRow: number,
  col: number,
  type: "cellColor" | "fontColor",
): Promise<string[]> {
  const cells = await getViewportCells(startRow, col, endRow, col);
  const colorSet = new Set<string>();

  for (const cell of cells) {
    if (cell.styleIndex === 0 && type === "cellColor") {
      // Default style - skip transparent/no background
      continue;
    }

    try {
      const style = await getStyle(cell.styleIndex);
      const color = type === "cellColor" ? style.backgroundColor : style.textColor;

      // Skip default/transparent colors
      if (
        color &&
        color !== "transparent" &&
        color !== "rgba(0, 0, 0, 0)" &&
        color !== "#000000" // Skip default black text
      ) {
        colorSet.add(color.toLowerCase());
      }
    } catch {
      // Skip cells with invalid style indices
    }
  }

  return Array.from(colorSet);
}

// ============================================================================
// Icon order values (BUG-0104)
// ============================================================================

/** One icon a column actually shows: the set AND the index within it. */
export interface IconChoice {
  iconSet: IconSetType;
  iconIndex: number;
}

/**
 * Encode an icon choice plus a direction as one `<select>` value.
 *
 * The SET travels with the INDEX. An index alone does not identify an icon —
 * that was BUG-0107, where a disabled rule's glyph family was handed to another
 * rule's index — and the backend's `SortField.icon` requires both halves for the
 * same reason.
 *
 * Extracted from the dialog rather than left inline because the decode is the
 * half that can silently go wrong: a `split("|")` that disagrees with its
 * encoder produces `NaN` or `undefined` and the sort is refused with a message
 * about an icon the user definitely chose.
 */
export function encodeIconOrderValue(icon: IconChoice, onTop: boolean): string {
  return `${icon.iconSet}|${icon.iconIndex}|${onTop ? "top" : "bottom"}`;
}

/**
 * The inverse. Returns `null` for the "no icons found" placeholder, which is a
 * real option the dropdown renders when nothing in the column shows an icon —
 * choosing it must leave the level with NO icon rather than a malformed one,
 * so the backend's refusal names the true reason.
 */
export function decodeIconOrderValue(
  value: string,
): { icon: IconChoice | null; onTop: boolean } {
  const [iconSet, iconIndex, direction] = value.split("|");
  const onTop = direction === "top";
  if (!iconSet) return { icon: null, onTop };
  // The EMPTY index is rejected before `Number` sees it, because `Number("")`
  // is 0 — so a missing index would decode as the set's LOWEST icon and the
  // sort would run, correctly, on an icon nobody chose. That silent-wrong-
  // answer is the class BUG-0104 is about, and this decoder had it until its
  // own test caught it.
  if (iconIndex === undefined || iconIndex === "") return { icon: null, onTop };
  const parsed = Number(iconIndex);
  if (!Number.isInteger(parsed) || parsed < 0) return { icon: null, onTop };
  return { icon: { iconSet: iconSet as IconSetType, iconIndex: parsed }, onTop };
}

/**
 * A human label for an icon choice.
 *
 * Positional rather than pictorial on purpose. The glyph families are named by
 * their set ("ThreeTrafficLights1"), and a user picking one out of a dropdown
 * needs to know WHICH of the three it is — Excel shows the glyph, and until the
 * row can render one, "icon 2" is the honest substitute. A bare set name would
 * be silently ambiguous for every multi-icon set.
 */
export function iconLabel(icon: IconChoice): string {
  return `${icon.iconSet} — icon ${icon.iconIndex + 1}`;
}

/**
 * The distinct icons a range shows, in the set's own order.
 *
 * WHY THE BACKEND ANSWERS THIS and the colour scan does not. A cell's colour is
 * a property of its STYLE, which the frontend reads directly. A cell's ICON is
 * the outcome of evaluating the conditional-format rule cascade — priority
 * order, `enabled`, `stopIfTrue`, and thresholds usually relative to RANGE
 * STATISTICS. Re-deriving that here is exactly the mistake BUG-0107 was, so this
 * asks the one evaluator and reads `iconSet` off the result rather than
 * searching the rule list for something that looks right.
 */
export async function getUniqueIconsInColumn(
  startRow: number,
  endRow: number,
  absoluteCol: number,
): Promise<IconChoice[]> {
  return getRangeIcons(startRow, absoluteCol, endRow, absoluteCol);
}

// ============================================================================
// Seeding: the level must CARRY what the dropdown SHOWS
// ============================================================================

/**
 * The icon the level should be written with, or `null` to leave it alone.
 *
 * WHY THIS IS A FUNCTION AND NOT TWO LINES IN THE COMPONENT. The order dropdown
 * is a controlled `<select>` that falls back to the first available entry when
 * the level names none, so the person sees an icon selected the instant the
 * list arrives — and a `<select>` fires NO change event for an option that is
 * already shown as chosen. Leave the level at `icon: undefined` and every such
 * sort is refused by `validate_sort_fields` with "names no icon. Choose which
 * icon to bring to the top.", a correct message about a choice the dialog is
 * displaying. That is BUG-0104's own symptom, and it survived inside BUG-0104's
 * first fix precisely because the display fallback made the dialog LOOK right.
 * Extracted so that disagreement is testable without rendering anything.
 *
 * Absence is not the only way they disagree. Changing the Column dropdown
 * rewrites `columnKey` and leaves the icon untouched, so the level can hold an
 * icon the NEW column never shows: the `<select>` renders blank for a value
 * matching no option, and the sort keys on an icon zero cells carry — it moves
 * nothing and reports success. So this reconciles on MEMBERSHIP, not on
 * absence.
 *
 * Returns `null` when no write is needed, including when the list is empty:
 * an empty list is what an in-flight fetch looks like, and clearing a good
 * icon on the way to the answer would make the dialog flicker between states.
 */
export function seedIconChoice(
  current: IconChoice | undefined,
  available: IconChoice[],
): IconChoice | null {
  if (available.length === 0) return null;
  const stillShown =
    current !== undefined &&
    available.some(
      (ic) => ic.iconSet === current.iconSet && ic.iconIndex === current.iconIndex,
    );
  return stillShown ? null : available[0];
}

/**
 * The same reconciliation for a colour level.
 *
 * The colour branch fails DIFFERENTLY and worse. `SortOn::CellColor` with no
 * colour named reaches the backend's `(Some(a), Some(b), None)` arm, which
 * compares the two colour strings — so the sort SUCCEEDS and orders rows by hex
 * code while the dialog says "bring this colour to the top". Nothing refuses,
 * nothing warns, and the result looks like a colour sort. Case-insensitive
 * because the scan and the level can spell the same colour either way.
 */
export function seedColorChoice(
  current: string | undefined,
  available: string[],
): string | null {
  if (available.length === 0) return null;
  const stillShown =
    current !== undefined &&
    available.some((c) => c.toLowerCase() === current.toLowerCase());
  return stillShown ? null : available[0];
}
