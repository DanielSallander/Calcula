//! FILENAME: app/extensions/BuiltIn/HomeTab/__tests__/font/bordersSplitButton.test.tsx
// PURPOSE: Excel's Borders split button on the Home tab's Font group (CONTRACT
//          3.4): the face that shows -- and re-applies -- the LAST border
//          used; the menu's rows in Excel's order, with their pictures and the
//          separators between Excel's runs; Line Color > (a palette with
//          Automatic) and Line Style > (six radio rows), which set the pen the
//          presets draw with; More Borders... to Format Cells' Border tab; and
//          every refusal reaching the user.
// CONTEXT: Rendered alone (HomeItemProps: item, state, band), in the ribbon
//          band and in the sidebar panel. What each preset WRITES is pinned in
//          borders.test.ts against the pure plan; here the backend doors are
//          doubles and the test watches which preset reaches them.

/* eslint-disable @typescript-eslint/naming-convention --
 * The module double below stands in for RibbonIcon, whose real name is
 * PascalCase. */

import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";

vi.mock("@api", async () => {
  const icons = await import("@api/ribbonIcons");
  return { RibbonIcon: icons.RibbonIcon };
});

const lib = vi.hoisted(() => ({
  applyBorderPreset: vi.fn(),
  applyFormatting: vi.fn(),
  getViewportCells: vi.fn(),
  getStyle: vi.fn(),
  beginUndoTransaction: vi.fn(),
  commitUndoTransaction: vi.fn(),
  cancelUndoTransaction: vi.fn(),
}));
vi.mock("@api/lib", () => lib);

vi.mock("@api/grid", () => ({
  getGridStateSnapshot: () => ({
    selection: { startRow: 1, startCol: 1, endRow: 2, endCol: 2, type: "cells" },
    config: { totalRows: 1048576, totalCols: 16384 },
  }),
}));

const dialogs = vi.hoisted(() => ({ alertAsync: vi.fn(async (..._a: unknown[]) => undefined) }));
vi.mock("@api/dialogs", () => dialogs);

const theme = vi.hoisted(() => ({ getThemeColorPalette: vi.fn() }));
vi.mock("@api/theme", () => theme);

import {
  SurfaceLayoutProvider,
  bandLayout,
  panelLayout,
  CONTROL_HEIGHT_MD,
  ICON_SIZE_SM,
  findHardcodedColours,
  type SurfaceLayout,
} from "@api/layout";
import { RibbonIcon, type RibbonIconKey } from "@api/ribbonIcons";
import { CommandRegistry, CoreCommands } from "@api/commands";
import type { HomeTabItem } from "../../homeTabConfig";
import type { HomeTabState } from "../../components/homeItemProps";
import { BordersSplitButton } from "../../components/font/BordersSplitButton";
import { borderPen, lastBorderPreset } from "../../components/font/borders";

// ============================================================================
// Harness
// ============================================================================

/** The catalog entry CONTRACT section 2 names (home-core adds it to ALL_ITEMS). */
const ITEM: HomeTabItem = {
  id: "borders",
  label: "Borders",
  tooltip: "Borders",
  type: "button",
  category: "Font",
  addedIn: 2,
};

const STATE = {} as unknown as HomeTabState;
const presetCalls: string[] = [];

let container: HTMLDivElement;
let root: Root;

beforeAll(() => {
  vi.spyOn(console, "log").mockImplementation(() => {});
});

beforeEach(() => {
  Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  presetCalls.length = 0;
  lastBorderPreset.reset();
  borderPen.reset();
  dialogs.alertAsync.mockClear();
  theme.getThemeColorPalette.mockReset().mockResolvedValue([]);
  lib.applyBorderPreset.mockReset().mockImplementation(async (...a: unknown[]) => {
    presetCalls.push(`preset:${a[4]}:${a[5]}:${a[6]}:${a[7]}`);
    return { cells: [], styles: [] };
  });
  lib.applyFormatting.mockReset().mockImplementation(async (_r: number[], _c: number[], f: Record<string, unknown>) => {
    presetCalls.push(`sides:${JSON.stringify(f)}`);
    return { cells: [], styles: [] };
  });
  lib.getViewportCells.mockReset().mockResolvedValue([]);
  lib.getStyle.mockReset();
  lib.beginUndoTransaction.mockReset().mockResolvedValue(7);
  lib.commitUndoTransaction.mockReset().mockResolvedValue(undefined);
  lib.cancelUndoTransaction.mockReset().mockResolvedValue(undefined);
});

