import { describe, it, expect, beforeEach } from "vitest";
import {
  setColumnHeaderOverrideProvider as registerProvider,
  getColumnHeaderOverride,
  registerColumnHeaderClickInterceptor as registerInterceptor,
  checkColumnHeaderClickInterceptor,
} from "../columnHeaderOverrides";

describe("columnHeaderOverrides", () => {
  // These registries are MULTI-provider and module-level: registering appends,
  // and the only way to remove a registration is the cleanup function it
  // returns. `setColumnHeaderOverrideProvider(null)` is documented as a no-op
  // that returns a no-op cleanup — it does NOT clear the registry — so the old
  // beforeEach cleared nothing and providers leaked from test to test. A later
  // test then read the FIRST registered provider's answer instead of its own.
  const cleanups: Array<() => void> = [];

  function setColumnHeaderOverrideProvider(
    ...args: Parameters<typeof registerProvider>
  ): () => void {
    const cleanup = registerProvider(...args);
    cleanups.push(cleanup);
    return cleanup;
  }

  function registerColumnHeaderClickInterceptor(
    ...args: Parameters<typeof registerInterceptor>
  ): () => void {
    const cleanup = registerInterceptor(...args);
    cleanups.push(cleanup);
    return cleanup;
  }

  beforeEach(() => {
    while (cleanups.length) cleanups.pop()!();
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

    // Was "last provider wins", asserting the pre-multi-provider single-slot
    // semantics where a second call REPLACED the first. The registry has since
    // become multi-provider: providers are sorted by priority (ascending) and
    // the FIRST non-null answer wins, so at equal priority the earliest
    // registration takes precedence. The only production caller (Table) invokes
    // its previous cleanup before re-registering, so it never has two live.
    it("first non-null provider wins at equal priority", () => {
      setColumnHeaderOverrideProvider(() => ({ text: "First" }));
      setColumnHeaderOverrideProvider(() => ({ text: "Second" }));
      expect(getColumnHeaderOverride(0, 0)).toEqual({ text: "First" });
    });

    it("falls through to the next provider when one returns null", () => {
      setColumnHeaderOverrideProvider(() => null);
      setColumnHeaderOverrideProvider(() => ({ text: "Second" }));
      expect(getColumnHeaderOverride(0, 0)).toEqual({ text: "Second" });
    });

    it("unregistering a provider lets the next one answer", () => {
      const cleanup = setColumnHeaderOverrideProvider(() => ({ text: "First" }));
      setColumnHeaderOverrideProvider(() => ({ text: "Second" }));
      cleanup();
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
    // No local cleanup needed: the outer beforeEach unregisters everything this
    // file registered. (The previous version registered an interceptor and
    // immediately removed it, which cleared nothing that was already there.)

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
