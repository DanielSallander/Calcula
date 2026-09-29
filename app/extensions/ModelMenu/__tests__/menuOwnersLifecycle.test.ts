//! FILENAME: app/extensions/ModelMenu/__tests__/menuOwnersLifecycle.test.ts
// PURPOSE: X19 (wave D). An extension that BUILDS a menu with registerMenu takes
//          it away on deactivate -- and a menu other extensions add items to
//          is not taken away while they still have items in it.
// CONTEXT: Eight menus were built and never removed: Data (AutoFilter),
//          Collaboration and Writeback (Collaboration), External Data, Model
//          (Model Menu), Review (Protection), Quick Access, Developer (Script
//          Notebook) and the legacy Conditional Formatting menu. Wave C added
//          unregisterMenu, whose plain form removes the menu with the items
//          others added to it (Standard Menus' Edit / Insert: W20). Data,
//          External Data, Model, Review and Developer are SHARED -- Grouping,
//          Solver, CSV, BI, Comments, the Macro Recorder... all add to them --
//          so their owners unregister with { keepWhileShared: true }: the
//          owner's own items go, the menu stays with the others' items, and it
//          goes with the last of them.

import { describe, it, expect, vi } from "vitest";
import type { ExtensionContext, ExtensionModule } from "@api/contract";
import { loadHarness, doorsUnder, settle, type Loader } from "./lifecycleHarness";

