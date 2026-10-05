//! FILENAME: app/extensions/BuiltIn/FormatCellsDialog/tabs/__tests__/numberTabAccounting.test.tsx
// PURPOSE: The Number tab's Accounting category, as the Home tab's Accounting
//          split button needs it:
//            - the symbols of Excel's Accounting menu are rows here (None, $, £,
//              € before, € after, ¥, CHF) -- the category offered only $, $ 0
//              decimals, "EUR" and kr;
//            - every display name the backend reports for them resolves to its
//              row, INCLUDING the en-US spelling that now ends in
//              ", parenthesised negatives" (the region's accounting negative is
//              frozen into the format; it is not a choice the user made here,
//              so it must not turn the row into a Currency-style composed id);
//            - FORMAT_CELLS { category: "accounting" } ("More Accounting
//              Formats...") opens ON Accounting even when the cell is General,
//              and the cell's format landing after mount does not yank it away.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";

vi.mock("@api", () => ({
  previewNumberFormat: vi.fn(async () => ({ display: "Sample" })),
  getCachedLocale: () => null,
  getLocaleSettings: async () => {
    throw new Error("no locale in this test");
  },
  getRibbonNumberFormats: async () => {
    throw new Error("no ribbon formats in this test");
  },
  onLocaleChanged: () => () => {},
}));

import { NumberTab } from "../NumberTab";
import { useFormatCellsStore } from "../../hooks/useFormatCellsState";
import {
  getNumberFormatCategories,
  normalizeToPresetValue,
  categoryForFormat,
} from "../../utils/numberFormats";

const GBP = "£";
const EUR = "€";
const CNY = "¥";

describe("the Accounting category's symbols", () => {
  it("offers Excel's Accounting menu symbols and None", () => {
    const accounting = getNumberFormatCategories().find((c) => c.id === "accounting")!;
    const values = accounting.formats.map((f) => f.value);
    for (const v of [
      "comma",
      "accounting_usd",
      "accounting_gbp",
      "accounting_eur_before",
      "accounting_eur_after",
      "accounting_cny",
      "accounting_chf",
    ]) {
      expect(values, v).toContain(v);
    }
    const labels = accounting.formats.map((f) => f.label);
    expect(labels).toContain("None");
    expect(labels).toContain(`${GBP} English (United Kingdom)`);
    expect(labels).toContain(`${EUR} Euro (${EUR} 123)`);
    expect(labels).toContain(`${EUR} Euro (123 ${EUR})`);
    expect(labels).toContain(`${CNY} Chinese (PRC)`);
    expect(labels).toContain("CHF French (Switzerland)");
    // The existing rows stay (no backward-compat need, but they are real formats).
    expect(values).toContain("accounting_usd_0");
    expect(values).toContain("accounting_sek");
  });

  it("each symbol's display name resolves to its row (sv-SE spelling)", () => {
    expect(normalizeToPresetValue("Accounting (, 2 decimals)")).toBe("comma");
    expect(normalizeToPresetValue(`Accounting (${GBP}, 2 decimals)`)).toBe("accounting_gbp");
    expect(normalizeToPresetValue(`Accounting (${EUR}, 2 decimals)`)).toBe("accounting_eur_before");
    expect(normalizeToPresetValue(`Accounting (${EUR}, 2 decimals, symbol after)`)).toBe("accounting_eur_after");
    expect(normalizeToPresetValue(`Accounting (${CNY}, 2 decimals)`)).toBe("accounting_cny");
    expect(normalizeToPresetValue("Accounting (CHF, 2 decimals)")).toBe("accounting_chf");
  });

  it("the en-US spelling (', parenthesised negatives') resolves to the SAME row", () => {
    expect(normalizeToPresetValue("Accounting ($, 2 decimals, parenthesised negatives)")).toBe("accounting_usd");
    expect(normalizeToPresetValue(`Accounting (${GBP}, 2 decimals, parenthesised negatives)`)).toBe("accounting_gbp");
    expect(normalizeToPresetValue("Accounting (, 2 decimals, parenthesised negatives)")).toBe("comma");
    expect(
      normalizeToPresetValue(`Accounting (${EUR}, 2 decimals, symbol after, parenthesised negatives)`),
    ).toBe("accounting_eur_after");
    expect(categoryForFormat("Accounting ($, 2 decimals, parenthesised negatives)")).toBe("accounting");
  });

  it("a CURRENCY keeps its composed negative choice (unchanged)", () => {
    expect(normalizeToPresetValue("Currency ($, 2 decimals, parenthesised negatives)")).toBe("currency_usd_neg_paren");
  });
});

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  useFormatCellsStore.getState().reset();
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

function rowByLabel(label: string): HTMLElement {
  const el = Array.from(container.querySelectorAll("span")).find((s) => s.textContent === label);
  if (!el) throw new Error(`no row labelled ${label}`);
  return el.parentElement as HTMLElement;
}

const ACCOUNTING_DESCRIPTION = "Accounting formats line up the currency symbols";

describe("FORMAT_CELLS { category } opens the Number tab ON that category", () => {
  it("a General cell opens on Accounting when Accounting was asked for", async () => {
    await render();
    // The dialog records the request in its mount effect, after the tab's
    // first render; then the cell's own format lands.
    await act(async () => useFormatCellsStore.getState().setNumberCategory("accounting"));
    await act(async () => useFormatCellsStore.setState({ numberFormat: "general" }));
    expect(container.textContent).toContain(ACCOUNTING_DESCRIPTION);
  });

  it("without a request the cell's own category wins, as before", async () => {
    await render();
    await act(async () => useFormatCellsStore.setState({ numberFormat: "general" }));
    expect(container.textContent).not.toContain(ACCOUNTING_DESCRIPTION);
  });

  it("choosing a row applies that symbol", async () => {
    await render();
    await act(async () => useFormatCellsStore.getState().setNumberCategory("accounting"));
    await act(async () => {
      rowByLabel(`${GBP} English (United Kingdom)`).dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(useFormatCellsStore.getState().numberFormat).toBe("accounting_gbp");
    // ...and the category stays where the user is.
    expect(container.textContent).toContain(ACCOUNTING_DESCRIPTION);
  });

  it("an en-US accounting cell lights its row instead of nothing", async () => {
    await render();
    await act(async () =>
      useFormatCellsStore.setState({ numberFormat: "Accounting ($, 2 decimals, parenthesised negatives)" }),
    );
    expect(container.textContent).toContain(ACCOUNTING_DESCRIPTION);
    // The preview echoes the LIT row's example; nothing lit shows "Sample".
    const previews = Array.from(container.querySelectorAll("div")).map((d) => d.textContent);
    expect(previews.some((t) => t === "$ 1,234.00")).toBe(true);
  });
});
