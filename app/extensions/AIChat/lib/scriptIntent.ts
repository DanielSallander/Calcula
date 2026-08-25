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
const ONE_OFF_WORDS = ["just ", "right now", "one-off", "one off", "quickly", "for now"];

export interface ScriptIntent {
  /** True when the message reads as a request to author something durable. */
  looksLikeScript: boolean;
  /** The word that matched, for an honest explanation to the user. */
  matched: string | null;
}

export function detectScriptIntent(message: string): ScriptIntent {
  const text = message.toLowerCase();
  const matched = SCRIPT_WORDS.find((w) => text.includes(w)) ?? null;
  if (!matched) return { looksLikeScript: false, matched: null };
  // An explicit "just do it now" beats the keyword: the user has said which of
  // the two things they want, and guessing past that is worse than not guessing.
  if (ONE_OFF_WORDS.some((w) => text.includes(w))) {
    return { looksLikeScript: false, matched: null };
  }
  return { looksLikeScript: true, matched };
}

/**
 * The object type a message hints at, or null.
 *
 * Only used to PRESELECT the dropdown in the guided flow — the user always sees
 * and can change it. `draftGate` has to guess "button" silently because it runs
 * after the fact; here the guess is visible, which is the whole improvement.
 */
const TYPE_HINTS: ReadonlyArray<[string, string]> = [
  ["button", "button"],
  ["chart", "chart"],
  ["pivot", "pivot"],
  ["slicer", "slicer"],
  ["timeline", "timeline"],
  ["shape", "shape"],
  ["text box", "textbox"],
  ["textbox", "textbox"],
  ["table", "table"],
  ["named range", "namedRange"],
  ["workbook", "workbook"],
  ["sheet", "sheet"],
  ["worksheet", "sheet"],
];

export function guessObjectType(message: string): string | null {
  const text = message.toLowerCase();
  for (const [needle, type] of TYPE_HINTS) {
    if (text.includes(needle)) return type;
  }
  return null;
}
