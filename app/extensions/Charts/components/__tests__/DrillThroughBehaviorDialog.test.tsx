//! FILENAME: app/extensions/Charts/components/__tests__/DrillThroughBehaviorDialog.test.tsx
// PURPOSE: The chart's "Drill-through behavior" dialog
//          (docs/design/model-drillthrough.md 2.9): seeded from the chart on
//          every show (None without a definition, Design query with one, the
//          draft starting from the chart's own query); Save writes the
//          definition CLEAR-then-SET inside ONE "Edit drill-through" undo step
//          with the repaint choreography and the flushed save; None removes it;
//          an unchanged definition writes nothing; an empty or non-compiling
//          query is refused and nothing is written; read-only shows the
//          definition with no Save and no radios.
// CONTEXT: The shared editor is doubled with a textarea plus a presentation
//          switch (its own tests pin its controls); the store, the renderer,
//          the Charts channel and the undo transaction are doubled so each test
//          is about what the dialog hands them.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

import type { ChartDefinition, ChartSpec } from "../../types";
import type { DrillThroughDefinition } from "@api/drillThrough";

const h = vi.hoisted(() => ({
  getChartById: vi.fn(),
  updateChartSpec: vi.fn(),
  syncChartRegions: vi.fn(),
  flushPendingChartSavesQuietly: vi.fn(),
  reportChartFailures: vi.fn(),
  invalidateChartCache: vi.fn(),
  invoke: vi.fn(),
  refusal: vi.fn(),
  transactions: [] as string[],
}));

vi.mock("../../lib/chartStore", () => ({
  getChartById: h.getChartById,
  updateChartSpec: h.updateChartSpec,
  syncChartRegions: h.syncChartRegions,
  flushPendingChartSavesQuietly: h.flushPendingChartSavesQuietly,
  reportChartFailures: h.reportChartFailures,
}));
vi.mock("../../rendering/chartRenderer", () => ({ invalidateChartCache: h.invalidateChartCache }));
vi.mock("../../lib/chartsBackend", () => ({ chartsBackend: { invoke: h.invoke } }));
vi.mock("../../lib/designQueryCommit", () => ({
  DESIGN_QUERY_MODEL_NOT_LOADED: "The BI model for this connection is not loaded. Open its connection first.",
  designQueryRefusal: (...a: unknown[]) => h.refusal(...a),
}));
vi.mock("@api/objectGeometry", () => ({
  runInUndoTransaction: async (label: string, fn: () => Promise<unknown> | unknown) => {
    h.transactions.push(label);
    return fn();
  },
}));
vi.mock("@api/dialogWindow", () => ({
  useDialogWindow: () => ({ ref: { current: null }, style: {}, onHeaderMouseDown: () => undefined, resizeHandles: null }),
}));
vi.mock("../../../_shared/drillThrough/DrillThroughDefinitionEditor", () => ({
  DrillThroughDefinitionEditor: (p: {
    value: DrillThroughDefinition;
    onChange: (next: DrillThroughDefinition) => void;
    readOnly?: boolean;
    connectionId: string;
    biModel: unknown;
    sourceLabel: string;
  }) =>
    React.createElement(
      "div",
      { "data-testid": "editor-stub", "data-readonly": p.readOnly ? "true" : "false", "data-connection": p.connectionId, "data-model": p.biModel ? "ready" : "none", "data-source": p.sourceLabel },
      React.createElement("textarea", {
        "data-testid": "editor-dsl",
        value: p.value.dslText,
        onChange: (e: React.ChangeEvent<HTMLTextAreaElement>) => p.onChange({ ...p.value, dslText: e.target.value }),
      }),
      React.createElement("input", {
        "data-testid": "editor-name",
        value: p.value.name ?? "",
        onChange: (e: React.ChangeEvent<HTMLInputElement>) => p.onChange({ ...p.value, name: e.target.value }),
      }),
      React.createElement(
        "button",
        {
          "data-testid": "editor-to-chart",
          onClick: () => p.onChange({ ...p.value, presentation: { kind: "chart", mark: "pie" } }),
        },
        "chart",
      ),
      // A presentation the result chart's createChart would refuse: a bar has
      // no innerRadius (BarMarkOptions is closed).
      React.createElement(
        "button",
        {
          "data-testid": "editor-to-bad-chart",
          onClick: () =>
            p.onChange({ ...p.value, presentation: { kind: "chart", mark: "bar", markOptions: { innerRadius: 0.4 } } }),
        },
        "bad chart",
      ),
      React.createElement("span", { "data-testid": "editor-presentation" }, p.value.presentation.kind),
    ),
}));

