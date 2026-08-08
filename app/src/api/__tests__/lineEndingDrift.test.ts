//! FILENAME: app/src/api/__tests__/lineEndingDrift.test.ts
// PURPOSE: Keep the repository free of MIXED-line-ending files.
// CONTEXT: Seven files were mostly-CRLF with a handful of LF lines (or the
//          reverse). That is not cosmetic: an exact-string edit whose snippet
//          uses one ending finds no match in the other region and NO-OPS
//          without error — an edit that looks applied and changed nothing. The
//          rationale for policing this in the working tree rather than via
//          .gitattributes is in app/scripts/check-line-endings.mjs.

import { describe, it, expect } from "vitest";
// @ts-expect-error -- plain .mjs tool script, deliberately untyped
import { findMixedLineEndings, countEndings } from "../../../scripts/check-line-endings.mjs";

interface MixedFile {
  file: string;
  crlf: number;
  lf: number;
  dominant: "CRLF" | "LF";
}

describe("line-ending drift", () => {
  it("no source file mixes CRLF and LF", () => {
    const mixed = findMixedLineEndings() as MixedFile[];
    const report = mixed
      .map((m) => `  ${m.file}  CRLF=${m.crlf} LF=${m.lf}  (dominant: ${m.dominant})`)
      .join("\n");
    expect(
      mixed,
      mixed.length
        ? `Mixed line endings — exact-string edits against these can silently no-op.\n` +
            `${report}\n\nFix: node scripts/check-line-endings.mjs --fix`
        : "",
    ).toEqual([]);
  });

  // The detector itself, so a broken counter cannot report a false "clean".
  it("counts CRLF and LF without double-counting the LF inside a CRLF", () => {
    expect(countEndings(Buffer.from("a\r\nb\r\n"))).toEqual({ crlf: 2, lf: 0 });
    expect(countEndings(Buffer.from("a\nb\n"))).toEqual({ crlf: 0, lf: 2 });
    expect(countEndings(Buffer.from("a\r\nb\nc\r\n"))).toEqual({ crlf: 2, lf: 1 });
    expect(countEndings(Buffer.from("no newline"))).toEqual({ crlf: 0, lf: 0 });
  });
});
