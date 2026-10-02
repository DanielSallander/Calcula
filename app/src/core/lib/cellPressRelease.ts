//! FILENAME: app/src/core/lib/cellPressRelease.ts
// PURPOSE: The ONE press session behind every release-time cell interceptor:
//          a press a cell click interceptor answered with a RELEASE CLAIM
//          (core/lib/cellClickInterceptors.ts `actOnRelease`) acts only when it
//          is released over the same target, and sliding off cancels
//          (BUG-0258 design phase 4, the owner's answer "on release, and sliding
//          off cancels" -- the standard Windows button rule).
// CONTEXT: The cell click interceptors used to ACT ON THE PRESS: an in-cell
//          button ran its macro, a worksheet pivot's +/- toggled and its filter
//          buttons opened the moment the mouse went down, so a press the user
//          meant to take back could not be. The floating families moved to the
//          release in M7 (Controls/lib/buttonPress.ts, Pivot/lib/
//          pivotChromePress.ts) through Core's content press; the cell
//          interceptors are asked from Core's own mouse-down handler
//          (useSpreadsheetSelection.ts `handleMouseDown`), so the session that
//          holds their presses is Core's, here, once -- not one copy per family.
//
//          THE RULES THIS FILE KEEPS:
//            - The session OPENS at the press, BEFORE the interceptors are asked
//              (they are async: a fast click's mouseup arrives while they are
//              still answering). A release heard then is kept, and judged when
//              the claim arrives; an Escape or a blur then cancels.
//            - Only a PRIMARY press can arm. Any other press answered with a
//              claim is taken (no selection) and runs nothing.
//            - The press only ARMS: nothing runs. The release runs the claim
//              ONCE, and only when the claim's `targetAt` at the release point
//              is its own `key`, the point is ON THE CELLS (Core's `cellAt`
//              says null over a floating object, over DOM stacked above the
//              grid, over a header, outside the grid), and the sheet is the one
//              the press began on.
//            - The pressed look follows the pointer: `setPressed(true)` while
//              the pointer is over the target, `false` while outside, as a
//              Windows button does; `false` on EVERY end path; one repaint per
//              change.
//            - Escape, a window blur, a move with the primary button UP (a
//              release this page never heard), a release of ANOTHER button with
//              the primary one up (a middle press), and the next press end it
//              with NOTHING run. Once a claim holds the press its Escape is the
//              press's: the keybinding dispatcher, which runs first, stands
//              aside for it (@api/keybindings `handleGlobalKeyDown`), and the
//              session prevents it and stops it at the window's capture phase,
//              so the grid, a canvas, a document listener and every bubble
//              listener never hear it. (A window-capture listener of its own
//              that an extension installed before the press runs before the
//              session, and can still see it.)
//            - The window listeners live only as long as the press.
//          WHAT RUNS is the claim's (each family decides HOW; Core decides WHEN).

import {
  isCellReleaseClaim,
  type CellClickAnswer,
  type CellPressPoint,
  type CellReleaseClaim,
} from "./cellClickInterceptors";

/** A pointer sample: where it is, and what is under it (the event's target). */
export interface CellPressSample {
  clientX: number;
  clientY: number;
  /** The element under the pointer (a mouse event's target); null when unknown. */
  target: EventTarget | null;
  ctrlKey?: boolean;
  metaKey?: boolean;
}

/** The press that opens a session: a sample plus the button pressed. */
export interface CellPressStart extends CellPressSample {
  /** 0 = primary. Only a primary press can arm. */
  button: number;
}

/** What the session asks the grid. Each answer is measured when it is asked. */
export interface CellPressDeps {
  /**
   * The cell under a point, or null when the point is OFF the cells: over a
   * floating object, over DOM stacked above the grid (the sample's target is
   * not the grid's, or it is a claimed element), over a header, outside the
   * grid. Pane-aware, with the geometry as it is painted now.
   */
  cellAt(sample: CellPressSample): { row: number; col: number } | null;
  /** Names the sheet the grid shows now. A point on another sheet is off every target. */
  sheetKey(): string;
  /** Repaint the grid (the pressed look changed). */
  redraw(): void;
}

/** The handle Core's mouse-down holds while the interceptors answer. */
export interface CellPress {
  /**
   * The interceptors answered. A release claim ARMS the press (or, when the
   * release was already heard, is judged against it now); any other answer
   * closes the session with nothing run. Only the first call counts.
   */
  settle(answer: CellClickAnswer): void;
}

type Outcome =
  | { kind: "released"; point: CellPressPoint | null; sample: CellPressSample }
  | { kind: "cancelled" };

interface Session {
  deps: CellPressDeps;
  /** The sheet the press began on. */
  sheet: string;
  settled: boolean;
  claim: CellReleaseClaim | null;
  /** Is the pressed look on? */
  pressed: boolean;
  /** The last pointer sample (the press, then each move). */
  last: CellPressSample;
  /** How the press ended before the claim arrived, if it did. */
  outcome: Outcome | null;
}

/** The session whose window listeners are bound, or null. */
let live: Session | null = null;

const NOTHING_TO_ARM: CellPress = { settle: () => {} };

/**
 * Open the press session for a grid cell press, BEFORE its interceptors are
 * asked. The previous press, if one is still held, ends first with nothing run.
 * A press that is not a primary one gets a handle that arms nothing.
 */
export function openCellPress(start: CellPressStart, deps: CellPressDeps): CellPress {
  cancelCellPress();
  if (start.button !== 0) return NOTHING_TO_ARM;
  const session: Session = {
    deps,
    sheet: deps.sheetKey(),
    settled: false,
    claim: null,
    pressed: false,
    last: sampleOf(start),
    outcome: null,
  };
  live = session;
  window.addEventListener("mousemove", onPressMove);
  window.addEventListener("mouseup", onPressUp);
  window.addEventListener("keydown", onPressKey, true);
  window.addEventListener("blur", onPressBlur);
  return { settle: (answer) => settle(session, answer) };
}

