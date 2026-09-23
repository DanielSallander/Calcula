// Tests for the @api/layout Slider: label + 5px token track + monospace
// readout on one 28px row; the filled part is an inline gradient of two LT
// tokens computed from the value; onChange fires per step and onCommit ONCE
// per interaction, only when the value moved (one document write, one undo
// entry). Scanned for hardcoded colours under band, panel and popover.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import React from "react";
import { bandLayout, panelLayout } from "../context";
import {
  SLIDER_BAND_WIDTH,
  Slider,
  formatSliderValue,
  sliderFillPercent,
  sliderTrackBackground,
} from "../primitives/Slider";
import {
  LAYOUTS,
  blur,
  declared,
  fire,
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

/** A controlled slider whose value lives in React, as in a real pane. */
function Controlled(props: {
  initial?: number;
  onChange?: (v: number) => void;
  onCommit?: (v: number) => void;
}) {
  const [value, setValue] = React.useState(props.initial ?? 150);
  return (
    <Slider
      testId="s"
      label="Gap"
      suffix="%"
      min={0}
      max={500}
      step={10}
      value={value}
      onChange={(v) => {
        props.onChange?.(v);
        setValue(v);
      }}
      onCommit={props.onCommit}
    />
  );
}

function range(): HTMLInputElement {
  return q<HTMLInputElement>(m.container, "[data-testid='s']");
}

// ============================================================================
// Pure helpers
// ============================================================================

describe("slider helpers", () => {
  it("sliderFillPercent maps the value onto 0..100 and clamps", () => {
    expect(sliderFillPercent(150, 0, 500)).toBe(30);
    expect(sliderFillPercent(-5, 0, 10)).toBe(0);
    expect(sliderFillPercent(50, 0, 10)).toBe(100);
    expect(sliderFillPercent(7, 7, 20)).toBe(0);
  });

  it("sliderFillPercent reads a degenerate range as empty, never NaN", () => {
    expect(sliderFillPercent(5, 10, 10)).toBe(0);
    expect(sliderFillPercent(5, 10, 0)).toBe(0);
    expect(sliderFillPercent(Number.NaN, 0, 10)).toBe(0);
  });

  it("formatSliderValue uses the step's precision and a spaced suffix", () => {
    expect(formatSliderValue(150, 1, "%")).toBe("150 %");
    expect(formatSliderValue(10, 1, "px")).toBe("10 px");
    expect(formatSliderValue(0.1 + 0.2, 0.1)).toBe("0.3");
    expect(formatSliderValue(0.5, 0.05)).toBe("0.50");
    expect(formatSliderValue(0.1 + 0.2)).toBe("0.3");
    expect(formatSliderValue(20, 10)).toBe("20");
  });

  it("sliderTrackBackground paints accent up to the value and track after it, from tokens", () => {
    const bg = sliderTrackBackground(30);
    expect(bg).toMatch(/^linear-gradient\(to right, var\(--state-accent[^)]*\) 0 30%, var\(--control-track[^)]*\) 30% 100%\)$/);
  });
});

// ============================================================================
// Component
// ============================================================================

