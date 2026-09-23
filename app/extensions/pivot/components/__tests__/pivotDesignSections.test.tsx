//! FILENAME: app/extensions/Pivot/components/__tests__/pivotDesignSections.test.tsx
// PURPOSE: The "Pivot Table Design" sections on the @api/layout grammar:
//          every section renders under band AND panel geometry with no
//          hardcoded chrome colour, follows the fill rule in the band (two
//          28px rows with a 5px gap, or the 61px gallery row), uses Checkbox /
//          Dropdown instead of native inputs/selects, and still writes the same
//          layout updates through the shared pivot panel store.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";

const h = vi.hoisted(() => {
  const state: {
    pivotId: string | null;
    layoutState: { pivotId: string | null; layout: Record<string, unknown> } | null;
    sourceRange: string;
  } = {
    pivotId: "p1",
    layoutState: { pivotId: "p1", layout: {} },
    sourceRange: "",
  };
  return {
    state,
    updateSharedLayout: vi.fn(),
    getPivotTableInfo: vi.fn(),
    updatePivotProperties: vi.fn(),
    requestOverlayRedraw: vi.fn(),
  };
});

vi.mock("../../lib/pivotPanelStore", () => ({
  usePivotPanelState: () => h.state,
  updateSharedLayout: h.updateSharedLayout,
}));
vi.mock("../../lib/pivot-api", () => ({
  getPivotTableInfo: h.getPivotTableInfo,
  updatePivotProperties: h.updatePivotProperties,
}));
vi.mock("@api/gridOverlays", () => ({ requestOverlayRedraw: h.requestOverlayRedraw }));

import {
  SurfaceLayoutProvider,
  bandLayout,
  panelLayout,
  findHardcodedColours,
  type SurfaceLayout,
} from "@api/layout";
import type { PanelSectionProps } from "@api/uiTypes";
import {
  DesignNameSection,
  DesignGrandTotalsSection,
  DesignStylesSection,
  DesignReportLayoutSection,
  DesignDisplaySection,
} from "../PivotDesignSections";
import { getPivotStylePreview, setPivotStylePreview } from "../../lib/pivotStyles";

const SECTION_PROPS = { placement: "ribbon" } as unknown as PanelSectionProps;

const SECTIONS: Array<[string, (p: PanelSectionProps) => React.ReactElement | null]> = [
  ["PivotTable Name", DesignNameSection],
  ["Grand Totals", DesignGrandTotalsSection],
  ["PivotTable Styles", DesignStylesSection],
  ["Report Layout", DesignReportLayoutSection],
  ["Display", DesignDisplaySection],
];

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
  h.state.pivotId = "p1";
  h.state.layoutState = { pivotId: "p1", layout: {} };
  h.getPivotTableInfo.mockResolvedValue({ name: "PivotTable1" });
  h.updatePivotProperties.mockResolvedValue(undefined);
  setPivotStylePreview(null, null);
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

function click(el: Element): void {
  act(() => {
    (el as HTMLElement).click();
  });
}

function byTestId(id: string): HTMLElement {
  const el = document.body.querySelector<HTMLElement>(`[data-testid="${id}"]`);
  if (!el) throw new Error(`no [data-testid="${id}"]`);
  return el;
}

// ============================================================================
// Every section, both surfaces
// ============================================================================

describe("Pivot Design sections — chrome", () => {
  for (const [name, Section] of SECTIONS) {
    for (const [surface, layout] of [
      ["band", bandLayout()],
      ["panel", panelLayout(300)],
    ] as const) {
      it(`${name} renders under ${surface} layout with no hardcoded colour and no native select`, async () => {
        await render(<Section {...SECTION_PROPS} />, layout);
        expect(container.firstElementChild).not.toBeNull();
        expect(container.querySelector("select")).toBeNull();
        expect(findHardcodedColours(container)).toEqual([]);
      });
    }
  }

  it("carries no unicode glyph icons", async () => {
    for (const [, Section] of SECTIONS) {
      await render(<Section {...SECTION_PROPS} />);
      expect(container.textContent ?? "").not.toMatch(/[←-➿\u{1F300}-\u{1FAFF}]/u);
    }
  });
});

