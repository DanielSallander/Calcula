//! FILENAME: app/extensions/Print/lib/__tests__/printHeaderFooter.test.ts
// PURPOSE: P2 S10 -- print and PDF header/footer codes &D and &T are the date
//          and time in the APP locale's patterns, never the WebView's own
//          locale (`toLocaleDateString()` printed "1/15/2024" in a de-DE app on
//          an English Windows).
// CONTEXT: Both generators keep their own replaceDynamicFields; each is pinned
//          here. The core page-layout copy is pinned by
//          src/core/lib/gridRenderer/printHeaderFooter.test.ts.

import { describe, it, expect, afterEach, vi } from "vitest";

vi.mock("jspdf", () => ({ jsPDF: class {} }));
vi.mock("@api/dialogs", () => ({ alertAsync: vi.fn(async () => {}) }));

import { replaceDynamicFields as pdfFields } from "../pdfGenerator";
import { replaceDynamicFields as printFields } from "../printGenerator";
import { useAppLocale, useInvariantLocale } from "../../../Charts/lib/__tests__/appLocaleTestKit";

/** 15 January 2024, 13:04:05 local time. */
const NOW = new Date(2024, 0, 15, 13, 4, 5);

afterEach(async () => {
  await useInvariantLocale();
});

describe("&D / &T in the app locale", () => {
  it("de-DE: the PDF generator writes DD.MM.YYYY and hh:mm:ss", async () => {
    await useAppLocale("de-DE");
    expect(pdfFields("Page &P of &N, &D &T", 2, 5, "Sheet1", NOW)).toBe("Page 2 of 5, 15.01.2024 13:04:05");
  });

  it("de-DE: the print generator writes the same", async () => {
    await useAppLocale("de-DE");
    expect(printFields("&A: &D &T", "Sales", NOW)).toBe("Sales: 15.01.2024 13:04:05");
  });

  it("sv-SE and en-US follow their own date order", async () => {
    await useAppLocale("sv-SE");
    expect(printFields("&D", "S", NOW)).toBe("2024-01-15");
    await useAppLocale("en-US");
    expect(pdfFields("&D", 1, 1, "S", NOW)).toBe("01/15/2024");
  });
});
