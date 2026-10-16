//! FILENAME: app/extensions/Controls/__tests__/pageNavigatorCreate.test.ts
// PURPOSE: A Page Navigator is created as ONE control by the one recipe
//          (PageNavigator/createPageNavigator.ts, the @api/buttonControlService
//          provider's `createPageNavigator`; WP-B, D-NAV S6):
//            - ONE `setControlMetadata` carrying the 18-key recipe, every value
//              static, controlType "pageNavigator", `pinToGrid` and `embedded`
//              the STRING "false";
//            - the floating store knows it with its type, its region is
//              published, the grid repaints, and the handle says where it is;
//            - no size asked: the natural box for the pages it will list now
//              (or the seam's four-item default before the page list was read);
//            - a refused request writes NOTHING and claims no anchor.
// CONTEXT: The in-memory control-metadata stand-in buttonActionCreate.test.ts
//          uses; the page list is a doubled @api/reportPages snapshot.

import { describe, it, expect, beforeEach, vi } from "vitest";
import type { ReportPage, ReportPagesSnapshot } from "@api/reportPages";

interface Meta {
  controlType: string;
  properties: Record<string, { valueType: string; value: string }>;
}

const h = vi.hoisted(() => ({
  setCalls: 0,
  allControlsReads: 0,
  syncs: 0,
  events: [] as string[],
  snapshot: null as unknown,
}));

const backend = new Map<string, Meta>();
const key = (s: number, r: number, c: number) => `${s}:${r}:${c}`;
const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

vi.mock("../lib/controlApi", () => ({
  async getControlMetadata(s: number, r: number, c: number) {
    await tick();
    return backend.get(key(s, r, c)) ?? null;
  },
  async setControlMetadata(s: number, r: number, c: number, meta: Meta) {
    await tick();
    h.setCalls++;
    backend.set(key(s, r, c), JSON.parse(JSON.stringify(meta)));
    return meta;
  },
  async removeControlMetadata(s: number, r: number, c: number) {
    await tick();
    return backend.delete(key(s, r, c));
  },
  async getAllControls(s: number) {
    await tick();
    h.allControlsReads++;
    return [...backend.entries()]
      .map(([k, metadata]) => {
        const [sheetIndex, row, col] = k.split(":").map(Number);
        return { sheetIndex, row, col, metadata };
      })
      .filter((e) => e.sheetIndex === s);
  },
  setControlProperty: vi.fn(),
  resolveControlProperties: vi.fn(async () => ({})),
}));

vi.mock("../lib/floatingStore", async (importOriginal) => {
  const real = await importOriginal<typeof import("../lib/floatingStore")>();
  return {
    ...real,
    syncFloatingControlRegions: () => {
      h.syncs++;
      real.syncFloatingControlRegions();
    },
  };
});

vi.mock("@api/grid", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getGridStateSnapshot: () => ({
    config: { defaultCellWidth: 100, defaultCellHeight: 24, activeSheet: 0 },
    dimensions: { columnWidths: new Map([[0, 50]]), rowHeights: new Map([[1, 40]]) },
    sheetContext: { activeSheetIndex: 0, activeSheetName: "A" },
  }),
}));

vi.mock("@api/events", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  emitAppEvent: (name: string) => {
    h.events.push(name);
  },
}));

vi.mock("@api/reportPages", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getReportPagesSnapshot: () => h.snapshot,
}));

import {
  PAGE_NAVIGATOR_CONTROL_TYPE,
  PAGE_NAVIGATOR_DEFAULT_SIZE,
  pageNavigatorNaturalSize,
} from "@api/buttonControlService";
import { AppEvents } from "@api/events";
import { createPageNavigatorAt } from "../PageNavigator/createPageNavigator";
import { pageNavigatorRecipe } from "../PageNavigator/pageNavigatorRecipe";
import { getAllFloatingControls, getFloatingControl, removeFloatingControl } from "../lib/floatingStore";

function page(index: number, name: string, extra: Partial<ReportPage> = {}): ReportPage {
  return { sheetId: `id-${name}`, name, index, visibility: "visible", isTooltipPage: false, ...extra };
}

function snapshotOf(pages: ReportPage[], version = 1): ReportPagesSnapshot {
  return { pages, sheetIdByIndex: new Map(pages.map((p) => [p.index, p.sheetId])), activeIndex: 0, version };
}

function stored(s: number, r: number, c: number): { controlType: string; values: Record<string, string>; types: string[] } {
  const meta = backend.get(key(s, r, c));
  expect(meta, `no control metadata at ${key(s, r, c)}`).toBeDefined();
  return {
    controlType: meta!.controlType,
    values: Object.fromEntries(Object.entries(meta!.properties).map(([k, v]) => [k, v.value])),
    types: Object.values(meta!.properties).map((v) => v.valueType),
  };
}

beforeEach(() => {
  backend.clear();
  for (const c of getAllFloatingControls()) removeFloatingControl(c.id);
  h.setCalls = 0;
  h.allControlsReads = 0;
  h.syncs = 0;
  h.events = [];
  // Three listed pages (a hidden one and a Tooltip page are not listed).
  h.snapshot = snapshotOf([
    page(1, "A"),
    page(2, "B"),
    page(3, "Hidden", { visibility: "hidden" }),
    page(4, "Tip", { isTooltipPage: true }),
    page(5, "C"),
  ]);
});