// ============================================================================
// Fill rule (band)
// ============================================================================

describe("Pivot Design sections — the fill rule in the band", () => {
  it("PivotTable Name is a 28px caption row over the 28px name box", async () => {
    await render(<DesignNameSection {...SECTION_PROPS} />);
    const column = container.firstElementChild as HTMLElement;
    expect(getComputedStyle(column).flexDirection).toBe("column");
    expect(getComputedStyle(column).rowGap || getComputedStyle(column).gap).toBe("5px");
    const [caption, input] = Array.from(column.children) as HTMLElement[];
    expect(caption.tagName).toBe("LABEL");
    expect(getComputedStyle(caption).height).toBe("28px");
    expect(input.tagName).toBe("INPUT");
    expect(caption.getAttribute("for")).toBe(input.id);
  });

  it("Grand Totals, Report Layout and Display stack two 28px rows with a 5px gap", async () => {
    await render(<DesignGrandTotalsSection {...SECTION_PROPS} />);
    let stack = container.firstElementChild as HTMLElement;
    expect(stack.style.gap).toBe("5px");
    expect(stack.children).toHaveLength(2);

    await render(<DesignReportLayoutSection {...SECTION_PROPS} />);
    stack = container.firstElementChild as HTMLElement;
    expect(stack.style.gap).toBe("5px");
    expect(stack.children).toHaveLength(2);
    expect(stack.querySelectorAll('[role="combobox"]')).toHaveLength(2);

    await render(<DesignDisplaySection {...SECTION_PROPS} />);
    const columns = Array.from((container.firstElementChild as HTMLElement).children) as HTMLElement[];
    expect(columns).toHaveLength(2);
    for (const col of columns) {
      expect(col.style.gap).toBe("5px");
      expect(col.children).toHaveLength(2);
    }
  });

  it("PivotTable Styles is one tall row: the 61px strip beside the Clear hero", async () => {
    await render(<DesignStylesSection {...SECTION_PROPS} />);
    const strip = byTestId("pivot-style");
    expect(getComputedStyle(strip).height).toBe("61px");
    const clear = byTestId("pivot-style-clear");
    expect(getComputedStyle(clear).height).toBe("61px");
  });
});

// ============================================================================
// Behaviour
// ============================================================================

