//! FILENAME: app/extensions/_shared/drillThrough/__tests__/DrillThroughDefinitionEditor.test.tsx
// PURPOSE: The shared drill-through definition editor: its mark list is
//          DERIVED from the chart-mark registry (never hand-written) and
//          offers only the marks the Charts store seam says a drill chart can
//          be created with, the presentation and keep-filters controls write
//          the definition shape, and `readOnly` shows the query as text with
//          every control disabled.
// CONTEXT: docs/design/model-drillthrough.md 2.9. The shared Monaco editor is
//          stubbed with a textarea (real Monaco crashes jsdom; the Charts tests
//          stub their wrapper the same way) -- this file is about the editor's
//          OWN controls.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";

vi.mock("../../dsl/pivotLayout/DesignQueryEditor", () => ({
  DesignQueryEditor: (p: { value: string; onChange: (v: string) => void }) =>
    React.createElement("textarea", {
      "data-testid": "dsl-stub",
      value: p.value,
      onChange: (e: React.ChangeEvent<HTMLTextAreaElement>) => p.onChange(e.target.value),
    }),
}));

import {
  registerChartMark,
  registerChartStoreService,
  unregisterChartMark,
  listChartMarks,
  type DrillThroughDefinition,
  type IChartStoreService,
} from "@api";
import {
  DRILL_MARK_NOT_CREATABLE_HINT,
  DRILL_THROUGH_FILTERS_NOTE,
  DrillThroughDefinitionEditor,
  defaultDrillMark,
  drillMarkOptions,
  isDrillChartMarkCreatable,
} from "../DrillThroughDefinitionEditor";

const STUB_MARK = "drill_test_mark";
/** A consented sandbox mark: registered, but the ChartSpec mark pattern refuses its id. */
const SANDBOX_MARK = "sandbox:radial";

function registerMark(id: string, label: string): void {
  registerChartMark(id, {
    meta: { label, layoutFamily: "cartesian" },
    paint: () => undefined,
    computeLayout: () => ({}),
    computeGeometry: () => ({}),
  });
}

/**
 * The Charts store seam as this editor reaches it. Its validation stands in
 * for Charts' own (the ChartSpec mark pattern); the Charts suite pins the
 * real one. What is pinned HERE is that the editor ASKS the seam.
 */
const MARK_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;
const store = {
  buildDesignQueryChartSpec: vi.fn((req: { mark: string; dslText: string; connectionId: string; title: string }) => ({
    mark: req.mark,
    data: { type: "designQuery", dslText: req.dslText, connectionId: req.connectionId },
    title: req.title,
  })),
  validateChartSpec: vi.fn((spec: Record<string, unknown>) =>
    MARK_PATTERN.test(String(spec.mark)) ? [] : [`spec.mark: "${String(spec.mark)}" does not match the pattern`],
  ),
};

function registerStore(): void {
  registerChartStoreService({
    getChartById: () => null,
    listCharts: () => [],
    createChart: () => "x",
    deleteChart: () => false,
    updateChartSpec: () => undefined,
    replaceChartSpec: () => undefined,
    setStyleProperty: () => undefined,
    updateChartPlacement: () => undefined,
    buildDesignQueryChartSpec: store.buildDesignQueryChartSpec,
    validateChartSpec: store.validateChartSpec,
  } as unknown as IChartStoreService);
}

let container: HTMLDivElement;
let root: Root;

const invoke = vi.fn(<T,>(): Promise<T> => Promise.resolve({ rowCount: 0, colCount: 0 } as T));

function render(ui: React.ReactElement): void {
  act(() => {
    root.render(ui);
  });
}

function $(selector: string): HTMLElement {
  const el = container.querySelector<HTMLElement>(selector);
  if (!el) throw new Error(`no element for ${selector}`);
  return el;
}

const tableDef: DrillThroughDefinition = { dslText: "ROWS: Geo.Region\nVALUES: [Revenue]", presentation: { kind: "table" }, name: "By region" };

beforeEach(() => {
  Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  registerMark(STUB_MARK, "Drill Test");
  store.buildDesignQueryChartSpec.mockClear();
  store.validateChartSpec.mockClear();
  registerStore();
});

afterEach(() => {
  act(() => {
    root.unmount();
  });
  container.remove();
  unregisterChartMark(STUB_MARK);
  unregisterChartMark(SANDBOX_MARK);
});

