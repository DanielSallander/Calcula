//! FILENAME: app/src/api/__tests__/csvText.test.ts
// PURPOSE: Parity cover for the shared CSV module (@api/csvText) — the ONE
//          parser/serializer behind the CsvImportExport dialogs, the worker's
//          api.text helpers, and (by mirrored fixtures) the Rust QuickJS
//          realm's Calcula.text ops.
// CONTEXT: The parse/serialize tables below are the SAME cases, case for case,
//          as core/script-engine/src/ops/text.rs `parse_table_driven_parity_
//          with_ts` / `to_csv_table_driven_parity_with_ts`. If either side
//          changes behavior, one of the two suites fails — that is the pin
//          that keeps the realms agreeing about what a CSV means.

import { describe, it, expect } from "vitest";
import {
  parseCsvText,
  toCsvText,
  scriptParseCsv,
  scriptToCsv,
} from "../csvText";

describe("parseCsvText — fixture parity with ops/text.rs", () => {
  // (input, delimiter, quote, expected) — mirrors the Rust table exactly.
  const cases: Array<[string, string, string | null, string[][]]> = [
    // simple rows, LF
    ["a,b,c\n1,2,3", ",", '"', [["a", "b", "c"], ["1", "2", "3"]]],
    // CRLF line endings
    ["a,b\r\nc,d", ",", '"', [["a", "b"], ["c", "d"]]],
    // bare CR line endings
    ["a,b\rc,d", ",", '"', [["a", "b"], ["c", "d"]]],
    // trailing newline does not create a phantom row
    ["a,b\n", ",", '"', [["a", "b"]]],
    // quoted field containing the delimiter
    ['"a,b",c', ",", '"', [["a,b", "c"]]],
    // escaped (doubled) quote inside a quoted field
    ['"He said ""hi""",x', ",", '"', [['He said "hi"', "x"]]],
    // newline inside a quoted field stays in the field
    ['"line1\nline2",b', ",", '"', [["line1\nline2", "b"]]],
    // CRLF inside a quoted field stays in the field (verbatim)
    ['"line1\r\nline2",b', ",", '"', [["line1\r\nline2", "b"]]],
    // empty fields
    ["a,,c", ",", '"', [["a", "", "c"]]],
    // empty leading/trailing fields
    [",a,", ",", '"', [["", "a", ""]]],
    // empty line in the middle IS a row with one empty field
    ["a\n\nb", ",", '"', [["a"], [""], ["b"]]],
    // quote in the MIDDLE of an unquoted field is literal
    ['ab"cd,e', ",", '"', [['ab"cd', "e"]]],
    // semicolon delimiter (sv-SE style)
    ["a;b;c", ";", '"', [["a", "b", "c"]]],
    // tab delimiter
    ["a\tb\tc", "\t", '"', [["a", "b", "c"]]],
    // quoting disabled: quotes are literal characters
    ['"a",b', ",", null, [['"a"', "b"]]],
    // empty input = no rows
    ["", ",", '"', []],
    // quoted empty field
    ['"",b', ",", '"', [["", "b"]]],
    // unterminated quote runs to end of input
    ['"abc', ",", '"', [["abc"]]],
  ];

  it.each(cases)("parses %j (delimiter %j, quote %j)", (input, delimiter, quote, expected) => {
    expect(parseCsvText(input, delimiter, quote)).toEqual(expected);
  });
});

