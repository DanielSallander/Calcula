// Tests for the @api/layout toggles: Checkbox and Switch. Both keep a REAL
// <input type="checkbox"> (so the browser owns the semantics and E2E can read
// `checked`), both fill exactly one 28px band row (the fill rule's 28 + 5 + 28),
// and both paint only with theme tokens — including the white tick, which is
// LT.onAccent and never a literal.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import React, { act } from "react";
import { bandLayout, panelLayout } from "../context";
import { TOOLTIP_DELAY_MS } from "../tokens";
import { Checkbox, Switch } from "../primitives/toggles";
import {
  LAYOUTS,
  click,
  declared,
  hardcodedColours,
  hover,
  mount,
  q,
  ruleBodies,
  type Mount,
} from "./formControlsKit";

let m: Mount;

beforeEach(() => {
  m = mount();
});

afterEach(() => {
  m.unmount();
  vi.useRealTimers();
});

/** A controlled harness: the toggle state lives in React, as in a real pane. */
function ControlledCheckbox(props: { initial?: boolean; indeterminate?: boolean; spy?: (v: boolean) => void }) {
  const [checked, setChecked] = React.useState(props.initial ?? false);
  return (
    <Checkbox
      testId="cb"
      label="Gridlines"
      checked={checked}
      indeterminate={props.indeterminate}
      onChange={(v) => {
        props.spy?.(v);
        setChecked(v);
      }}
    />
  );
}

// ============================================================================
// Checkbox
// ============================================================================

