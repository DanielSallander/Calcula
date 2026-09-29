//! FILENAME: app/extensions/ModelMenu/__tests__/lifecycleHarness.ts
// PURPOSE: Shared harness for the wave-D lifecycle censuses (X18-X20): load an
//          extension (and companions) into FRESH registries, activate it with
//          a context whose menus and commands are REAL, and read back every
//          door it opened -- menus and menu items at any depth, grid and sheet
//          right-click items, CommandRegistry commands, ExtensionRegistry
//          commands and add-ins.
// CONTEXT: Not a test file (no .test suffix): vitest does not collect it, and
//          the test files that import it declare the module mocks themselves
//          (vi.mock is hoisted per FILE). Modelled on
//          extensions/__tests__/featureExtensionsLifecycle.test.ts (wave C).
//
// HERMETIC: every load re-imports the registries (vi.resetModules), so one
//          extension's leak cannot sit in the next one's "before" and hide it.
//          What an extension registers is read back from the registries, so a
//          door added later is covered without editing a census.

import { vi } from "vitest";
import type { ExtensionModule } from "@api/contract";
import type { MenuItemDefinition } from "@api/uiTypes";

export type Loader = () => Promise<{ default: ExtensionModule }>;

/** The menus OTHER extensions build. A census pre-registers every one of them
 *  EXCEPT the menus the extension under test builds itself. */
export const MENU_BAR = [
  "file",
  "edit",
  "view",
  "insert",
  "format",
  "data",
  "externalData",
  "model",
  "formulas",
  "collaboration",
  "writeback",
  "review",
  "developer",
  "help",
];

export interface Harness {
  ext: ExtensionModule;
  /** Extensions loaded beside it into the same registries (not activated). */
  companions: ExtensionModule[];
  context: never;
  /** Every door, as "where/id", sorted. */
  doors: () => string[];
  /** The live @api/ui module these registries belong to. */
  ui: typeof import("@api/ui");
  /** The live @api/extensions module these registries belong to. */
  extensions: typeof import("@api/extensions");
  /** The REAL shell ExtensionRegistry these registries route to (fresh per
   *  load): the commands and add-ins it holds are what the census reads. */
  shellRegistry: typeof import("@shell/registries/ExtensionRegistry").ExtensionRegistry;
}

export interface LoadOptions {
  companions?: Loader[];
  /** Menu ids NOT to pre-register (the ones the extension under test builds). */
  owns?: string[];
  /** The context's invokeBackend. Defaults to one that answers every command
   *  with null; a census that activates an extension whose activation READS a
   *  backend shape (AutoRecover's settings) passes one that answers it. */
  invokeBackend?: (command: string, args?: unknown) => Promise<unknown>;
}

/** Every door of an extension context inert, except the menus and the commands. */
function inert(): unknown {
  return new Proxy(() => () => {}, {
    get: (_t, prop) => (prop === "then" ? undefined : inert()),
    apply: () => () => {},
  });
}

