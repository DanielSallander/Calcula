//! FILENAME: app/extensions/FillSeries/__tests__/seriesDialog.test.tsx
// PURPOSE: The Series dialog collects Excel's options, validates the numbers
//          typed into it, enables only what applies (Date unit for Date; Trend
//          for Linear and Growth; no step or stop for AutoFill), and stays open
//          with the reason when the series is refused.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";

const h = vi.hoisted(() => ({
  runs: [] as unknown[],
  answer: null as string | null,
}));
vi.mock("../lib/runSeries", () => ({
  runSeries: async (opts: unknown) => {
    h.runs.push(opts);
    return h.answer;
  },
}));

import { SeriesDialog } from "../components/SeriesDialog";

Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

let container: HTMLDivElement;
let root: Root;
const onClose = vi.fn();

const q = <T extends HTMLElement>(id: string): T => {
  const el = container.querySelector(`[data-testid='${id}']`);
  if (!el) throw new Error(`no ${id}`);
  return el as T;
};

async function click(id: string): Promise<void> {
  await act(async () => {
    q(id).click();
    for (let i = 0; i < 5; i++) await Promise.resolve();
  });
}

async function type(id: string, value: string): Promise<void> {
  const input = q<HTMLInputElement>(id);
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
    setter.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

beforeEach(async () => {
  h.runs = [];
  h.answer = null;
  onClose.mockClear();
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root.render(<SeriesDialog isOpen={true} onClose={onClose} data={{ seriesIn: "rows" }} />);
  });
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe("Series dialog", () => {
  it("starts on the direction it was opened with, Linear, step 1, no stop", async () => {
    expect(q<HTMLInputElement>("series-in-rows").checked).toBe(true);
    expect(q<HTMLInputElement>("series-type-linear").checked).toBe(true);
    expect(q<HTMLInputElement>("series-step").value).toBe("1");
    expect(q<HTMLInputElement>("series-stop").value).toBe("");
    // Date unit only for Date.
    expect(q<HTMLInputElement>("series-unit-month").disabled).toBe(true);
    await click("series-type-date");
    expect(q<HTMLInputElement>("series-unit-month").disabled).toBe(false);
    // Trend only for Linear and Growth.
    expect(q<HTMLInputElement>("series-trend").disabled).toBe(true);
  });

  it("OK runs the series with what was chosen and closes", async () => {
    await click("series-in-columns");
    await click("series-type-date");
    await click("series-unit-month");
    await type("series-step", "2");
    await type("series-stop", "46100");
    await click("series-ok");
    expect(h.runs).toEqual([
      { seriesIn: "columns", type: "date", dateUnit: "month", step: 2, stop: 46100, trend: false },
    ]);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("a step that is not a number is refused in the dialog, which stays open", async () => {
    await type("series-step", "abc");
    await click("series-ok");
    expect(h.runs).toEqual([]);
    expect(q("series-error").textContent).toMatch(/Step value/);
    expect(onClose).not.toHaveBeenCalled();
  });

  it("a refused series keeps the dialog open with the reason", async () => {
    h.answer = "Cell B2 is protected";
    await click("series-ok");
    expect(q("series-error").textContent).toBe("Cell B2 is protected");
    expect(onClose).not.toHaveBeenCalled();
  });

  it("AutoFill takes no step and no stop; Trend sends no step either", async () => {
    await click("series-type-autofill");
    expect(q<HTMLInputElement>("series-step").disabled).toBe(true);
    expect(q<HTMLInputElement>("series-stop").disabled).toBe(true);
    await click("series-type-linear");
    await click("series-trend");
    expect(q<HTMLInputElement>("series-step").disabled).toBe(true);
    await click("series-ok");
    expect(h.runs).toEqual([{ seriesIn: "rows", type: "linear", dateUnit: "day", step: 1, stop: null, trend: true }]);
  });
});
