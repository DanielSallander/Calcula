//! FILENAME: app/extensions/Sparklines/__tests__/designSections.test.tsx
// PURPOSE: The Sparkline design tab on the Calcula Clusters grammar: every
//          section renders in the ribbon band AND in a panel with no
//          hardcoded chrome colour, fills the band by THE FILL RULE (one tall
//          row, or two 28px rows), and still drives the sparkline store
//          exactly as the hand-rolled tab did.
// CONTEXT: The sections read the selection through useGridState (mocked) and
//          write through the REAL in-memory store, so each assertion is about
//          what the user's click did to their sparkline group.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";

const { grid, showDialogMock, paletteMock } = vi.hoisted(() => ({
  grid: {
    selection: null as null | { startRow: number; startCol: number; endRow: number; endCol: number },
  },
  showDialogMock: vi.fn(),
  paletteMock: vi.fn(),
}));

vi.mock("@api/state", () => ({ useGridState: () => grid }));
vi.mock("@api/ui", () => ({ showDialog: showDialogMock }));
vi.mock("@api/theme", () => ({ getThemeColorPalette: paletteMock }));
// The extension entry point wires the whole extension; the sections need only
// the dialog id from it.
vi.mock("../index", () => ({ SPARKLINE_DIALOG_ID: "sparkline:createDialog" }));

import {
  SurfaceLayoutProvider,
  bandLayout,
  panelLayout,
  findHardcodedColours,
  type SurfaceLayout,
} from "@api/layout";
import type { PanelSectionProps } from "@api/uiTypes";
import { RibbonIcon } from "@api/ribbonIcons";
import { createSparklineGroup, getAllGroups, resetSparklineStore, updateSparklineGroup } from "../store";
import type { SparklineGroup } from "../types";
import {
  SparklineEditSection,
  SparklineTypeSection,
  SparklineShowSection,
  SparklineStyleSection,
  SparklineAxisSection,
  SparklineGroupSection,
} from "../components/SparklineDesignSections";
import { SparklineColorPicker } from "../components/SparklineColorPicker";
import { SparklineDesignPanelDefinition, SPARKLINE_DESIGN_TAB_ID } from "../manifest";
import { SPARKLINE_PICKER_COLORS, SPARKLINE_STYLE_PRESETS } from "../lib/sparklineColors";

// ============================================================================
// Harness
// ============================================================================

type Section = React.ComponentType<PanelSectionProps>;

const SECTIONS: Array<[string, Section]> = [
  ["Sparkline", SparklineEditSection],
  ["Type", SparklineTypeSection],
  ["Show", SparklineShowSection],
  ["Style", SparklineStyleSection],
  ["Axis", SparklineAxisSection],
  ["Group", SparklineGroupSection],
];

const LAYOUTS: Array<[string, SurfaceLayout]> = [
  ["band", bandLayout()],
  ["panel", panelLayout(300)],
];

let container: HTMLDivElement;
let root: Root;
let currentSection: Section | null = null;
let currentLayout: SurfaceLayout = bandLayout();

beforeEach(() => {
  Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
  resetSparklineStore();
  showDialogMock.mockReset();
  paletteMock.mockReset();
  paletteMock.mockResolvedValue([]);
  // A line sparkline at F1 over A1:E1, with F1 selected.
  createSparklineGroup(
    { startRow: 0, startCol: 5, endRow: 0, endCol: 5 },
    { startRow: 0, startCol: 0, endRow: 0, endCol: 4 },
    "line",
  );
  grid.selection = { startRow: 0, startCol: 5, endRow: 0, endCol: 5 };
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  document.body.innerHTML = "";
  currentSection = null;
});

function render(section: Section, layout: SurfaceLayout = bandLayout()): void {
  currentSection = section;
  currentLayout = layout;
  const placement = layout.container === "band" ? "ribbon" : "sidebar";
  act(() => {
    root.render(
      <SurfaceLayoutProvider value={layout}>
        {React.createElement(section, { placement })}
      </SurfaceLayoutProvider>,
    );
  });
}

