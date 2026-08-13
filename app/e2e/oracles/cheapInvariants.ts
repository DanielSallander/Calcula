//! FILENAME: app/e2e/oracles/cheapInvariants.ts
// PURPOSE: Cheap synchronous invariants added to the per-action check list
//          (ALL_INVARIANTS). These cost nothing — they only inspect the
//          snapshot already captured after every action.

import type { Invariant, InvariantViolation } from "../invariants/invariants";

// Excel-compatible hard caps; Calcula's grid uses the same order of magnitude.
const MAX_ROWS = 1_048_576;
const MAX_COLS = 16_384;

/**
 * INVARIANT: The selection must be well-formed and within plausible grid
 * bounds. A selection with inverted or absurd coordinates indicates state
 * corruption in the selection model.
 */
export const selectionInBounds: Invariant = {
  id: "selection-in-bounds",
  description: "Selection coordinates are well-formed and within grid bounds",
  check(snapshot) {
    const violations: InvariantViolation[] = [];
    const sel = snapshot.logical.selection;
    if (!sel) return violations;

    const problems: string[] = [];
    if (sel.startRow < 0 || sel.startCol < 0) problems.push("negative start");
    if (sel.endRow < sel.startRow) problems.push("endRow < startRow");
    if (sel.endCol < sel.startCol) problems.push("endCol < startCol");
    if (sel.endRow >= MAX_ROWS) problems.push(`endRow >= ${MAX_ROWS}`);
    if (sel.endCol >= MAX_COLS) problems.push(`endCol >= ${MAX_COLS}`);

    if (problems.length > 0) {
      violations.push({
        invariantId: "selection-in-bounds",
        message: `Malformed selection (${problems.join(", ")}): ${JSON.stringify(sel)}`,
        details: { selection: sel, problems },
      });
    }
    return violations;
  },
};

/**
 * INVARIANT: the ribbon must be clickable after every action.
 *
 * THE ONE THAT COST THE MOST AND SHOWED THE LEAST. A walker action opened the
 * "Customize Home Tab" modal by accident (BUG-0037: a substring `.first()`
 * match that hit the View menu's "Customize Home Tab..." item instead of the
 * ribbon's Home tab). The modal is `position: fixed`, `z-index: 1050`, covers
 * 100% of the viewport, and carries NO `role="dialog"` — so the long-standing
 * `visibleDialogCount` read 0 while every remaining UI action in the walk
 * clicked into its backdrop. Each such click burns the 30s action timeout and
 * is TOLERATED by the runner, so the walk ran to completion and reported PASS
 * over a workbook whose UI had been unreachable for half the run. Before
 * `actionTimeout` was set at all, the same state produced the unexplained
 * twelve-minute stall recorded in playwright.config.ts.
 *
 * A blocked UI is not a product bug in itself — a modal is allowed to be modal.
 * It is a statement that THE REST OF THIS WALK MEANS NOTHING, and that has to
 * stop the walk rather than decorate it. No action in the catalog legitimately
 * leaves a viewport-covering modal open; every one of them either drives the
 * backend directly or closes what it opened.
 */
export const uiNotBlocked: Invariant = {
  id: "ui-not-blocked",
  description: "No overlay covers the ribbon's tab strip after an action",
  check(snapshot) {
    const blocker = snapshot.visual.ribbonBlockedBy;
    if (!blocker) return [];
    return [
      {
        invariantId: "ui-not-blocked",
        message:
          `The ribbon is covered by <${blocker.tag} class="${blocker.className}" ` +
          `role=${blocker.role ?? "-"} z-index=${blocker.zIndex}>` +
          (blocker.text ? ` "${blocker.text}"` : "") +
          `. Every UI action from here on clicks into this instead, so the ` +
          `remainder of the walk proves nothing.`,
        details: { blocker },
      },
    ];
  },
};

export const CHEAP_INVARIANTS: Invariant[] = [selectionInBounds, uiNotBlocked];
