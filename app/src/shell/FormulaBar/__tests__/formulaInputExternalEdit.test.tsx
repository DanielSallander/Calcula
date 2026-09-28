//! FILENAME: app/src/shell/FormulaBar/__tests__/formulaInputExternalEdit.test.tsx
// PURPOSE: The formula bar shows, and edits, an EXTERNAL cell (a selected
//          floating-grid cell) and hosts its edit SESSION -- and never touches
//          the Core cell underneath while it does.
// CONTEXT: THE DATA-INTEGRITY DEFECT. On a WORKSHEET a click on a floating-grid
//          cell does not move Core's selection, so the bar kept showing Core's
//          LAST active cell -- and clicking into it ran `startEdit` on THAT cell,
//          so Enter wrote the user's formula into a sheet cell hidden under the
//          floating grid, with no error anywhere. Case (d) is the unit guard of
//          that write; the live guard is the worksheet journey in
//          e2e/journeys/floating-range.spec.ts.
//
//          The external-edit store is REAL (imported by the component through
//          the `api/externalEdit` subpath, which this file does not double);
//          the owner is the Core test double (fakeExternalEdit).

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";

const h = vi.hoisted(() => ({
  gridState: {
    selection: null as null | { startRow: number; startCol: number; endRow: number; endCol: number },
    referenceStyle: "A1",
    surface: "grid" as "grid" | "canvas",
  },
  cells: new Map<string, { formula?: string; display?: string }>(),
  guardBlocked: false,
  editing: null as null | { row: number; col: number; value: string },
  dispatch: vi.fn(),
  startEdit: vi.fn(async () => undefined),
  commitEdit: vi.fn(async () => ({ success: true })),
  cancelEdit: vi.fn(async () => undefined),
  updateValue: vi.fn(),
  setGlobalIsEditing: vi.fn(),
  setGlobalCursorPosition: vi.fn(),
}));

vi.mock("../../../api", () => ({
  useGridContext: () => ({ state: h.gridState, dispatch: h.dispatch }),
  getCell: (row: number, col: number) => Promise.resolve(h.cells.get(`${row},${col}`) ?? null),
  getMergeInfo: () => Promise.resolve(null),
  isSheetProtected: () => Promise.resolve(false),
  getCellProtection: () => Promise.resolve({ formulaHidden: false }),
  checkRangeGuards: () => (h.guardBlocked ? { blocked: true } : null),
  getSpillRanges: () => Promise.resolve([]),
}));

vi.mock("../../../api/editing", () => ({
  useEditing: () => ({
    editing: h.editing,
    updateValue: h.updateValue,
    commitEdit: h.commitEdit,
    cancelEdit: h.cancelEdit,
    startEdit: h.startEdit,
  }),
  setGlobalIsEditing: h.setGlobalIsEditing,
  getGlobalEditingValue: () => "",
  setGlobalCursorPosition: h.setGlobalCursorPosition,
  getGlobalCursorPosition: () => 0,
  setChartSeriesRefMode: vi.fn(),
}));

vi.mock("../../../api/formulaAutocomplete", () => ({
  isFormulaAutocompleteVisible: () => false,
  AutocompleteEvents: { INPUT: "ac:input", KEY: "ac:key", ACCEPTED: "ac:accepted" },
}));

import { FormulaInput } from "../FormulaInput";
import { __resetExternalEditForTests } from "../../../core/lib/formulaEditTarget";
import {
  createFakeExternalEdit,
  type FakeExternalEdit,
} from "../../../core/lib/__tests__/helpers/fakeExternalEdit";

Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

let container: HTMLDivElement;
let root: Root;

async function flush(): Promise<void> {
  await act(async () => {
    for (let i = 0; i < 6; i++) await Promise.resolve();
  });
}

/** Let requestAnimationFrame callbacks run. */
async function frames(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 40));
  });
}

async function render(): Promise<void> {
  await act(async () => {
    root.render(React.createElement(FormulaInput));
  });
  await flush();
}

function input(): HTMLInputElement {
  const el = container.querySelector("input[data-formula-bar]");
  if (!el) throw new Error("the formula bar input did not render");
  return el as HTMLInputElement;
}

async function focusBar(): Promise<void> {
  await act(async () => {
    input().focus();
  });
  await flush();
}

