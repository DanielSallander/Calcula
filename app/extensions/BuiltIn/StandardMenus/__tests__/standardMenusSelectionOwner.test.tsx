//! FILENAME: app/extensions/BuiltIn/StandardMenus/__tests__/standardMenusSelectionOwner.test.tsx
// PURPOSE: The standard-menu doors whose target is Core's selection -- Insert
//          > Table... and the insert.table command (Ctrl+T); View > Go To
//          Special... and the view.goToSpecial command -- refuse with ONE
//          toast and open nothing while a selection owner holds the selection;
//          they open their dialogs when nothing does.
// CONTEXT: D4 (wa-keys fixup; BUG-0185 class). With a floating grid's cell
//          selected, Core's selection is HIDDEN under the floating grid:
//          Create Table prefilled its range from it, and Go To Special
//          searched inside it and replaced it. TEST owner (@api/selectionOwner).

import { describe, it, expect, vi, beforeAll, beforeEach, afterEach, afterAll } from "vitest";
import React, { act } from "react";
import { createRoot } from "react-dom/client";

const h = vi.hoisted(() => ({ showDialog: vi.fn() }));
vi.mock("@api/ui", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@api/ui")>()),
  showDialog: (...a: unknown[]) => h.showDialog(...a),
}));
// The View menu hook reads the grid's view flags; no GridProvider is mounted
// here, so it gets a plain worksheet state (and no backend round trips).
vi.mock("@api/grid", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@api/grid")>()),
  useGridState: () => ({ selection: null, surface: "grid", viewMode: "normal", showFormulas: false }),
  loadFreezePanesConfig: vi.fn(async () => ({ freezeRow: null, freezeCol: null })),
  loadSplitWindowConfig: vi.fn(async () => ({ splitRow: null, splitCol: null })),
}));

import extension from "../index";
import { useInsertMenu } from "../InsertMenu";
import { useViewMenu } from "../ViewMenu";
import { CommandRegistry } from "@api/commands";
import { registerSelectionOwner } from "@api/selectionOwner";
import { registerToastSink, type ToastPayload } from "@api/notifications";

const toasts: ToastPayload[] = [];
let owns = false;
let release: () => void = () => {};

/** Every door inert, except `commands`, which are REAL. */
function stubContext(): never {
  const inert = (): unknown =>
    new Proxy(() => () => {}, {
      get: (_t, prop) => (prop === "then" ? undefined : inert()),
      apply: () => () => {},
    });
  return new Proxy(inert() as Record<string, unknown>, {
    get: (t, prop) =>
      prop === "commands"
        ? {
            register: (id: string, fn: (...a: unknown[]) => unknown) => CommandRegistry.register(id, fn),
            unregister: (id: string) => CommandRegistry.unregister(id),
            execute: (id: string) => CommandRegistry.execute(id),
          }
        : (t as Record<string | symbol, unknown>)[prop as string],
  }) as never;
}
/** Render a hook once (react-dom + act; @testing-library/react is not installed). */
function renderHook<T>(hook: () => T): { result: { current: T } } {
  const result = { current: undefined as unknown as T };
  function Probe(): null {
    result.current = hook();
    return null;
  }
  const host = document.createElement("div");
  const root = createRoot(host);
  act(() => {
    root.render(React.createElement(Probe));
  });
  act(() => {
    root.unmount();
  });
  return { result };
}
function menuAction(items: { id: string; action?: () => unknown }[], id: string): () => unknown {
  const item = items.find((i) => i.id === id);
  if (!item?.action) throw new Error(`no menu action ${id}`);
  return item.action;
}
function refusals(): ToastPayload[] {
  return toasts.filter((t) => t.message.includes("the selection belongs to"));
}

beforeAll(() => {
  Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
  extension.activate(stubContext());
});
afterAll(() => {
  extension.deactivate?.();
});
beforeEach(() => {
  h.showDialog.mockClear();
  toasts.length = 0;
  registerToastSink((t) => toasts.push(t));
  owns = false;
  release = registerSelectionOwner({ id: "test-owner", label: "the test object's cells", ownsSelection: () => owns });
});
afterEach(() => {
  release();
});

const DOORS: [string, string, () => unknown][] = [
  ["Insert > Table...", "table:createDialog", () => menuAction(renderHook(() => useInsertMenu()).result.current.menu.items, "insert.table")()],
  ["insert.table (Ctrl+T)", "table:createDialog", () => CommandRegistry.execute("insert.table")],
  ["View > Go To Special...", "go-to-special", () => menuAction(renderHook(() => useViewMenu()).result.current.menu.items, "view.goToSpecial")()],
  ["view.goToSpecial", "go-to-special", () => CommandRegistry.execute("view.goToSpecial")],
];

describe("selection doors of the standard menus while a selection owner holds the selection", () => {
  for (const [label, , open] of DOORS) {
    it(`${label}: no dialog; one toast`, async () => {
      owns = true;
      await open();
      expect(h.showDialog, `${label} opened a dialog on Core's hidden selection`).not.toHaveBeenCalled();
      expect(refusals().length).toBe(1);
    });
  }
});

describe("positive controls: nothing owns the selection", () => {
  for (const [label, dialog, open] of DOORS) {
    it(`${label}: opens ${dialog}, no refusal`, async () => {
      await open();
      expect(h.showDialog).toHaveBeenCalledWith(dialog);
      expect(refusals()).toEqual([]);
    });
  }
});
