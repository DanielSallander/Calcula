//! FILENAME: app/extensions/ControlsPane/__tests__/controlsPaneClusters.test.tsx
// PURPOSE: The Controls tab after the Calcula Clusters rebuild — the ribbon
//          filter cards, the control cards and their bodies, the Add menu, the
//          filter checklist, the rename and Properties popovers and the two
//          Add dialogs — rendered on BOTH surfaces (band and panel) and held to
//          the redesign's promises:
//          - no hardcoded chrome colour anywhere they render (the Controls tab
//            was the biggest light-only surface left in Dark);
//          - the band fill rule: the strip is exactly the cluster's 61px box,
//            the cards keep their 56px "inline" height;
//          - no hand-rolled position:fixed z-10000 layer survives: every
//            overlay is an @api Popover (data-section-flyout);
//          - no unicode/emoji glyph icons, no native <select> in the band;
//          - behaviour kept: lazy item load, commit-once slider, rename error
//            inline, Delete, the connection-gated "Filter..." item.

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
import type { RibbonFilter, SlicerItem } from "../lib/filterPaneTypes";
import type { PaneControl, PaneItem } from "../lib/controlsPaneTypes";

// ============================================================================
// Doubles
// ============================================================================

const mocks = vi.hoisted(() => ({
  paneItems: [] as unknown[],
  connections: [] as Array<{ id: string; name: string; description: string }>,
  cachedItems: [] as unknown[],
  filterById: undefined as unknown,
  showDialog: vi.fn(),
  commitValue: vi.fn(),
  previewValue: vi.fn(),
  updateControlAsync: vi.fn(),
  deleteControlAsync: vi.fn(),
  updateFilterSelectionAsync: vi.fn(),
  deleteFilterAsync: vi.fn(),
  refreshFilterItems: vi.fn(),
  emitAppEvent: vi.fn(),
}));

vi.mock("@api", async () => {
  const icons = await vi.importActual<typeof import("@api/ribbonIcons")>("@api/ribbonIcons");
  return {
    RibbonIcon: icons.RibbonIcon,
    showDialog: mocks.showDialog,
    emitAppEvent: mocks.emitAppEvent,
    AppEvents: { GRID_REFRESH: "app:grid-refresh" },
    getSheets: async () => ({ sheets: [{ index: 0, name: "Sheet1" }] }),
    CellRange: { fromAddress: () => { throw new Error("no ranges in this test"); } },
    getShapeBitmap: () => null,
    hasShapeBitmapRenderer: () => false,
  };
});
vi.mock("@api/chartParams", () => ({
  setChartParamValue: () => undefined,
  listAnimatableCharts: () => [],
  listChartParams: () => [],
}));
vi.mock("@api/scriptableObjects", () => ({
  ObjectScriptManager: {
    getScript: () => null,
    registerScript: () => undefined,
    mountScript: async () => undefined,
  },
}));
vi.mock("@api/objectScriptBackend", () => ({ saveObjectScript: async () => undefined }));
vi.mock("../lib/controlsPaneStore", () => ({
  getPaneItems: () => mocks.paneItems,
  refreshControlsCache: async () => undefined,
  commitValue: mocks.commitValue,
  previewValue: mocks.previewValue,
  updateControlAsync: mocks.updateControlAsync,
  deleteControlAsync: mocks.deleteControlAsync,
  getAllControls: () => [],
  getControlById: () => null,
}));
vi.mock("../lib/filterPaneStore", () => ({
  getConnectionName: (id: string) =>
    id === "c1" ? "Sales model" : id === "c2" ? "Budget model" : undefined,
  refreshCache: async () => undefined,
  getCachedItems: () => mocks.cachedItems,
  refreshFilterItems: mocks.refreshFilterItems,
  updateFilterSelectionAsync: mocks.updateFilterSelectionAsync,
  deleteFilterAsync: mocks.deleteFilterAsync,
  getFilterById: () => mocks.filterById,
  updateFilterAsync: async () => null,
  getAllFilters: () => [],
  createFilterAsync: async () => undefined,
}));
vi.mock("../lib/filterPaneApi", () => ({
  getBiConnections: async () => mocks.connections,
  getAllSlicers: async () => [],
  getPivotsForBiConnection: async () => [],
  updateRibbonFilter: async () => undefined,
  getBiModelInfo: async () => ({
    tables: [{ name: "dim_customer", columns: [{ name: "city", dataType: "text" }] }],
  }),
}));
vi.mock("../lib/controlsPaneApi", () => ({ updatePaneControl: async () => undefined }));
vi.mock("../lib/filterPaneFilterBridge", () => ({ applyRibbonFilter: async () => undefined }));
vi.mock("../lib/filterPaneBackend", () => ({
  filterPaneBackend: { invoke: async () => undefined },
}));

