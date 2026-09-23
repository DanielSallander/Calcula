// Tests for the Dropdown value picker: the combobox trigger (geometry per
// surface, value/placeholder/renderValue), the listbox popup (options, the
// selected option focused on open), the listbox keyboard model (arrows that
// stop at the ends, Home/End, Enter/Space, Escape, Tab, typeahead), the
// no-op re-selection rule, and nesting inside another overlay. Rendered under
// band AND panel geometry and scanned for hardcoded colours.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import React, { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { SurfaceLayoutProvider, bandLayout, panelLayout, type SurfaceLayout } from "../context";
import { Popover } from "../primitives/Popover";
import { Dropdown, type DropdownOption, type DropdownProps } from "../primitives/Dropdown";
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

function listbox(): HTMLElement | null {
  return document.querySelector("[role='listbox']");
}

function options(): HTMLElement[] {
  return Array.from(document.querySelectorAll<HTMLElement>("[role='option']"));
}

type Position = "top" | "bottom" | "left" | "right" | "none";

const POSITIONS: DropdownOption<Position>[] = [
  { value: "top", label: "Top" },
  { value: "bottom", label: "Bottom", hint: "default" },
  { value: "left", label: "Left", disabled: true },
  { value: "right", label: "Right" },
  { value: "none", label: "None" },
];

/** Controlled harness, the way real callers hold the value. */
function Legend({
  initial = "bottom" as Position,
  onChange,
  ...rest
}: Partial<DropdownProps<Position>> & { initial?: Position }): React.ReactElement {
  const [value, setValue] = useState<Position>(initial);
  return (
    <>
      <Dropdown<Position>
        ariaLabel="Legend position"
        testId="dd"
        optionTestIdPrefix="pos-"
        options={POSITIONS}
        {...rest}
        value={value}
        onChange={(v) => {
          setValue(v);
          onChange?.(v);
        }}
      />
      <input data-testid="elsewhere" />
    </>
  );
}

// ============================================================================
// Trigger
// ============================================================================

describe("Dropdown trigger", () => {
  it("is a named combobox button that announces a listbox", () => {
    render(<Legend />);
    const t = byTestId<HTMLButtonElement>("dd");
    expect(t.tagName).toBe("BUTTON");
    expect(t.type).toBe("button");
    expect(t.getAttribute("role")).toBe("combobox");
    expect(t.getAttribute("aria-haspopup")).toBe("listbox");
    expect(t.getAttribute("aria-expanded")).toBe("false");
    expect(t.getAttribute("aria-label")).toBe("Legend position");
    expect(t.textContent).toBe("Bottom");
    expect(listbox()).toBeNull();
  });

  it("is a 28px field: padding 0 8 0 10, control border, input background, 12px", () => {
    render(<Legend />);
    const t = byTestId("dd");
    const cs = getComputedStyle(t);
    expect(cs.height).toBe("28px");
    expect(cs.padding).toBe("0px 8px 0px 10px");
    expect(cs.fontSize).toBe("12px");
    expect(declared(t, "border")).toContain("--control-border");
    expect(declared(t, "border-radius")).toContain("--radius-control");
    expect(declared(t, "background")).toContain("--input-bg");
    expect(t.querySelector("svg")?.getAttribute("width")).toBe("9");
  });

  it("is 104px wide in the band and fills a panel", () => {
    render(<Legend />, bandLayout());
    expect(byTestId("dd").style.width).toBe("104px");
    render(<Legend />, panelLayout(300));
    expect(byTestId("dd").style.width).toBe("100%");
    render(<Legend />, { ...panelLayout(200), container: "popover" });
    expect(byTestId("dd").style.width).toBe("100%");
  });

  it("an explicit width wins on every surface", () => {
    render(<Legend width={140} />, bandLayout());
    expect(byTestId("dd").style.width).toBe("140px");
    render(<Legend width={140} />);
    expect(byTestId("dd").style.width).toBe("140px");
  });

  it("shows the placeholder when the value matches no option", () => {
    render(
      <Dropdown<string>
        ariaLabel="Font"
        testId="dd"
        value="Missing"
        placeholder="Choose a font"
        options={[{ value: "Calibri", label: "Calibri" }]}
        onChange={() => undefined}
      />,
    );
    const t = byTestId("dd");
    expect(t.textContent).toBe("Choose a font");
    const text = t.firstElementChild!.firstElementChild as HTMLElement;
    expect(declared(text, "color")).toContain("--text-secondary");
  });

  it("renderValue draws the selected option into the trigger", () => {
    render(<Legend renderValue={(opt) => <b data-testid="custom">{opt.label.toUpperCase()}</b>} />);
    expect(byTestId("custom").textContent).toBe("BOTTOM");
  });

  it("shows the selected option's icon beside its label by default", () => {
    render(
      <Dropdown<string>
        ariaLabel="Dash"
        testId="dd"
        value="solid"
        options={[{ value: "solid", label: "Solid", icon: <svg data-testid="dash-icon" /> }]}
        onChange={() => undefined}
      />,
    );
    expect(byTestId("dd").querySelector("[data-testid='dash-icon']")).not.toBeNull();
  });

  it("disabled cannot open", () => {
    render(<Legend disabled />);
    const t = byTestId<HTMLButtonElement>("dd");
    expect(t.disabled).toBe(true);
    expect(getComputedStyle(t).opacity).toBe("0.5");
    click(t);
    expect(listbox()).toBeNull();
  });
});

