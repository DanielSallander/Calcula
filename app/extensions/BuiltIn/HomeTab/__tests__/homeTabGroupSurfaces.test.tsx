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

// The REAL @api/ui (the Styles heroes host registered menus through the kit's
// RegisteredMenuButton, which reads getMenus / subscribeToMenus from it), with
// only openDialog watched.
const openDialog = vi.fn();
vi.mock("@api/ui", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@api/ui")>()),
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

// The Merge & Center split button reads the selection, the merge state and
// the sheet's protection itself (MergeSplitButton). Nothing merged, nothing
// protected: the button renders at rest.
vi.mock("@api/grid", () => ({
  useGridState: () => ({
    selection: { startRow: 0, startCol: 0, endRow: 0, endCol: 2, type: "cells" },
    editing: null,
  }),
}));
vi.mock("@api/lib", () => ({
  readSelectionMergeState: async () => ({ touchesMerge: false }),
  isSheetProtected: async () => false,
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
const applyFormat = vi.fn(async (..._a: unknown[]) => true);
const handleFontFamilyChange = vi.fn();
const handleFontSizeChange = vi.fn();
/** The active cell's style, as the ribbon last read it. */
const currentStyle = {
  fontFamily: "Calibri",
  fontSize: 11,
  numberFormat: "General",
  textColor: "#c00000",
  backgroundColor: "#ffff00",
  underline: "none",
  textRotation: "none",
  indent: 0,
};
vi.mock("../components/useHomeTabState", () => ({
  useHomeTabState: () => ({
    currentStyle,
    currentCellData: null,
    handleItemClick,
    handleCellStyleApply: vi.fn(),
    handleFontFamilyChange,
    handleFontSizeChange,
    handleNumberFormatChange: vi.fn(),
    handleMergeCommand: vi.fn(),
    // Bold and Center Vertically are lit: the latched-toggle look.
    isActive: (id: string) => id === "bold" || id === "alignMiddle",
    applyFormat,
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
import { CommandRegistry, CoreCommands } from "@api/commands";
import { HomeTabGroupComponent } from "../components/HomeTabGroupComponent";
import { groupPieces } from "../components/groupPieces";
import { CURRENT_CATALOG, DEFAULT_LAYOUT, ITEMS_BY_ID, migrateLayout } from "../homeTabConfig";

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
  applyFormat.mockClear();
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

/** The group row: one child per piece, heroes and grids, in layout order. */
function groupRow(): HTMLElement {
  return container.firstElementChild as HTMLElement;
}

/** Is this group-row child a ControlGrid? In the band a grid is the flex
 *  COLUMN that stacks its rows; no hero control is. */
function isGrid(el: Element): boolean {
  return (el as HTMLElement).style.flexDirection === "column";
}

/** The group row read left to right: a hero as its item id, a grid as
 *  `grid(<ids of its first row> / <ids of its second row>)`. Split chevrons
 *  (`-options`) are left out: they belong to the control before them. */
function pieces(): string[] {
  const own = (el: Element) => {
    // A hero may BE the fmt-* element (a bare CommandButton), which
    // querySelectorAll alone does not return.
    const self = el.getAttribute("data-testid")?.startsWith("fmt-") ? [el.getAttribute("data-testid")!.slice(4)] : [];
    return [...self, ...fmtIds(el)].filter((id) => !id.endsWith("-options"));
  };
  return Array.from(groupRow().children).map((el) =>
    isGrid(el)
      ? `grid(${Array.from(el.children).map((row) => own(row).join(" ")).join(" / ")})`
      : (own(el)[0] ?? "?"),
  );
}

/** The band rows of a group's ONLY ControlGrid; each child is one band row. */
function bandRows(): HTMLElement[] {
  const grids = Array.from(groupRow().children).filter(isGrid);
  expect(grids, "exactly one grid in this group").toHaveLength(1);
  return Array.from(grids[0].children) as HTMLElement[];
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

    // Font Color is a split now: the chevron half opens the palette.
    await click(fmt("textColor-options"));
    const popover = document.querySelector("[data-testid='fmt-textColor-popover']");
    expect(popover, "the font colour popover opened").not.toBeNull();
    expect(findHardcodedColours(popover!.closest("[data-section-flyout]")!)).toEqual([]);
    await click(fmt("textColor-options"));

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
  it("no default group packs more than two band rows in any grid", async () => {
    for (const group of DEFAULT_LAYOUT.groups) {
      await render(group.items, bandLayout(1200));
      const grids = Array.from(groupRow().children).filter(isGrid);
      const heroes = group.items.filter((id) => ITEMS_BY_ID.get(id)?.hero);
      // Styles and Cells are heroes alone: no grid at all.
      if (heroes.length === group.items.length) {
        expect(grids, `${group.label} has no grid`).toHaveLength(0);
        continue;
      }
      expect(grids.length, `${group.label} grids`).toBeGreaterThan(0);
      for (const grid of grids) {
        expect(grid.children.length, `${group.label} band rows`).toBeLessThanOrEqual(2);
        expect(grid.children.length, `${group.label} band rows`).toBeGreaterThan(0);
      }
    }
  });

  it("Clipboard is the Paste hero beside Cut + Copy over Format Painter", async () => {
    const clipboard = DEFAULT_LAYOUT.groups.find((g) => g.id === "clipboard")!;
    await render(clipboard.items, bandLayout(1200));

    // A split's first DOM child is its span.split wrapper, so the hero is the
    // first CHILD that contains the main half.
    expect(groupRow().firstElementChild?.contains(fmt("paste")), "the Paste hero comes first").toBe(true);
    expect(pieces()).toEqual(["paste", "grid(cut copy / formatPainter)"]);
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

  it("Undo is Undo over Redo: two stacked icon buttons, no hero", async () => {
    await render(DEFAULT_LAYOUT.groups.find((g) => g.id === "undo")!.items, bandLayout(1200));
    expect(pieces()).toEqual(["grid(undo / redo)"]);
    expect(fmt("undo").textContent, "icon-only: there is no hero beside it").toBe("");
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
// Layout order: heroes stand where the layout puts them (CONTRACT section 1)
// ============================================================================

describe("items render IN LAYOUT ORDER: a hero is its own control, a run between heroes one grid", () => {
  const group = (id: string) => DEFAULT_LAYOUT.groups.find((g) => g.id === id)!.items;

  it("Editing is [AutoSum Fill / Clear][Sort & Filter][Find & Select] -- Excel's order", async () => {
    await render(group("editing"), bandLayout(1200));
    expect(pieces()).toEqual(["grid(autoSum fill / clear)", "sortFilter", "findSelect"]);
  });

  it("Styles and Cells are three heroes each, in catalog order, and no grid", async () => {
    await render(group("styles"), bandLayout(1200));
    expect(pieces()).toEqual(["conditionalFormatting", "formatAsTable", "cellStyles"]);
    await render(group("cells"), bandLayout(1200));
    expect(pieces()).toEqual(["insertCells", "deleteCells", "formatMenu"]);
  });

  it("a hero in the MIDDLE of a user's group splits it into two grids around it", async () => {
    // Inexpressible before: every hero was drawn first and every other item
    // packed into one grid after them.
    await render(["cut", "paste", "copy", "formatPainter"], bandLayout(1200));
    expect(pieces()).toEqual(["grid(cut)", "paste", "grid(copy / formatPainter)"]);
  });

  it("a run holding only a row break draws no empty grid", async () => {
    await render(["paste", "rowBreak", "sortFilter", "cut"], bandLayout(1200));
    expect(pieces()).toEqual(["paste", "sortFilter", "grid(cut)"]);
  });

  it("the sidebar keeps the same order (heroes as standard controls, grids as wrapping rows)", async () => {
    await render(group("editing"), panelLayout(300));
    const order = fmtIds(groupRow()).filter((id) => !id.endsWith("-options"));
    expect(order).toEqual(["autoSum", "fill", "clear", "sortFilter", "findSelect"]);
  });
});

// ============================================================================
// Which control each version-2 item is
// ============================================================================

describe("each Excel control is dispatched by item id", () => {
  /** id -> the fmt-* ids its control must draw (a split draws `-options`). */
  const CONTROLS: Record<string, string[]> = {
    paste: ["paste", "paste-options"],
    formatPainter: ["formatPainter"],
    underline: ["underline", "underline-options"],
    borders: ["borders", "borders-options"],
    backgroundColor: ["backgroundColor", "backgroundColor-options"],
    textColor: ["textColor", "textColor-options"],
    orientation: ["orientation"],
    mergeCells: ["mergeCells", "mergeCells-options"],
    accountingFormat: ["accountingFormat", "accountingFormat-options"],
    conditionalFormatting: ["conditionalFormatting"],
    formatAsTable: ["formatAsTable"],
    cellStyles: ["cellStyles"],
    insertCells: ["insertCells", "insertCells-options"],
    deleteCells: ["deleteCells", "deleteCells-options"],
    formatMenu: ["formatMenu"],
    autoSum: ["autoSum", "autoSum-options"],
    fill: ["fill"],
    clear: ["clear"],
    sortFilter: ["sortFilter"],
    findSelect: ["findSelect"],
  };

  for (const [surface, layout] of SURFACES) {
    it(`every one renders its own control in the ${surface}`, async () => {
      for (const [id, testIds] of Object.entries(CONTROLS)) {
        await render([id], layout());
        for (const testId of testIds) {
          expect(container.querySelectorAll(`[data-testid="fmt-${testId}"]`).length, `${id}: fmt-${testId}`).toBe(1);
        }
      }
    });
  }

  it("the menu-only controls are menus, not a plain hero command that carries the same id", async () => {
    // A dropped mapping would still draw `fmt-<id>` -- as a full-height
    // command button that opens nothing -- so the id alone proves nothing.
    for (const id of ["orientation", "cellStyles", "formatMenu", "fill", "clear", "sortFilter", "findSelect"]) {
      await render([id], bandLayout(1200));
      expect(fmt(id).hasAttribute("aria-haspopup"), `${id} opens a menu or a gallery`).toBe(true);
    }
  });

  it("the item door still runs a plain command (Cut) and the Paste picture", async () => {
    await render(["paste", "cut"], bandLayout(1200));
    await click(fmt("cut"));
    await click(fmt("paste"));
    expect(handleItemClick.mock.calls.map((c) => (c[0] as { id: string }).id)).toEqual(["cut", "paste"]);
  });

});

describe("groupPieces (the split into heroes and runs)", () => {
  it("keeps row breaks inside their run, drops unknown ids, and never splits a run on one", () => {
    expect(groupPieces(["cut", "retired", "copy", "rowBreak", "formatPainter", "paste"])).toEqual([
      {
        kind: "run",
        entries: [
          { id: "cut", index: 0 },
          { id: "copy", index: 2 },
          { id: "rowBreak", index: 3 },
          { id: "formatPainter", index: 4 },
        ],
      },
      { kind: "hero", id: "paste", index: 5 },
    ]);
  });

  it("gives an empty group nothing to draw", () => {
    expect(groupPieces([])).toEqual([]);
    expect(groupPieces(["rowBreak", "rowBreak"])).toEqual([]);
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
      // Underline's split sits INSIDE the B | I | U pill (its one span.split
      // child is rounded and divided like a button); Borders stands alone.
      expect(fmtIds(pill("Emphasis")!)).toEqual(["bold", "italic", "underline", "underline-options"]);
      expect(pill("Emphasis")!.contains(fmt("borders"))).toBe(false);

      await render(ids("alignment"), layout());
      expect(fmtIds(pill("Vertical alignment")!)).toEqual(["alignTop", "alignMiddle", "alignBottom"]);
      expect(fmtIds(pill("Horizontal alignment")!)).toEqual(["alignLeft", "alignCenter", "alignRight"]);
      expect(fmtIds(pill("Indent")!)).toEqual(["decreaseIndent", "increaseIndent"]);
      // Orientation, Wrap Text and Merge stand alone.
      expect(fmt("orientation").closest("[role='group']")).toBeNull();
      expect(fmt("wrapText").parentElement?.getAttribute("role")).not.toBe("group");
      expect(fmt("mergeCells").parentElement?.getAttribute("role")).not.toBe("group");

      await render(ids("number"), layout());
      expect(fmtIds(pill("Decimals")!)).toEqual(["increaseDecimal", "decreaseDecimal"]);
      expect(fmt("percentFormat").parentElement?.getAttribute("role")).not.toBe("group");
      expect(fmt("accountingFormat").closest("[role='group']")).toBeNull();
    });
  }

  it("a strikethrough the user adds back joins the Emphasis pill", async () => {
    // One curated row, so the four are neighbours in ONE pill.
    await render(["bold", "italic", "underline", "strikethrough", "rowBreak", "cut"], bandLayout(1200));
    expect(fmtIds(pill("Emphasis")!)).toEqual([
      "bold", "italic", "underline", "underline-options", "strikethrough",
    ]);
  });

  it("a pill never pulls a command onto another row: a split run is two pills", async () => {
    await render(["bold", "rowBreak", "italic", "underline"], bandLayout(1200));
    const rows = bandRows();
    expect(rows).toHaveLength(2);
    expect(fmtIds(rows[0])).toEqual(["bold"]);
    expect(fmtIds(rows[1])).toEqual(["italic", "underline", "underline-options"]);
    const pills = container.querySelectorAll("[role='group'][aria-label='Emphasis']");
    expect(pills).toHaveLength(2);
  });
});

// ============================================================================
// DOM hooks, names and tooltips
// ============================================================================

describe("hooks, names and tooltips", () => {
  const items = (id: string) => DEFAULT_LAYOUT.groups.find((g) => g.id === id)!.items;

  it("fmt-* and data-active stay on the pressed button itself", async () => {
    await render(items("font"), bandLayout(1200));
    const bold = fmt("bold");
    expect(bold.tagName).toBe("BUTTON");
    expect(bold.getAttribute("data-active")).toBe("true");
    expect(bold.getAttribute("aria-pressed")).toBe("true");
    expect(fmt("italic").hasAttribute("data-active")).toBe(false);
    expect(fmt("italic").getAttribute("aria-pressed")).toBe("false");

    await render(items("alignment"), bandLayout(1200));
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
    await render(items("alignment"), bandLayout(1200));
    expect(fmt("wrapText").getAttribute("aria-label")).toBe("Wrap Text");
    // Excel's Merge & Center split button: both halves are named.
    expect(fmt("mergeCells").getAttribute("aria-label")).toBe("Merge & Center");
    expect(fmt("mergeCells-options").getAttribute("aria-label")).toBe("Merge options");
    // A command Customize can add back keeps its name.
    await render(["insertRow"], bandLayout(1200));
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

describe("Font colour / Fill colour (Excel's split colour buttons, CONTRACT 3.5)", () => {
  it("are split bar swatches whose bar is the button's LAST colour, not the cell's", async () => {
    // The cell is dark red (currentStyle.textColor); the bar is Excel's
    // default red, because the face APPLIES what its bar shows -- a bar that
    // followed the cell would apply the cell's own colour back to it.
    await render(["textColor", "backgroundColor"], bandLayout(1200));
    const text = fmt("textColor");
    expect(text.tagName).toBe("BUTTON");
    expect(text.getAttribute("aria-label")).toBe("Font Color");
    const bar = text.querySelector("[data-colour-data]") as HTMLElement;
    expect(bar.style.background).toContain("rgb(255, 0, 0)");
    expect(bar.style.background).not.toContain("rgb(192, 0, 0)");
    expect(fmt("backgroundColor").getAttribute("aria-label")).toBe("Fill Color");
    expect(fmt("textColor-options")).not.toBe(fmt("textColor"));
  });

  it("a theme pick goes through the group's door as a theme slot, never flattened to hex", async () => {
    await render(["textColor"], bandLayout(1200));
    await click(fmt("textColor-options"));
    // The theme palette loads asynchronously on open.
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
    const accent = document.querySelector("[aria-label='Blue, Accent 1']");
    expect(accent, "the theme grid is shown").not.toBeNull();
    await click(accent!);
    expect(applyFormat).toHaveBeenCalledTimes(1);
    expect(applyFormat.mock.calls[0][0]).toMatchObject({ textColorTheme: "accent1", textColorTint: 0 });
  });

  it("Fill keeps its 'More Fill Options...' row, which opens Format Cells on Fill", async () => {
    await render(["backgroundColor"], bandLayout(1200));
    await click(fmt("backgroundColor-options"));
    const more = Array.from(document.querySelectorAll("button")).find(
      (b) => b.textContent === "More Fill Options...",
    );
    expect(more).toBeTruthy();
    // Through the FORMAT_CELLS command, the one door to the dialog (it refuses
    // while a selection owner holds the selection -- homeTabFormatCellsDoors).
    const formatCells = vi.fn();
    CommandRegistry.register(CoreCommands.FORMAT_CELLS, formatCells);
    try {
      await click(more!);
    } finally {
      CommandRegistry.unregister(CoreCommands.FORMAT_CELLS);
    }
    expect(formatCells).toHaveBeenCalledWith({ tab: "fill" });
    expect(openDialog, "the row opened the dialog past the command").not.toHaveBeenCalled();
  });
});

// ============================================================================
// A layout saved at version 1, as the upgrade renders it (review findings,
// 2026-10-04): the medium labelled face, and one owner per test id
// ============================================================================

describe("a version-1 layout after the upgrade", () => {
  /** The Cells and Editing groups exactly as version 1 shipped them, migrated. */
  const migrated = () =>
    Object.fromEntries(
      migrateLayout(
        {
          version: 1,
          groups: [
            { id: "cells", label: "Cells", items: ["insertRow", "insertColumn", "rowBreak", "deleteRow", "deleteColumn"] },
            { id: "editing", label: "Editing", items: ["undo", "redo", "find", "rowBreak", "clearFormatting", "clearAll"] },
          ],
        },
        CURRENT_CATALOG,
      ).groups.map((g) => [g.id, g.items]),
    );

  it("labels ONLY the commands Excel draws labelled beside a hero (Cut, Copy, Format Painter)", async () => {
    // 'labelled' used to be group-wide: the new heroes the upgrade brings into
    // Editing and Cells turned every small command there into a wide labelled
    // button, and the two groups ballooned.
    await render(migrated().editing, bandLayout(1200));
    for (const id of ["undo", "redo", "find", "clearFormatting", "clearAll"]) {
      expect(fmt(id).textContent, `${id} stays icon-only`).toBe("");
      expect(fmt(id).getAttribute("aria-label"), id).toBe(ITEMS_BY_ID.get(id)!.label);
    }
    await render(migrated().cells, bandLayout(1200));
    for (const id of ["insertRow", "insertColumn", "deleteRow", "deleteColumn"]) {
      expect(fmt(id).textContent, `${id} stays icon-only`).toBe("");
    }
    // Positive control: the Clipboard stack beside Paste is still labelled.
    await render(["paste", "cut", "copy", "rowBreak", "formatPainter"], bandLayout(1200));
    expect(fmt("cut").textContent).toBe("Cut");
    expect(fmt("formatPainter").textContent).toBe("Format Painter");
  });

  it("the catalog marks exactly Cut, Copy and Format Painter as Excel's medium (labelled) face", () => {
    expect(
      Array.from(ITEMS_BY_ID.values())
        .filter((i) => i.besideHero)
        .map((i) => i.id),
    ).toEqual(["cut", "copy", "formatPainter"]);
  });

  it("keeps the standalone Clear All AND the Clear menu, and the open menu shares no test id with it", async () => {
    const editing = migrated().editing;
    expect(editing).toContain("clearAll");
    expect(editing).toContain("clear");
    await render(editing, bandLayout(1200));
    await click(fmt("clear"));
    const allRow = document.querySelector("[role='menu'] [data-testid='fmt-clear-all']");
    expect(allRow, "the Clear menu's Clear All row").not.toBeNull();
    expect(document.querySelectorAll("[data-testid='fmt-clearAll']"), "one fmt-clearAll: the standalone button").toHaveLength(1);
    expect(fmt("clearAll").closest("[role='menu']"), "fmt-clearAll is not inside the menu").toBeNull();
    // No id at all is owned twice while the menu is open.
    const ids = Array.from(document.querySelectorAll("[data-testid]")).map((el) => el.getAttribute("data-testid"));
    const twice = ids.filter((id, i) => ids.indexOf(id) !== i);
    expect(twice).toEqual([]);
  });
});
