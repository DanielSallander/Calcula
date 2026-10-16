//! FILENAME: app/src/api/__tests__/statusBarRange.test.ts
// PURPOSE: The slot rules of @api/statusBarRange (WP-A S11a): one slot, last
//          writer wins, `null` withdraws only for the owner that holds it
//          (publishExternalCellTarget's rule), a republished identical range
//          is silent, and the stored range is normalised and frozen.

import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  publishStatusBarRange,
  getStatusBarRange,
  subscribeStatusBarRange,
  __resetStatusBarRangeForTests,
  type StatusBarRange,
} from "../statusBarRange";

const BLOCK: StatusBarRange = { startRow: 4, startCol: 1, endRow: 8, endCol: 3 };
const OTHER: StatusBarRange = { startRow: 0, startCol: 0, endRow: 2, endCol: 2 };

beforeEach(() => {
  __resetStatusBarRangeForTests();
});

describe("@api/statusBarRange slot", () => {
  it("is empty until someone publishes", () => {
    expect(getStatusBarRange()).toBeNull();
  });

  it("a published range is what the getter returns, and listeners hear it", () => {
    const heard = vi.fn();
    const off = subscribeStatusBarRange(heard);
    publishStatusBarRange("pivot-cells", BLOCK);
    expect(getStatusBarRange()).toEqual(BLOCK);
    expect(heard).toHaveBeenCalledTimes(1);
    off();
  });

  it("last writer wins: a second owner replaces the first", () => {
    publishStatusBarRange("pivot-cells", BLOCK);
    publishStatusBarRange("floating-grid", OTHER);
    expect(getStatusBarRange()).toEqual(OTHER);
  });

  it("null from an owner that no longer holds the slot does NOT withdraw the newer range", () => {
    publishStatusBarRange("floating-grid", OTHER);
    publishStatusBarRange("pivot-cells", BLOCK);
    const heard = vi.fn();
    const off = subscribeStatusBarRange(heard);
    publishStatusBarRange("floating-grid", null);
    expect(getStatusBarRange()).toEqual(BLOCK);
    expect(heard).not.toHaveBeenCalled();
    off();
  });

  it("null from the holder withdraws the slot and tells the listeners", () => {
    publishStatusBarRange("pivot-cells", BLOCK);
    const heard = vi.fn();
    const off = subscribeStatusBarRange(heard);
    publishStatusBarRange("pivot-cells", null);
    expect(getStatusBarRange()).toBeNull();
    expect(heard).toHaveBeenCalledTimes(1);
    off();
  });

  it("withdrawing an empty slot is silent", () => {
    const heard = vi.fn();
    const off = subscribeStatusBarRange(heard);
    publishStatusBarRange("pivot-cells", null);
    expect(heard).not.toHaveBeenCalled();
    off();
  });

  it("the same owner republishing the same cells is silent and keeps the same snapshot", () => {
    publishStatusBarRange("pivot-cells", BLOCK);
    const snapshot = getStatusBarRange();
    const heard = vi.fn();
    const off = subscribeStatusBarRange(heard);
    publishStatusBarRange("pivot-cells", { ...BLOCK });
    expect(heard).not.toHaveBeenCalled();
    expect(getStatusBarRange()).toBe(snapshot);
    off();
  });

  it("a different owner publishing the same cells takes the slot (its later null withdraws it)", () => {
    publishStatusBarRange("pivot-cells", BLOCK);
    publishStatusBarRange("floating-grid", { ...BLOCK });
    publishStatusBarRange("pivot-cells", null);
    expect(getStatusBarRange(), "the old owner withdrew a range it no longer held").toEqual(BLOCK);
    publishStatusBarRange("floating-grid", null);
    expect(getStatusBarRange()).toBeNull();
  });

  it("corners are ordered: a drag that ran up-left publishes the same block", () => {
    publishStatusBarRange("pivot-cells", { startRow: 8, startCol: 3, endRow: 4, endCol: 1 });
    expect(getStatusBarRange()).toEqual(BLOCK);
  });

  it("the stored range is a frozen copy: mutating the argument or the snapshot changes nothing", () => {
    const arg = { ...BLOCK };
    publishStatusBarRange("pivot-cells", arg);
    arg.endRow = 99;
    expect(getStatusBarRange()).toEqual(BLOCK);
    expect(Object.isFrozen(getStatusBarRange())).toBe(true);
  });

  it("refuses a range that is not four non-negative integer cell indexes, leaving the slot as it was", () => {
    publishStatusBarRange("pivot-cells", BLOCK);
    expect(() => publishStatusBarRange("x", { startRow: -1, startCol: 0, endRow: 1, endCol: 1 })).toThrow(RangeError);
    expect(() => publishStatusBarRange("x", { startRow: 0, startCol: 0.5, endRow: 1, endCol: 1 })).toThrow(RangeError);
    expect(() => publishStatusBarRange("x", { startRow: 0, startCol: 0, endRow: Number.NaN, endCol: 1 })).toThrow(
      RangeError,
    );
    expect(getStatusBarRange()).toEqual(BLOCK);
  });

  it("an unsubscribed listener hears nothing more, and a throwing listener does not silence the others", () => {
    const quiet = vi.fn();
    const offQuiet = subscribeStatusBarRange(quiet);
    offQuiet();
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const offBad = subscribeStatusBarRange(() => {
      throw new Error("boom");
    });
    const good = vi.fn();
    const offGood = subscribeStatusBarRange(good);
    publishStatusBarRange("pivot-cells", BLOCK);
    expect(quiet).not.toHaveBeenCalled();
    expect(good).toHaveBeenCalledTimes(1);
    expect(err).toHaveBeenCalled();
    offBad();
    offGood();
    err.mockRestore();
  });

  it("the test reset empties the slot whoever holds it and keeps subscriptions", () => {
    const heard = vi.fn();
    const off = subscribeStatusBarRange(heard);
    publishStatusBarRange("pivot-cells", BLOCK);
    __resetStatusBarRangeForTests();
    expect(getStatusBarRange()).toBeNull();
    expect(heard).toHaveBeenCalledTimes(2);
    publishStatusBarRange("pivot-cells", OTHER);
    expect(heard).toHaveBeenCalledTimes(3);
    off();
  });
});