// ============================================================================
// Listbox
// ============================================================================

describe("Dropdown listbox", () => {
  it("a click opens a card popover listbox of options, the selected one focused", () => {
    render(<Legend />);
    const t = byTestId("dd");
    click(t);
    const list = listbox()!;
    expect(list).not.toBeNull();
    expect(t.getAttribute("aria-expanded")).toBe("true");
    expect(t.getAttribute("aria-controls")).toBe(list.id);
    expect(list.getAttribute("aria-label")).toBe("Legend position");
    const pop = list.closest("[data-section-flyout]") as HTMLElement;
    expect(pop.hasAttribute("data-ribbon-content")).toBe(true);
    expect(pop.getAttribute("role")).toBe("presentation");
    expect(getComputedStyle(pop).padding).toBe("8px");
    expect(options().map((o) => o.textContent)).toEqual(["Top", "Bottomdefault", "Left", "Right", "None"]);
    expect(options().map((o) => o.getAttribute("aria-selected"))).toEqual([
      "false",
      "true",
      "false",
      "false",
      "false",
    ]);
    expect(document.activeElement).toBe(byTestId("pos-bottom"));
  });

  it("options are 30px rows with a check column holding the tick for the selected one", () => {
    render(<Legend />);
    click(byTestId("dd"));
    const selected = byTestId("pos-bottom");
    const other = byTestId("pos-top");
    expect(getComputedStyle(selected).height).toBe("30px");
    expect(selected.tabIndex).toBe(-1);
    expect((selected.firstElementChild as HTMLElement).querySelector("svg")).not.toBeNull();
    expect((other.firstElementChild as HTMLElement).querySelector("svg")).toBeNull();
    expect(byTestId("pos-left").getAttribute("aria-disabled")).toBe("true");
  });

  it("the open card is at least as wide as the trigger", () => {
    render(<Legend />);
    const t = byTestId("dd");
    Object.defineProperty(t, "offsetWidth", { configurable: true, value: 140 });
    click(t);
    expect(listbox()!.style.minWidth).toBe(`${140 - 18}px`);
  });

  it("focuses the first enabled option when nothing is selected", () => {
    render(
      <Dropdown<Position>
        ariaLabel="Legend position"
        testId="dd"
        optionTestIdPrefix="pos-"
        value={"nowhere" as Position}
        options={[{ ...POSITIONS[0], disabled: true }, ...POSITIONS.slice(1)]}
        onChange={() => undefined}
      />,
    );
    click(byTestId("dd"));
    expect(document.activeElement).toBe(byTestId("pos-bottom"));
  });

  it("a click on an option chooses it, closes, and returns focus to the trigger", () => {
    const onChange = vi.fn();
    render(<Legend onChange={onChange} />);
    click(byTestId("dd"));
    click(byTestId("pos-right"));
    expect(onChange).toHaveBeenCalledWith("right");
    expect(listbox()).toBeNull();
    expect(byTestId("dd").textContent).toBe("Right");
    expect(document.activeElement).toBe(byTestId("dd"));
  });

  it("choosing the current value closes without calling onChange", () => {
    const onChange = vi.fn();
    render(<Legend onChange={onChange} />);
    click(byTestId("dd"));
    click(byTestId("pos-bottom"));
    expect(listbox()).toBeNull();
    expect(onChange).not.toHaveBeenCalled();
  });

  it("a disabled option cannot be chosen", () => {
    const onChange = vi.fn();
    render(<Legend onChange={onChange} />);
    click(byTestId("dd"));
    click(byTestId("pos-left"));
    expect(onChange).not.toHaveBeenCalled();
    expect(listbox()).not.toBeNull();
  });

  it("an outside press closes it without moving focus to the trigger", () => {
    render(<Legend />);
    click(byTestId("dd"));
    mouseDown(byTestId("elsewhere"));
    expect(listbox()).toBeNull();
    expect(document.activeElement).not.toBe(byTestId("dd"));
  });

  it("a second click on the trigger closes it", () => {
    render(<Legend />);
    const t = byTestId("dd");
    click(t);
    mouseDown(t);
    click(t);
    expect(listbox()).toBeNull();
  });
});

