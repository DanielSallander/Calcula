//! FILENAME: app/extensions/Settings/__tests__/settingsStorage.test.ts
// PURPOSE: Tests for Settings storage logic (getSettings, saveSettings, defaults).
// CONTEXT: The SettingsView exports getSettings() which reads from localStorage.

import { describe, it, expect, beforeEach, vi } from "vitest";

// ============================================================================
// Replicate pure logic from SettingsView.tsx
// ============================================================================

type FileOpenMode = "preview" | "taskpane";

interface CalcuaSettings {
  fileClickAction: FileOpenMode;
}

const STORAGE_KEY = "calcula.settings";

const defaultSettings: CalcuaSettings = {
  fileClickAction: "preview",
};

function getSettings(): CalcuaSettings {
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

function saveSettings(settings: CalcuaSettings): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
}

// ============================================================================
// Tests
// ============================================================================

describe("Settings storage", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  describe("getSettings", () => {
    it("returns defaults when localStorage is empty", () => {
      const settings = getSettings();
      expect(settings).toEqual({ fileClickAction: "preview" });
    });

    it("reads saved settings from localStorage", () => {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({ fileClickAction: "taskpane" }));
      const settings = getSettings();
      expect(settings.fileClickAction).toBe("taskpane");
    });

    it("merges partial saved data with defaults", () => {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({}));
      const settings = getSettings();
      expect(settings.fileClickAction).toBe("preview");
    });

    it("handles corrupt JSON gracefully", () => {
      localStorage.setItem(STORAGE_KEY, "not-valid-json{{{");
      const settings = getSettings();
      expect(settings).toEqual({ fileClickAction: "preview" });
    });

    it("returns a new object each time (no shared reference)", () => {
      const a = getSettings();
      const b = getSettings();
      expect(a).toEqual(b);
      expect(a).not.toBe(b);
    });

    it("ignores unknown properties but preserves them through merge", () => {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({
        fileClickAction: "taskpane",
        unknownProp: 42,
      }));
      const settings = getSettings();
      expect(settings.fileClickAction).toBe("taskpane");
      expect((settings as Record<string, unknown>)["unknownProp"]).toBe(42);
    });
  });

  describe("saveSettings", () => {
    it("persists settings to localStorage", () => {
      saveSettings({ fileClickAction: "taskpane" });
      const raw = localStorage.getItem(STORAGE_KEY);
      expect(raw).toBeTruthy();
      expect(JSON.parse(raw!)).toEqual({ fileClickAction: "taskpane" });
    });

    it("round-trips through getSettings", () => {
      saveSettings({ fileClickAction: "taskpane" });
      expect(getSettings().fileClickAction).toBe("taskpane");
    });

    it("overwrites previous settings", () => {
      saveSettings({ fileClickAction: "taskpane" });
      saveSettings({ fileClickAction: "preview" });
      expect(getSettings().fileClickAction).toBe("preview");
    });
  });
});