describe("drillMarkOptions: derived from the mark registry, filtered by the Charts seam", () => {
  it("lists every registered mark the seam accepts, with its registry label, so a new mark appears without an edit here", () => {
    // SABOTAGE: a hand-written DRILL_CHART_MARKS list -- the stub mark never shows.
    const options = drillMarkOptions();
    expect(options.map((o) => o.value)).toEqual(listChartMarks().filter((m) => MARK_PATTERN.test(m)));
    expect(options.find((o) => o.value === STUB_MARK)).toEqual({ value: STUB_MARK, label: "Drill Test" });
  });

  it("never OFFERS a registered mark the ChartSpec refuses (a sandbox: id, a hyphenated id): every run would fail on it", () => {
    // SABOTAGE: offer every registered mark -- picking "Radial" saves a
    // definition whose every run is refused by createChart (review: the
    // editor offered an option that always fails).
    registerMark(SANDBOX_MARK, "Radial");
    registerMark("drill-hyphen-mark", "Hyphen");
    try {
      const offered = drillMarkOptions().map((o) => o.value);
      expect(listChartMarks()).toContain(SANDBOX_MARK);
      expect(offered).not.toContain(SANDBOX_MARK);
      expect(offered).not.toContain("drill-hyphen-mark");
      expect(offered).toContain(STUB_MARK);
      // The seam was ASKED about the sandbox mark, with a design-query spec.
      const asked = store.buildDesignQueryChartSpec.mock.calls.map((c) => c[0].mark);
      expect(asked).toContain(SANDBOX_MARK);
      expect(isDrillChartMarkCreatable(SANDBOX_MARK)).toBe(false);
      expect(isDrillChartMarkCreatable(STUB_MARK)).toBe(true);
    } finally {
      unregisterChartMark("drill-hyphen-mark");
    }
  });

  it("keeps a stored mark that is not registered here under its own id, rather than losing the choice", () => {
    const options = drillMarkOptions("vendorSankey");
    expect(options[options.length - 1]).toEqual({ value: "vendorSankey", label: "vendorSankey" });
    expect(drillMarkOptions(STUB_MARK).filter((o) => o.value === STUB_MARK)).toHaveLength(1);
  });

  it("a STORED mark the seam refuses is still shown -- disabled, with a hint -- never silently swapped", () => {
    registerMark(SANDBOX_MARK, "Radial");
    const options = drillMarkOptions(SANDBOX_MARK);
    expect(options.filter((o) => o.value === SANDBOX_MARK)).toEqual([
      { value: SANDBOX_MARK, label: "Radial", disabled: true, hint: DRILL_MARK_NOT_CREATABLE_HINT },
    ]);
    expect(drillMarkOptions("vendor.sankey").at(-1)).toEqual({
      value: "vendor.sankey",
      label: "vendor.sankey",
      disabled: true,
      hint: DRILL_MARK_NOT_CREATABLE_HINT,
    });
  });

  it("with no chart store (Charts not loaded) no mark can be created, and the default falls back to 'bar'", () => {
    registerChartStoreService(null as unknown as IChartStoreService);
    expect(drillMarkOptions()).toEqual([]);
    expect(isDrillChartMarkCreatable(STUB_MARK)).toBe(false);
    expect(defaultDrillMark()).toBe("bar");
  });

  it("a seam that throws hides the mark and says so in the console, never a crash", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    store.validateChartSpec.mockImplementationOnce(() => {
      throw new Error("schema not loaded");
    });
    try {
      expect(isDrillChartMarkCreatable(STUB_MARK)).toBe(false);
      expect(warn).toHaveBeenCalledTimes(1);
    } finally {
      warn.mockRestore();
    }
  });

  it("the default mark is 'bar' when the seam accepts it, else the first mark it accepts", () => {
    const accepted = listChartMarks().filter((m) => MARK_PATTERN.test(m));
    expect(defaultDrillMark()).toBe(accepted.includes("bar") ? "bar" : accepted[0]);
    registerMark(SANDBOX_MARK, "Radial");
    expect(defaultDrillMark()).not.toBe(SANDBOX_MARK);
  });
});

