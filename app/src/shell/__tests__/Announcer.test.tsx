//! FILENAME: app/src/shell/__tests__/Announcer.test.tsx
// PURPOSE: The shell's one polite live region (M8 S6): it exists with the
//          roles a screen reader needs, it is the sink behind @api/announce,
//          the SAME sentence announced twice is heard twice, and a HELD key
//          does not flood the reader (M8 review, finding 2).
// CONTEXT: A live region speaks when its content CHANGES. Pressing Space twice
//          on the same slicer item announces the same sentence twice; written
//          straight over itself it is no change, and the second press is
//          silent. So the region empties first and writes only once it has
//          SETTLED (ANNOUNCE_SETTLE_MS): long enough that the empty state is
//          rendered -- and so seen by the accessibility tree -- before the
//          sentence arrives (a write on the next animation frame lands in the
//          same rendering update as the clear, before the tree is built), and
//          long enough that an OS key repeat (~30 per second) keeps replacing
//          the pending sentence: a held arrow says where it STOPPED, once,
//          instead of queueing every slot it passed.
//          Time is a fake clock here -- animation frames included -- so each
//          state a screen reader could observe is asserted, not inferred.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { ANNOUNCE_SETTLE_MS, Announcer } from "../Announcer";
import { announce } from "../../api/announce";

Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

/** One display frame at 60 Hz. */
const FRAME_MS = 16;
/** An OS key repeat at its default rate (about 30 per second). */
const KEY_REPEAT_MS = 33;

let container: HTMLDivElement;
let root: Root;

function mount(element: React.ReactElement = <Announcer />): void {
  act(() => {
    root.render(element);
  });
}

function region(): HTMLElement {
  const el = container.querySelector<HTMLElement>("[data-testid='app-announcer']");
  if (!el) throw new Error("the announcer region is not in the DOM");
  return el;
}

/**
 * Run `steps` in order and return every text the region held after each
 * announce and after each passage of time -- the states a screen reader can
 * observe.
 */
function observe(steps: Array<{ announce: string } | { wait: number }>): string[] {
  const seen: string[] = [region().textContent ?? ""];
  for (const step of steps) {
    if ("wait" in step) vi.advanceTimersByTime(step.wait);
    else announce(step.announce);
    seen.push(region().textContent ?? "");
  }
  return seen;
}

