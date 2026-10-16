//! FILENAME: app/extensions/Controls/PageNavigator/__tests__/navigatorModel.test.ts
// PURPOSE: The pure Page Navigator model (WP-B S5): which items a navigator
//          shows, how overrides apply, where each item is, and which page is
//          current -- the one answer paint, zone, press and pane all share.

import { describe, it, expect } from "vitest";
import type { ReportPage } from "@api/reportPages";
import { serializePageNavigatorOverrides } from "@api/buttonControlService";
import {
  NAV_GAP_PART,
  currentPageKey,
  layoutNavigatorItems,
  navItemPart,
  navigatorItemArea,
  navigatorItemAt,
  navigatorItemKey,
  navigatorItems,
  pageNavigatorContainerDefaults,
  pageNavigatorFallbackContainer,
  parseNavItemPart,
  readPageNavigatorProps,
  type PageNavigatorProps,
} from "../navigatorModel";
import { PAGE_NAVIGATOR_DEFAULTS } from "../pageNavigatorRecipe";

function page(over: Partial<ReportPage> & { name: string; index: number }): ReportPage {
  return { sheetId: `id-${over.name}`, visibility: "visible", isTooltipPage: false, ...over };
}

const SALES = page({ name: "Sales", index: 1 });
const HIDDEN = page({ name: "Archive", index: 2, visibility: "hidden" });
const VERY = page({ name: "Secret", index: 3, visibility: "veryHidden" });
const TIP = page({ name: "Tip", index: 4, isTooltipPage: true });
const DETAIL = page({ name: "Detail", index: 5 });
const PAGES: ReportPage[] = [SALES, HIDDEN, VERY, TIP, DETAIL];

function props(over: Partial<Record<string, string>> = {}): PageNavigatorProps {
  return readPageNavigatorProps(over as Record<string, string>);
}

describe("readPageNavigatorProps", () => {
  it("an empty record is exactly the defaults table, parsed", () => {
    const d = PAGE_NAVIGATOR_DEFAULTS;
    expect(readPageNavigatorProps({})).toEqual({
      orientation: d.orientation,
      gap: Number(d.gap),
      padding: Number(d.padding),
      fill: d.fill,
      color: d.color,
      borderColor: d.borderColor,
      fontSize: Number(d.fontSize),
      selectedFill: d.selectedFill,
      selectedColor: d.selectedColor,
      showHiddenPages: d.showHiddenPages === "true",
      showTooltipPages: d.showTooltipPages === "true",
      overrides: [],
    });
    expect(readPageNavigatorProps(null)).toEqual(readPageNavigatorProps({}));
  });

  it("clamps numbers and falls back on bad values", () => {
    const p = props({ gap: "500", padding: "-3", fontSize: "abc", orientation: "diagonal", fill: "  " });
    expect(p.gap).toBe(64);
    expect(p.padding).toBe(0);
    expect(p.fontSize).toBe(Number(PAGE_NAVIGATOR_DEFAULTS.fontSize));
    expect(p.orientation).toBe("horizontal");
    expect(p.fill).toBe(PAGE_NAVIGATOR_DEFAULTS.fill);
    expect(props({ orientation: "vertical", showHiddenPages: "true" })).toMatchObject({
      orientation: "vertical",
      showHiddenPages: true,
    });
  });
});

