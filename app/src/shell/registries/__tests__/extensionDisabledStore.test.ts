import { describe, it, expect, beforeEach } from "vitest";
import {
  DISABLED_STORAGE_KEY,
  loadDisabledIds,
  persistDisabledIds,
} from "../extensionDisabledStore";

describe("extensionDisabledStore (C7 disabled-set persistence)", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("returns an empty set when nothing is stored", () => {
    expect(loadDisabledIds().size).toBe(0);
  });

  it("round-trips a set of ids", () => {
    persistDisabledIds(new Set(["ext.a", "ext.b"]));
    const loaded = loadDisabledIds();
    expect(loaded.has("ext.a")).toBe(true);
    expect(loaded.has("ext.b")).toBe(true);
    expect(loaded.size).toBe(2);
  });

  it("persists as a JSON array under the documented key", () => {
    persistDisabledIds(new Set(["ext.only"]));
    expect(JSON.parse(localStorage.getItem(DISABLED_STORAGE_KEY)!)).toEqual(["ext.only"]);
  });

  it("an empty set persists as an empty array (re-enable clears it)", () => {
    persistDisabledIds(new Set(["ext.a"]));
    persistDisabledIds(new Set());
    expect(loadDisabledIds().size).toBe(0);
    expect(JSON.parse(localStorage.getItem(DISABLED_STORAGE_KEY)!)).toEqual([]);
  });

  it("tolerates corrupt JSON (returns empty set, no throw)", () => {
    localStorage.setItem(DISABLED_STORAGE_KEY, "{not json");
    expect(loadDisabledIds().size).toBe(0);
  });

  it("ignores a non-array payload", () => {
    localStorage.setItem(DISABLED_STORAGE_KEY, JSON.stringify({ a: 1 }));
    expect(loadDisabledIds().size).toBe(0);
  });

  it("filters out non-string entries in the array", () => {
    localStorage.setItem(DISABLED_STORAGE_KEY, JSON.stringify(["ok", 42, null, { x: 1 }, "ok2"]));
    const loaded = loadDisabledIds();
    expect([...loaded].sort()).toEqual(["ok", "ok2"]);
  });
});
