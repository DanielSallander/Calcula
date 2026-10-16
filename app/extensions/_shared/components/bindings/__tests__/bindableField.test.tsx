//! FILENAME: app/extensions/_shared/components/bindings/__tests__/bindableField.test.tsx
// PURPOSE: The shared fx widget of property bindings (D-BIND, WP-D S8a):
//            * fx ON + Enter writes the binding (`setBinding`, source user,
//              no `invariant`: Rust delocalises), never the literal;
//            * fx OFF on a bound field clears the binding (`clearBinding`);
//            * an unchanged commit is not a write (tab-through rule);
//            * a refusal is shown INLINE as Rust's sentence;
//            * the resolved value (or its error) shows under the field;
//            * it never steals focus on mount;
//            * Delete / Backspace in it never reach a global listener (the
//              BUG-0125 precedent: a Delete in a pane field must not delete
//              the selected object);
//            * the editor's "Insert measure" menu inserts `[Name]` and names
//              the model only when it is not the page default;
//            * the analysis line shows Rust's refusal after the debounce.
// CONTEXT: react-dom + act; the seam (`@api/objectBindings`) is doubled
//          except its pure catalog helpers.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { ObjectBindingInfo, ObjectBindingRef } from "@api/objectBindings";

const h = vi.hoisted(() => {
  class FakeRefusal extends Error {
    readonly sentence: string;
    constructor(sentence: string) {
      super(sentence);
      this.sentence = sentence;
    }
  }
  return {
    FakeRefusal,
    binding: null as null | Record<string, unknown>,
    setBinding: vi.fn(),
    clearBinding: vi.fn(),
    analyze: vi.fn(),
    measures: vi.fn(),
    listeners: new Set<(c: { objects: Array<{ kind: string; id: string }>; reload: boolean }) => void>(),
  };
});

vi.mock("@api/objectBindings", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@api/objectBindings")>()),
  BindingRefusal: h.FakeRefusal,
  getBinding: () => (h.binding ? JSON.parse(JSON.stringify(h.binding)) : null),
  setBinding: (...a: unknown[]) => h.setBinding(...a),
  clearBinding: (...a: unknown[]) => h.clearBinding(...a),
  analyzeBindingFormula: (...a: unknown[]) => h.analyze(...a),
  listBindingMeasures: (...a: unknown[]) => h.measures(...a),
  onBindingsChanged: (cb: never) => {
    h.listeners.add(cb);
    return () => h.listeners.delete(cb);
  },
}));

import { BindableField, describeResolved, formulaToCommit, isUnchangedBinding } from "../BindableField";
import { measureToken, spliceAt, BINDING_ANALYSIS_DEBOUNCE_MS } from "../BindingFormulaEditor";
import { isGridFocused } from "@api/keybindings";

Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

const REF: ObjectBindingRef = { kind: "control", id: "uid-1" };
const PATH = "/properties/text";

function boundInfo(formula = "=Sheet1!A1", display = "42"): ObjectBindingInfo {
  return {
    object: REF,
    path: PATH,
    formula,
    displayFormula: formula,
    model: null,
    resolved: { object: REF, path: PATH, value: display, display, error: null, pending: false },
  };
}

let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  h.binding = null;
  h.setBinding.mockReset();
  h.clearBinding.mockReset();
  h.analyze.mockReset();
  h.measures.mockReset();
  h.measures.mockResolvedValue([]);
  h.analyze.mockResolvedValue({ error: null, warning: null });
  h.clearBinding.mockResolvedValue(true);
  h.listeners.clear();
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(async () => {
  vi.useRealTimers();
  await act(async () => {
    root.unmount();
  });
  host.remove();
});

const literal = <input data-literal="" defaultValue="Hello" />;

async function mount(disabledReason?: string): Promise<void> {
  await act(async () => {
    root.render(
      <BindableField object={REF} path={PATH} label="Text" literal={literal} disabledReason={disabledReason} />,
    );
  });
}

function q<T extends Element>(sel: string): T | null {
  return host.querySelector<T>(sel);
}

