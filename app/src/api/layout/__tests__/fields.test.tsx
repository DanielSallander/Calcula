// Tests for the @api/layout form fields: Field and FieldGrid on the fill
// rule's 28px row, the shared text-entry chrome of Input and Select, the
// restyled native Select (chevron in a wrapper, width on the wrapper, the
// caller's className/style/ref still on the <select>), and NumberField, whose
// whole reason to exist is that "blank" and "half-typed" are different things.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import React from "react";
import { bandLayout, panelLayout, popoverLayout } from "../context";
import { FIELD_HEIGHT } from "../tokens";
import {
  Field,
  FieldGrid,
  NUMBER_FIELD_WIDTH,
  NumberField,
  formatNumberFieldValue,
  parseNumberFieldText,
} from "../primitives/fields";
import { Input } from "../primitives/Input";
import { Select } from "../primitives/Select";
import {
  LAYOUTS,
  blur,
  declared,
  hardcodedColours,
  mount,
  q,
  ruleBodies,
  typeValue,
  type Mount,
} from "./formControlsKit";

let m: Mount;

beforeEach(() => {
  m = mount();
});

afterEach(() => {
  m.unmount();
});

// ============================================================================
// Field / FieldGrid
// ============================================================================

describe("Field", () => {
  it("is exactly one FIELD_HEIGHT row in the band, label inline-left", () => {
    m.render(
      <Field label="Name" htmlFor="n">
        <Input id="n" />
      </Field>,
      bandLayout(),
    );
    const row = m.container.firstElementChild as HTMLElement;
    expect(row.style.height).toBe(`${FIELD_HEIGHT}px`);
    expect(row.style.flexDirection).not.toBe("column");
    expect(row.style.alignItems).toBe("center");
    const label = q<HTMLLabelElement>(row, "label");
    expect(label.textContent).toBe("Name");
    expect(label.htmlFor).toBe("n");
    // The control sits in a FLEX box: in a block box an inline-level input
    // gets a descender strut and the row grows past 28px.
    const slot = label.nextElementSibling as HTMLElement;
    expect(slot.style.display).toBe("flex");
    expect(slot.style.alignItems).toBe("center");
  });

  it("puts the label above the control in the panel, 5px apart", () => {
    m.render(
      <Field label="Name">
        <Input />
      </Field>,
      panelLayout(300),
    );
    const row = m.container.firstElementChild as HTMLElement;
    expect(row.style.flexDirection).toBe("column");
    expect(row.style.gap).toBe("5px");
  });

  it("paints the label with the secondary token instead of fading it", () => {
    m.render(
      <Field label="Name">
        <Input />
      </Field>,
    );
    const label = q(m.container, "label");
    expect(label.style.opacity).toBe("");
    expect(declared(label, "color")).toContain("--text-secondary");
    expect(getComputedStyle(label).fontSize).toBe("11px");
  });
});

describe("FieldGrid", () => {
  it("is one inline row at least FIELD_HEIGHT tall in the band", () => {
    m.render(
      <FieldGrid>
        <Field label="From">
          <Input />
        </Field>
        <Field label="To">
          <Input />
        </Field>
      </FieldGrid>,
      bandLayout(),
    );
    const grid = m.container.firstElementChild as HTMLElement;
    expect(grid.style.flexDirection).toBe("row");
    expect(grid.style.minHeight).toBe(`${FIELD_HEIGHT}px`);
  });

  it("switches to two columns in a wide panel", () => {
    m.render(
      <FieldGrid>
        <Field label="From">
          <Input />
        </Field>
      </FieldGrid>,
      panelLayout(300),
    );
    const grid = m.container.firstElementChild as HTMLElement;
    expect(grid.style.display).toBe("grid");
    expect(grid.style.gridTemplateColumns).toBe("1fr 1fr");
  });
});

// ============================================================================
// Input
// ============================================================================

