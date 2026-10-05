//! FILENAME: app/extensions/BuiltIn/HomeTab/components/font/fontCommand.ts
// PURPOSE: A Font-group control's write through the group's formatting door
//          (`state.applyFormat`), with a refusal said to the user. (Its
//          command door, runFontCommand, was folded into ../runCommand.ts on
//          2026-10-04 with the other three groups' identical copies.)
// CONTEXT: useHomeTabState's handleMergeCommand pattern, kept here so this
//          folder's controls do not each spell it.
//
//          `state.applyFormat` already refuses while something else owns the
//          selection, and logs a backend failure itself; the catch below is
//          for a door that THROWS (a future door, or a test double), so a
//          click never ends in an unhandled rejection with nobody above it.

import { alertAsync } from "@api/dialogs";
import type { HomeTabState } from "../homeItemProps";
import { messageOf } from "../runCommand";

/**
 * Write `formatting` to the selection through the group's door, named
 * `action` (what a refusal and the undo step call it). Never rejects.
 */
export async function applyFontFormat(
  state: HomeTabState,
  formatting: Record<string, unknown>,
  action: string,
): Promise<void> {
  try {
    await state.applyFormat(formatting, action);
  } catch (err) {
    void alertAsync(messageOf(err));
  }
}
