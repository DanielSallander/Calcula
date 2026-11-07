//! FILENAME: app/extensions/DataValidation/components/__tests__/dataValidationDialogRelative.test.tsx
// PURPOSE: BUG-0745 on the user's path (lane cfdvfix, programme 2 wave 3).
//          The Data Validation dialog kept each part's `$` when it PARSED a
//          Source and then dropped the flags when it SAVED (it built the rule
//          with createListRuleFromRange, which has no relative parameter), so
//          `=F1:F2` was stored absolute and OK on an existing relative rule
//          silently made it absolute. Excel's dialog also states a relative
//          Source -- and a custom formula -- for the ACTIVE cell and stores it
//          for the range's top-left ([LIVE] cfdvb/probe1.ps1 C1/C2: `=F1:F2`
//          on H2:H4 reads `=F2:F3` at H3, `=$F1:F$2` reads `=$F3:F$2` at J4).
// CONTEXT: The real dialog over a doubled backend.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";

const h = vi.hoisted(() => ({
  ranges: [] as Array<Record<string, unknown>>,
  saved: [] as Array<{ range: number[]; validation: Record<string, unknown> }>,
  sel: null as null | Record<string, number>,
}));

/** A fill shifter for the plain references these tests use (A1, $A1, A$1). */
function shiftText(formula: string, rowDelta: number, colDelta: number): string {
  return formula.replace(/(\$?)([A-Z]{1,3})(\$?)(\d+)/g, (_m, cAbs: string, col: string, rAbs: string, row: string) => {
    let c = 0;
    for (const ch of col) c = c * 26 + (ch.charCodeAt(0) - 64);
    c -= 1;
    let r = Number(row) - 1;
    if (!cAbs) c += colDelta;
    if (!rAbs) r += rowDelta;
    if (c < 0 || r < 0) return "#REF!";
    let letters = "";
    for (let n = c + 1; n > 0; n = Math.floor((n - 1) / 26)) letters = String.fromCharCode(65 + ((n - 1) % 26)) + letters;
    return `${cAbs}${letters}${rAbs}${r + 1}`;
  });
}

vi.mock("@api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@api")>()),
  getSheets: async () => ({ sheets: [{ index: 0, name: "Sheet1" }], activeIndex: 0 }),
  getAllDataValidations: async () => h.ranges,
  getDataValidation: async () => null,
  setDataValidation: async (r0: number, c0: number, r1: number, c1: number, validation: Record<string, unknown>) => {
    h.saved.push({ range: [r0, c0, r1, c1], validation });
    return { success: true };
  },
  clearDataValidation: async () => ({ success: true }),
  shiftFormulasBatch: async (inputs: Array<{ formula: string; rowDelta: number; colDelta: number }>) =>
    inputs.map((i) => shiftText(i.formula, i.rowDelta, i.colDelta)),
}));
vi.mock("../../lib/validationStore", () => ({
  joinValidationRefresh: async () => undefined,
  getCurrentSelection: () => h.sel,
}));

import { DataValidationDialog } from "../DataValidationDialog";

let host: HTMLDivElement;
let root: Root;

async function flush(): Promise<void> {
  for (let i = 0; i < 8; i++) {
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
  }
}

/** Open the dialog over a selection `r0,c0:r1,c1` with `active` the active cell (0-based). */
async function open(r0: number, c0: number, r1: number, c1: number, active: [number, number]): Promise<void> {
  h.sel = { startRow: r0, startCol: c0, endRow: r1, endCol: c1, activeRow: active[0], activeCol: active[1] };
  await act(async () => {
    root.render(<DataValidationDialog isOpen onClose={() => {}} data={undefined as never} />);
  });
  await flush();
}

function input(placeholderStart: string): HTMLInputElement {
  const el = Array.from(host.querySelectorAll("input")).find((i) =>
    (i.getAttribute("placeholder") ?? "").startsWith(placeholderStart)
  );
  if (!el) throw new Error(`no input ${placeholderStart}`);
  return el as HTMLInputElement;
}

async function type(el: HTMLInputElement | HTMLSelectElement, value: string): Promise<void> {
  const proto = el instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
  await act(async () => {
    Object.getOwnPropertyDescriptor(proto, "value")!.set!.call(el, value);
    el.dispatchEvent(new Event(el instanceof HTMLSelectElement ? "change" : "input", { bubbles: true }));
  });
  await flush();
}

async function ok(): Promise<void> {
  const button = Array.from(host.querySelectorAll("button")).find((b) => b.textContent === "OK")!;
  await act(async () => {
    button.click();
  });
  await flush();
}

