//! FILENAME: app/extensions/Controls/lib/__tests__/buttonPress.test.ts
// PURPOSE: A run-mode floating button runs at the RELEASE inside it, and not at
//          all when the pointer slides off first (lib/buttonPress.ts, BUG-0258
//          design phase 4c -- the Windows button rule):
//            - the press only arms: nothing runs, the button shows pressed;
//            - the pressed look follows the pointer in and out of the button;
//            - a release inside runs it ONCE; outside, over another object
//              stacked on top, after Escape / blur / a lost release: never;
//            - the window listeners live only as long as the press;
//            - a release of another button ends the press only when the
//              primary one is up (a MIDDLE press arms a press too);
//            - the press holds Core's pointer over the button (no grip, no
//              resize handle under a held button) and lets go on every end
//              path (BUG-0258 M7 review).
// CONTEXT: "Inside" is Core's own hit answer (`topFloatingRegionAtClient`:
//          on the button's rectangle AND the topmost floating object there),
//          doubled here by a fake that knows the button's client rectangle and
//          whether something covers it.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const h = vi.hoisted(() => ({
  /** The button's client rectangle. */
  button: { left: 100, top: 50, right: 220, bottom: 90 },
  /** Another floating object stacked ON TOP of the button, over this client rectangle. */
  cover: null as null | { left: number; top: number; right: number; bottom: number },
  redraws: 0,
}));

vi.mock("@api/gridOverlays", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@api/gridOverlays")>()),
  requestOverlayRedraw: () => {
    h.redraws += 1;
  },
  topFloatingRegionAtClient: (x: number, y: number) => {
    const inRect = (r: { left: number; top: number; right: number; bottom: number }) =>
      x >= r.left && x <= r.right && y >= r.top && y <= r.bottom;
    if (h.cover && inRect(h.cover)) return { id: "cover" };
    if (inRect(h.button)) return { id: "control-0-2-1" };
    return null;
  },
}));

import { clearContentGestureCursor, contentGestureCursorFor, isContentGestureHeld } from "@api/gridOverlays";
import {
  beginFloatingButtonPress,
  cancelFloatingButtonPress,
  isFloatingButtonPressActive,
  isFloatingButtonPressed,
} from "../buttonPress";

const BUTTON = "control-0-2-1";
const INSIDE = { x: 150, y: 70 };
const INSIDE_2 = { x: 210, y: 85 };
const OUTSIDE = { x: 150 + 60, y: 70 + 60 };

const run = vi.fn();

function press(): void {
  beginFloatingButtonPress({ controlId: BUTTON, regionId: BUTTON, run });
}

function move(at: { x: number; y: number }, buttons = 1): void {
  window.dispatchEvent(new MouseEvent("mousemove", { clientX: at.x, clientY: at.y, buttons }));
}

/** `buttons`: the buttons still held AFTER this release (bit 1 = the primary). */
function release(at: { x: number; y: number }, button = 0, buttons = 0): void {
  window.dispatchEvent(new MouseEvent("mouseup", { clientX: at.x, clientY: at.y, button, buttons }));
}

function key(k: string): KeyboardEvent {
  const e = new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true });
  window.dispatchEvent(e);
  return e;
}

beforeEach(() => {
  run.mockReset();
  h.cover = null;
  h.redraws = 0;
});

afterEach(() => {
  cancelFloatingButtonPress();
  clearContentGestureCursor();
});

