// Tests for the Menu family: MenuButton (trigger clone + card popover),
// Menu (the keyboard model), MenuItem (the row recipe and its roles),
// MenuSeparator and MenuHeading. The keyboard contract is the WAI-ARIA menu
// button pattern and is pinned key by key, including the two behaviours that
// only matter when a menu is NESTED in another overlay: Escape and a press
// inside the open menu must not dismiss the overlay the menu was opened from.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import React, { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { SurfaceLayoutProvider, bandLayout, panelLayout, type SurfaceLayout } from "../context";
import { Button, IconButton } from "../primitives/Button";
import { Popover } from "../primitives/Popover";
import {
  Menu,
  MenuButton,
  MenuHeading,
  MenuItem,
  MenuSeparator,
  type MenuButtonProps,
} from "../primitives/Menu";
import { declared, hardcodedColours } from "./colourScan";

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
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

function menu(): HTMLElement | null {
  return document.querySelector("[role='menu']");
}

function items(): HTMLButtonElement[] {
  return Array.from(
    document.querySelectorAll<HTMLButtonElement>(
      "[role='menuitem'], [role='menuitemradio'], [role='menuitemcheckbox']",
    ),
  );
}

const Icon = () => (
  <svg width={20} height={20} viewBox="0 0 24 24" aria-hidden>
    <rect x="3" y="3" width="18" height="18" rx="2" fill="currentColor" />
  </svg>
);

/** The Chart Design "Actions" menu, with a trigger and a field elsewhere. */
function Actions({
  onRun = () => undefined,
  ...props
}: Partial<MenuButtonProps> & { onRun?: (id: string) => void }): React.ReactElement {
  return (
    <>
      <MenuButton
        trigger={<Button data-testid="trigger">Actions</Button>}
        ariaLabel="Chart actions"
        {...props}
      >
        <MenuItem testId="edit" icon={<Icon />} onSelect={() => onRun("edit")}>
          Edit Chart...
        </MenuItem>
        <MenuItem testId="save" icon={<Icon />} onSelect={() => onRun("save")} shortcut="Ctrl+Shift+S">
          Save Image...
        </MenuItem>
        <MenuItem testId="format" disabled onSelect={() => onRun("format")}>
          Format Data Point...
        </MenuItem>
        <MenuSeparator />
        <MenuItem testId="json" onSelect={() => onRun("json")} hint="task pane">
          Show Chart JSON
        </MenuItem>
      </MenuButton>
      <input data-testid="elsewhere" />
    </>
  );
}

// ============================================================================
// MenuButton — the trigger clone and the popover
// ============================================================================

