import { describe, it, expect, vi, beforeEach } from "vitest";

// We need to reset the module between tests to get a fresh MenuRegistry
// Use dynamic import approach or test the public API

import {
  registerMenu,
  registerMenuItem,
  getMenus,
  sortMenuItems,
  subscribeToMenus,
  notifyMenusChanged,
  registerStatusBarItem,
  unregisterStatusBarItem,
  getStatusBarItems,
  subscribeToStatusBar,
} from "../ui";

describe("MenuRegistry (via public API)", () => {
  // Note: since MenuRegistry is module-scoped singleton, tests accumulate state.
  // We work around this by using unique IDs per test.

  it("registers a menu and retrieves it", () => {
    registerMenu({
      id: "test-menu-1",
      label: "Test Menu",
      order: 100,
      items: [],
    });

    const menus = getMenus();
    const found = menus.find((m) => m.id === "test-menu-1");
    expect(found).toBeDefined();
    expect(found!.label).toBe("Test Menu");
  });

  it("returns menus sorted by order", () => {
    registerMenu({ id: "sort-z", label: "Z", order: 200, items: [] });
    registerMenu({ id: "sort-a", label: "A", order: 50, items: [] });

    const menus = getMenus();
    const zIdx = menus.findIndex((m) => m.id === "sort-z");
    const aIdx = menus.findIndex((m) => m.id === "sort-a");
    expect(aIdx).toBeLessThan(zIdx);
  });

  it("registerMenuItem appends item to existing menu", () => {
    registerMenu({
      id: "test-menu-items",
      label: "Items",
      order: 300,
      items: [],
    });

    registerMenuItem("test-menu-items", {
      id: "item-1",
      label: "Item 1",
      action: vi.fn(),
    });

    const menus = getMenus();
    const menu = menus.find((m) => m.id === "test-menu-items");
    expect(menu!.items).toHaveLength(1);
    expect(menu!.items[0].id).toBe("item-1");
  });

  it("registerMenuItem merges children on duplicate ID", () => {
    registerMenu({
      id: "test-menu-merge",
      label: "Merge",
      order: 400,
      items: [],
    });

    registerMenuItem("test-menu-merge", {
      id: "parent",
      label: "Parent",
      children: [{ id: "child-a", label: "A", action: vi.fn() }],
    });

    registerMenuItem("test-menu-merge", {
      id: "parent",
      label: "Parent",
      children: [{ id: "child-b", label: "B", action: vi.fn() }],
    });

    const menus = getMenus();
    const menu = menus.find((m) => m.id === "test-menu-merge");
    const parent = menu!.items.find((i) => i.id === "parent");
    expect(parent!.children).toHaveLength(2);
  });

  it("registerMenuItem before menu registration is deferred", () => {
    registerMenuItem("deferred-menu", {
      id: "early-item",
      label: "Early",
      action: vi.fn(),
    });

    registerMenu({
      id: "deferred-menu",
      label: "Deferred",
      order: 500,
      items: [],
    });

    const menus = getMenus();
    const menu = menus.find((m) => m.id === "deferred-menu");
    expect(menu!.items.some((i) => i.id === "early-item")).toBe(true);
  });

  it("subscribeToMenus notifies on registration", () => {
    const cb = vi.fn();
    const unsub = subscribeToMenus(cb);

    registerMenu({ id: "sub-test", label: "Sub", order: 600, items: [] });
    expect(cb).toHaveBeenCalled();

    unsub();
  });

  it("notifyMenusChanged triggers subscribers", () => {
    const cb = vi.fn();
    const unsub = subscribeToMenus(cb);

    notifyMenusChanged();
    expect(cb).toHaveBeenCalled();

    unsub();
  });

  it("sortMenuItems orders items by `order` (stable; default 0) without mutating input", () => {
    // Simulates the Model menu: skeleton separators + items contributed by
    // extensions in arbitrary activation order.
    registerMenu({
      id: "sort-items-menu",
      label: "Sorted",
      order: 700,
      items: [{ id: "sep-1", label: "", separator: true, order: 19 }],
    });
    registerMenuItem("sort-items-menu", { id: "late", label: "Late", order: 30, action: vi.fn() });
    registerMenuItem("sort-items-menu", { id: "early", label: "Early", order: 10, action: vi.fn() });
    registerMenuItem("sort-items-menu", { id: "unordered-a", label: "A", action: vi.fn() });
    registerMenuItem("sort-items-menu", { id: "unordered-b", label: "B", action: vi.fn() });

    const menu = getMenus().find((m) => m.id === "sort-items-menu")!;
    const originalOrder = menu.items.map((i) => i.id);
    const sorted = sortMenuItems(menu.items).map((i) => i.id);

    // Unordered items (default 0) keep registration order and come first;
    // ordered items interleave by their explicit order values.
    expect(sorted).toEqual(["unordered-a", "unordered-b", "early", "sep-1", "late"]);
    // Registry array is untouched.
    expect(menu.items.map((i) => i.id)).toEqual(originalOrder);
  });
});

describe("StatusBarRegistry (via public API)", () => {
  it("registers and retrieves items", () => {
    registerStatusBarItem({
      id: "sb-1",
      render: () => null as any,
      priority: 10,
    });

    const items = getStatusBarItems();
    expect(items.some((i) => i.id === "sb-1")).toBe(true);
  });

  it("sorts items by priority descending", () => {
    registerStatusBarItem({ id: "sb-low", render: () => null as any, priority: 1 });
    registerStatusBarItem({ id: "sb-high", render: () => null as any, priority: 100 });

    const items = getStatusBarItems();
    const highIdx = items.findIndex((i) => i.id === "sb-high");
    const lowIdx = items.findIndex((i) => i.id === "sb-low");
    expect(highIdx).toBeLessThan(lowIdx);
  });

  it("unregisters items", () => {
    registerStatusBarItem({ id: "sb-remove", render: () => null as any });
    unregisterStatusBarItem("sb-remove");

    const items = getStatusBarItems();
    expect(items.some((i) => i.id === "sb-remove")).toBe(false);
  });

  it("subscribes to changes", () => {
    const cb = vi.fn();
    const unsub = subscribeToStatusBar(cb);

    registerStatusBarItem({ id: "sb-sub", render: () => null as any });
    expect(cb).toHaveBeenCalled();

    unsub();
  });

  it("unregister of non-existent item does not notify", () => {
    const cb = vi.fn();
    const unsub = subscribeToStatusBar(cb);

    unregisterStatusBarItem("nonexistent-sb-item");
    expect(cb).not.toHaveBeenCalled();

    unsub();
  });
});