describe("the press arms; the release inside runs", () => {
  it("PRESS: nothing runs, and the button shows pressed", () => {
    press();
    expect(run, "the button ran on the PRESS").not.toHaveBeenCalled();
    expect(isFloatingButtonPressed(BUTTON)).toBe(true);
    expect(isFloatingButtonPressed("control-0-9-9"), "another control shows pressed").toBe(false);
    expect(h.redraws, "the pressed look was never painted").toBeGreaterThan(0);
  });

  it("released INSIDE: runs once, and the pressed look ends", () => {
    press();
    move(INSIDE_2);
    release(INSIDE_2);
    expect(run).toHaveBeenCalledTimes(1);
    expect(isFloatingButtonPressed(BUTTON)).toBe(false);
    expect(isFloatingButtonPressActive()).toBe(false);
    // A second release is heard by nobody.
    release(INSIDE);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("SLID OFF and released outside: never runs; the pressed look goes off while outside", () => {
    press();
    const before = h.redraws;
    move(OUTSIDE);
    expect(isFloatingButtonPressed(BUTTON), "still pressed with the pointer off the button").toBe(false);
    expect(isFloatingButtonPressActive(), "the press itself is still held").toBe(true);
    expect(h.redraws, "leaving the button did not repaint it").toBeGreaterThan(before);
    release(OUTSIDE);
    expect(run, "sliding off did not cancel the button").not.toHaveBeenCalled();
  });

  it("out and back in, released inside: runs once (and looks pressed again when back)", () => {
    press();
    move(OUTSIDE);
    move(INSIDE);
    expect(isFloatingButtonPressed(BUTTON)).toBe(true);
    release(INSIDE);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("released inside the rectangle while ANOTHER object is on top there: never runs", () => {
    h.cover = { left: 180, top: 60, right: 260, bottom: 120 };
    press();
    release({ x: 200, y: 80 });
    expect(run, "a release over an object covering the button ran it").not.toHaveBeenCalled();
  });

  it("a secondary-button release WITH THE PRIMARY STILL HELD does not end the press", () => {
    press();
    release(INSIDE, 2, 1);
    expect(run).not.toHaveBeenCalled();
    expect(isFloatingButtonPressActive()).toBe(true);
    release(INSIDE);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("a MIDDLE press (the primary never held): its release ends the press, running nothing -- it does not stay pressed until the pointer moves", () => {
    press();
    release(INSIDE, 1, 0);
    expect(isFloatingButtonPressActive(), "a middle click left the button pressed (and its listeners bound)").toBe(false);
    expect(isFloatingButtonPressed(BUTTON)).toBe(false);
    expect(run).not.toHaveBeenCalled();
    release(INSIDE);
    expect(run, "a later primary release ran a press that had ended").not.toHaveBeenCalled();
  });
});

describe("the press holds Core's pointer over the button, and lets go on every end path", () => {
  const ends: Array<[string, () => void]> = [
    ["a release inside", () => release(INSIDE)],
    ["a release outside", () => release(OUTSIDE)],
    ["Escape", () => void key("Escape")],
    ["a window blur", () => window.dispatchEvent(new Event("blur"))],
    ["a move with the primary button up", () => move(INSIDE, 0)],
    ["a middle release", () => release(INSIDE, 1, 0)],
    ["cancelFloatingButtonPress (deactivation)", () => cancelFloatingButtonPress()],
  ];
  for (const [name, end] of ends) {
    it(`held while pressed ('pointer', so no grip and no handle answers under it); let go after ${name}`, () => {
      press();
      expect(contentGestureCursorFor(BUTTON), "the press does not hold Core's pointer").toBe("pointer");
      expect(isContentGestureHeld()).toBe(true);
      move(OUTSIDE);
      expect(contentGestureCursorFor(BUTTON), "the hold ended when the pointer slid off").toBe("pointer");
      end();
      expect(contentGestureCursorFor(BUTTON), `the hold outlived ${name}`).toBeNull();
      expect(isContentGestureHeld()).toBe(false);
    });
  }

  it("the NEXT press takes the hold over: the old button's is gone, the new one's held", () => {
    beginFloatingButtonPress({ controlId: "control-0-5-5", regionId: "control-0-5-5", run: vi.fn() });
    expect(contentGestureCursorFor("control-0-5-5")).toBe("pointer");
    press();
    expect(contentGestureCursorFor("control-0-5-5")).toBeNull();
    expect(contentGestureCursorFor(BUTTON)).toBe("pointer");
  });
});

describe("every other ending runs nothing", () => {
  it("Escape cancels, and the Escape is the press's", () => {
    press();
    const e = key("Escape");
    expect(e.defaultPrevented, "the press did not take its Escape").toBe(true);
    expect(isFloatingButtonPressActive()).toBe(false);
    release(INSIDE);
    expect(run).not.toHaveBeenCalled();
  });

  it("another key does nothing to the press", () => {
    press();
    const e = key("a");
    expect(e.defaultPrevented).toBe(false);
    expect(isFloatingButtonPressActive()).toBe(true);
  });

  it("a move with the primary button UP (a release this page never heard) cancels", () => {
    press();
    move(INSIDE, 0);
    expect(isFloatingButtonPressActive()).toBe(false);
    release(INSIDE);
    expect(run).not.toHaveBeenCalled();
  });

  it("a window blur cancels", () => {
    press();
    window.dispatchEvent(new Event("blur"));
    expect(isFloatingButtonPressActive()).toBe(false);
    release(INSIDE);
    expect(run).not.toHaveBeenCalled();
  });

  it("the NEXT press cancels a press whose release never came (the old one never runs)", () => {
    const old = vi.fn();
    beginFloatingButtonPress({ controlId: "control-0-5-5", regionId: "control-0-5-5", run: old });
    press();
    release(INSIDE);
    expect(old).not.toHaveBeenCalled();
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("cancelFloatingButtonPress (deactivation) runs nothing", () => {
    press();
    cancelFloatingButtonPress();
    expect(isFloatingButtonPressed(BUTTON)).toBe(false);
    release(INSIDE);
    expect(run).not.toHaveBeenCalled();
  });
});

describe("the window listeners live only as long as the press", () => {
  it("bound at the press, every one removed at the release", () => {
    const add = vi.spyOn(window, "addEventListener");
    const remove = vi.spyOn(window, "removeEventListener");
    try {
      expect(isFloatingButtonPressActive()).toBe(false);
      press();
      const bound = add.mock.calls.map((c) => [c[0], c[1]] as const);
      expect(bound.map((b) => b[0]).sort()).toEqual(["blur", "keydown", "mousemove", "mouseup"]);
      release(INSIDE);
      for (const [type, fn] of bound) {
        expect(
          remove.mock.calls.some((c) => c[0] === type && c[1] === fn),
          `the press's ${type} listener outlived it`,
        ).toBe(true);
      }
    } finally {
      add.mockRestore();
      remove.mockRestore();
    }
  });
});
