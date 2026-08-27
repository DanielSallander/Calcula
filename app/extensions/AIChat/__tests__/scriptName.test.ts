//! FILENAME: app/extensions/AIChat/__tests__/scriptName.test.ts
// PURPOSE: A script's NAME must not be its own request preamble.
// CONTEXT: 2026-08-26, reported: "It prompts 'what should change in' and then
//          the beginning of my prompt is shown: 'create a script that formats
//          the'."  The old rule was the first SIX WORDS, verbatim.
//
//          THE DRIFT PIN (below) IS BEHAVIOURAL, NOT A SNAPSHOT. A snapshot of
//          five names would go green again the moment someone regenerated it
//          with the defect back in place; "no name starts with a request verb"
//          cannot.

import { describe, it, expect } from "vitest";
import { scriptNameFromIntent, MAX_SCRIPT_NAME_CHARS } from "../lib/scriptName";

/**
 * The corpus. First row is the owner's LITERAL prompt, recorded verbatim
 * (project_local_model_scripting.md:410).
 */
const CORPUS: ReadonlyArray<readonly [intent: string, name: string]> = [
  [
    "create a script that formats the background color of each selected cell",
    "Formats the background color of each selected...",
  ],
  // The three cases where this implementation diverges from a rejected design
  // that cut at the first preposition. Asserted as WHOLE strings, because a
  // `toContain` would pass for the very truncation being rejected.
  ["write a macro to sort rows 2-500 by column B", "Sort rows 2-500 by column B"],
  ["colour each selected cell by its content", "Colour each selected cell by its content"],
  ["please make me a new button script that clears the sheet", "Clears the sheet"],
  // A comma STRAIGHT AFTER the connective. The old tail `(?:that|which|to|for)\s+`
  // required whitespace after the connective, so "which," left the connective in
  // place and the name BEGAN with a bare relative pronoun — request debris, the
  // defect class this module shipped to fix.
  [
    "make a script which, when clicked, colours the current selection green",
    "When clicked, colours the current selection...",
  ],
  ["create a script that, when clicked, hides row 3", "When clicked, hides row 3"],
  // The two rows a WRONG comma fix would break: a `\b,?\s*` tail matches with
  // ZERO delimiter after the connective, so it eats "that" out of "that's"
  // (-> "'s fun for the kids") and "to" out of "to-do" (-> "-do list manager").
  // The delimiter after the connective must be REQUIRED: `(?:,\s*|\s+)`.
  ["make a script that's fun for the kids", "That's fun for the kids"],
  ["write a script to-do list manager", "To-do list manager"],
];

