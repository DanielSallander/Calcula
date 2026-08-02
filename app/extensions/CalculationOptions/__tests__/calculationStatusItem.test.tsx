//! FILENAME: app/extensions/CalculationOptions/__tests__/calculationStatusItem.test.tsx
// PURPOSE: The user-visible half of calculation cancellation — that a long
//          recalculation actually offers a way out, that pressing it reaches the
//          backend, and that a cancelled pass leaves the user able to SEE how
//          much of the workbook is stale.
// CONTEXT: The backend can stop a recalculation perfectly and it is worth
//          nothing if the button is never drawn or is drawn over a frozen UI.
//          These tests pin the three failure modes that would make the feature
//          exist without working: chrome that flashes on every trivial F9,
//          chrome that never appears on a long one, and a "cancelled" state the
//          user cannot distinguish from a finished one.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";

// --- The backend door, mocked wholesale ------------------------------------
const cancelCalculation = vi.fn(async () => true);
const getPendingRecalc = vi.fn(async () => null as unknown);
let progressHandler: ((payload: unknown) => void) | null = null;
const unlisten = vi.fn();
const listenForEvent = vi.fn(async (_event: string, handler: (p: unknown) => void) => {
  progressHandler = handler;
  return unlisten;
});
const onAppEvent = vi.fn(() => () => {});
const emitAppEvent = vi.fn();

vi.mock("@api", () => ({
  cancelCalculation: (...a: unknown[]) => cancelCalculation(...(a as [])),
  getPendingRecalc: (...a: unknown[]) => getPendingRecalc(...(a as [])),
  listenForEvent: (...a: unknown[]) =>
    listenForEvent(...(a as [string, (p: unknown) => void])),
  onAppEvent: (...a: unknown[]) => onAppEvent(...(a as [])),
  emitAppEvent: (...a: unknown[]) => emitAppEvent(...(a as [])),
  AppEvents: {
    RECALCULATION_COMPLETED: "app:recalculation-completed",
    RECALC_INCOMPLETE: "app:recalc-incomplete",
  },
}));

import {
  CalculationStatusItem,
  PROGRESS_VISIBLE_AFTER_MS,
} from "../components/CalculationStatusItem";

let container: HTMLDivElement;
let root: Root;

/**
 * Group a number the way the COMPONENT does.
 *
 * Deliberately not a hardcoded "1,000": the component uses
 * `toLocaleString()`, so on a Swedish machine (this repo's own environment)
 * the separator is a non-breaking space, and asserting the US form would fail
 * on the developer's laptop while passing in CI. Same class of bug as the
 * formula-separator locale trap already documented for the E2E suite.
 */
function grouped(n: number): string {
  return n.toLocaleString();
}

function mount(): void {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root.render(React.createElement(CalculationStatusItem));
  });
}

