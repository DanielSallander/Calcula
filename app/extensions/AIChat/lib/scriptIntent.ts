//! FILENAME: app/extensions/AIChat/lib/scriptIntent.ts
// PURPOSE: Notice when a chat message is really a request to AUTHOR A SCRIPT, so
//          the chat can offer the guided path instead of letting the model pick
//          a tool that cannot do the job.
// CONTEXT: 2026-08-24. Asked to "create a script that formats the background
//          color of each selected cell", qwen2.5:7b reached for
//          `apply_formatting` — which takes ONE range and ONE set of properties
//          and therefore cannot express a per-cell colour derived from per-cell
//          content. There is no correct choice among the non-script tools; the
//          request needs a script, and the model has to make that call before it
//          can get anything else right.
//
//          The measured failure is in TOOL SELECTION, not code generation: local
//          models write reasonable JavaScript and choose the wrong tool. So the
//          product should stop asking them to choose. This module is the cheap,
//          transparent half of that — a keyword read of the user's own words,
//          shown as an OFFER the user accepts, never an automatic reroute.
//
//          DELIBERATELY NOT A CLASSIFIER. Asking the model "is this a scripting
//          request?" spends a round trip on the same judgement it is already bad
//          at, and gets it wrong silently. A word list is worse at the margins
//          and completely legible at the centre, which is the right trade when
//          the output is a suggestion the user can ignore.

/**
 * Words that mean "I want something I can keep and re-run".
 *
 * "script", "macro" and "automate" are the unambiguous ones. "button" is here
 * because attaching behaviour to a button is the commonest way users describe
 * wanting one without using the word.
 */
const SCRIPT_WORDS = [
  "script",
  "macro",
  "automate",
  "automation",
  "automatically",
  "every time",
  "whenever",
  "each time",
  "when i click",
  "on click",
  "button that",
  "reusable",
];

/**
 * Phrases that mean "do it to the workbook now", which the tool loop handles
 * well and which must NOT be diverted.
 *
 * Checked only to suppress a match that is ALSO a script word — "just make A1
 * yellow" should never offer to write a macro. A message with no script word at
 * all never reaches here.
 */
const ONE_OFF_WORDS = ["just", "right now", "one-off", "one off", "quickly", "for now"];

/**
 * A DELIBERATELY OVER-BROAD sniff: might this message want scripting help?
 *
 * The opposite trade to `detectScriptIntent`, and it exists because that
 * function is measured to MISS 23 of 35 script requests in
 * `tests/eval/intents.json`. That miss rate is fine for OFFERING to write a
 * script — a missed offer costs a card nobody sees — and unacceptable for
 * deciding to WITHHOLD the API reference, where a miss costs the model the
 * knowledge it needs and it explains what it would write instead of writing it.
 *
 * So the two questions are asked by two functions with opposite failure modes:
 *   - `detectScriptIntent`  — precise. Wrong when it fires on nothing.
 *   - `mightWantScript`     — recall. Wrong when it STAYS SILENT.
 *
 * Over-firing here costs only the prompt tokens that were being spent anyway,
 * which is why the list includes plain verbs like "write" and "skriv" that
 * would be far too loose for an offer. It is not Swedish-complete and does not
 * need to be: the cost of a miss is bounded by whatever `looksLikeAnalysis`
 * also has to be true for.
 */
const MIGHT_WANT_SCRIPT_WORDS = [
  ...SCRIPT_WORDS,
  "makro",
  "makron",
  "skript",
  "automatisera",
  "automatiskt",
  "button",
  "knapp",
  "write",
  "skriv",
  "create",
  "skapa",
  "build",
  "bygg",
  "add",
  "lägg",
  "code",
  "kod",
  "function",
  "funktion",
  "trigger",
  "run",
  "kör",
];

export function mightWantScript(message: string): boolean {
  const text = message.toLowerCase();
  return MIGHT_WANT_SCRIPT_WORDS.some((w) => mentionsWord(text, w) || (w.includes(" ") && text.includes(w)));
}

