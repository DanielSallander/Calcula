// Tests for MenuSub (CONTRACT 6.3): a menu row that opens a nested card
// flyout to its right -- Excel's "Hide & Unhide >", "Line Style >",
// Conditional Formatting's "Highlight Cells Rules >" and its gallery flyouts.
//
// The keyboard model is WAI-ARIA's submenu pattern and is pinned key by key:
// Enter / Space / ArrowRight open the flyout ON its first row; Escape and
// ArrowLeft close ONLY that level and put focus back on the row that opened
// it; choosing an item closes the WHOLE chain and returns focus to the
// control that opened the top menu (after which the item runs). The mouse
// model is Windows': hovering a row opens its flyout after
// SUBMENU_HOVER_DELAY_MS, hovering a DIFFERENT row closes it after the same
// delay, and a pointer that reaches the open flyout before then keeps it.
// The parent menu owns which flyout is open, so there is never more than one
// per level -- the parent stops presses at its own portal (Menu.tsx NESTING),
// so the flyout's own outside-press listener cannot be what closes it.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import {
  SurfaceLayoutProvider,
  bandLayout,
  panelLayout,
  useSurfaceLayout,
  type SurfaceLayout,
} from "../context";
import { Button } from "../primitives/Button";
import {
  MENU_ICON_BLANK,
  Menu,
  MenuButton,
  MenuHeading,
  MenuItem,
  MenuSeparator,
  MenuSub,
  SplitMenuButton,
  useMenuClose,
} from "../primitives/Menu";
import {
  POPOVER_CARD_BORDER,
  POPOVER_CARD_PADDING,
  SUBMENU_ALIGN_OFFSET,
  SUBMENU_HOVER_DELAY_MS,
} from "../tokens";
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
  vi.useRealTimers();
  document.body.innerHTML = "";
});

function render(node: React.ReactNode, layout: SurfaceLayout = panelLayout(300)): void {
  act(() => {
    root.render(<SurfaceLayoutProvider value={layout}>{node}</SurfaceLayoutProvider>);
  });
}

/** A keyboard (or assistive-technology) activation: a click with detail 0. */
function click(el: Element): void {
  act(() => {
    el.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
}

/** A real pointer click: detail 1. */
function pointerClick(el: Element): void {
  act(() => {
    el.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, detail: 1 }));
    el.dispatchEvent(new MouseEvent("click", { bubbles: true, detail: 1 }));
  });
}

function mouseDown(el: Element): void {
  act(() => {
    el.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
  });
}

function mouseMove(el: Element): void {
  act(() => {
    el.dispatchEvent(new MouseEvent("mousemove", { bubbles: true }));
  });
}

function key(el: Element, k: string): KeyboardEvent {
  const event = new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true });
  act(() => {
    el.dispatchEvent(event);
  });
  return event;
}