import { ControlsPaneSection } from "../components/ControlsPaneSection";
import { RibbonFilterCard } from "../components/RibbonFilterCard";
import { ControlCard } from "../components/ControlCard";
import { AddItemMenu } from "../components/AddItemMenu";
import { CustomControlHost } from "../components/CustomControlHost";
import { AddControlDialog } from "../components/AddControlDialog";
import { AddFilterDialog } from "../components/AddFilterDialog";
import {
  ADD_CONTROL_DIALOG_ID,
  ADD_FILTER_DIALOG_ID,
  ControlsPanePanelDefinition,
} from "../manifest";
import { ToggleSwitch } from "../../Controls/PropertiesPane/ToggleSwitch";
import { SliderInput } from "../../Controls/PropertiesPane/SliderInput";

// ============================================================================
// Fixtures
// ============================================================================

function filterFixture(overrides: Partial<RibbonFilter> = {}): RibbonFilter {
  return {
    id: "f1",
    name: "dim_customer.city",
    connectionId: "c1",
    fieldName: "dim_customer.city",
    fieldDataType: "text",
    connectionMode: "workbook",
    connectedPivots: [],
    connectedSheets: [],
    displayMode: "dropdown" as RibbonFilter["displayMode"],
    selectedItems: null,
    crossFilterTargets: [],
    crossFilterSlicerTargets: [],
    advancedFilter: null,
    hideNoData: false,
    indicateNoData: true,
    sortNoDataLast: true,
    showSelectAll: false,
    singleSelect: false,
    order: 0,
    buttonColumns: 1,
    buttonRows: 1,
    filterLevel: 1,
    ...overrides,
  };
}

const ITEMS: SlicerItem[] = Array.from({ length: 12 }, (_, i) => ({
  value: `City ${i + 1}`,
  selected: false,
  hasData: i % 4 !== 3,
}));

const SLIDER: PaneControl = {
  id: "s1",
  name: "Rate",
  controlType: "slider",
  config: { type: "slider", min: 0, max: 100, step: 1, showValue: true },
  value: { kind: "number", value: 20 },
  order: 1,
};
const DROPDOWN: PaneControl = {
  id: "d1",
  name: "Region",
  controlType: "dropdown",
  config: {
    type: "dropdown",
    source: { type: "static", items: ["North", "South", "East"] },
    placeholder: null,
  },
  value: { kind: "text", value: "South" },
  order: 2,
};
const CHECKBOX: PaneControl = {
  id: "k1",
  name: "Include tax",
  controlType: "checkbox",
  config: { type: "checkbox", label: "Include tax" },
  value: { kind: "boolean", value: false },
  order: 3,
};
const BUTTON: PaneControl = {
  id: "b1",
  name: "Recalc",
  controlType: "button",
  config: { type: "button", label: "Recalculate" },
  value: null,
  order: 4,
};
const CUSTOM: PaneControl = {
  id: "x1",
  name: "Counter",
  controlType: "custom",
  config: { type: "custom", properties: {} },
  value: null,
  order: 5,
};

function allItems(): PaneItem[] {
  return [
    { kind: "filter", filter: filterFixture(), order: 0 },
    ...[SLIDER, DROPDOWN, CHECKBOX, BUTTON, CUSTOM].map(
      (c): PaneItem => ({ kind: "control", control: c, order: c.order }),
    ),
  ];
}

// ============================================================================
// Harness
// ============================================================================

let container: HTMLDivElement;
let root: Root;

const LAYOUTS: Array<[string, SurfaceLayout]> = [
  ["band", bandLayout()],
  ["panel", panelLayout(300)],
];

