// FILENAME: app/extensions/Distribution/__tests__/publishDialogWidth.test.ts
// PURPOSE: The dialog's WIDTH must never be a function of the measurement that
//          the width itself decides.
// CONTEXT: The two-pane push layout shipped unreachable. `width` read
//          `twoPane ? 1040 : 620`, `twoPane` read `!isNarrowBody`, and
//          `isNarrowBody` came from a ResizeObserver on the body. The dialog
//          opens in `loading` mode, so the first render is 620px wide, the mount
//          effect measures ~618, `isNarrowBody` latches true — and when the
//          awaited status resolves to `push` the width expression still reads
//          620. Nothing re-measures. 620 is an absorbing state.
//
//          No unit test could see it: jsdom has no ResizeObserver and no layout,
//          so `bodyWidth` stays 0, `isNarrowBody` is false and `twoPane` comes
//          out true — the test would pass on a dialog that is broken in every
//          real browser. So this pins the SHAPE instead: the width is keyed on
//          `mode`, which no measurement can change, which makes `isNarrowBody` a
//          pure consumer of the width. A consumer-only measurement can collapse
//          a wide dialog, and collapsing terminates; a producer cannot.
//
//          Source-text assertions, deliberately — same reasoning as
//          `pushButtonAnswers.test.ts` next door.

import { describe, it, expect } from "vitest";
import fs from "fs";
import path from "path";

const APP_ROOT = path.resolve(__dirname, "../../..");
const read = (rel: string): string => fs.readFileSync(path.join(APP_ROOT, rel), "utf8");

/** Comments quote the defect they removed, so scanners must not read them. */
const code = (src: string): string =>
  src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");

const DIALOG = code(read("extensions/Distribution/components/PublishDialog.tsx"));

/** The `width:` line inside the window style object. */
function widthExpression(src: string): string {
  const m = src.match(/^\s*width:\s*(.+?),\s*$/m);
  expect(m, "PublishDialog no longer declares a `width:` in its window style").toBeTruthy();
  return m![1];
}

describe("the Publish dialog's width cannot depend on its own measurement", () => {
  it("keys the width on `mode`, not on the measured-width derivatives", () => {
    const w = widthExpression(DIALOG);

    // The cycle, in the two spellings it can take.
    expect(w, "width must not read `twoPane` — that is the measurement's output").not.toMatch(
      /\btwoPane\b/,
    );
    expect(w, "width must not read `isNarrowBody` either").not.toMatch(/\bisNarrowBody\b/);
    expect(w, "width must not read the raw measurement").not.toMatch(/\bbodyWidth\b/);

    // And what it MUST read: the mode, which no measurement can change.
    expect(w).toMatch(/\bmode\b/);
  });

  it("still measures the body, so a genuinely narrow window folds to one column", () => {
    // The fix is not "delete the measurement" — a 1040px dialog on a small
    // screen must still stack. `isNarrowBody` has to survive as a CONSUMER.
    expect(DIALOG).toMatch(/isNarrowBody\s*=/);
    expect(DIALOG).toMatch(/ResizeObserver/);
    expect(DIALOG, "the fold must still be driven by the measurement").toMatch(
      /twoPane\s*=\s*mode === "push" && !isNarrowBody/,
    );
  });

  it("offers both widths, so the two-pane layout is actually reachable", () => {
    const w = widthExpression(DIALOG);
    expect(w).toMatch(/dialogWidth\(1040\)/);
    expect(w).toMatch(/dialogWidth\(620\)/);
  });
});