import {
  DRILL_THROUGH_EMPTY_QUERY,
  DRILL_THROUGH_UNDO_LABEL,
  DrillThroughBehaviorDialog,
  commitDrillThroughDefinition,
  drillDefinitionRefusal,
  normalizeDrillDefinition,
  sameDrillDefinition,
  startingDrillDraft,
} from "../DrillThroughBehaviorDialog";
import { ChartEvents } from "../../lib/chartEvents";
import { formatNumber } from "@api/locale";

// ----------------------------------------------------------------------------
// Fixtures
// ----------------------------------------------------------------------------

const MODEL = {
  tables: [{ name: "Geo", columns: [{ name: "Region", dataType: "string", isNumeric: false }] }],
  measures: [{ name: "Revenue", table: "Sales", sourceColumn: "amount", aggregation: "sum" }],
  connectionId: "conn-1",
};

const SOURCE_DSL = "ROWS: Geo.Region\nVALUES: [Revenue]";
const STORED: DrillThroughDefinition = {
  dslText: "ROWS: Product.Name\nVALUES: [Revenue]",
  presentation: { kind: "chart", mark: "bar" },
  name: "Product detail",
};

function chart(spec: Partial<ChartSpec> = {}): ChartDefinition {
  return {
    chartId: "c1",
    name: "Chart 1",
    sheetIndex: 0,
    x: 0,
    y: 0,
    width: 300,
    height: 200,
    spec: {
      mark: "bar",
      title: "Revenue by region",
      data: { type: "designQuery", dslText: SOURCE_DSL, connectionId: "conn-1" },
      series: [],
      ...spec,
    } as unknown as ChartSpec,
  };
}

const RANGE_CHART: ChartDefinition = {
  ...chart(),
  spec: { mark: "bar", data: { sheetIndex: 0, startRow: 0, startCol: 0, endRow: 3, endCol: 2 }, series: [] } as unknown as ChartSpec,
};

// ----------------------------------------------------------------------------
// Harness
// ----------------------------------------------------------------------------

let host: HTMLDivElement | null = null;
let root: Root | null = null;
const onClose = vi.fn();
let updatedEvents = 0;
const onUpdated = () => {
  updatedEvents += 1;
};

async function show(data: Record<string, unknown> = { chartId: "c1" }, isOpen = true): Promise<void> {
  if (!host) {
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
  }
  await act(async () => {
    root!.render(React.createElement(DrillThroughBehaviorDialog, { isOpen, onClose, data }));
  });
}

function q<T extends Element = HTMLElement>(sel: string): T | null {
  return host!.querySelector(sel) as T | null;
}

