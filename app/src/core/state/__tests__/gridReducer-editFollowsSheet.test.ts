//! FILENAME: app/src/core/state/__tests__/gridReducer-editFollowsSheet.test.ts
// PURPOSE: An open cell edit's stored sheet index FOLLOWS its sheet (by name)
//          through every sheet-context change and through the open itself.
// CONTEXT: Review TSHELL4-DISCARD-LANDS-UNDER-OPEN-EDIT. The tab strip's
//          discard of a temporary sheet moves Core's context to the edited
//          sheet's NEW index (`setSheetContext(2, "Summary")`); the edit still
//          said 3. Readers that take an index (the strip's source marker, the
//          edit-ended event) then named another sheet. The open has the same
//          gap: it names its sheet from the context it read BEFORE its awaits,
//          and a discard can land in between.

import { describe, it, expect } from "vitest";
import { gridReducer, getInitialState } from "../gridReducer";
import { setActiveSheet, setSheetContext, startEditing } from "../gridActions";
import type { GridState } from "../../types";

function onSheet(index: number, name: string): GridState {
  return gridReducer(getInitialState(), setSheetContext(index, name));
}

const EDIT_ON_SUMMARY = { row: 4, col: 2, value: "42", sourceSheetIndex: 3, sourceSheetName: "Summary" };

describe("the edit follows its sheet by name (gridReducer)", () => {
  it("SET_SHEET_CONTEXT onto the edit's sheet at a NEW index (the discard landed) rebases the edit", () => {
    let state = gridReducer(onSheet(3, "Summary"), startEditing(EDIT_ON_SUMMARY));
    expect(state.editing?.sourceSheetIndex).toBe(3);
    state = gridReducer(state, setSheetContext(2, "Summary"));
    expect(state.editing, "the edit lost its sheet").toEqual({ ...EDIT_ON_SUMMARY, sourceSheetIndex: 2 });
  });

  it("SET_ACTIVE_SHEET onto the edit's sheet at a new index (the return from point mode) rebases it too", () => {
    let state = gridReducer(onSheet(3, "Summary"), startEditing(EDIT_ON_SUMMARY));
    state = gridReducer(state, setActiveSheet(1, "Costs"));
    state = gridReducer(state, setActiveSheet(2, "Summary", "grid"));
    expect(state.editing?.sourceSheetIndex).toBe(2);
  });

  it("START_EDITING named from a context read BEFORE a renumbering lands at the sheet's index NOW", () => {
    // The open read (3, "Summary"); the discard moved the context to 2 meanwhile.
    const state = gridReducer(onSheet(2, "Summary"), startEditing(EDIT_ON_SUMMARY));
    expect(state.editing?.sourceSheetIndex).toBe(2);
  });

  it("control: point mode on ANOTHER sheet leaves the edit's index alone (the reducer cannot know where its sheet went)", () => {
    let state = gridReducer(onSheet(3, "Summary"), startEditing(EDIT_ON_SUMMARY));
    state = gridReducer(state, setActiveSheet(3, "Extra"));
    expect(state.editing).toEqual(EDIT_ON_SUMMARY);
    state = gridReducer(state, setSheetContext(1, "Costs"));
    expect(state.editing).toEqual(EDIT_ON_SUMMARY);
  });

  it("control: an edit with no name, and a context change with no edit, change nothing", () => {
    const nameless = { row: 0, col: 0, value: "", sourceSheetIndex: 3 };
    let state = gridReducer(onSheet(3, "Summary"), startEditing(nameless));
    state = gridReducer(state, setSheetContext(2, "Summary"));
    expect(state.editing).toEqual(nameless);
    const idle = gridReducer(onSheet(3, "Summary"), setSheetContext(2, "Summary"));
    expect(idle.editing).toBeNull();
  });
});

