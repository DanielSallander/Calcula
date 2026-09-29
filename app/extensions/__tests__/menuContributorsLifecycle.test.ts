//! FILENAME: app/extensions/__tests__/menuContributorsLifecycle.test.ts
// PURPOSE: Every built-in extension that adds a MENU ITEM -- to the menu bar at
//          any depth, to the grid's right-click menu or to the sheet tab's --
//          takes back exactly what it added when it is deactivated: its own
//          ids, never a menu or a submenu that another extension still has an
//          item in, and each of them once again when it comes back.
// CONTEXT: Y14 (wave E). The wave-D lifecycle fix-up (finding 5) found 27
//          extensions that added menu items and never removed them -- Review's
//          nine (Review/handlers/reviewMenuBuilder.ts), Sorting's four, Print's
//          File and View submenus, ... -- and two right-click leaks hid behind
//          them: Watch Window never took back Add/Remove Watch, and Pivot's
//          hand-kept id list had drifted from its items, so "Drill-Through
//          Behavior..." outlived every deactivate. The censuses before this one
//          (featureExtensionsLifecycle, builtinMenusLifecycle,
//          menuOwnersLifecycle, Grouping's dataMenuItemsLifecycle) each named
//          the extensions they checked, and that is how 27 were never checked.
//
// DERIVED, NOT LISTED. The census is every folder extensions/manifest.ts loads
//          whose source registers a menu item, a menu or a right-click item. A
//          new contributor is in it the day it registers its first item, so a
//          leak fails the build without anyone editing this file. The one
//          contributor whose take-back is outside the files of the package that
//          wrote this census is PINNED to exactly what it leaks today, so a fix
//          or a new leak both change the pin and fail here (PINNED_LEAKS).
//
// HERMETIC: every solo load re-imports the registries and the extension
//          (vi.resetModules, in lifecycleHarness), so one extension's leak
//          cannot sit in the next one's "before" and hide it.

import { describe, it, expect, vi, beforeAll } from "vitest";
import * as fs from "fs";
import * as path from "path";
import type { ExtensionModule } from "@api/contract";
import type { MenuItemDefinition } from "@api/uiTypes";
import { loadHarness, settle, MENU_BAR, type Loader } from "../ModelMenu/__tests__/lifecycleHarness";

vi.mock("@api/backend", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@api/backend")>()),
  listenForEvent: vi.fn(async () => () => {}),
  listenTauriEvent: vi.fn(async () => () => {}),
}));
// No Tauri host under jsdom: every backend read answers "nothing" -- in the
// SHAPE its caller reads where an activation reads one (Conditional
// Formatting's rules, the Controls style cache, Collaboration's writeback
// index and layer), so no activation's initial load rejects unhandled.
vi.mock("@tauri-apps/api/core", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tauri-apps/api/core")>()),
  invoke: vi.fn(async (cmd: string) => {
    if (cmd === "calp_get_writeback_regions" || cmd === "get_all_conditional_formats" || cmd === "get_all_styles") {
      return [];
    }
    if (cmd === "calp_reconcile_writeback" || cmd === "calp_get_writeback_layer") {
      return { formatVersion: 1, drafts: [] };
    }
    return null;
  }),
}));
vi.mock("@tauri-apps/api/event", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tauri-apps/api/event")>()),
  emit: vi.fn(async () => undefined),
  listen: vi.fn(async () => () => {}),
}));

/** The scoped invokeBackend an extension's context carries: AutoRecover's
 *  activation reads its settings through it (off, so no timer runs). */
async function invokeBackend(command: string): Promise<unknown> {
  if (command === "get_auto_recover_settings") return { enabled: false, intervalMs: 300_000 };
  return null;
}

// ============================================================================
// The census, derived from the source
// ============================================================================

const EXTENSIONS_DIR = path.resolve(__dirname, "..");
const MANIFEST = fs.readFileSync(path.join(EXTENSIONS_DIR, "manifest.ts"), "utf8");

