//! FILENAME: app/src/shell/FormulaBar/__tests__/formulaBarBuiltFormula.test.tsx
// PURPOSE: A formula assembled by an argument builder must reach the cell
//          WHOLE, through the ordinary commit path.
//
// THE DEFECT THIS EXISTS TO PREVENT, WHICH IS INVISIBLE IN A NAIVE DOUBLE.
// `commitEdit` commits `editing.value` out of its OWN closure — it is a
// useCallback with `editing` in its dependency array (useEditing.ts), so the
// function a handler is holding belongs to the render it was created in.
// Writing
//
//     updateValue(formula); void commitEdit();
//
// in one handler therefore commits a value from an EARLIER render, and the
// user's arguments are gone with no error anywhere. Sabotaging the bar into
// exactly that shape commits "<not editing>" here — the handler's own closure
// predates the edit session entirely — which is worse than the "=" one might
// predict, and either way is not the formula.
//
// So the double below is a CLOSURE, not a mutable global read at call time. A
// `commitEdit` that reads module state when invoked would pass this test
// against the broken implementation, which is the same as having no test.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { FORMULA_BAR_DEFAULT_EXPANDED_HEIGHT } from "../../../core/types";

// ---------------------------------------------------------------------------
// Editing double — deliberately shaped like the real hook.
// ---------------------------------------------------------------------------

interface EditingCellDouble {
  row: number;
  col: number;
  value: string;
}

let editingState: EditingCellDouble | null = null;
/** Every value that reached the cell, in order. */
const committed: string[] = [];
const forceListeners = new Set<() => void>();

function notifyEditing(): void {
  forceListeners.forEach((f) => f());
}

const updateValue = (value: string): void => {
  // No session, nothing to update — the real reducer updates an EXISTING
  // editing cell and cannot conjure one.
  if (!editingState) return;
  // A NEW object, as the real reducer produces: the identity change is what
  // re-runs the effect that performs the deferred commit.
  editingState = { ...editingState, value };
  notifyEditing();
};

const startEditing = async (initialValue?: string): Promise<void> => {
  // Genuinely async, like the real one (it awaits the backend before the cell
  // enters edit mode). The fx button does not await it, so there IS a window in
  // which the dialog is open and no edit session exists yet.
  await Promise.resolve();
  editingState = { row: 4, col: 2, value: initialValue ?? "" };
  notifyEditing();
};

const cancelEdit = async (): Promise<void> => {
  editingState = null;
  notifyEditing();
};

vi.mock("../../../api/editing", () => ({
  useEditing: () => {
    const [, force] = React.useReducer((n: number) => n + 1, 0);
    React.useEffect(() => {
      forceListeners.add(force);
      return () => {
        forceListeners.delete(force);
      };
    }, [force]);

    const editing = editingState;
    // THE POINT OF THIS FILE: closes over this render's `editing`, exactly as
    // the real commitEdit does (useCallback with `editing` in its deps).
    const commitEdit = React.useCallback(async () => {
      committed.push(editing ? editing.value : "<not editing>");
      editingState = null;
      notifyEditing();
      return null;
    }, [editing]);

    return {
      editing,
      isEditing: editing !== null,
      updateValue,
      commitEdit,
      cancelEdit,
      startEdit: vi.fn(),
      startEditing,
    };
  },
  setGlobalIsEditing: vi.fn(),
  getGlobalEditingValue: () => "",
  setGlobalCursorPosition: vi.fn(),
  getGlobalCursorPosition: () => 0,
  setChartSeriesRefMode: vi.fn(),
}));

const gridState = {
  selection: { startRow: 7, startCol: 3, endRow: 7, endCol: 3 },
  referenceStyle: "A1",
  formulaBarExpanded: false,
  formulaBarHeight: FORMULA_BAR_DEFAULT_EXPANDED_HEIGHT,
};

vi.mock("../../../api", () => ({
  useGridContext: () => ({ state: gridState, dispatch: vi.fn() }),
}));

vi.mock("../NameBox", () => ({ NameBox: () => null }));
vi.mock("../FormulaInput", () => ({ FormulaInput: () => null }));

