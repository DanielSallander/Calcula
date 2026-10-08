//! FILENAME: app/extensions/CanvasSheet/__tests__/canvasViewSection.test.tsx
// PURPOSE: The Canvas tab's VIEW group, rendered (CONTRACT-CANVAS section 1;
//          Power BI's View > Scale to fit + Page options): a Page View v hero
//          whose three rows (Fit to Page, Fit to Width, Actual Size) are radio
//          rows checked by the zoom the page is shown at; a two-row grid
//          [Gridlines, Snap to Grid / Lock Objects, Grid size]; the Design Mode
//          hero. Every control draws the picture the icon lanes drew for it
//          (no more Resize, Search, chart Gridlines or Pencil).
//
//          On a subscribed canvas the layout toggles are the publisher's, but
//          looking at the page (Page View) and Design Mode are the reader's.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import React from "react";

const h = vi.hoisted(() => ({
  snapshot: { active: null as unknown, activeSubscribed: false, activeIndex: 2, version: 1 },
  patches: [] as unknown[],
  views: [] as string[],
  current: "fitPage" as string | null,
  designMode: false,
  toggled: 0,
}));

vi.mock("../lib/canvasSheetStore", () => ({
  getCanvasSheetSnapshot: () => h.snapshot,
  subscribeCanvasSheets: () => () => {},
}));
vi.mock("../lib/canvasActions", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/canvasActions")>()),
  patchActiveCanvasLayout: async (patch: unknown) => {
    h.patches.push(patch);
    return true;
  },
  fitActiveCanvasToWindow: () => h.views.push("fitPage"),
  fitActiveCanvasToWidth: () => h.views.push("fitWidth"),
  showActiveCanvasAtActualSize: () => h.views.push("actual"),
  currentPageView: () => h.current,
}));
vi.mock("@api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@api")>()),
  getDesignMode: () => h.designMode,
  onDesignModeChange: () => () => {},
  toggleDesignMode: () => {
    h.toggled += 1;
  },
}));

import type { PanelSectionProps } from "@api/uiTypes";
import { defaultCanvasLayout } from "@api/canvasSheet";
import { CanvasViewSection } from "../components/CanvasViewSection";
import { SUBSCRIBED_NOTE } from "../lib/canvasNotes";
import { byTestId, click, drawsIcon, mountHarness, rowLabel, testIdsWithPrefix, type Harness } from "./tabHarness";

const PROPS = { placement: "ribbon" } as unknown as PanelSectionProps;

let hn: Harness;

function setLayout(over: Record<string, unknown> = {}, subscribed = false): void {
  h.snapshot = {
    active: { index: 2, name: "Report", layout: { ...defaultCanvasLayout(), ...over } },
    activeSubscribed: subscribed,
    activeIndex: 2,
    version: h.snapshot.version + 1,
  };
}

beforeEach(() => {
  setLayout();
  h.patches = [];
  h.views = [];
  h.current = "fitPage";
  h.designMode = false;
  h.toggled = 0;
  hn = mountHarness();
});

afterEach(() => hn.unmount());

function render(): void {
  hn.render(<CanvasViewSection {...PROPS} />, "band");
}

describe("Page View v", () => {
  const ROWS: ReadonlyArray<[string, string, Parameters<typeof drawsIcon>[1], string]> = [
    ["canvas-page-view-fitPage", "Fit to Page", "FitToPage", "fitPage"],
    ["canvas-page-view-fitWidth", "Fit to Width", "FitToWidth", "fitWidth"],
    ["canvas-page-view-actual", "Actual Size", "ActualSize", "actual"],
  ];

  it("is a hero with the Fit to Page picture", () => {
    render();
    const hero = byTestId("canvas-page-view", hn.container);
    expect(hero.textContent).toContain("Page View");
    expect(drawsIcon(hero, "FitToPage")).toBe(true);
    expect(hero.getAttribute("aria-haspopup")).toBe("menu");
  });

  it("three radio rows, in Power BI's order, worded and pictured", () => {
    render();
    click(byTestId("canvas-page-view", hn.container));
    const menu = document.querySelector<HTMLElement>('[role="menu"]')!;
    expect(testIdsWithPrefix("canvas-page-view-", menu)).toEqual(ROWS.map(([id]) => id));
    for (const [id, label, icon] of ROWS) {
      const row = byTestId(id, menu);
      expect(row.getAttribute("role")).toBe("menuitemradio");
      expect(rowLabel(row)).toBe(label);
      expect(drawsIcon(row, icon), `${id} draws ${icon}`).toBe(true);
    }
  });

  it.each(ROWS)("%s is checked when the page is shown at that zoom", (id, _l, _i, mode) => {
    h.current = mode;
    render();
    click(byTestId("canvas-page-view", hn.container));
    for (const [other] of ROWS) {
      expect(byTestId(other).getAttribute("aria-checked"), other).toBe(other === id ? "true" : "false");
    }
  });

  it("none is checked at a zoom of the user's own", () => {
    h.current = null;
    render();
    click(byTestId("canvas-page-view", hn.container));
    for (const [id] of ROWS) expect(byTestId(id).getAttribute("aria-checked")).toBe("false");
  });

  it("the check is read when the menu OPENS (a zoom changed since the last render)", () => {
    h.current = "fitPage";
    render();
    h.current = "actual";
    click(byTestId("canvas-page-view", hn.container));
    expect(byTestId("canvas-page-view-actual").getAttribute("aria-checked")).toBe("true");
  });

  it.each(ROWS)("%s runs its view", (id, _l, _i, mode) => {
    render();
    click(byTestId("canvas-page-view", hn.container));
    click(byTestId(id));
    expect(h.views).toEqual([mode]);
  });
});

