//! FILENAME: app/extensions/ControlsPane/__tests__/sliderControl.locale.test.tsx
// PURPOSE: A Controls-pane slider shows its value in the APP locale and still
//          commits the right number (P2 S9). Under de-DE the value label reads
//          "1,5"; the range's own position ("1.5" on the wire in every locale)
//          is read as a number, never through a text parser that would refuse
//          or misread it.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";

const mocks = vi.hoisted(() => ({
  commitValue: vi.fn(async () => undefined),
  previewValue: vi.fn(),
  setChartParamValue: vi.fn(),
}));

vi.mock("../lib/controlsPaneStore", () => ({
  commitValue: mocks.commitValue,
  previewValue: mocks.previewValue,
}));
vi.mock("@api/chartParams", () => ({ setChartParamValue: mocks.setChartParamValue }));

import { useAppLocale, useInvariantLocale } from "../../Charts/lib/__tests__/appLocaleTestKit";
import { SliderControl, formatSliderControlValue } from "../components/SliderControl";
import type { PaneControl } from "../lib/controlsPaneTypes";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const SLIDER = {
  id: "s1",
  name: "Rate",
  config: { type: "slider", min: 0, max: 10, step: 0.5, showValue: true },
  value: { kind: "number", value: 1.5 },
} as unknown as PaneControl;

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  mocks.commitValue.mockClear();
  mocks.previewValue.mockClear();
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  act(() => root.unmount());
  container.remove();
  await useInvariantLocale();
});

function typeRange(el: HTMLInputElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
  act(() => {
    setter.call(el, value);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

describe("SliderControl in the app locale", () => {
  it('de-DE: the value label reads "1,5"', async () => {
    await useAppLocale("de-DE");
    act(() => root.render(<SliderControl control={SLIDER} />));
    expect(container.querySelector("output")?.textContent).toBe("1,5");
    const range = container.querySelector<HTMLInputElement>('input[type="range"]')!;
    expect(range.title).toBe("Rate: 1,5");
  });

  it("de-DE: a release commits the range's NUMBER (2.5), not a parse of its wire text", async () => {
    await useAppLocale("de-DE");
    act(() => root.render(<SliderControl control={SLIDER} />));
    const range = container.querySelector<HTMLInputElement>('input[type="range"]')!;
    act(() => {
      range.dispatchEvent(new Event("pointerdown", { bubbles: true }));
    });
    typeRange(range, "2.5");
    act(() => {
      range.dispatchEvent(new Event("pointerup", { bubbles: true }));
    });
    expect(mocks.commitValue).toHaveBeenCalledTimes(1);
    expect(mocks.commitValue).toHaveBeenCalledWith("s1", { kind: "number", value: 2.5 });
    expect(container.querySelector("output")?.textContent).toBe("2,5");
  });

  it("the title value follows the step's precision in the locale", async () => {
    await useAppLocale("sv-SE");
    expect(formatSliderControlValue(0.1 + 0.2, 0.1)).toBe("0,3");
    expect(formatSliderControlValue(1234, 1)).toBe("1234");
    await useAppLocale("en-US");
    expect(formatSliderControlValue(1.5, 0.25)).toBe("1.50");
  });
});