/** Emoji and the old unicode glyph icons (pin, ellipsis, triangles, x). */
const GLYPH_ICONS = /[\u{1F300}-\u{1FAFF}⋯▲▼✖]/u;

function render(node: React.ReactNode, layout: SurfaceLayout): void {
  act(() => {
    root.render(<SurfaceLayoutProvider value={layout}>{node}</SurfaceLayoutProvider>);
  });
}

async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
}

function click(el: Element): void {
  act(() => {
    el.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
  });
}

async function clickAsync(el: Element): Promise<void> {
  await act(async () => {
    el.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    await Promise.resolve();
    await Promise.resolve();
  });
}

function pressKey(target: EventTarget, key: string): void {
  act(() => {
    target.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }));
  });
}

function byTestId<T extends Element = HTMLElement>(id: string, scope: ParentNode = document): T {
  const el = scope.querySelector<T>(`[data-testid="${id}"]`);
  if (!el) throw new Error(`no ${id}`);
  return el;
}

/** Every open @api Popover in the document. */
function flyouts(): HTMLElement[] {
  return Array.from(document.querySelectorAll<HTMLElement>("[data-section-flyout]"));
}

/** No hand-rolled overlay: nothing positions itself at the old z-index. */
function legacyFixedLayers(): Element[] {
  return Array.from(document.querySelectorAll("[style]")).filter((el) => {
    const s = (el as HTMLElement).style;
    return s.position === "fixed" && (s.zIndex === "10000" || s.zIndex === "9999" || s.zIndex === "9998");
  });
}

