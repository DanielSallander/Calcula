//! FILENAME: app/extensions/AIChat/__tests__/surfaceTax.test.ts
// PURPOSE: The ~6,000-token scripting reference is not built for a message that
//          plainly wants an answer about the data — and IS built for every
//          message that might want a script.
// CONTEXT: `apiSurfaceSection` ran unconditionally on every send. At the
//          built-in runtime's measured ~400 tok/s that is roughly 15 seconds of
//          prompt processing before a pure "analyse this" gets a single token
//          back, for a reply that will never call a script tool.
//
//          THE ASYMMETRY IS THE POINT AND IT IS EASY TO GET BACKWARDS. The
//          obvious gate — build the surface only when the script detector fires
//          — is wrong: measured on `tests/eval/intents.json`, that detector
//          MISSES 23 of 35 script requests. Gating positively would starve two
//          thirds of them. So the rule is negative: skip only where a message
//          is confidently analysis AND not script. A false negative costs
//          latency; a false positive costs the feature.
//
//          This tests the DECISION, not the component: the rule is one boolean
//          expression over two pure detectors, and reaching it through a render
//          would need the whole chat, a provider and a backend channel.

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { detectAnalysisIntent } from "../lib/analysisIntent";
import { mightWantScript } from "../lib/scriptIntent";

/** The rule as `ChatView` applies it. */
function skipsSurface(text: string): boolean {
  return detectAnalysisIntent(text).looksLikeAnalysis && !mightWantScript(text);
}

describe("the scripting surface is skipped only where it cannot be wanted", () => {
  it("skips it for a plain question about the data", () => {
    for (const text of [
      "analyse this range",
      "analysera det här",
      "summarise the trend in these numbers",
    ]) {
      expect(skipsSurface(text), text).toBe(true);
    }
  });

  it("BUILDS it whenever the message could want a script, even alongside analysis", () => {
    // The dangerous half. "Analyse this and write a macro for it" reads as
    // analysis to the first detector, and starving it of the reference is how
    // the capable model was measured explaining what it would write instead of
    // writing it (3/3 text-only without the surface).
    for (const text of [
      "analyse this and write a script to highlight the outliers",
      "analysera och skriv ett makro",
      "write a macro",
      "add a button that clears the sheet",
    ]) {
      expect(skipsSurface(text), text).toBe(false);
    }
  });

  it("BUILDS it for anything it cannot classify, which is most messages", () => {
    // The default has to be "build it". A message the analysis detector does
    // not recognise gets the surface, because the cost of being wrong in that
    // direction is seconds and the cost in the other direction is the feature.
    for (const text of ["hello", "thanks", "make this bold", "why is C3 wrong?"]) {
      expect(skipsSurface(text), text).toBe(false);
    }
  });

  it("is wired into ChatView with the NEGATIVE rule", () => {
    // The pure rule passing proves nothing about the call site, and the call
    // site is where the asymmetry can be quietly inverted to the obvious,
    // wrong, positive gate.
    const src = readFileSync(
      join(process.cwd(), "extensions/AIChat/components/ChatView.tsx"),
      "utf8",
    );
    // The HIGH-RECALL sniff, not the precise detector. Swapping
    // `mightWantScript` for `detectScriptIntent` here looks like a tidy-up and
    // is the defect: that detector misses 23 of 35 script requests, so the gate
    // would silently start starving them.
    expect(src).toMatch(
      /skipSurface\s*=\s*detectAnalysisIntent\(text\)\.looksLikeAnalysis\s*&&\s*!mightWantScript\(text\)/,
    );
    expect(src).toMatch(/skipSurface\s*\?\s*""\s*:\s*await apiSurfaceSection/);
  });
});
