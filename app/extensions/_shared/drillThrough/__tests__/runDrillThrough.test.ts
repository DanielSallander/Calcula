//! FILENAME: app/extensions/_shared/drillThrough/__tests__/runDrillThrough.test.ts
// PURPOSE: The drill-through runner: its pure parts (which page and standing
//          filters are baked, the caption, the title) and the ORDER of its
//          steps against doubled seams -- every check that can refuse BEFORE a
//          temporary sheet is left, the page's filters resolved while the
//          source page still exists, a dry run and the Charts seam's own spec
//          and validation before a chart's sheet is added, the shell switch
//          after the backend landed, one "sheets" refresh, what was not
//          carried told once AFTER landing -- and that every failure is ONE
//          toast and a `{ ok: false }`, never a silent no-op.
// CONTEXT: docs/design/model-drillthrough.md 2.4 / 2.7 / 2.8 and the review
//          round of 2026-10-23 (F1-F10). The backend is a recording fake
//          behind `io.invoke` (the caller's bound channel); the @api seams
//          are doubled partially over the real barrel; the strip's discard
//          command is doubled in its REAL shape (C7: resolves true once the
//          sheet is gone, false after toasting its own refusal).

import { describe, it, expect, beforeEach, vi, type Mock } from "vitest";

interface ChartStoreDouble {
  buildDesignQueryChartSpec: Mock<(req: Record<string, unknown>) => Record<string, unknown>>;
  validateChartSpec: Mock<(spec: Record<string, unknown>) => string[]>;
  createChart: Mock<(spec: Record<string, unknown>, placement?: Record<string, unknown>) => string>;
}

const h = vi.hoisted(() => ({
  sheets: { sheets: [] as Array<Record<string, unknown>>, activeIndex: 0 },
  getSheets: vi.fn<() => Promise<unknown>>(),
  execute: vi.fn<(id: string, args?: unknown) => Promise<unknown>>(),
  activateSheet: vi.fn<(index: number, opts?: { record?: boolean }) => Promise<unknown>>(),
  toasts: [] as Array<{ message: string; variant?: string }>,
  events: [] as Array<{ name: string; detail: unknown }>,
  chartStore: null as null | ChartStoreDouble,
  pageId: null as string | null,
  resolve: vi.fn(),
  published: [] as unknown[],
  /** Every step of every seam, in the order it happened. */
  log: [] as string[],
}));

vi.mock("@api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@api")>();
  return {
    ...actual,
    getSheets: () => {
      h.log.push("getSheets");
      return h.getSheets();
    },
    CommandRegistry: {
      ...actual.CommandRegistry,
      execute: (id: string, args?: unknown) => {
        h.log.push(id);
        return h.execute(id, args);
      },
    },
    activateSheet: (index: number, opts?: { record?: boolean }) => {
      h.log.push("activateSheet");
      return h.activateSheet(index, opts);
    },
    showToast: (message: string, options?: { variant?: string }) => {
      h.log.push(`toast:${options?.variant}`);
      h.toasts.push({ message, variant: options?.variant });
    },
    emitAppEvent: (name: string, detail: unknown) => {
      h.events.push({ name, detail });
    },
    getChartStoreService: () => h.chartStore,
    sheetIdAt: () => h.pageId,
  };
});

vi.mock("@api/reportFilters", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@api/reportFilters")>();
  return {
    ...actual,
    resolveFiltersFor: (...a: unknown[]) => {
      h.log.push("resolveFiltersFor");
      return h.resolve(...a);
    },
    getReportFilters: () => h.published,
  };
});

import { AppEvents, type DrillFilterSpec, type DrillThroughDefinition } from "@api";
import { getControlValue, registerControlValuesProvider } from "@api/controlValues";
import type { ReportFilter, ResolvedFieldFilter } from "@api/reportFilters";
import {
  DISCARD_EPHEMERAL_COMMAND,
  DRILL_CHART_PLACEMENT,
  TUPLE_FILTERS_NOTICE,
  activeTemporarySheetId,
  drillCaption,
  drillTitle,
  firstCompileErrorLine,
  isWorkbookWideFilter,
  pageFilterNotices,
  pageFiltersToSpecs,
  runDrillThrough,
  standingFiltersToSpecs,
  valueLessFilterFields,
  workbookWideFields,
  type DrillSource,
} from "../runDrillThrough";
import { compileDesignQuery } from "../../dsl/pivotLayout/designQuery";
import { substituteControlParams } from "../../dsl/pivotLayout/paramSubstitution";
import type { BiPivotModelInfo } from "../../components/types";

const col = (name: string) => ({ name, dataType: "string", isNumeric: false });
const biModel: BiPivotModelInfo = {
  tables: [
    { name: "Product", columns: [col("Category")] },
    { name: "Geo", columns: [col("Region")] },
  ],
  measures: [{ name: "Revenue" } as BiPivotModelInfo["measures"][number]],
  connectionId: "c1",
};

const source: DrillSource = { kind: "chart", id: "chart-1", sheetIndex: 2, connectionId: "c1", name: "Sales by Category" };
const pivotSource: DrillSource = { kind: "pivot", id: "pv-1", sheetIndex: 2, connectionId: "c1", name: "PivotTable1" };
const tableDef: DrillThroughDefinition = { dslText: "ROWS: Geo.Region\nVALUES: [Revenue]", presentation: { kind: "table" }, name: "By region" };
const chartDef: DrillThroughDefinition = {
  dslText: "ROWS: Geo.Region\nVALUES: [Revenue]",
  presentation: { kind: "chart", mark: "bar", markOptions: { stackMode: "stacked" } },
};
const bikes: DrillFilterSpec = { field: "Product.Category", includedKeys: ["Bikes"], labels: ["Bikes"] };
const CATEGORY_BIKES = { table: "Product", column: "Category", includedItems: ["Bikes"], hiddenItems: [] };

interface Call {
  command: string;
  args: Record<string, unknown> | undefined;
}

/** A recording backend: answers per command, or throws where the test says. */
function fakeBackend(overrides: Partial<Record<string, (args?: Record<string, unknown>) => unknown>> = {}) {
  const calls: Call[] = [];
  const answers: Record<string, (args?: Record<string, unknown>) => unknown> = {
    get_connection_bi_model: () => biModel,
    run_design_query: () => ({ rowCount: 3, colCount: 2 }),
    drill_through: () => ({ op: "toSheet", sheetIndex: 3, sheetName: "By region", sheetId: "S3", rowCount: 5, colCount: 2 }),
    ...overrides,
  };
  const invoke = <T,>(command: string, args?: Record<string, unknown>): Promise<T> => {
    calls.push({ command, args });
    h.log.push(command);
    const answer = answers[command];
    if (!answer) return Promise.reject(new Error(`unexpected command ${command}`));
    try {
      return Promise.resolve(answer(args) as T);
    } catch (e) {
      return Promise.reject(e);
    }
  };
  return { calls, io: { invoke } };
}

