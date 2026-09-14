//! FILENAME: app/extensions/_shared/dsl/pivotLayout/describeQuery/turns.ts
// PURPOSE: What one ask-and-answer IS, and what may be done with it. No React.
// CONTEXT: The panel around this is a transcript with a diff inside each turn.
//          Every decision that can be got wrong lives here instead of in the
//          component, because a component test can only reach these through a
//          render and a click, and the cases that matter are the ones nobody
//          clicks: a draft identical to the text already in the editor, a
//          `compiled` draft whose dsl is empty, an Accept pressed on turn 1
//          after turn 3 changed the editor underneath it.
//
//          THE RULE THE WHOLE FILE SERVES: a turn's disposition is computed
//          against the editor's text AT THE MOMENT IT IS ASKED, never cached
//          from when the draft arrived. That is the settled precedent next door
//          — the suggestion chips re-read the live text on accept and drop
//          themselves when the edit no longer applies, because the alternative
//          is a button that silently overwrites work done since it appeared.

import { sameDesignQuery } from "../canonical";
import type { DesignQueryDraft } from "../draft";

/**
 * What a turn is FOR the user, right now.
 *
 * - `pending`   — a usable query that differs from the editor. Offer the diff.
 * - `noop`      — the model proposed what is already there. Nothing to accept.
 * - `applied`   — the person took it.
 * - `rejected`  — the person declined it.
 * - `invalid`   — it did not compile. Still offerable: the editor's markers are
 *                 the fastest way to fix it, which is why the old row put such
 *                 drafts in the editor on purpose.
 * - `declined`  — no query could be read out of the reply. Nothing to show.
 * - `failed`    — the request itself failed (transport, no model, cancelled).
 */
export type TurnDisposition =
  | "pending"
  | "noop"
  | "applied"
  | "rejected"
  | "invalid"
  | "declined"
  | "failed";

export interface DraftTurn {
  /** Monotonic within a panel. React key AND the namespace for a dismissal. */
  id: number;
  intent: string;
  /**
   * WHICH model answered THIS turn.
   *
   * Recorded per turn rather than read from the provider when rendering,
   * because the model is switchable from inside this very panel: a transcript
   * that relabels its history the moment you change models is telling you
   * something false about where its answers came from.
   */
  model: string;
  draft: DesignQueryDraft | null;
  failure: string | null;
  disposition: TurnDisposition;
}

/**
 * Whether a draft is worth offering against `currentDsl`, before anyone clicks.
 *
 * The `compiled`-but-empty case is real, not defensive: the drafter can return
 * `{ status: "invalid", dsl: "" }` when the repair budget runs out with nothing
 * extractable, and an empty `dsl` applied over a working query would silently
 * blank the editor. `sameDesignQuery` compares CANONICALLY, so a reply that
 * differs only in clause order or whitespace is correctly a no-op rather than a
 * diff of nothing.
 */
export function dispositionFor(draft: DesignQueryDraft, currentDsl: string): TurnDisposition {
  if (draft.status === "declined") return "declined";
  if (draft.dsl.trim() === "") return "noop";
  if (draft.status === "invalid") return "invalid";
  // An empty editor has nothing to lose, so a first draft is never a no-op even
  // if `sameDesignQuery` would call two empties equal.
  if (currentDsl.trim() !== "" && sameDesignQuery(draft.dsl, currentDsl)) return "noop";
  return "pending";
}

/** Whether this turn still has something the person can apply. */
export function isActionable(turn: DraftTurn): boolean {
  return turn.disposition === "pending" || turn.disposition === "invalid";
}

/**
 * Whether a turn should show a side-by-side diff rather than just the query.
 *
 * Only when there is something to compare against. A first draft into an empty
 * editor gets the query plainly: a diff whose left pane is blank is a worse way
 * to read a query than the query.
 */
export function showsDiff(turn: DraftTurn, currentDsl: string): boolean {
  return turn.disposition === "pending" && currentDsl.trim() !== "";
}

/**
 * Re-decide an actionable turn against the editor's text NOW.
 *
 * Called on the Accept click, not on render. Between a draft arriving and the
 * person clicking it, they may have accepted a later turn, typed in the editor,
 * or clicked a suggestion chip — and in each case the honest answer may have
 * become "this no longer changes anything".
 */
export function recheck(turn: DraftTurn, currentDsl: string): DraftTurn {
  if (!isActionable(turn) || !turn.draft) return turn;
  const disposition = dispositionFor(turn.draft, currentDsl);
  return disposition === turn.disposition ? turn : { ...turn, disposition };
}

/**
 * The turn a follow-up ask should refine, or null to start fresh.
 *
 * The most recent turn that produced a query the person did not reject — so
 * "make it monthly" after an Accept refines what was accepted, and after a
 * Reject refines the last thing still standing rather than the discarded one.
 * A rejected draft is exactly what the person said they did not want; sending
 * it back as the thing to modify would be the opposite of listening.
 */
export function priorFor(turns: readonly DraftTurn[]): { intent: string; dsl: string } | null {
  for (let i = turns.length - 1; i >= 0; i--) {
    const t = turns[i];
    if (t.disposition === "rejected" || t.disposition === "failed") continue;
    if (t.disposition === "declined") continue;
    if (!t.draft || t.draft.dsl.trim() === "") continue;
    return { intent: t.intent, dsl: t.draft.dsl };
  }
  return null;
}

/** One sentence for a turn whose draft cannot be applied. */
export function dispositionNote(turn: DraftTurn): string | null {
  switch (turn.disposition) {
    case "noop":
      return "That is the query you already have — nothing to change.";
    case "applied":
      return "Applied to the editor.";
    case "rejected":
      return "Rejected. The editor is unchanged.";
    default:
      return null;
  }
}
