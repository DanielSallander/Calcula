//! FILENAME: app/extensions/Pivot/lib/pivotChromeRepeat.ts
// PURPOSE: The ONE double-click guard of a pivot's chrome, for a canvas pivot
//          box and a worksheet pivot alike. The two clicks of a double-click on
//          a +/- would toggle it twice (back to where it was), so a release that
//          repeats the SAME piece of chrome within REPEAT_PRESS_MS of the last
//          release that acted is dropped.
// CONTEXT: The chrome acts at the RELEASE (pivotChromePress.ts for the box,
//          Core's press session for the worksheet, via pivotCellChrome.ts), so
//          the window is measured between releases. The canvas box had this
//          guard since M7 (inside pivotVisualOverlay.ts `handlePivotVisualPress`);
//          the worksheet chrome had none, so a double-click on a worksheet +/-
//          toggled twice where the box toggled once (owner question 27,
//          2026-10-02: "give the worksheet chrome the canvas box's 450 ms guard,
//          for one behaviour"). Both now ask this module.

/** A repeat of the same piece of chrome within this many ms of the last release that acted is dropped. */
export const REPEAT_PRESS_MS = 450;

/** The last release that acted: which piece of chrome, and when. */
let lastAct: { key: string; at: number } | null = null;

/**
 * A release on the piece of chrome named `key` is about to act. Answers false
 * -- DROP it -- when `guarded` and it repeats the last release that acted, on
 * the same key, less than REPEAT_PRESS_MS later. Otherwise it becomes the last
 * release that acted and the answer is true. The loading indicator's Cancel is
 * not guarded (its callers pass `guarded: false`): a second Cancel undoes
 * nothing.
 */
export function chromeReleaseActs(key: string, guarded: boolean, now: number = Date.now()): boolean {
  if (guarded && lastAct !== null && lastAct.key === key && now - lastAct.at < REPEAT_PRESS_MS) {
    return false;
  }
  lastAct = { key, at: now };
  return true;
}

/** Forget the last release (a new installation of the pivot's chrome starts clean). */
export function forgetChromeReleases(): void {
  lastAct = null;
}