describe("Checkbox", () => {
  it("is a real checkbox input inside a <label>, so clicking the text toggles it", () => {
    const spy = vi.fn();
    m.render(<ControlledCheckbox spy={spy} />);
    const input = q<HTMLInputElement>(m.container, "[data-testid='cb']");
    expect(input.tagName).toBe("INPUT");
    expect(input.type).toBe("checkbox");
    const label = input.closest("label")!;
    expect(label).not.toBeNull();
    expect(label.textContent).toBe("Gridlines");

    click(label.querySelector("span")!);
    expect(spy).toHaveBeenLastCalledWith(true);
    expect(input.checked).toBe(true);

    click(input);
    expect(spy).toHaveBeenLastCalledWith(false);
    expect(input.checked).toBe(false);
  });

  it("is controlled: the checked prop is what shows", () => {
    const onChange = vi.fn();
    m.render(<Checkbox testId="cb" label="Legend" checked onChange={onChange} />);
    const input = q<HTMLInputElement>(m.container, "[data-testid='cb']");
    expect(input.checked).toBe(true);
    click(input);
    expect(onChange).toHaveBeenCalledWith(false);
    // The caller did not accept the change, so the box stays ticked.
    expect(input.checked).toBe(true);
  });

  it("fills exactly one 28px band row at 11px", () => {
    m.render(<Checkbox testId="cb" label="Title" checked={false} onChange={() => {}} />, bandLayout());
    const label = q(m.container, "label");
    const cs = getComputedStyle(label);
    expect(cs.height).toBe("28px");
    expect(cs.fontSize).toBe("11px");
    expect(cs.gap).toBe("7px");
  });

  it("is at least one 28px row at 12px in the panel, and its label may wrap", () => {
    m.render(<Checkbox testId="cb" label="Title" checked={false} onChange={() => {}} />, panelLayout(300));
    const label = q(m.container, "label");
    const cs = getComputedStyle(label);
    expect(cs.minHeight).toBe("28px");
    expect(cs.height).not.toBe("28px");
    expect(cs.fontSize).toBe("12px");
    const text = label.querySelector("span")!;
    expect(getComputedStyle(text).whiteSpace).not.toBe("nowrap");
  });

  it("draws the 16px box with the control tokens, not the OS checkbox", () => {
    m.render(<Checkbox testId="cb" label="Title" checked={false} onChange={() => {}} />);
    const input = q(m.container, "[data-testid='cb']");
    const cs = getComputedStyle(input);
    expect(cs.width).toBe("16px");
    expect(cs.height).toBe("16px");
    expect(cs.borderRadius).toBe("4px");
    expect(declared(input, "appearance")).toBe("none");
    expect(declared(input, "border")).toContain("--control-border");
    expect(declared(input, "background")).toContain("--bg-surface");
  });

  it("fills with the state accent when checked and draws the tick in LT.onAccent", () => {
    m.render(<Checkbox testId="cb" label="Title" checked onChange={() => {}} />);
    const input = q(m.container, "[data-testid='cb']");
    expect(declared(input, "background")).toContain("--state-accent");
    const tick = ruleBodies(input, ":checked::after").join(";");
    expect(tick).toContain("border-left:2px solid var(--badge-fg");
    expect(tick).toContain("border-bottom:2px solid var(--badge-fg");
    expect(tick).toContain("rotate(-45deg)");
  });

  it("shows the focus ring only on keyboard focus", () => {
    m.render(<Checkbox testId="cb" label="Title" checked={false} onChange={() => {}} />);
    const input = q(m.container, "[data-testid='cb']");
    const ring = ruleBodies(input, ":focus-visible").join(";");
    expect(ring).toContain("--focus-ring");
    expect(ruleBodies(input, ":focus{").length + ruleBodies(input, ":focus ").length).toBe(0);
  });

  it("sets the DOM-only indeterminate property and re-asserts it after a click", () => {
    const spy = vi.fn();
    m.render(<ControlledCheckbox indeterminate spy={spy} />);
    const input = q<HTMLInputElement>(m.container, "[data-testid='cb']");
    expect(input.indeterminate).toBe(true);
    expect(input.matches(":indeterminate")).toBe(true);
    // A click clears it natively; the caller still says "mixed".
    click(input);
    expect(spy).toHaveBeenCalledWith(true);
    expect(input.indeterminate).toBe(true);
    expect(ruleBodies(input, ":indeterminate::after").join(";")).toContain("--badge-fg");
  });

  it("clears indeterminate when the caller stops passing it", () => {
    m.render(<Checkbox testId="cb" label="All" checked={false} indeterminate onChange={() => {}} />);
    const input = q<HTMLInputElement>(m.container, "[data-testid='cb']");
    expect(input.indeterminate).toBe(true);
    m.render(<Checkbox testId="cb" label="All" checked={false} onChange={() => {}} />);
    expect(input.indeterminate).toBe(false);
  });

  it("disabled uses the one disabled idiom on the row and does not toggle", () => {
    const onChange = vi.fn();
    m.render(<Checkbox testId="cb" label="Title" checked={false} disabled onChange={onChange} />);
    const input = q<HTMLInputElement>(m.container, "[data-testid='cb']");
    const label = input.closest("label")!;
    expect(input.disabled).toBe(true);
    expect(label.getAttribute("data-disabled")).toBe("true");
    expect(getComputedStyle(label).opacity).toBe("0.5");
    expect(getComputedStyle(label).cursor).toBe("default");
    click(label);
    expect(onChange).not.toHaveBeenCalled();
  });

  it("routes HTML props and the ref to the input, className and style to the row", () => {
    const ref = React.createRef<HTMLInputElement>();
    m.render(
      <Checkbox
        ref={ref}
        id="show-legend"
        name="legend"
        aria-label="Show legend"
        className="my-row"
        style={{ marginLeft: 3 }}
        label="Legend"
        checked={false}
        onChange={() => {}}
      />,
    );
    const input = q<HTMLInputElement>(m.container, "#show-legend");
    expect(ref.current).toBe(input);
    expect(input.name).toBe("legend");
    expect(input.getAttribute("aria-label")).toBe("Show legend");
    const label = input.closest("label")!;
    expect(label.classList.contains("my-row")).toBe(true);
    expect(label.style.marginLeft).toBe("3px");
  });

  it("shows a tooltip on hover and describes the input with the same text", () => {
    vi.useFakeTimers();
    m.render(
      <Checkbox testId="cb" label="Legend" tooltip="Show the series names" checked={false} onChange={() => {}} />,
    );
    const input = q<HTMLInputElement>(m.container, "[data-testid='cb']");
    const describedBy = input.getAttribute("aria-describedby")!;
    expect(describedBy).toBeTruthy();
    const description = document.getElementById(describedBy)!;
    expect(description.textContent).toBe("Show the series names");
    expect(description.hidden).toBe(true);

    hover(input.closest("label")!);
    act(() => {
      vi.advanceTimersByTime(TOOLTIP_DELAY_MS);
    });
    expect(document.querySelector("[role='tooltip']")?.textContent).toBe("Show the series names");
  });

  it("carries no description and no tooltip when none is given", () => {
    m.render(<Checkbox testId="cb" label="Legend" checked={false} onChange={() => {}} />);
    const input = q(m.container, "[data-testid='cb']");
    expect(input.hasAttribute("aria-describedby")).toBe(false);
    expect(m.container.querySelector("[hidden]")).toBeNull();
  });

  it.each(LAYOUTS)("paints no hardcoded colour in the %s", (_name, layout) => {
    m.render(
      <>
        <Checkbox label="Off" checked={false} onChange={() => {}} />
        <Checkbox label="On" checked onChange={() => {}} />
        <Checkbox label="Mixed" checked={false} indeterminate onChange={() => {}} />
        <Checkbox label="Disabled" checked disabled onChange={() => {}} />
        <Checkbox label="Tip" tooltip="Explained" checked onChange={() => {}} />
      </>,
      layout,
    );
    expect(hardcodedColours(m.container)).toEqual([]);
  });
});

