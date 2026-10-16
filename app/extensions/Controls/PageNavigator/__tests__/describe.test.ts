//! FILENAME: app/extensions/Controls/PageNavigator/__tests__/describe.test.ts
// PURPOSE: `describePageNavigator` -- THE read the paint, the zone, the press
//          and the live proof share (WP-B, D-NAV S6):
//            - the current page is decided BY ID (the grid's active index ->
//              the page at that index), so renaming the active page keeps its
//              item current, and a page that merely shares the active sheet's
//              old name is not;
//            - the pressed item is the one a held press names;
//            - a live page-list change re-derives the items (nothing stored);
//            - READ-ONLY: with an empty settings cache it describes from the
//              defaults and starts NO fetch -- the purity the zone relies on;
//            - geometry in sheet px from the floating store's box, padding
//              applied once.
// CONTEXT: The page list is a doubled @api/reportPages snapshot and the grid's
//          sheet context a doubled @api/grid snapshot; the settings cache is
//          doubled so the test can see whether a fetch was started.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { ReportPage, ReportPagesSnapshot } from "@api/reportPages";
import type { PageNavigatorProps } from "../navigatorModel";

const h = vi.hoisted(() => ({
  snapshot: null as unknown,
  activeIndex: 0 as number | undefined,
  activeName: "" as string | undefined,
  props: new Map<string, unknown>(),
  fetches: 0,
  resolves: 0,
}));

vi.mock("@api/reportPages", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getReportPagesSnapshot: () => h.snapshot,
}));
vi.mock("@api/grid", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getGridStateSnapshot: () => ({ sheetContext: { activeSheetIndex: h.activeIndex, activeSheetName: h.activeName } }),
}));
vi.mock("../navigatorCache", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getPageNavigatorProps: (id: string) => h.props.get(id),
  fetchPageNavigatorProps: async () => {
    h.fetches++;
  },
}));
vi.mock("../../lib/controlApi", () => ({
  resolveControlProperties: async () => {
    h.resolves++;
    return {};
  },
}));

import { PAGE_NAVIGATOR_CONTROL_TYPE, serializePageNavigatorOverrides } from "@api/buttonControlService";
import { describePageNavigator } from "../describe";
import { readPageNavigatorProps, layoutNavigatorItems, navigatorItemArea } from "../navigatorModel";
import { addFloatingControl, getAllFloatingControls, removeFloatingControl } from "../../lib/floatingStore";
import { beginFloatingButtonPress, cancelFloatingButtonPress } from "../../lib/buttonPress";
import { noteControlProperties, resetControlContainers } from "../../lib/controlContainer";

const NAV = "control-1-0-3";

function page(index: number, name: string, extra: Partial<ReportPage> = {}): ReportPage {
  return { sheetId: `id-${index}`, name, index, visibility: "visible", isTooltipPage: false, ...extra };
}

function snapshotOf(pages: ReportPage[]): ReportPagesSnapshot {
  return { pages, sheetIdByIndex: new Map(pages.map((p) => [p.index, p.sheetId])), activeIndex: 1, version: 1 };
}

function props(resolved: Record<string, string>): PageNavigatorProps {
  return readPageNavigatorProps(resolved);
}

beforeEach(() => {
  for (const c of getAllFloatingControls()) removeFloatingControl(c.id);
  addFloatingControl({
    id: NAV,
    sheetIndex: 1,
    row: 0,
    col: 3,
    x: 100,
    y: 40,
    width: 360,
    height: 32,
    controlType: PAGE_NAVIGATOR_CONTROL_TYPE,
  });
  h.snapshot = snapshotOf([page(1, "Overview"), page(2, "Sales"), page(3, "Detail")]);
  h.activeIndex = 1;
  h.activeName = "Overview";
  h.props.clear();
  resetControlContainers();
  h.fetches = 0;
  h.resolves = 0;
});

afterEach(() => {
  cancelFloatingButtonPress();
});

describe("the current page is decided by id", () => {
  it("the item of the page at the grid's active index is current, and only it", () => {
    const d = describePageNavigator(NAV)!;
    expect(d.items.map((i) => [i.caption, i.current])).toEqual([
      ["Overview", true],
      ["Sales", false],
      ["Detail", false],
    ]);
  });

  // SABOTAGE: compare by name in `currentPageKey` -> red.
  it("renaming the ACTIVE page keeps its item current (same id); a page that took the old name is not current", () => {
    h.activeIndex = 2;
    h.activeName = "Sales";
    // The active page is renamed, and ANOTHER page now carries its old name;
    // the grid's name is stale until the next sheet-context update.
    h.snapshot = snapshotOf([page(1, "Sales"), page(2, "Sales Overview"), page(3, "Detail")]);
    const d = describePageNavigator(NAV)!;
    expect(d.items.find((i) => i.caption === "Sales Overview")?.current, "the renamed active page lost its current mark").toBe(
      true,
    );
    expect(d.items.find((i) => i.caption === "Sales")?.current, "a namesake was marked current").toBe(false);
  });

  it("a worksheet (not a report page) active: no item is current", () => {
    h.activeIndex = 0;
    expect(describePageNavigator(NAV)!.items.some((i) => i.current)).toBe(false);
  });
});

