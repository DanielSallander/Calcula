//! FILENAME: app/extensions/Slicer/components/__tests__/SlicerOptionsSections.test.tsx
// PURPOSE: The contextual Slicer tab's five sections on the Calcula Clusters
//          control grammar: what each renders in the ribbon band and in a
//          panel, that none of it paints a hardcoded colour, that each band
//          section fills the 61px content box one of the two sanctioned ways
//          (one tall row, or two 28px rows), and that the controls still DO
//          what they did — the dialogs, the delete, the column count, the
//          style, the show-header toggle — including the computed-property
//          lock, which is now a real `disabled` rather than a dimmed wrapper.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import {
  SurfaceLayoutProvider,
  bandLayout,
  panelLayout,
  findHardcodedColours,
  type SurfaceLayout,
} from "@api/layout";
import type { Slicer } from "../../lib/slicerTypes";

// ---------------------------------------------------------------------------
// Mocks — the sections' whole outside world
// ---------------------------------------------------------------------------

const mockShowDialog = vi.fn();
vi.mock("@api", () => ({
  showDialog: (...a: unknown[]) => mockShowDialog(...a),
}));

vi.mock("@api/gridOverlays", () => ({
  requestOverlayRedraw: vi.fn(),
}));

const mockUpdateSlicer = vi.fn(async (..._a: unknown[]) => undefined);
const mockUpdatePosition = vi.fn(async (..._a: unknown[]) => undefined);
const mockDeleteSlicer = vi.fn(async (..._a: unknown[]) => undefined);
vi.mock("../../lib/slicerStore", () => ({
  getSlicerById: () => undefined,
  updateSlicerAsync: (...a: unknown[]) => mockUpdateSlicer(...a),
  // The Size fields write every selected slicer as ONE undo step (M8 C2).
  commitSlicerGeometryAsync: (...a: unknown[]) => mockUpdatePosition(...a),
  deleteSlicerAsync: (...a: unknown[]) => mockDeleteSlicer(...a),
}));

vi.mock("../../manifest", () => ({
  SLICER_SETTINGS_DIALOG_ID: "slicer:settingsDialog",
  SLICER_COMPUTED_PROPS_DIALOG_ID: "slicer:computedPropsDialog",
  SLICER_CONNECTIONS_DIALOG_ID: "slicer:connectionsDialog",
}));

vi.mock("../../handlers/selectionHandler", () => ({
  broadcastSelectedSlicers: vi.fn(),
  getSelectedSlicerIds: () => new Set<string>(),
}));

let computedAttributes: string[] = [];
vi.mock("../../lib/slicer-api", () => ({
  getSlicerComputedAttributes: async () => computedAttributes,
}));

import {
  SlicerPropertiesSection,
  SlicerButtonsSection,
  SlicerStylesSection,
  SlicerSizeSection,
  SlicerActionsSection,
} from "../SlicerOptionsSections";
import { SlicerEvents } from "../../lib/slicerEvents";
import { SLICER_STYLES } from "../../lib/slicerStyles";

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
  vi.clearAllMocks();
  computedAttributes = [];
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  document.body.innerHTML = "";
});

function slicer(overrides: Partial<Slicer> = {}): Slicer {
  return {
    id: "s-1",
    name: "Region",
    headerText: null,
    sheetIndex: 0,
    x: 10,
    y: 10,
    width: 180,
    height: 240,
    sourceType: "table",
    cacheSourceId: "t-1",
    fieldName: "Region",
    selectedItems: null,
    showHeader: true,
    columns: 2,
    stylePreset: "slicer-light-2",
    selectionMode: "standard",
    hideNoData: false,
    indicateNoData: true,
    sortNoDataLast: true,
    forceSelection: false,
    showSelectAll: false,
    arrangement: "vertical",
    rows: 0,
    itemGap: 4,
    autogrid: false,
    itemPadding: 4,
    buttonRadius: 2,
    connectedSources: [],
    filterLevel: 1,
    ...overrides,
  } as Slicer;
}

type SectionComponent = (props: { placement: "ribbon" | "sidebar" }) => React.ReactElement;

