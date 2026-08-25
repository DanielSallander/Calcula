//! FILENAME: app/extensions/AIChat/__tests__/scriptIntent.test.ts
// PURPOSE: The chat should offer the guided path when a message is really a
//          request to author something — and stay out of the way otherwise.
// CONTEXT: 2026-08-24. The detector's output is an OFFER the user accepts or
//          dismisses, never a silent reroute, which is why a word list is the
//          right tool: it is worse at the margins and completely legible at the
//          centre. These tests pin both edges.

import { describe, it, expect } from "vitest";
import { detectScriptIntent, guessObjectType } from "../lib/scriptIntent";
import { DRAFT_OBJECT_TYPES } from "../lib/chatTools";

describe("detectScriptIntent - offers", () => {
  const YES = [
    // The reported message, verbatim.
    "create a script that formats the background color of each selected cell, using the content of the cell, for example: #FFFF00",
    "write a macro to total the columns",
    "can you automate this for me",
    "I want a button that refreshes the sales block",
    "colour the row red whenever the total goes negative",
    "do this automatically each time the sheet opens",
    "make something reusable that cleans up the names",
  ];
  for (const m of YES) {
    it(`offers for: ${m.slice(0, 48)}...`, () => {
      expect(detectScriptIntent(m).looksLikeScript).toBe(true);
      expect(detectScriptIntent(m).matched).toBeTruthy();
    });
  }
});

describe("detectScriptIntent - stays out of the way", () => {
  const NO = [
    "what is in A1 to C3?",
    "sum column B",
    "make A1:A3 yellow",
    "summarise this sheet",
    "which charts are there?",
    "delete the empty rows",
    // The tool loop is genuinely good at these; diverting them would be a
    // regression dressed as a feature.
  ];
  for (const m of NO) {
    it(`stays quiet for: ${m}`, () => {
      expect(detectScriptIntent(m).looksLikeScript).toBe(false);
    });
  }

  it("respects an explicit one-off, even with a script word in it", () => {
    // "just" is the user saying which of the two things they want. Guessing
    // past that is worse than not guessing.
    expect(detectScriptIntent("just automate the totals right now").looksLikeScript).toBe(false);
    expect(detectScriptIntent("quickly automate this").looksLikeScript).toBe(false);
    expect(detectScriptIntent("a one-off macro is fine").looksLikeScript).toBe(false);
  });

  it("is case-insensitive and safe on empty input", () => {
    expect(detectScriptIntent("Write A SCRIPT for this").looksLikeScript).toBe(true);
    expect(detectScriptIntent("").looksLikeScript).toBe(false);
  });
});

describe("guessObjectType", () => {
  it("only ever returns a type the backend will accept", () => {
    // A guess outside VALID_OBJECT_TYPES would preselect a dropdown value that
    // `validate_draft` rejects at the very end of the flow.
    const messages = [
      "a button that refreshes", "colour the chart", "refresh the pivot",
      "when the slicer changes", "on the timeline", "inside the shape",
      "in this text box", "for the table", "using a named range",
      "for the whole workbook", "when the sheet opens", "on the worksheet",
    ];
    for (const m of messages) {
      const t = guessObjectType(m);
      expect(t, m).not.toBeNull();
      expect(DRAFT_OBJECT_TYPES as readonly string[], `${m} -> ${t}`).toContain(t!);
    }
  });

  it("returns null rather than guessing when nothing is named", () => {
    expect(guessObjectType("create a script that colours cells")).toBeNull();
  });

  it("maps the spellings people actually use", () => {
    expect(guessObjectType("in this text box")).toBe("textbox");
    expect(guessObjectType("on the worksheet")).toBe("sheet");
    expect(guessObjectType("using a named range")).toBe("namedRange");
  });
});
