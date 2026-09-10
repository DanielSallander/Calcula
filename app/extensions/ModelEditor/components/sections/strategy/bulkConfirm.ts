// FILENAME: app/extensions/ModelEditor/components/sections/strategy/bulkConfirm.ts
// PURPOSE: `Confirm all`, and the sentence it puts on screen.
// CONTEXT: Implements property (8), the one gesture in this tab that could turn
//          the validator's objection into a human's endorsement. It SKIPS any
//          row carrying a finding and any `empty` row, and SAYS how many it
//          skipped and why — a silent skip is its own lie when the button is
//          called "Confirm all". See ../StrategySection.tsx.
//
//          It walks the model's OWN lists, never the rows on screen. Collapse,
//          the row filter and the view switcher can each hide a row; a button
//          called "Confirm all" that quietly meant "the ones you can see" is
//          this same defect wearing a different hat (property 19).

import {
  entryState,
  findingsAtPath,
  measureEntry,
  measureHasValues,
  measurePath,
  tableEntry,
  tableHasValues,
  tablePath,
  withMeasure,
  withTable,
} from "../../../lib/strategyTypes";
import type { EntryState, Finding, StrategyDoc } from "../../../lib/strategyTypes";

// ===========================================================================

/** What one `Confirm all` actually did, in the terms the person who pressed
 *  it needs to hear them. */
export interface BulkConfirm {
  doc: StrategyDoc;
  /** Rows this click marked as agreed by a human. */
  confirmed: number;
  /** Rows left unconfirmed BECAUSE they carry a finding. */
  warned: number;
  /** Rows left unconfirmed because they state nothing to agree to. */
  empty: number;
}

/**
 * Confirm every measure and table entry EXCEPT the ones a human still has to
 * read.
 *
 * Two exclusions, for two different reasons:
 *
 * A row with a FINDING is the whole point. `reviewed` is what the
 * decomposition engine reads as "a person vouched for this", so a bulk gesture
 * that swept a warned row into it would turn the validator's objection into a
 * human's endorsement — the one place in this tab where that conversion is
 * possible. Per-row Confirm still takes a warned row, because there the person
 * is looking at the warning while they press it.
 *
 * A row in the `empty` state is excluded for the reason per-row Confirm is
 * already disabled on one: confirming an entry with no values states nothing.
 * (`entryState` also refuses to PAINT such a row confirmed, so the old bulk
 * confirm was writing `reviewed: true` into rows the grid then kept drawing as
 * "not set" — a flag with no reader.)
 *
 * Findings are matched with `findingsAtPath`, the same function that renders
 * the badge on the row, so what the skip means and what the row shows cannot
 * drift apart.
 */
export function confirmAllUnwarned(
  doc: StrategyDoc,
  measures: string[],
  tables: string[],
  findings: Finding[],
): BulkConfirm {
  let next = doc;
  const counted = { confirmed: 0, warned: 0, empty: 0 };

  const consider = (
    path: string,
    entry: { reviewed: boolean },
    state: EntryState,
    apply: (d: StrategyDoc) => StrategyDoc,
  ): void => {
    // Already agreed: nothing to do and nothing to report. Counting it as a
    // fresh confirmation would inflate the number the message stands on.
    if (entry.reviewed) return;
    if (state === "empty") {
      counted.empty += 1;
      return;
    }
    if (findingsAtPath(findings, path).length > 0) {
      counted.warned += 1;
      return;
    }
    next = apply(next);
    counted.confirmed += 1;
  };

  for (const name of measures) {
    const entry = measureEntry(doc, name);
    consider(measurePath(name), entry, entryState(entry, measureHasValues(entry)), (d) =>
      withMeasure(d, name, { reviewed: true }),
    );
  }
  for (const name of tables) {
    const entry = tableEntry(doc, name);
    consider(tablePath(name), entry, entryState(entry, tableHasValues(entry)), (d) =>
      withTable(d, name, { reviewed: true }),
    );
  }
  return { doc: next, ...counted };
}

/**
 * What the tab says after a bulk confirm.
 *
 * It always leads with the number confirmed, even when that number is zero —
 * "Confirmed 0 rows." beside two skip sentences is the honest reading of a
 * click that looked like it did everything.
 */
export function describeBulkConfirm(result: BulkConfirm): string {
  const rows = (n: number): string => `${n} row${n === 1 ? "" : "s"}`;
  const parts = [`Confirmed ${rows(result.confirmed)}.`];
  if (result.warned > 0) {
    parts.push(
      `Skipped ${rows(result.warned)} carrying a finding — read the finding and confirm that row itself.`,
    );
  }
  if (result.empty > 0) {
    parts.push(
      `Skipped ${result.empty} empty row${result.empty === 1 ? "" : "s"} — an entry with no values states nothing to agree to.`,
    );
  }
  return parts.join(" ");
}

// ===========================================================================
// The model-wide block
