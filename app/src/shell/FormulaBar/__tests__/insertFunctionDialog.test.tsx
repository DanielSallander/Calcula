//! FILENAME: app/src/shell/FormulaBar/__tests__/insertFunctionDialog.test.tsx
// PURPOSE: The fx dialog's two jobs after CUBE moved into it — filtering the
//          catalog by category, and routing a function with a registered
//          builder to step 2 instead of handing back a template.
//
// WHY THE CATEGORY TESTS EXIST AT ALL. The category buttons used to be a
// hard-coded list of eight ids compared against a normalized category string,
// and the normalization did not agree with the ids: `"Date & Time"` became
// `date___time` (a space, an ampersand and a space, each replaced) while the id
// read `date_time`, so that button — and "Lookup & Reference" with it — filtered
// the list down to NOTHING. A dead filter looks exactly like a category with no
// functions in it, which is why it survived. The list is now derived from the
// catalog the backend ships, so the label and the value it filters on come from
// the same string and cannot drift apart again.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";

// ---------------------------------------------------------------------------
// Doubles: the catalog, spelled the way the Rust catalog spells it (see
// core/parser/src/ast.rs — "Math", "Date & Time", "Lookup & Reference", "Cube").
// ---------------------------------------------------------------------------

const CATALOG = [
  { name: "SUM", category: "Math", syntax: "SUM(number1, ...)", description: "Adds numbers" },
  { name: "TODAY", category: "Date & Time", syntax: "TODAY()", description: "Today's date" },
  { name: "VLOOKUP", category: "Lookup & Reference", syntax: "VLOOKUP(x)", description: "Looks up" },
  {
    name: "CUBEVALUE",
    category: "Cube",
    syntax: "CUBEVALUE(connection, [member1], ...)",
    description: "Returns an aggregated value from a Calcula BI model",
  },
];

const getFunctionTemplate = vi.fn(async (name: string) => `=${name}()`);

vi.mock("../../../core/lib/tauri-api", () => ({
  getAllFunctions: () => Promise.resolve({ functions: CATALOG }),
  getFunctionTemplate: (name: string) => getFunctionTemplate(name),
}));

import { InsertFunctionDialog } from "../InsertFunctionDialog";
import {
  registerFunctionBuilder,
  resetFunctionBuilders,
  type FunctionBuilderProps,
} from "../../../api/functionBuilders";

// ---------------------------------------------------------------------------

let container: HTMLDivElement;
let root: Root;

const onSelect = vi.fn();
const onBuilt = vi.fn();
const onClose = vi.fn();

async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
}

async function render(): Promise<void> {
  await act(async () => {
    root.render(
      React.createElement(InsertFunctionDialog, {
        onSelect,
        onBuilt,
        onClose,
        anchor: { row: 4, col: 2 },
      }),
    );
  });
  await flush();
}

function texts(selector: string): string[] {
  return [...container.querySelectorAll(selector)].map((el) => el.textContent ?? "");
}

/** Every category chip, by its label. */
function categoryLabels(): string[] {
  // The chips are the only buttons that sit above the list container.
  return texts("button").filter((t) => t !== "x" && t !== "Cancel" && t !== "Insert" && t !== "Back");
}

