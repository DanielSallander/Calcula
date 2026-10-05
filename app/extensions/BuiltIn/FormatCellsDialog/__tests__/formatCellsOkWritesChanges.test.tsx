//! FILENAME: app/extensions/BuiltIn/FormatCellsDialog/__tests__/formatCellsOkWritesChanges.test.tsx
// PURPOSE: Format Cells' OK, through the real dialog and the real command:
//          it writes only what the user changed (survey D5), Outline on a range
//          is an outside border, the whole OK is ONE undo step, a refusal is
//          shown instead of being logged, and FORMAT_CELLS { category } opens
//          the Number tab on that category ("More Accounting Formats...").
// CONTEXT: The plan itself is pinned by lib/__tests__/formatCellsWrites.test.ts;
//          this file proves the dialog loads the right baseline (an EMPTY
//          active cell included) and executes the plan.

/* eslint-disable @typescript-eslint/naming-convention --
 * The module doubles below stand in for the six tab COMPONENTS. */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";

const h = vi.hoisted(() => ({
  getCell: vi.fn(),
  getStyle: vi.fn(),
  applyFormatting: vi.fn(),
  applyBorderPreset: vi.fn(),
  begin: vi.fn(),
  commit: vi.fn(),
  cancel: vi.fn(),
  setCellProtection: vi.fn(),
  getCellProtection: vi.fn(),
  alert: vi.fn(),
  openDialog: vi.fn(),
  selection: { startRow: 0, startCol: 0, endRow: 2, endCol: 2 },
}));

vi.mock("@api", () => ({
  useGridState: () => ({ selection: h.selection }),
  cellEvents: { emit: vi.fn() },
}));
vi.mock("@api/lib", () => ({
  getCell: (...a: unknown[]) => h.getCell(...a),
  getStyle: (...a: unknown[]) => h.getStyle(...a),
  applyFormatting: (...a: unknown[]) => h.applyFormatting(...a),
  applyBorderPreset: (...a: unknown[]) => h.applyBorderPreset(...a),
  beginUndoTransaction: (...a: unknown[]) => h.begin(...a),
  commitUndoTransaction: (...a: unknown[]) => h.commit(...a),
  cancelUndoTransaction: (...a: unknown[]) => h.cancel(...a),
}));
vi.mock("@api/backend", () => ({
  setCellProtection: (...a: unknown[]) => h.setCellProtection(...a),
  getCellProtection: (...a: unknown[]) => h.getCellProtection(...a),
}));
vi.mock("@api/dialogs", () => ({ alertAsync: (...a: unknown[]) => h.alert(...a) }));
vi.mock("@api/ui", () => ({
  DialogExtensions: { registerDialog: vi.fn(), unregisterDialog: vi.fn(), openDialog: (...a: unknown[]) => h.openDialog(...a) },
}));
vi.mock("../tabs/NumberTab", async () => {
  const R = await import("react");
  return { NumberTab: () => R.createElement("input", { "data-testid": "in-dialog" }) };
});
vi.mock("../tabs/AlignmentTab", () => ({ AlignmentTab: () => null }));
vi.mock("../tabs/FontTab", () => ({ FontTab: () => null }));
vi.mock("../tabs/BorderTab", () => ({ BorderTab: () => null }));
vi.mock("../tabs/FillTab", () => ({ FillTab: () => null }));
vi.mock("../tabs/ProtectionTab", () => ({ ProtectionTab: () => null }));

import { FormatCellsDialog } from "../FormatCellsDialog";
import { useFormatCellsStore } from "../hooks/useFormatCellsState";
import extension from "../index";
import { CoreCommands } from "@api/commands";

let container: HTMLDivElement;
let root: Root;
const handlers = new Map<string, (...a: unknown[]) => unknown>();

/** The default cell style, as `getStyle(0)` reports it (the fields the dialog reads). */
const NO_LINE = { style: "none", color: "#000000", width: 0 };
const DEFAULT_STYLE = {
  bold: false, italic: false, underline: "none", strikethrough: false, fontSize: 11,
  fontFamily: "Calibri", textColor: "#000000", backgroundColor: "#ffffff", textAlign: "general",
  verticalAlign: "bottom", numberFormat: "General", wrapText: false, textRotation: "none",
  borderTop: NO_LINE, borderRight: NO_LINE, borderBottom: NO_LINE, borderLeft: NO_LINE,
  borderDiagonalDown: NO_LINE, borderDiagonalUp: NO_LINE, indent: 0, shrinkToFit: false,
  locked: true, formulaHidden: false,
};
const FORMATTED = { ...DEFAULT_STYLE, fontFamily: "Cambria", fontSize: 14, bold: true, numberFormat: "Number (2 decimals)" };

