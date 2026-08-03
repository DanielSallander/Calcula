//! FILENAME: app/src/api/__tests__/menuItemUpdate.test.ts
// PURPOSE: A registered menu item can be PATCHED in place (label/disabled/
//          hidden), and the patch survives a menu re-registration.
// CONTEXT: registerMenuItem is idempotent-by-merge — a second call with the same
//          id only folds in children, so it could never change a label. That is
//          how "Stop Recording" stayed in the Developer menu while nothing was
//          recording. updateMenuItem is the supported way to say "this item now
//          reads differently".

import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  getMenus,
  registerMenu,
  registerMenuItem,
  subscribeToMenus,
  unregisterMenuItem,
  updateMenuItem,
} from "../ui";

const MENU = "menu-item-update-test";

function itemsOf(menuId: string) {
  return getMenus().find((m) => m.id === menuId)?.items ?? [];
}

describe("updateMenuItem", () => {
  beforeEach(() => {
    unregisterMenuItem(MENU, "toggle");
    registerMenu({ id: MENU, label: "Test", order: 999, items: [] });
  });

  it("patches the label of a dynamically registered item", () => {
    registerMenuItem(MENU, { id: "toggle", label: "Record Macro…", order: 1 });
    expect(itemsOf(MENU).find((i) => i.id === "toggle")?.label).toBe("Record Macro…");

    updateMenuItem(MENU, "toggle", { label: "Stop Recording" });
    expect(itemsOf(MENU).find((i) => i.id === "toggle")?.label).toBe("Stop Recording");

    updateMenuItem(MENU, "toggle", { label: "Record Macro…" });
    expect(itemsOf(MENU).find((i) => i.id === "toggle")?.label).toBe("Record Macro…");
  });

  it("re-registering does NOT change the label (the reason update exists)", () => {
    registerMenuItem(MENU, { id: "toggle", label: "Record Macro…", order: 1 });
    registerMenuItem(MENU, { id: "toggle", label: "Stop Recording", order: 1 });
    expect(itemsOf(MENU).find((i) => i.id === "toggle")?.label).toBe("Record Macro…");
  });

  it("patches disabled / hidden / checked", () => {
    registerMenuItem(MENU, { id: "toggle", label: "X", order: 1 });
    updateMenuItem(MENU, "toggle", { disabled: true, hidden: true, checked: true });
    const item = itemsOf(MENU).find((i) => i.id === "toggle");
    expect(item?.disabled).toBe(true);
    expect(item?.hidden).toBe(true);
    expect(item?.checked).toBe(true);
  });

  it("the patch survives a menu re-registration", () => {
    registerMenuItem(MENU, { id: "toggle", label: "Record Macro…", order: 1 });
    updateMenuItem(MENU, "toggle", { label: "Stop Recording" });

    // A later extension re-registers the whole menu (the Developer menu's owner
    // does this at its own activation).
    registerMenu({ id: MENU, label: "Test", order: 999, items: [] });
    expect(itemsOf(MENU).find((i) => i.id === "toggle")?.label).toBe("Stop Recording");
  });

  it("notifies subscribers so the menu bar re-renders", () => {
    registerMenuItem(MENU, { id: "toggle", label: "A", order: 1 });
    const listener = vi.fn();
    const off = subscribeToMenus(listener);
    updateMenuItem(MENU, "toggle", { label: "B" });
    expect(listener).toHaveBeenCalled();
    off();
  });

  it("ignores unknown items and unknown menus without throwing or notifying", () => {
    const listener = vi.fn();
    const off = subscribeToMenus(listener);
    expect(() => updateMenuItem(MENU, "nope", { label: "B" })).not.toThrow();
    expect(() => updateMenuItem("no-such-menu", "toggle", { label: "B" })).not.toThrow();
    expect(listener).not.toHaveBeenCalled();
    off();
  });

  it("cannot rewrite an item's id", () => {
    registerMenuItem(MENU, { id: "toggle", label: "A", order: 1 });
    updateMenuItem(MENU, "toggle", { label: "B", id: "hijacked" } as never);
    const ids = itemsOf(MENU).map((i) => i.id);
    expect(ids).toContain("toggle");
    expect(ids).not.toContain("hijacked");
  });
});
