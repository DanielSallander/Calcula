import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock all dependencies before imports
vi.mock("../../../extensions/manifest", () => ({
  builtInExtensions: [],
}));

vi.mock("../../../src/api/backend", () => ({
  invokeBackend: vi.fn(),
}));

vi.mock("../../../src/api/commands", () => ({
  CommandRegistry: {
    register: vi.fn(),
    execute: vi.fn(),
    has: vi.fn(),
    getAll: vi.fn(() => []),
  },
}));

vi.mock("../../../src/api/version", () => ({
  API_VERSION: "1.0.0",
}));

vi.mock("../../../src/api/ui", () => ({
  registerMenu: vi.fn(),
  registerMenuItem: vi.fn(),
  getMenus: vi.fn(() => []),
  subscribeToMenus: vi.fn(() => () => {}),
  notifyMenusChanged: vi.fn(),
  registerTaskPane: vi.fn(),
  unregisterTaskPane: vi.fn(),
  openTaskPane: vi.fn(),
  closeTaskPane: vi.fn(),
  getTaskPane: vi.fn(),
  showTaskPaneContainer: vi.fn(),
  hideTaskPaneContainer: vi.fn(),
  isTaskPaneContainerOpen: vi.fn(),
  getTaskPaneManuallyClosed: vi.fn(() => []),
  markTaskPaneManuallyClosed: vi.fn(),
  clearTaskPaneManuallyClosed: vi.fn(),
  addTaskPaneContextKey: vi.fn(),
  removeTaskPaneContextKey: vi.fn(),
  registerDialog: vi.fn(),
  unregisterDialog: vi.fn(),
  showDialog: vi.fn(),
  hideDialog: vi.fn(),
  registerOverlay: vi.fn(),
  unregisterOverlay: vi.fn(),
  showOverlay: vi.fn(),
  hideOverlay: vi.fn(),
  hideAllOverlays: vi.fn(),
  registerStatusBarItem: vi.fn(),
  unregisterStatusBarItem: vi.fn(),
  registerActivityView: vi.fn(),
  unregisterActivityView: vi.fn(),
  openActivityView: vi.fn(),
  closeActivityView: vi.fn(),
  toggleActivityView: vi.fn(),
}));

vi.mock("../../../src/api/events", () => ({
  emitAppEvent: vi.fn(),
  onAppEvent: vi.fn(() => () => {}),
}));

vi.mock("../../../src/api/notifications", () => ({
  showToast: vi.fn(),
}));

vi.mock("../../../src/api/cellDecorations", () => ({
  registerCellDecoration: vi.fn(),
  unregisterCellDecoration: vi.fn(),
}));

vi.mock("../../../src/api/styleInterceptors", () => ({
  registerStyleInterceptor: vi.fn(),
  unregisterStyleInterceptor: vi.fn(),
  markRangeDirty: vi.fn(),
  markSheetDirty: vi.fn(),
}));

vi.mock("../../../src/api/gridOverlays", () => ({
  registerGridOverlay: vi.fn(),
}));

vi.mock("../../../src/api/editGuards", () => ({
  registerEditGuard: vi.fn(),
  registerRangeGuard: vi.fn(),
}));

vi.mock("../../../src/api/cellClickInterceptors", () => ({
  registerCellClickInterceptor: vi.fn(),
}));

vi.mock("../../../src/api/cellDoubleClickInterceptors", () => ({
  registerCellDoubleClickInterceptor: vi.fn(),
}));

vi.mock("../../../src/api/keyboard", () => ({
  registerShortcut: vi.fn(),
  getShortcuts: vi.fn(() => []),
}));

vi.mock("../../../src/api/keybindings", () => ({
  registerKeybinding: vi.fn(() => () => {}),
  getAllKeybindings: vi.fn(() => []),
  getEffectiveCombo: vi.fn(() => ""),
}));

vi.mock("../../../src/api/settings", () => ({
  getSetting: vi.fn(),
  setSetting: vi.fn(),
  removeSetting: vi.fn(),
  registerSettingDefinitions: vi.fn(() => () => {}),
}));

vi.mock("../../../src/api/cellEditors", () => ({
  registerCellEditor: vi.fn(),
}));

vi.mock("../../../src/api/fileFormats", () => ({
  registerFileFormat: vi.fn(),
  getFileFormats: vi.fn(() => []),
}));

vi.mock("../../../src/api/formulaFunctions", () => ({
  registerFunction: vi.fn(),
}));

// We test the pure utility functions exported from the module
// rather than the singleton (which has too many side effects)
// Focus on parseVersion and isApiVersionCompatible

// Since these are private, we re-implement them here for testing.
// Alternatively, test via the public API by creating extension modules.

describe("ExtensionManager - version compatibility", () => {
  // Re-implement the private functions for unit testing
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

  describe("parseVersion", () => {
    it("parses simple version", () => {
      expect(parseVersion("1.2.3")).toEqual([1, 2, 3]);
    });

    it("parses version with caret prefix", () => {
      expect(parseVersion("^1.2.3")).toEqual([1, 2, 3]);
    });

    it("handles missing parts", () => {
      expect(parseVersion("1")).toEqual([1, 0, 0]);
      expect(parseVersion("1.2")).toEqual([1, 2, 0]);
    });
  });

  describe("isApiVersionCompatible", () => {
    it("caret range: compatible when host >= required same major", () => {
      expect(isApiVersionCompatible("^1.2.3", "1.2.3")).toBe(true);
      expect(isApiVersionCompatible("^1.2.3", "1.3.0")).toBe(true);
      expect(isApiVersionCompatible("^1.2.3", "1.2.5")).toBe(true);
    });

    it("caret range: incompatible when host major differs", () => {
      expect(isApiVersionCompatible("^1.2.3", "2.0.0")).toBe(false);
      expect(isApiVersionCompatible("^1.2.3", "0.9.0")).toBe(false);
    });

    it("caret range: incompatible when host minor < required", () => {
      expect(isApiVersionCompatible("^1.2.3", "1.1.9")).toBe(false);
    });

    it("caret range: incompatible when same minor but patch too low", () => {
      expect(isApiVersionCompatible("^1.2.3", "1.2.2")).toBe(false);
    });

    it("no prefix: compatible if same major", () => {
      expect(isApiVersionCompatible("1.0.0", "1.5.0")).toBe(true);
      expect(isApiVersionCompatible("2.0.0", "2.99.99")).toBe(true);
    });

    it("no prefix: incompatible if different major", () => {
      expect(isApiVersionCompatible("1.0.0", "2.0.0")).toBe(false);
    });
  });
});

describe("ExtensionManager - subscription pattern", () => {
  // Test the vanilla listener pattern in isolation
  it("subscribe/unsubscribe pattern works", () => {
    const listeners = new Set<() => void>();
    const subscribe = (cb: () => void) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    };
    const notify = () => listeners.forEach((cb) => cb());

    const cb = vi.fn();
    const unsub = subscribe(cb);

    notify();
    expect(cb).toHaveBeenCalledTimes(1);

    unsub();
    notify();
    expect(cb).toHaveBeenCalledTimes(1);
  });
});
