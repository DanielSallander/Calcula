// Tests for the registered-menu seam (CONTRACT 6.4): RegisteredMenuButton
// and useRegisteredMenuItem render a subtree ANOTHER extension registered in
// the menu bar (getMenus() from @api/ui) under a ribbon control, so Format >
// Conditional Formatting and Home > Conditional Formatting are ONE tree owned
// by the Conditional Formatting extension -- galleries included -- and Format
// as Table's gallery is the Table extension's own.
//
// Driven through the REAL menu registry (registerMenu / registerMenuItem /
// updateMenuItem / unregisterMenuItem), because the defect this seam has to
// be safe against is a ribbon button that keeps showing what an extension has
// since taken back, or never shows what it registered after the ribbon
// mounted. Every test uses its own menu id: the registry is a module
// singleton, and unregisterMenu deliberately KEEPS items other extensions
// contributed, so a shared id would leak rows between tests.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { SurfaceLayoutProvider, bandLayout, panelLayout, useSurfaceLayout, type SurfaceLayout } from "../context";
import { Button, CommandButton } from "../primitives/Button";
import { RegisteredMenuButton, useRegisteredMenuItem } from "../primitives/MenuTree";
import { DISABLED_OPACITY } from "../primitives/disabled";
import {
  getMenus,
  notifyMenusChanged,
  registerMenu,
  registerMenuItem,
  unregisterMenu,
  unregisterMenuItem,
  updateMenuItem,
  type MenuItemDefinition,
} from "../../ui";
import { CommandRegistry } from "../../commands";
import { hardcodedColours } from "./colourScan";

// A refusal a registered row THROWS is shown to the user (alertAsync, the Home
// runners' door), never only logged: the console is not the user.
const { alertMock } = vi.hoisted(() => ({ alertMock: vi.fn() }));
vi.mock("../../dialogs", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../dialogs")>()),
  alertAsync: alertMock,
}));

let container: HTMLDivElement;
let root: Root;
let seq = 0;
let menuId = "";
const registered: string[] = [];

beforeEach(() => {
  Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  seq += 1;
  menuId = `test-format-${seq}`;
});

afterEach(() => {
  act(() => root.unmount());
  act(() => {
    for (const id of registered.splice(0)) unregisterMenu(id);
  });
  vi.restoreAllMocks();
  document.body.innerHTML = "";
});

function render(node: React.ReactNode, layout: SurfaceLayout = panelLayout(300)): void {
  act(() => {
    root.render(<SurfaceLayoutProvider value={layout}>{node}</SurfaceLayoutProvider>);
  });
}

function click(el: Element): void {
  act(() => {
    el.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
}

function mouseDown(el: Element): void {
  act(() => {
    el.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
  });
}

function key(el: Element, k: string): KeyboardEvent {
  const event = new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true });
  act(() => {
    el.dispatchEvent(event);
  });
  return event;
}

function byTestId<T extends Element = HTMLElement>(id: string): T {
  const el = document.querySelector(`[data-testid='${id}']`);
  if (!el) throw new Error(`no element for ${id}`);
  return el as T;
}

function maybe(id: string): HTMLElement | null {
  return document.querySelector(`[data-testid='${id}']`);
}

function menus(): HTMLElement[] {
  return Array.from(document.querySelectorAll<HTMLElement>("[role='menu']"));
}

function rows(menu: HTMLElement): HTMLElement[] {
  return Array.from(
    menu.querySelectorAll<HTMLElement>("[role='menuitem'], [role='menuitemradio'], [role='menuitemcheckbox']"),
  );
}

function defineMenu(items: MenuItemDefinition[] = []): void {
  act(() => {
    registerMenu({ id: menuId, label: "Format", order: 1, items });
  });
  registered.push(menuId);
}

/** A 16-unit menu-bar glyph with no size of its own, like menuIcons.tsx's. */
const Glyph = (
  <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" data-testid="glyph">
    <rect x="1" y="1" width="14" height="14" />
  </svg>
);

