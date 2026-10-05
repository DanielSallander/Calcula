//! FILENAME: app/extensions/BuiltIn/FormatCellsDialog/tabs/__tests__/fontTabSize.test.tsx
// PURPOSE: The Font tab's Size and Font fields.
//            - Size takes HALF POINTS from 1 to 409 (Excel's range; 10.5 was
//              unwritable while the backend stored a u8, survey D1). A size
//              between half points is rounded to the nearest one, and anything
//              outside 1..409 is not taken.
//            - Both fields show the style that LOADS after mount. They copied
//              the store once, at mount, so a dialog opened straight on the Font
//              tab -- the Home tab's Font dialog launcher does exactly that --
//              showed "11" and "system-ui" whatever the cell carried.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";

vi.mock("@api/theme", () => ({ getCachedTheme: () => null }));
vi.mock("../../components/ColorPicker", () => ({ ColorPicker: () => null }));

import { FontTab } from "../FontTab";
import { useFormatCellsStore } from "../../hooks/useFormatCellsState";
import { parseFontSize, MAX_FONT_SIZE } from "../../lib/fontValues";

describe("parseFontSize", () => {
  it("takes half points from 1 to 409", () => {
    expect(MAX_FONT_SIZE).toBe(409);
    expect(parseFontSize("10.5")).toBe(10.5);
    expect(parseFontSize("409")).toBe(409);
    expect(parseFontSize("1")).toBe(1);
  });

  it("rounds to the nearest half point", () => {
    expect(parseFontSize("10.3")).toBe(10.5);
    expect(parseFontSize("10.2")).toBe(10);
    expect(parseFontSize("11,5")).toBe(11.5); // a decimal comma, as typed on sv-SE
  });

  it("refuses what Excel refuses", () => {
    expect(parseFontSize("0.5")).toBeNull();
    expect(parseFontSize("410")).toBeNull();
    expect(parseFontSize("")).toBeNull();
    expect(parseFontSize("abc")).toBeNull();
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
    root.render(React.createElement(FontTab));
  });
}

function input(id: string): HTMLInputElement {
  const el = container.querySelector<HTMLInputElement>(`[data-testid="${id}"]`);
  if (!el) throw new Error(`no input ${id}`);
  return el;
}

async function typeInto(el: HTMLInputElement, value: string): Promise<void> {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
  await act(async () => {
    setter.call(el, value);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

async function blur(el: HTMLInputElement): Promise<void> {
  await act(async () => {
    el.dispatchEvent(new FocusEvent("focusout", { bubbles: true }));
  });
}

const size = () => useFormatCellsStore.getState().fontSize;

describe("FontTab: Size", () => {
  it("a half-point size is taken as typed", async () => {
    await render();
    await typeInto(input("fc-font-size"), "10.5");
    expect(size()).toBe(10.5);
  });

  it("an in-between size is rounded, and the field shows the rounded size once left", async () => {
    await render();
    const field = input("fc-font-size");
    await typeInto(field, "10.3");
    expect(size()).toBe(10.5);
    await blur(field);
    expect(field.value).toBe("10.5");
  });

  it("410 is not taken, and leaving the field shows the size that IS set", async () => {
    await render();
    const field = input("fc-font-size");
    await typeInto(field, "12");
    await typeInto(field, "410");
    expect(size()).toBe(12);
    await blur(field);
    expect(field.value).toBe("12");
  });

  it("the half-point sizes in the list are selectable", async () => {
    await render();
    const row = Array.from(container.querySelectorAll("div")).find((d) => d.textContent === "10.5" && d.children.length === 0);
    expect(row, "10.5 is in the size list").toBeTruthy();
    await act(async () => row!.dispatchEvent(new MouseEvent("click", { bubbles: true })));
    expect(size()).toBe(10.5);
  });
});

describe("FontTab: the fields follow a style that loads after mount", () => {
  it("Size and Font show the loaded cell, not the dialog's defaults", async () => {
    await render();
    await act(async () => useFormatCellsStore.getState().loadFromStyle({ fontSize: 14, fontFamily: "Cambria" }));
    expect(input("fc-font-size").value).toBe("14");
    expect(input("fc-font-name").value).toBe("Cambria");
  });

  it("typing is not overwritten mid-keystroke", async () => {
    await render();
    const field = input("fc-font-size");
    await typeInto(field, "10.");
    expect(field.value).toBe("10.");
  });
});
