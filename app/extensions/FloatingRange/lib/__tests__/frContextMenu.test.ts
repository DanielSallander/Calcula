//! FILENAME: app/extensions/FloatingRange/lib/__tests__/frContextMenu.test.ts
// PURPOSE: The floating range's object menu withholds its four SIZE items
//          while the range's geometry is frozen (a range its canvas locks),
//          and keeps the authoring items that are not geometry.
// CONTEXT: fr-move diagnosis, fix problem 3: "a subscribed canvas or a locked
//          grid refuses all of it" was false -- Add Row / Add Column / Delete
//          Last Row / Delete Last Column were unconditional, so a locked grid
//          could still change size through its menu. The menu now asks the
//          store's one per-range answer (`frGeometryEditable`).
//
//          "Size and Position..." (BUG-0258 phase 5b): offered for a published
//          range whenever the dialog can open -- a LOCKED range included (the
//          dialog opens read-only there) -- and hidden when nothing can open it.
//
//          "Format..." and "Properties..." (WP-C D-PANE): the ONE object pane on
//          its Format tab and on the grid's Properties tab, through
//          @api/objectPane's menu entry -- hidden while the pane cannot open.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { buildFrContextMenu, type FrContextMenuHandlers } from "../frContextMenu";
import type { GridRegion } from "@api/gridOverlays";
import { registerObjectGeometryProvider, resetObjectGeometryProviders } from "@api/objectGeometry";
import { registerSizeAndPositionOpener, resetObjectPosition } from "@api/objectPosition";
import {
  registerObjectPaneHost,
  registerObjectPaneProvider,
  resetObjectPane,
  type ObjectPaneOpenRequest,
} from "@api/objectPane";

const REGION: GridRegion = {
  id: "fr-fr-1",
  type: "floating-range",
  startRow: 0,
  startCol: 0,
  endRow: 0,
  endCol: 0,
  data: { frId: "fr-1" },
  floating: { x: 64, y: 32, width: 200, height: 100 },
};

beforeEach(() => {
  resetObjectPosition();
  resetObjectGeometryProviders();
  resetObjectPane();
});

function handlers(geometry: boolean, rows = 3, cols = 3, region: GridRegion | null = null): FrContextMenuHandlers {
  return {
    addRow: vi.fn(),
    addColumn: vi.fn(),
    deleteLastRow: vi.fn(),
    deleteLastColumn: vi.fn(),
    rename: vi.fn(),
    deleteObject: vi.fn(),
    getCounts: () => ({ rows, cols }),
    canEditGeometry: () => geometry,
    regionOf: () => region,
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
      "floatingRange.delete",
    ]);
  });

  it("withholds ALL FOUR size items on a locked range, and keeps Rename / Delete", () => {
    const ids = enabledIds(false);
    for (const id of SIZE_ITEMS) expect(ids).not.toContain(id);
    expect(ids).toEqual(["floatingRange.rename", "floatingRange.delete"]);
  });

  it("still gates the shrink items on the live window (a 1x1 range cannot lose a row)", () => {
    const ids = enabledIds(true, 1, 1);
    expect(ids).toContain("floatingRange.addRow");
    expect(ids).not.toContain("floatingRange.deleteLastRow");
    expect(ids).not.toContain("floatingRange.deleteLastColumn");
  });
});

describe("Size and Position... in the floating range menu", () => {
  function installed(): string[] {
    const opened: string[] = [];
    registerObjectGeometryProvider({ types: ["floating-range"], canResize: () => false, commit: async () => {} });
    registerSizeAndPositionOpener((r) => opened.push(r.id));
    return opened;
  }

  it("is offered after the size items, before Rename, and opens the dialog for the range's region", () => {
    const opened = installed();
    const items = buildFrContextMenu("fr-1", handlers(true, 3, 3, REGION)).filter((i) => i.enabled);
    const ids = items.map((i) => i.id);
    expect(ids).toEqual([...SIZE_ITEMS, "floatingRange.sizeAndPosition", "floatingRange.rename", "floatingRange.delete"]);
    const row = items.find((i) => i.id === "floatingRange.sizeAndPosition")!;
    expect(row.label).toBe("Size and Position...");
    row.run();
    expect(opened).toEqual([REGION.id]);
  });

  it("a LOCKED range still offers it (the dialog opens read-only there)", () => {
    installed();
    const ids = buildFrContextMenu("fr-1", handlers(false, 3, 3, REGION)).filter((i) => i.enabled).map((i) => i.id);
    expect(ids).toEqual(["floatingRange.sizeAndPosition", "floatingRange.rename", "floatingRange.delete"]);
  });

  it("is hidden when the range is not published, or no dialog is installed", () => {
    installed();
    expect(buildFrContextMenu("fr-1", handlers(true)).filter((i) => i.enabled).map((i) => i.id)).not.toContain("floatingRange.sizeAndPosition");
    resetObjectPosition();
    expect(buildFrContextMenu("fr-1", handlers(true, 3, 3, REGION)).filter((i) => i.enabled).map((i) => i.id)).not.toContain("floatingRange.sizeAndPosition");
  });
});

describe("Format... and Properties... open the ONE object pane", () => {
  function installedPane(): ObjectPaneOpenRequest[] {
    const opened: ObjectPaneOpenRequest[] = [];
    registerObjectPaneProvider({
      types: ["floating-range"],
      tabs: () => [{ id: "properties", label: "Properties", render: () => null }],
    });
    registerObjectPaneHost({
      open: (req) => {
        opened.push(req);
        return true;
      },
      close: () => {},
      state: () => ({ open: false, regionId: null, regionType: null, tabId: null }),
    });
    return opened;
  }

  it("are offered between Size and Position and Delete, and open Format / Properties as a door", () => {
    const opened = installedPane();
    const items = buildFrContextMenu("fr-1", handlers(true, 3, 3, REGION)).filter((i) => i.enabled);
    expect(items.map((i) => i.id)).toEqual([
      ...SIZE_ITEMS,
      "floatingRange.format",
      "floatingRange.rename",
      "floatingRange.properties",
      "floatingRange.delete",
    ]);
    const format = items.find((i) => i.id === "floatingRange.format")!;
    expect(format.label).toBe("Format...");
    format.run();
    items.find((i) => i.id === "floatingRange.properties")!.run();
    expect(opened.map((r) => [r.region?.id, r.tab, r.reason])).toEqual([
      [REGION.id, "format", "command"],
      [REGION.id, "properties", "command"],
    ]);
  });

  it("a LOCKED range still offers both (formatting is not geometry; the counts freeze in the tab)", () => {
    installedPane();
    const ids = buildFrContextMenu("fr-1", handlers(false, 3, 3, REGION)).filter((i) => i.enabled).map((i) => i.id);
    expect(ids).toEqual(["floatingRange.format", "floatingRange.rename", "floatingRange.properties", "floatingRange.delete"]);
  });

  it("are hidden when the range is not published or no pane is installed", () => {
    installedPane();
    const unpublished = buildFrContextMenu("fr-1", handlers(true)).filter((i) => i.enabled).map((i) => i.id);
    expect(unpublished).not.toContain("floatingRange.format");
    expect(unpublished).not.toContain("floatingRange.properties");
    resetObjectPane();
    const noPane = buildFrContextMenu("fr-1", handlers(true, 3, 3, REGION)).filter((i) => i.enabled).map((i) => i.id);
    expect(noPane).not.toContain("floatingRange.format");
    expect(noPane).not.toContain("floatingRange.properties");
  });
});
