//! FILENAME: app/src/api/chatPromptService.ts
// PURPOSE: Let a feature hand the AI chat a prepared prompt, without importing
//          the chat.
// CONTEXT: The Insights pane's "Send to chat" is the first caller: it has a set
//          of deterministic facts and wants a model to put them into a
//          paragraph. That is the right division of labour — the facts are
//          computed and checkable, the prose is not — but it needs a way to
//          reach the chat that does not make Insights depend on AIChat.
//
//          PREFILL, NOT AUTO-SEND, by default. The text goes into the composer
//          and the person presses send. A feature that could silently start a
//          model turn on the user's behalf is a feature that will eventually do
//          it at the wrong moment, and the chat's own convention is already
//          "offered, never automatic".

export interface ChatPromptSink {
  /** False when the chat cannot be opened, so a caller can hide the control. */
  isAvailable(): boolean;
  /**
   * Open the chat and put `text` in the composer.
   *
   * `autoSend` defaults to false and should stay false unless the user has
   * just explicitly asked for the answer.
   */
  openWithPrompt(text: string, options?: { autoSend?: boolean }): void;
}

let sink: ChatPromptSink | null = null;

/** Register the sink. Called once by AIChat at activation. */
export function registerChatPromptSink(next: ChatPromptSink): () => void {
  sink = next;
  return () => {
    if (sink === next) sink = null;
  };
}

/** Whether a "Send to chat" control should be rendered at all. */
export function hasChatPromptSink(): boolean {
  return sink !== null && sink.isAvailable();
}

/**
 * Hand the chat a prompt. Returns false when there was no chat to hand it to.
 *
 * Deliberately not a throw: this is an optional convenience on somebody else's
 * pane, and a missing chat should grey out a button rather than raise inside an
 * unrelated feature's click handler.
 */
export function openChatWithPrompt(text: string, options?: { autoSend?: boolean }): boolean {
  if (!sink || !sink.isAvailable()) return false;
  sink.openWithPrompt(text, options);
  return true;
}

export function resetChatPromptSink(): void {
  sink = null;
}
