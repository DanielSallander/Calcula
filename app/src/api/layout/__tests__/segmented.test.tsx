// Tests for the pill primitives: Segmented (a joined run of controls),
// SegmentedChoice (the pill as a WAI-ARIA radio group) and SegmentedTabs (the
// pill as a WAI-ARIA tablist). The keyboard model is part of their API, so it
// is pinned here key by key; the chrome is pinned through the rule text
// (jsdom's getComputedStyle cannot resolve var() shorthands), and every one is
// rendered under band AND panel geometry and scanned for hardcoded colours.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import React, { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { SurfaceLayoutProvider, bandLayout, panelLayout, type SurfaceLayout } from "../context";
import { IconButton, ToggleButton } from "../primitives/Button";
import {
  Segmented,
  SegmentedChoice,
  type SegmentedChoiceOption,
} from "../primitives/Segmented";
import { SegmentedTabs } from "../primitives/SegmentedTabs";
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
  vi.useRealTimers();
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

function key(el: Element, k: string): void {
  act(() => {
    el.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true }));
  });
}

function q<T extends Element = HTMLElement>(selector: string): T {
  const el = container.querySelector(selector);
  if (!el) throw new Error(`no element for ${selector}`);
  return el as T;
}

const LAYOUTS: Array<[string, SurfaceLayout]> = [
  ["band", bandLayout()],
  ["panel", panelLayout(300)],
];

