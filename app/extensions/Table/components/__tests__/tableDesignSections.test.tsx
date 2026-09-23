//! FILENAME: app/extensions/Table/components/__tests__/tableDesignSections.test.tsx
// PURPOSE: The Table Design panel on the Calcula Clusters control grammar.
// CONTEXT: Every section is rendered under the ribbon BAND and the sidebar
//          PANEL geometry and scanned for hardcoded chrome colours (the style
//          thumbnails are colour DATA inside `data-colour-data`, and skipped).
//          Beyond the look, three behaviours changed and are pinned here:
//
//          1. THE GALLERY WRITES THE TABLE. It used to hold the chosen style in
//             local React state and write nothing: a click highlighted a
//             thumbnail and the table never changed. Now a choice writes the
//             table's `styleName` and the highlight is DERIVED from what the
//             table stores.
//          2. THE JSON EDITOR IS A TASK PANE. The section drew a
//             `position: fixed` overlay; it now toggles the "table-json" pane.
//          3. NO NATIVE CHROME. No <select>, no `position: fixed`, no bare OS
//             checkbox styling: Checkbox, Button, CommandButton, StyleGallery.

/* eslint-disable @typescript-eslint/naming-convention --
 * The module doubles below stand in for the @api namespace objects
 * (RibbonIcon, AppEvents) and React components (the two dialogs, the section
 * under test), whose real names are PascalCase; React's own act() flag is
 * spelled IS_REACT_ACT_ENVIRONMENT. */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// ----------------------------------------------------------------------------
// Doubles
// ----------------------------------------------------------------------------

interface FakeTable {
  id: string;
  name: string;
  sheetIndex: number;
  startRow: number;
  startCol: number;
  endRow: number;
  endCol: number;
  columns: Array<{ id: string; name: string; totalsRowFunction: string }>;
  styleOptions: Record<string, boolean>;
  styleName: string;
}

const h = vi.hoisted(() => ({
  listeners: new Map<string, Set<(detail: unknown) => void>>(),
  emitted: [] as Array<[string, unknown]>,
  currentTable: null as unknown,
  selection: null as null | { startRow: number; startCol: number; endRow: number; endCol: number },
  paneOpen: false,
  paneIds: [] as string[],
  openTaskPane: vi.fn(),
  closeTaskPane: vi.fn(),
  showDialog: vi.fn(),
  confirmAsync: vi.fn(),
  updateTableStyle: vi.fn(),
  store: {
    updateTableStyleAsync: vi.fn(),
    toggleTotalsRowAsync: vi.fn(),
    convertToRangeAsync: vi.fn(),
    deleteTableAsync: vi.fn(),
    renameTableAsync: vi.fn(),
    resizeTableAsync: vi.fn(),
    refreshCache: vi.fn(() => Promise.resolve()),
  },
}));

const TABLE_STATE = "app:table-state";
const TABLE_REQUEST_STATE = "app:table-request-state";
const TABLE_DEFINITIONS_UPDATED = "app:table-definitions-updated";

function deliver(name: string, detail: unknown): void {
  h.listeners.get(name)?.forEach((cb) => cb(detail));
}

vi.mock("@api", async () => {
  const icons = await vi.importActual<typeof import("@api/ribbonIcons")>("@api/ribbonIcons");
  return {
    RibbonIcon: icons.RibbonIcon,
    AppEvents: {
      TABLE_CREATED: "app:table-created",
      TABLE_DEFINITIONS_UPDATED: "app:table-definitions-updated",
    },
    onAppEvent: (name: string, cb: (detail: unknown) => void) => {
      if (!h.listeners.has(name)) h.listeners.set(name, new Set());
      h.listeners.get(name)!.add(cb);
      return () => h.listeners.get(name)?.delete(cb);
    },
    emitAppEvent: (name: string, detail?: unknown) => {
      h.emitted.push([name, detail]);
      if (name === "app:table-request-state" && h.currentTable) {
        deliver("app:table-state", { table: h.currentTable });
      }
    },
    showDialog: (...a: unknown[]) => h.showDialog(...a),
    useGridState: () => ({ selection: h.selection }),
    openTaskPane: (...a: unknown[]) => h.openTaskPane(...a),
    closeTaskPane: (...a: unknown[]) => h.closeTaskPane(...a),
    useIsTaskPaneOpen: () => h.paneOpen,
    useTaskPaneOpenPaneIds: () => h.paneIds,
  };
});

