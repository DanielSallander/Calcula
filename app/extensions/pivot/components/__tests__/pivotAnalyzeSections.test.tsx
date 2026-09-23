//! FILENAME: app/extensions/Pivot/components/__tests__/pivotAnalyzeSections.test.tsx
// PURPOSE: The "Pivot Table" (analyze) sections on the @api/layout grammar:
//          CommandButton heroes with duotone RibbonIcons instead of hand-drawn
//          SVGs and unicode glyphs, no hardcoded chrome colour under band AND
//          panel geometry, the fill rule in the band, and every command still
//          doing what it did — including the three dialogs mounted inline.

/* eslint-disable @typescript-eslint/naming-convention --
 * The dialog doubles below stand in for React components whose real export
 * names are PascalCase; a camelCase double would not be the export the
 * sections import. */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";

const h = vi.hoisted(() => ({
  state: { pivotId: "p1" as string | null, layoutState: null, sourceRange: "Sheet1!$A$1:$D$20" },
  showDialog: vi.fn(),
  openTaskPane: vi.fn(),
  confirmAsync: vi.fn(),
  refreshSourceRange: vi.fn(),
  refreshPivotCache: vi.fn(),
  getPivotTableInfo: vi.fn(),
  deletePivotTable: vi.fn(),
  addCalculatedField: vi.fn(),
  addCalculatedItem: vi.fn(),
  showReportFilterPages: vi.fn(),
}));

vi.mock("@api", () => ({ showDialog: h.showDialog, openTaskPane: h.openTaskPane }));
vi.mock("@api/dialogs", () => ({ confirmAsync: h.confirmAsync }));
vi.mock("../../manifest", () => ({ PIVOT_OPTIONS_DIALOG_ID: "pivot:pivotOptionsDialog" }));
vi.mock("../../lib/pivotPanelStore", () => ({
  usePivotPanelState: () => h.state,
  refreshSourceRange: h.refreshSourceRange,
}));
vi.mock("../../lib/pivot-api", () => ({
  refreshPivotCache: h.refreshPivotCache,
  getPivotTableInfo: h.getPivotTableInfo,
  deletePivotTable: h.deletePivotTable,
  addCalculatedField: h.addCalculatedField,
  addCalculatedItem: h.addCalculatedItem,
  showReportFilterPages: h.showReportFilterPages,
}));
// The inline dialogs are other files' chrome; stand-ins prove they are still
// mounted by the sections and opened by their buttons.
vi.mock("../ChangeDataSourceDialog", () => ({
  ChangeDataSourceDialog: ({ isOpen }: { isOpen: boolean }) =>
    isOpen ? <div data-testid="stub-change-source-dialog" /> : null,
}));
vi.mock("../CalculatedFieldDialog", () => ({
  CalculatedFieldDialog: ({ isOpen, title }: { isOpen: boolean; title: string }) =>
    isOpen ? <div data-testid="stub-calc-dialog">{title}</div> : null,
}));

import {
  SurfaceLayoutProvider,
  bandLayout,
  panelLayout,
  findHardcodedColours,
  type SurfaceLayout,
} from "@api/layout";
import type { PanelSectionProps } from "@api/uiTypes";
import {
  AnalyzePivotTableSection,
  AnalyzeDataSection,
  AnalyzeActionsSection,
  AnalyzeCalculationsSection,
} from "../PivotAnalyzeSections";

const SECTION_PROPS = { placement: "ribbon" } as unknown as PanelSectionProps;

const SECTIONS: Array<[string, (p: PanelSectionProps) => React.ReactElement | null]> = [
  ["PivotTable", AnalyzePivotTableSection],
  ["Data", AnalyzeDataSection],
  ["Actions", AnalyzeActionsSection],
  ["Calculations", AnalyzeCalculationsSection],
];

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
  h.state.pivotId = "p1";
  h.refreshPivotCache.mockResolvedValue(undefined);
  h.deletePivotTable.mockResolvedValue(undefined);
  h.showReportFilterPages.mockResolvedValue(["Sheet East", "Sheet West"]);
  h.getPivotTableInfo.mockResolvedValue({
    sourceFields: [{ name: "Region" }, { name: "Sales" }],
    rowHierarchies: [{ name: "Region" }],
  });
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  document.body.innerHTML = "";
  vi.clearAllMocks();
});

