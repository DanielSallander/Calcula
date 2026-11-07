//! FILENAME: app/extensions/ConditionalFormatting/components/__tests__/cfEntryRelativeToActiveCell.test.tsx
// PURPOSE: BUG-0748 (dialog part), through the real doors and dialogs: a rule
//          formula typed in New Rule or a Highlight Cells Rules dialog is read
//          relative to the selection's ACTIVE cell and stored for the rule's
//          first cell, as Excel stores it.
// CONTEXT: Excel 16 [LIVE] 2026-11-06 (lane uiforms probe4): A2:E10 selected
//          with B5 active -- New Rule "=$C5>100" is stored =$C2>100, "=A4<>B5"
//          =XFD1<>A2, Greater Than "=$C5" =$C2. The dialogs sent the text as
//          typed, so the rule tested three rows too low; the menu doors did not
//          even tell the dialogs which cell was active.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";

const h = vi.hoisted(() => ({
  addConditionalFormat: vi.fn(),
  shiftFormulasBatch: vi.fn(),
  showDialog: vi.fn(),
  invalidateAndRefresh: vi.fn(async () => undefined),
}));

vi.mock("@api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@api")>()),
  addConditionalFormat: (...a: unknown[]) => h.addConditionalFormat(...a),
  shiftFormulasBatch: (...a: unknown[]) => h.shiftFormulasBatch(...a),
  showDialog: (...a: unknown[]) => h.showDialog(...a),
  restoreFocusToGrid: vi.fn(),
}));
vi.mock("../../lib/cfStore", () => ({ invalidateAndRefresh: () => h.invalidateAndRefresh() }));
vi.mock("../ColorScaleGallery", () => ({ ColorScaleGallery: () => null }));
vi.mock("../DataBarGallery", () => ({ DataBarGallery: () => null }));
vi.mock("../IconSetGallery", () => ({ IconSetGallery: () => null }));

import { NewRuleDialog } from "../NewRuleDialog";
import { QuickCFDialog } from "../QuickCFDialog";
import { registerCFMenuItems, setMenuSelection } from "../../handlers/homeMenuBuilder";
import { fakeShiftBatch } from "../../lib/__tests__/fakeFillShifter";

/** A2:E10, the probe's range. */
const A2_E10 = { startRow: 1, startCol: 0, endRow: 9, endCol: 4 };
const B5 = { row: 4, col: 1 };

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
  h.addConditionalFormat.mockReset();
  h.addConditionalFormat.mockResolvedValue({ success: true });
  h.shiftFormulasBatch.mockReset();
  h.shiftFormulasBatch.mockImplementation(fakeShiftBatch);
  h.showDialog.mockReset();
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  document.body.innerHTML = "";
});

function render(node: React.ReactNode): void {
  act(() => {
    root.render(node);
  });
}

function button(text: string): HTMLButtonElement {
  const found = Array.from(document.querySelectorAll("button")).find((b) => b.textContent?.trim() === text);
  if (!found) throw new Error(`no button "${text}"`);
  return found;
}

