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

/**
 * INVARIANT: the frontend and the backend agree about which sheet is active,
 * and that sheet is a VISIBLE one.
 *
 * WHY NO ORACLE COULD SEE THIS. The three semantic oracles all reason from the
 * workbook digest, and the digest is assembled entirely from `AppState` — so a
 * backend that is wrong in a self-consistent way passes every one of them. The
 * failure this catches is a DISAGREEMENT between the two halves of the app, and
 * the walker's snapshot is the only thing in the tree that holds both.
 *
 * MEASURED (BUG-0046): `hide_sheet` returned a "recommended" new active index
 * without performing the switch. All three of its callers — the tab strip, the
 * notebook's deferred-action host and the script broker — treated the
 * recommendation as done and moved the FRONTEND onto it. The backend stayed on
 * the sheet that had just been hidden, and every cell read and write goes to
 * the active sheet: the tab strip said Sheet1, the canvas painted Sheet2, and
 * typing wrote into the hidden sheet.
 *
 * The second clause is the Excel rule that makes the first one decidable: a
 * hidden sheet cannot be the active sheet (there is no tab to select, and
 * `Activate` raises in VBA). An active index that names a hidden sheet is
 * therefore a defect even when both halves agree on the number.
 */
export const activeSheetAgrees: Invariant = {
  id: "active-sheet-agrees",
  description:
    "The frontend and backend name the same active sheet, and it is visible",
  check(snapshot) {
    const violations: InvariantViolation[] = [];
    const { activeSheet, backendActiveSheet, sheetCount, sheetVisibility, sheetNames } =
      snapshot.logical;

    // A snapshot taken before the field existed (or from a failed query) must
    // not manufacture a violation out of a default.
    if (typeof backendActiveSheet !== "number") return violations;

    if (activeSheet !== backendActiveSheet) {
      violations.push({
        invariantId: "active-sheet-agrees",
        message:
          `The frontend is on sheet ${activeSheet} ` +
          `("${sheetNames?.[activeSheet] ?? "?"}") and the backend is on sheet ` +
          `${backendActiveSheet} ("${sheetNames?.[backendActiveSheet] ?? "?"}"). ` +
          `Every cell read and every cell write goes to the BACKEND's active ` +
          `sheet, so the grid is painting one sheet under another sheet's tab ` +
          `and an edit lands on the wrong one.`,
        details: { activeSheet, backendActiveSheet, sheetNames },
      });
    }

    const vis = sheetVisibility?.[backendActiveSheet];
    if (vis !== undefined && vis !== "visible") {
      violations.push({
        invariantId: "active-sheet-agrees",
        message:
          `The active sheet (${backendActiveSheet}, ` +
          `"${sheetNames?.[backendActiveSheet] ?? "?"}") is ${vis}. A hidden ` +
          `sheet cannot be the active sheet — it has no tab to select, and ` +
          `Excel's Activate raises on one.`,
        details: { backendActiveSheet, visibility: vis, sheetCount },
      });
    }

    return violations;
  },
};

export const CHEAP_INVARIANTS: Invariant[] = [
  selectionInBounds,
  uiNotBlocked,
  activeSheetAgrees,
];