// Review F1-rename-refuses-entry (round 5): the context carries the sheet's
// STABLE id, and an open edit follows its sheet by it -- through a rename too.
describe("the context's stable id, and the edit following its sheet by it (gridReducer)", () => {
  const EDIT_ON_S1 = { row: 0, col: 0, value: "hello", sourceSheetIndex: 0, sourceSheetName: "Sheet1", sourceSheetId: "S1" };

  it("a dispatch WITH an id stores it; one WITHOUT clears it (a stale id never misleads)", () => {
    let state = gridReducer(getInitialState(), setSheetContext(0, "Sheet1", "grid", "S1"));
    expect(state.sheetContext).toEqual({ activeSheetIndex: 0, activeSheetName: "Sheet1", activeSheetId: "S1" });
    state = gridReducer(state, setActiveSheet(1, "Costs", undefined, "S2"));
    expect(state.sheetContext.activeSheetId).toBe("S2");
    // Undo's follow of the backend's switch carries only an index and a name.
    state = gridReducer(state, setActiveSheet(0, "Sheet1"));
    expect(state.sheetContext.activeSheetId, "the context kept an id from the sheet it left").toBeUndefined();
    state = gridReducer(state, setSheetContext(0, "Sheet1", undefined, "S1"));
    state = gridReducer(state, setSheetContext(0, "Sheet1"));
    expect(state.sheetContext.activeSheetId).toBeUndefined();
  });

  it("RENAMED under the open edit (same index, same id, new name): the edit follows the name", () => {
    let state = gridReducer(gridReducer(getInitialState(), setSheetContext(0, "Sheet1", "grid", "S1")), startEditing(EDIT_ON_S1));
    state = gridReducer(state, setSheetContext(0, "Data", "grid", "S1"));
    expect(state.editing, "the edit did not follow the rename of its sheet").toEqual({ ...EDIT_ON_S1, sourceSheetName: "Data" });
  });

  it("RENUMBERED and RENAMED together: the edit follows both, by id", () => {
    const onSummary = { ...EDIT_ON_S1, sourceSheetIndex: 3, sourceSheetName: "Summary", sourceSheetId: "S3" };
    let state = gridReducer(gridReducer(getInitialState(), setSheetContext(3, "Summary", "grid", "S3")), startEditing(onSummary));
    state = gridReducer(state, setSheetContext(2, "Totals", "grid", "S3"));
    expect(state.editing).toEqual({ ...onSummary, sourceSheetIndex: 2, sourceSheetName: "Totals" });
  });

  it("DELETED: another sheet (another id) at the edit's index is NOT followed -- the edit keeps naming its own sheet", () => {
    let state = gridReducer(gridReducer(getInitialState(), setSheetContext(0, "Sheet1", "grid", "S1")), startEditing(EDIT_ON_S1));
    state = gridReducer(state, setSheetContext(0, "Costs", "grid", "S2"));
    expect(state.editing).toEqual(EDIT_ON_S1);
  });

  it("START_EDITING named from a context read BEFORE a rename landed: the stored edit carries the sheet's name NOW", () => {
    const readBefore = { ...EDIT_ON_S1, sourceSheetIndex: 3, sourceSheetName: "Summary", sourceSheetId: "S3" };
    const state = gridReducer(gridReducer(getInitialState(), setSheetContext(3, "Totals", "grid", "S3")), startEditing(readBefore));
    expect(state.editing).toEqual({ ...readBefore, sourceSheetName: "Totals" });
  });

  it("an edit opened with NO id adopts the sheet's id when the context arrives on it by name -- and then follows a rename", () => {
    const nameOnly = { row: 0, col: 0, value: "", sourceSheetIndex: 0, sourceSheetName: "Sheet1" };
    let state = gridReducer(gridReducer(getInitialState(), setSheetContext(0, "Sheet1")), startEditing(nameOnly));
    state = gridReducer(state, setSheetContext(0, "Sheet1", "grid", "S1"));
    expect(state.editing?.sourceSheetId).toBe("S1");
    state = gridReducer(state, setSheetContext(0, "Data", "grid", "S1"));
    expect(state.editing?.sourceSheetName).toBe("Data");
  });
});
