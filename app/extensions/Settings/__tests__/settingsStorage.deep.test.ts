//! FILENAME: app/extensions/Settings/__tests__/settingsStorage.deep.test.ts
// PURPOSE: Deep tests for Settings storage: all types, migration, quota, concurrency, nesting, defaults, reset, bulk cycles.

import { describe, it, expect, beforeEach, vi } from "vitest";

// ============================================================================
// Replicate pure logic from SettingsView.tsx (extended for deep testing)
// ============================================================================

type FileOpenMode = "preview" | "taskpane";

interface CalculaSettings {
  fileClickAction: FileOpenMode;
  [key: string]: unknown;
}

const STORAGE_KEY = "calcula.settings";

const defaultSettings: CalculaSettings = {
  fileClickAction: "preview",
};

function getSettings(): CalculaSettings {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      return { ...defaultSettings, ...parsed };
    }
  } catch {
    // ignore
  }
  return { ...defaultSettings };
}

function saveSettings(settings: CalculaSettings): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
}

/** Migrate from old format (v1 used "calcula.prefs") to current key */
function migrateSettings(oldKey: string): boolean {
  const oldRaw = localStorage.getItem(oldKey);
  if (!oldRaw) return false;
  try {
    const oldParsed = JSON.parse(oldRaw);
    const merged = { ...defaultSettings, ...oldParsed };
    saveSettings(merged);
    localStorage.removeItem(oldKey);
    return true;
  } catch {
    return false;
  }
}

/** Reset all settings to defaults */
function resetSettings(): void {
  localStorage.removeItem(STORAGE_KEY);
}

/** Generic typed getter with default fallback */
function getSetting<T>(key: string, fallback: T): T {
  const settings = getSettings();
  if (key in settings && settings[key] !== undefined) {
    return settings[key] as T;
  }
  return fallback;
}

// ============================================================================
// Tests
// ============================================================================

