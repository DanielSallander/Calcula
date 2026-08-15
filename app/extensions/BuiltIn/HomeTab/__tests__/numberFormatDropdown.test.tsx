//! FILENAME: app/extensions/BuiltIn/HomeTab/__tests__/numberFormatDropdown.test.tsx
// PURPOSE: The Home > Number dropdown is Excel's dropdown -- Excel's entries,
//          in Excel's order, sending preset KEYWORDS the backend resolves
//          against the locale, and reporting the selected cell's own format.
// CONTEXT: Measured 2026-08-15. The old dropdown carried six entries
//          ("General / Number / Thousands / Percentage / Scientific / Text"),
//          of which "Thousands" is not an Excel entry name at all, and had no
//          Currency, no Accounting, no Short Date, no Long Date, no Time, no
//          Fraction and no "More Number Formats...".
//
//          The sharper half is the read-back. Its option VALUES were format
//          codes ("0.00", "@") while `get_style` reports DISPLAY NAMES
//          ("Number (2 decimals)"), two disjoint vocabularies -- so applying
//          Number and re-reading the cell put the box on a greyed-out,
//          unselectable "Number (2 decimals)" row. The dropdown could not
//          report its own result on ANY entry but General.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";

import {
  CUSTOM_FORMAT_VALUE,
  MORE_NUMBER_FORMATS_VALUE,
  RIBBON_NUMBER_FORMATS,
  selectedPresetFor,
} from "../components/numberFormatOptions";

// --- Mocks ------------------------------------------------------------------

const openDialog = vi.fn();
vi.mock("@api/ui", () => ({
  DialogExtensions: { openDialog: (...args: unknown[]) => openDialog(...args) },
}));

vi.mock("@api/undoState", () => ({
  useUndoAvailability: () => ({ canUndo: false, canRedo: false }),
}));

/**
 * The rows the backend resolves for sv-SE. These are the exact strings
 * `get_ribbon_number_formats` returns on the app's own test locale -- measured
 * live, and pinned in Rust by `swedish_ribbon_presets_render_excel_shapes`.
 */
const SV_SE_ROWS = [
  { preset: "general", displayName: "General", sample: "1234,5678" },
  { preset: "number", displayName: "Number (2 decimals)", sample: "1234,57" },
  { preset: "currency", displayName: "Currency ( kr, 2 decimals)", sample: "1 234,57 kr" },
  { preset: "accounting", displayName: "Accounting (kr, 2 decimals)", sample: "1 234,57  kr" },
  { preset: "date_short", displayName: "Date (YYYY-MM-DD)", sample: "2024-01-15" },
  { preset: "date_long", displayName: 'Date ("den "d mmmm yyyy)', sample: "den 15 januari 2024" },
  { preset: "time", displayName: "Time (hh:mm:ss)", sample: "13:30:00" },
  { preset: "percentage", displayName: "Percentage (2 decimals)", sample: "123456,78%" },
  { preset: "fraction_1", displayName: "Fraction (up to 1 digits)", sample: "1234 4/7" },
  { preset: "scientific", displayName: "Scientific (2 decimals)", sample: "1,23E+03" },
  { preset: "text", displayName: "@", sample: "1234,5678" },
];

const getRibbonNumberFormats = vi.fn(async () => SV_SE_ROWS);
vi.mock("@api/numberFormats", () => ({
  getRibbonNumberFormats: (...args: unknown[]) => getRibbonNumberFormats(...(args as [])),
}));

vi.mock("@api/locale", () => ({
  onLocaleChanged: () => () => {},
}));

const handleNumberFormatChange = vi.fn();
let currentStyle: { numberFormat: string } | null = null;
vi.mock("../components/useHomeTabState", () => ({
  useHomeTabState: () => ({
    currentStyle,
    currentCellData: null,
    handleItemClick: vi.fn(),
    handleColorSelect: vi.fn(),
    handleCellStyleApply: vi.fn(),
    handleFontFamilyChange: vi.fn(),
    handleFontSizeChange: vi.fn(),
    handleNumberFormatChange,
    isActive: () => false,
    getCurrentColor: () => "#000000",
    applyFormat: vi.fn(),
    getItemById: vi.fn(),
  }),
}));

vi.mock("../components/homeTabIcons", () => ({ homeTabIcon: () => null }));
vi.mock("../../../_shared/components/CellStylesGallery", () => ({
  CellStylesGallery: () => null,
}));

import { HomeTabGroupComponent } from "../components/HomeTabGroupComponent";

// --- Harness ----------------------------------------------------------------

let container: HTMLDivElement;
let root: Root;

async function render(): Promise<HTMLSelectElement> {
  await act(async () => {
    root.render(
      React.createElement(HomeTabGroupComponent, {
        context: {} as never,
        itemIds: ["numberFormat"],
      }),
    );
  });
  const select = container.querySelector<HTMLSelectElement>(
    '[data-testid="fmt-numberFormat"]',
  );
  if (!select) throw new Error("number-format dropdown did not render");
  return select;
}

function labels(select: HTMLSelectElement): string[] {
  return Array.from(select.querySelectorAll("option")).map((o) => o.textContent ?? "");
}

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  currentStyle = null;
  handleNumberFormatChange.mockClear();
  openDialog.mockClear();
  getRibbonNumberFormats.mockClear();
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

// --- The list ---------------------------------------------------------------

