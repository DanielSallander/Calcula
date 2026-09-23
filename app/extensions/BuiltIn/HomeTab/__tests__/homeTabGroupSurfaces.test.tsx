//! FILENAME: app/extensions/BuiltIn/HomeTab/__tests__/homeTabGroupSurfaces.test.tsx
// PURPOSE: Every Home group, as the Calcula Clusters redesign renders it, in
//          the ribbon band AND the sidebar panel: token-only chrome, the fill
//          rule, the Segmented pills, the value pickers and colour swatches,
//          and the DOM hooks the journeys depend on.
// CONTEXT: The redesign is visual, so the risks are the ones a screenshot
//          cannot name: a colour literal that ignores the skin, a third band
//          row that no longer fits the 61px content box, a pill that pulls a
//          command onto another row, a `fmt-*` testid or `data-active` that
//          moved to a wrapper, a hero icon at the wrong size. Each has a case.

/* eslint-disable @typescript-eslint/naming-convention --
 * The module doubles below stand in for RibbonIcon, DialogExtensions and the
 * CellStylesGallery component, whose real names are PascalCase; a camelCase
 * double would simply not be the export the component imports. */

import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";

// --- Mocks: the real icon set and real @api/layout, a fake document -------

// The icon set is real (it must paint with tokens too); only the @api BARREL,
// which reaches every extension, is kept out of the module graph.
vi.mock("@api", async () => {
  const icons = await import("@api/ribbonIcons");
  return { RibbonIcon: icons.RibbonIcon };
});

const openDialog = vi.fn();
vi.mock("@api/ui", () => ({
  DialogExtensions: { openDialog: (...args: unknown[]) => openDialog(...args) },
}));

vi.mock("@api/undoState", () => ({
  useUndoAvailability: () => ({ canUndo: true, canRedo: false }),
}));

vi.mock("@api/numberFormats", () => ({
  getRibbonNumberFormats: async () => [],
}));

vi.mock("@api/locale", () => ({
  onLocaleChanged: () => () => {},
}));

// The document theme the colour popover shows (ColorPopover reads it through
// src/api/theme.ts, which would otherwise invoke Tauri).
vi.mock("@api/theme", () => ({
  getThemeColorPalette: async () => [
    { slot: "dark1", tint: 0, resolvedColor: "#000000", label: "Black, Text 1" },
    { slot: "accent1", tint: 0, resolvedColor: "#4472c4", label: "Blue, Accent 1" },
  ],
}));

const handleItemClick = vi.fn();
const handleColorSelect = vi.fn();
const handleFontFamilyChange = vi.fn();
const handleFontSizeChange = vi.fn();
/** The active cell's style, as the ribbon last read it. */
const currentStyle = {
  fontFamily: "Calibri",
  fontSize: 11,
  numberFormat: "General",
  textColor: "#c00000",
  backgroundColor: "#ffff00",
};
vi.mock("../components/useHomeTabState", () => ({
  useHomeTabState: () => ({
    currentStyle,
    currentCellData: null,
    handleItemClick,
    handleColorSelect,
    handleCellStyleApply: vi.fn(),
    handleFontFamilyChange,
    handleFontSizeChange,
    handleNumberFormatChange: vi.fn(),
    // Bold and Center Vertically are lit: the latched-toggle look.
    isActive: (id: string) => id === "bold" || id === "alignMiddle",
    getCurrentColor: (id: string) =>
      id === "textColor" ? currentStyle.textColor : currentStyle.backgroundColor,
    applyFormat: vi.fn(),
    getItemById: vi.fn(),
  }),
}));

vi.mock("../../../_shared/components/CellStylesGallery", () => ({
  CellStylesGallery: () => null,
}));

import {
  SurfaceLayoutProvider,
  bandLayout,
  panelLayout,
  findHardcodedColours,
  HERO_ICON_SIZE,
  ICON_SIZE_SM,
  type SurfaceLayout,
} from "@api/layout";
import { initKeybindings } from "@api/keybindings";
import { HomeTabGroupComponent } from "../components/HomeTabGroupComponent";
import { DEFAULT_LAYOUT, ITEMS_BY_ID } from "../homeTabConfig";

