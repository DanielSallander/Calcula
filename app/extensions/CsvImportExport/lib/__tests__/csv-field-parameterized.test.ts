//! FILENAME: app/extensions/CsvImportExport/lib/__tests__/csv-field-parameterized.test.ts
// PURPOSE: Parameterized tests for single-field CSV edge cases, export round-trip, and delimiter detection.
// TARGET: 130+ test cases via it.each.

import { describe, it, expect } from "vitest";
import { parseCsv, detectDelimiter, CsvParseOptions } from "../csvParser";
import { exportToCsv, CsvExportOptions } from "../csvExporter";

// ============================================================================
// Helpers
// ============================================================================

function defaultParseOpts(overrides: Partial<CsvParseOptions> = {}): CsvParseOptions {
  return {
    delimiter: ",",
    textQualifier: '"',
    hasHeaders: false,
    skipRows: 0,
    ...overrides,
  };
}

function defaultExportOpts(overrides: Partial<CsvExportOptions> = {}): CsvExportOptions {
  return {
    delimiter: ",",
    textQualifier: '"',
    lineEnding: "\r\n",
    ...overrides,
  };
}

// ============================================================================
// 1. parseCsv single-field edge cases: 50 inputs
// ============================================================================

describe("parseCsv single-field edge cases - 50 inputs", () => {

  const singleFieldCases: [string, string, string][] = [
    // [description, csv input, expected first field value]
    ["simple word", "hello", "hello"],
    ["number", "42", "42"],
    ["decimal", "3.14", "3.14"],
    ["negative number", "-7", "-7"],
    ["empty string", "", ""],
    ["single space", " ", " "],
    ["multiple spaces", "   ", "   "],
    ["tab character", "\t", "\t"],
    ["quoted simple", '"hello"', "hello"],
    ["quoted with comma", '"hello,world"', "hello,world"],
    ["quoted with delimiter", '"a,b"', "a,b"],
    ["quoted with newline", '"line1\nline2"', "line1\nline2"],
    ["quoted with CRLF", '"line1\r\nline2"', "line1\r\nline2"],
    ["escaped quote", '"say ""hi"""', 'say "hi"'],
    ["double escaped quotes", '"""quoted"""', '"quoted"'],
    ["only escaped quote", '""""', '"'],
    ["quoted with spaces", '"  hello  "', "  hello  "],
    ["quoted space", '" "', " "],
    ["quoted tabs", '"\t\t"', "\t\t"],
    ["unquoted trailing space", "abc ", "abc "],
    ["unquoted leading space", " abc", " abc"],
    ["all digits", "1234567890", "1234567890"],
    ["scientific notation", "1.5e10", "1.5e10"],
    ["zero", "0", "0"],
    ["boolean-like true", "true", "true"],
    ["boolean-like false", "false", "false"],
    ["null-like", "null", "null"],
    ["undefined-like", "undefined", "undefined"],
    ["hash", "#comment", "#comment"],
    ["at sign", "@mention", "@mention"],
    ["url-like", "http://example.com", "http://example.com"],
    ["email-like", "user@test.com", "user@test.com"],
    ["path-like", "C:\\Users\\test", "C:\\Users\\test"],
    ["forward slashes", "a/b/c", "a/b/c"],
    ["parentheses", "(test)", "(test)"],
    ["brackets", "[test]", "[test]"],
    ["curly braces", "{test}", "{test}"],
    ["ampersand", "a&b", "a&b"],
    ["pipe", "a|b", "a|b"],
    ["equals", "a=b", "a=b"],
    ["plus", "a+b", "a+b"],
    ["asterisk", "a*b", "a*b"],
    ["exclamation", "hello!", "hello!"],
    ["question mark", "hello?", "hello?"],
    ["semicolon (not delimiter)", "a;b", "a;b"],
    ["colon", "a:b", "a:b"],
    ["single char", "x", "x"],
    ["unicode word", "Strassburg", "Strassburg"],
    ["mixed case", "AbCdEf", "AbCdEf"],
    ["long string", "a".repeat(1000), "a".repeat(1000)],
  ];

  it.each(singleFieldCases)(
    "parses single field: %s",
    (_desc, input, expected) => {
      // Handle the empty-string case: parseCsv on "" returns [] (trailing empty row suppressed)
      if (input === "") {
        const result = parseCsv(input, defaultParseOpts());
        expect(result).toHaveLength(0);
        return;
      }
      const result = parseCsv(input, defaultParseOpts());
      expect(result.length).toBeGreaterThanOrEqual(1);
      expect(result[0][0]).toBe(expected);
    },
  );
});

// ============================================================================
// 2. exportToCsv round-trip: same 50 values
// ============================================================================