function wait(ms: number): void {
  act(() => {
    vi.advanceTimersByTime(ms);
  });
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

const Icon = () => (
  <svg width={16} height={16} viewBox="0 0 24 24" aria-hidden>
    <rect x="3" y="3" width="18" height="18" rx="2" fill="currentColor" />
  </svg>
);

/** Excel's Format menu, cut down: two submenus, a nested one, a gallery. */
function FormatMenu({
  onRun = () => undefined,
  disabledSub = false,
}: {
  onRun?: (id: string) => void;
  disabledSub?: boolean;
}): React.ReactElement {
  return (
    <>
      <MenuButton trigger={<Button data-testid="trigger">Format</Button>} ariaLabel="Format">
        <MenuHeading>Cell Size</MenuHeading>
        <MenuItem testId="rowHeight" icon={<Icon />} onSelect={() => onRun("rowHeight")}>
          Row Height...
        </MenuItem>
        <MenuItem testId="autofit" icon={MENU_ICON_BLANK} onSelect={() => onRun("autofit")}>
          AutoFit Row Height
        </MenuItem>
        <MenuSeparator />
        <MenuSub label="Hide & Unhide" icon={MENU_ICON_BLANK} testId="hide" disabled={disabledSub}>
          <MenuItem testId="hideRows" onSelect={() => onRun("hideRows")}>
            Hide Rows
          </MenuItem>
          <MenuItem testId="hideCols" onSelect={() => onRun("hideCols")}>
            Hide Columns
          </MenuItem>
          <MenuSeparator />
          <MenuSub label="More" testId="more">
            <MenuItem testId="deep" onSelect={() => onRun("deep")}>
              Deep Item
            </MenuItem>
          </MenuSub>
        </MenuSub>
        <MenuSub label="Tab Color" testId="tabColor" width={180}>
          <Swatches onRun={onRun} />
        </MenuSub>
        <MenuItem testId="protect" onSelect={() => onRun("protect")}>
          Protect Sheet...
        </MenuItem>
      </MenuButton>
      <input data-testid="elsewhere" />
    </>
  );
}

/** Custom flyout content (a gallery stand-in) that closes the chain itself. */
function Swatches({ onRun }: { onRun: (id: string) => void }): React.ReactElement {
  const close = useMenuClose();
  return (
    <div data-testid="swatches">
      <button
        type="button"
        data-testid="red"
        onClick={() => {
          close();
          onRun("red");
        }}
      >
        Red
      </button>
      <button type="button" data-testid="blue">
        Blue
      </button>
    </div>
  );
}

function openRoot(): void {
  click(byTestId("trigger"));
}

// ============================================================================
// The row
// ============================================================================

describe("MenuSub row", () => {
  it("is a menuitem that announces its flyout and draws a right chevron", () => {
    render(<FormatMenu />);
    openRoot();
    const row = byTestId<HTMLButtonElement>("hide");
    expect(row.tagName).toBe("BUTTON");
    expect(row.type).toBe("button");
    expect(row.getAttribute("role")).toBe("menuitem");
    expect(row.getAttribute("aria-haspopup")).toBe("menu");
    expect(row.getAttribute("aria-expanded")).toBe("false");
    expect(row.hasAttribute("aria-controls")).toBe(false);
    expect(row.tabIndex).toBe(-1);
    expect(row.querySelector("[data-menu-label]")?.textContent).toBe("Hide & Unhide");
    // The trailing chevron is the grammar's chevron turned to point right.
    const chevron = row.querySelector("[data-submenu-chevron]") as HTMLElement;
    expect(chevron).not.toBeNull();
    expect(chevron.getAttribute("aria-hidden")).toBe("true");
    expect(chevron.querySelector("svg")).not.toBeNull();
    expect(declared(chevron, "transform")).toContain("rotate(-90deg)");
    // The row recipe: 30px, the 16px check column first.
    expect(getComputedStyle(row).height).toBe("30px");
    expect(getComputedStyle(row.firstElementChild as HTMLElement).width).toBe("16px");
  });

  it("MENU_ICON_BLANK reserves the icon column without drawing, so labels line up", () => {
    render(<FormatMenu />);
    openRoot();
    for (const id of ["rowHeight", "autofit", "hide"]) {
      const row = byTestId(id);
      const iconCol = row.children[1] as HTMLElement;
      expect(iconCol.getAttribute("aria-hidden")).toBe("true");
      expect(getComputedStyle(iconCol).width).toBe("20px");
      expect(iconCol.nextElementSibling?.hasAttribute("data-menu-label")).toBe(true);
    }
    expect(byTestId("rowHeight").children[1].querySelector("svg")).not.toBeNull();
    expect(byTestId("autofit").children[1].querySelector("svg")).toBeNull();
    expect(byTestId("autofit").children[1].textContent).toBe("");
    // A row with NO icon has no icon column at all (unchanged behaviour).
    expect(byTestId("protect").children[1].hasAttribute("data-menu-label")).toBe(true);
  });

  it("announces WHAT it opens: a menu of items says 'menu', custom content says 'dialog'", () => {
    // A palette or gallery flyout is a labelled role=group, not a role=menu:
    // announcing "menu" would promise menu-item arrows it does not have. ARIA
    // has no "group" popup type; "dialog" is the generic one, and it is what
    // the kit's other palette trigger (ColorSwatch's chevron) already says.
    render(<FormatMenu />);
    openRoot();
    expect(byTestId("hide").getAttribute("aria-haspopup")).toBe("menu");
    expect(byTestId("tabColor").getAttribute("aria-haspopup")).toBe("dialog");
    // And it stays true while open, with the flyout that proves it.
    key(byTestId("tabColor"), "ArrowRight");
    expect(byTestId("tabColor").getAttribute("aria-haspopup")).toBe("dialog");
    expect(document.getElementById(byTestId("tabColor").getAttribute("aria-controls")!)?.getAttribute("role")).toBe(
      "group",
    );
    key(byTestId("red"), "Escape");
    key(byTestId("hide"), "ArrowRight");
    expect(byTestId("hide").getAttribute("aria-haspopup")).toBe("menu");
    expect(document.getElementById(byTestId("hide").getAttribute("aria-controls")!)?.getAttribute("role")).toBe(
      "menu",
    );
  });

  it("the flyout's first row lines up with its parent row (Excel): lifted by the card's border + padding", () => {
    // jsdom lays out nothing, so the row reports where it would be; the
    // flyout card is placed from that rect. Its first row sits
    // POPOVER_CARD_BORDER + POPOVER_CARD_PADDING below the card's top edge,
    // so the card's top must be exactly that much above the row's.
    render(<FormatMenu />);
    openRoot();
    const row = byTestId("hide");
    row.getBoundingClientRect = () =>
      ({ left: 100, top: 300, right: 340, bottom: 330, width: 240, height: 30, x: 100, y: 300 }) as DOMRect;
    key(row, "ArrowRight");
    const card = menus()[1].closest("[data-section-flyout]") as HTMLElement;
    expect(POPOVER_CARD_BORDER + POPOVER_CARD_PADDING).toBe(9);
    expect(SUBMENU_ALIGN_OFFSET).toBe(-(POPOVER_CARD_BORDER + POPOVER_CARD_PADDING));
    expect(card.style.top).toBe(`${300 + SUBMENU_ALIGN_OFFSET}px`);
    // And the card's chrome is what the offset assumes (same constants; the
    // border shorthand is read from the rule, which jsdom drops with var()).
    expect(getComputedStyle(card).paddingTop).toBe(`${POPOVER_CARD_PADDING}px`);
    expect(declared(card, "border")).toMatch(new RegExp(`^${POPOVER_CARD_BORDER}px solid `));
    // The menu inside adds no offset of its own: its first row is its first box.
    expect(getComputedStyle(menus()[1]).paddingTop || "0px").toBe("0px");
  });

  it("an expanded row keeps the hover wash while focus is in its flyout", () => {
    render(<FormatMenu />);
    openRoot();
    key(byTestId("hide"), "ArrowRight");
    expect(byTestId("hide").getAttribute("aria-expanded")).toBe("true");
    expect(declared(byTestId("hide"), "background")).toContain("--button-hover-bg");
  });
});

// ============================================================================
// Keyboard
// ============================================================================

describe("MenuSub keyboard", () => {
  it.each(["ArrowRight", "Enter", " "])("%s opens the flyout ON its first row", (k) => {
    render(<FormatMenu />);
    openRoot();
    const row = byTestId("hide");
    const event = key(row, k);
    expect(event.defaultPrevented).toBe(true);
    expect(menus()).toHaveLength(2);
    expect(row.getAttribute("aria-expanded")).toBe("true");
    const flyout = menus()[1];
    expect(row.getAttribute("aria-controls")).toBe(flyout.id);
    expect(flyout.getAttribute("aria-labelledby")).toBe(row.id);
    expect(document.activeElement).toBe(byTestId("hideRows"));
    // A card popover to the right of the row.
    const card = flyout.closest("[data-section-flyout]") as HTMLElement;
    expect(getComputedStyle(card).borderRadius).toContain("--radius-popover");
  });

  it("Escape closes ONLY the flyout and refocuses its row; the menu stays open", () => {
    render(<FormatMenu />);
    openRoot();
    key(byTestId("hide"), "ArrowRight");
    const event = key(byTestId("hideRows"), "Escape");
    expect(event.defaultPrevented).toBe(true);
    expect(menus()).toHaveLength(1);
    expect(document.activeElement).toBe(byTestId("hide"));
    expect(byTestId("hide").getAttribute("aria-expanded")).toBe("false");
    expect(byTestId("trigger").getAttribute("aria-expanded")).toBe("true");
  });

  it("ArrowLeft closes only the flyout too; ArrowLeft in the TOP menu does nothing", () => {
    render(<FormatMenu />);
    openRoot();
    key(byTestId("hide"), "ArrowRight");
    key(byTestId("hideCols"), "ArrowLeft");
    expect(menus()).toHaveLength(1);
    expect(document.activeElement).toBe(byTestId("hide"));
    key(byTestId("hide"), "ArrowLeft");
    expect(menus()).toHaveLength(1);
    expect(document.activeElement).toBe(byTestId("hide"));
  });

  it("the flyout has the full menu keyboard: arrows wrap, typeahead", () => {
    render(<FormatMenu />);
    openRoot();
    key(byTestId("hide"), "ArrowRight");
    key(byTestId("hideRows"), "ArrowDown");
    expect(document.activeElement).toBe(byTestId("hideCols"));
    key(byTestId("hideCols"), "ArrowDown");
    expect(document.activeElement).toBe(byTestId("more"));
    key(byTestId("more"), "ArrowDown");
    expect(document.activeElement).toBe(byTestId("hideRows"));
    key(byTestId("hideRows"), "m");
    expect(document.activeElement).toBe(byTestId("more"));
    // The keys stayed in the flyout: the top menu's focus did not move.
    expect(menus()).toHaveLength(2);
  });

  it("choosing an item closes the WHOLE chain, returns focus to the trigger, THEN runs", () => {
    let focusedAtRun: Element | null = null;
    const onRun = vi.fn(() => {
      focusedAtRun = document.activeElement;
    });
    render(<FormatMenu onRun={onRun} />);
    openRoot();
    key(byTestId("hide"), "ArrowRight");
    key(byTestId("hideRows"), "ArrowDown");
    key(byTestId("hideCols"), "Enter");
    expect(onRun).toHaveBeenCalledTimes(1);
    expect(onRun).toHaveBeenCalledWith("hideCols");
    expect(menus()).toHaveLength(0);
    expect(focusedAtRun).toBe(byTestId("trigger"));
    expect(document.activeElement).toBe(byTestId("trigger"));
  });

  it("nested: Escape in the third level closes only that level", () => {
    const onRun = vi.fn();
    render(<FormatMenu onRun={onRun} />);
    openRoot();
    key(byTestId("hide"), "ArrowRight");
    key(byTestId("hideRows"), "End");
    expect(document.activeElement).toBe(byTestId("more"));
    key(byTestId("more"), "ArrowRight");
    expect(menus()).toHaveLength(3);
    expect(document.activeElement).toBe(byTestId("deep"));
    key(byTestId("deep"), "Escape");
    expect(menus()).toHaveLength(2);
    expect(document.activeElement).toBe(byTestId("more"));
    // And a pick from the third level still closes everything.
    key(byTestId("more"), "ArrowRight");
    key(byTestId("deep"), "Enter");
    expect(onRun).toHaveBeenCalledWith("deep");
    expect(menus()).toHaveLength(0);
    expect(document.activeElement).toBe(byTestId("trigger"));
  });

  it("moving focus to another row closes the open flyout", () => {
    vi.useFakeTimers();
    render(<FormatMenu />);
    openRoot();
    // Opened by the pointer (focus stays on the row) ...
    mouseMove(byTestId("hide"));
    wait(SUBMENU_HOVER_DELAY_MS);
    expect(menus()).toHaveLength(2);
    expect(document.activeElement).toBe(byTestId("hide"));
    // ... then the keyboard moves on.
    key(byTestId("hide"), "ArrowDown");
    expect(document.activeElement).toBe(byTestId("tabColor"));
    expect(menus()).toHaveLength(1);
  });

  it("Escape with a flyout the POINTER opened closes only that flyout; focus stays on the row", () => {
    // Windows / Office menus: Escape closes the innermost open popup. A
    // flyout the pointer opened leaves keyboard focus on the hovered row, so
    // the key lands on the PARENT level -- which must close its open flyout,
    // not the whole menu around it. A second Escape then closes the menu.
    vi.useFakeTimers();
    render(<FormatMenu />);
    openRoot();
    mouseMove(byTestId("hide"));
    wait(SUBMENU_HOVER_DELAY_MS);
    expect(menus()).toHaveLength(2);
    expect(document.activeElement).toBe(byTestId("hide"));
    const event = key(byTestId("hide"), "Escape");
    expect(event.defaultPrevented).toBe(true);
    expect(menus()).toHaveLength(1);
    expect(byTestId("hide").getAttribute("aria-expanded")).toBe("false");
    expect(byTestId("trigger").getAttribute("aria-expanded")).toBe("true");
    expect(document.activeElement).toBe(byTestId("hide"));
    key(byTestId("hide"), "Escape");
    expect(menus()).toHaveLength(0);
    expect(document.activeElement).toBe(byTestId("trigger"));
  });

  it("the same one level at depth: a pointer-opened third level goes, the second stays", () => {
    vi.useFakeTimers();
    render(<FormatMenu />);
    openRoot();
    key(byTestId("hide"), "ArrowRight");
    mouseMove(byTestId("more"));
    wait(SUBMENU_HOVER_DELAY_MS);
    expect(menus()).toHaveLength(3);
    expect(document.activeElement).toBe(byTestId("more"));
    key(byTestId("more"), "Escape");
    expect(menus()).toHaveLength(2);
    expect(document.activeElement).toBe(byTestId("more"));
  });

  it("ArrowRight on a row whose flyout the pointer opened steps INTO it", () => {
    vi.useFakeTimers();
    render(<FormatMenu />);
    openRoot();
    mouseMove(byTestId("hide"));
    wait(SUBMENU_HOVER_DELAY_MS);
    expect(document.activeElement).toBe(byTestId("hide"));
    key(byTestId("hide"), "ArrowRight");
    expect(menus()).toHaveLength(2);
    expect(document.activeElement).toBe(byTestId("hideRows"));
  });

  it("Tab closes the whole chain and lets focus move on from the trigger", () => {
    render(<FormatMenu />);
    openRoot();
    key(byTestId("hide"), "ArrowRight");
    const tab = key(byTestId("hideRows"), "Tab");
    expect(tab.defaultPrevented).toBe(false);
    expect(menus()).toHaveLength(0);
    expect(document.activeElement).toBe(byTestId("trigger"));
  });

  it("typeahead in the top menu lands on a submenu row too", () => {
    render(<FormatMenu />);
    openRoot();
    key(byTestId("rowHeight"), "h");
    expect(document.activeElement).toBe(byTestId("hide"));
  });
});

// ============================================================================
// Mouse
// ============================================================================

describe("MenuSub pointer", () => {
  it("a pointer click opens the flyout WITHOUT moving focus into it", () => {
    render(<FormatMenu />);
    openRoot();
    pointerClick(byTestId("hide"));
    expect(menus()).toHaveLength(2);
    expect(byTestId("hide").getAttribute("aria-expanded")).toBe("true");
    expect(menus()[1].contains(document.activeElement)).toBe(false);
    // A second click keeps it open (Windows), it does not toggle.
    pointerClick(byTestId("hide"));
    expect(menus()).toHaveLength(2);
  });

  it(`hovering a row opens its flyout after ${SUBMENU_HOVER_DELAY_MS}ms, not before`, () => {
    vi.useFakeTimers();
    render(<FormatMenu />);
    openRoot();
    mouseMove(byTestId("hide"));
    wait(SUBMENU_HOVER_DELAY_MS - 1);
    expect(menus()).toHaveLength(1);
    wait(1);
    expect(menus()).toHaveLength(2);
    // The pointer moves focus to the hovered row; it does not go into the flyout.
    expect(document.activeElement).toBe(byTestId("hide"));
  });

  it("leaving the row before the delay cancels the open", () => {
    vi.useFakeTimers();
    render(<FormatMenu />);
    openRoot();
    mouseMove(byTestId("hide"));
    wait(100);
    mouseMove(byTestId("protect"));
    wait(SUBMENU_HOVER_DELAY_MS * 2);
    expect(menus()).toHaveLength(1);
  });

  it("hovering ANOTHER row closes the open flyout after the delay", () => {
    vi.useFakeTimers();
    render(<FormatMenu />);
    openRoot();
    mouseMove(byTestId("hide"));
    wait(SUBMENU_HOVER_DELAY_MS);
    expect(menus()).toHaveLength(2);
    mouseMove(byTestId("protect"));
    wait(SUBMENU_HOVER_DELAY_MS - 1);
    expect(menus()).toHaveLength(2);
    wait(1);
    expect(menus()).toHaveLength(1);
  });

  it("reaching the flyout before the delay KEEPS it (a diagonal path across a sibling row)", () => {
    vi.useFakeTimers();
    render(<FormatMenu />);
    openRoot();
    mouseMove(byTestId("hide"));
    wait(SUBMENU_HOVER_DELAY_MS);
    mouseMove(byTestId("tabColor"));
    wait(100);
    mouseMove(byTestId("hideCols"));
    wait(SUBMENU_HOVER_DELAY_MS * 3);
    expect(menus()).toHaveLength(2);
    expect(document.activeElement).toBe(byTestId("hideCols"));
  });

  it("hovering a different submenu row swaps the flyouts -- never two at one level", () => {
    vi.useFakeTimers();
    render(<FormatMenu />);
    openRoot();
    mouseMove(byTestId("hide"));
    wait(SUBMENU_HOVER_DELAY_MS);
    expect(maybe("hideRows")).not.toBeNull();
    mouseMove(byTestId("tabColor"));
    wait(SUBMENU_HOVER_DELAY_MS);
    expect(maybe("hideRows")).toBeNull();
    expect(maybe("swatches")).not.toBeNull();
    expect(byTestId("hide").getAttribute("aria-expanded")).toBe("false");
    expect(byTestId("tabColor").getAttribute("aria-expanded")).toBe("true");
  });

  it("a pointer click on a sibling submenu row switches at once", () => {
    render(<FormatMenu />);
    openRoot();
    pointerClick(byTestId("hide"));
    pointerClick(byTestId("tabColor"));
    expect(maybe("hideRows")).toBeNull();
    expect(maybe("swatches")).not.toBeNull();
  });

  it("a pointer click on an item in the flyout runs it and closes everything", () => {
    const onRun = vi.fn();
    render(<FormatMenu onRun={onRun} />);
    openRoot();
    pointerClick(byTestId("hide"));
    mouseDown(byTestId("hideRows"));
    // The press inside the flyout dismissed nothing.
    expect(menus()).toHaveLength(2);
    pointerClick(byTestId("hideRows"));
    expect(onRun).toHaveBeenCalledWith("hideRows");
    expect(menus()).toHaveLength(0);
  });

  it("a press outside everything closes the whole chain", () => {
    render(<FormatMenu />);
    openRoot();
    pointerClick(byTestId("hide"));
    mouseDown(byTestId("elsewhere"));
    expect(menus()).toHaveLength(0);
  });
});

// ============================================================================
// Disabled
// ============================================================================

describe("MenuSub disabled", () => {
  it("is natively disabled, faded, skipped by the arrows, and opens by no route", () => {
    vi.useFakeTimers();
    render(<FormatMenu disabledSub />);
    openRoot();
    const row = byTestId<HTMLButtonElement>("hide");
    expect(row.disabled).toBe(true);
    pointerClick(row);
    key(row, "ArrowRight");
    key(row, "Enter");
    mouseMove(row);
    wait(SUBMENU_HOVER_DELAY_MS * 2);
    expect(menus()).toHaveLength(1);
    expect(row.getAttribute("aria-expanded")).toBe("false");
    key(byTestId("autofit"), "ArrowDown");
    expect(document.activeElement).toBe(byTestId("tabColor"));
  });
});

// ============================================================================
// Custom content (a gallery, a palette)
// ============================================================================

describe("MenuSub with custom content", () => {
  it("is a card flyout holding a role=group, not a role=menu", () => {
    render(<FormatMenu />);
    openRoot();
    key(byTestId("tabColor"), "ArrowRight");
    expect(menus()).toHaveLength(1);
    const swatches = byTestId("swatches");
    const group = swatches.parentElement as HTMLElement;
    expect(group.getAttribute("role")).toBe("group");
    expect(group.getAttribute("aria-labelledby")).toBe(byTestId("tabColor").id);
    expect(byTestId("tabColor").getAttribute("aria-controls")).toBe(group.id);
    const card = group.closest("[data-section-flyout]") as HTMLElement;
    expect(card.style.width).toBe("180px");
    expect(getComputedStyle(card).borderRadius).toContain("--radius-popover");
    // Opened from the keyboard: focus went to its first focusable.
    expect(document.activeElement).toBe(byTestId("red"));
  });

  it("Escape inside it closes only that level", () => {
    render(<FormatMenu />);
    openRoot();
    key(byTestId("tabColor"), "ArrowRight");
    const event = key(byTestId("blue"), "Escape");
    expect(event.defaultPrevented).toBe(true);
    expect(maybe("swatches")).toBeNull();
    expect(menus()).toHaveLength(1);
    expect(document.activeElement).toBe(byTestId("tabColor"));
  });

  it("the arrows are the content's own (a gallery walks its grid with them)", () => {
    render(<FormatMenu />);
    openRoot();
    key(byTestId("tabColor"), "ArrowRight");
    const left = key(byTestId("red"), "ArrowLeft");
    expect(left.defaultPrevented).toBe(false);
    expect(maybe("swatches")).not.toBeNull();
  });

  it("a key inside custom content two levels down belongs to that content, not to the level around it", () => {
    // React delivers the flyout's keydown to every ancestor Menu through the
    // component tree. The "Hide & Unhide" level answers ArrowLeft by closing
    // ITSELF -- it must not do that for a key pressed inside its child's
    // gallery, which walks its own grid with the arrows.
    render(
      <MenuButton trigger={<Button data-testid="trigger">Format</Button>}>
        <MenuSub label="Hide & Unhide" testId="hide">
          <MenuItem testId="hideRows" onSelect={() => undefined}>
            Hide Rows
          </MenuItem>
          <MenuSub label="Colors" testId="colors">
            <Swatches onRun={() => undefined} />
          </MenuSub>
        </MenuSub>
      </MenuButton>,
    );
    openRoot();
    key(byTestId("hide"), "ArrowRight");
    key(byTestId("hideRows"), "ArrowDown");
    key(byTestId("colors"), "ArrowRight");
    expect(document.activeElement).toBe(byTestId("red"));
    for (const k of ["ArrowLeft", "ArrowDown", "Home", "h"]) {
      key(byTestId("red"), k);
      expect(menus()).toHaveLength(2);
      expect(maybe("swatches")).not.toBeNull();
      expect(document.activeElement).toBe(byTestId("red"));
    }
  });

  it("useMenuClose() closes the whole chain and returns focus to the trigger", () => {
    const onRun = vi.fn();
    render(<FormatMenu onRun={onRun} />);
    openRoot();
    key(byTestId("tabColor"), "ArrowRight");
    mouseDown(byTestId("red"));
    expect(menus()).toHaveLength(1);
    click(byTestId("red"));
    expect(onRun).toHaveBeenCalledWith("red");
    expect(maybe("swatches")).toBeNull();
    expect(menus()).toHaveLength(0);
    expect(document.activeElement).toBe(byTestId("trigger"));
  });

  it("content is laid out as a popover surface, never as the band it was opened from", () => {
    // A gallery (StyleGallery, the table-style gallery) reads the surface to
    // decide between its ribbon strip and its grid: inside a flyout opened
    // from the band it must see "popover", or it draws a 61px strip in a menu.
    function Probe(): React.ReactElement {
      return <div data-testid="probe">{useSurfaceLayout().container}</div>;
    }
    render(
      <MenuButton trigger={<Button data-testid="trigger">Styles</Button>}>
        <MenuSub label="Data Bars" testId="bars">
          <Probe />
        </MenuSub>
      </MenuButton>,
      bandLayout(),
    );
    openRoot();
    key(byTestId("bars"), "ArrowRight");
    expect(byTestId("probe").textContent).toBe("popover");
  });
});

// ============================================================================
// Other hosts
// ============================================================================

describe("MenuSub in other hosts", () => {
  it("inside a SplitMenuButton: a pick returns focus to the half that opened the menu", () => {
    let focusedAtRun: Element | null = null;
    render(
      <SplitMenuButton
        icon={<Icon />}
        label="Borders"
        data-testid="main"
        chevronTestId="chevron"
        onClick={() => undefined}
      >
        <MenuItem testId="bottom" onSelect={() => undefined}>
          Bottom Border
        </MenuItem>
        <MenuSub label="Line Style" testId="lineStyle" icon={MENU_ICON_BLANK}>
          <MenuItem
            testId="thick"
            role="menuitemradio"
            checked={false}
            onSelect={() => {
              focusedAtRun = document.activeElement;
            }}
          >
            Thick
          </MenuItem>
        </MenuSub>
      </SplitMenuButton>,
    );
    click(byTestId("chevron"));
    key(byTestId("bottom"), "ArrowDown");
    key(byTestId("lineStyle"), "ArrowRight");
    expect(document.activeElement).toBe(byTestId("thick"));
    key(byTestId("thick"), "Enter");
    expect(menus()).toHaveLength(0);
    expect(focusedAtRun).toBe(byTestId("chevron"));
  });

  it("inside a standalone Menu: a pick closes the flyout and refocuses its row", () => {
    const onPick = vi.fn();
    render(
      <Menu ariaLabel="Actions">
        <MenuItem testId="a" onSelect={() => undefined}>
          Edit
        </MenuItem>
        <MenuSub label="More" testId="more">
          <MenuItem testId="deep" onSelect={onPick}>
            Deep
          </MenuItem>
        </MenuSub>
      </Menu>,
    );
    const row = byTestId<HTMLButtonElement>("more");
    // Standalone rows are ordinary tab stops.
    expect(row.tabIndex).toBe(0);
    key(row, "ArrowRight");
    expect(document.activeElement).toBe(byTestId("deep"));
    key(byTestId("deep"), "Enter");
    expect(onPick).toHaveBeenCalledTimes(1);
    expect(maybe("deep")).toBeNull();
    expect(document.activeElement).toBe(row);
    // The standalone list itself is still there.
    expect(menus()).toHaveLength(1);
  });

  it("useMenuClose() outside any menu is a harmless no-op", () => {
    function Lonely(): React.ReactElement {
      const close = useMenuClose();
      return (
        <button type="button" data-testid="lonely" onClick={close}>
          x
        </button>
      );
    }
    render(<Lonely />);
    expect(() => click(byTestId("lonely"))).not.toThrow();
  });
});

describe("MenuSub colours", () => {
  it.each([
    ["band", bandLayout()],
    ["panel", panelLayout(300)],
  ])("paints no hardcoded colour in the %s with every level open", (_name, layout) => {
    render(<FormatMenu />, layout);
    openRoot();
    key(byTestId("hide"), "ArrowRight");
    key(byTestId("hideRows"), "End");
    key(byTestId("more"), "ArrowRight");
    expect(menus()).toHaveLength(3);
    expect(hardcodedColours(document.body)).toEqual([]);
  });
});
