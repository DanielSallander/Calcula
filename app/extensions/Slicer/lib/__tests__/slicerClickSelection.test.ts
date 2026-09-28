//! FILENAME: app/extensions/Slicer/lib/__tests__/slicerClickSelection.test.ts
// PURPOSE: What a click does to a slicer's selection (pure), and the rule that
//          every USER click goes through the click queue.
//
//          The selection rules are the ones the click handler always had
//          (standard / single / multi, Ctrl+click toggle, force selection);
//          they moved into a pure function so a QUEUED click computes them
//          from the committed selection when it runs. A "no change" answer is
//          `undefined`, and it writes nothing: writing the same selection
//          again recorded an undo step that changed nothing.

import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import path from "path";
import { selectionAfterClear, selectionAfterItemClick } from "../slicerClickSelection";
import type { Slicer, SlicerItem } from "../slicerTypes";

const ITEMS: SlicerItem[] = ["East", "West", "North"].map((value) => ({ value, selected: true, hasData: true }));

function s(
  selectedItems: string[] | null,
  selectionMode: Slicer["selectionMode"] = "standard",
  forceSelection = false,
): Pick<Slicer, "selectedItems" | "selectionMode" | "forceSelection"> {
  return { selectedItems, selectionMode, forceSelection };
}

describe("selectionAfterItemClick", () => {
  it("a plain click selects only that item", () => {
    expect(selectionAfterItemClick(s(null), ITEMS, "East", false)).toEqual(["East"]);
    expect(selectionAfterItemClick(s(["West"]), ITEMS, "East", false)).toEqual(["East"]);
  });

  it("clicking the only selected item again clears the filter -- unless the slicer forces a selection", () => {
    expect(selectionAfterItemClick(s(["East"]), ITEMS, "East", false)).toBeNull();
    expect(selectionAfterItemClick(s(["East"], "standard", true), ITEMS, "East", false)).toBeUndefined();
  });

  it("Ctrl+click toggles: from 'all' it deselects that one item", () => {
    expect(selectionAfterItemClick(s(null), ITEMS, "West", true)).toEqual(["East", "North"]);
  });

  it("Ctrl+click adds to, and removes from, a selection", () => {
    expect(selectionAfterItemClick(s(["East"]), ITEMS, "West", true)).toEqual(["East", "West"]);
    expect(selectionAfterItemClick(s(["East", "West"]), ITEMS, "West", true)).toEqual(["East"]);
  });

  it("toggling the last item off clears the filter (or, forced, changes nothing); toggling every item on clears it", () => {
    expect(selectionAfterItemClick(s(["East"]), ITEMS, "East", true)).toBeNull();
    expect(selectionAfterItemClick(s(["East"], "standard", true), ITEMS, "East", true)).toBeUndefined();
    expect(selectionAfterItemClick(s(["East", "West"]), ITEMS, "North", true)).toBeNull();
  });

  it("multi mode toggles without Ctrl; single mode never toggles", () => {
    expect(selectionAfterItemClick(s(["East"], "multi"), ITEMS, "West", false)).toEqual(["East", "West"]);
    expect(selectionAfterItemClick(s(["East"], "single"), ITEMS, "West", true)).toEqual(["West"]);
  });

  it("without an item list nothing happens", () => {
    expect(selectionAfterItemClick(s(null), undefined, "East", false)).toBeUndefined();
  });
});

describe("selectionAfterClear", () => {
  it("clears a filtering slicer; a slicer that filters nothing is left alone", () => {
    expect(selectionAfterClear(s(["East"]))).toBeNull();
    expect(selectionAfterClear(s(null))).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Every user click is queued
// ---------------------------------------------------------------------------

/** Line and block comments out. */
function code(rel: string): string {
  return readFileSync(path.resolve(__dirname, rel), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:"'])\/\/[^\n]*/g, "$1");
}

describe("the user-click sites", () => {
  it("never write a selection directly: they go through the click queue (one gesture, one Ctrl+Z)", () => {
    const menu = code("../../handlers/slicerContextMenu.ts");
    expect(menu).not.toMatch(/updateSlicerSelectionAsync\s*\(/);
    expect(menu).toMatch(/clickSlicerClearFilter\s*\(/);

    // index.ts calls it exactly once: the script service's setSelectedItems,
    // which joins the script's own transaction and must NOT queue.
    const index = code("../../index.ts");
    const direct = [...index.matchAll(/updateSlicerSelectionAsync\s*\(/g)];
    expect(direct).toHaveLength(1);
    expect(index).toMatch(/setSelectedItems\s*\([^)]*\)\s*\{\s*await updateSlicerSelectionAsync\s*\(/);
    expect(index).toMatch(/clickSlicerItem\s*\(/);
    expect(index).toMatch(/clickSlicerClearFilter\s*\(/);
  });
});