async function type(sel: string, text: string): Promise<void> {
  const el = q<HTMLTextAreaElement | HTMLInputElement>(sel)!;
  await act(async () => {
    const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, "value")!.set!.call(el, text);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

async function clickOn(sel: string): Promise<void> {
  const el = q<HTMLElement>(sel);
  if (!el) throw new Error(`no element for ${sel}`);
  await act(async () => {
    el.click();
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  h.transactions.length = 0;
  updatedEvents = 0;
  window.addEventListener(ChartEvents.CHART_UPDATED, onUpdated);
  h.getChartById.mockReturnValue(chart());
  h.flushPendingChartSavesQuietly.mockResolvedValue([]);
  h.refusal.mockReturnValue(null);
  h.invoke.mockImplementation(async (cmd: string) => {
    if (cmd === "get_connection_bi_model") return MODEL;
    throw new Error(cmd);
  });
});

afterEach(async () => {
  window.removeEventListener(ChartEvents.CHART_UPDATED, onUpdated);
  if (root) {
    const r = root;
    await act(async () => r.unmount());
  }
  root = null;
  host?.remove();
  host = null;
});

// ============================================================================
// Pure helpers
// ============================================================================

describe("the pure helpers", () => {
  it("normalizes a draft to its stored shape: name trimmed and dropped when blank, keepFilters kept only when false", () => {
    expect(normalizeDrillDefinition({ dslText: "ROWS: A", presentation: { kind: "table" }, name: "  ", keepFilters: true })).toEqual({
      dslText: "ROWS: A",
      presentation: { kind: "table" },
    });
    expect(normalizeDrillDefinition({ dslText: "ROWS: A", presentation: { kind: "table" }, name: " Detail ", keepFilters: false })).toEqual({
      dslText: "ROWS: A",
      presentation: { kind: "table" },
      name: "Detail",
      keepFilters: false,
    });
  });

  it("compares definitions by value, treating absent and undefined alike", () => {
    expect(sameDrillDefinition(undefined, undefined)).toBe(true);
    expect(sameDrillDefinition(STORED, { ...STORED })).toBe(true);
    expect(sameDrillDefinition(STORED, undefined)).toBe(false);
    expect(sameDrillDefinition(STORED, { ...STORED, name: "Other" })).toBe(false);
  });

  it("starts a NEW definition from the chart's own query as a table", () => {
    expect(startingDrillDraft(chart())).toEqual({ dslText: SOURCE_DSL, presentation: { kind: "table" } });
    expect(startingDrillDraft(RANGE_CHART)).toEqual({ dslText: "", presentation: { kind: "table" } });
    expect(startingDrillDraft(undefined)).toEqual({ dslText: "", presentation: { kind: "table" } });
  });

  it("drillDefinitionRefusal: null when the schema accepts; the limit named for a too-long query or name; the schema's reasons otherwise", () => {
    expect(drillDefinitionRefusal(STORED)).toBeNull();
    expect(drillDefinitionRefusal({ dslText: "x".repeat(20000), presentation: { kind: "table" } })).toBeNull();

    const limit = formatNumber(20000, { grouping: true });
    expect(drillDefinitionRefusal({ dslText: "x".repeat(20001), presentation: { kind: "table" } })).toBe(
      `The design query is longer than ${limit} characters. Shorten it to save the drill-through.`,
    );
    const nameLimit = formatNumber(80, { grouping: true });
    expect(drillDefinitionRefusal({ dslText: "ROWS: A.B", presentation: { kind: "table" }, name: "n".repeat(81) })).toBe(
      `The drill-through's name is longer than ${nameLimit} characters. Shorten it to save the drill-through.`,
    );
    const badMark = drillDefinitionRefusal({ dslText: "ROWS: A.B", presentation: { kind: "chart", mark: "bar-3d" } });
    expect(badMark).toContain("This drill-through cannot be saved:");
    expect(badMark).toContain("drillThrough.presentation.mark");
  });
});

// ============================================================================
// The write
// ============================================================================

describe("commitDrillThroughDefinition", () => {
  it("writes CLEAR then SET inside the Edit drill-through step, then repaints and flushes", async () => {
    await commitDrillThroughDefinition("c1", STORED);

    expect(h.transactions).toEqual([DRILL_THROUGH_UNDO_LABEL]);
    expect(h.updateChartSpec.mock.calls).toEqual([
      ["c1", { drillThrough: undefined }],
      ["c1", { drillThrough: STORED }],
    ]);
    expect(h.invalidateChartCache).toHaveBeenCalledWith("c1");
    expect(h.syncChartRegions).toHaveBeenCalled();
    expect(updatedEvents).toBe(1);
    expect(h.flushPendingChartSavesQuietly).toHaveBeenCalled();
  });

  it("None writes the clear alone", async () => {
    await commitDrillThroughDefinition("c1", undefined);
    expect(h.updateChartSpec.mock.calls).toEqual([["c1", { drillThrough: undefined }]]);
  });

  it("refuses a definition the schema refuses BEFORE the step opens: nothing is written", async () => {
    const limit = formatNumber(20000, { grouping: true });
    await expect(
      commitDrillThroughDefinition("c1", { dslText: "x".repeat(20001), presentation: { kind: "table" } }),
    ).rejects.toThrow(`longer than ${limit} characters`);
    await expect(
      commitDrillThroughDefinition("c1", {
        dslText: "ROWS: A.B",
        presentation: { kind: "chart", mark: "bar", markOptions: { innerRadius: 0.4 } },
      }),
    ).rejects.toThrow("unknown property 'innerRadius'");
    expect(h.transactions).toEqual([]);
    expect(h.updateChartSpec).not.toHaveBeenCalled();
    expect(h.flushPendingChartSavesQuietly).not.toHaveBeenCalled();
  });

  it("a refused save throws the backend's reason and repaints what the store rolled back to", async () => {
    h.flushPendingChartSavesQuietly.mockResolvedValue([
      { chartId: "c1", reason: "The sheet is protected." },
      { chartId: "other", reason: "elsewhere" },
    ]);
    await expect(commitDrillThroughDefinition("c1", STORED)).rejects.toThrow("The sheet is protected.");
    expect(h.reportChartFailures).toHaveBeenCalledWith([{ chartId: "other", reason: "elsewhere" }]);
    expect(h.invalidateChartCache).toHaveBeenCalledTimes(2);
    expect(updatedEvents).toBe(2);
  });
});

// ============================================================================
// The dialog
// ============================================================================

describe("DrillThroughBehaviorDialog", () => {
  it("seeds None for a chart without a definition, and the Design query draft from the chart's own query", async () => {
    await show();
    expect(q<HTMLInputElement>("[data-testid='drill-through-mode-none']")!.checked).toBe(true);
    expect(q("[data-testid='editor-stub']")).toBeNull();

    await clickOn("[data-testid='drill-through-mode-designQuery']");
    expect(q<HTMLTextAreaElement>("[data-testid='editor-dsl']")!.value).toBe(SOURCE_DSL);
    expect(q("[data-testid='editor-presentation']")!.textContent).toBe("table");
    // The model came over the Charts channel for the chart's connection.
    expect(h.invoke).toHaveBeenCalledWith("get_connection_bi_model", { connectionId: "conn-1" });
    expect(q("[data-testid='editor-stub']")!.getAttribute("data-model")).toBe("ready");
    expect(q("[data-testid='editor-stub']")!.getAttribute("data-connection")).toBe("conn-1");
    expect(q("[data-testid='editor-stub']")!.getAttribute("data-source")).toBe('the chart "Revenue by region"');
  });

  it("seeds Design query with the stored definition, and re-seeds on a re-show (no remount) of another chart", async () => {
    h.getChartById.mockImplementation((id: string) => (id === "c1" ? chart({ drillThrough: STORED }) : chart()));
    await show({ chartId: "c1", __openCount: 1 });
    expect(q<HTMLInputElement>("[data-testid='drill-through-mode-designQuery']")!.checked).toBe(true);
    expect(q<HTMLTextAreaElement>("[data-testid='editor-dsl']")!.value).toBe(STORED.dslText);
    expect(q("[data-testid='editor-presentation']")!.textContent).toBe("chart");

    // DialogContainer re-shows WITHOUT remounting: the props change, the state must follow.
    await show({ chartId: "c2", __openCount: 2 });
    expect(q<HTMLInputElement>("[data-testid='drill-through-mode-none']")!.checked).toBe(true);
  });

  it("Save writes the normalized definition (clear + set) in one undo step and closes", async () => {
    await show();
    await clickOn("[data-testid='drill-through-mode-designQuery']");
    await type("[data-testid='editor-dsl']", "ROWS: Product.Name\nVALUES: [Revenue]");
    await type("[data-testid='editor-name']", "  Product detail ");
    await clickOn("[data-testid='editor-to-chart']");
    await clickOn("[data-testid='drill-through-save']");

    expect(h.refusal).toHaveBeenCalledWith("ROWS: Product.Name\nVALUES: [Revenue]", "conn-1", MODEL);
    expect(h.transactions).toEqual([DRILL_THROUGH_UNDO_LABEL]);
    expect(h.updateChartSpec.mock.calls).toEqual([
      ["c1", { drillThrough: undefined }],
      [
        "c1",
        {
          drillThrough: {
            dslText: "ROWS: Product.Name\nVALUES: [Revenue]",
            presentation: { kind: "chart", mark: "pie" },
            name: "Product detail",
          },
        },
      ],
    ]);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("None on a chart with a definition removes it", async () => {
    h.getChartById.mockReturnValue(chart({ drillThrough: STORED }));
    await show();
    await clickOn("[data-testid='drill-through-mode-none']");
    await clickOn("[data-testid='drill-through-save']");
    expect(h.updateChartSpec.mock.calls).toEqual([["c1", { drillThrough: undefined }]]);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("an unchanged definition writes nothing and just closes", async () => {
    h.getChartById.mockReturnValue(chart({ drillThrough: STORED }));
    await show();
    await clickOn("[data-testid='drill-through-save']");
    expect(h.updateChartSpec).not.toHaveBeenCalled();
    expect(h.transactions).toEqual([]);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("refuses an empty query and a query the compiler refuses, writing nothing", async () => {
    await show();
    await clickOn("[data-testid='drill-through-mode-designQuery']");
    await type("[data-testid='editor-dsl']", "   ");
    await clickOn("[data-testid='drill-through-save']");
    expect(q("[data-testid='drill-through-error']")!.textContent).toBe(DRILL_THROUGH_EMPTY_QUERY);

    h.refusal.mockReturnValue("Line 1: Unknown field 'Nope.Field'");
    await type("[data-testid='editor-dsl']", "ROWS: Nope.Field");
    await clickOn("[data-testid='drill-through-save']");
    expect(q("[data-testid='drill-through-error']")!.textContent).toBe("Line 1: Unknown field 'Nope.Field'");
    expect(h.updateChartSpec).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
  });

  it("refuses a query longer than the schema's bound with a sentence naming the limit -- before compiling, nothing written", async () => {
    await show();
    await clickOn("[data-testid='drill-through-mode-designQuery']");
    await type("[data-testid='editor-dsl']", "x".repeat(20001));
    await clickOn("[data-testid='drill-through-save']");

    const limit = formatNumber(20000, { grouping: true });
    expect(q("[data-testid='drill-through-error']")!.textContent).toBe(
      `The design query is longer than ${limit} characters. Shorten it to save the drill-through.`,
    );
    // Refused by the dialog itself, ahead of the model's compile check.
    expect(h.refusal).not.toHaveBeenCalled();
    expect(h.transactions).toEqual([]);
    expect(h.updateChartSpec).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
  });

  it("refuses the too-long query with NO model at hand too (without the model nothing else checks the text)", async () => {
    h.invoke.mockImplementation(async (cmd: string) => {
      if (cmd === "get_connection_bi_model") return null;
      throw new Error(cmd);
    });
    await show();
    await clickOn("[data-testid='drill-through-mode-designQuery']");
    expect(q("[data-testid='editor-stub']")!.getAttribute("data-model")).toBe("none");
    await type("[data-testid='editor-dsl']", "x".repeat(20001));
    await clickOn("[data-testid='drill-through-save']");

    expect(q("[data-testid='drill-through-error']")!.textContent).toContain("longer than");
    expect(h.updateChartSpec).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
  });

  it("refuses a presentation the result chart's createChart would refuse (a bar with a pie's option), nothing written", async () => {
    await show();
    await clickOn("[data-testid='drill-through-mode-designQuery']");
    await clickOn("[data-testid='editor-to-bad-chart']");
    await clickOn("[data-testid='drill-through-save']");

    const error = q("[data-testid='drill-through-error']")!.textContent ?? "";
    expect(error).toContain("This drill-through cannot be saved:");
    expect(error).toContain("drillThrough.presentation.markOptions: unknown property 'innerRadius'");
    expect(h.refusal).not.toHaveBeenCalled();
    expect(h.updateChartSpec).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
  });

  it("shows a backend refusal of the save and stays open", async () => {
    h.flushPendingChartSavesQuietly.mockResolvedValue([{ chartId: "c1", reason: "The sheet is protected." }]);
    await show();
    await clickOn("[data-testid='drill-through-mode-designQuery']");
    await clickOn("[data-testid='drill-through-save']");
    expect(q("[data-testid='drill-through-error']")!.textContent).toBe("The sheet is protected.");
    expect(onClose).not.toHaveBeenCalled();
  });

  it("read-only shows the definition with the editor read-only, no radios and no Save", async () => {
    h.getChartById.mockReturnValue(chart({ drillThrough: STORED }));
    await show({ chartId: "c1", readOnly: true });
    expect(q("[data-testid='drill-through-dialog']")!.getAttribute("data-readonly")).toBe("true");
    expect(q("[data-testid='drill-through-mode-none']")).toBeNull();
    expect(q("[data-testid='drill-through-mode-designQuery']")).toBeNull();
    expect(q("[data-testid='drill-through-save']")).toBeNull();
    expect(q("[data-testid='editor-stub']")!.getAttribute("data-readonly")).toBe("true");
    expect(q<HTMLTextAreaElement>("[data-testid='editor-dsl']")!.value).toBe(STORED.dslText);
    expect(q("[data-testid='drill-through-cancel']")!.textContent).toBe("Close");
  });

  it("tells that a chart reading cells has no drill-through, with Save disabled", async () => {
    h.getChartById.mockReturnValue(RANGE_CHART);
    await show();
    expect(q("[data-testid='drill-through-not-design-query']")).not.toBeNull();
    expect(q<HTMLButtonElement>("[data-testid='drill-through-save']")!.disabled).toBe(true);
    expect(h.invoke).not.toHaveBeenCalled();
  });

  it("renders nothing while closed", async () => {
    await show({ chartId: "c1" }, false);
    expect(host!.textContent).toBe("");
  });
});
