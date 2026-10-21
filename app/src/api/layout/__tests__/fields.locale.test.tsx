//! FILENAME: app/src/api/layout/__tests__/fields.locale.test.tsx
// PURPOSE: NumberField reads and shows numbers in the APP locale (P2 S9): under
//          de-DE "1,5" commits 1.5 and "1.234,5" commits 1234.5, the foreign
//          spelling "1.5" is refused rather than misread, the committed value
//          is shown with the locale's comma, and ArrowUp/ArrowDown still step.
// CONTEXT: The locales come from THE shared Rust <-> TS corpus
//          (core/engine/tests/fixtures/locale_text_corpus.json), so "de-DE"
//          here is exactly what the backend would install.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "fs";
import path from "path";
import React from "react";
import { NumberField, formatNumberFieldValue, parseNumberFieldText } from "../primitives/fields";
import { formatSliderValue } from "../primitives/Slider";
import { normalizeLocaleSettings, resetActiveLocaleForTests, setActiveLocale } from "../../../core/lib/locale";
import type { LocaleSettings } from "../../../core/lib/locale";
import { blur, fire, mount, q, typeValue, type Mount } from "./formControlsKit";

const CORPUS = JSON.parse(
  fs.readFileSync(path.resolve(__dirname, "../../../../../core/engine/tests/fixtures/locale_text_corpus.json"), "utf8"),
) as { locales: Record<string, LocaleSettings> };

function useLocale(id: string): void {
  setActiveLocale(normalizeLocaleSettings(CORPUS.locales[id]));
}

let m: Mount;

beforeEach(() => {
  m = mount();
  useLocale("de-DE");
});

afterEach(() => {
  m.unmount();
  resetActiveLocaleForTests();
});

function Controlled(props: { initial: number | null; onChange: (v: number | null) => void; step?: number }) {
  const [value, setValue] = React.useState<number | null>(props.initial);
  return (
    <NumberField
      testId="n"
      ariaLabel="Value"
      value={value}
      step={props.step}
      onChange={(v) => {
        props.onChange(v);
        setValue(v);
      }}
    />
  );
}

function input(): HTMLInputElement {
  return q<HTMLInputElement>(m.container, "[data-testid='n']");
}

describe("NumberField in the de-DE app locale", () => {
  it('"1,5" commits 1.5', () => {
    const onChange = vi.fn();
    m.render(<Controlled initial={null} onChange={onChange} />);
    typeValue(input(), "1,5");
    expect(onChange).toHaveBeenLastCalledWith(1.5);
  });

  it('"1.234,5" commits 1234.5', () => {
    const onChange = vi.fn();
    m.render(<Controlled initial={null} onChange={onChange} />);
    typeValue(input(), "1.234,5");
    expect(onChange).toHaveBeenLastCalledWith(1234.5);
  });

  it('the foreign spelling "1.5" is refused, never read as 15 or 1.5', () => {
    expect(parseNumberFieldText("1.5")).toBeUndefined();
    const onChange = vi.fn();
    m.render(<Controlled initial={7} onChange={onChange} />);
    typeValue(input(), "1.5");
    expect(onChange).not.toHaveBeenCalled();
    // Leaving the box drops the refused text and shows the committed value.
    blur(input());
    expect(input().value).toBe("7");
  });

  it("shows the committed value with the locale's decimal comma and no grouping", () => {
    m.render(<Controlled initial={1234.5} onChange={() => {}} />);
    expect(input().value).toBe("1234,5");
    expect(formatNumberFieldValue(0.1 + 0.2)).toBe("0,3");
    // What the box shows reads back to the same number.
    expect(parseNumberFieldText(formatNumberFieldValue(1234567.125))).toBe(1234567.125);
  });

  it("ArrowUp steps from the typed value and shows the result in the locale", () => {
    const onChange = vi.fn();
    m.render(<Controlled initial={null} step={0.5} onChange={onChange} />);
    typeValue(input(), "1,5");
    fire(input(), "keydown", { key: "ArrowUp" });
    expect(onChange).toHaveBeenLastCalledWith(2);
    fire(input(), "keydown", { key: "ArrowUp" });
    expect(onChange).toHaveBeenLastCalledWith(2.5);
    expect(input().value).toBe("2,5");
    fire(input(), "keydown", { key: "ArrowDown" });
    expect(onChange).toHaveBeenLastCalledWith(2);
  });

  it("the Slider readout reads in the app locale", () => {
    expect(formatSliderValue(1.5, 0.1)).toBe("1,5");
    expect(formatSliderValue(0.5, 0.05, "%")).toBe("0,50 %");
    expect(formatSliderValue(150, 1, "%")).toBe("150 %");
  });
});
