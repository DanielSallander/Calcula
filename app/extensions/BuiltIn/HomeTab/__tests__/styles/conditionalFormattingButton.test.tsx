//! FILENAME: app/extensions/BuiltIn/HomeTab/__tests__/styles/conditionalFormattingButton.test.tsx
// PURPOSE: Home > Conditional Formatting (CONTRACT 3.8): Excel's large
//          two-line hero "Conditional / Formatting v" in the band, a standard
//          28px control outside it, hosting the ONE tree the Conditional
//          Formatting extension registers at Format > Conditional Formatting --
//          and, while nothing usable is registered there, a greyed button whose
//          tooltip says WHY.
// CONTEXT: Driven through the REAL menu registry (registerMenu /
//          registerMenuItem / updateMenuItem / unregisterMenuItem from @api/ui),
//          exactly as the extensions reach it in the app, because the failure
//          this control has to be safe against is a ribbon button that shows a
//          tree the owner has since changed or taken back. The registered tree
//          below is Excel's top level as the CF extension registers it
//          (styles-ext report, read from live Excel 16 on 2026-10-04); the real
//          registration is pinned row by row in the CF extension's own
//          cfExcelMenu.test.tsx -- this file pins the HOSTING.

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
  DISABLED_OPACITY,
  HERO_ICON_SIZE,
  ICON_SIZE_SM,
  useMenuClose,
} from "@api/layout";
import { initKeybindings } from "@api/keybindings";
import { CommandRegistry } from "@api/commands";
import { updateMenuItem, notifyMenusChanged, getMenus, type MenuItemDefinition } from "@api/ui";
import type { HomeTabState } from "../../components/homeItemProps";
import {
  ConditionalFormattingButton,
  CONDITIONAL_FORMATTING_UNAVAILABLE,
} from "../../components/styles/ConditionalFormattingButton";
import { registeredHeroUnavailable } from "../../components/styles/RegisteredStylesHero";
import {
  mount,
  unmount,
  host,
  render,
  click,
  key,
  byTestId,
  maybe,
  menus,
  rows,
  shape,
  tooltipOf,
  tooltipChipOf,
  pictureMarkup,
  registerFormatMenu,
  registerItem,
  cleanupRegistry,
  stylesItem,
  FORMAT_MENU_ID,
} from "./stylesHarness";

/** The state the group passes; Conditional Formatting reads none of it. */
const STATE = {} as HomeTabState;
const ITEM = stylesItem("conditionalFormatting");
const TRIGGER = "fmt-conditionalFormatting";
/** The id the CF extension registers (ConditionalFormatting/handlers/homeMenuBuilder.ts),
 *  as a LITERAL: a hosting component that named the wrong id would otherwise
 *  pass by agreeing with itself (its own constant on both sides of the test). */
const CONDITIONAL_FORMATTING_MENU_ITEM_ID = "format:conditionalFormatting";


/** A 16-unit menu-bar glyph with no size of its own, like menuIcons.tsx's. */
function glyph(name: string): React.ReactElement {
  return (
    <svg viewBox="0 0 16 16" data-glyph={name}>
      <rect x="1" y="1" width="14" height="14" />
    </svg>
  );
}

/** A gallery the way CF's draw: no chrome of its own, closes the chain on a pick. */
function FakeGallery({ onPick, onClose }: { onPick: (v: string) => void; onClose: () => void }): React.ReactElement {
  return (
    <div data-testid="fake-data-bars">
      <button type="button" data-testid="fake-data-bar-blue" onClick={() => { onPick("blue"); onClose(); }}>
        Blue Data Bar
      </button>
    </div>
  );
}

/** A flyout content that closes the chain through the kit's hook instead. */
function HookGallery({ onPick }: { onPick: (v: string) => void }): React.ReactElement {
  const close = useMenuClose();
  return (
    <button type="button" data-testid="fake-icon-set" onClick={() => { onPick("arrows"); close(); }}>
      3 Arrows
    </button>
  );
}

const actions = {
  greaterThan: vi.fn(),
  newRule: vi.fn(),
  clearSheet: vi.fn(),
  manage: vi.fn(),
  dataBar: vi.fn(),
  iconSet: vi.fn(),
};