// ============================================================================
// Switch
// ============================================================================

function ControlledSwitch(props: { spy?: (v: boolean) => void }) {
  const [checked, setChecked] = React.useState(false);
  return (
    <Switch
      testId="sw"
      label="2nd axis"
      checked={checked}
      onChange={(v) => {
        props.spy?.(v);
        setChecked(v);
      }}
    />
  );
}

describe("Switch", () => {
  it("is a real checkbox with role=switch, toggled by clicking anywhere on the row", () => {
    const spy = vi.fn();
    m.render(<ControlledSwitch spy={spy} />);
    const input = q<HTMLInputElement>(m.container, "[data-testid='sw']");
    expect(input.type).toBe("checkbox");
    expect(input.getAttribute("role")).toBe("switch");
    expect(input.closest("label")?.textContent).toBe("2nd axis");
    click(input.closest("label")!);
    expect(spy).toHaveBeenLastCalledWith(true);
    expect(input.checked).toBe(true);
  });

  it("keeps the input as an invisible layer over the whole row (clickable, never zero-size)", () => {
    m.render(<Switch testId="sw" label="On" checked={false} onChange={() => {}} />);
    const input = q(m.container, "[data-testid='sw']");
    const cs = getComputedStyle(input);
    expect(cs.position).toBe("absolute");
    expect(cs.opacity).toBe("0");
    expect(cs.width).toBe("100%");
    expect(cs.height).toBe("100%");
    expect(getComputedStyle(input.closest("label")!).position).toBe("relative");
  });

  it("draws a 30x16 track with a 12px thumb in the control tokens", () => {
    m.render(<Switch testId="sw" label="On" checked={false} onChange={() => {}} />);
    const track = q(m.container, "[data-testid='sw'] + span");
    expect(track.getAttribute("aria-hidden")).toBe("true");
    const cs = getComputedStyle(track);
    expect(cs.width).toBe("30px");
    expect(cs.height).toBe("16px");
    expect(declared(track, "background")).toContain("--control-track");
    const thumb = ruleBodies(track, "::after").join(";");
    expect(thumb).toContain("width:12px");
    expect(thumb).toContain("--badge-fg");
    expect(thumb).toContain("transition:transform");
  });

  it("fills the track with the state accent and slides the thumb when on", () => {
    m.render(<Switch testId="sw" label="On" checked onChange={() => {}} />);
    const input = q(m.container, "[data-testid='sw']");
    const onTrack = ruleBodies(input, ":checked+").join(";");
    expect(onTrack).toContain("--state-accent");
    expect(onTrack).toContain("translateX(14px)");
    const track = q(m.container, "[data-testid='sw'] + span");
    expect(declared(track, "background")).toContain("--state-accent");
  });

  it("rings the TRACK on keyboard focus, since the input itself is invisible", () => {
    m.render(<Switch testId="sw" label="On" checked={false} onChange={() => {}} />);
    const input = q(m.container, "[data-testid='sw']");
    expect(ruleBodies(input, ":focus-visible+").join(";")).toContain("--focus-ring");
  });

  it("fills exactly one 28px band row at 11px, and at least one 28px row in the panel", () => {
    m.render(<Switch testId="sw" label="On" checked={false} onChange={() => {}} />, bandLayout());
    let cs = getComputedStyle(q(m.container, "label"));
    expect(cs.height).toBe("28px");
    expect(cs.fontSize).toBe("11px");
    m.render(<Switch testId="sw" label="On" checked={false} onChange={() => {}} />, panelLayout(300));
    cs = getComputedStyle(q(m.container, "label"));
    expect(cs.minHeight).toBe("28px");
    expect(cs.fontSize).toBe("12px");
  });

  it("disabled dims the row and does not toggle", () => {
    const onChange = vi.fn();
    m.render(<Switch testId="sw" label="On" checked={false} disabled onChange={onChange} />);
    const input = q<HTMLInputElement>(m.container, "[data-testid='sw']");
    const label = input.closest("label")!;
    expect(getComputedStyle(label).opacity).toBe("0.5");
    click(label);
    expect(onChange).not.toHaveBeenCalled();
  });

  it("forwards its ref to the input", () => {
    const ref = React.createRef<HTMLInputElement>();
    m.render(<Switch ref={ref} testId="sw" label="On" checked={false} onChange={() => {}} />);
    expect(ref.current).toBe(q(m.container, "[data-testid='sw']"));
  });

  it.each(LAYOUTS)("paints no hardcoded colour in the %s", (_name, layout) => {
    m.render(
      <>
        <Switch label="Off" checked={false} onChange={() => {}} />
        <Switch label="On" checked onChange={() => {}} />
        <Switch label="Disabled" checked disabled onChange={() => {}} />
      </>,
      layout,
    );
    expect(hardcodedColours(m.container)).toEqual([]);
  });
});
