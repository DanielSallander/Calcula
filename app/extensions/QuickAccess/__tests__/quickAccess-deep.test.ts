//! FILENAME: app/extensions/QuickAccess/__tests__/quickAccess-deep.test.ts
// PURPOSE: Deep tests for QuickAccess: pin scaling, corrupted storage recovery,
//          deeply nested menus, property combinations, deduplication edge cases.

import { describe, it, expect, beforeEach } from "vitest";

// ============================================================================
// Constants (from index.ts)
// ============================================================================

const STORAGE_KEY = "calcula:quickAccess:pinnedIds";

// ============================================================================
// Replicate pure logic from index.ts
// ============================================================================

function loadPinnedIds(): Set<string> {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const arr = JSON.parse(raw);
      if (Array.isArray(arr)) {
        return new Set(arr.filter((id: unknown) => typeof id === "string"));
      }
    }
  } catch {
    // Ignore corrupt data
  }
  return new Set();
}

function savePinnedIds(pinnedIds: Set<string>): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(Array.from(pinnedIds)));
  } catch {
    // Ignore quota errors
  }
}

// ============================================================================
// Menu item types
// ============================================================================

interface SimpleMenuItem {
  id: string;
  label: string;
  action?: () => void;
  commandId?: string;
  children?: SimpleMenuItem[];
  separator?: boolean;
  hidden?: boolean;
  shortcut?: string;
}

interface SimpleMenu {
  id: string;
  label: string;
  items: SimpleMenuItem[];
}

function findMenuItemById(id: string, menus: SimpleMenu[], skipMenuId: string): SimpleMenuItem | null {
  function walk(items: SimpleMenuItem[]): SimpleMenuItem | null {
    for (const item of items) {
      if (item.id === id) return item;
      if (item.children) {
        const found = walk(item.children);
        if (found) return found;
      }
    }
    return null;
  }
  for (const menu of menus) {
    if (menu.id === skipMenuId) continue;
    const found = walk(menu.items);
    if (found) return found;
  }
  return null;
}

interface CommandEntry {
  id: string;
  label: string;
  shortLabel: string;
  action?: () => void;
  commandId?: string;
  shortcut?: string;
}

function collectAllCommands(menus: SimpleMenu[]): CommandEntry[] {
  const entries: CommandEntry[] = [];

  function walk(items: SimpleMenuItem[], parentPath: string): void {
    for (const item of items) {
      if (item.separator || item.hidden) continue;
      if (item.action || item.commandId) {
        entries.push({
          id: item.id,
          label: parentPath ? `${parentPath} > ${item.label}` : item.label,
          shortLabel: item.label,
          action: item.action,
          commandId: item.commandId,
          shortcut: item.shortcut,
        });
      }
      if (item.children) {
        walk(item.children, parentPath ? `${parentPath} > ${item.label}` : item.label);
      }
    }
  }

  for (const menu of menus) {
    if (menu.id === "quickAccess") continue;
    walk(menu.items, menu.label);
  }

  return entries;
}

// ============================================================================
// Pin toggle helper (mirrors index.ts togglePin logic)
// ============================================================================

function togglePin(pinnedIds: Set<string>, id: string): Set<string> {
  const copy = new Set(pinnedIds);
  if (copy.has(id)) {
    copy.delete(id);
  } else {
    copy.add(id);
  }
  return copy;
}

// ============================================================================
// Tests
// ============================================================================

