//! FILENAME: app/extensions/ControlsPane/components/__tests__/filterDropdownConditions.test.tsx
// PURPOSE: The ribbon filter's checklist speaks MEMBERS (P2 S7):
//          - an advanced condition compares NUMBERS on the member KEY (read
//            invariantly) against the user's text read in the APP locale, DATES
//            on the key's ISO date against the text read as an app-locale date,
//            and TEXT on the label -- never a string comparison of display
//            text, never parseFloat of a localised spelling;
//          - a selection SENDS the member key (never the label it shows), and
//            each item's `data-value` -- the journeys' oracle -- is the key.
// CONTEXT: The active app locale is installed the way the app installs it
//          (`setLocale`, its `set_locale` answered by a mocked Tauri IPC with
//          THE shared Rust <-> TS corpus settings), so the real `parseNumber` /
//          `parseDate` of @api/locale run. The rest of the dropdown's world is
//          doubled as in filterDropdownOverwrite.test.tsx.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import fs from "fs";
import path from "path";
import { mockIPC, clearMocks } from "@tauri-apps/api/mocks";
import { SurfaceLayoutProvider, bandLayout } from "@api/layout";
import { setLocale, INVARIANT_LOCALE, type LocaleSettings } from "@api/locale";

vi.mock("@api", () => ({
  emitAppEvent: vi.fn(),
  AppEvents: { GRID_REFRESH: "app:grid-refresh" },
  getSheets: async () => ({ sheets: [{ index: 0, name: "Report" }] }),
}));
vi.mock("@api/pivotNotices", () => ({ surfacePivotNotices: vi.fn() }));
vi.mock("@api/notifications", () => ({ showToast: vi.fn() }));
vi.mock("../../lib/filterPaneBackend", () => ({
  filterPaneBackend: { invoke: () => Promise.resolve(undefined) },
}));
vi.mock("../../lib/filterPaneStore", () => ({
  updateFilterAsync: vi.fn(async () => undefined),
  updateFilterSelectionAsync: vi.fn(),
  getAllFilters: () => [],
  getConnectionName: () => "Sales model",
  getFilterItemsError: () => null,
  getFilterNarrowingError: () => null,
  getFilterLoadAttempts: () => 0,
}));
vi.mock("../../lib/filterPaneApi", () => ({
  getAllSlicers: async () => [],
  getPivotsForBiConnection: async () => [],
}));

import { FilterDropdown, evalCondition } from "../FilterDropdown";
import type { SlicerItem } from "../../lib/filterPaneTypes";

const CORPUS = path.resolve(__dirname, "../../../../../core/engine/tests/fixtures/locale_text_corpus.json");

async function useAppLocale(settings: LocaleSettings): Promise<void> {
  mockIPC((cmd) => {
    if (cmd === "set_locale") return settings;
    throw new Error(`unexpected IPC ${cmd}`);
  });
  try {
    await setLocale(settings.localeId);
  } finally {
    clearMocks();
  }
}

function corpusLocale(id: string): LocaleSettings {
  const raw = JSON.parse(fs.readFileSync(CORPUS, "utf8")) as { locales: Record<string, LocaleSettings> };
  const l = raw.locales[id];
  if (!l) throw new Error(`the corpus has no ${id}`);
  return l;
}

const item = (key: string, label: string): SlicerItem => ({ key, label, selected: true, hasData: true });

afterEach(async () => {
  await useAppLocale({ ...INVARIANT_LOCALE });
});