describe("Input", () => {
  it("is the FIELD_HEIGHT text-entry chrome, painted with tokens", () => {
    m.render(<Input data-testid="i" />);
    const input = q(m.container, "[data-testid='i']");
    const cs = getComputedStyle(input);
    expect(cs.height).toBe("28px");
    expect(cs.borderRadius).toContain("--radius-control");
    expect(cs.padding).toBe("0px 8px");
    expect(declared(input, "border")).toContain("--control-border");
    expect(declared(input, "background")).toContain("--input-bg");
    expect(declared(input, "color")).toContain("--text-primary");
  });

  it("rings keyboard/typing focus and turns the border to the state accent", () => {
    m.render(<Input data-testid="i" />);
    const focus = ruleBodies(q(m.container, "[data-testid='i']"), ":focus-visible").join(";");
    expect(focus).toContain("--focus-ring");
    expect(focus).toContain("border-color:var(--state-accent");
    expect(focus).toContain("outline:none");
  });

  it("defaults to 64px in the band and 100% elsewhere; an explicit width wins", () => {
    m.render(<Input data-testid="i" />, bandLayout());
    expect(q(m.container, "[data-testid='i']").style.width).toBe("64px");
    m.render(<Input data-testid="i" />, panelLayout(300));
    expect(q(m.container, "[data-testid='i']").style.width).toBe("100%");
    m.render(<Input data-testid="i" width={120} />, bandLayout());
    expect(q(m.container, "[data-testid='i']").style.width).toBe("120px");
  });

  it("keeps the caller's style, className, HTML props and ref", () => {
    const ref = React.createRef<HTMLInputElement>();
    m.render(
      <Input
        ref={ref}
        data-testid="i"
        className="caller"
        style={{ width: 50, textAlign: "right" }}
        placeholder="B1"
        disabled
      />,
    );
    const input = q<HTMLInputElement>(m.container, "[data-testid='i']");
    expect(ref.current).toBe(input);
    expect(input.classList.contains("caller")).toBe(true);
    expect(input.style.width).toBe("50px");
    expect(input.style.textAlign).toBe("right");
    expect(input.placeholder).toBe("B1");
    expect(getComputedStyle(input).opacity).toBe("0.5");
  });
});

// ============================================================================
// Select
// ============================================================================

describe("Select", () => {
  const options = (
    <>
      <option value="calibri">Calibri</option>
      <option value="segoe">Segoe UI</option>
    </>
  );

  it("wraps the native select with a chevron; the ref still reaches the <select>", () => {
    const ref = React.createRef<HTMLSelectElement>();
    m.render(
      <Select ref={ref} data-testid="s" defaultValue="calibri" aria-label="Font">
        {options}
      </Select>,
    );
    const select = q<HTMLSelectElement>(m.container, "[data-testid='s']");
    expect(ref.current).toBe(select);
    expect(select.getAttribute("aria-label")).toBe("Font");
    const wrapper = select.parentElement!;
    expect(wrapper.tagName).toBe("SPAN");
    expect(getComputedStyle(wrapper).position).toBe("relative");
    expect(getComputedStyle(wrapper).display).toBe("inline-flex");

    const chevron = select.nextElementSibling as HTMLElement;
    expect(chevron.getAttribute("aria-hidden")).toBe("true");
    const cs = getComputedStyle(chevron);
    expect(cs.position).toBe("absolute");
    expect(cs.right).toBe("9px");
    expect(cs.pointerEvents).toBe("none");
    expect(declared(chevron, "color")).toContain("--text-secondary");
    expect(chevron.querySelector("svg")?.getAttribute("width")).toBe("9");
  });

  it("drops the OS trigger and reserves room for the chevron", () => {
    m.render(<Select data-testid="s">{options}</Select>);
    const select = q(m.container, "[data-testid='s']");
    const cs = getComputedStyle(select);
    expect(declared(select, "appearance")).toBe("none");
    expect(cs.height).toBe("28px");
    expect(cs.paddingRight).toBe("26px");
    expect(cs.paddingLeft).toBe("10px");
    expect(cs.width).toBe("100%");
    expect(cs.borderRadius).toContain("--radius-control");
    expect(declared(select, "border")).toContain("--control-border");
    expect(declared(select, "background")).toContain("--input-bg");
    const focus = ruleBodies(select, ":focus-visible").join(";");
    expect(focus).toContain("--focus-ring");
    expect(focus).toContain("--state-accent");
  });

  it("puts the width on the wrapper: 96px band default, 100% panel default, explicit wins", () => {
    m.render(<Select data-testid="s">{options}</Select>, bandLayout());
    expect(q(m.container, "[data-testid='s']").parentElement!.style.width).toBe("96px");
    m.render(<Select data-testid="s">{options}</Select>, panelLayout(300));
    expect(q(m.container, "[data-testid='s']").parentElement!.style.width).toBe("100%");
    m.render(
      <Select data-testid="s" width={118}>
        {options}
      </Select>,
      bandLayout(),
    );
    const select = q(m.container, "[data-testid='s']");
    expect(select.parentElement!.style.width).toBe("118px");
    // The select itself fills the wrapper rather than carrying the width.
    expect(select.style.width).toBe("");
  });

  it("keeps className and style on the <select>, as existing callers intend", () => {
    m.render(
      <Select data-testid="s" className="caller" style={{ fontFamily: "Georgia" }} title="Font">
        {options}
      </Select>,
      bandLayout(),
    );
    const select = q(m.container, "[data-testid='s']");
    expect(select.classList.contains("caller")).toBe(true);
    expect(select.style.fontFamily).toBe("Georgia");
    expect(select.getAttribute("title")).toBe("Font");
    expect(select.parentElement!.classList.contains("caller")).toBe(false);
  });

  it("lets a select sized through style.width size its wrapper", () => {
    m.render(
      <Select data-testid="s" style={{ width: 300 }}>
        {options}
      </Select>,
      bandLayout(),
    );
    const select = q(m.container, "[data-testid='s']");
    expect(select.style.width).toBe("300px");
    expect(select.parentElement!.style.width).toBe("");
  });

  it("delivers a change to the caller's onChange with the chosen value", () => {
    const onChange = vi.fn();
    m.render(
      <Select data-testid="s" value="calibri" onChange={(e) => onChange(e.target.value)}>
        {options}
      </Select>,
    );
    typeValue(q<HTMLSelectElement>(m.container, "[data-testid='s']"), "segoe");
    expect(onChange).toHaveBeenCalledWith("segoe");
  });

  it("dims the WRAPPER when disabled, so select and chevron fade together, once", () => {
    m.render(
      <Select data-testid="s" disabled>
        {options}
      </Select>,
    );
    const select = q<HTMLSelectElement>(m.container, "[data-testid='s']");
    expect(select.disabled).toBe(true);
    expect(getComputedStyle(select.parentElement!).opacity).toBe("0.5");
    expect(getComputedStyle(select).opacity).not.toBe("0.5");
  });

  it("draws no chevron on a multi-row list", () => {
    m.render(
      <Select data-testid="s" multiple>
        {options}
      </Select>,
    );
    const select = q(m.container, "[data-testid='s']");
    expect(select.nextElementSibling).toBeNull();
    expect(getComputedStyle(select).height).toBe("auto");
  });
});