// --- Harness ----------------------------------------------------------------

let container: HTMLDivElement;
let root: Root;

beforeAll(() => {
  // The app registers the built-in bindings at startup; the tooltips resolve
  // their shortcut chips from that registry.
  vi.spyOn(console, "log").mockImplementation(() => {});
  initKeybindings();
});

beforeEach(() => {
  Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  handleItemClick.mockClear();
  handleColorSelect.mockClear();
  openDialog.mockClear();
});

afterEach(() => {
  act(() => root.unmount());
  document.body.innerHTML = "";
});

async function render(itemIds: string[], layout: SurfaceLayout): Promise<void> {
  await act(async () => {
    root.render(
      <SurfaceLayoutProvider value={layout}>
        <HomeTabGroupComponent context={{} as never} itemIds={itemIds} />
      </SurfaceLayoutProvider>,
    );
  });
}

function fmt(id: string): HTMLElement {
  const el = container.querySelector<HTMLElement>(`[data-testid="fmt-${id}"]`);
  if (!el) throw new Error(`no fmt-${id}`);
  return el;
}

/** The fmt-* ids inside an element, in DOM order. */
function fmtIds(el: Element): string[] {
  return Array.from(el.querySelectorAll("[data-testid^='fmt-']")).map((n) =>
    (n.getAttribute("data-testid") ?? "").slice(4),
  );
}

/** The band rows of a group: the ControlGrid is the group row's last child,
 *  and each of its children is one band row. */
function bandRows(): HTMLElement[] {
  const groupRow = container.firstElementChild as HTMLElement;
  const grid = groupRow.lastElementChild as HTMLElement;
  return Array.from(grid.children) as HTMLElement[];
}

function pill(label: string): HTMLElement | null {
  return container.querySelector<HTMLElement>(`[role='group'][aria-label='${label}']`);
}

async function hover(el: Element): Promise<void> {
  await act(async () => {
    el.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
    await new Promise((r) => setTimeout(r, 450));
  });
}

async function click(el: Element): Promise<void> {
  await act(async () => {
    el.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await Promise.resolve();
  });
}

const SURFACES: Array<[string, () => SurfaceLayout]> = [
  ["band", () => bandLayout(1200)],
  ["panel", () => panelLayout(300)],
];

// ============================================================================
// Token-only chrome, per group, per surface
// ============================================================================

describe("every Home group paints with tokens only", () => {
  for (const group of DEFAULT_LAYOUT.groups) {
    for (const [surface, layout] of SURFACES) {
      it(`${group.label} in the ${surface}`, async () => {
        await render(group.items, layout());
        expect(container.querySelector("[data-testid^='fmt-']")).not.toBeNull();
        expect(findHardcodedColours(container)).toEqual([]);
      });
    }
  }

  it("the colour popover and the open font list too", async () => {
    const font = DEFAULT_LAYOUT.groups.find((g) => g.id === "font")!;
    await render(font.items, bandLayout(1200));

    await click(fmt("textColor"));
    const popover = document.querySelector("[data-testid='fmt-textColor-popover']");
    expect(popover, "the font colour popover opened").not.toBeNull();
    expect(findHardcodedColours(popover!.closest("[data-section-flyout]")!)).toEqual([]);
    await click(fmt("textColor"));

    await click(fmt("fontName"));
    const list = document.querySelector("[role='listbox']");
    expect(list, "the font list opened").not.toBeNull();
    expect(list!.querySelectorAll("[role='option']").length).toBeGreaterThan(10);
    // Each row previews its font IN that font, and a font can be named after
    // a colour ("Arial Black"). findHardcodedColours skips font / font-family
    // declarations itself, so the open list — card chrome included — is
    // scanned as rendered.
    expect(
      Array.from(list!.querySelectorAll<HTMLElement>("[style]")).some((el) => el.style.fontFamily !== ""),
      "the rows really carry their font",
    ).toBe(true);
    expect(findHardcodedColours(list!.closest("[data-section-flyout]")!)).toEqual([]);
  });
});

// ============================================================================
// The fill rule
// ============================================================================