vi.mock("@api/backend", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@api/backend")>()),
  listenForEvent: vi.fn(async () => () => {}),
  listenTauriEvent: vi.fn(async () => () => {}),
}));
// No Tauri host under jsdom: every backend read answers "nothing" -- in the
// shape the caller reads (Collaboration's writeback index and layer), so an
// activation's initial loads cannot reject unhandled.
vi.mock("@tauri-apps/api/core", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tauri-apps/api/core")>()),
  invoke: vi.fn(async (cmd: string) => {
    if (cmd === "calp_get_writeback_regions") return [];
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

const AUTO_FILTER: Loader = () => import("../../AutoFilter");
const COLLABORATION: Loader = () => import("../../Collaboration");
const EXTERNAL_DATA: Loader = () => import("../../ExternalData");
const MODEL_MENU: Loader = () => import("..");
const PROTECTION: Loader = () => import("../../Protection");
const QUICK_ACCESS: Loader = () => import("../../QuickAccess");
const SCRIPT_NOTEBOOK: Loader = () => import("../../ScriptNotebook");
const CONDITIONAL_FORMATTING: Loader = () => import("../../_standard/conditional-formatting");

/** [name, loader, the menus it builds] */
const OWNERS: [string, Loader, string[]][] = [
  ["AutoFilter", AUTO_FILTER, ["data"]],
  ["Collaboration", COLLABORATION, ["collaboration", "writeback"]],
  ["External Data", EXTERNAL_DATA, ["externalData"]],
  ["Model Menu", MODEL_MENU, ["model"]],
  ["Protection", PROTECTION, ["review"]],
  ["Quick Access", QUICK_ACCESS, ["quickAccess"]],
  ["Script Notebook", SCRIPT_NOTEBOOK, ["developer"]],
  ["Conditional Formatting", CONDITIONAL_FORMATTING, ["conditional-formatting"]],
];

describe("X19: a menu owner's doors live exactly as long as it does", () => {
  for (const [name, loader, owns] of OWNERS) {
    it(`${name}: deactivate removes its menu${owns.length > 1 ? "s" : ""} and every other door activate added`, async () => {
      const { ext, context, doors } = await loadHarness(loader, { owns });
      const before = doors();
      await ext.activate(context);
      await settle();
      const added = doors().filter((d) => !before.includes(d));
      for (const id of owns) expect(added, `${name} did not build menu "${id}"`).toContain(`menu/${id}`);
      await ext.deactivate?.();
      await settle();
      expect(doors(), `${name} left these after deactivate (it added ${JSON.stringify(added)})`).toEqual(before);
    }, 30_000);
  }
});

/** A stand-in for "another extension": one item in `menuId`, taken back on deactivate. */
function contributor(menuId: string): ExtensionModule {
  let ctx: ExtensionContext | null = null;
  const itemId = `${menuId}:otherExtensionsItem`;
  return {
    manifest: { id: `test.contributor.${menuId}`, name: "Contributor", version: "1.0.0" },
    activate(context: ExtensionContext) {
      ctx = context;
      context.ui.menus.registerItem(menuId, { id: itemId, label: "Another extension's item", action: () => {} });
    },
    deactivate() {
      ctx?.ui.menus.unregisterItem(menuId, itemId);
      ctx = null;
    },
  };
}

const SHARED: [string, Loader, string][] = [
  ["AutoFilter", AUTO_FILTER, "data"],
  ["External Data", EXTERNAL_DATA, "externalData"],
  ["Model Menu", MODEL_MENU, "model"],
  ["Protection", PROTECTION, "review"],
  ["Script Notebook", SCRIPT_NOTEBOOK, "developer"],
];

describe("X19: a SHARED menu stays while another extension still has an item in it", () => {
  for (const [name, loader, menuId] of SHARED) {
    it(`${name}: "${menuId}" keeps the other extension's item, and goes with the last of it`, async () => {
      const { ext: owner, context, doors } = await loadHarness(loader, { owns: [menuId] });
      const other = contributor(menuId);
      const before = doors();
      const inMenu = () => doorsUnder(doors(), `${menuId}/`);
      const theirs = `${menuId}/${menuId}:otherExtensionsItem`;

      await other.activate(context);
      await owner.activate(context);
      await settle();
      const all = inMenu();
      expect(all, "positive control: the other extension's item is in the menu").toContain(theirs);

      await owner.deactivate?.();
      await settle();
      expect(doors(), `${name} took the shared "${menuId}" menu while another extension had an item in it`).toContain(
        `menu/${menuId}`,
      );
      expect(inMenu(), `${name} left its own items, or took the other's`).toEqual([theirs]);

      // The owner comes back: its items AND the other's, once each.
      await owner.activate(context);
      await settle();
      expect(inMenu(), `after ${name} came back`).toEqual(all);

      await owner.deactivate?.();
      await settle();
      expect(inMenu()).toEqual([theirs]);

      // The last contributor leaves: the menu it was holding open goes too.
      await other.deactivate?.();
      expect(doors(), `the "${menuId}" menu outlived every extension that had an item in it`).toEqual(before);
    }, 30_000);
  }

  it("AutoFilter + Grouping (real contributors): Data keeps Outline while Grouping is active", async () => {
    const { ext: autoFilter, companions, context, doors } = await loadHarness(AUTO_FILTER, {
      owns: ["data"],
      companions: [() => import("../../Grouping")],
    });
    const [grouping] = companions;
    const before = doors();
    await autoFilter.activate(context);
    await grouping.activate(context);
    await settle();
    expect(doors()).toContain("data/data:filter");
    expect(doors()).toContain("data/data:outline:group");

    await autoFilter.deactivate?.();
    await settle();
    expect(doors(), "Data went with AutoFilter while Grouping still had Outline in it").toContain("menu/data");
    expect(doors()).toContain("data/data:outline:group");
    expect(doors(), "AutoFilter's own Filter item stayed").not.toContain("data/data:filter");

    await grouping.deactivate?.();
    await settle();
    expect(doors(), "Data outlived both").toEqual(before);
  }, 30_000);
});

describe("X19: a menu taken back is not built again by a late refresh", () => {
  it("Protection: the protection refresh still in flight at deactivate does not rebuild Review", async () => {
    const { ext, context, doors } = await loadHarness(PROTECTION, { owns: ["review"] });
    const before = doors();
    await ext.activate(context);
    // No settle: activation's initial refreshProtectionState() -> refreshMenu()
    // is still in flight when the extension goes.
    await ext.deactivate?.();
    await settle();
    expect(doors(), "the Review menu came back after Protection was deactivated").toEqual(before);
  }, 30_000);

  it("Quick Access: pinning from a palette still open at deactivate neither rebuilds the menu nor overwrites the saved pins", async () => {
    // The user's saved pins. deactivate() empties the in-memory set, so a
    // late toggle that still SAVES overwrites these with the one id toggled,
    // and the next activation loads only that (review of X19, wave D). The
    // stored value is asserted, never deleted first -- deleting it is what
    // hid the loss in the first version of this test.
    const KEY = "calcula:quickAccess:pinnedIds";
    const saved = JSON.stringify(["data:sort", "edit:copy"]);
    localStorage.setItem(KEY, saved);
    try {
      const { ext, context, doors, ui } = await loadHarness(QUICK_ACCESS, { owns: ["quickAccess"] });
      const before = doors();
      await ext.activate(context);
      const more = ui
        .getMenus()
        .find((m) => m.id === "quickAccess")
        ?.items.find((i) => i.id === "quickAccess:more");
      const palette = more?.customContent?.(() => {}) as
        | { props: { onTogglePin: (entry: { id: string; label: string; shortLabel: string }) => void } }
        | undefined;
      expect(palette?.props.onTogglePin, "positive control: the palette's pin door").toBeTypeOf("function");
      expect(localStorage.getItem(KEY), "positive control: activation keeps the saved pins").toBe(saved);

      await ext.deactivate?.();
      palette?.props.onTogglePin({ id: "data:filter", label: "Filter", shortLabel: "Filter" });
      expect(doors(), "a pin toggled after deactivate built the Quick Access menu again").toEqual(before);
      expect(localStorage.getItem(KEY), "a pin toggled after deactivate overwrote the user's saved pins").toBe(saved);
    } finally {
      localStorage.removeItem(KEY);
    }
  }, 30_000);

  it("Quick Access: unpinning from a menu still open at deactivate does not wipe the saved pins", async () => {
    // A pinned item's unpin button (rightAction) in a dropdown still on
    // screen: after deactivate the in-memory set is empty, so a save there
    // stores [] -- every pin gone at once.
    const KEY = "calcula:quickAccess:pinnedIds";
    const saved = JSON.stringify(["data:filter"]);
    localStorage.setItem(KEY, saved);
    try {
      const { ext, context, ui } = await loadHarness(QUICK_ACCESS, { owns: ["quickAccess"] });
      // The pinned id must resolve to a real menu item to be listed.
      ui.registerMenuItem("data", { id: "data:filter", label: "Filter", action: () => {} });
      await ext.activate(context);
      const pinned = ui
        .getMenus()
        .find((m) => m.id === "quickAccess")
        ?.items.find((i) => i.id === "quickAccess:pinned:data:filter");
      expect(pinned?.rightAction?.onClick, "positive control: the pinned item's unpin door").toBeTypeOf("function");

      await ext.deactivate?.();
      pinned?.rightAction?.onClick?.();
      expect(localStorage.getItem(KEY), "an unpin after deactivate wiped the user's saved pins").toBe(saved);
    } finally {
      localStorage.removeItem(KEY);
    }
  }, 30_000);
});

describe("NEW (found by the census): Protection's sheet-tab overrides are put back on deactivate", () => {
  it("the core Rename / Delete / Insert Sheet items return in place, the same objects", async () => {
    const { ext, context, extensions } = await loadHarness(PROTECTION, { owns: ["review"] });
    const core = ["core:rename", "core:delete", "core:insertSheet"].map((id) => ({
      id,
      label: id,
      onClick: () => {},
    }));
    const first = { id: "core:first", label: "First", onClick: () => {} };
    const last = { id: "core:last", label: "Last", onClick: () => {} };
    for (const item of [first, ...core, last]) extensions.sheetExtensions.registerContextMenuItem(item);
    const order = () => extensions.sheetExtensions.getContextMenuItems().map((i) => i.id);
    const initialOrder = order();

    await ext.activate(context);
    await settle();
    const overridden = extensions.sheetExtensions.getContextMenuItems().filter((i) => i.id.startsWith("core:"));
    expect(
      overridden.filter((i) => core.includes(i as never)),
      "positive control: Protection replaces the three core items while it is active",
    ).toEqual([]);

    await ext.deactivate?.();
    await settle();
    expect(order(), "the core items moved").toEqual(initialOrder);
    for (const item of core) {
      expect(
        extensions.sheetExtensions.getContextMenuItems().find((i) => i.id === item.id),
        `${item.id}: Protection's override outlived it`,
      ).toBe(item);
    }
  }, 30_000);
});

describe("X19: unregisterMenu(id, { keepWhileShared: true }) in the registry", () => {
  const MENU = "x19-registry-menu";

  async function fresh() {
    const { ui } = await loadHarness(async () => ({ default: contributor("unused") }));
    const build = () =>
      ui.registerMenu({ id: MENU, label: "Owner", order: 997, items: [{ id: "own:a", label: "Own", action: () => {} }] });
    const items = () => ui.getMenus().find((m) => m.id === MENU)?.items.map((i) => i.id);
    return { ui, build, items };
  }

  it("with nothing else in it, the menu goes -- and the subscribers hear it once", async () => {
    const { ui, build, items } = await fresh();
    build();
    const heard = vi.fn();
    const off = ui.subscribeToMenus(heard);
    ui.unregisterMenu(MENU, { keepWhileShared: true });
    off();
    expect(items()).toBeUndefined();
    expect(heard).toHaveBeenCalledTimes(1);
  });

  it("a nested contribution holds it open; its removal takes the empty parent AND the menu", async () => {
    const { ui, build, items } = await fresh();
    build();
    ui.registerMenuItem(MENU, {
      id: "shared:parent",
      label: "Parent",
      children: [{ id: "shared:parent:child", label: "Child", action: () => {} }],
    });
    ui.unregisterMenu(MENU, { keepWhileShared: true });
    expect(items()).toEqual(["shared:parent"]);

    const heard = vi.fn();
    const off = ui.subscribeToMenus(heard);
    ui.unregisterMenuItem(MENU, "shared:parent:child");
    off();
    expect(items(), "an ownerless, empty menu stayed on the menu bar").toBeUndefined();
    expect(heard).toHaveBeenCalledTimes(1);
  });

  it("a menu its owner took back again is not removed by the last contribution leaving", async () => {
    const { ui, build, items } = await fresh();
    build();
    ui.registerMenuItem(MENU, { id: "theirs", label: "Theirs", action: () => {} });
    ui.unregisterMenu(MENU, { keepWhileShared: true });
    build();
    expect(items()).toEqual(["own:a", "theirs"]);
    ui.unregisterMenuItem(MENU, "theirs");
    expect(items(), "the owner's menu went with another extension's item").toEqual(["own:a"]);
    ui.unregisterMenu(MENU);
  });

  it("positive control: the plain form still removes the menu with the others' items (W20)", async () => {
    const { ui, build, items } = await fresh();
    build();
    ui.registerMenuItem(MENU, { id: "theirs", label: "Theirs", action: () => {} });
    ui.unregisterMenu(MENU);
    expect(items()).toBeUndefined();
    build();
    expect(items(), "the other extension's item came back once with the rebuilt menu").toEqual(["own:a", "theirs"]);
    ui.unregisterMenuItem(MENU, "theirs");
    ui.unregisterMenu(MENU);
  });
});
