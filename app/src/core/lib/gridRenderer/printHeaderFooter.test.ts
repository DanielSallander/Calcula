//! FILENAME: app/src/core/lib/gridRenderer/printHeaderFooter.test.ts
// PURPOSE: P2 S10 -- the page-layout view's header/footer codes &D and &T are
//          today's date and time in the APP locale's patterns. They used to be
//          `toLocaleDateString()` / `toLocaleTimeString()`, i.e. the WebView's
//          own locale, so a de-DE app on an English Windows printed "1/15/2024"
//          over cells that read "15.01.2024".
// CONTEXT: The Print extension's own two copies (pdfGenerator, printGenerator)
//          are pinned by extensions/Print/lib/__tests__/printHeaderFooter.test.ts.
//          The locales come from the shared Rust <-> TS corpus.

import { describe, it, expect, afterEach } from "vitest";
import fs from "fs";
import path from "path";
import { parseHeaderFooter } from "./core";
import { setActiveLocale, resetActiveLocaleForTests, type LocaleSettings } from "../locale";

const corpus = JSON.parse(
  fs.readFileSync(path.resolve(__dirname, "../../../../../core/engine/tests/fixtures/locale_text_corpus.json"), "utf8"),
) as { locales: Record<string, LocaleSettings> };

/** 15 January 2024, 13:04:05 local time. */
const NOW = new Date(2024, 0, 15, 13, 4, 5);

afterEach(() => {
  resetActiveLocaleForTests();
});

describe("parseHeaderFooter &D / &T", () => {
  it("de-DE: &D follows the locale date_format (DD.MM.YYYY), &T its time_format", () => {
    setActiveLocale(corpus.locales["de-DE"]);
    const parts = parseHeaderFooter("&LPrinted &D&R&T", NOW);
    expect(parts.left).toBe("Printed 15.01.2024");
    expect(parts.right).toBe("13:04:05");
  });

  it("sv-SE: ISO date order", () => {
    setActiveLocale(corpus.locales["sv-SE"]);
    expect(parseHeaderFooter("&C&D", NOW).center).toBe("2024-01-15");
  });

  it("en-US: month first and a 12-hour clock", () => {
    setActiveLocale(corpus.locales["en-US"]);
    const parts = parseHeaderFooter("&C&D &T", NOW);
    expect(parts.center).toBe("01/15/2024 1:04:05 PM");
  });

  it("a $ in the date pattern's output is inserted literally (no replacement-pattern expansion)", () => {
    setActiveLocale({ ...corpus.locales["de-DE"], dateFormat: "DD.MM.YYYY" });
    expect(parseHeaderFooter("&C$&D$", NOW).center).toBe("$15.01.2024$");
  });
});
