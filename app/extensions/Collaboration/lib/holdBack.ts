// FILENAME: app/extensions/Collaboration/lib/holdBack.ts
// PURPOSE: The push dialog's HOLD-BACK -- the changes the author unticked in
//          "Changes since vN", which the push publishes with the base
//          version's value instead (`holdBackCells`) -- and what happens to
//          those unticks when the selection moves or the comparison is worked
//          out again.
// CONTEXT: The unticks used to be CLEARED on every refetch of the working-copy
//          diff, on the theory that a key kept from the previous answer could
//          name a row that no longer exists. But the dialog refetches on its
//          own: after a gone-sheet refusal it reads the sheet list again, the
//          selection moves, and the diff runs again. So every cell the author
//          had held back was ticked again with no message, and the next Push
//          published it -- a private number, to every subscriber, under the
//          author's key (review round 9, DIALOG-TS F1).
//
//          Round 10 then DROPPED an untick whose sheet left the push, and said
//          so. That was the same leak one gesture later: untick Summary!A1,
//          untick the Summary sheet by mistake, tick it again -- and A1 came
//          back ticked, the next Push published it, and the only sentence on
//          screen still said "their sheet is no longer in this push", with
//          Summary in the push (review round 10, DIALOG-TS-R10-1).
//
//          Round 11 PARKED such an untick instead -- but sorted the unticks by
//          the TICKED ROWS, and a push carries more sheets than are ticked: a
//          floating grid's backing sheet travels with the page that hosts it,
//          and a sheet a chart on a ticked sheet reads joins the push too (the
//          resolver's expansion, `resolve_publish_selection`). An untick on
//          such a sheet was parked, its row showed ticked again, the line under
//          the panel said its sheet was not in this push -- and the push shipped
//          the cell (review round 11, RV11-TS-1).
//
//          THE RULE NOW: an untick is the author's, and only the author takes
//          it back -- and WHICH SHEETS A PUSH CARRIES is Rust's to say, never
//          this dialog's to rebuild.
//            * A push sends EVERY untick, active and parked, with its own sheet
//              selection (`holdBackCells`), and Rust holds back exactly the ones
//              on sheets that push carries, skipping the rest. Over-sending is
//              harmless; under-sending is the leak.
//            * When a comparison lands, the unticks are SORTED by the sheets it
//              says the push carries (`WorkingCopyDiff.carriedSheetIds`,
//              `keepSheets`), never dropped: on a carried sheet they act
//              (`excluded`), on any other they are PARKED (`parked`). NOTHING
//              MOVES BEFORE THAT ANSWER: between a gesture and the answer a key
//              stays where the last answer put it -- the push is right either
//              way, because Rust decides.
//            * ...then, ON THE CARRIED SHEETS ONLY, an untick whose row the
//              answer does not list is dropped (`keepRows`) -- and that is SAID.
//              The rows are the only place an untick can be seen -- the push
//              dialog lists the diff's SAMPLE rows and nothing else -- so an
//              untick without a row would act on a push nobody reviewed. A
//              sheet the push does not carry is not judged at all: its rows'
//              absence says nothing about a parked untick.
//            * A ROW ON SCREEN CAN BE ON A SHEET THE PUSH DOES NOT CARRY: the
//              diff lists an unticked BASE sheet as "removed", every cell a row
//              with a box. Such a sheet is not carried, so an untick on one of
//              its rows is parked at once (`toggle`, by the latest answer's
//              `carried`), and the line under the panel says so -- never counted
//              as a change that stays local.
//            * The author's own gestures (an untick, a re-tick, Push all) and a
//              fresh start (a new show, a landed push) replace the notice; Push
//              all and a fresh start also let every parked untick go.
//
//          Pure: a reducer the dialog drives with `useReducer`, so the unticks
//          and the sentences about them change in ONE update, and a sentence
//          can never disagree with the set it describes.

import type { HoldBackCellRef } from "@api/collaboration";
import { formatNumber } from "@api/locale";

