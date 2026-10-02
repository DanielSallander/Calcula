//! FILENAME: app/src/core/lib/__tests__/cellPressRelease.test.ts
// PURPOSE: A cell press an interceptor CLAIMS acts on its RELEASE over the same
//          target, and sliding off cancels (BUG-0258 design phase 4, "Buttons
//          and pivot +/- act on release instead of on press"; the owner's
//          answer "on release, and sliding off cancels"). The session lives in
//          Core (core/lib/cellPressRelease.ts) and is the ONE place every
//          release-time cell interceptor goes through:
//            - the press only arms: nothing runs;
//            - the release runs the claim ONCE, and only over the same target
//              (the claim's own key), on the cells, on the sheet it began on;
//            - the pressed look follows the pointer in and out of the target;
//            - a release heard during the async interceptor check still counts
//              (a fast click's mouseup arrives before the claim does);
//            - Escape, a window blur, a move with the primary button up, a
//              middle release with the primary up, the next press and a
//              non-primary press end it with nothing run;
//            - the window listeners live only as long as the press.
// CONTEXT: The deps are a fake grid (100 x 20 px cells from the client origin)
//          so what is observed is WHEN and HOW OFTEN a claim runs.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  actOnCellRelease,
  actOnRelease,
  isCellPressed,
  type CellPressPoint,
  type CellReleaseClaim,
} from "../cellClickInterceptors";
import {
  cancelCellPress,
  isCellPressHeld,
  openCellPress,
  type CellPressDeps,
  type CellPressSample,
} from "../cellPressRelease";

// ============================================================================
// A fake grid
// ============================================================================

/** DOM stacked ABOVE the grid (a menu, a dialog): never on the cells. */
let outside: HTMLDivElement;
let sheet = "0";
const redraw = vi.fn();
const cellAtCalls: CellPressSample[] = [];

const deps: CellPressDeps = {
  cellAt: (sample) => {
    cellAtCalls.push(sample);
    if (sample.target === outside) return null;
    if (sample.clientX < 0 || sample.clientY < 0) return null;
    return { row: Math.floor(sample.clientY / 20), col: Math.floor(sample.clientX / 100) };
  },
  sheetKey: () => sheet,
  redraw,
};

/** The centre of cell (row, col) in client px. */
function at(row: number, col: number): { x: number; y: number } {
  return { x: col * 100 + 50, y: row * 20 + 10 };
}

function press(p: { x: number; y: number }, button = 0) {
  return openCellPress({ clientX: p.x, clientY: p.y, button, target: null }, deps);
}

function move(p: { x: number; y: number }, buttons = 1): void {
  window.dispatchEvent(new MouseEvent("mousemove", { clientX: p.x, clientY: p.y, buttons }));
}

/** `buttons`: the buttons still held AFTER this release (bit 1 = the primary). */
function release(p: { x: number; y: number }, button = 0, buttons = 0, on: EventTarget = window): void {
  on.dispatchEvent(new MouseEvent("mouseup", { clientX: p.x, clientY: p.y, button, buttons, bubbles: true }));
}

function escape(on: EventTarget = document.body): KeyboardEvent {
  const e = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
  on.dispatchEvent(e);
  return e;
}

/** A claim on the button cell at (row, col) with the pressed look. */
function cellClaim(row: number, col: number) {
  const run = vi.fn<(p: CellPressPoint) => void>();
  return { run, claim: actOnCellRelease(row, col, run, { pressedLook: true }) };
}

beforeEach(() => {
  cancelCellPress();
  sheet = "0";
  redraw.mockClear();
  cellAtCalls.length = 0;
  outside = document.createElement("div");
  document.body.appendChild(outside);
});

afterEach(() => {
  cancelCellPress();
  outside.remove();
  vi.restoreAllMocks();
});

// ============================================================================
// The release decides
// ============================================================================

