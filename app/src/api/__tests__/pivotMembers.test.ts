//! FILENAME: app/src/api/__tests__/pivotMembers.test.ts
// PURPOSE: @api/pivotMembers, the ONE reading of a member (P2 S7): identity
//          from the KEY, display from the LABEL. Under a de-DE app locale a
//          header that SHOWS "1234,5" is still the item "1234.5"; a date header
//          that shows "15.01.2024" is still "2024-01-15"; the blank member shows
//          "(Blank)" and is the item "". A cell the backend attached no member
//          to falls back to its value (BUG-0454: an unformatted numeric header
//          is "2013", never "").
// CONTEXT: The locales are THE shared Rust <-> TS corpus's
//          (core/engine/tests/fixtures/locale_text_corpus.json), installed
//          straight into the core active-locale slot.

import { describe, it, expect, afterEach } from "vitest";
import fs from "fs";
import path from "path";
import {
  pivotCellItemKey,
  pivotCellDisplayText,
  memberKeyNumber,
  memberKeyDate,
  memberKeys,
  memberLabelOf,
} from "../pivotMembers";
import type { PivotCellData } from "../pivotTypes";
import { setActiveLocale, resetActiveLocaleForTests, type LocaleSettings } from "../../core/lib/locale";

const CORPUS = path.resolve(__dirname, "../../../../core/engine/tests/fixtures/locale_text_corpus.json");

function useLocale(id: string): void {
  const raw = JSON.parse(fs.readFileSync(CORPUS, "utf8")) as { locales: Record<string, LocaleSettings> };
  const l = raw.locales[id];
  if (!l) throw new Error(`the corpus has no ${id}`);
  setActiveLocale(l);
}

function header(extra: Partial<PivotCellData>): PivotCellData {
  return { cellType: "RowHeader", value: null, backgroundStyle: "Normal", ...extra } as PivotCellData;
}

afterEach(() => resetActiveLocaleForTests());

describe("identity from the key even when the label differs", () => {
  it("a de-DE number header: shows 1234,5, IS 1234.5", () => {
    useLocale("de-DE");
    const cell = header({ value: 1234.5, member: { key: "1234.5", label: "1234,5" } });
    expect(pivotCellItemKey(cell)).toBe("1234.5");
    expect(pivotCellDisplayText(cell)).toBe("1234,5");
  });

  it("a de-DE date header: shows 15.01.2024, IS 2024-01-15", () => {
    useLocale("de-DE");
    const cell = header({ value: "2024-01-15", member: { key: "2024-01-15", label: "15.01.2024" } });
    expect(pivotCellItemKey(cell)).toBe("2024-01-15");
    expect(pivotCellDisplayText(cell)).toBe("15.01.2024");
  });

  it("the blank member (ruling Q8): shows (Blank), IS the key \"\" -- its header text reads (blank)", () => {
    const cell = header({ value: "(blank)", member: { key: "", label: "(Blank)" } });
    expect(pivotCellItemKey(cell)).toBe("");
    expect(pivotCellDisplayText(cell)).toBe("(Blank)");
  });

  it("a member wins over formattedValue on BOTH sides (identity never reads the formatted text)", () => {
    const cell = header({ value: 2013, formattedValue: "FY2013", member: { key: "2013", label: "2013" } });
    expect(pivotCellItemKey(cell)).toBe("2013");
    expect(pivotCellDisplayText(cell)).toBe("2013");
  });
});

describe("a cell with no member falls back to its value", () => {
  it("identity: the value as invariant text, whatever the app locale (BUG-0454)", () => {
    useLocale("de-DE");
    expect(pivotCellItemKey(header({ value: 2013 }))).toBe("2013");
    expect(pivotCellItemKey(header({ value: 1234.5, formattedValue: "1.234,50" }))).toBe("1234.5");
    expect(pivotCellItemKey(header({ value: "Europe" }))).toBe("Europe");
    expect(pivotCellItemKey(header({ value: true }))).toBe("TRUE");
    expect(pivotCellItemKey(header({ value: null }))).toBe("");
  });

  it("display: formattedValue, else the value in the APP locale", () => {
    useLocale("de-DE");
    expect(pivotCellDisplayText(header({ value: 1234.5, formattedValue: "1.234,50" }))).toBe("1.234,50");
    expect(pivotCellDisplayText(header({ value: 1234.5 }))).toBe("1234,5");
    expect(pivotCellDisplayText(header({ value: "Europe" }))).toBe("Europe");
    expect(pivotCellDisplayText(header({ value: Infinity }))).toBe("Infinity");
    resetActiveLocaleForTests();
    expect(pivotCellDisplayText(header({ value: 1234.5 }))).toBe("1234.5");
  });
});

describe("member keys are read INVARIANTLY, never in the app locale", () => {
  it("memberKeyNumber: the key's number; a label spelling or text is null", () => {
    useLocale("de-DE");
    expect(memberKeyNumber("3578.27")).toBe(3578.27);
    expect(memberKeyNumber("-0.5")).toBe(-0.5);
    expect(memberKeyNumber("1.234,5")).toBeNull();
    expect(memberKeyNumber("North")).toBeNull();
    expect(memberKeyNumber("")).toBeNull();
  });

  it("memberKeyDate: an ISO key's serial; a de-DE label is not a key", () => {
    useLocale("de-DE");
    expect(memberKeyDate("2024-01-15")).toBe(45306);
    expect(memberKeyDate("2024-01-15 12:00:00")).toBeCloseTo(45306.5, 9);
    expect(memberKeyDate("15.01.2024")).toBeNull();
    expect(memberKeyDate("")).toBeNull();
  });

  it("memberKeys / memberLabelOf: hold keys, show labels; an unknown key shows as itself", () => {
    const members = [
      { key: "2024-01-15", label: "15.01.2024" },
      { key: "", label: "(Blank)" },
    ];
    expect(memberKeys(members)).toEqual(["2024-01-15", ""]);
    const labelOf = memberLabelOf(members);
    expect(labelOf("2024-01-15")).toBe("15.01.2024");
    expect(labelOf("")).toBe("(Blank)");
    expect(labelOf("gone")).toBe("gone");
  });
});
