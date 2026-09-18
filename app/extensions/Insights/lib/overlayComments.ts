//! FILENAME: app/extensions/Insights/lib/overlayComments.ts
// PURPOSE: Comments follow the data — the pure re-anchoring rule (§4.8a).
// CONTEXT: A comment is anchored to a CUE, the one point of interest the reader
//          was looking at, not to a month. When a chart's data changes and the
//          bundle is recomputed, every comment is re-resolved by CUE ID against
//          the new cues:
//
//          (a) the cue still names the same datum → the comment stays where
//              the ring now is (a filter may have moved the bar);
//          (b) the cue exists but names a different datum (the highest month
//              moved from Mar to May) → the comment FOLLOWS the ring and
//              carries `movedFrom: "Mar"` so the reader sees it moved;
//          (c) the cue is gone → the comment is kept UNATTACHED (anchor null),
//              drawn in the tray, never left over the wrong bar.
//
//          IT RESOLVES BY CUE, NOT BY FACT, because one fact routinely owns
//          SEVERAL cues — `extremes` rings the highest bar AND the lowest — and
//          a fact-keyed lookup silently returned the FIRST of them. That is the
//          defect the owner found live: a comment written on the 2023 bar was
//          drawn on 2025, and "keep this mark" persisted the wrong bar into the
//          document. `factId` stays on the comment for grouping and wording; it
//          is never what the lookup resolves by.
//
//          Pure and deterministic, so the three outcomes are three tests.

import type { ChartCue, ChartCueComment, ChartCueDatumAnchor } from "@api/chartCues";

/** The datum ONE cue points at, by its own id. Null when it is not on the chart or is not a datum cue. */
export function datumOfCue(cues: readonly ChartCue[], cueId: string): ChartCueDatumAnchor | null {
  for (const c of cues) {
    if (c.cueId === cueId && c.anchor.type === "datum") return { ...c.anchor };
  }
  return null;
}

function sameDatum(a: ChartCueDatumAnchor, b: ChartCueDatumAnchor): boolean {
  return a.series === b.series && a.categoryLabel === b.categoryLabel;
}

/**
 * Re-anchor every comment against the cues now on the chart.
 *
 * `movedFrom` records the label the comment was ORIGINALLY written against
 * and is kept across further moves, so "was Mar" does not become "was May"
 * after a second change and then silently vanish when the data returns.
 */
export function reanchorComments(
  comments: readonly ChartCueComment[],
  cues: readonly ChartCue[],
): ChartCueComment[] {
  return comments.map((comment) => {
    const now = datumOfCue(cues, comment.cueId);
    if (!now) {
      // (c) the cue is gone. Keep the last anchor's label as `movedFrom`
      // only if it was never recorded, so the tray can say what it was about.
      return { ...comment, anchor: null, ...(comment.movedFrom === undefined && comment.anchor ? { movedFrom: comment.anchor.categoryLabel } : {}) };
    }
    const origin = comment.movedFrom ?? comment.anchor?.categoryLabel;
    if (origin !== undefined && !sameDatum(now, { ...now, categoryLabel: origin })) {
      // (b) same cue, different datum: follow, and say where from.
      return { ...comment, anchor: now, movedFrom: origin };
    }
    // (a) same datum (or a comment written unattached that has found its cue): home again.
    const { movedFrom: _dropped, ...rest } = comment;
    return { ...rest, anchor: now };
  });
}

/**
 * A fresh comment on ONE cue, anchored where that cue is now.
 *
 * It takes the cue itself rather than an id, because the caller always has it
 * (the reader clicked it) and because a cue that is not in `cues` must not
 * quietly produce a comment anchored somewhere else.
 */
export function newComment(id: string, cue: ChartCue, text: string, cues: readonly ChartCue[]): ChartCueComment {
  return { id, cueId: cue.cueId, factId: cue.factId, text, anchor: datumOfCue(cues, cue.cueId) };
}