/** The Charts store seam: its OWN skeleton (marked), its validation, its creation. */
function chartStoreDouble(): ChartStoreDouble {
  return {
    buildDesignQueryChartSpec: vi.fn((req: Record<string, unknown>) => {
      h.log.push("buildDesignQueryChartSpec");
      return {
        mark: req.mark,
        ...(req.markOptions ? { markOptions: req.markOptions } : {}),
        data: { type: "designQuery", dslText: req.dslText, connectionId: req.connectionId },
        series: [],
        title: req.title,
        skeleton: "charts-owned",
      };
    }),
    validateChartSpec: vi.fn((_spec: Record<string, unknown>) => {
      h.log.push("validateChartSpec");
      return [] as string[];
    }),
    createChart: vi.fn((_spec: Record<string, unknown>, _placement?: Record<string, unknown>) => {
      h.log.push("createChart");
      return "chart-new";
    }),
  };
}

function resolved(filters: ResolvedFieldFilter[] = [], tupleFilters: unknown[] = []) {
  return { filters, tupleFilters, highlights: null, sources: [] };
}

function rff(field: string, includedKeys: string[], from: string, workbookWide = false): ResolvedFieldFilter {
  return { field, includedKeys, level: 1, from, workbookWide };
}

function published(partial: Partial<ReportFilter> & Pick<ReportFilter, "field" | "includedKeys" | "sourceName">): ReportFilter {
  return {
    publisher: "ribbonFilters",
    sourceId: "rf-1",
    sourceRef: null,
    scope: { kind: "all" },
    connectionId: "c1",
    filterLevel: 1,
    ...partial,
  } as ReportFilter;
}

/** The active sheet becomes a temporary one, E1 (a drill from a drill). */
function onTemporarySheet(): void {
  h.sheets.sheets.push({ index: 3, name: "Drill", visibility: "visible", sheetId: "E1", kind: "canvas", ephemeral: true });
  h.sheets.activeIndex = 3;
}

/** The strip's discard in its real shape (C7): the sheet goes, the active index moves, true. */
function discardLands(): void {
  h.execute.mockImplementation(async (_id: string, args?: unknown) => {
    const sheetId = (args as { sheetId: string }).sheetId;
    h.sheets.sheets = h.sheets.sheets.filter((s) => s.sheetId !== sheetId);
    h.sheets.activeIndex = 2;
    return true;
  });
}

/** A refused discard in its real shape (C7): ONE toast of its own, the sheet stays, false. */
function discardRefused(message: string): void {
  h.execute.mockImplementation(async () => {
    h.toasts.push({ message, variant: "warning" });
    return false;
  });
}

/** The steps of the log that matter for an order assertion. */
function steps(...keep: string[]): string[] {
  return h.log.filter((s) => keep.includes(s));
}

const ORDER_STEPS = [
  "get_connection_bi_model",
  "resolveFiltersFor",
  "run_design_query",
  "buildDesignQueryChartSpec",
  "validateChartSpec",
  DISCARD_EPHEMERAL_COMMAND,
  "drill_through",
  "activateSheet",
  "createChart",
];

beforeEach(() => {
  h.sheets = {
    sheets: [
      { index: 0, name: "Data", visibility: "visible", sheetId: "S0", kind: "worksheet" },
      { index: 2, name: "Page", visibility: "visible", sheetId: "S2", kind: "canvas" },
    ],
    activeIndex: 2,
  };
  h.getSheets.mockReset();
  h.getSheets.mockImplementation(() => Promise.resolve(JSON.parse(JSON.stringify(h.sheets))));
  h.execute.mockReset();
  discardLands();
  h.activateSheet.mockReset();
  h.activateSheet.mockResolvedValue({ sheets: [], activeIndex: 3 });
  h.toasts = [];
  h.events = [];
  h.chartStore = chartStoreDouble();
  h.pageId = null;
  h.resolve.mockReset();
  h.resolve.mockReturnValue(resolved());
  h.published = [];
  h.log = [];
});

// ----------------------------------------------------------------------------
// Pure parts
// ----------------------------------------------------------------------------

describe("page filters", () => {
  const fromAll = rff("Geo.Region", ["E"], "Ribbon Region", true);
  const fromPage = rff("Product.Category", ["Bikes"], "Slicer");

  it("isWorkbookWideFilter reads the resolver's flag, never a name, field or keys", () => {
    // SABOTAGE: match the published list by source name, field and keys -- a
    // page slicer renamed "Region" over the same keys as a workbook ribbon
    // filter "Region" is then dropped from a chart bake it belongs in (F8).
    expect(isWorkbookWideFilter(fromAll)).toBe(true);
    expect(isWorkbookWideFilter(fromPage)).toBe(false);
    const pageNamedLikeRibbon = rff("Geo.Region", ["E"], "Ribbon Region", false);
    expect(isWorkbookWideFilter(pageNamedLikeRibbon)).toBe(false);
  });

  it("the CHART presentation leaves workbook-wide filters out (they re-apply live on the new page); the TABLE bakes them", () => {
    // SABOTAGE: bake them for the chart too -- when the ribbon filter later
    // moves, the kept chart shows the intersection of the snapshot and the
    // live filter, which is neither.
    expect(pageFiltersToSpecs([fromAll, fromPage], { presentation: "chart" })).toEqual([
      { field: "Product.Category", includedKeys: ["Bikes"] },
    ]);
    expect(pageFiltersToSpecs([fromAll, fromPage], { presentation: "table" })).toEqual([
      { field: "Geo.Region", includedKeys: ["E"] },
      { field: "Product.Category", includedKeys: ["Bikes"] },
    ]);
  });

  it("a page slicer that shares a workbook filter's name, field and keys is still baked into a chart (F8)", () => {
    const ribbon = rff("Geo.Region", ["East"], "Region", true);
    const slicer = rff("Geo.Region", ["East"], "Region", false);
    expect(pageFiltersToSpecs([ribbon, slicer], { presentation: "chart" })).toEqual([{ field: "Geo.Region", includedKeys: ["East"] }]);
  });

  it("an empty inclusion is kept as such, so the merge refuses it with its message", () => {
    expect(pageFiltersToSpecs([{ ...fromPage, includedKeys: [] }], { presentation: "table" })).toEqual([
      { field: "Product.Category", includedKeys: [] },
    ]);
  });

  it("tuple selections are a notice, not a spec", () => {
    expect(pageFilterNotices({ tupleFilters: [] })).toEqual([]);
    expect(pageFilterNotices({ tupleFilters: [{ fields: ["A", "B"], tuples: [["1", "2"]], from: "Chart 2" }] })).toEqual([TUPLE_FILTERS_NOTICE]);
  });
});

