//! FILENAME: app/extensions/Controls/__tests__/pageNavigatorPress.test.ts
// PURPOSE: A RUN-MODE press on a Page Navigator item navigates at the release
//          over the same item (PageNavigator/navigatorPress.ts; WP-B, D-NAV S6):
//            - the item's page is opened through the declarative navigate action
//              (@api/sheetSwitch), by its sheet id;
//            - a hidden page's item says why it cannot open, and switches
//              nothing; the current page's item does nothing;
//            - a press on the gap arms nothing; a slide onto another item opens
//              neither;
//            - never `button:clicked`, never the script door;
//            - Controls' bodyDragStart listener routes a navigator's press here
//              BEFORE the button's `part !== "button"` return (source pin).
// CONTEXT: The real press session (lib/buttonPress.ts) and the real
//          `performButtonAction`; the sheet list, the switch, the toasts, the
//          page-list snapshot and the client -> canvas mapping are doubled.
//          The navigator's canvas box is x 100..340, y 50..90; with the default
//          gap of 8 its two items are x 100..216 and 224..340.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as path from "path";
import type { ReportPage, ReportPagesSnapshot } from "@api/reportPages";

const h = vi.hoisted(() => ({
  sheets: [] as Array<{ index: number; name: string; visibility: string; sheetId?: string }>,
  activeIndex: 0,
  activations: [] as number[],
  toasts: [] as Array<{ message: string; variant?: string }>,
  events: [] as string[],
  snapshot: null as unknown,
  props: undefined as unknown,
}));

vi.mock("@api/lib", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getSheets: async () => ({ sheets: h.sheets.map((s) => ({ ...s })), activeIndex: h.activeIndex }),
}));
vi.mock("@api/sheetSwitch", () => ({
  activateSheet: async (index: number) => {
    h.activations.push(index);
    return { sheets: h.sheets, activeIndex: index };
  },
}));
vi.mock("@api/notifications", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  showToast: (message: string, options?: { variant?: string; type?: string }) => {
    h.toasts.push({ message, variant: options?.variant ?? options?.type });
  },
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
vi.mock("@api/gridOverlays", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@api/gridOverlays")>()),
  requestOverlayRedraw: () => {},
  topFloatingRegionAtClient: (x: number, y: number) =>
    x >= 100 && x <= 340 && y >= 50 && y <= 90 ? { id: "control-1-0-3" } : null,
}));
vi.mock("../lib/controlHitTest", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  // Client == canvas here; the region's canvas box is fixed.
  floatingControlCanvasPoint: (_regionId: string, x: number, y: number) => ({
    point: { x, y },
    bounds: { x: 100, y: 50, width: 240, height: 40 },
  }),
}));
vi.mock("../PageNavigator/navigatorCache", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getPageNavigatorProps: () => h.props,
}));
vi.mock("../lib/controlApi", () => ({ resolveControlProperties: async () => ({}) }));

import { pressPageNavigatorItem } from "../PageNavigator/navigatorPress";
import { readPageNavigatorProps } from "../PageNavigator/navigatorModel";
import { cancelFloatingButtonPress, isFloatingButtonPressActive } from "../lib/buttonPress";

const NAV = "control-1-0-3";
const ITEM_1 = { x: 150, y: 70 };
const ITEM_2 = { x: 300, y: 70 };

function page(index: number, name: string, extra: Partial<ReportPage> = {}): ReportPage {
  return { sheetId: `id-${index}`, name, index, visibility: "visible", isTooltipPage: false, ...extra };
}

function useCanvases(pages: ReportPage[]): void {
  h.snapshot = {
    pages,
    sheetIdByIndex: new Map(pages.map((p) => [p.index, p.sheetId])),
    activeIndex: h.activeIndex,
    version: 1,
  } satisfies ReportPagesSnapshot;
  h.sheets = [
    { index: 0, name: "Sheet1", visibility: "visible", sheetId: "id-0" },
    ...pages.map((p) => ({ index: p.index, name: p.name, visibility: p.visibility, sheetId: p.sheetId })),
  ];
}

function press(part: string): boolean {
  return pressPageNavigatorItem({ controlId: NAV, regionId: NAV, sheetIndex: 1, part });
}

