/**
 * FILENAME: app/extensions/BusinessIntelligence/lib/refreshOutcome.ts
 * PURPOSE: Turn the raw outcome of a connection Refresh into the single line
 *          the user reads. This decision used to live inline in the pane,
 *          where it reported a security refusal as "nothing to refresh".
 *
 * THE RULE it encodes, which the pane could not previously express:
 *
 *   "zero candidates enumerated" is quiet and informational;
 *   "zero successes out of N"    is loud and an error.
 *
 * A calm "nothing to refresh" is reachable ONLY from a run in which nothing
 * went wrong. Anything that failed — a grid-query refresh refused by the
 * active "view as" role, a pivot that would not rebuild, or a failure to even
 * LIST the pivots — makes the whole run an error, however many other things
 * succeeded, and the message says both parts.
 */

/** What a Refresh actually did. Every failure is carried, never discarded. */
export interface RefreshOutcome {
  /** Grid query regions that refreshed. */
  queryCount: number;
  /** Rows across those regions. */
  totalRows: number;
  /** Pivot tables that refreshed. */
  pivotCount: number;
  /**
   * Everything that went wrong: a failed grid-query refresh, a pivot that
   * refused, a failure to enumerate the pivots. Empty means nothing did —
   * which is the ONLY way to reach the quiet "nothing to refresh" line.
   */
  errors: string[];
}

export interface RefreshStatus {
  message: string;
  type: "info" | "success" | "error";
}

/**
 * The one place that decides what a Refresh reports. Pure, so it can be
 * tested without rendering the pane: the honesty of this surface is a
 * property of this function.
 */
export function summarizeRefresh(outcome: RefreshOutcome): RefreshStatus {
  const refreshed: string[] = [];
  if (outcome.queryCount > 0) {
    refreshed.push(`${outcome.queryCount} queries (${outcome.totalRows} rows)`);
  }
  if (outcome.pivotCount > 0) {
    refreshed.push(`${outcome.pivotCount} pivot table(s)`);
  }

  if (outcome.errors.length > 0) {
    const [first, ...rest] = outcome.errors;
    const more = rest.length > 0 ? ` (+${rest.length} more)` : "";
    // Name what DID refresh too: a partly-refreshed workbook is a different
    // situation from one where nothing happened, and the user is looking at it.
    const also = refreshed.length > 0 ? `; refreshed ${refreshed.join(" + ")}` : "";
    return { message: `Refresh failed: ${first}${more}${also}`, type: "error" };
  }

  if (refreshed.length > 0) {
    return { message: `Refreshed ${refreshed.join(" + ")}`, type: "success" };
  }

  return { message: "No queries or pivot tables to refresh.", type: "info" };
}