describe("standing filters", () => {
  const allRegion = published({ sourceName: "Region", field: "geo.region", includedKeys: ["E"] });
  const pageYear = published({ sourceName: "Year", field: "Date.Year", includedKeys: ["2024"], scope: { kind: "page", sheetId: "S2" }, sourceId: "rf-2" });
  const otherConn = published({ sourceName: "Cat", field: "Product.Category", includedKeys: ["Bikes"], connectionId: "c2", sourceId: "rf-3" });

  it("workbookWideFields: the lower-cased fields of all-scoped publications on THIS connection only", () => {
    expect([...workbookWideFields("c1", [allRegion, pageYear, otherConn])]).toEqual(["geo.region"]);
    expect([...workbookWideFields("c2", [allRegion, pageYear, otherConn])]).toEqual(["product.category"]);
  });

  it("a CHART drops a standing filter on a field a workbook-wide filter of the same connection filters; a TABLE keeps everything", () => {
    // SABOTAGE: keep every standing spec for the chart -- a workbook ribbon
    // filter the backend wrote into the pivot is baked into the kept chart,
    // and once the ribbon filter moves the chart shows the intersection (F2).
    const standing: DrillFilterSpec[] = [
      { field: "Geo.Region", hiddenKeys: ["W", "N"] },
      { field: "Date.Year", includedKeys: ["2024"] },
      { field: "Product.Category", hiddenKeys: ["Toys"] },
    ];
    const opts = { connectionId: "c1", published: [allRegion, pageYear, otherConn] };
    expect(standingFiltersToSpecs(standing, { ...opts, presentation: "chart" })).toEqual([
      { field: "Date.Year", includedKeys: ["2024"] },
      { field: "Product.Category", hiddenKeys: ["Toys"] },
    ]);
    expect(standingFiltersToSpecs(standing, { ...opts, presentation: "table" })).toEqual(standing);
    expect(standingFiltersToSpecs(standing, { ...opts, published: [], presentation: "chart" })).toEqual(standing);
  });
});

describe("caption, title", () => {
  it("valueLessFilterFields names the FILTERS fields the engine route drops (no values at all)", () => {
    expect(
      valueLessFilterFields({
        connectionId: "c1",
        rowFields: [],
        columnFields: [],
        valueFields: [],
        filterFields: [
          { table: "Geo", column: "Region", hiddenItems: [] },
          { table: "Product", column: "Category", includedItems: ["B"], hiddenItems: [] },
          { table: "Date", column: "Year", hiddenItems: ["2020"] },
        ],
      }),
    ).toEqual(["Geo.Region"]);
  });

  it("drillCaption: complete lines -- what it was filtered to, what was not carried, the value-less fields", () => {
    expect(drillCaption([bikes], ["the filter on X could not be carried"], ["Geo.Region"])).toEqual([
      "Filtered to: Product.Category: Bikes",
      "Not carried: the filter on X could not be carried",
      "FILTERS fields with no values are not applied by a drill-through: Geo.Region",
    ]);
    expect(drillCaption([], [], [])).toEqual(["Filtered to: all members (no filters)"]);
  });

  it("drillTitle is '<name>: <labels>', the name alone for a measure-only datum, 'Drill through' with no name", () => {
    expect(drillTitle(tableDef, [bikes])).toBe("By region: Bikes");
    expect(drillTitle(tableDef, [])).toBe("By region");
    expect(drillTitle(chartDef, [bikes])).toBe("Drill through: Bikes");
  });

  it("firstCompileErrorLine spells 'Line N: message'", () => {
    expect(firstCompileErrorLine([{ message: "Unknown field", location: { line: 3 } }])).toBe("Line 3: Unknown field");
    expect(firstCompileErrorLine([])).toBe("unknown error");
  });

  it("activeTemporarySheetId: the ACTIVE sheet's id when it is temporary, else null", () => {
    const sheet = (index: number, sheetId: string | undefined, ephemeral?: boolean) =>
      ({ index, name: `S${index}`, visibility: "visible", sheetId, ephemeral }) as never;
    expect(activeTemporarySheetId({ sheets: [sheet(0, "A"), sheet(1, "E", true)], activeIndex: 1 })).toBe("E");
    expect(activeTemporarySheetId({ sheets: [sheet(0, "A"), sheet(1, "E", true)], activeIndex: 0 })).toBeNull();
    expect(activeTemporarySheetId({ sheets: [sheet(1, undefined, true)], activeIndex: 1 })).toBeNull();
    expect(activeTemporarySheetId({ sheets: [], activeIndex: 0 })).toBeNull();
  });
});

// ----------------------------------------------------------------------------
// The run
// ----------------------------------------------------------------------------

