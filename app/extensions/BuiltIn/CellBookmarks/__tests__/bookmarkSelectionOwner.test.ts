//! FILENAME: app/extensions/BuiltIn/CellBookmarks/__tests__/bookmarkSelectionOwner.test.ts
// PURPOSE: The bookmark doors that act on Core's selection -- Insert >
//          Bookmarks > Add / Remove, and the bookmarks.add / toggle / remove /
//          editAtSelection commands (Ctrl+Shift+B runs toggle) -- refuse with
//          ONE toast and touch nothing while a selection owner holds the
//          selection; they work when nothing does.
// CONTEXT: D4 (wa-keys fixup; BUG-0185 class). With a floating grid's cell
//          selected, Core's selection is a cell HIDDEN under the floating
//          grid, and Add Bookmark bookmarked THAT cell. TEST owner
//          (@api/selectionOwner). Navigation (next / previous bookmark) is not
//          refused: it replaces the selection, it does not act on it.

import { describe, it, expect, vi, beforeAll, beforeEach, afterEach, afterAll } from "vitest";

const h = vi.hoisted(() => ({
  addBookmark: vi.fn(),
  removeBookmark: vi.fn(() => true),
  showOverlay: vi.fn(),
  menuItems: [] as { id: string; action?: () => void; children?: unknown[] }[],
}));
vi.mock("../lib/bookmarkStore", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/bookmarkStore")>()),
  addBookmark: (...a: unknown[]) => h.addBookmark(...a),
  removeBookmark: (...a: unknown[]) => h.removeBookmark(...a),
  hasBookmarkAt: () => false,
}));
vi.mock("@api/grid", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@api/grid")>()),
  getGridStateSnapshot: () => ({
    selection: { startRow: 7, startCol: 2, endRow: 7, endCol: 2 },
    sheetContext: { activeSheetIndex: 0, activeSheetName: "Sheet1" },
  }),
}));
vi.mock("@api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@api")>()),
  showOverlay: (...a: unknown[]) => h.showOverlay(...a),
  registerMenuItem: (_menu: string, item: { id: string; children?: unknown[] }) => {
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

/** Every door inert, except `commands`, which are REAL. */
function stubContext(): never {
  const inert = (): unknown =>
    new Proxy(() => () => {}, {
      get: (_t, prop) => (prop === "then" ? undefined : inert()),
      apply: () => () => {},
    });
  return new Proxy(inert() as Record<string, unknown>, {
    get: (t, prop) => {
      if (prop === "commands") {
        return {
          register: (id: string, fn: (...a: unknown[]) => unknown, opts?: unknown) =>
            CommandRegistry.register(id, fn, opts as never),
          unregister: (id: string) => CommandRegistry.unregister(id),
          execute: (id: string) => CommandRegistry.execute(id),
        };
      }
      if (prop === "invokeBackend") return vi.fn(async () => null);
      return (t as Record<string | symbol, unknown>)[prop as string];
    },
  }) as never;
}

function menuAction(id: string): () => void {
  const parent = h.menuItems.find((i) => i.id === "insert.bookmarks");
  const child = (parent?.children as { id: string; action?: () => void }[] | undefined)?.find((c) => c.id === id);
  if (!child?.action) throw new Error(`no menu action ${id}`);
  return child.action;
}
function refusals(): ToastPayload[] {
  return toasts.filter((t) => t.message.includes("the selection belongs to"));
}
function acted(): number {
  return h.addBookmark.mock.calls.length + h.removeBookmark.mock.calls.length + h.showOverlay.mock.calls.length;
}

beforeAll(async () => {
  await extension.activate(stubContext());
});
afterAll(async () => {
  await extension.deactivate?.();
});
beforeEach(() => {
  h.addBookmark.mockClear();
  h.removeBookmark.mockClear();
  h.showOverlay.mockClear();
  toasts.length = 0;
  registerToastSink((t) => toasts.push(t));
  owns = false;
  release = registerSelectionOwner({ id: "test-owner", label: "the test object's cells", ownsSelection: () => owns });
});
afterEach(() => {
  release();
});

/** [label, how to open the door] */
const DOORS: [string, () => unknown][] = [
  ["Insert > Bookmarks > Add Bookmark", () => menuAction("insert.bookmarks.add")()],
  ["Insert > Bookmarks > Remove Bookmark", () => menuAction("insert.bookmarks.remove")()],
  ["bookmarks.add", () => CommandRegistry.execute("bookmarks.add")],
  ["bookmarks.toggle (Ctrl+Shift+B)", () => CommandRegistry.execute("bookmarks.toggle")],
  ["bookmarks.remove", () => CommandRegistry.execute("bookmarks.remove")],
  ["bookmarks.editAtSelection", () => CommandRegistry.execute("bookmarks.editAtSelection")],
];

describe("bookmark doors while a selection owner holds the selection", () => {
  for (const [label, open] of DOORS) {
    it(`${label}: nothing bookmarked, removed or opened; one toast`, async () => {
      owns = true;
      await open();
      expect(acted(), `${label} acted on Core's hidden cell`).toBe(0);
      expect(refusals().length).toBe(1);
    });
  }
});

describe("positive controls: nothing owns the selection", () => {
  for (const [label, open] of DOORS) {
    it(`${label}: acts on Core's active cell, no refusal`, async () => {
      await open();
      expect(acted()).toBe(1);
      expect(refusals()).toEqual([]);
    });
  }

  it("navigation is not refused: bookmarks.next still runs while owned", async () => {
    owns = true;
    await CommandRegistry.execute("bookmarks.next");
    expect(refusals()).toEqual([]);
  });
});
