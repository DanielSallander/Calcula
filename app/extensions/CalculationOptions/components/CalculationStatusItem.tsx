//! FILENAME: app/extensions/CalculationOptions/components/CalculationStatusItem.tsx
// PURPOSE: The user-visible half of calculation cancellation — a status-bar
//          item that shows recalculation progress with a Cancel button, and
//          afterwards shows Excel's "Calculate" marker when a cancelled pass
//          left cells un-recalculated.
// CONTEXT: This is Calcula's answer to VBA's Ctrl+Break. The backend half made
//          it POSSIBLE (calculate_now moved off the WebView2 UI thread, so the
//          webview can still paint and dispatch a click while a recalculation
//          runs); this is the part the user can actually reach.
//
//          DELIBERATELY NOT A MODAL. A dialog would block the very UI the user
//          needs to click, and a modal over a running calculation is how
//          applications end up with a Cancel button that cannot be pressed. It
//          is a status-bar item — always visible, never in the way, and it
//          costs nothing when no calculation is running (it renders null).
//
//          The 1500 ms delay before anything appears is not cosmetic: almost
//          every recalculation is instant, and chrome that flashes on every F9
//          trains people to ignore it.

import React, { useCallback, useEffect, useRef, useState } from "react";
import {
  cancelCalculation,
  getPendingRecalc,
  listenForEvent,
  onAppEvent,
  emitAppEvent,
  AppEvents,
  type UnlistenFn,
} from "@api";

/** Mirrors `CalcProgressEvent` in app/src-tauri/src/eval_budget.rs. */
interface CalcProgressPayload {
  scope: string;
  cellsDone: number;
  cellsTotal: number;
  elapsedMs: number;
  done: boolean;
  cancelled: boolean;
  pendingCells: number;
}

/** Backend event name — must match `CALC_PROGRESS_EVENT` in eval_budget.rs. */
const CALC_PROGRESS_EVENT = "app:calc-progress";

/**
 * How long a recalculation must run before any chrome appears.
 *
 * Below this the pass is over before a human registers that anything happened,
 * and showing a progress bar for 80 ms is worse than showing nothing: it makes
 * the application look busy when it is not.
 */
export const PROGRESS_VISIBLE_AFTER_MS = 1500;

function formatCount(n: number): string {
  return n.toLocaleString();
}

export function CalculationStatusItem(): React.ReactElement | null {
  const [progress, setProgress] = useState<CalcProgressPayload | null>(null);
  const [visible, setVisible] = useState(false);
  const [staleCells, setStaleCells] = useState(0);
  const [cancelling, setCancelling] = useState(false);
  const showTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const clearShowTimer = useCallback(() => {
    if (showTimer.current !== null) {
      clearTimeout(showTimer.current);
      showTimer.current = null;
    }
  }, []);

  const onCancel = useCallback(() => {
    // Optimistic: the flag is set immediately, but the pass only notices at its
    // next poll boundary, so the label changes right away to acknowledge the
    // click. A button that looks inert for 200 ms gets clicked five times.
    setCancelling(true);
    void cancelCalculation();
  }, []);

  // Backend progress stream.
  useEffect(() => {
    let unlisten: UnlistenFn | null = null;
    let disposed = false;

    void listenForEvent(CALC_PROGRESS_EVENT, (payload) => {
      const p = payload as CalcProgressPayload;
      if (p.done) {
        clearShowTimer();
        setVisible(false);
        setProgress(null);
        setCancelling(false);
        setStaleCells(p.cancelled ? p.pendingCells : 0);
        if (p.cancelled) {
          // Tell the rest of the app the workbook is not settled. Save,
          // publish and any "read all derived values" consumer wants this —
          // and a script that just called calculateNow needs to know its
          // answers are incomplete rather than merely finished.
          emitAppEvent(AppEvents.RECALC_INCOMPLETE, {
            sheetIndex: -1,
            cellCount: p.pendingCells,
          });
        }
        return;
      }
      setProgress(p);
      if (showTimer.current === null) {
        showTimer.current = setTimeout(() => {
          setVisible(true);
          showTimer.current = null;
        }, PROGRESS_VISIBLE_AFTER_MS);
      }
    }).then((fn) => {
      if (disposed) {
        void fn();
      } else {
        unlisten = fn;
      }
    });

    return () => {
      disposed = true;
      clearShowTimer();
      if (unlisten) void unlisten();
    };
  }, [clearShowTimer]);

  // A completed recalculation settles the workbook, so the stale marker goes.
  useEffect(() => {
    return onAppEvent(AppEvents.RECALCULATION_COMPLETED, () => {
      void getPendingRecalc().then((p) => setStaleCells(p ? p.cells.length : 0));
    });
  }, []);

  // Initial read, so a workbook opened after a cancelled session still says so.
  useEffect(() => {
    void getPendingRecalc().then((p) => setStaleCells(p ? p.cells.length : 0));
  }, []);

  // ESC and Ctrl+Break, bound to the SAME command as the button.
  //
  // The keystroke is a convenience, not the mechanism. VBA polled the keyboard
  // because its interpreter owned the UI thread and had no other option; here
  // the honest Ctrl+Break analogue is a reachable button, and reachability is a
  // threading property, not a keyboard one.
  useEffect(() => {
    if (!progress) return;
    const onKey = (e: KeyboardEvent) => {
      const isBreak = e.key === "Pause" || (e.ctrlKey && e.key === "Cancel");
      if (e.key === "Escape" || isBreak) {
        e.preventDefault();
        onCancel();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [progress, onCancel]);

  if (progress && visible) {
    const pct =
      progress.cellsTotal > 0
        ? Math.min(100, Math.round((progress.cellsDone / progress.cellsTotal) * 100))
        : 0;
    return (
      <span
        data-testid="calc-progress"
        style={{ display: "flex", alignItems: "center", gap: "8px" }}
      >
        <span>
          Calculating… {formatCount(progress.cellsDone)} / {formatCount(progress.cellsTotal)} ({pct}%)
        </span>
        <button
          type="button"
          onClick={onCancel}
          disabled={cancelling}
          title="Stop this calculation (Esc)"
          style={{
            font: "inherit",
            padding: "0 8px",
            height: "18px",
            lineHeight: "16px",
            cursor: cancelling ? "default" : "pointer",
            border: "1px solid rgba(255,255,255,0.6)",
            borderRadius: "3px",
            background: "transparent",
            color: "inherit",
            opacity: cancelling ? 0.6 : 1,
          }}
        >
          {cancelling ? "Stopping…" : "Cancel"}
        </button>
      </span>
    );
  }

  if (staleCells > 0) {
    // Excel's own affordance for "this workbook has un-recalculated cells".
    // The count is the point: "Calculate" alone does not tell the user how much
    // of what they are looking at is stale.
    return (
      <span
        data-testid="calc-stale"
        title={`${formatCount(staleCells)} cell(s) still hold values from before the cancelled recalculation. Press F9 to finish.`}
        style={{ fontWeight: 600 }}
      >
        Calculate ({formatCount(staleCells)})
      </span>
    );
  }

  return null;
}
