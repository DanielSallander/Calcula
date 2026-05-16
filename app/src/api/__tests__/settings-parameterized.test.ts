import { describe, it, expect, beforeEach } from "vitest";
import { getSetting, setSetting, removeSetting } from "../settings";

// ============================================================================
// Mock localStorage
// ============================================================================

const storage: Map<string, string> = new Map();

beforeEach(() => {
  storage.clear();
  Object.defineProperty(globalThis, "localStorage", {
    value: {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => storage.set(key, value),
      removeItem: (key: string) => storage.delete(key),
      clear: () => storage.clear(),
      get length() { return storage.size; },
      key: (index: number) => Array.from(storage.keys())[index] ?? null,
    },
    writable: true,
    configurable: true,
  });
});

// ============================================================================
// getSetting/setSetting round-trip - 50 combos
// ============================================================================

describe("getSetting/setSetting round-trip", () => {
  // String values (10)
  it.each([
    ["test-ext", "theme", "dark", "dark"],
    ["test-ext", "locale", "en-US", "en-US"],
    ["my.ext", "name", "hello world", "hello world"],
    ["ext-1", "path", "/usr/local/bin", "/usr/local/bin"],
    ["ext-2", "empty-str", "", ""],
    ["ext-3", "special-chars", "foo@bar#baz$qux", "foo@bar#baz$qux"],
    ["ext-4", "unicode", "test-ascii-value", "test-ascii-value"],
    ["ext-5", "long-value", "a".repeat(1000), "a".repeat(1000)],
    ["ext-6", "with spaces", "value with spaces", "value with spaces"],
    ["ext-7", "dot.key.nested", "nested-value", "nested-value"],
  ] as const)("string: ext=%s key=%s val=%s", (extId, key, value, expected) => {
    setSetting(extId, key, value);
    expect(getSetting(extId, key, "default")).toBe(expected);
  });

  // Number values (15)
  it.each([
    ["num-ext", "count", 0, 0],
    ["num-ext", "positive", 42, 42],
    ["num-ext", "negative", -10, -10],
    ["num-ext", "float", 3.14, 3.14],
    ["num-ext", "large", 999999999, 999999999],
    ["num-ext", "small-float", 0.001, 0.001],
    ["num-ext", "neg-float", -99.99, -99.99],
    ["num-ext", "max-safe", Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER],
    ["num-ext", "min-safe", Number.MIN_SAFE_INTEGER, Number.MIN_SAFE_INTEGER],
    ["num-ext", "one", 1, 1],
    ["num-ext", "hundred", 100, 100],
    ["num-ext", "thousand", 1000, 1000],
    ["num-ext", "decimal-2", 2.5, 2.5],
    ["num-ext", "decimal-3", 0.333, 0.333],
    ["num-ext", "neg-one", -1, -1],
  ] as const)("number: ext=%s key=%s val=%s", (extId, key, value, expected) => {
    setSetting(extId, key, value);
    expect(getSetting(extId, key, 0)).toBe(expected);
  });

  // Boolean values (10)
  it.each([
    ["bool-ext", "enabled", true, true],
    ["bool-ext", "disabled", false, false],
    ["bool-ext", "show-hints", true, true],
    ["bool-ext", "auto-save", false, false],
    ["bool-ext", "dark-mode", true, true],
    ["bool-ext", "compact", false, false],
    ["bool-ext", "animations", true, true],
    ["bool-ext", "debug", false, false],
    ["bool-ext", "verbose", true, true],
    ["bool-ext", "muted", false, false],
  ] as const)("boolean: ext=%s key=%s val=%s", (extId, key, value, expected) => {
    setSetting(extId, key, value);
    expect(getSetting(extId, key, !value)).toBe(expected);
  });

  // Keys with special characters (10)
  it.each([
    ["ext", "dot.separated.key", "v1", "v1"],
    ["ext", "slash/key", "v2", "v2"],
    ["ext", "dash-key", "v3", "v3"],
    ["ext", "underscore_key", "v4", "v4"],
    ["ext", "colon:key", "v5", "v5"],
    ["ext", "at@key", "v6", "v6"],
    ["ext", "hash#key", "v7", "v7"],
    ["ext", "tilde~key", "v8", "v8"],
    ["ext", "pipe|key", "v9", "v9"],
    ["ext", "mixed.key/path:name", "v10", "v10"],
  ] as const)("special key: ext=%s key=%s val=%s", (extId, key, value, expected) => {
    setSetting(extId, key, value);
    expect(getSetting(extId, key, "default")).toBe(expected);
  });

  // Overwrite existing values (5)
  it.each([
    ["overwrite-ext", "key1", "first", "second", "second"],
    ["overwrite-ext", "key2", "alpha", "beta", "beta"],
    ["overwrite-ext", "num-key", 10, 20, 20],
    ["overwrite-ext", "bool-key", true, false, false],
    ["overwrite-ext", "str-key", "old", "new", "new"],
  ] as const)("overwrite: ext=%s key=%s first=%s second=%s => %s", (extId, key, first, second, expected) => {
    setSetting(extId, key, first);
    setSetting(extId, key, second);
    const defaultVal = typeof expected === "number" ? 0 : typeof expected === "boolean" ? true : "default";
    expect(getSetting(extId, key, defaultVal as typeof expected)).toBe(expected);
  });
});

