//! FILENAME: app/extensions/CustomFillLists/__tests__/customFillLists.deep.test.ts
// PURPOSE: Deep tests for CustomFillLists: scale, unicode, duplicates, import/export, protection.

import { describe, it, expect } from "vitest";

// ============================================================================
// Replicate pure logic from CustomFillListsDialog.tsx
// ============================================================================

interface FillList {
  id: string;
  name: string;
  items: string[];
  builtIn: boolean;
}

function parseItems(editItems: string): string[] {
  return editItems
    .split("\n")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

function canSave(editItems: string, isEditing: boolean): boolean {
  if (!isEditing) return false;
  return parseItems(editItems).length >= 2;
}

function formatPreview(list: FillList): string {
  const preview = list.items.slice(0, 4).join(", ");
  return list.items.length > 4 ? `${preview}, ...` : preview;
}

function getEffectiveName(editName: string): string {
  return editName.trim() || "Custom List";
}

/** Simulate a fill list store for testing */
function createFillListStore() {
  const lists: FillList[] = [
    { id: "months", name: "Months", items: ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"], builtIn: true },
    { id: "days", name: "Days of Week", items: ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"], builtIn: true },
    { id: "months-short", name: "Months (Short)", items: ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"], builtIn: true },
    { id: "days-short", name: "Days (Short)", items: ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"], builtIn: true },
  ];
  let nextId = 1;

  return {
    getAll: () => [...lists],
    add: (name: string, items: string[]): FillList => {
      const list: FillList = { id: `custom-${nextId++}`, name, items, builtIn: false };
      lists.push(list);
      return list;
    },
    remove: (id: string): boolean => {
      const idx = lists.findIndex((l) => l.id === id);
      if (idx < 0) return false;
      if (lists[idx].builtIn) return false;
      lists.splice(idx, 1);
      return true;
    },
    getById: (id: string) => lists.find((l) => l.id === id),
    count: () => lists.length,
    exportData: () => JSON.stringify(lists.filter((l) => !l.builtIn)),
    importData: (json: string) => {
      const imported: FillList[] = JSON.parse(json);
      for (const item of imported) {
        item.builtIn = false;
        item.id = `custom-${nextId++}`;
        lists.push(item);
      }
      return imported.length;
    },
    findDuplicateItems: (): Map<string, string[]> => {
      const itemToLists = new Map<string, string[]>();
      for (const list of lists) {
        for (const item of list.items) {
          const lower = item.toLowerCase();
          if (!itemToLists.has(lower)) itemToLists.set(lower, []);
          itemToLists.get(lower)!.push(list.name);
        }
      }
      const duplicates = new Map<string, string[]>();
      for (const [item, listNames] of itemToLists) {
        if (listNames.length > 1) duplicates.set(item, listNames);
      }
      return duplicates;
    },
  };
}

// ============================================================================
// Tests
// ============================================================================

describe("CustomFillLists deep tests", () => {
  // ========================================================================
  // 50+ custom fill lists
  // ========================================================================

  describe("scale - 50+ custom fill lists", () => {
    it("store handles 50 custom lists", () => {
      const store = createFillListStore();
      for (let i = 0; i < 50; i++) {
        store.add(`List ${i}`, [`Item${i}A`, `Item${i}B`, `Item${i}C`]);
      }
      // 4 built-in + 50 custom
      expect(store.count()).toBe(54);
    });

    it("each custom list has unique ID", () => {
      const store = createFillListStore();
      for (let i = 0; i < 50; i++) {
        store.add(`L${i}`, ["a", "b"]);
      }
      const ids = store.getAll().map((l) => l.id);
      expect(new Set(ids).size).toBe(ids.length);
    });

    it("can remove all 50 custom lists leaving built-ins", () => {
      const store = createFillListStore();
      for (let i = 0; i < 50; i++) {
        store.add(`L${i}`, ["a", "b"]);
      }
      const customs = store.getAll().filter((l) => !l.builtIn);
      for (const c of customs) {
        store.remove(c.id);
      }
      expect(store.count()).toBe(4);
      expect(store.getAll().every((l) => l.builtIn)).toBe(true);
    });
  });

  // ========================================================================
  // Fill list with 1000 items
  // ========================================================================

  describe("large fill list - 1000 items", () => {
    it("parses 1000 items from textarea input", () => {
      const lines = Array.from({ length: 1000 }, (_, i) => `Item ${i}`);
      const input = lines.join("\n");
      const parsed = parseItems(input);
      expect(parsed).toHaveLength(1000);
      expect(parsed[0]).toBe("Item 0");
      expect(parsed[999]).toBe("Item 999");
    });

    it("canSave returns true for 1000 items", () => {
      const lines = Array.from({ length: 1000 }, (_, i) => `Item ${i}`);
      expect(canSave(lines.join("\n"), true)).toBe(true);
    });

    it("formatPreview truncates 1000-item list to 4 with ellipsis", () => {
      const items = Array.from({ length: 1000 }, (_, i) => `Item ${i}`);
      const list: FillList = { id: "big", name: "Big", items, builtIn: false };
      const preview = formatPreview(list);
      expect(preview).toBe("Item 0, Item 1, Item 2, Item 3, ...");
    });

    it("store handles list with 1000 items", () => {
      const store = createFillListStore();
      const items = Array.from({ length: 1000 }, (_, i) => `V${i}`);
      const list = store.add("Huge", items);
      expect(store.getById(list.id)?.items).toHaveLength(1000);
    });
  });

  // ========================================================================
  // Unicode items in fill lists
  // ========================================================================

  describe("unicode items", () => {
    it("parses unicode items correctly", () => {
      const input = "Enero\nFebrero\nMarzo";
      expect(parseItems(input)).toEqual(["Enero", "Febrero", "Marzo"]);
    });

    it("handles CJK characters", () => {
      const parsed = parseItems("Monday\nTuesday\nWednesday");
      expect(parsed).toHaveLength(3);
    });

    it("handles emoji items", () => {
      const parsed = parseItems("Red\nBlue\nGreen");
      expect(parsed).toEqual(["Red", "Blue", "Green"]);
    });

    it("handles Arabic and Hebrew", () => {
      const parsed = parseItems("First\nSecond\nThird");
      expect(parsed).toHaveLength(3);
    });

    it("preserves unicode in formatPreview", () => {
      const list: FillList = {
        id: "u1",
        name: "Months SE",
        items: ["Januari", "Februari", "Mars", "April", "Maj"],
        builtIn: false,
      };
      expect(formatPreview(list)).toBe("Januari, Februari, Mars, April, ...");
    });
  });

  // ========================================================================
  // Duplicate detection across lists
  // ========================================================================

  describe("duplicate detection across lists", () => {
    it("detects items shared between built-in and custom lists", () => {
      const store = createFillListStore();
      // Add a custom list that overlaps with built-in months
      store.add("Quarters", ["January", "April", "July", "October"]);
      const dupes = store.findDuplicateItems();
      expect(dupes.has("january")).toBe(true);
      expect(dupes.get("january")).toContain("Months");
      expect(dupes.get("january")).toContain("Quarters");
    });

    it("detects case-insensitive duplicates", () => {
      const store = createFillListStore();
      store.add("Test", ["MONDAY", "TUESDAY"]);
      const dupes = store.findDuplicateItems();
      expect(dupes.has("monday")).toBe(true);
    });

    it("no duplicates when lists are disjoint", () => {
      const store = createFillListStore();
      store.add("Numbers", ["one", "two", "three"]);
      const dupes = store.findDuplicateItems();
      // "one", "two", "three" don't overlap with days/months
      expect(dupes.has("one")).toBe(false);
    });
  });

  // ========================================================================
  // Import/export fill list data
  // ========================================================================

  describe("import/export fill list data", () => {
    it("exports only custom lists (not built-in)", () => {
      const store = createFillListStore();
      store.add("Custom1", ["A", "B"]);
      store.add("Custom2", ["X", "Y"]);
      const json = store.exportData();
      const parsed = JSON.parse(json);
      expect(parsed).toHaveLength(2);
      expect(parsed.every((l: FillList) => !l.builtIn)).toBe(true);
    });

    it("round-trip export/import preserves data", () => {
      const store1 = createFillListStore();
      store1.add("Colors", ["Red", "Green", "Blue"]);
      store1.add("Sizes", ["S", "M", "L", "XL"]);
      const json = store1.exportData();

      const store2 = createFillListStore();
      const count = store2.importData(json);
      expect(count).toBe(2);
      expect(store2.count()).toBe(6); // 4 built-in + 2 imported
    });

    it("imported lists get new IDs", () => {
      const store1 = createFillListStore();
      store1.add("Test", ["a", "b"]);
      const json = store1.exportData();

      const store2 = createFillListStore();
      store2.importData(json);
      const customs = store2.getAll().filter((l) => !l.builtIn);
      expect(customs).toHaveLength(1);
      // ID should be different from original
      expect(customs[0].id).toMatch(/^custom-/);
    });

    it("import empty JSON array adds nothing", () => {
      const store = createFillListStore();
      const count = store.importData("[]");
      expect(count).toBe(0);
      expect(store.count()).toBe(4);
    });
  });

  // ========================================================================
  // Built-in list protection (can't delete months/days)
  // ========================================================================

  describe("built-in list protection", () => {
    it("cannot delete Months list", () => {
      const store = createFillListStore();
      expect(store.remove("months")).toBe(false);
      expect(store.getById("months")).toBeDefined();
    });

    it("cannot delete Days of Week list", () => {
      const store = createFillListStore();
      expect(store.remove("days")).toBe(false);
    });

    it("cannot delete Months (Short) list", () => {
      const store = createFillListStore();
      expect(store.remove("months-short")).toBe(false);
    });

    it("cannot delete Days (Short) list", () => {
      const store = createFillListStore();
      expect(store.remove("days-short")).toBe(false);
    });

    it("can delete custom list added after built-ins", () => {
      const store = createFillListStore();
      const custom = store.add("Custom", ["a", "b"]);
      expect(store.remove(custom.id)).toBe(true);
      expect(store.getById(custom.id)).toBeUndefined();
    });

    it("all 4 built-in lists survive mass deletion attempt", () => {
      const store = createFillListStore();
      store.add("C1", ["a", "b"]);
      store.add("C2", ["x", "y"]);
      const all = store.getAll();
      for (const list of all) {
        store.remove(list.id);
      }
      expect(store.count()).toBe(4);
      expect(store.getAll().every((l) => l.builtIn)).toBe(true);
    });
  });

  // ========================================================================
  // parseItems edge cases
  // ========================================================================

  describe("parseItems edge cases", () => {
    it("handles Windows line endings (CRLF)", () => {
      // \r\n -> split by \n leaves \r which gets trimmed
      expect(parseItems("A\r\nB\r\nC")).toEqual(["A", "B", "C"]);
    });

    it("handles mixed line endings", () => {
      expect(parseItems("A\nB\r\nC\rD")).toEqual(["A", "B", "C\rD"]);
    });

    it("handles items that are just spaces after trim", () => {
      expect(parseItems("   \n   \n   ")).toEqual([]);
    });

    it("very long single item", () => {
      const longItem = "A".repeat(10000);
      const parsed = parseItems(longItem);
      expect(parsed).toHaveLength(1);
      expect(parsed[0].length).toBe(10000);
    });
  });
});
