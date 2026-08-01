//! FILENAME: app/extensions/ScriptNotebook/lib/__tests__/notebookScaffold.test.ts
// PURPOSE: The "Test in notebook" door's input validation.
// CONTEXT: The payload arrives over a cross-window Tauri event as untyped IPC,
//          and becomes CELL SOURCE. It is never executed on arrival, but it is
//          still persisted into the workbook, so a malformed or oversized
//          payload must be rejected/capped rather than stored.

import { describe, it, expect } from "vitest";
import {
  normalizeScaffoldRequest,
  scaffoldCellSource,
} from "../notebookScaffold";
import { cellKindOf } from "../cellKind";

describe("normalizeScaffoldRequest", () => {
  it("accepts a well-formed request", () => {
    const r = normalizeScaffoldRequest({
      notebookName: "Model analysis",
      title: 'Measure "Revenue"',
      cells: [
        { kind: "markdown", source: "## Revenue" },
        { kind: "code", source: "model.query('c', {})" },
      ],
    });
    expect(r).not.toBeNull();
    expect(r!.cells).toHaveLength(2);
    expect(r!.cells[0].kind).toBe("markdown");
  });

  it("rejects non-objects, missing cells and empty cell lists", () => {
    for (const bad of [null, undefined, 7, "x", {}, { cells: [] }, { cells: "no" }]) {
      expect(normalizeScaffoldRequest(bad), String(bad)).toBeNull();
    }
  });

  it("defaults an unknown kind to code rather than trusting it", () => {
    const r = normalizeScaffoldRequest({ cells: [{ kind: "html", source: "x" }] });
    expect(r!.cells[0].kind).toBe("code");
  });

  it("drops cells whose source is not a string", () => {
    const r = normalizeScaffoldRequest({
      cells: [{ kind: "code", source: 42 }, { kind: "code", source: "ok" }],
    });
    expect(r!.cells).toHaveLength(1);
    expect(r!.cells[0].source).toBe("ok");
  });

  it("caps the number of cells and the size of each", () => {
    const cells = Array.from({ length: 40 }, () => ({
      kind: "code" as const,
      source: "x".repeat(50_000),
    }));
    const r = normalizeScaffoldRequest({ cells })!;
    expect(r.cells.length).toBeLessThanOrEqual(12);
    for (const c of r.cells) expect(c.source.length).toBeLessThanOrEqual(20_000);
  });

  it("supplies safe defaults for a missing name/title", () => {
    const r = normalizeScaffoldRequest({ cells: [{ kind: "code", source: "1" }] })!;
    expect(r.notebookName).toBe("Model analysis");
    expect(r.title).toBe("Scaffold");
  });
});

describe("scaffoldCellSource", () => {
  it("marks markdown cells so the runner skips them", () => {
    const source = scaffoldCellSource({ kind: "markdown", source: "# Notes" });
    expect(cellKindOf(source)).toBe("markdown");
  });

  it("leaves code cells alone", () => {
    const source = scaffoldCellSource({ kind: "code", source: "1 + 1" });
    expect(source).toBe("1 + 1");
    expect(cellKindOf(source)).toBe("code");
  });
});
