//! FILENAME: app/extensions/Controls/PropertiesPane/__tests__/pageNavigatorButtonsSection.test.tsx
// PURPOSE: The Properties pane's "Buttons" section for a Page Navigator (WP-B,
//          D-NAV S7.5):
//            - one row per page the navigator lists, in tab order -- a page an
//              override hides is still a row (so it can be shown again), a
//              user-hidden page is not unless Show hidden pages is on;
//            - a caption commit writes ONE serialised override naming the page
//              by id AND name; an unchanged commit writes nothing;
//            - unchecking Show writes `hidden: true`; re-checking it removes
//              the override (its only field cleared);
//            - clearing every field removes the entry; a colour is written and
//              cleared; a name-matched override is re-keyed to the page's id;
//            - the item selected on the canvas has its row expanded and
//              scrolled into view;
//            - an over-cap list is refused with the length sentence (a toast)
//              and NOTHING is written.
// CONTEXT: react-dom + act; the page list is a doubled @api/reportPages
//          snapshot and the toast a recorder.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { ReportPage } from "@api/reportPages";

const h = vi.hoisted(() => ({
  snapshot: null as unknown,
  toasts: [] as Array<{ message: string; type?: string }>,
}));

vi.mock("@api/reportPages", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@api/reportPages")>()),
  getReportPagesSnapshot: () => h.snapshot,
  onReportPagesChanged: () => () => {},
}));
vi.mock("@api/notifications", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@api/notifications")>()),
  showToast: (message: string, options?: { type?: string }) => {
    h.toasts.push({ message, type: options?.type });
  },
}));

import {
  MAX_PAGE_NAVIGATOR_OVERRIDES_CHARS,
  parsePageNavigatorOverrides,
  serializePageNavigatorOverrides,
  type PageNavigatorOverride,
} from "@api/buttonControlService";
import { PageNavigatorButtonsSection, applyPageOverrideEdit, swatchValue } from "../PageNavigatorButtonsSection";
import { setSelectedNavigatorItem, resetNavigatorItemSelection } from "../../PageNavigator/navigatorItemSelection";
import type { ControlPropertyValue } from "../../lib/types";

Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

const NAV = "control-1-0-3";

function page(index: number, name: string, extra: Partial<ReportPage> = {}): ReportPage {
  return { sheetId: `id-${index}`, name, index, visibility: "visible", isTooltipPage: false, ...extra };
}

function useCanvases(pages: ReportPage[]): void {
  h.snapshot = {
    pages,
    sheetIdByIndex: new Map(pages.map((p) => [p.index, p.sheetId])),
    activeIndex: 1,
    version: 1,
  };
}

function bag(values: Record<string, string>): Record<string, ControlPropertyValue> {
  return Object.fromEntries(Object.entries(values).map(([k, v]) => [k, { valueType: "static" as const, value: v }]));
}

let host: HTMLDivElement;
let root: Root;
let writes: PageNavigatorOverride[][];

async function render(values: Record<string, string> = {}): Promise<void> {
  await act(async () => {
    root.render(
      <PageNavigatorButtonsSection
        controlId={NAV}
        properties={bag(values)}
        readOnly={false}
        onWrite={async (list) => {
          writes.push(list);
        }}
      />,
    );
  });
}

function el<T extends HTMLElement>(testId: string): T {
  const found = host.querySelector<T>(`[data-testid="${testId}"]`);
  if (!found) throw new Error(`no ${testId}`);
  return found;
}

async function expand(key: string): Promise<void> {
  const row = el<HTMLButtonElement>(`nav-buttons-row-${key}`);
  if (row.getAttribute("aria-expanded") !== "true") {
    await act(async () => {
      row.click();
    });
  }
}