vi.mock("@api/dialogs", () => ({
  confirmAsync: (...a: unknown[]) => h.confirmAsync(...a),
}));

vi.mock("@api/backend", () => ({
  updateTableStyle: (...a: unknown[]) => h.updateTableStyle(...a),
}));

vi.mock("@api/jsonView", () => ({
  getObjectJson: vi.fn(() => Promise.resolve("{}")),
  setObjectJson: vi.fn(() => Promise.resolve()),
}));

vi.mock("../../lib/tableStore", () => ({
  updateTableStyleAsync: (...a: unknown[]) => h.store.updateTableStyleAsync(...a),
  toggleTotalsRowAsync: (...a: unknown[]) => h.store.toggleTotalsRowAsync(...a),
  convertToRangeAsync: (...a: unknown[]) => h.store.convertToRangeAsync(...a),
  deleteTableAsync: (...a: unknown[]) => h.store.deleteTableAsync(...a),
  renameTableAsync: (...a: unknown[]) => h.store.renameTableAsync(...a),
  resizeTableAsync: (...a: unknown[]) => h.store.resizeTableAsync(...a),
  refreshCache: () => h.store.refreshCache(),
}));

// The manifest pulls in the two dialogs; they are not under test here.
vi.mock("../CreateTableDialog", () => ({ CreateTableDialog: () => null }));
vi.mock("../RemoveDuplicatesDialog", () => ({ RemoveDuplicatesDialog: () => null }));

import {
  SurfaceLayoutProvider,
  bandLayout,
  panelLayout,
  findHardcodedColours,
  type SurfaceLayout,
} from "@api/layout";
import type { PanelSectionProps } from "@api/uiTypes";
import {
  PropertiesSection,
  ToolsSection,
  StyleOptionsSection,
  JsonSection,
  StylesSection,
  TABLE_DESIGN_SECTIONS,
} from "../TableDesignTab";
import { TableDesignPanelDefinition, TableJsonPaneDefinition } from "../../manifest";

// ----------------------------------------------------------------------------
// Harness
// ----------------------------------------------------------------------------

function makeTable(overrides: Partial<FakeTable> = {}): FakeTable {
  return {
    id: "t1",
    name: "Sales",
    sheetIndex: 0,
    startRow: 0,
    startCol: 0,
    endRow: 4,
    endCol: 3,
    columns: [{ id: "c1", name: "Region", totalsRowFunction: "none" }],
    styleOptions: {
      headerRow: true,
      totalRow: false,
      bandedRows: true,
      bandedColumns: false,
      firstColumn: false,
      lastColumn: false,
      showFilterButton: true,
    },
    styleName: "TableStyleMedium2",
    ...overrides,
  };
}

const SECTION_PROPS = {} as PanelSectionProps;

let container: HTMLDivElement;
let root: Root;

function render(layout: SurfaceLayout, node: React.ReactElement): void {
  act(() => {
    root.render(<SurfaceLayoutProvider value={layout}>{node}</SurfaceLayoutProvider>);
  });
}

async function flush(): Promise<void> {
  await act(async () => {
    for (let i = 0; i < 5; i++) await Promise.resolve();
  });
}

function byTestId<T extends Element = HTMLElement>(id: string): T {
  const el = document.querySelector<T>(`[data-testid="${id}"]`);
  if (!el) throw new Error(`no element with data-testid="${id}"`);
  return el;
}

function buttonByText(text: string): HTMLButtonElement {
  const found = Array.from(container.querySelectorAll("button")).find(
    (b) => b.textContent?.trim() === text,
  );
  if (!found) throw new Error(`no button "${text}"`);
  return found;
}

function click(el: Element): void {
  act(() => {
    (el as HTMLElement).click();
  });
}

beforeEach(() => {
  h.listeners.clear();
  h.emitted.length = 0;
  h.currentTable = makeTable();
  h.selection = null;
  h.paneOpen = false;
  h.paneIds = [];
  h.openTaskPane.mockReset();
  h.closeTaskPane.mockReset();
  h.showDialog.mockReset();
  h.confirmAsync.mockReset();
  h.updateTableStyle.mockReset();
  for (const fn of Object.values(h.store)) fn.mockReset();
  h.store.refreshCache.mockImplementation(() => Promise.resolve());
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  document.body.innerHTML = "";
});

