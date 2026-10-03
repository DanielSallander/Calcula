// Tests for THE disabled idiom (primitives/disabled.ts) across every
// @api/layout primitive that can be disabled. The owner found a disabled Redo
// beside an enabled Undo "only slightly lighter" (2026-10-02): at opacity .5
// the duotone accent stayed GREEN, so the idiom now fades further AND draws the
// icons without colour. These tests pin both halves of that, per primitive and
// per disabled-state spelling (:disabled, aria-disabled, data-disabled), and
// pin what must NOT lose its colour: the colour bar of a ColorSwatch is data.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import React from "react";
import { DISABLED_LOOK, DISABLED_OPACITY } from "../primitives/disabled";
import { Button, IconButton, CommandButton } from "../primitives/Button";
import { Chip } from "../primitives/Chip";
import { ColorSwatch } from "../primitives/Color";
import { Dropdown } from "../primitives/Dropdown";
import { Menu, MenuItem, SplitMenuButton } from "../primitives/Menu";
import { Select } from "../primitives/Select";
import { Checkbox, Switch } from "../primitives/toggles";
import { bandLayout } from "../context";
import { click, declared, mount, q, type Mount } from "./formControlsKit";

const GREY = "grayscale(1)";
const FADED = String(DISABLED_OPACITY);

const Icon = () => (
  <svg data-testid="icon" width={20} height={20} viewBox="0 0 24 24" aria-hidden>
    <rect x="3" y="3" width="18" height="18" rx="2" fill="currentColor" />
  </svg>
);

let m: Mount;
beforeEach(() => {
  m = mount();
});
afterEach(() => m.unmount());

function filterOf(el: Element): string {
  return getComputedStyle(el).filter;
}

/** Whether `el` is drawn without colour by its OWN filter or an ancestor's.
 *  `filter` does not inherit, so reading the element alone would miss a
 *  grey filter on the control around it -- which a descendant cannot undo. */
function greyed(el: Element): boolean {
  for (let n: Element | null = el; n && n !== m.container; n = n.parentElement) {
    if (filterOf(n) === GREY) return true;
  }
  return false;
}

