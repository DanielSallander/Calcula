import { describe, it, expect, beforeEach } from "vitest";
import {
  registerMenu,
  getMenus,
  registerMenuItem,
  registerStatusBarItem,
  unregisterStatusBarItem,
  getStatusBarItems,
} from "../ui";

// ============================================================================
// Helpers
// ============================================================================

/** We need to reset internal state between tests. The MenuRegistry and
 *  StatusBarRegistry are singletons inside ui.ts. We re-register fresh
 *  data each test and rely on the fact that registerMenu overwrites by id. */

function dummyComponent() { return null; }

// ============================================================================
// Menu registration - 30 configs with various orders/priorities
// ============================================================================

describe("menu registration ordering", () => {
  const menuConfigs = [
    // [menus to register (id, label, order)[], expected order of ids]
    {
      name: "single menu",
      menus: [{ id: "m1", label: "File", order: 1 }],
      expected: ["m1"],
    },
    {
      name: "two menus ascending",
      menus: [
        { id: "m1", label: "File", order: 1 },
        { id: "m2", label: "Edit", order: 2 },
      ],
      expected: ["m1", "m2"],
    },
    {
      name: "two menus descending",
      menus: [
        { id: "m2", label: "Edit", order: 2 },
        { id: "m1", label: "File", order: 1 },
      ],
      expected: ["m1", "m2"],
    },
    {
      name: "three menus mixed order",
      menus: [
        { id: "m3", label: "View", order: 3 },
        { id: "m1", label: "File", order: 1 },
        { id: "m2", label: "Edit", order: 2 },
      ],
      expected: ["m1", "m2", "m3"],
    },
    {
      name: "five menus",
      menus: [
        { id: "m5", label: "Help", order: 50 },
        { id: "m1", label: "File", order: 10 },
        { id: "m3", label: "View", order: 30 },
        { id: "m2", label: "Edit", order: 20 },
        { id: "m4", label: "Data", order: 40 },
      ],
      expected: ["m1", "m2", "m3", "m4", "m5"],
    },
    {
      name: "negative orders",
      menus: [
        { id: "m1", label: "A", order: -10 },
        { id: "m2", label: "B", order: -5 },
        { id: "m3", label: "C", order: 0 },
      ],
      expected: ["m1", "m2", "m3"],
    },
    {
      name: "large order values",
      menus: [
        { id: "m1", label: "A", order: 1000 },
        { id: "m2", label: "B", order: 100 },
        { id: "m3", label: "C", order: 10 },
      ],
      expected: ["m3", "m2", "m1"],
    },
    {
      name: "order 0 for all (stable by insertion)",
      menus: [
        { id: "m1", label: "A", order: 0 },
        { id: "m2", label: "B", order: 0 },
        { id: "m3", label: "C", order: 0 },
      ],
      expected: ["m1", "m2", "m3"], // stable sort
    },
    {
      name: "re-register overwrites",
      menus: [
        { id: "m1", label: "Old", order: 2 },
        { id: "m2", label: "Other", order: 1 },
        { id: "m1", label: "New", order: 2 }, // overwrite m1
      ],
      expected: ["m2", "m1"],
    },
    {
      name: "ten menus",
      menus: Array.from({ length: 10 }, (_, i) => ({
        id: `menu-${i}`,
        label: `Menu ${i}`,
        order: (9 - i) * 10,
      })),
      expected: Array.from({ length: 10 }, (_, i) => `menu-${9 - i}`),
    },
    {
      name: "fractional orders",
      menus: [
        { id: "m1", label: "A", order: 1.5 },
        { id: "m2", label: "B", order: 1.1 },
        { id: "m3", label: "C", order: 1.9 },
      ],
      expected: ["m2", "m1", "m3"],
    },
    {
      name: "single high order",
      menus: [{ id: "m1", label: "Solo", order: 999 }],
      expected: ["m1"],
    },
    {
      name: "two same order different id",
      menus: [
        { id: "a", label: "A", order: 5 },
        { id: "b", label: "B", order: 5 },
      ],
      expected: ["a", "b"],
    },
    {
      name: "sequential orders 1-5",
      menus: [
        { id: "m5", label: "E", order: 5 },
        { id: "m4", label: "D", order: 4 },
        { id: "m3", label: "C", order: 3 },
        { id: "m2", label: "B", order: 2 },
        { id: "m1", label: "A", order: 1 },
      ],
      expected: ["m1", "m2", "m3", "m4", "m5"],
    },
    {
      name: "reverse sequential 5-1",
      menus: [
        { id: "m1", label: "A", order: 5 },
        { id: "m2", label: "B", order: 4 },
        { id: "m3", label: "C", order: 3 },
        { id: "m4", label: "D", order: 2 },
        { id: "m5", label: "E", order: 1 },
      ],
      expected: ["m5", "m4", "m3", "m2", "m1"],
    },
    {
      name: "gaps in order",
      menus: [
        { id: "m1", label: "A", order: 10 },
        { id: "m2", label: "B", order: 100 },
        { id: "m3", label: "C", order: 1000 },
      ],
      expected: ["m1", "m2", "m3"],
    },
    {
      name: "interleaved registration",
      menus: [
        { id: "m1", label: "A", order: 1 },
        { id: "m3", label: "C", order: 3 },
        { id: "m2", label: "B", order: 2 },
        { id: "m5", label: "E", order: 5 },
        { id: "m4", label: "D", order: 4 },
      ],
      expected: ["m1", "m2", "m3", "m4", "m5"],
    },
    {
      name: "negative and positive mixed",
      menus: [
        { id: "m1", label: "A", order: -100 },
        { id: "m2", label: "B", order: 100 },
        { id: "m3", label: "C", order: 0 },
      ],
      expected: ["m1", "m3", "m2"],
    },
    {
      name: "twenty menus",
      menus: Array.from({ length: 20 }, (_, i) => ({
        id: `bulk-${i}`,
        label: `Bulk ${i}`,
        order: i * 5,
      })),
      expected: Array.from({ length: 20 }, (_, i) => `bulk-${i}`),
    },
    {
      name: "overwrite changes order",
      menus: [
        { id: "m1", label: "A", order: 1 },
        { id: "m2", label: "B", order: 2 },
        { id: "m1", label: "A-updated", order: 3 }, // now after m2
      ],
      expected: ["m2", "m1"],
    },
    {
      name: "three zero orders",
      menus: [
        { id: "x", label: "X", order: 0 },
        { id: "y", label: "Y", order: 0 },
        { id: "z", label: "Z", order: 0 },
      ],
      expected: ["x", "y", "z"],
    },
    {
      name: "order 1 and 2 only",
      menus: [
        { id: "second", label: "Second", order: 2 },
        { id: "first", label: "First", order: 1 },
      ],
      expected: ["first", "second"],
    },
    {
      name: "four menus reverse",
      menus: [
        { id: "d", label: "D", order: 4 },
        { id: "c", label: "C", order: 3 },
        { id: "b", label: "B", order: 2 },
        { id: "a", label: "A", order: 1 },
      ],
      expected: ["a", "b", "c", "d"],
    },
    {
      name: "six menus even orders",
      menus: [
        { id: "m6", label: "F", order: 12 },
        { id: "m4", label: "D", order: 8 },
        { id: "m2", label: "B", order: 4 },
        { id: "m5", label: "E", order: 10 },
        { id: "m3", label: "C", order: 6 },
        { id: "m1", label: "A", order: 2 },
      ],
      expected: ["m1", "m2", "m3", "m4", "m5", "m6"],
    },
    {
      name: "hidden menu still ordered",
      menus: [
        { id: "m1", label: "A", order: 1, hidden: true },
        { id: "m2", label: "B", order: 2 },
      ],
      expected: ["m1", "m2"],
    },
    {
      name: "eight menus shuffled",
      menus: [
        { id: "h", label: "H", order: 8 },
        { id: "a", label: "A", order: 1 },
        { id: "e", label: "E", order: 5 },
        { id: "c", label: "C", order: 3 },
        { id: "g", label: "G", order: 7 },
        { id: "b", label: "B", order: 2 },
        { id: "f", label: "F", order: 6 },
        { id: "d", label: "D", order: 4 },
      ],
      expected: ["a", "b", "c", "d", "e", "f", "g", "h"],
    },
    {
      name: "duplicate order values mixed",
      menus: [
        { id: "m1", label: "A", order: 1 },
        { id: "m2", label: "B", order: 1 },
        { id: "m3", label: "C", order: 2 },
        { id: "m4", label: "D", order: 2 },
      ],
      expected: ["m1", "m2", "m3", "m4"],
    },
    {
      name: "very large set of 15",
      menus: Array.from({ length: 15 }, (_, i) => ({
        id: `s-${14 - i}`,
        label: `S${14 - i}`,
        order: (14 - i) * 2,
      })),
      expected: Array.from({ length: 15 }, (_, i) => `s-${i}`),
    },
    {
      name: "single zero order",
      menus: [{ id: "zero", label: "Zero", order: 0 }],
      expected: ["zero"],
    },
    {
      name: "orders with 0.5 increments",
      menus: [
        { id: "m1", label: "A", order: 0.5 },
        { id: "m2", label: "B", order: 1.0 },
        { id: "m3", label: "C", order: 1.5 },
        { id: "m4", label: "D", order: 2.0 },
      ],
      expected: ["m1", "m2", "m3", "m4"],
    },
  ];

  it.each(menuConfigs.map((c) => [c.name, c.menus, c.expected]))(
    "menu ordering: %s",
    (_name, menus, expected) => {
      const menuDefs = menus as Array<{ id: string; label: string; order: number; hidden?: boolean }>;
      for (const m of menuDefs) {
        registerMenu({ id: m.id, label: m.label, order: m.order, items: [], hidden: m.hidden });
      }
      const result = getMenus().map((m) => m.id);
      // Only check the menus we registered (registry may have leftovers from other tests)
      const registeredIds = new Set(menuDefs.map((m) => m.id));
      const filtered = result.filter((id) => registeredIds.has(id));
      expect(filtered).toEqual(expected);
    }
  );
});