describe("the page options grid", () => {
  const TOGGLES: ReadonlyArray<[string, string, Parameters<typeof drawsIcon>[1], "showGrid" | "snapToGrid" | "objectsLocked"]> = [
    ["canvas-show-grid", "Gridlines", "ShowGrid", "showGrid"],
    ["canvas-snap-to-grid", "Snap to Grid", "SnapToGrid", "snapToGrid"],
    ["canvas-lock-objects", "Lock Objects", "LockObjects", "objectsLocked"],
  ];

  it("Gridlines, Snap to Grid / Lock Objects, Grid size -- in that order", () => {
    render();
    const ids = [...hn.container.querySelectorAll<HTMLElement>("[data-testid]")]
      .map((e) => e.getAttribute("data-testid"))
      .filter((id) => ["canvas-show-grid", "canvas-snap-to-grid", "canvas-lock-objects", "canvas-grid-size"].includes(id ?? ""));
    expect(ids).toEqual(["canvas-show-grid", "canvas-snap-to-grid", "canvas-lock-objects", "canvas-grid-size"]);
  });

  it.each(TOGGLES)("%s: worded, pictured, pressed by the layout, and it flips the layout", (id, label, icon, field) => {
    setLayout({ showGrid: true, snapToGrid: false, objectsLocked: false });
    render();
    const el = byTestId(id, hn.container);
    expect(el.textContent).toContain(label);
    expect(drawsIcon(el, icon), `${id} draws ${icon}`).toBe(true);
    const on = field === "showGrid";
    expect(el.getAttribute("aria-pressed")).toBe(String(on));
    click(el);
    expect(h.patches).toEqual([{ [field]: !on }]);
  });

  it("Lock Objects reads ON from the layout and turns it off", () => {
    setLayout({ objectsLocked: true });
    render();
    const el = byTestId("canvas-lock-objects", hn.container);
    expect(el.getAttribute("aria-pressed")).toBe("true");
    click(el);
    expect(h.patches).toEqual([{ objectsLocked: false }]);
  });

  it("Grid size commits a whole number of px", () => {
    render();
    const field = byTestId<HTMLInputElement>("canvas-grid-size", hn.container);
    expect(field.value).toBe("16");
  });
});

describe("Design Mode", () => {
  it("a hero with the DesignMode picture that toggles design mode, pressed while on", () => {
    h.designMode = true;
    render();
    const el = byTestId("canvas-design-mode", hn.container);
    expect(el.textContent).toContain("Design Mode");
    expect(drawsIcon(el, "DesignMode")).toBe(true);
    expect(el.getAttribute("aria-pressed")).toBe("true");
    click(el);
    expect(h.toggled).toBe(1);
  });
});

describe("a subscribed canvas", () => {
  it("the layout toggles are disabled; Page View and Design Mode stay the reader's", () => {
    setLayout({}, true);
    render();
    for (const id of ["canvas-show-grid", "canvas-snap-to-grid", "canvas-lock-objects", "canvas-grid-size"]) {
      expect(byTestId<HTMLButtonElement>(id, hn.container).disabled, id).toBe(true);
    }
    expect(byTestId("canvas-page-view", hn.container).disabled).toBe(false);
    expect(byTestId("canvas-design-mode", hn.container).disabled).toBe(false);
    click(byTestId("canvas-lock-objects", hn.container));
    expect(h.patches).toEqual([]);
    expect(SUBSCRIBED_NOTE).toMatch(/publisher/);
  });
});

it("is not shown off a canvas", () => {
  h.snapshot = { active: null, activeSubscribed: false, activeIndex: 0, version: 1 };
  render();
  expect(hn.container.innerHTML).toBe("");
});
