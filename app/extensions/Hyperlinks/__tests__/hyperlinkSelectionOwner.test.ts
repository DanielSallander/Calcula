//! FILENAME: app/extensions/Hyperlinks/__tests__/hyperlinkSelectionOwner.test.ts
// PURPOSE: The hyperlink doors that act on Core's ACTIVE cell -- Insert >
//          Hyperlink..., Insert > Follow Hyperlink, and the hyperlinks.insert
//          command (Ctrl+K) -- refuse with ONE toast and touch nothing while a
//          selection owner holds the selection; they work when nothing does.
// CONTEXT: D4 (wa-keys fixup; BUG-0185 class). With a floating grid's cell
//          selected, Core's active cell is HIDDEN under the floating grid, and
//          Insert Hyperlink opened its dialog for THAT cell. TEST owner
//          (@api/selectionOwner). The grid context menu is not a door here: it
//          acts on the cell the user right-clicked.

import { describe, it, expect, vi, beforeAll, beforeEach, afterEach, afterAll } from "vitest";

const h = vi.hoisted(() => ({
  showDialog: vi.fn(),
  getHyperlink: vi.fn(async () => null),
  selectionSubs: new Set<(sel: unknown) => void>(),
  menuItems: [] as { id: string; action?: () => unknown }[],
}));
vi.mock("@api", async (importOriginal) => {
  const real = await importOriginal<typeof import("@api")>();
  return {
    ...real,
    // eslint-disable-next-line @typescript-eslint/naming-convention -- the real export name
    ExtensionRegistry: {
      ...real.ExtensionRegistry,
      onSelectionChange: (cb: (sel: unknown) => void) => {
        h.selectionSubs.add(cb);
        return () => h.selectionSubs.delete(cb);
      },
    },
    showDialog: (...a: unknown[]) => h.showDialog(...a),
    registerMenuItem: (_menu: string, item: { id: string; action?: () => unknown }) => {
      h.menuItems.push(item);
    },
  };
});
vi.mock("@api/backend", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@api/backend")>()),
  getHyperlink: (...a: unknown[]) => h.getHyperlink(...(a as [])),
  getHyperlinkIndicators: vi.fn(async () => []),
}));

import extension from "../index";
import { CommandRegistry } from "@api/commands";
import { registerSelectionOwner } from "@api/selectionOwner";
import { registerToastSink, type ToastPayload } from "@api/notifications";

const toasts: ToastPayload[] = [];
let owns = false;
let release: () => void = () => {};

function stubContext(): never {
  return {
    ui: { dialogs: { register: vi.fn(), unregister: vi.fn() } },
    commands: {
      register: (id: string, fn: (...a: unknown[]) => unknown) => CommandRegistry.register(id, fn),
      unregister: (id: string) => CommandRegistry.unregister(id),
      execute: (id: string) => CommandRegistry.execute(id),
    },
  } as never;
}
function menuAction(id: string): () => unknown {
  const item = h.menuItems.find((i) => i.id === id);
  if (!item?.action) throw new Error(`no menu action ${id}`);
  return item.action;
}
function refusals(): ToastPayload[] {
  return toasts.filter((t) => t.message.includes("the selection belongs to"));
}
async function settle(): Promise<void> {
  for (let i = 0; i < 6; i++) await Promise.resolve();
}

beforeAll(() => {
  extension.activate(stubContext());
  for (const cb of h.selectionSubs) cb({ startRow: 4, startCol: 2, endRow: 4, endCol: 2, type: "cells" });
});
afterAll(() => {
  extension.deactivate?.();
});
beforeEach(() => {
  h.showDialog.mockClear();
  h.getHyperlink.mockClear();
  toasts.length = 0;
  registerToastSink((t) => toasts.push(t));
  owns = false;
  release = registerSelectionOwner({ id: "test-owner", label: "the test object's cells", ownsSelection: () => owns });
});
afterEach(() => {
  release();
});

/** [label, open the door, did it act?] */
const DOORS: [string, () => unknown, () => boolean][] = [
  ["Insert > Hyperlink...", () => menuAction("insert:insertHyperlink")(), () => h.showDialog.mock.calls.length > 0],
  ["hyperlinks.insert (Ctrl+K)", () => CommandRegistry.execute("hyperlinks.insert"), () => h.getHyperlink.mock.calls.length > 0],
  ["Insert > Follow Hyperlink", () => menuAction("insert:followHyperlink")(), () => h.getHyperlink.mock.calls.length > 0],
];

describe("hyperlink doors while a selection owner holds the selection", () => {
  for (const [label, open, acted] of DOORS) {
    it(`${label}: nothing opened or followed for Core's hidden cell; one toast`, async () => {
      owns = true;
      await open();
      await settle();
      expect(acted(), `${label} acted on Core's hidden active cell`).toBe(false);
      expect(refusals().length).toBe(1);
    });
  }
});

describe("positive controls: nothing owns the selection", () => {
  for (const [label, open, acted] of DOORS) {
    it(`${label}: acts on Core's active cell, no refusal`, async () => {
      await open();
      await settle();
      expect(acted()).toBe(true);
      expect(refusals()).toEqual([]);
    });
  }
});