const SECTIONS: Array<[string, React.ComponentType<PanelSectionProps>]> = [
  ["Properties", PropertiesSection],
  ["Tools", ToolsSection],
  ["Table Style Options", StyleOptionsSection],
  ["JSON", JsonSection],
  ["Table Styles", StylesSection],
];

// ----------------------------------------------------------------------------
// Chrome: tokens only, no native/hand-rolled layers, on both surfaces
// ----------------------------------------------------------------------------

describe.each([
  ["band", bandLayout(900)],
  ["panel", panelLayout(300)],
])("every Table Design section in the %s", (_name, layout) => {
  it.each(SECTIONS)("%s paints with tokens only, and draws no native or fixed layer", (_label, Section) => {
    render(layout, <Section {...SECTION_PROPS} />);
    // (The band gallery is thumbnails only — no text — so count controls.)
    expect(
      container.querySelectorAll("button, input").length,
      "precondition: the section rendered its controls",
    ).toBeGreaterThan(0);
    expect(findHardcodedColours(container)).toEqual([]);
    expect(container.querySelector("select")).toBeNull();
    const fixed = Array.from(container.querySelectorAll<HTMLElement>("*")).filter(
      (el) => el.style.position === "fixed",
    );
    expect(fixed).toEqual([]);
  });
});

describe("the fill rule in the band", () => {
  it("Properties is TWO rows: the name field, then Resize Table", () => {
    render(bandLayout(900), <PropertiesSection {...SECTION_PROPS} />);
    const stack = container.firstElementChild as HTMLElement;
    expect(stack.children.length).toBe(2);
    expect(stack.children[0].querySelector("input")).not.toBeNull();
    expect(stack.children[1].textContent).toContain("Resize Table");
  });

  it("Tools and Style Options are two 28px rows filled column by column", () => {
    for (const Section of [ToolsSection, StyleOptionsSection]) {
      render(bandLayout(900), <Section {...SECTION_PROPS} />);
      const grid = container.firstElementChild as HTMLElement;
      const cs = getComputedStyle(grid);
      expect(cs.display).toBe("grid");
      expect(cs.gridAutoFlow).toBe("column");
      expect(cs.gridTemplateRows.replace(/\s+/g, "")).toBe("repeat(2,28px)");
    }
  });

  it("the JSON hero and the gallery strip are one 61px row each", () => {
    render(bandLayout(900), <JsonSection {...SECTION_PROPS} />);
    const hero = byTestId<HTMLButtonElement>("table-json-toggle");
    expect(hero.textContent).toBe("JSON");
    expect(getComputedStyle(hero).height).toBe("61px");

    render(bandLayout(900), <StylesSection {...SECTION_PROPS} />);
    expect(getComputedStyle(byTestId("table-styles")).height).toBe("61px");
  });
});

// ----------------------------------------------------------------------------
// Empty state
// ----------------------------------------------------------------------------

describe("with no table selected", () => {
  it("Properties explains itself and the other sections render nothing", () => {
    h.currentTable = null;
    render(bandLayout(900), <PropertiesSection {...SECTION_PROPS} />);
    expect(container.textContent).toBe("Select a Table to see design options");
    for (const Section of [ToolsSection, StyleOptionsSection, JsonSection, StylesSection]) {
      render(bandLayout(900), <Section {...SECTION_PROPS} />);
      expect(container.innerHTML).toBe("");
    }
  });
});

// ----------------------------------------------------------------------------
// Tools
// ----------------------------------------------------------------------------

