//! FILENAME: app/src/api/scriptHost/__tests__/textRotationValidator.test.ts
// PURPOSE: The script gate's `textRotation` vocabulary is the backend's
//          (`parse_text_rotation`, app/src-tauri/src/commands/styles.rs):
//          "none" | "rotate90" | "rotate270" | "vertical" | "custom:N" with an
//          integer N in -90..90.
// CONTEXT: The gate used to accept only the first three. The macro recorder
//          records every applyFormatting call verbatim, so a recorded Home >
//          Orientation > "Angle Counterclockwise" ("custom:45") or "Vertical
//          Text" ("vertical") was REFUSED on replay (survey alignment.md
//          section 1). Out-of-range and malformed values stay refused here,
//          before the backend's own refusal.

import { describe, it, expect } from "vitest";
import { checkFormatObject } from "../validators";

describe("textRotation: the Orientation menu's whole vocabulary", () => {
  it("accepts every value the Orientation menu and Format Cells send", () => {
    for (const value of [
      "none",
      "rotate90",
      "rotate270",
      "vertical",
      "custom:45",
      "custom:-45",
      "custom:0",
      "custom:90",
      "custom:-90",
      "custom:1",
    ]) {
      expect(checkFormatObject({ textRotation: value }), value).toBe(true);
    }
  });

  it("refuses angles outside -90..90, non-integers, and anything else", () => {
    for (const value of [
      "custom:91",
      "custom:-91",
      "custom:45.5",
      "custom:",
      "custom:abc",
      "custom: 45",
      "stacked",
      "sideways",
      "",
      "45",
    ]) {
      const verdict = checkFormatObject({ textRotation: value });
      expect(verdict, value).not.toBe(true);
      expect(String(verdict), value).toContain("vertical");
    }
    expect(checkFormatObject({ textRotation: 45 })).not.toBe(true);
  });
});
