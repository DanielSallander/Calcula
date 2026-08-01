//! FILENAME: app/extensions/ScriptNotebook/lib/__tests__/cellKind.test.ts
// PURPOSE: Lock down the code/markdown cell-kind rule.
// CONTEXT: The kind lives in the cell SOURCE (a `//!markdown` first line), and
//          the RUST runner applies the same rule
//          (notebook_commands.rs::is_markdown_source). If these two ever
//          disagree, prose reaches QuickJS or a code cell silently stops
//          running — so the cases here mirror the Rust test module one for one.

import { describe, it, expect } from "vitest";
import {
  MARKDOWN_MARKER,
  cellKindOf,
  emptySourceForKind,
  isMarkdownCell,
  markdownBodyOf,
  withMarkdownMarker,
} from "../cellKind";

describe("cellKindOf", () => {
  it("recognizes the canonical marker", () => {
    expect(cellKindOf("//!markdown\n# Heading")).toBe("markdown");
  });

  it("tolerates indent, spacing, case and CRLF — same as the Rust runner", () => {
    for (const src of [
      "  //!markdown\ntext",
      "//! markdown\ntext",
      "//!MARKDOWN\ntext",
      "//!markdown   \ntext",
      "//!markdown\r\ntext",
      "//!markdown",
    ]) {
      expect(cellKindOf(src), src).toBe("markdown");
    }
  });

  it("only counts the marker on the FIRST line", () => {
    expect(cellKindOf("const x = 1;\n//!markdown\n")).toBe("code");
  });

  it("treats ordinary code and near-miss comments as code", () => {
    for (const src of [
      "",
      "1 + 1",
      "// markdown\nconst x = 1;",
      "//!markdownish\ntext",
      "//!md\ntext",
      "/*!markdown*/",
      "model.query('c', { measures: ['x'] })",
    ]) {
      expect(cellKindOf(src), src).toBe("code");
    }
  });
});

describe("markdown body round-trip", () => {
  it("strips and re-attaches the marker without touching the prose", () => {
    const body = "# Title\n\nSome *text* with `code`.\n";
    const source = withMarkdownMarker(body);
    expect(source.startsWith(MARKDOWN_MARKER)).toBe(true);
    expect(cellKindOf(source)).toBe("markdown");
    expect(markdownBodyOf(source)).toBe(body);
  });

  it("returns a code cell's source unchanged", () => {
    expect(markdownBodyOf("const x = 1;")).toBe("const x = 1;");
  });

  it("gives an empty body for a marker-only cell", () => {
    expect(markdownBodyOf(MARKDOWN_MARKER)).toBe("");
  });
});

describe("new-cell sources", () => {
  it("starts a code cell empty and a text cell marked", () => {
    expect(emptySourceForKind("code")).toBe("");
    expect(cellKindOf(emptySourceForKind("markdown"))).toBe("markdown");
  });

  it("isMarkdownCell reads the cell's source", () => {
    expect(isMarkdownCell({ source: "//!markdown\nhi" })).toBe(true);
    expect(isMarkdownCell({ source: "hi" })).toBe(false);
  });
});
