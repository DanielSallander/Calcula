//! FILENAME: app/extensions/Controls/PropertiesPane/__tests__/propertyRowColor.test.tsx
// PURPOSE: A colour row's OS picker writes the property ONCE per pick
//          (BUG-0536). WebView2's picker fires an `input` per drag step and one
//          `change` when it closes; the row used to write (and add an undo step)
//          on every `input`. The steps now only preview into the row's text box.
// CONTEXT: react-dom + act; `@api/objectBindings` stubbed (no backend).

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";

vi.mock("@api/objectBindings", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@api/objectBindings")>()),
  getBinding: () => null,
  setBinding: vi.fn(),
  clearBinding: vi.fn(),
  analyzeBindingFormula: async () => ({ error: null, warning: null }),
  listBindingMeasures: async () => [],
  onBindingsChanged: () => () => {},
}));

import { PropertyRow } from "../PropertyRow";
import { BUTTON_PROPERTIES } from "../../lib/types";

Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

const FILL = BUTTON_PROPERTIES.find((d) => d.inputType === "color")!;
const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;

let host: HTMLDivElement;
let root: Root;
const onChange = vi.fn();

beforeEach(() => {
  onChange.mockReset();
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => {
    root.unmount();
  });
  host.remove();
});

describe("PropertyRow -- colour picker", () => {
  it("a pick that steps N times writes ONCE, on the closing change", async () => {
    expect(FILL).toBeDefined();
    await act(async () => {
      root.render(
        <PropertyRow
          definition={FILL}
          value={{ valueType: "static", value: "#123456" }}
          scripts={[]}
          onChange={onChange}
          bindingRef={null}
        />,
      );
    });
    const picker = host.querySelector<HTMLInputElement>('input[type="color"]')!;
    const text = host.querySelector<HTMLInputElement>('input[type="text"]')!;
    for (const step of ["#200000", "#400000", "#600000"]) {
      await act(async () => {
        setter?.call(picker, step);
        picker.dispatchEvent(new Event("input", { bubbles: true }));
      });
    }
    // The steps preview into the text box, and write nothing.
    expect(text.value).toBe("#600000");
    expect(onChange).not.toHaveBeenCalled();
    await act(async () => {
      picker.dispatchEvent(new Event("change", { bubbles: true }));
    });
    expect(onChange.mock.calls).toEqual([[FILL.key, "#600000"]]);
  });
});
