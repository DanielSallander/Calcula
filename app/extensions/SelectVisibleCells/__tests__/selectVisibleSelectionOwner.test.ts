//! FILENAME: app/extensions/SelectVisibleCells/__tests__/selectVisibleSelectionOwner.test.ts
// PURPOSE: Select Visible Cells (Edit menu, and the selectVisibleCells.execute
//          command Alt+; runs) refuses with ONE toast and leaves Core's
//          selection alone while a selection owner holds the selection; it
//          reshapes the selection when nothing does.
// CONTEXT: D4 (wa-keys fixup; BUG-0185 class). With a floating grid's cell
//          selected, Core's selection is HIDDEN under the floating grid, and
//          Select Visible Cells rebuilt THAT selection. TEST owner
//          (@api/selectionOwner).

import { describe, it, expect, vi, beforeAll, beforeEach, afterEach, afterAll } from "vitest";

const h = vi.hoisted(() => ({
  dispatchGridAction: vi.fn(),
  menuItems: [] as { id: string; action?: () => unknown }[],
}));
vi.mock("@api/grid", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@api/grid")>()),
  getGridStateSnapshot: () => ({
    selection: { startRow: 0, startCol: 0, endRow: 4, endCol: 0, type: "cells" },
    dimensions: { hiddenRows: new Set<number>([2]), hiddenCols: new Set<number>() },
  }),
}));
vi.mock("@api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@api")>()),
  dispatchGridAction: (...a: unknown[]) => h.dispatchGridAction(...a),
  registerMenuItem: (_menu: string, item: { id: string; action?: () => unknown }) => {
    h.menuItems.push(item);
  },
}));

import extension from "../index";
import { CommandRegistry } from "@api/commands";
import { registerSelectionOwner } from "@api/selectionOwner";
import { registerToastSink, type ToastPayload } from "@api/notifications";

const toasts: ToastPayload[] = [];
let owns = false;
let release: () => void = () => {};

function refusals(): ToastPayload[] {
  return toasts.filter((t) => t.message.includes("the selection belongs to"));
}
function menuAction(id: string): () => unknown {
  const item = h.menuItems.find((i) => i.id === id);
  if (!item?.action) throw new Error(`no menu action ${id}`);
  return item.action;
}

beforeAll(() => {
  extension.activate({
    commands: {
      register: (id: string, fn: (...a: unknown[]) => unknown) => CommandRegistry.register(id, fn),
      unregister: (id: string) => CommandRegistry.unregister(id),
    },
  } as never);
});
afterAll(() => {
  extension.deactivate?.();
});
beforeEach(() => {
  h.dispatchGridAction.mockClear();
  toasts.length = 0;
  registerToastSink((t) => toasts.push(t));
  owns = false;
  release = registerSelectionOwner({ id: "test-owner", label: "the test object's cells", ownsSelection: () => owns });
});
afterEach(() => {
  release();
});

const DOORS: [string, () => unknown][] = [
  ["Edit > Select Visible Cells", () => menuAction("edit:selectVisibleCells")()],
  ["selectVisibleCells.execute (Alt+;)", () => CommandRegistry.execute("selectVisibleCells.execute")],
];

describe("Select Visible Cells while a selection owner holds the selection", () => {
  for (const [label, open] of DOORS) {
    it(`${label}: Core's hidden selection is not rebuilt; one toast`, async () => {
      owns = true;
      await open();
      expect(h.dispatchGridAction).not.toHaveBeenCalled();
      expect(refusals().length).toBe(1);
    });
  }
});

describe("positive controls: nothing owns the selection", () => {
  for (const [label, open] of DOORS) {
    it(`${label}: selects only the visible cells, no refusal`, async () => {
      await open();
      expect(h.dispatchGridAction).toHaveBeenCalledTimes(1);
      expect(refusals()).toEqual([]);
    });
  }
});
