//! FILENAME: app/extensions/QuickAccess/__tests__/quickAccess.test.ts
// PURPOSE: Tests for QuickAccess extension: pin persistence, menu item lookup,
//          pin toggling, and command collection.
// CONTEXT: Logic from index.ts and components/CommandPalette.tsx.

import { describe, it, expect, beforeEach, vi } from "vitest";

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
// Replicate menu item lookup logic
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

// ============================================================================
// Replicate collectAllCommands logic from CommandPalette.tsx
// ============================================================================

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
// Tests
// ============================================================================

describe("QuickAccess", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  describe("loadPinnedIds", () => {
    it("returns empty set when localStorage is empty", () => {
      const ids = loadPinnedIds();
      expect(ids.size).toBe(0);
    });

    it("loads saved string IDs", () => {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(["cmd1", "cmd2"]));
      const ids = loadPinnedIds();
      expect(ids.size).toBe(2);
      expect(ids.has("cmd1")).toBe(true);
      expect(ids.has("cmd2")).toBe(true);
    });

    it("filters out non-string values", () => {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(["cmd1", 42, null, "cmd2", true]));
      const ids = loadPinnedIds();
      expect(ids.size).toBe(2);
      expect(ids.has("cmd1")).toBe(true);
      expect(ids.has("cmd2")).toBe(true);
    });

    it("returns empty set for corrupt JSON", () => {
      localStorage.setItem(STORAGE_KEY, "{invalid json");
      const ids = loadPinnedIds();
      expect(ids.size).toBe(0);
    });

    it("returns empty set for non-array JSON", () => {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({ a: 1 }));
      const ids = loadPinnedIds();
      expect(ids.size).toBe(0);
    });

    it("deduplicates entries", () => {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(["cmd1", "cmd1", "cmd1"]));
      const ids = loadPinnedIds();
      expect(ids.size).toBe(1);
    });
  });

  describe("savePinnedIds", () => {
    it("saves set as JSON array", () => {
      const ids = new Set(["a", "b"]);
      savePinnedIds(ids);
      const raw = localStorage.getItem(STORAGE_KEY);
      expect(raw).toBeTruthy();
      const parsed = JSON.parse(raw!);
      expect(parsed).toHaveLength(2);
      expect(parsed).toContain("a");
      expect(parsed).toContain("b");
    });

    it("saves empty set as empty array", () => {
      savePinnedIds(new Set());
      expect(JSON.parse(localStorage.getItem(STORAGE_KEY)!)).toEqual([]);
    });

    it("round-trips through loadPinnedIds", () => {
      const original = new Set(["x", "y", "z"]);
      savePinnedIds(original);
      const loaded = loadPinnedIds();
      expect(loaded).toEqual(original);
    });
  });

  describe("findMenuItemById", () => {
    const menus: SimpleMenu[] = [
      {
        id: "file",
        label: "File",
        items: [
          { id: "file:new", label: "New", action: () => {} },
          {
            id: "file:recent",
            label: "Recent",
            children: [
              { id: "file:recent:1", label: "Doc1.xlsx", action: () => {} },
            ],
          },
        ],
      },
      {
        id: "quickAccess",
        label: "Quick Access",
        items: [
          { id: "qa:pinned:file:new", label: "New", action: () => {} },
        ],
      },
    ];

    it("finds a top-level item", () => {
      const item = findMenuItemById("file:new", menus, "quickAccess");
      expect(item).not.toBeNull();
      expect(item!.label).toBe("New");
    });

    it("finds a nested item", () => {
      const item = findMenuItemById("file:recent:1", menus, "quickAccess");
      expect(item).not.toBeNull();
      expect(item!.label).toBe("Doc1.xlsx");
    });

    it("skips the quickAccess menu", () => {
      const item = findMenuItemById("qa:pinned:file:new", menus, "quickAccess");
      expect(item).toBeNull();
    });

    it("returns null for non-existent id", () => {
      const item = findMenuItemById("nonexistent", menus, "quickAccess");
      expect(item).toBeNull();
    });
  });

  describe("collectAllCommands", () => {
    const action = () => {};
    const menus: SimpleMenu[] = [
      {
        id: "edit",
        label: "Edit",
        items: [
          { id: "edit:undo", label: "Undo", action, shortcut: "Ctrl+Z" },
          { id: "edit:sep", label: "", separator: true },
          { id: "edit:hidden", label: "Hidden", action, hidden: true },
          {
            id: "edit:options",
            label: "Options",
            children: [
              { id: "edit:options:a", label: "Option A", commandId: "optionA" },
            ],
          },
        ],
      },
      {
        id: "quickAccess",
        label: "Quick Access",
        items: [
          { id: "qa:something", label: "Something", action },
        ],
      },
    ];

    it("collects actionable items", () => {
      const cmds = collectAllCommands(menus);
      const ids = cmds.map((c) => c.id);
      expect(ids).toContain("edit:undo");
      expect(ids).toContain("edit:options:a");
    });

    it("skips separators", () => {
      const cmds = collectAllCommands(menus);
      expect(cmds.find((c) => c.id === "edit:sep")).toBeUndefined();
    });

    it("skips hidden items", () => {
      const cmds = collectAllCommands(menus);
      expect(cmds.find((c) => c.id === "edit:hidden")).toBeUndefined();
    });

    it("skips quickAccess menu", () => {
      const cmds = collectAllCommands(menus);
      expect(cmds.find((c) => c.id === "qa:something")).toBeUndefined();
    });

    it("builds parent path in label", () => {
      const cmds = collectAllCommands(menus);
      const optA = cmds.find((c) => c.id === "edit:options:a");
      expect(optA).toBeDefined();
      expect(optA!.label).toBe("Edit > Options > Option A");
      expect(optA!.shortLabel).toBe("Option A");
    });

    it("preserves shortcut info", () => {
      const cmds = collectAllCommands(menus);
      const undo = cmds.find((c) => c.id === "edit:undo");
      expect(undo!.shortcut).toBe("Ctrl+Z");
    });

    it("handles empty menus", () => {
      expect(collectAllCommands([])).toEqual([]);
    });

    it("skips non-actionable parent items without action/commandId", () => {
      const cmds = collectAllCommands(menus);
      expect(cmds.find((c) => c.id === "edit:options")).toBeUndefined();
    });
  });
});