// The dialog is replaced by a pair of buttons that fire its two callbacks, so
// this file tests the bar's handling and nothing else. `anchor` is echoed into
// the DOM so the bar's choice of target cell is observable.
let lastAnchor: { row: number; col: number } | null = null;
vi.mock("../InsertFunctionDialog", () => ({
  InsertFunctionDialog: (props: {
    onBuilt: (formula: string) => void;
    onSelect: (name: string, template: string) => void;
    anchor: { row: number; col: number };
  }) => {
    lastAnchor = props.anchor;
    return React.createElement("div", null, [
      React.createElement(
        "button",
        {
          key: "built",
          "data-testid": "fire-built",
          onClick: () => props.onBuilt('=CUBEVALUE("Sales","[Revenue]")'),
        },
        "built",
      ),
      React.createElement(
        "button",
        {
          key: "template",
          "data-testid": "fire-template",
          onClick: () => props.onSelect("SUM", "=SUM()"),
        },
        "template",
      ),
    ]);
  },
}));

import { FormulaBar } from "../FormulaBar";

// ---------------------------------------------------------------------------

let container: HTMLDivElement;
let root: Root;

async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
}

function click(testId: string): void {
  const el = container.querySelector(`[data-testid='${testId}']`);
  if (!el) throw new Error(`no element with data-testid="${testId}"`);
  act(() => {
    el.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
}

/** The fx button — the only button titled "Insert Function". */
function openDialog(): void {
  const el = [...container.querySelectorAll("button")].find(
    (b) => b.getAttribute("title") === "Insert Function",
  );
  if (!el) throw new Error("the fx button did not render");
  act(() => {
    el.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
}

beforeEach(async () => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  editingState = null;
  committed.length = 0;
  lastAnchor = null;
  await act(async () => {
    root.render(React.createElement(FormulaBar));
  });
  await flush();
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe("a built formula reaching the cell", () => {
  it("commits the whole formula, not the '=' the edit started with", async () => {
    openDialog();
    await flush();
    // The fx button seeded the editor, which is precisely the stale value a
    // same-tick commit would write.
    expect(editingState?.value).toBe("=");

    click("fire-built");
    await flush();

    expect(committed).toEqual(['=CUBEVALUE("Sales","[Revenue]")']);
  });

  it("commits exactly once", async () => {
    openDialog();
    await flush();
    click("fire-built");
    await flush();
    // Further renders must not re-fire the parked commit.
    await flush();
    await flush();

    expect(committed).toHaveLength(1);
  });

  it("closes the dialog when the builder inserts", async () => {
    openDialog();
    await flush();
    expect(container.querySelector("[data-testid='fire-built']")).not.toBeNull();

    click("fire-built");
    await flush();

    expect(container.querySelector("[data-testid='fire-built']")).toBeNull();
  });

  it("abandons a parked commit that has no edit session to land in", async () => {
    // fx starts the edit session asynchronously and does not await it, so the
    // dialog is briefly open with no session. A formula parked in that window
    // must be DROPPED, never replayed into the session that appears next — the
    // same requirement as an edit torn down by Escape mid-flight.
    openDialog();
    expect(editingState).toBeNull();

    click("fire-built");
    await flush();

    expect(committed).toEqual([]);
    // The session that did arrive holds what fx seeded it with, untouched.
    expect(editingState?.value).toBe("=");
  });

  it("still hands a plain template to the editor without committing", async () => {
    openDialog();
    await flush();

    click("fire-template");
    await flush();

    // The user completes a template themselves; nothing is committed for them.
    expect(committed).toEqual([]);
    expect(editingState?.value).toBe("=SUM()");
  });

  it("targets the cell being edited, falling back to the selection anchor", async () => {
    // Before the fx button's async startEditing resolves there is no `editing`,
    // so the anchor comes from the selection rather than defaulting to (0,0).
    expect(editingState).toBeNull();
    openDialog();
    expect(lastAnchor).toEqual({ row: 7, col: 3 });

    await flush();
    // Once the edit session exists it is authoritative.
    expect(lastAnchor).toEqual({ row: 4, col: 2 });
  });
});