describe("createPageNavigator writes ONE control from the one recipe", () => {
  it("at a position: one metadata write with the 18-key recipe, the store entry, the region, the repaint, the handle", async () => {
    const handle = await createPageNavigatorAt({ sheetIndex: 1, x: 40, y: 60 });
    const size = pageNavigatorNaturalSize(3);

    expect(h.setCalls, "a navigator is ONE metadata write").toBe(1);
    const at = { row: handle.row, col: handle.col };
    const s = stored(1, at.row, at.col);
    expect(s.controlType).toBe(PAGE_NAVIGATOR_CONTROL_TYPE);
    expect(s.values).toEqual(pageNavigatorRecipe({ x: 40, y: 60, ...size }, "horizontal"));
    expect(Object.keys(s.values)).toHaveLength(18);
    expect(new Set(s.types)).toEqual(new Set(["static"]));
    expect(s.values.pinToGrid).toBe("false");
    expect(s.values.embedded).toBe("false");
    for (const k of ["text", "onSelect", "tooltip", "action", "actionTarget", "actionTargetName", "macroRef"]) {
      expect(s.values, `a navigator carries no ${k}`).not.toHaveProperty(k);
    }

    const ctrl = getFloatingControl(handle.instanceId);
    expect(ctrl).toMatchObject({ controlType: PAGE_NAVIGATOR_CONTROL_TYPE, sheetIndex: 1, x: 40, y: 60, ...size });
    expect(h.syncs, "the region was never published").toBeGreaterThan(0);
    expect(h.events).toContain(AppEvents.GRID_REFRESH);
    expect(handle).toEqual({
      instanceId: `control-1-${at.row}-${at.col}`,
      sheetIndex: 1,
      row: at.row,
      col: at.col,
      x: 40,
      y: 60,
      ...size,
    });
  });

  it("at an anchor: the anchor cell's WALKED origin (custom column width and row height)", async () => {
    const handle = await createPageNavigatorAt({ sheetIndex: 0, row: 2, col: 1 });
    // Column 0 is 50 wide; rows 0 and 1 are 24 and 40 tall.
    expect(handle).toMatchObject({ row: 2, col: 1, x: 50, y: 64 });
    expect(stored(0, 2, 1).values).toMatchObject({ x: "50", y: "64" });
  });

  it("an asked size and orientation are used as given", async () => {
    const handle = await createPageNavigatorAt({ sheetIndex: 1, x: 0, y: 0, width: 300, height: 90, orientation: "vertical" });
    expect(handle).toMatchObject({ width: 300, height: 90 });
    expect(stored(1, handle.row, handle.col).values).toMatchObject({ width: "300", height: "90", orientation: "vertical" });
  });

  it("no size: natural for the pages listed NOW; the seam's four-item default before the list was ever read", async () => {
    h.snapshot = snapshotOf([page(1, "Only")]);
    const one = await createPageNavigatorAt({ sheetIndex: 1, x: 0, y: 0 });
    expect(one).toMatchObject(pageNavigatorNaturalSize(1));

    h.snapshot = snapshotOf([], 0);
    const unread = await createPageNavigatorAt({ sheetIndex: 1, x: 0, y: 100 });
    expect(unread).toMatchObject({ width: PAGE_NAVIGATOR_DEFAULT_SIZE.width, height: PAGE_NAVIGATOR_DEFAULT_SIZE.height });
  });

  it("a vertical navigator with no size is one item wide and the items tall", async () => {
    const handle = await createPageNavigatorAt({ sheetIndex: 1, x: 0, y: 0, orientation: "vertical" });
    const horizontal = pageNavigatorNaturalSize(3);
    expect(handle.width).toBeLessThan(horizontal.width);
    expect(handle.height).toBeGreaterThan(horizontal.height);
    expect(handle.width * 3).toBeLessThanOrEqual(horizontal.width);
  });
});

describe("a refused request writes nothing", () => {
  const refused: Array<[string, Record<string, unknown>]> = [
    ["an unknown orientation", { sheetIndex: 0, x: 0, y: 0, orientation: "diagonal" }],
    ["x without y", { sheetIndex: 0, x: 10 }],
    ["a zero width", { sheetIndex: 0, x: 0, y: 0, width: 0 }],
    ["a non-finite height", { sheetIndex: 0, x: 0, y: 0, height: Number.NaN }],
    ["neither anchor nor position", { sheetIndex: 0 }],
  ];
  for (const [name, request] of refused) {
    it(`${name}: rejects with a sentence, no metadata, no store entry, no anchor read`, async () => {
      await expect(createPageNavigatorAt(request as never)).rejects.toThrow(/page navigator/i);
      expect(h.setCalls).toBe(0);
      expect(h.allControlsReads, "a refused request claimed an anchor").toBe(0);
      expect(getAllFloatingControls()).toHaveLength(0);
      expect(backend.size).toBe(0);
    });
  }
});
