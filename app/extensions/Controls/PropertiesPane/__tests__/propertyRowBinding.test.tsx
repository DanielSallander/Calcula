//! FILENAME: app/extensions/Controls/PropertiesPane/__tests__/propertyRowBinding.test.tsx
// PURPOSE: The Properties pane's rows after D-BIND (WP-D S8a):
//            * a `supportsFormula` row is a `BindableField`: `=...` in its fx
//              editor calls `setBinding` and NEVER the row's literal write --
//              the backend's `set_control_property` never sees "formula";
//            * fx off on a bound row calls `clearBinding`;
//            * typing `=...` into the LITERAL editor stores text (static), the
//              "'" escape staying display-only;
//            * no fx without a uid, on a read-only row, or on a key the
//              catalog does not accept (a script-declared custom key); and fx
//              on a row whose property is ALREADY bound even when the row
//              does not normally offer it.
// CONTEXT: react-dom + act; `@api/objectBindings` is real except the
//          operations that reach the backend and the cache read.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { ObjectBindingRef } from "@api/objectBindings";

const h = vi.hoisted(() => ({
  bound: new Map<string, Record<string, unknown>>(),
  setBinding: vi.fn(),
  clearBinding: vi.fn(),
}));

vi.mock("@api/objectBindings", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@api/objectBindings")>()),
  getBinding: (_o: unknown, path: string) => h.bound.get(path) ?? null,
  setBinding: (...a: unknown[]) => h.setBinding(...a),
  clearBinding: (...a: unknown[]) => h.clearBinding(...a),
  analyzeBindingFormula: async () => ({ error: null, warning: null }),
  listBindingMeasures: async () => [],
  onBindingsChanged: () => () => {},
}));

import { PropertyRow, fromDisplayValue, isUnchangedCommit, rowOffersBinding } from "../PropertyRow";
import { BUTTON_PROPERTIES, type PropertyDefinition } from "../../lib/types";
import { SHAPE_PROPERTIES } from "../../Shape/shapeProperties";

Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

const REF: ObjectBindingRef = { kind: "control", id: "uid-7" };
const TEXT = BUTTON_PROPERTIES.find((d) => d.key === "text")!;
const FONT_BOLD = SHAPE_PROPERTIES.find((d) => d.key === "fontBold")!;
const NAME = SHAPE_PROPERTIES.find((d) => d.key === "name")!;
const CUSTOM: PropertyDefinition = {
  key: "speed",
  label: "Speed",
  inputType: "number",
  defaultValue: "",
  supportsFormula: true,
  group: "Custom",
};

let host: HTMLDivElement;
let root: Root;
const onChange = vi.fn();
const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;

beforeEach(() => {
  h.bound.clear();
  h.setBinding.mockReset();
  h.clearBinding.mockReset();
  h.clearBinding.mockResolvedValue(true);
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

async function render(definition: PropertyDefinition, bindingRef: ObjectBindingRef | null = REF, value?: string): Promise<void> {
  await act(async () => {
    root.render(
      <PropertyRow
        definition={definition}
        value={value === undefined ? undefined : { valueType: "static", value }}
        scripts={[]}
        onChange={onChange}
        bindingRef={bindingRef}
      />,
    );
  });
}

function q<T extends Element>(sel: string): T | null {
  return host.querySelector<T>(sel);
}

async function typeAndEnter(input: HTMLInputElement, text: string): Promise<void> {
  await act(async () => {
    input.focus();
    setter?.call(input, text);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await act(async () => {
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    await Promise.resolve();
  });
}

describe("the literal helpers", () => {
  it("fromDisplayValue never yields a formula: '=' text is stored as typed, the escape is dropped", () => {
    expect(fromDisplayValue("=A1")).toBe("=A1");
    expect(fromDisplayValue("'=A1")).toBe("=A1");
    expect(fromDisplayValue("Go")).toBe("Go");
  });

  it("isUnchangedCommit also sees the stored static value through its escape", () => {
    expect(isUnchangedCommit("'=x", { valueType: "static", value: "=x" }, "")).toBe(true);
    expect(isUnchangedCommit("=x", { valueType: "static", value: "=x" }, "")).toBe(true);
    expect(isUnchangedCommit("=y", { valueType: "static", value: "=x" }, "")).toBe(false);
    expect(isUnchangedCommit("Mine();", undefined, "")).toBe(false);
  });
});

describe("which rows offer fx", () => {
  it("a supportsFormula row of a control with a uid", () => {
    expect(rowOffersBinding(TEXT, REF)).toBe(true);
  });
  it("never without a uid", () => {
    expect(rowOffersBinding(TEXT, null)).toBe(false);
  });
  it("never on a key the catalog does not accept (identity, script-declared custom)", () => {
    expect(rowOffersBinding(NAME, REF)).toBe(false);
    expect(rowOffersBinding(CUSTOM, REF)).toBe(false);
  });
  it("on a row that does not offer it normally, once the property IS bound", () => {
    expect(rowOffersBinding(FONT_BOLD, REF)).toBe(false);
    h.bound.set("/properties/fontBold", { formula: "=TRUE" });
    expect(rowOffersBinding(FONT_BOLD, REF)).toBe(true);
  });
});

describe("a supportsFormula row", () => {
  // SABOTAGE: route the fx editor's commit to the row's onChange (the literal write).
  it("'=' in its fx editor calls setBinding and never the literal write", async () => {
    h.setBinding.mockImplementation(async (object: unknown, path: string, formula: string) => ({
      object,
      path,
      formula,
      displayFormula: formula,
      model: null,
      resolved: null,
    }));
    await render(TEXT, REF, "Run");
    await act(async () => {
      q<HTMLButtonElement>("[data-bindable-fx]")!.click();
    });
    await typeAndEnter(q<HTMLInputElement>("[data-binding-formula-input]")!, "=Sheet1!B2");
    expect(h.setBinding).toHaveBeenCalledTimes(1);
    expect(h.setBinding.mock.calls[0].slice(0, 3)).toEqual([REF, "/properties/text", "=Sheet1!B2"]);
    expect(onChange, "no literal write (set_control_property) for a formula").not.toHaveBeenCalled();
  });

  it("fx off on a bound row calls clearBinding", async () => {
    h.bound.set("/properties/text", {
      object: REF,
      path: "/properties/text",
      formula: "=A1",
      displayFormula: "=A1",
      model: null,
      resolved: null,
    });
    await render(TEXT, REF, "");
    await act(async () => {
      q<HTMLButtonElement>("[data-bindable-fx]")!.click();
    });
    expect(h.clearBinding).toHaveBeenCalledTimes(1);
    expect(h.clearBinding.mock.calls[0].slice(0, 2)).toEqual([REF, "/properties/text"]);
    expect(onChange).not.toHaveBeenCalled();
  });

  // SABOTAGE: make fromDisplayValue drop a leading "=" or route "=..." elsewhere.
  it("typing '=A1' into the LITERAL editor stores the text, static", async () => {
    await render(TEXT, REF, "Run");
    const literal = host.querySelector<HTMLInputElement>('input[type="text"]:not([data-binding-formula-input])')!;
    expect(literal, "fx off shows the literal editor").not.toBeNull();
    await act(async () => {
      literal.focus();
      setter?.call(literal, "=A1");
      literal.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => {
      literal.blur();
    });
    expect(onChange).toHaveBeenCalledWith("text", "=A1");
    expect(h.setBinding).not.toHaveBeenCalled();
  });

  it("without a uid the row is the literal editor alone (no fx)", async () => {
    await render(TEXT, null, "Run");
    expect(q("[data-bindable-fx]")).toBeNull();
  });
});