beforeEach(() => {
  Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
  for (const fn of Object.values(h)) if (typeof fn === "function" && "mockReset" in fn) fn.mockReset();
  h.selection = { startRow: 0, startCol: 0, endRow: 2, endCol: 2 };
  h.getCell.mockResolvedValue({ row: 0, col: 0, styleIndex: 5, display: "x" });
  h.getStyle.mockImplementation(async (i: number) => (i === 0 ? DEFAULT_STYLE : FORMATTED));
  h.applyFormatting.mockResolvedValue({ cells: [], styles: [] });
  h.applyBorderPreset.mockResolvedValue({ cells: [], styles: [] });
  h.begin.mockResolvedValue(41);
  h.commit.mockResolvedValue(undefined);
  h.cancel.mockResolvedValue(undefined);
  h.setCellProtection.mockResolvedValue({ success: true });
  h.getCellProtection.mockResolvedValue({ locked: true, formulaHidden: false });
  useFormatCellsStore.getState().reset();
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  handlers.clear();
  extension.activate({
    commands: {
      register: (id: string, fn: (...a: unknown[]) => unknown) => handlers.set(id, fn),
      unregister: (id: string) => handlers.delete(id),
    },
  } as never);
});

afterEach(() => {
  extension.deactivate();
  act(() => root.unmount());
  document.body.innerHTML = "";
});

async function settle(): Promise<void> {
  await act(async () => {
    for (let i = 0; i < 6; i++) await new Promise((r) => setTimeout(r, 0));
  });
}

async function renderDialog(onClose: () => void, data?: Record<string, unknown>): Promise<void> {
  await act(async () => {
    root.render(<FormatCellsDialog isOpen onClose={onClose} data={data} />);
  });
  await settle();
}

async function pressOk(): Promise<void> {
  const el = document.querySelector("[data-testid='in-dialog']")!;
  await act(async () => {
    el.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
  });
  await settle();
}