// ============================================================================
// NumberField
// ============================================================================

/** Make jsdom report the browser's "half-typed" state for the next edit. */
function markBadInput(input: HTMLInputElement, bad: boolean): void {
  Object.defineProperty(input, "validity", {
    configurable: true,
    value: { badInput: bad, valid: !bad },
  });
}

function Controlled(props: {
  initial?: number | null;
  onChange?: (v: number | null) => void;
  min?: number;
  max?: number;
  blankMeans?: "auto";
  accept?: boolean;
}) {
  // `??` would turn an explicit null (the case under test) back into 12.
  const [value, setValue] = React.useState<number | null>(
    props.initial === undefined ? 12 : props.initial,
  );
  return (
    <NumberField
      testId="n"
      ariaLabel="Value"
      value={value}
      min={props.min}
      max={props.max}
      blankMeans={props.blankMeans}
      onChange={(v) => {
        props.onChange?.(v);
        if (props.accept !== false) setValue(v);
      }}
    />
  );
}

function numberInput(): HTMLInputElement {
  return q<HTMLInputElement>(m.container, "[data-testid='n']");
}

describe("NumberField helpers", () => {
  it("formatNumberFieldValue shows blank for null and strips float noise", () => {
    expect(formatNumberFieldValue(null)).toBe("");
    expect(formatNumberFieldValue(Number.NaN)).toBe("");
    expect(formatNumberFieldValue(12)).toBe("12");
    expect(formatNumberFieldValue(0.1 + 0.2)).toBe("0.3");
    expect(formatNumberFieldValue(-1.25)).toBe("-1.25");
  });

  it("parseNumberFieldText separates blank (null) from half-typed (undefined)", () => {
    expect(parseNumberFieldText("")).toBeNull();
    expect(parseNumberFieldText("  ")).toBeNull();
    expect(parseNumberFieldText("", true)).toBeUndefined();
    expect(parseNumberFieldText("42")).toBe(42);
    expect(parseNumberFieldText("-0.5")).toBe(-0.5);
    expect(parseNumberFieldText("abc")).toBeUndefined();
  });
});

