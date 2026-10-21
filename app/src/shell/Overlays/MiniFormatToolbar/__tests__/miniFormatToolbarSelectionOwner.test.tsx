//! FILENAME: app/src/shell/Overlays/MiniFormatToolbar/__tests__/miniFormatToolbarSelectionOwner.test.tsx
// PURPOSE: The mini format toolbar refuses -- one toast, nothing written, its
//          buttons NOT shown pressed -- while a selection owner holds the
//          selection, and formats Core's selection when nothing does.
// CONTEXT: BUG-0185. The toolbar rides on the grid's context menu and formats
//          the menu context's selection, which is Core's -- a cell hidden
//          under a floating grid while that grid's cell is selected (a
//          right-press inside Core's hidden selection still opens this menu,
//          BUG-0186). The owner here is a TEST owner (@api/selectionOwner).

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";

const { getCellMock, getStyleMock, applyMock, adjustMock } = vi.hoisted(() => ({
  getCellMock: vi.fn(),
  getStyleMock: vi.fn(),
  applyMock: vi.fn(),
  adjustMock: vi.fn(),
}));

vi.mock("../../../../api/lib", () => ({
  getCell: getCellMock,
  getStyle: getStyleMock,
  applyFormatting: applyMock,
  // Increase / Decrease Decimal write through the backend's decimal step.
  adjustNumberFormatDecimals: adjustMock,
}));

/** Every write the toolbar can make, through either door. */
const writes = (): number => applyMock.mock.calls.length + adjustMock.mock.calls.length;
vi.mock("../../../../api", () => ({ cellEvents: { emit: vi.fn() } }));
vi.mock("../../../../api/theme", () => ({ getThemeColorPalette: vi.fn(async () => []) }));
// The cell-target seam is REAL (P3); only its backend read is doubled.
const readTargetCellMock = vi.hoisted(() => vi.fn());
vi.mock("../../../../api/cellTarget", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../../api/cellTarget")>()),
  readTargetCell: (...a: unknown[]) => readTargetCellMock(...a),
}));

import { MiniFormatToolbar } from "../MiniFormatToolbar";
import type { GridMenuContext } from "../../../../api/extensions";
import { registerSelectionOwner, type CellTargetCapability } from "../../../../api/selectionOwner";
import { CELL_TARGET_CAPABILITIES } from "../../../../api/cellTarget";
import { registerToastSink, type ToastPayload } from "../../../../api/notifications";

let container: HTMLDivElement;
let root: Root;
const toasts: ToastPayload[] = [];
let release: (() => void) | null = null;

const CONTEXT = {
  selection: { startRow: 1, startCol: 2, endRow: 2, endCol: 3, type: "cells" },
  clickedCell: { row: 1, col: 2 },
  isWithinSelection: true,
  sheetIndex: 0,
  sheetName: "Sheet1",
  dimensions: { columnWidths: new Map(), rowHeights: new Map() },
} as unknown as GridMenuContext;

async function render(): Promise<void> {
  await act(async () => {
    root.render(<MiniFormatToolbar position={{ x: 200, y: 300 }} context={CONTEXT} onClose={() => {}} />);
  });
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

function byTestId<T extends HTMLElement = HTMLElement>(id: string): T {
  const el = document.querySelector<T>(`[data-testid="${id}"]`);
  if (!el) throw new Error(`no element [data-testid="${id}"]`);
  return el;
}

async function click(el: Element): Promise<void> {
  await act(async () => {
    el.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }));
    el.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, cancelable: true }));
    el.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
  });
}

async function selectValue(el: HTMLSelectElement, value: string): Promise<void> {
  await act(async () => {
    el.value = value;
    el.dispatchEvent(new Event("change", { bubbles: true }));
  });
}

beforeEach(() => {
  Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
  getCellMock.mockReset();
  getStyleMock.mockReset();
  applyMock.mockReset();
  getCellMock.mockResolvedValue({ row: 1, col: 2, styleIndex: 7, display: "" });
  getStyleMock.mockResolvedValue({
    fontFamily: "Calibri", fontSize: 11, bold: false, italic: false, underline: "none",
    strikethrough: false, textColor: "#000000", backgroundColor: "#ffffff", textAlign: "general",
  });
  applyMock.mockResolvedValue({ cells: [] });
  adjustMock.mockReset();
  adjustMock.mockResolvedValue({ cells: [], styles: [] });
  toasts.length = 0;
  registerToastSink((t) => toasts.push(t));
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  release?.();
  release = null;
  act(() => root.unmount());
  document.body.innerHTML = "";
});

