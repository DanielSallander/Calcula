//! FILENAME: app/extensions/Charts/lib/customOrderLists.ts
// PURPOSE: Resolve a chart sort's `customOrder` — a fill-list name or an explicit
//          domain — into the ordered labels the sort ranks rows by.
// CONTEXT: The list MEMBERS are the grid's, never Charts'. They come from the
//          fill-list registry through @api/fillLists, which is where the user's
//          own lists live too, so "order this chart Mon..Sun" and "drag-fill
//          Mon..Sun" can never disagree. Only the NAME spellings are mapped here:
//          the Sort dialog and the backend's SortField.customOrder know the four
//          built-ins as "weekdays"/"weekdaysShort"/"months"/"monthsShort", while
//          the registry keys them by id ("builtin.weekday.full", ...). Neither
//          spelling is exported as a shared constant anywhere, so the mapping is
//          pinned by a test (ordinalDomainOrder.test.ts) rather than trusted.

import { FillListRegistry } from "@api/fillLists";

/** The Sort-dialog / backend names for the four built-in lists → fill-list registry ids. */
export const BUILT_IN_CUSTOM_ORDER_LISTS: Readonly<Record<string, string>> = {
  weekdays: "builtin.weekday.full",
  weekdaysShort: "builtin.weekday.short",
  months: "builtin.month.full",
  monthsShort: "builtin.month.short",
};

/** The four built-in `customOrder` names, in declaration order (schema + docs read this). */
export const BUILT_IN_CUSTOM_ORDER_NAMES = Object.keys(BUILT_IN_CUSTOM_ORDER_LISTS);

/** Comparison form of a label: trimmed and case-folded, the way the grid matches lists. */
export function customOrderKey(label: string): string {
  return label.trim().toLowerCase();
}

/**
 * Resolve a `customOrder` declaration into ordered labels, or null when a name
 * matches no list (or the declaration is empty).
 *
 * An unresolvable NAME is deliberately null rather than a one-item list: the
 * backend's resolve_custom_order falls back to splitting the string on commas, so
 * a typo there quietly becomes a list containing only the typo — an order that
 * cannot change anything. Here the caller reports it instead.
 */
export function resolveCustomOrder(order: string | string[]): string[] | null {
  if (Array.isArray(order)) return order.length > 0 ? [...order] : null;

  const wanted = customOrderKey(order);
  if (wanted === "") return null;

  // Never index the alias table with the caller's string — match it, so an
  // inherited property name ("constructor") cannot resolve to anything.
  const aliasId = Object.entries(BUILT_IN_CUSTOM_ORDER_LISTS)
    .find(([name]) => customOrderKey(name) === wanted)?.[1];

  const lists = FillListRegistry.getAllLists();
  const list = aliasId
    ? lists.find((l) => l.id === aliasId)
    : lists.find((l) => customOrderKey(l.id) === wanted || customOrderKey(l.name) === wanted);

  return list && list.items.length > 0 ? [...list.items] : null;
}
