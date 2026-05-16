//! FILENAME: app/extensions/CsvImportExport/lib/__tests__/csv-i18n.test.ts
// PURPOSE: Tests for internationalization, unicode handling, and locale-sensitive CSV parsing.

import { describe, it, expect } from "vitest";
import {
  parseCsv,
  detectDelimiter,
  createDefaultParseOptions,
  type CsvParseOptions,
} from "../csvParser";

// ============================================================================
// Helper
// ============================================================================

function opts(overrides: Partial<CsvParseOptions> = {}): CsvParseOptions {
  return { delimiter: ",", textQualifier: '"', hasHeaders: false, skipRows: 0, ...overrides };
}

// ============================================================================
// European / Nordic text (Latin Extended)
// ============================================================================

describe("CSV with European/Nordic characters", () => {
  it("parses Swedish characters (å, ä, ö)", () => {
    const csv = "Namn,Stad\nÅsa,Göteborg\nÄlvsjö,Malmö";
    const rows = parseCsv(csv, opts());
    expect(rows).toEqual([
      ["Namn", "Stad"],
      ["Åsa", "Göteborg"],
      ["Älvsjö", "Malmö"],
    ]);
  });

  it("parses German characters (ü, ö, ä, ß)", () => {
    const csv = "Name,Stadt\nMüller,Düsseldorf\nStraße,München";
    const rows = parseCsv(csv, opts());
    expect(rows[1]).toEqual(["Müller", "Düsseldorf"]);
    expect(rows[2]).toEqual(["Straße", "München"]);
  });

  it("parses French accented characters (é, è, ê, ç, ñ)", () => {
    const csv = "Prénom,Café\nRené,Crème brûlée\nFrançois,Señor";
    const rows = parseCsv(csv, opts());
    expect(rows[1][0]).toBe("René");
    expect(rows[1][1]).toBe("Crème brûlée");
    expect(rows[2]).toEqual(["François", "Señor"]);
  });
});

// ============================================================================
// CJK characters
// ============================================================================

describe("CSV with CJK characters", () => {
  it("parses Chinese text", () => {
    const csv = "姓名,城市\n张三,北京\n李四,上海";
    const rows = parseCsv(csv, opts());
    expect(rows[1]).toEqual(["张三", "北京"]);
    expect(rows[2]).toEqual(["李四", "上海"]);
  });

  it("parses Japanese text (hiragana, katakana, kanji)", () => {
    const csv = "名前,都市\nたなか,東京\nスズキ,大阪";
    const rows = parseCsv(csv, opts());
    expect(rows[1]).toEqual(["たなか", "東京"]);
    expect(rows[2]).toEqual(["スズキ", "大阪"]);
  });

  it("parses Korean text", () => {
    const csv = "이름,도시\n김철수,서울\n박영희,부산";
    const rows = parseCsv(csv, opts());
    expect(rows[1]).toEqual(["김철수", "서울"]);
    expect(rows[2]).toEqual(["박영희", "부산"]);
  });

  it("handles quoted CJK fields containing delimiters", () => {
    const csv = '"张三,李四",北京';
    const rows = parseCsv(csv, opts());
    expect(rows[0]).toEqual(["张三,李四", "北京"]);
  });
});

// ============================================================================
// RTL text (Arabic, Hebrew)
// ============================================================================

describe("CSV with RTL text", () => {
  it("parses Arabic text", () => {
    const csv = "الاسم,المدينة\nأحمد,القاهرة\nفاطمة,الرياض";
    const rows = parseCsv(csv, opts());
    expect(rows[0]).toEqual(["الاسم", "المدينة"]);
    expect(rows[1]).toEqual(["أحمد", "القاهرة"]);
  });

  it("parses Hebrew text", () => {
    const csv = "שם,עיר\nדוד,ירושלים\nשרה,תל אביב";
    const rows = parseCsv(csv, opts());
    expect(rows[1]).toEqual(["דוד", "ירושלים"]);
    expect(rows[2]).toEqual(["שרה", "תל אביב"]);
  });

  it("handles mixed LTR and RTL in same field", () => {
    const csv = '"Hello مرحبا",World';
    const rows = parseCsv(csv, opts());
    expect(rows[0][0]).toBe("Hello مرحبا");
  });
});

// ============================================================================
// Emoji in cell values
// ============================================================================