afterEach(() => {
  act(() => root.unmount());
  vi.useRealTimers();
  vi.restoreAllMocks();
  document.body.innerHTML = "";
});

const SURFACES: Array<[string, () => SurfaceLayout, boolean]> = [
  ["band", () => bandLayout(1200), true],
  ["panel", () => panelLayout(300), false],
];

async function render(surface: [string, () => SurfaceLayout, boolean] = SURFACES[0]): Promise<void> {
  const [, layout, band] = surface;
  await act(async () => {
    root.render(
      <SurfaceLayoutProvider value={layout()}>
        <BordersSplitButton item={ITEM} state={STATE} band={band} />
      </SurfaceLayoutProvider>,
    );
  });
}

function byTestId(id: string): HTMLButtonElement {
  const el = document.querySelector<HTMLButtonElement>(`[data-testid='${id}']`);
  if (!el) throw new Error(`no ${id}`);
  return el;
}

function click(el: Element): void {
  act(() => {
    el.dispatchEvent(new MouseEvent("click", { bubbles: true, detail: 1 }));
  });
}

async function settle(): Promise<void> {
  await act(async () => {
    for (let i = 0; i < 20; i++) await Promise.resolve();
    await new Promise((r) => setTimeout(r, 0));
  });
}

/** The TOP menu's own rows (not a flyout's). */
function topRows(): HTMLButtonElement[] {
  const menu = document.querySelector("[role='menu']");
  if (!menu) return [];
  return Array.from(menu.children).flatMap((el) =>
    el.tagName === "BUTTON" ? [el as HTMLButtonElement] : Array.from(el.querySelectorAll<HTMLButtonElement>(":scope > button")),
  );
}

function rowLabel(row: Element): string | null | undefined {
  return row.querySelector("[data-menu-label]")?.textContent;
}

function iconMarkup(iconKey: RibbonIconKey, size: number): string {
  const host = document.createElement("div");
  const r = createRoot(host);
  act(() => r.render(React.createElement(RibbonIcon[iconKey], { size })));
  const html = host.innerHTML;
  act(() => r.unmount());
  return html;
}

async function openMenu(): Promise<void> {
  await render();
  click(byTestId("fmt-borders-options"));
}

/** Excel's rows, by test id, in order; `|` where Excel draws a separator. */
const LAYOUT = [
  "fmt-borders-bottom",
  "fmt-borders-top",
  "fmt-borders-left",
  "fmt-borders-right",
  "|",
  "fmt-borders-none",
  "fmt-borders-all",
  "fmt-borders-outside",
  "fmt-borders-thickOutside",
  "|",
  "fmt-borders-doubleBottom",
  "fmt-borders-thickBottom",
  "fmt-borders-topBottom",
  "fmt-borders-topThickBottom",
  "fmt-borders-topDoubleBottom",
  "|",
  "fmt-borders-lineColor",
  "fmt-borders-lineStyle",
  "|",
  "fmt-borders-more",
];

const LABELS = [
  "Bottom Border",
  "Top Border",
  "Left Border",
  "Right Border",
  "No Border",
  "All Borders",
  "Outside Borders",
  "Thick Outside Borders",
  "Bottom Double Border",
  "Thick Bottom Border",
  "Top and Bottom Border",
  "Top and Thick Bottom Border",
  "Top and Double Bottom Border",
  "Line Color",
  "Line Style",
  "More Borders...",
];

const ICONS: Array<[string, RibbonIconKey]> = [
  ["fmt-borders-bottom", "BorderBottom"],
  ["fmt-borders-top", "BorderTop"],
  ["fmt-borders-left", "BorderLeft"],
  ["fmt-borders-right", "BorderRight"],
  ["fmt-borders-none", "BorderNone"],
  ["fmt-borders-all", "BorderAll"],
  ["fmt-borders-outside", "BorderOutside"],
  ["fmt-borders-thickOutside", "BorderThickOutside"],
  ["fmt-borders-doubleBottom", "BorderDoubleBottom"],
  ["fmt-borders-thickBottom", "BorderThickBottom"],
  ["fmt-borders-topBottom", "BorderTopBottom"],
  ["fmt-borders-topThickBottom", "BorderTopThickBottom"],
  ["fmt-borders-topDoubleBottom", "BorderTopDoubleBottom"],
  ["fmt-borders-lineColor", "LineColor"],
  ["fmt-borders-more", "BorderAll"],
];