function clickButtonLabelled(label: string): void {
  const el = [...container.querySelectorAll("button")].find((b) => b.textContent === label);
  if (!el) throw new Error(`no button labelled "${label}" (have: ${categoryLabels().join(", ")})`);
  act(() => {
    el.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
}

/** Which of the catalog's functions are currently listed. */
function visibleNames(): string[] {
  const all = texts("div");
  return CATALOG.map((f) => f.name).filter((n) => all.includes(n));
}

function clickFunction(name: string): void {
  const el = [...container.querySelectorAll("div")].find((d) => d.textContent === name);
  if (!el) throw new Error(`function "${name}" is not listed`);
  act(() => {
    el.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
}

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  onSelect.mockClear();
  onBuilt.mockClear();
  onClose.mockClear();
  getFunctionTemplate.mockClear();
  resetFunctionBuilders();
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe("Insert Function dialog — categories", () => {
  it("offers a chip for every category the catalog ships, not a hard-coded list", async () => {
    await render();

    const labels = categoryLabels();
    expect(labels).toContain("All");
    // "Cube" had NO chip before: it was not one of the eight hard-coded ids.
    expect(labels).toContain("Cube");
    expect(labels).toContain("Date & Time");
    expect(labels).toContain("Lookup & Reference");
    // "Math" is shown under Excel's name for it.
    expect(labels).toContain("Math & Trig");
    expect(labels).not.toContain("Math");
  });

  it("actually filters on the ampersand categories that used to filter to nothing", async () => {
    await render();
    expect(visibleNames()).toEqual(["SUM", "TODAY", "VLOOKUP", "CUBEVALUE"]);

    clickButtonLabelled("Date & Time");
    expect(visibleNames()).toEqual(["TODAY"]);

    clickButtonLabelled("Lookup & Reference");
    expect(visibleNames()).toEqual(["VLOOKUP"]);

    clickButtonLabelled("Cube");
    expect(visibleNames()).toEqual(["CUBEVALUE"]);

    clickButtonLabelled("All");
    expect(visibleNames()).toEqual(["SUM", "TODAY", "VLOOKUP", "CUBEVALUE"]);
  });
});

describe("Insert Function dialog — argument builders", () => {
  /** A builder that reports a finished formula as soon as it mounts. */
  function StubBuilder(props: FunctionBuilderProps): React.ReactElement {
    const { context, onFormulaChange } = props;
    React.useEffect(() => {
      onFormulaChange(`=${context.functionName}("S","[Revenue]")`);
    }, [context.functionName, onFormulaChange]);
    return React.createElement(
      "div",
      { "data-testid": "stub-builder" },
      `builder for ${context.functionName} at ${context.row},${context.col}`,
    );
  }

  /** A builder that never reports a formula: Insert must stay disabled. */
  function IncompleteBuilder(props: FunctionBuilderProps): React.ReactElement {
    const { onFormulaChange } = props;
    React.useEffect(() => {
      onFormulaChange(null);
    }, [onFormulaChange]);
    return React.createElement("div", null, "incomplete");
  }

  it("inserts a template for a function with no builder", async () => {
    await render();

    clickFunction("SUM");
    clickButtonLabelled("Insert");
    await flush();

    expect(getFunctionTemplate).toHaveBeenCalledWith("SUM");
    expect(onSelect).toHaveBeenCalledWith("SUM", "=SUM()");
    expect(onBuilt).not.toHaveBeenCalled();
  });

  it("opens the builder instead of a template, and hands it the anchor cell", async () => {
    registerFunctionBuilder({
      id: "stub",
      functions: ["CUBEVALUE"],
      component: StubBuilder,
    });
    await render();

    clickFunction("CUBEVALUE");
    clickButtonLabelled("Insert");
    await flush();

    // No template was even asked for — the builder owns the arguments.
    expect(getFunctionTemplate).not.toHaveBeenCalled();
    expect(onSelect).not.toHaveBeenCalled();

    const panel = container.querySelector("[data-testid='stub-builder']");
    expect(panel?.textContent).toBe("builder for CUBEVALUE at 4,2");
  });

  it("previews exactly what Insert will commit, and hands that string back", async () => {
    registerFunctionBuilder({ id: "stub", functions: ["CUBEVALUE"], component: StubBuilder });
    await render();

    clickFunction("CUBEVALUE");
    clickButtonLabelled("Insert");
    await flush();

    const preview = container.querySelector("[data-testid='function-builder-preview']");
    expect(preview?.textContent).toBe('=CUBEVALUE("S","[Revenue]")');

    clickButtonLabelled("Insert");
    expect(onBuilt).toHaveBeenCalledWith('=CUBEVALUE("S","[Revenue]")');
  });

  it("refuses to insert while the builder reports nothing", async () => {
    registerFunctionBuilder({
      id: "stub",
      functions: ["CUBEVALUE"],
      component: IncompleteBuilder,
    });
    await render();

    clickFunction("CUBEVALUE");
    clickButtonLabelled("Insert");
    await flush();

    expect(container.querySelector("[data-testid='function-builder']")).not.toBeNull();

    clickButtonLabelled("Insert");
    expect(onBuilt).not.toHaveBeenCalled();
  });

  it("goes Back to the catalog without inserting anything", async () => {
    registerFunctionBuilder({ id: "stub", functions: ["CUBEVALUE"], component: StubBuilder });
    await render();

    clickFunction("CUBEVALUE");
    clickButtonLabelled("Insert");
    await flush();
    expect(container.querySelector("[data-testid='function-builder']")).not.toBeNull();

    clickButtonLabelled("Back");
    await flush();

    expect(container.querySelector("[data-testid='function-builder']")).toBeNull();
    expect(onBuilt).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
    // The catalog is back, unfiltered.
    expect(visibleNames()).toEqual(["SUM", "TODAY", "VLOOKUP", "CUBEVALUE"]);
  });

  it("picks up a builder registered after the dialog is already open", async () => {
    await render();

    await act(async () => {
      registerFunctionBuilder({ id: "late", functions: ["CUBEVALUE"], component: StubBuilder });
    });
    await flush();

    clickFunction("CUBEVALUE");
    clickButtonLabelled("Insert");
    await flush();

    expect(container.querySelector("[data-testid='stub-builder']")).not.toBeNull();
    expect(onSelect).not.toHaveBeenCalled();
  });
});