describe("Tools", () => {
  it("keeps every command under its old label, each with an icon", () => {
    render(bandLayout(900), <ToolsSection {...SECTION_PROPS} />);
    for (const label of [
      "Summarize with PivotTable",
      "Remove Duplicates",
      "Insert Slicer",
      "Convert to Range",
      "Edit Script...",
      "Delete Table",
    ]) {
      expect(buttonByText(label).querySelector("svg"), label).not.toBeNull();
    }
  });

  it("Delete Table carries the danger tone (a token, not a literal)", () => {
    render(bandLayout(900), <ToolsSection {...SECTION_PROPS} />);
    const del = byTestId<HTMLButtonElement>("table-design-delete");
    const rules = Array.from(document.querySelectorAll("style"))
      .map((s) => s.textContent ?? "")
      .join("\n");
    const classes = del.className.split(/\s+/).filter(Boolean);
    const dangerRule = classes.some((c) =>
      new RegExp(`\\.${c}[^{]*\\{[^}]*var\\(--tone-danger-fg`).test(rules),
    );
    expect(dangerRule).toBe(true);
  });

  it("dispatches the same dialogs and store calls as before", async () => {
    h.store.deleteTableAsync.mockResolvedValue(true);
    render(bandLayout(900), <ToolsSection {...SECTION_PROPS} />);

    click(buttonByText("Summarize with PivotTable"));
    expect(h.showDialog).toHaveBeenCalledWith("pivot:createDialog", {
      selection: { startRow: 0, startCol: 0, endRow: 4, endCol: 3 },
      tableName: "Sales",
    });
    click(buttonByText("Insert Slicer"));
    expect(h.showDialog).toHaveBeenCalledWith("slicer:insertDialog", {
      sourceType: "table",
      sourceId: "t1",
    });
    click(buttonByText("Remove Duplicates"));
    expect(h.showDialog).toHaveBeenCalledWith(
      "table:removeDuplicatesDialog",
      expect.objectContaining({ table: expect.objectContaining({ id: "t1" }) }),
    );
    click(buttonByText("Edit Script..."));
    expect(h.emitted).toContainEqual([
      "scriptable-objects:edit-script",
      { objectType: "table", instanceId: "t1", objectName: "Sales" },
    ]);

    click(buttonByText("Delete Table"));
    await flush();
    expect(h.store.deleteTableAsync).toHaveBeenCalledWith("t1");
  });

  it("Convert to Range is refused when the confirm dialog says no (the Tauri Promise shape)", async () => {
    h.confirmAsync.mockReturnValue(Promise.resolve(false));
    render(bandLayout(900), <ToolsSection {...SECTION_PROPS} />);
    click(buttonByText("Convert to Range"));
    await flush();
    expect(h.confirmAsync).toHaveBeenCalledTimes(1);
    expect(h.store.convertToRangeAsync).not.toHaveBeenCalled();

    // Positive control: the same gesture with consent converts.
    h.confirmAsync.mockReturnValue(Promise.resolve(true));
    h.store.convertToRangeAsync.mockResolvedValue(true);
    click(buttonByText("Convert to Range"));
    await flush();
    expect(h.store.convertToRangeAsync).toHaveBeenCalledWith("t1");
  });
});

// ----------------------------------------------------------------------------
// Style options
// ----------------------------------------------------------------------------

describe("Table Style Options", () => {
  it("shows the seven flags as real checkboxes reflecting the table", () => {
    h.currentTable = makeTable({
      styleOptions: {
        headerRow: true,
        totalRow: false,
        bandedRows: true,
        bandedColumns: false,
        firstColumn: true,
        lastColumn: false,
        // showFilterButton absent: shown as on, as before
      },
    });
    render(panelLayout(300), <StyleOptionsSection {...SECTION_PROPS} />);
    const state = (key: string) => byTestId<HTMLInputElement>(`table-style-option-${key}`).checked;
    expect(container.querySelectorAll('input[type="checkbox"]').length).toBe(7);
    expect(state("headerRow")).toBe(true);
    expect(state("totalRow")).toBe(false);
    expect(state("bandedRows")).toBe(true);
    expect(state("bandedColumns")).toBe(false);
    expect(state("firstColumn")).toBe(true);
    expect(state("lastColumn")).toBe(false);
    expect(state("showFilterButton")).toBe(true);
  });

  it("Total Row goes through the totals-row command; the others through the style update", async () => {
    const updated = makeTable({ styleOptions: { ...makeTable().styleOptions, totalRow: true } });
    h.store.toggleTotalsRowAsync.mockResolvedValue(updated);
    h.store.updateTableStyleAsync.mockResolvedValue(makeTable());
    render(bandLayout(900), <StyleOptionsSection {...SECTION_PROPS} />);

    click(byTestId("table-style-option-totalRow"));
    await flush();
    expect(h.store.toggleTotalsRowAsync).toHaveBeenCalledWith("t1", true);
    expect(byTestId<HTMLInputElement>("table-style-option-totalRow").checked).toBe(true);
    expect(h.emitted.map(([n]) => n)).toContain(TABLE_DEFINITIONS_UPDATED);

    click(byTestId("table-style-option-bandedRows"));
    await flush();
    expect(h.store.updateTableStyleAsync).toHaveBeenCalledWith("t1", { bandedRows: false });
  });
});