function listRange(saved: { validation: Record<string, unknown> }): Record<string, unknown> {
  const rule = saved.validation.rule as { list: { source: { range: Record<string, unknown> } } };
  return rule.list.source.range;
}

const ALL = { startRow: true, startCol: true, endRow: true, endCol: true };

function validationOn(r0: number, c0: number, r1: number, c1: number, rule: Record<string, unknown>) {
  return {
    startRow: r0,
    startCol: c0,
    endRow: r1,
    endCol: c1,
    validation: {
      rule,
      ignoreBlanks: true,
      prompt: { showPrompt: true, title: "", message: "" },
      errorAlert: { showAlert: true, style: "stop", title: "", message: "" },
    },
  };
}

beforeEach(() => {
  h.ranges = [];
  h.saved = [];
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

describe("Data Validation dialog: a relative Source (BUG-0745)", () => {
  it("saves =F1:F2 typed at the top-left with its relative flags", async () => {
    // H2:H4 selected, H2 active.
    await open(1, 7, 3, 7, [1, 7]);
    await type(host.querySelector("select")!, "list");
    await type(input("e.g., Yes"), "=F1:F2");
    await ok();
    expect(h.saved).toHaveLength(1);
    expect(listRange(h.saved[0])).toEqual({ sheetIndex: 0, startRow: 0, startCol: 5, endRow: 1, endCol: 5, relative: ALL });
  });

  it("reads what is typed for the ACTIVE cell and stores it for the top-left", async () => {
    // H2:H4 selected with H3 active: =F2:F3 typed there is =F1:F2 at H2.
    await open(1, 7, 3, 7, [2, 7]);
    await type(host.querySelector("select")!, "list");
    await type(input("e.g., Yes"), "=F2:F3");
    await ok();
    expect(listRange(h.saved[0])).toEqual({ sheetIndex: 0, startRow: 0, startCol: 5, endRow: 1, endCol: 5, relative: ALL });
  });

  it("shows a stored relative Source for the active cell, and OK keeps it relative", async () => {
    const stored = { list: { source: { range: { sheetIndex: 0, startRow: 0, startCol: 5, endRow: 1, endCol: 5, relative: ALL } }, inCellDropdown: true } };
    h.ranges = [validationOn(1, 7, 3, 7, stored)];
    await open(1, 7, 3, 7, [2, 7]);
    expect(input("e.g., Yes").value).toBe("=F2:F3");
    await ok();
    expect(listRange(h.saved[0])).toEqual({ sheetIndex: 0, startRow: 0, startCol: 5, endRow: 1, endCol: 5, relative: ALL });
  });

  it("shows a mixed source unordered at the active cell, as Excel does (C2)", async () => {
    const mixed = { startRow: true, startCol: false, endRow: false, endCol: true };
    const stored = { list: { source: { range: { sheetIndex: 0, startRow: 0, startCol: 5, endRow: 1, endCol: 5, relative: mixed } }, inCellDropdown: true } };
    h.ranges = [validationOn(1, 9, 3, 9, stored)];
    await open(1, 9, 3, 9, [3, 9]);
    expect(input("e.g., Yes").value).toBe("=$F3:F$2");
    await ok();
    expect(listRange(h.saved[0])).toEqual({ sheetIndex: 0, startRow: 0, startCol: 5, endRow: 1, endCol: 5, relative: mixed });
  });

  it("an absolute source stays absolute and is not moved", async () => {
    await open(1, 7, 3, 7, [3, 7]);
    await type(host.querySelector("select")!, "list");
    await type(input("e.g., Yes"), "=$F$1:$F$2");
    await ok();
    expect(listRange(h.saved[0])).toEqual({ sheetIndex: 0, startRow: 0, startCol: 5, endRow: 1, endCol: 5 });
  });
});

describe("Data Validation dialog: a custom formula is stated for the active cell", () => {
  it("stores what is typed at the active cell for the top-left, and shows it back there", async () => {
    await open(1, 0, 4, 0, [3, 0]);
    await type(host.querySelector("select")!, "custom");
    await type(input("e.g., =AND"), "=A4>5");
    await ok();
    expect(h.saved[0].validation.rule).toEqual({ custom: { formula: "=A2>5" } });

    h.saved = [];
    h.ranges = [validationOn(1, 0, 4, 0, { custom: { formula: "=A2>5" } })];
    await act(async () => root.unmount());
    root = createRoot(host);
    await open(1, 0, 4, 0, [3, 0]);
    expect(input("e.g., =AND").value).toBe("=A4>5");
  });
});
