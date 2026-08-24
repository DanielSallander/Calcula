//! FILENAME: app/extensions/GoToSpecial/criteriaOptions.ts
// PURPOSE: The rows of the Go To Special dialog, one per criteria the API accepts.
// CONTEXT: Split out of GoToSpecialDialog.tsx so the list can be asserted
//          without importing React and the @api barrel. "Last cell" existed at
//          no layer -- not in GoToSpecialCriteria, not in this dialog -- while
//          Ctrl+End claimed to go there, so the two disagreed in public.

import type { GoToSpecialCriteria } from "@api";

export interface CriteriaOption {
  value: GoToSpecialCriteria;
  label: string;
}

export const CRITERIA_OPTIONS: CriteriaOption[] = [
  { value: "blanks", label: "Blanks" },
  { value: "formulas", label: "Formulas" },
  { value: "constants", label: "Constants" },
  { value: "errors", label: "Errors" },
  { value: "comments", label: "Comments" },
  { value: "notes", label: "Notes" },
  { value: "conditionalFormats", label: "Conditional Formats" },
  { value: "dataValidation", label: "Data Validation" },
  // Excel's wording, and Excel's behaviour: the lower-right corner of the used
  // range, whatever is selected when the dialog is opened.
  { value: "lastCell", label: "Last Cell" },
];