describe("navigatorItems", () => {
  it("lists visible, non-tooltip pages in tab order by default", () => {
    const items = navigatorItems(PAGES, props());
    expect(items.map((i) => i.sheetName)).toEqual(["Sales", "Detail"]);
    expect(items[0]).toMatchObject({
      key: "id-Sales",
      sheetId: "id-Sales",
      index: 1,
      caption: "Sales",
      hiddenPage: false,
      tooltipPage: false,
      fill: PAGE_NAVIGATOR_DEFAULTS.fill,
    });
  });

  it("lists hidden and tooltip pages only when asked, never veryHidden", () => {
    const items = navigatorItems(PAGES, props({ showHiddenPages: "true", showTooltipPages: "true" }));
    expect(items.map((i) => i.sheetName)).toEqual(["Sales", "Archive", "Tip", "Detail"]);
    expect(items.find((i) => i.sheetName === "Archive")?.hiddenPage).toBe(true);
    expect(items.find((i) => i.sheetName === "Tip")?.tooltipPage).toBe(true);
  });

  it("applies an override by id: caption, colours, hide", () => {
    const overrides = serializePageNavigatorOverrides([
      { sheetId: "id-Sales", sheetName: "OldName", text: "Overview", fill: "#112233", color: "#445566", borderColor: "#778899" },
      { sheetId: "id-Detail", sheetName: "Detail", hidden: true },
    ]);
    const items = navigatorItems(PAGES, props({ pageOverrides: overrides }));
    expect(items.map((i) => i.sheetName)).toEqual(["Sales"]);
    expect(items[0]).toMatchObject({ caption: "Overview", fill: "#112233", color: "#445566", borderColor: "#778899" });
  });

  it("applies an override by NAME when its id names no live page (a subscriber's ids)", () => {
    const overrides = serializePageNavigatorOverrides([{ sheetId: "gone-id", sheetName: "detail", text: "More" }]);
    const items = navigatorItems(PAGES, props({ pageOverrides: overrides }));
    expect(items.find((i) => i.sheetName === "Detail")?.caption).toBe("More");
  });

  it("never applies by name an override whose id belongs to ANOTHER live page", () => {
    // Its id is the hidden Archive page (unlisted but live); its stale name is "Detail".
    const overrides = serializePageNavigatorOverrides([{ sheetId: "id-Archive", sheetName: "Detail", text: "Wrong" }]);
    const items = navigatorItems(PAGES, props({ pageOverrides: overrides }));
    expect(items.find((i) => i.sheetName === "Detail")?.caption).toBe("Detail");
  });

  it("an empty caption falls back to the page name", () => {
    const overrides = serializePageNavigatorOverrides([{ sheetId: "id-Sales", sheetName: "Sales", text: "" }]);
    expect(navigatorItems(PAGES, props({ pageOverrides: overrides }))[0].caption).toBe("Sales");
  });
});

describe("item keys and parts", () => {
  it("keys by id, by name only without one, and round-trips a part", () => {
    expect(navigatorItemKey({ sheetId: "abc", name: "Sales" })).toBe("abc");
    expect(navigatorItemKey({ sheetId: "", name: "Sales" })).toBe("name:Sales");
    expect(parseNavItemPart(navItemPart("abc"))).toBe("abc");
    expect(parseNavItemPart(navItemPart("name:Sales"))).toBe("name:Sales");
    expect(parseNavItemPart(NAV_GAP_PART)).toBeNull();
    expect(parseNavItemPart("button")).toBeNull();
    expect(parseNavItemPart("navItem:")).toBeNull();
    expect(parseNavItemPart(undefined)).toBeNull();
  });
});

describe("navigatorItemArea (the ONE place padding applies)", () => {
  it("insets by padding on all four sides", () => {
    expect(navigatorItemArea({ x: 10, y: 20, width: 100, height: 40 }, { padding: 5 })).toEqual({
      x: 15,
      y: 25,
      width: 90,
      height: 30,
    });
  });

  it("never goes below 0 x 0", () => {
    // The content rect of @api/visualContainer's layout: a padding wider than
    // the box leaves NO area (it is clamped, never negative), so no item is laid out.
    const a = navigatorItemArea({ x: 0, y: 0, width: 20, height: 10 }, { padding: 30 });
    expect(a.width).toBe(0);
    expect(a.height).toBe(0);
    expect(layoutNavigatorItems(a, 2, { orientation: "horizontal", gap: 0 }).every((r) => r.width === 0)).toBe(true);
  });
});

