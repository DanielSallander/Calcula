//! FILENAME: app/extensions/ConditionalFormatting/components/__tests__/cfGalleries.test.tsx
// PURPOSE: The three Conditional Formatting galleries paint with @api/layout
//          tokens and read correctly in BOTH of their hosts -- the menu bar's
//          Format > Conditional Formatting flyout and the Home tab's
//          Conditional Formatting hero (RegisteredMenuButton -> MenuSub card).
// CONTEXT: The galleries were drawn for the menu bar only, with its --menu-*
//          variables: --menu-text is #cccccc and --menu-dropdown-bg #252526 in
//          BOTH skins, because the menu bar is dark in the light theme too.
//          Those variables ARE defined inside an @api/layout card popover (the
//          skin writes them on :root), so nothing failed to resolve -- the
//          ribbon's light card simply showed "More Rules..." in light grey on
//          white and the data-bar swatches as dark tiles. The galleries now
//          paint their own LT surface, so they read the same on either host.
//
//          The colour previews are colour DATA (the colours ARE the presets)
//          and sit inside `data-colour-data`; everything else is chrome and may
//          not carry a colour literal.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";

const h = vi.hoisted(() => ({
  addConditionalFormat: vi.fn(),
  showDialog: vi.fn(),
}));

vi.mock("@api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@api")>()),
  showDialog: (...a: unknown[]) => h.showDialog(...a),
  addConditionalFormat: (...a: unknown[]) => h.addConditionalFormat(...a),
}));
vi.mock("../../lib/cfStore", () => ({ invalidateAndRefresh: vi.fn(async () => undefined) }));
// The icon previews draw on a canvas; jsdom has none.
vi.mock("../../rendering/iconShapes", () => ({ drawIcon: vi.fn() }));

import { ColorScaleGallery } from "../ColorScaleGallery";
import { DataBarGallery } from "../DataBarGallery";
import { IconSetGallery } from "../IconSetGallery";
import { PRESET_COLOR_SCALES } from "../../types";
import { registerCFMenuItems, setMenuSelection } from "../../handlers/homeMenuBuilder";
import {
  Button,
  RegisteredMenuButton,
  SurfaceLayoutProvider,
  bandLayout,
  findHardcodedColours,
} from "@api/layout";
import { registerMenu, registerMenuItem, unregisterMenu, unregisterMenuItem } from "@api/ui";

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
  h.addConditionalFormat.mockReset();
  h.addConditionalFormat.mockResolvedValue({ success: true });
  h.showDialog.mockReset();
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  document.body.innerHTML = "";
});

function render(node: React.ReactNode): void {
  act(() => {
    root.render(node);
  });
}

function byTestId(id: string): HTMLElement {
  const el = document.querySelector<HTMLElement>(`[data-testid='${id}']`);
  if (!el) throw new Error(`no element for ${id}`);
  return el;
}

function key(el: Element, k: string): KeyboardEvent {
  const event = new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true });
  act(() => {
    el.dispatchEvent(event);
  });
  return event;
}

/** Every stylesheet rule that matches an element inside `root`. */
function matchedRuleText(root: Element): string {
  const els = [root, ...Array.from(root.querySelectorAll("*"))];
  let out = "";
  for (const style of Array.from(document.querySelectorAll("style"))) {
    const text = style.textContent ?? "";
    const re = /([^{}]+)\{([^{}]*)\}/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) {
      const selector = m[1].trim();
      let hit = false;
      for (const el of els) {
        try {
          if (el.matches(selector)) {
            hit = true;
            break;
          }
        } catch {
          // a selector jsdom cannot parse (a keyframe step): not ours
        }
      }
      if (hit) out += `${selector}{${m[2]}}\n`;
    }
  }
  return out;
}

const GALLERIES: Array<[string, () => React.ReactElement]> = [
  ["cf-gallery-colorScales", () => <ColorScaleGallery onSelect={vi.fn()} onMoreRules={vi.fn()} onClose={vi.fn()} />],
  ["cf-gallery-dataBars", () => <DataBarGallery onSelect={vi.fn()} onMoreRules={vi.fn()} onClose={vi.fn()} />],
  ["cf-gallery-iconSets", () => <IconSetGallery onSelect={vi.fn()} onMoreRules={vi.fn()} onClose={vi.fn()} />],
];