/** Mount a section, then broadcast a selection to it (as the handler does). */
async function mount(
  Section: SectionComponent,
  layout: SurfaceLayout,
  selection: Slicer[] = [slicer()],
): Promise<void> {
  act(() => {
    root.render(
      <SurfaceLayoutProvider value={layout}>
        <Section placement={layout.container === "band" ? "ribbon" : "sidebar"} />
      </SurfaceLayoutProvider>,
    );
  });
  await act(async () => {
    window.dispatchEvent(new CustomEvent(SlicerEvents.SLICER_UPDATED, { detail: selection }));
    // Let the computed-attributes fetch resolve.
    await Promise.resolve();
    await Promise.resolve();
  });
}

function click(el: Element): void {
  act(() => {
    el.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
}

async function clickAsync(el: Element): Promise<void> {
  await act(async () => {
    el.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await Promise.resolve();
  });
}

function byLabel<T extends HTMLElement = HTMLElement>(label: string): T {
  const el = document.querySelector(`[aria-label="${label}"]`);
  if (!el) throw new Error(`no element labelled "${label}"`);
  return el as T;
}

function buttonByText(text: string): HTMLButtonElement {
  const btn = Array.from(container.querySelectorAll("button")).find(
    (b) => b.textContent?.trim() === text,
  );
  if (!btn) throw new Error(`no button with text "${text}"`);
  return btn;
}

/** The section's root element (SurfaceLayoutProvider renders no DOM). */
function sectionRoot(): HTMLElement {
  const el = container.firstElementChild;
  if (!el) throw new Error("section rendered nothing");
  return el as HTMLElement;
}

const SECTIONS: Array<[string, SectionComponent]> = [
  ["Properties", SlicerPropertiesSection],
  ["Buttons", SlicerButtonsSection],
  ["Slicer Styles", SlicerStylesSection],
  ["Size", SlicerSizeSection],
  ["Actions", SlicerActionsSection],
];

const LAYOUTS: Array<[string, SurfaceLayout]> = [
  ["band", bandLayout()],
  ["panel", panelLayout(300)],
];

// ============================================================================
// Chrome: tokens only, no hand-rolled controls
// ============================================================================

describe("Slicer Options sections — chrome", () => {
  for (const [sectionName, Section] of SECTIONS) {
    for (const [layoutName, layout] of LAYOUTS) {
      it(`${sectionName} paints no hardcoded colour in the ${layoutName}`, async () => {
        await mount(Section, layout);
        expect(container.childElementCount).toBeGreaterThan(0);
        expect(findHardcodedColours(container)).toEqual([]);
      });

      it(`${sectionName} renders no native <select> and no dimming wrapper in the ${layoutName}`, async () => {
        computedAttributes = ["headerText", "showHeader", "columns", "width", "height"];
        await mount(Section, layout);
        expect(container.querySelector("select")).toBeNull();
        expect(container.querySelector("option")).toBeNull();
        for (const el of Array.from(container.querySelectorAll<HTMLElement>("*"))) {
          expect(el.style.pointerEvents).not.toBe("none");
          expect(el.style.opacity).toBe("");
        }
      });
    }
  }

  it("the empty Properties state paints with tokens too", async () => {
    await mount(SlicerPropertiesSection, bandLayout(), []);
    act(() => {
      window.dispatchEvent(new CustomEvent("slicer:deselected"));
    });
    expect(container.textContent).toContain("Select a slicer to configure it.");
    expect(findHardcodedColours(container)).toEqual([]);
  });
});

// ============================================================================
// The fill rule: two 28px rows, or one tall row
// ============================================================================

describe("Slicer Options sections — the fill rule in the band", () => {
  it("Properties is two rows: the name, then the header text with its toggle", async () => {
    await mount(SlicerPropertiesSection, bandLayout());
    const rows = Array.from(sectionRoot().children) as HTMLElement[];
    expect(rows).toHaveLength(2);
    expect(rows[0].textContent).toContain("Name:");
    expect(rows[1].textContent).toContain("Header:");
    expect(rows[1].textContent).toContain("Show Header");
    expect(sectionRoot().style.gap).toBe("5px");
  });

  it("Size is two rows even though a two-child grid would not split on its own", async () => {
    await mount(SlicerSizeSection, bandLayout());
    const rows = Array.from(sectionRoot().children) as HTMLElement[];
    expect(rows).toHaveLength(2);
    expect(rows[0].textContent).toContain("Width:");
    expect(rows[1].textContent).toContain("Height:");
    expect(sectionRoot().style.gap).toBe("5px");
  });

  it("Buttons stacks its label over the dropdown as two 28px rows", async () => {
    await mount(SlicerButtonsSection, bandLayout());
    const rows = Array.from(sectionRoot().children) as HTMLElement[];
    expect(rows).toHaveLength(2);
    expect(rows[0].textContent).toBe("Columns:");
    expect(rows[1].querySelector('[role="combobox"]')).not.toBeNull();
    expect(sectionRoot().style.gap).toBe("5px");
  });

  it("Actions is one tall row of four heroes, drawn from the icon set", async () => {
    await mount(SlicerActionsSection, bandLayout());
    const buttons = Array.from(sectionRoot().querySelectorAll("button"));
    expect(buttons).toHaveLength(4);
    for (const b of buttons) {
      // A hero is the icon slot over the label: exactly two spans, the
      // first holding the icon set's 24-grid drawing at the hero size.
      const svg = b.querySelector("svg");
      expect(svg?.getAttribute("viewBox")).toBe("0 0 24 24");
      expect(svg?.getAttribute("width")).toBe("30");
    }
    expect(buttons.map((b) => b.textContent)).toEqual([
      "Settings",
      "Connections",
      "Computed",
      "Delete",
    ]);
  });

  it("Slicer Styles is the StyleGallery strip", async () => {
    await mount(SlicerStylesSection, bandLayout());
    const strip = container.querySelector('[data-testid="slicer-styles"]');
    expect(strip).not.toBeNull();
    expect(strip?.querySelectorAll('[role="option"]')).toHaveLength(4);
    expect(container.querySelector('[data-testid="slicer-styles-expand"]')).not.toBeNull();
  });
});

// ============================================================================
// Behaviour
// ============================================================================

describe("Slicer Options sections — behaviour", () => {
  it("Settings, Report Connections and Computed open their dialog for the slicer", async () => {
    await mount(SlicerActionsSection, bandLayout());
    click(buttonByText("Settings"));
    click(byLabel("Report Connections"));
    click(buttonByText("Computed"));
    expect(mockShowDialog.mock.calls).toEqual([
      ["slicer:settingsDialog", { slicerId: "s-1" }],
      ["slicer:connectionsDialog", { slicerId: "s-1" }],
      ["slicer:computedPropsDialog", { slicerId: "s-1" }],
    ]);
  });

  it("with several slicers selected the single-slicer commands are really disabled; Delete deletes them all", async () => {
    await mount(SlicerActionsSection, panelLayout(300), [slicer(), slicer({ id: "s-2", name: "Year" })]);
    expect(buttonByText("Settings").disabled).toBe(true);
    expect(byLabel<HTMLButtonElement>("Report Connections").disabled).toBe(true);
    expect(buttonByText("Computed").disabled).toBe(true);
    const del = buttonByText("Delete (2)");
    expect(del.disabled).toBe(false);
    await clickAsync(del);
    expect(mockDeleteSlicer.mock.calls.map((c) => c[0])).toEqual(["s-1", "s-2"]);
  });

  it("the column count is a Dropdown that writes to every selected slicer", async () => {
    await mount(SlicerButtonsSection, bandLayout(), [slicer(), slicer({ id: "s-2" })]);
    const trigger = byLabel<HTMLButtonElement>("Columns");
    expect(trigger.getAttribute("role")).toBe("combobox");
    expect(trigger.textContent).toContain("2");
    click(trigger);
    const option = Array.from(document.querySelectorAll('[role="option"]')).find(
      (o) => o.textContent?.trim() === "4",
    );
    expect(option).toBeDefined();
    await clickAsync(option!);
    expect(mockUpdateSlicer.mock.calls).toEqual([
      ["s-1", { columns: 4 }],
      ["s-2", { columns: 4 }],
    ]);
  });

  it("a mixed column count shows the dash", async () => {
    await mount(SlicerButtonsSection, bandLayout(), [slicer({ columns: 1 }), slicer({ id: "s-2", columns: 3 })]);
    expect(byLabel("Columns").textContent?.trim()).toBe("-");
  });

  it("a computed attribute is a real disabled control that explains itself", async () => {
    computedAttributes = ["headerText", "showHeader", "columns", "width", "height"];
    const explanation = "This attribute is controlled via computed properties";

    await mount(SlicerPropertiesSection, bandLayout());
    const inputs = Array.from(container.querySelectorAll<HTMLInputElement>("input"));
    const header = inputs.find((i) => i.type !== "checkbox" && i.title === explanation);
    expect(header?.disabled).toBe(true);
    const toggle = container.querySelector<HTMLInputElement>('input[type="checkbox"]');
    expect(toggle?.disabled).toBe(true);
    const describedBy = toggle?.getAttribute("aria-describedby") ?? "";
    expect(describedBy).not.toBe("");
    expect(document.getElementById(describedBy)?.textContent).toBe(explanation);

    await mount(SlicerButtonsSection, bandLayout());
    expect(byLabel<HTMLButtonElement>("Columns").disabled).toBe(true);
    expect(container.querySelector(`[title="${explanation}"]`)).not.toBeNull();

    await mount(SlicerSizeSection, bandLayout());
    const size = Array.from(container.querySelectorAll<HTMLInputElement>("input"));
    expect(size).toHaveLength(2);
    for (const i of size) {
      expect(i.disabled).toBe(true);
      expect(i.title).toBe(explanation);
    }
  });

  it("Show Header is a real checkbox: mixed is indeterminate, a click writes to every slicer", async () => {
    await mount(SlicerPropertiesSection, panelLayout(300), [
      slicer({ showHeader: true }),
      slicer({ id: "s-2", showHeader: false }),
    ]);
    const toggle = container.querySelector<HTMLInputElement>('input[type="checkbox"]')!;
    expect(toggle.indeterminate).toBe(true);
    await clickAsync(toggle);
    expect(mockUpdateSlicer.mock.calls).toEqual([
      ["s-1", { showHeader: true }],
      ["s-2", { showHeader: true }],
    ]);
  });

  it("choosing a style in the gallery writes the preset id", async () => {
    await mount(SlicerStylesSection, panelLayout(300));
    const selected = container.querySelector('[role="option"][aria-selected="true"]');
    expect(selected?.getAttribute("aria-label")).toBe("Light 2");
    const dark = container.querySelector('[data-testid="slicer-styles-slicer-dark-3"]');
    expect(dark).not.toBeNull();
    await clickAsync(dark!);
    expect(mockUpdateSlicer.mock.calls).toEqual([["s-1", { stylePreset: "slicer-dark-3" }]]);
  });

  it("the panel gallery lists every preset, grouped Light then Dark", async () => {
    await mount(SlicerStylesSection, panelLayout(300));
    const options = container.querySelectorAll('[role="option"]');
    expect(options).toHaveLength(SLICER_STYLES.length);
    const headings = Array.from(container.querySelectorAll('[role="group"]')).map(
      (g) => g.firstElementChild?.textContent,
    );
    expect(headings).toEqual(["Light", "Dark"]);
  });

  it("the width commits on blur and refuses a size below 60", async () => {
    await mount(SlicerSizeSection, panelLayout(300));
    const [width] = Array.from(container.querySelectorAll<HTMLInputElement>("input"));
    const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;

    act(() => {
      setValue.call(width, "40");
      width.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => {
      width.dispatchEvent(new FocusEvent("focusout", { bubbles: true }));
      await Promise.resolve();
    });
    expect(mockUpdatePosition).not.toHaveBeenCalled();
    expect(width.value).toBe("180");

    act(() => {
      setValue.call(width, "200");
      width.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => {
      width.dispatchEvent(new FocusEvent("focusout", { bubbles: true }));
      await Promise.resolve();
    });
    expect(mockUpdatePosition.mock.calls).toEqual([
      [[{ slicerId: "s-1", x: 10, y: 10, width: 200, height: 240 }], "Resize Slicer"],
    ]);
  });
});
