//! FILENAME: app/extensions/Insights/lib/chatHandoff.ts
// PURPOSE: Turn a computed bundle into the prompt the AI chat is handed.
// CONTEXT: This is the division of labour the whole feature rests on: the FACTS
//          are computed and checkable, the PROSE is not. So the prompt ships the
//          bundle verbatim and asks for wording — never for analysis.
//
//          THREE THINGS THE PROMPT MUST DO, and each of them is a defect if it
//          stops doing it:
//
//          - Carry the notes. "Sampled to 10,000 points", "hidden rows
//            excluded" are the caveats that make a number honest. A summary
//            written without them is confidently wrong, and the reader has no
//            way to tell.
//          - Carry the `dropped` count, so the model cannot present a capped
//            list as the complete picture.
//          - Forbid causes. Every sentence Rust produces is careful not to
//            claim WHY something moved; a narrator that adds "because of the
//            price change" undoes that in one clause.
//
//          It PREFILLS, never auto-sends: `openChatWithPrompt` defaults
//          `autoSend` to false and this module never overrides it. The person
//          presses send.

import { hasChatPromptSink, openChatWithPrompt } from "@api/chatPromptService";
import type { InsightBundle } from "@api/insightsService";

/** The rules the narrator is held to. Kept separate so a test can name them. */
const NARRATION_RULES = [
  "Write a short plain-language summary of the facts below.",
  "Use only the numbers given. Do not compute new ones and do not round away detail that changes the meaning.",
  "Do not suggest a cause for any movement. The facts deliberately do not claim one.",
  "Repeat every limitation listed below rather than dropping it.",
];

/**
 * Compose the prompt for a bundle.
 *
 * `originLabel` is what the bundle was computed FROM ("Sheet1!B2:D40", a
 * measure name, a chart title). It goes in because a summary that does not say
 * what it summarises is unusable once it has been pasted anywhere else.
 */
export function buildChatPrompt(bundle: InsightBundle, originLabel?: string | null): string {
  const parts: string[] = [];

  const where = originLabel ? ` for ${originLabel}` : "";
  parts.push(
    `Calcula computed the following facts${where}. They are deterministic — ` +
      `no model produced them — and they came from the ` +
      `${bundle.source === "model" ? "semantic model" : "cell range"}.`,
  );

  parts.push(NARRATION_RULES.map((r) => `- ${r}`).join("\n"));

  parts.push("Facts:");
  parts.push(bundle.markdown.trim().length > 0 ? bundle.markdown.trim() : "(none)");

  if (bundle.dropped > 0) {
    parts.push(
      `${bundle.dropped} further fact${bundle.dropped === 1 ? " was" : "s were"} ranked ` +
        `below the cut and are not listed. Do not present this as the complete picture.`,
    );
  }

  if (bundle.notes.length > 0) {
    parts.push(`Stated limits:\n${bundle.notes.map((n) => `- ${n}`).join("\n")}`);
  }

  return parts.join("\n\n");
}

/** Whether a "Send to chat" control should be rendered at all. */
export function canSendToChat(): boolean {
  return hasChatPromptSink();
}

/**
 * Hand the bundle to the chat. Returns false when there was no chat to hand it
 * to — the caller greys out or hides the control rather than raising.
 */
export function sendBundleToChat(
  bundle: InsightBundle,
  originLabel?: string | null,
): boolean {
  return openChatWithPrompt(buildChatPrompt(bundle, originLabel));
}
