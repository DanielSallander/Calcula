//! FILENAME: app/extensions/FlashFill/__tests__/flashFillSelectionOwner.test.ts
// PURPOSE: Flash Fill (Data menu, and the flashfill.execute command Ctrl+E
//          runs) refuses with ONE toast and reads/writes nothing while a
//          selection owner holds the selection; it runs when nothing does.
// CONTEXT: D4 (wa-keys fixup; BUG-0185 class). Flash Fill fills the column of
//          Core's active cell -- a cell HIDDEN under a floating grid while
//          that grid's cell is selected. TEST owner (@api/selectionOwner). The
//          first thing Flash Fill does is read the grid state, so that read is
//          the witness.

import { describe, it, expect, vi, beforeAll, beforeEach, afterEach, afterAll } from "vitest";

const h = vi.hoisted(() => ({
  getGridStateSnapshot: vi.fn((): null => null),
  menuItems: [] as { id: string; action?: () => unknown }[],
}));
vi.mock("@api/grid", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@api/grid")>()),
  getGridStateSnapshot: () => h.getGridStateSnapshot(),
}));
vi.mock("@api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@api")>()),
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
      register: (id: string, fn: (...a: unknown[]) => unknown, opts?: unknown) =>
        CommandRegistry.register(id, fn, opts as never),
      unregister: (id: string) => CommandRegistry.unregister(id),
    },
  } as never);
});
afterAll(() => {
  extension.deactivate?.();
});
beforeEach(() => {
  h.getGridStateSnapshot.mockClear();
  toasts.length = 0;
  registerToastSink((t) => toasts.push(t));
  owns = false;
  release = registerSelectionOwner({ id: "test-owner", label: "the test object's cells", ownsSelection: () => owns });
});
afterEach(() => {
  release();
});

const DOORS: [string, () => unknown][] = [
  ["Data > Flash Fill", () => menuAction("flashfill")()],
  ["flashfill.execute (Ctrl+E)", () => CommandRegistry.execute("flashfill.execute")],
];

describe("Flash Fill while a selection owner holds the selection", () => {
  for (const [label, open] of DOORS) {
    it(`${label}: reads nothing from Core's hidden selection; one toast`, async () => {
      owns = true;
      await open();
      expect(h.getGridStateSnapshot).not.toHaveBeenCalled();
      expect(refusals().length).toBe(1);
    });
  }
});

describe("positive controls: nothing owns the selection", () => {
  for (const [label, open] of DOORS) {
    it(`${label}: runs, no refusal`, async () => {
      await open();
      expect(h.getGridStateSnapshot).toHaveBeenCalledTimes(1);
      expect(refusals()).toEqual([]);
    });
  }
});
