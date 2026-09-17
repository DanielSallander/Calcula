//! FILENAME: app/extensions/Insights/lib/overlayComments.ts
// PURPOSE: Comments follow the data — the pure re-anchoring rule (§4.8a).
// CONTEXT: A comment is anchored to a FACT, the point of interest, not to a
//          month. When a chart's data changes and the bundle is recomputed,
//          every comment is re-resolved by fact id against the new cues:
//
//          (a) the fact still names the same datum → the comment stays where
//              the ring now is (a filter may have moved the bar);
//          (b) the fact exists but names a different datum (the highest month
//              moved from Mar to May) → the comment FOLLOWS the ring and
//              carries `movedFrom: "Mar"` so the reader sees it moved;
//          (c) the fact is gone → the comment is kept UNATTACHED (anchor null),
//              drawn in the tray, never left over the wrong bar.
//
//          Pure and deterministic, so the three outcomes are three tests.

import type { ChartCue, ChartCueComment, ChartCueDatumAnchor } from "@api/chartCues";

/** The datum a fact's cues point at: its first datum-anchored cue. */
export function primaryDatumOf(cues: readonly ChartCue[], factId: string): ChartCueDatumAnchor | null {
  for (const c of cues) {
    if (c.factId === factId && c.anchor.type === "datum") return { ...c.anchor };
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
    const now = primaryDatumOf(cues, comment.factId);
    if (!now) {
      // (c) the fact is gone. Keep the last anchor's label as `movedFrom`
      // only if it was never recorded, so the tray can say what it was about.
      return { ...comment, anchor: null, ...(comment.movedFrom === undefined && comment.anchor ? { movedFrom: comment.anchor.categoryLabel } : {}) };
    }
    const origin = comment.movedFrom ?? comment.anchor?.categoryLabel;
    if (origin !== undefined && !sameDatum(now, { ...now, categoryLabel: origin })) {
      // (b) same fact, different datum: follow, and say where from.
      return { ...comment, anchor: now, movedFrom: origin };
    }
    // (a) same datum (or a comment written unattached that has found its fact): home again.
    const { movedFrom: _dropped, ...rest } = comment;
    return { ...rest, anchor: now };
  });
}

/** A fresh comment on a fact, anchored where its cue is now (or unattached if it is not on the chart). */
export function newComment(id: string, factId: string, text: string, cues: readonly ChartCue[]): ChartCueComment {
  return { id, factId, text, anchor: primaryDatumOf(cues, factId) };
}
