//! FILENAME: app/extensions/Pivot/lib/showAsRule.ts
// PURPOSE: Translate a value field's Show Values As between the editor's form
//          (the dialog's `showValuesAs` string plus a Base field / Base item)
//          and the backend's Excel-compatible `showAs` rule -- both ways.
// CONTEXT: The Value Field Settings dialog collects a Base field / Base item,
//          but the editor kept neither and sent only the plain `showValuesAs`
//          string -- which carries no base, so the backend had nothing to
//          resolve (`resolve_base_field_indices`, app/src-tauri/src/pivot/commands.rs)
//          and "Running Total In Region" left every value as it was (found live
//          2026-09-29, e2e fixall-pivot X1). The backend applies `showAs` over
//          the plain string. The way BACK matters as much: the update REPLACES
//          the value fields, so an editor seeded without the rule cleared it
//          on its first change after reopening.

import type { ShowAsCalculation, ShowAsRule, ShowValuesAs } from "@api/pivot";

/** The dialog's Show Values As values -> the backend's ShowAsCalculation names. */
const CALCULATION: Record<ShowValuesAs, ShowAsCalculation> = {
  normal: "none",
  percent_of_total: "percentOfGrandTotal",
  percent_of_row: "percentOfRowTotal",
  percent_of_column: "percentOfColumnTotal",
  percent_of_parent_row: "percentOfParentRowTotal",
  percent_of_parent_column: "percentOfParentColumnTotal",
  difference: "differenceFrom",
  percent_difference: "percentDifferenceFrom",
  running_total: "runningTotal",
  percent_of_running_total: "percentOfRunningTotal",
  rank_ascending: "rankAscending",
  rank_descending: "rankDescending",
  index: "index",
};

/** The backend's ShowAsCalculation names -> the dialog's Show Values As values. */
const SHOW_VALUES_AS = Object.fromEntries(
  Object.entries(CALCULATION).map(([showValuesAs, calculation]) => [calculation, showValuesAs]),
) as Record<ShowAsCalculation, ShowValuesAs>;

/**
 * The `showAs` rule for a value field, or undefined when there is no base to
 * send (no calculation, an unknown one, or no base field chosen) -- the plain
 * `showValuesAs` string then says everything.
 */
export function showAsRuleFor(
  showValuesAs: string | undefined,
  baseField: string | undefined,
  baseItem: string | undefined,
): ShowAsRule | undefined {
  if (!showValuesAs || !baseField) return undefined;
  const calculation = CALCULATION[showValuesAs as ShowValuesAs];
  if (!calculation || calculation === "none") return undefined;
  return baseItem ? { calculation, baseField, baseItem } : { calculation, baseField };
}

/**
 * The editor's form of a value field's saved `showAs` rule: what to seed the
 * Values zone with, so the next update sends the rule back unchanged. Empty
 * when the field shows its values as they are.
 */
export function showValuesAsFromRule(
  rule: ShowAsRule | undefined,
): { showValuesAs?: ShowValuesAs; baseField?: string; baseItem?: string } {
  if (!rule) return {};
  const showValuesAs = SHOW_VALUES_AS[rule.calculation];
  if (!showValuesAs || showValuesAs === "normal") return {};
  return {
    showValuesAs,
    ...(rule.baseField ? { baseField: rule.baseField } : {}),
    ...(rule.baseItem ? { baseItem: rule.baseItem } : {}),
  };
}