const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;

async function typeInto(input: HTMLInputElement, text: string): Promise<void> {
  await act(async () => {
    input.focus();
    setter?.call(input, text);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

async function press(el: Element, key: string): Promise<void> {
  await act(async () => {
    el.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true }));
  });
}

describe("pure helpers", () => {
  it("formulaToCommit adds the '=' and refuses an empty formula", () => {
    expect(formulaToCommit("=A1")).toBe("=A1");
    expect(formulaToCommit("A1")).toBe("=A1");
    expect(formulaToCommit("  =A1  ")).toBe("=A1");
    expect(formulaToCommit("=")).toBeNull();
    expect(formulaToCommit("   ")).toBeNull();
  });

  it("isUnchangedBinding compares the localised formula and the model", () => {
    const b = boundInfo("=Sheet1!A1");
    expect(isUnchangedBinding("=Sheet1!A1", null, b)).toBe(true);
    expect(isUnchangedBinding("=Sheet1!A2", null, b)).toBe(false);
    expect(isUnchangedBinding("=Sheet1!A1", "m2", b)).toBe(false);
    expect(isUnchangedBinding("=A1", null, null)).toBe(false);
  });

  it("describeResolved says pending, error and value", () => {
    const b = boundInfo();
    expect(describeResolved(b)).toEqual({ text: "= 42", isError: false });
    expect(describeResolved({ ...b, resolved: { ...b.resolved!, pending: true } })?.text).toBe("Calculating...");
    expect(describeResolved({ ...b, resolved: { ...b.resolved!, display: "#REF!", error: "The cell is gone." } })).toEqual({
      text: "#REF! - The cell is gone.",
      isError: true,
    });
    expect(describeResolved(null)).toBeNull();
  });

  it("measureToken doubles ']' and spliceAt replaces the selection", () => {
    expect(measureToken("Revenue")).toBe("[Revenue]");
    expect(measureToken("A]B")).toBe("[A]]B]");
    expect(spliceAt("=1+", 3, 3, "[X]")).toEqual({ value: "=1+[X]", cursor: 6 });
    expect(spliceAt("=abc", 1, 4, "Z")).toEqual({ value: "=Z", cursor: 2 });
  });
});