// ============================================================================
// Keyboard
// ============================================================================

describe("Dropdown keyboard", () => {
  it("ArrowDown / ArrowUp on the trigger open the list", () => {
    render(<Legend />);
    const t = byTestId("dd");
    act(() => t.focus());
    expect(key(t, "ArrowDown").defaultPrevented).toBe(true);
    expect(listbox()).not.toBeNull();
    expect(document.activeElement).toBe(byTestId("pos-bottom"));
    key(document.activeElement!, "Escape");
    key(t, "ArrowUp");
    expect(listbox()).not.toBeNull();
  });

  it("the arrows move between enabled options and STOP at the ends", () => {
    render(<Legend initial="top" />);
    click(byTestId("dd"));
    const top = byTestId("pos-top");
    expect(document.activeElement).toBe(top);
    key(top, "ArrowUp");
    expect(document.activeElement).toBe(top);
    key(top, "ArrowDown");
    expect(document.activeElement).toBe(byTestId("pos-bottom"));
    // "Left" is disabled and skipped.
    key(byTestId("pos-bottom"), "ArrowDown");
    expect(document.activeElement).toBe(byTestId("pos-right"));
    key(byTestId("pos-right"), "ArrowDown");
    key(byTestId("pos-none"), "ArrowDown");
    expect(document.activeElement).toBe(byTestId("pos-none"));
  });

  it("Home and End jump; moving focus alone never changes the value", () => {
    const onChange = vi.fn();
    render(<Legend onChange={onChange} />);
    click(byTestId("dd"));
    key(byTestId("pos-bottom"), "End");
    expect(document.activeElement).toBe(byTestId("pos-none"));
    key(byTestId("pos-none"), "Home");
    expect(document.activeElement).toBe(byTestId("pos-top"));
    expect(onChange).not.toHaveBeenCalled();
  });

  it("Enter chooses the focused option, closes, and returns focus", () => {
    const onChange = vi.fn();
    render(<Legend onChange={onChange} />);
    click(byTestId("dd"));
    key(byTestId("pos-bottom"), "ArrowDown");
    const event = key(byTestId("pos-right"), "Enter");
    expect(event.defaultPrevented).toBe(true);
    expect(onChange).toHaveBeenCalledWith("right");
    expect(listbox()).toBeNull();
    expect(document.activeElement).toBe(byTestId("dd"));
  });

  it("Space chooses too", () => {
    const onChange = vi.fn();
    render(<Legend onChange={onChange} />);
    click(byTestId("dd"));
    key(byTestId("pos-bottom"), "Home");
    key(byTestId("pos-top"), " ");
    expect(onChange).toHaveBeenCalledWith("top");
  });

  it("Escape closes without choosing and returns focus to the trigger", () => {
    const onChange = vi.fn();
    render(<Legend onChange={onChange} />);
    click(byTestId("dd"));
    key(byTestId("pos-bottom"), "ArrowDown");
    const event = key(byTestId("pos-right"), "Escape");
    expect(event.defaultPrevented).toBe(true);
    expect(listbox()).toBeNull();
    expect(onChange).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(byTestId("dd"));
    expect(byTestId("dd").getAttribute("aria-expanded")).toBe("false");
  });

  it("Tab closes, returns focus to the trigger and does NOT cancel the Tab", () => {
    render(<Legend />);
    click(byTestId("dd"));
    const event = key(byTestId("pos-bottom"), "Tab");
    expect(event.defaultPrevented).toBe(false);
    expect(listbox()).toBeNull();
    expect(document.activeElement).toBe(byTestId("dd"));
  });

  it("a letter jumps to the next option starting with it, cycling and skipping disabled", () => {
    render(
      <Dropdown<string>
        ariaLabel="Font"
        testId="dd"
        optionTestIdPrefix="f-"
        value="Arial"
        options={[
          { value: "Arial", label: "Arial" },
          { value: "Calibri", label: "Calibri" },
          { value: "Cambria", label: "Cambria", disabled: true },
          { value: "Consolas", label: "Consolas" },
          { value: "Segoe", label: "Segoe UI" },
        ]}
        onChange={() => undefined}
      />,
    );
    click(byTestId("dd"));
    key(byTestId("f-Arial"), "c");
    expect(document.activeElement).toBe(byTestId("f-Calibri"));
    key(byTestId("f-Calibri"), "C");
    expect(document.activeElement).toBe(byTestId("f-Consolas"));
    key(byTestId("f-Consolas"), "c");
    expect(document.activeElement).toBe(byTestId("f-Calibri"));
    key(byTestId("f-Calibri"), "s");
    expect(document.activeElement).toBe(byTestId("f-Segoe"));
    expect(key(byTestId("f-Segoe"), "q").defaultPrevented).toBe(false);
  });

  it("the pointer moves focus, so hover and keyboard share one current option", () => {
    render(<Legend />);
    click(byTestId("dd"));
    act(() => {
      byTestId("pos-none").dispatchEvent(new MouseEvent("mousemove", { bubbles: true }));
    });
    expect(document.activeElement).toBe(byTestId("pos-none"));
    act(() => {
      byTestId("pos-left").dispatchEvent(new MouseEvent("mousemove", { bubbles: true }));
    });
    expect(document.activeElement).toBe(byTestId("pos-none"));
  });
});