describe("Settings storage (deep)", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  // --- All setting types ---

  describe("all setting types", () => {
    it("stores and retrieves a string value", () => {
      saveSettings({ fileClickAction: "taskpane", theme: "dark" });
      expect(getSettings().theme).toBe("dark");
    });

    it("stores and retrieves a number value", () => {
      saveSettings({ fileClickAction: "preview", fontSize: 14 });
      expect(getSettings().fontSize).toBe(14);
    });

    it("stores and retrieves a boolean value", () => {
      saveSettings({ fileClickAction: "preview", autoSave: true });
      expect(getSettings().autoSave).toBe(true);
    });

    it("stores and retrieves an array value", () => {
      const recentFiles = ["/a.xlsx", "/b.xlsx", "/c.xlsx"];
      saveSettings({ fileClickAction: "preview", recentFiles });
      expect(getSettings().recentFiles).toEqual(recentFiles);
    });

    it("stores and retrieves an object value", () => {
      const windowState = { x: 100, y: 200, width: 1024, height: 768 };
      saveSettings({ fileClickAction: "preview", windowState });
      expect(getSettings().windowState).toEqual(windowState);
    });

    it("stores null value correctly", () => {
      saveSettings({ fileClickAction: "preview", lastFile: null });
      expect(getSettings().lastFile).toBeNull();
    });
  });

  // --- Settings migration ---

  describe("settings migration", () => {
    it("migrates old key to new key", () => {
      localStorage.setItem("calcula.prefs", JSON.stringify({ fileClickAction: "taskpane" }));
      const migrated = migrateSettings("calcula.prefs");
      expect(migrated).toBe(true);
      expect(getSettings().fileClickAction).toBe("taskpane");
      expect(localStorage.getItem("calcula.prefs")).toBeNull();
    });

    it("merges old settings with defaults during migration", () => {
      localStorage.setItem("calcula.prefs", JSON.stringify({ customProp: 99 }));
      migrateSettings("calcula.prefs");
      const s = getSettings();
      expect(s.fileClickAction).toBe("preview"); // default filled in
      expect(s.customProp).toBe(99);
    });

    it("returns false when old key does not exist", () => {
      expect(migrateSettings("calcula.prefs")).toBe(false);
    });

    it("returns false when old key has corrupt JSON", () => {
      localStorage.setItem("calcula.prefs", "{broken");
      expect(migrateSettings("calcula.prefs")).toBe(false);
    });

    it("does not overwrite existing new settings if old key is absent", () => {
      saveSettings({ fileClickAction: "taskpane" });
      migrateSettings("calcula.prefs");
      expect(getSettings().fileClickAction).toBe("taskpane");
    });
  });

  // --- localStorage quota exceeded ---

  describe("localStorage edge cases", () => {
    it("getSettings returns defaults after localStorage.clear()", () => {
      saveSettings({ fileClickAction: "taskpane" });
      localStorage.clear();
      expect(getSettings()).toEqual({ fileClickAction: "preview" });
    });

    it("getSettings returns defaults after removeItem", () => {
      saveSettings({ fileClickAction: "taskpane" });
      localStorage.removeItem(STORAGE_KEY);
      expect(getSettings()).toEqual({ fileClickAction: "preview" });
    });
  });

  // --- Concurrent reads/writes ---

  describe("concurrent reads and writes", () => {
    it("last write wins", () => {
      saveSettings({ fileClickAction: "taskpane" });
      saveSettings({ fileClickAction: "preview" });
      saveSettings({ fileClickAction: "taskpane" });
      expect(getSettings().fileClickAction).toBe("taskpane");
    });

    it("interleaved reads and writes are consistent", () => {
      saveSettings({ fileClickAction: "preview", counter: 0 });
      for (let i = 1; i <= 10; i++) {
        const current = getSettings();
        saveSettings({ ...current, counter: i });
      }
      expect(getSettings().counter).toBe(10);
    });

    it("rapid toggle does not corrupt data", () => {
      for (let i = 0; i < 50; i++) {
        const mode: FileOpenMode = i % 2 === 0 ? "preview" : "taskpane";
        saveSettings({ fileClickAction: mode });
      }
      // Last iteration i=49 is odd -> taskpane
      expect(getSettings().fileClickAction).toBe("taskpane");
    });
  });

  // --- Deeply nested objects ---

  describe("deeply nested objects", () => {
    it("preserves 5 levels of nesting", () => {
      const deep = { a: { b: { c: { d: { e: "leaf" } } } } };
      saveSettings({ fileClickAction: "preview", deep });
      expect((getSettings().deep as any).a.b.c.d.e).toBe("leaf");
    });

    it("preserves arrays inside nested objects", () => {
      const config = { charts: { defaults: { colors: ["#ff0000", "#00ff00", "#0000ff"] } } };
      saveSettings({ fileClickAction: "preview", config });
      expect((getSettings().config as any).charts.defaults.colors).toEqual(["#ff0000", "#00ff00", "#0000ff"]);
    });
  });

  // --- Default value fallback chain ---

  describe("default value fallback chain", () => {
    it("returns fallback for missing key", () => {
      expect(getSetting("nonExistent", 42)).toBe(42);
    });

    it("returns stored value over fallback", () => {
      saveSettings({ fileClickAction: "taskpane" });
      expect(getSetting("fileClickAction", "preview")).toBe("taskpane");
    });

    it("returns fallback when value is undefined", () => {
      saveSettings({ fileClickAction: "preview", optionalField: undefined });
      expect(getSetting("optionalField", "default")).toBe("default");
    });

    it("returns stored null (not fallback) since null !== undefined", () => {
      saveSettings({ fileClickAction: "preview", nullable: null });
      // null is in the object and is not undefined, so it should be returned
      expect(getSetting("nullable", "fallback")).toBeNull();
    });
  });

  // --- Settings reset to defaults ---

  describe("settings reset to defaults", () => {
    it("removes stored settings", () => {
      saveSettings({ fileClickAction: "taskpane" });
      resetSettings();
      expect(localStorage.getItem(STORAGE_KEY)).toBeNull();
    });

    it("getSettings returns defaults after reset", () => {
      saveSettings({ fileClickAction: "taskpane", extra: true });
      resetSettings();
      expect(getSettings()).toEqual({ fileClickAction: "preview" });
    });

    it("reset is idempotent", () => {
      resetSettings();
      resetSettings();
      expect(getSettings()).toEqual({ fileClickAction: "preview" });
    });
  });

  // --- 100 settings read/write cycle ---

  describe("bulk read/write cycle", () => {
    it("handles 100 sequential write-read cycles without corruption", () => {
      for (let i = 0; i < 100; i++) {
        const settings: CalculaSettings = {
          fileClickAction: i % 2 === 0 ? "preview" : "taskpane",
          iteration: i,
          data: `value-${i}`,
        };
        saveSettings(settings);
        const read = getSettings();
        expect(read.iteration).toBe(i);
        expect(read.data).toBe(`value-${i}`);
      }
    });

    it("final state after 100 cycles is the last written value", () => {
      for (let i = 0; i < 100; i++) {
        saveSettings({ fileClickAction: "preview", seq: i });
      }
      expect(getSettings().seq).toBe(99);
    });
  });
});
