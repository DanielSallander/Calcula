//! FILENAME: app/src/api/scriptHost/scriptPreview/dryRunCaveat.ts
// PURPOSE: Decide, in ONE place, which sentence a surface shows about a preview
//          that changed nothing.
// CONTEXT: docs/design/local-model-script-authoring.md §5c.1. MOVED here from
//          `AIChat/lib/dryRunNotes.ts` on 2026-08-26: the Object Script Editor
//          is a separate Tauri window and may not import AIChat's internals, and
//          this rule sits beside the `unexercisedHooks` leaf it is built on.
//
//          THE RULE IS NEGATIVE, which is why it is a function and not two
//          ternaries in a component tree: "It ran without error but changed no
//          cells. That is expected if the open sheet has nothing for it to act
//          on" must NEVER be shown when the reason for the zero is that the
//          handler holding the work was never fired. That sentence blames the
//          user's data for the preview's own limitation, and it is the exact
//          opposite of the truth in the commonest non-button case.
//
//          A negative rule written inline disappears on the next edit to the
//          tree around it. Written here it has a name, a test file and two
//          callers.
//
//          TONE IS A PARAMETER, NOT A SHARED STRING. The guided screen is read
//          BEFORE you go and try the script; the diff is read with your finger
//          on Accept. "Try it on real data before relying on it" is the right
//          advice in the first place and the wrong one in the second, where the
//          next action is not a trial run at all. Sharing one wording would have
//          downgraded the editor's existing sentence and redded the two "Read
//          that handler yourself" assertions in objectScriptEditorAiEdit.test.tsx.

import { unexercisedHookNote } from "./unexercisedHooks";

/** What the run reported, as the result card already knows it. */
export interface DryRunCaveatInput {
  /** The preview RAN, judged the script, and no cell changed. */
  changedNothing: boolean;
  /** Handlers the script registered that the preview could not fire. */
  unexercisedHooks: readonly string[] | undefined;
  /** "advice" = the guided screen (you are about to go and try it).
   *  "review" = the diff (your next action is pressing Accept). */
  tone?: "advice" | "review";
}

/**
 * The one sentence to show about the run, or "" when there is nothing to say.
 *
 * THE UNEXERCISED BRANCH COMES FIRST, and the ordering is the whole invariant:
 * when a handler was never fired, that fact explains the zero and the
 * "check it against real data" sentence would be a false explanation of it. It
 * also fires when cells DID change — a script whose click handler ran and whose
 * selection handler did not was still only half measured.
 */
export function dryRunCaveat(input: DryRunCaveatInput): string {
  const review = input.tone === "review";
  const unexercised = unexercisedHookNote(input.unexercisedHooks);
  if (unexercised) {
    if (review) {
      const plural = (input.unexercisedHooks?.length ?? 0) > 1;
      return `${unexercised} Read ${plural ? "those handlers" : "that handler"} yourself before accepting.`;
    }
    return `${unexercised} Try it on real data before relying on it.`;
  }
  if (input.changedNothing) {
    return review
      ? "It ran without error against a copy of your workbook but changed no cells. " +
          "That is expected if the open sheet has nothing for it to act on — read it " +
          "yourself before accepting."
      : "It ran without error against a copy of your workbook but changed no cells. " +
          "That is expected if the open sheet has nothing for it to act on — check it " +
          "against real data before relying on it.";
  }
  return "";
}