/** The hold-back as the dialog keeps it. */
export interface HoldBackState {
  /**
   * The unticked cells ON SHEETS THE LATEST COMPARISON SAYS THIS PUSH CARRIES,
   * as `cellKeyOf` strings (components/VersionDiffView.tsx): what the strip
   * under the panel counts as staying local.
   *
   * AN EXCLUSION SET. The diff rows are a bounded sample, so a changed cell may
   * have no row -- storing what was opted OUT of means every cell the dialog
   * could not show is pushed, which is exactly what a push has always done.
   */
  readonly excluded: ReadonlySet<string>;
  /**
   * The author's unticks on sheets the LATEST COMPARISON SAYS THIS PUSH DOES
   * NOT CARRY -- unticked, gone from the list read again, a floating grid's
   * backing sheet whose host page is unticked, or an unticked base sheet the
   * diff lists as "removed". A push still SENDS them (Rust holds back exactly
   * the ones on sheets that push carries), so they act the moment the push
   * carries their sheet again; the next comparison that says so moves them
   * back into `excluded`. Disjoint from `excluded`.
   */
  readonly parked: ReadonlySet<string>;
  /**
   * Unticks a new comparison took away -- their sheet is carried, and the
   * answer no longer lists their row -- since the author last acted on the
   * list. 0 = none.
   */
  readonly dropped: number;
  /**
   * The sheets (stable ids, `WorkingCopyDiff.carriedSheetIds`) the LATEST
   * comparison says this push carries -- the answer whose rows are on screen --
   * or `null` before one has landed. An untick of a row goes where this puts its
   * sheet. A fresh start keeps it: it describes the rows still on screen, not
   * the author's unticks.
   */
  readonly carried: ReadonlySet<string> | null;
}

/** Nothing held back, nothing to say, no comparison yet: where the dialog starts. */
export const EMPTY_HOLD_BACK: HoldBackState = {
  excluded: new Set<string>(),
  parked: new Set<string>(),
  dropped: 0,
  carried: null,
};

export type HoldBackAction =
  /** The author ticked (`include`) or unticked one row. */
  | { type: "toggle"; key: string; include: boolean }
  /** The author pressed Push all: every change goes, the parked ones included. */
  | { type: "includeAll" }
  /** A new show, or a push that landed: every change on screen is ticked again, by design. */
  | { type: "reset" }
  /**
   * A comparison landed, and says this push CARRIES the sheets `sheetIds`
   * (stable ids, `WorkingCopyDiff.carriedSheetIds`): the unticks on them act;
   * every other one is parked -- never dropped.
   */
  | { type: "keepSheets"; sheetIds: ReadonlySet<string> }
  /**
   * The same comparison's rows: on the sheets `sheetIds` -- the ones it says the
   * push carries -- keep only the unticks that are one of its rows (`keys`). An
   * untick on any other sheet is not this answer's to judge, whether it has a
   * row there (a "removed" sheet's) or not.
   */
  | { type: "keepRows"; keys: ReadonlySet<string>; sheetIds: ReadonlySet<string> };

/**
 * `cellKeyOf` in reverse. The key carries the diff row's SHEET ID, which for a
 * working copy is directly the application's -- so this is a parse, not a
 * lookup that could go stale between the tick and the push. The LAST two
 * colons split it, so an id that contains a colon still parses.
 */
export const parseCellKey = (k: string): HoldBackCellRef => {
  const colAt = k.lastIndexOf(":");
  const rowAt = k.lastIndexOf(":", colAt - 1);
  return {
    sheetId: k.slice(0, rowAt),
    row: Number(k.slice(rowAt + 1, colAt)),
    col: Number(k.slice(colAt + 1)),
  };
};

/** Whether `a` holds exactly the keys of `b`. */
function sameKeys(a: readonly string[], b: ReadonlySet<string>): boolean {
  return a.length === b.size && a.every((key) => b.has(key));
}

/** Whether the cell `key` names is on one of the sheets `sheetIds`. */
const onSheets = (sheetIds: ReadonlySet<string>, key: string): boolean =>
  sheetIds.has(parseCellKey(key).sheetId);

/** No unticks and no notice -- but the latest comparison's carried sheets kept. */
const cleared = (state: HoldBackState): HoldBackState => ({
  excluded: new Set<string>(),
  parked: new Set<string>(),
  dropped: 0,
  carried: state.carried,
});