describe("runDrillThrough: a table", () => {
  it("reads the model, bakes the datum, lands the sheet, then switches and refreshes -- in that order", async () => {
    const { calls, io } = fakeBackend();
    const out = await runDrillThrough(source, { ...tableDef, keepFilters: false }, { filters: [bikes] }, io);
    expect(out).toEqual({ ok: true, sheetIndex: 3, sheetId: "S3", sheetName: "By region" });
    expect(calls.map((c) => c.command)).toEqual(["get_connection_bi_model", "drill_through"]);
    expect(calls[0].args).toEqual({ connectionId: "c1" });
    const req = (calls[1].args as { request: Record<string, unknown> }).request;
    expect(req.op).toBe("toSheet");
    expect(req.presentation).toBe("table");
    expect(req.name).toBe("By region");
    expect(req.title).toBe("By region");
    expect(req.caption).toEqual(["Filtered to: Product.Category: Bikes"]);
    const query = req.query as { filterFields: unknown[] };
    expect(query.filterFields).toEqual([CATEGORY_BIKES]);
    expect(h.activateSheet).toHaveBeenCalledWith(3, { record: false });
    expect(h.events).toEqual([{ name: AppEvents.MUTATION_REFRESH, detail: { domains: ["sheets"], source: "commit" } }]);
    expect(h.toasts).toEqual([]);
    expect(h.execute).not.toHaveBeenCalled();
  });

  it("sends the definition's FULL name as the title; the sheet name stays the cleaned base; an unnamed definition sends none (C4)", async () => {
    // SABOTAGE: title = name -- A1 shows "Revenue by region  channel, 202",
    // the cut-down sheet name, instead of what the author wrote.
    const named = fakeBackend();
    await runDrillThrough(source, { ...tableDef, name: "  Revenue by region / channel, 2025 plan  ", keepFilters: false }, { filters: [bikes] }, named.io);
    const req = (named.calls[1].args as { request: Record<string, unknown> }).request;
    expect(req.name).toBe("Revenue by region  channel, 202");
    expect(req.title).toBe("Revenue by region / channel, 2025 plan");

    const unnamed = fakeBackend();
    await runDrillThrough(source, { ...tableDef, name: undefined, keepFilters: false }, { filters: [bikes] }, unnamed.io);
    const bare = (unnamed.calls[1].args as { request: Record<string, unknown> }).request;
    expect(bare.name).toBe("Sales by Category drill");
    expect(bare).not.toHaveProperty("title");
  });

  it("no model (a connection that is not open) is TOLD, and nothing is added", async () => {
    // SABOTAGE: query anyway -- Rust answers "Connection not found" after a
    // sheet was already added, or the ZERO id runs silently.
    const { calls, io } = fakeBackend({ get_connection_bi_model: () => null });
    const out = await runDrillThrough(source, tableDef, { filters: [bikes] }, io);
    expect(out).toEqual({ ok: false, reason: "Open the model's connection first." });
    expect(calls.map((c) => c.command)).toEqual(["get_connection_bi_model"]);
    expect(h.toasts).toEqual([{ message: "Open the model's connection first.", variant: "warning" }]);
    expect(h.activateSheet).not.toHaveBeenCalled();
    const zero = await runDrillThrough({ ...source, connectionId: "0" }, tableDef, { filters: [bikes] }, fakeBackend().io);
    expect(zero.ok).toBe(false);
  });

  it("a compile error is a toast with its first line, and nothing is added", async () => {
    const { calls, io } = fakeBackend();
    const out = await runDrillThrough(source, { ...tableDef, dslText: "ROWS: Nope.Field\nVALUES: [Revenue]", keepFilters: false }, { filters: [bikes] }, io);
    expect(out.ok).toBe(false);
    expect(h.toasts[0]?.message).toMatch(/^The drill-through query has errors\. Line 1: /);
    expect(calls.map((c) => c.command)).toEqual(["get_connection_bi_model"]);
  });

  it("a bake refusal (an inclusion that keeps nothing) is a toast, and nothing is added", async () => {
    const { calls, io } = fakeBackend();
    const out = await runDrillThrough(source, { ...tableDef, keepFilters: false }, { filters: [{ field: "Product.Category", includedKeys: [] }] }, io);
    expect(out.ok).toBe(false);
    expect(h.toasts[0]?.message).toMatch(/no member/);
    expect(h.toasts[0]?.variant).toBe("warning");
    expect(calls.map((c) => c.command)).toEqual(["get_connection_bi_model"]);
  });

  it("a backend refusal of toSheet is a toast", async () => {
    const { io } = fakeBackend({
      drill_through: () => {
        throw new Error("keep or leave the temporary sheet first");
      },
    });
    const out = await runDrillThrough(source, { ...tableDef, keepFilters: false }, { filters: [bikes] }, io);
    expect(out.ok).toBe(false);
    expect(h.toasts).toEqual([{ message: expect.stringMatching(/keep or leave the temporary sheet first/), variant: "error" }]);
    expect(h.activateSheet).not.toHaveBeenCalled();
  });

  it("an UNSET @param drops its FILTERS line and the drill still compiles with the datum's filter", async () => {
    // getControlValue has no provider here: an unset @param DROPS its line.
    const { calls, io } = fakeBackend();
    await runDrillThrough(source, { ...tableDef, dslText: "ROWS: Geo.Region\nVALUES: [Revenue]\nFILTERS: Product.Category = @Cat", keepFilters: false }, { filters: [bikes] }, io);
    const query = (calls[1].args as { request: { query: { filterFields: unknown[] } } }).request.query;
    expect(query.filterFields).toEqual([CATEGORY_BIKES]);
  });

  it("a datum's notices go into the caption AND are told once, as warnings, only AFTER the sheet landed", async () => {
    // SABOTAGE: toast them before the run (or let the caller do it) -- a
    // drill that then fails shows a notice about filters of a drill that
    // never ran (F10).
    const { calls, io } = fakeBackend();
    await runDrillThrough(source, { ...tableDef, keepFilters: false }, { filters: [bikes], notices: ["the filter on Geo.Region could not be carried"] }, io);
    const req = (calls[1].args as { request: { caption: string[] } }).request;
    expect(req.caption).toEqual(["Filtered to: Product.Category: Bikes", "Not carried: the filter on Geo.Region could not be carried"]);
    expect(h.toasts).toEqual([{ message: "the filter on Geo.Region could not be carried", variant: "warning" }]);
    expect(steps("drill_through", "activateSheet", "toast:warning")).toEqual(["drill_through", "activateSheet", "toast:warning"]);
  });

  it("a presentation kind this version does not know is refused, never run as a table or a chart", async () => {
    const { calls, io } = fakeBackend();
    const odd = { ...tableDef, presentation: { kind: "matrix" } } as unknown as DrillThroughDefinition;
    const out = await runDrillThrough(source, odd, { filters: [bikes] }, io);
    expect(out.ok).toBe(false);
    expect(calls).toEqual([]);
    expect(h.toasts).toEqual([{ message: 'The drill-through\'s presentation "matrix" is not one this version can show.', variant: "error" }]);
  });

  it("a failed read of the sheets is a toast, and nothing else runs", async () => {
    h.getSheets.mockRejectedValue(new Error("backend gone"));
    const { calls, io } = fakeBackend();
    const out = await runDrillThrough(source, tableDef, { filters: [bikes] }, io);
    expect(out.ok).toBe(false);
    expect(calls).toEqual([]);
    expect(h.toasts).toEqual([{ message: "Could not read the workbook's sheets before drilling: backend gone", variant: "error" }]);
  });
});