// ============================================================================
// Status bar registration - 20 configs with priorities
// ============================================================================

describe("status bar registration and priority ordering", () => {
  const configs: Array<{
    name: string;
    items: Array<{ id: string; alignment: "left" | "right"; priority?: number }>;
    expected: string[];
  }> = [
    { name: "single item", items: [{ id: "sb1", alignment: "left" }], expected: ["sb1"] },
    { name: "two items same priority", items: [{ id: "sb1", alignment: "left" }, { id: "sb2", alignment: "left" }], expected: ["sb1", "sb2"] },
    { name: "higher priority first", items: [{ id: "sb1", alignment: "left", priority: 10 }, { id: "sb2", alignment: "left", priority: 20 }], expected: ["sb2", "sb1"] },
    { name: "three items descending priority", items: [{ id: "a", alignment: "left", priority: 30 }, { id: "b", alignment: "left", priority: 20 }, { id: "c", alignment: "left", priority: 10 }], expected: ["a", "b", "c"] },
    { name: "mixed alignments", items: [{ id: "l1", alignment: "left", priority: 5 }, { id: "r1", alignment: "right", priority: 10 }], expected: ["r1", "l1"] },
    { name: "five items various priorities", items: [{ id: "a", alignment: "left", priority: 1 }, { id: "b", alignment: "left", priority: 5 }, { id: "c", alignment: "left", priority: 3 }, { id: "d", alignment: "right", priority: 2 }, { id: "e", alignment: "right", priority: 4 }], expected: ["b", "e", "c", "d", "a"] },
    { name: "all undefined priorities", items: [{ id: "a", alignment: "left" }, { id: "b", alignment: "right" }, { id: "c", alignment: "left" }], expected: ["a", "b", "c"] },
    { name: "negative priorities", items: [{ id: "a", alignment: "left", priority: -5 }, { id: "b", alignment: "left", priority: -1 }], expected: ["b", "a"] },
    { name: "zero and positive", items: [{ id: "a", alignment: "left", priority: 0 }, { id: "b", alignment: "left", priority: 10 }], expected: ["b", "a"] },
    { name: "ten items ascending", items: Array.from({ length: 10 }, (_, i) => ({ id: `s${i}`, alignment: "left" as const, priority: i })), expected: Array.from({ length: 10 }, (_, i) => `s${9 - i}`) },
    { name: "overwrite keeps latest", items: [{ id: "dup", alignment: "left", priority: 1 }, { id: "other", alignment: "left", priority: 5 }, { id: "dup", alignment: "right", priority: 10 }], expected: ["dup", "other"] },
    { name: "single high priority", items: [{ id: "high", alignment: "left", priority: 999 }], expected: ["high"] },
    { name: "single right aligned", items: [{ id: "r1", alignment: "right", priority: 1 }], expected: ["r1"] },
    { name: "priority 100 vs 50", items: [{ id: "a", alignment: "left", priority: 50 }, { id: "b", alignment: "left", priority: 100 }], expected: ["b", "a"] },
    { name: "four mixed", items: [{ id: "a", alignment: "left", priority: 4 }, { id: "b", alignment: "right", priority: 3 }, { id: "c", alignment: "left", priority: 2 }, { id: "d", alignment: "right", priority: 1 }], expected: ["a", "b", "c", "d"] },
    { name: "six items reverse registered", items: Array.from({ length: 6 }, (_, i) => ({ id: `r${5 - i}`, alignment: "left" as const, priority: (5 - i) * 10 })), expected: Array.from({ length: 6 }, (_, i) => `r${5 - i}`) },
    { name: "priority 0 only", items: [{ id: "z1", alignment: "left", priority: 0 }, { id: "z2", alignment: "left", priority: 0 }], expected: ["z1", "z2"] },
    { name: "large gap", items: [{ id: "lo", alignment: "left", priority: 1 }, { id: "hi", alignment: "left", priority: 10000 }], expected: ["hi", "lo"] },
    { name: "three right aligned", items: [{ id: "r1", alignment: "right", priority: 3 }, { id: "r2", alignment: "right", priority: 1 }, { id: "r3", alignment: "right", priority: 2 }], expected: ["r1", "r3", "r2"] },
    { name: "eight items shuffled", items: [{ id: "h", alignment: "left", priority: 8 }, { id: "a", alignment: "left", priority: 1 }, { id: "e", alignment: "left", priority: 5 }, { id: "c", alignment: "left", priority: 3 }, { id: "g", alignment: "left", priority: 7 }, { id: "b", alignment: "left", priority: 2 }, { id: "f", alignment: "left", priority: 6 }, { id: "d", alignment: "left", priority: 4 }], expected: ["h", "g", "f", "e", "d", "c", "b", "a"] },
  ];

  // Clean up status bar items before each test
  beforeEach(() => {
    // Unregister all known IDs from our configs
    const allIds = new Set<string>();
    for (const c of configs) {
      for (const item of c.items) {
        allIds.add(item.id);
      }
    }
    for (const id of allIds) {
      unregisterStatusBarItem(id);
    }
  });

  it.each(configs.map((c) => [c.name, c.items, c.expected]))(
    "status bar: %s",
    (_name, items, expected) => {
      const defs = items as Array<{ id: string; alignment: "left" | "right"; priority?: number }>;
      for (const item of defs) {
        registerStatusBarItem({
          id: item.id,
          component: dummyComponent,
          alignment: item.alignment,
          priority: item.priority,
        });
      }
      const result = getStatusBarItems().map((i) => i.id);
      // Filter to only our registered items
      const registeredIds = new Set(defs.map((d) => d.id));
      const filtered = result.filter((id) => registeredIds.has(id));
      expect(filtered).toEqual(expected);
    }
  );
});

