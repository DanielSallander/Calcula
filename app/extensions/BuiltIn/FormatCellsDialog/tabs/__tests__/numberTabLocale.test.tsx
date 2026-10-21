//! FILENAME: app/extensions/BuiltIn/FormatCellsDialog/tabs/__tests__/numberTabLocale.test.tsx
// PURPOSE: BUG-0064 pin — the Number tab's preset labels/examples must carry
//          the CURRENT locale's separators, not the static US defaults.
// CONTEXT: getNumberFormatCategories(dec, thou) was locale-aware and unit-
//          tested with locale args, yet the tab's only production path used the
//          US-default NUMBER_FORMAT_CATEGORIES constant. On a sv-SE document
//          the dialog advertised "1,234.00" while clicking that preset rendered
//          "1 234,00" in the cell — the sample text lied about the result
//          (measured live on CDP 9222, 2026-08-14). Excel's samples are
//          locale-correct. Pinned in BOTH directions: sv-SE separators appear
//          when the locale says so, and a locale change re-renders the labels.
//          Since P2 the tab reads the APP locale synchronously (getAppLocale,
//          installed before the first render); it never awaits a locale.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";

// ---- @api stub --------------------------------------------------------------
// The barrel reaches every extension; stub only what NumberTab touches.
type Locale = {
  decimalSeparator: string;
  thousandsSeparator: string;
};

const US = { decimalSeparator: ".", thousandsSeparator: "," };

const mockState: {
  app: Locale;
  asyncReads: number;
  localeListeners: Array<(loc: Locale) => void>;
} = { app: US, asyncReads: 0, localeListeners: [] };

vi.mock("@api", () => ({
  previewNumberFormat: vi.fn(async () => ({ display: "Sample" })),
  getAppLocale: () => mockState.app,
  // Present only to prove the tab never awaits the locale any more.
  getLocaleSettings: async () => {
    mockState.asyncReads++;
    return mockState.app;
  },
  // The regional rows are resolved by the backend. This suite is about the
  // locale-driven LABELS, so the ribbon response is empty here -- which also
  // pins that an empty response leaves those labels exactly as they were.
  getRibbonNumberFormats: async () => [],
  onLocaleChanged: (cb: (loc: Locale) => void) => {
    mockState.localeListeners.push(cb);
    return () => {
      mockState.localeListeners = mockState.localeListeners.filter((c) => c !== cb);
    };
  },
}));

import { NumberTab } from "../NumberTab";
import { useFormatCellsStore } from "../../hooks/useFormatCellsState";

const SV = { decimalSeparator: ",", thousandsSeparator: " " };

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  mockState.app = US;
  mockState.asyncReads = 0;
  mockState.localeListeners = [];
  // Land on the Number category so both presets (number, number_sep) render.
  useFormatCellsStore.setState({ numberFormat: "number_sep" });
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

async function render(): Promise<void> {
  await act(async () => {
    root.render(React.createElement(NumberTab));
  });
  await act(async () => {
    await Promise.resolve();
  });
}

describe("NumberTab locale-aware preset labels (BUG-0064)", () => {
  it("renders sv-SE separators when the app locale says so", async () => {
    mockState.app = SV;
    await render();
    const text = container.textContent ?? "";
    expect(text).toContain("1 234,00"); // the number_sep preset, sv-SE face
    expect(text).not.toContain("1,234.00"); // the pre-fix US face must be gone
  });

  it("renders US separators for a US locale (the same path, other direction)", async () => {
    mockState.app = US;
    await render();
    const text = container.textContent ?? "";
    expect(text).toContain("1,234.00");
    expect(text).not.toContain("1 234,00");
  });

  it("reads the app locale synchronously on the first render and never awaits one", async () => {
    mockState.app = SV;
    await act(async () => {
      root.render(React.createElement(NumberTab));
    });
    expect(container.textContent ?? "").toContain("1 234,00");
    expect(mockState.asyncReads).toBe(0);
  });

  it("re-renders the labels when the locale changes while open", async () => {
    mockState.app = US;
    await render();
    expect(container.textContent).toContain("1,234.00");
    await act(async () => {
      for (const cb of [...mockState.localeListeners]) cb(SV);
    });
    const text = container.textContent ?? "";
    expect(text).toContain("1 234,00");
    expect(text).not.toContain("1,234.00");
  });

  it("shows the US defaults while the app locale is the invariant one", async () => {
    mockState.app = US; // getAppLocale() before the backend answered
    await render();
    expect(container.textContent).toContain("1,234.00");
  });
});
