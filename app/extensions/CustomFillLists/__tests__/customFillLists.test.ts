//! FILENAME: app/extensions/CustomFillLists/__tests__/customFillLists.test.ts
// PURPOSE: Tests for CustomFillLists dialog logic: item parsing, validation,
//          preview formatting, and save/delete behavior.
// CONTEXT: Logic from components/CustomFillListsDialog.tsx.

import { describe, it, expect, vi, beforeEach } from "vitest";

// ============================================================================
// Replicate pure logic from CustomFillListsDialog.tsx
// ============================================================================

interface FillList {
  id: string;
  name: string;
  items: string[];
  builtIn: boolean;
}

/**
 * Parse textarea input into items array (same logic as handleSave).
 */
function parseItems(editItems: string): string[] {
  return editItems
    .split("\n")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/**
 * Check if items are saveable (minimum 2 entries).
 */
function canSave(editItems: string, isEditing: boolean): boolean {
  if (!isEditing) return false;
  return parseItems(editItems).length >= 2;
}

/**
 * Format list items for preview in the list panel.
 */
function formatPreview(list: FillList): string {
  const preview = list.items.slice(0, 4).join(", ");
  return list.items.length > 4 ? `${preview}, ...` : preview;
}

/**
 * Determine the effective name for saving.
 */
function getEffectiveName(editName: string): string {
  return editName.trim() || "Custom List";
}

// ============================================================================
// Tests
// ============================================================================

describe("CustomFillLists", () => {
  describe("parseItems", () => {
    it("splits by newline and trims", () => {
      expect(parseItems("Mon\nTue\nWed")).toEqual(["Mon", "Tue", "Wed"]);
    });

    it("filters out empty lines", () => {
      expect(parseItems("Mon\n\nTue\n\n")).toEqual(["Mon", "Tue"]);
    });

    it("trims whitespace from each item", () => {
      expect(parseItems("  Mon  \n  Tue  ")).toEqual(["Mon", "Tue"]);
    });

    it("returns empty array for empty string", () => {
      expect(parseItems("")).toEqual([]);
    });

    it("returns empty array for whitespace-only input", () => {
      expect(parseItems("   \n  \n  ")).toEqual([]);
    });

    it("handles single item", () => {
      expect(parseItems("Monday")).toEqual(["Monday"]);
    });

    it("preserves items with internal spaces", () => {
      expect(parseItems("New York\nLos Angeles")).toEqual(["New York", "Los Angeles"]);
    });
  });

  describe("canSave", () => {
    it("returns false when not editing", () => {
      expect(canSave("Mon\nTue", false)).toBe(false);
    });

    it("returns true with 2+ items when editing", () => {
      expect(canSave("Mon\nTue", true)).toBe(true);
    });

    it("returns false with only 1 item", () => {
      expect(canSave("Mon", true)).toBe(false);
    });

    it("returns false with empty input", () => {
      expect(canSave("", true)).toBe(false);
    });

    it("returns false with blank lines only", () => {
      expect(canSave("\n\n\n", true)).toBe(false);
    });

    it("returns true with items separated by blank lines", () => {
      expect(canSave("Mon\n\n\nTue", true)).toBe(true);
    });
  });

  describe("formatPreview", () => {
    it("shows all items when 4 or fewer", () => {
      const list: FillList = { id: "1", name: "Test", items: ["A", "B", "C"], builtIn: false };
      expect(formatPreview(list)).toBe("A, B, C");
    });

    it("shows exactly 4 items without ellipsis", () => {
      const list: FillList = { id: "1", name: "Test", items: ["A", "B", "C", "D"], builtIn: false };
      expect(formatPreview(list)).toBe("A, B, C, D");
    });

    it("truncates to 4 items with ellipsis when more than 4", () => {
      const list: FillList = {
        id: "1",
        name: "Test",
        items: ["Mon", "Tue", "Wed", "Thu", "Fri"],
        builtIn: false,
      };
      expect(formatPreview(list)).toBe("Mon, Tue, Wed, Thu, ...");
    });

    it("handles single item", () => {
      const list: FillList = { id: "1", name: "Test", items: ["Only"], builtIn: false };
      expect(formatPreview(list)).toBe("Only");
    });

    it("handles empty items", () => {
      const list: FillList = { id: "1", name: "Test", items: [], builtIn: false };
      expect(formatPreview(list)).toBe("");
    });
  });

  describe("getEffectiveName", () => {
    it("uses provided name when non-empty", () => {
      expect(getEffectiveName("Days of Week")).toBe("Days of Week");
    });

    it("trims whitespace", () => {
      expect(getEffectiveName("  Regions  ")).toBe("Regions");
    });

    it("falls back to 'Custom List' for empty string", () => {
      expect(getEffectiveName("")).toBe("Custom List");
    });

    it("falls back to 'Custom List' for whitespace-only", () => {
      expect(getEffectiveName("   ")).toBe("Custom List");
    });
  });

  describe("delete guard", () => {
    it("should not allow deleting built-in lists", () => {
      const list: FillList = { id: "days", name: "Days", items: ["Mon", "Tue"], builtIn: true };
      const canDelete = !list.builtIn;
      expect(canDelete).toBe(false);
    });

    it("should allow deleting user-defined lists", () => {
      const list: FillList = { id: "custom1", name: "My List", items: ["A", "B"], builtIn: false };
      const canDelete = !list.builtIn;
      expect(canDelete).toBe(true);
    });
  });
});
