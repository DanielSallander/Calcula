//! FILENAME: app/extensions/FloatingRange/lib/__tests__/frContextMenu.test.ts
// PURPOSE: The floating range's object menu withholds its four SIZE items
//          while the range's geometry is frozen (a range its canvas locks),
//          and keeps the authoring items that are not geometry.
// CONTEXT: fr-move diagnosis, fix problem 3: "a subscribed canvas or a locked
//          grid refuses all of it" was false -- Add Row / Add Column / Delete
//          Last Row / Delete Last Column were unconditional, so a locked grid
//          could still change size through its menu. The menu now asks the
//          store's one per-range answer (`frGeometryEditable`).

import { describe, it, expect, vi } from "vitest";
import { buildFrContextMenu, type FrContextMenuHandlers } from "../frContextMenu";

function handlers(geometry: boolean, rows = 3, cols = 3): FrContextMenuHandlers {
  return {
    addRow: vi.fn(),
    addColumn: vi.fn(),
    deleteLastRow: vi.fn(),
    deleteLastColumn: vi.fn(),
    rename: vi.fn(),
    properties: vi.fn(),
    deleteObject: vi.fn(),
    getCounts: () => ({ rows, cols }),
    canEditGeometry: () => geometry,
  };
}

function enabledIds(geometry: boolean, rows = 3, cols = 3): string[] {
  return buildFrContextMenu("fr-1", handlers(geometry, rows, cols))
    .filter((i) => i.enabled)
    .map((i) => i.id);
}

const SIZE_ITEMS = [
  "floatingRange.addRow",
  "floatingRange.addColumn",
  "floatingRange.deleteLastRow",
  "floatingRange.deleteLastColumn",
];

describe("the floating range object menu", () => {
  it("offers the size items when the range's geometry may change", () => {
    expect(enabledIds(true)).toEqual([
      ...SIZE_ITEMS,
      "floatingRange.rename",
      "floatingRange.properties",
      "floatingRange.delete",
    ]);
  });

  it("withholds ALL FOUR size items on a locked range, and keeps Rename / Properties / Delete", () => {
    const ids = enabledIds(false);
    for (const id of SIZE_ITEMS) expect(ids).not.toContain(id);
    expect(ids).toEqual(["floatingRange.rename", "floatingRange.properties", "floatingRange.delete"]);
  });

  it("still gates the shrink items on the live window (a 1x1 range cannot lose a row)", () => {
    const ids = enabledIds(true, 1, 1);
    expect(ids).toContain("floatingRange.addRow");
    expect(ids).not.toContain("floatingRange.deleteLastRow");
    expect(ids).not.toContain("floatingRange.deleteLastColumn");
  });
});