/** Excel's Conditional Formatting top level, as the CF extension registers it. */
function cfTree(): MenuItemDefinition {
  return {
    id: CONDITIONAL_FORMATTING_MENU_ITEM_ID,
    label: "Conditional Formatting",
    icon: glyph("cf"),
    children: [
      {
        id: "cf:highlightCells",
        label: "Highlight Cells Rules",
        icon: glyph("highlight"),
        children: [
          { id: "cf:greaterThan", label: "Greater Than...", icon: glyph("gt"), action: actions.greaterThan },
          { id: "cf:lessThan", label: "Less Than...", icon: glyph("lt"), action: () => undefined },
        ],
      },
      {
        id: "cf:topBottomRules",
        label: "Top/Bottom Rules",
        icon: glyph("topBottom"),
        children: [{ id: "cf:top10Items", label: "Top 10 Items...", icon: glyph("top"), action: () => undefined }],
      },
      { id: "cf:sep-rules", label: "", separator: true },
      {
        id: "cf:dataBars",
        label: "Data Bars",
        icon: glyph("bars"),
        customContent: (onClose) => <FakeGallery onPick={actions.dataBar} onClose={onClose} />,
      },
      {
        id: "cf:colorScales",
        label: "Color Scales",
        icon: glyph("scales"),
        customContent: () => <div data-testid="fake-color-scales" />,
      },
      {
        id: "cf:iconSets",
        label: "Icon Sets",
        icon: glyph("icons"),
        customContent: () => <HookGallery onPick={actions.iconSet} />,
      },
      { id: "cf:sep-galleries", label: "", separator: true },
      { id: "cf:newRule", label: "New Rule...", icon: glyph("new"), commandId: "cf.test.newRule" },
      {
        id: "cf:clearRules",
        label: "Clear Rules",
        icon: glyph("clear"),
        children: [
          { id: "cf:clearFromSheet", label: "Clear Rules from Entire Sheet", icon: glyph("sheet"), action: actions.clearSheet },
          { id: "cf:clearFromTable", label: "Clear Rules from This Table", icon: glyph("table"), disabled: true, action: () => undefined },
        ],
      },
      { id: "cf:manageRules", label: "Manage Rules...", icon: glyph("manage"), action: actions.manage },
    ],
  };
}

async function renderButton(layout = bandLayout(1200), band = true): Promise<void> {
  await render(<ConditionalFormattingButton item={ITEM} state={STATE} band={band} />, layout);
}

function trigger(): HTMLButtonElement {
  return byTestId<HTMLButtonElement>(TRIGGER);
}

beforeAll(() => {
  vi.spyOn(console, "log").mockImplementation(() => {});
  initKeybindings();
});

beforeEach(() => {
  mount();
  for (const fn of Object.values(actions)) fn.mockReset();
});

afterEach(() => {
  unmount();
  cleanupRegistry();
  vi.restoreAllMocks();
});

// ============================================================================
// The control, per surface
// ============================================================================

