//! FILENAME: tests/eval/run-intent-eval-split.mjs
// PURPOSE: WHICH rows of `intents.json` the router may be tuned against, and
//          which it may only be measured on — as a pure module, so the runner
//          and the CI corpus test import the SAME split and cannot disagree.
// CONTEXT: The router's rules were derived from this corpus's own vocabulary
//          (docs/design/ai-intent-router.md §4b), and its author read every
//          failure of the prototype on the full corpus before writing them. A
//          held-out half is therefore defined by two conditions, both needed:
//          the id hashes odd, AND the row's failure was never inspected during
//          rule authoring. The inspected ids are pinned to `tune` BY NAME below.
//
//          Append to the inspected set; never remove from it. An id that was
//          ever looked at while a rule was being written stays on the tuned
//          side for good — that is what makes the held-out number honest.

/** Ids whose failures were READ during rule authoring. */
export const INSPECTED_DURING_AUTHORING = new Set([
  // 2026-09-16, the prototype's misses over the 214-row corpus.
  "task:cap-fetch-rate",
  "task:trap-vba-cells-idiom",
  "task:trap-browser-fetch",
  "task:shape-multi-step-report",
  "task:shape-loop-over-rows",
  "task:shape-formula-read",
  "task:shape-no-capability-needed",
  "dq:average-amount-per-segment",
  "dq:average-amount-by-category",
  "dq:bottom-3-subcategories-by-quantity",
  "dq:average-quantity-per-sale-by-subcategory",
  "dq:revenue-every-month-most-recent-first",
  "qu-3",
  "pf-4",
  "pa-1",
  "rg-subscription",
  // 2026-09-16, the first router run's misses on the tune split.
  "task:grid-sum-in-script",
  "task:grid-recalculate",
  "dq:layout-tabular-no-column-totals-segment-category",
]);

function hash(text) {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/** `"tune"` or `"held-out"`, deterministic in the id. */
export function splitOf(id) {
  if (INSPECTED_DURING_AUTHORING.has(id)) return "tune";
  return hash(id) % 2 === 0 ? "tune" : "held-out";
}
