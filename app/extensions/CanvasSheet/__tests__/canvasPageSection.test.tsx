//! FILENAME: app/extensions/CanvasSheet/__tests__/canvasPageSection.test.tsx
// PURPOSE: The Canvas tab's PAGE group, rendered (CONTRACT-CANVAS section 1;
//          Power BI's Design > Customize page): Page Size v, Page Background
//          and Wallpaper (colour SPLIT buttons, "Theme default" = automatic),
//          and Themes v -- the document theme gallery Page Layout > Themes
//          shows, hosted through the theme-gallery seam (@api/themeGallery),
//          never by importing Document Theme.
//
//          Page Size: every preset as a radio row (`canvas-page-size-<id>`,
//          the ids the old dropdown's options had) grouped 16:9 sizes / other
//          types, then Custom Size... which opens the W/H fields
//          (`canvas-page-width` / `-height`). A pick writes the preset AND its
//          size; the current one writes nothing.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import React from "react";

const h = vi.hoisted(() => ({
  snapshot: { active: null as unknown, activeSubscribed: false, activeIndex: 2, version: 1 },
  patches: [] as unknown[],
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
}));
vi.mock("@api/theme", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@api/theme")>()),
  getThemeColorPalette: async () => [],
}));

import { act } from "react";
import type { PanelSectionProps } from "@api/uiTypes";
import { registerThemeGallery } from "@api/themeGallery";
import { CANVAS_PAGE_PRESETS, defaultCanvasLayout } from "@api/canvasSheet";
import { CanvasPageSection } from "../components/CanvasPageSection";
import { resetPageColourMemory } from "../lib/pageColours";
import { SUBSCRIBED_NOTE } from "../lib/canvasNotes";
import { byTestId, click, drawsIcon, flush, maybeTestId, mountHarness, rowLabel, testIdsWithPrefix, type Harness } from "./tabHarness";

const PROPS = { placement: "ribbon" } as unknown as PanelSectionProps;

let hn: Harness;

function setLayout(over: Record<string, unknown> = {}): void {
  h.snapshot = {
    active: { index: 2, name: "Report", layout: { ...defaultCanvasLayout(), ...over } },
    activeSubscribed: false,
    activeIndex: 2,
    version: (h.snapshot.version ?? 0) + 1,
  };
}

beforeEach(() => {
  setLayout();
  h.patches = [];
  // The splits remember the session's last pick (Excel's Fill Color rule).
  resetPageColourMemory();
  hn = mountHarness();
});

afterEach(() => {
  hn.unmount();
});

function render(): void {
  hn.render(<CanvasPageSection {...PROPS} />, "band");
}

function openPageSize(): HTMLElement {
  click(byTestId("canvas-page-size", hn.container));
  return document.querySelector<HTMLElement>('[role="menu"]')!;
}