describe("runDrillThrough: a drill FROM a drill", () => {
  it("TABLE: every check runs while the temporary sheet still exists -- the page's filters, the query pre-flight -- and it is discarded right before toSheet", async () => {
    // SABOTAGE: discard first (the old order) -- a drill refused by any later
    // check has already deleted the page the user was reading (F1).
    onTemporarySheet();
    h.pageId = "E1";
    const { io } = fakeBackend();
    const out = await runDrillThrough({ ...source, sheetIndex: 3 }, tableDef, { filters: [bikes] }, io);
    expect(out.ok).toBe(true);
    expect(h.execute).toHaveBeenCalledWith(DISCARD_EPHEMERAL_COMMAND, { sheetId: "E1" });
    expect(steps(...ORDER_STEPS)).toEqual([
      "get_connection_bi_model",
      "resolveFiltersFor",
      "run_design_query",
      DISCARD_EPHEMERAL_COMMAND,
      "drill_through",
      "activateSheet",
    ]);
    expect(h.toasts).toEqual([]);
  });

  it("CHART: the dry run, the spec and its validation all come before the discard", async () => {
    onTemporarySheet();
    h.pageId = "E1";
    const { io } = fakeBackend();
    const out = await runDrillThrough({ ...source, sheetIndex: 3 }, chartDef, { filters: [bikes] }, io);
    expect(out.ok).toBe(true);
    expect(steps(...ORDER_STEPS)).toEqual([
      "get_connection_bi_model",
      "resolveFiltersFor",
      "run_design_query",
      "buildDesignQueryChartSpec",
      "validateChartSpec",
      DISCARD_EPHEMERAL_COMMAND,
      "drill_through",
      "activateSheet",
      "createChart",
    ]);
  });

  const refusals: Array<[string, () => { def: DrillThroughDefinition; datum: { filters: DrillFilterSpec[] }; backend?: Parameters<typeof fakeBackend>[0] }]> = [
    ["no model", () => ({ def: tableDef, datum: { filters: [bikes] }, backend: { get_connection_bi_model: () => null } })],
    ["a compile error", () => ({ def: { ...tableDef, dslText: "ROWS: Nope.Field\nVALUES: [Revenue]" }, datum: { filters: [bikes] } })],
    ["a bake refusal", () => ({ def: tableDef, datum: { filters: [{ field: "Product.Category", includedKeys: [] }] } })],
    [
      "a failing table pre-flight",
      () => ({
        def: tableDef,
        datum: { filters: [bikes] },
        backend: {
          run_design_query: () => {
            throw new Error("the engine refused the query");
          },
        },
      }),
    ],
    [
      "a failing chart dry run",
      () => ({
        def: chartDef,
        datum: { filters: [bikes] },
        backend: {
          run_design_query: () => {
            throw new Error("A design query needs at least one measure (VALUES).");
          },
        },
      }),
    ],
    [
      "no chart store",
      () => {
        h.chartStore = null;
        return { def: chartDef, datum: { filters: [bikes] } };
      },
    ],
    [
      "a chart spec the Charts seam refuses",
      () => {
        h.chartStore!.validateChartSpec.mockReturnValue(["spec.markOptions: unknown property 'innerRadius'"]);
        return { def: chartDef, datum: { filters: [bikes] } };
      },
    ],
    [
      "a chart spec the Charts seam cannot build",
      () => {
        h.chartStore!.buildDesignQueryChartSpec.mockImplementation(() => {
          throw new Error("no skeleton");
        });
        return { def: chartDef, datum: { filters: [bikes] } };
      },
    ],
  ];

  for (const [name, setup] of refusals) {
    it(`a drill refused by ${name} NEVER discards the temporary sheet, and says why once`, async () => {
      onTemporarySheet();
      const { def, datum, backend } = setup();
      const { calls, io } = fakeBackend(backend);
      const out = await runDrillThrough({ ...source, sheetIndex: 3 }, { ...def, keepFilters: false }, datum, io);
      expect(out.ok).toBe(false);
      expect(h.execute).not.toHaveBeenCalled();
      expect(calls.map((c) => c.command)).not.toContain("drill_through");
      expect(h.toasts).toHaveLength(1);
      expect(h.sheets.sheets.some((s) => s.sheetId === "E1")).toBe(true);
    });
  }

  it("a REFUSED discard stops the run with the strip's ONE toast -- no second toast, no toSheet (F4)", async () => {
    // SABOTAGE: treat only a THROWN discard as a failure -- the real command
    // never throws on a refusal, so the run carries on into toSheet, which
    // refuses again with a second, confusing toast.
    onTemporarySheet();
    discardRefused("Temporary sheet kept: Protect Workbook Structure is on.");
    const { calls, io } = fakeBackend();
    const out = await runDrillThrough({ ...source, sheetIndex: 3 }, { ...tableDef, keepFilters: false }, { filters: [bikes] }, io);
    expect(out).toEqual({ ok: false, reason: 'The temporary sheet "Drill" was not discarded, so the drill-through did not run.' });
    expect(calls.map((c) => c.command)).toEqual(["get_connection_bi_model", "run_design_query"]);
    expect(h.toasts).toEqual([{ message: "Temporary sheet kept: Protect Workbook Structure is on.", variant: "warning" }]);
  });

  it("a discard that answers true while the sheet is still listed stops the run and SAYS so (nobody else did)", async () => {
    onTemporarySheet();
    h.execute.mockResolvedValue(true);
    const { calls, io } = fakeBackend();
    const out = await runDrillThrough({ ...source, sheetIndex: 3 }, { ...tableDef, keepFilters: false }, { filters: [bikes] }, io);
    expect(out.ok).toBe(false);
    expect(calls.map((c) => c.command)).not.toContain("drill_through");
    expect(h.toasts).toEqual([{ message: 'The temporary sheet "Drill" was not discarded, so the drill-through did not run.', variant: "error" }]);
  });

  it("a THROWN discard is a toast and stops the run", async () => {
    onTemporarySheet();
    h.execute.mockRejectedValue(new Error("the strip is gone"));
    const { calls, io } = fakeBackend();
    const out = await runDrillThrough({ ...source, sheetIndex: 3 }, { ...tableDef, keepFilters: false }, { filters: [bikes] }, io);
    expect(out.ok).toBe(false);
    expect(calls.map((c) => c.command)).not.toContain("drill_through");
    expect(h.toasts).toEqual([{ message: "Could not leave the temporary sheet before drilling: the strip is gone", variant: "error" }]);
  });

  it("the sheets are read AGAIN before the discard: one the strip discarded meanwhile is not discarded twice", async () => {
    // The user left E1 during the model round trip: the strip discarded it.
    onTemporarySheet();
    const { calls, io } = fakeBackend({
      get_connection_bi_model: () => {
        h.sheets.sheets = h.sheets.sheets.filter((s) => s.sheetId !== "E1");
        h.sheets.activeIndex = 2;
        return biModel;
      },
    });
    const out = await runDrillThrough({ ...source, sheetIndex: 3 }, { ...tableDef, keepFilters: false }, { filters: [bikes] }, io);
    expect(out.ok).toBe(true);
    expect(h.execute).not.toHaveBeenCalled();
    expect(calls.map((c) => c.command)).toContain("drill_through");
  });

  it("a temporary sheet the user KEPT during the checks is not discarded, and the drill lands beside it", async () => {
    onTemporarySheet();
    const { io } = fakeBackend({
      get_connection_bi_model: () => {
        h.sheets.sheets = h.sheets.sheets.map((s) => (s.sheetId === "E1" ? { ...s, ephemeral: false } : s));
        return biModel;
      },
    });
    const out = await runDrillThrough({ ...source, sheetIndex: 3 }, { ...tableDef, keepFilters: false }, { filters: [bikes] }, io);
    expect(out.ok).toBe(true);
    expect(h.execute).not.toHaveBeenCalled();
    expect(h.toasts).toEqual([]);
  });
});

