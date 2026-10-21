//! FILENAME: app/src/api/pivotMembers.ts
// PURPOSE: The ONE reading of a member for every consumer: identity from the
//          KEY, display from the LABEL (P2, app locale everywhere).
// CONTEXT: The Rust boundary carries every pivot item, BI column value, slicer
//          item and design-query header member as `MemberRef { key, label }`
//          (`api_types.rs`). `key` is invariant canonical text: selections,
//          filters, page filters, GETPIVOTDATA and cross-filter tuples match
//          on it. `label` is the app-locale display. A label is never parsed
//          back into a key (BUG-0166 precedent: a localised label used as an
//          identity matched nothing in another locale).
//
//          `pivotCellLabel` (Pivot extension) was DELETED, not aliased: it
//          named an item by its FORMATTED text, which is display, and every
//          caller had to choose which of the two it meant.

import type { MemberRef } from "./types";
import type { PivotCellData, PivotCellValue } from "./pivotTypes";
import { formatNumber } from "./locale";
import { INVARIANT_LOCALE, parseDateIn } from "../core/lib/locale";

export type { MemberRef };

/** A pivot cell value as INVARIANT text: the spelling Rust's member key uses
 *  for a value (`format!("{}", n)` for a number; TRUE/FALSE; the text as is). */
function invariantValueText(value: PivotCellValue | undefined): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "number") return String(value);
  if (typeof value === "boolean") return value ? "TRUE" : "FALSE";
  return value;
}

/**
 * The IDENTITY of the item a pivot cell names: `member.key` when the backend
 * attached a member, else the cell's value as invariant text. Never the
 * formatted or localised text -- an unformatted numeric header is "2013", never
 * "" (BUG-0454), and a de-DE header that reads "1234,5" is still "1234.5".
 * Menus that FILTER, HIDE, TOGGLE or DRILL by item send this.
 */
export function pivotCellItemKey(cell: PivotCellData): string {
  if (cell.member) return cell.member.key;
  return invariantValueText(cell.value);
}

/**
 * What a pivot cell SHOWS: `member.label` when the backend attached a member,
 * else its formatted value, else its value in the app locale (a number in
 * General with the app's decimal separator). Menus that NAME an item in a
 * caption read this; nothing matches on it.
 */
export function pivotCellDisplayText(cell: PivotCellData): string {
  if (cell.member) return cell.member.label;
  if (cell.formattedValue) return cell.formattedValue;
  const value = cell.value;
  if (typeof value === "number" && Number.isFinite(value)) return formatNumber(value);
  return invariantValueText(value);
}

/**
 * A member KEY read as a number, INVARIANTLY ("3578.27"), or null when the key
 * is not a number (text, the blank member ""). Never reads a label: "1.234,5"
 * is not a key.
 */
export function memberKeyNumber(key: string): number | null {
  const trimmed = key.trim();
  if (trimmed === "") return null;
  const n = Number(trimmed);
  return Number.isFinite(n) ? n : null;
}

/**
 * A member KEY read as an Excel date serial, INVARIANTLY: an ISO date key
 * ("2024-03-01", "2024-03-01 13:04:05"), or null when the key is no date.
 */
export function memberKeyDate(key: string): number | null {
  return parseDateIn(INVARIANT_LOCALE, key);
}

/** The KEYS of `members`, in order: what a selection or a filter speaks. */
export function memberKeys(members: readonly MemberRef[]): string[] {
  return members.map((m) => m.key);
}

/**
 * A key -> label lookup over `members`, for a list that holds keys and shows
 * labels. A key it does not know shows as itself (a selection that names a
 * member no longer listed stays visible rather than blank).
 */
export function memberLabelOf(members: readonly MemberRef[]): (key: string) => string {
  const labels = new Map<string, string>();
  for (const m of members) labels.set(m.key, m.label);
  return (key: string) => labels.get(key) ?? key;
}