async function render(node: React.ReactNode, layout: SurfaceLayout = bandLayout()): Promise<void> {
  await act(async () => {
    root.render(<SurfaceLayoutProvider value={layout}>{node}</SurfaceLayoutProvider>);
  });
}

async function click(el: Element): Promise<void> {
  await act(async () => {
    (el as HTMLElement).click();
  });
}

function byTestId(id: string): HTMLElement {
  const el = document.body.querySelector<HTMLElement>(`[data-testid="${id}"]`);
  if (!el) throw new Error(`no [data-testid="${id}"]`);
  return el;
}

// ============================================================================
// Chrome
// ============================================================================

describe("Pivot Analyze sections — chrome", () => {
  for (const [name, Section] of SECTIONS) {
    for (const [surface, layout] of [
      ["band", bandLayout()],
      ["panel", panelLayout(300)],
    ] as const) {
      it(`${name} renders under ${surface} layout with no hardcoded colour`, async () => {
        await render(<Section {...SECTION_PROPS} />, layout);
        expect(container.firstElementChild).not.toBeNull();
        expect(findHardcodedColours(container)).toEqual([]);
      });
    }
  }

  it("every button carries a duotone icon and no glyph text", async () => {
    for (const Section of [AnalyzeDataSection, AnalyzeActionsSection, AnalyzeCalculationsSection]) {
      await render(<Section {...SECTION_PROPS} />);
      const buttons = Array.from(container.querySelectorAll("button"));
      expect(buttons.length).toBeGreaterThan(0);
      for (const button of buttons) {
        expect(button.querySelector("svg")).not.toBeNull();
        // Duotone icons: filled shapes on the 24-unit grid, no <text> glyphs.
        expect(button.querySelector("svg text")).toBeNull();
        expect(button.querySelector("svg")!.getAttribute("viewBox")).toBe("0 0 24 24");
      }
      expect(container.textContent ?? "").not.toMatch(/[←-➿\u{1F300}-\u{1FAFF}]/u);
    }
  });

  it("the heroes are 61px tall in the band and 28px buttons in a panel", async () => {
    await render(<AnalyzeDataSection {...SECTION_PROPS} />);
    expect(getComputedStyle(byTestId("pivot-analyze-refresh")).height).toBe("61px");
    await render(<AnalyzeDataSection {...SECTION_PROPS} />, panelLayout(300));
    expect(byTestId("pivot-analyze-refresh").style.height).toBe("28px");
  });

  it("Filter Pages and Delete stack as two 28px rows beside the heroes in the band", async () => {
    await render(<AnalyzeActionsSection {...SECTION_PROPS} />);
    const filterPages = byTestId("pivot-analyze-filter-pages");
    const del = byTestId("pivot-analyze-delete");
    const column = filterPages.parentElement!;
    expect(del.parentElement).toBe(column);
    expect(getComputedStyle(column).flexDirection).toBe("column");
    expect(getComputedStyle(column).rowGap || getComputedStyle(column).gap).toBe("5px");
    expect(filterPages.style.height).toBe("28px");
    expect(del.style.height).toBe("28px");
    for (const id of ["pivot-analyze-options", "pivot-analyze-insert-slicer", "pivot-analyze-insert-timeline"]) {
      expect(getComputedStyle(byTestId(id)).height).toBe("61px");
    }
  });

  it("the data source readout is a caption row over a value row", async () => {
    await render(<AnalyzePivotTableSection {...SECTION_PROPS} />);
    const value = byTestId("pivot-analyze-source-range");
    expect(value.textContent).toBe("Sheet1!$A$1:$D$20");
    expect(value.getAttribute("title")).toBe("Sheet1!$A$1:$D$20");
    const caption = value.previousElementSibling as HTMLElement;
    expect(caption.textContent).toBe("Data Source:");
    expect(getComputedStyle(caption).height).toBe("28px");
    expect(getComputedStyle(value).height).toBe("28px");
  });
});

// ============================================================================
// Behaviour
// ============================================================================