/** A gallery that draws no background (the CF galleries) and closes the chain. */
function Gallery({ onClose, onPick }: { onClose: () => void; onPick: (v: string) => void }): React.ReactElement {
  const layout = useSurfaceLayout();
  return (
    <div data-testid="gallery" data-container={layout.container}>
      <button
        type="button"
        data-testid="swatch-green"
        onClick={() => {
          onPick("green");
          onClose();
        }}
      >
        Green
      </button>
    </div>
  );
}

function Hero({ id = "cf" }: { id?: string }): React.ReactElement {
  return (
    <>
      <RegisteredMenuButton
        menuId={menuId}
        itemId="format:conditionalFormatting"
        trigger={
          <CommandButton
            icon={Glyph}
            label="Conditional Formatting"
            chevron
            labelLines={2}
            data-testid={`fmt-${id}`}
          />
        }
      />
      <input data-testid="elsewhere" />
    </>
  );
}

// ============================================================================
// Not registered
// ============================================================================

describe("RegisteredMenuButton: an item nobody registered", () => {
  it("renders the trigger aria-disabled (so its tooltip can still say why), opening nothing", () => {
    defineMenu();
    render(<Hero />, bandLayout());
    const trigger = byTestId<HTMLButtonElement>("fmt-cf");
    expect(trigger.getAttribute("aria-disabled")).toBe("true");
    expect(trigger.disabled).toBe(false);
    expect(getComputedStyle(trigger).opacity).toBe(String(DISABLED_OPACITY));
    click(trigger);
    expect(menus()).toHaveLength(0);
    expect(document.querySelector("[data-section-flyout]")).toBeNull();
  });

  it("an unknown MENU is the same as an unknown item", () => {
    render(<Hero />, bandLayout());
    expect(byTestId("fmt-cf").getAttribute("aria-disabled")).toBe("true");
  });

  it("does not run the trigger's own onClick while disabled", () => {
    defineMenu();
    const own = vi.fn();
    render(
      <RegisteredMenuButton
        menuId={menuId}
        itemId="nothing"
        trigger={<Button data-testid="t" onClick={own}>X</Button>}
      />,
    );
    click(byTestId("t"));
    expect(own).not.toHaveBeenCalled();
  });

  it("re-renders ENABLED when the extension registers the item after the ribbon mounted", () => {
    defineMenu();
    render(<Hero />, bandLayout());
    expect(byTestId("fmt-cf").getAttribute("aria-disabled")).toBe("true");
    act(() => {
      registerMenuItem(menuId, {
        id: "format:conditionalFormatting",
        label: "Conditional Formatting",
        children: [{ id: "cf:newRule", label: "New Rule...", action: () => undefined }],
      });
    });
    const trigger = byTestId("fmt-cf");
    expect(trigger.hasAttribute("aria-disabled")).toBe(false);
    click(trigger);
    expect(menus()).toHaveLength(1);
  });

  it("goes disabled again when the extension takes the item back (deactivation)", () => {
    defineMenu([
      {
        id: "format:conditionalFormatting",
        label: "Conditional Formatting",
        children: [{ id: "cf:newRule", label: "New Rule...", action: () => undefined }],
      },
    ]);
    render(<Hero />, bandLayout());
    expect(byTestId("fmt-cf").hasAttribute("aria-disabled")).toBe(false);
    act(() => unregisterMenuItem(menuId, "format:conditionalFormatting"));
    expect(byTestId("fmt-cf").getAttribute("aria-disabled")).toBe("true");
  });

  it("a hidden or disabled registered item disables the trigger", () => {
    defineMenu([
      {
        id: "format:conditionalFormatting",
        label: "Conditional Formatting",
        children: [{ id: "cf:newRule", label: "New Rule...", action: () => undefined }],
      },
    ]);
    render(<Hero />, bandLayout());
    act(() => updateMenuItem(menuId, "format:conditionalFormatting", { hidden: true }));
    expect(byTestId("fmt-cf").getAttribute("aria-disabled")).toBe("true");
    act(() => updateMenuItem(menuId, "format:conditionalFormatting", { hidden: false, disabled: true }));
    expect(byTestId("fmt-cf").getAttribute("aria-disabled")).toBe("true");
    act(() => updateMenuItem(menuId, "format:conditionalFormatting", { disabled: false }));
    expect(byTestId("fmt-cf").hasAttribute("aria-disabled")).toBe(false);
  });
});

