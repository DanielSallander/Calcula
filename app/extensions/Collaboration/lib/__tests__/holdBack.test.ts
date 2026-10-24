//! FILENAME: app/extensions/Collaboration/lib/__tests__/holdBack.test.ts
// PURPOSE: The push dialog's hold-back reducer (lib/holdBack.ts): unticks are
//          SORTED and PRUNED, never cleared, when a comparison lands; an untick
//          whose sheet the push does not carry is PARKED -- it holds nothing
//          back and comes back with its sheet; WHICH sheets the push carries is
//          the answer's to say (`carriedSheetIds`), never the ticked rows'; and
//          every untick a comparison takes away is counted, so the dialog can
//          say so.
// CONTEXT: Review round 9, DIALOG-TS F1: the diff effect cleared every untick
//          on each refetch, and the dialog refetches on its own after a
//          gone-sheet refusal (it reads the sheet list again), so a held-back
//          private number was ticked again in silence and the next Push
//          published it. Review round 10, DIALOG-TS-R10-1: the fix then DROPPED
//          the unticks of a sheet that left the push, so unticking the sheet by
//          mistake and ticking it again did the same, under a sentence that was
//          no longer true. Review round 11, RV11-TS-1: the unticks were sorted
//          by the TICKED rows, and a push carries more -- a floating grid's
//          backing sheet with its host, a chart's source -- so an untick on such
//          a sheet was parked while its sheet shipped. The mounted half is
//          pushHoldBackSurvivesReRead.test.tsx.

import { describe, it, expect } from "vitest";
import {
  EMPTY_HOLD_BACK,
  describeDroppedHoldBacks,
  describeParkedHoldBacks,
  holdBackReducer,
  parseCellKey,
  type HoldBackAction,
  type HoldBackState,
} from "../holdBack";

const A1 = "id-summary:0:0";
const B2 = "id-summary:1:1";
const D1 = "id-dashboard:0:3";
/** A cell of a floating grid's BACKING sheet: carried with its host page, never ticked itself. */
const F_B2 = "id-float:1:1";

function run(state: HoldBackState, ...actions: HoldBackAction[]): HoldBackState {
  return actions.reduce(holdBackReducer, state);
}

const untick = (key: string): HoldBackAction => ({ type: "toggle", key, include: false });
const tick = (key: string): HoldBackAction => ({ type: "toggle", key, include: true });
/** A comparison landed, and says the push CARRIES these sheets. */
const carries = (...sheetIds: string[]): HoldBackAction => ({ type: "keepSheets", sheetIds: new Set(sheetIds) });
/** ...and lists these rows; on the sheets it carries, the unticks without one go. */
const listed = (sheetIds: string[], rows: string[]): HoldBackAction => ({
  type: "keepRows",
  keys: new Set(rows),
  sheetIds: new Set(sheetIds),
});
const sorted = (keys: ReadonlySet<string>): string[] => [...keys].sort();

