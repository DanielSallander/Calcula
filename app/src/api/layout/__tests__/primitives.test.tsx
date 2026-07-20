// Tests for the @api/layout primitives: the same JSX must render horizontally
// under band geometry and vertically under panel geometry, and the
// intrinsically-tall primitives (ItemList/Tall) must emit a Launcher in the
// band whose flyout hosts the content at vertical popover geometry.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import {
  SurfaceLayoutProvider,
  bandLayout,
  panelLayout,
  useSurfaceLayout,
  Field,
  Stack,
  ControlGrid,
  CommandButton,
  ItemList,
  Tall,
  type SurfaceLayout,
} from "../index";

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

function renderIn(layout: SurfaceLayout, node: React.ReactNode): void {
  act(() => {
    root.render(<SurfaceLayoutProvider value={layout}>{node}</SurfaceLayoutProvider>);
  });
}

function click(el: Element): void {
  act(() => {
    el.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
}

/** Probe that records the surface geometry it renders under. */
function GeometryProbe(): React.ReactElement {
  const layout = useSurfaceLayout();
  return (
    <span
      data-testid="probe"
      data-container={layout.container}
      data-orientation={layout.orientation}
    />
  );
}

describe("Field", () => {
  it("puts the label inline-left in the band", () => {
    renderIn(bandLayout(), <Field label="Fps"><input /></Field>);
    const rootDiv = container.firstElementChild as HTMLElement;
    expect(rootDiv.style.flexDirection).not.toBe("column");
    expect(rootDiv.querySelector("label")?.textContent).toBe("Fps");
  });

  it("puts the label above in the panel", () => {
    renderIn(panelLayout(300), <Field label="Fps"><input /></Field>);
    const rootDiv = container.firstElementChild as HTMLElement;
    expect(rootDiv.style.flexDirection).toBe("column");
  });
});

describe("Stack", () => {
  it("column-wraps within the band height", () => {
    renderIn(bandLayout(), <Stack><div>a</div><div>b</div></Stack>);
    const rootDiv = container.firstElementChild as HTMLElement;
    expect(rootDiv.style.flexWrap).toBe("wrap");
    expect(rootDiv.style.maxHeight).toBe("80px");
  });

  it("stacks without a height cap in the panel", () => {
    renderIn(panelLayout(300), <Stack><div>a</div></Stack>);
    const rootDiv = container.firstElementChild as HTMLElement;
    expect(rootDiv.style.maxHeight).toBe("");
  });
});

describe("ControlGrid", () => {
  const buttons = (n: number) =>
    Array.from({ length: n }, (_, i) => <button key={i}>{i}</button>);

  it("chunks children row-major into two stacked rows in the band", () => {
    renderIn(bandLayout(), <ControlGrid>{buttons(6)}</ControlGrid>);
    const rootDiv = container.firstElementChild as HTMLElement;
    expect(rootDiv.style.flexDirection).toBe("column");
    const rows = Array.from(rootDiv.children) as HTMLElement[];
    expect(rows).toHaveLength(2);
    expect(rows[0].querySelectorAll("button")).toHaveLength(3);
    expect(rows[1].querySelectorAll("button")).toHaveLength(3);
    // Reading order preserved: first row holds the first children
    expect(rows[0].textContent).toBe("012");
    expect(rows[1].textContent).toBe("345");
  });

  it("keeps small groups on a single band row (below splitAt)", () => {
    renderIn(bandLayout(), <ControlGrid>{buttons(4)}</ControlGrid>);
    const rootDiv = container.firstElementChild as HTMLElement;
    const rows = Array.from(rootDiv.children) as HTMLElement[];
    expect(rows).toHaveLength(1);
    expect(rows[0].querySelectorAll("button")).toHaveLength(4);
  });

  it("honors a custom splitAt threshold", () => {
    renderIn(bandLayout(), <ControlGrid splitAt={2}>{buttons(3)}</ControlGrid>);
    const rootDiv = container.firstElementChild as HTMLElement;
    expect(rootDiv.children).toHaveLength(2);
  });

  it("renders one wrapping row in the panel", () => {
    renderIn(panelLayout(300), <ControlGrid>{buttons(6)}</ControlGrid>);
    const rootDiv = container.firstElementChild as HTMLElement;
    expect(rootDiv.style.flexDirection).toBe("row");
    expect(rootDiv.style.flexWrap).toBe("wrap");
    expect(rootDiv.querySelectorAll("button")).toHaveLength(6);
  });
});

describe("CommandButton", () => {
  it("renders as a full-height icon-over-label hero in the band", () => {
    renderIn(bandLayout(), <CommandButton icon="P" label="Paste" data-testid="hero" />);
    const button = container.querySelector("button[data-testid='hero']") as HTMLElement;
    expect(button).not.toBeNull();
    expect(button.textContent).toBe("PPaste");
    expect(button.style.height).toBe("");
    // Band form uses the hero class (column flex + 100% height via css class)
    expect(getComputedStyle(button).flexDirection).toBe("column");
  });

  it("renders as a standard inline button in the panel", () => {
    renderIn(panelLayout(300), <CommandButton icon="P" label="Paste" data-testid="hero" />);
    const button = container.querySelector("button[data-testid='hero']") as HTMLElement;
    expect(button).not.toBeNull();
    expect(getComputedStyle(button).flexDirection).not.toBe("column");
  });
});

describe("ItemList", () => {
  const list = (
    <ItemList label="Animations" count={2} testId="list">
      <div data-testid="row">one</div>
      <div data-testid="row">two</div>
    </ItemList>
  );

  it("renders items directly in the panel", () => {
    renderIn(panelLayout(300), list);
    expect(container.querySelectorAll("[data-testid='row']")).toHaveLength(2);
    expect(container.querySelector("button")).toBeNull();
  });

  it("renders a counted launcher in the band, items behind the flyout", () => {
    renderIn(bandLayout(), list);
    const button = container.querySelector("button[data-testid='list']");
    expect(button?.textContent).toContain("Animations (2)");
    expect(document.querySelectorAll("[data-testid='row']")).toHaveLength(0);

    click(button!);
    const flyout = document.querySelector("[data-section-flyout]");
    expect(flyout).not.toBeNull();
    expect(flyout!.querySelectorAll("[data-testid='row']")).toHaveLength(2);
  });

  it("closes the flyout on Escape", () => {
    renderIn(bandLayout(), list);
    click(container.querySelector("button[data-testid='list']")!);
    expect(document.querySelector("[data-section-flyout]")).not.toBeNull();
    act(() => {
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });
    expect(document.querySelector("[data-section-flyout]")).toBeNull();
  });
});

describe("Tall", () => {
  it("renders children inline in the panel", () => {
    renderIn(panelLayout(300), <Tall label="Editor"><GeometryProbe /></Tall>);
    const probe = container.querySelector("[data-testid='probe']");
    expect(probe?.getAttribute("data-container")).toBe("panel");
  });

  it("hosts children at vertical popover geometry inside the band launcher", () => {
    renderIn(bandLayout(), <Tall label="Editor" testId="tall"><GeometryProbe /></Tall>);
    expect(document.querySelector("[data-testid='probe']")).toBeNull();

    click(container.querySelector("button[data-testid='tall']")!);
    const probe = document.querySelector("[data-testid='probe']");
    expect(probe?.getAttribute("data-container")).toBe("popover");
    expect(probe?.getAttribute("data-orientation")).toBe("vertical");
  });
});