describe("the control", () => {
  it("is the contract's catalog entry: a Styles hero named Conditional Formatting", () => {
    expect(ITEM).toMatchObject({ id: "conditionalFormatting", label: "Conditional Formatting", hero: true });
  });

  it("in the band: Excel's large button 'Conditional / Formatting v' with the hero picture", async () => {
    registerFormatMenu();
    registerItem(cfTree());
    await renderButton();
    const button = trigger();
    expect(button.tagName).toBe("BUTTON");
    const lines = Array.from(button.querySelectorAll("[data-hero-line]"));
    expect(lines.map((l) => l.textContent?.trim())).toEqual(["Conditional", "Formatting"]);
    // The chevron follows the LAST word (Excel's "Formatting v").
    expect(lines[1].querySelector("svg")).not.toBeNull();
    // The accessible name and an E2E text match read the whole label.
    expect(button.textContent).toBe("Conditional Formatting");
    const face = button.querySelector("svg") as SVGElement;
    expect(face.getAttribute("width")).toBe(String(HERO_ICON_SIZE));
    expect(face.outerHTML).toBe(pictureMarkup(<RibbonIcon.ConditionalFormatting size={HERO_ICON_SIZE} />));
    expect(button.hasAttribute("title")).toBe(false);
  });

  it("outside the band: a standard 28px control -- the 20px picture, one-line label, chevron", async () => {
    registerFormatMenu();
    registerItem(cfTree());
    await renderButton(panelLayout(300), false);
    const button = trigger();
    expect(button.querySelector("[data-hero-line]")).toBeNull();
    const face = button.querySelector("svg") as SVGElement;
    expect(face.getAttribute("width")).toBe(String(ICON_SIZE_SM));
    expect(face.outerHTML).toBe(pictureMarkup(<RibbonIcon.ConditionalFormatting size={ICON_SIZE_SM} />));
    expect(button.textContent).toBe("Conditional Formatting");
    // Icon, label, chevron: two drawings, the chevron after the label.
    const drawings = button.querySelectorAll("svg");
    expect(drawings).toHaveLength(2);
    const label = Array.from(button.querySelectorAll("span")).find((s) => s.textContent === "Conditional Formatting");
    expect(label).toBeTruthy();
    expect(label!.compareDocumentPosition(drawings[1]) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("is a menu button over the registered tree, and its tooltip is the catalog's", async () => {
    registerFormatMenu();
    registerItem(cfTree());
    await renderButton();
    expect(trigger().getAttribute("aria-haspopup")).toBe("menu");
    expect(trigger().hasAttribute("aria-disabled")).toBe(false);
    expect(tooltipOf(trigger())).toBe("Conditional Formatting");
  });

  for (const [surface, layout, band] of [
    ["band", bandLayout(1200), true],
    ["panel", panelLayout(300), false],
  ] as const) {
    it(`paints with tokens only in the ${surface}, closed and open two levels deep`, async () => {
      registerFormatMenu();
      registerItem(cfTree());
      await renderButton(layout, band);
      expect(findHardcodedColours(host())).toEqual([]);
      click(trigger());
      key(byTestId("cf:highlightCells"), "ArrowRight");
      expect(menus()).toHaveLength(2);
      expect(findHardcodedColours(document.body)).toEqual([]);
    });
  }
});

// ============================================================================
// The hosted tree
// ============================================================================

describe("the menu is the tree the CF extension registered", () => {
  for (const [surface, layout, band] of [
    ["band", bandLayout(1200), true],
    ["panel", panelLayout(300), false],
  ] as const) {
    it(`Excel's top level in its order, with its separators and pictures (${surface})`, async () => {
      registerFormatMenu();
      registerItem(cfTree());
      await renderButton(layout, band);
      click(trigger());
      const [top] = menus();
      expect(top.getAttribute("aria-labelledby")).toBe(trigger().id);
      expect(shape(top)).toEqual([
        "Highlight Cells Rules",
        "Top/Bottom Rules",
        "---",
        "Data Bars",
        "Color Scales",
        "Icon Sets",
        "---",
        "New Rule...",
        "Clear Rules",
        "Manage Rules...",
      ]);
      // A hosted row's test id is its registered id: one identity for both doors.
      expect(rows(top).map((r) => r.getAttribute("data-testid"))).toEqual([
        "cf:highlightCells",
        "cf:topBottomRules",
        "cf:dataBars",
        "cf:colorScales",
        "cf:iconSets",
        "cf:newRule",
        "cf:clearRules",
        "cf:manageRules",
      ]);
      for (const row of rows(top)) {
        expect(row.querySelector("svg[data-glyph]"), row.getAttribute("data-testid") ?? "").not.toBeNull();
      }
      // The rule submenus and the galleries are flyouts; the rest run.
      for (const id of ["cf:highlightCells", "cf:topBottomRules", "cf:clearRules", "cf:dataBars", "cf:colorScales", "cf:iconSets"]) {
        expect(byTestId(id).getAttribute("aria-haspopup"), id).not.toBeNull();
      }
      for (const id of ["cf:newRule", "cf:manageRules"]) {
        expect(byTestId(id).hasAttribute("aria-haspopup"), id).toBe(false);
      }
    });
  }

  it("a rule row runs the owner's action once, after the whole chain closed, with focus back on the hero", async () => {
    let focusedAtRun: Element | null = null;
    actions.greaterThan.mockImplementation(() => {
      focusedAtRun = document.activeElement;
    });
    registerFormatMenu();
    registerItem(cfTree());
    await renderButton();
    click(trigger());
    key(byTestId("cf:highlightCells"), "ArrowRight");
    expect(rows(menus()[1]).map((r) => r.getAttribute("data-testid"))).toEqual(["cf:greaterThan", "cf:lessThan"]);
    key(byTestId("cf:greaterThan"), "Enter");
    expect(actions.greaterThan).toHaveBeenCalledTimes(1);
    expect(menus()).toHaveLength(0);
    expect(focusedAtRun).toBe(trigger());
    expect(actions.newRule).not.toHaveBeenCalled();
  });

  it("a row registered with a commandId runs exactly that command, with no arguments", async () => {
    const execute = vi.spyOn(CommandRegistry, "execute").mockResolvedValue(undefined);
    registerFormatMenu();
    registerItem(cfTree());
    await renderButton();
    click(trigger());
    click(byTestId("cf:newRule"));
    expect(execute).toHaveBeenCalledTimes(1);
    expect(execute).toHaveBeenCalledWith("cf.test.newRule");
    expect(menus()).toHaveLength(0);
  });

  it("Manage Rules... runs its action; nothing else runs", async () => {
    registerFormatMenu();
    registerItem(cfTree());
    await renderButton();
    click(trigger());
    click(byTestId("cf:manageRules"));
    expect(actions.manage).toHaveBeenCalledTimes(1);
    expect(actions.clearSheet).not.toHaveBeenCalled();
    expect(actions.greaterThan).not.toHaveBeenCalled();
  });

  it("a gallery opens in a flyout; its pick closes the WHOLE chain and focus returns to the hero", async () => {
    registerFormatMenu();
    registerItem(cfTree());
    await renderButton();
    click(trigger());
    key(byTestId("cf:dataBars"), "ArrowRight");
    const gallery = byTestId("fake-data-bars");
    // A gallery draws no chrome of its own: the flyout card does.
    expect(gallery.closest("[data-section-flyout]")).not.toBeNull();
    click(byTestId("fake-data-bar-blue"));
    expect(actions.dataBar).toHaveBeenCalledWith("blue");
    expect(maybe("fake-data-bars")).toBeNull();
    expect(menus()).toHaveLength(0);
    expect(document.activeElement).toBe(trigger());
  });

  it("a gallery that closes through useMenuClose closes the chain too", async () => {
    registerFormatMenu();
    registerItem(cfTree());
    await renderButton();
    click(trigger());
    key(byTestId("cf:iconSets"), "ArrowRight");
    click(byTestId("fake-icon-set"));
    expect(actions.iconSet).toHaveBeenCalledWith("arrows");
    expect(menus()).toHaveLength(0);
  });

  it("a row the owner registered DISABLED stays disabled (Clear Rules from This Table outside a table)", async () => {
    registerFormatMenu();
    registerItem(cfTree());
    await renderButton();
    click(trigger());
    key(byTestId("cf:clearRules"), "ArrowRight");
    const table = byTestId<HTMLButtonElement>("cf:clearFromTable");
    expect(table.disabled || table.getAttribute("aria-disabled") === "true").toBe(true);
    const sheet = byTestId<HTMLButtonElement>("cf:clearFromSheet");
    expect(sheet.disabled).toBe(false);
    click(sheet);
    expect(actions.clearSheet).toHaveBeenCalledTimes(1);
  });

  it("follows the owner's live change, even while the menu is open (the active cell moved into a table)", async () => {
    registerFormatMenu();
    registerItem(cfTree());
    await renderButton();
    click(trigger());
    key(byTestId("cf:clearRules"), "ArrowRight");
    expect(byTestId<HTMLButtonElement>("cf:clearFromTable").disabled).toBe(true);
    // The CF extension patches the nested child IN PLACE and announces it
    // (refreshClearScopes): the object is the same before and after.
    act(() => {
      const top = getMenus()
        .find((m) => m.id === FORMAT_MENU_ID)
        ?.items.find((i) => i.id === CONDITIONAL_FORMATTING_MENU_ITEM_ID);
      const clear = top?.children?.find((c) => c.id === "cf:clearRules");
      const table = clear?.children?.find((c) => c.id === "cf:clearFromTable");
      if (table) table.disabled = false;
      notifyMenusChanged();
    });
    expect(byTestId<HTMLButtonElement>("cf:clearFromTable").disabled).toBe(false);
  });

  it("Escape closes one level, then the menu, and focus ends on the hero", async () => {
    registerFormatMenu();
    registerItem(cfTree());
    await renderButton();
    click(trigger());
    key(byTestId("cf:highlightCells"), "ArrowRight");
    expect(menus()).toHaveLength(2);
    key(byTestId("cf:greaterThan"), "Escape");
    expect(menus()).toHaveLength(1);
    key(byTestId("cf:highlightCells"), "Escape");
    expect(menus()).toHaveLength(0);
    expect(document.activeElement).toBe(trigger());
  });
});

// ============================================================================
// Nothing usable registered: disabled, and the tooltip says why
// ============================================================================

describe("unavailable: greyed, inert, and the tooltip says why", () => {
  it("the CF extension is not running (Format menu present, item absent)", async () => {
    registerFormatMenu();
    await renderButton();
    const button = trigger();
    expect(button.getAttribute("aria-disabled")).toBe("true");
    // Never NATIVELY disabled: a disabled button shows no tooltip at all.
    expect(button.disabled).toBe(false);
    expect(getComputedStyle(button).opacity).toBe(String(DISABLED_OPACITY));
    click(button);
    expect(menus()).toHaveLength(0);
    expect(tooltipOf(button)).toBe(CONDITIONAL_FORMATTING_UNAVAILABLE.noItem);
  });

  it("the Format menu that hosts the item is not loaded -- said so, not blamed on CF", async () => {
    await renderButton();
    expect(trigger().getAttribute("aria-disabled")).toBe("true");
    expect(tooltipOf(trigger())).toBe(CONDITIONAL_FORMATTING_UNAVAILABLE.noMenu);
  });

  it("CF registered before the Format menu existed: enabled the moment the menu arrives", async () => {
    // Activation order is not guaranteed: the registry keeps an item for a
    // menu that does not exist yet and appends it when the menu registers.
    registerItem(cfTree());
    await renderButton();
    expect(trigger().getAttribute("aria-disabled")).toBe("true");
    expect(tooltipOf(trigger())).toBe(CONDITIONAL_FORMATTING_UNAVAILABLE.noMenu);
    registerFormatMenu();
    expect(trigger().hasAttribute("aria-disabled")).toBe(false);
    expect(tooltipOf(trigger())).toBe("Conditional Formatting");
    click(trigger());
    expect(menus()).toHaveLength(1);
  });

  it("registered after the ribbon mounted: enabled then, and greyed again when CF deactivates", async () => {
    registerFormatMenu();
    await renderButton();
    expect(trigger().getAttribute("aria-disabled")).toBe("true");
    registerItem(cfTree());
    expect(trigger().hasAttribute("aria-disabled")).toBe(false);
    cleanupRegistry();
    registerFormatMenu();
    expect(trigger().getAttribute("aria-disabled")).toBe("true");
    expect(tooltipOf(trigger())).toBe(CONDITIONAL_FORMATTING_UNAVAILABLE.noItem);
  });

  it("registered but hidden or disabled by its owner: 'not available right now'", async () => {
    registerFormatMenu();
    registerItem(cfTree());
    await renderButton();
    act(() => updateMenuItem(FORMAT_MENU_ID, CONDITIONAL_FORMATTING_MENU_ITEM_ID, { disabled: true }));
    expect(trigger().getAttribute("aria-disabled")).toBe("true");
    expect(tooltipOf(trigger())).toBe(CONDITIONAL_FORMATTING_UNAVAILABLE.off);
    act(() => updateMenuItem(FORMAT_MENU_ID, CONDITIONAL_FORMATTING_MENU_ITEM_ID, { disabled: false, hidden: true }));
    expect(trigger().getAttribute("aria-disabled")).toBe("true");
    expect(tooltipOf(trigger())).toBe(CONDITIONAL_FORMATTING_UNAVAILABLE.off);
    act(() => updateMenuItem(FORMAT_MENU_ID, CONDITIONAL_FORMATTING_MENU_ITEM_ID, { hidden: false }));
    expect(trigger().hasAttribute("aria-disabled")).toBe(false);
  });

  it("greyed, the tooltip drops its shortcut chip: no key is advertised for a command that cannot run", async () => {
    // The catalog entry carries no shortcut today; a customised tooltip that
    // does (the itemTooltip split) must still lose its chip while greyed.
    const withKey = { ...ITEM, tooltip: "Conditional Formatting (Alt+H)" };
    registerFormatMenu();
    registerItem(cfTree());
    await render(<ConditionalFormattingButton item={withKey} state={STATE} band />, bandLayout(1200));
    // Live: the text and the chip, said once each.
    expect(tooltipChipOf(trigger())).toBe("Alt+H");
    expect(tooltipOf(trigger())).toBe("Conditional FormattingAlt+H");
    act(() => updateMenuItem(FORMAT_MENU_ID, CONDITIONAL_FORMATTING_MENU_ITEM_ID, { disabled: true }));
    expect(tooltipChipOf(trigger())).toBeNull();
    expect(tooltipOf(trigger())).toBe(CONDITIONAL_FORMATTING_UNAVAILABLE.off);
  });

  it("each reason names the command, and none of them is the enabled tooltip", () => {
    const reasons = Object.values(CONDITIONAL_FORMATTING_UNAVAILABLE);
    expect(new Set(reasons).size).toBe(reasons.length);
    for (const reason of reasons) {
      expect(reason.startsWith("Conditional Formatting ")).toBe(true);
      expect(reason).not.toBe("Conditional Formatting");
    }
    expect(CONDITIONAL_FORMATTING_UNAVAILABLE.noItem).toMatch(/Conditional Formatting extension/);
    expect(CONDITIONAL_FORMATTING_UNAVAILABLE.noMenu).toMatch(/Format menu/);
  });
});

// ============================================================================
// The tooltip's verdict and the kit's verdict never disagree
// ============================================================================

describe("the reason agrees with the kit's own enabled/disabled decision", () => {
  // The tooltip's reason is computed beside RegisteredMenuButton, which makes
  // its own call on the same item. If the two rules ever drift, the ribbon
  // shows a greyed button with no reason -- or a live one that says it is
  // unavailable. Each registration shape the kit distinguishes, both ways.
  const SHAPES: Array<[string, MenuItemDefinition | null, boolean]> = [
    ["absent", null, true],
    ["children", { id: CONDITIONAL_FORMATTING_MENU_ITEM_ID, label: "CF", children: [{ id: "a", label: "A", action: () => undefined }] }, false],
    ["custom content only", { id: CONDITIONAL_FORMATTING_MENU_ITEM_ID, label: "CF", customContent: () => <div /> }, false],
    ["runs an action", { id: CONDITIONAL_FORMATTING_MENU_ITEM_ID, label: "CF", action: () => undefined }, false],
    ["runs a command", { id: CONDITIONAL_FORMATTING_MENU_ITEM_ID, label: "CF", commandId: "cf.x" }, false],
    ["does nothing", { id: CONDITIONAL_FORMATTING_MENU_ITEM_ID, label: "CF" }, true],
    [
      "only hidden children",
      { id: CONDITIONAL_FORMATTING_MENU_ITEM_ID, label: "CF", children: [{ id: "a", label: "A", hidden: true, action: () => undefined }] },
      true,
    ],
    [
      "only separators",
      { id: CONDITIONAL_FORMATTING_MENU_ITEM_ID, label: "CF", children: [{ id: "s", label: "", separator: true }] },
      true,
    ],
    [
      "hidden children but custom content",
      {
        id: CONDITIONAL_FORMATTING_MENU_ITEM_ID,
        label: "CF",
        children: [{ id: "a", label: "A", hidden: true, action: () => undefined }],
        customContent: () => <div />,
      },
      false,
    ],
    ["disabled", { id: CONDITIONAL_FORMATTING_MENU_ITEM_ID, label: "CF", disabled: true, action: () => undefined }, true],
    ["hidden", { id: CONDITIONAL_FORMATTING_MENU_ITEM_ID, label: "CF", hidden: true, action: () => undefined }, true],
  ];

  for (const [name, item, greyed] of SHAPES) {
    it(`${name}: ${greyed ? "greyed, with a reason" : "live, with the catalog tooltip"}`, async () => {
      registerFormatMenu();
      if (item) registerItem(item);
      await renderButton();
      expect(trigger().getAttribute("aria-disabled") === "true", "the kit's decision").toBe(greyed);
      expect(registeredHeroUnavailable(item, true) !== null, "the tooltip's decision").toBe(greyed);
      const tip = tooltipOf(trigger());
      if (greyed) expect(tip).not.toBe("Conditional Formatting");
      else expect(tip).toBe("Conditional Formatting");
    });
  }

  it("the pure rule: no menu, no item, off, or available", () => {
    expect(registeredHeroUnavailable(null, false)).toBe("noMenu");
    expect(registeredHeroUnavailable(null, true)).toBe("noItem");
    expect(registeredHeroUnavailable({ id: "x", label: "X", disabled: true, action: () => undefined }, true)).toBe("off");
    expect(registeredHeroUnavailable({ id: "x", label: "X", action: () => undefined }, true)).toBeNull();
  });
});