describe("Pivot Analyze sections — behaviour", () => {
  it("without a pivot the info section asks for one and the rest render nothing", async () => {
    h.state.pivotId = null;
    await render(<AnalyzePivotTableSection {...SECTION_PROPS} />);
    expect(container.textContent).toBe("Select a PivotTable to see options");
    for (const Section of [AnalyzeDataSection, AnalyzeActionsSection, AnalyzeCalculationsSection]) {
      await render(<Section {...SECTION_PROPS} />);
      expect(container.innerHTML).toBe("");
    }
  });

  it("Refresh refreshes the cache and announces pivot:refresh", async () => {
    const onRefresh = vi.fn();
    window.addEventListener("pivot:refresh", onRefresh);
    await render(<AnalyzeDataSection {...SECTION_PROPS} />);
    await click(byTestId("pivot-analyze-refresh"));
    expect(h.refreshPivotCache).toHaveBeenCalledWith("p1");
    expect(onRefresh).toHaveBeenCalledTimes(1);
    window.removeEventListener("pivot:refresh", onRefresh);
  });

  it("Refresh on a disconnected BI pivot offers the Connections pane (awaited, fail-closed)", async () => {
    h.refreshPivotCache.mockRejectedValue(new Error("Not connected"));
    h.confirmAsync.mockReturnValue(Promise.resolve(false));
    await render(<AnalyzeDataSection {...SECTION_PROPS} />);
    await click(byTestId("pivot-analyze-refresh"));
    expect(h.confirmAsync).toHaveBeenCalledTimes(1);
    expect(h.openTaskPane).not.toHaveBeenCalled();

    h.confirmAsync.mockReturnValue(Promise.resolve(true));
    await click(byTestId("pivot-analyze-refresh"));
    expect(h.openTaskPane).toHaveBeenCalledWith("connections-pane");
  });

  it("Change Source opens the inline Change Data Source dialog", async () => {
    await render(<AnalyzeDataSection {...SECTION_PROPS} />);
    expect(document.body.querySelector('[data-testid="stub-change-source-dialog"]')).toBeNull();
    await click(byTestId("pivot-analyze-change-source"));
    expect(byTestId("stub-change-source-dialog")).toBeTruthy();
  });

  it("Options, Insert Slicer and Insert Timeline open their dialogs for this pivot", async () => {
    await render(<AnalyzeActionsSection {...SECTION_PROPS} />);
    await click(byTestId("pivot-analyze-options"));
    expect(h.showDialog).toHaveBeenLastCalledWith("pivot:pivotOptionsDialog", { pivotId: "p1" });
    await click(byTestId("pivot-analyze-insert-slicer"));
    expect(h.showDialog).toHaveBeenLastCalledWith("slicer:insertDialog", { sourceType: "pivot", sourceId: "p1" });
    await click(byTestId("pivot-analyze-insert-timeline"));
    expect(h.showDialog).toHaveBeenLastCalledWith("timelineSlicer:insertDialog", { sourceId: "p1" });
  });

  it("Filter Pages generates the sheets and refreshes the sheet tabs", async () => {
    const onSheets = vi.fn();
    window.addEventListener("sheets:refresh", onSheets);
    await render(<AnalyzeActionsSection {...SECTION_PROPS} />);
    await click(byTestId("pivot-analyze-filter-pages"));
    expect(h.showReportFilterPages).toHaveBeenCalledWith("p1", 0);
    expect(onSheets).toHaveBeenCalledTimes(1);
    window.removeEventListener("sheets:refresh", onSheets);
  });

  it("Delete deletes the pivot", async () => {
    await render(<AnalyzeActionsSection {...SECTION_PROPS} />);
    await click(byTestId("pivot-analyze-delete"));
    expect(h.deletePivotTable).toHaveBeenCalledWith("p1");
  });

  it("Calculated Field and Calculated Item open the inline dialog with the right field names", async () => {
    await render(<AnalyzeCalculationsSection {...SECTION_PROPS} />);
    await click(byTestId("pivot-analyze-calculated-field"));
    expect(h.getPivotTableInfo).toHaveBeenCalledWith("p1");
    expect(byTestId("stub-calc-dialog").textContent).toBe("Insert Calculated Field");

    await render(<AnalyzeCalculationsSection {...SECTION_PROPS} />);
    await click(byTestId("pivot-analyze-calculated-item"));
    const dialogs = Array.from(document.body.querySelectorAll('[data-testid="stub-calc-dialog"]'))
      .map((d) => d.textContent);
    expect(dialogs).toContain("Insert Calculated Item");
  });
});