describe("evalCondition under a de-DE app locale", () => {
  beforeEach(async () => {
    await useAppLocale(corpusLocale("de-DE"));
  });

  const big = item("3578.27", "3578,27");
  const small = item("1234.5", "1234,5");

  it('isGreaterThan "3.000,5" keeps key 3578.27 and drops 1234.5 (key invariant, target in the app locale)', () => {
    expect(evalCondition(big, "isGreaterThan", "3.000,5")).toBe(true);
    expect(evalCondition(small, "isGreaterThan", "3.000,5")).toBe(false);
    expect(evalCondition(small, "isLessThanOrEqualTo", "1.234,5")).toBe(true);
    expect(evalCondition(small, "isLessThan", "1.234,5")).toBe(false);
    expect(evalCondition(big, "isGreaterThanOrEqualTo", "3578,27")).toBe(true);
  });

  it("a target that is not a number in THIS locale fails the condition (never guessed)", () => {
    // "3.000.5" is no de-DE number; parseFloat would have read 3.
    expect(evalCondition(big, "isGreaterThan", "3.000.5")).toBe(false);
    expect(evalCondition(big, "isLessThan", "abc")).toBe(false);
    // A key that is not a number fails too (text, the blank member).
    expect(evalCondition(item("North", "North"), "isGreaterThan", "0")).toBe(false);
    expect(evalCondition(item("", "(Blank)"), "isLessThan", "1")).toBe(false);
  });

  it('isAfter "01.02.2024" keeps key 2024-03-01 (an ISO key against an app-locale date)', () => {
    const march = item("2024-03-01", "01.03.2024");
    const january = item("2024-01-15", "15.01.2024");
    expect(evalCondition(march, "isAfter", "01.02.2024")).toBe(true);
    expect(evalCondition(january, "isAfter", "01.02.2024")).toBe(false);
    expect(evalCondition(january, "isBefore", "01.02.2024")).toBe(true);
    expect(evalCondition(january, "isOnOrBefore", "15.01.2024")).toBe(true);
    expect(evalCondition(january, "isOnOrAfter", "15.01.2024")).toBe(true);
    // A date the app locale cannot read ("2024/31/12") fails the condition.
    expect(evalCondition(march, "isAfter", "2024/31/12")).toBe(false);
  });

  it('a text contains "Rot" matches the LABEL', () => {
    const red = item("red", "Rot");
    expect(evalCondition(red, "contains", "rot")).toBe(true);
    expect(evalCondition(red, "is", "Rot")).toBe(true);
    expect(evalCondition(red, "startsWith", "red")).toBe(false);
  });

  it("blank / empty read the KEY: the blank member is key \"\" while it reads (Blank)", () => {
    const blank = item("", "(Blank)");
    expect(evalCondition(blank, "isBlank", "")).toBe(true);
    expect(evalCondition(blank, "isEmpty", "")).toBe(true);
    expect(evalCondition(item("North", "North"), "isBlank", "")).toBe(false);
    expect(evalCondition(item("North", "North"), "isNotEmpty", "")).toBe(true);
  });
});

describe("a selection sends the KEY; data-value is the key", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    document.body.innerHTML = "";
  });

  function render(onApply: (selected: string[] | null) => void): void {
    const anchor = document.createElement("div");
    document.body.appendChild(anchor);
    act(() => {
      root.render(
        <SurfaceLayoutProvider value={bandLayout()}>
          <FilterDropdown
            filterId="f1"
            fieldName="Sales.Date"
            items={[item("2024-01-15", "15.01.2024"), item("2024-02-01", "01.02.2024"), item("", "(Blank)")]}
            fieldLabel="Sales.Date"
            itemsError={null}
            narrowingError={null}
            onRetry={() => undefined}
            selectedItems={null}
            anchorEl={anchor}
            onApply={onApply}
            onClose={() => undefined}
            onDelete={() => undefined}
            connectionId="c1"
            connectionMode="manual"
            dependentFilters={[]}
            dependentSlicers={[]}
            advancedFilter={null}
            fieldDataType="date"
            connectedPivots={[]}
            connectedSheets={[]}
            hideNoData={false}
            indicateNoData={true}
            sortNoDataLast={true}
            showSelectAll={false}
            singleSelect={false}
            filterLevel={1}
          />
        </SurfaceLayoutProvider>,
      );
    });
  }

  function rows(): HTMLElement[] {
    return Array.from(document.querySelectorAll<HTMLElement>('[data-testid="controls-pane-filter-item"]'));
  }

  it("each row SHOWS the label and carries the KEY as data-value", () => {
    render(() => undefined);
    expect(rows().map((r) => r.textContent?.trim())).toEqual(["15.01.2024", "01.02.2024", "(Blank)"]);
    expect(rows().map((r) => r.getAttribute("data-value"))).toEqual(["2024-01-15", "2024-02-01", ""]);
  });

  it("unticking the row shown as 15.01.2024 applies the remaining KEYS", async () => {
    const onApply = vi.fn();
    render(onApply);
    const box = rows()[0].querySelector("input") as HTMLInputElement;
    await act(async () => {
      box.click();
    });
    const ok = Array.from(document.querySelectorAll<HTMLButtonElement>("button")).find((b) => b.textContent?.trim() === "OK");
    await act(async () => {
      ok!.click();
    });
    expect(onApply).toHaveBeenCalledWith(["2024-02-01", ""]);
  });
});