describe("OK writes only what the user changed (D5)", () => {
  it("an untouched OK writes NOTHING -- no format, no protection, no undo step -- and closes", async () => {
    const onClose = vi.fn();
    await renderDialog(onClose);
    await pressOk();
    expect(h.applyFormatting, "an untouched OK rewrote the selection").not.toHaveBeenCalled();
    expect(h.applyBorderPreset).not.toHaveBeenCalled();
    expect(h.setCellProtection).not.toHaveBeenCalled();
    expect(h.begin).not.toHaveBeenCalled();
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("one change on a mixed selection writes that ONE property, so the others stay mixed", async () => {
    const onClose = vi.fn();
    await renderDialog(onClose);
    act(() => useFormatCellsStore.getState().setItalic(true));
    await pressOk();
    expect(h.applyFormatting).toHaveBeenCalledTimes(1);
    expect(h.applyFormatting).toHaveBeenCalledWith([0, 1, 2], [0, 1, 2], { italic: true });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("an EMPTY active cell loads the default style and never writes 'system-ui'", async () => {
    h.getCell.mockResolvedValue(null);
    await renderDialog(vi.fn());
    expect(h.getStyle).toHaveBeenCalledWith(0);
    expect(useFormatCellsStore.getState().fontFamily).toBe(DEFAULT_STYLE.fontFamily);
    act(() => useFormatCellsStore.getState().setUnderline("double"));
    await pressOk();
    const [, , formatting] = h.applyFormatting.mock.calls[0];
    expect(formatting).toEqual({ underline: "double" });
    expect(JSON.stringify(h.applyFormatting.mock.calls)).not.toContain("system-ui");
  });

  it("a protection change alone goes to setCellProtection and formats nothing", async () => {
    await renderDialog(vi.fn());
    act(() => useFormatCellsStore.getState().setLocked(false));
    await pressOk();
    expect(h.applyFormatting).not.toHaveBeenCalled();
    expect(h.setCellProtection).toHaveBeenCalledWith({
      startRow: 0, startCol: 0, endRow: 2, endCol: 2, locked: false, formulaHidden: false,
    });
  });
});

describe("Borders on a range, and the undo step", () => {
  it("Outline on B1:C3-style range is ONE outside preset, inside one undo transaction", async () => {
    await renderDialog(vi.fn());
    const thin = { style: "thin" as const, color: "#000000" };
    act(() => {
      const s = useFormatCellsStore.getState();
      s.setBorderTop(thin);
      s.setBorderRight(thin);
      s.setBorderBottom(thin);
      s.setBorderLeft(thin);
      s.setBold(false); // FORMATTED is bold: a second write in the same OK
    });
    await pressOk();
    expect(h.applyBorderPreset).toHaveBeenCalledWith(0, 0, 2, 2, "outside", "solid", "#000000", 1);
    expect(h.applyFormatting).toHaveBeenCalledWith([0, 1, 2], [0, 1, 2], { bold: false });
    expect(h.begin).toHaveBeenCalledTimes(1);
    expect(h.commit).toHaveBeenCalledWith(41);
  });

  it("reads the range's OUTER edges from the corners that own them", async () => {
    // Top-left (0,0) has a top line; the bottom-left corner (2,0) a bottom line.
    h.getCell.mockImplementation(async (row: number, col: number) => ({ row, col, styleIndex: row * 10 + col + 1, display: "" }));
    h.getStyle.mockImplementation(async (i: number) => {
      const line = { style: "thin", color: "#000000", width: 1 };
      if (i === 1) return { ...DEFAULT_STYLE, borderTop: line };
      if (i === 21) return { ...DEFAULT_STYLE, borderBottom: line };
      return DEFAULT_STYLE;
    });
    await renderDialog(vi.fn());
    const s = useFormatCellsStore.getState();
    expect(s.borderTop.style).toBe("thin");
    expect(s.borderBottom.style).toBe("thin");
    expect(s.borderRight.style).toBe("none");
    expect(s.rangeShape).toEqual({ multiRow: true, multiCol: true });
    // ...and an untouched OK still writes nothing.
    await pressOk();
    expect(h.applyFormatting).not.toHaveBeenCalled();
    expect(h.applyBorderPreset).not.toHaveBeenCalled();
  });
});

describe("a refused write is SHOWN, not logged", () => {
  it("the backend's refusal opens an alert and the dialog stays open", async () => {
    h.applyFormatting.mockRejectedValue("Font size must be between 1 and 409");
    const onClose = vi.fn();
    await renderDialog(onClose);
    act(() => useFormatCellsStore.getState().setFontSize(410));
    await pressOk();
    expect(h.alert).toHaveBeenCalledTimes(1);
    expect(String(h.alert.mock.calls[0][0])).toContain("409");
    expect(onClose).not.toHaveBeenCalled();
    // What was opened is closed (committed), so nothing swallows later edits.
    expect(h.commit).toHaveBeenCalledWith(41);
  });
});

describe("FORMAT_CELLS { tab, category }", () => {
  it("passes a category through to the dialog", async () => {
    await handlers.get(CoreCommands.FORMAT_CELLS)!({ tab: "number", category: "accounting" });
    expect(h.openDialog).toHaveBeenCalledWith("format-cells", { tab: "number", category: "accounting" });
  });

  it("a category alone opens the Number tab", async () => {
    await handlers.get(CoreCommands.FORMAT_CELLS)!({ category: "accounting" });
    expect(h.openDialog).toHaveBeenCalledWith("format-cells", { tab: "number", category: "accounting" });
  });

  it("the tab alone is unchanged", async () => {
    await handlers.get(CoreCommands.FORMAT_CELLS)!({ tab: "font" });
    expect(h.openDialog).toHaveBeenCalledWith("format-cells", { tab: "font" });
  });

  it("the dialog opens on Number with the requested category recorded", async () => {
    await renderDialog(vi.fn(), { category: "accounting" });
    expect(useFormatCellsStore.getState().activeTab).toBe("number");
    expect(useFormatCellsStore.getState().numberCategory).toBe("accounting");
  });
});

describe("a value the user re-chose is written (review finding (k))", () => {
  it("A1 bold + Currency, A2 plain: re-choosing Bold and Currency on A1:A2 makes BOTH so", async () => {
    h.selection = { startRow: 0, startCol: 0, endRow: 1, endCol: 0 };
    h.getStyle.mockImplementation(async () => ({ ...DEFAULT_STYLE, bold: true, numberFormat: "currency_usd" }));
    const onClose = vi.fn();
    await renderDialog(onClose);
    expect(useFormatCellsStore.getState().bold, "the dialog shows the active cell's Bold").toBe(true);
    act(() => {
      useFormatCellsStore.getState().setBold(true);
      useFormatCellsStore.getState().setNumberFormat("currency_usd");
    });
    await pressOk();
    expect(h.applyFormatting, "OK wrote nothing: A2 stayed plain").toHaveBeenCalledTimes(1);
    expect(h.applyFormatting).toHaveBeenCalledWith([0, 1], [0], { bold: true, numberFormat: "currency_usd" });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("control: the same dialog with nothing touched still writes nothing (D5)", async () => {
    h.selection = { startRow: 0, startCol: 0, endRow: 1, endCol: 0 };
    await renderDialog(vi.fn());
    await pressOk();
    expect(h.applyFormatting).not.toHaveBeenCalled();
  });
});

describe("the dialog loads the ACTIVE cell (review finding (g))", () => {
  it("a drag from B2 (anchor) down to B5 (active) loads B5's style and protection, not B2's", async () => {
    h.selection = { startRow: 1, startCol: 1, endRow: 4, endCol: 1 };
    h.getCell.mockImplementation(async (row: number, col: number) => ({ row, col, styleIndex: row === 1 ? 7 : 0, display: "" }));
    h.getStyle.mockImplementation(async (i: number) => (i === 7 ? { ...DEFAULT_STYLE, bold: true } : DEFAULT_STYLE));
    await renderDialog(vi.fn());
    expect(h.getCell.mock.calls[0], "the dialog loaded the anchor").toEqual([4, 1]);
    expect(h.getCellProtection).toHaveBeenCalledWith(4, 1);
    expect(useFormatCellsStore.getState().bold, "B2's Bold leaked into a dialog about B5").toBe(false);
  });
});
