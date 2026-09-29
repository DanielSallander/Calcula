//! FILENAME: app/extensions/FloatingRange/__tests__/frClipboardKeyClaim.test.ts
// PURPOSE: A floating range with a selected CELL claims the clipboard keys
//          (`ownsKey("Clipboard")`), so the canvas's object clipboard (W25:
//          Ctrl+C / Ctrl+V / Ctrl+D copy, paste and duplicate the selected
//          OBJECTS) stands aside and the keys stay the cells' -- today they
//          are refused for a range's cells with one sentence (frKeyRouting).
//          Without the claim, Ctrl+C inside a floating grid's cell copied the
//          whole range object (or, as a range cannot be copied, answered with
//          "not copied") instead of speaking about the cell.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { FloatingRangeInfo } from "@api/floatingRanges";
import type { GridRegion } from "@api/gridOverlays";
import { objectOwnsKey, resetObjectSelectionProviders } from "@api/objectSelection";
import {
  createFloatingRangeSelectionProvider,
  registerFloatingRangeObjectSelection,
} from "../lib/frObjectSelection";
import { FLOATING_RANGE_REGION_TYPE, resetFloatingRangeStore, upsertFromInfo } from "../lib/floatingRangeStore";
import { clearLocalSelection, resetFrSelection, setLocalSelection } from "../lib/frSelection";

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

beforeEach(() => {
  resetObjectSelectionProviders();
  resetFloatingRangeStore();
  resetFrSelection();
  upsertFromInfo(info("fr-a"));
});

afterEach(() => {
  resetObjectSelectionProviders();
  resetFloatingRangeStore();
  resetFrSelection();
});

describe("the clipboard keys belong to a floating range's selected cell", () => {
  it("claims them while a cell is selected, and gives them back when it is not", () => {
    const p = createFloatingRangeSelectionProvider();
    p.select(region("fr-a"));
    expect(p.ownsKey!("Clipboard"), "the range object alone claimed the clipboard keys").toBe(false);
    setLocalSelection({ frId: "fr-a", anchorRow: 1, anchorCol: 1, endRow: 1, endCol: 1 });
    expect(p.ownsKey!("Clipboard"), "a selected cell did not keep Ctrl+C / Ctrl+V / Ctrl+D").toBe(true);
    clearLocalSelection();
    expect(p.ownsKey!("Clipboard")).toBe(false);
  });

  it("answers through the seam the canvas's clipboard door asks", () => {
    registerFloatingRangeObjectSelection();
    expect(objectOwnsKey("Clipboard")).toBe(false);
    setLocalSelection({ frId: "fr-a", anchorRow: 0, anchorCol: 0, endRow: 0, endCol: 0 });
    expect(objectOwnsKey("Clipboard")).toBe(true);
  });
});