describe("the pressed item", () => {
  it("is the one a held press names, and only while it is held", () => {
    beginFloatingButtonPress({ controlId: NAV, regionId: NAV, itemKey: "id-2", itemAtClient: () => "id-2", run: () => {} });
    expect(describePageNavigator(NAV)!.items.map((i) => i.pressed)).toEqual([false, true, false]);
    cancelFloatingButtonPress();
    expect(describePageNavigator(NAV)!.items.some((i) => i.pressed)).toBe(false);
  });
});

describe("items are derived live, never stored", () => {
  it("a page added to the snapshot appears at the next read; one removed is gone", () => {
    expect(describePageNavigator(NAV)!.items.map((i) => i.caption)).toEqual(["Overview", "Sales", "Detail"]);
    h.snapshot = snapshotOf([page(1, "Overview"), page(2, "Sales"), page(3, "Detail"), page(4, "New")]);
    expect(describePageNavigator(NAV)!.items.map((i) => i.caption)).toEqual(["Overview", "Sales", "Detail", "New"]);
    h.snapshot = snapshotOf([page(1, "Overview"), page(4, "New")]);
    expect(describePageNavigator(NAV)!.items.map((i) => i.caption)).toEqual(["Overview", "New"]);
  });

  it("the cached settings apply: overrides by id, hidden pages only with Show hidden pages", () => {
    h.snapshot = snapshotOf([page(1, "Overview"), page(2, "Sales", { visibility: "hidden" }), page(3, "Detail")]);
    expect(describePageNavigator(NAV)!.items.map((i) => i.caption)).toEqual(["Overview", "Detail"]);
    h.props.set(
      NAV,
      props({
        showHiddenPages: "true",
        pageOverrides: serializePageNavigatorOverrides([{ sheetId: "id-3", sheetName: "Detail", text: "Details" }]),
      }),
    );
    const d = describePageNavigator(NAV)!;
    expect(d.items.map((i) => [i.caption, i.hiddenPage])).toEqual([
      ["Overview", false],
      ["Sales", true],
      ["Details", false],
    ]);
  });
});

describe("read-only", () => {
  it("with an EMPTY settings cache it describes from the defaults and starts no fetch and no read", () => {
    const d = describePageNavigator(NAV)!;
    expect(d.props).toEqual(readPageNavigatorProps(null));
    expect(h.fetches, "describe started a fetch (zoneAt must stay pure)").toBe(0);
    expect(h.resolves).toBe(0);
  });
});

describe("geometry", () => {
  it("the box is the store's (sheet px), the items divide it after the padding", () => {
    h.props.set(NAV, props({ padding: "4", gap: "6" }));
    const d = describePageNavigator(NAV)!;
    expect(d.box).toEqual({ x: 100, y: 40, width: 360, height: 32 });
    const expected = layoutNavigatorItems(navigatorItemArea(d.box, d.props), 3, d.props);
    expect(d.items.map((i) => i.rect)).toEqual(expected);
    expect(d.items[0].rect.x).toBe(104);
    expect(d.items[0].rect.y).toBe(44);
  });

  // WP-C C3 / J23: the rects are laid out in the CONTENT RECT of the container
  // the navigator is published with -- whose padding IS its padding key -- so
  // describe's rects start at the content origin (no double inset), and a
  // Core-painted title moves them down by its band.
  it("with the published container (padding 12) the first rect starts at the content origin, inset ONCE", () => {
    const resolved = { padding: "12", gap: "6" };
    h.props.set(NAV, props(resolved));
    noteControlProperties(NAV, PAGE_NAVIGATOR_CONTROL_TYPE, resolved);
    const d = describePageNavigator(NAV)!;
    expect(d.items[0].rect.x).toBe(112);
    expect(d.items[0].rect.y).toBe(52);
    expect(d.items[0].rect.height).toBe(32 - 24);
  });

  it("a Core-painted title on the container moves the rects below its band", () => {
    const resolved = { padding: "2", containerTitleShow: "true", containerTitleText: "Pages", containerTitleFontSize: "8" };
    h.props.set(NAV, props(resolved));
    noteControlProperties(NAV, PAGE_NAVIGATOR_CONTROL_TYPE, resolved);
    const d = describePageNavigator(NAV)!;
    // padding 2, the title band ceil(8 * 1.25) = 10, the default 4 below it.
    expect(d.items[0].rect.y).toBe(40 + 2 + 10 + 4);
    expect(d.items[0].rect.x).toBe(102);
  });

  it("null for an unknown control and for a control that is not a navigator", () => {
    expect(describePageNavigator("control-9-9-9")).toBeNull();
    addFloatingControl({ id: "control-1-0-4", sheetIndex: 1, row: 0, col: 4, x: 0, y: 0, width: 80, height: 28, controlType: "button" });
    expect(describePageNavigator("control-1-0-4")).toBeNull();
  });
});