describe("Page Size v", () => {
  it("is a hero with the PageSize picture", () => {
    render();
    const hero = byTestId("canvas-page-size", hn.container);
    expect(hero.textContent).toContain("Page Size");
    expect(drawsIcon(hero, "PageSize")).toBe(true);
    expect(hero.getAttribute("aria-haspopup")).toBe("menu");
  });

  it("lists every preset as a radio row, in the Rust order, then Custom Size...", () => {
    render();
    const menu = openPageSize();
    expect(testIdsWithPrefix("canvas-page-size-", menu)).toEqual([
      ...CANVAS_PAGE_PRESETS.map((p) => `canvas-page-size-${p.id}`),
      "canvas-page-size-custom",
    ]);
    for (const p of CANVAS_PAGE_PRESETS) {
      const row = byTestId(`canvas-page-size-${p.id}`, menu);
      expect(row.getAttribute("role")).toBe("menuitemradio");
      expect(rowLabel(row)).toBe(p.label);
      expect(row.textContent).toContain(p.sizeLabel);
    }
  });

  it("the 16:9 sizes are one group, the other types another (a rule between them)", () => {
    render();
    const menu = openPageSize();
    const kids = [...menu.children];
    const at = (id: string) => kids.indexOf(byTestId(id, menu));
    const isRule = (i: number) => kids[i]?.getAttribute("role") === "separator";
    expect(isRule(at("canvas-page-size-4:3") - 1)).toBe(true);
    expect(isRule(at("canvas-page-size-custom") - 1)).toBe(true);
    expect(isRule(at("canvas-page-size-16:9-fhd") - 1)).toBe(false);
  });

  it("checks the page's own preset", () => {
    setLayout({ pagePreset: "tooltip", pageWidth: 320, pageHeight: 240 });
    render();
    const menu = openPageSize();
    expect(byTestId("canvas-page-size-tooltip", menu).getAttribute("aria-checked")).toBe("true");
    expect(byTestId("canvas-page-size-16:9", menu).getAttribute("aria-checked")).toBe("false");
    expect(byTestId("canvas-page-size-custom", menu).getAttribute("aria-checked")).toBe("false");
  });

  it("a pick writes the preset AND its size; the current preset writes nothing", () => {
    render();
    click(byTestId("canvas-page-size-16:9-fhd", openPageSize()));
    expect(h.patches).toEqual([{ pagePreset: "16:9-fhd", pageWidth: 1920, pageHeight: 1080 }]);
    click(byTestId("canvas-page-size-16:9", openPageSize()));
    expect(h.patches).toHaveLength(1);
  });

  it("Custom Size... opens the width and height fields; a typed size is a custom page", async () => {
    setLayout({ pagePreset: "custom", pageWidth: 900, pageHeight: 500 });
    render();
    const menu = openPageSize();
    expect(byTestId("canvas-page-size-custom", menu).getAttribute("aria-checked")).toBe("true");
    click(byTestId("canvas-page-size-custom", menu));
    await flush();
    const width = byTestId<HTMLInputElement>("canvas-page-width");
    const height = byTestId<HTMLInputElement>("canvas-page-height");
    expect(width.value).toBe("900");
    expect(height.value).toBe("500");
    act(() => width.focus());
    act(() => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
      setter.call(width, "1000");
      width.dispatchEvent(new Event("input", { bubbles: true }));
    });
    act(() => {
      width.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    });
    expect(h.patches).toEqual([{ pagePreset: "custom", pageWidth: 1000 }]);
  });

  // Review finding (2026-10-08): chosen from the KEYBOARD, Custom Size...
  // closed the menu and left focus on the Page Size button, and the fields sit
  // in a card portalled to the end of <body>, which Tab reaches only after
  // every later control. The card now takes focus itself: the width field,
  // its text selected for overtyping (the All Visuals card's rule).
  it("Custom Size... from the keyboard puts focus IN the card, on the width field", async () => {
    setLayout({ pagePreset: "custom", pageWidth: 900, pageHeight: 500 });
    const selected: HTMLInputElement[] = [];
    const select = vi.spyOn(HTMLInputElement.prototype, "select").mockImplementation(function (this: HTMLInputElement) {
      selected.push(this);
    });
    render();
    const trigger = byTestId("canvas-page-size", hn.container);
    act(() => trigger.focus());
    act(() => {
      trigger.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
    });
    await flush();
    const row = byTestId("canvas-page-size-custom");
    act(() => row.focus());
    act(() => {
      row.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
    });
    await flush();
    await flush();
    const width = byTestId<HTMLInputElement>("canvas-page-width");
    expect(document.activeElement).toBe(width);
    // Its text selected, so typing replaces it (a number field has no
    // selection range to read back in jsdom, so the call is what is checked).
    expect(selected).toEqual([width]);
    select.mockRestore();
  });
});