// ============================================================================
// A registered item with children -> a menu
// ============================================================================

describe("RegisteredMenuButton: children become a menu", () => {
  // Fresh per test: the rows close over these when register() runs.
  let actions = { greaterThan: vi.fn(), clearSheet: vi.fn() };
  beforeEach(() => {
    actions = { greaterThan: vi.fn(), clearSheet: vi.fn() };
  });

  function register(extra: Partial<MenuItemDefinition> = {}): void {
    defineMenu([
      {
        id: "format:conditionalFormatting",
        label: "Conditional Formatting",
        icon: Glyph,
        children: [
          {
            id: "cf:highlightCells",
            label: "Highlight Cells Rules",
            icon: Glyph,
            children: [
              { id: "cf:greaterThan", label: "Greater Than...", icon: Glyph, action: actions.greaterThan },
              { id: "cf:lessThan", label: "Less Than...", disabled: true, action: () => undefined },
              { id: "cf:secret", label: "Secret", hidden: true, action: () => undefined },
            ],
          },
          {
            id: "cf:dataBars",
            label: "Data Bars",
            icon: Glyph,
            customContent: (onClose) => <Gallery onClose={onClose} onPick={actions.greaterThan} />,
          },
          { id: "cf:sep1", label: "", separator: true },
          { id: "cf:newRule", label: "New Rule...", commandId: "cf.newRule", shortcut: "Ctrl+R" },
          { id: "cf:showIcons", label: "Show Icons", checked: true, action: () => undefined },
          { id: "cf:sep2", label: "", separator: true },
          { id: "cf:sep3", label: "", separator: true },
          { id: "cf:clear", label: "Clear Rules from Entire Sheet", action: actions.clearSheet },
          { id: "cf:sep4", label: "", separator: true },
        ],
        ...extra,
      },
    ]);
  }

  it("the trigger is a menu button; the rows follow the registered order", () => {
    register();
    render(<Hero />, bandLayout());
    const trigger = byTestId("fmt-cf");
    expect(trigger.getAttribute("aria-haspopup")).toBe("menu");
    click(trigger);
    const [top] = menus();
    expect(top.getAttribute("aria-labelledby")).toBe(trigger.id);
    expect(rows(top).map((r) => r.getAttribute("data-testid"))).toEqual([
      "cf:highlightCells",
      "cf:dataBars",
      "cf:newRule",
      "cf:showIcons",
      "cf:clear",
    ]);
    expect(rows(top).map((r) => r.querySelector("[data-menu-label]")?.textContent)).toEqual([
      "Highlight Cells Rules",
      "Data Bars",
      "New Rule...",
      "Show Icons",
      "Clear Rules from Entire Sheet",
    ]);
  });

  it("separators: one between groups, never doubled, never at the ends", () => {
    register();
    render(<Hero />, bandLayout());
    click(byTestId("fmt-cf"));
    const [top] = menus();
    const kinds = Array.from(top.children).map((el) => (el.getAttribute("role") === "separator" ? "-" : "row"));
    expect(kinds).toEqual(["row", "row", "-", "row", "row", "-", "row"]);
  });

  it("children become MenuSubs; customContent becomes a MenuSub whose flyout is the content", () => {
    register();
    render(<Hero />, bandLayout());
    click(byTestId("fmt-cf"));
    const highlight = byTestId("cf:highlightCells");
    const bars = byTestId("cf:dataBars");
    expect(highlight.getAttribute("aria-haspopup")).toBe("menu");
    // A customContent flyout (the Data Bars gallery) is custom content -- a
    // role=group with its own keys -- so its row announces a "dialog" popup,
    // not a menu (MenuSub, 2026-10-04 follow-up).
    expect(bars.getAttribute("aria-haspopup")).toBe("dialog");
    key(highlight, "ArrowRight");
    const flyout = menus()[1];
    expect(rows(flyout).map((r) => r.getAttribute("data-testid"))).toEqual(["cf:greaterThan", "cf:lessThan"]);
    expect(byTestId<HTMLButtonElement>("cf:lessThan").disabled).toBe(true);
    expect(maybe("cf:secret")).toBeNull();
  });

  it("an action row runs after the whole chain closed and focus is back on the trigger", () => {
    let focusedAtRun: Element | null = null;
    actions.greaterThan.mockImplementation(() => {
      focusedAtRun = document.activeElement;
    });
    register();
    render(<Hero />, bandLayout());
    click(byTestId("fmt-cf"));
    key(byTestId("cf:highlightCells"), "ArrowRight");
    key(byTestId("cf:greaterThan"), "Enter");
    expect(actions.greaterThan).toHaveBeenCalledTimes(1);
    expect(menus()).toHaveLength(0);
    expect(focusedAtRun).toBe(byTestId("fmt-cf"));
  });

  it("a commandId row runs through CommandRegistry.execute", () => {
    const execute = vi.spyOn(CommandRegistry, "execute").mockResolvedValue(undefined);
    register();
    render(<Hero />, bandLayout());
    click(byTestId("fmt-cf"));
    click(byTestId("cf:newRule"));
    expect(execute).toHaveBeenCalledWith("cf.newRule");
    expect(menus()).toHaveLength(0);
  });

  it("a command that THROWS a refusal shows it to the user (alertAsync, not awaited) and logs it", async () => {
    alertMock.mockReset();
    alertMock.mockReturnValue(new Promise(() => undefined)); // the user never answers: nothing may wait on it
    vi.spyOn(CommandRegistry, "execute").mockRejectedValue(new Error("This sheet is protected."));
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    register();
    render(<Hero />, bandLayout());
    click(byTestId("fmt-cf"));
    click(byTestId("cf:newRule"));
    await act(async () => {
      await Promise.resolve();
    });
    expect(alertMock).toHaveBeenCalledTimes(1);
    expect(alertMock).toHaveBeenCalledWith("This sheet is protected.");
    expect(error).toHaveBeenCalled();
  });

  it("an action that throws (or rejects) is shown to the user too", async () => {
    alertMock.mockReset();
    alertMock.mockResolvedValue(undefined);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    actions.clearSheet.mockImplementation(() => {
      throw new Error("Cannot clear rules: the sheet is protected.");
    });
    register();
    render(<Hero />, bandLayout());
    click(byTestId("fmt-cf"));
    click(byTestId("cf:clear"));
    await act(async () => {
      await Promise.resolve();
    });
    expect(alertMock).toHaveBeenCalledWith("Cannot clear rules: the sheet is protected.");
    expect(menus()).toHaveLength(0);
  });

  it("a failing command is reported, not thrown into React", async () => {
    vi.spyOn(CommandRegistry, "execute").mockRejectedValue(new Error("boom"));
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    register();
    render(<Hero />, bandLayout());
    click(byTestId("fmt-cf"));
    click(byTestId("cf:newRule"));
    await act(async () => {
      await Promise.resolve();
    });
    expect(error).toHaveBeenCalled();
  });

  it("checked becomes a menuitemcheckbox; shortcut shows; icons are fitted to 16px", () => {
    register();
    render(<Hero />, bandLayout());
    click(byTestId("fmt-cf"));
    const show = byTestId("cf:showIcons");
    expect(show.getAttribute("role")).toBe("menuitemcheckbox");
    expect(show.getAttribute("aria-checked")).toBe("true");
    expect(byTestId("cf:newRule").querySelector("kbd")?.textContent).toBe("Ctrl+R");
    const glyph = byTestId("cf:highlightCells").querySelector("svg") as SVGElement;
    const box = glyph.parentElement as HTMLElement;
    expect(getComputedStyle(box).width).toBe("16px");
    expect(getComputedStyle(box).height).toBe("16px");
    expect(getComputedStyle(glyph).width).toBe("16px");
    // A row with no icon gets none (no blank column forced on the tree).
    expect(byTestId("cf:clear").children[1].hasAttribute("data-menu-label")).toBe(true);
  });

  it("a gallery flyout gets card chrome and a popover surface; its onClose closes the chain", () => {
    register();
    render(<Hero />, bandLayout());
    const trigger = byTestId("fmt-cf");
    click(trigger);
    key(byTestId("cf:dataBars"), "ArrowRight");
    const gallery = byTestId("gallery");
    expect(gallery.getAttribute("data-container")).toBe("popover");
    const card = gallery.closest("[data-section-flyout]") as HTMLElement;
    expect(getComputedStyle(card).borderRadius).toContain("--radius-popover");
    expect(document.activeElement).toBe(byTestId("swatch-green"));
    mouseDown(byTestId("swatch-green"));
    expect(menus()).toHaveLength(1);
    click(byTestId("swatch-green"));
    expect(actions.greaterThan).toHaveBeenCalledWith("green");
    expect(maybe("gallery")).toBeNull();
    expect(menus()).toHaveLength(0);
    expect(document.activeElement).toBe(trigger);
  });

  it("follows a live change while OPEN (updateMenuItem + notifyMenusChanged)", () => {
    register();
    render(<Hero />, bandLayout());
    click(byTestId("fmt-cf"));
    expect(byTestId("cf:showIcons").getAttribute("aria-checked")).toBe("true");
    // Mutating a nested child in place and announcing it is the registry's
    // documented way to flip a checked state (notifyMenusChanged, ui.ts). The
    // item OBJECT is the same before and after, so a renderer that compared
    // identities would miss it.
    act(() => {
      const top = getMenus()
        .find((m) => m.id === menuId)
        ?.items.find((i) => i.id === "format:conditionalFormatting");
      const child = top?.children?.find((c) => c.id === "cf:showIcons");
      if (child) child.checked = false;
      notifyMenusChanged();
    });
    expect(byTestId("cf:showIcons").getAttribute("aria-checked")).toBe("false");
    expect(menus()).toHaveLength(1);
  });

  it("placement and width reach the popover", () => {
    register();
    render(
      <RegisteredMenuButton
        menuId={menuId}
        itemId="format:conditionalFormatting"
        width={260}
        placement="bottom-end"
        trigger={<Button data-testid="t">CF</Button>}
      />,
    );
    click(byTestId("t"));
    const card = menus()[0].closest("[data-section-flyout]") as HTMLElement;
    expect(card.style.width).toBe("260px");
  });

  it.each([
    ["band", bandLayout()],
    ["panel", panelLayout(300)],
  ])("paints no hardcoded colour in the %s, open two levels deep", (_name, layout) => {
    register();
    render(<Hero />, layout);
    click(byTestId("fmt-cf"));
    key(byTestId("cf:highlightCells"), "ArrowRight");
    expect(hardcodedColours(document.body)).toEqual([]);
  });
});