describe("BindableField", () => {
  it("fx off shows the caller's LITERAL editor; fx on + Enter writes the binding, never the literal", async () => {
    h.setBinding.mockImplementation(async (_o: unknown, _p: unknown, f: string) => boundInfo(f, "7"));
    await mount();
    expect(q("[data-literal]"), "fx off: the literal editor").not.toBeNull();
    expect(q("[data-binding-formula-input]")).toBeNull();

    await act(async () => {
      q<HTMLButtonElement>("[data-bindable-fx]")!.click();
    });
    expect(q("[data-literal]"), "fx on: the literal editor is replaced").toBeNull();
    const input = q<HTMLInputElement>("[data-binding-formula-input]")!;
    expect(input.value).toBe("=");
    await typeInto(input, "=A1");
    await press(input, "Enter");
    await act(async () => {
      await Promise.resolve();
    });

    expect(h.setBinding).toHaveBeenCalledTimes(1);
    const [object, path, formula, opts] = h.setBinding.mock.calls[0];
    expect(object).toEqual(REF);
    expect(path).toBe(PATH);
    expect(formula).toBe("=A1");
    expect(opts).toEqual({ model: undefined, source: { kind: "user" } });
    expect((opts as { invariant?: boolean }).invariant, "a person's formula is localised: no invariant flag").toBeUndefined();
    expect(q("[data-bindable-resolved]")?.textContent).toBe("= 7");
  });

  // SABOTAGE: make toggleFx only flip the local state when bound (no removeBinding).
  it("fx OFF on a bound field clears the binding", async () => {
    h.binding = boundInfo() as never;
    await mount();
    expect(q("[data-bindable-field]")?.getAttribute("data-bound")).toBe("true");
    expect(q<HTMLInputElement>("[data-binding-formula-input]")?.value).toBe("=Sheet1!A1");
    h.clearBinding.mockImplementation(async () => {
      h.binding = null;
      return true;
    });
    await act(async () => {
      q<HTMLButtonElement>("[data-bindable-fx]")!.click();
    });
    expect(h.clearBinding).toHaveBeenCalledTimes(1);
    expect(h.clearBinding.mock.calls[0].slice(0, 2)).toEqual([REF, PATH]);
    expect(q("[data-literal]"), "the literal editor is back").not.toBeNull();
    expect(h.setBinding).not.toHaveBeenCalled();
  });

  it('"Remove binding" clears it too', async () => {
    h.binding = boundInfo() as never;
    await mount();
    await act(async () => {
      q<HTMLButtonElement>("[data-bindable-remove]")!.click();
    });
    expect(h.clearBinding).toHaveBeenCalledTimes(1);
  });

  it("an unchanged commit (focus and leave the stored formula) writes nothing", async () => {
    vi.useFakeTimers();
    h.binding = boundInfo() as never;
    await mount();
    const input = q<HTMLInputElement>("[data-binding-formula-input]")!;
    await act(async () => {
      input.focus();
    });
    await press(input, "Enter");
    await act(async () => {
      input.blur();
      vi.advanceTimersByTime(500);
    });
    expect(h.setBinding).not.toHaveBeenCalled();
  });

  it("a refusal is shown inline as Rust's sentence", async () => {
    h.setBinding.mockRejectedValue(new h.FakeRefusal("There is no measure [Nope] in model 'Sales'."));
    await mount();
    await act(async () => {
      q<HTMLButtonElement>("[data-bindable-fx]")!.click();
    });
    const input = q<HTMLInputElement>("[data-binding-formula-input]")!;
    await typeInto(input, "=[Nope]");
    await press(input, "Enter");
    await act(async () => {
      await Promise.resolve();
    });
    expect(q("[data-bindable-refusal]")?.textContent).toBe("There is no measure [Nope] in model 'Sales'.");
    expect(input.value, "the typed formula is kept for fixing").toBe("=[Nope]");
  });

  it("an error value shows its sentence under the field", async () => {
    const b = boundInfo();
    h.binding = { ...b, resolved: { ...b.resolved!, display: "#REF!", error: "The sheet was deleted." } } as never;
    await mount();
    const line = q("[data-bindable-resolved]");
    expect(line?.getAttribute("data-bindable-resolved")).toBe("error");
    expect(line?.textContent).toContain("The sheet was deleted.");
  });

  it("follows onBindingsChanged: a binding made elsewhere (a script) appears", async () => {
    await mount();
    expect(q("[data-bindable-field]")?.getAttribute("data-bound")).toBe("false");
    h.binding = boundInfo("=Sheet1!B2", "9") as never;
    await act(async () => {
      for (const l of h.listeners) l({ objects: [REF], reload: false });
    });
    expect(q("[data-bindable-field]")?.getAttribute("data-bound")).toBe("true");
    expect(q<HTMLInputElement>("[data-binding-formula-input]")?.value).toBe("=Sheet1!B2");
  });

  // SABOTAGE: add autoFocus to the BindingFormulaEditor <input>.
  it("never takes focus on mount (bound or not)", async () => {
    const outside = document.createElement("button");
    document.body.appendChild(outside);
    outside.focus();
    try {
      h.binding = boundInfo() as never;
      await mount();
      expect(document.activeElement, "the bound editor did not take focus").toBe(outside);
      await act(async () => {
        root.render(<BindableField object={{ kind: "control", id: "uid-2" }} path={PATH} label="Text" literal={literal} />);
      });
      expect(document.activeElement, "a re-mount on another object did not take focus").toBe(outside);
    } finally {
      outside.remove();
    }
  });

  // SABOTAGE: drop the onKeyDown={stopObjectKeys} on the field's root.
  it("Delete / Backspace in the field never reach a global key listener (BUG-0125 precedent)", async () => {
    h.binding = boundInfo() as never;
    await mount();
    const seen: string[] = [];
    const listener = (e: KeyboardEvent) => seen.push(e.key);
    document.addEventListener("keydown", listener);
    try {
      const input = q<HTMLInputElement>("[data-binding-formula-input]")!;
      await act(async () => {
        input.focus();
      });
      expect(isGridFocused(), "focus in a pane field is not the grid's").toBe(false);
      await press(input, "Delete");
      await press(input, "Backspace");
      const fx = q<HTMLButtonElement>("[data-bindable-fx]")!;
      await act(async () => {
        fx.focus();
      });
      await press(fx, "Delete");
      expect(seen, "no Delete/Backspace escaped the field").toEqual([]);
      // Positive control: another key does bubble.
      await press(input, "a");
      expect(seen).toEqual(["a"]);
    } finally {
      document.removeEventListener("keydown", listener);
    }
  });

  it("a disabled field shows why and offers no write", async () => {
    h.binding = boundInfo() as never;
    await mount("The sheet is protected.");
    const fx = q<HTMLButtonElement>("[data-bindable-fx]")!;
    expect(fx.disabled).toBe(true);
    expect(fx.title).toBe("The sheet is protected.");
    expect(q<HTMLInputElement>("[data-binding-formula-input]")!.readOnly).toBe(true);
    expect(q("[data-bindable-remove]")).toBeNull();
  });
});