async function type(value: string, caret = value.length): Promise<void> {
  const el = input();
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
  await act(async () => {
    setter.call(el, value);
    el.setSelectionRange(caret, caret);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await flush();
}

async function key(k: string, init: KeyboardEventInit = {}): Promise<void> {
  await act(async () => {
    input().dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true, ...init }));
  });
  await flush();
}

function dispatchedTypes(): string[] {
  return h.dispatch.mock.calls.map((c) => (c[0] as { type: string }).type);
}

/** A floating-grid cell selected on a WORKSHEET whose Core active cell is B2. */
function worksheetWithGridCell(formula = "=GRID()"): void {
  h.gridState.surface = "grid";
  h.gridState.selection = { startRow: 1, startCol: 1, endRow: 1, endCol: 1 };
  h.cells.set("1,1", { formula, display: "1" });
}

let commitCompletes: number;
const onCommitComplete = () => {
  commitCompletes += 1;
};

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  h.cells.clear();
  h.guardBlocked = false;
  h.editing = null;
  h.gridState.selection = null;
  h.gridState.surface = "grid";
  for (const fn of [h.dispatch, h.startEdit, h.commitEdit, h.cancelEdit, h.updateValue, h.setGlobalIsEditing, h.setGlobalCursorPosition]) {
    fn.mockClear();
  }
  commitCompletes = 0;
  window.addEventListener("formulaBar:commitComplete", onCommitComplete);
});

afterEach(() => {
  window.removeEventListener("formulaBar:commitComplete", onCommitComplete);
  act(() => root.unmount());
  container.remove();
  __resetExternalEditForTests();
});

describe("FormulaInput -- a selected EXTERNAL cell", () => {
  it("(a) on a worksheet it shows the floating-grid cell's formula, never Core's hidden cell, and clears the precedent boxes", async () => {
    worksheetWithGridCell();
    const fake = createFakeExternalEdit({ hostSheetIndex: 0, text: "=Sheet1!E2" });
    fake.publishCell();
    await render();

    expect(input().value).toBe("=Sheet1!E2");
    expect(dispatchedTypes()).toContain("CLEAR_FORMULA_REFERENCES");
    expect(dispatchedTypes()).not.toContain("SET_FORMULA_REFERENCES");
  });

  it("(b) on a canvas (no Core selection) it shows the content", async () => {
    h.gridState.surface = "canvas";
    createFakeExternalEdit({ hostSheetIndex: 2, text: "=A1*2" }).publishCell();
    await render();
    expect(input().value).toBe("=A1*2");
  });

  it("(c) while the content read is in flight the bar shows NOTHING -- never another cell's text", async () => {
    // The Core cell's text is on screen first...
    worksheetWithGridCell("=GRID()");
    await render();
    expect(input().value).toBe("=GRID()");

    // ...then a floating-grid cell is selected whose content has not arrived.
    await act(async () => {
      createFakeExternalEdit({ hostSheetIndex: 0 }).publishCell({ content: null });
    });
    await flush();
    expect(input().value).toBe("");
  });

  it("(d) focusing the bar begins the OWNER's edit; Core's startEdit and global flag are never touched", async () => {
    worksheetWithGridCell();
    const fake = createFakeExternalEdit({ hostSheetIndex: 0, text: "=Sheet1!E2" });
    fake.publishCell();
    await render();

    await focusBar();

    expect(fake.isRegistered()).toBe(true);
    expect(h.startEdit).not.toHaveBeenCalled();
    expect(h.setGlobalIsEditing).not.toHaveBeenCalledWith(true);
  });

  it("(e) a blocked Core cell underneath (a pivot) does not stop the floating-grid edit", async () => {
    worksheetWithGridCell();
    h.guardBlocked = true;
    const fake = createFakeExternalEdit({ hostSheetIndex: 0, text: "=1" });
    fake.publishCell();
    await render();
    expect(input().readOnly).toBe(false);

    await focusBar();

    expect(fake.isRegistered()).toBe(true);
    expect(document.activeElement).toBe(input());
  });

  it("(f) a CORE edit wins: focus does not begin the external edit, and the bar shows Core's value", async () => {
    worksheetWithGridCell();
    const fake = createFakeExternalEdit({ hostSheetIndex: 0, text: "=Sheet1!E2" });
    fake.publishCell();
    await render();
    expect(input().value).toBe("=Sheet1!E2");

    // A Core edit opens (a click on Core's already-active cell does not clear
    // the floating grid's selection, so both can exist).
    h.editing = { row: 1, col: 1, value: "=CORE" };
    await render();

    expect(input().value).toBe("=CORE");
    await focusBar();
    expect(fake.isRegistered()).toBe(false);
  });

  it("(k) withdrawing the external cell with the Core selection unchanged brings the grid cell back", async () => {
    worksheetWithGridCell("=GRID()");
    const fake = createFakeExternalEdit({ hostSheetIndex: 0, text: "=Sheet1!E2" });
    const withdraw = fake.publishCell();
    await render();
    expect(input().value).toBe("=Sheet1!E2");

    await act(async () => withdraw());
    await flush();

    expect(input().value).toBe("=GRID()");
  });

  it("(l) a canvas with nothing selected: focus raises no global flag and the bar is read-only", async () => {
    h.gridState.surface = "canvas";
    await render();
    expect(input().readOnly).toBe(true);
    await focusBar();
    await act(async () => input().blur());
    expect(h.setGlobalIsEditing).not.toHaveBeenCalledWith(true);
    expect(h.startEdit).not.toHaveBeenCalled();
  });
});