describe("MenuButton", () => {
  it("clones the trigger with aria-haspopup=menu and aria-expanded, adding no wrapper", () => {
    render(<Actions />);
    const trigger = byTestId("trigger");
    expect(container.firstElementChild).toBe(trigger);
    expect(trigger.getAttribute("aria-haspopup")).toBe("menu");
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
    expect(trigger.hasAttribute("aria-controls")).toBe(false);
    expect(trigger.textContent).toBe("Actions");
    expect(menu()).toBeNull();
  });

  it("a click opens a card popover holding role=menu, and focuses the first item", () => {
    render(<Actions />);
    const trigger = byTestId("trigger");
    click(trigger);
    const m = menu()!;
    expect(m).not.toBeNull();
    expect(trigger.getAttribute("aria-expanded")).toBe("true");
    expect(trigger.getAttribute("aria-controls")).toBe(m.id);
    expect(m.getAttribute("aria-label")).toBe("Chart actions");
    const pop = m.closest("[data-section-flyout]") as HTMLElement;
    expect(pop).not.toBeNull();
    expect(pop.hasAttribute("data-ribbon-content")).toBe(true);
    expect(pop.getAttribute("role")).toBe("presentation");
    expect(getComputedStyle(pop).borderRadius).toContain("--radius-popover");
    expect(document.activeElement).toBe(byTestId("edit"));
  });

  it("a second click on the trigger closes it", () => {
    render(<Actions />);
    const trigger = byTestId("trigger");
    click(trigger);
    mouseDown(trigger);
    click(trigger);
    expect(menu()).toBeNull();
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
  });

  it("chains the trigger's own onClick", () => {
    const own = vi.fn();
    render(
      <MenuButton trigger={<Button data-testid="trigger" onClick={own}>Go</Button>}>
        <MenuItem onSelect={() => undefined}>One</MenuItem>
      </MenuButton>,
    );
    click(byTestId("trigger"));
    expect(own).toHaveBeenCalledTimes(1);
    expect(menu()).not.toBeNull();
  });

  it("is named by its trigger when no ariaLabel is given", () => {
    render(
      <MenuButton trigger={<Button data-testid="trigger">Trendline</Button>}>
        <MenuItem onSelect={() => undefined}>Linear</MenuItem>
      </MenuButton>,
    );
    const trigger = byTestId("trigger");
    click(trigger);
    expect(trigger.id).not.toBe("");
    expect(menu()!.getAttribute("aria-labelledby")).toBe(trigger.id);
    expect(menu()!.hasAttribute("aria-label")).toBe(false);
  });

  it("works with an IconButton trigger", () => {
    render(
      <MenuButton trigger={<IconButton data-testid="trigger" icon={<Icon />} label="More" chevron />}>
        <MenuItem onSelect={() => undefined}>One</MenuItem>
      </MenuButton>,
    );
    const trigger = byTestId("trigger");
    expect(trigger.getAttribute("aria-label")).toBe("More");
    click(trigger);
    expect(menu()).not.toBeNull();
    expect(trigger.getAttribute("aria-expanded")).toBe("true");
  });

  it("ArrowDown on the trigger opens on the first item, ArrowUp on the last", () => {
    render(<Actions />);
    const trigger = byTestId("trigger");
    act(() => trigger.focus());
    key(trigger, "ArrowDown");
    expect(document.activeElement).toBe(byTestId("edit"));
    key(document.activeElement!, "Escape");
    expect(menu()).toBeNull();
    key(trigger, "ArrowUp");
    expect(document.activeElement).toBe(byTestId("json"));
  });

  it("the width prop sizes the popover", () => {
    render(<Actions width={246} />);
    click(byTestId("trigger"));
    const pop = menu()!.closest("[data-section-flyout]") as HTMLElement;
    expect(pop.style.width).toBe("246px");
  });

  it("an outside press dismisses it without moving focus to the trigger", () => {
    render(<Actions />);
    click(byTestId("trigger"));
    mouseDown(byTestId("elsewhere"));
    expect(menu()).toBeNull();
    expect(document.activeElement).not.toBe(byTestId("trigger"));
  });
});

// ============================================================================
// Menu — the keyboard model
// ============================================================================

