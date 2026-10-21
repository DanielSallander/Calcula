//! FILENAME: app/extensions/Pivot/handlers/__tests__/pivotFilterOverlayMembers.test.tsx
// PURPOSE: The pivot report-filter overlay speaks MEMBERS (P2 S7): it SHOWS
//          each member's app-locale label, SEARCHES over the labels, and its OK
//          callback (Apply) returns KEYS -- the selection a filter stores and the
//          backend matches. A de-DE date field shows "15.01.2024" and selects
//          "2024-01-15"; the blank member shows "(Blank)" and selects "".
//          - handleOpenFilterMenu hands the overlay `members` (never the
//            retired `uniqueValues`), with the cached selection's KEYS;
//          - the registered overlay renders labels and returns keys.
// CONTEXT: @testing-library/react is not installed; react-dom + `act`, as the
//          other Pivot component tests. The dialogs and panes the manifest also
//          registers are stood in for (heavy, and another test's concern); the
//          shared FilterDropdown is REAL.

/* eslint-disable @typescript-eslint/naming-convention --
 * The doubles below stand in for React components, whose real export names are
 * PascalCase. */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";

const h = vi.hoisted(() => ({
  showOverlay: vi.fn(),
  getAtCell: vi.fn(),
  getFieldUniqueValues: vi.fn(),
  cachedView: null as unknown,
}));

vi.mock("@api", () => ({
  emitAppEvent: vi.fn(),
  OverlayExtensions: { showOverlay: h.showOverlay },
}));
vi.mock("@api/pivot", () => ({
  pivot: { getAtCell: h.getAtCell, getFieldUniqueValues: h.getFieldUniqueValues },
}));
vi.mock("../../lib/pivotViewStore", () => ({ getCachedPivotView: () => h.cachedView }));
vi.mock("../../components/PivotEditorView", () => ({ PivotEditorView: () => null }));
vi.mock("../../components/CreatePivotDialog", () => ({ CreatePivotDialog: () => null }));
vi.mock("../../components/GroupDialog", () => ({ GroupDialog: () => null }));
vi.mock("../../components/FieldSettingsDialog", () => ({ FieldSettingsDialog: () => null }));
vi.mock("../../components/PivotOptionsDialog", () => ({ PivotOptionsDialog: () => null }));
vi.mock("../../components/DrillThroughBehaviorDialog", () => ({ default: () => null }));
vi.mock("../../components/PivotHeaderFilterDropdown", () => ({ PivotHeaderFilterDropdown: () => null }));
vi.mock("../../components/PivotDesignSections", () => ({
  DesignNameSection: () => null,
  DesignGrandTotalsSection: () => null,
  DesignStylesSection: () => null,
  DesignReportLayoutSection: () => null,
  DesignDisplaySection: () => null,
}));
vi.mock("../../components/PivotAnalyzeSections", () => ({
  AnalyzePivotTableSection: () => null,
  AnalyzeDataSection: () => null,
  AnalyzeActionsSection: () => null,
  AnalyzeCalculationsSection: () => null,
}));

import { PivotFilterOverlayDefinition, PIVOT_FILTER_OVERLAY_ID } from "../../manifest";
import { handleOpenFilterMenu } from "../filterMenuHandler";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const MEMBERS = [
  { key: "2024-01-15", label: "15.01.2024" },
  { key: "2024-02-01", label: "01.02.2024" },
  { key: "", label: "(Blank)" },
];

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  vi.clearAllMocks();
  h.cachedView = null;
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

function renderOverlay(data: Record<string, unknown>): void {
  const Overlay = PivotFilterOverlayDefinition.component as React.ComponentType<Record<string, unknown>>;
  act(() => {
    root.render(
      React.createElement(Overlay, {
        data,
        anchorRect: { x: 0, y: 0, width: 150, height: 24 },
        onClose: vi.fn(),
      }),
    );
  });
}

function rowTexts(): string[] {
  return Array.from(container.querySelectorAll("label")).map((l) => (l.textContent ?? "").trim());
}

