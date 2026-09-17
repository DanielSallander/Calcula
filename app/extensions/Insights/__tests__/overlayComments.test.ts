//! FILENAME: app/extensions/Insights/__tests__/overlayComments.test.ts
// PURPOSE: The three outcomes of "a comment follows the data" (§4.8a), each
//          as a test, plus the round trip back home.

import { describe, it, expect } from "vitest";
import { reanchorComments, newComment, primaryDatumOf } from "../lib/overlayComments";
import type { ChartCue, ChartCueComment } from "@api/chartCues";

function ring(factId: string, series: string, categoryIndex: number, categoryLabel: string): ChartCue {
  return { factId, kind: "ring", polarity: "neutral", anchor: { type: "datum", series, categoryIndex, categoryLabel } };
}

const EXT = "extremes:c//Sales/A1:A13:";

describe("reanchorComments", () => {
  it("(a) the fact still names the same datum: the comment stays, at the ring's new index", () => {
    const written = newComment("k1", EXT, "Launch month", [ring(EXT, "Sales", 2, "Mar")]);
    expect(written.anchor).toEqual({ type: "datum", series: "Sales", categoryIndex: 2, categoryLabel: "Mar" });
    // Jan was hidden by a filter: Mar is now painter index 1.
    const after = reanchorComments([written], [ring(EXT, "Sales", 1, "Mar")]);
    expect(after[0].anchor).toEqual({ type: "datum", series: "Sales", categoryIndex: 1, categoryLabel: "Mar" });
    expect(after[0].movedFrom).toBeUndefined();
  });

  it("(b) the fact now names a different datum: the comment follows and says where from", () => {
    const written = newComment("k1", EXT, "Launch month", [ring(EXT, "Sales", 2, "Mar")]);
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

  it("(c) the fact is gone: the comment is kept unattached, remembering what it was about", () => {
    const written = newComment("k1", EXT, "Launch month", [ring(EXT, "Sales", 2, "Mar")]);
    const after = reanchorComments([written], [ring("trend:c//Sales/A1:A13:", "Sales", 11, "Dec")]);
    expect(after[0].anchor).toBeNull();
    expect(after[0].movedFrom).toBe("Mar");
    expect(after[0].text).toBe("Launch month");
    // When the fact returns, the comment re-attaches (and is home if the datum is the same).
    const back = reanchorComments(after, [ring(EXT, "Sales", 2, "Mar")]);
    expect(back[0].anchor?.categoryLabel).toBe("Mar");
    expect(back[0].movedFrom).toBeUndefined();
  });

  it("a comment written on a fact with no datum cue starts unattached and never throws", () => {
    const c = newComment("k1", "leader:m/Sales:", "biggest", [{ factId: "leader:m/Sales:", kind: "emphasis", polarity: "good", anchor: { type: "series", series: "Sales" } }]);
    expect(c.anchor).toBeNull();
    expect(reanchorComments([c], [])).toEqual([c]);
  });

  it("is deterministic and leaves unrelated comments untouched", () => {
    const comments: ChartCueComment[] = [
      newComment("k1", EXT, "a", [ring(EXT, "Sales", 2, "Mar")]),
      newComment("k2", "x", "b", [ring("x", "Cost", 0, "Jan")]),
    ];
    const cues = [ring(EXT, "Sales", 2, "Mar"), ring("x", "Cost", 0, "Jan")];
    const first = JSON.stringify(reanchorComments(comments, cues));
    for (let i = 0; i < 10; i++) expect(JSON.stringify(reanchorComments(comments, cues))).toBe(first);
    expect(primaryDatumOf(cues, "nope")).toBeNull();
  });
});