describe("the galleries paint with @api/layout tokens", () => {
  for (const [testId, make] of GALLERIES) {
    it(`${testId}: no --menu-* variable, no chrome colour literal, an LT surface of its own`, () => {
      render(make());
      const gallery = byTestId(testId);
      const rules = matchedRuleText(gallery);
      expect(rules).not.toMatch(/--menu-/);
      expect(findHardcodedColours(gallery)).toEqual([]);
      // Its own surface: the same --bg-surface token the kit's card paints,
      // so it is seamless in the ribbon card and legible on the dark menu bar.
      expect(rules).toMatch(/background[^;]*var\(--bg-surface/);
      expect(rules).toMatch(/color:\s*var\(--text-primary/);
    });
  }

  it("the previews are colour DATA inside data-colour-data", () => {
    render(<ColorScaleGallery onSelect={vi.fn()} onMoreRules={vi.fn()} onClose={vi.fn()} />);
    const option = byTestId("cf-colorScale-0");
    const preview = option.querySelector("[data-colour-data]") as HTMLElement | null;
    expect(preview).not.toBeNull();
    // Green on top: the HIGHEST value is green, as the name says. (jsdom
    // serialises #63BE7B / #FFEB84 / #F8696B as rgb().)
    expect(preview!.getAttribute("style") ?? "").toMatch(
      /linear-gradient\(rgb\(99, 190, 123\).*rgb\(255, 235, 132\).*rgb\(248, 105, 107\)/,
    );
  });
});

describe("Color Scales gallery", () => {
  it("offers all twelve presets by Excel's name, then More Rules...", () => {
    render(<ColorScaleGallery onSelect={vi.fn()} onMoreRules={vi.fn()} onClose={vi.fn()} />);
    const names = Array.from(document.querySelectorAll("[data-cf-option]")).map((el) => el.getAttribute("aria-label"));
    expect(names).toHaveLength(12);
    expect(names[0]).toBe("Green - Yellow - Red Color Scale");
    expect(names[11]).toBe("Yellow - Green Color Scale");
    expect(byTestId("cf-colorScales-moreRules").textContent).toBe("More Rules...");
  });

  it("a pick hands over the preset and then closes", () => {
    const onSelect = vi.fn();
    const onClose = vi.fn();
    render(<ColorScaleGallery onSelect={onSelect} onMoreRules={vi.fn()} onClose={onClose} />);
    act(() => byTestId("cf-colorScale-4").click());
    expect(onSelect).toHaveBeenCalledWith(PRESET_COLOR_SCALES[4]);
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(onSelect.mock.invocationCallOrder[0]).toBeLessThan(onClose.mock.invocationCallOrder[0]);
  });

  it("More Rules... opens New Rule and closes", () => {
    const onMoreRules = vi.fn();
    const onClose = vi.fn();
    render(<ColorScaleGallery onSelect={vi.fn()} onMoreRules={onMoreRules} onClose={onClose} />);
    act(() => byTestId("cf-colorScales-moreRules").click());
    expect(onMoreRules).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("the arrows move through the 4-column grid and down onto More Rules...", () => {
    render(<ColorScaleGallery onSelect={vi.fn()} onMoreRules={vi.fn()} onClose={vi.fn()} />);
    const first = byTestId("cf-colorScale-0");
    act(() => first.focus());
    expect(key(first, "ArrowRight").defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(byTestId("cf-colorScale-1"));
    key(document.activeElement!, "ArrowDown");
    expect(document.activeElement).toBe(byTestId("cf-colorScale-5"));
    key(document.activeElement!, "ArrowDown");
    expect(document.activeElement).toBe(byTestId("cf-colorScale-9"));
    key(document.activeElement!, "ArrowDown");
    expect(document.activeElement).toBe(byTestId("cf-colorScales-moreRules"));
    key(document.activeElement!, "ArrowUp");
    expect(document.activeElement).toBe(byTestId("cf-colorScale-8"));
    key(document.activeElement!, "Home");
    expect(document.activeElement).toBe(byTestId("cf-colorScale-0"));
    // At the first option ArrowLeft is NOT taken: it belongs to the host
    // (a submenu level closes on it).
    expect(key(document.activeElement!, "ArrowLeft").defaultPrevented).toBe(false);
  });
});

describe("Data Bars gallery", () => {
  it("Gradient Fill then Solid Fill, six bars each by Excel's name", () => {
    render(<DataBarGallery onSelect={vi.fn()} onMoreRules={vi.fn()} onClose={vi.fn()} />);
    const groups = Array.from(document.querySelectorAll("[role='group']")).map((g) => [
      g.getAttribute("aria-label"),
      Array.from(g.querySelectorAll("[data-cf-option]")).map((el) => el.getAttribute("aria-label")),
    ]);
    const six = ["Blue Data Bar", "Green Data Bar", "Red Data Bar", "Orange Data Bar", "Light Blue Data Bar", "Purple Data Bar"];
    expect(groups).toEqual([
      ["Gradient Fill", six],
      ["Solid Fill", six],
    ]);
  });

  it("a gradient pick hands over (colour, true); a solid pick (colour, false)", () => {
    const onSelect = vi.fn();
    render(<DataBarGallery onSelect={onSelect} onMoreRules={vi.fn()} onClose={vi.fn()} />);
    act(() => byTestId("cf-dataBar-gradient-1").click());
    act(() => byTestId("cf-dataBar-solid-2").click());
    expect(onSelect.mock.calls).toEqual([
      ["#63C384", true],
      ["#FF555A", false],
    ]);
  });

  it("keeps a tooltip starting 'Gradient' on the gradient bars (the fixall-edit journey clicks one by it)", () => {
    render(<DataBarGallery onSelect={vi.fn()} onMoreRules={vi.fn()} onClose={vi.fn()} />);
    expect(document.querySelectorAll('button[title^="Gradient"]')).toHaveLength(6);
  });
});

describe("Icon Sets gallery", () => {
  it("is grouped as Excel's, and a pick hands over the set and its icon count", () => {
    const onSelect = vi.fn();
    render(<IconSetGallery onSelect={onSelect} onMoreRules={vi.fn()} onClose={vi.fn()} />);
    const groups = Array.from(document.querySelectorAll("[role='group']")).map((g) => g.getAttribute("aria-label"));
    expect(groups).toEqual(["Directional", "Shapes", "Indicators", "Ratings"]);
    act(() => byTestId("cf-iconSet-fiveQuarters").click());
    expect(onSelect).toHaveBeenCalledWith("fiveQuarters", 5);
  });
});

// ============================================================================
// Hosted by the ribbon: the kit's RegisteredMenuButton over the REAL registry
// ============================================================================

describe("the whole tree, hosted by RegisteredMenuButton (the Home tab's door)", () => {
  const MENU = "cf-host-test-format";
  let cleanup: () => void = () => {};

  beforeEach(() => {
    act(() => registerMenu({ id: MENU, label: "Format", order: 1, items: [] }));
    cleanup = registerCFMenuItems({
      ui: {
        menus: {
          registerItem: (_menu: string, item: never) => registerMenuItem(MENU, item),
          unregisterItem: (_menu: string, id: string) => unregisterMenuItem(MENU, id),
        },
      },
    } as never);
    setMenuSelection({ startRow: 0, startCol: 0, endRow: 9, endCol: 0 });
  });

  afterEach(() => {
    act(() => cleanup());
    act(() => unregisterMenu(MENU));
  });

  function renderHero(): void {
    render(
      <SurfaceLayoutProvider value={bandLayout(900)}>
        <RegisteredMenuButton
          menuId={MENU}
          itemId="format:conditionalFormatting"
          trigger={<Button data-testid="fmt-conditionalFormatting">Conditional Formatting</Button>}
        />
      </SurfaceLayoutProvider>,
    );
  }

  function rowIds(menu: Element): string[] {
    return Array.from(menu.querySelectorAll(":scope [role='menuitem'], :scope [role='menuitemcheckbox']"))
      .filter((el) => el.closest("[role='menu']") === menu)
      .map((el) => el.getAttribute("data-testid") ?? "");
  }

  it("opens Excel's top level, in order", () => {
    renderHero();
    act(() => byTestId("fmt-conditionalFormatting").click());
    const menu = document.querySelector("[role='menu']")!;
    expect(rowIds(menu)).toEqual([
      "cf:highlightCells",
      "cf:topBottomRules",
      "cf:dataBars",
      "cf:colorScales",
      "cf:iconSets",
      "cf:newRule",
      "cf:clearRules",
      "cf:manageRules",
    ]);
    expect(menu.querySelectorAll("[role='separator']")).toHaveLength(2);
  });

  it("Color Scales opens the gallery in the card; a pick writes Excel's rule and closes the chain", async () => {
    renderHero();
    act(() => byTestId("fmt-conditionalFormatting").click());
    act(() => byTestId("cf:colorScales").click());
    const gallery = byTestId("cf-gallery-colorScales");
    expect(gallery.querySelectorAll("[data-cf-option]")).toHaveLength(12);
    expect(findHardcodedColours(gallery)).toEqual([]);
    await act(async () => {
      byTestId("cf-colorScale-0").click();
      for (let i = 0; i < 6; i++) await Promise.resolve();
    });
    expect(h.addConditionalFormat).toHaveBeenCalledTimes(1);
    expect(h.addConditionalFormat.mock.calls[0][0].rule.maxPoint.color).toBe("#63BE7B");
    expect(h.addConditionalFormat.mock.calls[0][0].ranges).toEqual([{ startRow: 0, startCol: 0, endRow: 9, endCol: 0 }]);
    expect(document.querySelector("[data-testid='cf-gallery-colorScales']")).toBeNull();
    expect(document.querySelector("[role='menu']")).toBeNull();
  });

  it("Clear Rules shows This Table / This PivotTable disabled, as Excel does outside them", () => {
    renderHero();
    act(() => byTestId("fmt-conditionalFormatting").click());
    act(() => byTestId("cf:clearRules").click());
    expect((byTestId("cf:clearFromTable") as HTMLButtonElement).disabled).toBe(true);
    expect((byTestId("cf:clearFromPivot") as HTMLButtonElement).disabled).toBe(true);
    expect((byTestId("cf:clearFromSelection") as HTMLButtonElement).disabled).toBe(false);
  });
});
