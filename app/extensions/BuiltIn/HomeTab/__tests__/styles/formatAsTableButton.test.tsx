//! FILENAME: app/extensions/BuiltIn/HomeTab/__tests__/styles/formatAsTableButton.test.tsx
// PURPOSE: Home > Format as Table (CONTRACT 3.9): Excel's large two-line hero
//          "Format as / Table v" in the band, a standard 28px control outside
//          it, opening the Tables extension's table-style gallery -- the
//          customContent of Format > Format as Table -- as a card, through the
//          kit's registered-menu seam; greyed with a reason while nothing is
//          registered there.
// CONTEXT: The REAL menu registry, as the extensions reach it. The gallery
//          registered here is a stand-in that does what the real one does on a
//          pick (Table/components/FormatAsTableGallery.tsx: close first, then
//          CommandRegistry.execute(ExtensionCommands.FORMAT_AS_TABLE,
//          { styleId })); the real gallery and the command are pinned by the
//          Tables extension's own formatAsTable.test.tsx. The Home tab may not
//          import that extension, so this file pins the HOSTING: the pick
//          reaches the command with exactly the contract's arguments, once,
//          and the card closes with focus back on the hero.

/* eslint-disable @typescript-eslint/naming-convention --
 * The module double below stands in for RibbonIcon, whose real name is
 * PascalCase. */

import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from "vitest";
import React, { act } from "react";

vi.mock("@api", async () => {
  const icons = await import("@api/ribbonIcons");
  return { RibbonIcon: icons.RibbonIcon };
});

import { RibbonIcon } from "@api";
import {
  bandLayout,
  panelLayout,
  findHardcodedColours,
  useSurfaceLayout,
  HERO_ICON_SIZE,
  ICON_SIZE_SM,
} from "@api/layout";
import { initKeybindings } from "@api/keybindings";
import { CommandRegistry, ExtensionCommands } from "@api/commands";
import { updateMenuItem, type MenuItemDefinition } from "@api/ui";
import type { HomeTabState } from "../../components/homeItemProps";
import {
  FormatAsTableButton,
  FORMAT_AS_TABLE_UNAVAILABLE,
} from "../../components/styles/FormatAsTableButton";
import {
  mount,
  unmount,
  host,
  render,
  click,
  keyboardClick,
  key,
  mouseDown,
  byTestId,
  maybe,
  menus,
  tooltipOf,
  pictureMarkup,
  registerFormatMenu,
  registerItem,
  cleanupRegistry,
  stylesItem,
  FORMAT_MENU_ID,
} from "./stylesHarness";

const STATE = {} as HomeTabState;
const ITEM = stylesItem("formatAsTable");
const TRIGGER = "fmt-formatAsTable";
/** The id the Tables extension registers (Table/handlers/formatAsTable.ts),
 *  as a LITERAL: a hosting component that named the wrong id would otherwise
 *  pass by agreeing with itself (its own constant on both sides of the test). */
const FORMAT_AS_TABLE_MENU_ITEM_ID = "format:formatAsTable";


/** What the Tables extension's gallery does with a pick: close the popover
 *  first, then run Format as Table with the style's id (and catch). */
function StandInGallery({ onClose }: { onClose: () => void }): React.ReactElement {
  const layout = useSurfaceLayout();
  const pick = (styleId: string) => {
    onClose();
    CommandRegistry.execute(ExtensionCommands.FORMAT_AS_TABLE, { styleId }).catch(() => undefined);
  };
  return (
    <div data-testid="format-as-table-gallery" data-container={layout.container} role="listbox" aria-label="Table styles">
      <button type="button" role="option" tabIndex={0} data-testid="format-as-table-table-medium-2" onClick={() => pick("table-medium-2")}>
        Medium 2
      </button>
      <button type="button" role="option" tabIndex={-1} data-testid="format-as-table-table-light-9" onClick={() => pick("table-light-9")}>
        Light 9
      </button>
    </div>
  );
}