describe("runDrillThrough: the page's filters", () => {
  const regionFilter = rff("Geo.Region", ["E"], "Slicer_Region");

  it("keepFilters (the default) resolves for the SOURCE visual on its page and bakes the answer beside the datum", async () => {
    h.pageId = "S2";
    h.resolve.mockReturnValue(resolved([regionFilter]));
    const { calls, io } = fakeBackend();
    await runDrillThrough(source, tableDef, { filters: [bikes] }, io);
    expect(h.resolve).toHaveBeenCalledWith("S2", { ref: { kind: "chart", id: "chart-1" }, canHighlight: false }, "c1");
    const query = (calls[1].args as { request: { query: { filterFields: unknown[] } } }).request.query;
    expect(query.filterFields).toEqual([CATEGORY_BIKES, { table: "Geo", column: "Region", includedItems: ["E"], hiddenItems: [] }]);
  });

  it("keepFilters: false resolves nothing", async () => {
    h.pageId = "S2";
    const { io } = fakeBackend();
    await runDrillThrough(source, { ...tableDef, keepFilters: false }, { filters: [bikes] }, io);
    expect(h.resolve).not.toHaveBeenCalled();
  });

  it("a source whose sheet has no id (no page list) resolves nothing rather than guessing", async () => {
    h.pageId = null;
    const { io } = fakeBackend();
    await runDrillThrough(source, tableDef, { filters: [bikes] }, io);
    expect(h.resolve).not.toHaveBeenCalled();
  });

  it("tuple selections are a caption line and ONE info toast after landing, never a filter", async () => {
    h.pageId = "S2";
    h.resolve.mockReturnValue(resolved([], [{ fields: ["A.X", "B.Y"], tuples: [["1", "2"]], from: "Chart 2" }]));
    const { calls, io } = fakeBackend();
    const out = await runDrillThrough(source, tableDef, { filters: [bikes] }, io);
    expect(out.ok).toBe(true);
    expect(h.toasts).toEqual([{ message: TUPLE_FILTERS_NOTICE, variant: "info" }]);
    expect(steps("activateSheet", "toast:info")).toEqual(["activateSheet", "toast:info"]);
    const req = (calls[1].args as { request: { caption: string[]; query: { filterFields: unknown[] } } }).request;
    expect(req.caption[1]).toBe(`Not carried: ${TUPLE_FILTERS_NOTICE}`);
    expect(req.query.filterFields).toHaveLength(1);
  });

  it("a tuple selection on a drill that then FAILS tells only the failure (F10)", async () => {
    h.pageId = "S2";
    h.resolve.mockReturnValue(resolved([], [{ fields: ["A.X", "B.Y"], tuples: [["1", "2"]], from: "Chart 2" }]));
    const { io } = fakeBackend();
    const out = await runDrillThrough(source, { ...tableDef, dslText: "ROWS: Nope.Field\nVALUES: [Revenue]" }, { filters: [bikes], notices: ["the filter on X could not be carried"] }, io);
    expect(out.ok).toBe(false);
    expect(h.toasts).toHaveLength(1);
    expect(h.toasts[0].message).toMatch(/^The drill-through query has errors/);
  });

  it("a page filter that keeps nothing refuses the drill ('the source shows no members here')", async () => {
    h.pageId = "S2";
    h.resolve.mockReturnValue(resolved([{ ...regionFilter, includedKeys: [] }]));
    const { calls, io } = fakeBackend();
    const out = await runDrillThrough(source, tableDef, { filters: [bikes] }, io);
    expect(out.ok).toBe(false);
    expect(h.toasts[0]?.message).toMatch(/no members here/);
    expect(calls.map((c) => c.command)).toEqual(["get_connection_bi_model"]);
  });

  it("the CHART presentation leaves a workbook-wide filter out of the bake and keeps a page slicer of the same name; the TABLE keeps both", async () => {
    h.pageId = "S2";
    const ribbon = rff("Geo.Region", ["E"], "Region", true);
    const slicer = rff("Geo.Region", ["E"], "Region", false);
    h.resolve.mockReturnValue(resolved([ribbon, slicer]));

    const table = fakeBackend();
    await runDrillThrough(source, tableDef, { filters: [bikes] }, table.io);
    const tableQuery = (table.calls[1].args as { request: { query: { filterFields: unknown[] } } }).request.query;
    expect(tableQuery.filterFields).toEqual([CATEGORY_BIKES, { table: "Geo", column: "Region", includedItems: ["E"], hiddenItems: [] }]);

    const chart = fakeBackend();
    await runDrillThrough(source, chartDef, { filters: [bikes] }, chart.io);
    const dryRun = chart.calls.find((c) => c.command === "run_design_query")!.args as { request: { filterFields: unknown[] } };
    // The page slicer is still baked (F8): its region filter is in the chart's query.
    expect(dryRun.request.filterFields).toEqual([CATEGORY_BIKES, { table: "Geo", column: "Region", includedItems: ["E"], hiddenItems: [] }]);
    const onlyRibbon = fakeBackend();
    h.resolve.mockReturnValue(resolved([ribbon]));
    await runDrillThrough(source, chartDef, { filters: [bikes] }, onlyRibbon.io);
    const ribbonRun = onlyRibbon.calls.find((c) => c.command === "run_design_query")!.args as { request: { filterFields: unknown[] } };
    expect(ribbonRun.request.filterFields).toEqual([CATEGORY_BIKES]);
  });
});

