//! FILENAME: app/src/shell/FormulaBar/__tests__/formulaBarExternalEdit.test.tsx
// PURPOSE: The bar's own buttons -- X, the check mark and fx -- act on a live
//          EXTERNAL session (a floating grid's cell edit) and on a selected
//          external cell, never on the Core cell under it.
// CONTEXT: X and the check mark were enabled only by Core's `editing`, so a
//          floating-grid edit in the bar could be neither committed nor cancelled
//          with them; and fx ran `startEditing("=")` on CORE's active cell -- on
//          a worksheet, a cell hidden under the floating grid.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { FORMULA_BAR_DEFAULT_EXPANDED_HEIGHT } from "../../../core/types";

const h = vi.hoisted(() => ({
  dispatch: vi.fn(),
  startEditing: vi.fn(),
  commitEdit: vi.fn(async () => ({ success: true })),
  cancelEdit: vi.fn(async () => undefined),
  updateValue: vi.fn(),
  /** Called when the (doubled) Insert Function dialog renders. */
  onDialogRender: null as null | (() => void),
  dialogProps: null as null | {
    onSelect: (name: string, template: string) => void;
    onBuilt: (formula: string) => void;
    anchor: { row: number; col: number };
  },
}));

vi.mock("../../../api", () => ({
  useGridContext: () => ({
    state: {
      selection: { startRow: 4, startCol: 4, endRow: 4, endCol: 4 },
      referenceStyle: "A1",
      formulaBarExpanded: false,
      formulaBarHeight: FORMULA_BAR_DEFAULT_EXPANDED_HEIGHT,
    },
    dispatch: h.dispatch,
  }),
  getCell: () => Promise.resolve(null),
  getMergeInfo: () => Promise.resolve(null),
  isSheetProtected: () => Promise.resolve(false),
  getCellProtection: () => Promise.resolve({ formulaHidden: false }),
  checkRangeGuards: () => null,
  getSpillRanges: () => Promise.resolve([]),
}));

vi.mock("../../../api/editing", () => ({
  useEditing: () => ({
    editing: null,
    updateValue: h.updateValue,
    commitEdit: h.commitEdit,
    cancelEdit: h.cancelEdit,
    startEdit: vi.fn(),
    startEditing: h.startEditing,
  }),
  setGlobalIsEditing: vi.fn(),
  getGlobalEditingValue: () => "",
  setGlobalCursorPosition: vi.fn(),
  getGlobalCursorPosition: () => 0,
  setChartSeriesRefMode: vi.fn(),
}));

vi.mock("../../../api/formulaAutocomplete", () => ({
  isFormulaAutocompleteVisible: () => false,
  AutocompleteEvents: { INPUT: "ac:input", KEY: "ac:key", ACCEPTED: "ac:accepted" },
}));

vi.mock("../NameBox", () => ({ NameBox: () => null }));
vi.mock("../InsertFunctionDialog", () => ({
  InsertFunctionDialog: (props: NonNullable<typeof h.dialogProps>) => {
    h.onDialogRender?.();
    h.dialogProps = props;
    return null;
  },
}));

import { FormulaBar } from "../FormulaBar";
import { __resetExternalEditForTests } from "../../../core/lib/formulaEditTarget";
import { createFakeExternalEdit } from "../../../core/lib/__tests__/helpers/fakeExternalEdit";

Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

let container: HTMLDivElement;
let root: Root;

async function render(): Promise<void> {
  await act(async () => {
    root.render(<FormulaBar />);
  });
  await act(async () => {
    for (let i = 0; i < 6; i++) await Promise.resolve();
  });
}

function button(title: string): HTMLButtonElement {
  const el = container.querySelector(`button[title="${title}"]`);
  if (!el) throw new Error(`no button titled ${title}`);
  return el as HTMLButtonElement;
}

async function click(el: HTMLElement): Promise<void> {
  await act(async () => {
    el.click();
    for (let i = 0; i < 6; i++) await Promise.resolve();
  });
}

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  h.dialogProps = null;
  h.onDialogRender = null;
  for (const fn of [h.dispatch, h.startEditing, h.commitEdit, h.cancelEdit, h.updateValue]) fn.mockClear();
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  __resetExternalEditForTests();
});

