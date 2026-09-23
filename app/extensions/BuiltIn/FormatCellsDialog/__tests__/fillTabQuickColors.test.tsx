//! FILENAME: app/extensions/BuiltIn/FormatCellsDialog/__tests__/fillTabQuickColors.test.tsx
// PURPOSE: The Fill tab's Solid "Quick Colors" grid is the ONE quick-pick set
//          (@api/layout QUICK_COLORS), drawn as named swatch buttons whose paint
//          is marked as colour DATA and whose chrome is tokens only.
// CONTEXT: It used to be a second hand-rolled colour grid: a local forty-colour
//          list that matched no other picker in the app, swatches named only by
//          a hex `title`, and a border/scale recipe of its own.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";

const { paletteMock } = vi.hoisted(() => ({ paletteMock: vi.fn() }));
vi.mock("@api/theme", () => ({ getThemeColorPalette: paletteMock }));

import { QUICK_COLORS, colorLabel, findHardcodedColours } from "@api/layout";
import { FillTab } from "../tabs/FillTab";
import { useFormatCellsStore } from "../hooks/useFormatCellsState";

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
  paletteMock.mockReset();
  paletteMock.mockResolvedValue([]);
  useFormatCellsStore.getState().reset();
  useFormatCellsStore.getState().setFillMode("solid");
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  document.body.innerHTML = "";
  useFormatCellsStore.getState().reset();
});

function render(): void {
  act(() => {
    root.render(<FillTab />);
  });
}

function grid(): HTMLElement {
  const el = container.querySelector<HTMLElement>('[role="group"][aria-label="Quick colors"]');
  if (!el) throw new Error("no Quick Colors grid");
  return el;
}

function swatches(): HTMLButtonElement[] {
  return Array.from(grid().querySelectorAll<HTMLButtonElement>("button"));
}

describe("Format Cells Fill tab — Quick Colors", () => {
  it("offers exactly the shared QUICK_COLORS set, in order", () => {
    render();
    const painted = swatches().map((b) => b.style.background);
    expect(painted).toHaveLength(QUICK_COLORS.length);
    // jsdom normalises an inline hex to rgb(); compare through a probe element.
    const probe = document.createElement("span");
    const expected = QUICK_COLORS.map((c) => {
      probe.style.background = c;
      return probe.style.background;
    });
    expect(painted).toEqual(expected);
  });

  it("names every swatch (aria-label and tooltip) and marks its paint as colour data", () => {
    render();
    const buttons = swatches();
    buttons.forEach((b, i) => {
      expect(b.getAttribute("type")).toBe("button");
      expect(b.getAttribute("aria-label")).toBe(colorLabel(QUICK_COLORS[i]));
      expect(b.getAttribute("title")).toBe(colorLabel(QUICK_COLORS[i]));
      expect(b.hasAttribute("data-colour-data")).toBe(true);
    });
    // Human names, not hex: the set is fully named in @api/layout.
    expect(buttons[0].getAttribute("aria-label")).toBe("Black");
  });

  it("a click sets the solid background colour, and the chosen swatch is pressed", () => {
    render();
    const red = swatches().find((b) => b.getAttribute("aria-label") === "Red")!;
    act(() => {
      red.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(useFormatCellsStore.getState().backgroundColor).toBe("#ff0000");
    const pressed = swatches().filter((b) => b.getAttribute("aria-pressed") === "true");
    expect(pressed).toEqual([red]);
  });

  it("marks the current colour pressed case-insensitively (a stored #FFFFFF is White)", () => {
    useFormatCellsStore.getState().setBackgroundColor("#FFFFFF");
    render();
    const pressed = swatches().filter((b) => b.getAttribute("aria-pressed") === "true");
    expect(pressed.map((b) => b.getAttribute("aria-label"))).toEqual(["White"]);
  });

  it("paints its chrome — the grid and every swatch ring — with tokens only", () => {
    render();
    expect(findHardcodedColours(grid())).toEqual([]);
    // The swatches are data, so the scan above skips them. Their RING is
    // chrome: probe a copy of one swatch that carries its classes but neither
    // the data mark nor the data paint.
    const probe = swatches()[0].cloneNode(false) as HTMLElement;
    probe.removeAttribute("data-colour-data");
    probe.removeAttribute("style");
    const wrap = document.createElement("div");
    wrap.appendChild(probe);
    document.body.appendChild(wrap);
    expect(probe.getAttribute("class")).toBeTruthy();
    expect(findHardcodedColours(wrap)).toEqual([]);
  });
});
