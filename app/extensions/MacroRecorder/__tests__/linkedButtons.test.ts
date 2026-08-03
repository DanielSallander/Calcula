//! FILENAME: app/extensions/MacroRecorder/__tests__/linkedButtons.test.ts
// PURPOSE: Deleting a macro that ≥1 button LINKS must warn, naming the buttons —
//          never silently orphan them. This pins the warning wording.
// CONTEXT: Silent orphaning is the recurring failure this whole feature fought.
//          The confirm text is derived by a pure function so it is testable
//          without a backend; the actual scan is a Rust command tested there.

import { describe, it, expect } from "vitest";
import {
  describeMacroDeletion,
  type MacroLinkingControl,
} from "../lib/linkedButtons";

const at = (sheetName: string, row: number, col: number): MacroLinkingControl => ({
  sheetIndex: 0,
  sheetName,
  row,
  col,
});

describe("describeMacroDeletion", () => {
  it("returns null when nothing links the macro (plain confirm is used)", () => {
    expect(describeMacroDeletion("Macro1", [])).toBeNull();
  });

  it("names a single linking button by sheet + A1 anchor", () => {
    const msg = describeMacroDeletion("Macro1", [at("Sheet1", 0, 0)])!;
    expect(msg).toContain("Macro1");
    expect(msg).toContain("Sheet1!A1");
    expect(msg).toMatch(/1 button links/);
    expect(msg).toMatch(/nothing to run/i);
    expect(msg).toMatch(/Delete anyway\?/);
  });

  it("pluralises and lists multiple anchors, with an exact count", () => {
    const msg = describeMacroDeletion("Macro1", [
      at("Sheet1", 0, 0),
      at("Sheet2", 2, 27), // AB3
    ])!;
    expect(msg).toMatch(/2 buttons link/);
    expect(msg).toContain("Sheet1!A1");
    expect(msg).toContain("Sheet2!AB3");
  });

  it("caps the shown anchors but keeps the count exact", () => {
    const many: MacroLinkingControl[] = Array.from({ length: 10 }, (_, i) =>
      at("Sheet1", i, 0),
    );
    const msg = describeMacroDeletion("Macro1", many)!;
    expect(msg).toMatch(/10 buttons link/);
    // Only a handful of anchors are enumerated, then an ellipsis.
    expect(msg).toContain(", …");
  });
});
