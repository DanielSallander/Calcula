//! FILENAME: app/extensions/AIChat/lib/scriptIntent.ts
// PURPOSE: The script-facing view of the intent router: "is this a request to
//          AUTHOR something durable, and what object does it attach to?"
// CONTEXT: 2026-08-24. Asked to "create a script that formats the background
//          color of each selected cell", qwen2.5:7b reached for
//          `apply_formatting` — which takes ONE range and ONE set of properties
//          and therefore cannot express a per-cell colour derived from per-cell
//          content. The measured failure is in TOOL SELECTION, not code
//          generation, so the product stops asking the model to choose.
//
//          ABSORBED INTO `intentRouter.ts` on 2026-09-16 (design: M4). This file
//          used to be one of two independent detectors that ran on every message
//          with nothing arbitrating between them; it now answers its question by
//          asking the router, which routes each message exactly once. The
//          twelve-word trigger list it carried is gone — measured on the corpus
//          it MISSED 23 of 35 script requests, because "when this button is
//          clicked" is how a person asks for automation and the word *script*
//          is not. The router's `script` rules are durability signals instead.
//
//          `mightWantScript` stays here, unchanged and deliberately over-broad:
//          it is the RECALL guard on the API-surface gate, and its failure mode
//          (staying silent) is the opposite of the router's (firing wrongly).

import { routeIntent } from "./intentRouter";

export { guessObjectType, mentionsWord } from "./intentRouter";

/**
 * A DELIBERATELY OVER-BROAD sniff: might this message want scripting help?
 *
 * The opposite trade to the router's decisive `script` rule. A miss here costs
 * the model the ~6,000-token API reference it needs and it explains what it
 * would write instead of writing it — so over-firing, which costs only prompt
 * tokens that were being spent anyway, is the right side to err on. Plain
 * verbs like "write" and "add" would be far too loose for an offer and are
 * exactly right for a guard.
 */
const MIGHT_WANT_SCRIPT_WORDS = [
  "script", "scripts", "macro", "macros", "automate", "automation", "automatically",
  "every time", "whenever", "each time", "when i click", "on click", "button that", "reusable",
  "button", "write", "create", "build", "add", "code", "function", "trigger", "run",
  "download", "fetch", "json", "api", "http", "https", "remember", "dialog", "prompt",
  "log", "expose", "form",
  // A handful of Swedish spellings stay in the GUARD only. The programme is
  // English-only, and the router's decisive rules are — but this list exists to
  // stay silent as rarely as possible, and a person who types "skriv ett makro"
  // must not be starved of the API reference because of which language they
  // typed it in. Over-firing here costs tokens; missing costs the feature.
  "makro", "makron", "skript", "skriv", "automatisera", "automatiskt", "knapp", "skapa",
  "bygg", "kod", "funktion", "kör",
];

export function mightWantScript(message: string): boolean {
  const text = message.toLowerCase();
  return MIGHT_WANT_SCRIPT_WORDS.some((w) =>
    w.includes(" ") ? text.includes(w) : new RegExp(`\\b${w}\\b`).test(text),
  );
}

export interface ScriptIntent {
  /** True when the message reads as a request to author something durable. */
  looksLikeScript: boolean;
  /** The evidence, for an honest explanation to the user. */
  matched: string | null;
}

/**
 * Should the chat OFFER the guided script path for this message?
 *
 * Offered, never automatic — the router will be wrong at the margins, so the
 * user decides. The offer is made when the router routes to `script` outright;
 * a message the router would ask about ("analyse this and then automate it
 * weekly") gets the clarifying notice instead of a card it may not want.
 */
export function detectScriptIntent(message: string): ScriptIntent {
  const route = routeIntent(message);
  if (route.intent !== "script" || route.clarify) return { looksLikeScript: false, matched: null };
  return { looksLikeScript: true, matched: route.matched[0] ?? null };
}
