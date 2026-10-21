//! FILENAME: app/src/core/lib/locale/__tests__/localeText.corpus.test.ts
// PURPOSE: Assert the TypeScript locale text module against THE shared Rust <-> TS
//          corpus, core/engine/tests/fixtures/locale_text_corpus.json (P2 S1/S6).
// CONTEXT: The Rust suite (core/engine/src/locale_corpus_tests.rs) asserts the
//          very same rows against the engine AND pins the fixture's `locales`
//          section to `LocaleSettings::from_locale_id` + `calendar()`, so a TS
//          display that disagrees with the engine fails here. Every failing row
//          is reported at once, by index and JSON.

import { describe, it, expect } from "vitest";
import fs from "fs";
import path from "path";
import {
  formatNumberIn,
  formatNumberWithCodeIn,
  formatDateIn,
  parseNumberIn,
  parseDateIn,
  normalizeLocaleSettings,
} from "../index";
import type { DateStyle, LocaleSettings } from "../index";

interface CorpusRow {
  locale: string;
  op: "format" | "parse" | "parseDate" | "formatDate";
  input: number | string;
  code?: string;
  style?: DateStyle;
  expected: number | string | null;
}

const CORPUS_PATH = path.resolve(__dirname, "../../../../../../core/engine/tests/fixtures/locale_text_corpus.json");
const RAW = fs.readFileSync(CORPUS_PATH, "utf8");
const CORPUS = JSON.parse(RAW) as { locales: Record<string, LocaleSettings>; rows: CorpusRow[] };

function localeOf(id: string): LocaleSettings {
  const raw = CORPUS.locales[id];
  if (!raw) throw new Error(`corpus has no locale ${id}`);
  return normalizeLocaleSettings(raw);
}

function actual(row: CorpusRow): number | string | null {
  const locale = localeOf(row.locale);
  switch (row.op) {
    case "format": {
      const value = row.input as number;
      if (row.code !== undefined) {
        const res = formatNumberWithCodeIn(locale, value, row.code);
        if (!res.exact) return `<inexact: ${res.text}>`;
        return res.text;
      }
      return formatNumberIn(locale, value);
    }
    case "parse":
      return parseNumberIn(locale, row.input as string);
    case "parseDate":
      return parseDateIn(locale, row.input as string);
    case "formatDate":
      return formatDateIn(locale, row.input as number, row.style ?? "short");
    default:
      throw new Error(`unknown op ${(row as CorpusRow).op}`);
  }
}

function same(expected: CorpusRow["expected"], got: number | string | null): boolean {
  if (typeof expected === "number" && typeof got === "number") {
    return Math.abs(expected - got) <= 1e-9 * Math.max(Math.abs(expected), 1);
  }
  return expected === got;
}

describe("the shared locale text corpus (Rust <-> TypeScript)", () => {
  it("every corpus row matches the TypeScript formatter and parser", () => {
    const failures: string[] = [];
    CORPUS.rows.forEach((row, i) => {
      let got: number | string | null;
      try {
        got = actual(row);
      } catch (err) {
        failures.push(`row ${i}: ${JSON.stringify(row)} -> threw ${String(err)}`);
        return;
      }
      if (!same(row.expected, got)) {
        failures.push(`row ${i}: ${JSON.stringify(row)} -> TS gave ${JSON.stringify(got)}`);
      }
    });
    expect(failures, `${failures.length} of ${CORPUS.rows.length} rows disagree:\n${failures.join("\n")}`).toEqual([]);
  });

  it("the corpus is the full one, with the six locales and NBSP grouping intact", () => {
    expect(CORPUS.rows.length).toBeGreaterThanOrEqual(120);
    for (const id of ["en-US", "en-GB", "sv-SE", "de-DE", "de-CH", "fr-FR"]) {
      expect(CORPUS.locales[id]?.localeId).toBe(id);
      for (const op of ["format", "parse", "parseDate", "formatDate"]) {
        expect(CORPUS.rows.some((r) => r.locale === id && r.op === op), `${op} row for ${id}`).toBe(true);
      }
    }
    expect(CORPUS.locales["sv-SE"].thousandsSeparator).toBe(" ");
    expect(RAW.includes("\\u00A0")).toBe(true);
  });
});
