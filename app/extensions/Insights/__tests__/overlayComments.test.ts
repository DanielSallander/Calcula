//! FILENAME: app/extensions/Insights/__tests__/overlayComments.test.ts
// PURPOSE: The three outcomes of "a comment follows the data" (§4.8a), each
//          as a test, plus the round trip back home — and the one the owner
//          found live: a fact with TWO cues must not collapse to its first.

import { describe, it, expect } from "vitest";
import { reanchorComments, newComment, datumOfCue } from "../lib/overlayComments";
import type { ChartCue, ChartCueComment } from "@api/chartCues";

function ring(factId: string, series: string, categoryIndex: number, categoryLabel: string, ordinal = 0): ChartCue {
  return { cueId: `${factId}#${ordinal}`, factId, kind: "ring", polarity: "neutral", anchor: { type: "datum", series, categoryIndex, categoryLabel } };
}

const EXT = "extremes:c//Sales/A1:A13:";

describe("reanchorComments", () => {
  it("(a) the cue still names the same datum: the comment stays, at the ring's new index", () => {
    const cue = ring(EXT, "Sales", 2, "Mar");
    const written = newComment("k1", cue, "Launch month", [cue]);
    expect(written.anchor).toEqual({ type: "datum", series: "Sales", categoryIndex: 2, categoryLabel: "Mar" });
    // Jan was hidden by a filter: Mar is now painter index 1.
    const after = reanchorComments([written], [ring(EXT, "Sales", 1, "Mar")]);
    expect(after[0].anchor).toEqual({ type: "datum", series: "Sales", categoryIndex: 1, categoryLabel: "Mar" });
    expect(after[0].movedFrom).toBeUndefined();
  });

  it("(b) the cue now names a different datum: the comment follows and says where from", () => {
    const cue = ring(EXT, "Sales", 2, "Mar");
    const written = newComment("k1", cue, "Launch month", [cue]);
    const after = reanchorComments([written], [ring(EXT, "Sales", 4, "May")]);
    expect(after[0].anchor?.categoryLabel).toBe("May");
    expect(after[0].movedFrom).toBe("Mar");
    // A second move keeps the ORIGINAL label, not the intermediate one.
    const again = reanchorComments(after, [ring(EXT, "Sales", 5, "Jun")]);
    expect(again[0].movedFrom).toBe("Mar");
    // And going back home clears it.
    const home = reanchorComments(again, [ring(EXT, "Sales", 2, "Mar")]);
    expect(home[0].anchor?.categoryLabel).toBe("Mar");
    expect(home[0].movedFrom).toBeUndefined();
  });

  it("(c) the cue is gone: the comment is kept unattached, remembering what it was about", () => {
    const cue = ring(EXT, "Sales", 2, "Mar");
    const written = newComment("k1", cue, "Launch month", [cue]);
    const after = reanchorComments([written], [ring("trend:c//Sales/A1:A13:", "Sales", 11, "Dec")]);
    expect(after[0].anchor).toBeNull();
    expect(after[0].movedFrom).toBe("Mar");
    expect(after[0].text).toBe("Launch month");
    // When the cue returns, the comment re-attaches (and is home if the datum is the same).
    const back = reanchorComments(after, [ring(EXT, "Sales", 2, "Mar")]);
    expect(back[0].anchor?.categoryLabel).toBe("Mar");
    expect(back[0].movedFrom).toBeUndefined();
  });

  it("a comment written on a cue with no datum starts unattached and never throws", () => {
    const cue: ChartCue = { cueId: "leader:m/Sales:#0", factId: "leader:m/Sales:", kind: "emphasis", polarity: "good", anchor: { type: "series", series: "Sales" } };
    const c = newComment("k1", cue, "biggest", [cue]);
    expect(c.anchor).toBeNull();
    expect(reanchorComments([c], [])).toEqual([c]);
  });

  // The defect the owner found live. `extremes` emits a ring on the highest bar
  // and another on the lowest, both carrying ONE fact id, and the lookup was
  // fact-keyed — so a comment written on 2023 was drawn on 2025, and every
  // later re-anchor dragged it back there.
  it("keeps a comment on the cue it was written on when its fact owns two", () => {
    const highest = ring(EXT, "Sales", 4, "2025", 0);
    const lowest = ring(EXT, "Sales", 2, "2023", 1);
    const written = newComment("k1", lowest, "why so low?", [highest, lowest]);
    expect(written.anchor?.categoryLabel).toBe("2023");

    const after = reanchorComments([written], [highest, lowest]);
    expect(after[0].anchor?.categoryLabel).toBe("2023");
    expect(after[0].movedFrom).toBeUndefined();

    // And the cue order on the chart does not decide it either.
    const reversed = reanchorComments([written], [lowest, highest]);
    expect(reversed[0].anchor?.categoryLabel).toBe("2023");
  });

  it("is deterministic and leaves unrelated comments untouched", () => {
    const a = ring(EXT, "Sales", 2, "Mar");
    const b = ring("x", "Cost", 0, "Jan");
    const comments: ChartCueComment[] = [newComment("k1", a, "a", [a]), newComment("k2", b, "b", [b])];
    const cues = [a, b];
    const first = JSON.stringify(reanchorComments(comments, cues));
    for (let i = 0; i < 10; i++) expect(JSON.stringify(reanchorComments(comments, cues))).toBe(first);
    expect(datumOfCue(cues, "nope")).toBeNull();
    // A FACT id is not a cue id: it resolves to nothing rather than to the first cue.
    expect(datumOfCue(cues, EXT)).toBeNull();
  });
});