// ============================================================================
// The control
// ============================================================================

describe("the control", () => {
  for (const surface of SURFACES) {
    it(`is Excel's icon split: Bottom Border on its face, a named chevron (${surface[0]})`, async () => {
      await render(surface);
      const main = byTestId("fmt-borders");
      const chevron = byTestId("fmt-borders-options");
      expect(main.getAttribute("aria-label")).toBe("Bottom Border");
      expect(chevron.getAttribute("aria-label")).toBe("Borders options");
      expect(chevron.getAttribute("aria-haspopup")).toBe("menu");
      expect(main.hasAttribute("title")).toBe(false);
      expect(main.hasAttribute("aria-pressed")).toBe(false);
      expect(main.style.height).toBe(`${CONTROL_HEIGHT_MD}px`);
      expect(main.querySelector("svg")!.outerHTML).toBe(iconMarkup("BorderBottom", ICON_SIZE_SM));
    });
  }

  it("paints with tokens only, the open menu included", async () => {
    await openMenu();
    expect(findHardcodedColours(document.body)).toEqual([]);
  });

  it("the face runs Bottom Border by default, without opening the menu", async () => {
    await render();
    click(byTestId("fmt-borders"));
    await settle();
    expect(presetCalls).toEqual([`sides:${JSON.stringify({ borderBottom: { style: "thin", color: "#000000" } })}`]);
    expect(document.querySelector("[role='menu']")).toBeNull();
  });
});

// ============================================================================
// The menu
// ============================================================================