// ----------------------------------------------------------------------------
// The gallery writes the table
// ----------------------------------------------------------------------------

describe("Table Styles", () => {
  it("highlights the style the TABLE stores, not a local default", () => {
    h.currentTable = makeTable({ styleName: "TableStyleDark3" });
    render(panelLayout(600), <StylesSection {...SECTION_PROPS} />);
    const selected = Array.from(container.querySelectorAll('[role="option"][aria-selected="true"]'));
    expect(selected.map((el) => el.getAttribute("aria-label"))).toEqual(["Dark 3"]);
  });

  it("an empty style name highlights None; an unknown one highlights nothing", () => {
    h.currentTable = makeTable({ styleName: "" });
    render(panelLayout(600), <StylesSection {...SECTION_PROPS} />);
    expect(
      container.querySelector('[role="option"][aria-selected="true"]')?.getAttribute("aria-label"),
    ).toBe("None");

    h.currentTable = makeTable({ styleName: "CompanyStyle" });
    act(() => root.unmount());
    root = createRoot(container);
    render(panelLayout(600), <StylesSection {...SECTION_PROPS} />);
    expect(container.querySelector('[role="option"][aria-selected="true"]')).toBeNull();
  });

  it("choosing a style WRITES the table's style name, and the highlight follows the table", async () => {
    h.updateTableStyle.mockImplementation(async (params: { styleName: string }) => ({
      success: true,
      table: makeTable({ styleName: params.styleName }),
    }));
    render(bandLayout(900), <StylesSection {...SECTION_PROPS} />);

    // The band strip starts from Excel's familiar Medium row, with the applied
    // Medium 2 among them — not None and Light 1, which lead the full grid.
    const strip = Array.from(
      byTestId("table-styles").querySelectorAll('[role="listbox"] [role="option"]'),
    ).map((el) => el.getAttribute("aria-label"));
    expect(strip).toEqual(["Medium 1", "Medium 2", "Medium 3"]);
    const medium2 = byTestId("table-styles-table-medium-2");
    expect(medium2.getAttribute("aria-selected")).toBe("true");

    click(byTestId("table-styles-table-medium-3"));
    await flush();
    expect(h.updateTableStyle).toHaveBeenCalledWith({ tableId: "t1", styleName: "TableStyleMedium3" });
    expect(h.store.refreshCache).toHaveBeenCalled();
    expect(h.emitted.map(([n]) => n)).toContain(TABLE_DEFINITIONS_UPDATED);
    expect(byTestId("table-styles-table-medium-3").getAttribute("aria-selected")).toBe("true");

    // The expanded gallery: every style, grouped; a choice there writes too.
    click(byTestId("table-styles-expand"));
    click(byTestId("table-styles-option-table-dark-3"));
    await flush();
    expect(h.updateTableStyle).toHaveBeenLastCalledWith({
      tableId: "t1",
      styleName: "TableStyleDark3",
    });
  });

  it("None clears the style (Excel's first tile replaces the old Clear footer)", async () => {
    h.updateTableStyle.mockResolvedValue({ success: true, table: makeTable({ styleName: "" }) });
    render(bandLayout(900), <StylesSection {...SECTION_PROPS} />);
    // None leads the full grid, not the strip.
    expect(document.querySelector('[data-testid="table-styles-table-none"]')).toBeNull();
    click(byTestId("table-styles-expand"));
    click(byTestId("table-styles-option-table-none"));
    await flush();
    expect(h.updateTableStyle).toHaveBeenCalledWith({ tableId: "t1", styleName: "" });
    // The applied None now takes the strip's last slot, selected.
    expect(byTestId("table-styles-table-none").getAttribute("aria-selected")).toBe("true");
  });

  it("a refused write changes nothing", async () => {
    h.updateTableStyle.mockResolvedValue({ success: false, error: "The sheet is protected" });
    render(bandLayout(900), <StylesSection {...SECTION_PROPS} />);
    click(byTestId("table-styles-table-medium-1"));
    await flush();
    expect(byTestId("table-styles-table-medium-2").getAttribute("aria-selected")).toBe("true");
    expect(h.emitted.map(([n]) => n)).not.toContain(TABLE_DEFINITIONS_UPDATED);
  });

  it("thumbnails are SVG colour DATA inside data-colour-data", () => {
    render(bandLayout(900), <StylesSection {...SECTION_PROPS} />);
    const svg = byTestId("table-styles-table-medium-2").querySelector("svg");
    expect(svg).not.toBeNull();
    expect(svg!.closest("[data-colour-data]")).not.toBeNull();
    // Medium 2 = the blue accent's header.
    expect(svg!.querySelector("rect")?.getAttribute("fill")).toBe("#4472c4");
  });
});

