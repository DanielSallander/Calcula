//! FILENAME: app/extensions/FloatingRange/__tests__/frObjectSelection.test.ts
// PURPOSE: The Floating Range's object-selection provider: select/deselect the
//          OBJECT without a mouse press, and `ownsKey` — Tab and Escape belong
//          to the range exactly while it has an inner cell selection.
// CONTEXT: The range's own window-capture key handler moves the inner cell on
//          Tab and drops the inner selection on Escape, and nothing can stop a
//          second window-capture listener (a canvas sheet's Tab cycling) from
//          ALSO seeing the key. So the canvas binding asks `objectOwnsKey`
//          first; if this answer drifted from the handler's behaviour, one Tab
//          press would both move the inner cell and jump to the next object.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { FloatingRangeInfo } from "@api/floatingRanges";
import type { GridRegion } from "@api/gridOverlays";
import {
  objectOwnsKey,
  resetObjectSelectionProviders,
  selectObject,
} from "@api/objectSelection";
import {
  createFloatingRangeSelectionProvider,
  registerFloatingRangeObjectSelection,
} from "../lib/frObjectSelection";
import {
  FLOATING_RANGE_REGION_TYPE,
  resetFloatingRangeStore,
  upsertFromInfo,
} from "../lib/floatingRangeStore";
import {
  clearLocalSelection,
  getLocalSelection,
  isFloatingRangeSelected,
  resetFrSelection,
  setLocalSelection,
} from "../lib/frSelection";
import { noteFrContextMenuMounted } from "../lib/frContextMenu";

function info(id: string): FloatingRangeInfo {
  return {
    id,
    backingSheetId: `backing-${id}`,
    hostSheetId: "host",
    x: 100,
    y: 100,
    rotation: 0,
    pinToGrid: false,
    rowCount: 4,
    colCount: 3,
    colWidths: {},
    rowHeights: {},
    showTitle: true,
    showColumnHeaders: true,
    showRowHeaders: true,
    name: id,
    backingSheetIndex: 1,
    hostSheetIndex: 0,
  } as FloatingRangeInfo;
}

function region(frId: string): GridRegion {
  return {
    id: `fr-${frId}`,
    type: FLOATING_RANGE_REGION_TYPE,
    startRow: 0,
    startCol: 0,
    endRow: 0,
    endCol: 0,
    floating: { x: 100, y: 100, width: 300, height: 200 },
    data: { frId },
  };
}

function innerCell(frId: string) {
  setLocalSelection({ frId, anchorRow: 1, anchorCol: 1, endRow: 1, endCol: 1 });
}

beforeEach(() => {
  resetObjectSelectionProviders();
  resetFloatingRangeStore();
  resetFrSelection();
  upsertFromInfo(info("fr-a"));
  upsertFromInfo(info("fr-b"));
});

afterEach(() => {
  resetFloatingRangeStore();
  resetFrSelection();
});

describe("ownsKey follows the inner cell selection", () => {
  it("owns neither key while there is no inner selection", () => {
    const p = createFloatingRangeSelectionProvider();
    p.select(region("fr-a"));
    expect(isFloatingRangeSelected("fr-a")).toBe(true);
    expect(p.ownsKey!("Tab")).toBe(false);
    expect(p.ownsKey!("Escape")).toBe(false);
  });

  it("owns Tab AND Escape while a cell inside the range is selected", () => {
    const p = createFloatingRangeSelectionProvider();
    p.select(region("fr-a"));
    innerCell("fr-a");
    expect(p.ownsKey!("Tab")).toBe(true);
    expect(p.ownsKey!("Escape")).toBe(true);
    // ...and gives them back the moment the inner selection is dropped
    // (which is what Escape itself does, in handleFrKeyDown).
    clearLocalSelection();
    expect(p.ownsKey!("Tab")).toBe(false);
    expect(p.ownsKey!("Escape")).toBe(false);
  });

  it("answers through the seam, so a canvas guard sees it", () => {
    registerFloatingRangeObjectSelection();
    expect(objectOwnsKey("Tab")).toBe(false);
    innerCell("fr-b");
    expect(objectOwnsKey("Tab")).toBe(true);
    expect(objectOwnsKey("Escape")).toBe(true);
  });

  it("owns Escape (only) while the range's right-click menu is open, inner selection or not", () => {
    // The menu closes itself on Escape; a canvas binding asks this before it
    // takes the key (frContextMenuCanvasEscape.test.tsx drives the real pair).
    const p = createFloatingRangeSelectionProvider();
    p.select(region("fr-a"));
    const release = noteFrContextMenuMounted();
    try {
      expect(p.ownsKey!("Escape")).toBe(true);
      expect(p.ownsKey!("Tab")).toBe(false);
    } finally {
      release();
    }
    expect(p.ownsKey!("Escape")).toBe(false);
  });

  it("does not own a key for an inner selection whose range is gone", () => {
    // handleFrKeyDown clears such a selection and lets the key through.
    const p = createFloatingRangeSelectionProvider();
    innerCell("fr-deleted");
    expect(p.ownsKey!("Tab")).toBe(false);
  });

  // BUG-0270: the generic Delete of a selected object stands down for a family
  // whose OWN door takes the key. The range's door (frKeyRouting.ts) clears a
  // selected CELL or deletes the selected range -- the generic must never
  // delete the whole range instead of clearing its cell, whatever the
  // activation order.
  it("owns Delete while the range is selected on the sheet shown -- as an object AND with a cell selected; not with nothing", () => {
    const p = createFloatingRangeSelectionProvider();
    expect(p.ownsKey!("Delete"), "control: nothing selected").toBe(false);
    p.select(region("fr-a"));
    expect(p.ownsKey!("Delete"), "the range's own door deletes the selected range").toBe(true);
    innerCell("fr-a");
    expect(p.ownsKey!("Delete"), "a generic Delete would delete the range instead of clearing its cell").toBe(true);
    p.deselectAll();
    expect(p.ownsKey!("Delete")).toBe(false);
  });
});

