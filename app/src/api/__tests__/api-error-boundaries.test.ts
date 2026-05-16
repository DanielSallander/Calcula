import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { emitAppEvent, onAppEvent } from "../events";
import { CommandRegistry } from "../commands";
import { getSetting, setSetting, removeSetting } from "../settings";
import { CellRange } from "../range";
import { columnToLetter } from "../types";
import {
  registerStyleInterceptor,
  applyStyleInterceptors,
  type BaseStyleInfo,
} from "../styleInterceptors";
import { registerMenu, registerMenuItem, getMenus } from "../ui";

// ============================================================================
// API Error Boundary Tests
// Verify the API layer handles invalid inputs gracefully.
// ============================================================================

describe("API Error Boundaries", () => {
  // --------------------------------------------------------------------------
  // Event emit with undefined/null event name
  // --------------------------------------------------------------------------
  describe("events - invalid inputs", () => {
    it("emitAppEvent with empty string does not throw", () => {
      expect(() => emitAppEvent("" as any)).not.toThrow();
    });

    it("emitAppEvent with undefined payload does not throw", () => {
      expect(() => emitAppEvent("app:grid-refresh", undefined)).not.toThrow();
    });

    it("onAppEvent with empty string returns a valid unsubscribe function", () => {
      const cb = vi.fn();
      const unsub = onAppEvent("" as any, cb);
      expect(typeof unsub).toBe("function");
      unsub();
    });

    it("emitAppEvent with null payload delivers null to subscribers", () => {
      const cb = vi.fn();
      const unsub = onAppEvent("app:test-null" as any, cb);
      emitAppEvent("app:test-null" as any, null);
      expect(cb).toHaveBeenCalledWith(null);
      unsub();
    });
  });

  // --------------------------------------------------------------------------
  // Command execute with empty string
  // --------------------------------------------------------------------------
  describe("commands - invalid inputs", () => {
    it("execute with empty string logs warning but does not throw", async () => {
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      await expect(CommandRegistry.execute("")).resolves.toBeUndefined();
      expect(warnSpy).toHaveBeenCalled();
      warnSpy.mockRestore();
    });

    it("execute with non-existent command ID logs warning", async () => {
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      await expect(CommandRegistry.execute("nonexistent.command.xyz")).resolves.toBeUndefined();
      expect(warnSpy).toHaveBeenCalled();
      warnSpy.mockRestore();
    });

    it("has returns false for empty string", () => {
      expect(CommandRegistry.has("")).toBe(false);
    });

    it("unregister with non-existent ID does not throw", () => {
      expect(() => CommandRegistry.unregister("does.not.exist")).not.toThrow();
    });
  });

  // --------------------------------------------------------------------------
  // Settings get with special characters in key
  // --------------------------------------------------------------------------
  describe("settings - special characters", () => {
    const extId = "test-error-boundary";

    afterEach(() => {
      // Clean up any settings we may have written
      try {
        removeSetting(extId, "key.with.dots");
        removeSetting(extId, "key/with/slashes");
        removeSetting(extId, "key with spaces");
        removeSetting(extId, "key\twith\ttabs");
        removeSetting(extId, "");
      } catch {
        // ignore
      }
    });

    it("get with dotted key returns default", () => {
      const val = getSetting(extId, "key.with.dots", "default");
      expect(val).toBe("default");
    });

    it("set and get with slashes in key works", () => {
      setSetting(extId, "key/with/slashes", "value1");
      expect(getSetting(extId, "key/with/slashes", "")).toBe("value1");
    });

    it("set and get with spaces in key works", () => {
      setSetting(extId, "key with spaces", 42);
      expect(getSetting(extId, "key with spaces", 0)).toBe(42);
    });

    it("get with empty key returns default", () => {
      const val = getSetting(extId, "", "fallback");
      expect(val).toBe("fallback");
    });

    it("boolean parsing handles non-boolean stored values", () => {
      setSetting(extId, "key\twith\ttabs", "notABool");
      // When default is boolean, stored "notABool" !== "true" => false
      expect(getSetting(extId, "key\twith\ttabs", true)).toBe(false);
    });

    it("number parsing handles non-numeric stored values", () => {
      setSetting(extId, "key.with.dots", "notANumber");
      // When default is number, NaN falls back to default
      expect(getSetting(extId, "key.with.dots", 99)).toBe(99);
    });
  });

  // --------------------------------------------------------------------------
  // CellRange.fromAddress with every invalid format
  // --------------------------------------------------------------------------
  describe("CellRange.fromAddress - invalid formats", () => {
    it("throws on empty string", () => {
      expect(() => CellRange.fromAddress("")).toThrow();
    });

    it("throws on numeric-only input", () => {
      expect(() => CellRange.fromAddress("123")).toThrow();
    });

    it("throws on letter-only input (no row number)", () => {
      expect(() => CellRange.fromAddress("ABC")).toThrow();
    });

    it("throws on invalid separator", () => {
      expect(() => CellRange.fromAddress("A1;B2")).toThrow();
    });

    it("throws on double colon", () => {
      expect(() => CellRange.fromAddress("A1::B2")).toThrow();
    });

    it("throws on reversed reference with letters only after colon", () => {
      expect(() => CellRange.fromAddress("A1:XYZ")).toThrow();
    });

    it("parses sheet-prefixed references (sheet part is ignored on CellRange)", () => {
      const r = CellRange.fromAddress("Sheet1!A1:B2");
      expect(r.startRow).toBe(0);
      expect(r.startCol).toBe(0);
      expect(r.endRow).toBe(1);
      expect(r.endCol).toBe(1);
    });

    it("handles absolute references with $ signs", () => {
      const r = CellRange.fromAddress("$A$1:$B$2");
      expect(r.startRow).toBe(0);
      expect(r.endRow).toBe(1);
    });
  });

  // --------------------------------------------------------------------------
  // columnToLetter with every problematic input type
  // --------------------------------------------------------------------------
  describe("columnToLetter - edge cases", () => {
    it("column 0 returns A", () => {
      expect(columnToLetter(0)).toBe("A");
    });

    it("column 25 returns Z", () => {
      expect(columnToLetter(25)).toBe("Z");
    });

    it("column 26 returns AA", () => {
      expect(columnToLetter(26)).toBe("AA");
    });

    it("large column number does not throw", () => {
      // Column 16383 = XFD (Excel max)
      expect(() => columnToLetter(16383)).not.toThrow();
      const result = columnToLetter(16383);
      expect(result.length).toBeGreaterThan(0);
    });

    it("negative column produces empty string (degenerates gracefully)", () => {
      // The while loop condition c >= 0 won't enter for negative
      const result = columnToLetter(-1);
      expect(result).toBe("");
    });
  });

  // --------------------------------------------------------------------------
  // Style interceptor with throwing callback
  // --------------------------------------------------------------------------
  describe("style interceptor - throwing callback", () => {
    afterEach(() => {
      // Clean up by unregistering
    });

    it("applyStyleInterceptors catches interceptor errors and continues", () => {
      const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

      const cleanup1 = registerStyleInterceptor("thrower", () => {
        throw new Error("Interceptor explosion");
      }, 0);

      const cleanup2 = registerStyleInterceptor("safe", () => {
        return { backgroundColor: "#00ff00" };
      }, 10);

      const baseStyle: BaseStyleInfo = { styleIndex: 0 };
      const result = applyStyleInterceptors("test", baseStyle, { row: 0, col: 0 });

      // The safe interceptor should still have applied
      expect(result.backgroundColor).toBe("#00ff00");
      // The error should have been logged
      expect(errorSpy).toHaveBeenCalled();

      cleanup1();
      cleanup2();
      errorSpy.mockRestore();
    });

    it("interceptor returning null leaves style unchanged", () => {
      const cleanup = registerStyleInterceptor("noop", () => null, 0);

      const baseStyle: BaseStyleInfo = { styleIndex: 0, backgroundColor: "#ffffff" };
      const result = applyStyleInterceptors("test", baseStyle, { row: 0, col: 0 });

      expect(result.backgroundColor).toBe("#ffffff");
      cleanup();
    });

    it("interceptor returning undefined leaves style unchanged", () => {
      const cleanup = registerStyleInterceptor("undef", () => undefined, 0);

      const baseStyle: BaseStyleInfo = { styleIndex: 0, textColor: "#000000" };
      const result = applyStyleInterceptors("test", baseStyle, { row: 0, col: 0 });

      expect(result.textColor).toBe("#000000");
      cleanup();
    });
  });

  // --------------------------------------------------------------------------
  // Menu registration with missing required fields
  // --------------------------------------------------------------------------
  describe("menu registration - edge cases", () => {
    it("registerMenu with empty items array works", () => {
      expect(() =>
        registerMenu({ id: "test-empty", label: "Test", order: 999, items: [] })
      ).not.toThrow();
    });

    it("registerMenuItem to non-existent menu does not throw", () => {
      // Item is queued for when the menu is eventually registered
      expect(() =>
        registerMenuItem("nonexistent-menu-id", {
          id: "item1",
          label: "Item 1",
          action: () => {},
        })
      ).not.toThrow();
    });

    it("registerMenu with duplicate ID overwrites previous", () => {
      registerMenu({ id: "dup-test", label: "First", order: 1, items: [] });
      registerMenu({ id: "dup-test", label: "Second", order: 1, items: [] });
      const menus = getMenus();
      const found = menus.filter((m) => m.id === "dup-test");
      expect(found.length).toBe(1);
      expect(found[0].label).toBe("Second");
    });

    it("registerMenuItem appends dynamically registered items on re-registration", () => {
      registerMenu({
        id: "dynamic-test",
        label: "Dynamic",
        order: 998,
        items: [{ id: "original", label: "Original", action: () => {} }],
      });
      registerMenuItem("dynamic-test", {
        id: "dynamic-item",
        label: "Dynamic Item",
        action: () => {},
      });

      // Re-register the menu; dynamic items should survive
      registerMenu({
        id: "dynamic-test",
        label: "Dynamic",
        order: 998,
        items: [{ id: "original", label: "Original", action: () => {} }],
      });

      const menus = getMenus();
      const menu = menus.find((m) => m.id === "dynamic-test");
      expect(menu).toBeDefined();
      const dynamicItem = menu!.items.find((i) => i.id === "dynamic-item");
      expect(dynamicItem).toBeDefined();
    });
  });
});
