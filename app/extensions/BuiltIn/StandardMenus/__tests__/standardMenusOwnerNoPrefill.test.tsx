//! FILENAME: app/extensions/BuiltIn/StandardMenus/__tests__/standardMenusOwnerNoPrefill.test.tsx
// PURPOSE: While a selection owner (a floating grid's selected cell) holds the
//          selection: Insert > PivotTable... and Insert > Chart... open WITHOUT
//          a prefill from Core's hidden selection (they do not refuse), and
//          View > Split Window refuses once (it splits at Core's hidden active
//          cell). Remove Split is not the selection's and still acts.
// CONTEXT: W24 (wave C), with the owner default: "Insert > PivotTable / Chart
//          ... do NOT refuse while a selection owner claims the selection: they
//          open with NO prefill from Core's hidden selection. View > Split ...
//          DO refuse (they act on the hidden active cell)." Both create
//          dialogs take the opener's `suppressAutoRange` (the canvas insert
//          already uses it for the chart dialog). TEST owner
//          (@api/selectionOwner).

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";

const h = vi.hoisted(() => ({
  showDialog: vi.fn(),
  splitWindow: vi.fn(async () => undefined),
  removeSplitWindow: vi.fn(async () => undefined),
  split: { splitRow: null as number | null, splitCol: null as number | null },
}));

vi.mock("@api/ui", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@api/ui")>()),
  showDialog: (...a: unknown[]) => h.showDialog(...a),
}));
// Core's selection: C4 (row 3, col 2) -- hidden under the owner's object in
// the claimed cases.
vi.mock("@api/grid", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@api/grid")>()),
  useGridState: () => ({
    selection: { startRow: 3, startCol: 2, endRow: 3, endCol: 2, type: "cells" },
    surface: "grid",
    viewMode: "normal",
    showFormulas: false,
  }),
  loadFreezePanesConfig: vi.fn(async () => ({ freezeRow: null, freezeCol: null })),
  loadSplitWindowConfig: vi.fn(async () => ({ ...h.split })),
  splitWindow: (...a: unknown[]) => h.splitWindow(...(a as [])),
  removeSplitWindow: () => h.removeSplitWindow(),
}));

import { useInsertMenu } from "../InsertMenu";
import { useViewMenu } from "../ViewMenu";
import type { MenuItemDefinition } from "@api/ui";
import { registerSelectionOwner } from "@api/selectionOwner";
import { registerToastSink, type ToastPayload } from "@api/notifications";

Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

const toasts: ToastPayload[] = [];
let owns = false;
let release: () => void = () => {};
let root: Root | null = null;

/** Mount a hook and let its effects (the split-state load) settle. */
async function mountHook<T>(hook: () => T): Promise<{ current: T }> {
  const result = { current: undefined as unknown as T };
  function Probe(): null {
    result.current = hook();
    return null;
  }
  root = createRoot(document.createElement("div"));
  await act(async () => {
    root!.render(React.createElement(Probe));
    for (let i = 0; i < 5; i++) await Promise.resolve();
  });
  return result;
}

function action(items: MenuItemDefinition[], id: string): () => unknown {
  const item = items.find((i) => i.id === id);
  if (!item?.action) throw new Error(`no menu action ${id}`);
  return item.action;
}

function refusals(): ToastPayload[] {
  return toasts.filter((t) => t.message.includes("the selection belongs to"));
}

beforeEach(() => {
  h.showDialog.mockClear();
  h.splitWindow.mockClear();
  h.removeSplitWindow.mockClear();
  h.split = { splitRow: null, splitCol: null };
  toasts.length = 0;
  registerToastSink((t) => toasts.push(t));
  owns = false;
  release = registerSelectionOwner({ id: "test-owner", label: "the test object's cells", ownsSelection: () => owns });
});

afterEach(async () => {
  release();
  if (root) {
    const r = root;
    await act(async () => {
      r.unmount();
    });
    root = null;
  }
});

describe("Insert > PivotTable... / Chart... while a selection owner holds the selection", () => {
  for (const [label, itemId, dialogId] of [
    ["PivotTable...", "insert.pivot", "pivot:createDialog"],
    ["Chart...", "insert.chart", "chart:createDialog"],
  ] as const) {
    it(`${label}: opens, with NO prefill from Core's hidden selection; no refusal`, async () => {
      const menu = await mountHook(() => useInsertMenu());
      owns = true;
      await action(menu.current.menu.items, itemId)();
      expect(h.showDialog, `${label} did not open`).toHaveBeenCalledTimes(1);
      expect(h.showDialog.mock.calls[0][0]).toBe(dialogId);
      expect(
        h.showDialog.mock.calls[0][1],
        `${label} let the dialog prefill from Core's HIDDEN selection`,
      ).toEqual(expect.objectContaining({ suppressAutoRange: true }));
      expect(refusals()).toEqual([]);
    });

    it(`positive control, ${label}: nothing owns the selection -> opens as before (prefill allowed)`, async () => {
      const menu = await mountHook(() => useInsertMenu());
      await action(menu.current.menu.items, itemId)();
      expect(h.showDialog).toHaveBeenCalledWith(dialogId);
      expect(h.showDialog.mock.calls[0]).toHaveLength(1);
      expect(refusals()).toEqual([]);
    });
  }
});

describe("View > Split Window while a selection owner holds the selection", () => {
  it("refuses: no split at Core's hidden active cell; one toast", async () => {
    const menu = await mountHook(() => useViewMenu());
    owns = true;
    await action(menu.current.menu.items, "view.split")();
    expect(h.splitWindow, "the window was split at Core's HIDDEN active cell").not.toHaveBeenCalled();
    expect(refusals().length).toBe(1);
    expect(refusals()[0].message).toContain("Split Window");
  });

  it("Remove Split is not the selection's: it still acts, silently", async () => {
    h.split = { splitRow: 5, splitCol: 3 };
    const menu = await mountHook(() => useViewMenu());
    owns = true;
    const item = menu.current.menu.items.find((i) => i.id === "view.split");
    expect(item?.label).toBe("Remove Split");
    await action(menu.current.menu.items, "view.split")();
    expect(h.removeSplitWindow).toHaveBeenCalledTimes(1);
    expect(refusals()).toEqual([]);
  });

  it("positive control: nothing owns the selection -> split at the active cell (C4)", async () => {
    const menu = await mountHook(() => useViewMenu());
    await action(menu.current.menu.items, "view.split")();
    expect(h.splitWindow).toHaveBeenCalledWith(3, 2);
    expect(refusals()).toEqual([]);
  });
});
