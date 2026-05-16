import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  registerStyleInterceptor,
  unregisterStyleInterceptor,
  getStyleInterceptors,
  hasStyleInterceptors,
  applyStyleInterceptors,
  markRangeDirty,
  markSheetDirty,
  clearDirtyState,
  isCellDirty,
  hasDirtyState,
  type BaseStyleInfo,
  type CellCoords,
  type IStyleOverride,
} from "../styleInterceptors";

// ============================================================================
// Helpers
// ============================================================================

const BASE_STYLE: BaseStyleInfo = {
  styleIndex: 0,
  backgroundColor: "#ffffff",
  textColor: "#000000",
  bold: false,
  italic: false,
  underline: false,
  strikethrough: false,
  fontSize: 11,
  fontFamily: "Calibri",
};

let cleanups: (() => void)[] = [];

beforeEach(() => {
  cleanups.forEach((fn) => fn());
  cleanups = [];
  clearDirtyState();
  // Unregister any lingering interceptors
  getStyleInterceptors().forEach((reg) => unregisterStyleInterceptor(reg.id));
});

// ============================================================================
// 1. Style Pipeline - 40 interceptor combos
// ============================================================================

describe("Style pipeline (parameterized)", () => {
  const singleOverrideCases = Array.from({ length: 20 }, (_, i) => {
    const props: (keyof IStyleOverride)[] = [
      "backgroundColor",
      "textColor",
      "bold",
      "italic",
      "underline",
      "strikethrough",
      "fontSize",
      "fontFamily",
      "borderTopColor",
      "borderBottomColor",
    ];
    const prop = props[i % props.length];
    const value =
      typeof BASE_STYLE[prop as keyof BaseStyleInfo] === "boolean"
        ? true
        : typeof BASE_STYLE[prop as keyof BaseStyleInfo] === "number"
          ? 14 + i
          : `#${(i * 123456).toString(16).slice(0, 6).padStart(6, "0")}`;

    return {
      label: `single-${prop}-${i}`,
      id: `interceptor-single-${i}`,
      prop,
      value,
      row: i,
      col: i + 1,
    };
  });

  // Each interceptor in the chain sets a DIFFERENT property, so no overwrites
  const chainedCases = Array.from({ length: 20 }, (_, i) => {
    const propSets: [keyof IStyleOverride, unknown][][] = [
      [["bold", true]],
      [["italic", true]],
      [["backgroundColor", `#ff${(i * 11).toString(16).padStart(4, "0")}`]],
      [["textColor", "#ff0000"]],
      [["underline", true]],
      [["strikethrough", true]],
    ];
    const count = (i % 4) + 2;
    return {
      label: `chained-${i}`,
      interceptors: Array.from({ length: count }, (_, j) => ({
        id: `chain-${i}-${j}`,
        priority: j * 10,
        override: Object.fromEntries(propSets[j % propSets.length]) as IStyleOverride,
      })),
      row: i + 100,
      col: i + 50,
    };
  });

  describe("single override", () => {
    it.each(singleOverrideCases)(
      "$label: applies $prop override",
      ({ id, prop, value, row, col }) => {
        const override: IStyleOverride = { [prop]: value };
        const cleanup = registerStyleInterceptor(id, () => override, 0);
        cleanups.push(cleanup);

        const result = applyStyleInterceptors("test", { ...BASE_STYLE }, { row, col });
        expect((result as Record<string, unknown>)[prop]).toBe(value);
      }
    );
  });

  describe("chained interceptors", () => {
    it.each(chainedCases)(
      "$label: chains ${interceptors.length} interceptors",
      ({ interceptors, row, col }) => {
        for (const int of interceptors) {
          const cleanup = registerStyleInterceptor(
            int.id,
            () => int.override,
            int.priority
          );
          cleanups.push(cleanup);
        }

        const result = applyStyleInterceptors("test", { ...BASE_STYLE }, { row, col });

        // Verify each override was applied
        for (const int of interceptors) {
          for (const [key, val] of Object.entries(int.override)) {
            if (val !== undefined) {
              expect((result as Record<string, unknown>)[key]).toBe(val);
            }
          }
        }
      }
    );
  });
});

// ============================================================================
// 2. Priority Ordering - 30 priority combos
// ============================================================================

describe("Priority ordering (parameterized)", () => {
  const overwriteCases = Array.from({ length: 15 }, (_, i) => ({
    label: `priority-overwrite-${i}`,
    firstPriority: i * 10,
    secondPriority: i * 10 + 5,
    firstBg: `#aa${i.toString(16).padStart(4, "0")}`,
    secondBg: `#bb${i.toString(16).padStart(4, "0")}`,
  }));

  const reverseCases = Array.from({ length: 15 }, (_, i) => ({
    label: `priority-reverse-${i}`,
    firstPriority: 100 - i * 5,
    secondPriority: 50 - i * 3,
    firstBg: `#cc${i.toString(16).padStart(4, "0")}`,
    secondBg: `#dd${i.toString(16).padStart(4, "0")}`,
  }));

  describe("later priority overwrites earlier", () => {
    it.each(overwriteCases)(
      "$label: priority $firstPriority then $secondPriority",
      ({ label, firstPriority, secondPriority, firstBg, secondBg }) => {
        const c1 = registerStyleInterceptor(
          `${label}-first`,
          () => ({ backgroundColor: firstBg }),
          firstPriority
        );
        cleanups.push(c1);
        const c2 = registerStyleInterceptor(
          `${label}-second`,
          () => ({ backgroundColor: secondBg }),
          secondPriority
        );
        cleanups.push(c2);

        const result = applyStyleInterceptors("x", { ...BASE_STYLE }, { row: 0, col: 0 });
        // Higher priority runs later, so its value wins
        const sorted = [
          { bg: firstBg, p: firstPriority },
          { bg: secondBg, p: secondPriority },
        ].sort((a, b) => a.p - b.p);
        expect(result.backgroundColor).toBe(sorted[sorted.length - 1].bg);
      }
    );
  });

  describe("sorted order matches priority", () => {
    it.each(reverseCases)(
      "$label: priorities $firstPriority and $secondPriority sorted correctly",
      ({ label, firstPriority, secondPriority }) => {
        const c1 = registerStyleInterceptor(`${label}-a`, () => null, firstPriority);
        cleanups.push(c1);
        const c2 = registerStyleInterceptor(`${label}-b`, () => null, secondPriority);
        cleanups.push(c2);

        const interceptors = getStyleInterceptors();
        for (let j = 1; j < interceptors.length; j++) {
          expect(interceptors[j].priority! >= interceptors[j - 1].priority!).toBe(true);
        }
      }
    );
  });
});

