//! FILENAME: app/extensions/__tests__/featureExtensionsLifecycle.test.ts
// PURPOSE: Everything a feature extension adds on activate -- menu items at any
//          depth, grid right-click items, CommandRegistry commands, and the
//          ExtensionRegistry commands a ribbon or cell-type button runs -- is
//          gone after deactivate.
// CONTEXT: W20 / W21 (wave C). @api/ui had no unregisterMenu, and
//          ExtensionRegistry.registerCommand has no unregister, so menus and
//          commands outlived their extensions: Tracing's Formulas menu, the
//          cellBehaviors.* and sparklines.* commands, the Test Runner's test.*
//          commands. The same audit found menu ITEMS left behind by Defined
//          Names (all four Formulas items: its cleanup list was empty), the BI
//          extension (three Model items), Scenario Manager (What-If),
//          Scriptable Objects (three Developer items and Insert > Form...) and
//          Sparklines (Insert > Sparklines). The built-ins have their own
//          census (BuiltIn/__tests__/builtinMenusLifecycle.test.ts).
//
// HERMETIC: every case re-imports the registries and the extension
//          (vi.resetModules), so one extension's leak cannot sit in the next
//          one's "before" and hide it. What an extension registers is read
//          back from the registries, so a door added later is covered without
//          editing this file.

import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@api/backend", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@api/backend")>()),
  listenForEvent: vi.fn(async () => () => {}),
  listenTauriEvent: vi.fn(async () => () => {}),
}));
// No Tauri host under jsdom: every backend read answers "nothing", every event
// emit lands nowhere (an activation's initial loads must not reject unhandled).
vi.mock("@tauri-apps/api/core", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tauri-apps/api/core")>()),
  invoke: vi.fn(async () => null),
}));
vi.mock("@tauri-apps/api/event", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tauri-apps/api/event")>()),
  emit: vi.fn(async () => undefined),
  listen: vi.fn(async () => () => {}),
}));

type Loader = () => Promise<{ default: import("@api/contract").ExtensionModule }>;

const EXTENSIONS: [string, Loader][] = [
  ["Tracing", () => import("../Tracing")],
  ["Defined Names", () => import("../DefinedNames")],
  ["Business Intelligence", () => import("../BusinessIntelligence")],
  ["Scenario Manager", () => import("../ScenarioManager")],
  ["Sparklines", () => import("../Sparklines")],
  ["Table", () => import("../Table")],
  ["Test Runner", () => import("../TestRunner")],
  ["Scriptable Objects", () => import("../ScriptableObjects")],
];

/** The menus other extensions build, present before the one under test adds to them. */
const MENU_BAR = ["file", "edit", "view", "insert", "format", "data", "review", "formulas", "model", "developer", "help"];

interface Harness {
  ext: import("@api/contract").ExtensionModule;
  /** Extensions loaded beside it into the same registries (not activated). */
  companions: import("@api/contract").ExtensionModule[];
  context: never;
  /** Every door, as "where/id". */
  doors: () => string[];
}