describe("the author's own gestures", () => {
  it("an untick holds the change back, a re-tick lets it go, Push all lets every one go", () => {
    let s = run(EMPTY_HOLD_BACK, untick(A1), untick(D1));
    expect(sorted(s.excluded)).toEqual([D1, A1].sort());
    s = run(s, tick(A1));
    expect([...s.excluded]).toEqual([D1]);
    s = run(s, { type: "includeAll" });
    expect(s.excluded.size).toBe(0);
  });

  it("an untick or Push all replaces an earlier notice, which would otherwise go stale", () => {
    const dropped = run(EMPTY_HOLD_BACK, untick(A1), untick(B2), listed(["id-summary"], [A1]));
    expect(dropped.dropped).toBe(1);
    expect(run(dropped, untick(D1)).dropped).toBe(0);
    expect(run(dropped, { type: "includeAll" }).dropped).toBe(0);
  });

  // SABOTAGE: let includeAll keep `parked`.
  it("Push all lets the PARKED unticks go too: every change is pushed once its sheet is", () => {
    const s = run(EMPTY_HOLD_BACK, untick(A1), untick(D1), carries("id-summary"));
    expect([...s.parked], "the precondition: D1 is parked").toEqual([D1]);
    const all = run(s, { type: "includeAll" });
    expect(all.excluded.size).toBe(0);
    expect(all.parked.size, "Push all left a parked untick to come back later").toBe(0);
    // ...so a push that carries Dashboard again brings nothing back.
    expect(run(all, carries("id-summary", "id-dashboard")).excluded.size).toBe(0);
  });

  // SABOTAGE: put every untick in `excluded` again (`toggle` ignoring
  // `carried`) -- an untick on a "removed" sheet's row is then counted as a
  // change that stays local, on a sheet the push does not publish at all.
  it("an untick on a row of a sheet the latest answer does NOT carry -- a 'removed' base sheet -- is parked at once", () => {
    // The answer carries Dashboard only; it lists Summary as "removed", so
    // Summary!A1's row is on screen with a box.
    const s = run(EMPTY_HOLD_BACK, carries("id-dashboard"), untick(A1), untick(D1));
    expect([...s.parked], "an untick on a sheet the push does not carry was counted as acting").toEqual([A1]);
    expect([...s.excluded]).toEqual([D1]);
    // The re-tick takes it back from wherever it is.
    const back = run(s, tick(A1));
    expect(back.parked.size, "a re-tick left the untick parked").toBe(0);
    expect([...back.excluded]).toEqual([D1]);
  });

  // SABOTAGE: park an untick when no answer has landed yet.
  it("before any comparison has landed an untick acts: there is nothing to judge it by, and Rust decides at the push", () => {
    expect(EMPTY_HOLD_BACK.carried).toBeNull();
    const s = run(EMPTY_HOLD_BACK, untick(A1));
    expect([...s.excluded], "an untick before any answer did not act").toEqual([A1]);
    expect(s.parked.size).toBe(0);
  });
});