// ============================================================================
// 3. Dirty Range Tracking - 20 range combos
// ============================================================================

describe("Dirty range tracking (parameterized)", () => {
  const insideCases = Array.from({ length: 10 }, (_, i) => ({
    label: `inside-${i}`,
    range: {
      startRow: i * 10,
      startCol: i * 5,
      endRow: i * 10 + 20,
      endCol: i * 5 + 10,
      sheetIndex: i % 3 === 0 ? undefined : i % 3,
    },
    testRow: i * 10 + 5,
    testCol: i * 5 + 3,
    testSheet: i % 3 === 0 ? undefined : i % 3,
    expected: true,
  }));

  const outsideCases = Array.from({ length: 10 }, (_, i) => ({
    label: `outside-${i}`,
    range: {
      startRow: i * 10,
      startCol: i * 5,
      endRow: i * 10 + 20,
      endCol: i * 5 + 10,
      sheetIndex: i % 2,
    },
    testRow: i * 10 + 50,
    testCol: i * 5 + 50,
    testSheet: i % 2,
    expected: false,
  }));

  describe("cells inside dirty range", () => {
    it.each(insideCases)(
      "$label: ($testRow,$testCol) is inside range",
      ({ range, testRow, testCol, testSheet }) => {
        clearDirtyState();
        markRangeDirty(range);
        expect(isCellDirty(testRow, testCol, testSheet)).toBe(true);
        expect(hasDirtyState()).toBe(true);
      }
    );
  });

  describe("cells outside dirty range", () => {
    it.each(outsideCases)(
      "$label: ($testRow,$testCol) is outside range",
      ({ range, testRow, testCol, testSheet }) => {
        clearDirtyState();
        markRangeDirty(range);
        expect(isCellDirty(testRow, testCol, testSheet)).toBe(false);
      }
    );
  });

  describe("markSheetDirty makes all cells dirty", () => {
    const cells = Array.from({ length: 10 }, (_, i) => ({
      label: `sheet-dirty-${i}`,
      row: i * 100,
      col: i * 50,
    }));

    it.each(cells)(
      "$label: ($row,$col) is dirty after markSheetDirty",
      ({ row, col }) => {
        clearDirtyState();
        markSheetDirty();
        expect(isCellDirty(row, col)).toBe(true);
      }
    );
  });

  describe("clearDirtyState resets", () => {
    const cells = Array.from({ length: 10 }, (_, i) => ({
      label: `cleared-${i}`,
      row: i,
      col: i,
    }));

    it.each(cells)(
      "$label: ($row,$col) is clean after clearDirtyState",
      ({ row, col }) => {
        markSheetDirty();
        clearDirtyState();
        expect(isCellDirty(row, col)).toBe(false);
        expect(hasDirtyState()).toBe(false);
      }
    );
  });

  describe("hasStyleInterceptors", () => {
    it("returns false when empty", () => {
      expect(hasStyleInterceptors()).toBe(false);
    });

    it("returns true when interceptor registered", () => {
      const c = registerStyleInterceptor("test-has", () => null, 0);
      cleanups.push(c);
      expect(hasStyleInterceptors()).toBe(true);
    });
  });

  describe("error handling in interceptors", () => {
    it("catches interceptor errors without breaking pipeline", () => {
      const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      const c1 = registerStyleInterceptor(
        "err-interceptor",
        () => { throw new Error("boom"); },
        0
      );
      cleanups.push(c1);
      const c2 = registerStyleInterceptor(
        "ok-interceptor",
        () => ({ bold: true }),
        10
      );
      cleanups.push(c2);

      const result = applyStyleInterceptors("x", { ...BASE_STYLE }, { row: 0, col: 0 });
      expect(result.bold).toBe(true);
      expect(errSpy).toHaveBeenCalled();
      errSpy.mockRestore();
    });
  });

  describe("unregister removes interceptor", () => {
    it("interceptor no longer applied after unregister", () => {
      const c = registerStyleInterceptor(
        "temp-interceptor",
        () => ({ backgroundColor: "#ff0000" }),
        0
      );
      c(); // unregister immediately

      const result = applyStyleInterceptors("x", { ...BASE_STYLE }, { row: 0, col: 0 });
      expect(result.backgroundColor).toBe("#ffffff");
    });
  });
});