/** import identifier -> folder, for every built-in the manifest imports. */
const FOLDER_OF = new Map(
  [...MANIFEST.matchAll(/^import (\w+) from "\.\/([^"]+)";/gm)].map((m) => [m[1], m[2]] as const),
);

/** The folders in ACTIVATION order: the builtInExtensions array, not the imports. */
const ACTIVATION_ORDER: string[] = (() => {
  const body = MANIFEST.slice(MANIFEST.indexOf("export const builtInExtensions"));
  const list = body.slice(body.indexOf("["), body.indexOf("];"));
  const out: string[] = [];
  for (const m of list.replace(/\/\/.*$/gm, "").matchAll(/\b(\w+Extension)\b/g)) {
    const folder = FOLDER_OF.get(m[1]);
    if (folder && !out.includes(folder)) out.push(folder);
  }
  return out;
})();

/** A menu item, a menu or a right-click item being registered. */
const REGISTERS_A_MENU_DOOR =
  /registerMenuItem\(|menus\.registerItem\(|registerMenu\(|menus\.register\(|registerContextMenuItems?\(/;

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== "__tests__") sourceFiles(full, out);
    } else if (/\.tsx?$/.test(entry.name) && !/\.(test|spec)\.tsx?$/.test(entry.name)) {
      out.push(full);
    }
  }
  return out;
}

/** Every built-in whose source opens a menu door, in activation order. */
const CONTRIBUTORS = ACTIVATION_ORDER.filter((folder) =>
  sourceFiles(path.join(EXTENSIONS_DIR, folder)).some((file) =>
    REGISTERS_A_MENU_DOOR.test(fs.readFileSync(file, "utf8")),
  ),
);

const LOADERS = import.meta.glob<{ default: ExtensionModule }>([
  "../*/index.ts",
  "../*/index.tsx",
  "../BuiltIn/*/index.ts",
  "../BuiltIn/*/index.tsx",
]);

function loaderOf(folder: string): Loader {
  const loader = LOADERS[`../${folder}/index.ts`] ?? LOADERS[`../${folder}/index.tsx`];
  if (!loader) throw new Error(`no index.ts(x) for the built-in "${folder}"`);
  return loader as Loader;
}

/**
 * The 27 the wave-D fix-up named (finding 5): the positive control that the
 * derivation finds what motivated it.
 */
const NAMED_BY_WAVE_D = [
  "AIChat", "AdvancedFilter", "AutoRecover", "CalculationOptions", "ConditionalFormatting",
  "Consolidate", "Controls", "CsvImportExport", "CustomFillLists", "CustomFunctions", "DataForm",
  "DataValidation", "EditingOptions", "EvaluateFormula", "FlashFill", "Hyperlinks", "JsonView",
  "ModelEditor", "Pivot", "Print", "RemoveDuplicates", "Reports", "Review", "SelectVisibleCells",
  "Sorting", "TextToColumns", "WatchWindow",
];

/**
 * Leaks whose take-back lives in a file the package that wrote this census
 * could not edit, pinned EXACTLY; when one is fixed its pin fails -- delete the
 * entry then. EMPTY since wave F (Z5): the last one, Reports' two Model items
 * (model:createReport / model:manageReports, never removed), is now taken back
 * by Reports' own deactivate. Keep it empty: a new pin is a leak shipped.
 */
const PINNED_LEAKS = new Map<string, string[]>([]);

// ============================================================================
// Each contributor alone
// ============================================================================

interface Solo {
  /** Doors activate opened that were not there before. */
  added: string[];
  /** Menus activate BUILT (registerMenu) -- a pre-registered one it replaced, or a new one. */
  built: string[];
  /** Doors still open after deactivate that activate opened. */
  left: string[];
  /** With the menus it builds NOT pre-registered: what differs from before, after deactivate. */
  strictDiff: { left: string[]; gone: string[] } | null;
  error: string | null;
}

async function runSolo(folder: string): Promise<Solo> {
  try {
    const { ext, context, doors, ui } = await loadHarness(loaderOf(folder), { invokeBackend });
    const preRegistered = new Map(ui.getMenus().map((menu) => [menu.id, menu]));
    const before = doors();
    await ext.activate(context);
    await settle();
    const built = ui
      .getMenus()
      .filter((menu) => preRegistered.get(menu.id) !== menu)
      .map((menu) => menu.id);
    const added = doors().filter((door) => !before.includes(door));
    await ext.deactivate?.();
    await settle();
    const left = doors().filter((door) => !before.includes(door));

    // A menu OWNER, measured the way the app runs it: nobody built its menu
    // before it, so after deactivate the registry must be exactly as it was.
    let strictDiff: Solo["strictDiff"] = null;
    if (built.length > 0) {
      const strict = await loadHarness(loaderOf(folder), { invokeBackend, owns: built });
      const strictBefore = strict.doors();
      await strict.ext.activate(strict.context);
      await settle();
      await strict.ext.deactivate?.();
      await settle();
      const after = strict.doors();
      strictDiff = {
        left: after.filter((door) => !strictBefore.includes(door)),
        gone: strictBefore.filter((door) => !after.includes(door)),
      };
    }
    return { added, built, left, strictDiff, error: null };
  } catch (error) {
    return { added: [], built: [], left: [], strictDiff: null, error: String((error as Error)?.stack ?? error) };
  }
}

const solo = new Map<string, Solo>();

beforeAll(async () => {
  for (const folder of CONTRIBUTORS) solo.set(folder, await runSolo(folder));
}, 600_000);

describe("the census is derived from the source, not listed", () => {
  it("finds the menu contributors the manifest loads, the 27 named by wave D among them", () => {
    expect(ACTIVATION_ORDER.length, "the builtInExtensions array did not parse").toBeGreaterThan(60);
    expect(CONTRIBUTORS.length, "the source scan found too few contributors to be working").toBeGreaterThanOrEqual(60);
    expect(CONTRIBUTORS).toEqual(expect.arrayContaining(NAMED_BY_WAVE_D));
    for (const folder of CONTRIBUTORS) expect(() => loaderOf(folder), folder).not.toThrow();
  });
});

describe("each menu contributor alone: deactivate takes back every door activate opened", () => {
  for (const folder of CONTRIBUTORS) {
    it(folder, () => {
      const result = solo.get(folder);
      expect(result, `${folder} was not measured`).toBeDefined();
      const { added, built, left, strictDiff, error } = result!;
      expect(error, `${folder}'s activate or deactivate threw`).toBeNull();
      expect(
        added.length + built.length,
        `${folder} opened no door at all -- the census has nothing to check`,
      ).toBeGreaterThan(0);
      expect(left, `${folder} left these after deactivate (it opened ${JSON.stringify(added)})`).toEqual(
        PINNED_LEAKS.get(folder) ?? [],
      );
      if (strictDiff) {
        expect(strictDiff.left, `${folder} left doors behind with its own menu${built.length > 1 ? "s" : ""}`).toEqual(
          PINNED_LEAKS.get(folder) ?? [],
        );
        expect(strictDiff.gone, `${folder}'s deactivate removed doors it never opened`).toEqual([]);
      }
    });
  }
});

// ============================================================================
// All contributors together
// ============================================================================

/** Find an item by id at any depth of the live menus. */
function findItem(menus: { items: MenuItemDefinition[] }[], id: string): MenuItemDefinition | undefined {
  const walk = (items: MenuItemDefinition[]): MenuItemDefinition | undefined => {
    for (const item of items) {
      if (item.id === id) return item;
      const below = item.children ? walk(item.children) : undefined;
      if (below) return below;
    }
    return undefined;
  };
  for (const menu of menus) {
    const hit = walk(menu.items);
    if (hit) return hit;
  }
  return undefined;
}

describe("all menu contributors together: each takes back only its own, and all of it comes back", () => {
  it("deactivating any one keeps every other extension's items; re-activating it restores the menus exactly", async () => {
    const [first, ...rest] = CONTRIBUTORS;
    const { ext, companions, context, doors, ui } = await loadHarness(loaderOf(first), {
      invokeBackend,
      companions: rest.map(loaderOf),
    });
    const modules = new Map<string, ExtensionModule>(
      [ext, ...companions].map((module, i) => [CONTRIBUTORS[i], module] as const),
    );
    const before = doors();
    for (const module of modules.values()) await module.activate(context);
    await settle();
    const all = doors();

    // A door two contributors both open must be a SUBMENU they share (What-If
    // Analysis, Outline): a container with children and nothing of its own,
    // which goes with its last child. The same LEAF id in two extensions is a
    // collision -- whichever leaves first takes the other's item.
    const openers = new Map<string, string[]>();
    for (const [folder, result] of solo) {
      for (const door of result.added) openers.set(door, [...(openers.get(door) ?? []), folder]);
    }
    for (const [door, folders] of openers) {
      if (folders.length < 2) continue;
      const [where, id] = [door.slice(0, door.indexOf("/")), door.slice(door.indexOf("/") + 1)];
      const item = findItem(ui.getMenus(), id);
      expect(
        !!item && !!item.children?.length && !item.action && !item.commandId && !item.customContent,
        `${door} is opened by ${folders.join(" and ")} but is not a shared submenu (${where})`,
      ).toBe(true);
    }

    for (const [folder, module] of modules) {
      const others = new Set(
        [...solo].filter(([name]) => name !== folder).flatMap(([, result]) => result.added),
      );
      const own = (solo.get(folder)?.added ?? []).filter((door) => !others.has(door));

      await module.deactivate?.();
      await settle();
      const without = doors();
      expect(
        own.filter((door) => without.includes(door)),
        `${folder}'s own doors stayed while the others were active`,
      ).toEqual(PINNED_LEAKS.get(folder) ?? []);

      await module.activate(context);
      await settle();
      expect(doors(), `after ${folder} was deactivated and came back, the menus are not what they were`).toEqual(all);
    }

    for (const module of [...modules.values()].reverse()) await module.deactivate?.();
    await settle();
    expect(
      doors().filter((door) => !before.includes(door)),
      "doors outlived every contributor",
    ).toEqual([...PINNED_LEAKS.values()].flat().sort());
  }, 600_000);
});

// ============================================================================
// The menus Standard Menus' shell component builds
// ============================================================================

describe("no contributor reuses an id the File, View or Insert menu defines itself", () => {
  // Those three menus are built by Standard Menus' shell COMPONENT, not by an
  // activation, so no load above holds their items. An item another extension
  // registers under one of their ids is merged into it, and taking it back
  // would take the shell's own item with it.
  it("File / View / Insert ids are never added by a contributor", () => {
    const shellIds = new Set<string>();
    for (const file of ["FileMenu.ts", "ViewMenu.ts", "InsertMenu.ts"]) {
      const text = fs.readFileSync(path.join(EXTENSIONS_DIR, "BuiltIn", "StandardMenus", file), "utf8");
      for (const m of text.matchAll(/\bid:\s*["']([^"']+)["']/g)) shellIds.add(m[1]);
    }
    expect(shellIds.size, "positive control: the shell menus' ids were read").toBeGreaterThan(20);
    const reused: string[] = [];
    for (const [folder, result] of solo) {
      for (const door of result.added) {
        const [where, id] = [door.slice(0, door.indexOf("/")), door.slice(door.indexOf("/") + 1)];
        if (MENU_BAR.includes(where) && shellIds.has(id)) reused.push(`${folder}: ${door}`);
      }
    }
    expect(reused).toEqual([]);
  });
});