/** How many times the region BECAME `message` (a change into it). */
function updatesTo(states: string[], message: string): number {
  let count = 0;
  for (let i = 1; i < states.length; i++) {
    if (states[i] === message && states[i - 1] !== message) count++;
  }
  return count;
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "requestAnimationFrame", "cancelAnimationFrame"] });
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("shell Announcer (the app's polite live region)", () => {
  it("exists once, with role status, aria-live polite and aria-atomic", () => {
    mount();
    expect(container.querySelectorAll("[data-testid='app-announcer']")).toHaveLength(1);
    const el = region();
    expect(el.getAttribute("role")).toBe("status");
    expect(el.getAttribute("aria-live")).toBe("polite");
    expect(el.getAttribute("aria-atomic")).toBe("true");
  });

  it("is visually hidden but stays in the accessibility tree, and is never focusable", () => {
    mount();
    const el = region();
    expect(el.style.position).toBe("absolute");
    expect(el.style.overflow).toBe("hidden");
    expect(el.style.width).toBe("1px");
    expect(el.style.height).toBe("1px");
    // display:none / visibility:hidden would take it out of the a11y tree.
    expect(el.style.display).not.toBe("none");
    expect(el.style.visibility).not.toBe("hidden");
    expect(el.hasAttribute("tabindex")).toBe(false);
    expect(el.textContent).toBe("");
  });

  it("empties at once, and writes the sentence only once the region SETTLED -- not on the next animation frame, before the empty state was ever rendered", () => {
    mount();
    const states = observe([
      { announce: "North, selected, 2 of 5" },
      { wait: FRAME_MS },
      { wait: ANNOUNCE_SETTLE_MS - FRAME_MS },
    ]);
    expect(states[1], "the region was not emptied first").toBe("");
    expect(states[2], "the sentence was written on the next frame: the empty state never reached the accessibility tree").toBe("");
    expect(states[3]).toBe("North, selected, 2 of 5");
    expect(ANNOUNCE_SETTLE_MS, "too short to outlast a frame and an OS key repeat").toBeGreaterThan(KEY_REPEAT_MS * 3);
  });

  it("the same message twice produces two updates", () => {
    mount();
    const states = observe([
      { announce: "North, selected" },
      { wait: ANNOUNCE_SETTLE_MS },
      { announce: "North, selected" },
      { wait: ANNOUNCE_SETTLE_MS },
    ]);
    // The region passes through empty between the two, so the second is a
    // change a screen reader announces.
    expect(states).toEqual(["", "", "North, selected", "", "North, selected"]);
    expect(updatesTo(states, "North, selected")).toBe(2);
  });

  it("a second message before the region settled replaces the first (only the latest is written)", () => {
    mount();
    const states = observe([{ announce: "North" }, { wait: FRAME_MS }, { announce: "South" }, { wait: ANNOUNCE_SETTLE_MS }]);
    expect(states[states.length - 1]).toBe("South");
    expect(updatesTo(states, "North")).toBe(0);
    expect(vi.getTimerCount(), "a superseded write is still pending").toBe(0);
  });

  it("a HELD arrow (an announcement every key repeat) writes ONE sentence -- where it stopped -- once the keys stop: the reader is never left seconds behind the ring", () => {
    mount();
    const steps: Array<{ announce: string } | { wait: number }> = [];
    for (let i = 1; i <= 10; i++) {
      steps.push({ announce: `Item ${i}, ${i} of 40` }, { wait: KEY_REPEAT_MS });
    }
    steps.push({ wait: ANNOUNCE_SETTLE_MS });
    const states = observe(steps);
    const spoken = states.filter((s, i) => s !== "" && s !== states[i - 1]);
    expect(spoken, "every repeat was written: a polite region QUEUES them all").toEqual(["Item 10, 10 of 40"]);
  });

  it("never moves DOM focus", () => {
    const input = document.createElement("input");
    document.body.appendChild(input);
    try {
      input.focus();
      expect(document.activeElement).toBe(input);
      mount();
      announce("North, selected");
      vi.advanceTimersByTime(ANNOUNCE_SETTLE_MS);
      expect(document.activeElement).toBe(input);
    } finally {
      input.remove();
    }
  });

  it("unmounting unregisters the sink and cancels a pending write", () => {
    mount();
    announce("about to unmount");
    expect(vi.getTimerCount()).toBe(1);
    act(() => root.render(<></>));
    expect(vi.getTimerCount(), "the pending write survived the unmount").toBe(0);
    expect(() => announce("after unmount")).not.toThrow();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("an OLD region unmounting after a new one mounted does not silence the new one", () => {
    // Two shells briefly coexist (a remount): the old one's cleanup runs last.
    const second = document.createElement("div");
    document.body.appendChild(second);
    const secondRoot = createRoot(second);
    try {
      mount(); // the old region registers first
      act(() => secondRoot.render(<Announcer />)); // the new one registers after
      act(() => root.render(<></>)); // the old one unmounts late
      announce("from the new shell");
      vi.advanceTimersByTime(ANNOUNCE_SETTLE_MS);
      const el = second.querySelector<HTMLElement>("[data-testid='app-announcer']");
      expect(el?.textContent).toBe("from the new shell");
    } finally {
      act(() => secondRoot.unmount());
      second.remove();
    }
  });

  it("keeps announcing under React StrictMode (mount, cleanup, mount)", () => {
    mount(
      <React.StrictMode>
        <Announcer />
      </React.StrictMode>,
    );
    announce("strict");
    vi.advanceTimersByTime(ANNOUNCE_SETTLE_MS);
    expect(region().textContent).toBe("strict");
  });
});