describe("Menu keyboard", () => {
  it("ArrowDown/ArrowUp move between enabled items and wrap", () => {
    render(<Actions />);
    click(byTestId("trigger"));
    const [edit, save, , json] = items();
    key(edit, "ArrowDown");
    expect(document.activeElement).toBe(save);
    // "Format Data Point..." is disabled and skipped.
    key(save, "ArrowDown");
    expect(document.activeElement).toBe(json);
    key(json, "ArrowDown");
    expect(document.activeElement).toBe(edit);
    key(edit, "ArrowUp");
    expect(document.activeElement).toBe(json);
  });

  it("Home and End jump to the first and last enabled items", () => {
    render(<Actions />);
    click(byTestId("trigger"));
    const [edit, , , json] = items();
    key(edit, "End");
    expect(document.activeElement).toBe(json);
    key(json, "Home");
    expect(document.activeElement).toBe(edit);
  });

  it("navigation keys are consumed (preventDefault) so the page does not scroll", () => {
    render(<Actions />);
    click(byTestId("trigger"));
    expect(key(items()[0], "ArrowDown").defaultPrevented).toBe(true);
  });

  it("Enter runs the focused item, closes the menu and returns focus to the trigger", () => {
    const onRun = vi.fn();
    render(<Actions onRun={onRun} />);
    click(byTestId("trigger"));
    const event = key(byTestId("edit"), "Enter");
    expect(event.defaultPrevented).toBe(true);
    expect(onRun).toHaveBeenCalledWith("edit");
    expect(onRun).toHaveBeenCalledTimes(1);
    expect(menu()).toBeNull();
    expect(document.activeElement).toBe(byTestId("trigger"));
  });

  it("Space runs the focused item too", () => {
    const onRun = vi.fn();
    render(<Actions onRun={onRun} />);
    click(byTestId("trigger"));
    key(byTestId("edit"), "ArrowDown");
    key(byTestId("save"), " ");
    expect(onRun).toHaveBeenCalledWith("save");
    expect(menu()).toBeNull();
  });

  it("a click runs the item exactly once and closes the menu", () => {
    const onRun = vi.fn();
    render(<Actions onRun={onRun} />);
    click(byTestId("trigger"));
    click(byTestId("json"));
    expect(onRun).toHaveBeenCalledTimes(1);
    expect(onRun).toHaveBeenCalledWith("json");
    expect(menu()).toBeNull();
  });

  it("a disabled item neither runs nor closes the menu", () => {
    const onRun = vi.fn();
    render(<Actions onRun={onRun} />);
    click(byTestId("trigger"));
    const format = byTestId<HTMLButtonElement>("format");
    expect(format.disabled).toBe(true);
    click(format);
    expect(onRun).not.toHaveBeenCalled();
    expect(menu()).not.toBeNull();
  });

  it("the item runs AFTER focus has returned to the trigger", () => {
    let focusedAtRun: Element | null = null;
    render(<Actions onRun={() => (focusedAtRun = document.activeElement)} />);
    click(byTestId("trigger"));
    click(byTestId("edit"));
    expect(focusedAtRun).toBe(byTestId("trigger"));
  });

  it("Escape closes and returns focus to the trigger", () => {
    render(<Actions />);
    click(byTestId("trigger"));
    const event = key(byTestId("edit"), "Escape");
    expect(event.defaultPrevented).toBe(true);
    expect(menu()).toBeNull();
    expect(document.activeElement).toBe(byTestId("trigger"));
    expect(byTestId("trigger").getAttribute("aria-expanded")).toBe("false");
  });

  it("Tab closes, returns focus to the trigger and does NOT cancel the Tab", () => {
    render(<Actions />);
    click(byTestId("trigger"));
    const event = key(byTestId("edit"), "Tab");
    expect(event.defaultPrevented).toBe(false);
    expect(menu()).toBeNull();
    expect(document.activeElement).toBe(byTestId("trigger"));
  });

  it("a letter jumps to the next item starting with it, cycling", () => {
    render(
      <MenuButton trigger={<Button data-testid="trigger">Trendline</Button>}>
        <MenuItem testId="none" onSelect={() => undefined}>None</MenuItem>
        <MenuItem testId="linear" onSelect={() => undefined}>Linear</MenuItem>
        <MenuItem testId="exp" onSelect={() => undefined}>Exponential</MenuItem>
        <MenuItem testId="log" onSelect={() => undefined} hint="needs x > 0">
          Logarithmic
        </MenuItem>
      </MenuButton>,
    );
    click(byTestId("trigger"));
    key(byTestId("none"), "l");
    expect(document.activeElement).toBe(byTestId("linear"));
    key(byTestId("linear"), "L");
    expect(document.activeElement).toBe(byTestId("log"));
    key(byTestId("log"), "l");
    expect(document.activeElement).toBe(byTestId("linear"));
    key(byTestId("linear"), "e");
    expect(document.activeElement).toBe(byTestId("exp"));
    // No match: focus stays, and the key is not consumed.
    expect(key(byTestId("exp"), "z").defaultPrevented).toBe(false);
    expect(document.activeElement).toBe(byTestId("exp"));
  });

  it("the pointer moves focus inside a popup menu", () => {
    render(<Actions />);
    click(byTestId("trigger"));
    act(() => {
      byTestId("json").dispatchEvent(new MouseEvent("mousemove", { bubbles: true }));
    });
    expect(document.activeElement).toBe(byTestId("json"));
  });

  it("closeOnSelect={false} keeps the menu open after an item runs", () => {
    function Checks(): React.ReactElement {
      const [equation, setEquation] = useState(false);
      return (
        <MenuButton trigger={<Button data-testid="trigger">Options</Button>} closeOnSelect={false}>
          <MenuItem
            testId="eq"
            role="menuitemcheckbox"
            checked={equation}
            onSelect={() => setEquation((v) => !v)}
          >
            Show equation
          </MenuItem>
        </MenuButton>
      );
    }
    render(<Checks />);
    click(byTestId("trigger"));
    click(byTestId("eq"));
    expect(menu()).not.toBeNull();
    expect(byTestId("eq").getAttribute("aria-checked")).toBe("true");
  });
});

