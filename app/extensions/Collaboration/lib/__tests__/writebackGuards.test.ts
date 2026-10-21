// FILENAME: app/extensions/Collaboration/lib/__tests__/writebackGuards.test.ts
// PURPOSE: The writeback range-guard decision (a single-cell EDIT passes so the
//          commit guard can save a draft; paste/fill/move -- even 1x1 -- is
//          refused with a user-language message) and the commit guard's
//          locale-aware coercion.

import { describe, it, expect } from "vitest";
import {
  decideWritebackRangeGuard,
  coerceWritebackInput,
  writebackBulkRefusalMessage,
} from "../writebackGuards";
import type { WritebackRegionEntry } from "@api/collaboration";

const region = {
  sheetId: "s",
  sheetIndex: 0,
  regionId: "r1",
  packageName: "writeback-test",
  rowStart: 2,
  rowEnd: 4,
  colStart: 1,
  colEnd: 1,
} as WritebackRegionEntry;

describe("decideWritebackRangeGuard", () => {
  it("allows anything that touches no region", () => {
    expect(decideWritebackRangeGuard(null, 0, 0, 9, 9, "other")).toBeNull();
  });

  it("allows a single-cell edit on a writeback cell", () => {
    expect(decideWritebackRangeGuard(region, 3, 1, 3, 1, "edit")).toBeNull();
  });

  it("refuses a 1x1 paste (it would bypass the draft path)", () => {
    expect(decideWritebackRangeGuard(region, 3, 1, 3, 1, "other")).toEqual({
      blocked: true,
      message: writebackBulkRefusalMessage("writeback-test"),
    });
  });

  it("refuses an operation kind a caller did not state", () => {
    expect(decideWritebackRangeGuard(region, 3, 1, 3, 1, undefined)?.blocked).toBe(true);
  });

  it("refuses a multi-cell range even when labelled an edit", () => {
    expect(decideWritebackRangeGuard(region, 2, 1, 4, 1, "edit")?.blocked).toBe(true);
  });

  it("says what the cells are for and what to do, never 'future version'", () => {
    const msg = decideWritebackRangeGuard(region, 2, 0, 4, 3, "other")!.message;
    expect(msg).toBe(
      'These cells collect input for "writeback-test". Type into them one cell at a time; ' +
        "paste and fill are not supported for writeback cells.",
    );
    expect(msg).not.toMatch(/future version/i);
    expect(writebackBulkRefusalMessage("")).toContain("input for the application.");
  });
});

describe("coerceWritebackInput", () => {
  // sv-SE: decimal comma, space thousands.
  const svParse = {
    parseNumber: (t: string) => {
      const s = t.trim().replace(/\s/g, "");
      if (!/^[+-]?\d+(,\d+)?$/.test(s)) return null;
      return Number(s.replace(",", "."));
    },
  };

  it("reads a number in the APP locale", () => {
    expect(coerceWritebackInput("1,5", "number", svParse)).toEqual({ type: "number", value: 1.5 });
  });

  it("sends unparseable number input as text for the backend to refuse", () => {
    expect(coerceWritebackInput("abc", "number", svParse)).toEqual({ type: "text", value: "abc" });
  });

  it("never sends a non-finite number", () => {
    const inf = { parseNumber: () => Infinity };
    expect(coerceWritebackInput("1e999", "number", inf)).toEqual({ type: "text", value: "1e999" });
  });

  it("an empty entry is a pending retraction", () => {
    expect(coerceWritebackInput("   ", "number", svParse)).toEqual({ type: "empty" });
  });

  it("keeps TRUE/FALSE for booleans, case-insensitive", () => {
    expect(coerceWritebackInput("true", "boolean", svParse)).toEqual({ type: "boolean", value: true });
    expect(coerceWritebackInput("FALSE", "boolean", svParse)).toEqual({ type: "boolean", value: false });
    expect(coerceWritebackInput("ja", "boolean", svParse)).toEqual({ type: "text", value: "ja" });
  });

  it("a declared text region keeps a numeric-looking code as text", () => {
    expect(coerceWritebackInput("12345", "text", svParse)).toEqual({ type: "text", value: "12345" });
  });

  it("an untyped region sniffs in the app locale but keeps leading-zero codes", () => {
    expect(coerceWritebackInput("2,25", undefined, svParse)).toEqual({ type: "number", value: 2.25 });
    expect(coerceWritebackInput("00123", undefined, svParse)).toEqual({ type: "text", value: "00123" });
    expect(coerceWritebackInput("true", undefined, svParse)).toEqual({ type: "boolean", value: true });
  });
});