function release(at: { x: number; y: number }): void {
  window.dispatchEvent(new MouseEvent("mouseup", { clientX: at.x, clientY: at.y, button: 0, buttons: 0 }));
}

function move(at: { x: number; y: number }): void {
  window.dispatchEvent(new MouseEvent("mousemove", { clientX: at.x, clientY: at.y, buttons: 1 }));
}

const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

beforeEach(() => {
  h.activeIndex = 1;
  h.activations = [];
  h.toasts = [];
  h.events = [];
  h.props = undefined;
  useCanvases([page(1, "Overview"), page(2, "Sales")]);
});

afterEach(() => {
  cancelFloatingButtonPress();
});

describe("a run-mode item press navigates at the release", () => {
  it("released over the same item: its page is activated; no toast, no button:clicked", async () => {
    expect(press("navItem:id-2")).toBe(true);
    release(ITEM_2);
    await settle();
    expect(h.activations).toEqual([2]);
    expect(h.toasts).toEqual([]);
    expect(h.events, "a navigator press reached the script hook").not.toContain("button:clicked");
  });

  it("the page is found by ID: renamed while the press was held, it still opens", async () => {
    press("navItem:id-2");
    useCanvases([page(1, "Overview"), page(2, "Sales Overview")]);
    release(ITEM_2);
    await settle();
    expect(h.activations).toEqual([2]);
  });

  it("a HIDDEN page's item (listed with Show hidden pages): the info toast, and no switch", async () => {
    h.props = readPageNavigatorProps({ showHiddenPages: "true" });
    useCanvases([page(1, "Overview"), page(2, "Secret", { visibility: "hidden" })]);
    press("navItem:id-2");
    release(ITEM_2);
    await settle();
    expect(h.activations).toEqual([]);
    expect(h.toasts).toHaveLength(1);
    expect(h.toasts[0].message).toMatch(/"Secret".*is hidden, so the button cannot open it/);
    expect(h.toasts[0].variant).toBe("info");
  });

  it("the CURRENT page's item: nothing happens", async () => {
    press("navItem:id-1");
    release(ITEM_1);
    await settle();
    expect(h.activations).toEqual([]);
    expect(h.toasts).toEqual([]);
  });

  it("a press on the GAP arms nothing", async () => {
    expect(press("navGap")).toBe(false);
    expect(isFloatingButtonPressActive()).toBe(false);
    release(ITEM_2);
    await settle();
    expect(h.activations).toEqual([]);
  });

  it("slid from one item onto the other and released there: neither opens", async () => {
    press("navItem:id-2");
    move(ITEM_1);
    release(ITEM_1);
    await settle();
    expect(h.activations).toEqual([]);
    expect(h.toasts).toEqual([]);
  });

  it("the item's page left the list while the press was held: nothing", async () => {
    press("navItem:id-2");
    useCanvases([page(1, "Overview")]);
    release(ITEM_2);
    await settle();
    expect(h.activations).toEqual([]);
  });
});

describe("Controls routes a navigator's content press here", () => {
  const src = fs.readFileSync(path.resolve(__dirname, "../index.ts"), "utf8").replace(/\/\/.*$/gm, "");
  const start = src.indexOf("const handleButtonPress = (e: Event) => {");
  const body = src.slice(start, src.indexOf("window.addEventListener(\"floatingObject:bodyDragStart\", handleButtonPress)", start));

  it("handleButtonPress hands a pageNavigator press to pressPageNavigatorItem BEFORE the button's part check, and returns", () => {
    expect(start, "handleButtonPress is gone").toBeGreaterThan(0);
    const navigator = body.indexOf("PAGE_NAVIGATOR_CONTROL_TYPE");
    const route = body.indexOf("pressPageNavigatorItem(");
    const buttonCheck = body.indexOf('detail.part !== "button"');
    expect(navigator).toBeGreaterThan(0);
    expect(route).toBeGreaterThan(navigator);
    expect(buttonCheck).toBeGreaterThan(route);
    expect(body.slice(route, buttonCheck)).toMatch(/return;/);
    expect(body.slice(navigator, buttonCheck)).not.toMatch(/button:clicked|runFloatingButtonClick/);
  });
});