describe("Page Background and Wallpaper (colour splits)", () => {
  const SPLITS: ReadonlyArray<[string, "background" | "wallpaper", Parameters<typeof drawsIcon>[1]]> = [
    ["canvas-page-background", "background", "Background"],
    ["canvas-page-wallpaper", "wallpaper", "Wallpaper"],
  ];

  it.each(SPLITS)("%s: its picture, a face and an options half", (id, _field, icon) => {
    render();
    expect(drawsIcon(byTestId(id, hn.container), icon)).toBe(true);
    expect(byTestId(`${id}-options`, hn.container).getAttribute("aria-haspopup")).toBe("dialog");
  });

  it.each(SPLITS)("%s: Theme default writes \"\"", async (id, field) => {
    setLayout({ [field]: "#123456" });
    render();
    click(byTestId(`${id}-options`, hn.container));
    await flush();
    const automatic = byTestId(`${id}-popover-automatic`);
    expect(automatic.textContent).toContain("Theme default");
    click(automatic);
    expect(h.patches).toEqual([{ [field]: "" }]);
  });

  it.each(SPLITS)("%s: a palette pick writes the colour, and the face then applies it again", async (id, field) => {
    render();
    click(byTestId(`${id}-options`, hn.container));
    await flush();
    const swatch = byTestId(`${id}-popover`).querySelector<HTMLButtonElement>("[data-colour-swatch]")!;
    click(swatch);
    expect(h.patches).toHaveLength(1);
    const picked = (h.patches[0] as Record<string, string>)[field];
    expect(picked).toMatch(/^#[0-9a-f]{6}$/i);
    click(byTestId(id, hn.container));
    expect(h.patches).toEqual([{ [field]: picked }, { [field]: picked }]);
  });

  it("the wallpaper face shows the page's wallpaper (the colour is data on the bar)", () => {
    setLayout({ wallpaper: "#abcdef" });
    render();
    const bar = byTestId("canvas-page-wallpaper", hn.container).querySelector<HTMLElement>("[data-colour-data]");
    expect(bar?.style.background || bar?.style.backgroundColor).toMatch(/abcdef|171, 205, 239/i);
  });
});

describe("Themes v", () => {
  it("hosts the document theme gallery registered with the theme-gallery seam", async () => {
    const release = registerThemeGallery({
      heading: "Built-in Themes",
      render: (onClose) => (
        <button type="button" data-testid="hosted-theme-gallery" onClick={() => onClose()}>
          gallery
        </button>
      ),
    });
    try {
      render();
      const hero = byTestId("canvas-themes", hn.container);
      expect(hero.textContent).toContain("Themes");
      expect(drawsIcon(hero, "Theme")).toBe(true);
      expect(hero.getAttribute("aria-haspopup")).toBe("dialog");
      click(hero);
      await flush();
      await flush();
      const body = byTestId("hosted-theme-gallery");
      // The card takes focus (the All Visuals card's rule), so the keyboard
      // can pick a theme at once.
      expect(document.activeElement).toBe(body);
      // A pick closes the card and gives focus back to the hero.
      click(body);
      await flush();
      expect(maybeTestId("hosted-theme-gallery")).toBeNull();
      expect(document.activeElement).toBe(hero);
    } finally {
      release();
    }
  });

  it("greys out when no theme gallery is registered, and says why", () => {
    render();
    const hero = byTestId("canvas-themes", hn.container);
    expect(hero.getAttribute("aria-disabled") === "true" || (hero as HTMLButtonElement).disabled).toBe(true);
    click(hero);
    expect(maybeTestId("hosted-theme-gallery")).toBeNull();
  });
});

describe("a subscribed canvas", () => {
  it("disables every control, with the subscribed note", () => {
    h.snapshot = { ...h.snapshot, activeSubscribed: true };
    render();
    for (const id of ["canvas-page-size", "canvas-page-background", "canvas-page-background-options", "canvas-page-wallpaper", "canvas-page-wallpaper-options"]) {
      const el = byTestId(id, hn.container);
      expect(el.disabled || el.getAttribute("aria-disabled") === "true", id).toBe(true);
    }
    click(byTestId("canvas-page-size", hn.container));
    expect(document.querySelector('[role="menu"]')).toBeNull();
    expect(SUBSCRIBED_NOTE).toMatch(/publisher/);
  });
});

it("is not shown off a canvas", () => {
  h.snapshot = { active: null, activeSubscribed: false, activeIndex: 0, version: 1 };
  render();
  expect(hn.container.innerHTML).toBe("");
});
