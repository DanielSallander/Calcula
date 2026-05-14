import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  getSetting,
  setSetting,
  removeSetting,
  registerSettingDefinitions,
  getAllSettingDefinitions,
  subscribeToSettings,
} from "../settings";

// Mock localStorage
const store: Record<string, string> = {};
const localStorageMock = {
  getItem: vi.fn((key: string) => store[key] ?? null),
  setItem: vi.fn((key: string, value: string) => {
    store[key] = value;
  }),
  removeItem: vi.fn((key: string) => {
    delete store[key];
  }),
};

Object.defineProperty(globalThis, "localStorage", { value: localStorageMock });

describe("settings API", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    for (const key of Object.keys(store)) delete store[key];
  });

  describe("getSetting", () => {
    it("returns default when nothing stored", () => {
      expect(getSetting("ext1", "theme", "dark")).toBe("dark");
    });

    it("reads stored string value", () => {
      store["ext.ext1.theme"] = "light";
      expect(getSetting("ext1", "theme", "dark")).toBe("light");
    });

    it("reads stored boolean value", () => {
      store["ext.ext1.enabled"] = "true";
      expect(getSetting("ext1", "enabled", false)).toBe(true);

      store["ext.ext1.enabled"] = "false";
      expect(getSetting("ext1", "enabled", true)).toBe(false);
    });

    it("reads stored number value", () => {
      store["ext.ext1.count"] = "42";
      expect(getSetting("ext1", "count", 0)).toBe(42);
    });

    it("returns default for NaN number", () => {
      store["ext.ext1.count"] = "not-a-number";
      expect(getSetting("ext1", "count", 10)).toBe(10);
    });
  });

  describe("setSetting", () => {
    it("stores string value", () => {
      setSetting("ext1", "theme", "light");
      expect(localStorageMock.setItem).toHaveBeenCalledWith("ext.ext1.theme", "light");
    });

    it("stores boolean as string", () => {
      setSetting("ext1", "enabled", true);
      expect(localStorageMock.setItem).toHaveBeenCalledWith("ext.ext1.enabled", "true");
    });

    it("stores number as string", () => {
      setSetting("ext1", "count", 42);
      expect(localStorageMock.setItem).toHaveBeenCalledWith("ext.ext1.count", "42");
    });
  });

  describe("removeSetting", () => {
    it("removes from localStorage", () => {
      removeSetting("ext1", "theme");
      expect(localStorageMock.removeItem).toHaveBeenCalledWith("ext.ext1.theme");
    });
  });

  describe("registerSettingDefinitions", () => {
    it("registers and retrieves definitions", () => {
      const cleanup = registerSettingDefinitions("ext1", [
        {
          key: "theme",
          label: "Theme",
          type: "select",
          defaultValue: "dark",
          options: [
            { label: "Dark", value: "dark" },
            { label: "Light", value: "light" },
          ],
        },
      ]);

      const defs = getAllSettingDefinitions();
      expect(defs).toHaveLength(1);
      expect(defs[0].extensionId).toBe("ext1");
      expect(defs[0].label).toBe("Theme");

      cleanup();
      expect(getAllSettingDefinitions()).toHaveLength(0);
    });
  });

  describe("subscribeToSettings", () => {
    it("notifies on setSetting", () => {
      const cb = vi.fn();
      const unsub = subscribeToSettings(cb);

      setSetting("ext1", "key", "val");
      expect(cb).toHaveBeenCalled();

      unsub();
    });

    it("notifies on removeSetting", () => {
      const cb = vi.fn();
      const unsub = subscribeToSettings(cb);

      removeSetting("ext1", "key");
      expect(cb).toHaveBeenCalled();

      unsub();
    });

    it("unsubscribe stops notifications", () => {
      const cb = vi.fn();
      const unsub = subscribeToSettings(cb);
      unsub();

      setSetting("ext1", "key", "val");
      expect(cb).not.toHaveBeenCalled();
    });
  });
});