describe("toCsvText — fixture parity with ops/text.rs", () => {
  // (rows, delimiter, quote, lineEnding, expected) — mirrors the Rust table.
  const cases: Array<[string[][], string, string, string, string]> = [
    [[["a", "b"], ["1", "2"]], ",", '"', "\r\n", "a,b\r\n1,2"],
    // field containing the delimiter is quoted
    [[["a,b", "c"]], ",", '"', "\r\n", '"a,b",c'],
    // field containing a quote is quoted with the quote doubled
    [[['He said "hi"', "x"]], ",", '"', "\r\n", '"He said ""hi""",x'],
    // field containing a newline is quoted
    [[["line1\nline2", "b"]], ",", '"', "\r\n", '"line1\nline2",b'],
    // custom line ending
    [[["a"], ["b"]], ",", '"', "\n", "a\nb"],
    // semicolon delimiter: comma no longer forces quoting, semicolon does
    [[["a,b", "c;d"]], ";", '"', "\r\n", 'a,b;"c;d"'],
    // empty rows list
    [[], ",", '"', "\r\n", ""],
  ];

  it.each(cases)("serializes %j (delimiter %j)", (rows, delimiter, quote, ending, expected) => {
    expect(toCsvText(rows, delimiter, quote, ending)).toBe(expected);
  });

  it("round-trips through parse (identity)", () => {
    const original = [
      ["plain", "with,comma", 'with"quote'],
      ["multi\nline", "", "tail"],
    ];
    const text = toCsvText(original, ",", '"', "\r\n");
    expect(parseCsvText(text, ",", '"')).toEqual(original);
  });
});

describe("scriptParseCsv — the api.text.parseCsv wrapper", () => {
  it("splits headers off when asked (Rust js_parse_csv_returns_rows_and_headers)", () => {
    const r = scriptParseCsv('name,age\r\n"Doe, Jane",42\n', { hasHeaders: true });
    expect(r.headers).toEqual(["name", "age"]);
    expect(r.rows).toEqual([["Doe, Jane", "42"]]);
    const plain = scriptParseCsv("a;b", { delimiter: ";" });
    expect(plain.rows).toEqual([["a", "b"]]);
    expect(plain.headers).toBeUndefined();
  });

  it("hasHeaders on empty input yields empty headers AND empty rows", () => {
    const r = scriptParseCsv("", { hasHeaders: true });
    expect(r.headers).toEqual([]);
    expect(r.rows).toEqual([]);
  });

  it('quote: "" disables quoting', () => {
    expect(scriptParseCsv('"a",b', { quote: "" }).rows).toEqual([['"a"', "b"]]);
  });

  it("rejects a multi-character delimiter, naming the option", () => {
    expect(() => scriptParseCsv("a,b", { delimiter: ",," })).toThrow(/delimiter/);
    expect(() => scriptParseCsv("a,b", { delimiter: ",," })).toThrow("must be exactly one character");
  });

  it("rejects an empty delimiter (only quote may be empty)", () => {
    expect(() => scriptParseCsv("a,b", { delimiter: "" })).toThrow("delimiter must be exactly one character");
  });

  it("rejects a non-string delimiter with the Rust wording", () => {
    expect(() => scriptParseCsv("a,b", { delimiter: 5 as unknown as string })).toThrow(
      "delimiter must be a string",
    );
  });
});

describe("scriptToCsv — the api.text.toCsv wrapper", () => {
  it("coerces cells like the Rust twin (js_to_csv_serializes_and_quotes)", () => {
    expect(scriptToCsv([["a,b", 1, true, null]])).toBe('"a,b",1,true,');
    expect(scriptToCsv([["x"], ["y"]], { lineEnding: "\n" })).toBe("x\ny");
    expect(scriptToCsv([[1.5, 2]], { delimiter: ";", headers: ["v", "w"] })).toBe("v;w\r\n1.5;2");
  });

  it("round-trips via both wrappers (js_roundtrip_via_both_ops)", () => {
    const rows = [["a", "b,c"], ['d"e', ""]];
    const text = scriptToCsv(rows);
    expect(scriptParseCsv(text).rows).toEqual(rows);
  });

  it("rejects a bad lineEnding with the Rust wording", () => {
    expect(() => scriptToCsv([["a"]], { lineEnding: ";" })).toThrow(
      'lineEnding must be "\\r\\n", "\\n" or "\\r"',
    );
  });

  it("rejects non-array rows / headers", () => {
    expect(() => scriptToCsv("a" as unknown as string[][])).toThrow("toCsv rows must be an array of arrays");
    expect(() => scriptToCsv([["a"]], { headers: "h" as unknown as string[] })).toThrow(
      "headers must be an array",
    );
  });

  it("refuses an empty quote (a serializer must be able to escape)", () => {
    expect(() => scriptToCsv([["a"]], { quote: "" })).toThrow("quote must be exactly one character");
  });
});