// ============================================================================
// Nesting inside another overlay
// ============================================================================

/** An outer popover (a stand-in for a Launcher flyout or an options card)
 *  holding a MenuButton. */
function Nested({ onOuterClose }: { onOuterClose: () => void }): React.ReactElement {
  const [anchor, setAnchor] = useState<HTMLButtonElement | null>(null);
  const [open, setOpen] = useState(true);
  return (
    <>
      <button ref={setAnchor} data-testid="outer-anchor">
        Outer
      </button>
      <Popover
        anchorEl={anchor}
        open={open}
        card
        onClose={() => {
          setOpen(false);
          onOuterClose();
        }}
      >
        <div data-testid="outer-body">
          <MenuButton trigger={<Button data-testid="trigger">Trendline</Button>}>
            <MenuItem testId="linear" onSelect={() => undefined}>
              Linear
            </MenuItem>
          </MenuButton>
        </div>
      </Popover>
    </>
  );
}

describe("Menu nested in another overlay", () => {
  it("Escape in the menu closes only the menu", () => {
    const onOuterClose = vi.fn();
    render(<Nested onOuterClose={onOuterClose} />);
    click(byTestId("trigger"));
    key(byTestId("linear"), "Escape");
    expect(menu()).toBeNull();
    expect(onOuterClose).not.toHaveBeenCalled();
    expect(byTestId("outer-body")).not.toBeNull();
    expect(document.activeElement).toBe(byTestId("trigger"));
  });

  it("a press on a menu item does not dismiss the outer overlay", () => {
    const onOuterClose = vi.fn();
    render(<Nested onOuterClose={onOuterClose} />);
    click(byTestId("trigger"));
    mouseDown(byTestId("linear"));
    expect(onOuterClose).not.toHaveBeenCalled();
    click(byTestId("linear"));
    expect(menu()).toBeNull();
    expect(onOuterClose).not.toHaveBeenCalled();
  });
});

// ============================================================================
// MenuItem — the row recipe and roles
// ============================================================================

