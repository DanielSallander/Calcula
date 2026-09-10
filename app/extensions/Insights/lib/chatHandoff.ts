//! FILENAME: app/extensions/Insights/lib/chatHandoff.ts
// PURPOSE: Hand a computed bundle to the AI chat as a prompt.
// CONTEXT: This is the division of labour the whole feature rests on: the FACTS
//          are computed and checkable, the PROSE is not. So the prompt ships the
//          bundle verbatim and asks for wording — never for analysis.
//
//          THE WORDS LIVE IN THE SEAM. `describeBundleForModel` in
//          `@api/insightsService` is the one text a model is ever handed a
//          bundle as, whether it arrives from this button or from the chat's
//          own "analyse" pre-route — so the notes, the dropped count and the
//          ban on causes are written once, and this module only decides WHEN
//          to hand it over.
//
//          It PREFILLS, never auto-sends: `openChatWithPrompt` defaults
//          `autoSend` to false and this module never overrides it. The person
//          presses send.

import { hasChatPromptSink, openChatWithPrompt } from "@api/chatPromptService";
import { describeBundleForModel, type InsightBundle } from "@api/insightsService";

/**
 * Compose the prompt for a bundle.
 *
 * `originLabel` is what the bundle was computed FROM ("Sheet1!B2:D40", a
 * measure name, a chart title). It goes in because a summary that does not say
 * what it summarises is unusable once it has been pasted anywhere else.
 */
export function buildChatPrompt(bundle: InsightBundle, originLabel?: string | null): string {
  return describeBundleForModel(bundle, originLabel);
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