const Icon = ({ size = 20 }: { size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden>
    <rect x="3" y="3" width="18" height="18" rx="2" fill="currentColor" />
  </svg>
);

// ============================================================================
// Segmented
// ============================================================================

describe("Segmented", () => {
  const emphasis = (props: Partial<React.ComponentProps<typeof Segmented>> = {}) => (
    <Segmented ariaLabel="Emphasis" data-testid="seg" {...props}>
      <ToggleButton active data-testid="b">
        B
      </ToggleButton>
      <ToggleButton active={false} data-testid="i">
        I
      </ToggleButton>
      <ToggleButton active={false} data-testid="u">
        U
      </ToggleButton>
    </Segmented>
  );

  it("is a named group whose border is an inset shadow (outer height == children)", () => {
    render(emphasis());
    const seg = q("[data-testid='seg']");
    expect(seg.getAttribute("role")).toBe("group");
    expect(seg.getAttribute("aria-label")).toBe("Emphasis");
    expect(getComputedStyle(seg).display).toBe("inline-flex");
    expect(getComputedStyle(seg).alignItems).toBe("stretch");
    expect(declared(seg, "box-shadow")).toMatch(/^inset 0 0 0 1px var\(--control-border/);
    expect(declared(seg, "border-radius")).toContain("--radius-control");
    expect(declared(seg, "background")).toContain("--bg-surface");
    expect(declared(seg, "border")).toBe("");
  });

  it("role is overridable and HTML props pass through", () => {
    const onKeyDown = vi.fn();
    render(emphasis({ role: "radiogroup", className: "extra", onKeyDown }));
    const seg = q("[data-testid='seg']");
    expect(seg.getAttribute("role")).toBe("radiogroup");
    expect(seg.classList.contains("extra")).toBe(true);
    key(q("[data-testid='b']"), "x");
    expect(onKeyDown).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["sm", "24px"],
    ["md", "28px"],
    ["tall", "61px"],
  ] as const)("size %s pins the pill height to %s", (size, height) => {
    render(emphasis({ size }));
    expect(q("[data-testid='seg']").style.height).toBe(height);
  });

  it("size auto (the default) lets the children decide", () => {
    render(emphasis());
    expect(q("[data-testid='seg']").style.height).toBe("");
  });

  it("squares inner corners and rounds only the ends", () => {
    render(emphasis());
    const [b, i, u] = ["b", "i", "u"].map((id) => q(`[data-testid='${id}']`));
    expect(declared(i, "border-radius")).toBe("0");
    expect(declared(b, "border-top-left-radius")).toContain("--radius-control");
    expect(declared(b, "border-bottom-left-radius")).toContain("--radius-control");
    expect(declared(b, "border-top-right-radius")).toBe("");
    expect(declared(u, "border-top-right-radius")).toContain("--radius-control");
    expect(declared(u, "border-bottom-right-radius")).toContain("--radius-control");
  });

  it("draws a divider before every child but the first", () => {
    render(emphasis());
    expect(declared(q("[data-testid='b']"), "box-shadow")).not.toContain("--control-divider");
    expect(declared(q("[data-testid='i']"), "box-shadow")).toContain("--control-divider");
    expect(declared(q("[data-testid='u']"), "box-shadow")).toContain("--control-divider");
  });

  it("restates the focus ring above the divider rule", () => {
    render(emphasis());
    const text = Array.from(document.querySelectorAll("style"))
      .map((s) => s.textContent ?? "")
      .join("\n");
    const cls = q("[data-testid='seg']").className.split(/\s+/)[0];
    const divider = text.indexOf(`.${cls}.${cls}>*+*{`);
    const ring = text.indexOf(`.${cls}.${cls}>*:focus-visible{`);
    expect(divider).toBeGreaterThanOrEqual(0);
    expect(ring).toBeGreaterThan(divider);
  });

  it("paints pressed children with the pressed wash", () => {
    render(emphasis());
    expect(declared(q("[data-testid='b']"), "background")).toContain("--button-pressed-bg");
    expect(declared(q("[data-testid='i']"), "background")).not.toContain("--button-pressed-bg");
  });

  it("rounds a split toggle's outer halves only", () => {
    render(
      <Segmented ariaLabel="Chart elements" size="tall">
        <IconButton icon={<Icon size={28} />} label="Title" size="tall" split onChevronClick={() => undefined} />
        <IconButton icon={<Icon size={28} />} label="Gridlines" size="tall" pressed />
        <IconButton icon={<Icon size={28} />} label="Legend" size="tall" split onChevronClick={() => undefined} />
      </Segmented>,
    );
    const [firstMain, firstChev, middle, lastMain, lastChev] = Array.from(
      container.querySelectorAll("button"),
    );
    // Every half is squared by the shorthand; only the pill's two ends get a
    // longhand radius back.
    for (const half of [firstMain, firstChev, lastMain, lastChev]) {
      expect(declared(half, "border-radius")).toBe("0");
    }
    expect(declared(middle, "border-radius")).toBe("0");
    expect(declared(firstMain, "border-top-left-radius")).toContain("--radius-control");
    expect(declared(firstMain, "border-bottom-left-radius")).toContain("--radius-control");
    expect(declared(firstChev, "border-top-right-radius")).not.toContain("--radius-control");
    expect(declared(lastMain, "border-top-left-radius")).not.toContain("--radius-control");
    expect(declared(lastChev, "border-top-right-radius")).toContain("--radius-control");
    expect(declared(lastChev, "border-bottom-right-radius")).toContain("--radius-control");
  });

  it.each(LAYOUTS)("paints no hardcoded colour in the %s", (_name, layout) => {
    render(
      <>
        {emphasis()}
        <Segmented ariaLabel="Elements" size="tall">
          <IconButton icon={<Icon size={28} />} label="Title" size="tall" split pressed onChevronClick={() => undefined} />
          <IconButton icon={<Icon size={28} />} label="Gridlines" size="tall" />
        </Segmented>
      </>,
      layout,
    );
    expect(hardcodedColours(container)).toEqual([]);
  });
});

// ============================================================================
// SegmentedChoice
// ============================================================================

type Stacking = "grouped" | "stacked" | "percent";

const STACKING: SegmentedChoiceOption<Stacking>[] = [
  { value: "grouped", label: "Grouped", icon: <Icon />, testId: "opt-grouped" },
  { value: "stacked", label: "Stacked", icon: <Icon />, testId: "opt-stacked" },
  { value: "percent", label: "100% stacked", icon: <Icon />, testId: "opt-percent" },
];

/** A controlled harness, the way real callers hold the value. */
function Choice({
  initial = "grouped" as Stacking,
  options = STACKING,
  onChange,
  ...rest
}: Partial<React.ComponentProps<typeof SegmentedChoice<Stacking>>> & {
  initial?: Stacking;
}): React.ReactElement {
  const [value, setValue] = useState<Stacking>(initial);
  return (
    <SegmentedChoice<Stacking>
      ariaLabel="Stacking"
      testId="choice"
      {...rest}
      options={options}
      value={value}
      onChange={(v) => {
        setValue(v);
        onChange?.(v);
      }}
    />
  );
}

function radios(): HTMLButtonElement[] {
  return Array.from(container.querySelectorAll<HTMLButtonElement>("[role='radio']"));
}

describe("SegmentedChoice", () => {
  it("is a radiogroup of radio buttons with one checked", () => {
    render(<Choice />);
    const group = q("[data-testid='choice']");
    expect(group.getAttribute("role")).toBe("radiogroup");
    expect(group.getAttribute("aria-label")).toBe("Stacking");
    expect(radios().map((r) => r.getAttribute("aria-checked"))).toEqual(["true", "false", "false"]);
    expect(radios().every((r) => !r.hasAttribute("aria-pressed"))).toBe(true);
  });

  it("has exactly one tab stop: the checked option", () => {
    render(<Choice initial="stacked" />);
    expect(radios().map((r) => r.tabIndex)).toEqual([-1, 0, -1]);
  });

  it("falls back to the first enabled option as the tab stop when nothing matches", () => {
    const options: SegmentedChoiceOption<Stacking>[] = [
      { ...STACKING[0], disabled: true },
      STACKING[1],
      STACKING[2],
    ];
    render(
      <SegmentedChoice<Stacking>
        ariaLabel="Stacking"
        options={options}
        value={"nothing" as Stacking}
        onChange={() => undefined}
      />,
    );
    expect(radios().map((r) => r.tabIndex)).toEqual([-1, 0, -1]);
  });

  it("a click selects, and clicking the checked option changes nothing", () => {
    const onChange = vi.fn();
    render(<Choice onChange={onChange} />);
    click(q("[data-testid='opt-stacked']"));
    expect(onChange).toHaveBeenCalledWith("stacked");
    expect(radios()[1].getAttribute("aria-checked")).toBe("true");
    click(q("[data-testid='opt-stacked']"));
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it("ArrowRight/ArrowDown move focus AND select; the end wraps to the start", () => {
    const onChange = vi.fn();
    render(<Choice onChange={onChange} />);
    const [a, b, c] = radios();
    act(() => a.focus());
    key(a, "ArrowRight");
    expect(document.activeElement).toBe(b);
    expect(onChange).toHaveBeenLastCalledWith("stacked");
    key(b, "ArrowDown");
    expect(document.activeElement).toBe(c);
    expect(onChange).toHaveBeenLastCalledWith("percent");
    key(c, "ArrowRight");
    expect(document.activeElement).toBe(a);
    expect(onChange).toHaveBeenLastCalledWith("grouped");
    expect(radios().map((r) => r.tabIndex)).toEqual([0, -1, -1]);
  });

  it("ArrowLeft/ArrowUp move backwards and wrap; Home/End jump", () => {
    const onChange = vi.fn();
    render(<Choice onChange={onChange} />);
    const [a, b, c] = radios();
    act(() => a.focus());
    key(a, "ArrowLeft");
    expect(document.activeElement).toBe(c);
    key(c, "ArrowUp");
    expect(document.activeElement).toBe(b);
    key(b, "Home");
    expect(document.activeElement).toBe(a);
    key(a, "End");
    expect(document.activeElement).toBe(c);
    expect(onChange.mock.calls.map((call) => call[0])).toEqual(["percent", "stacked", "grouped", "percent"]);
  });

  it("skips disabled options", () => {
    const options: SegmentedChoiceOption<Stacking>[] = [
      STACKING[0],
      { ...STACKING[1], disabled: true },
      STACKING[2],
    ];
    const onChange = vi.fn();
    render(<Choice options={options} onChange={onChange} />);
    const [a, b, c] = radios();
    expect(b.disabled).toBe(true);
    act(() => a.focus());
    key(a, "ArrowRight");
    expect(document.activeElement).toBe(c);
    expect(onChange).toHaveBeenCalledWith("percent");
  });

  it("other keys are left alone (no preventDefault)", () => {
    render(<Choice />);
    const [a] = radios();
    act(() => a.focus());
    const event = new KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true });
    act(() => {
      a.dispatchEvent(event);
    });
    expect(event.defaultPrevented).toBe(false);
  });

  it("text options show label text; iconOnly options are named by aria-label", () => {
    render(
      <>
        <Choice testId="text" />
        <Choice testId="icons" iconOnly />
      </>,
    );
    const textRadios = Array.from(q("[data-testid='text']").querySelectorAll("[role='radio']"));
    const iconRadios = Array.from(q("[data-testid='icons']").querySelectorAll("[role='radio']"));
    expect(textRadios.map((r) => r.textContent)).toEqual(["Grouped", "Stacked", "100% stacked"]);
    expect(iconRadios.map((r) => r.textContent)).toEqual(["", "", ""]);
    expect(iconRadios.map((r) => r.getAttribute("aria-label"))).toEqual([
      "Grouped",
      "Stacked",
      "100% stacked",
    ]);
  });

  it("an icon-only option explains itself with a tooltip (tooltip, else label)", () => {
    vi.useFakeTimers();
    const options: SegmentedChoiceOption<Stacking>[] = [
      { ...STACKING[0], tooltip: "Side by side" },
      STACKING[1],
      STACKING[2],
    ];
    render(<Choice options={options} iconOnly />);
    const [a, b] = radios();
    act(() => {
      a.dispatchEvent(new MouseEvent("mouseover", { bubbles: true, relatedTarget: null }));
    });
    act(() => {
      vi.advanceTimersByTime(1000);
    });
    expect(document.querySelector("[role='tooltip']")?.textContent).toBe("Side by side");
    act(() => {
      a.dispatchEvent(new MouseEvent("mouseout", { bubbles: true, relatedTarget: null }));
      b.dispatchEvent(new MouseEvent("mouseover", { bubbles: true, relatedTarget: null }));
    });
    act(() => {
      vi.advanceTimersByTime(1000);
    });
    expect(document.querySelector("[role='tooltip']")?.textContent).toBe("Stacked");
  });

  it.each([
    ["sm", "24px", "24px"],
    ["md", "28px", "28px"],
    ["tall", "44px", "61px"],
  ] as const)("iconOnly size %s renders %s x %s options", (size, width, height) => {
    render(<Choice iconOnly size={size} />);
    const [a] = radios();
    expect(a.style.width).toBe(width);
    expect(a.style.height).toBe(height);
    if (size === "tall") expect(q("[data-testid='choice']").style.height).toBe("61px");
  });

  it("the checked option wears the pressed look through aria-checked", () => {
    render(<Choice />);
    const [a, b] = radios();
    expect(declared(a, "background")).toContain("--button-pressed-bg");
    expect(declared(b, "background")).not.toContain("--button-pressed-bg");
  });

  it.each(LAYOUTS)("paints no hardcoded colour in the %s", (_name, layout) => {
    render(
      <>
        <Choice testId="a" />
        <Choice testId="b" iconOnly size="tall" />
        <Choice testId="c" size="sm" options={[STACKING[0], { ...STACKING[1], disabled: true }]} />
      </>,
      layout,
    );
    expect(hardcodedColours(container)).toEqual([]);
  });
});

// ============================================================================
// SegmentedTabs
// ============================================================================

const TABS = [
  { id: "fields", label: "Fields" },
  { id: "filters", label: "Filters" },
  { id: "format", label: "Format" },
];

function Tabs({ onChange }: { onChange?: (id: string) => void }): React.ReactElement {
  const [value, setValue] = useState("fields");
  return (
    <SegmentedTabs
      ariaLabel="Pane views"
      tabs={TABS}
      value={value}
      testIdPrefix="tab-"
      onChange={(id) => {
        setValue(id);
        onChange?.(id);
      }}
    />
  );
}

function tabs(): HTMLButtonElement[] {
  return Array.from(container.querySelectorAll<HTMLButtonElement>("[role='tab']"));
}

describe("SegmentedTabs", () => {
  it("is a named tablist of tabs with one selected and one tab stop", () => {
    render(<Tabs />);
    const list = q("[role='tablist']");
    expect(list.getAttribute("aria-label")).toBe("Pane views");
    expect(tabs().map((t) => t.getAttribute("aria-selected"))).toEqual(["true", "false", "false"]);
    expect(tabs().map((t) => t.tabIndex)).toEqual([0, -1, -1]);
    expect(tabs().map((t) => t.textContent)).toEqual(["Fields", "Filters", "Format"]);
    expect(tabs()[0].style.height).toBe("28px");
    expect(list.style.height).toBe("28px");
  });

  it("a click selects; clicking the selected tab changes nothing", () => {
    const onChange = vi.fn();
    render(<Tabs onChange={onChange} />);
    click(q("[data-testid='tab-format']"));
    expect(onChange).toHaveBeenCalledWith("format");
    expect(tabs()[2].getAttribute("aria-selected")).toBe("true");
    click(q("[data-testid='tab-format']"));
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it("Left/Right move and activate with wrap; Home/End jump; Up/Down are not tab keys", () => {
    const onChange = vi.fn();
    render(<Tabs onChange={onChange} />);
    const [a, b, c] = tabs();
    act(() => a.focus());
    key(a, "ArrowRight");
    expect(document.activeElement).toBe(b);
    key(b, "ArrowRight");
    key(c, "ArrowRight");
    expect(document.activeElement).toBe(a);
    key(a, "ArrowLeft");
    expect(document.activeElement).toBe(c);
    key(c, "Home");
    expect(document.activeElement).toBe(a);
    key(a, "End");
    expect(document.activeElement).toBe(c);
    const before = onChange.mock.calls.length;
    key(c, "ArrowDown");
    expect(document.activeElement).toBe(c);
    expect(onChange.mock.calls.length).toBe(before);
    expect(onChange.mock.calls.map((call) => call[0])).toEqual([
      "filters",
      "format",
      "fields",
      "format",
      "fields",
      "format",
    ]);
  });

  it("the selected tab wears the pressed look through aria-selected", () => {
    render(<Tabs />);
    const [a, b] = tabs();
    expect(declared(a, "background")).toContain("--button-pressed-bg");
    expect(declared(b, "background")).not.toContain("--button-pressed-bg");
  });

  it("fills the width in a panel, sizes to its labels in the band", () => {
    render(<Tabs />);
    const list = q("[role='tablist']");
    expect(list.style.width).toBe("100%");
    expect(list.style.display).toBe("flex");
    expect(tabs()[0].style.flex).toContain("1");

    render(<Tabs />, bandLayout());
    const bandList = q("[role='tablist']");
    expect(bandList.style.width).toBe("");
    expect(tabs()[0].style.flex).toBe("");
  });

  it.each(LAYOUTS)("paints no hardcoded colour in the %s", (_name, layout) => {
    render(<Tabs />, layout);
    expect(hardcodedColours(container)).toEqual([]);
  });
});