function type(input: HTMLInputElement, value: string): void {
  act(() => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
    setter.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

function choose(select: HTMLSelectElement, value: string): void {
  act(() => {
    const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")!.set!;
    setter.call(select, value);
    select.dispatchEvent(new Event("change", { bubbles: true }));
  });
}

function selectWithOption(value: string): HTMLSelectElement {
  const found = Array.from(document.querySelectorAll("select")).find((s) =>
    Array.from(s.options).some((o) => o.value === value),
  );
  if (!found) throw new Error(`no select offering "${value}"`);
  return found;
}

async function settle(): Promise<void> {
  await act(async () => {
    for (let i = 0; i < 10; i++) await Promise.resolve();
  });
  await new Promise((r) => setTimeout(r, 0));
}

function addedRule(): unknown {
  expect(h.addConditionalFormat).toHaveBeenCalledTimes(1);
  return h.addConditionalFormat.mock.calls[0][0].rule;
}

describe("New Rule: the formula is typed for the ACTIVE cell", () => {
  it("[LIVE] =$C5>100 with B5 active in A2:E10 is written =$C2>100", async () => {
    render(<NewRuleDialog isOpen onClose={vi.fn()} data={{ selection: A2_E10, activeCell: B5, initialCategory: "formula" }} />);
    type(document.querySelector<HTMLInputElement>("input[placeholder='=A1>100']")!, "=$C5>100");
    act(() => button("OK").click());
    await settle();
    expect(addedRule()).toEqual({ type: "expression", formula: "=$C2>100" });
  });

  it("[LIVE] =A4<>B5 with B5 active is written =XFD1<>A2 (the reference wraps round the edge)", async () => {
    render(<NewRuleDialog isOpen onClose={vi.fn()} data={{ selection: A2_E10, activeCell: B5, initialCategory: "formula" }} />);
    type(document.querySelector<HTMLInputElement>("input[placeholder='=A1>100']")!, "=A4<>B5");
    act(() => button("OK").click());
    await settle();
    expect(addedRule()).toEqual({ type: "expression", formula: "=XFD1<>A2" });
  });

  it("a Cell Value operand =$C5 is written =$C2", async () => {
    render(<NewRuleDialog isOpen onClose={vi.fn()} data={{ selection: A2_E10, activeCell: B5 }} />);
    choose(selectWithOption("cellValue"), "cellValue");
    const [value1] = Array.from(document.querySelectorAll<HTMLInputElement>("input[placeholder='Value']"));
    type(value1, "=$C5");
    act(() => button("OK").click());
    await settle();
    expect(addedRule()).toMatchObject({ type: "cellValue", operator: "greaterThan", value1: "=$C2" });
  });

  it("typed at the top-left cell nothing moves (and the shifter is not asked)", async () => {
    render(<NewRuleDialog isOpen onClose={vi.fn()} data={{ selection: A2_E10, activeCell: { row: 1, col: 0 }, initialCategory: "formula" }} />);
    type(document.querySelector<HTMLInputElement>("input[placeholder='=A1>100']")!, "=$C2>100");
    act(() => button("OK").click());
    await settle();
    expect(addedRule()).toEqual({ type: "expression", formula: "=$C2>100" });
    expect(h.shiftFormulasBatch).not.toHaveBeenCalled();
  });

  it("a range that would wrap apart is refused on screen, and nothing is written", async () => {
    const onClose = vi.fn();
    render(<NewRuleDialog isOpen onClose={onClose} data={{ selection: A2_E10, activeCell: B5, initialCategory: "formula" }} />);
    type(document.querySelector<HTMLInputElement>("input[placeholder='=A1>100']")!, "=SUM(C2:C5)>0");
    act(() => button("OK").click());
    await settle();
    expect(h.addConditionalFormat).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
    expect(document.querySelector("[role='alert']")?.textContent).toContain("wrap around the edge");
  });
});

describe("Highlight Cells Rules: a formula operand is typed for the ACTIVE cell", () => {
  it("[LIVE] Greater Than =$C5 with B5 active is written =$C2", async () => {
    render(<QuickCFDialog isOpen onClose={vi.fn()} data={{ ruleType: "greaterThan", selection: A2_E10, activeCell: B5 }} />);
    type(document.querySelector<HTMLInputElement>("input[type='text']")!, "=$C5");
    act(() => button("OK").click());
    await settle();
    expect(addedRule()).toEqual({ type: "cellValue", operator: "greaterThan", value1: "=$C2" });
  });

  it("a plain value is a value: 100 stays 100", async () => {
    render(<QuickCFDialog isOpen onClose={vi.fn()} data={{ ruleType: "lessThan", selection: A2_E10, activeCell: B5 }} />);
    type(document.querySelector<HTMLInputElement>("input[type='text']")!, "100");
    act(() => button("OK").click());
    await settle();
    expect(addedRule()).toEqual({ type: "cellValue", operator: "lessThan", value1: "100" });
  });
});

describe("the menu doors tell the dialogs which cell is active", () => {
  const items = new Map<string, { action?: () => unknown; children?: unknown[] }>();
  function collect(item: { id: string; action?: () => unknown; children?: unknown[] }): void {
    items.set(item.id, item);
    for (const child of (item.children ?? []) as Array<{ id: string }>) collect(child);
  }

  beforeEach(() => {
    items.clear();
    registerCFMenuItems({ ui: { menus: { registerItem: (_m: string, item: { id: string }) => collect(item) } } } as never);
  });

  it("New Rule... and Greater Than... carry the active cell (the grid's activeRow/activeCol)", async () => {
    // Anchor A2, far corner E10, the grid's active cell B5.
    setMenuSelection({ startRow: 1, startCol: 0, endRow: 9, endCol: 4, activeRow: 4, activeCol: 1 });
    await items.get("cf:newRule")!.action!();
    await items.get("cf:greaterThan")!.action!();
    expect(h.showDialog).toHaveBeenCalledTimes(2);
    for (const [, data] of h.showDialog.mock.calls) {
      expect(data.selection).toEqual(A2_E10);
      expect(data.activeCell).toEqual(B5);
    }
  });

  it("without an explicit active cell it is the selection's end, as the grid draws it", async () => {
    setMenuSelection({ startRow: 9, startCol: 4, endRow: 1, endCol: 0 });
    await items.get("cf:newRule")!.action!();
    expect(h.showDialog.mock.calls[0][1].activeCell).toEqual({ row: 1, col: 0 });
  });
});
