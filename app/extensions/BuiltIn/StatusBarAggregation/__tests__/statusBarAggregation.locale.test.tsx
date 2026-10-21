//! FILENAME: app/extensions/BuiltIn/StatusBarAggregation/__tests__/statusBarAggregation.locale.test.tsx
// PURPOSE: P2 S10 -- the status-bar Sum/Average/Count read in the APP locale.
//          They used to go through `toLocaleString()`, i.e. the WebView's own
//          locale, so a de-DE app on an English Windows showed "1,235.5" while
//          the cells it summed read "1.234,5".
// CONTEXT: The locales come from the shared Rust <-> TS corpus (the Charts
//          appLocaleTestKit), so these are the separators the backend sends.

import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { describe, it, expect, afterEach, vi } from "vitest";

vi.mock("../useSelectionAggregation", () => ({
  useSelectionAggregation: () => ({
    sum: 1235.5,
    average: 617.75,
    count: 2,
    numericalCount: 2,
    min: 1,
    max: 1234.5,
  }),
}));

vi.mock("../useAggregationPreferences", () => ({
  useAggregationPreferences: () => ({
    visibleKeys: new Set(["sum", "average", "count"]),
    toggleKey: () => {},
  }),
}));

import { StatusBarAggregationWidget, formatAggregationValue } from "../StatusBarAggregationWidget";
import { useAppLocale, useInvariantLocale } from "../../../Charts/lib/__tests__/appLocaleTestKit";

let root: Root | null = null;
let container: HTMLDivElement | null = null;

afterEach(async () => {
  if (root) act(() => root!.unmount());
  container?.remove();
  root = null;
  container = null;
  await useInvariantLocale();
});

describe("formatAggregationValue in the app locale", () => {
  it("de-DE: 1235.5 reads 1.235,5", async () => {
    await useAppLocale("de-DE");
    expect(formatAggregationValue(1235.5)).toBe("1.235,5");
    expect(formatAggregationValue(1234567)).toBe("1.234.567");
    expect(formatAggregationValue(0.125)).toBe("0,13"); // half away from zero, 2 decimals max
  });

  it("sv-SE groups with the no-break space", async () => {
    await useAppLocale("sv-SE");
    expect(formatAggregationValue(1235.5)).toBe("1 235,5");
  });

  it("en-US keeps today's text", async () => {
    await useAppLocale("en-US");
    expect(formatAggregationValue(1235.5)).toBe("1,235.5");
    expect(formatAggregationValue(-0.004)).toBe("0");
  });
});

describe("StatusBarAggregationWidget", () => {
  it("shows the de-DE Sum and follows a live switch to en-US", async () => {
    await useAppLocale("de-DE");
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    act(() => root!.render(<StatusBarAggregationWidget />));
    expect(container.textContent).toContain("Sum: 1.235,5");
    expect(container.textContent).toContain("Average: 617,75");

    await act(async () => {
      await useAppLocale("en-US");
    });
    expect(container.textContent).toContain("Sum: 1,235.5");
  });
});