describe("the fill rule: one tall row, or two 28px rows", () => {
  it("no default group packs more than two band rows", async () => {
    for (const group of DEFAULT_LAYOUT.groups) {
      await render(group.items, bandLayout(1200));
      const heroes = group.items.filter((id) => ITEMS_BY_ID.get(id)?.hero);
      if (heroes.length === group.items.length) continue; // Styles: the hero alone
      expect(bandRows().length, `${group.label} band rows`).toBeLessThanOrEqual(2);
      expect(bandRows().length, `${group.label} band rows`).toBeGreaterThan(0);
    }
  });

  it("Clipboard is the Paste hero beside Cut + Copy over Format Painter", async () => {
    const clipboard = DEFAULT_LAYOUT.groups.find((g) => g.id === "clipboard")!;
    await render(clipboard.items, bandLayout(1200));

    const groupRow = container.firstElementChild as HTMLElement;
    expect(groupRow.firstElementChild?.getAttribute("data-testid")).toBe("fmt-paste");
    const rows = bandRows();
    expect(rows.map(fmtIds)).toEqual([["cut", "copy"], ["formatPainter"]]);
    // Beside a hero there is room for the words (Excel's medium buttons).
    expect(fmt("cut").textContent).toBe("Cut");
    expect(fmt("copy").textContent).toBe("Copy");
    expect(fmt("formatPainter").textContent).toBe("Format Painter");
  });

  it("heroes draw the 30px hero icon in the band and the standard 20px one in a panel", async () => {
    await render(["paste", "cut"], bandLayout(1200));
    expect(fmt("paste").querySelector("svg")?.getAttribute("width")).toBe(String(HERO_ICON_SIZE));
    await render(["paste", "cut"], panelLayout(300));
    expect(fmt("paste").querySelector("svg")?.getAttribute("width")).toBe(String(ICON_SIZE_SM));
    // In a panel the stack is a plain icon row again: no labels.
    expect(fmt("cut").textContent).toBe("");
    expect(fmt("cut").getAttribute("aria-label")).toBe("Cut");
  });

  it("a group WITHOUT a hero still fills two rows rather than one short row", async () => {
    // A user group with no row breaks: it used to stay on one row below five
    // items, which is exactly the short-row-in-a-tall-card the rule forbids.
    await render(["undo", "redo", "find", "clearAll"], bandLayout(1200));
    expect(bandRows().map(fmtIds)).toEqual([["undo", "redo"], ["find", "clearAll"]]);
  });

  it("honours a user's own row breaks exactly (three rows clip; they are the user's)", async () => {
    await render(
      ["insertRow", "insertColumn", "rowBreak", "deleteRow", "rowBreak", "deleteColumn"],
      bandLayout(1200),
    );
    expect(bandRows().map(fmtIds)).toEqual([
      ["insertRow", "insertColumn"],
      ["deleteRow"],
      ["deleteColumn"],
    ]);
  });
});

// ============================================================================
// Segmented pills
// ============================================================================

describe("related commands join into Segmented pills", () => {
  for (const [surface, layout] of SURFACES) {
    it(`Font, Alignment and Number pills in the ${surface}`, async () => {
      const ids = (g: string) => DEFAULT_LAYOUT.groups.find((x) => x.id === g)!.items;

      await render(ids("font"), layout());
      expect(fmtIds(pill("Emphasis")!)).toEqual(["bold", "italic", "underline", "strikethrough"]);

      await render(ids("alignment"), layout());
      expect(fmtIds(pill("Vertical alignment")!)).toEqual(["alignTop", "alignMiddle", "alignBottom"]);
      expect(fmtIds(pill("Horizontal alignment")!)).toEqual(["alignLeft", "alignCenter", "alignRight"]);
      expect(fmtIds(pill("Indent")!)).toEqual(["decreaseIndent", "increaseIndent"]);
      // Wrap Text and Merge stand alone.
      expect(fmt("wrapText").parentElement?.getAttribute("role")).not.toBe("group");
      expect(fmt("mergeCells").parentElement?.getAttribute("role")).not.toBe("group");

      await render(ids("number"), layout());
      expect(fmtIds(pill("Decimals")!)).toEqual(["increaseDecimal", "decreaseDecimal"]);
      expect(fmt("percentFormat").parentElement?.getAttribute("role")).not.toBe("group");
    });
  }

  it("a pill never pulls a command onto another row: a split run is two pills", async () => {
    await render(["bold", "rowBreak", "italic", "underline"], bandLayout(1200));
    const rows = bandRows();
    expect(rows).toHaveLength(2);
    expect(fmtIds(rows[0])).toEqual(["bold"]);
    expect(fmtIds(rows[1])).toEqual(["italic", "underline"]);
    const pills = container.querySelectorAll("[role='group'][aria-label='Emphasis']");
    expect(pills).toHaveLength(2);
  });
});