// ============================================================================
// Nesting
// ============================================================================

function Nested({ onOuterClose }: { onOuterClose: () => void }): React.ReactElement {
  const [anchor, setAnchor] = useState<HTMLButtonElement | null>(null);
  const [open, setOpen] = useState(true);
  return (
    <>
      <button ref={setAnchor}>Legend options</button>
      <Popover
        anchorEl={anchor}
        open={open}
        card
        onClose={() => {
          setOpen(false);
          onOuterClose();
        }}
      >
        <Legend />
      </Popover>
    </>
  );
}

describe("Dropdown nested in another overlay", () => {
  it("Escape in the list closes only the list", () => {
    const onOuterClose = vi.fn();
    render(<Nested onOuterClose={onOuterClose} />);
    click(byTestId("dd"));
    key(byTestId("pos-bottom"), "Escape");
    expect(listbox()).toBeNull();
    expect(onOuterClose).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(byTestId("dd"));
  });

  it("choosing an option does not dismiss the outer overlay", () => {
    const onOuterClose = vi.fn();
    render(<Nested onOuterClose={onOuterClose} />);
    click(byTestId("dd"));
    mouseDown(byTestId("pos-right"));
    expect(onOuterClose).not.toHaveBeenCalled();
    click(byTestId("pos-right"));
    expect(byTestId("dd").textContent).toBe("Right");
    expect(onOuterClose).not.toHaveBeenCalled();
  });
});

// ============================================================================
// Colours
// ============================================================================

describe("Dropdown colours", () => {
  it.each([
    ["band", bandLayout()],
    ["panel", panelLayout(300)],
  ])("paints no hardcoded colour in the %s (trigger and open list)", (_name, layout) => {
    render(
      <>
        <Legend />
        <Dropdown<string>
          ariaLabel="Font"
          value="x"
          placeholder="Font"
          disabled
          options={[{ value: "a", label: "A" }]}
          onChange={() => undefined}
        />
      </>,
      layout,
    );
    click(byTestId("dd"));
    expect(listbox()).not.toBeNull();
    expect(hardcodedColours(document.body)).toEqual([]);
  });
});