describe("NumberField", () => {
  it("is a 62px number input on the field chrome, with tabular figures", () => {
    m.render(<Controlled />);
    const input = numberInput();
    expect(input.type).toBe("number");
    expect(input.value).toBe("12");
    expect(input.style.width).toBe(`${NUMBER_FIELD_WIDTH}px`);
    expect(input.getAttribute("aria-label")).toBe("Value");
    const cs = getComputedStyle(input);
    expect(cs.height).toBe("28px");
    expect(cs.padding).toBe("0px 8px");
    expect(declared(input, "font-variant-numeric")).toBe("tabular-nums");
    expect(declared(input, "border")).toContain("--control-border");
    expect(ruleBodies(input, ":focus-visible").join(";")).toContain("--focus-ring");
  });

  it("reports each typed number, and null when the box is emptied", () => {
    const onChange = vi.fn();
    m.render(<Controlled onChange={onChange} />);
    typeValue(numberInput(), "15");
    typeValue(numberInput(), "");
    expect(onChange.mock.calls).toEqual([[15], [null]]);
    expect(numberInput().value).toBe("");
  });

  it("never reports half-typed text ('-', '1.') as blank", () => {
    const onChange = vi.fn();
    m.render(<Controlled onChange={onChange} />);
    const input = numberInput();
    markBadInput(input, true);
    typeValue(input, "");
    expect(onChange).not.toHaveBeenCalled();
  });

  it("shows 'auto' for blank when blank means auto, and nothing otherwise", () => {
    m.render(<Controlled initial={null} blankMeans="auto" />);
    expect(numberInput().value).toBe("");
    expect(numberInput().placeholder).toBe("auto");
    m.render(<NumberField testId="n" value={null} onChange={() => {}} />);
    expect(numberInput().placeholder).toBe("");
  });

  it("keeps the draft while focused and shows the committed value after blur", () => {
    const onChange = vi.fn();
    // The caller refuses every change: the committed value stays 12.
    m.render(<Controlled onChange={onChange} accept={false} />);
    const input = numberInput();
    typeValue(input, "15");
    expect(onChange).toHaveBeenCalledWith(15);
    expect(input.value).toBe("15");
    blur(input);
    expect(input.value).toBe("12");
  });

  it("enforces min/max when focus leaves, not while typing", () => {
    const onChange = vi.fn();
    m.render(<Controlled onChange={onChange} min={0} max={100} />);
    const input = numberInput();
    typeValue(input, "900");
    expect(onChange.mock.calls).toEqual([[900]]);
    blur(input);
    expect(onChange.mock.calls).toEqual([[900], [100]]);
    expect(input.value).toBe("100");

    typeValue(input, "-5");
    blur(input);
    expect(onChange).toHaveBeenLastCalledWith(0);
    expect(input.value).toBe("0");
  });

  it("clears half-typed garbage on blur when the committed value is blank", () => {
    // jsdom sanitises a number input's value itself, so the garbage cannot be
    // put on screen here; what can be proven is that the field WRITES "" on
    // blur. React would not: it compares "" (what a browser reports for "1.")
    // with the committed "" and skips the write, leaving "1." displayed.
    m.render(<Controlled initial={null} />);
    const input = numberInput();
    markBadInput(input, true);
    typeValue(input, "");
    const write = vi.spyOn(input, "value", "set");
    blur(input);
    expect(write).toHaveBeenCalledWith("");
    write.mockRestore();

    // A clean blank is left alone.
    markBadInput(input, false);
    const clean = vi.spyOn(input, "value", "set");
    blur(input);
    expect(clean).not.toHaveBeenCalled();
    clean.mockRestore();
  });

  it("labels the input and describes it with its unit", () => {
    m.render(<NumberField testId="n" label="Width" suffix="px" value={20} onChange={() => {}} />);
    const input = numberInput();
    const label = q<HTMLLabelElement>(m.container, "label");
    expect(label.textContent).toBe("Width");
    expect(label.htmlFor).toBe(input.id);
    const suffix = document.getElementById(input.getAttribute("aria-describedby")!)!;
    expect(suffix.textContent).toBe("px");
    expect(declared(suffix, "color")).toContain("--text-secondary");
  });

  it("routes the ref and HTML props to the input, className/style to the row, and chains onBlur", () => {
    const ref = React.createRef<HTMLInputElement>();
    const onBlur = vi.fn();
    m.render(
      <NumberField
        ref={ref}
        testId="n"
        name="gap"
        width={80}
        className="caller"
        style={{ marginLeft: 4 }}
        value={1}
        onBlur={onBlur}
        onChange={() => {}}
      />,
    );
    const input = numberInput();
    expect(ref.current).toBe(input);
    expect(input.name).toBe("gap");
    expect(input.style.width).toBe("80px");
    const row = input.parentElement!;
    expect(row.classList.contains("caller")).toBe(true);
    expect(row.style.marginLeft).toBe("4px");
    blur(input);
    expect(onBlur).toHaveBeenCalledTimes(1);
  });
});

// ============================================================================
// Colours
// ============================================================================

describe("fields: colours", () => {
  it.each(LAYOUTS)("paint no hardcoded colour in the %s", (_name, layout) => {
    m.render(
      <FieldGrid>
        <Field label="Name">
          <Input placeholder="Sales" />
        </Field>
        <Field label="Font">
          <Select defaultValue="a">
            <option value="a">Calibri</option>
          </Select>
        </Field>
        <Field label="Gap">
          <NumberField value={null} blankMeans="auto" suffix="%" onChange={() => {}} />
        </Field>
        <Input disabled />
        <Select disabled multiple>
          <option value="a">A</option>
        </Select>
      </FieldGrid>,
      layout,
    );
    expect(hardcodedColours(m.container)).toEqual([]);
  });

  it("is the same chrome in a launcher popover", () => {
    m.render(<NumberField testId="n" value={3} onChange={() => {}} />, popoverLayout(300));
    expect(getComputedStyle(numberInput()).height).toBe("28px");
  });
});
