import { describe, it, expect, beforeEach } from "vitest";
import {
  setColumnHeaderOverrideProvider,
  getColumnHeaderOverride,
  registerColumnHeaderClickInterceptor,
  checkColumnHeaderClickInterceptor,
} from "../columnHeaderOverrides";

describe("columnHeaderOverrides", () => {
  // Clean up between tests
  beforeEach(() => {
    setColumnHeaderOverrideProvider(null);
  });

  describe("setColumnHeaderOverrideProvider / getColumnHeaderOverride", () => {
    it("returns null when no provider is set", () => {
      expect(getColumnHeaderOverride(0, 0)).toBeNull();
    });

    it("returns override from provider", () => {
      setColumnHeaderOverrideProvider((col) => {
        if (col === 2) return { text: "Name" };
        return null;
      });
      expect(getColumnHeaderOverride(2, 0)).toEqual({ text: "Name" });
      expect(getColumnHeaderOverride(0, 0)).toBeNull();
    });

    it("passes viewportStartRow to provider", () => {
      let receivedRow = -1;
      setColumnHeaderOverrideProvider((_col, viewportStartRow) => {
        receivedRow = viewportStartRow;
        return null;
      });
      getColumnHeaderOverride(0, 42);
      expect(receivedRow).toBe(42);
    });

    it("cleanup function clears the provider", () => {
      const cleanup = setColumnHeaderOverrideProvider(() => ({ text: "X" }));
      expect(getColumnHeaderOverride(0, 0)).toEqual({ text: "X" });
      cleanup();
      expect(getColumnHeaderOverride(0, 0)).toBeNull();
    });

    it("cleanup does not clear if a different provider was set", () => {
      const cleanup1 = setColumnHeaderOverrideProvider(() => ({ text: "First" }));
      setColumnHeaderOverrideProvider(() => ({ text: "Second" }));
      cleanup1(); // should not clear "Second"
      expect(getColumnHeaderOverride(0, 0)).toEqual({ text: "Second" });
    });

    it("last provider wins", () => {
      setColumnHeaderOverrideProvider(() => ({ text: "First" }));
      setColumnHeaderOverrideProvider(() => ({ text: "Second" }));
      expect(getColumnHeaderOverride(0, 0)).toEqual({ text: "Second" });
    });

    it("supports filter button properties", () => {
      setColumnHeaderOverrideProvider(() => ({
        text: "Status",
        showFilterButton: true,
        hasActiveFilter: true,
      }));
      const result = getColumnHeaderOverride(0, 0);
      expect(result?.showFilterButton).toBe(true);
      expect(result?.hasActiveFilter).toBe(true);
    });
  });

  describe("registerColumnHeaderClickInterceptor / checkColumnHeaderClickInterceptor", () => {
    beforeEach(() => {
      // Clear interceptor by registering null-equivalent
      const cleanup = registerColumnHeaderClickInterceptor(() => null);
      cleanup();
    });

    it("returns null when no interceptor is registered", () => {
      expect(checkColumnHeaderClickInterceptor(0, 50, 10, 0, 100, 24)).toBeNull();
    });

    it("delegates to interceptor", () => {
      registerColumnHeaderClickInterceptor((col) => {
        if (col === 3) return { handled: true };
        return null;
      });
      expect(checkColumnHeaderClickInterceptor(3, 50, 10, 0, 100, 24)).toEqual({ handled: true });
      expect(checkColumnHeaderClickInterceptor(0, 50, 10, 0, 100, 24)).toBeNull();
    });

    it("cleanup unregisters interceptor", () => {
      const cleanup = registerColumnHeaderClickInterceptor(() => ({ handled: true }));
      expect(checkColumnHeaderClickInterceptor(0, 0, 0, 0, 100, 24)).toEqual({ handled: true });
      cleanup();
      expect(checkColumnHeaderClickInterceptor(0, 0, 0, 0, 100, 24)).toBeNull();
    });

    it("passes all parameters to interceptor", () => {
      let received: number[] = [];
      registerColumnHeaderClickInterceptor((col, cx, cy, colX, colW, headerH) => {
        received = [col, cx, cy, colX, colW, headerH];
        return null;
      });
      checkColumnHeaderClickInterceptor(5, 150, 12, 100, 80, 24);
      expect(received).toEqual([5, 150, 12, 100, 80, 24]);
    });

    it("returns selectionOverride when provided", () => {
      registerColumnHeaderClickInterceptor(() => ({
        handled: false,
        selectionOverride: { startRow: 5, endRow: 20 },
      }));
      const result = checkColumnHeaderClickInterceptor(0, 0, 0, 0, 100, 24);
      expect(result?.selectionOverride).toEqual({ startRow: 5, endRow: 20 });
    });

    it("catches interceptor errors and returns null", () => {
      registerColumnHeaderClickInterceptor(() => {
        throw new Error("boom");
      });
      expect(checkColumnHeaderClickInterceptor(0, 0, 0, 0, 100, 24)).toBeNull();
    });
  });
});
