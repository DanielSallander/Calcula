//! FILENAME: app/extensions/Controls/PropertiesPane/__tests__/propertiesPaneHeader.test.tsx
// PURPOSE: The Properties pane's HEADER words and a Page Navigator's sections
//          (WP-B, D-NAV S7.4):
//            - the header keeps its own wording for the kinds it always named
//              -- "Button", "Image" (not the generic "Picture"), a shape's
//              catalog name ("Rectangle") -- and says "Page navigator" for a
//              navigator; an unknown kind is Capitalised, an untyped one
//              "Control" (lib/controlKinds.ts);
//            - a navigator shows the Navigator / Button style / Selected page /
//              Pages / Size groups, no Action section, and EXACTLY ONE section
//              titled "Buttons" (the per-page overrides; the style group is
//              "Button style", so the title names one thing);
//            - a navigator container row repaints its paint cache on a write.
// CONTEXT: react-dom + act like heldButtonCodeWiring.test.tsx; the control's
//          metadata and the property door are doubled, the page list is a
//          doubled @api/reportPages snapshot.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";

const h = vi.hoisted(() => ({
  meta: { controlType: "button", properties: {} } as {
    controlType: string;
    properties: Record<string, { valueType: string; value: string }>;
  },
  setProperty: [] as unknown[][],
  snapshot: {
    pages: [
      { sheetId: "id-1", name: "Overview", index: 1, visibility: "visible", isTooltipPage: false },
      { sheetId: "id-2", name: "Sales", index: 2, visibility: "visible", isTooltipPage: false },
    ],
    sheetIdByIndex: new Map([
      [1, "id-1"],
      [2, "id-2"],
    ]),
    activeIndex: 1,
    version: 1,
  },
}));

vi.mock("@api/workbookScripts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@api/workbookScripts")>()),
  listWorkbookScripts: async () => [],
  listWorkbookScriptRecords: async () => [],
}));
vi.mock("@api/reportPages", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@api/reportPages")>()),
  getReportPagesSnapshot: () => h.snapshot,
  onReportPagesChanged: () => () => {},
}));
vi.mock("@api/lib", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getSheets: async () => ({ sheets: [], activeIndex: 0 }),
}));
vi.mock("../../lib/controlApi", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../lib/controlApi")>()),
  getControlMetadata: async () => h.meta,
  setControlProperty: async (...a: unknown[]) => {
    h.setProperty.push(a);
    return h.meta;
  },
}));

import { PropertiesPane } from "../PropertiesPane";

Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
if (!("ResizeObserver" in globalThis)) {
  Reflect.set(
    globalThis,
    "ResizeObserver",
    class {
      observe(): void {}
      unobserve(): void {}
      disconnect(): void {}
    },
  );
}

let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  h.setProperty = [];
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

const s = (value: string) => ({ valueType: "static", value });

async function renderPane(controlType: string, properties: Record<string, { valueType: string; value: string }> = {}): Promise<void> {
  h.meta = { controlType, properties };
  // A FRESH pane per control: the pane re-reads its metadata only when the
  // anchor changes, and every case here uses the same anchor.
  act(() => root.unmount());
  root = createRoot(host);
  await act(async () => {
    root.render(<PropertiesPane data={{ row: 2, col: 1, sheetIndex: 0, controlType }} {...({} as never)} />);
  });
  await act(async () => {
    await new Promise((r) => setTimeout(r, 0));
  });
}

/** The pane's header title. */
function title(): string {
  const all = Array.from(host.querySelectorAll("span")).map((e) => e.textContent ?? "");
  return all.find((t) => t.endsWith(" Properties")) ?? "";
}

/** Every CollapsibleSection title, in order. */
function sectionTitles(): string[] {
  return Array.from(host.querySelectorAll("svg + span")).map((e) => e.textContent ?? "");
}

