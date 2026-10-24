//! FILENAME: app/src/core/lib/__tests__/editSheetIdentity.test.ts
// PURPOSE: The rules that say WHICH sheet an open cell edit belongs to -- by
//          the sheet's identity (its name), never by an index other code can
//          renumber (core/lib/editSheetIdentity.ts, and `sameSheetName` in
//          core/lib/formulaEditTarget.ts).
// CONTEXT: Review TSHELL4-DISCARD-LANDS-UNDER-OPEN-EDIT. A temporary sheet's
//          discard (or a delete, a move, a copy -- MCP and scripts included)
//          renumbers the sheets while an edit is open. The edit kept its OLD
//          index, so the editor vanished from its own sheet and Enter wrote into
//          whichever sheet slid into the old index. The sheet layouts below are
//          the finding's: Sales, Drillthrough (temporary), Costs, Summary.

import { describe, it, expect } from "vitest";
import {
  findEditSheet,
  isEditOnShownSheet,
  isEditSheet,
  rebaseEditOntoShownSheet,
} from "../editSheetIdentity";
import { sameSheetName } from "../formulaEditTarget";

const ON_SUMMARY = { sourceSheetIndex: 3, sourceSheetName: "Summary" };

/** The list after the temporary sheet's discard: Summary moved from 3 to 2, Extra slid into 3. */
const AFTER_DISCARD = [
  { index: 0, name: "Sales" },
  { index: 1, name: "Costs" },
  { index: 2, name: "Summary" },
  { index: 3, name: "Extra" },
];

describe("sameSheetName: the workbook's own uniqueness rule (eq_ignore_ascii_case)", () => {
  it("names the same sheet ignoring ASCII case, and nothing else", () => {
    expect(sameSheetName("Summary", "Summary")).toBe(true);
    expect(sameSheetName("Summary", "summary")).toBe(true);
    expect(sameSheetName("Q1-2026", "q1-2026")).toBe(true);
    expect(sameSheetName("Summary", "Summary2")).toBe(false);
    expect(sameSheetName("Summary", "Costs")).toBe(false);
  });

  it("does not fold non-ASCII letters (the backend lets two names that differ only in a non-ASCII letter's case coexist), and an empty name names nothing", () => {
    expect(sameSheetName("\u00c4rende", "\u00e4rende")).toBe(false);
    expect(sameSheetName("", "")).toBe(false);
    expect(sameSheetName("Summary", "")).toBe(false);
  });
});

describe("isEditOnShownSheet: is the grid showing the edit's sheet?", () => {
  it("RENUMBERED: the edit's sheet at a NEW index is still the edit's sheet", () => {
    expect(isEditOnShownSheet(ON_SUMMARY, { activeSheetIndex: 2, activeSheetName: "Summary" })).toBe(true);
  });

  it("another sheet slid into the edit's OLD index: that is NOT the edit's sheet", () => {
    expect(isEditOnShownSheet(ON_SUMMARY, { activeSheetIndex: 3, activeSheetName: "Extra" })).toBe(false);
  });

  it("point mode: another sheet at another index is not the edit's sheet; the edit's own is", () => {
    expect(isEditOnShownSheet(ON_SUMMARY, { activeSheetIndex: 1, activeSheetName: "Costs" })).toBe(false);
    expect(isEditOnShownSheet(ON_SUMMARY, { activeSheetIndex: 3, activeSheetName: "Summary" })).toBe(true);
  });

  it("without a name on either side it is the index (the old rule); an edit naming no sheet is on whatever is shown", () => {
    expect(isEditOnShownSheet({ sourceSheetIndex: 0 }, { activeSheetIndex: 1 })).toBe(false);
    expect(isEditOnShownSheet({ sourceSheetIndex: 1 }, { activeSheetIndex: 1, activeSheetName: "Costs" })).toBe(true);
    expect(isEditOnShownSheet(ON_SUMMARY, { activeSheetIndex: 3, activeSheetName: "" })).toBe(true);
    expect(isEditOnShownSheet({}, { activeSheetIndex: 4, activeSheetName: "Costs" })).toBe(true);
  });
});

describe("findEditSheet / isEditSheet: where is the edit's sheet NOW?", () => {
  it("finds the edit's sheet by NAME in a fresh list, at its new index -- not the sheet at its old one", () => {
    expect(findEditSheet(ON_SUMMARY, AFTER_DISCARD)).toEqual({ index: 2, name: "Summary" });
    expect(isEditSheet(ON_SUMMARY, { index: 3, name: "Extra" })).toBe(false);
  });

  it("a sheet that is gone (deleted, or renamed, under the edit) is null -- never a fall-back to the stored index", () => {
    const withoutSummary = AFTER_DISCARD.filter((s) => s.name !== "Summary");
    expect(findEditSheet(ON_SUMMARY, withoutSummary)).toBeNull();
  });

  it("an edit with no name is found at its index (the old rule)", () => {
    expect(findEditSheet({ sourceSheetIndex: 1 }, AFTER_DISCARD)).toEqual({ index: 1, name: "Costs" });
    expect(findEditSheet({}, AFTER_DISCARD)).toBeNull();
  });
});

