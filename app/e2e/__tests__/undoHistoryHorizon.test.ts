//! FILENAME: app/e2e/__tests__/undoHistoryHorizon.test.ts
// PURPOSE: Unit tier for `stepsBackToBaseline` -- the pure function that
//          decides how far the undo-round-trip oracle winds back, or why it
//          cannot wind back at all.
// CONTEXT: This function is the oracle's whole judgement. Everything else in
//          `undoRoundTrip.ts` needs a running app; this does not, which is why
//          it was written pure and exported in the first place.
//
//          IT HAS THREE CAUSES TO TELL APART, and only one of them is ever a
//          product defect:
//
//            1. the size cap dropped the remembered entry   -> evictedTotal moved
//            2. a workbook-STRUCTURE change ended the history -> clearedTotal moved
//            3. the walk undid past its own checkpoint      -> neither moved
//
//          (2) did not exist as a distinguishable case until BUG-0005 was
//          fixed, and its absence is what that bug was FILED as: soak seed
//          424242 added a sheet at action 35 and the oracle reported "undo-all
//          did not restore the checkpoint, 14 digest differences" -- a report
//          about undo, produced by an action Excel does not let you undo at
//          all. Excel ends the undo history when a sheet is added, deleted,
//          renamed, moved or copied, and Calcula now matches it, so the
//          oracle's job in that window is to say the checkpoint is outside the
//          history rather than to blame the product.
//
//          A wrong answer here is invisible in a green run and expensive in a
//          red one: a false "unreachable" silently stops testing undo, and a
//          false defect costs a triage cycle (it cost two, S11 and S12).

import { describe, it, expect } from "vitest";
import { stepsBackToBaseline } from "../oracles/undoRoundTrip";

type Baseline = Parameters<typeof stepsBackToBaseline>[0];
type Now = Parameters<typeof stepsBackToBaseline>[1];

function baseline(over: Partial<Baseline> = {}): Baseline {
  return { undoTopSeq: null, evictedTotal: 0, clearedTotal: 0, ...over };
}
function now(over: Partial<Now> = {}): Now {
  return { undoSeqs: [], evictedTotal: 0, clearedTotal: 0, ...over };
}

describe("stepsBackToBaseline: the ordinary case", () => {
  it("counts the entries sitting above the remembered id", () => {
    const result = stepsBackToBaseline(
      baseline({ undoTopSeq: 7 }),
      now({ undoSeqs: [5, 6, 7, 8, 9, 10] })
    );
    expect(result).toEqual({ steps: 3 });
  });

  it("counts every entry when the stack was empty at the checkpoint", () => {
    const result = stepsBackToBaseline(baseline(), now({ undoSeqs: [1, 2] }));
    expect(result).toEqual({ steps: 2 });
  });

  it("reports zero steps when nothing undoable happened in the window", () => {
    const result = stepsBackToBaseline(
      baseline({ undoTopSeq: 9 }),
      now({ undoSeqs: [7, 8, 9] })
    );
    expect(result).toEqual({ steps: 0 });
  });
});

describe("stepsBackToBaseline: a sheet operation ended the history", () => {
  // THE BUG-0005 CASE. Excel does not let a sheet add/delete/rename/move/copy
  // be undone, and ending the history is how it avoids applying an undo entry
  // to a renumbered sheet. The oracle must recognise that, not report it.
  it("says so when the remembered entry was discarded by a wholesale clear", () => {
    const result = stepsBackToBaseline(
      baseline({ undoTopSeq: 4, clearedTotal: 0 }),
      now({ undoSeqs: [11, 12], clearedTotal: 9 })
    );
    expect(result).toHaveProperty("unreachable");
    const { unreachable } = result as { unreachable: string };
    expect(unreachable).toContain("workbook-structure change");
    expect(unreachable).toContain("9 transaction(s) discarded");
    // The critical negative: it must NOT accuse the walk of undoing past its
    // own checkpoint, which is a different mechanism with a different remedy.
    expect(unreachable).not.toContain("undid past");
  });

  it("says so even when the stack was empty at the checkpoint", () => {
    // An empty baseline cannot notice a clear by looking at ids -- every id is
    // post-baseline either way -- so the counter is the only evidence. Without
    // this branch a walk that started a window with an empty stack, edited
    // cells, then inserted a sheet would be told to undo `undoSeqs.length`
    // steps and would compare against a digest it can no longer reach.
    const result = stepsBackToBaseline(
      baseline({ undoTopSeq: null, clearedTotal: 2 }),
      now({ undoSeqs: [30, 31], clearedTotal: 5 })
    );
    expect(result).toHaveProperty("unreachable");
    expect((result as { unreachable: string }).unreachable).toContain(
      "3 transaction(s) discarded"
    );
  });

  it("takes precedence over the cap when both moved", () => {
    // A long window can overflow the cap AND end the history. The clear is the
    // more informative answer: eviction loses the OLDEST entries, a clear loses
    // all of them, and the remedy differs (raise the cap vs. do not checkpoint
    // across a sheet operation).
    const result = stepsBackToBaseline(
      baseline({ undoTopSeq: 4, evictedTotal: 0, clearedTotal: 0 }),
      now({ undoSeqs: [50], evictedTotal: 12, clearedTotal: 30 })
    );
    expect((result as { unreachable: string }).unreachable).toContain(
      "workbook-structure change"
    );
  });
});

describe("stepsBackToBaseline: the other two causes still answer for themselves", () => {
  it("blames the cap when only eviction moved", () => {
    const result = stepsBackToBaseline(
      baseline({ undoTopSeq: 4, evictedTotal: 0 }),
      now({ undoSeqs: [11, 12], evictedTotal: 7 })
    );
    expect((result as { unreachable: string }).unreachable).toContain(
      "overflow of the history cap"
    );
  });

  it("blames the walk when neither counter moved", () => {
    // The one case that is genuinely about the walk's own behaviour: the
    // remembered entry was undone past and a later action cleared the redo
    // stack, so the state it named is gone for good.
    const result = stepsBackToBaseline(
      baseline({ undoTopSeq: 4 }),
      now({ undoSeqs: [11, 12] })
    );
    expect((result as { unreachable: string }).unreachable).toContain(
      "undid past the checkpoint"
    );
  });

  it("survives a baseline written before clearedTotal existed", () => {
    // Defensive, and cheap: a baseline object round-tripped through an older
    // report has no `clearedTotal`. `undefined - 0` is NaN, and `NaN > 0` is
    // false, so the guard would silently never fire -- the exact shape of
    // failure this whole file exists to prevent.
    const stale = { undoTopSeq: 4, evictedTotal: 0 } as unknown as Baseline;
    const result = stepsBackToBaseline(stale, now({ undoSeqs: [11], clearedTotal: 3 }));
    expect((result as { unreachable: string }).unreachable).toContain(
      "workbook-structure change"
    );
  });
});