function button(text: string): HTMLButtonElement {
  const b = Array.from(container.querySelectorAll("button")).find((x) => (x.textContent ?? "").trim() === text);
  if (!b) throw new Error(`no "${text}" button`);
  return b as HTMLButtonElement;
}

describe("handleOpenFilterMenu hands the overlay MEMBERS", () => {
  it("carries members and the cached selection's keys -- never uniqueValues", async () => {
    h.getFieldUniqueValues.mockResolvedValue({ fieldIndex: 2, fieldName: "Date", members: MEMBERS });
    h.cachedView = {
      filterRows: [{ fieldIndex: 2, fieldName: "Date", selectedValues: ["2024-01-15"], members: MEMBERS, displayValue: "", viewRow: 0 }],
    };
    await handleOpenFilterMenu({ fieldIndex: 2, fieldName: "Date", row: 0, col: 0, anchorX: 10, anchorY: 20, pivotId: "p1" });
    expect(h.showOverlay).toHaveBeenCalledTimes(1);
    const [id, opts] = h.showOverlay.mock.calls[0] as [string, { data: Record<string, unknown> }];
    expect(id).toBe(PIVOT_FILTER_OVERLAY_ID);
    expect(opts.data.members).toEqual(MEMBERS);
    expect(opts.data.selectedValues).toEqual(["2024-01-15"]);
    expect("uniqueValues" in opts.data).toBe(false);
  });

  it("with no cached selection every member KEY is selected", async () => {
    h.getFieldUniqueValues.mockResolvedValue({ fieldIndex: 2, fieldName: "Date", members: MEMBERS });
    await handleOpenFilterMenu({ fieldIndex: 2, fieldName: "Date", row: 0, col: 0, anchorX: 10, anchorY: 20, pivotId: "p1" });
    const [, opts] = h.showOverlay.mock.calls[0] as [string, { data: Record<string, unknown> }];
    expect(opts.data.selectedValues).toEqual(["2024-01-15", "2024-02-01", ""]);
  });
});

describe("the overlay shows labels and returns keys", () => {
  it("renders every member's LABEL, never its key", () => {
    renderOverlay({ fieldName: "Date", fieldIndex: 2, members: MEMBERS, selectedValues: ["2024-01-15", "2024-02-01", ""], onApply: vi.fn() });
    expect(rowTexts()).toEqual(["15.01.2024", "01.02.2024", "(Blank)"]);
    expect(container.textContent).not.toContain("2024-01-15");
  });

  it("Apply returns KEYS: the kept ones and the hidden ones", async () => {
    const onApply = vi.fn(async () => undefined);
    renderOverlay({ fieldName: "Date", fieldIndex: 2, members: MEMBERS, selectedValues: ["2024-01-15", "2024-02-01", ""], onApply });
    // Untick the member SHOWN as 01.02.2024.
    const second = Array.from(container.querySelectorAll("label")).find((l) => l.textContent?.includes("01.02.2024"));
    const box = second!.querySelector("input") as HTMLInputElement;
    await act(async () => {
      box.click();
    });
    await act(async () => {
      button("Apply").click();
    });
    expect(onApply).toHaveBeenCalledWith(2, ["2024-01-15", ""], ["2024-02-01"]);
  });

  it("the search matches what the user SEES (the label), not the key", () => {
    renderOverlay({ fieldName: "Date", fieldIndex: 2, members: MEMBERS, selectedValues: [], onApply: vi.fn() });
    const search = container.querySelector('input[placeholder="Search..."]') as HTMLInputElement;
    const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
    act(() => {
      setValue.call(search, "15.01");
      search.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(rowTexts()).toEqual(["15.01.2024"]);
    act(() => {
      setValue.call(search, "2024-01");
      search.dispatchEvent(new Event("input", { bubbles: true }));
    });
    // The key spelling is not what is shown, so it finds nothing.
    expect(rowTexts()).toEqual([]);
  });
});