describe("a claimed cell press acts on the RELEASE over the same target", () => {
  it("the press runs nothing; the release on the same cell runs it ONCE, with the release point", () => {
    const { run, claim } = cellClaim(2, 1);
    press(at(2, 1)).settle(claim);
    expect(isCellPressHeld()).toBe(true);
    expect(run, "the claim ran on the PRESS").not.toHaveBeenCalled();

    release({ x: 160, y: 47 });
    expect(run).toHaveBeenCalledTimes(1);
    expect(run.mock.calls[0][0]).toMatchObject({ row: 2, col: 1, clientX: 160, clientY: 47 });
    expect(isCellPressHeld()).toBe(false);
    // A second release (no press) runs nothing more.
    release(at(2, 1));
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("released on ANOTHER cell: nothing runs", () => {
    const { run, claim } = cellClaim(2, 1);
    press(at(2, 1)).settle(claim);
    move(at(2, 2));
    release(at(2, 2));
    expect(run, "a release on another cell ran the press's target").not.toHaveBeenCalled();
  });

  it("released OFF the cells (a header, outside the grid): nothing runs", () => {
    const { run, claim } = cellClaim(2, 1);
    press(at(2, 1)).settle(claim);
    release({ x: -5, y: 47 });
    expect(run).not.toHaveBeenCalled();
  });

  it("released over DOM stacked above the grid (the release's target is handed to Core's hit test): nothing runs", () => {
    const { run, claim } = cellClaim(2, 1);
    press(at(2, 1)).settle(claim);
    release(at(2, 1), 0, 0, outside);
    expect(cellAtCalls.some((s) => s.target === outside), "the release's target never reached Core's question").toBe(true);
    expect(run, "a release over a menu covering the button ran it").not.toHaveBeenCalled();
  });

  it("slid off and BACK onto the same cell before the release: it runs (the release decides)", () => {
    const { run, claim } = cellClaim(2, 1);
    press(at(2, 1)).settle(claim);
    move(at(2, 3));
    move(at(2, 1));
    release(at(2, 1));
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("the sheet changed under the held press: the release on the same coordinates runs nothing", () => {
    const { run, claim } = cellClaim(2, 1);
    press(at(2, 1)).settle(claim);
    sheet = "1";
    release(at(2, 1));
    expect(run, "the release ran the button at the same cell of ANOTHER sheet").not.toHaveBeenCalled();
  });

  it("a claim's own key decides, not the cell: a target spanning cells runs from anywhere on it", () => {
    const run = vi.fn();
    const claim = actOnRelease({
      key: "wide",
      targetAt: (p) => (p.row === 4 && p.col >= 1 && p.col <= 3 ? "wide" : null),
      runAtRelease: run,
    });
    press(at(4, 1)).settle(claim);
    release(at(4, 3));
    expect(run).toHaveBeenCalledTimes(1);
  });
});

// ============================================================================
// The pressed look
// ============================================================================

describe("the pressed look follows the pointer while the press is held", () => {
  it("on at the arm, off while outside, on again inside, off at the release -- one repaint per change", () => {
    const setPressed = vi.fn<(pressed: boolean) => void>();
    const claim = actOnRelease({
      key: "k",
      targetAt: (p) => (p.row === 2 && p.col === 1 ? "k" : null),
      runAtRelease: () => {},
      setPressed,
    });
    press(at(2, 1)).settle(claim);
    expect(setPressed.mock.calls.map((c) => c[0])).toEqual([true]);
    move({ x: 160, y: 50 }); // still inside: no change, no repaint
    expect(setPressed).toHaveBeenCalledTimes(1);
    move(at(5, 5));
    move(at(2, 1));
    release(at(2, 1));
    expect(setPressed.mock.calls.map((c) => c[0])).toEqual([true, false, true, false]);
    expect(redraw).toHaveBeenCalledTimes(4);
  });

  it("a cell claim with the pressed look: isCellPressed answers for THAT cell only while held inside", () => {
    const { claim } = cellClaim(2, 1);
    press(at(2, 1)).settle(claim);
    expect(isCellPressed(2, 1)).toBe(true);
    expect(isCellPressed(2, 2)).toBe(false);
    move(at(9, 9));
    expect(isCellPressed(2, 1), "the look stuck while the pointer was outside").toBe(false);
    move(at(2, 1));
    expect(isCellPressed(2, 1)).toBe(true);
    release(at(2, 1));
    expect(isCellPressed(2, 1)).toBe(false);
  });

  it("every end path turns the look off: Escape, blur, a lost release, the next press", () => {
    for (const end of [
      () => escape(),
      () => window.dispatchEvent(new Event("blur")),
      () => move(at(2, 1), 0),
      () => press(at(7, 7)),
    ]) {
      const { claim } = cellClaim(2, 1);
      press(at(2, 1)).settle(claim);
      expect(isCellPressed(2, 1)).toBe(true);
      end();
      expect(isCellPressed(2, 1), `an end path left the button looking pressed: ${String(end)}`).toBe(false);
      cancelCellPress();
    }
  });

  it("a claim without the pressed look is never asked for one", () => {
    const run = vi.fn();
    press(at(2, 1)).settle(actOnCellRelease(2, 1, run));
    expect(isCellPressed(2, 1)).toBe(false);
    release(at(2, 1));
    expect(run).toHaveBeenCalledTimes(1);
  });
});

// ============================================================================
// The async gap: the claim arrives after the release
// ============================================================================

describe("a release heard while the interceptors were still answering", () => {
  it("over the target: runs once, when the claim arrives", () => {
    const p = press(at(2, 1));
    release(at(2, 1));
    const { run, claim } = cellClaim(2, 1);
    expect(run).not.toHaveBeenCalled();
    p.settle(claim);
    expect(run, "a fast click (release before the claim) never ran").toHaveBeenCalledTimes(1);
    expect(isCellPressHeld()).toBe(false);
    expect(isCellPressed(2, 1)).toBe(false);
  });

  it("off the target: nothing runs when the claim arrives", () => {
    const p = press(at(2, 1));
    move(at(2, 4));
    release(at(2, 4));
    const { run, claim } = cellClaim(2, 1);
    p.settle(claim);
    expect(run).not.toHaveBeenCalled();
  });

  it("Escape or a blur during the check: nothing runs; that Escape is NOT consumed (no claim was known yet)", () => {
    const heard = vi.fn();
    document.addEventListener("keydown", heard);
    try {
      const p = press(at(2, 1));
      const e = escape();
      expect(heard, "an Escape during the check was swallowed before anything claimed the press").toHaveBeenCalledTimes(1);
      expect(e.defaultPrevented).toBe(false);
      release(at(2, 1));
      const { run, claim } = cellClaim(2, 1);
      p.settle(claim);
      expect(run).not.toHaveBeenCalled();
    } finally {
      document.removeEventListener("keydown", heard);
    }

    const p2 = press(at(2, 1));
    window.dispatchEvent(new Event("blur"));
    const second = cellClaim(2, 1);
    p2.settle(second.claim);
    release(at(2, 1));
    expect(second.run).not.toHaveBeenCalled();
  });

  it("a claim settled twice arms once", () => {
    const p = press(at(2, 1));
    const { run, claim } = cellClaim(2, 1);
    p.settle(claim);
    p.settle(claim);
    release(at(2, 1));
    expect(run).toHaveBeenCalledTimes(1);
  });
});

// ============================================================================
// Ends with nothing run
// ============================================================================

describe("ends with NOTHING run", () => {
  it("Escape while held: consumed (nothing else hears it), nothing runs", () => {
    const heard = vi.fn();
    document.addEventListener("keydown", heard);
    try {
      const { run, claim } = cellClaim(2, 1);
      press(at(2, 1)).settle(claim);
      const e = escape();
      expect(e.defaultPrevented).toBe(true);
      expect(heard, "the press's Escape also reached the grid / a canvas").not.toHaveBeenCalled();
      expect(isCellPressHeld()).toBe(false);
      release(at(2, 1));
      expect(run).not.toHaveBeenCalled();
    } finally {
      document.removeEventListener("keydown", heard);
    }
  });

  it("another key while held is not the press's", () => {
    const { run, claim } = cellClaim(2, 1);
    press(at(2, 1)).settle(claim);
    const e = new KeyboardEvent("keydown", { key: "a", bubbles: true, cancelable: true });
    document.body.dispatchEvent(e);
    expect(e.defaultPrevented).toBe(false);
    release(at(2, 1));
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("a window blur", () => {
    const { run, claim } = cellClaim(2, 1);
    press(at(2, 1)).settle(claim);
    window.dispatchEvent(new Event("blur"));
    release(at(2, 1));
    expect(run).not.toHaveBeenCalled();
  });

  it("a move with the primary button UP (a release this page never heard)", () => {
    const { run, claim } = cellClaim(2, 1);
    press(at(2, 1)).settle(claim);
    move(at(2, 1), 0);
    expect(isCellPressHeld()).toBe(false);
    release(at(2, 1));
    expect(run).not.toHaveBeenCalled();
  });

  it("a middle release with the primary up ends it; a secondary release with the primary HELD does not", () => {
    const first = cellClaim(2, 1);
    press(at(2, 1)).settle(first.claim);
    release(at(2, 1), 1, 0);
    expect(isCellPressHeld()).toBe(false);
    release(at(2, 1));
    expect(first.run).not.toHaveBeenCalled();

    const second = cellClaim(2, 1);
    press(at(2, 1)).settle(second.claim);
    release(at(2, 1), 2, 1);
    expect(isCellPressHeld(), "a secondary release with the primary held ended the press").toBe(true);
    release(at(2, 1));
    expect(second.run).toHaveBeenCalledTimes(1);
  });

  it("the next press ends the held one", () => {
    const first = cellClaim(2, 1);
    press(at(2, 1)).settle(first.claim);
    press(at(6, 0));
    release(at(2, 1));
    expect(first.run, "a press superseded by another one still ran").not.toHaveBeenCalled();
  });

  it("a NON-primary press never arms: a right or middle press answered with a claim runs nothing", () => {
    for (const button of [1, 2]) {
      const { run, claim } = cellClaim(2, 1);
      press(at(2, 1), button).settle(claim);
      expect(isCellPressHeld()).toBe(false);
      release(at(2, 1));
      expect(run, `button ${button} ran the cell`).not.toHaveBeenCalled();
    }
  });

  it("an answer that is not a claim (acted at the press, or declined) arms nothing", () => {
    for (const answer of [true, false]) {
      const p = press(at(2, 1));
      p.settle(answer);
      expect(isCellPressHeld()).toBe(false);
    }
  });
});

// ============================================================================
// Failures are contained
// ============================================================================

describe("a failing claim never breaks the grid", () => {
  it("a runAtRelease that rejects is logged, and the press is over", async () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const claim = actOnCellRelease(2, 1, async () => {
      throw new Error("boom");
    });
    press(at(2, 1)).settle(claim);
    release(at(2, 1));
    await Promise.resolve();
    await Promise.resolve();
    expect(errors).toHaveBeenCalled();
    expect(isCellPressHeld()).toBe(false);
  });

  it("a targetAt that throws counts as OFF the target (logged), and nothing runs", () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const run = vi.fn();
    const claim: CellReleaseClaim = actOnRelease({
      key: "k",
      targetAt: () => {
        throw new Error("geometry gone");
      },
      runAtRelease: run,
    });
    press(at(2, 1)).settle(claim);
    release(at(2, 1));
    expect(run).not.toHaveBeenCalled();
    expect(errors).toHaveBeenCalled();
  });
});

// ============================================================================
// Listener lifetime
// ============================================================================

describe("the window listeners live only as long as the press", () => {
  function listenerLedger() {
    const live = new Map<string, number>();
    const add = vi.spyOn(window, "addEventListener");
    const remove = vi.spyOn(window, "removeEventListener");
    return {
      count(): Record<string, number> {
        live.clear();
        for (const c of add.mock.calls) live.set(String(c[0]), (live.get(String(c[0])) ?? 0) + 1);
        for (const c of remove.mock.calls) live.set(String(c[0]), (live.get(String(c[0])) ?? 0) - 1);
        return Object.fromEntries(live);
      },
    };
  }

  it("bound at the press (mousemove, mouseup, keydown, blur), all four gone after the release", () => {
    const ledger = listenerLedger();
    const { claim } = cellClaim(2, 1);
    press(at(2, 1)).settle(claim);
    expect(ledger.count()).toEqual({ mousemove: 1, mouseup: 1, keydown: 1, blur: 1 });
    release(at(2, 1));
    expect(ledger.count()).toEqual({ mousemove: 0, mouseup: 0, keydown: 0, blur: 0 });
  });

  it("an unclaimed press unbinds as soon as the interceptors answer", () => {
    const ledger = listenerLedger();
    press(at(2, 1)).settle(false);
    expect(ledger.count()).toEqual({ mousemove: 0, mouseup: 0, keydown: 0, blur: 0 });
  });

  it("a non-primary press binds nothing at all", () => {
    const ledger = listenerLedger();
    press(at(2, 1), 2);
    expect(ledger.count()).toEqual({});
  });
});