export interface ScriptIntent {
  /** True when the message reads as a request to author something durable. */
  looksLikeScript: boolean;
  /** The word that matched, for an honest explanation to the user. */
  matched: string | null;
}

export function detectScriptIntent(message: string): ScriptIntent {
  const text = message.toLowerCase();
  // AS WORDS, NOT SUBSTRINGS — the rule `mentionsWord` below already states and
  // the only one this function was not following. `includes` made *description*,
  // *subscription*, *transcript* and *prescription* all match the trigger
  // "script", and *macroeconomic* match "macro"; each one rendered a script
  // offer card and built a ~6,000-token API surface for a message that wanted
  // neither. The suppressor was worse because it failed SILENTLY: "just" was
  // spelled `"just "` and matched inside *adjust* and *readjust*, so "adjust the
  // totals automatically whenever the source changes" — three separate
  // automation signals — was thrown away with no trace.
  //
  // Measured on `tests/eval/intents.json` (170 utterances) before this change:
  // 5 false scripts, and 7 of the 9 regression cases routed wrongly.
  const matched = SCRIPT_WORDS.find((w) => mentionsWord(text, w)) ?? null;
  if (!matched) return { looksLikeScript: false, matched: null };
  // An explicit "just do it now" beats the keyword: the user has said which of
  // the two things they want, and guessing past that is worse than not guessing.
  if (ONE_OFF_WORDS.some((w) => mentionsWord(text, w))) {
    return { looksLikeScript: false, matched: null };
  }
  return { looksLikeScript: true, matched };
}

/**
 * The object type a message hints at, or null.
 *
 * Used to PRESELECT the dropdown in the guided flow — where the user sees and
 * can change it — AND to pick the API slice the chat shows the model before it
 * writes anything, where nobody sees it at all. That second consumer is why the
 * match has to be word-accurate: a wrong answer is a prompt that confidently
 * describes the wrong object's hooks, and the model's draft is dead.
 *
 * ORDER MATTERS: first hit wins, so the NAMED objects come first and the generic
 * grid words last. "add a button to my spreadsheet" is a button request that
 * happens to mention where the button goes.
 */
const TYPE_HINTS: ReadonlyArray<[string, string]> = [
  ["button", "button"],
  ["chart", "chart"],
  ["pivot", "pivot"],
  ["slicer", "slicer"],
  ["timeline", "timeline"],
  ["shape", "shape"],
  // "form" as a WORD, so "format" and "formula" do not match (isWord below).
  ["form", "form"],
  ["text box", "textbox"],
  ["textbox", "textbox"],
  ["table", "table"],
  ["named range", "namedRange"],
  ["workbook", "workbook"],
  ["sheet", "sheet"],
  ["worksheet", "sheet"],
  // The grid primitives, last. They are real object types (`DRAFT_OBJECT_TYPES`
  // in chatTools.ts), and until they were listed "when this cell changes" got
  // the BUTTON surface — a documented miss, but a miss on the commonest way to
  // describe a cell script.
  ["cell", "cell"],
  ["row", "row"],
  ["column", "column"],
];

/**
 * Does the text contain `needle` AS A WORD?
 *
 * `includes` was WRONG, not merely loose. "spreadsheet" contains "sheet", so "a
 * script for my spreadsheet that colours each selected cell" built a
 * SheetContext surface — no `onClick` anywhere in it — for what is almost always
 * a button request. "datatable" contains "table" the same way, and with the grid
 * primitives above, "narrow" would contain "row" and "columns" would swallow
 * every plural of every noun that ends in one.
 *
 * A miss is the acceptable failure here (`apiSurface.ts` falls back to "button"
 * and says so); a confident wrong answer is not.
 */
export function mentionsWord(text: string, needle: string): boolean {
  // The needles are a fixed lowercase table, but escaped anyway: a table entry
  // with a "." or a "(" in it would otherwise silently become a wildcard.
  const escaped = needle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`\\b${escaped}\\b`).test(text);
}

export function guessObjectType(message: string): string | null {
  const text = message.toLowerCase();
  for (const [needle, type] of TYPE_HINTS) {
    if (mentionsWord(text, needle)) return type;
  }
  return null;
}
