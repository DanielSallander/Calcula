//! FILENAME: app/src/shell/FormulaBar/__tests__/insertFunctionCommand.test.tsx
// PURPOSE: `core.formula.insertFunction` (Shift+F3; AutoSum > More
//          Functions...) opens Insert Function WITH THE FORMULA BAR HIDDEN --
//          Excel's does -- and opens it the way the bar's fx button does.
// CONTEXT: Home tab 2026-10-04. The dialog was local state of the FormulaBar
//          component, which unmounts when View > Formula Bar is off, so a
//          command registered by the bar would have vanished with it. The host
//          now lives in the shell frame (insertFunctionHost.tsx). Nothing of
//          the bar is rendered here: only the host, as the frame mounts it.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";

const h = vi.hoisted(() => ({ startEditing: vi.fn(async () => undefined) }));

vi.mock("../../../api/editing", () => ({
  useEditing: () => ({
    editing: null,
    isEditing: false,
    updateValue: vi.fn(),
    commitEdit: vi.fn(async () => null),
    cancelEdit: vi.fn(async () => undefined),
    startEdit: vi.fn(),
    startEditing: h.startEditing,
  }),
  setGlobalIsEditing: vi.fn(),
  getGlobalEditingValue: () => "",
  setGlobalCursorPosition: vi.fn(),
  getGlobalCursorPosition: () => 0,
  setChartSeriesRefMode: vi.fn(),
}));
vi.mock("../../../api", () => ({
  useGridContext: () => ({ state: { selection: { startRow: 2, startCol: 1, endRow: 2, endCol: 1 } }, dispatch: vi.fn() }),
}));
vi.mock("../InsertFunctionDialog", () => ({
  InsertFunctionDialog: (props: { anchor: { row: number; col: number } }) =>
    React.createElement("div", { "data-testid": "insert-function-dialog", "data-anchor": JSON.stringify(props.anchor) }),
}));

import {
  InsertFunctionHost,
  installInsertFunction,
  isInsertFunctionOpen,
  resetInsertFunctionForTests,
} from "../insertFunctionHost";
import { CommandRegistry, CoreCommands } from "../../../api/commands";
import { getShellComponents } from "../../../api/ui";
import { getAllKeybindings, initKeybindings } from "../../../api/keybindings";
import { registerSelectionOwner } from "../../../api/selectionOwner";
import { registerToastSink, type ToastPayload } from "../../../api/notifications";

Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

let container: HTMLDivElement;
let root: Root;
const toasts: ToastPayload[] = [];
registerToastSink((t) => toasts.push(t));

const dialog = (): Element | null => container.querySelector("[data-testid='insert-function-dialog']");

async function run(): Promise<void> {
  await act(async () => {
    await CommandRegistry.execute(CoreCommands.INSERT_FUNCTION);
    for (let i = 0; i < 4; i++) await Promise.resolve();
  });
}

beforeEach(async () => {
  installInsertFunction();
  resetInsertFunctionForTests();
  h.startEditing.mockClear();
  toasts.length = 0;
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root.render(React.createElement(InsertFunctionHost));
  });
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe("Insert Function without the formula bar", () => {
  it("installing registers the command and puts the host in the shell frame (once)", () => {
    installInsertFunction();
    expect(CommandRegistry.has(CoreCommands.INSERT_FUNCTION)).toBe(true);
    expect(getShellComponents().filter((c) => c.id === "core.insertFunctionHost")).toHaveLength(1);
  });

  it("Shift+F3 is bound to it", () => {
    initKeybindings();
    const binding = getAllKeybindings().find((b) => b.combo === "Shift+F3");
    expect(binding?.commandId).toBe(CoreCommands.INSERT_FUNCTION);
  });

  it("opens the dialog and begins Core's '=' edit of the active cell -- no formula bar mounted", async () => {
    await run();
    expect(dialog()).not.toBeNull();
    expect(h.startEditing).toHaveBeenCalledTimes(1);
    expect(h.startEditing).toHaveBeenCalledWith("=");
    // The builder is anchored at the selection until the edit exists.
    expect(dialog()!.getAttribute("data-anchor")).toBe(JSON.stringify({ row: 2, col: 1 }));
  });

  it("begins the edit once per open, not on every render", async () => {
    await run();
    await act(async () => {
      root.render(React.createElement(InsertFunctionHost));
    });
    expect(h.startEditing).toHaveBeenCalledTimes(1);
  });

  it("refuses while an object holds the selection: no edit, no dialog, one toast", async () => {
    const release = registerSelectionOwner({
      id: "test.object", label: "the object", fallback: true, ownsSelection: () => true,
      refusal: (a) => `${a} is not available while an object is selected.`,
    });
    try {
      await run();
    } finally {
      release();
    }
    expect(dialog()).toBeNull();
    expect(isInsertFunctionOpen()).toBe(false);
    expect(h.startEditing).not.toHaveBeenCalled();
    expect(toasts.map((t) => t.message)).toEqual(["Insert Function is not available while an object is selected."]);
  });
});