// ============================================================================
// DOM hooks, names and tooltips
// ============================================================================

describe("hooks, names and tooltips", () => {
  it("fmt-* and data-active stay on the pressed button itself", async () => {
    await render(DEFAULT_LAYOUT.groups[1].items, bandLayout(1200));
    const bold = fmt("bold");
    expect(bold.tagName).toBe("BUTTON");
    expect(bold.getAttribute("data-active")).toBe("true");
    expect(bold.getAttribute("aria-pressed")).toBe("true");
    expect(fmt("italic").hasAttribute("data-active")).toBe(false);
    expect(fmt("italic").getAttribute("aria-pressed")).toBe("false");

    await render(DEFAULT_LAYOUT.groups[2].items, bandLayout(1200));
    expect(fmt("alignMiddle").tagName).toBe("BUTTON");
    expect(fmt("alignMiddle").getAttribute("data-active")).toBe("true");
  });

  it("the typographic glyphs stay letters, named for assistive technology", async () => {
    await render(["bold", "italic", "superscript", "percentFormat", "commaFormat", "increaseDecimal", "decreaseDecimal"], bandLayout(1200));
    expect(fmt("bold").textContent).toBe("B");
    expect(fmt("bold").getAttribute("aria-label")).toBe("Bold");
    expect(fmt("superscript").textContent).toBe("x²");
    expect(fmt("percentFormat").textContent).toBe("%");
    expect(fmt("commaFormat").textContent).toBe(",");
    expect(fmt("increaseDecimal").textContent).toBe(".0");
    expect(fmt("decreaseDecimal").textContent).toBe("0.");
  });

  it("icon commands are named by aria-label and carry no native title", async () => {
    for (const group of DEFAULT_LAYOUT.groups) {
      await render(group.items, bandLayout(1200));
      for (const button of Array.from(container.querySelectorAll("button"))) {
        expect(button.hasAttribute("title"), `${button.getAttribute("data-testid")} has a title`).toBe(false);
      }
    }
    await render(DEFAULT_LAYOUT.groups[2].items, bandLayout(1200));
    expect(fmt("wrapText").getAttribute("aria-label")).toBe("Wrap Text");
    await render(DEFAULT_LAYOUT.groups[5].items, bandLayout(1200));
    expect(fmt("insertRow").getAttribute("aria-label")).toBe("Insert Row");
  });

  it("no native <select> is left in the band; the pickers are comboboxes", async () => {
    const all = DEFAULT_LAYOUT.groups.flatMap((g) => g.items);
    await render(all, bandLayout(1200));
    expect(container.querySelector("select")).toBeNull();
    for (const id of ["fontName", "fontSize", "numberFormat"]) {
      expect(fmt(id).getAttribute("role"), id).toBe("combobox");
    }
    expect(fmt("fontName").textContent).toBe("Calibri");
    expect(fmt("fontSize").textContent).toBe("11");
  });

  for (const [surface, layout] of SURFACES) {
    it(`the value pickers carry their tooltip on the combobox itself, no wrapper (${surface})`, async () => {
      await render(["fontName", "fontSize", "numberFormat"], layout());
      const expected: Record<string, string> = {
        fontName: "Font Name",
        fontSize: "Font Size",
        numberFormat: "Number Format",
      };
      for (const id of Object.keys(expected)) {
        const trigger = fmt(id);
        // Straight inside the grid row: no <span> hover target around it.
        expect(trigger.parentElement?.tagName, id).not.toBe("SPAN");
        await hover(trigger);
        const tip = document.querySelector("[role='tooltip']");
        expect(tip?.textContent, id).toBe(expected[id]);
        // Described on the element a screen reader announces.
        expect(trigger.getAttribute("aria-describedby"), id).toBe(tip!.id);
        await act(async () => {
          trigger.dispatchEvent(new MouseEvent("mouseout", { bubbles: true }));
        });
        expect(document.querySelector("[role='tooltip']"), `${id} closed`).toBeNull();
      }
      // A panel still stretches the pickers across the row.
      if (surface === "panel") expect(fmt("fontName").style.width).toBe("100%");
      else expect(fmt("fontName").style.width).toBe("122px");
    });
  }

  it("the font pickers apply what is chosen", async () => {
    await render(["fontName", "fontSize"], bandLayout(1200));
    await click(fmt("fontName"));
    const georgia = Array.from(document.querySelectorAll("[role='option']")).find((o) =>
      o.textContent?.startsWith("Georgia"),
    );
    await click(georgia!);
    expect(handleFontFamilyChange).toHaveBeenCalledWith("Georgia");

    await click(fmt("fontSize"));
    await click(document.querySelector("[data-testid='fmt-fontSize-option-14']")!);
    expect(handleFontSizeChange).toHaveBeenCalledWith(14);
  });

  it("a hover shows the tooltip with its shortcut chip — live for a command, literal otherwise", async () => {
    await render(["paste", "cut", "copy", "formatPainter"], bandLayout(1200));
    await hover(fmt("cut"));
    const cutTip = document.querySelector("[role='tooltip']");
    expect(cutTip?.textContent).toContain("Cut");
    expect(cutTip?.querySelector("kbd")?.textContent).toBe("Ctrl+X");
    // The shortcut is said ONCE: split off the text, drawn as the chip.
    expect(cutTip?.textContent).not.toContain("(Ctrl+X)");

    await render(["bold"], bandLayout(1200));
    await hover(fmt("bold"));
    const boldTip = document.querySelector("[role='tooltip']");
    expect(boldTip?.querySelector("kbd")?.textContent).toBe("Ctrl+B");
  });

  it("Undo/Redo enablement still binds to the undo store", async () => {
    await render(["undo", "redo"], bandLayout(1200));
    expect((fmt("undo") as HTMLButtonElement).disabled).toBe(false);
    expect((fmt("redo") as HTMLButtonElement).disabled).toBe(true);
  });
});