export async function loadHarness(loader: Loader, options: LoadOptions = {}): Promise<Harness> {
  vi.resetModules();
  const ui = await import("@api/ui");
  const extensions = await import("@api/extensions");
  const { CommandRegistry } = await import("@api/commands");

  // The shell's ExtensionRegistry bookkeeping is the REAL one (src/shell/
  // registries/ExtensionRegistry.ts, fresh after the reset), wired the way
  // bootstrap.ts wires it: an add-in's commands go with it, and a command goes
  // only with the registration that registered it (one registered over
  // another's brings that one back when it goes). A hand copy of that
  // bookkeeping here had already drifted from the shell once -- it deleted
  // by id -- so the census reads the shell itself.
  const { ExtensionRegistry: shellRegistry } = await import("@shell/registries/ExtensionRegistry");
  type Manifest = import("@api/extensions").AddInManifest;
  type Command = import("@api/extensions").CommandDefinition;
  const service = {
    registerAddIn: (manifest: Manifest) => shellRegistry.registerAddIn(manifest),
    unregisterAddIn: (id: string) => shellRegistry.unregisterAddIn(id),
    registerCommand: (command: Command) => shellRegistry.registerCommand(command),
    unregisterCommand: (command: Command) => shellRegistry.unregisterCommand(command),
    getCommand: (id: string) => shellRegistry.getCommand(id),
    getAllCommands: () => shellRegistry.getAllCommands(),
    registerRibbonTab: () => {},
    unregisterRibbonTab: () => {},
    registerRibbonGroup: () => {},
    getRibbonTabs: () => [],
    getRibbonGroupsForTab: () => [],
    notifySelectionChange: () => {},
    onSelectionChange: () => () => {},
    onCellChange: () => () => {},
    onRegistryChange: () => () => {},
  };
  extensions.registerExtensionRegistryService(service as never);

  const gridItems = new Map<string, import("@api/extensions").GridContextMenuItem>();
  extensions.registerGridExtensionsService({
    registerContextMenuItem: (item) => void gridItems.set(item.id, item),
    registerContextMenuItems: (items) => items.forEach((item) => gridItems.set(item.id, item)),
    unregisterContextMenuItem: (id) => void gridItems.delete(id),
    getContextMenuItems: () => [...gridItems.values()],
    getContextMenuItemsForContext: () => [...gridItems.values()],
    onChange: () => () => {},
  });
  const sheetItems = new Map<string, import("@api/extensions").SheetContextMenuItem>();
  extensions.registerSheetExtensionsService({
    registerContextMenuItem: (item) => void sheetItems.set(item.id, item),
    unregisterContextMenuItem: (id) => void sheetItems.delete(id),
    getContextMenuItems: () => [...sheetItems.values()],
    getContextMenuItemsForContext: () => [],
  });

  const owns = new Set(options.owns ?? []);
  for (const id of MENU_BAR) {
    if (!owns.has(id)) ui.registerMenu({ id, label: id, order: 1, items: [] });
  }

  const doors = (): string[] => {
    const out: string[] = [];
    const walk = (menuId: string, items: MenuItemDefinition[] | undefined): void => {
      for (const item of items ?? []) {
        out.push(`${menuId}/${item.id}`);
        walk(menuId, item.children);
      }
    };
    for (const menu of ui.getMenus()) {
      out.push(`menu/${menu.id}`);
      walk(menu.id, menu.items);
    }
    for (const id of gridItems.keys()) out.push(`grid-context/${id}`);
    for (const id of sheetItems.keys()) out.push(`sheet-context/${id}`);
    for (const command of shellRegistry.getAllCommands()) out.push(`extension-registry/${command.id}`);
    for (const manifest of shellRegistry.getRegisteredAddIns()) out.push(`add-in/${manifest.id}`);
    for (const id of CommandRegistry.getAll()) out.push(`command/${id}`);
    return out.sort();
  };

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
      if (prop === "commands") return CommandRegistry;
      if (prop === "ui") {
        return new Proxy(inert() as Record<string, unknown>, {
          get: (u, p) => (p === "menus" ? menus : (u as Record<string | symbol, unknown>)[p as string]),
        });
      }
      if (prop === "invokeBackend") return options.invokeBackend ?? vi.fn(async () => null);
      return (t as Record<string | symbol, unknown>)[prop as string];
    },
  }) as never;

  const ext = (await loader()).default;
  const companions: ExtensionModule[] = [];
  for (const companion of options.companions ?? []) companions.push((await companion()).default);
  return { ext, companions, context, doors, ui, extensions, shellRegistry };
}

/** The doors under one menu path prefix ("data/data:whatIf:"), sorted. */
export function doorsUnder(doors: string[], prefix: string): string[] {
  return doors.filter((d) => d.startsWith(prefix)).sort();
}

/** Let an activation's fire-and-forget promises settle. */
export async function settle(): Promise<void> {
  for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0));
}