/** The hold-back after `action`. Returns `state` itself when nothing changed. */
export function holdBackReducer(state: HoldBackState, action: HoldBackAction): HoldBackState {
  switch (action.type) {
    case "toggle": {
      const excluded = new Set(state.excluded);
      const parked = new Set(state.parked);
      excluded.delete(action.key);
      parked.delete(action.key);
      if (!action.include) {
        // WHERE THE LATEST COMPARISON PUTS ITS SHEET. A row on screen can be on
        // a sheet this push does not carry -- an unticked base sheet the diff
        // lists as "removed", cell by cell -- and an untick there holds nothing
        // back: it is parked at once, where the line under the panel says so,
        // rather than counted as a change that stays local. Before any
        // comparison has landed there is nothing to judge by, so it acts (Rust
        // decides at the push either way).
        const carried = state.carried === null || onSheets(state.carried, action.key);
        (carried ? excluded : parked).add(action.key);
      }
      // The gesture is the author's latest word on the list: the notice goes.
      return { excluded, parked, dropped: 0, carried: state.carried };
    }
    case "includeAll":
      return state.excluded.size === 0 && state.parked.size === 0 && state.dropped === 0
        ? state
        : cleared(state);
    case "reset":
      return cleared(state);
    case "keepSheets": {
      // SORTED, NEVER DROPPED: every untick, active or parked, goes where the
      // answer says its sheet now is. `dropped` is untouched -- nothing was
      // taken away.
      const carried = action.sheetIds;
      const all = [...state.excluded, ...state.parked];
      const excluded = all.filter((key) => onSheets(carried, key));
      // The two sets partition `all`, so an unchanged `excluded` means an
      // unchanged `parked`.
      const unsorted = sameKeys(excluded, state.excluded);
      const sameCarried = state.carried !== null && sameKeys([...carried], state.carried);
      if (unsorted && sameCarried) return state;
      return {
        excluded: unsorted ? state.excluded : new Set(excluded),
        parked: unsorted ? state.parked : new Set(all.filter((key) => !onSheets(carried, key))),
        dropped: state.dropped,
        carried: sameCarried ? state.carried : new Set(carried),
      };
    }
    case "keepRows": {
      // ONLY THE SHEETS THIS ANSWER SAYS THE PUSH CARRIES. Everything else -- a
      // parked untick's sheet above all, and a "removed" sheet whose rows are
      // on screen -- is outside what the push will publish, so a row's absence
      // there says nothing.
      const { keys, sheetIds } = action;
      const keep = (key: string): boolean => !onSheets(sheetIds, key) || keys.has(key);
      const excluded = [...state.excluded].filter(keep);
      const parked = [...state.parked].filter(keep);
      const droppedNow = state.excluded.size - excluded.length + (state.parked.size - parked.length);
      if (droppedNow === 0) return state;
      return {
        excluded: new Set(excluded),
        parked: new Set(parked),
        dropped: state.dropped + droppedNow,
        carried: state.carried,
      };
    }
  }
}

/**
 * What the dialog says while unticks are parked. TRUE BY CONSTRUCTION: it
 * counts only the unticks whose sheet the latest comparison says this push does
 * not carry -- never a guess from the sheet boxes -- and it promises only what
 * the push does, because a push sends every untick and Rust holds back exactly
 * the ones on sheets it carries.
 */
export function describeParkedHoldBacks(parked: number): string {
  return (
    `${formatNumber(parked)} change(s) you held back are on a sheet this push does not carry; ` +
    "they stay held back if the push carries it again."
  );
}

/**
 * What the dialog says about unticks a new comparison took away, in plain
 * words -- never silently. `baseVersion` names the panel ("Changes since
 * v1.0.0") the way the dialog titles it.
 */
export function describeDroppedHoldBacks(dropped: number, baseVersion: string): string {
  return (
    `${formatNumber(dropped)} change(s) you held back are no longer held back, because ` +
    `"Changes since v${baseVersion}" no longer lists them.`
  );
}