describe("BindingFormulaEditor inside the field", () => {
  it("Insert measure puts [Name] in the formula and names the model only when it is not the page default", async () => {
    h.measures.mockResolvedValue([
      { modelKey: "sales", connectionId: "c1", name: "Sales", measures: ["Revenue"], isDefault: true },
      { modelKey: "hr", connectionId: "c2", name: "HR", measures: ["Headcount"], isDefault: false },
    ]);
    h.setBinding.mockImplementation(async (_o: unknown, _p: unknown, f: string, o: { model?: string }) => ({
      ...boundInfo(f),
      model: o.model ?? null,
    }));
    await mount();
    await act(async () => {
      q<HTMLButtonElement>("[data-bindable-fx]")!.click();
    });
    await act(async () => {
      await Promise.resolve();
    });
    const select = q<HTMLSelectElement>("[data-binding-insert-measure]");
    expect(select, "the measure menu is offered when the page has measures").not.toBeNull();
    const input = q<HTMLInputElement>("[data-binding-formula-input]")!;
    await act(async () => {
      input.focus();
      input.setSelectionRange(1, 1);
    });
    await act(async () => {
      select!.value = JSON.stringify(["hr", "Headcount"]);
      select!.dispatchEvent(new Event("change", { bubbles: true }));
    });
    expect(input.value).toBe("=[Headcount]");
    await press(input, "Enter");
    await act(async () => {
      await Promise.resolve();
    });
    expect(h.setBinding).toHaveBeenCalledTimes(1);
    expect(h.setBinding.mock.calls[0][2]).toBe("=[Headcount]");
    expect(h.setBinding.mock.calls[0][3]).toMatchObject({ model: "hr" });
  });

  it("the analysis line shows Rust's refusal after the debounce, not before", async () => {
    vi.useFakeTimers();
    h.analyze.mockResolvedValue({ error: "There is no sheet named 'NOWHERE'.", warning: null });
    await mount();
    await act(async () => {
      q<HTMLButtonElement>("[data-bindable-fx]")!.click();
    });
    const input = q<HTMLInputElement>("[data-binding-formula-input]")!;
    await typeInto(input, "=NOWHERE!A1");
    expect(h.analyze, "nothing asked before the debounce").not.toHaveBeenCalled();
    await act(async () => {
      vi.advanceTimersByTime(BINDING_ANALYSIS_DEBOUNCE_MS + 10);
    });
    await act(async () => {
      await Promise.resolve();
    });
    expect(h.analyze).toHaveBeenCalledTimes(1);
    expect(h.analyze.mock.calls[0][1]).toBe("=NOWHERE!A1");
    expect(q("[data-binding-refusal]")?.textContent).toBe("There is no sheet named 'NOWHERE'.");
  });
});
