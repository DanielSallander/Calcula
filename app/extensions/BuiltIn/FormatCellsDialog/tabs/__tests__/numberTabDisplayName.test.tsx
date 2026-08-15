//! FILENAME: app/extensions/BuiltIn/FormatCellsDialog/tabs/__tests__/numberTabDisplayName.test.tsx
// PURPOSE: BUG-0065 frontend pin — the Number tab must recognize the backend
//          DISPLAY NAMES get_style emits, selecting the owning category and
//          lighting the matching preset when the dialog reopens on a
//          formatted cell.
// CONTEXT: get_style returns "Number (2 decimals, with separators)" /
//          "Date (yyyy-mm-dd)", not preset values ("number_sep"/"date_iso").
//          findCurrentCategory compared them against preset values and ran at
//          MOUNT, before FormatCellsDialog's async loadCurrentStyle landed —
//          so a formatted cell always reopened on General with nothing
//          highlighted, and (the Rust half, pinned in commands/styles.rs) an
//          untouched OK corrupted the format outright: measured live
//          2026-08-14, "-500,00" reverted to "-500" and a date cell rendered
//          "15ate (2023-03-15)".

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";

vi.mock("@api", () => ({
  previewNumberFormat: vi.fn(async () => ({ display: "Sample" })),
  getCachedLocale: () => null,
  getLocaleSettings: async () => {
    throw new Error("no locale in this test");
  },
  // REJECTS on purpose. The regional rows are an enhancement, never a
  // requirement: a backend that cannot answer must cost those rows and nothing
  // else, and every BUG-0065 expectation below must still hold.
  getRibbonNumberFormats: async () => {
    throw new Error("no ribbon formats in this test");
  },
  onLocaleChanged: () => () => {},
}));

import { NumberTab } from "../NumberTab";
import { useFormatCellsStore } from "../../hooks/useFormatCellsState";
import {
  normalizeToPresetValue,
  categoryForFormat,
} from "../../utils/numberFormats";

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  useFormatCellsStore.setState({ numberFormat: "General" });
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

describe("normalizeToPresetValue / categoryForFormat (BUG-0065)", () => {
  it("maps every backend display name with a preset equivalent", () => {
    expect(normalizeToPresetValue("Number (2 decimals, with separators)")).toBe("number_sep");
    expect(normalizeToPresetValue("Number (2 decimals)")).toBe("number");
    expect(normalizeToPresetValue("Currency ($, 2 decimals)")).toBe("currency_usd");
    expect(normalizeToPresetValue("Accounting (kr, 2 decimals)")).toBe("accounting_sek");
    expect(normalizeToPresetValue("Percentage (2 decimals)")).toBe("percentage");
    expect(normalizeToPresetValue("Date (yyyy-mm-dd)")).toBe("date_iso");
    expect(normalizeToPresetValue("Time (hh:mm:ss AM/PM)")).toBe("time_12h");
    expect(normalizeToPresetValue("Fraction (/8 fixed)")).toBe("fraction_eighths");
  });

  it("keeps preset values as themselves (case-insensitively)", () => {
    expect(normalizeToPresetValue("number_sep")).toBe("number_sep");
    expect(normalizeToPresetValue("General")).toBe("general");
  });

  it("returns null for custom strings and unmatched shapes", () => {
    expect(normalizeToPresetValue("#,##0.00")).toBeNull();
    expect(normalizeToPresetValue("Number (5 decimals)")).toBeNull();
    expect(normalizeToPresetValue("")).toBeNull();
  });

  it("categorizes display names, including no-preset shapes by prefix", () => {
    expect(categoryForFormat("Number (2 decimals, with separators)")).toBe("number");
    expect(categoryForFormat("Number (5 decimals)")).toBe("number"); // ribbon increase-decimal result
    expect(categoryForFormat("Date (yyyy-mm-dd)")).toBe("date");
    expect(categoryForFormat("Percentage (0 decimals)")).toBe("percentage");
    expect(categoryForFormat("General")).toBe("general");
    expect(categoryForFormat("")).toBe("general");
    expect(categoryForFormat("#,##0.00;[Red]-#,##0.00")).toBe("custom");
  });
});

describe("NumberTab reopened on a formatted cell (BUG-0065)", () => {
  it("selects the owning category and lights the preset for a loaded display name", async () => {
    await render();
    // The dialog's loadCurrentStyle lands AFTER mount — simulate exactly that.
    await act(async () => {
      useFormatCellsStore.setState({ numberFormat: "Number (2 decimals, with separators)" });
    });
    const text = container.textContent ?? "";
    // The Number category's description proves the category switched.
    expect(text).toContain("Number formats are used for general display of numbers");
    // The preview echoes the matched preset's example — only a lit match does.
    expect(text).toContain("1,234.00");
  });

  it("selects the Date category for a loaded date display name", async () => {
    await render();
    await act(async () => {
      useFormatCellsStore.setState({ numberFormat: "Date (yyyy-mm-dd)" });
    });
    const text = container.textContent ?? "";
    expect(text).toContain("Date formats display date and time serial numbers");
    expect(text).toContain("2024-01-15 (ISO)");
  });

  it("lands custom formats in the Custom category with the input prefilled", async () => {
    await render();
    await act(async () => {
      useFormatCellsStore.setState({ numberFormat: "#,##0.00;[Red]-#,##0.00" });
    });
    const input = container.querySelector("input") as HTMLInputElement;
    expect(input).not.toBeNull();
    expect(input.value).toBe("#,##0.00;[Red]-#,##0.00");
  });
});