/** Re-render the current section (a store write outside a click). */
function rerender(): void {
  if (currentSection) render(currentSection, currentLayout);
}

function group(): SparklineGroup {
  const all = getAllGroups();
  expect(all).toHaveLength(1);
  return all[0];
}

function byTestId<T extends Element = HTMLElement>(id: string): T {
  const el = document.querySelector(`[data-testid='${id}']`);
  if (!el) throw new Error(`no element for ${id}`);
  return el as T;
}

function click(el: Element): void {
  act(() => {
    el.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
}

function key(el: Element, k: string): void {
  act(() => {
    el.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true }));
  });
}

/** Set a controlled input's value the way typing does (see formControlsKit). */
function typeValue(el: HTMLInputElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
  act(() => {
    setter?.call(el, value);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

/** Open a Dropdown by its trigger test id and pick the option with that id. */
function choose(triggerId: string, optionId: string): void {
  click(byTestId(triggerId));
  click(byTestId(optionId));
}

/** The value the stylesheet rules matching `el` declare for `prop`. */
function declared(el: Element, prop: string): string {
  let value = "";
  const decl = new RegExp(`(?:^|;)\\s*${prop}\\s*:\\s*([^;]+)`);
  for (const style of Array.from(document.querySelectorAll("style"))) {
    const texts = [style.textContent ?? ""];
    const sheet = style.sheet;
    if (sheet) for (const rule of Array.from(sheet.cssRules)) texts.push(rule.cssText);
    for (const text of texts) {
      const re = /([^{}]+)\{([^{}]*)\}/g;
      let m: RegExpExecArray | null;
      while ((m = re.exec(text)) !== null) {
        let matches = false;
        try {
          matches = el.matches(m[1].trim());
        } catch {
          matches = false;
        }
        if (!matches) continue;
        const hit = decl.exec(m[2]);
        if (hit) value = hit[1].trim();
      }
    }
  }
  return value;
}

// ============================================================================
// Every section, both surfaces
// ============================================================================

describe("Sparkline design sections follow the skin", () => {
  for (const [sectionName, Component] of SECTIONS) {
    for (const [layoutName, layout] of LAYOUTS) {
      it(`${sectionName} paints no hardcoded colour in the ${layoutName}`, () => {
        render(Component, layout);
        expect(container.childElementCount).toBeGreaterThan(0);
        expect(findHardcodedColours(container)).toEqual([]);
      });
    }
  }

  it("the custom-scale Axis section paints no hardcoded colour either", () => {
    updateSparklineGroup(group().id, { axisScaleType: "custom" });
    for (const [, layout] of LAYOUTS) {
      render(SparklineAxisSection, layout);
      expect(findHardcodedColours(container)).toEqual([]);
    }
  });

  it("no section carries a unicode or emoji glyph icon, a native select, or a fixed layer", () => {
    for (const [, Component] of SECTIONS) {
      for (const [, layout] of LAYOUTS) {
        render(Component, layout);
        // Printable ASCII only: the old tab drew its icons as text
        // (&#x270E; &#x1F4C8; &#x229E; &#x2716; and the picker's triangles).
        expect(container.textContent ?? "").toMatch(/^[\x20-\x7E]*$/);
        expect(container.querySelector("select")).toBeNull();
        const fixed = Array.from(container.querySelectorAll<HTMLElement>("*")).filter(
          (el) => el.style.position === "fixed",
        );
        expect(fixed).toEqual([]);
      }
    }
  });

  it("with no sparkline selected, only the first section speaks", () => {
    grid.selection = { startRow: 10, startCol: 10, endRow: 10, endCol: 10 };
    render(SparklineEditSection);
    expect(byTestId("sparkline-design-empty").textContent).toBe(
      "Select a sparkline cell to see design options",
    );
    expect(findHardcodedColours(container)).toEqual([]);
    for (const [, Component] of SECTIONS.slice(1)) {
      render(Component);
      expect(container.innerHTML).toBe("");
    }
  });
});

// ============================================================================
// Sparkline: the Edit Data hero
// ============================================================================

describe("Sparkline section", () => {
  it("is one tall hero in the band that opens the edit dialog", () => {
    render(SparklineEditSection);
    const hero = byTestId<HTMLButtonElement>("sparkline-edit-data");
    expect(hero.tagName).toBe("BUTTON");
    expect(hero.textContent).toBe("Edit Data");
    expect(hero.querySelector("svg")).not.toBeNull();
    expect(declared(hero, "height")).toBe("61px");
    click(hero);
    expect(showDialogMock).toHaveBeenCalledWith("sparkline:createDialog", {
      editGroupId: group().id,
      sparklineType: "line",
    });
  });

  it("is a standard 28px button in a panel", () => {
    render(SparklineEditSection, panelLayout(300));
    const button = byTestId<HTMLButtonElement>("sparkline-edit-data");
    expect(button.style.height).toBe("28px");
    expect(button.textContent).toBe("Edit Data");
  });
});

// ============================================================================
// Type: the Line | Column | Win/Loss pill
// ============================================================================

describe("Type section", () => {
  it("is a 61px radio pill of three icon-over-label options in the band", () => {
    render(SparklineTypeSection);
    const pill = byTestId("sparkline-type");
    expect(pill.getAttribute("role")).toBe("radiogroup");
    expect(pill.getAttribute("aria-label")).toBe("Sparkline type");
    expect(pill.getAttribute("data-size")).toBe("tall");
    expect(pill.style.height).toBe("61px");
    const radios = Array.from(pill.querySelectorAll<HTMLButtonElement>("[role='radio']"));
    expect(radios.map((r) => r.textContent)).toEqual(["Line", "Column", "Win/Loss"]);
    for (const r of radios) {
      expect(r.style.height).toBe("61px");
      expect(r.querySelector("svg")?.getAttribute("width")).toBe("28");
    }
    expect(radios.map((r) => r.getAttribute("aria-checked"))).toEqual(["true", "false", "false"]);
  });

  it("is a 28px pill with 20px icons in a panel", () => {
    render(SparklineTypeSection, panelLayout(300));
    const pill = byTestId("sparkline-type");
    expect(pill.getAttribute("data-size")).toBe("md");
    expect(byTestId("sparkline-type-line").querySelector("svg")?.getAttribute("width")).toBe("20");
  });

  it("a click changes the group's type, and the pill follows it", () => {
    render(SparklineTypeSection);
    click(byTestId("sparkline-type-column"));
    expect(group().type).toBe("column");
    expect(byTestId("sparkline-type-column").getAttribute("aria-checked")).toBe("true");
    click(byTestId("sparkline-type-winloss"));
    expect(group().type).toBe("winloss");
  });

  it("arrow keys move and choose, like any radio group", () => {
    render(SparklineTypeSection);
    key(byTestId("sparkline-type-line"), "ArrowRight");
    expect(group().type).toBe("column");
  });

  it("follows the selection to another sparkline on the next render", () => {
    createSparklineGroup(
      { startRow: 1, startCol: 5, endRow: 1, endCol: 5 },
      { startRow: 1, startCol: 0, endRow: 1, endCol: 4 },
      "winloss",
    );
    render(SparklineTypeSection);
    expect(byTestId("sparkline-type-line").getAttribute("aria-checked")).toBe("true");
    grid.selection = { startRow: 1, startCol: 5, endRow: 1, endCol: 5 };
    rerender();
    expect(byTestId("sparkline-type-winloss").getAttribute("aria-checked")).toBe("true");
    expect(byTestId("sparkline-type-line").getAttribute("aria-checked")).toBe("false");
  });
});

// ============================================================================
// Show: six checkboxes as three columns of two
// ============================================================================

const SHOW_BOXES: Array<[string, keyof SparklineGroup, string]> = [
  ["sparkline-show-high", "showHighPoint", "High Point"],
  ["sparkline-show-low", "showLowPoint", "Low Point"],
  ["sparkline-show-first", "showFirstPoint", "First Point"],
  ["sparkline-show-last", "showLastPoint", "Last Point"],
  ["sparkline-show-negative", "showNegativePoints", "Negative Points"],
  ["sparkline-show-markers", "showMarkers", "Markers"],
];

describe("Show section", () => {
  it("fills the band as two rows: three columns of two checkboxes", () => {
    render(SparklineShowSection);
    const row = container.firstElementChild as HTMLElement;
    const columns = Array.from(row.children) as HTMLElement[];
    expect(columns).toHaveLength(3);
    for (const column of columns) {
      expect(column.querySelectorAll("input[type='checkbox']")).toHaveLength(2);
      expect(column.style.gap).toBe("5px");
      expect(column.style.maxHeight).toBe("61px");
    }
    expect(columns.map((c) => c.textContent)).toEqual([
      "High PointLow Point",
      "First PointLast Point",
      "Negative PointsMarkers",
    ]);
  });

  it("is one list of six in a panel", () => {
    render(SparklineShowSection, panelLayout(300));
    const list = container.firstElementChild as HTMLElement;
    expect(list.children).toHaveLength(6);
  });

  it("each box is a real checkbox that writes its flag", () => {
    for (const [testId, field, label] of SHOW_BOXES) {
      render(SparklineShowSection);
      const input = byTestId<HTMLInputElement>(testId);
      expect(input.type).toBe("checkbox");
      expect(input.closest("label")?.textContent).toBe(label);
      expect(input.checked).toBe(false);
      act(() => input.click());
      expect(group()[field]).toBe(true);
      expect(byTestId<HTMLInputElement>(testId).checked).toBe(true);
    }
  });
});

// ============================================================================
// Style: the preset strip and the two colour pickers
// ============================================================================

describe("Style section", () => {
  it("fills the band as two rows: the preset strip over the pickers", () => {
    render(SparklineStyleSection);
    const stack = container.firstElementChild as HTMLElement;
    expect(stack.children).toHaveLength(2);
    expect(stack.style.gap).toBe("5px");
    expect(stack.children[0].querySelector("[role='radiogroup']")).not.toBeNull();
    expect(stack.children[1].querySelectorAll("[aria-haspopup='dialog']")).toHaveLength(2);
  });

  it("shows the presets as palettes of their own colours, the matching one checked", () => {
    render(SparklineStyleSection);
    const strip = container.querySelector("[role='radiogroup']") as HTMLElement;
    expect(strip.getAttribute("aria-label")).toBe("Sparkline style");
    const radios = Array.from(strip.querySelectorAll<HTMLButtonElement>("[role='radio']"));
    expect(radios.map((r) => r.getAttribute("aria-label"))).toEqual([
      "Style 1",
      "Style 2",
      "Style 3",
      "Style 4",
    ]);
    expect(radios[0].getAttribute("aria-checked")).toBe("true");
    const bars = Array.from(radios[1].querySelectorAll<HTMLElement>("[data-colour-data]"));
    expect(bars.map((b) => b.style.background)).toEqual([
      "rgb(237, 125, 49)",
      "rgb(237, 125, 49)",
      "rgb(217, 71, 53)",
    ]);
    expect(byTestId("sparkline-style-more")).not.toBeNull();
  });

  it("a preset applies its line, negative and marker colours", () => {
    render(SparklineStyleSection);
    click(byTestId("sparkline-style-style-2"));
    expect(group().color).toBe("#ED7D31");
    expect(group().negativeColor).toBe("#D94735");
    expect(group().markerColor).toBe("#ED7D31");
    expect(byTestId("sparkline-style-style-2").getAttribute("aria-checked")).toBe("true");
  });

  it("every preset is reachable from More styles", () => {
    render(SparklineStyleSection);
    // A strip of STYLES, not colour palettes: the overflow button and its
    // popover say so.
    const more = byTestId<HTMLButtonElement>("sparkline-style-more");
    expect(more.getAttribute("aria-label")).toBe("More styles");
    click(more);
    const list = byTestId<HTMLElement>("sparkline-style-list");
    const popover = list.closest("[data-section-flyout]") as HTMLElement;
    expect(popover.getAttribute("aria-label")).toBe("Sparkline styles");
    expect(popover.textContent).toContain("Sparkline styles");
    expect(popover.textContent).not.toContain("Colour palettes");
    const options = Array.from(document.querySelectorAll("[role='option']"));
    expect(options).toHaveLength(SPARKLINE_STYLE_PRESETS.length);
    click(byTestId("sparkline-style-option-style-7"));
    expect(group().color).toBe("#264478");
    expect(group().markerColor).toBe("#264478");
  });

  it("no preset is checked when the colours match none", () => {
    updateSparklineGroup(group().id, { color: "#123456" });
    render(SparklineStyleSection);
    const checked = container.querySelectorAll("[role='radio'][aria-checked='true']");
    expect(checked).toHaveLength(0);
  });

  it("the colour pickers show the group's colours as data and write them back", () => {
    updateSparklineGroup(group().id, { markerColor: "#70AD47" });
    render(SparklineStyleSection);
    const line = byTestId<HTMLButtonElement>("sparkline-color");
    const marker = byTestId<HTMLButtonElement>("sparkline-marker-color");
    expect(line.getAttribute("aria-label")).toBe("Sparkline Color");
    expect(marker.getAttribute("aria-label")).toBe("Marker Color");
    expect((line.querySelector("[data-colour-data]") as HTMLElement).style.background).toBe(
      "rgb(68, 114, 196)",
    );
    expect((marker.querySelector("[data-colour-data]") as HTMLElement).style.background).toBe(
      "rgb(112, 173, 71)",
    );

    click(marker);
    const popover = byTestId("sparkline-marker-color-popover");
    click(popover.querySelector("[aria-label][data-colour-swatch='4']") as HTMLElement);
    expect(group().markerColor).toBe("#dc2626");
    expect(group().color).toBe("#4472C4");
  });

  it("the marker picker falls back to the line colour when no marker colour is set", () => {
    updateSparklineGroup(group().id, { markerColor: "" });
    render(SparklineStyleSection);
    const marker = byTestId("sparkline-marker-color");
    expect((marker.querySelector("[data-colour-data]") as HTMLElement).style.background).toBe(
      "rgb(68, 114, 196)",
    );
  });
});

describe("SparklineColorPicker", () => {
  function Harness({ onChange }: { onChange: (c: string) => void }): React.ReactElement {
    return <SparklineColorPicker label="Sparkline Color" value="#4472C4" onChange={onChange} testId="pick" />;
  }

  it("is a labelled @api ColorSwatch: the label names and opens it", () => {
    act(() => {
      root.render(
        <SurfaceLayoutProvider value={bandLayout()}>
          <Harness onChange={() => undefined} />
        </SurfaceLayoutProvider>,
      );
    });
    const button = byTestId<HTMLButtonElement>("pick");
    const label = container.querySelector("label") as HTMLLabelElement;
    expect(label.textContent).toBe("Sparkline Color");
    expect(label.htmlFor).toBe(button.id);
    expect(button.getAttribute("aria-expanded")).toBe("false");
    expect(findHardcodedColours(container)).toEqual([]);
  });

  it("opens the sparkline colour list (no theme grid) and reports a pick", () => {
    const onChange = vi.fn();
    act(() => {
      root.render(
        <SurfaceLayoutProvider value={panelLayout(300)}>
          <Harness onChange={onChange} />
        </SurfaceLayoutProvider>,
      );
    });
    click(byTestId("pick"));
    const popover = byTestId("pick-popover");
    const swatches = Array.from(popover.querySelectorAll<HTMLElement>("[data-colour-swatch]"));
    expect(swatches).toHaveLength(SPARKLINE_PICKER_COLORS.length);
    expect(swatches).toHaveLength(60);
    expect(popover.textContent).not.toContain("Theme colours");
    expect(popover.textContent).toContain("Colours");
    expect(paletteMock).not.toHaveBeenCalled();
    // The popover chrome follows the skin too; only the swatches are data.
    expect(findHardcodedColours(popover)).toEqual([]);

    click(swatches[0]);
    expect(onChange).toHaveBeenCalledWith("#000000");
    expect(document.querySelector("[data-testid='pick-popover']")).toBeNull();
  });

  it("a typed hex is committed only when it is a whole colour", () => {
    const onChange = vi.fn();
    act(() => {
      root.render(
        <SurfaceLayoutProvider value={panelLayout(300)}>
          <Harness onChange={onChange} />
        </SurfaceLayoutProvider>,
      );
    });
    click(byTestId("pick"));
    const hex = byTestId<HTMLInputElement>("pick-popover-hex");
    typeValue(hex, "#12");
    expect(onChange).not.toHaveBeenCalled();
    typeValue(hex, "#123456");
    key(hex, "Enter");
    expect(onChange).toHaveBeenCalledWith("#123456");
  });
});

// ============================================================================
// Axis: columns of two, three value dropdowns, custom min/max
// ============================================================================

describe("Axis section", () => {
  it("fills the band as two rows: axis + scale, then empty cells + plot order", () => {
    render(SparklineAxisSection);
    const columns = Array.from((container.firstElementChild as HTMLElement).children) as HTMLElement[];
    expect(columns).toHaveLength(2);
    for (const column of columns) {
      expect(column.children).toHaveLength(2);
      expect(column.style.gap).toBe("5px");
    }
    expect(byTestId("sparkline-axis-scale").getAttribute("role")).toBe("combobox");
    expect(byTestId("sparkline-axis-scale").textContent).toBe("Auto");
    expect(byTestId("sparkline-axis-empty-cells").textContent).toBe("Zero");
    expect(byTestId("sparkline-axis-plot-order").textContent).toBe("Left to Right");
  });

  it("Show Axis is a real checkbox", () => {
    render(SparklineAxisSection);
    const input = byTestId<HTMLInputElement>("sparkline-axis-show");
    expect(input.type).toBe("checkbox");
    act(() => input.click());
    expect(group().showAxis).toBe(true);
  });

  it("choosing Custom scale adds a min/max column, and blank means auto", () => {
    render(SparklineAxisSection);
    expect(document.querySelector("[data-testid='sparkline-axis-min']")).toBeNull();
    choose("sparkline-axis-scale", "sparkline-axis-scale-custom");
    expect(group().axisScaleType).toBe("custom");

    const columns = Array.from((container.firstElementChild as HTMLElement).children);
    expect(columns).toHaveLength(3);
    const min = byTestId<HTMLInputElement>("sparkline-axis-min");
    const max = byTestId<HTMLInputElement>("sparkline-axis-max");
    expect(min.placeholder).toBe("auto");
    typeValue(min, "-5");
    expect(group().axisMinValue).toBe(-5);
    typeValue(max, "12.5");
    expect(group().axisMaxValue).toBe(12.5);
    typeValue(min, "");
    expect(group().axisMinValue).toBeNull();
  });

  it("empty-cell handling and plot order are value dropdowns", () => {
    render(SparklineAxisSection);
    choose("sparkline-axis-empty-cells", "sparkline-axis-empty-cells-gaps");
    expect(group().emptyCellHandling).toBe("gaps");
    choose("sparkline-axis-plot-order", "sparkline-axis-plot-order-rightToLeft");
    expect(group().plotOrder).toBe("rightToLeft");
    expect(byTestId("sparkline-axis-plot-order").textContent).toBe("Right to Left");
  });

  it("is one labelled list in a panel", () => {
    updateSparklineGroup(group().id, { axisScaleType: "custom" });
    render(SparklineAxisSection, panelLayout(300));
    const list = container.firstElementChild as HTMLElement;
    expect(list.children).toHaveLength(6);
    expect(byTestId("sparkline-axis-scale").style.width).toBe("100%");
  });
});

// ============================================================================
// Group: Group + Ungroup over Clear
// ============================================================================

describe("Group section", () => {
  it("fills the band as two 28px rows", () => {
    render(SparklineGroupSection);
    const rows = Array.from((container.firstElementChild as HTMLElement).children) as HTMLElement[];
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.textContent)).toEqual(["GroupUngroup", "Clear"]);
    for (const button of Array.from(container.querySelectorAll<HTMLButtonElement>("button"))) {
      expect(button.style.height).toBe("28px");
      expect(button.querySelector("svg")).not.toBeNull();
    }
  });

  it("Clear is the danger tone, not an inline colour, and removes the group", () => {
    render(SparklineGroupSection);
    const clear = byTestId<HTMLButtonElement>("sparkline-clear");
    expect(clear.style.color).toBe("");
    expect(declared(clear, "color")).toContain("--tone-danger-fg");
    click(clear);
    expect(getAllGroups()).toHaveLength(0);
  });

  it("Ungroup splits a group; Group merges the selection back", () => {
    resetSparklineStore();
    createSparklineGroup(
      { startRow: 0, startCol: 5, endRow: 2, endCol: 5 },
      { startRow: 0, startCol: 0, endRow: 2, endCol: 4 },
      "column",
    );
    grid.selection = { startRow: 0, startCol: 5, endRow: 2, endCol: 5 };
    render(SparklineGroupSection);
    click(byTestId("sparkline-ungroup"));
    expect(getAllGroups()).toHaveLength(3);
    rerender();
    click(byTestId("sparkline-group"));
    expect(getAllGroups()).toHaveLength(1);
  });
});

// ============================================================================
// Manifest
// ============================================================================

describe("SparklineDesignPanelDefinition", () => {
  it("keeps the tab label and gains a token accent", () => {
    expect(SparklineDesignPanelDefinition.id).toBe(SPARKLINE_DESIGN_TAB_ID);
    expect(SparklineDesignPanelDefinition.title).toBe("Sparkline");
    expect(SparklineDesignPanelDefinition.ribbonColor).toBe(
      "var(--tab-accent-sparkline, #c2410c)",
    );
    expect(SparklineDesignPanelDefinition.defaultPlacement).toBe("ribbon");
  });

  it("the panel icon is the Sparkline glyph at 20px", () => {
    const icon = SparklineDesignPanelDefinition.icon;
    expect(React.isValidElement(icon)).toBe(true);
    const el = icon as React.ReactElement<{ size: number }>;
    expect(el.type).toBe(RibbonIcon.Sparkline);
    expect(el.props.size).toBe(20);
  });

  it("every section keeps its id and carries a 24px RibbonIcon, never a glyph string", () => {
    const sections = SparklineDesignPanelDefinition.sections;
    expect(sections.map((s) => s.id)).toEqual([
      "sparkline-design.sparkline",
      "sparkline-design.type",
      "sparkline-design.show",
      "sparkline-design.style",
      "sparkline-design.axis",
      "sparkline-design.group",
    ]);
    expect(sections.map((s) => s.label)).toEqual([
      "Sparkline",
      "Type",
      "Show",
      "Style",
      "Axis",
      "Group",
    ]);
    const icons = new Set(Object.values(RibbonIcon) as unknown[]);
    for (const section of sections) {
      expect(typeof section.icon).not.toBe("string");
      expect(React.isValidElement(section.icon)).toBe(true);
      const el = section.icon as React.ReactElement<{ size: number }>;
      expect(icons.has(el.type)).toBe(true);
      expect(el.props.size).toBe(24);
    }
  });

  it("the icons render as token-painted SVG", () => {
    act(() => {
      root.render(
        <>
          {SparklineDesignPanelDefinition.icon}
          {SparklineDesignPanelDefinition.sections.map((s) => (
            <React.Fragment key={s.id}>{s.icon}</React.Fragment>
          ))}
        </>,
      );
    });
    expect(container.querySelectorAll("svg")).toHaveLength(7);
    expect(findHardcodedColours(container)).toEqual([]);
  });
});
