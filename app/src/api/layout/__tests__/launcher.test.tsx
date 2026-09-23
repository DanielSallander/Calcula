// Tests for the Launcher: a demoted cluster is a 61px tall control (the fill
// rule), keeps the contracts the shell and the E2E journeys depend on
// (testId, aria-expanded, a flyout tagged data-ribbon-content +
// data-section-flyout with role="dialog", Escape and outside-mousedown
// dismissal, popoverLayout(width - 24) inside), falls back to the Group icon
// rather than a text glyph, tolerates presses inside NESTED flyouts, and
// paints only with tokens.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import React, { act } from "react";
import ReactDOM from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import {
  SurfaceLayoutProvider,
  bandLayout,
  panelLayout,
  useSurfaceLayout,
  type SurfaceLayout,
} from "../context";
import { Launcher } from "../primitives/Launcher";
import { FLYOUT_DEFAULT_WIDTH, FLYOUT_MAX_WIDTH, FLYOUT_MIN_WIDTH } from "../tokens";
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

function render(node: React.ReactNode, layout: SurfaceLayout = bandLayout()): void {
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

function pressEscape(target: EventTarget = document): void {
  act(() => {
    target.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  });
}

function button(): HTMLButtonElement {
  return container.querySelector("button[data-testid='launch']") as HTMLButtonElement;
}

function flyout(): HTMLElement | null {
  return document.querySelector("[data-section-flyout]");
}

/** Records the geometry the flyout hosts its content at. */
function Probe(): React.ReactElement {
  const layout = useSurfaceLayout();
  return (
    <span
      data-testid="probe"
      data-container={layout.container}
      data-orientation={layout.orientation}
      data-width={layout.width}
    />
  );
}

/** A nested overlay opened from inside the flyout: a separate body portal
 *  tagged the way every popover is. */
function NestedPortal(): React.ReactElement {
  return ReactDOM.createPortal(
    <div data-section-flyout="" data-testid="nested">
      <button data-testid="nested-option">Option</button>
    </div>,
    document.body,
  );
}

const Icon = () => (
  <svg data-testid="section-icon" width={16} height={16} viewBox="0 0 24 24" aria-hidden>
    <rect x="3" y="3" width="18" height="18" rx="2" fill="currentColor" />
  </svg>
);

describe("Launcher button", () => {
  it("is a 61px tall control with the hero's 58px minimum width", () => {
    render(<Launcher label="Actions" testId="launch"><Probe /></Launcher>);
    const cs = getComputedStyle(button());
    expect(cs.height).toBe("61px");
    expect(cs.minWidth).toBe("58px");
    expect(cs.padding).toBe("6px 10px");
    expect(cs.gap).toBe("3px");
    expect(cs.flexDirection).toBe("column");
    expect(declared(button(), "border-radius")).toContain("--radius-control");
  });

  it("keeps its contract attributes", () => {
    render(<Launcher label="Actions" testId="launch"><Probe /></Launcher>);
    const b = button();
    expect(b.type).toBe("button");
    expect(b.getAttribute("aria-expanded")).toBe("false");
    expect(b.getAttribute("aria-haspopup")).toBe("dialog");
  });

  it("its only text is the label: the icon and chevron are SVG", () => {
    render(<Launcher label="Animations (2)" testId="launch"><Probe /></Launcher>);
    expect(button().textContent).toBe("Animations (2)");
  });

  it("falls back to the Group icon at 24px in a 34px slot", () => {
    render(<Launcher label="Actions" testId="launch"><Probe /></Launcher>);
    const slot = button().firstElementChild as HTMLElement;
    expect(slot.getAttribute("aria-hidden")).toBe("true");
    expect(getComputedStyle(slot).width).toBe("34px");
    expect(getComputedStyle(slot).height).toBe("34px");
    const svg = slot.querySelector("svg") as SVGElement;
    expect(svg).not.toBeNull();
    expect(svg.getAttribute("width")).toBe("24");
    expect(slot.textContent).toBe("");
  });

  it("uses the section's icon when given, fitted to 24px", () => {
    render(<Launcher label="Actions" icon={<Icon />} testId="launch"><Probe /></Launcher>);
    const slot = button().firstElementChild as HTMLElement;
    const svg = slot.querySelector("[data-testid='section-icon']") as SVGElement;
    expect(svg).not.toBeNull();
    expect(getComputedStyle(svg).width).toBe("24px");
    expect(getComputedStyle(svg).height).toBe("24px");
  });

  it("label is 11px/500 with a 13px line, ellipsised at 110px, then a 9px chevron", () => {
    render(<Launcher label="A rather long section label" testId="launch"><Probe /></Launcher>);
    const label = button().lastElementChild as HTMLElement;
    const cs = getComputedStyle(label);
    expect(cs.fontSize).toBe("11px");
    expect(cs.fontWeight).toBe("500");
    expect(cs.lineHeight).toBe("13px");
    expect(cs.maxWidth).toBe("110px");
    const text = label.firstElementChild as HTMLElement;
    expect(getComputedStyle(text).textOverflow).toBe("ellipsis");
    const chevron = label.querySelector("svg") as SVGElement;
    expect(chevron.getAttribute("width")).toBe("9");
  });
});

describe("Launcher flyout", () => {
  it("opens a body-portal card tagged as ribbon content, headed by the label", () => {
    render(<Launcher label="Actions" testId="launch"><Probe /></Launcher>);
    expect(flyout()).toBeNull();
    click(button());
    const el = flyout()!;
    expect(el.parentElement).toBe(document.body);
    expect(el.hasAttribute("data-ribbon-content")).toBe(true);
    expect(el.getAttribute("role")).toBe("dialog");
    expect(el.getAttribute("aria-label")).toBe("Actions");
    expect(button().getAttribute("aria-expanded")).toBe("true");
    expect(button().getAttribute("aria-controls")).toBe(el.id);
    const cs = getComputedStyle(el);
    expect(cs.position).toBe("fixed");
    expect(cs.padding).toBe("8px");
    expect(declared(el, "border-radius")).toContain("--radius-popover");
    expect(declared(el, "box-shadow")).toContain("--shadow-popover");
    expect(declared(el, "border")).toContain("--ribbon-cluster-border");
    const heading = el.firstElementChild as HTMLElement;
    expect(heading.textContent).toBe("Actions");
    expect(getComputedStyle(heading).fontSize).toBe("11px");
    expect(getComputedStyle(heading).fontWeight).toBe("600");
  });

  it("hosts its content at vertical popover geometry, width - 24", () => {
    render(<Launcher label="Actions" testId="launch"><Probe /></Launcher>);
    click(button());
    const probe = document.querySelector("[data-testid='probe']")!;
    expect(probe.getAttribute("data-container")).toBe("popover");
    expect(probe.getAttribute("data-orientation")).toBe("vertical");
    expect(probe.getAttribute("data-width")).toBe(String(FLYOUT_DEFAULT_WIDTH - 24));
    expect(flyout()!.style.width).toBe(`${FLYOUT_DEFAULT_WIDTH}px`);
  });

  it("clamps the flyout width to the sidebar's range", () => {
    render(<Launcher label="Wide" flyoutWidth={2000} testId="launch"><Probe /></Launcher>);
    click(button());
    expect(flyout()!.style.width).toBe(`${FLYOUT_MAX_WIDTH}px`);
    act(() => root.unmount());
    root = createRoot(container);
    render(<Launcher label="Narrow" flyoutWidth={10} testId="launch"><Probe /></Launcher>);
    click(button());
    expect(flyout()!.style.width).toBe(`${FLYOUT_MIN_WIDTH}px`);
  });

  it("a second click closes it", () => {
    render(<Launcher label="Actions" testId="launch"><Probe /></Launcher>);
    click(button());
    mouseDown(button());
    click(button());
    expect(flyout()).toBeNull();
    expect(button().getAttribute("aria-expanded")).toBe("false");
  });

  it("Escape closes it and returns focus to the launcher when focus was inside", () => {
    render(
      <Launcher label="Actions" testId="launch">
        <button data-testid="inside">Inside</button>
      </Launcher>,
    );
    click(button());
    const inside = document.querySelector<HTMLButtonElement>("[data-testid='inside']")!;
    act(() => inside.focus());
    pressEscape(inside);
    expect(flyout()).toBeNull();
    expect(document.activeElement).toBe(button());
  });

  it("Escape never steals focus from an unrelated field", () => {
    render(
      <>
        <Launcher label="Actions" testId="launch"><Probe /></Launcher>
        <input data-testid="field" />
      </>,
    );
    click(button());
    const field = container.querySelector<HTMLInputElement>("[data-testid='field']")!;
    act(() => field.focus());
    pressEscape(field);
    expect(flyout()).toBeNull();
    expect(document.activeElement).toBe(field);
  });

  it("an outside press closes it; presses inside it do not", () => {
    render(
      <>
        <Launcher label="Actions" testId="launch">
          <button data-testid="inside">Inside</button>
        </Launcher>
        <div data-testid="outside">grid</div>
      </>,
    );
    click(button());
    mouseDown(document.querySelector("[data-testid='inside']")!);
    expect(flyout()).not.toBeNull();
    mouseDown(container.querySelector("[data-testid='outside']")!);
    expect(flyout()).toBeNull();
  });

  it("a press inside a NESTED flyout (a separate portal) does not close it", () => {
    render(
      <Launcher label="Actions" testId="launch">
        <NestedPortal />
      </Launcher>,
    );
    click(button());
    const option = document.querySelector("[data-testid='nested-option']")!;
    expect(option).not.toBeNull();
    mouseDown(option);
    expect(document.querySelector("[role='dialog'][data-section-flyout]")).not.toBeNull();
  });
});

describe("Launcher colours", () => {
  it.each([
    ["band", bandLayout()],
    ["panel", panelLayout(300)],
  ])("paints no hardcoded colour in the %s (button and flyout)", (_name, layout) => {
    render(<Launcher label="Actions" testId="launch"><Probe /></Launcher>, layout);
    expect(hardcodedColours(container)).toEqual([]);
    click(button());
    expect(hardcodedColours(document.body)).toEqual([]);
  });
});