describe("runDrillThrough: a pivot's standing filters (F2)", () => {
  const allRegion = published({ sourceName: "Region", field: "Geo.Region", includedKeys: ["E"] });
  const standingRegion: DrillFilterSpec = { field: "Geo.Region", hiddenKeys: ["W"] };
  const pinnedRegion: DrillFilterSpec = { field: "geo.region", includedKeys: ["E"], labels: ["East"] };

  it("a CHART leaves out a standing filter a workbook-wide filter re-applies live -- whatever keepFilters says -- and titles by the clicked path only", async () => {
    h.published = [allRegion];
    for (const keepFilters of [true, false]) {
      h.log = [];
      const { calls, io } = fakeBackend();
      const out = await runDrillThrough(pivotSource, { ...chartDef, keepFilters }, { filters: [bikes], standing: [standingRegion, pinnedRegion] }, io);
      expect(out.ok).toBe(true);
      const dryRun = calls.find((c) => c.command === "run_design_query")!.args as { request: { filterFields: unknown[] } };
      expect(dryRun.request.filterFields, `keepFilters ${keepFilters}`).toEqual([CATEGORY_BIKES]);
    }
    const req = h.chartStore!.buildDesignQueryChartSpec.mock.calls[0][0];
    // "East" rides a STANDING spec: it was not clicked, so it is not in the title.
    expect(req.title).toBe("Drill through: Bikes");
  });

  it("the chart's title names the CLICKED members only: a labelled standing filter that IS baked stays out of it", async () => {
    // SABOTAGE: title from every baked spec -- the pivot's own pinned "East"
    // reads as if it had been clicked ("Drill through: Bikes, East").
    const { calls, io } = fakeBackend();
    await runDrillThrough(pivotSource, { ...chartDef, keepFilters: false }, { filters: [bikes], standing: [pinnedRegion] }, io);
    const dryRun = calls.find((c) => c.command === "run_design_query")!.args as { request: { filterFields: unknown[] } };
    expect(dryRun.request.filterFields).toEqual([CATEGORY_BIKES, { table: "Geo", column: "Region", includedItems: ["E"], hiddenItems: [] }]);
    expect(h.chartStore!.buildDesignQueryChartSpec.mock.calls[0][0].title).toBe("Drill through: Bikes");
  });

  it("the CLICKED path on that same field is still baked into the chart", async () => {
    h.published = [allRegion];
    const { calls, io } = fakeBackend();
    const east: DrillFilterSpec = { field: "Geo.Region", includedKeys: ["E"], labels: ["East"] };
    await runDrillThrough(pivotSource, { ...chartDef, keepFilters: false }, { filters: [east], standing: [standingRegion] }, io);
    const dryRun = calls.find((c) => c.command === "run_design_query")!.args as { request: { filterFields: unknown[] } };
    expect(dryRun.request.filterFields).toEqual([{ table: "Geo", column: "Region", includedItems: ["E"], hiddenItems: [] }]);
    expect(h.chartStore!.buildDesignQueryChartSpec.mock.calls[0][0].title).toBe("Drill through: East");
  });

  it("the TABLE bakes the standing filter (static cells)", async () => {
    h.published = [allRegion];
    const { calls, io } = fakeBackend();
    await runDrillThrough(pivotSource, { ...tableDef, keepFilters: false }, { filters: [bikes], standing: [standingRegion] }, io);
    const query = (calls[1].args as { request: { query: { filterFields: unknown[] } } }).request.query;
    expect(query.filterFields).toEqual([CATEGORY_BIKES, { table: "Geo", column: "Region", hiddenItems: ["W"] }]);
  });

  it("a page-scoped publication, or one on another connection, leaves the standing filter in the chart", async () => {
    h.published = [
      published({ sourceName: "Region", field: "Geo.Region", includedKeys: ["E"], scope: { kind: "page", sheetId: "S2" } }),
      published({ sourceName: "Region", field: "Geo.Region", includedKeys: ["E"], connectionId: "c2", sourceId: "rf-9" }),
    ];
    const { calls, io } = fakeBackend();
    await runDrillThrough(pivotSource, { ...chartDef, keepFilters: false }, { filters: [bikes], standing: [standingRegion] }, io);
    const dryRun = calls.find((c) => c.command === "run_design_query")!.args as { request: { filterFields: unknown[] } };
    expect(dryRun.request.filterFields).toEqual([CATEGORY_BIKES, { table: "Geo", column: "Region", hiddenItems: ["W"] }]);
  });
});

