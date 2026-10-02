//! FILENAME: app/extensions/Slicer/lib/__tests__/slicerClickSelection.run.test.ts
// PURPOSE: What a DRAG across slicer items does to the selection (pure;
//          `selectionAfterItemRun`, BUG-0258 design phase 4, owner decision D4)
//          -- and that the preview a live drag paints is exactly that
//          (`selectionShownDuringRun`), so what the user sees while the button
//          is held is what the release commits:
//            - a plain drag selects EXACTLY the run;
//            - Ctrl+drag ADDS the run to the selection (it never toggles: a run
//              is not a click);
//            - 'single' takes the item the button was released on (the run's
//              last value), Ctrl or not;
//            - 'multi' adds the run, Ctrl or not;
//            - from an UNFILTERED slicer an adding run (Ctrl, or 'multi')
//              selects exactly the run, as a plain drag does -- adding to
//              "every item" would write nothing and show nothing while the
//              button is held (the M7 review's finding; flagged to the owner
//              beside D4);
//            - a result that selects every item is no filter (null), and a
//              result equal to the current selection writes NOTHING
//              (undefined: no undo step that changes nothing).
//          Excel's own drag semantics were not checked in Excel (a risk the
//          owner holds); D4 is this project's choice.

import { describe, it, expect } from "vitest";
import { selectionAfterItemRun, selectionShownDuringRun } from "../slicerClickSelection";
import type { Slicer, SlicerItem } from "../slicerTypes";

const ITEMS: SlicerItem[] = ["East", "West", "North", "South", "Mid"].map((value) => ({
  value,
  selected: true,
  hasData: true,
}));

function s(
  selectedItems: string[] | null,
  selectionMode: Slicer["selectionMode"] = "standard",
): Pick<Slicer, "selectedItems" | "selectionMode"> {
  return { selectedItems, selectionMode };
}

describe("selectionAfterItemRun", () => {
  it.each([
    // [label, selected, mode, run, additive, expected]
    ["plain: exactly the run (from all)", null, "standard", ["East", "West", "North"], false, ["East", "West", "North"]],
    ["plain: exactly the run (replacing another selection)", ["Mid"], "standard", ["West", "North"], false, ["West", "North"]],
    ["plain: a run swept UPWARD is stored in the slicer's order", ["Mid"], "standard", ["North", "West", "East"], false, ["East", "West", "North"]],
    ["Ctrl: the run is ADDED (a union)", ["Mid"], "standard", ["East", "West"], true, ["East", "West", "Mid"]],
    ["Ctrl: already-selected items in the run stay selected (no toggle)", ["East", "Mid"], "standard", ["East", "West"], true, ["East", "West", "Mid"]],
    ["Ctrl from ALL: the run, exactly (as a plain drag) -- never 'all stays all, nothing written'", null, "standard", ["East", "West"], true, ["East", "West"]],
    ["multi from ALL: the run, exactly (as a plain drag)", null, "multi", ["West", "North"], false, ["West", "North"]],
    ["Ctrl from ALL with a run covering every item: still no filter -- nothing to write", null, "standard", ["East", "West", "North", "South", "Mid"], true, undefined],
    ["single: the item released on, alone", ["Mid"], "single", ["East", "West", "North"], false, ["North"]],
    ["single: Ctrl changes nothing", ["Mid"], "single", ["North", "West"], true, ["West"]],
    ["multi: the run is added without Ctrl", ["Mid"], "multi", ["East", "West"], false, ["East", "West", "Mid"]],
    ["a run covering EVERY item is no filter (null)", ["Mid"], "standard", ["East", "West", "North", "South", "Mid"], false, null],
    ["a Ctrl run that completes the set is no filter (null)", ["North", "South", "Mid"], "standard", ["East", "West"], true, null],
    ["the run IS the selection: nothing to write", ["West", "North"], "standard", ["North", "West"], false, undefined],
    ["a covering run on an unfiltered slicer: nothing to write", null, "standard", ["East", "West", "North", "South", "Mid"], false, undefined],
  ] as const)("%s", (_label, selected, mode, run, additive, expected) => {
    const got = selectionAfterItemRun(s(selected === null ? null : [...selected], mode), ITEMS, run, additive);
    expect(got).toEqual(expected === undefined ? undefined : expected === null ? null : [...expected]);
  });

  it("values the item list does not hold are ignored; an empty run and a missing list do nothing", () => {
    expect(selectionAfterItemRun(s(null), ITEMS, ["Gone", "East"], false)).toEqual(["East"]);
    expect(selectionAfterItemRun(s(null), ITEMS, ["Gone"], false)).toBeUndefined();
    expect(selectionAfterItemRun(s(null), ITEMS, [], false)).toBeUndefined();
    expect(selectionAfterItemRun(s(null), undefined, ["East"], false)).toBeUndefined();
  });
});

describe("selectionShownDuringRun (what the live drag paints)", () => {
  it("is what the release would commit", () => {
    expect(selectionShownDuringRun(s(["Mid"]), ITEMS, ["East", "West"], false)).toEqual(["East", "West"]);
    expect(selectionShownDuringRun(s(["Mid"]), ITEMS, ["East", "West"], true)).toEqual(["East", "West", "Mid"]);
    expect(selectionShownDuringRun(s(["Mid"], "single"), ITEMS, ["East", "West"], false)).toEqual(["West"]);
  });

  it("from ALL, a Ctrl run and a 'multi' run PAINT the run while the button is held (not the unchanged 'all')", () => {
    expect(selectionShownDuringRun(s(null), ITEMS, ["East"], true)).toEqual(["East"]);
    expect(selectionShownDuringRun(s(null, "multi"), ITEMS, ["East", "West"], false)).toEqual(["East", "West"]);
  });

  it("is the CURRENT selection where the release would commit nothing", () => {
    expect(selectionShownDuringRun(s(null), ITEMS, ["East", "West", "North", "South", "Mid"], true)).toBeNull();
    expect(selectionShownDuringRun(s(["West"]), ITEMS, ["West"], false)).toEqual(["West"]);
  });
});