describe("MenuItem", () => {
  it("is a 30px button row: radius 6, padding 0 9, gap 9, 12px text", () => {
    render(
      <Menu ariaLabel="Actions">
        <MenuItem testId="row" onSelect={() => undefined}>
          Edit
        </MenuItem>
      </Menu>,
    );
    const row = byTestId<HTMLButtonElement>("row");
    expect(row.tagName).toBe("BUTTON");
    expect(row.type).toBe("button");
    expect(row.getAttribute("role")).toBe("menuitem");
    const cs = getComputedStyle(row);
    expect(cs.height).toBe("30px");
    expect(cs.borderRadius).toBe("6px");
    expect(cs.padding).toBe("0px 9px");
    expect(cs.gap).toBe("9px");
    expect(cs.fontSize).toBe("12px");
    expect(declared(row, "background")).toBe("transparent");
  });

  it("a plain item carries no aria-checked; radio/checkbox items always do", () => {
    render(
      <Menu ariaLabel="Trendline">
        <MenuItem testId="plain" onSelect={() => undefined}>Edit</MenuItem>
        <MenuItem testId="r-on" role="menuitemradio" checked onSelect={() => undefined}>Linear</MenuItem>
        <MenuItem testId="r-off" role="menuitemradio" onSelect={() => undefined}>None</MenuItem>
        <MenuItem testId="c-on" role="menuitemcheckbox" checked onSelect={() => undefined}>Show R2</MenuItem>
      </Menu>,
    );
    expect(byTestId("plain").hasAttribute("aria-checked")).toBe(false);
    expect(byTestId("r-on").getAttribute("aria-checked")).toBe("true");
    expect(byTestId("r-off").getAttribute("aria-checked")).toBe("false");
    expect(byTestId("c-on").getAttribute("role")).toBe("menuitemcheckbox");
    expect(byTestId("c-on").getAttribute("aria-checked")).toBe("true");
  });

  it("the 16px check column is always present and holds an accent tick only when checked", () => {
    render(
      <Menu ariaLabel="Trendline">
        <MenuItem testId="on" role="menuitemradio" checked onSelect={() => undefined}>Linear</MenuItem>
        <MenuItem testId="off" role="menuitemradio" onSelect={() => undefined}>None</MenuItem>
      </Menu>,
    );
    const onCol = byTestId("on").firstElementChild as HTMLElement;
    const offCol = byTestId("off").firstElementChild as HTMLElement;
    expect(onCol.getAttribute("aria-hidden")).toBe("true");
    expect(getComputedStyle(onCol).width).toBe("16px");
    expect(getComputedStyle(offCol).width).toBe("16px");
    expect(onCol.querySelector("svg")).not.toBeNull();
    expect(offCol.querySelector("svg")).toBeNull();
    expect(declared(onCol, "color")).toContain("--state-accent");
  });

  it("renders icon, label, hint and shortcut; the label stays the text", () => {
    render(
      <Menu ariaLabel="Actions">
        <MenuItem testId="row" icon={<Icon />} hint="task pane" shortcut="Ctrl+J" onSelect={() => undefined}>
          Chart JSON
        </MenuItem>
      </Menu>,
    );
    const row = byTestId("row");
    expect(row.querySelector("[data-menu-label]")?.textContent).toBe("Chart JSON");
    const kbd = row.querySelector("kbd") as HTMLElement;
    expect(kbd.textContent).toBe("Ctrl+J");
    expect(getComputedStyle(kbd).fontSize).toBe("11px");
    expect(getComputedStyle(kbd).fontFamily).toContain("Cascadia Code");
    expect(row.textContent).toBe("Chart JSONtask paneCtrl+J");
  });

  it("passes HTML props through and chains onClick", () => {
    const onClick = vi.fn();
    const onSelect = vi.fn();
    render(
      <Menu ariaLabel="Actions">
        <MenuItem testId="row" title="Edit the chart" onClick={onClick} onSelect={onSelect}>
          Edit
        </MenuItem>
      </Menu>,
    );
    const row = byTestId("row");
    expect(row.getAttribute("title")).toBe("Edit the chart");
    click(row);
    expect(onClick).toHaveBeenCalledTimes(1);
    expect(onSelect).toHaveBeenCalledTimes(1);
  });

  it("disabled uses the one disabled idiom", () => {
    render(
      <Menu ariaLabel="Actions">
        <MenuItem testId="row" disabled onSelect={() => undefined}>
          Edit
        </MenuItem>
      </Menu>,
    );
    const row = byTestId<HTMLButtonElement>("row");
    expect(row.disabled).toBe(true);
    expect(getComputedStyle(row).opacity).toBe("0.5");
  });
});

// ============================================================================
// Standalone Menu, separator, heading
// ============================================================================