describe("FormulaBar buttons with an external edit", () => {
  it("X and the check mark are disabled with no edit at all", async () => {
    await render();
    expect(button("Cancel (Esc)").disabled).toBe(true);
    expect(button("Enter").disabled).toBe(true);
  });

  it("a live session enables X and the check mark; the check mark commits it with no move", async () => {
    const fake = createFakeExternalEdit({ hostSheetIndex: 2, text: "=7" });
    fake.register();
    await render();
    expect(button("Cancel (Esc)").disabled).toBe(false);
    expect(button("Enter").disabled).toBe(false);

    await click(button("Enter"));
    expect(fake.calls.filter((c) => c.fn === "commit")).toEqual([{ fn: "commit", args: [null] }]);
    expect(h.commitEdit).not.toHaveBeenCalled();
  });

  it("X cancels the session, never a Core edit", async () => {
    const fake = createFakeExternalEdit({ hostSheetIndex: 2, text: "=7" });
    fake.register();
    await render();
    await click(button("Cancel (Esc)"));
    expect(fake.calls.map((c) => c.fn)).toContain("cancel");
    expect(h.cancelEdit).not.toHaveBeenCalled();
  });

  it("fx on a selected floating-grid cell begins THAT cell's edit with '=', never startEditing on Core's cell", async () => {
    const fake = createFakeExternalEdit({ hostSheetIndex: 0, text: "=1", anchor: { row: 2, col: 1 } });
    fake.publishCell();
    await render();

    await click(button("Insert Function"));

    expect(h.startEditing).not.toHaveBeenCalled();
    expect(fake.isRegistered()).toBe(true);
    expect(fake.session.getText()).toBe("=");
    // The builder is anchored at the edited cell (in its owner's coordinates).
    expect(h.dialogProps?.anchor).toEqual({ row: 2, col: 1 });

    // Picking a function fills the template into the session.
    await act(async () => h.dialogProps?.onSelect("SUM", "=SUM("));
    expect(fake.session.getText()).toBe("=SUM(");
  });

  it("a built formula is set into the session and committed through the owner", async () => {
    const fake = createFakeExternalEdit({ hostSheetIndex: 0, text: "=1" });
    fake.publishCell();
    await render();
    await click(button("Insert Function"));

    await act(async () => {
      h.dialogProps?.onBuilt("=SUM(A1:A3)");
      for (let i = 0; i < 6; i++) await Promise.resolve();
    });

    expect(fake.calls).toContainEqual({ fn: "setText", args: ["=SUM(A1:A3)", 11] });
    expect(fake.calls.filter((c) => c.fn === "commit")).toEqual([{ fn: "commit", args: [null] }]);
    expect(h.updateValue).not.toHaveBeenCalled();
    expect(h.commitEdit).not.toHaveBeenCalled();
  });

  it("fx during an IN-CELL session hands the edit to the BAR before the dialog opens (never reseeds it)", async () => {
    // Review 2026-09-27 (FR finding 8, part a). The dialog focuses its search
    // box on mount, which blurs the floating grid's in-cell editor; while that
    // view owned the edit its deferred blur committed "=SUM(A1" 150 ms later.
    // The owner's blur rule stands down once the BAR owns the edit
    // (frEditorSession.test.ts "(fx)") -- so the bar must own it BEFORE the
    // dialog exists.
    const fake = createFakeExternalEdit({ hostSheetIndex: 0, text: "=SUM(A1" });
    fake.session.view = "cell";
    fake.register();
    let viewWhenTheDialogRendered: string | null = null;
    h.onDialogRender = () => {
      viewWhenTheDialogRendered ??= fake.session.getView();
    };
    await render();

    await click(button("Insert Function"));

    expect(fake.calls.map((c) => c.fn)).toContain("adoptBarView");
    expect(viewWhenTheDialogRendered).toBe("bar");
    expect(fake.session.getText()).toBe("=SUM(A1");
    expect(h.startEditing).not.toHaveBeenCalled();
    expect(fake.isRegistered()).toBe(true);
  });

  it("pressing fx does not take the focus off the entry in progress (its mousedown is prevented, as X's is)", async () => {
    await render();
    const press = new MouseEvent("mousedown", { bubbles: true, cancelable: true });
    await act(async () => {
      button("Insert Function").dispatchEvent(press);
    });
    expect(press.defaultPrevented).toBe(true);
  });

  it("positive control: with nothing external, fx starts the Core edit", async () => {
    await render();
    await click(button("Insert Function"));
    expect(h.startEditing).toHaveBeenCalledWith("=");
  });
});