async function load(loader: Loader, companionLoaders: Loader[] = []): Promise<Harness> {
  vi.resetModules();
  const ui = await import("@api/ui");
  const extensions = await import("@api/extensions");
  const { CommandRegistry } = await import("@api/commands");

  // The shell's ExtensionRegistry bookkeeping: an add-in's commands go with it
  // (src/shell/registries/ExtensionRegistry.ts unregisterAddIn).
  const xCommands = new Map<string, unknown>();
  const addIns = new Map<string, import("@api/extensions").AddInManifest>();
  extensions.registerExtensionRegistryService({
    registerAddIn: (manifest) => {
      addIns.set(manifest.id, manifest);
      manifest.commands?.forEach((c) => xCommands.set(c.id, c));
    },
    unregisterAddIn: (id) => {
      addIns.get(id)?.commands?.forEach((c) => xCommands.delete(c.id));
      addIns.delete(id);
    },
    registerCommand: (command) => void xCommands.set(command.id, command),
    getCommand: () => undefined,
    getAllCommands: () => [],
    registerRibbonTab: () => {},
    unregisterRibbonTab: () => {},
    registerRibbonGroup: () => {},
    getRibbonTabs: () => [],
    getRibbonGroupsForTab: () => [],
    notifySelectionChange: () => {},
    onSelectionChange: () => () => {},
    onCellChange: () => () => {},
    onRegistryChange: () => () => {},
  });
  const contextItems = new Map<string, import("@api/extensions").GridContextMenuItem>();
  extensions.registerGridExtensionsService({
    registerContextMenuItem: (item) => void contextItems.set(item.id, item),
    registerContextMenuItems: (items) => items.forEach((item) => contextItems.set(item.id, item)),
    unregisterContextMenuItem: (id) => void contextItems.delete(id),
    getContextMenuItems: () => [...contextItems.values()],
    getContextMenuItemsForContext: () => [...contextItems.values()],
    onChange: () => () => {},
  });
  for (const id of MENU_BAR) ui.registerMenu({ id, label: id, order: 1, items: [] });

  const registered = new Set<string>();
  const doors = (): string[] => {
    const out: string[] = [];
    const walk = (menuId: string, items: import("@api/ui").MenuItemDefinition[] | undefined): void => {
      for (const item of items ?? []) {
        out.push(`${menuId}/${item.id}`);
        walk(menuId, item.children);
      }
    };
    for (const menu of ui.getMenus()) {
      out.push(`menu/${menu.id}`);
      walk(menu.id, menu.items);
    }
    for (const id of contextItems.keys()) out.push(`grid-context/${id}`);
    for (const id of xCommands.keys()) out.push(`extension-registry/${id}`);
    for (const id of registered) if (CommandRegistry.has(id)) out.push(`command/${id}`);
    return out.sort();
  };

  // Every door of the context inert, except the menus and the commands, which are REAL.
  const inert = (): unknown =>
    new Proxy(() => () => {}, {
      get: (_t, prop) => (prop === "then" ? undefined : inert()),
      apply: () => () => {},
    });
  const menus = {
    register: ui.registerMenu,
    unregister: ui.unregisterMenu,
    registerItem: ui.registerMenuItem,
    unregisterItem: ui.unregisterMenuItem,
    updateItem: ui.updateMenuItem,
    getAll: ui.getMenus,
    subscribe: ui.subscribeToMenus,
    notifyChanged: ui.notifyMenusChanged,
  };
  const context = new Proxy(inert() as Record<string, unknown>, {
    get: (t, prop) => {
      if (prop === "commands") {
        return {
          register: (id: string, fn: (...a: unknown[]) => unknown, opts?: unknown) => {
            registered.add(id);
            CommandRegistry.register(id, fn, opts as never);
          },
          unregister: (id: string) => CommandRegistry.unregister(id),
          execute: (id: string, args?: unknown) => CommandRegistry.execute(id, args),
          has: (id: string) => CommandRegistry.has(id),
        };
      }
      if (prop === "ui") {
        return new Proxy(inert() as Record<string, unknown>, {
          get: (u, p) => (p === "menus" ? menus : (u as Record<string | symbol, unknown>)[p as string]),
        });
      }
      if (prop === "invokeBackend") return vi.fn(async () => null);
      return (t as Record<string | symbol, unknown>)[prop as string];
    },
  }) as never;

  const ext = (await loader()).default;
  const companions: import("@api/contract").ExtensionModule[] = [];
  for (const companion of companionLoaders) companions.push((await companion()).default);
  return { ext, companions, context, doors };
}

beforeEach(() => {
  vi.resetModules();
});

describe("a feature extension's doors live exactly as long as the extension", () => {
  for (const [name, loader] of EXTENSIONS) {
    it(`${name}: deactivate removes every door activate added`, async () => {
      const { ext, context, doors } = await load(loader);
      const before = doors();
      await ext.activate(context);
      const added = doors().filter((door) => !before.includes(door));
      await ext.deactivate?.();
      expect(added.length, `${name} added no door -- the census has nothing to check`).toBeGreaterThan(0);
      expect(
        doors().filter((door) => !before.includes(door)),
        `${name} left these after deactivate (it added ${JSON.stringify(added)})`,
      ).toEqual([]);
    }, 30_000);
  }
});

// A SHARED parent (wave C review): Data > What-If Analysis is ONE submenu that
// Goal Seek, What-If Data Table, Solver and Scenario Manager each build by
// registering the same parent id with their own child. Scenario Manager's
// deactivate took the whole parent -- and with it the other three items, which
// their owners register once, at activation, so they never came back. Each of
// the cases above activates one extension alone, so none could see it.
describe("a door SHARED between extensions outlives the one that leaves", () => {
  const whatIf = (doors: string[]): string[] => doors.filter((d) => d.startsWith("data/data:whatIf:")).sort();

  it("Scenario Manager's deactivate takes only its own What-If item; its re-activate adds it back once", async () => {
    const { ext: scenario, companions, context, doors } = await load(() => import("../ScenarioManager"), [
      () => import("../GoalSeek"),
      () => import("../DataTables"),
      () => import("../Solver"),
    ]);
    for (const companion of companions) await companion.activate(context);
    const others = whatIf(doors());
    expect(others, "positive control: the other three What-If items are there").toEqual([
      "data/data:whatIf:dataTable",
      "data/data:whatIf:goalSeek",
      "data/data:whatIf:solver",
    ]);

    await scenario.activate(context);
    const all = whatIf(doors());
    expect(all).toEqual([...others, "data/data:whatIf:scenarioManager"].sort());

    await scenario.deactivate?.();
    expect(whatIf(doors()), "Scenario Manager's deactivate took the other extensions' What-If items").toEqual(others);
    expect(doors(), "the shared What-If Analysis submenu went with Scenario Manager").toContain("data/data:whatIf");

    await scenario.activate(context);
    expect(whatIf(doors()), "after Scenario Manager came back, What-If Analysis is not what it was").toEqual(all);

    await scenario.deactivate?.();
    for (const companion of companions) await companion.deactivate?.();
  }, 30_000);
});