// ============================================================================
// Default values - 20 combos
// ============================================================================

describe("getSetting with defaults (missing keys)", () => {
  it.each([
    // String defaults
    ["missing-ext", "no-key-1", "default-a", "default-a"],
    ["missing-ext", "no-key-2", "", ""],
    ["missing-ext", "no-key-3", "fallback", "fallback"],
    ["missing-ext", "no-key-4", "hello world", "hello world"],
    ["missing-ext", "no-key-5", "/path/to/file", "/path/to/file"],
    // Number defaults
    ["missing-ext", "no-num-1", 0, 0],
    ["missing-ext", "no-num-2", 42, 42],
    ["missing-ext", "no-num-3", -1, -1],
    ["missing-ext", "no-num-4", 3.14, 3.14],
    ["missing-ext", "no-num-5", 100, 100],
    ["missing-ext", "no-num-6", 999, 999],
    ["missing-ext", "no-num-7", -50.5, -50.5],
    // Boolean defaults
    ["missing-ext", "no-bool-1", true, true],
    ["missing-ext", "no-bool-2", false, false],
    ["missing-ext", "no-bool-3", true, true],
    ["missing-ext", "no-bool-4", false, false],
    // Different extension IDs, same key
    ["ext-alpha", "shared-key", "alpha-default", "alpha-default"],
    ["ext-beta", "shared-key", "beta-default", "beta-default"],
    ["ext-gamma", "shared-key", 99, 99],
    ["ext-delta", "shared-key", true, true],
  ] as const)("default: ext=%s key=%s default=%s => %s", (extId, key, defaultVal, expected) => {
    expect(getSetting(extId, key, defaultVal)).toBe(expected);
  });
});

// ============================================================================
// removeSetting - 15 scenarios
// ============================================================================

describe("removeSetting", () => {
  it.each([
    // Remove string values
    ["rm-ext", "str-key-1", "value1", "default1"],
    ["rm-ext", "str-key-2", "value2", "default2"],
    ["rm-ext", "str-key-3", "value3", "default3"],
    // Remove number values
    ["rm-ext", "num-key-1", 42, 0],
    ["rm-ext", "num-key-2", 100, -1],
    ["rm-ext", "num-key-3", 3.14, 0],
    // Remove boolean values
    ["rm-ext", "bool-key-1", true, false],
    ["rm-ext", "bool-key-2", false, true],
    ["rm-ext", "bool-key-3", true, false],
    // Remove from different extensions
    ["ext-a", "shared", "val-a", "default"],
    ["ext-b", "shared", "val-b", "default"],
    ["ext-c", "shared", "val-c", "default"],
    // Remove key that was overwritten
    ["rm-ext", "overwritten", "final", "default"],
    // Remove with special key names
    ["rm-ext", "dot.key", "val", "default"],
    ["rm-ext", "slash/key", "val", "default"],
  ] as const)("remove: ext=%s key=%s (set=%s, default after remove=%s)", (extId, key, setValue, defaultAfter) => {
    setSetting(extId, key, setValue);
    expect(getSetting(extId, key, defaultAfter as typeof setValue)).toBe(setValue);
    removeSetting(extId, key);
    expect(getSetting(extId, key, defaultAfter as typeof setValue)).toBe(defaultAfter);
  });
});

// ============================================================================
// Extension isolation - settings don't leak between extensions
// ============================================================================

describe("extension isolation", () => {
  it.each([
    ["ext-1", "ext-2", "theme", "dark", "light", "default"],
    ["ext-a", "ext-b", "count", 10, 20, 0],
    ["ext-x", "ext-y", "enabled", true, false, false],
    ["org.foo", "org.bar", "setting", "foo-val", "bar-val", "none"],
    ["alpha", "beta", "mode", "alpha-mode", "beta-mode", "unknown"],
  ] as const)("ext1=%s ext2=%s key=%s are isolated", (ext1, ext2, key, val1, val2, defaultVal) => {
    setSetting(ext1, key, val1);
    setSetting(ext2, key, val2);
    expect(getSetting(ext1, key, defaultVal as typeof val1)).toBe(val1);
    expect(getSetting(ext2, key, defaultVal as typeof val2)).toBe(val2);
  });
});