describe("select / deselect", () => {
  it("selecting another range drops the first range's inner selection", () => {
    const p = createFloatingRangeSelectionProvider();
    p.select(region("fr-a"));
    innerCell("fr-a");
    p.select(region("fr-b"));
    expect(isFloatingRangeSelected("fr-b")).toBe(true);
    expect(isFloatingRangeSelected("fr-a")).toBe(false);
    expect(getLocalSelection()).toBeNull();
  });

  it("deselectAll clears the object AND the inner selection, returning the keys", () => {
    registerFloatingRangeObjectSelection();
    selectObject(region("fr-a"));
    innerCell("fr-a");
    const p = createFloatingRangeSelectionProvider();
    p.deselectAll();
    expect(isFloatingRangeSelected("fr-a")).toBe(false);
    expect(getLocalSelection()).toBeNull();
    expect(objectOwnsKey("Tab")).toBe(false);
  });

  it("ignores a region whose range is not in the store", () => {
    const p = createFloatingRangeSelectionProvider();
    p.select(region("fr-missing"));
    expect(isFloatingRangeSelected("fr-missing")).toBe(false);
    expect(p.isSelected(region("fr-missing"))).toBe(false);
  });
});

describe("refOf: the floating range's canvas identity (M8)", () => {
  it("is { kind: 'floatingRange', id: frId }, and reaches objectRefOf through the seam", async () => {
    const { objectRefOf } = await import("@api/objectSelection");
    expect(createFloatingRangeSelectionProvider().refOf?.(region("fr-a"))).toEqual({
      kind: "floatingRange",
      id: "fr-a",
    });
    const off = registerFloatingRangeObjectSelection();
    expect(objectRefOf(region("fr-b"))).toEqual({ kind: "floatingRange", id: "fr-b" });
    off();
  });

  it("is null for a region that carries no range id", () => {
    expect(createFloatingRangeSelectionProvider().refOf?.({ ...region("fr-a"), data: {} })).toBeNull();
  });
});

describe("the canvas selection set (M8)", () => {
  it("owns the ARROWS too while a cell inside the range is selected (they move the inner cell)", () => {
    const p = createFloatingRangeSelectionProvider();
    p.select(region("fr-a"));
    expect(p.ownsKey!("Arrow")).toBe(false);
    innerCell("fr-a");
    expect(p.ownsKey!("Arrow")).toBe(true);
  });

  it("every object-selection chokepoint announces a CHANGE to the set, and only a change", async () => {
    const { onObjectSelectionChanged } = await import("@api/objectSelection");
    const sel = await import("../lib/frSelection");
    let seen = 0;
    const off = onObjectSelectionChanged(() => {
      seen += 1;
    });
    sel.selectFloatingRange("fr-a");
    sel.selectFloatingRange("fr-a"); // already the selection
    sel.selectFloatingRange("fr-b");
    sel.deselectAllFloatingRanges();
    sel.deselectAllFloatingRanges(); // nothing selected
    sel.selectFloatingRange("fr-a");
    sel.resetFrSelection();
    // select a, select b, deselect, select a, reset: five changes.
    expect(seen).toBe(5);
    off();
  });

  it("labelOf is the range's published name", () => {
    const p = createFloatingRangeSelectionProvider();
    expect(p.labelOf!({ ...region("fr-a"), data: { frId: "fr-a", name: "Budget" } })).toBe("Budget");
    expect(p.labelOf!(region("fr-a"))).toBeNull();
  });
});