describe("QuickAccess Deep", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  // --------------------------------------------------------------------------
  // Pin/unpin at scale
  // --------------------------------------------------------------------------

  describe("pin/unpin 50 commands", () => {
    it("persists and reloads 50 pinned IDs", () => {
      const ids = new Set<string>();
      for (let i = 0; i < 50; i++) {
        ids.add(`cmd:scale:${i}`);
      }
      savePinnedIds(ids);
      const loaded = loadPinnedIds();
      expect(loaded.size).toBe(50);
      for (let i = 0; i < 50; i++) {
        expect(loaded.has(`cmd:scale:${i}`)).toBe(true);
      }
    });

    it("pin then unpin all 50 leaves empty set", () => {
      let ids = new Set<string>();
      for (let i = 0; i < 50; i++) {
        ids = togglePin(ids, `cmd:${i}`);
      }
      expect(ids.size).toBe(50);
      for (let i = 0; i < 50; i++) {
        ids = togglePin(ids, `cmd:${i}`);
      }
      expect(ids.size).toBe(0);
    });

    it("round-trips 50 pins through localStorage", () => {
      const ids = new Set<string>();
      for (let i = 0; i < 50; i++) {
        ids.add(`pin:${i}:${String.fromCharCode(65 + (i % 26))}`);
      }
      savePinnedIds(ids);
      const loaded = loadPinnedIds();
      expect(loaded).toEqual(ids);
    });
  });

  // --------------------------------------------------------------------------
  // Pin ordering stability
  // --------------------------------------------------------------------------

  describe("pin ordering stability", () => {
    it("preserves insertion order through save/load cycle", () => {
      const order = ["z-cmd", "a-cmd", "m-cmd", "b-cmd"];
      const ids = new Set(order);
      savePinnedIds(ids);
      const raw = JSON.parse(localStorage.getItem(STORAGE_KEY)!);
      // Set iteration order matches insertion order
      expect(raw).toEqual(order);
    });

    it("maintains order after removing middle element", () => {
      const ids = new Set(["first", "second", "third", "fourth"]);
      ids.delete("second");
      savePinnedIds(ids);
      const raw = JSON.parse(localStorage.getItem(STORAGE_KEY)!);
      expect(raw).toEqual(["first", "third", "fourth"]);
    });
  });

  // --------------------------------------------------------------------------
  // Corrupted localStorage recovery
  // --------------------------------------------------------------------------

  describe("corrupted localStorage recovery", () => {
    it("recovers from empty string", () => {
      localStorage.setItem(STORAGE_KEY, "");
      expect(loadPinnedIds().size).toBe(0);
    });

    it("recovers from string 'null'", () => {
      localStorage.setItem(STORAGE_KEY, "null");
      expect(loadPinnedIds().size).toBe(0);
    });

    it("recovers from string 'undefined'", () => {
      localStorage.setItem(STORAGE_KEY, "undefined");
      expect(loadPinnedIds().size).toBe(0);
    });

    it("recovers from number JSON", () => {
      localStorage.setItem(STORAGE_KEY, "42");
      expect(loadPinnedIds().size).toBe(0);
    });

    it("recovers from boolean JSON", () => {
      localStorage.setItem(STORAGE_KEY, "true");
      expect(loadPinnedIds().size).toBe(0);
    });

    it("recovers from nested arrays", () => {
      localStorage.setItem(STORAGE_KEY, JSON.stringify([["a", "b"], "c"]));
      const ids = loadPinnedIds();
      // Only "c" is a string; ["a","b"] is not
      expect(ids.size).toBe(1);
      expect(ids.has("c")).toBe(true);
    });

    it("recovers from array with objects", () => {
      localStorage.setItem(STORAGE_KEY, JSON.stringify([{ id: "a" }, "b"]));
      const ids = loadPinnedIds();
      expect(ids.size).toBe(1);
      expect(ids.has("b")).toBe(true);
    });

    it("recovers from truncated JSON", () => {
      localStorage.setItem(STORAGE_KEY, '["cmd1","cmd2');
      expect(loadPinnedIds().size).toBe(0);
    });

    it("recovers from JSON with trailing garbage", () => {
      localStorage.setItem(STORAGE_KEY, '["cmd1"]garbage');
      // JSON.parse throws on trailing chars
      expect(loadPinnedIds().size).toBe(0);
    });

    it("recovers from very large corrupted string", () => {
      localStorage.setItem(STORAGE_KEY, "x".repeat(100000));
      expect(loadPinnedIds().size).toBe(0);
    });
  });

  // --------------------------------------------------------------------------
  // Deeply nested menus (5+ levels)
  // --------------------------------------------------------------------------

  describe("deeply nested menus (5+ levels)", () => {
    function buildDeepMenu(depth: number): SimpleMenu {
      let leaf: SimpleMenuItem = {
        id: `deep:leaf`,
        label: "Leaf Action",
        action: () => {},
        shortcut: "Ctrl+L",
      };
      for (let i = depth - 1; i >= 0; i--) {
        leaf = {
          id: `deep:level${i}`,
          label: `Level ${i}`,
          children: [leaf],
        };
      }
      return { id: "deep", label: "Deep", items: [leaf] };
    }

    it("findMenuItemById finds item at depth 5", () => {
      const menus = [buildDeepMenu(5)];
      const found = findMenuItemById("deep:leaf", menus, "quickAccess");
      expect(found).not.toBeNull();
      expect(found!.label).toBe("Leaf Action");
    });

    it("findMenuItemById finds item at depth 10", () => {
      const menus = [buildDeepMenu(10)];
      const found = findMenuItemById("deep:leaf", menus, "quickAccess");
      expect(found).not.toBeNull();
    });

    it("collectAllCommands builds full path for depth 5", () => {
      const menus = [buildDeepMenu(5)];
      const cmds = collectAllCommands(menus);
      const leaf = cmds.find((c) => c.id === "deep:leaf");
      expect(leaf).toBeDefined();
      expect(leaf!.label).toBe(
        "Deep > Level 0 > Level 1 > Level 2 > Level 3 > Level 4 > Leaf Action"
      );
      expect(leaf!.shortLabel).toBe("Leaf Action");
      expect(leaf!.shortcut).toBe("Ctrl+L");
    });

    it("collectAllCommands handles depth 7 without stack overflow", () => {
      const menus = [buildDeepMenu(7)];
      const cmds = collectAllCommands(menus);
      expect(cmds.length).toBe(1);
    });
  });

  // --------------------------------------------------------------------------
  // Menu items with all property combinations
  // --------------------------------------------------------------------------

  describe("menu items with all property combinations", () => {
    it("item with action only", () => {
      const menus: SimpleMenu[] = [
        { id: "m", label: "M", items: [{ id: "a", label: "A", action: () => {} }] },
      ];
      const cmds = collectAllCommands(menus);
      expect(cmds).toHaveLength(1);
      expect(cmds[0].action).toBeDefined();
      expect(cmds[0].commandId).toBeUndefined();
    });

    it("item with commandId only", () => {
      const menus: SimpleMenu[] = [
        { id: "m", label: "M", items: [{ id: "a", label: "A", commandId: "do.thing" }] },
      ];
      const cmds = collectAllCommands(menus);
      expect(cmds).toHaveLength(1);
      expect(cmds[0].commandId).toBe("do.thing");
    });

    it("item with both action and commandId", () => {
      const menus: SimpleMenu[] = [
        { id: "m", label: "M", items: [{ id: "a", label: "A", action: () => {}, commandId: "x" }] },
      ];
      const cmds = collectAllCommands(menus);
      expect(cmds).toHaveLength(1);
      expect(cmds[0].action).toBeDefined();
      expect(cmds[0].commandId).toBe("x");
    });

    it("separator with children is still skipped", () => {
      const menus: SimpleMenu[] = [
        {
          id: "m",
          label: "M",
          items: [
            {
              id: "sep",
              label: "",
              separator: true,
              children: [{ id: "child", label: "Child", action: () => {} }],
            },
          ],
        },
      ];
      const cmds = collectAllCommands(menus);
      expect(cmds).toHaveLength(0);
    });

    it("hidden item with children is skipped", () => {
      const menus: SimpleMenu[] = [
        {
          id: "m",
          label: "M",
          items: [
            {
              id: "h",
              label: "Hidden",
              hidden: true,
              children: [{ id: "child", label: "Child", action: () => {} }],
            },
          ],
        },
      ];
      const cmds = collectAllCommands(menus);
      expect(cmds).toHaveLength(0);
    });

    it("item with no action, no commandId, and no children is excluded", () => {
      const menus: SimpleMenu[] = [
        { id: "m", label: "M", items: [{ id: "label-only", label: "Just a label" }] },
      ];
      const cmds = collectAllCommands(menus);
      expect(cmds).toHaveLength(0);
    });
  });

  // --------------------------------------------------------------------------
  // Pin deduplication edge cases
  // --------------------------------------------------------------------------

  describe("pin deduplication edge cases", () => {
    it("toggling same pin twice returns to original state", () => {
      let ids = new Set(["a", "b"]);
      ids = togglePin(ids, "c");
      ids = togglePin(ids, "c");
      expect(ids).toEqual(new Set(["a", "b"]));
    });

    it("localStorage with 100 duplicates loads as single entry", () => {
      const arr = Array(100).fill("same-id");
      localStorage.setItem(STORAGE_KEY, JSON.stringify(arr));
      const ids = loadPinnedIds();
      expect(ids.size).toBe(1);
      expect(ids.has("same-id")).toBe(true);
    });

    it("IDs differing only by case are treated as distinct", () => {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(["Cmd", "cmd", "CMD"]));
      const ids = loadPinnedIds();
      expect(ids.size).toBe(3);
    });

    it("empty string is a valid pin ID", () => {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(["", "a"]));
      const ids = loadPinnedIds();
      expect(ids.size).toBe(2);
      expect(ids.has("")).toBe(true);
    });
  });

  // --------------------------------------------------------------------------
  // Empty menu tree
  // --------------------------------------------------------------------------

  describe("empty menu tree", () => {
    it("collectAllCommands returns empty for menus with no items", () => {
      const menus: SimpleMenu[] = [
        { id: "file", label: "File", items: [] },
        { id: "edit", label: "Edit", items: [] },
      ];
      expect(collectAllCommands(menus)).toEqual([]);
    });

    it("findMenuItemById returns null in empty menus", () => {
      const menus: SimpleMenu[] = [{ id: "file", label: "File", items: [] }];
      expect(findMenuItemById("any", menus, "quickAccess")).toBeNull();
    });

    it("collectAllCommands with only quickAccess menu returns empty", () => {
      const menus: SimpleMenu[] = [
        {
          id: "quickAccess",
          label: "Quick Access",
          items: [{ id: "qa:1", label: "Pinned", action: () => {} }],
        },
      ];
      expect(collectAllCommands(menus)).toEqual([]);
    });
  });
});
