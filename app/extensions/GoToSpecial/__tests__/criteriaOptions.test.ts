//! FILENAME: app/extensions/GoToSpecial/__tests__/criteriaOptions.test.ts
// PURPOSE: The dialog must offer every criteria the API accepts.
// CONTEXT: "Last cell" was reachable from nowhere for exactly this reason —
//          nothing tied the dialog's radio list to GoToSpecialCriteria, so a
//          criteria could exist in the type and be invisible in the product (or
//          the reverse). The map below is exhaustive by TYPE: adding a member to
//          GoToSpecialCriteria without a row here fails check-types, and this
//          test then fails until the dialog offers it.

import { describe, it, expect } from "vitest";
import type { GoToSpecialCriteria } from "@api";
import { CRITERIA_OPTIONS } from "../criteriaOptions";

const EVERY_CRITERIA: Record<GoToSpecialCriteria, true> = {
  blanks: true,
  formulas: true,
  constants: true,
  errors: true,
  comments: true,
  notes: true,
  conditionalFormats: true,
  dataValidation: true,
  lastCell: true,
};

describe("Go To Special criteria options", () => {
  it("offers every criteria the API accepts, and nothing it does not", () => {
    const offered = CRITERIA_OPTIONS.map((option) => option.value).sort();

    expect(offered).toEqual(Object.keys(EVERY_CRITERIA).sort());
  });

  it("offers each one exactly once", () => {
    const offered = CRITERIA_OPTIONS.map((option) => option.value);

    expect(new Set(offered).size).toBe(offered.length);
  });

  it("labels every option with something a user can read", () => {
    for (const option of CRITERIA_OPTIONS) {
      expect(option.label.trim().length).toBeGreaterThan(0);
    }
  });

  it("names Excel's last-cell criteria the way Excel does", () => {
    const lastCell = CRITERIA_OPTIONS.find((option) => option.value === "lastCell");

    expect(lastCell?.label).toBe("Last Cell");
  });
});
