//! FILENAME: app/extensions/Grouping/__tests__/groupingSelectionOwner.test.ts
// PURPOSE: Every Group / Ungroup door that acts on Core's selection -- Data >
//          Outline > Group / Ungroup, the grid context menu's Group / Ungroup,
//          and the grouping.group / grouping.ungroup commands (Alt+Shift+Right
//          / Left) -- refuses with ONE toast and groups nothing while a
//          selection owner holds the selection; they work when nothing does.
// CONTEXT: D4 (wa-keys fixup; BUG-0185 class). With a floating grid's cell
//          selected, Core's selection is HIDDEN under the floating grid, and
//          Data > Group grouped ITS rows. TEST owner (@api/selectionOwner).
//          The menu and the context menu used to carry their own copies of the
//          group/ungroup logic; they now share one (lib/groupSelection.ts).

import { describe, it, expect, vi, beforeAll, beforeEach, afterEach, afterAll } from "vitest";

const h = vi.hoisted(() => ({
  performGroupRows: vi.fn(),
  performUngroupRows: vi.fn(),
  performGroupColumns: vi.fn(),
  performUngroupColumns: vi.fn(),
  onSelection: null as null | ((sel: unknown) => void),
  contextItems: [] as { id: string; onClick: (ctx: unknown) => unknown }[],
  menuItems: [] as { id: string; children?: { id: string; action?: () => unknown }[] }[],
}));
vi.mock("../lib/groupingStore", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/groupingStore")>()),
  performGroupRows: (...a: unknown[]) => h.performGroupRows(...a),
  performUngroupRows: (...a: unknown[]) => h.performUngroupRows(...a),
  performGroupColumns: (...a: unknown[]) => h.performGroupColumns(...a),
  performUngroupColumns: (...a: unknown[]) => h.performUngroupColumns(...a),
  resyncOutlineFromBackend: vi.fn(async () => {}),
  resetGroupingState: vi.fn(),
  getCurrentOutlineInfo: () => ({ maxRowLevel: 1, maxColLevel: 0 }),
}));
vi.mock("@api/groupingService", () => ({ registerGroupingController: () => () => {} }));
vi.mock("@api", async (importOriginal) => {
  const real = await importOriginal<typeof import("@api")>();
  return {
    ...real,
    registerPostHeaderOverlay: () => () => {},
    // eslint-disable-next-line @typescript-eslint/naming-convention -- the real export name
    ExtensionRegistry: {
      onSelectionChange: (cb: (sel: unknown) => void) => {
        h.onSelection = cb;
        return () => {
          h.onSelection = null;
        };
      },
    },
    gridExtensions: {
      ...real.gridExtensions,
      registerContextMenuItems: (items: { id: string; onClick: (ctx: unknown) => unknown }[]) => {
        h.contextItems.push(...items);
      },
      unregisterContextMenuItem: vi.fn(),
    },
  };
});

import extension from "../index";
import { CommandRegistry } from "@api/commands";
import { registerSelectionOwner } from "@api/selectionOwner";
import { registerToastSink, type ToastPayload } from "@api/notifications";

const toasts: ToastPayload[] = [];
let owns = false;
let release: () => void = () => {};
const SELECTION = { startRow: 2, endRow: 5, startCol: 0, endCol: 3, type: "cells" };

function stubContext(): never {
  return {
    ui: {
      dialogs: { register: vi.fn(), unregister: vi.fn(), show: vi.fn() },
      menus: {
        registerItem: (_menu: string, item: { id: string; children?: { id: string; action?: () => unknown }[] }) => {
          h.menuItems.push(item);
        },
      },
    },
    events: { on: () => () => {} },
    commands: {
      register: (id: string, fn: (...a: unknown[]) => unknown) => CommandRegistry.register(id, fn),
      unregister: (id: string) => CommandRegistry.unregister(id),
      execute: (id: string) => CommandRegistry.execute(id),
    },
  } as never;
}
function menuAction(id: string): () => unknown {
  const outline = h.menuItems.find((i) => i.id === "data:outline");
  const child = outline?.children?.find((c) => c.id === id);
  if (!child?.action) throw new Error(`no menu action ${id}`);
  return child.action;
}
function contextAction(id: string): () => unknown {
  const item = h.contextItems.find((i) => i.id === id);
  if (!item) throw new Error(`no context item ${id}`);
  return () => item.onClick({ selection: SELECTION });
}
function acted(): number {
  return (
    h.performGroupRows.mock.calls.length +
    h.performUngroupRows.mock.calls.length +
    h.performGroupColumns.mock.calls.length +
    h.performUngroupColumns.mock.calls.length
  );
}
function refusals(): ToastPayload[] {
  return toasts.filter((t) => t.message.includes("the selection belongs to"));
}

beforeAll(() => {
  extension.activate(stubContext());
  h.onSelection?.(SELECTION);
});
afterAll(() => {
  extension.deactivate?.();
});
beforeEach(() => {
  h.performGroupRows.mockClear();
  h.performUngroupRows.mockClear();
  h.performGroupColumns.mockClear();
  h.performUngroupColumns.mockClear();
  toasts.length = 0;
  registerToastSink((t) => toasts.push(t));
  owns = false;
  release = registerSelectionOwner({ id: "test-owner", label: "the test object's cells", ownsSelection: () => owns });
});
afterEach(() => {
  release();
});

const DOORS: [string, () => unknown][] = [
  ["Data > Outline > Group", () => menuAction("data:outline:group")()],
  ["Data > Outline > Ungroup", () => menuAction("data:outline:ungroup")()],
  ["context menu Group", () => contextAction("grouping:group")()],
  ["context menu Ungroup", () => contextAction("grouping:ungroup")()],
  ["grouping.group (Alt+Shift+Right)", () => CommandRegistry.execute("grouping.group")],
  ["grouping.ungroup (Alt+Shift+Left)", () => CommandRegistry.execute("grouping.ungroup")],
];

describe("Group / Ungroup while a selection owner holds the selection", () => {
  for (const [label, open] of DOORS) {
    it(`${label}: nothing grouped or ungrouped; one toast`, async () => {
      owns = true;
      await open();
      expect(acted(), `${label} grouped Core's hidden rows`).toBe(0);
      expect(refusals().length).toBe(1);
    });
  }
});

describe("positive controls: nothing owns the selection", () => {
  for (const [label, open] of DOORS) {
    it(`${label}: acts on the selected rows (2..5), no refusal`, async () => {
      await open();
      expect(acted()).toBe(1);
      const call = [...h.performGroupRows.mock.calls, ...h.performUngroupRows.mock.calls][0];
      expect(call).toEqual([2, 5]);
      expect(refusals()).toEqual([]);
    });
  }
});
