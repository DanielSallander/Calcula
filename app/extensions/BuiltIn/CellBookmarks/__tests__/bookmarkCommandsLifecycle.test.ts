//! FILENAME: app/extensions/BuiltIn/CellBookmarks/__tests__/bookmarkCommandsLifecycle.test.ts
// PURPOSE: Every command Cell Bookmarks registers on activate is gone after
//          deactivate, and comes back on a re-activate -- and so are its
//          Insert > Bookmarks menu items and its grid right-click items.
// CONTEXT: D3 (wa-keys fixup). activate() registered its bookmarks.* commands
//          and deactivate() never unregistered one of them, so a deactivated
//          extension kept answering CommandRegistry.execute -- the keybinding
//          registry's Ctrl+Shift+B / Ctrl+] / Ctrl+[ still toggled and moved
//          bookmarks through a store nothing was painting or persisting any
//          more -- and a second activate registered every id over the stale
//          one. The ids are read from what activate ACTUALLY registered, so a
//          command added later is covered without editing this file.
//          The MENUS were the same defect one layer up (D3 review): with the
//          commands gone, Insert > Bookmarks > Add Bookmark still added a
//          bookmark to that unpainted, unpersisted store, and the grid context
//          menu kept offering Add/Remove/Edit Bookmark. Driven through the REAL
//          @api/ui menu registry; the grid context menu through a recording
//          grid-extensions service (the shell registers Core's at startup).

import { describe, it, expect, vi } from "vitest";

import extension from "../index";
import { CommandRegistry } from "@api/commands";
import { registerMenu, getMenus, type MenuItemDefinition } from "@api/ui";
import { registerGridExtensionsService, type GridContextMenuItem } from "@api/extensions";

const h = vi.hoisted(() => ({ added: 0 }));

vi.mock("@api/grid", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@api/grid")>()),
  getGridStateSnapshot: () => ({
    selection: { startRow: 4, startCol: 1, endRow: 4, endCol: 1, type: "cells" },
    sheetContext: { activeSheetIndex: 0, activeSheetName: "Sheet1" },
  }),
}));
vi.mock("../lib/bookmarkStore", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/bookmarkStore")>()),
  addBookmark: () => {
    h.added++;
    return { label: "B1" };
  },
  hasBookmarkAt: () => false,
}));

/** The grid right-click items, as Core's service would hold them. */
const contextItems = new Map<string, GridContextMenuItem>();
registerGridExtensionsService({
  registerContextMenuItem: (item) => void contextItems.set(item.id, item),
  registerContextMenuItems: (items) => items.forEach((item) => contextItems.set(item.id, item)),
  unregisterContextMenuItem: (id) => void contextItems.delete(id),
  getContextMenuItems: () => [...contextItems.values()],
  getContextMenuItemsForContext: () => [...contextItems.values()],
  onChange: () => () => {},
});
registerMenu({ id: "insert", label: "Insert", order: 30, items: [] });

function insertMenuItem(id: string): MenuItemDefinition | null {
  const walk = (items: MenuItemDefinition[] | undefined): MenuItemDefinition | null => {
    for (const it of items ?? []) {
      if (it.id === id) return it;
      const inner = walk(it.children);
      if (inner) return inner;
    }
    return null;
  };
  return walk(getMenus().find((m) => m.id === "insert")?.items);
}

function bookmarkContextItems(): string[] {
  return [...contextItems.keys()].filter((id) => id.startsWith("bookmarks."));
}

/** Every door inert, except `commands`, which are REAL and recorded. */
function stubContext(registered: string[]): never {
  const inert = (): unknown =>
    new Proxy(() => () => {}, {
      get: (_t, prop) => (prop === "then" ? undefined : inert()),
      apply: () => () => {},
    });
  return new Proxy(inert() as Record<string, unknown>, {
    get: (t, prop) => {
      if (prop === "commands") {
        return {
          register: (id: string, fn: (...a: unknown[]) => unknown, opts?: unknown) => {
            registered.push(id);
            CommandRegistry.register(id, fn, opts as never);
          },
          unregister: (id: string) => CommandRegistry.unregister(id),
          execute: (id: string) => CommandRegistry.execute(id),
        };
      }
      if (prop === "invokeBackend") return vi.fn(async () => null);
      return (t as Record<string | symbol, unknown>)[prop as string];
    },
  }) as never;
}

describe("Cell Bookmarks' commands live exactly as long as the extension", () => {
  it("activate registers them; deactivate unregisters EVERY one", async () => {
    const registered: string[] = [];
    await extension.activate(stubContext(registered));
    try {
      expect(registered.length, "the census found no registrations to check").toBeGreaterThanOrEqual(14);
      for (const id of ["bookmarks.toggle", "bookmarks.next", "bookmarks.prev", "bookmarks.saveView"]) {
        expect(registered).toContain(id);
      }
      expect(registered.filter((id) => !CommandRegistry.has(id))).toEqual([]);
    } finally {
      await extension.deactivate?.();
    }
    expect(
      registered.filter((id) => CommandRegistry.has(id)),
      "still registered after deactivate",
    ).toEqual([]);
  });

  it("a re-activate registers them again (and a second deactivate removes them again)", async () => {
    const first: string[] = [];
    await extension.activate(stubContext(first));
    await extension.deactivate?.();
    const second: string[] = [];
    await extension.activate(stubContext(second));
    try {
      expect(second.sort()).toEqual(first.sort());
      expect(second.filter((id) => !CommandRegistry.has(id))).toEqual([]);
    } finally {
      await extension.deactivate?.();
    }
    expect(second.filter((id) => CommandRegistry.has(id))).toEqual([]);
  });
});

describe("Cell Bookmarks' menu doors live exactly as long as the extension", () => {
  it("positive control: while active, Insert > Bookmarks > Add Bookmark adds one, and the grid menu offers it", async () => {
    await extension.activate(stubContext([]));
    try {
      const add = insertMenuItem("insert.bookmarks.add");
      expect(add, "the Add Bookmark item exists while active").not.toBeNull();
      h.added = 0;
      await add!.action?.();
      expect(h.added).toBe(1);
      expect(bookmarkContextItems()).toContain("bookmarks.context.add");
    } finally {
      await extension.deactivate?.();
    }
  });

  it("after deactivate no Insert > Bookmarks item and no grid right-click item remains", async () => {
    await extension.activate(stubContext([]));
    await extension.deactivate?.();
    expect(insertMenuItem("insert.bookmarks"), "Insert > Bookmarks survived deactivate").toBeNull();
    expect(insertMenuItem("insert.bookmarks.add"), "Insert > Bookmarks > Add Bookmark survived deactivate").toBeNull();
    expect(bookmarkContextItems(), "grid right-click bookmark items survived deactivate").toEqual([]);
  });

  it("a re-activate brings exactly one Insert > Bookmarks back", async () => {
    await extension.activate(stubContext([]));
    await extension.deactivate?.();
    await extension.activate(stubContext([]));
    try {
      const insert = getMenus().find((m) => m.id === "insert");
      expect(insert?.items.filter((i) => i.id === "insert.bookmarks").length).toBe(1);
      expect(insertMenuItem("insert.bookmarks.add")).not.toBeNull();
      expect(bookmarkContextItems().sort()).toEqual(["bookmarks.context.add", "bookmarks.context.edit", "bookmarks.context.remove"]);
    } finally {
      await extension.deactivate?.();
    }
  });
});