/** Set a range/text input's value the way the browser does, then fire input. */
function typeInto(input: HTMLInputElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
  act(() => {
    setter?.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

beforeEach(() => {
  Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
  mocks.paneItems = [];
  mocks.connections = [];
  mocks.cachedItems = ITEMS;
  mocks.filterById = undefined;
  mocks.showDialog.mockReset();
  mocks.commitValue.mockReset().mockResolvedValue(undefined);
  mocks.previewValue.mockReset();
  mocks.updateControlAsync.mockReset().mockResolvedValue(SLIDER);
  mocks.deleteControlAsync.mockReset().mockResolvedValue(undefined);
  mocks.updateFilterSelectionAsync.mockReset();
  mocks.deleteFilterAsync.mockReset().mockResolvedValue(undefined);
  mocks.refreshFilterItems.mockReset().mockResolvedValue(undefined);
  mocks.emitAppEvent.mockReset();
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  document.body.innerHTML = "";
});

// ============================================================================
// The section
// ============================================================================

describe("ControlsPaneSection", () => {
  it.each(LAYOUTS)("renders every card kind token-painted in the %s", (_n, layout) => {
    mocks.paneItems = allItems();
    render(<ControlsPaneSection placement="ribbon" />, layout);

    expect(container.querySelectorAll('[data-pane-card="filter"]')).toHaveLength(1);
    expect(container.querySelectorAll('[data-pane-card="control"]')).toHaveLength(5);
    expect(byTestId("controls-pane-add", container)).toBeTruthy();
    // No OS-drawn select anywhere in the strip, no glyph icons.
    expect(container.querySelector("select")).toBeNull();
    expect(GLYPH_ICONS.test(container.textContent ?? "")).toBe(false);
    expect(findHardcodedColours(container)).toEqual([]);
  });

  it("band: the strip is exactly the cluster's 61px box, cards 56px, Add a 61px hero", () => {
    mocks.paneItems = allItems();
    render(<ControlsPaneSection placement="ribbon" />, bandLayout());

    expect(byTestId("controls-pane-strip", container).style.height).toBe("61px");
    for (const card of Array.from(container.querySelectorAll<HTMLElement>("[data-pane-card]"))) {
      expect(card.style.height).toBe("56px");
      expect(card.style.borderRadius).toContain("--radius-cluster");
    }
    // Every card still sits in its HTML5 drag wrapper.
    expect(container.querySelectorAll('[draggable="true"]')).toHaveLength(6);
    // The Add hero: icon over label, the label and nothing else as text.
    const add = byTestId<HTMLButtonElement>("controls-pane-add", container);
    expect(add.textContent).toBe("Add");
    expect(add.querySelector("svg")).not.toBeNull();
  });

  it("panel: grouped connection headers use the 12px/600 sentence-case recipe", () => {
    mocks.paneItems = [
      { kind: "filter", filter: filterFixture(), order: 0 },
      { kind: "filter", filter: filterFixture({ id: "f2", connectionId: "c2" }), order: 1 },
      { kind: "control", control: SLIDER, order: 2 },
    ];
    render(<ControlsPaneSection placement="sidebar" />, panelLayout(300));

    const header = Array.from(container.querySelectorAll<HTMLElement>("div")).find(
      (d) => d.textContent === "Budget model" && d.childElementCount === 0 && d.style.fontSize === "12px",
    );
    expect(header).toBeTruthy();
    expect(header?.style.fontWeight).toBe("600");
    expect(header?.style.textTransform).toBe("");
    expect(header?.style.letterSpacing).toBe("");
    expect(findHardcodedColours(container)).toEqual([]);
  });

  it("empty: the hint points at the Add button", () => {
    render(<ControlsPaneSection placement="ribbon" />, bandLayout());
    expect(container.textContent).toContain("Click Add to add filters and controls");
    expect(findHardcodedColours(container)).toEqual([]);
  });
});

// ============================================================================
// Ribbon filter card + checklist
// ============================================================================

describe("RibbonFilterCard", () => {
  it.each(LAYOUTS)("shows the summary as a Chip, token-painted, in the %s", (_n, layout) => {
    render(<RibbonFilterCard filter={filterFixture()} />, layout);

    const chip = byTestId("controls-pane-filter-summary", container);
    expect(chip.textContent).toBe("(All)");
    expect(container.textContent).toContain("city");
    expect(container.textContent).toContain("Sales model");
    expect(byTestId("controls-pane-filter-open", container).querySelector("svg")).not.toBeNull();
    expect(GLYPH_ICONS.test(container.textContent ?? "")).toBe(false);
    expect(findHardcodedColours(container)).toEqual([]);
  });

  it("a filtered card reads 'N of M', takes the pressed state, and a pin is an icon", () => {
    render(
      <RibbonFilterCard
        filter={filterFixture({ selectedItems: ["City 1", "City 2", "City 3"], filterLevel: 2 })}
      />,
      bandLayout(),
    );
    expect(byTestId("controls-pane-filter-summary", container).textContent).toBe("3 of 12");
    expect(container.querySelector('[data-pane-card="filter"]')?.getAttribute("data-filtered")).toBe(
      "true",
    );
    const pin = container.querySelector('[aria-label="Pinned filter (level 2)"]');
    expect(pin?.querySelector("svg")).not.toBeNull();
    expect(GLYPH_ICONS.test(container.textContent ?? "")).toBe(false);
    expect(findHardcodedColours(container)).toEqual([]);
  });

  it("a missing connection is named in the danger tone, not a literal red", () => {
    render(<RibbonFilterCard filter={filterFixture({ connectionId: "gone" })} />, bandLayout());
    expect(container.textContent).toContain("(connection missing)");
    expect(findHardcodedColours(container)).toEqual([]);
  });

  it("opens the checklist in a card Popover (lazy-loaded once), token-painted, toggles and closes on Escape", async () => {
    render(<RibbonFilterCard filter={filterFixture()} />, bandLayout());
    const open = byTestId<HTMLButtonElement>("controls-pane-filter-open", container);

    await clickAsync(open);
    expect(mocks.refreshFilterItems).toHaveBeenCalledTimes(1);
    const pops = flyouts();
    expect(pops).toHaveLength(1);
    const pop = pops[0];
    expect(pop.getAttribute("data-ribbon-content")).toBe("");
    expect(pop.querySelector('[data-testid="controls-pane-filter-dropdown"]')).not.toBeNull();
    expect(pop.textContent).toContain("City 12");
    expect(pop.textContent).toContain("Basic filtering");
    // More than eight values: the search box takes focus on open.
    expect(document.activeElement).toBe(pop.querySelector('input[aria-label="Search values"]'));
    expect(open.getAttribute("aria-expanded")).toBe("true");
    expect(legacyFixedLayers()).toEqual([]);
    expect(findHardcodedColours(pop)).toEqual([]);

    // The chevron toggles it shut (a press on the card is never "outside").
    await clickAsync(open);
    expect(flyouts()).toHaveLength(0);

    // Reopen: no second load; Escape closes.
    await clickAsync(open);
    expect(mocks.refreshFilterItems).toHaveBeenCalledTimes(1);
    expect(flyouts()).toHaveLength(1);
    pressKey(document, "Escape");
    expect(flyouts()).toHaveLength(0);
  });

  it("OK applies the selection; every sub-panel of the checklist is token-painted", async () => {
    render(<RibbonFilterCard filter={filterFixture()} />, bandLayout());
    await clickAsync(byTestId("controls-pane-filter-open", container));
    const pop = flyouts()[0];

    // Uncheck one value, then OK -> a 11-item selection is applied.
    const first = pop.querySelector<HTMLInputElement>('input[type="checkbox"]');
    expect(first).not.toBeNull();
    click(first!);
    const ok = Array.from(pop.querySelectorAll("button")).find((b) => b.textContent === "OK");
    expect(ok).toBeTruthy();

    for (const view of ["Connections", "Cross-filter", "Settings"]) {
      const btn = Array.from(flyouts()[0].querySelectorAll("button")).find(
        (b) => b.textContent === view,
      );
      expect(btn).toBeTruthy();
      await clickAsync(btn!);
      await flush();
      expect(findHardcodedColours(flyouts()[0])).toEqual([]);
      const cancel = Array.from(flyouts()[0].querySelectorAll("button")).filter(
        (b) => b.textContent === "Cancel",
      );
      click(cancel[cancel.length - 1]);
    }

    // Advanced mode (a restyled native select in a popover, not the band).
    const mode = flyouts()[0].querySelector<HTMLSelectElement>('select[aria-label="Filtering mode"]');
    expect(mode).not.toBeNull();
    act(() => {
      mode!.value = "advanced";
      mode!.dispatchEvent(new Event("change", { bubbles: true }));
    });
    expect(flyouts()[0].textContent).toContain("Show items when the value");
    expect(findHardcodedColours(flyouts()[0])).toEqual([]);

    act(() => {
      mode!.value = "basic";
      mode!.dispatchEvent(new Event("change", { bubbles: true }));
    });
    const ok2 = Array.from(flyouts()[0].querySelectorAll("button")).find((b) => b.textContent === "OK");
    click(ok2!);
    expect(mocks.updateFilterSelectionAsync).toHaveBeenCalledTimes(1);
    const [, selection] = mocks.updateFilterSelectionAsync.mock.calls[0];
    expect(selection).toHaveLength(11);
    expect(flyouts()).toHaveLength(0);
  });
});

// ============================================================================
// Control cards and their bodies
// ============================================================================

describe("ControlCard", () => {
  const renderCustom = (c: PaneControl) => <CustomControlHost control={c} embedded />;

  it.each(LAYOUTS)("every control kind renders token-painted in the %s", (_n, layout) => {
    render(
      <>
        {[SLIDER, DROPDOWN, CHECKBOX, BUTTON, CUSTOM].map((c) => (
          <ControlCard key={c.id} control={c} onEditCode={() => undefined} renderCustom={renderCustom} />
        ))}
      </>,
      layout,
    );
    expect(container.querySelectorAll('[data-pane-card="control"]')).toHaveLength(5);
    expect(container.querySelector('input[type="range"]')).not.toBeNull();
    expect(container.querySelector('[role="combobox"]')).not.toBeNull();
    expect(container.querySelector('input[type="checkbox"]')).not.toBeNull();
    expect(container.querySelector("select")).toBeNull();
    expect(GLYPH_ICONS.test(container.textContent ?? "")).toBe(false);
    expect(findHardcodedColours(container)).toEqual([]);
  });

  it("the options menu is an @api Menu in a card Popover: Rename / Edit code / Delete", async () => {
    render(<ControlCard control={BUTTON} onEditCode={() => undefined} />, bandLayout());
    const trigger = byTestId<HTMLButtonElement>("controls-pane-card-menu", container);
    expect(trigger.getAttribute("aria-label")).toBe("Control options");
    expect(trigger.getAttribute("aria-haspopup")).toBe("menu");

    click(trigger);
    const menu = document.querySelector('[role="menu"]');
    expect(menu).not.toBeNull();
    const labels = Array.from(menu!.querySelectorAll('[role="menuitem"]')).map((b) => b.textContent);
    expect(labels).toEqual(["Rename...", "Edit code...", "Delete"]);
    expect(legacyFixedLayers()).toEqual([]);
    expect(findHardcodedColours(flyouts()[0])).toEqual([]);

    const del = Array.from(menu!.querySelectorAll('[role="menuitem"]')).find(
      (b) => b.textContent === "Delete",
    );
    await clickAsync(del!);
    expect(mocks.deleteControlAsync).toHaveBeenCalledWith("b1");
  });

  it("a slider/dropdown/checkbox card offers no Edit code item", () => {
    render(<ControlCard control={SLIDER} onEditCode={() => undefined} />, bandLayout());
    click(byTestId("controls-pane-card-menu", container));
    const labels = Array.from(document.querySelectorAll('[role="menuitem"]')).map((b) => b.textContent);
    expect(labels).toEqual(["Rename...", "Delete"]);
  });

  it("Rename opens a token-painted popover; a backend rejection shows inline and keeps it open", async () => {
    mocks.updateControlAsync.mockResolvedValueOnce({ error: 'A control named "Region" already exists' });
    render(<ControlCard control={SLIDER} />, bandLayout());
    click(byTestId("controls-pane-card-menu", container));
    const rename = Array.from(document.querySelectorAll('[role="menuitem"]')).find(
      (b) => b.textContent === "Rename...",
    );
    click(rename!);

    const input = document.querySelector<HTMLInputElement>('input[aria-label="Control name"]');
    expect(input).not.toBeNull();
    expect(input!.value).toBe("Rate");
    expect(findHardcodedColours(flyouts()[0])).toEqual([]);

    typeInto(input!, "Region");
    await act(async () => {
      input!.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(mocks.updateControlAsync).toHaveBeenCalledWith("s1", { name: "Region" });
    expect(document.querySelector('[role="alert"]')?.textContent).toContain("already exists");
    expect(flyouts()).toHaveLength(1);

    // A good name closes it.
    typeInto(input!, "Rate 2");
    const ok = Array.from(flyouts()[0].querySelectorAll("button")).find((b) => b.textContent === "OK");
    await clickAsync(ok!);
    expect(mocks.updateControlAsync).toHaveBeenLastCalledWith("s1", { name: "Rate 2" });
    expect(flyouts()).toHaveLength(0);
  });

  it("the slider previews every step and commits once on release", () => {
    render(<ControlCard control={SLIDER} />, bandLayout());
    const range = container.querySelector<HTMLInputElement>('input[type="range"]')!;
    act(() => {
      range.dispatchEvent(new Event("pointerdown", { bubbles: true }));
    });
    typeInto(range, "30");
    typeInto(range, "40");
    expect(mocks.previewValue).toHaveBeenCalledTimes(2);
    expect(mocks.commitValue).not.toHaveBeenCalled();
    act(() => {
      range.dispatchEvent(new Event("pointerup", { bubbles: true }));
    });
    // A blur after the release is a duplicate end event: still one commit.
    act(() => {
      range.dispatchEvent(new FocusEvent("focusout", { bubbles: true }));
    });
    expect(mocks.commitValue).toHaveBeenCalledTimes(1);
    expect(mocks.commitValue).toHaveBeenCalledWith("s1", { kind: "number", value: 40 });
    // The readout is the primitive's monospace <output>.
    expect(container.querySelector("output")?.textContent).toBe("40");
  });

  it("the checkbox commits the new state at once", () => {
    render(<ControlCard control={CHECKBOX} />, panelLayout(300));
    const box = container.querySelector<HTMLInputElement>('input[type="checkbox"]')!;
    click(box);
    expect(mocks.commitValue).toHaveBeenCalledWith("k1", { kind: "boolean", value: true });
  });

  it("the dropdown is an @api Dropdown: a listbox in a card Popover, committing the pick", () => {
    render(<ControlCard control={DROPDOWN} />, bandLayout());
    const trigger = container.querySelector<HTMLButtonElement>('[role="combobox"]')!;
    expect(trigger.textContent).toBe("South");
    click(trigger);
    const list = document.querySelector('[role="listbox"]');
    expect(list).not.toBeNull();
    expect(list!.closest("[data-section-flyout]")).not.toBeNull();
    expect(legacyFixedLayers()).toEqual([]);
    expect(findHardcodedColours(flyouts()[0])).toEqual([]);

    click(byTestId("controls-pane-dropdown-option-East"));
    expect(mocks.commitValue).toHaveBeenCalledWith("d1", { kind: "text", value: "East" });
    expect(flyouts()).toHaveLength(0);
  });

  it("a committed value that is no longer in the list still shows on the trigger", () => {
    render(
      <ControlCard control={{ ...DROPDOWN, value: { kind: "text", value: "West" } }} />,
      bandLayout(),
    );
    expect(container.querySelector('[role="combobox"]')?.textContent).toBe("West");
  });

  it("an empty dropdown opens to a disabled 'No items' row", () => {
    render(
      <ControlCard
        control={{
          ...DROPDOWN,
          config: { type: "dropdown", source: { type: "static", items: [] }, placeholder: null },
          value: null,
        }}
      />,
      bandLayout(),
    );
    const trigger = container.querySelector<HTMLButtonElement>('[role="combobox"]')!;
    expect(trigger.textContent).toBe("Select...");
    click(trigger);
    const row = document.querySelector('[role="option"]');
    expect(row?.textContent).toBe("No items");
    expect(row?.getAttribute("aria-disabled")).toBe("true");
  });
});

// ============================================================================
// Custom control host (standalone card) + its Properties popover
// ============================================================================

describe("CustomControlHost", () => {
  it.each(LAYOUTS)("the standalone card is token-painted with icon buttons in the %s", (_n, layout) => {
    render(<CustomControlHost control={CUSTOM} />, layout);
    expect(container.querySelector('[aria-label="Properties"], button[title="Properties"]')).not.toBeNull();
    expect(GLYPH_ICONS.test(container.textContent ?? "")).toBe(false);
    expect(container.textContent).not.toContain("</>");
    expect(findHardcodedColours(container)).toEqual([]);
  });

  it("Properties opens a card Popover (no full-window overlay), token-painted", () => {
    render(<CustomControlHost control={CUSTOM} />, bandLayout());
    const props = container.querySelector<HTMLButtonElement>('[aria-label="Properties"]')!;
    click(props);
    const pops = flyouts();
    expect(pops).toHaveLength(1);
    expect(pops[0].textContent).toContain("Properties — Counter");
    expect(legacyFixedLayers()).toEqual([]);
    expect(findHardcodedColours(pops[0])).toEqual([]);
    click(props);
    expect(flyouts()).toHaveLength(0);
  });
});

// ============================================================================
// Add menu
// ============================================================================

describe("AddItemMenu", () => {
  it.each(LAYOUTS)("opens a token-painted @api Menu in the %s", (_n, layout) => {
    render(<AddItemMenu />, layout);
    click(byTestId("controls-pane-add", container));
    const menu = document.querySelector('[role="menu"]');
    expect(menu).not.toBeNull();
    const labels = Array.from(menu!.querySelectorAll('[role="menuitem"]')).map((b) => b.textContent);
    expect(labels).toEqual(["Filter...", "Button", "Slider", "Dropdown", "Checkbox", "Custom..."]);
    expect(legacyFixedLayers()).toEqual([]);
    expect(findHardcodedColours(container)).toEqual([]);
    expect(findHardcodedColours(flyouts()[0])).toEqual([]);
  });

  it("Filter... stays disabled without a model connection", async () => {
    render(<AddItemMenu />, bandLayout());
    click(byTestId("controls-pane-add", container));
    await flush();
    const filter = byTestId<HTMLButtonElement>("controls-pane-add-filter");
    expect(filter.disabled).toBe(true);
    expect(filter.title).toBe("Requires a model connection (Data > Business Intelligence)");
  });

  it("Filter... enables once a connection is confirmed and opens the Add Filter dialog", async () => {
    mocks.connections = [{ id: "c1", name: "Sales model", description: "" }];
    render(<AddItemMenu />, bandLayout());
    click(byTestId("controls-pane-add", container));
    await flush();
    const filter = byTestId<HTMLButtonElement>("controls-pane-add-filter");
    expect(filter.disabled).toBe(false);
    click(filter);
    expect(mocks.showDialog).toHaveBeenCalledWith(ADD_FILTER_DIALOG_ID);
    expect(flyouts()).toHaveLength(0);
  });

  it("a control kind opens the Add Control dialog pre-set to that type", () => {
    render(<AddItemMenu />, bandLayout());
    click(byTestId("controls-pane-add", container));
    click(byTestId("controls-pane-add-slider"));
    expect(mocks.showDialog).toHaveBeenCalledWith(ADD_CONTROL_DIALOG_ID, { controlType: "slider" });
  });
});

// ============================================================================
// Manifest + dialogs
// ============================================================================

describe("Controls panel definition", () => {
  it("carries a 20px panel icon and a 24px section icon, and is not contextual", () => {
    const def = ControlsPanePanelDefinition;
    expect(React.isValidElement(def.icon)).toBe(true);
    expect((def.icon as React.ReactElement<{ size: number }>).props.size).toBe(20);
    const section = def.sections[0];
    expect((section.icon as React.ReactElement<{ size: number }>).props.size).toBe(24);
    expect(section.ribbonPresentation).toBe("inline");
    expect(def.ribbonColor).toBeUndefined();
  });
});

describe("Add dialogs", () => {
  it("Add Control is token-painted and keeps its Cancel / Add Control actions", () => {
    render(
      <AddControlDialog isOpen onClose={() => undefined} data={{ controlType: "slider" }} />,
      panelLayout(300),
    );
    expect(container.textContent).toContain("Add Slider");
    const labels = Array.from(container.querySelectorAll("button")).map((b) => b.textContent);
    expect(labels).toContain("Cancel");
    expect(labels).toContain("Add Control");
    expect(container.querySelector('[aria-label="Close"]')?.querySelector("svg")).not.toBeNull();
    expect(findHardcodedColours(container)).toEqual([]);
  });

  it("Add Filter is token-painted", async () => {
    mocks.connections = [{ id: "c1", name: "Sales model", description: "" }];
    render(<AddFilterDialog isOpen onClose={() => undefined} />, panelLayout(300));
    await flush();
    await flush();
    expect(container.textContent).toContain("dim_customer.city");
    expect(findHardcodedColours(container)).toEqual([]);
  });
});

// ============================================================================
// Properties pane adapters
// ============================================================================

describe("PropertiesPane adapters", () => {
  it.each(LAYOUTS)("ToggleSwitch is an @api Switch in the %s", (_n, layout) => {
    const onChange = vi.fn();
    render(<ToggleSwitch checked={false} onChange={onChange} label="No" />, layout);
    const input = container.querySelector<HTMLInputElement>('input[role="switch"]');
    expect(input).not.toBeNull();
    click(input!);
    expect(onChange).toHaveBeenCalledWith(true);
    expect(container.textContent).toBe("No");
    expect(findHardcodedColours(container)).toEqual([]);
  });

  it.each(LAYOUTS)("SliderInput is an @api Slider + NumberField in the %s", (_n, layout) => {
    const onChange = vi.fn();
    const onCommit = vi.fn();
    render(
      <SliderInput value={50} min={0} max={100} step={1} onChange={onChange} onCommit={onCommit} />,
      layout,
    );
    const range = container.querySelector<HTMLInputElement>('input[type="range"]')!;
    const box = container.querySelector<HTMLInputElement>('input[type="number"]')!;
    expect(box.value).toBe("50");

    // A drag step previews AND commits, as the bare range did.
    typeInto(range, "60");
    expect(onChange).toHaveBeenLastCalledWith(60);
    expect(onCommit).toHaveBeenLastCalledWith(60);

    // The box commits on blur, clamped; typing alone commits nothing.
    onCommit.mockClear();
    act(() => box.focus());
    typeInto(box, "500");
    expect(onCommit).not.toHaveBeenCalled();
    act(() => box.blur());
    expect(onCommit).toHaveBeenCalledWith(100);

    expect(findHardcodedColours(container)).toEqual([]);
  });
});
