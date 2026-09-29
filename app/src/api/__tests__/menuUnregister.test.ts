//! FILENAME: app/src/api/__tests__/menuUnregister.test.ts
// PURPOSE: A menu an extension BUILT with registerMenu can be taken away again
//          (unregisterMenu) -- and taking it away does not take the items
//          OTHER extensions added to it with registerMenuItem.
// CONTEXT: W20 (wave C). @api/ui could register a menu and add, patch and
//          remove ITEMS, but not remove a menu: Standard Menus' Edit and
//          Format and Tracing's Formulas outlived their own deactivate by
//          construction. The rule for the rest of a menu is the same one the
//          dynamic record already applies to a re-registration: an item is its
//          adder's, so it stays while its adder is active and comes back --
//          once -- when the menu is built again.

import { describe, it, expect, vi, afterEach } from "vitest";
import {
  getMenus,
  registerMenu,
  registerMenuItem,
  subscribeToMenus,
  unregisterMenu,
  unregisterMenuItem,
} from "../ui";

const MENU = "menu-unregister-test";

function menu(): ReturnType<typeof getMenus>[number] | undefined {
  return getMenus().find((m) => m.id === MENU);
}

function build(): void {
  registerMenu({
    id: MENU,
    label: "Owner's menu",
    order: 998,
    items: [{ id: "own:first", label: "Own item" }],
  });
}

afterEach(() => {
  unregisterMenuItem(MENU, "foreign");
  unregisterMenu(MENU);
});

describe("unregisterMenu", () => {
  it("removes the menu from the menu bar and tells the subscribers once", () => {
    build();
    expect(menu()?.items.map((i) => i.id)).toEqual(["own:first"]);
    const heard = vi.fn();
    const off = subscribeToMenus(heard);
    try {
      unregisterMenu(MENU);
    } finally {
      off();
    }
    expect(menu()).toBeUndefined();
    expect(heard).toHaveBeenCalledTimes(1);
  });

  it("keeps another extension's item, which comes back ONCE when the menu is built again", () => {
    build();
    registerMenuItem(MENU, { id: "foreign", label: "Another extension's item" });
    expect(menu()?.items.map((i) => i.id)).toEqual(["own:first", "foreign"]);

    unregisterMenu(MENU);
    expect(menu()).toBeUndefined();

    build();
    expect(menu()?.items.map((i) => i.id)).toEqual(["own:first", "foreign"]);
    unregisterMenu(MENU);
    build();
    expect(menu()?.items.filter((i) => i.id === "foreign")).toHaveLength(1);
  });

  it("an item added while the menu is gone appears when it is built", () => {
    build();
    unregisterMenu(MENU);
    registerMenuItem(MENU, { id: "foreign", label: "Added in between" });
    expect(menu()).toBeUndefined();
    build();
    expect(menu()?.items.map((i) => i.id)).toEqual(["own:first", "foreign"]);
  });

  it("an unknown menu id is ignored, and announces nothing", () => {
    const heard = vi.fn();
    const off = subscribeToMenus(heard);
    try {
      unregisterMenu("no-such-menu-anywhere");
    } finally {
      off();
    }
    expect(heard).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// A SHARED parent (wave C review of W21). Several extensions build one submenu
// by each registering the SAME parent id with their own child, which
// registerMenuItem merges -- Data > What-If Analysis holds Goal Seek, What-If
// Data Table, Solver and Scenario Manager that way. An extension takes back
// its CHILD; the parent is everyone's. Unregistering the parent id took every
// other contributor's child with it, and they register once, at activation, so
// they never came back.
// ---------------------------------------------------------------------------

describe("unregisterMenuItem on a child of a SHARED parent", () => {
  const SHARED = "shared:whatIf";

  function contribute(child: string): void {
    registerMenuItem(MENU, {
      id: SHARED,
      label: "What-If Analysis",
      children: [{ id: `${SHARED}:${child}`, label: child, action: () => {} }],
    });
  }

  function childrenOfShared(): string[] | undefined {
    return menu()?.items.find((i) => i.id === SHARED)?.children?.map((c) => c.id);
  }

  afterEach(() => {
    unregisterMenuItem(MENU, SHARED);
    unregisterMenuItem(MENU, "own:sub");
  });

  it("takes back ONE contributor's child and leaves the others' -- in the menu and when it is built again", () => {
    build();
    contribute("a");
    contribute("b");
    contribute("c");
    expect(childrenOfShared()).toEqual([`${SHARED}:a`, `${SHARED}:b`, `${SHARED}:c`]);

    const heard = vi.fn();
    const off = subscribeToMenus(heard);
    try {
      unregisterMenuItem(MENU, `${SHARED}:b`);
    } finally {
      off();
    }
    expect(childrenOfShared(), "taking back one child of a shared parent").toEqual([`${SHARED}:a`, `${SHARED}:c`]);
    expect(heard).toHaveBeenCalledTimes(1);

    // The record a rebuilt menu is made from agrees.
    unregisterMenu(MENU);
    build();
    expect(childrenOfShared(), "the removed child came back with the rebuilt menu").toEqual([
      `${SHARED}:a`,
      `${SHARED}:c`,
    ]);

    // Its owner activating again adds it back, once.
    contribute("b");
    expect(childrenOfShared()).toEqual([`${SHARED}:a`, `${SHARED}:c`, `${SHARED}:b`]);
  });

  it("the parent goes with its LAST child -- also from the record -- and comes back with the next one", () => {
    build();
    contribute("a");
    contribute("b");
    unregisterMenuItem(MENU, `${SHARED}:a`);
    unregisterMenuItem(MENU, `${SHARED}:b`);
    expect(menu()?.items.map((i) => i.id), "an emptied shared parent stayed as an empty submenu").toEqual(["own:first"]);

    unregisterMenu(MENU);
    build();
    expect(menu()?.items.map((i) => i.id), "an empty shared parent came back with the rebuilt menu").toEqual(["own:first"]);

    contribute("c");
    expect(childrenOfShared()).toEqual([`${SHARED}:c`]);
  });

  it("the same when the contributions arrived BEFORE the menu was built", () => {
    contribute("a");
    contribute("b");
    build();
    unregisterMenuItem(MENU, `${SHARED}:a`);
    expect(childrenOfShared()).toEqual([`${SHARED}:b`]);
    unregisterMenuItem(MENU, `${SHARED}:b`);
    expect(menu()?.items.map((i) => i.id)).toEqual(["own:first"]);
  });

  it("a child added to the menu's OWN submenu is taken back without touching the owner's children", () => {
    registerMenu({
      id: MENU,
      label: "Owner's menu",
      order: 998,
      items: [{ id: "own:sub", label: "Sub", children: [{ id: "own:sub:1", label: "Own child" }] }],
    });
    registerMenuItem(MENU, { id: "own:sub", label: "Sub", children: [{ id: "foreign:child", label: "Foreign child" }] });
    const sub = (): string[] | undefined => menu()?.items.find((i) => i.id === "own:sub")?.children?.map((c) => c.id);
    expect(sub()).toEqual(["own:sub:1", "foreign:child"]);
    unregisterMenuItem(MENU, "foreign:child");
    expect(sub()).toEqual(["own:sub:1"]);
  });

  it("positive control: a top-level item is still taken back by its own id", () => {
    build();
    registerMenuItem(MENU, { id: "foreign", label: "Another extension's item" });
    unregisterMenuItem(MENU, "foreign");
    expect(menu()?.items.map((i) => i.id)).toEqual(["own:first"]);
  });
});
