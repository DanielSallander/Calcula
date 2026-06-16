//! FILENAME: app/extensions/ScriptableObjects/lib/lineDiff.test.ts
// PURPOSE: Tests for the consent-prompt line diff (T3).

import { describe, it, expect } from "vitest";
import { lineDiff, changedLineCount } from "./lineDiff";

describe("lineDiff", () => {
  it("returns all 'same' rows for identical text", () => {
    const rows = lineDiff("a\nb\nc", "a\nb\nc");
    expect(rows.every((r) => r.type === "same")).toBe(true);
    expect(rows.map((r) => r.text)).toEqual(["a", "b", "c"]);
    expect(changedLineCount(rows)).toBe(0);
  });

  it("marks an added line as 'add', keeping context as 'same'", () => {
    const rows = lineDiff("a\nc", "a\nb\nc");
    expect(rows).toEqual([
      { type: "same", text: "a" },
      { type: "add", text: "b" },
      { type: "same", text: "c" },
    ]);
    expect(changedLineCount(rows)).toBe(1);
  });

  it("marks a removed line as 'del'", () => {
    const rows = lineDiff("a\nb\nc", "a\nc");
    expect(rows).toEqual([
      { type: "same", text: "a" },
      { type: "del", text: "b" },
      { type: "same", text: "c" },
    ]);
    expect(changedLineCount(rows)).toBe(1);
  });

  it("represents a modified line as a del + add pair", () => {
    const rows = lineDiff("x = 1", "x = 2");
    expect(rows).toContainEqual({ type: "del", text: "x = 1" });
    expect(rows).toContainEqual({ type: "add", text: "x = 2" });
    expect(changedLineCount(rows)).toBe(2);
  });

  it("handles a full rewrite (everything del then add)", () => {
    const rows = lineDiff("old", "new");
    expect(rows).toEqual([
      { type: "del", text: "old" },
      { type: "add", text: "new" },
    ]);
  });
});
