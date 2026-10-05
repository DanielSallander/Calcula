//! FILENAME: app/src/shell/dialogs/__tests__/dimensionInputDialog.test.tsx
// PURPOSE: The Row Height / Column Width dialog speaks Excel's units, and its
//          third mode -- Excel's Standard Width (Home > Format > Default
//          Width...) -- asks for the STANDARD column width in the same
//          character units as Column Width.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { DimensionInputDialog, type DimensionInputData } from "../DimensionInputDialog";

Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

let container: HTMLDivElement;
let root: Root;
const onResult = vi.fn();
const onClose = vi.fn();

function render(data: DimensionInputData): void {
  act(() => {
    root.render(
      <DimensionInputDialog isOpen onClose={onClose} data={data as unknown as Record<string, unknown>} />,
    );
  });
}

function input(): HTMLInputElement {
  const el = container.querySelector("input");
  if (!el) throw new Error("no input");
  return el;
}

function setValue(value: string): void {
  const el = input();
  act(() => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
    setter.call(el, value);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

function pressEnter(): void {
  act(() => {
    input().dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
  });
}

beforeEach(() => {
  onResult.mockReset();
  onClose.mockReset();
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe("Column Width / Row Height (unchanged)", () => {
  it("column width is in characters: 64px shows 8.43", () => {
    render({ mode: "columnWidth", currentPx: 64.01, rangeLabel: "B:D", onResult });
    expect(container.textContent).toContain("Column Width");
    expect(input().value).toBe("8.43");
  });

  it("row height is in points: 20px shows 15", () => {
    render({ mode: "rowHeight", currentPx: 20, rangeLabel: "4", onResult });
    expect(container.textContent).toContain("Row Height");
    expect(input().value).toBe("15");
    setValue("30");
    pressEnter();
    expect(onResult).toHaveBeenCalledWith(40);
  });
});

describe("Standard Width (Excel's Default Width...)", () => {
  it("titles itself Standard Width and asks for the standard column width in characters", () => {
    render({ mode: "defaultWidth", currentPx: 64.01, onResult });
    expect(container.textContent).toContain("Standard Width");
    expect(container.textContent).toContain("Standard column width");
    expect(container.textContent).toContain("characters");
    expect(input().value).toBe("8.43");
  });

  it("answers PIXELS by the column conversion (chars * 7 + 5)", () => {
    render({ mode: "defaultWidth", currentPx: 64.01, onResult });
    setValue("10");
    pressEnter();
    expect(onResult).toHaveBeenCalledWith(75);
    expect(onClose).toHaveBeenCalled();
  });

  it("refuses a non-positive width", () => {
    render({ mode: "defaultWidth", currentPx: 64.01, onResult });
    setValue("0");
    pressEnter();
    expect(onResult).not.toHaveBeenCalled();
  });
});