// ============================================================================
// Colour swatches
// ============================================================================

describe("Font colour / Fill colour", () => {
  it("are bar swatches on the fmt-* trigger, showing the cell's colour as data", async () => {
    await render(["textColor", "backgroundColor"], bandLayout(1200));
    const text = fmt("textColor");
    expect(text.tagName).toBe("BUTTON");
    expect(text.getAttribute("aria-label")).toBe("Font Color");
    const bar = text.querySelector("[data-colour-data]") as HTMLElement;
    expect(bar.style.background).toContain("rgb(192, 0, 0)");
    expect(fmt("backgroundColor").getAttribute("aria-label")).toBe("Fill Color");
  });

  it("a theme pick and a standard pick both go down handleColorSelect", async () => {
    await render(["textColor"], bandLayout(1200));
    await click(fmt("textColor"));
    // The theme palette loads asynchronously on open.
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
    const accent = document.querySelector("[aria-label='Blue, Accent 1']");
    expect(accent, "the theme grid is shown").not.toBeNull();
    await click(accent!);
    expect(handleColorSelect).toHaveBeenCalledWith("textColor", "#4472c4");
  });

  it("Fill keeps its 'More Fill Options...' row, which opens Format Cells on Fill", async () => {
    await render(["backgroundColor"], bandLayout(1200));
    await click(fmt("backgroundColor"));
    const more = Array.from(document.querySelectorAll("button")).find(
      (b) => b.textContent === "More Fill Options...",
    );
    expect(more).toBeTruthy();
    await click(more!);
    expect(openDialog).toHaveBeenCalledWith("format-cells", { tab: "fill" });
  });
});
