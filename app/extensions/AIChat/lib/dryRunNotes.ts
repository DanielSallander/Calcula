//! FILENAME: app/extensions/AIChat/lib/dryRunNotes.ts
// PURPOSE: Decide, in ONE place, which sentence the guided screen shows about a
//          preview that changed nothing.
// CONTEXT: docs/design/local-model-script-authoring.md §5c.1.
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
//          tree around it. Written here it has a name, a test file and one
//          caller.

import { unexercisedHookNote } from "@api/scriptHost/scriptPreview/unexercisedHooks";

/** What the run reported, as the result card already knows it. */
export interface DryRunCaveatInput {
  /** The preview RAN, judged the script, and no cell changed. */
  changedNothing: boolean;
  /** Handlers the script registered that the preview could not fire. */
  unexercisedHooks: readonly string[] | undefined;
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
  const unexercised = unexercisedHookNote(input.unexercisedHooks);
  if (unexercised) {
    return `${unexercised} Try it on real data before relying on it.`;
  }
  if (input.changedNothing) {
    return (
      "It ran without error against a copy of your workbook but changed no cells. " +
      "That is expected if the open sheet has nothing for it to act on — check it " +
      "against real data before relying on it."
    );
  }
  return "";
}