describe("Slider", () => {
  it("renders label, range and readout on one 28px row with an 8px gap", () => {
    m.render(<Controlled />);
    const input = range();
    const row = input.parentElement!;
    const label = q<HTMLLabelElement>(row, "label");
    expect(label.textContent).toBe("Gap");
    expect(label.htmlFor).toBe(input.id);
    expect(input.type).toBe("range");
    expect(input.value).toBe("150");
    const cs = getComputedStyle(row);
    expect(cs.height).toBe("28px");
    expect(cs.gap).toBe("8px");
    expect(getComputedStyle(label).fontSize).toBe("12px");
    expect(declared(label, "color")).toContain("--text-secondary");
  });

  it("fills the track from the value with two tokens (inline gradient)", () => {
    m.render(<Controlled initial={150} />);
    const bg = range().style.background;
    expect(bg).toContain("--state-accent");
    expect(bg).toContain("--control-track");
    expect(bg).toContain("30%");
    typeValue(range(), "250");
    expect(range().style.background).toContain("50%");
  });

  it("draws a 5px token track and a 16px surface thumb with the control border", () => {
    m.render(<Controlled />);
    const input = range();
    const cs = getComputedStyle(input);
    expect(cs.height).toBe("5px");
    expect(declared(input, "appearance")).toBe("none");
    const thumb = ruleBodies(input, "::-webkit-slider-thumb").join(";");
    expect(thumb).toContain("width:16px");
    expect(thumb).toContain("height:16px");
    expect(thumb).toContain("--bg-surface");
    expect(thumb).toContain("--control-border");
    expect(thumb).toContain("--shadow-cluster-hover");
    expect(ruleBodies(input, ":focus-visible::-webkit-slider-thumb").join(";")).toContain("--focus-ring");
  });

  it("shows a monospace, tabular, aria-hidden readout with the suffix", () => {
    m.render(<Controlled />);
    const output = q(m.container, "output");
    expect(output.textContent).toBe("150 %");
    expect(output.getAttribute("aria-hidden")).toBe("true");
    expect(output.getAttribute("for")).toBe(range().id);
    const cs = getComputedStyle(output);
    expect(cs.fontSize).toBe("11px");
    expect(cs.minWidth).toBe("34px");
    expect(cs.fontFamily).toContain("Cascadia Code");
    expect(declared(output, "font-variant-numeric")).toBe("tabular-nums");
    // The readout's text reaches assistive tech through the input instead.
    expect(range().getAttribute("aria-valuetext")).toBe("150 %");
  });

  it("omits the readout when readout={false}", () => {
    m.render(<Slider value={3} min={0} max={10} onChange={() => {}} readout={false} ariaLabel="Speed" />);
    expect(m.container.querySelector("output")).toBeNull();
    expect(q(m.container, "input").getAttribute("aria-label")).toBe("Speed");
  });

  it("is a 104px track in the band and fills the row in the panel", () => {
    m.render(<Controlled />, bandLayout());
    expect(range().style.width).toBe(`${SLIDER_BAND_WIDTH}px`);
    expect(getComputedStyle(range().parentElement!).display).toBe("inline-flex");

    m.render(<Controlled />, panelLayout(300));
    expect(range().style.width).toBe("");
    expect(getComputedStyle(range()).flexGrow).toBe("1");
    const row = getComputedStyle(range().parentElement!);
    expect(row.display).toBe("flex");
    expect(row.width).toBe("100%");
  });

  it("honours an explicit width on every surface", () => {
    m.render(<Slider testId="s" value={3} min={0} max={10} width={80} onChange={() => {}} />, panelLayout(300));
    expect(range().style.width).toBe("80px");
    expect(getComputedStyle(range()).flexGrow).not.toBe("1");
  });

  it("reports every step through onChange as a number", () => {
    const onChange = vi.fn();
    m.render(<Controlled onChange={onChange} />);
    typeValue(range(), "160");
    typeValue(range(), "170");
    expect(onChange.mock.calls).toEqual([[160], [170]]);
  });

  it("commits ONCE when a drag ends, with the final value", () => {
    const onCommit = vi.fn();
    m.render(<Controlled onCommit={onCommit} />);
    const input = range();
    fire(input, "pointerdown");
    typeValue(input, "160");
    typeValue(input, "200");
    expect(onCommit).not.toHaveBeenCalled();
    fire(input, "pointerup");
    expect(onCommit.mock.calls).toEqual([[200]]);
    // The blur that follows the release does not commit a second time.
    blur(input);
    expect(onCommit).toHaveBeenCalledTimes(1);
  });

  it("does not commit an interaction that ends where it began", () => {
    const onCommit = vi.fn();
    m.render(<Controlled onCommit={onCommit} />);
    const input = range();
    fire(input, "pointerdown");
    typeValue(input, "200");
    typeValue(input, "150");
    fire(input, "pointerup");
    expect(onCommit).not.toHaveBeenCalled();
  });

  it("commits on keyup of a value key, and ignores keys that do not move it", () => {
    const onCommit = vi.fn();
    m.render(<Controlled onCommit={onCommit} />);
    const input = range();
    // Tabbing in: the keyup lands here, the keydown did not.
    fire(input, "keyup", { key: "Tab" });
    expect(onCommit).not.toHaveBeenCalled();

    fire(input, "keydown", { key: "ArrowRight" });
    typeValue(input, "160");
    // Auto-repeat keeps the ORIGINAL start value.
    fire(input, "keydown", { key: "ArrowRight", repeat: true });
    typeValue(input, "170");
    fire(input, "keyup", { key: "ArrowRight" });
    expect(onCommit.mock.calls).toEqual([[170]]);
  });

  it("commits on blur when the release was never seen (pointer let go elsewhere)", () => {
    const onCommit = vi.fn();
    m.render(<Controlled onCommit={onCommit} />);
    const input = range();
    fire(input, "pointerdown");
    typeValue(input, "300");
    blur(input);
    expect(onCommit.mock.calls).toEqual([[300]]);
  });

  it("chains the caller's own pointer/key/blur handlers", () => {
    const onPointerUp = vi.fn();
    const onKeyUp = vi.fn();
    const onBlur = vi.fn();
    m.render(
      <Slider
        testId="s"
        value={1}
        min={0}
        max={10}
        onChange={() => {}}
        onPointerUp={onPointerUp}
        onKeyUp={onKeyUp}
        onBlur={onBlur}
      />,
    );
    fire(range(), "pointerup");
    fire(range(), "keyup", { key: "ArrowLeft" });
    blur(range());
    expect(onPointerUp).toHaveBeenCalledTimes(1);
    expect(onKeyUp).toHaveBeenCalledTimes(1);
    expect(onBlur).toHaveBeenCalledTimes(1);
  });

  it("disabled dims the row with the one disabled idiom", () => {
    m.render(<Slider testId="s" value={1} min={0} max={10} onChange={() => {}} disabled label="Gap" />);
    expect(range().disabled).toBe(true);
    const row = range().parentElement!;
    expect(row.getAttribute("data-disabled")).toBe("true");
    expect(getComputedStyle(row).opacity).toBe("0.5");
  });

  it("routes the ref and HTML props to the input, className/style to the row", () => {
    const ref = React.createRef<HTMLInputElement>();
    m.render(
      <Slider
        ref={ref}
        id="gap"
        name="gap"
        className="my-row"
        style={{ marginTop: 2 }}
        value={1}
        min={0}
        max={10}
        onChange={() => {}}
        label="Gap"
      />,
    );
    const input = q<HTMLInputElement>(m.container, "#gap");
    expect(ref.current).toBe(input);
    expect(input.name).toBe("gap");
    expect(q<HTMLLabelElement>(m.container, "label").htmlFor).toBe("gap");
    const row = input.parentElement!;
    expect(row.classList.contains("my-row")).toBe(true);
    expect(row.style.marginTop).toBe("2px");
  });

  it.each(LAYOUTS)("paints no hardcoded colour in the %s", (_name, layout) => {
    m.render(
      <>
        <Slider value={150} min={0} max={500} label="Gap" suffix="%" onChange={() => {}} />
        <Slider value={0} min={0} max={10} ariaLabel="Speed" onChange={() => {}} readout={false} />
        <Slider value={10} min={0} max={10} label="Size" disabled onChange={() => {}} />
      </>,
      layout,
    );
    expect(hardcodedColours(m.container)).toEqual([]);
  });
});