describe("DrillThroughDefinitionEditor", () => {
  it("shows the name, the query, the note and the source; switching to Chart writes a chart presentation with the default mark", () => {
    const onChange = vi.fn();
    render(
      <DrillThroughDefinitionEditor
        value={tableDef}
        onChange={onChange}
        connectionId="c1"
        biModel={null}
        invoke={invoke}
        sourceLabel='the chart "Sales by Category"'
      />,
    );
    expect(($("[data-testid=drill-through-name]") as HTMLInputElement).value).toBe("By region");
    expect(($("[data-testid=dsl-stub]") as HTMLTextAreaElement).value).toBe(tableDef.dslText);
    expect($("[data-testid=drill-through-note]").textContent).toBe(DRILL_THROUGH_FILTERS_NOTE);
    expect($("[data-testid=drill-through-source]").textContent).toContain('the chart "Sales by Category"');
    expect(container.querySelector("[data-testid=drill-through-mark]")).toBeNull();

    act(() => {
      $("[data-testid=drill-through-presentation-chart]").click();
    });
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange.mock.calls[0][0]).toEqual({ ...tableDef, presentation: { kind: "chart", mark: defaultDrillMark() } });
  });

  it("with a chart presentation the mark picker shows the stored mark; Keep filters unticked writes keepFilters: false", () => {
    const onChange = vi.fn();
    const def: DrillThroughDefinition = { ...tableDef, presentation: { kind: "chart", mark: STUB_MARK, markOptions: { a: 1 } } };
    render(
      <DrillThroughDefinitionEditor value={def} onChange={onChange} connectionId="c1" biModel={null} invoke={invoke} sourceLabel="the pivot" />,
    );
    expect($("[data-testid=drill-through-mark]").textContent).toContain("Drill Test");
    expect(container.querySelector("[data-testid=drill-through-mark-refused]")).toBeNull();
    const keep = $("[data-testid=drill-through-keep-filters]") as HTMLInputElement;
    expect(keep.checked).toBe(true);
    act(() => {
      keep.click();
    });
    expect(onChange).toHaveBeenCalledWith({ ...def, keepFilters: false });

    // Back to Table and to Chart again keeps the last chart choice.
    act(() => {
      $("[data-testid=drill-through-presentation-table]").click();
    });
    expect(onChange).toHaveBeenLastCalledWith({ ...def, presentation: { kind: "table" } });
  });

  it("a stored mark the Charts seam refuses is SAID under the picker", () => {
    registerMark(SANDBOX_MARK, "Radial");
    const def: DrillThroughDefinition = { ...tableDef, presentation: { kind: "chart", mark: SANDBOX_MARK } };
    render(<DrillThroughDefinitionEditor value={def} onChange={vi.fn()} connectionId="c1" biModel={null} invoke={invoke} sourceLabel="the chart" />);
    expect($("[data-testid=drill-through-mark-refused]").textContent).toBe(
      'The chart type "Radial" cannot be created for a drill-through result: choose another.',
    );
  });

  it("name and query edits write through onChange", () => {
    const onChange = vi.fn();
    render(
      <DrillThroughDefinitionEditor value={tableDef} onChange={onChange} connectionId="c1" biModel={null} invoke={invoke} sourceLabel="the pivot" />,
    );
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
    const name = $("[data-testid=drill-through-name]") as HTMLInputElement;
    act(() => {
      setter.call(name, "Detail");
      name.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(onChange).toHaveBeenLastCalledWith({ ...tableDef, name: "Detail" });
  });

  it("readOnly shows the query as text, disables every control and never calls onChange", () => {
    // SABOTAGE: render the live editor read-only by CSS alone -- a subscriber
    // could still change the text and nothing would stop a Save.
    const onChange = vi.fn();
    render(
      <DrillThroughDefinitionEditor
        value={{ ...tableDef, presentation: { kind: "chart", mark: "bar" } }}
        onChange={onChange}
        connectionId="c1"
        biModel={null}
        invoke={invoke}
        readOnly
        sourceLabel="the chart"
      />,
    );
    expect(container.querySelector("[data-testid=dsl-stub]")).toBeNull();
    expect($("[data-testid=drill-through-dsl-readonly]").textContent).toBe(tableDef.dslText);
    expect(($("[data-testid=drill-through-name]") as HTMLInputElement).disabled).toBe(true);
    expect(($("[data-testid=drill-through-keep-filters]") as HTMLInputElement).disabled).toBe(true);
    expect($("[data-testid=drill-through-source]").textContent).toMatch(/view only/);
    act(() => {
      $("[data-testid=drill-through-presentation-table]").click();
      $("[data-testid=drill-through-keep-filters]").click();
    });
    expect(onChange).not.toHaveBeenCalled();
  });
});