describe("scriptNameFromIntent", () => {
  it.each(CORPUS)("names %j", (intent, expected) => {
    expect(scriptNameFromIntent(intent)).toBe(expected);
  });

  it("never begins with the request preamble it was asked with", () => {
    // THE DRIFT PIN. `titleFor` took the first six words, so every one of these
    // began with "create"/"write"/"please". `that`/`which` joined the ban when
    // "script which, when clicked" left the connective standing and the name
    // began with a bare relative pronoun. The apostrophe lookahead on `that` is
    // load-bearing: the contraction "That's fun for the kids" is a LEGITIMATE
    // name in this corpus, and `\b` alone matches before its apostrophe.
    for (const [intent] of CORPUS) {
      const name = scriptNameFromIntent(intent);
      expect(
        name,
        `"${intent}" was named after its own request`,
      ).not.toMatch(/^(create|make|write|build|generate|author|produce|please|can you|a script|an? macro|that(?!['’])|which)\b/i);
    }
  });

  it("keeps the VERB when the sentence merely starts with an article", () => {
    // "add a guard so it does nothing" has no script noun in it, so the wrapper
    // must not fire at all.
    expect(scriptNameFromIntent("add a guard so it does nothing when the selection is empty"))
      .toMatch(/^Add /);
    // THIS is the case with the teeth. MEASURED 2026-08-26: making the script
    // noun optional in REQUEST_WRAPPER leaves the "add a guard" line above
    // GREEN — "add" is not one of the wrapper's verbs, so the captured lead is
    // empty either way and the `m[1].trim()` guard already refuses. It is only
    // when the lead IS a real wrapper verb that an optional noun eats it, and
    // then "Make a guard..." silently becomes "Guard...".
    expect(scriptNameFromIntent("make a guard so it does nothing when the selection is empty"))
      .toMatch(/^Make a guard /);
  });

  it("keeps a BARE noun that happens to be a wrapper word", () => {
    // The lead the wrapper captured is empty here, so there is no preamble to
    // strip — "function" is the SUBJECT. `if (m)` instead of `if (m && m[1].trim())`
    // turns this into "Keys should be ignored", and the drift pin above does
    // NOT catch it.
    expect(scriptNameFromIntent("function keys should be ignored"))
      .toBe("Function keys should be ignored");
  });

  it("cuts at a SENTENCE, never at a comma", () => {
    expect(scriptNameFromIntent("sort rows 2, 5, and 9")).toBe("Sort rows 2, 5, and 9");
    // The control: a second sentence is never part of a name.
    expect(scriptNameFromIntent("clear the sheet. then bold row 1")).toBe("Clear the sheet");
  });

  it("KNOWN LIMIT: an abbreviation's period also cuts", () => {
    // ACCEPTED OUTPUT, not desired output. "e.g." reads as a sentence end, so
    // the name dangles mid-abbreviation. Accepted because all four caller
    // guarantees still hold, Rename is one click away in the editor, and the
    // measured alternative — suppressing '.' after a single-letter token —
    // trades this for "select column b. then sort" no longer cutting at its
    // real sentence end. If SENTENCE_END ever learns abbreviations, this pin
    // is the one to update.
    expect(scriptNameFromIntent("clear cells e.g. A1:B2 and also C3")).toBe("Clear cells e.g");
  });

  it("strips a leading modal", () => {
    expect(scriptNameFromIntent("it should colour the cells")).toBe("Colour the cells");
  });

  describe("the four guarantees callers depend on", () => {
    const ADVERSARIAL = [
      "",
      "   ",
      "create a script",
      "x".repeat(500),
      "make a script that\nbolds\trow 1",
      "\u{1F600}".repeat(30),
      "the a an of to in on for by with and or so that when if it its each every",
      ...CORPUS.map(([intent]) => intent),
    ];

    it.each(ADVERSARIAL)("holds for %j", (intent) => {
      const name = scriptNameFromIntent(intent);
      expect(name).toBe(name.trim());
      expect(name.length).toBeGreaterThan(0);
      // INCLUDING the ellipsis — a 48-char cap that emits 49 is not a cap.
      expect(name.length).toBeLessThanOrEqual(MAX_SCRIPT_NAME_CHARS);
      expect(name).not.toMatch(/[\n\r\t]/);
    });

    it("leaves no dangling high surrogate when it cuts an emoji run", () => {
      // A 45-unit slice through a run of astral characters lands BETWEEN the
      // two halves of a pair. Asserted as "no lone surrogate anywhere", not as
      // an index: a JSON round-trip does NOT catch it (ES2019 stringify escapes
      // a lone surrogate and parse hands it straight back), so that assertion
      // would have had no teeth.
      const name = scriptNameFromIntent("\u{1F600}".repeat(30));
      expect(name, "a high surrogate with no low half").not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/);
      expect(name, "a low surrogate with no high half").not.toMatch(/(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/);
    });

    it("gives back the SAME fallback string for every degenerate input", () => {
      // No objectType parameter: the dropdown already prints the type, and a
      // "Button script" fallback would sit one lowercase letter from the
      // scaffold name the editor mints.
      expect(scriptNameFromIntent("")).toBe("AI script");
      expect(scriptNameFromIntent("   ")).toBe("AI script");
      expect(scriptNameFromIntent("create a script")).toBe("AI script");
    });
  });
});