describe("Home > Number dropdown: Excel's list", () => {
  it("is Excel's eleven entries in Excel's order, then More Number Formats", async () => {
    const select = await render();
    expect(labels(select)).toEqual([
      "General",
      "Number",
      "Currency",
      "Accounting",
      "Short Date",
      "Long Date",
      "Time",
      "Percentage",
      "Fraction",
      "Scientific",
      "Text",
      "More Number Formats...",
    ]);
  });

  it("omits Special and Custom, which are Format Cells categories and not rows", async () => {
    const select = await render();
    expect(labels(select)).not.toContain("Special");
    // "Custom" appears only as the read-back of a format with no entry.
    expect(labels(select)).not.toContain("Custom");
  });

  it("never sends a format code -- only preset keywords the backend resolves", () => {
    // A format code here is a hard-coded region for five of the eleven rows.
    for (const option of RIBBON_NUMBER_FORMATS) {
      expect(option.preset).toMatch(/^[a-z_0-9]+$/);
    }
    expect(RIBBON_NUMBER_FORMATS.map((o) => o.preset)).toEqual([
      "general",
      "number",
      "currency",
      "accounting",
      "date_short",
      "date_long",
      "time",
      "percentage",
      "fraction_1",
      "scientific",
      "text",
    ]);
  });

  it("carries the locale-resolved sample on each row", async () => {
    const select = await render();
    const byValue = new Map(
      Array.from(select.querySelectorAll("option")).map((o) => [o.value, o.title]),
    );
    expect(byValue.get("date_short")).toBe("2024-01-15");
    expect(byValue.get("date_long")).toBe("den 15 januari 2024");
    expect(byValue.get("currency")).toBe("1 234,57 kr");
    expect(byValue.get("scientific")).toBe("1,23E+03");
  });
});

// --- Applying ---------------------------------------------------------------

describe("Home > Number dropdown: applying", () => {
  it("sends the preset keyword, not a format code", async () => {
    const select = await render();
    await act(async () => {
      select.value = "date_long";
      select.dispatchEvent(new Event("change", { bubbles: true }));
    });
    expect(handleNumberFormatChange).toHaveBeenCalledWith("date_long");
  });

  it("opens Format Cells on the Number tab and applies nothing", async () => {
    const select = await render();
    await act(async () => {
      select.value = MORE_NUMBER_FORMATS_VALUE;
      select.dispatchEvent(new Event("change", { bubbles: true }));
    });
    expect(openDialog).toHaveBeenCalledWith("format-cells", { tab: "number" });
    expect(handleNumberFormatChange).not.toHaveBeenCalled();
  });
});

// --- Reading back -----------------------------------------------------------

describe("Home > Number dropdown: reflecting the selected cell", () => {
  it("shows the entry a formatted cell is already on", async () => {
    for (const row of SV_SE_ROWS) {
      currentStyle = { numberFormat: row.displayName };
      const select = await render();
      expect(select.value).toBe(row.preset);
      await act(async () => root.unmount());
      root = createRoot(container);
    }
  });

  it("shows General on a brand-new workbook", async () => {
    currentStyle = { numberFormat: "General" };
    const select = await render();
    expect(select.value).toBe("general");
  });

  it("shows Custom for a format that is not one of the entries, keeping the real format on the tooltip", async () => {
    currentStyle = { numberFormat: "Number (2 decimals, with separators)" };
    const select = await render();
    expect(select.value).toBe(CUSTOM_FORMAT_VALUE);
    const custom = select.querySelector<HTMLOptionElement>(
      `option[value="${CUSTOM_FORMAT_VALUE}"]`,
    );
    expect(custom?.textContent).toBe("Custom");
    expect(custom?.title).toBe("Number (2 decimals, with separators)");
    expect(custom?.disabled).toBe(true);
  });

  it("survives a backend that cannot answer -- rows stay, selection degrades", async () => {
    getRibbonNumberFormats.mockRejectedValueOnce(new Error("no backend"));
    currentStyle = { numberFormat: "General" };
    const select = await render();
    expect(labels(select)).toContain("Long Date");
    expect(select.value).toBe("general");
  });
});

// --- The mapping itself -----------------------------------------------------

describe("selectedPresetFor", () => {
  it("maps every backend display name back to its entry", () => {
    for (const row of SV_SE_ROWS) {
      expect(selectedPresetFor(row.displayName, SV_SE_ROWS)).toBe(row.preset);
    }
  });

  it("does not guess from format codes -- the two vocabularies are disjoint", () => {
    // "0.00" is what the OLD dropdown sent as Number's value. It is not a
    // display name and must not be mistaken for one.
    expect(selectedPresetFor("0.00", SV_SE_ROWS)).toBe(CUSTOM_FORMAT_VALUE);
    expect(selectedPresetFor("#,##0.00", SV_SE_ROWS)).toBe(CUSTOM_FORMAT_VALUE);
  });

  it("resolves General before the first backend response lands, so the box never flickers", () => {
    expect(selectedPresetFor("General", [])).toBe("general");
    expect(selectedPresetFor("Date (YYYY-MM-DD)", [])).toBe(CUSTOM_FORMAT_VALUE);
  });

  it("treats an en-US resolution as en-US, not as sv-SE", () => {
    const US_ROWS = [
      { preset: "date_short", displayName: "Date (MM/DD/YYYY)" },
      { preset: "currency", displayName: "Currency ($, 2 decimals)" },
      { preset: "time", displayName: "Time (h:mm:ss AM/PM)" },
    ];
    expect(selectedPresetFor("Date (MM/DD/YYYY)", US_ROWS)).toBe("date_short");
    // The sv-SE name is NOT an en-US entry: same preset, different region.
    expect(selectedPresetFor("Date (YYYY-MM-DD)", US_ROWS)).toBe(CUSTOM_FORMAT_VALUE);
  });
});