function tablesItem(): MenuItemDefinition {
  return {
    id: FORMAT_AS_TABLE_MENU_ITEM_ID,
    label: "Format as Table",
    order: 1,
    customContent: (onClose) => <StandInGallery onClose={onClose} />,
  };
}

async function renderButton(layout = bandLayout(1200), band = true): Promise<void> {
  await render(
    <>
      <FormatAsTableButton item={ITEM} state={STATE} band={band} />
      <input data-testid="elsewhere" />
    </>,
    layout,
  );
}

function trigger(): HTMLButtonElement {
  return byTestId<HTMLButtonElement>(TRIGGER);
}

function card(): HTMLElement | null {
  return maybe("format-as-table-gallery")?.closest<HTMLElement>("[data-section-flyout]") ?? null;
}

beforeAll(() => {
  vi.spyOn(console, "log").mockImplementation(() => {});
  initKeybindings();
});

beforeEach(() => {
  mount();
});

afterEach(() => {
  unmount();
  cleanupRegistry();
  vi.restoreAllMocks();
});

describe("the control", () => {
  it("is the contract's catalog entry: a Styles hero named Format as Table", () => {
    expect(ITEM).toMatchObject({ id: "formatAsTable", label: "Format as Table", hero: true });
    expect(ExtensionCommands.FORMAT_AS_TABLE).toBe("table.formatAsTable");
  });

  it("in the band: Excel's large button 'Format as / Table v' with its picture", async () => {
    registerFormatMenu();
    registerItem(tablesItem());
    await renderButton();
    const button = trigger();
    const lines = Array.from(button.querySelectorAll("[data-hero-line]"));
    expect(lines.map((l) => l.textContent?.trim())).toEqual(["Format as", "Table"]);
    expect(lines[1].querySelector("svg")).not.toBeNull();
    expect(button.textContent).toBe("Format as Table");
    const face = button.querySelector("svg") as SVGElement;
    expect(face.outerHTML).toBe(pictureMarkup(<RibbonIcon.FormatAsTable size={HERO_ICON_SIZE} />));
  });

  it("outside the band: a standard 28px control with the 20px picture", async () => {
    registerFormatMenu();
    registerItem(tablesItem());
    await renderButton(panelLayout(300), false);
    const button = trigger();
    expect(button.querySelector("[data-hero-line]")).toBeNull();
    const face = button.querySelector("svg") as SVGElement;
    expect(face.outerHTML).toBe(pictureMarkup(<RibbonIcon.FormatAsTable size={ICON_SIZE_SM} />));
    expect(button.textContent).toBe("Format as Table");
  });

  it("announces a dialog (a gallery card, not a menu), and its tooltip is the catalog's", async () => {
    registerFormatMenu();
    registerItem(tablesItem());
    await renderButton();
    expect(trigger().getAttribute("aria-haspopup")).toBe("dialog");
    expect(trigger().getAttribute("aria-expanded")).toBe("false");
    expect(tooltipOf(trigger())).toBe("Format as Table");
  });
});

