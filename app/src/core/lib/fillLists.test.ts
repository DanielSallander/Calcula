import { describe, it, expect, beforeEach } from "vitest";
import { FillListRegistry } from "./fillLists";

describe("FillListRegistry", () => {
  beforeEach(() => {
    FillListRegistry._reset();
  });

  // ==========================================================================
  // Built-in lists
  // ==========================================================================

  describe("built-in lists", () => {
    it("includes weekday and month lists", () => {
      const builtIn = FillListRegistry.getBuiltInLists();
      expect(builtIn).toHaveLength(4);
      const ids = builtIn.map((l) => l.id);
      expect(ids).toContain("builtin.weekday.short");
      expect(ids).toContain("builtin.weekday.full");
      expect(ids).toContain("builtin.month.short");
      expect(ids).toContain("builtin.month.full");
    });

    it("built-in lists are marked as builtIn", () => {
      const builtIn = FillListRegistry.getBuiltInLists();
      expect(builtIn.every((l) => l.builtIn)).toBe(true);
    });

    it("getAllLists returns built-in lists when no user lists exist", () => {
      const all = FillListRegistry.getAllLists();
      expect(all).toHaveLength(4);
    });
  });

  // ==========================================================================
  // User-defined lists
  // ==========================================================================

  describe("user-defined lists", () => {
    it("adds a new user-defined list", () => {
      const list = FillListRegistry.addList("Priorities", ["High", "Medium", "Low"]);
      expect(list.id).toBeTruthy();
      expect(list.name).toBe("Priorities");
      expect(list.items).toEqual(["High", "Medium", "Low"]);
      expect(list.builtIn).toBe(false);
    });

    it("getAllLists includes user-defined lists after built-in", () => {
      FillListRegistry.addList("Sizes", ["S", "M", "L", "XL"]);
      const all = FillListRegistry.getAllLists();
      expect(all).toHaveLength(5);
      expect(all[4].name).toBe("Sizes");
    });

    it("getUserLists returns only user-defined lists", () => {
      FillListRegistry.addList("Regions", ["North", "South", "East", "West"]);
      const user = FillListRegistry.getUserLists();
      expect(user).toHaveLength(1);
      expect(user[0].name).toBe("Regions");
    });

    it("updates a user-defined list", () => {
      const list = FillListRegistry.addList("Test", ["A", "B"]);
      const updated = FillListRegistry.updateList(list.id, "Updated", ["X", "Y", "Z"]);
      expect(updated).toBe(true);
      const all = FillListRegistry.getUserLists();
      expect(all[0].name).toBe("Updated");
      expect(all[0].items).toEqual(["X", "Y", "Z"]);
    });

    it("returns false when updating a non-existent list", () => {
      expect(FillListRegistry.updateList("nonexistent", "Nope", ["A"])).toBe(false);
    });

    it("removes a user-defined list", () => {
      const list = FillListRegistry.addList("ToDelete", ["A", "B"]);
      expect(FillListRegistry.removeList(list.id)).toBe(true);
      expect(FillListRegistry.getUserLists()).toHaveLength(0);
    });

    it("returns false when removing a non-existent list", () => {
      expect(FillListRegistry.removeList("nonexistent")).toBe(false);
    });
  });

  // ==========================================================================
  // Value matching
  // ==========================================================================

  describe("matchValues", () => {
    it("matches a single weekday short name", () => {
      const match = FillListRegistry.matchValues(["Mon"]);
      expect(match).not.toBeNull();
      expect(match!.list.id).toBe("builtin.weekday.short");
      expect(match!.startIndex).toBe(1); // Mon is index 1
      expect(match!.step).toBe(1);
    });

    it("matches a single month full name", () => {
      const match = FillListRegistry.matchValues(["March"]);
      expect(match).not.toBeNull();
      expect(match!.list.id).toBe("builtin.month.full");
      expect(match!.startIndex).toBe(2); // March is index 2
    });

    it("matches consecutive weekdays", () => {
      const match = FillListRegistry.matchValues(["Mon", "Tue", "Wed"]);
      expect(match).not.toBeNull();
      expect(match!.list.id).toBe("builtin.weekday.short");
      expect(match!.step).toBe(1);
    });

    it("matches weekdays with step 2", () => {
      const match = FillListRegistry.matchValues(["Mon", "Wed", "Fri"]);
      expect(match).not.toBeNull();
      expect(match!.step).toBe(2);
    });

    it("matches months wrapping around", () => {
      const match = FillListRegistry.matchValues(["Nov", "Dec"]);
      expect(match).not.toBeNull();
      expect(match!.step).toBe(1);
    });

    it("matches case-insensitively", () => {
      const match = FillListRegistry.matchValues(["MONDAY", "tuesday"]);
      expect(match).not.toBeNull();
      expect(match!.list.id).toBe("builtin.weekday.full");
    });

    it("returns null for non-matching values", () => {
      const match = FillListRegistry.matchValues(["Foo", "Bar"]);
      expect(match).toBeNull();
    });

    it("returns null for empty values", () => {
      const match = FillListRegistry.matchValues([]);
      expect(match).toBeNull();
    });

    it("prioritizes user-defined lists over built-in", () => {
      // Create a user list that overlaps with a built-in
      FillListRegistry.addList("Custom Days", ["Mon", "Tue", "Wed", "Thu", "Fri"]);
      const match = FillListRegistry.matchValues(["Mon", "Tue"]);
      expect(match).not.toBeNull();
      // Should match user list first (5-item list, not 7-item weekday)
      expect(match!.list.builtIn).toBe(false);
      expect(match!.list.name).toBe("Custom Days");
    });

    it("matches user-defined custom list", () => {
      FillListRegistry.addList("Priorities", ["High", "Medium", "Low"]);
      const match = FillListRegistry.matchValues(["High"]);
      expect(match).not.toBeNull();
      expect(match!.list.name).toBe("Priorities");
      expect(match!.startIndex).toBe(0);
      expect(match!.step).toBe(1);
    });

    it("matches user-defined list with multiple values", () => {
      FillListRegistry.addList("Sizes", ["XS", "S", "M", "L", "XL"]);
      const match = FillListRegistry.matchValues(["S", "M", "L"]);
      expect(match).not.toBeNull();
      expect(match!.startIndex).toBe(1); // S is at index 1
      expect(match!.step).toBe(1);
    });
  });

  // ==========================================================================
  // Value generation
  // ==========================================================================

  describe("generateValue", () => {
    it("generates next weekday", () => {
      const match = FillListRegistry.matchValues(["Mon"])!;
      // Mon is index 1, step 1 -> offset 1 = Tue (index 2)
      expect(FillListRegistry.generateValue(match, 1, 1)).toBe("Tue");
      expect(FillListRegistry.generateValue(match, 1, 2)).toBe("Wed");
    });

    it("wraps around at end of list", () => {
      const match = FillListRegistry.matchValues(["Fri"])!;
      // Fri is index 5, step 1 -> offset 1 = Sat (6), offset 2 = Sun (0)
      expect(FillListRegistry.generateValue(match, 5, 1)).toBe("Sat");
      expect(FillListRegistry.generateValue(match, 5, 2)).toBe("Sun");
      expect(FillListRegistry.generateValue(match, 5, 3)).toBe("Mon");
    });

    it("generates values with step > 1", () => {
      const match = FillListRegistry.matchValues(["Mon", "Wed"])!;
      // Step is 2, last is Wed (index 3: Sun=0,Mon=1,Tue=2,Wed=3)
      expect(FillListRegistry.generateValue(match, 3, 1)).toBe("Fri");
      expect(FillListRegistry.generateValue(match, 3, 2)).toBe("Sun");
    });

    it("generates from user-defined list", () => {
      FillListRegistry.addList("Quarters", ["Q1", "Q2", "Q3", "Q4"]);
      const match = FillListRegistry.matchValues(["Q1"])!;
      expect(FillListRegistry.generateValue(match, 0, 1)).toBe("Q2");
      expect(FillListRegistry.generateValue(match, 0, 2)).toBe("Q3");
      expect(FillListRegistry.generateValue(match, 0, 3)).toBe("Q4");
      expect(FillListRegistry.generateValue(match, 0, 4)).toBe("Q1"); // wraps
    });

    it("generates months correctly", () => {
      const match = FillListRegistry.matchValues(["Oct", "Nov", "Dec"])!;
      expect(FillListRegistry.generateValue(match, 11, 1)).toBe("Jan"); // wraps
      expect(FillListRegistry.generateValue(match, 11, 2)).toBe("Feb");
    });
  });

  // ==========================================================================
  // Edge cases: multi-step sequences
  // ==========================================================================

  describe("multi-step sequences", () => {
    it("matches every 2nd month (Jan, Mar, May)", () => {
      const match = FillListRegistry.matchValues(["Jan", "Mar", "May"]);
      expect(match).not.toBeNull();
      expect(match!.step).toBe(2);
    });

    it("matches every 3rd month (Jan, Apr, Jul)", () => {
      const match = FillListRegistry.matchValues(["Jan", "Apr", "Jul"]);
      expect(match).not.toBeNull();
      expect(match!.step).toBe(3);
    });

    it("matches every 3rd weekday (Sun, Wed, Sat)", () => {
      const match = FillListRegistry.matchValues(["Sun", "Wed", "Sat"]);
      expect(match).not.toBeNull();
      expect(match!.step).toBe(3);
    });

    it("generates values for step=2 months correctly", () => {
      const match = FillListRegistry.matchValues(["Jan", "Mar"])!;
      expect(match.step).toBe(2);
      // lastIndex=2 (Mar), offset 1 => May (4), offset 2 => Jul (6)
      expect(FillListRegistry.generateValue(match, 2, 1)).toBe("May");
      expect(FillListRegistry.generateValue(match, 2, 2)).toBe("Jul");
    });

    it("wraps multi-step around list boundary", () => {
      const match = FillListRegistry.matchValues(["Oct", "Dec"])!;
      expect(match.step).toBe(2);
      // lastIndex=11 (Dec), offset 1 => Feb (1)
      expect(FillListRegistry.generateValue(match, 11, 1)).toBe("Feb");
    });
  });

  // ==========================================================================
  // Edge cases: reverse / wrapping sequences
  // ==========================================================================

  describe("reverse and wrapping sequences", () => {
    it("detects wrapping from Dec to Jan as step=1", () => {
      const match = FillListRegistry.matchValues(["Dec", "Jan"]);
      expect(match).not.toBeNull();
      expect(match!.step).toBe(1);
    });

    it("detects Nov, Dec wrapping and generates Jan", () => {
      const match = FillListRegistry.matchValues(["Nov", "Dec"])!;
      expect(FillListRegistry.generateValue(match, 11, 1)).toBe("Jan");
      expect(FillListRegistry.generateValue(match, 11, 2)).toBe("Feb");
    });

    it("detects Sat, Sun wrapping", () => {
      const match = FillListRegistry.matchValues(["Sat", "Sun"]);
      expect(match).not.toBeNull();
      expect(match!.step).toBe(1);
    });
  });

  // ==========================================================================
  // Edge cases: case insensitive matching
  // ==========================================================================

  describe("case-insensitive matching", () => {
    it("matches all-uppercase short months (JAN, FEB)", () => {
      const match = FillListRegistry.matchValues(["JAN", "FEB", "MAR"]);
      expect(match).not.toBeNull();
      expect(match!.list.id).toBe("builtin.month.short");
      expect(match!.step).toBe(1);
    });

    it("matches all-lowercase short months (jan, feb)", () => {
      const match = FillListRegistry.matchValues(["jan", "feb"]);
      expect(match).not.toBeNull();
      expect(match!.list.id).toBe("builtin.month.short");
    });

    it("matches mixed case full month names (JANUARY, february)", () => {
      const match = FillListRegistry.matchValues(["JANUARY", "february"]);
      expect(match).not.toBeNull();
      expect(match!.list.id).toBe("builtin.month.full");
    });

    it("matches with leading/trailing whitespace", () => {
      const match = FillListRegistry.matchValues(["  Mon  ", " Tue "]);
      expect(match).not.toBeNull();
      expect(match!.list.id).toBe("builtin.weekday.short");
    });

    it("matches user list case-insensitively", () => {
      FillListRegistry.addList("Grades", ["Alpha", "Beta", "Gamma"]);
      const match = FillListRegistry.matchValues(["ALPHA", "beta"]);
      expect(match).not.toBeNull();
      expect(match!.list.name).toBe("Grades");
    });
  });

  // ==========================================================================
  // Edge cases: custom lists with special content
  // ==========================================================================

  describe("custom lists with special content", () => {
    it("handles special characters in list items", () => {
      FillListRegistry.addList("Symbols", ["@home", "#work", "$money", "&more"]);
      const match = FillListRegistry.matchValues(["@home", "#work"]);
      expect(match).not.toBeNull();
      expect(match!.step).toBe(1);
    });

    it("handles unicode characters", () => {
      FillListRegistry.addList("Emojis", ["\u2764", "\u2B50", "\u2600", "\u2601"]);
      const match = FillListRegistry.matchValues(["\u2764", "\u2B50"]);
      expect(match).not.toBeNull();
      expect(match!.step).toBe(1);
      expect(FillListRegistry.generateValue(match!, 1, 1)).toBe("\u2600");
    });

    it("handles a very long custom list (100+ items)", () => {
      const items = Array.from({ length: 120 }, (_, i) => `Item_${i}`);
      FillListRegistry.addList("Big", items);
      const match = FillListRegistry.matchValues(["Item_50", "Item_51", "Item_52"]);
      expect(match).not.toBeNull();
      expect(match!.startIndex).toBe(50);
      expect(match!.step).toBe(1);
      expect(FillListRegistry.generateValue(match!, 52, 1)).toBe("Item_53");
    });

    it("wraps around a long list", () => {
      const items = Array.from({ length: 100 }, (_, i) => `V${i}`);
      FillListRegistry.addList("Century", items);
      const match = FillListRegistry.matchValues(["V98", "V99"])!;
      expect(FillListRegistry.generateValue(match, 99, 1)).toBe("V0");
    });

    it("handles single-item list", () => {
      FillListRegistry.addList("One", ["Solo"]);
      const match = FillListRegistry.matchValues(["Solo"]);
      expect(match).not.toBeNull();
      expect(match!.step).toBe(1);
      // Generating always returns the same item
      expect(FillListRegistry.generateValue(match!, 0, 1)).toBe("Solo");
      expect(FillListRegistry.generateValue(match!, 0, 5)).toBe("Solo");
    });

    it("handles duplicate items in a list (matches first occurrence)", () => {
      FillListRegistry.addList("Dupes", ["A", "B", "A", "C"]);
      const match = FillListRegistry.matchValues(["A"]);
      expect(match).not.toBeNull();
      expect(match!.startIndex).toBe(0); // indexOf returns first
    });

    it("handles empty string items in list", () => {
      FillListRegistry.addList("Blanks", ["", "X", ""]);
      const match = FillListRegistry.matchValues([""]);
      expect(match).not.toBeNull();
      expect(match!.startIndex).toBe(0);
    });

    it("empty items list does not match anything", () => {
      FillListRegistry.addList("Empty", []);
      const match = FillListRegistry.matchValues(["anything"]);
      // Should fall through to built-in lists or return null
      expect(match === null || match.list.name !== "Empty").toBe(true);
    });
  });

  // ==========================================================================
  // Edge cases: generateValue with unusual steps
  // ==========================================================================

  describe("generateValue edge cases", () => {
    it("step=0 in match returns same item repeatedly", () => {
      // Manually construct a match with step=0
      const lists = FillListRegistry.getBuiltInLists();
      const weekdays = lists.find((l) => l.id === "builtin.weekday.short")!;
      const fakeMatch = { list: weekdays, startIndex: 3, step: 0 };
      expect(FillListRegistry.generateValue(fakeMatch, 3, 1)).toBe("Wed");
      expect(FillListRegistry.generateValue(fakeMatch, 3, 5)).toBe("Wed");
    });

    it("negative step wraps backwards correctly", () => {
      const lists = FillListRegistry.getBuiltInLists();
      const months = lists.find((l) => l.id === "builtin.month.short")!;
      // step=-1: going backwards
      const fakeMatch = { list: months, startIndex: 2, step: -1 };
      // lastIndex=2 (Mar), offset 1 => (2 + (-1)*1) % 12 = 1 => Feb
      expect(FillListRegistry.generateValue(fakeMatch, 2, 1)).toBe("Feb");
      // offset 3 => (2 + (-1)*3) % 12 = -1 => 11 => Dec
      expect(FillListRegistry.generateValue(fakeMatch, 2, 3)).toBe("Dec");
    });

    it("large offset wraps many times", () => {
      const match = FillListRegistry.matchValues(["Mon"])!;
      // offset 700 with step 1, list len 7 => 700 % 7 = 0 => (1+700)%7 = 1 => Mon
      expect(FillListRegistry.generateValue(match, 1, 700)).toBe("Mon");
      expect(FillListRegistry.generateValue(match, 1, 701)).toBe("Tue");
    });
  });

  // ==========================================================================
  // Edge cases: inconsistent steps
  // ==========================================================================

  describe("inconsistent steps return null", () => {
    it("rejects non-uniform steps (Mon, Wed, Thu)", () => {
      const match = FillListRegistry.matchValues(["Mon", "Wed", "Thu"]);
      expect(match).toBeNull();
    });

    it("rejects values from different lists mixed together", () => {
      // "Mon" is weekday, "Jan" is month - neither list contains both
      const match = FillListRegistry.matchValues(["Mon", "Jan"]);
      expect(match).toBeNull();
    });
  });

  // ==========================================================================
  // Persistence
  // ==========================================================================

  describe("persistence", () => {
    it("persists user lists to localStorage", () => {
      FillListRegistry.addList("Stored", ["A", "B", "C"]);
      const raw = localStorage.getItem("calcula.customFillLists");
      expect(raw).toBeTruthy();
      const parsed = JSON.parse(raw!);
      expect(parsed).toHaveLength(1);
      expect(parsed[0].name).toBe("Stored");
    });

    it("loads user lists from localStorage on fresh instance", () => {
      FillListRegistry.addList("Persisted", ["X", "Y"]);
      // Reset loaded state to simulate fresh load
      FillListRegistry._reset();
      // Manually set localStorage as if it existed
      localStorage.setItem(
        "calcula.customFillLists",
        JSON.stringify([{ id: "user.test", name: "Persisted", items: ["X", "Y"], builtIn: false }]),
      );
      const lists = FillListRegistry.getUserLists();
      expect(lists).toHaveLength(1);
      expect(lists[0].name).toBe("Persisted");
    });
  });

  // ==========================================================================
  // Subscribers
  // ==========================================================================

  describe("subscribers", () => {
    it("notifies subscribers on add", () => {
      let called = 0;
      FillListRegistry.subscribe(() => { called++; });
      FillListRegistry.addList("Sub", ["A", "B"]);
      expect(called).toBe(1);
    });

    it("notifies subscribers on update", () => {
      const list = FillListRegistry.addList("Sub", ["A", "B"]);
      let called = 0;
      FillListRegistry.subscribe(() => { called++; });
      FillListRegistry.updateList(list.id, "Updated", ["C", "D"]);
      expect(called).toBe(1);
    });

    it("notifies subscribers on remove", () => {
      const list = FillListRegistry.addList("Sub", ["A", "B"]);
      let called = 0;
      FillListRegistry.subscribe(() => { called++; });
      FillListRegistry.removeList(list.id);
      expect(called).toBe(1);
    });

    it("unsubscribe stops notifications", () => {
      let called = 0;
      const unsub = FillListRegistry.subscribe(() => { called++; });
      unsub();
      FillListRegistry.addList("Sub", ["A", "B"]);
      expect(called).toBe(0);
    });
  });
});