describe("the Properties pane header", () => {
  it("keeps its own words for button, image and a shape's catalog name", async () => {
    await renderPane("button", { text: s("Go") });
    expect(title()).toBe("Button Properties");
    await renderPane("image");
    expect(title(), "the pane says Image, not the generic Picture").toBe("Image Properties");
    await renderPane("shape", { shapeType: s("rectangle") });
    expect(title()).toBe("Rectangle Properties");
  });

  it("says 'Page navigator' for a navigator", async () => {
    await renderPane("pageNavigator");
    expect(title()).toBe("Page navigator Properties");
  });

  it("an unknown kind is Capitalised; an untyped control is 'Control'", async () => {
    await renderPane("checkbox");
    expect(title()).toBe("Checkbox Properties");
    await renderPane("");
    expect(title()).toBe("Control Properties");
  });
});

describe("a navigator's sections", () => {
  it("Navigator / Button style / Selected page / Pages / Size, then exactly ONE 'Buttons', and no Action", async () => {
    await renderPane("pageNavigator");
    const titles = sectionTitles();
    expect(titles).toEqual(["Navigator", "Button style", "Selected page", "Pages", "Size", "Buttons"]);
    expect(titles.filter((t) => t === "Buttons")).toHaveLength(1);
    expect(titles).not.toContain("Action");
    expect(host.querySelector('[data-testid="nav-buttons-section"]')).not.toBeNull();
    expect(host.querySelector('[data-testid="nav-buttons-row-id-1"]')).not.toBeNull();
    expect(host.querySelector('[data-testid="nav-buttons-row-id-2"]')).not.toBeNull();
  });

  it("a button has no Buttons section", async () => {
    await renderPane("button", { text: s("Go") });
    expect(sectionTitles()).not.toContain("Buttons");
    expect(host.querySelector('[data-testid="nav-buttons-section"]')).toBeNull();
  });

  it("a container row write repaints the navigator (controls:invalidate-cache for its anchor)", async () => {
    await renderPane("pageNavigator");
    const heard: unknown[] = [];
    const on = (e: Event) => heard.push((e as CustomEvent).detail);
    window.addEventListener("controls:invalidate-cache", on);
    try {
      const select = host.querySelector<HTMLSelectElement>('[data-control-prop-select="orientation"]');
      expect(select, "the orientation select row").not.toBeNull();
      const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")!.set!;
      await act(async () => {
        setter.call(select, "vertical");
        select!.dispatchEvent(new Event("change", { bubbles: true }));
      });
      await act(async () => {
        await new Promise((r) => setTimeout(r, 0));
      });
      expect(h.setProperty).toEqual([[0, 2, 1, "pageNavigator", "orientation", "static", "vertical"]]);
      expect(heard).toEqual([{ sheetIndex: 0, row: 2, col: 1 }]);
    } finally {
      window.removeEventListener("controls:invalidate-cache", on);
    }
  });

  it("a per-page caption commit writes ONE serialised pageOverrides value and repaints", async () => {
    await renderPane("pageNavigator");
    const heard: unknown[] = [];
    const on = (e: Event) => heard.push((e as CustomEvent).detail);
    window.addEventListener("controls:invalidate-cache", on);
    try {
      const row = host.querySelector<HTMLButtonElement>('[data-testid="nav-buttons-row-id-2"]')!;
      await act(async () => {
        row.click();
      });
      const input = host.querySelector<HTMLInputElement>('[data-testid="nav-buttons-caption-id-2"]')!;
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
      await act(async () => {
        setter.call(input, "Revenue");
        input.dispatchEvent(new Event("input", { bubbles: true }));
      });
      await act(async () => {
        input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
      });
      await act(async () => {
        await new Promise((r) => setTimeout(r, 0));
      });
      expect(h.setProperty).toEqual([
        [0, 2, 1, "pageNavigator", "pageOverrides", "static", '[{"sheetId":"id-2","sheetName":"Sales","text":"Revenue"}]'],
      ]);
      expect(heard).toEqual([{ sheetIndex: 0, row: 2, col: 1 }]);
    } finally {
      window.removeEventListener("controls:invalidate-cache", on);
    }
  });
});