describe("the gallery card", () => {
  for (const [surface, layout, band] of [
    ["band", bandLayout(1200), true],
    ["panel", panelLayout(300), false],
  ] as const) {
    it(`opens as a labelled card laid out as a popover, not as a band strip (${surface})`, async () => {
      registerFormatMenu();
      registerItem(tablesItem());
      await renderButton(layout, band);
      click(trigger());
      expect(trigger().getAttribute("aria-expanded")).toBe("true");
      expect(menus()).toHaveLength(0);
      const box = card();
      expect(box).not.toBeNull();
      expect(box!.getAttribute("role")).toBe("dialog");
      expect(box!.getAttribute("aria-label")).toBe("Format as Table");
      expect(byTestId("format-as-table-gallery").getAttribute("data-container")).toBe("popover");
      expect(findHardcodedColours(host())).toEqual([]);
      expect(findHardcodedColours(box!)).toEqual([]);
    });
  }

  it("a pick runs Format as Table ONCE with exactly { styleId }, closes the card, and focus returns to the hero", async () => {
    const execute = vi.spyOn(CommandRegistry, "execute").mockResolvedValue(true);
    registerFormatMenu();
    registerItem(tablesItem());
    await renderButton();
    click(trigger());
    click(byTestId("format-as-table-table-light-9"));
    expect(execute).toHaveBeenCalledTimes(1);
    expect(execute).toHaveBeenCalledWith(ExtensionCommands.FORMAT_AS_TABLE, { styleId: "table-light-9" });
    expect(card()).toBeNull();
    expect(document.activeElement).toBe(trigger());
    expect(trigger().getAttribute("aria-expanded")).toBe("false");
  });

  it("opened from the keyboard, focus goes into the gallery (Excel moves focus into a drop-down)", async () => {
    registerFormatMenu();
    registerItem(tablesItem());
    await renderButton();
    trigger().focus();
    keyboardClick(trigger());
    expect(document.activeElement).toBe(byTestId("format-as-table-table-medium-2"));
  });

  it("opened with the mouse, focus stays on the hero", async () => {
    registerFormatMenu();
    registerItem(tablesItem());
    await renderButton();
    trigger().focus();
    click(trigger());
    expect(card()).not.toBeNull();
    expect(document.activeElement).toBe(trigger());
  });

  it("a second click, Escape and a press elsewhere each close it without running anything", async () => {
    const execute = vi.spyOn(CommandRegistry, "execute").mockResolvedValue(true);
    registerFormatMenu();
    registerItem(tablesItem());
    await renderButton();
    click(trigger());
    mouseDown(trigger());
    click(trigger());
    expect(card()).toBeNull();
    click(trigger());
    key(byTestId("format-as-table-table-medium-2"), "Escape");
    expect(card()).toBeNull();
    expect(document.activeElement).toBe(trigger());
    click(trigger());
    mouseDown(byTestId("elsewhere"));
    expect(card()).toBeNull();
    expect(execute).not.toHaveBeenCalled();
  });
});

describe("unavailable: greyed, inert, and the tooltip says why", () => {
  it("the Tables extension is not running", async () => {
    registerFormatMenu();
    await renderButton();
    expect(trigger().getAttribute("aria-disabled")).toBe("true");
    expect(trigger().disabled).toBe(false);
    click(trigger());
    expect(card()).toBeNull();
    expect(tooltipOf(trigger())).toBe(FORMAT_AS_TABLE_UNAVAILABLE.noItem);
  });

  it("the Format menu that hosts it is not loaded", async () => {
    await renderButton();
    expect(trigger().getAttribute("aria-disabled")).toBe("true");
    expect(tooltipOf(trigger())).toBe(FORMAT_AS_TABLE_UNAVAILABLE.noMenu);
  });

  it("registered after the ribbon mounted: live from then on", async () => {
    registerFormatMenu();
    await renderButton();
    expect(trigger().getAttribute("aria-disabled")).toBe("true");
    registerItem(tablesItem());
    expect(trigger().hasAttribute("aria-disabled")).toBe(false);
    click(trigger());
    expect(card()).not.toBeNull();
  });

  it("disabled by its owner: 'not available right now'", async () => {
    registerFormatMenu();
    registerItem(tablesItem());
    await renderButton();
    act(() => updateMenuItem(FORMAT_MENU_ID, FORMAT_AS_TABLE_MENU_ITEM_ID, { disabled: true }));
    expect(trigger().getAttribute("aria-disabled")).toBe("true");
    expect(tooltipOf(trigger())).toBe(FORMAT_AS_TABLE_UNAVAILABLE.off);
  });

  it("each reason names the command and the extension or menu it waits for", () => {
    const reasons = Object.values(FORMAT_AS_TABLE_UNAVAILABLE);
    expect(new Set(reasons).size).toBe(reasons.length);
    for (const reason of reasons) expect(reason.startsWith("Format as Table ")).toBe(true);
    expect(FORMAT_AS_TABLE_UNAVAILABLE.noItem).toMatch(/Tables extension/);
    expect(FORMAT_AS_TABLE_UNAVAILABLE.noMenu).toMatch(/Format menu/);
  });
});