describe("CSV with emoji", () => {
  it("parses simple emoji", () => {
    const csv = "Status,Item\n✅,Done\n❌,Failed";
    const rows = parseCsv(csv, opts());
    expect(rows[1]).toEqual(["✅", "Done"]);
    expect(rows[2]).toEqual(["❌", "Failed"]);
  });

  it("parses multi-codepoint emoji (flags, skin tones, ZWJ sequences)", () => {
    const csv = "Emoji,Label\n🇸🇪,Sweden\n👨‍👩‍👧‍👦,Family\n👍🏽,Thumbs Up";
    const rows = parseCsv(csv, opts());
    expect(rows[1][0]).toBe("🇸🇪");
    expect(rows[2][0]).toBe("👨‍👩‍👧‍👦");
    expect(rows[3][0]).toBe("👍🏽");
  });

  it("handles emoji inside quoted fields", () => {
    const csv = '"🎉 Party, everyone!",2024';
    const rows = parseCsv(csv, opts());
    expect(rows[0][0]).toBe("🎉 Party, everyone!");
  });
});

// ============================================================================
// Decimal separators (locale-sensitive)
// ============================================================================

describe("decimal and thousands separator handling", () => {
  it("comma-decimal locale defaults to semicolon delimiter", () => {
    const options = createDefaultParseOptions(",");
    expect(options.delimiter).toBe(";");
  });

  it("period-decimal locale defaults to comma delimiter", () => {
    const options = createDefaultParseOptions(".");
    expect(options.delimiter).toBe(",");
  });

  it("parses European-style CSV with semicolon delimiter", () => {
    const csv = "Produkt;Pris\nMjölk;12,50\nBröd;34,90";
    const rows = parseCsv(csv, opts({ delimiter: ";" }));
    expect(rows[1]).toEqual(["Mjölk", "12,50"]);
    expect(rows[2]).toEqual(["Bröd", "34,90"]);
  });

  it("detects semicolon delimiter in European-style CSV", () => {
    const csv = "A;B;C\n1;2;3\n4;5;6";
    expect(detectDelimiter(csv)).toBe(";");
  });

  it("comma in numeric values does not break semicolon-delimited CSV", () => {
    const csv = "Name;Amount\nTest;1.234,56\nOther;7.890,12";
    const rows = parseCsv(csv, opts({ delimiter: ";" }));
    expect(rows[1][1]).toBe("1.234,56");
  });
});

// ============================================================================
// Date formats across locales
// ============================================================================

describe("date format values in CSV", () => {
  it("preserves ISO date strings", () => {
    const csv = "Date,Value\n2024-01-15,100\n2024-12-31,200";
    const rows = parseCsv(csv, opts());
    expect(rows[1][0]).toBe("2024-01-15");
  });

  it("preserves US date format (MM/DD/YYYY)", () => {
    const csv = "Date,Value\n01/15/2024,100";
    const rows = parseCsv(csv, opts());
    expect(rows[1][0]).toBe("01/15/2024");
  });

  it("preserves European date format (DD.MM.YYYY) in semicolon CSV", () => {
    const csv = "Datum;Wert\n15.01.2024;100\n31.12.2024;200";
    const rows = parseCsv(csv, opts({ delimiter: ";" }));
    expect(rows[1][0]).toBe("15.01.2024");
  });

  it("preserves Swedish date format (YYYY-MM-DD) with comma-decimal values", () => {
    const csv = "Datum;Belopp\n2024-01-15;1 234,50\n2024-12-31;9 876,00";
    const rows = parseCsv(csv, opts({ delimiter: ";" }));
    expect(rows[1]).toEqual(["2024-01-15", "1 234,50"]);
  });
});

// ============================================================================
// BOM handling
// ============================================================================

describe("BOM (Byte Order Mark) handling", () => {
  it("parses CSV with UTF-8 BOM prefix", () => {
    const bom = "\uFEFF";
    const csv = bom + "Name,Value\nAlice,100";
    const rows = parseCsv(csv, opts());
    // The BOM character will be part of the first field
    // This test documents the current behavior
    expect(rows[0][0]).toBe("\uFEFFName");
    expect(rows[1]).toEqual(["Alice", "100"]);
  });

  it("BOM does not affect delimiter detection", () => {
    const bom = "\uFEFF";
    const csv = bom + "A;B;C\n1;2;3\n4;5;6";
    expect(detectDelimiter(csv)).toBe(";");
  });

  it("BOM in middle of file is treated as regular character", () => {
    const csv = "A,B\nHello\uFEFF,World";
    const rows = parseCsv(csv, opts());
    expect(rows[1][0]).toBe("Hello\uFEFF");
  });
});