// WP-C C3 / J23 (S13): the item area IS the navigator's CONTENT RECT --
// `visualContentRectFor(regionId, box, container)` -- and the container's
// padding IS the navigator's own `padding`, so Core's band, the layout, the
// hit and describe agree, and the padding is applied exactly once.
describe("navigatorItemArea is the container's content rect (WP-C)", () => {
  const box = { x: 100, y: 50, width: 300, height: 80 };

  it("with the container the provider publishes (padding 12) it is the box inset by 12 -- not 24", () => {
    const p = props({ padding: "12" });
    const container = pageNavigatorFallbackContainer(p.padding);
    const area = navigatorItemArea(box, p, { regionId: "control-0-1-1", container });
    expect(area).toEqual({ x: 112, y: 62, width: 276, height: 56 });
    // Without a published container the answer is the same rect (no double inset, no jump).
    expect(navigatorItemArea(box, p)).toEqual(area);
  });

  it("navigatorItemAt at the content origin hits item 0; the padding band hits nothing", () => {
    const p = props({ padding: "12", gap: "8" });
    const items = navigatorItems(PAGES, p); // Sales, Detail
    const area = { regionId: "control-0-1-1", container: pageNavigatorFallbackContainer(p.padding) };
    expect(navigatorItemAt(box, items, p, { x: 112, y: 62 }, area)?.sheetName).toBe("Sales");
    expect(navigatorItemAt(box, items, p, { x: 106, y: 90 }, area)).toBeNull();
    expect(navigatorItemAt(box, items, p, { x: 200, y: 55 }, area)).toBeNull();
  });

  it("a Core-painted title and a shown border move the items inside the same rect", () => {
    const p = props({ padding: "4" });
    const base = pageNavigatorFallbackContainer(p.padding);
    const container = {
      ...base,
      title: { ...base.title, show: true, fontSize: 16, text: "Pages" },
      spacing: { ...base.spacing, belowTitle: 4 },
      border: { ...base.border, show: true, width: 2 },
    };
    const area = navigatorItemArea(box, p, { regionId: "control-0-1-1", container });
    // border 2 + padding 4 on every side; the title band (ceil(16 * 1.25) = 20) + 4 below it.
    expect(area).toEqual({ x: 106, y: 50 + 2 + 4 + 20 + 4, width: 288, height: 80 - 2 - 4 - 20 - 4 - 4 - 2 });
  });

  it("the defaults paint nothing round the items (no background, no border, all Core's)", () => {
    const c = pageNavigatorContainerDefaults();
    expect(c.background.show).toBe(false);
    expect(c.border.show).toBe(false);
    expect(c.paint).toEqual({ background: "core", border: "core", title: "core", shadow: "core" });
  });
});

describe("layoutNavigatorItems", () => {
  it("divides a horizontal area equally, gap apart", () => {
    const rects = layoutNavigatorItems({ x: 0, y: 0, width: 232, height: 32 }, 2, { orientation: "horizontal", gap: 8 });
    expect(rects).toEqual([
      { x: 0, y: 0, width: 112, height: 32 },
      { x: 120, y: 0, width: 112, height: 32 },
    ]);
  });

  it("divides a vertical area equally, gap apart", () => {
    const rects = layoutNavigatorItems({ x: 5, y: 10, width: 100, height: 100 }, 3, { orientation: "vertical", gap: 5 });
    expect(rects.map((r) => r.y)).toEqual([10, 45, 80]);
    expect(rects.every((r) => r.height === 30 && r.width === 100 && r.x === 5)).toBe(true);
  });

  it("shrinks the gap (never the count) when crowded", () => {
    const rects = layoutNavigatorItems({ x: 0, y: 0, width: 20, height: 10 }, 5, { orientation: "horizontal", gap: 10 });
    expect(rects).toHaveLength(5);
    for (const r of rects) expect(r.width).toBeGreaterThanOrEqual(1);
    const last = rects[4];
    expect(last.x + last.width).toBeCloseTo(20);
  });

  it("zero items lay out nothing", () => {
    expect(layoutNavigatorItems({ x: 0, y: 0, width: 100, height: 30 }, 0, { orientation: "horizontal", gap: 8 })).toEqual([]);
  });
});

describe("navigatorItemAt", () => {
  const p = props({ gap: "8", padding: "4" });
  const items = navigatorItems(PAGES, p); // Sales, Detail
  const box = { x: 100, y: 50, width: 240, height: 40 }; // area 104..336 x 54..86; items 104..216, 224..336

  it("finds the item under the point", () => {
    expect(navigatorItemAt(box, items, p, { x: 150, y: 70 })?.sheetName).toBe("Sales");
    expect(navigatorItemAt(box, items, p, { x: 300, y: 70 })?.sheetName).toBe("Detail");
  });

  it("is null on a gap", () => {
    expect(navigatorItemAt(box, items, p, { x: 220, y: 70 })).toBeNull();
  });

  it("is null on the padding band", () => {
    expect(navigatorItemAt(box, items, p, { x: 102, y: 70 })).toBeNull();
    expect(navigatorItemAt(box, items, p, { x: 150, y: 52 })).toBeNull();
  });
});

describe("currentPageKey (by index -> id, never by name)", () => {
  it("names the page at the active index by its id", () => {
    expect(currentPageKey(PAGES, 5)).toBe("id-Detail");
  });

  it("still finds the active page after it was renamed", () => {
    // SABOTAGE: compare names in currentPageKey -> this goes red.
    const renamed = PAGES.map((pg) => (pg.index === 1 ? { ...pg, name: "Revenue" } : pg));
    expect(currentPageKey(renamed, 1)).toBe("id-Sales");
  });

  it("is null for a worksheet or an unknown index", () => {
    expect(currentPageKey(PAGES, 0)).toBeNull();
    expect(currentPageKey(PAGES, undefined)).toBeNull();
  });
});
