//! FILENAME: app/extensions/Pivot/lib/showValuesAsOptions.ts
// PURPOSE: The ONE list of "Show Values As" choices and which of them need a
//          base field / base item. Read by the Value Field Settings dialog and
//          by the value-cell context menu's "Show Values As" sub-menu, so the
//          two can never offer different calculations or labels.
// CONTEXT: Moved verbatim from components/ValueFieldSettingsModal.tsx (WP-A S10).

import type { ShowValuesAs } from "../components/types";

/** Every Show Values As calculation, in Excel's order, with its label. */
export const SHOW_VALUES_AS_OPTIONS: ReadonlyArray<{ value: ShowValuesAs; label: string }> = [
  { value: "normal", label: "No Calculation" },
  { value: "percent_of_total", label: "% of Grand Total" },
  { value: "percent_of_row", label: "% of Row Total" },
  { value: "percent_of_column", label: "% of Column Total" },
  { value: "percent_of_parent_row", label: "% of Parent Row Total" },
  { value: "percent_of_parent_column", label: "% of Parent Column Total" },
  { value: "difference", label: "Difference From" },
  { value: "percent_difference", label: "% Difference From" },
  { value: "running_total", label: "Running Total In" },
  { value: "percent_of_running_total", label: "% of Running Total In" },
  { value: "rank_ascending", label: "Rank Smallest to Largest" },
  { value: "rank_descending", label: "Rank Largest to Smallest" },
  { value: "index", label: "Index" },
];

/** ShowValuesAs options that require a base field selection. */
export const NEEDS_BASE_FIELD: readonly ShowValuesAs[] = [
  "difference",
  "percent_difference",
  "running_total",
  "percent_of_running_total",
  "rank_ascending",
  "rank_descending",
];

/** ShowValuesAs options that require a base item selection. */
export const NEEDS_BASE_ITEM: readonly ShowValuesAs[] = [
  "difference",
  "percent_difference",
];