describe("a comparison landed: the unticks are SORTED by what it says the push carries, never dropped", () => {
  // SABOTAGE: drop the unticks whose sheet is not carried (round 10's keepSheets).
  it("an untick on a carried sheet acts; one on a sheet the push does not carry is PARKED, and nothing is said dropped", () => {
    const s = run(EMPTY_HOLD_BACK, untick(A1), untick(B2), untick(D1), carries("id-summary", "id-private"));
    expect(sorted(s.excluded), "an untick on a carried sheet was lost").toEqual([A1, B2].sort());
    expect([...s.parked], "the untick on the sheet the push does not carry was lost").toEqual([D1]);
    expect(s.dropped, "parking an untick is not dropping it").toBe(0);
  });

  // SABOTAGE: never move a parked key back into `excluded` (sort only the
  // active ones, keep `parked` as it was).
  it("an answer that carries the sheet again brings its parked unticks back: they act again, unticked on their rows", () => {
    const parked = run(EMPTY_HOLD_BACK, untick(A1), untick(D1), carries("id-dashboard"));
    expect([...parked.parked]).toEqual([A1]);
    expect([...parked.excluded]).toEqual([D1]);
    const back = run(parked, carries("id-summary", "id-dashboard"));
    expect(sorted(back.excluded), "carrying the sheet again did not bring its hold-back back").toEqual([D1, A1].sort());
    expect(back.parked.size).toBe(0);
    expect(back.dropped).toBe(0);
  });

  // THE ROUND-11 LEAK, in the reducer: a sheet nobody ticks -- a floating
  // grid's backing sheet -- is carried with its host, and an untick on it acts
  // exactly when the answer says so. SABOTAGE: sort by any set but the answer's.
  it("an untick on a sheet carried by ANOTHER route -- a floating grid's backing sheet -- acts while the answer carries it, and comes back with it", () => {
    let s = run(EMPTY_HOLD_BACK, carries("id-summary", "id-page", "id-float"), untick(F_B2));
    expect([...s.excluded], "the backing sheet's untick does not act while its host is carried").toEqual([F_B2]);
    // The host page unticked: the backing sheet is not carried any more.
    s = run(s, carries("id-summary"));
    expect([...s.parked]).toEqual([F_B2]);
    // The host ticked again: the answer carries the backing sheet again.
    s = run(s, carries("id-summary", "id-page", "id-float"));
    expect([...s.excluded], "the answer that carries the backing sheet again did not un-park its untick").toEqual([F_B2]);
    expect(s.parked.size).toBe(0);
  });

  it("an answer that carries nothing parks every untick; one that carries them again brings every one back", () => {
    const none = run(EMPTY_HOLD_BACK, untick(A1), untick(D1), carries());
    expect(none.excluded.size).toBe(0);
    expect(sorted(none.parked)).toEqual([D1, A1].sort());
    expect(sorted(run(none, carries("id-summary", "id-dashboard")).excluded)).toEqual([D1, A1].sort());
  });

  // SABOTAGES, each on its own: never record the answer's carried sheets
  // (keepSheets keeps `state.carried`); or let a fresh start forget them.
  it("remembers the sheets the latest answer carries, and a fresh start keeps them: they describe the rows on screen", () => {
    const s = run(EMPTY_HOLD_BACK, carries("id-dashboard"), untick(D1));
    expect(s.carried, "the answer's carried sheets were not recorded").not.toBeNull();
    expect(sorted(s.carried!)).toEqual(["id-dashboard"]);
    const next = run(s, carries("id-summary"));
    expect(next.carried, "the next answer's carried sheets were not recorded").not.toBeNull();
    expect(sorted(next.carried!), "the next answer's carried sheets were not recorded").toEqual(["id-summary"]);
    // A reset forgets the unticks, not the answer: an untick on a "removed"
    // row after it is still parked at once.
    const fresh = run(s, { type: "reset" });
    expect(fresh.carried, "a fresh start forgot the latest answer's carried sheets").not.toBeNull();
    expect(sorted(fresh.carried!)).toEqual(["id-dashboard"]);
    expect([...run(fresh, untick(A1)).parked], "after a fresh start a removed row's untick acted").toEqual([A1]);
    const all = run(s, { type: "includeAll" });
    expect(all.carried, "Push all forgot the latest answer's carried sheets").not.toBeNull();
    expect(sorted(all.carried!)).toEqual(["id-dashboard"]);
  });
});

