//! FILENAME: app/extensions/AIChat/__tests__/analysisIntent.test.ts
// PURPOSE: The chat computes the facts first when a message asks what the data
//          says — and leaves everything else to the tool loop.
// CONTEXT: 2026-09-10. The detector decides whether a cheap, read-only Tier-0
//          computation runs BEFORE the model sees the message. A false positive
//          costs one computation the model may ignore; a false negative costs
//          nothing new, because the model can still call analyze_range itself.
//          So the centre must be solid and the margins may be conservative.

import { describe, it, expect } from "vitest";
import { detectAnalysisIntent } from "../lib/analysisIntent";

describe("detectAnalysisIntent - computes the facts first", () => {
  const YES = [
    "what is going on in this data?",
    "What's going on with revenue?",
    "analyse the selection",
    "analyze this range for me",
    "are there any outliers in column C?",
    "is there a trend here",
    "summarise the data in B2:D40",
    "explain these numbers",
    "what stands out in this table?",
    "anything interesting in the sales figures?",
    "give me some insights",
    "is revenue seasonal?",
    // Swedish
    "analysera markeringen",
    "vad händer med omsättningen?",
    "finns det något mönster här?",
    "hur går det för försäljningen?",
  ];
  for (const m of YES) {
    it(`computes first for: ${m}`, () => {
      const intent = detectAnalysisIntent(m);
      expect(intent.looksLikeAnalysis).toBe(true);
      expect(intent.matched).toBeTruthy();
    });
  }
});

describe("detectAnalysisIntent - stays out of the way", () => {
  const NO = [
    "what is in A1 to C3?",
    "sum column B",
    "make A1:A3 yellow",
    "which charts are there?",
    "delete the empty rows",
    "create a script that colours each cell by its value",
    "write a macro to total the columns",
    // The word must be a word: "trendy" is not "trend", and a product called
    // "Insightful" is not a request for insights.
    "rename the sheet to Trendy Products",
    "set B2 to Insightful",
  ];
  for (const m of NO) {
    it(`stays quiet for: ${m}`, () => {
      expect(detectAnalysisIntent(m).looksLikeAnalysis).toBe(false);
    });
  }

  it("defers to the formula assistant when the message asks for a formula", () => {
    // "A formula for the trend" wants the formula seam, whose answer is
    // verified by the engine. A fact bundle would be the wrong kind of help.
    expect(detectAnalysisIntent("give me a formula for the trend in column B").looksLikeAnalysis).toBe(false);
    expect(detectAnalysisIntent("en formel för trenden").looksLikeAnalysis).toBe(false);
  });

  it("is case-insensitive and safe on empty input", () => {
    expect(detectAnalysisIntent("ANALYSE THIS").looksLikeAnalysis).toBe(true);
    expect(detectAnalysisIntent("").looksLikeAnalysis).toBe(false);
  });
});
