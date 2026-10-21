//! FILENAME: app/extensions/GoalSeek/lib/goalSeekParse.ts
// PURPOSE: What the Goal Seek dialog's typed numbers mean (P2 S9): the "To
//          value" is read STRICTLY in the app locale, and the result is shown
//          in it.
// CONTEXT: `parseFloat` read "1,5" under sv-SE as 1 -- the digits before the
//          comma -- and Goal Seek then solved for the WRONG target without a
//          word. The app-locale reader refuses what is not a number there, so
//          the dialog says so instead.

import { formatNumber, parseNumber } from "@api/locale";

/** The typed "To value" as a number, or null when it is no number in the app locale. */
export function parseGoalSeekTarget(text: string): number | null {
  if (text.trim() === "") return null;
  return parseNumber(text);
}

/** A Goal Seek result ("Current value") for display, in the app locale. */
export function formatGoalSeekValue(value: number): string {
  return Number.isFinite(value) ? formatNumber(value) : String(value);
}
