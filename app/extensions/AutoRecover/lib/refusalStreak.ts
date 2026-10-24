//! FILENAME: app/extensions/AutoRecover/lib/refusalStreak.ts
// PURPOSE: Count AutoRecover ticks the backend refused because the workbook
//          kept changing, put up a notice when it has happened three times in
//          a row, and take the notice down the moment the streak ends.
// CONTEXT: `auto_recover_save` takes its snapshot through Rust's
//          `take_consistent_snapshot` (app/src-tauri/src/persistence.rs). When
//          a sheet renumbering -- an agent deleting or moving sheets, a
//          drill-through sheet appearing -- lands inside all three of its
//          attempts, the tick is refused, retryably
//          (`WORKBOOK_CHANGED_WHILE_SAVING`), and nothing is written. The timer
//          swallowed every error, so a sustained burst of sheet churn could
//          refuse tick after tick with nothing on screen, and a crash then lost
//          everything since the last manual save.
//
//          THE RULE: the count is of refusals IN A ROW. A tick that wrote its
//          copy ends the streak; so does any other outcome -- "not_dirty"
//          (nothing unsaved: the user saved, so nothing is being skipped) and
//          any other error (it is not the workbook changing, and stays as
//          silent as before). The notice goes up when the count REACHES the
//          threshold, so one streak can never show it twice -- not even after
//          the user clicked it away -- and it comes down when the streak ends.
//
//          ON SCREEN FOR THE WHOLE STREAK (review round 9, F4). It was a
//          30-second card shown once per streak: a two-hour burst of agent
//          work while the user was away was announced for half a minute and
//          then skipped copy after copy with nothing on screen -- the silent
//          loss the notice exists to prevent. Before that it stayed until
//          dismissed and nothing took it back, so it went stale and stacked
//          (review round 8). Now it stays up (duration 0) exactly as long as
//          copies are being skipped, and the streak's end withdraws it
//          (`@api/notifications`' dismiss handle): at most one card, and only
//          while it is true.
//
//          NO IPC, NO UI: the extension says how to show and how to withdraw
//          (a toast and its handle), which is what makes this directly testable.

import { isWorkbookChangedWhileSaving } from "@api/backendRefusal";

/** Refusals in a row before the user is told. */
export const SKIPPED_SNAPSHOTS_NOTICE_AFTER = 3;

/**
 * The notice. Plain words, no internal code, no number (the app locale owns
 * every number a person reads): what is happening, why, and what keeps the
 * work safe meanwhile.
 */
export const SKIPPED_SNAPSHOTS_NOTICE =
  "AutoRecover is skipping recovery copies because the workbook keeps changing: " +
  "sheets were added, deleted or moved every time it tried to read the workbook. " +
  "Save the workbook (Ctrl+S) to keep your changes safe.";

/** What a streak puts up when it reaches the threshold, and takes down when it ends. */
export interface StreakNotice {
  /** Put the notice up. Called at most once per streak. */
  show(): void;
  /** Take it down: the streak that showed it ended (or was reset). */
  withdraw(): void;
}

/** The running count of refused AutoRecover ticks. */
export interface RefusalStreak {
  /** A tick wrote its recovery copy: the streak ends, and its notice comes down. */
  succeeded(): void;
  /**
   * A tick failed with `err`: counted when it is the retryable refusal, else
   * the streak ends and its notice comes down.
   */
  failed(err: unknown): void;
  /** Forget the streak and take its notice down (the extension was (re)activated or deactivated). */
  reset(): void;
  /** Refusals in a row so far. */
  readonly count: number;
}

/**
 * A streak that shows `notice` exactly when `after` refusals have come in a
 * row -- once per streak -- and withdraws it when that streak ends.
 */
export function createRefusalStreak(
  notice: StreakNotice,
  after: number = SKIPPED_SNAPSHOTS_NOTICE_AFTER,
): RefusalStreak {
  let count = 0;
  /** Whether THIS streak put the notice up (and nothing has taken it down yet). */
  let shown = false;
  const end = (): void => {
    count = 0;
    if (shown) {
      shown = false;
      notice.withdraw();
    }
  };
  return {
    succeeded() {
      end();
    },
    failed(err: unknown) {
      if (!isWorkbookChangedWhileSaving(err)) {
        end();
        return;
      }
      count += 1;
      if (count === after) {
        shown = true;
        notice.show();
      }
    },
    reset() {
      end();
    },
    get count() {
      return count;
    },
  };
}