/** End the held press, if any, with NOTHING run (Escape, blur, a lost release, the next press). */
export function cancelCellPress(): void {
  const s = live;
  if (!s) return;
  if (s.outcome === null) s.outcome = { kind: "cancelled" };
  finish(s);
}

/** Is a claimed press held right now (armed, its release not yet heard)? */
export function isCellPressHeld(): boolean {
  return live !== null && live.claim !== null;
}

function settle(s: Session, answer: CellClickAnswer): void {
  if (s.settled) return;
  s.settled = true;
  const claim = isCellReleaseClaim(answer) ? answer : null;
  if (claim === null) {
    // Acted at the press, or declined: nothing to hold.
    if (live === s) finish(s);
    return;
  }
  if (s.outcome !== null) {
    // The press ended while the interceptors were answering.
    if (s.outcome.kind === "released") judge(claim, s.outcome.point);
    return;
  }
  if (live !== s) return;
  s.claim = claim;
  follow(s, s.last);
}

function sampleOf(e: {
  clientX: number;
  clientY: number;
  target?: EventTarget | null;
  ctrlKey?: boolean;
  metaKey?: boolean;
}): CellPressSample {
  return {
    clientX: e.clientX,
    clientY: e.clientY,
    target: e.target ?? null,
    ctrlKey: e.ctrlKey === true,
    metaKey: e.metaKey === true,
  };
}

/** The point Core hands a claim, or null when the sample is off the cells or on another sheet. */
function pointOf(s: Session, sample: CellPressSample): CellPressPoint | null {
  let cell: { row: number; col: number } | null;
  try {
    if (s.deps.sheetKey() !== s.sheet) return null;
    cell = s.deps.cellAt(sample);
  } catch (error) {
    console.error("[cellPressRelease] the grid could not place the pointer:", error);
    return null;
  }
  if (cell === null) return null;
  return {
    clientX: sample.clientX,
    clientY: sample.clientY,
    ctrlKey: sample.ctrlKey,
    metaKey: sample.metaKey,
    row: cell.row,
    col: cell.col,
  };
}

/** Is the claim's own target under this point? */
function onTarget(claim: CellReleaseClaim, point: CellPressPoint | null): boolean {
  if (point === null) return false;
  try {
    return claim.targetAt(point) === claim.key;
  } catch (error) {
    console.error("[cellPressRelease] a release claim could not place the pointer:", error);
    return false;
  }
}

function setLook(s: Session, pressed: boolean): void {
  if (s.pressed === pressed) return;
  s.pressed = pressed;
  try {
    s.claim?.setPressed?.(pressed);
  } catch (error) {
    console.error("[cellPressRelease] a release claim's pressed look failed:", error);
  }
  s.deps.redraw();
}

/** The pressed look follows the pointer. */
function follow(s: Session, sample: CellPressSample): void {
  if (s.claim === null) return;
  setLook(s, onTarget(s.claim, pointOf(s, sample)));
}

/** Unbind, and turn the pressed look off. */
function finish(s: Session): void {
  if (live === s) {
    live = null;
    window.removeEventListener("mousemove", onPressMove);
    window.removeEventListener("mouseup", onPressUp);
    window.removeEventListener("keydown", onPressKey, true);
    window.removeEventListener("blur", onPressBlur);
  }
  setLook(s, false);
}

/** Run the claim ONCE when the release is over its own target. */
function judge(claim: CellReleaseClaim, point: CellPressPoint | null): void {
  if (point === null || !onTarget(claim, point)) return;
  try {
    const result = claim.runAtRelease(point);
    if (result !== undefined && typeof (result as Promise<void>).then === "function") {
      (result as Promise<void>).then(undefined, (error: unknown) => {
        console.error("[cellPressRelease] a release claim failed:", error);
      });
    }
  } catch (error) {
    console.error("[cellPressRelease] a release claim failed:", error);
  }
}

const onPressMove = (e: MouseEvent): void => {
  const s = live;
  if (!s) return;
  // The press exists only while the primary button is HELD: a move with it up
  // means its release was never heard. Nothing runs.
  if ((e.buttons & 1) === 0) {
    cancelCellPress();
    return;
  }
  s.last = sampleOf(e);
  follow(s, s.last);
};

const onPressUp = (e: MouseEvent): void => {
  const s = live;
  if (!s) return;
  if (e.button !== 0) {
    // Another button let go. With the primary one still held the press goes
    // on; with it up this was never a primary release, and it ends here.
    if ((e.buttons & 1) === 0) cancelCellPress();
    return;
  }
  const sample = sampleOf(e);
  // Measured NOW, at the release, whether or not the claim has arrived.
  const point = pointOf(s, sample);
  s.outcome = { kind: "released", point, sample };
  finish(s);
  if (s.claim !== null) judge(s.claim, point);
};

const onPressKey = (e: KeyboardEvent): void => {
  const s = live;
  if (!s || e.key !== "Escape") return;
  // Once a claim holds the press, the Escape is the press's: the keybinding
  // dispatcher (window capture, earlier) stood aside for it, and nothing past
  // this point hears it. Before that (the interceptors still answering) nobody
  // has claimed the press, so the Escape cancels it AND goes on to whoever owns
  // it.
  if (s.claim !== null) {
    e.preventDefault();
    e.stopPropagation();
  }
  cancelCellPress();
};

const onPressBlur = (): void => {
  cancelCellPress();
};