describe("runDrillThrough: a chart", () => {
  it("dry-runs the query, takes the spec from the Charts seam and validates it there, then appends, activates and creates ONE chart filling the page", async () => {
    // SABOTAGE: build the spec here (the old copied recipe) -- Insert Chart
    // follows Charts' next default change and drill charts do not (F3); or
    // skip the validation -- a spec the ChartSpec refuses leaves an empty
    // temporary page (F5); or create before the switch -- regions publish
    // only for the store's active sheet.
    const { calls, io } = fakeBackend();
    const out = await runDrillThrough(source, { ...chartDef, keepFilters: false }, { filters: [bikes] }, io);
    expect(out).toEqual({ ok: true, sheetIndex: 3, sheetId: "S3", sheetName: "By region", chartId: "chart-new" });
    expect(calls.map((c) => c.command)).toEqual(["get_connection_bi_model", "run_design_query", "drill_through"]);
    expect(steps(...ORDER_STEPS)).toEqual([
      "get_connection_bi_model",
      "run_design_query",
      "buildDesignQueryChartSpec",
      "validateChartSpec",
      "drill_through",
      "activateSheet",
      "createChart",
    ]);
    const store = h.chartStore!;
    expect(store.buildDesignQueryChartSpec).toHaveBeenCalledTimes(1);
    expect(store.buildDesignQueryChartSpec.mock.calls[0][0]).toEqual({
      dslText: 'ROWS: Geo.Region\nVALUES: [Revenue]\nFILTERS: [Product.Category] = ("Bikes")',
      connectionId: "c1",
      mark: "bar",
      markOptions: { stackMode: "stacked" },
      title: "Drill through: Bikes",
    });
    // The seam's spec, unchanged and uncopied, is what is validated and created.
    const built = store.buildDesignQueryChartSpec.mock.results[0].value as Record<string, unknown>;
    expect(store.validateChartSpec.mock.calls[0][0]).toBe(built);
    const create = store.createChart.mock.calls[0];
    expect(create[0]).toBe(built);
    expect(create[0].skeleton).toBe("charts-owned");
    expect(create[1]).toEqual({ sheetIndex: 3, ...DRILL_CHART_PLACEMENT, name: "Sales by Category drill" });
    const toSheet = (calls[2].args as { request: Record<string, unknown> }).request;
    expect(toSheet).toEqual({ op: "toSheet", name: "Sales by Category drill", presentation: "chart", caption: ["Filtered to: Product.Category: Bikes"] });
    expect(toSheet).not.toHaveProperty("query");
    expect(h.activateSheet).toHaveBeenCalledWith(3, { record: false });
    expect(h.events.map((e) => e.name)).toEqual([AppEvents.MUTATION_REFRESH]);
    expect(h.toasts).toEqual([]);
  });

  it("a definition with no mark options sends none to the seam", async () => {
    const { io } = fakeBackend();
    await runDrillThrough(source, { ...chartDef, presentation: { kind: "chart", mark: "pie" }, keepFilters: false }, { filters: [bikes] }, io);
    expect(h.chartStore!.buildDesignQueryChartSpec.mock.calls[0][0]).not.toHaveProperty("markOptions");
  });

  it("a spec the Charts seam refuses is ONE toast naming the first violations, and NO sheet is added (F5)", async () => {
    h.chartStore!.validateChartSpec.mockReturnValue([
      "spec.markOptions: unknown property 'innerRadius'",
      "spec.mark: does not match the pattern",
      "spec.x: a",
      "spec.y: b",
    ]);
    const { calls, io } = fakeBackend();
    const out = await runDrillThrough(source, { ...chartDef, keepFilters: false }, { filters: [bikes] }, io);
    expect(out.ok).toBe(false);
    expect(calls.map((c) => c.command)).toEqual(["get_connection_bi_model", "run_design_query"]);
    expect(h.chartStore!.createChart).not.toHaveBeenCalled();
    expect(h.toasts).toEqual([
      {
        message:
          "The drill-through's chart settings are not valid: spec.markOptions: unknown property 'innerRadius'; spec.mark: does not match the pattern; spec.x: a",
        variant: "error",
      },
    ]);
  });

  it("a failing dry run is a toast and adds NO sheet", async () => {
    const { calls, io } = fakeBackend({
      run_design_query: () => {
        throw new Error("A design query needs at least one measure (VALUES).");
      },
    });
    const out = await runDrillThrough(source, { ...chartDef, keepFilters: false }, { filters: [bikes], notices: ["the filter on X could not be carried"] }, io);
    expect(out.ok).toBe(false);
    expect(h.toasts).toHaveLength(1);
    expect(h.toasts[0]?.message).toMatch(/at least one measure/);
    expect(calls.map((c) => c.command)).toEqual(["get_connection_bi_model", "run_design_query"]);
    expect(h.chartStore!.buildDesignQueryChartSpec).not.toHaveBeenCalled();
    expect(h.chartStore!.createChart).not.toHaveBeenCalled();
  });

  it("with no chart store the run is refused BEFORE a sheet is added", async () => {
    h.chartStore = null;
    const { calls, io } = fakeBackend();
    const out = await runDrillThrough(source, { ...chartDef, keepFilters: false }, { filters: [bikes] }, io);
    expect(out.ok).toBe(false);
    expect(calls.map((c) => c.command)).toEqual(["get_connection_bi_model", "run_design_query"]);
    expect(h.toasts[0]?.message).toMatch(/Charts are unavailable/);
  });

  it("a chart that still fails to create after landing is a toast that names the page -- and tells no notice", async () => {
    h.chartStore!.createChart.mockImplementation(() => {
      throw new Error("Invalid chart spec: mark");
    });
    const { io } = fakeBackend();
    const out = await runDrillThrough(source, { ...chartDef, keepFilters: false }, { filters: [bikes], notices: ["the filter on X could not be carried"] }, io);
    expect(out.ok).toBe(false);
    expect(h.toasts).toEqual([
      { message: expect.stringMatching(/"By region" was added but its chart could not be created: Invalid chart spec: mark/), variant: "error" },
    ]);
  });

  it("a page that cannot be shown after landing tells only that failure, no notice", async () => {
    h.activateSheet.mockRejectedValue(new Error("switch refused"));
    const { io } = fakeBackend();
    const out = await runDrillThrough(source, { ...chartDef, keepFilters: false }, { filters: [bikes], notices: ["the filter on X could not be carried"] }, io);
    expect(out.ok).toBe(false);
    expect(h.toasts).toEqual([{ message: 'The drill-through page "By region" was added but could not be shown: switch refused', variant: "error" }]);
    expect(h.chartStore!.createChart).not.toHaveBeenCalled();
  });

  it("the notices are told once AFTER the chart was created: the source's as warnings, the page's tuple notice as info", async () => {
    h.pageId = "S2";
    h.resolve.mockReturnValue(resolved([], [{ fields: ["A.X", "B.Y"], tuples: [["1", "2"]], from: "Chart 2" }]));
    const { io } = fakeBackend();
    const out = await runDrillThrough(source, chartDef, { filters: [bikes], notices: ["the filter on X could not be carried"] }, io);
    expect(out.ok).toBe(true);
    expect(h.toasts).toEqual([
      { message: "the filter on X could not be carried", variant: "warning" },
      { message: TUPLE_FILTERS_NOTICE, variant: "info" },
    ]);
    expect(steps("createChart", "toast:warning", "toast:info")).toEqual(["createChart", "toast:warning", "toast:info"]);
  });

  it("a measure-only datum (a Card) drills with no member filter and a plain title", async () => {
    const { calls, io } = fakeBackend();
    const out = await runDrillThrough(source, { ...chartDef, keepFilters: false, name: "Detail" }, { filters: [] }, io);
    expect(out.ok).toBe(true);
    const toSheet = (calls[2].args as { request: { caption: string[]; title?: string } }).request;
    expect(toSheet.caption).toEqual(["Filtered to: all members (no filters)"]);
    expect(toSheet.title).toBe("Detail");
    const req = h.chartStore!.buildDesignQueryChartSpec.mock.calls[0][0];
    expect(req.title).toBe("Detail");
    expect(req.dslText).toBe(chartDef.dslText);
  });

  it("the chart stores the SUBSTITUTED text -- values, never @names -- and it is exactly the text it was dry-run with (F9)", async () => {
    // SABOTAGE: hand the seam the unsubstituted baked text -- the kept chart
    // re-reads `@Cat` live and moves off the numbers the drill showed; or
    // drop the substitution -- the dry run and the chart disagree.
    registerControlValuesProvider({
      list: () => [],
      get: (n) => (n.toUpperCase() === "CAT" ? { kind: "textList", value: ["Bikes", "Clothing"] } : undefined),
    });
    try {
      const { calls, io } = fakeBackend();
      const def = { ...chartDef, dslText: "ROWS: Geo.Region\nVALUES: [Revenue]\nFILTERS: Product.Category = @Cat", keepFilters: false };
      const out = await runDrillThrough(source, def, { filters: [bikes] }, io);
      expect(out.ok).toBe(true);
      const created = h.chartStore!.createChart.mock.calls[0][0];
      const stored = (created.data as { dslText: string }).dslText;
      expect(stored).toBe(
        'ROWS: Geo.Region\nVALUES: [Revenue]\nFILTERS: Product.Category = ("Bikes", "Clothing")\nFILTERS: [Product.Category] = ("Bikes")',
      );
      expect(stored).not.toContain("@");
      const dryRun = calls.find((c) => c.command === "run_design_query")!.args as { request: unknown };
      expect(compileDesignQuery(stored, "c1", biModel).request).toEqual(dryRun.request);
      // The chart's reader re-substitutes on every read: with the control
      // moved, the kept text does not move.
      registerControlValuesProvider({
        list: () => [],
        get: (n) => (n.toUpperCase() === "CAT" ? { kind: "textList", value: ["Clothing"] } : undefined),
      });
      expect(substituteControlParams(stored, getControlValue)).toBe(stored);
    } finally {
      registerControlValuesProvider(null);
    }
  });
});