describe("the menu", () => {
  it("is Excel's rows in Excel's order, with Excel's separators, under a Borders heading", async () => {
    await openMenu();
    const menu = document.querySelector("[role='menu']")!;
    expect(menu.getAttribute("aria-label")).toBe("Borders");
    expect(menu.firstElementChild?.textContent).toBe("Borders");
    const seen: string[] = [];
    for (const el of Array.from(menu.querySelectorAll("[role='separator'], [data-testid^='fmt-borders-']"))) {
      if (el.getAttribute("role") === "separator") seen.push("|");
      else if (!el.closest("[role='group']")) seen.push(el.getAttribute("data-testid")!);
    }
    expect(seen).toEqual(LAYOUT);
    expect(topRows().map(rowLabel)).toEqual(LABELS);
  });

  it("each row carries the CONTRACT's picture at the menu's 20px; Line Style reserves the column blank", async () => {
    await openMenu();
    for (const [id, iconKey] of ICONS) {
      // [check column][icon column][label]: the icon column holds the picture.
      expect(byTestId(id).children[1].innerHTML, id).toBe(iconMarkup(iconKey, 20));
    }
    const lineStyle = byTestId("fmt-borders-lineStyle");
    expect(lineStyle.querySelector("svg[data-line-sample]")).toBeNull();
    expect(lineStyle.querySelector("[data-menu-icon-blank]")).not.toBeNull();
  });

  it("Line Color and Line Style are submenus; no row is checked; nothing is disabled", async () => {
    await openMenu();
    expect(byTestId("fmt-borders-lineColor").getAttribute("aria-haspopup")).toBe("dialog");
    expect(byTestId("fmt-borders-lineStyle").getAttribute("aria-haspopup")).toBe("menu");
    for (const row of topRows()) {
      expect(row.hasAttribute("aria-checked")).toBe(false);
      expect(row.disabled).toBe(false);
    }
  });

  const RUNS: Array<[string, string]> = [
    ["fmt-borders-bottom", `sides:${JSON.stringify({ borderBottom: { style: "thin", color: "#000000" } })}`],
    ["fmt-borders-top", `sides:${JSON.stringify({ borderTop: { style: "thin", color: "#000000" } })}`],
    ["fmt-borders-left", `sides:${JSON.stringify({ borderLeft: { style: "thin", color: "#000000" } })}`],
    ["fmt-borders-right", `sides:${JSON.stringify({ borderRight: { style: "thin", color: "#000000" } })}`],
    ["fmt-borders-none", "preset:none:solid:#000000:0"],
    ["fmt-borders-all", "preset:allBorders:solid:#000000:1"],
    ["fmt-borders-outside", "preset:outside:solid:#000000:1"],
    ["fmt-borders-thickOutside", "preset:outside:solid:#000000:2"],
    ["fmt-borders-doubleBottom", `sides:${JSON.stringify({ borderBottom: { style: "double", color: "#000000" } })}`],
    ["fmt-borders-thickBottom", `sides:${JSON.stringify({ borderBottom: { style: "medium", color: "#000000" } })}`],
  ];
  for (const [id, expected] of RUNS) {
    it(`${id} runs its preset, becomes the face, and the face then re-applies it`, async () => {
      await openMenu();
      click(byTestId(id));
      await settle();
      expect(presetCalls[0]).toBe(expected);
      expect(document.querySelector("[role='menu']")).toBeNull();
      const main = byTestId("fmt-borders");
      expect(main.getAttribute("aria-label")).toBe(LABELS[LAYOUT.filter((x) => x !== "|").indexOf(id)]);
      presetCalls.length = 0;
      click(main);
      await settle();
      expect(presetCalls[0]).toBe(expected);
    });
  }

  it("the face shows the last border's picture and name", async () => {
    await openMenu();
    click(byTestId("fmt-borders-thickOutside"));
    await settle();
    const main = byTestId("fmt-borders");
    expect(main.getAttribute("aria-label")).toBe("Thick Outside Borders");
    expect(main.querySelector("svg")!.outerHTML).toBe(iconMarkup("BorderThickOutside", ICON_SIZE_SM));
  });

  it("the remembered face is shared by every copy of the button (band and launcher flyout)", async () => {
    await render();
    const second = document.createElement("div");
    document.body.appendChild(second);
    const root2 = createRoot(second);
    await act(async () => {
      root2.render(
        <SurfaceLayoutProvider value={panelLayout(300)}>
          <BordersSplitButton item={ITEM} state={STATE} band={false} />
        </SurfaceLayoutProvider>,
      );
    });
    click(byTestId("fmt-borders-options"));
    click(byTestId("fmt-borders-all"));
    await settle();
    const faces = Array.from(document.querySelectorAll("[data-testid='fmt-borders']"));
    expect(faces.map((f) => f.getAttribute("aria-label"))).toEqual(["All Borders", "All Borders"]);
    act(() => root2.unmount());
  });

  it("More Borders... opens Format Cells on its Border tab", async () => {
    const execute = vi.spyOn(CommandRegistry, "execute").mockResolvedValue(undefined as never);
    await openMenu();
    click(byTestId("fmt-borders-more"));
    await settle();
    expect(execute).toHaveBeenCalledWith(CoreCommands.FORMAT_CELLS, { tab: "border" });
    expect(presetCalls).toEqual([]);
    // It does not become the face.
    expect(byTestId("fmt-borders").getAttribute("aria-label")).toBe("Bottom Border");
  });
});

// ============================================================================
// Line Style > and Line Color >
// ============================================================================

