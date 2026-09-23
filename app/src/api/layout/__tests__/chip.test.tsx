// Tests for the @api/layout Chip: the 24px status pill. It is static by
// default, a <button> when clickable, and grows a 16px close button when
// removable — and a chip that is BOTH never nests one button in another. Tones
// paint with LT.<tone>Bg/Fg, the neutral chip with the chip tokens, and every
// variant is scanned for hardcoded colours under band, panel and popover.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import React from "react";
import { bandLayout } from "../context";
import { Chip, type ChipTone } from "../primitives/Chip";
import { LAYOUTS, click, declared, hardcodedColours, mount, q, ruleBodies, type Mount } from "./formControlsKit";

let m: Mount;

beforeEach(() => {
  m = mount();
});

afterEach(() => {
  m.unmount();
});

describe("Chip: the static pill", () => {
  it("is a 24px pill at 11px/500 with the pill radius", () => {
    m.render(<Chip testId="c">Linear</Chip>);
    const chip = q(m.container, "[data-testid='c']");
    expect(chip.tagName).toBe("SPAN");
    const cs = getComputedStyle(chip);
    expect(cs.height).toBe("24px");
    expect(cs.padding).toBe("0px 9px");
    expect(cs.gap).toBe("4px");
    expect(cs.fontSize).toBe("11px");
    expect(cs.fontWeight).toBe("500");
    expect(cs.borderRadius).toContain("--radius-pill");
    expect(chip.textContent).toBe("Linear");
  });

  it("neutral paints the chip tokens: chip background, inset chip border, secondary text", () => {
    m.render(<Chip testId="c">Linear</Chip>);
    const chip = q(m.container, "[data-testid='c']");
    expect(declared(chip, "background-color")).toContain("--chip-bg");
    expect(declared(chip, "box-shadow")).toContain("--chip-border");
    expect(declared(chip, "box-shadow")).toContain("inset");
    expect(declared(chip, "color")).toContain("--text-secondary");
    expect(chip.getAttribute("data-active")).toBeNull();
  });

  it("renders a value as `name: <b>value</b>`, the value in 600 and the primary colour", () => {
    m.render(
      <Chip testId="c" value="On">
        Loop
      </Chip>,
    );
    const chip = q(m.container, "[data-testid='c']");
    expect(chip.textContent).toBe("Loop: On");
    const b = q(chip, "b");
    expect(b.textContent).toBe("On");
    expect(getComputedStyle(b).fontWeight).toBe("600");
    expect(declared(b, "color")).toContain("--text-primary");
  });

  it("does not add a second colon to a name that already ends in one", () => {
    m.render(
      <Chip testId="c" value="On">
        Loop:
      </Chip>,
    );
    expect(q(m.container, "[data-testid='c']").textContent).toBe("Loop: On");
  });

  it("lets callers bold a leading count through children (`3 of 12`)", () => {
    m.render(
      <Chip testId="c" tone="info">
        <b>3</b> of 12
      </Chip>,
    );
    const chip = q(m.container, "[data-testid='c']");
    expect(chip.textContent).toBe("3 of 12");
    expect(declared(q(chip, "b"), "color")).toContain("--tone-info-fg");
  });

  it.each<[ChipTone, string, string]>([
    ["info", "--tone-info-bg", "--tone-info-fg"],
    ["ok", "--tone-ok-bg", "--tone-ok-fg"],
    ["warn", "--tone-warn-bg", "--tone-warn-fg"],
    ["danger", "--tone-danger-bg", "--tone-danger-fg"],
  ])("tone %s paints its tone background and foreground, with no border", (tone, bg, fg) => {
    m.render(
      <Chip testId="c" tone={tone} value="x">
        Status
      </Chip>,
    );
    const chip = q(m.container, "[data-testid='c']");
    expect(declared(chip, "background-color")).toContain(bg);
    expect(declared(chip, "color")).toContain(fg);
    expect(declared(chip, "box-shadow")).toBe("none");
    expect(declared(q(chip, "b"), "color")).toContain(fg);
  });

  it("renders icon and chevron as aria-hidden slots, keeping the text the only text", () => {
    m.render(
      <Chip testId="c" icon={<svg data-testid="icon" />} chevron>
        Filter
      </Chip>,
    );
    const chip = q(m.container, "[data-testid='c']");
    const slots = Array.from(chip.children).filter((el) => el.getAttribute("aria-hidden") === "true");
    expect(slots).toHaveLength(2);
    expect(slots[0].querySelector("[data-testid='icon']")).not.toBeNull();
    expect(slots[1].querySelector("svg")?.getAttribute("width")).toBe("7");
    expect(chip.textContent).toBe("Filter");
  });

  it("marks the on state with data-active and the pressed tokens", () => {
    m.render(
      <Chip testId="c" active>
        Q1
      </Chip>,
    );
    const chip = q(m.container, "[data-testid='c']");
    expect(chip.getAttribute("data-active")).toBe("true");
    expect(declared(chip, "background-color")).toContain("--button-pressed-bg");
    expect(declared(chip, "box-shadow")).toContain("--button-pressed-border");
  });

  it("passes title, aria-* and the ref through to the pill", () => {
    const ref = React.createRef<HTMLElement>();
    m.render(
      <Chip ref={ref} testId="c" title="Loop playback" aria-describedby="d">
        Loop
      </Chip>,
    );
    const chip = q(m.container, "[data-testid='c']");
    expect(ref.current).toBe(chip);
    expect(chip.getAttribute("title")).toBe("Loop playback");
    expect(chip.getAttribute("aria-describedby")).toBe("d");
  });
});

