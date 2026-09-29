//! FILENAME: app/extensions/BuiltIn/__tests__/builtinMenusLifecycle.test.ts
// PURPOSE: Every menu item a built-in (BuiltIn/) extension adds on activate --
//          to the menu bar at any depth, or to the grid's right-click menu --
//          is gone after deactivate.
// CONTEXT: D3 review (wave B). D3 made deactivate take a built-in's COMMANDS
//          away (builtinCommandsLifecycle.test.ts), but the menus were the same
//          defect one layer up: Cell Bookmarks' Insert > Bookmarks > Add
//          Bookmark still wrote to a store nothing painted or persisted any
//          more, its right-click Add/Remove/Edit Bookmark stayed, and Format
//          Painter's and Collection Preview's items outlived their extensions.
//          The menu bar and the right-click menu are diffed before activate and
//          after deactivate, so an item added later is covered without editing
//          this file. Standard Menus is in the census too (W20, wave C): it
//          BUILDS the Edit and Format menus with registerMenu, and until
//          @api/ui had unregisterMenu those menus outlived it by construction.
//
// HERMETIC: every test re-imports the menu registry, the grid-extensions
//          service and the extension (vi.resetModules), because a door leaked
//          by one extension would otherwise already be in the next test's
//          "before" and hide that extension's own leak.

import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@api/backend", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@api/backend")>()),
  listenForEvent: vi.fn(async () => () => {}),
  listenTauriEvent: vi.fn(async () => () => {}),
}));

type Loader = () => Promise<{ default: import("@api/contract").ExtensionModule }>;

/**
 * Every built-in, Standard Menus included: it BUILDS the Edit and Format menus
 * (registerMenu) where the others only ADD items, and its deactivate takes them
 * away with unregisterMenu. (Its File / View / Insert menus belong to its shell
 * component, whose unmount is pinned in
 * StandardMenus/__tests__/standardMenusMenuLifecycle.test.tsx.)
 */
const EXTENSIONS: [string, Loader][] = [
  ["Cell Bookmarks", () => import("../CellBookmarks")],
  ["Find & Replace", () => import("../FindReplaceDialog")],
  ["Format Cells", () => import("../FormatCellsDialog")],
  ["Format Painter", () => import("../FormatPainter")],
  ["Collection Preview", () => import("../CollectionPreview")],
  ["Paste Special", () => import("../PasteSpecial")],
  ["Standard Menus", () => import("../StandardMenus")],
];

interface Harness {
  ext: import("@api/contract").ExtensionModule;
  context: never;
  /** Every menu-bar item (at any depth) and grid right-click item, as "where/id". */
  doors: () => string[];
}

/** Fresh registries, a recording grid-extensions service, and the extension. */
async function load(loader: Loader): Promise<Harness> {
  vi.resetModules();
  const ui = await import("@api/ui");
  const extensions = await import("@api/extensions");
  const { CommandRegistry } = await import("@api/commands");

  const contextItems = new Map<string, import("@api/extensions").GridContextMenuItem>();
  extensions.registerGridExtensionsService({
    registerContextMenuItem: (item) => void contextItems.set(item.id, item),
    registerContextMenuItems: (items) => items.forEach((item) => contextItems.set(item.id, item)),
    unregisterContextMenuItem: (id) => void contextItems.delete(id),
    getContextMenuItems: () => [...contextItems.values()],
    getContextMenuItemsForContext: () => [...contextItems.values()],
    onChange: () => () => {},
  });
  // The menu bar's menus exist before any extension adds to them.
  for (const id of ["file", "edit", "view", "insert", "format", "data", "review", "formulas", "help"]) {
    ui.registerMenu({ id, label: id, order: 1, items: [] });
  }

  const doors = (): string[] => {
    const out: string[] = [];
    const walk = (menuId: string, items: import("@api/ui").MenuItemDefinition[] | undefined): void => {
      for (const item of items ?? []) {
        out.push(`${menuId}/${item.id}`);
        walk(menuId, item.children);
      }
    };
    for (const menu of ui.getMenus()) walk(menu.id, menu.items);
    for (const id of contextItems.keys()) out.push(`grid-context/${id}`);
    return out.sort();
  };

  // Every door of the context inert, except `commands`, which are REAL.
  const inert = (): unknown =>
    new Proxy(() => () => {}, {
      get: (_t, prop) => (prop === "then" ? undefined : inert()),
      apply: () => () => {},
    });
  const context = new Proxy(inert() as Record<string, unknown>, {
    get: (t, prop) => {
      if (prop === "commands") {
        return {
          register: (id: string, fn: (...a: unknown[]) => unknown, opts?: unknown) =>
            CommandRegistry.register(id, fn, opts as never),
          unregister: (id: string) => CommandRegistry.unregister(id),
          execute: (id: string, args?: unknown) => CommandRegistry.execute(id, args),
          has: (id: string) => CommandRegistry.has(id),
        };
      }
      if (prop === "invokeBackend") return vi.fn(async () => null);
      return (t as Record<string | symbol, unknown>)[prop as string];
    },
  }) as never;

  const ext = (await loader()).default;
  return { ext, context, doors };
}

beforeEach(() => {
  vi.resetModules();
});

describe("a built-in extension's menu items live exactly as long as the extension", () => {
  for (const [name, loader] of EXTENSIONS) {
    it(`${name}: deactivate removes every menu item activate added`, async () => {
      const { ext, context, doors } = await load(loader);
      const before = doors();
      await ext.activate(context);
      const added = doors().filter((door) => !before.includes(door));
      await ext.deactivate?.();
      expect(
        doors().filter((door) => !before.includes(door)),
        `${name} left these menu items after deactivate (it added ${JSON.stringify(added)})`,
      ).toEqual([]);
    });
  }

  it("positive control: the census sees each extension's items while it is active", async () => {
    const expected = new Map<string, string[]>([
      ["Cell Bookmarks", ["insert/insert.bookmarks.add", "grid-context/bookmarks.context.add"]],
      ["Format Painter", ["edit/edit:formatPainter"]],
      ["Collection Preview", ["view/view.otherOptions.autoShowCollection"]],
      ["Standard Menus", ["edit/edit:undo", "edit/edit:paste:values", "format/format:cells"]],
    ]);
    for (const [name, loader] of EXTENSIONS.filter(([n]) => expected.has(n))) {
      const { ext, context, doors } = await load(loader);
      const before = doors();
      await ext.activate(context);
      try {
        expect(doors().filter((door) => !before.includes(door)), name).toEqual(
          expect.arrayContaining(expected.get(name) ?? []),
        );
      } finally {
        await ext.deactivate?.();
      }
    }
  });
});