describe("exportToCsv round-trip - 50 values", () => {

  const roundTripValues: [string, string][] = [
    ["simple word", "hello"],
    ["number", "42"],
    ["decimal", "3.14"],
    ["negative", "-7"],
    ["single space", " "],
    ["with comma", "hello,world"],
    ["with delimiter inside", "a,b,c"],
    ["with newline", "line1\nline2"],
    ["with CRLF", "line1\r\nline2"],
    ["with quote", 'say "hi"'],
    ["double quotes", '"quoted"'],
    ["just a quote", '"'],
    ["tabs", "\t\t"],
    ["trailing space", "abc "],
    ["leading space", " abc"],
    ["all digits", "1234567890"],
    ["scientific notation", "1.5e10"],
    ["zero", "0"],
    ["true", "true"],
    ["false", "false"],
    ["null", "null"],
    ["hash", "#comment"],
    ["at sign", "@mention"],
    ["url", "http://example.com"],
    ["email", "user@test.com"],
    ["path", "C:\\Users\\test"],
    ["forward slashes", "a/b/c"],
    ["parentheses", "(test)"],
    ["brackets", "[test]"],
    ["braces", "{test}"],
    ["ampersand", "a&b"],
    ["pipe", "a|b"],
    ["equals", "a=b"],
    ["plus", "a+b"],
    ["asterisk", "a*b"],
    ["exclamation", "hello!"],
    ["question", "hello?"],
    ["semicolon", "a;b"],
    ["colon", "a:b"],
    ["single char", "x"],
    ["long string", "b".repeat(500)],
    ["mixed special", "a,b\"c\nd"],
    ["triple quotes", '"""'],
    ["comma and newline", ",\n"],
    ["delimiter only", ","],
    ["multiple commas", ",,,"],
    ["space comma space", " , "],
    ["backslash", "\\"],
  ];

  it.each(roundTripValues)(
    "round-trip for value: %s",
    (_desc, value) => {
      const data = [[value]];
      const exportOpts = defaultExportOpts();
      const csv = exportToCsv(data, exportOpts);

      const parseOpts = defaultParseOpts();
      const parsed = parseCsv(csv, parseOpts);

      expect(parsed.length).toBeGreaterThanOrEqual(1);
      expect(parsed[0][0]).toBe(value);
    },
  );
});

// ============================================================================
// 3. detectDelimiter: 30 file contents
// ============================================================================

describe("detectDelimiter - 30 cases", () => {

  const delimiterCases: [string, string, string][] = [
    // [description, file content, expected delimiter]
    ["basic comma CSV", "a,b,c\n1,2,3\n4,5,6", ","],
    ["basic semicolon CSV", "a;b;c\n1;2;3\n4;5;6", ";"],
    ["basic tab CSV", "a\tb\tc\n1\t2\t3\n4\t5\t6", "\t"],
    ["basic pipe CSV", "a|b|c\n1|2|3\n4|5|6", "|"],
    ["comma with quoted fields", '"a","b","c"\n"1","2","3"', ","],
    ["semicolon with quoted", '"a";"b";"c"\n"1";"2";"3"', ";"],
    ["two columns comma", "a,b\n1,2\n3,4", ","],
    ["two columns semicolon", "a;b\n1;2\n3;4", ";"],
    ["single column (no delimiters)", "a\nb\nc", ","],
    ["comma more frequent than semi", "a,b,c,d\n1,2,3,4", ","],
    ["semi more frequent than comma", "a;b;c;d;e\n1;2;3;4;5", ";"],
    ["tab more frequent", "a\tb\tc\td\n1\t2\t3\t4", "\t"],
    ["pipe more frequent", "a|b|c|d\n1|2|3|4", "|"],
    ["mixed but comma consistent", "a,b,c\nd,e,f\ng,h,i", ","],
    ["mixed but semicolon consistent", "a;b;c\nd;e;f\ng;h;i", ";"],
    ["one line comma", "a,b,c", ","],
    ["one line semicolon", "a;b;c", ";"],
    ["one line tab", "a\tb\tc", "\t"],
    ["one line pipe", "a|b|c", "|"],
    ["empty lines between", "a,b\n\nc,d", ","],
    ["many columns comma", "a,b,c,d,e,f,g\n1,2,3,4,5,6,7", ","],
    ["quoted comma inside semicolon CSV", '"a,b";c;d\n"e,f";g;h', ";"],
    ["quoted semicolon inside comma CSV", '"a;b",c,d\n"e;f",g,h', ","],
    ["CRLF line endings", "a,b,c\r\n1,2,3\r\n4,5,6", ","],
    ["only whitespace", "   \n   ", ","],
    ["empty input", "", ","],
    ["single value", "hello", ","],
    ["numbers comma", "1,2,3\n4,5,6\n7,8,9", ","],
    ["numbers semicolon", "1;2;3\n4;5;6\n7;8;9", ";"],
    ["wide tab file", "col1\tcol2\tcol3\tcol4\tcol5\nv1\tv2\tv3\tv4\tv5", "\t"],
  ];

  it.each(delimiterCases)(
    "detects delimiter: %s",
    (_desc, content, expected) => {
      const result = detectDelimiter(content);
      expect(result).toBe(expected);
    },
  );
});