describe("Chip: clickable", () => {
  it("renders AS a <button> when onClick is given", () => {
    const onClick = vi.fn();
    m.render(
      <Chip testId="c" onClick={onClick}>
        Series
      </Chip>,
    );
    const chip = q<HTMLButtonElement>(m.container, "[data-testid='c']");
    expect(chip.tagName).toBe("BUTTON");
    expect(chip.type).toBe("button");
    expect(chip.hasAttribute("aria-pressed")).toBe(false);
    click(chip);
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it("announces active through aria-pressed", () => {
    m.render(
      <>
        <Chip testId="on" onClick={() => {}} active>
          Q1
        </Chip>
        <Chip testId="off" onClick={() => {}} active={false}>
          Q2
        </Chip>
      </>,
    );
    expect(q(m.container, "[data-testid='on']").getAttribute("aria-pressed")).toBe("true");
    expect(q(m.container, "[data-testid='off']").getAttribute("aria-pressed")).toBe("false");
  });

  it("tints hover and press OVER the tone (background-image), and rings keyboard focus", () => {
    m.render(
      <Chip testId="c" tone="info" onClick={() => {}}>
        Info
      </Chip>,
    );
    const chip = q(m.container, "[data-testid='c']");
    const hoverRule = ruleBodies(chip, ":hover").join(";");
    expect(hoverRule).toContain("background-image");
    expect(hoverRule).toContain("--button-hover-bg");
    expect(hoverRule).not.toMatch(/background(-color)?:/);
    expect(ruleBodies(chip, ":focus-visible").join(";")).toContain("--focus-ring");
  });

  it("disabled uses the one disabled idiom and ignores clicks", () => {
    const onClick = vi.fn();
    m.render(
      <Chip testId="c" onClick={onClick} disabled>
        Series
      </Chip>,
    );
    const chip = q<HTMLButtonElement>(m.container, "[data-testid='c']");
    expect(chip.disabled).toBe(true);
    expect(getComputedStyle(chip).opacity).toBe("0.5");
    click(chip);
    expect(onClick).not.toHaveBeenCalled();
  });
});

describe("Chip: removable", () => {
  it("adds a 16px close button named by removeLabel", () => {
    const onRemove = vi.fn();
    m.render(
      <Chip testId="c" onRemove={onRemove} removeLabel="Remove filter Region">
        Region
      </Chip>,
    );
    const chip = q(m.container, "[data-testid='c']");
    expect(chip.tagName).toBe("SPAN");
    const close = q<HTMLButtonElement>(chip, "[data-testid='c-remove']");
    expect(close.getAttribute("aria-label")).toBe("Remove filter Region");
    const cs = getComputedStyle(close);
    expect(cs.width).toBe("16px");
    expect(cs.height).toBe("16px");
    expect(getComputedStyle(chip).paddingRight).toBe("4px");
    click(close);
    expect(onRemove).toHaveBeenCalledTimes(1);
    // The close glyph is an SVG, so the chip's text is still just its name.
    expect(chip.textContent).toBe("Region");
  });

  it("defaults the close button's name to Remove", () => {
    m.render(
      <Chip testId="c" onRemove={() => {}}>
        Region
      </Chip>,
    );
    expect(q(m.container, "[data-testid='c-remove']").getAttribute("aria-label")).toBe("Remove");
  });

  it("clickable AND removable: two sibling buttons in a span, never nested", () => {
    const onClick = vi.fn();
    const onRemove = vi.fn();
    m.render(
      <Chip testId="c" onClick={onClick} onRemove={onRemove} active aria-expanded={false} aria-haspopup="menu">
        Region
      </Chip>,
    );
    const chip = q(m.container, "[data-testid='c']");
    expect(chip.tagName).toBe("SPAN");
    const buttons = Array.from(chip.querySelectorAll("button"));
    expect(buttons).toHaveLength(2);
    expect(buttons[0].querySelector("button")).toBeNull();
    const [main, close] = buttons;
    // The popup attributes a MenuButton adds belong on the clickable half.
    expect(main.getAttribute("aria-expanded")).toBe("false");
    expect(main.getAttribute("aria-haspopup")).toBe("menu");
    expect(main.getAttribute("aria-pressed")).toBe("true");
    expect(chip.hasAttribute("aria-expanded")).toBe(false);
    // The on look is on the pill; the half is transparent over it.
    expect(chip.getAttribute("data-active")).toBe("true");
    expect(declared(main, "background-color")).toBe("transparent");

    click(main);
    expect(onClick).toHaveBeenCalledTimes(1);
    expect(onRemove).not.toHaveBeenCalled();
    click(close);
    expect(onRemove).toHaveBeenCalledTimes(1);
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it("disabled dims the pill once and disables both halves", () => {
    const onClick = vi.fn();
    const onRemove = vi.fn();
    m.render(
      <Chip testId="c" onClick={onClick} onRemove={onRemove} disabled>
        Region
      </Chip>,
    );
    const chip = q(m.container, "[data-testid='c']");
    expect(getComputedStyle(chip).opacity).toBe("0.5");
    const buttons = Array.from(chip.querySelectorAll("button"));
    for (const b of buttons) {
      expect(b.disabled).toBe(true);
      // Never compounded to .25.
      expect(getComputedStyle(b).opacity).not.toBe("0.5");
      click(b);
    }
    expect(onClick).not.toHaveBeenCalled();
    expect(onRemove).not.toHaveBeenCalled();
  });
});

describe("Chip: colours", () => {
  it.each(LAYOUTS)("paints no hardcoded colour in the %s", (_name, layout) => {
    m.render(
      <>
        <Chip value="On">Loop</Chip>
        <Chip tone="info">
          <b>3</b> of 12
        </Chip>
        <Chip tone="ok">Saved</Chip>
        <Chip tone="warn">Stale</Chip>
        <Chip tone="danger">Error</Chip>
        <Chip active onClick={() => {}} chevron>
          Series
        </Chip>
        <Chip onRemove={() => {}}>Region</Chip>
        <Chip onClick={() => {}} onRemove={() => {}} disabled>
          Year
        </Chip>
      </>,
      layout,
    );
    expect(hardcodedColours(m.container)).toEqual([]);
  });

  it("is the same pill in the band", () => {
    m.render(<Chip testId="c">Linear</Chip>, bandLayout());
    expect(getComputedStyle(q(m.container, "[data-testid='c']")).height).toBe("24px");
  });
});
