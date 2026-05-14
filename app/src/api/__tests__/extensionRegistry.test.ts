import { describe, it, expect, vi, beforeEach } from "vitest";
import { ExtensionRegistry } from "../extensionRegistry";

describe("ExtensionRegistry (API layer)", () => {
  beforeEach(() => {
    ExtensionRegistry.clear();
  });

  it("registers and notifies selection change callback", () => {
    const cb = vi.fn();
    ExtensionRegistry.onSelectionChange(cb);

    const selection = { row: 0, col: 0, ranges: [] } as any;
    ExtensionRegistry.notifySelectionChange(selection);

    expect(cb).toHaveBeenCalledWith(selection);
  });

  it("unsubscribes callback", () => {
    const cb = vi.fn();
    const unsub = ExtensionRegistry.onSelectionChange(cb);
    unsub();

    ExtensionRegistry.notifySelectionChange(null);
    expect(cb).not.toHaveBeenCalled();
  });

  it("handles null selection", () => {
    const cb = vi.fn();
    ExtensionRegistry.onSelectionChange(cb);
    ExtensionRegistry.notifySelectionChange(null);
    expect(cb).toHaveBeenCalledWith(null);
  });

  it("catches errors in callbacks without affecting others", () => {
    const errorCb = vi.fn(() => {
      throw new Error("boom");
    });
    const goodCb = vi.fn();

    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    ExtensionRegistry.onSelectionChange(errorCb);
    ExtensionRegistry.onSelectionChange(goodCb);

    ExtensionRegistry.notifySelectionChange(null);

    expect(errorCb).toHaveBeenCalled();
    expect(goodCb).toHaveBeenCalled();
    expect(errorSpy).toHaveBeenCalled();

    errorSpy.mockRestore();
  });

  it("supports multiple concurrent subscribers", () => {
    const cbs = [vi.fn(), vi.fn(), vi.fn()];
    cbs.forEach((cb) => ExtensionRegistry.onSelectionChange(cb));

    ExtensionRegistry.notifySelectionChange(null);

    cbs.forEach((cb) => expect(cb).toHaveBeenCalledTimes(1));
  });

  it("clear removes all subscribers", () => {
    const cb = vi.fn();
    ExtensionRegistry.onSelectionChange(cb);
    ExtensionRegistry.clear();

    ExtensionRegistry.notifySelectionChange(null);
    expect(cb).not.toHaveBeenCalled();
  });
});