function progress(over: Record<string, unknown> = {}): void {
  act(() => {
    progressHandler?.({
      scope: "workbook",
      cellsDone: 1_000,
      cellsTotal: 10_000,
      elapsedMs: 200,
      done: false,
      cancelled: false,
      pendingCells: 0,
      ...over,
    });
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  cancelCalculation.mockClear();
  getPendingRecalc.mockClear();
  getPendingRecalc.mockResolvedValue(null);
  listenForEvent.mockClear();
  progressHandler = null;
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.useRealTimers();
});

describe("calculation progress + cancel", () => {
  it("shows nothing at all when no calculation is running", () => {
    mount();
    expect(container.textContent).toBe("");
  });

  it("stays invisible for a recalculation shorter than the delay", () => {
    // The anti-flash rule. Almost every F9 is instant, and chrome that appears
    // and vanishes on every keystroke-speed recalc trains people to ignore it —
    // which means they also ignore it on the one that matters.
    mount();
    progress({ cellsDone: 10, cellsTotal: 20 });
    act(() => {
      vi.advanceTimersByTime(PROGRESS_VISIBLE_AFTER_MS - 1);
    });
    expect(container.querySelector("[data-testid='calc-progress']")).toBeNull();
  });

  it("offers progress AND a Cancel button once a recalculation runs long", () => {
    mount();
    progress();
    act(() => {
      vi.advanceTimersByTime(PROGRESS_VISIBLE_AFTER_MS);
    });

    const el = container.querySelector("[data-testid='calc-progress']");
    expect(el).not.toBeNull();
    // The counts are the point: "Calculating…" alone tells the user nothing
    // about whether waiting is worthwhile.
    expect(el?.textContent).toContain(grouped(1_000));
    expect(el?.textContent).toContain(grouped(10_000));
    expect(el?.textContent).toContain("10%");

    const button = container.querySelector("button");
    expect(button).not.toBeNull();
    expect(button?.textContent).toBe("Cancel");
  });

  it("reaches the backend when Cancel is clicked, and says so immediately", () => {
    mount();
    progress();
    act(() => {
      vi.advanceTimersByTime(PROGRESS_VISIBLE_AFTER_MS);
    });

    const button = container.querySelector("button")!;
    act(() => {
      button.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect(cancelCalculation).toHaveBeenCalledTimes(1);
    // The pass only notices at its next poll boundary, so the label has to
    // acknowledge the click straight away — a button that looks inert for
    // 200 ms gets clicked five times.
    const after = container.querySelector("button");
    expect(after?.textContent).toBe("Stopping…");
    expect((after as HTMLButtonElement).disabled).toBe(true);
  });

  it("binds Esc to the same command as the button", () => {
    // VBA's Ctrl+Break, without VBA's keyboard poll: the keystroke is a
    // convenience that invokes the identical command, not a second mechanism.
    mount();
    progress();
    act(() => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    });
    expect(cancelCalculation).toHaveBeenCalledTimes(1);
  });

  it("ignores Esc when nothing is calculating", () => {
    mount();
    act(() => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    });
    expect(cancelCalculation).not.toHaveBeenCalled();
  });
});

describe("the stale marker after a cancel", () => {
  it("replaces the progress chrome with Excel's 'Calculate' and a count", () => {
    // THE point of recording the pending set. A cell holding a pre-pass value
    // looks exactly like a correct one, so "cancelled" on its own is not a
    // usable message — the user has to be told how much is stale.
    mount();
    progress();
    act(() => {
      vi.advanceTimersByTime(PROGRESS_VISIBLE_AFTER_MS);
    });
    progress({ done: true, cancelled: true, pendingCells: 4_218, cellsDone: 5_782 });

    expect(container.querySelector("[data-testid='calc-progress']")).toBeNull();
    const stale = container.querySelector("[data-testid='calc-stale']");
    expect(stale).not.toBeNull();
    expect(stale?.textContent).toBe(`Calculate (${grouped(4_218)})`);
    expect(stale?.getAttribute("title")).toContain("before the cancelled recalculation");

    // ...and the rest of the app is told, so a script that just awaited
    // calculateNow can tell "finished" from "stopped part way".
    expect(emitAppEvent).toHaveBeenCalledWith("app:recalc-incomplete", {
      sheetIndex: -1,
      cellCount: 4_218,
    });
  });

  it("shows nothing after a pass that COMPLETED", () => {
    mount();
    progress();
    progress({ done: true, cancelled: false, pendingCells: 0, cellsDone: 10_000 });
    expect(container.querySelector("[data-testid='calc-stale']")).toBeNull();
    expect(container.textContent).toBe("");
  });

  it("reports staleness left over from a previous session on mount", async () => {
    getPendingRecalc.mockResolvedValue({
      sheetIndex: 0,
      cells: [
        { row: 1, col: 0 },
        { row: 2, col: 0 },
      ],
    });
    mount();
    await act(async () => {
      await Promise.resolve();
    });
    expect(container.querySelector("[data-testid='calc-stale']")?.textContent).toBe(
      "Calculate (2)"
    );
  });
});