// ============================================================================
// A registered item with ONLY customContent -> the popover body
// ============================================================================

describe("RegisteredMenuButton: customContent alone is the whole popover body", () => {
  function register(onPick: (v: string) => void): void {
    defineMenu([
      {
        id: "format:formatAsTable",
        label: "Format as Table",
        customContent: (onClose) => <Gallery onClose={onClose} onPick={onPick} />,
      },
    ]);
  }

  function Table(): React.ReactElement {
    return (
      <>
        <RegisteredMenuButton
          menuId={menuId}
          itemId="format:formatAsTable"
          width={300}
          trigger={<CommandButton icon={Glyph} label="Format as Table" chevron labelLines={2} data-testid="fmt-fat" />}
        />
        <input data-testid="elsewhere" />
      </>
    );
  }

  it("the trigger announces a dialog; the card holds the content and nothing else", () => {
    register(() => undefined);
    render(<Table />, bandLayout());
    const trigger = byTestId("fmt-fat");
    expect(trigger.getAttribute("aria-haspopup")).toBe("dialog");
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
    click(trigger);
    expect(trigger.getAttribute("aria-expanded")).toBe("true");
    const gallery = byTestId("gallery");
    expect(menus()).toHaveLength(0);
    const card = gallery.closest("[data-section-flyout]") as HTMLElement;
    expect(card.getAttribute("role")).toBe("dialog");
    expect(card.getAttribute("aria-label")).toBe("Format as Table");
    expect(card.style.width).toBe("300px");
    // Galleries hosted this way draw no background: the CARD gives them chrome.
    expect(getComputedStyle(card).borderRadius).toContain("--radius-popover");
    expect(gallery.getAttribute("data-container")).toBe("popover");
    expect(trigger.getAttribute("aria-controls")).toBe((gallery.parentElement as HTMLElement).id);
  });

  it("onClose closes it and returns focus to the trigger; the pick ran first", () => {
    const onPick = vi.fn();
    register(onPick);
    render(<Table />, bandLayout());
    const trigger = byTestId("fmt-fat");
    click(trigger);
    click(byTestId("swatch-green"));
    expect(onPick).toHaveBeenCalledWith("green");
    expect(maybe("gallery")).toBeNull();
    expect(document.activeElement).toBe(trigger);
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
  });

  it("toggles on a second click; Escape and an outside press close it", () => {
    register(() => undefined);
    render(<Table />, bandLayout());
    const trigger = byTestId("fmt-fat");
    click(trigger);
    mouseDown(trigger);
    click(trigger);
    expect(maybe("gallery")).toBeNull();
    click(trigger);
    key(byTestId("swatch-green"), "Escape");
    expect(maybe("gallery")).toBeNull();
    expect(document.activeElement).toBe(trigger);
    click(trigger);
    mouseDown(byTestId("elsewhere"));
    expect(maybe("gallery")).toBeNull();
  });

  it("ArrowDown / ArrowUp on the trigger open the card with focus inside, as on every other hero (MenuButton)", () => {
    register(() => undefined);
    render(<Table />, bandLayout());
    const trigger = byTestId("fmt-fat");
    act(() => trigger.focus());

    const down = key(trigger, "ArrowDown");
    expect(down.defaultPrevented).toBe(true);
    expect(maybe("gallery")).not.toBeNull();
    expect(trigger.getAttribute("aria-expanded")).toBe("true");
    expect(document.activeElement).toBe(byTestId("swatch-green"));

    key(byTestId("swatch-green"), "Escape");
    expect(maybe("gallery")).toBeNull();
    expect(document.activeElement).toBe(trigger);

    key(trigger, "ArrowUp");
    expect(maybe("gallery")).not.toBeNull();
    expect(document.activeElement).toBe(byTestId("swatch-green"));
  });

  it("an arrow while a POINTER-opened card is open steps into it (and does not close it)", () => {
    register(() => undefined);
    render(<Table />, bandLayout());
    const trigger = byTestId("fmt-fat");
    act(() => {
      trigger.focus();
      trigger.dispatchEvent(new MouseEvent("click", { bubbles: true, detail: 1 }));
    });
    expect(maybe("gallery")).not.toBeNull();
    expect(document.activeElement).toBe(trigger);
    key(trigger, "ArrowDown");
    expect(maybe("gallery")).not.toBeNull();
    expect(document.activeElement).toBe(byTestId("swatch-green"));
  });

  it("other keys, and an arrow the trigger handled itself, open nothing", () => {
    register(() => undefined);
    render(
      <RegisteredMenuButton
        menuId={menuId}
        itemId="format:formatAsTable"
        trigger={
          <Button
            data-testid="own"
            onKeyDown={(e) => {
              if (e.key === "ArrowDown") e.preventDefault();
            }}
          >
            FaT
          </Button>
        }
      />,
    );
    const trigger = byTestId("own");
    key(trigger, "ArrowDown");
    key(trigger, "ArrowRight");
    key(trigger, "a");
    expect(maybe("gallery")).toBeNull();
  });
});