describe("the disabled idiom itself", () => {
  it("fades to .4 and greys the icons -- the values the owner's review settled", () => {
    // .4 is set by the label, not the icon: a disabled 12px label measures
    // 2.53:1 on the Light cluster there, and .35 drops it under Excel's ~2.3.
    expect(DISABLED_OPACITY).toBe(0.4);
    expect(DISABLED_LOOK).toContain(`opacity: ${DISABLED_OPACITY};`);
    expect(DISABLED_LOOK).toContain("cursor: default;");
    expect(DISABLED_LOOK).toMatch(
      /& svg:not\(\[data-colour-data\]\),\s*& img:not\(\[data-colour-data\]\)\s*\{\s*filter: grayscale\(1\);\s*\}/,
    );
  });

  it("carries no colour literal (it is interpolated into every primitive)", () => {
    expect(DISABLED_LOOK).not.toMatch(/#[0-9a-f]{3,8}\b|rgba?\(|hsla?\(/i);
  });
});

describe("Button recipe (:disabled)", () => {
  it("a disabled IconButton fades and its icon loses its colour", () => {
    m.render(<IconButton icon={<Icon />} label="Redo" disabled data-testid="redo" />);
    const b = q<HTMLButtonElement>(m.container, "[data-testid='redo']");
    expect(b.disabled).toBe(true);
    expect(getComputedStyle(b).opacity).toBe(FADED);
    expect(getComputedStyle(b).cursor).toBe("default");
    expect(filterOf(q(b, "[data-testid='icon']"))).toBe(GREY);
  });

  it("an enabled IconButton beside it keeps full strength and colour", () => {
    m.render(<IconButton icon={<Icon />} label="Undo" data-testid="undo" />);
    const b = q<HTMLButtonElement>(m.container, "[data-testid='undo']");
    expect(getComputedStyle(b).opacity).not.toBe(FADED);
    expect(filterOf(q(b, "[data-testid='icon']"))).not.toBe(GREY);
  });

  it("the filter is on the ICON, never the control: a pressed fill survives", () => {
    m.render(<IconButton icon={<Icon />} label="Wrap" pressed disabled data-testid="b" />);
    const b = q<HTMLButtonElement>(m.container, "[data-testid='b']");
    expect(filterOf(b)).not.toBe(GREY);
    expect(declared(b, "background")).toContain("--button-pressed-bg");
  });

  it("a labelled Button and a band hero grey their icons too", () => {
    m.render(
      <>
        <Button icon={<Icon />} disabled data-testid="labelled">
          Cut
        </Button>
        <CommandButton icon={<Icon />} label="Paste" disabled data-testid="hero" />
      </>,
      bandLayout(),
    );
    for (const id of ["labelled", "hero"]) {
      const b = q<HTMLButtonElement>(m.container, `[data-testid='${id}']`);
      expect(getComputedStyle(b).opacity).toBe(FADED);
      expect(filterOf(q(b, "[data-testid='icon']"))).toBe(GREY);
    }
  });
});

describe("SplitMenuButton (aria-disabled, never native)", () => {
  function Merge({ pressed }: { pressed?: boolean }): React.ReactElement {
    return (
      <SplitMenuButton
        icon={<Icon />}
        label="Merge & Center"
        pressed={pressed}
        disabled
        data-testid="main"
        chevronTestId="chevron"
        menuLabel="Merge"
        onClick={() => undefined}
      >
        <MenuItem onSelect={() => undefined}>Merge Cells</MenuItem>
      </SplitMenuButton>
    );
  }

  it("both halves fade and the icon loses its colour, though neither is :disabled", () => {
    m.render(<Merge />);
    const main = q<HTMLButtonElement>(m.container, "[data-testid='main']");
    const chevron = q<HTMLButtonElement>(m.container, "[data-testid='chevron']");
    expect(main.disabled).toBe(false);
    expect(getComputedStyle(main).opacity).toBe(FADED);
    expect(getComputedStyle(chevron).opacity).toBe(FADED);
    expect(filterOf(q(main, "[data-testid='icon']"))).toBe(GREY);
    expect(filterOf(q(chevron, "svg"))).toBe(GREY);
  });

  it("a pressed, disabled Merge & Center keeps its pressed fill (Excel does)", () => {
    m.render(<Merge pressed />);
    const main = q<HTMLButtonElement>(m.container, "[data-testid='main']");
    expect(filterOf(main)).not.toBe(GREY);
    expect(declared(main, "background")).toContain("--button-pressed-bg");
  });
});

describe("ColorSwatch: the icon greys, the colour bar is data and keeps its colour", () => {
  it("in its IconButton form", () => {
    m.render(
      <ColorSwatch
        variant="bar"
        icon={<Icon />}
        color="#c00000"
        onChange={() => undefined}
        label="Font Color"
        testId="fc"
        disabled
      />,
    );
    const icon = q(m.container, "[data-testid='icon']");
    const bar = q(m.container, "[data-colour-data]");
    expect(filterOf(icon)).toBe(GREY);
    expect(greyed(bar)).toBe(false);
    expect(getComputedStyle(icon.closest("button")!).opacity).toBe(FADED);
  });

  it("in its native form (the face wrapper carries data-disabled)", () => {
    m.render(
      <ColorSwatch
        native
        variant="bar"
        icon={<Icon />}
        color="#c00000"
        onChange={() => undefined}
        label="Font Color"
        testId="nat"
        disabled
      />,
    );
    const input = q<HTMLInputElement>(m.container, "[data-testid='nat']");
    const wrap = input.parentElement!;
    expect(getComputedStyle(wrap).opacity).toBe(FADED);
    expect(filterOf(q(wrap, "[data-testid='icon']"))).toBe(GREY);
    expect(greyed(q(wrap, "[data-colour-data]"))).toBe(false);
  });
});

describe("list rows, Dropdown, Select, Chip", () => {
  it("a disabled MenuItem fades and greys its icon", () => {
    m.render(
      <Menu ariaLabel="Edit">
        <MenuItem testId="row" icon={<Icon />} disabled onSelect={() => undefined}>
          Redo
        </MenuItem>
      </Menu>,
    );
    const row = q<HTMLButtonElement>(m.container, "[data-testid='row']");
    expect(getComputedStyle(row).opacity).toBe(FADED);
    expect(filterOf(q(row, "[data-testid='icon']"))).toBe(GREY);
  });

  it("a disabled Dropdown trigger greys its chevron", () => {
    m.render(
      <Dropdown
        testId="dd"
        value="a"
        options={[{ value: "a", label: "A" }]}
        onChange={() => undefined}
        disabled
      />,
    );
    const t = q<HTMLButtonElement>(m.container, "[data-testid='dd']");
    expect(getComputedStyle(t).opacity).toBe(FADED);
    expect(filterOf(q(t, "svg"))).toBe(GREY);
  });

  it("a disabled Dropdown OPTION (aria-disabled row) fades and greys its icon", () => {
    m.render(
      <Dropdown
        testId="dd"
        value="a"
        options={[
          { value: "a", label: "A" },
          { value: "b", label: "B", icon: <Icon />, disabled: true },
        ]}
        optionTestIdPrefix="opt-"
        onChange={() => undefined}
      />,
    );
    click(q(m.container, "[data-testid='dd']"));
    // The listbox portals to <body>.
    const row = q(document, "[data-testid='opt-b']");
    expect(row.getAttribute("aria-disabled")).toBe("true");
    expect(getComputedStyle(row).opacity).toBe(FADED);
    expect(filterOf(q(row, "[data-testid='icon']"))).toBe(GREY);
  });

  it("a colour sample marked data-colour-data keeps its colour on a disabled trigger", () => {
    m.render(
      <Dropdown
        testId="dd"
        value="red"
        options={[
          {
            value: "red",
            label: "Red",
            icon: (
              <svg data-testid="sample" data-colour-data="" width={16} height={16} aria-hidden>
                <rect width="16" height="16" fill="currentColor" />
              </svg>
            ),
          },
        ]}
        onChange={() => undefined}
        disabled
      />,
    );
    const t = q<HTMLButtonElement>(m.container, "[data-testid='dd']");
    expect(getComputedStyle(t).opacity).toBe(FADED);
    expect(greyed(q(t, "[data-testid='sample']"))).toBe(false);
    // The chevron beside it is decoration and still greys.
    const chevron = Array.from(t.querySelectorAll("svg")).find((s) => !s.hasAttribute("data-colour-data"));
    expect(chevron && filterOf(chevron)).toBe(GREY);
  });

  it("a disabled Checkbox or Switch row greys an icon in its label", () => {
    m.render(
      <>
        <Checkbox testId="cb" label={<Icon />} checked disabled onChange={() => undefined} />
        <Switch testId="sw" label="On" checked disabled onChange={() => undefined} />
      </>,
    );
    const cbRow = q(m.container, "[data-testid='cb']").closest("label")!;
    expect(getComputedStyle(cbRow).opacity).toBe(FADED);
    expect(filterOf(q(cbRow, "[data-testid='icon']"))).toBe(GREY);
    expect(getComputedStyle(q(m.container, "[data-testid='sw']").closest("label")!).opacity).toBe(FADED);
  });

  it("a disabled Select greys its chevron through the WRAPPER and dims once", () => {
    m.render(
      <Select data-testid="s" disabled>
        <option value="a">A</option>
      </Select>,
    );
    const select = q<HTMLSelectElement>(m.container, "[data-testid='s']");
    const wrapper = select.parentElement!;
    expect(getComputedStyle(wrapper).opacity).toBe(FADED);
    expect(getComputedStyle(select).opacity).toBe("1");
    expect(filterOf(q(wrapper, "svg"))).toBe(GREY);
  });

  it("a disabled removable Chip dims the pill once and greys its icons", () => {
    m.render(
      <Chip testId="c" icon={<Icon />} onClick={() => undefined} onRemove={() => undefined} disabled>
        Region
      </Chip>,
    );
    const chip = q(m.container, "[data-testid='c']");
    expect(getComputedStyle(chip).opacity).toBe(FADED);
    for (const half of Array.from(chip.querySelectorAll("button"))) {
      // Undimmed, not merely "not .4": any second dim would compound.
      expect(["", "1"]).toContain(getComputedStyle(half).opacity);
    }
    for (const svg of Array.from(chip.querySelectorAll("svg"))) {
      expect(filterOf(svg)).toBe(GREY);
    }
  });
});