async function typeCaption(key: string, text: string, how: "enter" | "blur" = "enter"): Promise<void> {
  const input = el<HTMLInputElement>(`nav-buttons-caption-${key}`);
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
  await act(async () => {
    setter.call(input, text);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await act(async () => {
    if (how === "enter") input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    else input.dispatchEvent(new FocusEvent("focusout", { bubbles: true }));
  });
}

beforeEach(() => {
  writes = [];
  h.toasts = [];
  resetNavigatorItemSelection();
  useCanvases([page(1, "Overview"), page(2, "Sales"), page(3, "Detail")]);
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  resetNavigatorItemSelection();
});

const rowKeys = () =>
  Array.from(host.querySelectorAll("[data-testid^='nav-buttons-row-']")).map((e) =>
    (e.getAttribute("data-testid") ?? "").replace("nav-buttons-row-", ""),
  );

describe("the rows are the listed pages", () => {
  it("one row per page in tab order, an override-hidden page included", async () => {
    await render({ pageOverrides: serializePageNavigatorOverrides([{ sheetId: "id-2", sheetName: "Sales", hidden: true }]) });
    expect(rowKeys()).toEqual(["id-1", "id-2", "id-3"]);
    expect(el(`nav-buttons-row-id-2`).textContent).toContain("not shown");
  });

  it("a user-hidden page is a row only with Show hidden pages on; a tooltip page only with Show tooltip pages", async () => {
    useCanvases([page(1, "Overview"), page(2, "Secret", { visibility: "hidden" }), page(3, "Tip", { isTooltipPage: true })]);
    await render();
    expect(rowKeys()).toEqual(["id-1"]);
    await render({ showHiddenPages: "true", showTooltipPages: "true" });
    expect(rowKeys()).toEqual(["id-1", "id-2", "id-3"]);
  });

  it("no pages: one sentence, no rows", async () => {
    useCanvases([]);
    await render();
    expect(rowKeys()).toEqual([]);
    expect(el("nav-buttons-empty").textContent).toMatch(/no report pages/);
  });
});

describe("a write is one serialised override list", () => {
  it("a caption commit writes ONE override naming the page by id and name", async () => {
    await render();
    await expand("id-2");
    await typeCaption("id-2", "Revenue");
    expect(writes).toEqual([[{ sheetId: "id-2", sheetName: "Sales", text: "Revenue" }]]);
    expect(serializePageNavigatorOverrides(writes[0])).toBe('[{"sheetId":"id-2","sheetName":"Sales","text":"Revenue"}]');
  });

  it("an unchanged commit (blur without typing) writes nothing", async () => {
    await render({ pageOverrides: serializePageNavigatorOverrides([{ sheetId: "id-2", sheetName: "Sales", text: "Revenue" }]) });
    await expand("id-2");
    await typeCaption("id-2", "Revenue", "blur");
    expect(writes).toEqual([]);
  });

  it("unchecking Show writes hidden:true; re-checking removes the override", async () => {
    await render();
    await expand("id-3");
    const box = el<HTMLInputElement>("nav-buttons-show-id-3");
    expect(box.checked).toBe(true);
    await act(async () => {
      box.click();
    });
    expect(writes).toEqual([[{ sheetId: "id-3", sheetName: "Detail", hidden: true }]]);

    await render({ pageOverrides: serializePageNavigatorOverrides(writes[0]) });
    const again = el<HTMLInputElement>("nav-buttons-show-id-3");
    expect(again.checked).toBe(false);
    await act(async () => {
      again.click();
    });
    expect(writes[1], "a shown page with no other setting keeps no entry").toEqual([]);
  });

  it("BUG-0468: the box shows the click while the write is in flight, and a refused write puts the tick back", async () => {
    let settle: ((ok: boolean) => void) | null = null;
    const pendingWrite = async (list: PageNavigatorOverride[]): Promise<void> => {
      writes.push(list);
      const ok = await new Promise<boolean>((resolve) => {
        settle = resolve;
      });
      if (!ok) throw new Error("refused");
    };
    await act(async () => {
      root.render(
        <PageNavigatorButtonsSection controlId={NAV} properties={bag({})} readOnly={false} onWrite={pendingWrite} />,
      );
    });
    await expand("id-3");
    const box = el<HTMLInputElement>("nav-buttons-show-id-3");
    await act(async () => {
      box.click();
    });
    expect(writes).toEqual([[{ sheetId: "id-3", sheetName: "Detail", hidden: true }]]);
    expect(box.checked, "the stored value has not changed yet, but the box already shows the click").toBe(false);

    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    await act(async () => {
      settle!(false);
    });
    errors.mockRestore();
    expect(box.checked, "the write was refused: the box shows the stored value again").toBe(true);
  });

  it("clearing every field removes the entry; other entries keep their order", async () => {
    const stored: PageNavigatorOverride[] = [
      { sheetId: "id-1", sheetName: "Overview", fill: "#ff0000" },
      { sheetId: "id-2", sheetName: "Sales", text: "Revenue" },
      { sheetId: "id-3", sheetName: "Detail", color: "#00ff00" },
    ];
    await render({ pageOverrides: serializePageNavigatorOverrides(stored) });
    await expand("id-2");
    await typeCaption("id-2", "");
    expect(writes).toEqual([[stored[0], stored[2]]]);
  });

  it("a colour is written, and Clear removes it", async () => {
    await render();
    await expand("id-1");
    const swatch = el<HTMLInputElement>("nav-buttons-fill-id-1");
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
    await act(async () => {
      setter.call(swatch, "#336699");
      swatch.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(writes).toEqual([[{ sheetId: "id-1", sheetName: "Overview", fill: "#336699" }]]);

    await render({ pageOverrides: serializePageNavigatorOverrides(writes[0]) });
    await act(async () => {
      el<HTMLButtonElement>("nav-buttons-fill-id-1-clear").click();
    });
    expect(writes[1]).toEqual([]);
  });

  it("a name-matched override (no live id) is re-keyed to the page's id on its next write", async () => {
    await render({
      pageOverrides: serializePageNavigatorOverrides([{ sheetId: "app-id-9", sheetName: "Sales", text: "Old" }]),
    });
    await expand("id-2");
    await typeCaption("id-2", "New");
    expect(writes).toEqual([[{ sheetId: "id-2", sheetName: "Sales", text: "New" }]]);
  });

  it("an over-cap list is refused with the length sentence and NOTHING is written", async () => {
    // 256 orphan entries with 255-char captions: valid one by one, too long together.
    const caption = "x".repeat(255);
    const stored: PageNavigatorOverride[] = Array.from({ length: 256 }, (_, i) => ({
      sheetId: `gone-${i}`,
      sheetName: `Gone ${i}`,
      text: caption,
    }));
    const value = serializePageNavigatorOverrides(stored);
    expect(parsePageNavigatorOverrides(value)).toHaveLength(256);
    await render({ pageOverrides: value });
    await expand("id-1");
    await typeCaption("id-1", "One more");
    expect(writes, "an over-cap list reached the writer").toEqual([]);
    expect(h.toasts).toHaveLength(1);
    expect(h.toasts[0].type).toBe("error");
    expect(h.toasts[0].message).toContain(`the limit is ${MAX_PAGE_NAVIGATOR_OVERRIDES_CHARS}`);
  });
});

describe("the canvas's selected item", () => {
  it("its row is expanded and scrolled into view; another navigator's selection expands nothing", async () => {
    const scrolled: string[] = [];
    const original = HTMLElement.prototype.scrollIntoView;
    HTMLElement.prototype.scrollIntoView = function (this: HTMLElement) {
      scrolled.push(this.querySelector("[data-testid^='nav-buttons-row-']")?.getAttribute("data-testid") ?? "");
    };
    try {
      await render();
      expect(el("nav-buttons-row-id-2").getAttribute("aria-expanded")).toBe("false");
      await act(async () => {
        setSelectedNavigatorItem({ controlId: "control-9-9-9", itemKey: "id-2" });
      });
      expect(el("nav-buttons-row-id-2").getAttribute("aria-expanded")).toBe("false");
      await act(async () => {
        setSelectedNavigatorItem({ controlId: NAV, itemKey: "id-2" });
      });
      expect(el("nav-buttons-row-id-2").getAttribute("aria-expanded")).toBe("true");
      expect(el("nav-buttons-row-id-1").getAttribute("aria-expanded")).toBe("false");
      expect(scrolled).toEqual(["nav-buttons-row-id-2"]);
    } finally {
      HTMLElement.prototype.scrollIntoView = original;
    }
  });
});

describe("the pure helpers", () => {
  const pages = [page(1, "Overview"), page(2, "Sales")];

  it("applyPageOverrideEdit keeps hidden only when true and drops an empty caption", () => {
    expect(applyPageOverrideEdit([], pages, pages[0], { hidden: false, text: "" })).toEqual([]);
    expect(applyPageOverrideEdit([], pages, pages[0], { hidden: true })).toEqual([
      { sheetId: "id-1", sheetName: "Overview", hidden: true },
    ]);
  });

  it("swatchValue shows #rrggbb for every accepted spelling, else the navigator's colour", () => {
    expect(swatchValue("#abc", "#000000")).toBe("#aabbcc");
    expect(swatchValue("#11223344", "#000000")).toBe("#112233");
    expect(swatchValue(undefined, "#e0e0e0")).toBe("#e0e0e0");
    expect(swatchValue(undefined, "red")).toBe("#000000");
  });
});