// ============================================================================
// The barrel: extensions import these from @api/layout and nowhere else
// ============================================================================

describe("@api/layout exports the menu additions", () => {
  it("RegisteredMenuButton, useRegisteredMenuItem, MenuSub, MENU_ICON_BLANK, useMenuClose", async () => {
    const layout = await import("..");
    const menu = await import("../primitives/Menu");
    expect(layout.RegisteredMenuButton).toBe(RegisteredMenuButton);
    expect(layout.useRegisteredMenuItem).toBe(useRegisteredMenuItem);
    expect(layout.MenuSub).toBe(menu.MenuSub);
    expect(layout.MENU_ICON_BLANK).toBe(menu.MENU_ICON_BLANK);
    expect(layout.useMenuClose).toBe(menu.useMenuClose);
    expect(layout.SUBMENU_HOVER_DELAY_MS).toBe(200);
    expect(layout.HERO_SPLIT_TOP_HEIGHT).toBe(41);
  });
});

// ============================================================================
// useRegisteredMenuItem
// ============================================================================

describe("useRegisteredMenuItem", () => {
  function Readout({ itemId }: { itemId: string }): React.ReactElement {
    const item = useRegisteredMenuItem(menuId, itemId);
    return <span data-testid="readout">{item ? `${item.label}|${item.disabled ? "off" : "on"}` : "none"}</span>;
  }

  it("is null until registered, then follows the registry (nested ids too)", () => {
    defineMenu();
    render(<Readout itemId="cf:greaterThan" />);
    expect(byTestId("readout").textContent).toBe("none");
    act(() => {
      registerMenuItem(menuId, {
        id: "format:conditionalFormatting",
        label: "Conditional Formatting",
        children: [{ id: "cf:greaterThan", label: "Greater Than...", action: () => undefined }],
      });
    });
    expect(byTestId("readout").textContent).toBe("Greater Than...|on");
  });

  it("re-renders on updateMenuItem of a top-level item", () => {
    defineMenu([{ id: "format:cells", label: "Cells...", action: () => undefined }]);
    render(<Readout itemId="format:cells" />);
    expect(byTestId("readout").textContent).toBe("Cells...|on");
    act(() => updateMenuItem(menuId, "format:cells", { disabled: true, label: "Format Cells..." }));
    expect(byTestId("readout").textContent).toBe("Format Cells...|off");
  });

  it("a registration that happened between render and subscription is not missed", () => {
    defineMenu();
    // A child's LAYOUT effect runs after the parent rendered (and read the
    // registry) but before the parent's passive effect subscribes: the worst
    // case of an extension activating while the ribbon mounts, when no
    // subscriber exists yet to hear the notification.
    function Registrar(): null {
      React.useLayoutEffect(() => {
        registerMenuItem(menuId, { id: "late", label: "Late", action: () => undefined });
      }, []);
      return null;
    }
    function Racer(): React.ReactElement {
      const item = useRegisteredMenuItem(menuId, "late");
      return (
        <>
          <Registrar />
          <span data-testid="readout">{item ? item.label : "none"}</span>
        </>
      );
    }
    render(<Racer />);
    expect(byTestId("readout").textContent).toBe("Late");
  });
});
