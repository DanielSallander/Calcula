//! FILENAME: app/src/api/__tests__/api-exhaustive.test.ts
// PURPOSE: Exhaustive verification that all API events, commands, and constants
//          are complete, consistent, and follow naming conventions.

import { describe, it, expect } from "vitest";
import { AppEvents, type AppEventName } from "../events";
import { CoreCommands } from "../commands";

// ============================================================================
// Helpers
// ============================================================================

function getAllEventValues(): string[] {
  return Object.values(AppEvents);
}

function getAllCommandValues(): string[] {
  return Object.values(CoreCommands);
}

// ============================================================================
// Tests: AppEvents naming conventions
// ============================================================================

describe("AppEvents naming conventions", () => {
  it("all event names start with 'app:'", () => {
    for (const [key, value] of Object.entries(AppEvents)) {
      expect(value).toMatch(/^app:/);
    }
  });

  it("all event name suffixes use kebab-case", () => {
    const kebabRe = /^app:[a-z][a-z0-9]*(-[a-z0-9]+)*$/;
    for (const [key, value] of Object.entries(AppEvents)) {
      expect(value).toMatch(kebabRe);
    }
  });

  it("no duplicate event values", () => {
    const values = getAllEventValues();
    const unique = new Set(values);
    expect(unique.size).toBe(values.length);
  });

  it("no duplicate event keys", () => {
    const keys = Object.keys(AppEvents);
    const unique = new Set(keys);
    expect(unique.size).toBe(keys.length);
  });

  it("event keys are UPPER_SNAKE_CASE", () => {
    const upperSnake = /^[A-Z][A-Z0-9]*(_[A-Z0-9]+)*$/;
    for (const key of Object.keys(AppEvents)) {
      expect(key).toMatch(upperSnake);
    }
  });
});

// ============================================================================
// Tests: AppEvents completeness
// ============================================================================

describe("AppEvents completeness", () => {
  const EXPECTED_EVENTS = [
    "app:cut", "app:copy", "app:paste",
    "app:find", "app:replace",
    "app:selection-changed",
    "app:sheet-changed",
    "app:data-changed",
    "app:cells-updated",
    "app:cell-values-changed",
    "app:edit-started", "app:edit-ended",
    "app:grid-refresh",
    "app:context-menu-request", "app:context-menu-close",
    "app:rows-inserted", "app:columns-inserted",
    "app:rows-deleted", "app:columns-deleted",
    "app:navigate-to-cell",
    "app:named-ranges-changed",
    "app:freeze-changed",
    "app:split-changed",
    "app:view-mode-changed",
    "app:zoom-changed",
    "app:theme-changed",
    "app:before-save", "app:after-save",
    "app:before-open", "app:after-open",
    "app:before-new", "app:after-new",
    "app:before-close",
    "app:dirty-state-changed",
  ];

  it("all expected events exist in AppEvents", () => {
    const values = new Set(getAllEventValues());
    for (const expected of EXPECTED_EVENTS) {
      expect(values.has(expected)).toBe(true);
    }
  });

  it("AppEvents has a reasonable number of entries (no accidental deletions)", () => {
    const count = Object.keys(AppEvents).length;
    expect(count).toBeGreaterThanOrEqual(30);
  });
});

// ============================================================================
// Tests: CoreCommands naming conventions
// ============================================================================

describe("CoreCommands naming conventions", () => {
  it("all command IDs use dot-separated namespace", () => {
    const dotFormat = /^core\.[a-z]+\.[a-zA-Z]+$/;
    for (const [key, value] of Object.entries(CoreCommands)) {
      expect(value).toMatch(dotFormat);
    }
  });

  it("no duplicate command values", () => {
    const values = getAllCommandValues();
    const unique = new Set(values);
    expect(unique.size).toBe(values.length);
  });

  it("no duplicate command keys", () => {
    const keys = Object.keys(CoreCommands);
    const unique = new Set(keys);
    expect(unique.size).toBe(keys.length);
  });

  it("command keys are UPPER_SNAKE_CASE", () => {
    const upperSnake = /^[A-Z][A-Z0-9]*(_[A-Z0-9]+)*$/;
    for (const key of Object.keys(CoreCommands)) {
      expect(key).toMatch(upperSnake);
    }
  });
});

// ============================================================================
// Tests: CoreCommands completeness
// ============================================================================

describe("CoreCommands completeness", () => {
  it("clipboard commands are present", () => {
    expect(CoreCommands.CUT).toBeDefined();
    expect(CoreCommands.COPY).toBeDefined();
    expect(CoreCommands.PASTE).toBeDefined();
    expect(CoreCommands.PASTE_SPECIAL).toBeDefined();
    expect(CoreCommands.PASTE_VALUES).toBeDefined();
    expect(CoreCommands.PASTE_FORMULAS).toBeDefined();
    expect(CoreCommands.PASTE_FORMATTING).toBeDefined();
    expect(CoreCommands.PASTE_LINK).toBeDefined();
  });

  it("edit commands are present", () => {
    expect(CoreCommands.UNDO).toBeDefined();
    expect(CoreCommands.REDO).toBeDefined();
    expect(CoreCommands.FIND).toBeDefined();
    expect(CoreCommands.REPLACE).toBeDefined();
    expect(CoreCommands.CLEAR_CONTENTS).toBeDefined();
    expect(CoreCommands.CLEAR_ALL).toBeDefined();
  });

  it("fill commands are present", () => {
    expect(CoreCommands.FILL_DOWN).toBeDefined();
    expect(CoreCommands.FILL_RIGHT).toBeDefined();
    expect(CoreCommands.FILL_UP).toBeDefined();
    expect(CoreCommands.FILL_LEFT).toBeDefined();
  });

  it("grid commands are present", () => {
    expect(CoreCommands.MERGE_CELLS).toBeDefined();
    expect(CoreCommands.UNMERGE_CELLS).toBeDefined();
    expect(CoreCommands.FREEZE_PANES).toBeDefined();
    expect(CoreCommands.INSERT_ROW).toBeDefined();
    expect(CoreCommands.INSERT_COLUMN).toBeDefined();
    expect(CoreCommands.DELETE_ROW).toBeDefined();
    expect(CoreCommands.DELETE_COLUMN).toBeDefined();
  });
});

// ============================================================================
// Tests: No cross-contamination between constant objects
// ============================================================================

describe("No duplicate values across constant objects", () => {
  it("AppEvents values do not overlap with CoreCommands values", () => {
    const eventValues = new Set(getAllEventValues());
    const commandValues = getAllCommandValues();
    for (const cmd of commandValues) {
      expect(eventValues.has(cmd)).toBe(false);
    }
  });

  it("AppEvents and CoreCommands use different namespaces", () => {
    // Events use "app:" prefix, commands use "core." prefix
    for (const val of getAllEventValues()) {
      expect(val.startsWith("app:")).toBe(true);
    }
    for (const val of getAllCommandValues()) {
      expect(val.startsWith("core.")).toBe(true);
    }
  });
});