describe("rebaseEditOntoShownSheet: the stored index follows the name", () => {
  it("the shown sheet IS the edit's sheet at another index: the index follows", () => {
    const editing = { row: 0, col: 0, value: "42", ...ON_SUMMARY };
    expect(rebaseEditOntoShownSheet(editing, 2, "Summary")).toEqual({ ...editing, sourceSheetIndex: 2 });
  });

  it("another sheet, the same index, no stored index or no name: the SAME object back", () => {
    const editing = { row: 0, col: 0, value: "42", ...ON_SUMMARY };
    expect(rebaseEditOntoShownSheet(editing, 1, "Costs")).toBe(editing);
    expect(rebaseEditOntoShownSheet(editing, 3, "Summary")).toBe(editing);
    const noIndex = { row: 0, col: 0, value: "", sourceSheetName: "Summary" };
    expect(rebaseEditOntoShownSheet(noIndex, 2, "Summary")).toBe(noIndex);
    const noName = { row: 0, col: 0, value: "", sourceSheetIndex: 3 };
    expect(rebaseEditOntoShownSheet(noName, 2, "Summary")).toBe(noName);
  });
});

// Review F1-rename-refuses-entry (round 5): deciding by NAME broke a RENAME of
// the edited sheet while the edit was open -- the edit looked like it belonged
// to another sheet, and Enter refused the entry. The STABLE id comes first.
describe("by the STABLE id first: a rename is followed, a delete is not", () => {
  const ON_S1 = { sourceSheetIndex: 0, sourceSheetName: "Sheet1", sourceSheetId: "S1" };

  it("isEditOnShownSheet: the same id under a NEW name is the edit's sheet; another id under the SAME name is not", () => {
    expect(isEditOnShownSheet(ON_S1, { activeSheetIndex: 0, activeSheetName: "Data", activeSheetId: "S1" })).toBe(true);
    expect(isEditOnShownSheet(ON_S1, { activeSheetIndex: 0, activeSheetName: "Sheet1", activeSheetId: "S2" })).toBe(false);
    // Renumbered AND renamed together: still the edit's sheet.
    expect(isEditOnShownSheet(ON_S1, { activeSheetIndex: 4, activeSheetName: "Data", activeSheetId: "S1" })).toBe(true);
  });

  it("an id missing on EITHER side falls back to the name (a context dispatched without one never misleads)", () => {
    expect(isEditOnShownSheet(ON_S1, { activeSheetIndex: 0, activeSheetName: "Data" })).toBe(false);
    expect(isEditOnShownSheet(ON_S1, { activeSheetIndex: 7, activeSheetName: "sheet1" })).toBe(true);
    const nameOnly = { sourceSheetIndex: 0, sourceSheetName: "Sheet1" };
    expect(isEditOnShownSheet(nameOnly, { activeSheetIndex: 0, activeSheetName: "Data", activeSheetId: "S1" })).toBe(false);
  });

  it("findEditSheet: a RENAMED sheet is found by id; a DELETED one is null even when another sheet now has its name", () => {
    const renamed = [
      { index: 0, name: "Data", sheetId: "S1" },
      { index: 1, name: "Costs", sheetId: "S2" },
    ];
    expect(findEditSheet(ON_S1, renamed)).toEqual({ index: 0, name: "Data", sheetId: "S1" });
    const deletedAndRecreated = [
      { index: 0, name: "Sheet1", sheetId: "S9" },
      { index: 1, name: "Costs", sheetId: "S2" },
    ];
    expect(findEditSheet(ON_S1, deletedAndRecreated), "a namesake with another id is not the edit's sheet").toBeNull();
    expect(isEditSheet(ON_S1, { index: 0, name: "Sheet1", sheetId: "S9" })).toBe(false);
  });

  it("findEditSheet: a list WITHOUT ids (an older backend) falls back to the name", () => {
    expect(findEditSheet(ON_S1, [{ index: 2, name: "Sheet1" }])).toEqual({ index: 2, name: "Sheet1" });
  });

  it("rebaseEditOntoShownSheet BY ID follows the index AND the name", () => {
    const editing = { row: 0, col: 0, value: "hello", ...ON_S1 };
    expect(rebaseEditOntoShownSheet(editing, 0, "Data", "S1")).toEqual({ ...editing, sourceSheetName: "Data" });
    expect(rebaseEditOntoShownSheet(editing, 2, "Data", "S1")).toEqual({
      ...editing,
      sourceSheetIndex: 2,
      sourceSheetName: "Data",
    });
    // Nothing to follow: the SAME object back.
    expect(rebaseEditOntoShownSheet(editing, 0, "Sheet1", "S1")).toBe(editing);
  });

  it("rebaseEditOntoShownSheet: another id is another sheet, whatever its name -- the SAME object back", () => {
    const editing = { row: 0, col: 0, value: "hello", ...ON_S1 };
    expect(rebaseEditOntoShownSheet(editing, 3, "Sheet1", "S2")).toBe(editing);
  });

  it("rebaseEditOntoShownSheet BY NAME: an edit with no id ADOPTS the shown sheet's (names are unique), so a later rename is followed", () => {
    const editing = { row: 0, col: 0, value: "", sourceSheetIndex: 3, sourceSheetName: "Summary" };
    expect(rebaseEditOntoShownSheet(editing, 3, "Summary", "S3")).toEqual({ ...editing, sourceSheetId: "S3" });
    expect(rebaseEditOntoShownSheet(editing, 2, "Summary", "S3")).toEqual({
      ...editing,
      sourceSheetIndex: 2,
      sourceSheetId: "S3",
    });
    // Another name adopts nothing.
    expect(rebaseEditOntoShownSheet(editing, 3, "Extra", "S4")).toBe(editing);
  });

  it("an edit WITH an id under a context WITHOUT one: the name rule moves the index, and the id is kept", () => {
    const editing = { row: 0, col: 0, value: "", sourceSheetIndex: 3, sourceSheetName: "Summary", sourceSheetId: "S3" };
    expect(rebaseEditOntoShownSheet(editing, 2, "Summary")).toEqual({ ...editing, sourceSheetIndex: 2 });
    expect(rebaseEditOntoShownSheet(editing, 2, "Data")).toBe(editing);
  });
});