describe("Menu standalone", () => {
  it("is a role=menu list whose items are ordinary tab stops", () => {
    render(
      <Menu ariaLabel="Actions" data-testid="menu">
        <MenuItem testId="a" onSelect={() => undefined}>Edit</MenuItem>
        <MenuItem testId="b" onSelect={() => undefined}>Save</MenuItem>
      </Menu>,
    );
    expect(byTestId("menu").getAttribute("role")).toBe("menu");
    expect(byTestId("menu").getAttribute("aria-label")).toBe("Actions");
    expect(byTestId<HTMLButtonElement>("a").tabIndex).toBe(0);
    expect(byTestId<HTMLButtonElement>("b").tabIndex).toBe(0);
  });

  it("the arrows still move focus; Escape is left to the enclosing overlay", () => {
    render(
      <Menu ariaLabel="Actions">
        <MenuItem testId="a" onSelect={() => undefined}>Edit</MenuItem>
        <MenuItem testId="b" onSelect={() => undefined}>Save</MenuItem>
      </Menu>,
    );
    act(() => byTestId("a").focus());
    key(byTestId("a"), "ArrowDown");
    expect(document.activeElement).toBe(byTestId("b"));
    expect(key(byTestId("b"), "Escape").defaultPrevented).toBe(false);
  });

  it("does not take focus on mount and runs items without closing anything", () => {
    const onSelect = vi.fn();
    render(
      <>
        <input data-testid="field" />
        <Menu ariaLabel="Actions">
          <MenuItem testId="a" onSelect={onSelect}>Edit</MenuItem>
        </Menu>
      </>,
    );
    expect(document.activeElement).toBe(document.body);
    click(byTestId("a"));
    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(byTestId("a")).not.toBeNull();
  });

  it("MenuSeparator is a 1px divider-coloured separator", () => {
    render(
      <Menu ariaLabel="Actions">
        <MenuItem onSelect={() => undefined}>Edit</MenuItem>
        <MenuSeparator />
        <MenuItem onSelect={() => undefined}>Save</MenuItem>
      </Menu>,
    );
    const sep = document.querySelector("[role='separator']") as HTMLElement;
    expect(sep).not.toBeNull();
    expect(getComputedStyle(sep).height).toBe("1px");
    expect(getComputedStyle(sep).margin).toBe("5px 6px");
    expect(declared(sep, "background")).toContain("--control-divider");
  });

  it("MenuHeading is a small uppercase secondary caption", () => {
    render(
      <Menu ariaLabel="Filter">
        <MenuHeading>Series</MenuHeading>
        <MenuItem onSelect={() => undefined}>Revenue</MenuItem>
      </Menu>,
    );
    const heading = document.querySelector("[role='presentation']") as HTMLElement;
    expect(heading.textContent).toBe("Series");
    const cs = getComputedStyle(heading);
    expect(cs.fontSize).toBe("10px");
    expect(cs.fontWeight).toBe("600");
    expect(cs.textTransform).toBe("uppercase");
    expect(cs.letterSpacing).toBe("0.4px");
    expect(cs.padding).toBe("6px 8px 4px");
    expect(declared(heading, "color")).toContain("--text-secondary");
  });
});

// ============================================================================
// Colours
// ============================================================================

describe("Menu colours", () => {
  it.each([
    ["band", bandLayout()],
    ["panel", panelLayout(300)],
  ])("paints no hardcoded colour in the %s (trigger and open popup)", (_name, layout) => {
    render(
      <MenuButton trigger={<Button data-testid="trigger">Trendline</Button>}>
        <MenuHeading>Type</MenuHeading>
        <MenuItem role="menuitemradio" checked icon={<Icon />} onSelect={() => undefined}>
          Linear
        </MenuItem>
        <MenuItem role="menuitemradio" disabled onSelect={() => undefined} hint="soon">
          Polynomial
        </MenuItem>
        <MenuSeparator />
        <MenuItem role="menuitemcheckbox" shortcut="Ctrl+E" onSelect={() => undefined}>
          Show equation
        </MenuItem>
      </MenuButton>,
      layout,
    );
    click(byTestId("trigger"));
    expect(menu()).not.toBeNull();
    expect(hardcodedColours(document.body)).toEqual([]);
  });
});
