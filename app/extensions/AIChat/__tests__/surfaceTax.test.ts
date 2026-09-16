//! FILENAME: app/extensions/AIChat/__tests__/surfaceTax.test.ts
// PURPOSE: The ~6,000-token scripting API reference is skipped ONLY where the
//          message cannot want it, and the call site keeps the asymmetry.
// CONTEXT: `apiSurfaceSection` is ~6,000 tokens of reference built into the
//          system prompt — roughly 15 s of prompt processing on the built-in
//          runtime — and it used to be built on EVERY message. Skipping it is
//          worth seconds; skipping it wrongly costs the feature: without the
//          reference the capable model explains what it would write instead of
//          writing it (measured 3/3 text-only).
//
//          THE RULE IS NEGATIVE. Gating on a positive script signal was the
//          obvious move and is wrong: the old detector missed 23 of 35 script
//          requests. The surface is skipped only where the router has DECIDED
//          the message is something else AND the deliberately over-broad
//          `mightWantScript` sniff is silent. Two conditions, both needed.

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { routeIntent } from "../lib/intentRouter";
import { mightWantScript } from "../lib/scriptIntent";

/** The rule as `ChatView` applies it. */
function skipsSurface(text: string): boolean {
  const route = routeIntent(text);
  return route.decisive && route.intent !== "script" && !mightWantScript(text);
}

describe("the scripting surface is skipped only where it cannot be wanted", () => {
  it("skips it for a message the router has DECIDED is something else", () => {
    for (const text of [
      "analyse this range",
      "summarise the trend in these numbers",
      "make A1:D1 bold",
      "delete the empty rows between 40 and 60",
      "why does C7 show #DIV/0!",
    ]) {
      expect(skipsSurface(text), text).toBe(true);
    }
  });

  it("BUILDS it whenever the message could want a script, even alongside analysis", () => {
    // The dangerous half. "Analyse this and write a script for it" reads as
    // analysis, and starving it of the reference is how the capable model was
    // measured explaining what it would write instead of writing it.
    for (const text of [
      "analyse this and write a script to highlight the outliers",
      "analysera och skriv ett makro",
      "write a macro",
      "add a button that clears the sheet",
      "when this cell changes, recalculate the total",
    ]) {
      expect(skipsSurface(text), text).toBe(false);
    }
  });

  it("BUILDS it for anything the router only LEANS on, which is most messages", () => {
    // A lean is allowed to be wrong; a missing reference is not something the
    // model can recover from. Only a decision skips.
    for (const text of ["hello", "thanks", "fix this", "what does a pivot table do", "can you help"]) {
      const route = routeIntent(text);
      expect(route.decisive, text).toBe(false);
      expect(skipsSurface(text), text).toBe(false);
    }
  });

  it("BUILDS it when the sniff fires even on a decided non-script route", () => {
    // Belt and braces: the high-recall word list still overrides a decision.
    // "add a column" decides data-op; "add" is on the sniff list; the surface
    // is built. The cost is seconds, the alternative is the feature.
    const text = "add a column called Total after column C";
    expect(routeIntent(text).decisive).toBe(true);
    expect(mightWantScript(text)).toBe(true);
    expect(skipsSurface(text)).toBe(false);
  });

  it("is wired into ChatView with the NEGATIVE rule", () => {
    // The pure rule passing proves nothing about the call site, and the call
    // site is where the asymmetry can be quietly inverted to the obvious,
    // wrong, positive gate. Both conditions must be present, and the sniff
    // must be the high-recall one.
    const src = readFileSync(join(process.cwd(), "extensions/AIChat/components/ChatView.tsx"), "utf8");
    expect(src).toMatch(
      /skipSurface\s*=\s*route\.decisive\s*&&\s*route\.intent\s*!==\s*"script"\s*&&\s*!mightWantScript\(text\)/,
    );
    expect(src).toMatch(/skipSurface\s*\?\s*""\s*:\s*await apiSurfaceSection/);
    // And the route is computed ONCE — a second `routeIntent(` call in send()
    // would be the drift that made two detectors disagree.
    expect(src.match(/routeIntent\(/g)?.length).toBe(1);
  });
});
