//! FILENAME: app/extensions/AIChat/lib/scriptName.ts
// PURPOSE: A readable NAME from what the user asked for.
// CONTEXT: 2026-08-26, reported: "It prompts 'what should change in' and then
//          the beginning of my prompt is shown: 'create a script that formats
//          the'. I dont think it should name the script after the prompt."
//          The old rule (`titleFor`) was the first SIX WORDS, verbatim — so
//          every AI script was named after its own request preamble.
//
//          FOUR GUARANTEES CALLERS DEPEND ON: the result is trimmed, non-empty,
//          at most MAX_SCRIPT_NAME_CHARS, and contains no newline or tab.
//          Non-empty is what `validate_draft` requires (mcp/drafts.rs:118);
//          no-newline is what keeps the audit line intact (drafts.rs:270).
//
//          ENGLISH WRAPPERS ONLY. A guessed Swedish or German preamble list
//          would eat a real verb on a wrong alternation, and a name that lost
//          its verb is worse than a name with a preamble. The ~45-character
//          fallback below is what a non-English prompt gets, and it is already
//          far better than the first six words verbatim.

/** INCLUDING the trailing "..." — a 48-char cap that emits 49 is not a cap. */
export const MAX_SCRIPT_NAME_CHARS = 48;

/** Closed-class words that must never END a truncated name. */
const TAIL_WORDS = new Set([
  "the","a","an","of","to","in","on","for","by","with","and","or",
  "so","that","when","if","it","its","each","every",
]);

/**
 * Strip a request preamble. TWO parts are required, and each guards a real case:
 *  - a captured NON-EMPTY lead, or "function keys should be ignored" loses its
 *    subject and becomes "Keys should be ignored";
 *  - a mandatory script NOUN, or "add a guard so it does nothing" loses its verb.
 *
 * The connective tail accepts a comma straight after the connective — "script
 * that, when clicked, ..." — or the name STARTS with a bare relative pronoun.
 * But the delimiter after the connective is REQUIRED (`(?:,\s*|\s+)`, never
 * `,?\s*`): a zero-width tail lets `\b` consume "that" out of "that's" and
 * "to" out of "to-do", leaving "'s fun for the kids" as the name.
 */
const REQUEST_WRAPPER =
  /^((?:please\s+|can\s+you\s+|could\s+you\s+|i\s+(?:want|need)\s+(?:you\s+to\s+)?)*(?:(?:create|make|write|build|generate|author|produce|code)\s+(?:me\s+)?)?(?:(?:a|an|the|another|some)\s+)?(?:(?:new|simple|small|quick|little)\s+)?(?:(?:button|sheet|cell|workbook|chart|table|slicer|pivot)\s+)?)(?:script|macro|function|program|snippet|routine)\b(?:\s*[:,–—-]\s*|\s+(?:that|which|to|for)\b(?:,\s*|\s+)|\s+)?/i;

/** "it should colour the cells" -> "colour the cells". */
const LEADING_MODAL = /^(?:it\s+)?(?:should|shall|will|must)\s+/i;

/**
 * A SENTENCE terminator, not a comma.
 *
 * The comma was rejected deliberately: "sort rows 2, 5, and 9" would become
 * "Sort rows 2". A second SENTENCE is never part of a name; a clause is.
 *
 * KNOWN LIMIT, accepted: an abbreviation's period also cuts, so "clear cells
 * e.g. A1:B2 and also C3" names as "Clear cells e.g". Pinned as accepted
 * output in scriptName.test.ts — the trade-off and the rejected alternative
 * are documented there.
 */
const SENTENCE_END = /[.;!?](?:\s|$)/;

export function scriptNameFromIntent(intent: string): string {
  // This one call delivers the no-newline/no-tab guarantee.
  let s = String(intent ?? "").replace(/\s+/g, " ").trim();
  s = s.replace(/^["'“”‘’]+/, "").replace(/["'“”‘’]+$/, "");

  const m = REQUEST_WRAPPER.exec(s);
  if (m && m[1].trim()) s = s.slice(m[0].length).trim();
  s = s.replace(LEADING_MODAL, "").trim();

  const stop = SENTENCE_END.exec(s);
  if (stop) s = s.slice(0, stop.index).trim();
  s = s.replace(/[.,;:!?\-–—]+$/, "").trim();

  if (s.length > MAX_SCRIPT_NAME_CHARS) {
    let head = s.slice(0, MAX_SCRIPT_NAME_CHARS - 3);
    if (s[MAX_SCRIPT_NAME_CHARS - 3] !== " ") {
      const sp = head.lastIndexOf(" ");
      if (sp > 0) head = head.slice(0, sp);
    }
    head = head.replace(/[\uD800-\uDBFF]$/, "");        // dangling high surrogate
    // Runs ONLY here, so a SHORT name is never chopped. Terminates at the first
    // content word — no counter, no budget, nothing to tune.
    let words = head.trim().split(" ");
    while (words.length > 1 && TAIL_WORDS.has(words[words.length - 1].toLowerCase())) words.pop();
    head = words.join(" ").replace(/[.,;:!?\-–—]+$/, "");
    s = head ? `${head}...` : "";
  }

  if (!s) return "AI script";
  // Codepoint-safe, and it leaves "2026 totals", SUMIF, A1 and B:B alone.
  return s.replace(/^\p{L}/u, (c) => c.toUpperCase());
}
