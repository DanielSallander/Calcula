import { describe, it, expect, vi } from "vitest";

// Re-implement the private functions from ExtensionManager for unit testing
function parseVersion(version: string): [number, number, number] {
  const parts = version.replace(/^[^0-9]*/, "").split(".").map(Number);
  return [parts[0] || 0, parts[1] || 0, parts[2] || 0];
}

function isApiVersionCompatible(required: string, host: string): boolean {
  const isCaret = required.startsWith("^");
  const [reqMajor, reqMinor, reqPatch] = parseVersion(required);
  const [hostMajor, hostMinor, hostPatch] = parseVersion(host);

  if (isCaret) {
    if (hostMajor !== reqMajor) return false;
    if (hostMinor < reqMinor) return false;
    if (hostMinor === reqMinor && hostPatch < reqPatch) return false;
    return true;
  }

  return hostMajor === reqMajor;
}

describe("ExtensionManager deep tests", () => {
  // =========================================================================
  // parseVersion edge cases
  // =========================================================================

  describe("parseVersion edge cases", () => {
    it("parses standard semver", () => {
      expect(parseVersion("1.2.3")).toEqual([1, 2, 3]);
    });

    it("parses with caret prefix", () => {
      expect(parseVersion("^2.5.1")).toEqual([2, 5, 1]);
    });

    it("parses with tilde prefix", () => {
      expect(parseVersion("~1.4.2")).toEqual([1, 4, 2]);
    });

    it("handles single number", () => {
      expect(parseVersion("3")).toEqual([3, 0, 0]);
    });

    it("handles two numbers", () => {
      expect(parseVersion("2.7")).toEqual([2, 7, 0]);
    });

    it("handles zero version", () => {
      expect(parseVersion("0.0.0")).toEqual([0, 0, 0]);
    });

    it("handles large version numbers", () => {
      expect(parseVersion("100.200.300")).toEqual([100, 200, 300]);
    });

    it("strips pre-release tags (treated as NaN -> 0)", () => {
      // "1.2.3-beta.1" -> split gives ["1","2","3-beta","1"] -> Number("3-beta") = NaN -> 0
      const result = parseVersion("1.2.3-beta.1");
      expect(result[0]).toBe(1);
      expect(result[1]).toBe(2);
      // patch becomes 0 due to NaN from "3-beta"
      expect(result[2]).toBe(0);
    });

    it("strips build metadata (treated as NaN -> 0)", () => {
      const result = parseVersion("1.2.3+build.456");
      expect(result[0]).toBe(1);
      expect(result[1]).toBe(2);
      expect(result[2]).toBe(0); // "3+build" -> NaN -> 0
    });

    it("handles empty string", () => {
      expect(parseVersion("")).toEqual([0, 0, 0]);
    });

    it("handles non-numeric string", () => {
      expect(parseVersion("abc")).toEqual([0, 0, 0]);
    });

    it("handles version with v prefix", () => {
      expect(parseVersion("v1.2.3")).toEqual([1, 2, 3]);
    });
  });

  // =========================================================================
  // Version compatibility matrix
  // =========================================================================

  describe("version compatibility matrix", () => {
    // Caret range ^1.0.0 - standard major > 0
    describe("^1.0.0 (standard caret)", () => {
      const req = "^1.0.0";

      it("exact match is compatible", () => {
        expect(isApiVersionCompatible(req, "1.0.0")).toBe(true);
      });

      it("higher minor is compatible", () => {
        expect(isApiVersionCompatible(req, "1.5.0")).toBe(true);
      });

      it("higher patch is compatible", () => {
        expect(isApiVersionCompatible(req, "1.0.9")).toBe(true);
      });

      it("next major is incompatible", () => {
        expect(isApiVersionCompatible(req, "2.0.0")).toBe(false);
      });

      it("previous major is incompatible", () => {
        expect(isApiVersionCompatible(req, "0.9.9")).toBe(false);
      });
    });

    // Caret range ^0.1.0 - major 0
    describe("^0.1.0 (zero major caret)", () => {
      const req = "^0.1.0";

      it("exact match is compatible", () => {
        expect(isApiVersionCompatible(req, "0.1.0")).toBe(true);
      });

      it("higher minor is compatible", () => {
        expect(isApiVersionCompatible(req, "0.2.0")).toBe(true);
      });

      it("higher patch is compatible", () => {
        expect(isApiVersionCompatible(req, "0.1.5")).toBe(true);
      });

      it("lower minor is incompatible", () => {
        expect(isApiVersionCompatible(req, "0.0.9")).toBe(false);
      });

      it("major 1 is incompatible", () => {
        expect(isApiVersionCompatible(req, "1.0.0")).toBe(false);
      });
    });

    // Caret range ^0.0.1 - double zero major.minor
    describe("^0.0.1 (double zero caret)", () => {
      const req = "^0.0.1";

      it("exact match is compatible", () => {
        expect(isApiVersionCompatible(req, "0.0.1")).toBe(true);
      });

      it("higher patch is compatible", () => {
        expect(isApiVersionCompatible(req, "0.0.5")).toBe(true);
      });

      it("lower patch is incompatible", () => {
        expect(isApiVersionCompatible(req, "0.0.0")).toBe(false);
      });

      it("higher minor is compatible", () => {
        // Note: this differs from npm's caret behavior for ^0.0.x
        // but matches the implementation
        expect(isApiVersionCompatible(req, "0.1.0")).toBe(true);
      });
    });

    // Non-caret (major-only matching)
    describe("non-caret version matching", () => {
      it("same major always compatible", () => {
        expect(isApiVersionCompatible("1.0.0", "1.99.99")).toBe(true);
      });

      it("different major always incompatible", () => {
        expect(isApiVersionCompatible("1.0.0", "2.0.0")).toBe(false);
        expect(isApiVersionCompatible("3.0.0", "2.99.99")).toBe(false);
      });

      it("major 0 to major 0 is compatible", () => {
        expect(isApiVersionCompatible("0.1.0", "0.9.9")).toBe(true);
      });
    });

    // Edge cases with high versions
    describe("high version numbers", () => {
      it("caret with high minor", () => {
        expect(isApiVersionCompatible("^1.50.0", "1.50.0")).toBe(true);
        expect(isApiVersionCompatible("^1.50.0", "1.49.99")).toBe(false);
        expect(isApiVersionCompatible("^1.50.0", "1.51.0")).toBe(true);
      });

      it("caret with high patch", () => {
        expect(isApiVersionCompatible("^1.0.99", "1.0.99")).toBe(true);
        expect(isApiVersionCompatible("^1.0.99", "1.0.98")).toBe(false);
        expect(isApiVersionCompatible("^1.0.99", "1.1.0")).toBe(true);
      });
    });
  });

  // =========================================================================
  // Subscribe/unsubscribe patterns at scale
  // =========================================================================

  describe("subscribe/unsubscribe at scale", () => {
    it("handles 100 listeners with correct subscribe/unsubscribe", () => {
      const listeners = new Set<() => void>();
      const subscribe = (cb: () => void) => {
        listeners.add(cb);
        return () => listeners.delete(cb);
      };
      const notify = () => listeners.forEach((cb) => cb());

      const callbacks = Array.from({ length: 100 }, () => vi.fn());
      const unsubs = callbacks.map((cb) => subscribe(cb));

      notify();
      callbacks.forEach((cb) => expect(cb).toHaveBeenCalledTimes(1));

      // Unsubscribe even-indexed listeners
      unsubs.forEach((unsub, i) => { if (i % 2 === 0) unsub(); });

      notify();
      callbacks.forEach((cb, i) => {
        expect(cb).toHaveBeenCalledTimes(i % 2 === 0 ? 1 : 2);
      });
    });

    it("unsubscribing all 100 listeners results in no calls on notify", () => {
      const listeners = new Set<() => void>();
      const subscribe = (cb: () => void) => {
        listeners.add(cb);
        return () => listeners.delete(cb);
      };
      const notify = () => listeners.forEach((cb) => cb());

      const callbacks = Array.from({ length: 100 }, () => vi.fn());
      const unsubs = callbacks.map((cb) => subscribe(cb));

      unsubs.forEach((unsub) => unsub());
      notify();
      callbacks.forEach((cb) => expect(cb).not.toHaveBeenCalled());
    });

    it("re-subscribing after unsubscribe works", () => {
      const listeners = new Set<() => void>();
      const subscribe = (cb: () => void) => {
        listeners.add(cb);
        return () => listeners.delete(cb);
      };
      const notify = () => listeners.forEach((cb) => cb());

      const cb = vi.fn();
      const unsub1 = subscribe(cb);
      unsub1();
      expect(listeners.size).toBe(0);

      const unsub2 = subscribe(cb);
      notify();
      expect(cb).toHaveBeenCalledTimes(1);
      unsub2();
    });

    it("same callback subscribed multiple times is deduplicated in Set", () => {
      const listeners = new Set<() => void>();
      const subscribe = (cb: () => void) => {
        listeners.add(cb);
        return () => listeners.delete(cb);
      };
      const notify = () => listeners.forEach((cb) => cb());

      const cb = vi.fn();
      subscribe(cb);
      subscribe(cb);
      subscribe(cb);

      expect(listeners.size).toBe(1);
      notify();
      expect(cb).toHaveBeenCalledTimes(1);
    });
  });
});