// ============================================================================
// Menu item lookup - 40 ID lookups
// ============================================================================

describe("menu item lookup via getMenus", () => {
  // Register a menu with many items for lookup tests
  const MENU_ID = "lookup-test-menu";
  const ITEM_IDS = Array.from({ length: 40 }, (_, i) => `item-${i}`);

  beforeEach(() => {
    registerMenu({
      id: MENU_ID,
      label: "Lookup Test",
      order: 9999,
      items: ITEM_IDS.map((id, i) => ({
        id,
        label: `Item ${i}`,
        commandId: `cmd.${id}`,
        disabled: i % 3 === 0,
        hidden: i % 7 === 0,
        shortcut: i % 2 === 0 ? `Ctrl+${i}` : undefined,
      })),
    });
  });

  it.each(ITEM_IDS.map((id, i) => [id, i]))(
    "finds item '%s' at index %i",
    (itemId, index) => {
      const menus = getMenus();
      const menu = menus.find((m) => m.id === MENU_ID);
      expect(menu).toBeDefined();
      const item = menu!.items.find((it) => it.id === itemId);
      expect(item).toBeDefined();
      expect(item!.id).toBe(itemId);
      expect(item!.label).toBe(`Item ${index}`);
      expect(item!.commandId).toBe(`cmd.${itemId}`);
      if ((index as number) % 3 === 0) {
        expect(item!.disabled).toBe(true);
      }
      if ((index as number) % 7 === 0) {
        expect(item!.hidden).toBe(true);
      }
      if ((index as number) % 2 === 0) {
        expect(item!.shortcut).toBe(`Ctrl+${index}`);
      }
    }
  );
});
