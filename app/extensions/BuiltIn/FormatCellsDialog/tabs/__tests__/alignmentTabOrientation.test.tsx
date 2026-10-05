//! FILENAME: app/extensions/BuiltIn/FormatCellsDialog/tabs/__tests__/alignmentTabOrientation.test.tsx
// PURPOSE: The Alignment tab's Orientation control and Indent, as Excel's:
//            - orientation is a DEGREES value from -90 to 90 plus the stacked
//              "Text" box (Excel's Vertical Text). The tab offered a select of
//              0 / 90 / -90 only, and a cell at 45 degrees (the Home tab's Angle
//              Counterclockwise) opened showing nothing it could select;
//            - the indent goes to 250, Excel's limit (measured: 251 errors).
//              The tab capped it at 15.
// CONTEXT: Values are the backend's spelling ("none", "rotate90", "rotate270",
//          "vertical", "custom:N"); 0 / 90 / -90 always travel as the named
//          values, which is how the backend reports them back.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";

import { AlignmentTab } from "../AlignmentTab";
import { useFormatCellsStore } from "../../hooks/useFormatCellsState";
import {
  orientationOf,
  textRotationForDegrees,
  clampIndent,
  MAX_INDENT,
} from "../../lib/alignmentValues";

describe("orientation values", () => {
  it("reads every backend spelling", () => {
    expect(orientationOf("none")).toEqual({ stacked: false, degrees: 0 });
    expect(orientationOf("rotate90")).toEqual({ stacked: false, degrees: 90 });
    expect(orientationOf("rotate270")).toEqual({ stacked: false, degrees: -90 });
    expect(orientationOf("custom:45")).toEqual({ stacked: false, degrees: 45 });
    expect(orientationOf("custom:-30")).toEqual({ stacked: false, degrees: -30 });
    expect(orientationOf("vertical")).toEqual({ stacked: true, degrees: 0 });
  });

  it("writes the named values for 0 / 90 / -90 and custom:N otherwise, clamped", () => {
    expect(textRotationForDegrees(0)).toBe("none");
    expect(textRotationForDegrees(90)).toBe("rotate90");
    expect(textRotationForDegrees(-90)).toBe("rotate270");
    expect(textRotationForDegrees(45)).toBe("custom:45");
    expect(textRotationForDegrees(-45)).toBe("custom:-45");
    expect(textRotationForDegrees(120)).toBe("rotate90");
    expect(textRotationForDegrees(12.6)).toBe("custom:13");
  });

  it("the indent runs 0..250", () => {
    expect(MAX_INDENT).toBe(250);
    expect(clampIndent(251)).toBe(250);
    expect(clampIndent(-1)).toBe(0);
    expect(clampIndent(16)).toBe(16);
  });
});

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
  useFormatCellsStore.getState().reset();
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

async function render(): Promise<void> {
  await act(async () => {
    root.render(React.createElement(AlignmentTab));
  });
}

function byTestId<T extends HTMLElement = HTMLElement>(id: string): T {
  const el = container.querySelector<T>(`[data-testid="${id}"]`);
  if (!el) throw new Error(`no element ${id}`);
  return el;
}

async function click(el: HTMLElement): Promise<void> {
  await act(async () => {
    el.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
}

/** Type into a controlled input the way React listens for it. */
async function typeInto(el: HTMLInputElement, value: string): Promise<void> {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
  await act(async () => {
    setter.call(el, value);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

const rotation = () => useFormatCellsStore.getState().textRotation;

describe("AlignmentTab: Orientation", () => {
  it("the angle presets set Excel's five orientations", async () => {
    await render();
    await click(byTestId("fc-orientation-45"));
    expect(rotation()).toBe("custom:45");
    await click(byTestId("fc-orientation--45"));
    expect(rotation()).toBe("custom:-45");
    await click(byTestId("fc-orientation-90"));
    expect(rotation()).toBe("rotate90");
    await click(byTestId("fc-orientation--90"));
    expect(rotation()).toBe("rotate270");
    await click(byTestId("fc-orientation-0"));
    expect(rotation()).toBe("none");
  });

  it("the stacked 'Text' box sets vertical text and is shown pressed", async () => {
    await render();
    await click(byTestId("fc-orientation-stacked"));
    expect(rotation()).toBe("vertical");
    expect(byTestId("fc-orientation-stacked").getAttribute("aria-pressed")).toBe("true");
  });

  it("the Degrees field takes any angle from -90 to 90", async () => {
    await render();
    const field = byTestId<HTMLInputElement>("fc-orientation-degrees");
    await typeInto(field, "30");
    expect(rotation()).toBe("custom:30");
    await typeInto(field, "-60");
    expect(rotation()).toBe("custom:-60");
    await typeInto(field, "90");
    expect(rotation()).toBe("rotate90");
    // Out of range is not taken (Excel refuses it).
    await typeInto(field, "95");
    expect(rotation()).toBe("rotate90");
  });

  it("a cell loaded at 45 degrees shows 45 (the old select had no such option)", async () => {
    await render();
    await act(async () => useFormatCellsStore.setState({ textRotation: "custom:45" }));
    expect(byTestId<HTMLInputElement>("fc-orientation-degrees").value).toBe("45");
    expect(byTestId("fc-orientation-45").getAttribute("aria-pressed")).toBe("true");
  });

  it("typing a degree leaves stacked text", async () => {
    await render();
    await click(byTestId("fc-orientation-stacked"));
    await typeInto(byTestId<HTMLInputElement>("fc-orientation-degrees"), "20");
    expect(rotation()).toBe("custom:20");
  });
});

describe("AlignmentTab: Indent", () => {
  it("goes past 15, up to Excel's 250, and stops there", async () => {
    await render();
    const field = byTestId<HTMLInputElement>("fc-indent");
    await typeInto(field, "16");
    expect(useFormatCellsStore.getState().indent).toBe(16);
    await typeInto(field, "250");
    expect(useFormatCellsStore.getState().indent).toBe(250);
    expect(byTestId<HTMLButtonElement>("fc-indent-increase").disabled).toBe(true);
    await typeInto(field, "400");
    expect(useFormatCellsStore.getState().indent).toBe(250);
  });

  it("an indent on a General or Center cell makes it Left, as Excel does (measured)", async () => {
    // Excel: IndentLevel 2 on General -> HorizontalAlignment Left; on Center ->
    // Left; on Right -> stays Right.
    await render();
    await click(byTestId("fc-indent-increase"));
    expect(useFormatCellsStore.getState().textAlign).toBe("left");

    await act(async () => useFormatCellsStore.setState({ textAlign: "center", indent: 0 }));
    await typeInto(byTestId<HTMLInputElement>("fc-indent"), "3");
    expect(useFormatCellsStore.getState().textAlign).toBe("left");

    await act(async () => useFormatCellsStore.setState({ textAlign: "right", indent: 0 }));
    await click(byTestId("fc-indent-increase"));
    expect(useFormatCellsStore.getState().textAlign).toBe("right");
  });

  it("the + / - buttons step by one", async () => {
    await render();
    await click(byTestId("fc-indent-increase"));
    await click(byTestId("fc-indent-increase"));
    expect(useFormatCellsStore.getState().indent).toBe(2);
    await click(byTestId("fc-indent-decrease"));
    expect(useFormatCellsStore.getState().indent).toBe(1);
  });
});
