//! FILENAME: app/src/api/__tests__/registry-idempotent.test.ts
// PURPOSE: Tests for idempotency and reversibility of the extension registry.
// CONTEXT: Verifies that repeated register/unregister cycles, double-subscribe,
//          and clear operations behave predictably.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { ExtensionRegistry } from "../extensionRegistry";

// ============================================================================
// Setup
// ============================================================================

beforeEach(() => {
  ExtensionRegistry.clear();
});

// ============================================================================
// Double-register / overwrite
// ============================================================================

describe("registry - double-register idempotency", () => {
  it("double onSelectionChange with different callbacks registers both", () => {
    const cb1 = vi.fn();
    const cb2 = vi.fn();
    ExtensionRegistry.onSelectionChange(cb1);
    ExtensionRegistry.onSelectionChange(cb2);

    ExtensionRegistry.notifySelectionChange(null);
    expect(cb1).toHaveBeenCalledTimes(1);
    expect(cb2).toHaveBeenCalledTimes(1);
  });

  it("registering same callback reference twice still calls it once (Set semantics)", () => {
    const cb = vi.fn();
    ExtensionRegistry.onSelectionChange(cb);
    ExtensionRegistry.onSelectionChange(cb);

    ExtensionRegistry.notifySelectionChange(null);
    // Set-based: same reference added twice = only one entry
    expect(cb).toHaveBeenCalledTimes(1);
  });

  it("two identical-looking but different function objects are called independently", () => {
    let count = 0;
    const cb1 = () => { count++; };
    const cb2 = () => { count++; };
    ExtensionRegistry.onSelectionChange(cb1);
    ExtensionRegistry.onSelectionChange(cb2);

    ExtensionRegistry.notifySelectionChange(null);
    expect(count).toBe(2);
  });
});

// ============================================================================
// Subscribe same handler twice = called twice (when different refs)
// ============================================================================

describe("registry - subscribe behavior", () => {
  it("subscribe, notify, unsubscribe, notify = second notify does not call", () => {
    const cb = vi.fn();
    const unsub = ExtensionRegistry.onSelectionChange(cb);

    ExtensionRegistry.notifySelectionChange(null);
    expect(cb).toHaveBeenCalledTimes(1);

    unsub();
    ExtensionRegistry.notifySelectionChange(null);
    expect(cb).toHaveBeenCalledTimes(1);
  });

  it("subscribe -> unsubscribe -> subscribe again works", () => {
    const cb = vi.fn();
    const unsub1 = ExtensionRegistry.onSelectionChange(cb);
    unsub1();

    const unsub2 = ExtensionRegistry.onSelectionChange(cb);
    ExtensionRegistry.notifySelectionChange(null);
    expect(cb).toHaveBeenCalledTimes(1);

    unsub2();
    ExtensionRegistry.notifySelectionChange(null);
    expect(cb).toHaveBeenCalledTimes(1);
  });

  it("double unsubscribe does not throw", () => {
    const cb = vi.fn();
    const unsub = ExtensionRegistry.onSelectionChange(cb);
    expect(() => {
      unsub();
      unsub();
    }).not.toThrow();
  });

  it("unsubscribe on already-cleared registry does not throw", () => {
    const cb = vi.fn();
    const unsub = ExtensionRegistry.onSelectionChange(cb);
    ExtensionRegistry.clear();
    expect(() => unsub()).not.toThrow();
  });
});

// ============================================================================
// Register then unregister then register = works
// ============================================================================

describe("registry - register/unregister cycle", () => {
  it("register -> clear -> register cycle works correctly", () => {
    const cb = vi.fn();
    ExtensionRegistry.onSelectionChange(cb);
    ExtensionRegistry.clear();

    ExtensionRegistry.notifySelectionChange(null);
    expect(cb).not.toHaveBeenCalled();

    ExtensionRegistry.onSelectionChange(cb);
    ExtensionRegistry.notifySelectionChange(null);
    expect(cb).toHaveBeenCalledTimes(1);
  });

  it("multiple register/clear cycles accumulate no stale state", () => {
    for (let i = 0; i < 5; i++) {
      const cb = vi.fn();
      ExtensionRegistry.onSelectionChange(cb);
      ExtensionRegistry.clear();
    }

    const finalCb = vi.fn();
    ExtensionRegistry.onSelectionChange(finalCb);
    ExtensionRegistry.notifySelectionChange(null);
    expect(finalCb).toHaveBeenCalledTimes(1);
  });
});

// ============================================================================
// Clear then clear = no error
// ============================================================================

describe("registry - clear idempotency", () => {
  it("double clear does not throw", () => {
    expect(() => {
      ExtensionRegistry.clear();
      ExtensionRegistry.clear();
    }).not.toThrow();
  });

  it("clear on empty registry does not throw", () => {
    expect(() => ExtensionRegistry.clear()).not.toThrow();
  });

  it("triple clear leaves registry functional", () => {
    ExtensionRegistry.clear();
    ExtensionRegistry.clear();
    ExtensionRegistry.clear();

    const cb = vi.fn();
    ExtensionRegistry.onSelectionChange(cb);
    ExtensionRegistry.notifySelectionChange(null);
    expect(cb).toHaveBeenCalledTimes(1);
  });

  it("clear removes all callbacks so notify is a no-op", () => {
    const cb1 = vi.fn();
    const cb2 = vi.fn();
    ExtensionRegistry.onSelectionChange(cb1);
    ExtensionRegistry.onSelectionChange(cb2);

    ExtensionRegistry.clear();
    ExtensionRegistry.notifySelectionChange(null);

    expect(cb1).not.toHaveBeenCalled();
    expect(cb2).not.toHaveBeenCalled();
  });

  it("notify on empty registry does not throw", () => {
    expect(() => ExtensionRegistry.notifySelectionChange(null)).not.toThrow();
  });
});