// ----------------------------------------------------------------------------
// JSON: a task pane, not a fixed overlay
// ----------------------------------------------------------------------------

describe("JSON", () => {
  it("the hero opens the table-json pane for THIS table", () => {
    render(bandLayout(900), <JsonSection {...SECTION_PROPS} />);
    const hero = byTestId<HTMLButtonElement>("table-json-toggle");
    expect(hero.getAttribute("aria-pressed")).toBe("false");
    click(hero);
    expect(h.openTaskPane).toHaveBeenCalledWith("table-json", { tableId: "t1", tableName: "Sales" });
    expect(h.closeTaskPane).not.toHaveBeenCalled();
  });

  it("while the pane shows, the hero is pressed and closes it", () => {
    h.paneOpen = true;
    h.paneIds = ["table-json"];
    render(bandLayout(900), <JsonSection {...SECTION_PROPS} />);
    const hero = byTestId<HTMLButtonElement>("table-json-toggle");
    expect(hero.getAttribute("aria-pressed")).toBe("true");
    click(hero);
    expect(h.closeTaskPane).toHaveBeenCalledWith("table-json");
    expect(h.openTaskPane).not.toHaveBeenCalled();
  });

  it("an open pane that is hidden (container closed) is not 'showing'", () => {
    h.paneOpen = false;
    h.paneIds = ["table-json"];
    render(bandLayout(900), <JsonSection {...SECTION_PROPS} />);
    expect(byTestId("table-json-toggle").getAttribute("aria-pressed")).toBe("false");
  });
});

// ----------------------------------------------------------------------------
// Registration
// ----------------------------------------------------------------------------

describe("the Table Design panel definition", () => {
  it("keeps its ids, label and collapse order, and every section has an icon", () => {
    expect(TABLE_DESIGN_SECTIONS.map((s) => [s.id, s.label, s.collapsePriority])).toEqual([
      ["table-design.properties", "Properties", 1],
      ["table-design.tools", "Tools", 2],
      ["table-design.styleOptions", "Table Style Options", 3],
      ["table-design.json", "JSON", 100],
      ["table-design.styles", "Table Styles", 200],
    ]);
    for (const section of TABLE_DESIGN_SECTIONS) {
      expect(React.isValidElement(section.icon), section.id).toBe(true);
    }
  });

  it("is the contextual 'Table Design' tab with a token accent and an icon", () => {
    expect(TableDesignPanelDefinition.title).toBe("Table Design");
    expect(TableDesignPanelDefinition.ribbonColor).toMatch(/^var\(--tab-accent-table, #[0-9a-f]{6}\)$/i);
    expect(React.isValidElement(TableDesignPanelDefinition.icon)).toBe(true);
  });

  it("registers the table-json pane on the 'table' context", () => {
    expect(TableJsonPaneDefinition.id).toBe("table-json");
    expect(TableJsonPaneDefinition.title).toBe("Table JSON");
    expect(TableJsonPaneDefinition.contextKeys).toEqual(["table"]);
    expect(React.isValidElement(TableJsonPaneDefinition.icon)).toBe(true);
  });
});

// The TABLE_STATE / TABLE_REQUEST_STATE names the doubles answer must be the
// real ones, or every section above would have rendered its empty state.
describe("harness", () => {
  it("answers the sections' state request with the current table", () => {
    render(bandLayout(900), <JsonSection {...SECTION_PROPS} />);
    expect(h.emitted.map(([n]) => n)).toContain(TABLE_REQUEST_STATE);
    expect(h.listeners.get(TABLE_STATE)?.size ?? 0).toBeGreaterThan(0);
  });
});