describe("FormulaInput -- a live external SESSION", () => {
  async function liveSession(text: string, cursor = text.length): Promise<FakeExternalEdit> {
    h.gridState.surface = "grid";
    h.gridState.selection = { startRow: 1, startCol: 1, endRow: 1, endCol: 1 };
    const fake = createFakeExternalEdit({ hostSheetIndex: 2, text, cursor });
    fake.register();
    await render();
    return fake;
  }

  it("shows the session's text over Core's selection, and is never read-only", async () => {
    h.guardBlocked = true;
    const fake = await liveSession("=");
    expect(input().value).toBe("=");
    expect(input().readOnly).toBe(false);
    await focusBar();
    // The bar became the session's view; still no global flag.
    expect(fake.calls.map((c) => c.fn)).toContain("adoptBarView");
    expect(h.setGlobalIsEditing).not.toHaveBeenCalledWith(true);
  });

  it("(g) typing goes to the session; Enter/Tab/Shift+Tab commit with the move; Escape cancels -- never Core's", async () => {
    let fake = await liveSession("=");
    await focusBar();
    await type("=5", 2);
    expect(fake.calls).toContainEqual({ fn: "setText", args: ["=5", 2] });
    expect(h.updateValue).not.toHaveBeenCalled();

    await key("Enter");
    expect(fake.calls.filter((c) => c.fn === "commit")).toEqual([{ fn: "commit", args: ["down"] }]);
    expect(h.commitEdit).not.toHaveBeenCalled();
    // Its listener moves CORE's active cell: a second, unrelated move.
    expect(commitCompletes).toBe(0);

    act(() => root.unmount());
    root = createRoot(container);
    fake = await liveSession("=1");
    await focusBar();
    await key("Tab");
    expect(fake.calls.filter((c) => c.fn === "commit")).toEqual([{ fn: "commit", args: ["right"] }]);

    act(() => root.unmount());
    root = createRoot(container);
    fake = await liveSession("=1");
    await focusBar();
    await key("Tab", { shiftKey: true });
    expect(fake.calls.filter((c) => c.fn === "commit")).toEqual([{ fn: "commit", args: ["left"] }]);

    act(() => root.unmount());
    root = createRoot(container);
    fake = await liveSession("=1");
    await focusBar();
    await key("Escape");
    expect(fake.calls.map((c) => c.fn)).toContain("cancel");
    expect(h.cancelEdit).not.toHaveBeenCalled();
    expect(commitCompletes).toBe(0);
  });

  it("(g2) Enter/Tab keep the bar focused when a NEW session opened while the commit was in flight", async () => {
    // Review 2026-09-27 (FR finding 7, part 3). The owner moves its selection
    // before its write's first await, so a key typed into the bar during the
    // write opens a session on the NEXT cell -- and that session's view is the
    // bar. Blurred after the await, it sat live with no view holding the
    // keyboard.
    for (const [k, init] of [["Enter", {}], ["Tab", {}]] as const) {
      act(() => root.unmount());
      root = createRoot(container);
      const first = await liveSession("5");
      const next = createFakeExternalEdit({ hostSheetIndex: 2, text: "6", address: "Float1!A2" });
      const commitFirst = first.session.commit.bind(first.session);
      first.session.commit = (move) => {
        const written = commitFirst(move);
        // The keystroke typed during the write (FormulaInput.handleChange ->
        // cell.beginEdit) registered the next cell's session.
        next.register();
        return written;
      };
      await focusBar();
      await key(k, init);
      expect(first.calls.some((c) => c.fn === "commit"), k).toBe(true);
      expect(next.isRegistered(), k).toBe(true);
      expect(document.activeElement, `${k}: the new session's view lost the keyboard`).toBe(input());
      next.session.cancel();
    }
  });

  it("(g3) control: with no session left after the commit, Enter still gives the focus up", async () => {
    await liveSession("5");
    await focusBar();
    expect(document.activeElement).toBe(input());
    await key("Enter");
    expect(document.activeElement).not.toBe(input());
  });

  it("(h) a caret move without a text change reaches the session, not the global caret", async () => {
    const fake = await liveSession("=A1+B1");
    await focusBar();
    h.setGlobalCursorPosition.mockClear();
    await act(async () => {
      input().setSelectionRange(3, 3);
      input().dispatchEvent(new KeyboardEvent("keyup", { key: "ArrowLeft", bubbles: true }));
      document.dispatchEvent(new Event("selectionchange"));
    });
    await flush();
    expect(fake.calls).toContainEqual({ fn: "setCursor", args: [3] });
    expect(h.setGlobalCursorPosition).not.toHaveBeenCalled();
  });

  it("(i) an accepted suggestion is applied by the bar ONLY while the bar is focused", async () => {
    const fake = await liveSession("=SU", 3);
    await act(async () => {
      window.dispatchEvent(new CustomEvent("ac:accepted", { detail: { newValue: "=SUM(", newCursorPosition: 5 } }));
    });
    expect(fake.calls.some((c) => c.fn === "setText")).toBe(false);

    await focusBar();
    await act(async () => {
      window.dispatchEvent(new CustomEvent("ac:accepted", { detail: { newValue: "=SUM(", newCursorPosition: 5 } }));
    });
    expect(fake.calls).toContainEqual({ fn: "setText", args: ["=SUM(", 5] });
  });

  it("(j) a pick inserted by the owner shows in the bar, with the caret after it", async () => {
    const fake = await liveSession("=");
    await focusBar();
    await act(async () => {
      fake.target.insertReference({ sheetName: "Sheet1", startRow: 1, startCol: 4, endRow: 1, endCol: 4 });
    });
    await frames();
    expect(input().value).toBe("=Sheet1!E2");
    expect(input().selectionStart).toBe(10);
  });

  it("(j2) a pick that left focus on the grid gives the keyboard back to the bar", async () => {
    const grid = document.createElement("div");
    grid.setAttribute("data-focus-container", "spreadsheet");
    grid.tabIndex = 0;
    document.body.appendChild(grid);
    const fake = await liveSession("=");
    await focusBar();
    await act(async () => grid.focus());
    await act(async () => {
      fake.target.insertReference({ sheetName: "Sheet1", startRow: 1, startCol: 4, endRow: 1, endCol: 4 });
    });
    await frames();
    expect(document.activeElement).toBe(input());
    grid.remove();
  });

  it("(m) F4 and Alt+Enter go through the session", async () => {
    const fake = await liveSession("=A1", 3);
    await focusBar();
    await act(async () => input().setSelectionRange(3, 3));
    await key("F4");
    expect(fake.calls).toContainEqual({ fn: "setText", args: ["=$A$1", 5] });

    await act(async () => input().setSelectionRange(5, 5));
    await key("Enter", { altKey: true });
    expect(fake.calls).toContainEqual({ fn: "setText", args: ["=$A$1\n", 6] });
    expect(h.updateValue).not.toHaveBeenCalled();
    expect(fake.calls.some((c) => c.fn === "commit")).toBe(false);
  });
});