describe("Pivot Design sections — behaviour", () => {
  it("shows the select-a-pivot message when no pivot is active; the rest render nothing", async () => {
    h.state.layoutState = null;
    await render(<DesignNameSection {...SECTION_PROPS} />);
    expect(container.textContent).toBe("Select a PivotTable to see design options");
    for (const Section of [DesignGrandTotalsSection, DesignStylesSection, DesignReportLayoutSection, DesignDisplaySection]) {
      await render(<Section {...SECTION_PROPS} />);
      expect(container.innerHTML).toBe("");
    }
  });

  it("loads the pivot name and saves a trimmed rename on Enter", async () => {
    await render(<DesignNameSection {...SECTION_PROPS} />);
    const input = byTestId("pivot-design-name") as HTMLInputElement;
    expect(input.value).toBe("PivotTable1");
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
    act(() => {
      setter.call(input, "  Sales  ");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => {
      input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    });
    expect(h.updatePivotProperties).toHaveBeenCalledWith({ pivotId: "p1", name: "Sales" });
  });

  it("grand total checkboxes default on and write the toggled value", async () => {
    await render(<DesignGrandTotalsSection {...SECTION_PROPS} />);
    const rows = byTestId("pivot-design-row-totals") as HTMLInputElement;
    const cols = byTestId("pivot-design-column-totals") as HTMLInputElement;
    expect(rows.type).toBe("checkbox");
    expect(rows.checked).toBe(true);
    expect(cols.checked).toBe(true);
    click(rows);
    expect(h.updateSharedLayout).toHaveBeenCalledWith({ showRowGrandTotals: false });
    click(cols);
    expect(h.updateSharedLayout).toHaveBeenCalledWith({ showColumnGrandTotals: false });
  });

  it("display checkboxes read the layout and write each flag", async () => {
    h.state.layoutState = { pivotId: "p1", layout: { repeatRowLabels: true } };
    await render(<DesignDisplaySection {...SECTION_PROPS} />);
    expect((byTestId("pivot-design-repeat-labels") as HTMLInputElement).checked).toBe(true);
    expect((byTestId("pivot-design-empty-rows") as HTMLInputElement).checked).toBe(false);
    expect((byTestId("pivot-design-empty-cols") as HTMLInputElement).checked).toBe(false);
    expect((byTestId("pivot-design-autofit-columns") as HTMLInputElement).checked).toBe(true);
    click(byTestId("pivot-design-repeat-labels"));
    click(byTestId("pivot-design-empty-rows"));
    click(byTestId("pivot-design-empty-cols"));
    click(byTestId("pivot-design-autofit-columns"));
    expect(h.updateSharedLayout.mock.calls.map((c) => c[0])).toEqual([
      { repeatRowLabels: false },
      { showEmptyRows: true },
      { showEmptyCols: true },
      { autoFitColumnWidths: false },
    ]);
  });

  it("report layout and values position are Dropdowns that write the chosen value", async () => {
    h.state.layoutState = { pivotId: "p1", layout: { reportLayout: "outline" } };
    await render(<DesignReportLayoutSection {...SECTION_PROPS} />);
    const layoutTrigger = byTestId("pivot-design-report-layout");
    expect(layoutTrigger.getAttribute("role")).toBe("combobox");
    expect(layoutTrigger.textContent).toBe("Outline");
    click(layoutTrigger);
    click(byTestId("pivot-design-report-layout-tabular"));
    expect(h.updateSharedLayout).toHaveBeenCalledWith({ reportLayout: "tabular" });

    const valuesTrigger = byTestId("pivot-design-values-position");
    expect(valuesTrigger.textContent).toBe("Columns");
    click(valuesTrigger);
    click(byTestId("pivot-design-values-position-rows"));
    expect(h.updateSharedLayout).toHaveBeenCalledWith({ valuesPosition: "rows" });
  });

  it("the styles gallery commits, clears, and previews transiently on the active pivot", async () => {
    await render(<DesignStylesSection {...SECTION_PROPS} />);
    // Default style applied and shown selected.
    expect(byTestId("pivot-style-PivotStyleLight16").getAttribute("aria-selected")).toBe("true");

    const option = document.body.querySelectorAll('[data-testid="pivot-style"] [role="option"]')[0];
    const id = option.getAttribute("data-testid")!.replace("pivot-style-", "");
    act(() => {
      option.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
    });
    expect(getPivotStylePreview("p1")).toBe(id);
    expect(h.requestOverlayRedraw).toHaveBeenCalled();
    // A preview is not a layout change: nothing was written.
    expect(h.updateSharedLayout).not.toHaveBeenCalled();

    click(option);
    expect(getPivotStylePreview("p1")).toBeNull();
    expect(h.updateSharedLayout).toHaveBeenCalledWith({ styleId: id });

    click(byTestId("pivot-style-clear"));
    expect(h.updateSharedLayout).toHaveBeenLastCalledWith({ styleId: "" });
  });

  it("a standing preview ends when the section unmounts", async () => {
    await render(<DesignStylesSection {...SECTION_PROPS} />);
    const option = document.body.querySelectorAll('[data-testid="pivot-style"] [role="option"]')[1];
    act(() => {
      option.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
    });
    expect(getPivotStylePreview("p1")).not.toBeNull();
    act(() => root.unmount());
    expect(getPivotStylePreview("p1")).toBeNull();
    root = createRoot(container);
  });
});
