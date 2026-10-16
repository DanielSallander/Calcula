//! FILENAME: app/extensions/BuiltIn/BoundProperties/__tests__/boundPropertiesDialog.test.tsx
// PURPOSE: The Bound Properties view (WP-D S10, D §3.21) LISTS every binding
//          (Object = kind + name, Property = the family's label or the path,
//          Formula, Value or error), EDITS a binding in place through the shared
//          BindingFormulaEditor (one `setBinding`, as a USER edit), REMOVES one
//          (one `clearBinding`), shows Rust's refusal sentence, keeps an orphan
//          listed and removable, and re-reads on `onBindingsChanged`.
// CONTEXT: react-dom + act; `@api/objectBindings` is real except the calls
//          that reach the backend and the cache read.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { ObjectBindingInfo, ObjectBindingPlace } from "@api/objectBindings";

const h = vi.hoisted(() => ({
  bindings: [] as ObjectBindingInfo[],
  places: [] as ObjectBindingPlace[],
  listeners: [] as Array<() => void>,
  setBinding: vi.fn(),
  clearBinding: vi.fn(),
  locate: vi.fn(),
  goTo: vi.fn(),
}));

vi.mock("@api/objectBindings", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@api/objectBindings")>()),
  listBindings: () => h.bindings,
  locateBoundObjects: (...a: unknown[]) => h.locate(...a),
  setBinding: (...a: unknown[]) => h.setBinding(...a),
  clearBinding: (...a: unknown[]) => h.clearBinding(...a),
  analyzeBindingFormula: async () => ({ error: null, warning: null }),
  listBindingMeasures: async () => [],
  onBindingsChanged: (cb: () => void) => {
    h.listeners.push(cb);
    return () => {
      h.listeners = h.listeners.filter((l) => l !== cb);
    };
  },
  getBindablePropertiesRegistration: (kind: string) =>
    kind === "chart"
      ? { properties: () => [{ pointer: "/spec/title", label: "Chart title" }] }
      : null,
}));

vi.mock("../lib/boundPropertyRows", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/boundPropertyRows")>()),
  goToBoundObject: (...a: unknown[]) => h.goTo(...a),
}));

import { BoundPropertiesDialog } from "../BoundPropertiesDialog";
import { BindingRefusal } from "@api/objectBindings";
import { buildBoundPropertyRows, distinctObjects, valueText } from "../lib/boundPropertyRows";

Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

const CHART = { kind: "chart" as const, id: "chart-1" };
const CONTROL = { kind: "control" as const, id: "uid-9" };
const GONE = { kind: "slicer" as const, id: "slicer-gone" };

function binding(
  object: { kind: ObjectBindingInfo["object"]["kind"]; id: string },
  path: string,
  formula: string,
  resolved: Partial<NonNullable<ObjectBindingInfo["resolved"]>> | null,
): ObjectBindingInfo {
  return {
    object,
    path,
    formula,
    displayFormula: formula,
    model: null,
    resolved: resolved
      ? { object, path, value: null, display: "", error: null, pending: false, ...resolved }
      : null,
  };
}

let host: HTMLDivElement;
let root: Root;
const onClose = vi.fn();
const inputSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;