/** The toolbar's writing controls, driven the way a user drives them. */
const DOORS: [string, () => Promise<void>][] = [
  ["Bold", () => click(byTestId("mini-format-bold"))],
  ["Italic", () => click(byTestId("mini-format-italic"))],
  ["Underline", () => click(byTestId("mini-format-underline"))],
  ["Strikethrough", () => click(byTestId("mini-format-strikethrough"))],
  ["Grow font", () => click(byTestId("mini-format-grow"))],
  ["Shrink font", () => click(byTestId("mini-format-shrink"))],
  ["Align right", () => click(byTestId("mini-format-align-right"))],
  ["Percent", () => click(byTestId("mini-format-percent"))],
  ["Comma", () => click(byTestId("mini-format-comma"))],
  ["Decimal +", () => click(byTestId("mini-format-decimal-increase"))],
  ["Decimal -", () => click(byTestId("mini-format-decimal-decrease"))],
  ["Font", () => selectValue(byTestId<HTMLSelectElement>("mini-format-font"), "Verdana")],
  ["Size", () => selectValue(byTestId<HTMLSelectElement>("mini-format-size"), "14")],
];

describe("mini format toolbar while a selection owner holds the selection", () => {
  for (const [label, run] of DOORS) {
    it(`${label}: writes nothing, says so once`, async () => {
      release = registerSelectionOwner({ id: "test-owner", label: "the test object's cells", ownsSelection: () => true });
      await render();
      await run();
      expect(writes(), `${label} formatted Core's hidden selection`).toBe(0);
      expect(toasts.length).toBe(1);
    });
  }

  it("a refused Bold is not shown as pressed (the toolbar must not claim a format it did not apply)", async () => {
    release = registerSelectionOwner({ id: "test-owner", label: "x", ownsSelection: () => true });
    await render();
    await click(byTestId("mini-format-bold"));
    expect(byTestId("mini-format-bold").getAttribute("aria-pressed")).toBe("false");
  });
});

describe("positive controls: nothing owns the selection", () => {
  for (const [label, run] of DOORS) {
    it(`${label}: formats Core's selection, no refusal`, async () => {
      await render();
      await run();
      expect(writes()).toBe(1);
      expect(toasts).toEqual([]);
    });
  }
});

// ============================================================================
// P3 S9: a floating grid's cells
// ============================================================================

const REF = { kind: "floatingRange" as const, id: "fr-9" };
const ADMITTED = CELL_TARGET_CAPABILITIES.filter((c) => c !== "table" && c !== "filter" && c !== "shiftCells");

/** A double of the floating grid's claim: its own selection F7:F8 (active F8). */
function floatingGrid(actsOn?: readonly CellTargetCapability[]): void {
  release = registerSelectionOwner({
    id: "floatingRange",
    label: "a floating grid's cells",
    ownsSelection: () => true,
    cellTarget: () => ({
      ref: REF,
      selection: { startRow: 6, startCol: 5, endRow: 7, endCol: 5, activeRow: 7, activeCol: 5, type: "cells" },
      bounds: { rows: 10, cols: 8 },
      label: "Float1",
      wholeObject: false,
    }),
    ...(actsOn ? { actsOn } : {}),
  });
}

describe("mini format toolbar on a floating grid's cells (P3)", () => {
  beforeEach(() => {
    readTargetCellMock.mockReset();
    readTargetCellMock.mockResolvedValue({ row: 7, col: 5, styleIndex: 9, display: "", valueKind: "empty" });
  });

  for (const [label, run] of DOORS) {
    it(`${label}: writes the GRID's cells with { target }, never Core's`, async () => {
      floatingGrid(ADMITTED);
      await render();
      await run();
      expect(toasts, `${label} was refused`).toEqual([]);
      const calls = [...applyMock.mock.calls, ...adjustMock.mock.calls];
      expect(calls.length).toBe(1);
      const call = calls[0] as unknown[];
      const [rows, cols] = call as [number[], number[]];
      expect([...rows].sort()).toEqual([6, 7]);
      expect(cols).toEqual([5]);
      expect(call[3], `${label} wrote without the target`).toEqual({ target: REF });
    });
  }

  it("the pill describes the grid's ACTIVE cell, read through the target", async () => {
    floatingGrid(ADMITTED);
    await render();
    expect(readTargetCellMock).toHaveBeenCalledWith(REF, 7, 5);
    expect(getCellMock).not.toHaveBeenCalled();
    expect(getStyleMock).toHaveBeenCalledWith(9);
  });

  it("Decimal +: the grid's ACTIVE cell goes first", async () => {
    floatingGrid(ADMITTED);
    await render();
    await click(byTestId("mini-format-decimal-increase"));
    expect(adjustMock.mock.calls).toEqual([[[7, 6], [5], 1, { target: REF }]]);
  });

  for (const [label, run] of DOORS) {
    it(`inert until S8: ${label} refuses on a floating grid that admits nothing`, async () => {
      floatingGrid(undefined);
      await render();
      await run();
      expect(writes()).toBe(0);
      expect(toasts.length).toBe(1);
    });
  }
});
