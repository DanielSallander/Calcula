import { describe, it, expect, beforeEach } from "vitest";
import { FillListRegistry } from "./fillLists";

/**
 * Sequence generation tests simulating Excel auto-fill behavior.
 * Covers month/day sequences, wrap-around, multi-step, reverse,
 * custom lists, case handling, and edge cases.
 */
describe("FillLists - Sequence Generation (Excel Auto-Fill)", () => {
  beforeEach(() => {
    FillListRegistry._reset();
  });

  // Helper: match values, then generate N values starting after the last source value
  function generateSequence(seed: string[], count: number): string[] {
    const match = FillListRegistry.matchValues(seed);
    if (!match) return [];
    // Find index of the last seed value in the list
    const lowerItems = match.list.items.map((s) => s.toLowerCase());
    const lastLower = seed[seed.length - 1].trim().toLowerCase();
    const lastIndex = lowerItems.indexOf(lastLower);
    const result: string[] = [];
    for (let i = 1; i <= count; i++) {
      result.push(FillListRegistry.generateValue(match, lastIndex, i));
    }
    return result;
  }

  // ==========================================================================
  // Month sequences
  // ==========================================================================

  describe("month sequences (short)", () => {
    it("Jan -> Feb -> Mar", () => {
      expect(generateSequence(["Jan"], 3)).toEqual(["Feb", "Mar", "Apr"]);
    });

    it("Jan, Feb -> Mar, Apr, May", () => {
      expect(generateSequence(["Jan", "Feb"], 3)).toEqual(["Mar", "Apr", "May"]);
    });

    it("Oct, Nov, Dec -> Jan, Feb, Mar (wrap-around)", () => {
      expect(generateSequence(["Oct", "Nov", "Dec"], 3)).toEqual(["Jan", "Feb", "Mar"]);
    });
  });

  describe("month sequences (full)", () => {
    it("January -> February -> March", () => {
      expect(generateSequence(["January"], 2)).toEqual(["February", "March"]);
    });

    it("November, December -> January, February (wrap-around)", () => {
      expect(generateSequence(["November", "December"], 2)).toEqual(["January", "February"]);
    });
  });

  // ==========================================================================
  // Day sequences
  // ==========================================================================

  describe("day sequences (short)", () => {
    it("Mon -> Tue -> Wed", () => {
      expect(generateSequence(["Mon"], 2)).toEqual(["Tue", "Wed"]);
    });

    it("Mon, Tue, Wed -> Thu, Fri, Sat", () => {
      expect(generateSequence(["Mon", "Tue", "Wed"], 3)).toEqual(["Thu", "Fri", "Sat"]);
    });
  });

  describe("day sequences (full)", () => {
    it("Monday -> Tuesday -> Wednesday", () => {
      expect(generateSequence(["Monday"], 2)).toEqual(["Tuesday", "Wednesday"]);
    });

    it("Thursday, Friday -> Saturday, Sunday, Monday", () => {
      expect(generateSequence(["Thursday", "Friday"], 3)).toEqual([
        "Saturday",
        "Sunday",
        "Monday",
      ]);
    });
  });

  // ==========================================================================
  // Wrap-around
  // ==========================================================================

  describe("wrap-around sequences", () => {
    it("Nov, Dec -> Jan, Feb (month wrap)", () => {
      expect(generateSequence(["Nov", "Dec"], 2)).toEqual(["Jan", "Feb"]);
    });

    it("Sat, Sun -> Mon (weekday wrap)", () => {
      expect(generateSequence(["Sat", "Sun"], 1)).toEqual(["Mon"]);
    });

    it("Fri, Sat, Sun -> Mon, Tue (weekday wrap with 3 seeds)", () => {
      expect(generateSequence(["Fri", "Sat", "Sun"], 2)).toEqual(["Mon", "Tue"]);
    });

    it("December -> January (full month wrap)", () => {
      expect(generateSequence(["December"], 1)).toEqual(["January"]);
    });

    it("Saturday -> Sunday -> Monday (full weekday wrap)", () => {
      expect(generateSequence(["Saturday"], 2)).toEqual(["Sunday", "Monday"]);
    });
  });

  // ==========================================================================
  // Multi-step sequences
  // ==========================================================================

  describe("multi-step sequences", () => {
    it("Jan, Mar, May (step=2) -> Jul, Sep, Nov", () => {
      expect(generateSequence(["Jan", "Mar", "May"], 3)).toEqual(["Jul", "Sep", "Nov"]);
    });

    it("Jan, Mar (step=2) -> May, Jul", () => {
      expect(generateSequence(["Jan", "Mar"], 2)).toEqual(["May", "Jul"]);
    });

    it("Jan, Apr, Jul (step=3) -> Oct, Jan", () => {
      expect(generateSequence(["Jan", "Apr", "Jul"], 2)).toEqual(["Oct", "Jan"]);
    });

    it("Mon, Wed, Fri (step=2) -> Sun, Tue", () => {
      expect(generateSequence(["Mon", "Wed", "Fri"], 2)).toEqual(["Sun", "Tue"]);
    });

    it("Sun, Wed, Sat (step=3) -> Tue, Fri", () => {
      expect(generateSequence(["Sun", "Wed", "Sat"], 2)).toEqual(["Tue", "Fri"]);
    });

    it("multi-step month wraps: Sep, Nov (step=2) -> Jan, Mar", () => {
      expect(generateSequence(["Sep", "Nov"], 2)).toEqual(["Jan", "Mar"]);
    });
  });

  // ==========================================================================
  // Reverse sequences (negative step via wrap-around logic)
  // ==========================================================================

  describe("reverse sequences", () => {
    it("Dec, Nov (detects step=11 due to forward-only wrap logic)", () => {
      // The implementation computes forward step: Nov(10) - Dec(11) = -1, +12 = 11
      // So it wraps forward by 11 (equivalent to backwards by 1)
      const match = FillListRegistry.matchValues(["Dec", "Nov"]);
      expect(match).not.toBeNull();
      expect(match!.step).toBe(11);
      // Generating: from Nov(10), +11 = 21 % 12 = 9 = Oct
      expect(generateSequence(["Dec", "Nov"], 1)).toEqual(["Oct"]);
    });

    it("Dec, Nov, Oct -> Sep, Aug (reverse months)", () => {
      expect(generateSequence(["Dec", "Nov", "Oct"], 2)).toEqual(["Sep", "Aug"]);
    });

    it("Wed, Tue, Mon -> Sun, Sat (reverse weekdays)", () => {
      expect(generateSequence(["Wed", "Tue", "Mon"], 2)).toEqual(["Sun", "Sat"]);
    });

    it("Mar, Jan (reverse step=2 => forward step=10) -> Nov", () => {
      const match = FillListRegistry.matchValues(["Mar", "Jan"]);
      expect(match).not.toBeNull();
      expect(match!.step).toBe(10); // -2 + 12 = 10
      expect(generateSequence(["Mar", "Jan"], 1)).toEqual(["Nov"]);
    });
  });

  // ==========================================================================
  // Custom list: Q1-Q4
  // ==========================================================================

  describe("custom list: quarters", () => {
    beforeEach(() => {
      FillListRegistry.addList("Quarters", ["Q1", "Q2", "Q3", "Q4"]);
    });

    it("Q1 -> Q2 -> Q3", () => {
      expect(generateSequence(["Q1"], 2)).toEqual(["Q2", "Q3"]);
    });

    it("Q1, Q2, Q3 -> Q4, Q1 (wrap)", () => {
      expect(generateSequence(["Q1", "Q2", "Q3"], 2)).toEqual(["Q4", "Q1"]);
    });

    it("Q3, Q4 -> Q1 (wrap)", () => {
      expect(generateSequence(["Q3", "Q4"], 1)).toEqual(["Q1"]);
    });

    it("Q1, Q3 (step=2) -> Q1, Q3 (repeating pattern)", () => {
      expect(generateSequence(["Q1", "Q3"], 2)).toEqual(["Q1", "Q3"]);
    });
  });

  // ==========================================================================
  // Custom list: colors
  // ==========================================================================

  describe("custom list: colors", () => {
    beforeEach(() => {
      FillListRegistry.addList("Rainbow", [
        "Red",
        "Orange",
        "Yellow",
        "Green",
        "Blue",
        "Indigo",
        "Violet",
      ]);
    });

    it("Red, Orange, Yellow, Green -> Blue", () => {
      expect(generateSequence(["Red", "Orange", "Yellow", "Green"], 1)).toEqual(["Blue"]);
    });

    it("Green, Blue -> Indigo, Violet, Red (wrap)", () => {
      expect(generateSequence(["Green", "Blue"], 3)).toEqual(["Indigo", "Violet", "Red"]);
    });

    it("Violet -> Red (wrap back to start)", () => {
      expect(generateSequence(["Violet"], 1)).toEqual(["Red"]);
    });

    it("Red, Yellow (step=2) -> Blue, Violet, Orange", () => {
      expect(generateSequence(["Red", "Yellow"], 3)).toEqual(["Blue", "Violet", "Orange"]);
    });
  });

  // ==========================================================================
  // Swedish months (registered as custom list)
  // ==========================================================================

  describe("Swedish months (custom list)", () => {
    beforeEach(() => {
      FillListRegistry.addList("Swedish Months Short", [
        "Jan",
        "Feb",
        "Mar",
        "Apr",
        "Maj",
        "Jun",
        "Jul",
        "Aug",
        "Sep",
        "Okt",
        "Nov",
        "Dec",
      ]);
      FillListRegistry.addList("Swedish Months Full", [
        "Januari",
        "Februari",
        "Mars",
        "April",
        "Maj",
        "Juni",
        "Juli",
        "Augusti",
        "September",
        "Oktober",
        "November",
        "December",
      ]);
    });

    it("Januari -> Februari -> Mars", () => {
      expect(generateSequence(["Januari"], 2)).toEqual(["Februari", "Mars"]);
    });

    it("Okt, Nov, Dec -> Jan (Swedish short wrap)", () => {
      // User list takes priority, so matches Swedish short list
      expect(generateSequence(["Okt", "Nov", "Dec"], 1)).toEqual(["Jan"]);
    });

    it("Maj -> Juni (Swedish-specific month name)", () => {
      // "Maj" only exists in the Swedish list, not built-in English
      expect(generateSequence(["Maj"], 1)).toEqual(["Jun"]);
    });

    it("Oktober, November, December -> Januari (full Swedish wrap)", () => {
      expect(generateSequence(["Oktober", "November", "December"], 1)).toEqual(["Januari"]);
    });
  });

  // ==========================================================================
  // Mixed case consistency
  // ==========================================================================

  describe("mixed case", () => {
    it("matching is case-insensitive (jan matches Jan list)", () => {
      const match = FillListRegistry.matchValues(["jan"]);
      expect(match).not.toBeNull();
      expect(match!.list.id).toBe("builtin.month.short");
    });

    it("generated values use canonical case from list definition", () => {
      // Even though input is lowercase, output uses list's canonical case
      expect(generateSequence(["jan"], 2)).toEqual(["Feb", "Mar"]);
    });

    it("JAN, FEB -> generates canonical case Mar, Apr", () => {
      expect(generateSequence(["JAN", "FEB"], 2)).toEqual(["Mar", "Apr"]);
    });

    it("monday, tuesday -> generates canonical Wednesday, Thursday", () => {
      expect(generateSequence(["monday", "tuesday"], 2)).toEqual(["Wednesday", "Thursday"]);
    });
  });

  // ==========================================================================
  // Ambiguous matching
  // ==========================================================================

  describe("ambiguous matching", () => {
    it("Mon matches weekday short list (first match wins)", () => {
      const match = FillListRegistry.matchValues(["Mon"]);
      expect(match).not.toBeNull();
      expect(match!.list.id).toBe("builtin.weekday.short");
    });

    it("user list with overlapping items takes priority over built-in", () => {
      FillListRegistry.addList("Workdays", ["Mon", "Tue", "Wed", "Thu", "Fri"]);
      const match = FillListRegistry.matchValues(["Mon", "Tue"]);
      expect(match).not.toBeNull();
      expect(match!.list.builtIn).toBe(false);
      expect(match!.list.name).toBe("Workdays");
    });

    it("Jan matches user Swedish list before built-in when Swedish registered", () => {
      FillListRegistry.addList("Swedish Short", [
        "Jan", "Feb", "Mar", "Apr", "Maj", "Jun",
        "Jul", "Aug", "Sep", "Okt", "Nov", "Dec",
      ]);
      const match = FillListRegistry.matchValues(["Jan"]);
      expect(match).not.toBeNull();
      // User lists are checked first
      expect(match!.list.builtIn).toBe(false);
    });
  });

  // ==========================================================================
  // No match cases
  // ==========================================================================

  describe("no match returns null", () => {
    it("random text returns null", () => {
      expect(FillListRegistry.matchValues(["banana"])).toBeNull();
    });

    it("numeric string returns null", () => {
      expect(FillListRegistry.matchValues(["123"])).toBeNull();
    });

    it("partial month name returns null", () => {
      expect(FillListRegistry.matchValues(["Janu"])).toBeNull();
    });

    it("mixed list/non-list values return null", () => {
      expect(FillListRegistry.matchValues(["Mon", "Banana"])).toBeNull();
    });

    it("values from different lists return null", () => {
      expect(FillListRegistry.matchValues(["Jan", "Monday"])).toBeNull();
    });
  });

  // ==========================================================================
  // Step detection with 3+ values
  // ==========================================================================

  describe("step detection with 3+ seed values", () => {
    it("Mon, Wed, Fri (step=2) -> Sun", () => {
      const match = FillListRegistry.matchValues(["Mon", "Wed", "Fri"]);
      expect(match).not.toBeNull();
      expect(match!.step).toBe(2);
      expect(generateSequence(["Mon", "Wed", "Fri"], 1)).toEqual(["Sun"]);
    });

    it("Jan, Apr, Jul, Oct (step=3) -> Jan", () => {
      expect(generateSequence(["Jan", "Apr", "Jul", "Oct"], 1)).toEqual(["Jan"]);
    });

    it("inconsistent step returns null: Mon, Wed, Thu", () => {
      expect(FillListRegistry.matchValues(["Mon", "Wed", "Thu"])).toBeNull();
    });

    it("inconsistent step returns null: Jan, Mar, Jun", () => {
      expect(FillListRegistry.matchValues(["Jan", "Mar", "Jun"])).toBeNull();
    });
  });

  // ==========================================================================
  // Step=0 edge case (repeated same value)
  // ==========================================================================

  describe("step=0 edge case", () => {
    it("manually constructed step=0 repeats the same value", () => {
      const lists = FillListRegistry.getBuiltInLists();
      const months = lists.find((l) => l.id === "builtin.month.short")!;
      const fakeMatch = { list: months, startIndex: 5, step: 0 };
      // Jun(5) + 0*offset always = Jun
      expect(FillListRegistry.generateValue(fakeMatch, 5, 1)).toBe("Jun");
      expect(FillListRegistry.generateValue(fakeMatch, 5, 10)).toBe("Jun");
      expect(FillListRegistry.generateValue(fakeMatch, 5, 100)).toBe("Jun");
    });
  });

  // ==========================================================================
  // Large offset: generate 100th value
  // ==========================================================================

  describe("large offset generation", () => {
    it("100th value after Jan in monthly sequence", () => {
      // Jan = index 0, step=1, offset=100 => (0 + 100) % 12 = 4 => May
      const match = FillListRegistry.matchValues(["Jan"])!;
      expect(FillListRegistry.generateValue(match, 0, 100)).toBe("May");
    });

    it("100th value after Mon in weekday sequence", () => {
      // Mon = index 1, step=1, offset=100 => (1 + 100) % 7 = 3 => Wed
      const match = FillListRegistry.matchValues(["Mon"])!;
      expect(FillListRegistry.generateValue(match, 1, 100)).toBe("Wed");
    });

    it("100th value with step=2 months: Jan, Mar -> 100th", () => {
      // Mar = index 2, step=2, offset=100 => (2 + 200) % 12 = 202 % 12 = 10 => Nov
      const match = FillListRegistry.matchValues(["Jan", "Mar"])!;
      expect(FillListRegistry.generateValue(match, 2, 100)).toBe("Nov");
    });

    it("1000th value in custom 4-item list", () => {
      FillListRegistry.addList("ABCD", ["A", "B", "C", "D"]);
      const match = FillListRegistry.matchValues(["A"])!;
      // index 0, step=1, offset=1000 => 1000 % 4 = 0 => A
      expect(FillListRegistry.generateValue(match, 0, 1000)).toBe("A");
      expect(FillListRegistry.generateValue(match, 0, 1001)).toBe("B");
    });
  });

  // ==========================================================================
  // Full sequence simulation (Excel drag-fill style)
  // ==========================================================================

  describe("full Excel-style drag sequences", () => {
    it("drag from Jan down 12 cells produces full year then wraps", () => {
      const result = generateSequence(["Jan"], 12);
      expect(result).toEqual([
        "Feb", "Mar", "Apr", "May", "Jun", "Jul",
        "Aug", "Sep", "Oct", "Nov", "Dec", "Jan",
      ]);
    });

    it("drag from Monday down 7 cells produces full week then wraps", () => {
      const result = generateSequence(["Monday"], 7);
      expect(result).toEqual([
        "Tuesday", "Wednesday", "Thursday", "Friday",
        "Saturday", "Sunday", "Monday",
      ]);
    });

    it("drag from Wed,Fri (step=2) down 5 cells", () => {
      const result = generateSequence(["Wed", "Fri"], 5);
      // Fri=5, step=2: Sun(0), Tue(2), Thu(4), Sat(6), Mon(1)
      expect(result).toEqual(["Sun", "Tue", "Thu", "Sat", "Mon"]);
    });

    it("drag custom colors list from start through full wrap", () => {
      FillListRegistry.addList("Traffic", ["Red", "Yellow", "Green"]);
      const result = generateSequence(["Red"], 6);
      expect(result).toEqual(["Yellow", "Green", "Red", "Yellow", "Green", "Red"]);
    });
  });
});