beforeEach(() => {
  h.bindings = [
    binding(CONTROL, "/properties/text", "=\"Region: \"&Data!B1", { display: "Region: Europe" }),
    binding(CHART, "/spec/title", "=Inputs!B1", { display: "Revenue 2025" }),
    binding(GONE, "/headerText", "=Data!A1", { display: "x" }),
    binding(CHART, "/spec/yAxis/min", "=Inputs!C1", { error: "'abc' is not a number.", display: "#VALUE!" }),
  ];
  h.places = [
    { object: CHART, name: "Revenue card", sheetIndex: 2, sheetName: "Report" },
    { object: CONTROL, name: "Banner", sheetIndex: 0, sheetName: "Data" },
  ];
  h.listeners = [];
  h.setBinding.mockReset();
  h.clearBinding.mockReset();
  h.clearBinding.mockResolvedValue(true);
  h.locate.mockReset();
  h.locate.mockImplementation(async () => h.places);
  h.goTo.mockReset();
  h.goTo.mockResolvedValue(true);
  onClose.mockReset();
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

async function open(): Promise<void> {
  await act(async () => {
    root.render(<BoundPropertiesDialog isOpen onClose={onClose} />);
  });
}

function rows(): HTMLTableRowElement[] {
  return [...host.querySelectorAll<HTMLTableRowElement>("[data-testid=bound-property-row]")];
}

function cell(row: HTMLElement, col: string): string {
  return row.querySelector(`[data-col=${col}]`)?.textContent ?? "";
}

function button(row: HTMLElement, action: string): HTMLButtonElement {
  return row.querySelector<HTMLButtonElement>(`[data-action=${action}]`)!;
}

async function click(el: HTMLElement): Promise<void> {
  await act(async () => {
    el.click();
  });
}

describe("the Bound Properties view", () => {
  it("lists every binding: object, the family's label or the path, formula, value or error", async () => {
    await open();
    expect(h.locate).toHaveBeenCalledWith([CONTROL, CHART, GONE]);
    const r = rows();
    expect(r).toHaveLength(4);
    // Sorted by sheet: Data (0), then Report (2) by property, then the orphan last.
    expect(r.map((x) => cell(x, "object"))).toEqual([
      "control Banner",
      "chart Revenue card",
      "chart Revenue card",
      "slicer (no longer in this workbook)",
    ]);
    // The family's label where it has one, else the path.
    expect(r.map((x) => cell(x, "property"))).toEqual(["/properties/text", "/spec/yAxis/min", "Chart title", "/headerText"]);
    expect(cell(r[2], "formula")).toBe("=Inputs!B1");
    expect(cell(r[2], "value")).toBe("Revenue 2025");
    expect(cell(r[1], "value")).toBe("#VALUE! - 'abc' is not a number.");
    // An orphan cannot be gone to, but can be removed.
    expect(button(r[3], "goto").disabled).toBe(true);
    expect(button(r[3], "remove").disabled).toBe(false);
  });

  it("says so when nothing is bound", async () => {
    h.bindings = [];
    await open();
    expect(host.querySelector("[data-testid=bound-properties-empty]")).not.toBeNull();
    expect(h.locate).not.toHaveBeenCalled();
  });

  it("removes a binding with ONE clearBinding, as a user edit", async () => {
    await open();
    await click(button(rows()[2], "remove"));
    expect(h.clearBinding).toHaveBeenCalledTimes(1);
    expect(h.clearBinding).toHaveBeenCalledWith(CHART, "/spec/title", { source: { kind: "user" } });
  });

  it("edits a binding in place through the shared editor: Enter sends ONE setBinding", async () => {
    h.setBinding.mockResolvedValue(h.bindings[1]);
    await open();
    await click(button(rows()[2], "edit"));
    const input = host.querySelector<HTMLInputElement>("[data-binding-formula-input]");
    expect(input, "the shared BindingFormulaEditor is shown in the row").not.toBeNull();
    await act(async () => {
      inputSetter?.call(input, "=Inputs!B2");
      input!.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => {
      input!.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    });
    expect(h.setBinding).toHaveBeenCalledTimes(1);
    expect(h.setBinding).toHaveBeenCalledWith(CHART, "/spec/title", "=Inputs!B2", {
      model: undefined,
      source: { kind: "user" },
    });
  });

  it("shows Rust's refusal sentence when an edit is refused", async () => {
    h.clearBinding.mockRejectedValue(new BindingRefusal("Cannot change objects on a protected sheet."));
    await open();
    await click(button(rows()[0], "remove"));
    expect(host.querySelector("[data-testid=bound-properties-error]")?.textContent).toBe(
      "Cannot change objects on a protected sheet.",
    );
  });

  it("goes to the object's place", async () => {
    await open();
    await click(button(rows()[2], "goto"));
    expect(h.goTo).toHaveBeenCalledWith(h.places[0]);
  });

  it("re-reads when the bindings change", async () => {
    await open();
    expect(rows()).toHaveLength(4);
    h.bindings = h.bindings.slice(0, 1);
    await act(async () => {
      for (const l of h.listeners) l();
    });
    expect(rows()).toHaveLength(1);
  });

  it("renders nothing while closed", async () => {
    await act(async () => {
      root.render(<BoundPropertiesDialog isOpen={false} onClose={onClose} />);
    });
    expect(host.querySelector("[data-testid=bound-properties-dialog]")).toBeNull();
  });
});

describe("the row helpers", () => {
  it("names each object once, in first-seen order", () => {
    expect(distinctObjects(h.bindings)).toEqual([CONTROL, CHART, GONE]);
  });

  it("says Calculating for a pending value and Not calculated for none", () => {
    expect(valueText(binding(CHART, "/a", "=1", { pending: true }))).toEqual({ text: "Calculating...", isError: false });
    expect(valueText(binding(CHART, "/a", "=1", null))).toEqual({ text: "Not calculated yet", isError: false });
  });

  it("falls back to the path when no family labels the property", () => {
    const built = buildBoundPropertyRows(h.bindings.slice(1, 2), h.places, () => null);
    expect(built[0].propertyText).toBe("/spec/title");
  });
});