describe("the pen", () => {
  async function openSub(id: string): Promise<void> {
    await openMenu();
    click(byTestId(id));
    await settle();
  }

  it("Line Style > is six radio rows, Thin checked by default, in Excel's order", async () => {
    await openSub("fmt-borders-lineStyle");
    const ids = ["thin", "dotted", "dashed", "double", "medium", "thick"].map((s) => `fmt-borders-lineStyle-${s}`);
    const rows = ids.map(byTestId);
    expect(rows.map((r) => r.getAttribute("role"))).toEqual(Array(6).fill("menuitemradio"));
    expect(rows.map(rowLabel)).toEqual(["Thin", "Dotted", "Dashed", "Double", "Medium", "Thick"]);
    expect(rows.map((r) => r.getAttribute("aria-checked"))).toEqual(["true", "false", "false", "false", "false", "false"]);
    // Each row shows a sample of its line, in the text colour (never a literal).
    for (const r of rows) expect(r.querySelector("svg[data-line-sample]")).not.toBeNull();
    expect(findHardcodedColours(document.body)).toEqual([]);
  });

  it("choosing a line style closes the menu, applies nothing, and the presets then draw with it", async () => {
    await openSub("fmt-borders-lineStyle");
    click(byTestId("fmt-borders-lineStyle-dashed"));
    await settle();
    expect(document.querySelector("[role='menu']")).toBeNull();
    expect(presetCalls).toEqual([]);
    expect(borderPen.get().style).toBe("dashed");
    click(byTestId("fmt-borders"));
    await settle();
    expect(presetCalls).toEqual([`sides:${JSON.stringify({ borderBottom: { style: "dashed", color: "#000000" } })}`]);
    // Reopened, Dashed is the checked row.
    click(byTestId("fmt-borders-options"));
    click(byTestId("fmt-borders-lineStyle"));
    await settle();
    expect(byTestId("fmt-borders-lineStyle-dashed").getAttribute("aria-checked")).toBe("true");
  });

  it("Line Color > is a palette with Automatic first; a pick sets the colour the presets use", async () => {
    await openSub("fmt-borders-lineColor");
    const palette = byTestId("fmt-borders-lineColor-palette");
    expect(palette.firstElementChild?.getAttribute("data-testid")).toBe("fmt-borders-lineColor-palette-automatic");
    expect(palette.firstElementChild?.textContent).toBe("Automatic");
    // Automatic is the current pen colour.
    expect(byTestId("fmt-borders-lineColor-palette-automatic").getAttribute("aria-pressed")).toBe("true");
    click(palette.querySelector<HTMLButtonElement>("button[aria-label='Red']")!);
    await settle();
    expect(document.querySelector("[role='menu']")).toBeNull();
    expect(presetCalls).toEqual([]);
    expect(borderPen.get().color).toBe("#ff0000");
    click(byTestId("fmt-borders"));
    await settle();
    expect(presetCalls).toEqual([`sides:${JSON.stringify({ borderBottom: { style: "thin", color: "#ff0000" } })}`]);
  });

  it("Automatic puts the pen back to the automatic (black) line", async () => {
    borderPen.set({ color: "#ff0000", style: "thin" });
    await openSub("fmt-borders-lineColor");
    click(byTestId("fmt-borders-lineColor-palette-automatic"));
    await settle();
    expect(borderPen.get().color).toBeNull();
    click(byTestId("fmt-borders"));
    await settle();
    expect(presetCalls[0]).toContain("#000000");
  });

  it("a theme colour is kept as its resolved colour (a border's colour is absolute in the backend)", async () => {
    theme.getThemeColorPalette.mockResolvedValue([
      { slot: "accent1", tint: 0, resolvedColor: "#4472c4", label: "Blue, Accent 1" },
    ]);
    await openSub("fmt-borders-lineColor");
    await settle();
    click(byTestId("fmt-borders-lineColor-palette").querySelector<HTMLButtonElement>("button[aria-label='Blue, Accent 1']")!);
    await settle();
    expect(borderPen.get().color).toBe("#4472c4");
  });
});

// ============================================================================
// Refusals
// ============================================================================

describe("refusals", () => {
  it("a backend refusal from a row reaches the user", async () => {
    lib.applyBorderPreset.mockRejectedValueOnce(new Error("The sheet is protected."));
    await openMenu();
    click(byTestId("fmt-borders-all"));
    await settle();
    expect(dialogs.alertAsync).toHaveBeenCalledWith("The sheet is protected.");
  });

  it("a backend refusal from the face reaches the user", async () => {
    lib.applyFormatting.mockRejectedValueOnce(new Error("Locked."));
    await render();
    click(byTestId("fmt-borders"));
    await settle();
    expect(dialogs.alertAsync).toHaveBeenCalledWith("Locked.");
  });

  it("More Borders... refused reaches the user", async () => {
    vi.spyOn(CommandRegistry, "execute").mockRejectedValue(new Error("Not now."));
    await openMenu();
    click(byTestId("fmt-borders-more"));
    await settle();
    expect(dialogs.alertAsync).toHaveBeenCalledWith("Not now.");
  });
});