describe("the same answer's rows: it judges only the sheets it says the push carries", () => {
  // SABOTAGE: make keepRows keep everything (or nothing).
  it("on a carried sheet, unticks that are one of its rows stay; the others are dropped and counted", () => {
    const s = run(EMPTY_HOLD_BACK, untick(A1), untick(B2), listed(["id-summary"], [A1, "id-summary:5:5"]));
    expect([...s.excluded]).toEqual([A1]);
    expect(s.dropped).toBe(1);
  });

  // SABOTAGE: remove the limit (`keep = (key) => keys.has(key)`).
  it("an untick on a sheet the push does NOT carry is not the answer's to judge -- above all a parked one", () => {
    // A1 is parked (Summary not carried); the answer carries Dashboard and lists D1.
    const s = run(
      EMPTY_HOLD_BACK,
      untick(A1),
      untick(D1),
      carries("id-dashboard"),
      listed(["id-dashboard"], [D1]),
    );
    expect([...s.parked], "the answer for the other sheet took a parked hold-back away").toEqual([A1]);
    expect([...s.excluded]).toEqual([D1]);
    expect(s.dropped, "a parked untick was counted as no longer listed").toBe(0);
    // And it comes back with its sheet.
    expect(sorted(run(s, carries("id-summary", "id-dashboard")).excluded)).toEqual([D1, A1].sort());
  });

  it("a 'removed' sheet's rows judge nothing either: its parked unticks stay, row or no row", () => {
    // Summary is listed as removed (its rows A1, B2 on screen) and not carried.
    const s = run(EMPTY_HOLD_BACK, untick(A1), untick(B2), carries("id-dashboard"), listed(["id-dashboard"], [D1]));
    expect(sorted(s.parked), "an answer took a parked untick on a sheet it does not carry away").toEqual(
      [A1, B2].sort(),
    );
    expect(s.dropped).toBe(0);
  });

  it("drops add up across comparisons until the author acts", () => {
    const s = run(
      EMPTY_HOLD_BACK,
      untick(A1),
      untick(B2),
      untick(D1),
      listed(["id-summary", "id-dashboard"], [A1, D1]),
      listed(["id-summary", "id-dashboard"], [A1]),
    );
    expect([...s.excluded]).toEqual([A1]);
    expect(s.dropped).toBe(2);
  });

  it("a sort or a prune that changes nothing returns the SAME state (nothing re-renders, nothing is said)", () => {
    const before = run(EMPTY_HOLD_BACK, untick(A1), untick(D1), carries("id-summary"));
    expect(holdBackReducer(before, carries("id-summary"))).toBe(before);
    expect(holdBackReducer(before, listed(["id-summary"], [A1]))).toBe(before);
    expect(holdBackReducer(before, listed(["id-other"], []))).toBe(before);
    expect(before.dropped).toBe(0);
    // A different carried set that sorts nothing differently keeps the very
    // sets, and records the new answer.
    const moved = holdBackReducer(before, carries("id-summary", "id-other"));
    expect(moved).not.toBe(before);
    expect(moved.excluded).toBe(before.excluded);
    expect(moved.parked).toBe(before.parked);
    expect(sorted(moved.carried!)).toEqual(["id-other", "id-summary"]);
  });

  it("a reset -- a new show, a landed push -- forgets the unticks, the parked ones AND the notice", () => {
    const s = run(EMPTY_HOLD_BACK, untick(A1), untick(B2), untick(D1), carries("id-summary"), listed(["id-summary"], [A1]));
    expect(s.parked.size + s.dropped, "the precondition: something parked and something dropped").toBe(2);
    const fresh = holdBackReducer(s, { type: "reset" });
    expect(fresh.excluded.size).toBe(0);
    expect(fresh.parked.size).toBe(0);
    expect(fresh.dropped).toBe(0);
  });
});

describe("the keys and the sentences", () => {
  it("a key parses back to the cell it names, even when the sheet id holds a colon", () => {
    expect(parseCellKey("id-summary:12:3")).toEqual({ sheetId: "id-summary", row: 12, col: 3 });
    expect(parseCellKey("urn:sheet:7:0:4")).toEqual({ sheetId: "urn:sheet:7", row: 0, col: 4 });
  });

  it("says a drop in plain words, naming the panel the rows were in", () => {
    expect(describeDroppedHoldBacks(1, "1.0.0")).toBe(
      '1 change(s) you held back are no longer held back, because "Changes since v1.0.0" no longer lists them.',
    );
    expect(describeDroppedHoldBacks(3, "2.1.0")).toContain('"Changes since v2.1.0"');
  });

  it("says what is parked in terms of what the push CARRIES, never of the sheet boxes", () => {
    expect(describeParkedHoldBacks(1)).toBe(
      "1 change(s) you held back are on a sheet this push does not carry; they stay held back if the push carries it again.",
    );
    expect(describeParkedHoldBacks(2), "the parked line claims they are no longer held back").not.toMatch(
      /no longer held back/,
    );
    // A backing sheet has no box to tick: the sentence must not tell the author to tick it.
    expect(describeParkedHoldBacks(2)).not.toMatch(/tick it/);
  });
});
