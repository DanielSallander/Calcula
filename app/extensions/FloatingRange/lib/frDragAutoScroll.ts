//! FILENAME: app/extensions/FloatingRange/lib/frDragAutoScroll.ts
// PURPOSE: A drag-select that leaves a floating range's cell area keeps going:
//          while the pointer is held past an edge, the range SCROLLS that way
//          and the selection's moving end follows it, one cell per tick -- the
//          grid's own drag auto-scroll, inside the frame.
// CONTEXT: E10 (open-items 2.af "Floating grid (M7) follow-ups"). A range whose
//          content reaches past its window scrolls (M7), but a drag-select was
//          clamped to the cells on screen: the selection stopped at the
//          window's edge and the only way further was the wheel. The grid's
//          drag does this through useAutoScroll (core); a floating range's
//          drag is its own gesture (index.ts `handleBodyDragStart`), so it
//          gets its own ticker, the same shape.

import type { FloatingRangeEntry } from "./floatingRangeStore";
import { frCellsTop, frRowHdrW, frameHeight, frameWidth } from "./frDimensions";

/** One tick's move of the selection's end: a row and/or a column. */
export interface FrAutoScrollStep {
  dRow: -1 | 0 | 1;
  dCol: -1 | 0 | 1;
}

/** How often a held pointer moves the selection one more cell (ms). */
export const FR_AUTOSCROLL_INTERVAL_MS = 60;

/**
 * Past which edge of the CELL AREA a frame-relative point lies, or null while
 * it is inside it. Above the first row means the title bar and the column
 * headers too, left of the first column the row headers: dragging onto them
 * scrolls, as dragging onto the grid's headers does.
 */
export function frAutoScrollStep(entry: FloatingRangeEntry, dx: number, dy: number): FrAutoScrollStep | null {
  const dRow: -1 | 0 | 1 = dy < frCellsTop(entry) ? -1 : dy >= frameHeight(entry) ? 1 : 0;
  const dCol: -1 | 0 | 1 = dx < frRowHdrW(entry) ? -1 : dx >= frameWidth(entry) ? 1 : 0;
  return dRow === 0 && dCol === 0 ? null : { dRow, dCol };
}

/** The ticker a drag owns: `update` on every pointer move, `stop` when the drag ends. */
export interface FrAutoScroller {
  update(step: FrAutoScrollStep | null): void;
  stop(): void;
}

/**
 * A ticker that calls `tick(step)` every `intervalMs` while the pointer is
 * past an edge (the latest step wins), and nothing while it is inside.
 */
export function createFrAutoScroller(
  tick: (step: FrAutoScrollStep) => void,
  intervalMs: number = FR_AUTOSCROLL_INTERVAL_MS,
): FrAutoScroller {
  let step: FrAutoScrollStep | null = null;
  let timer: ReturnType<typeof setInterval> | null = null;
  const stopTimer = () => {
    if (timer !== null) {
      clearInterval(timer);
      timer = null;
    }
  };
  return {
    update(next) {
      step = next;
      if (step === null) {
        stopTimer();
        return;
      }
      if (timer === null) {
        timer = setInterval(() => {
          if (step !== null) tick(step);
        }, intervalMs);
      }
    },
    stop() {
      step = null;
      stopTimer();
    },
  };
}
