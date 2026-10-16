//! FILENAME: app/extensions/Charts/lib/__tests__/chartObjectFormat.test.ts
// PURPOSE: The chart's @api/objectFormat provider (WP-C S9a): one spelling per
//          fact in BOTH directions (read and commit), the explicit clear, the
//          transient preview, the binding table, and -- the reason the
//          provider has a `flush` -- ONE commitObjectFormat on a chart is ONE
//          undo step labelled "Format Object" with the `update_chart` write
//          INSIDE it (review R1-4 / R2-7).
// CONTEXT: The REAL chart store and the REAL commitObjectFormat /
//          runInUndoTransaction run here; only the backend is doubled (the
//          chart channel's invoke and the undo transaction's begin/commit),
//          and every call is recorded in ONE ordered log so "inside the
//          transaction" is a statement about order, not a guess.

import { describe, it, expect, beforeEach, vi } from "vitest";

const log: string[] = [];

vi.mock("../../../../src/core/lib/tauri-api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../../src/core/lib/tauri-api")>()),
  beginUndoTransaction: vi.fn(async (label: string) => {
    log.push(`begin:${label}`);
  }),
  commitUndoTransaction: vi.fn(async () => {
    log.push("commit");
  }),
}));
vi.mock("@api/dialogs", () => ({ alertAsync: () => Promise.resolve() }));

import { setGridRegions, type GridRegion } from "@api/gridOverlays";
import {
  OBJECT_FORMAT_UNDO_LABEL,
  commitObjectFormat,
  endObjectFormatPreview,
  previewObjectFormat,
  readObjectFormat,
  registerObjectFormatProvider,
  resetObjectFormatProviders,
  type ObjectFormatProvider,
} from "@api/objectFormat";
import { isBindablePath } from "@api/objectBindings";
import { VISUAL_CONTAINER_FIELD_IDS } from "@api/visualContainer";
import {
  flushPendingChartSavesQuietly,
  getChartById,
  getPreviewBaseSpec,
  loadChartsFromBackend,
  previewChartSpec,
  resetChartStore,
  restoreChartSpecPreview,
  syncChartRegions,
  updateChartSpec,
} from "../chartStore";
import { chartsBackend } from "../chartsBackend";
import {
  CONTAINER_BINDING_KIND,
  CONTAINER_BINDING_PATHS,
  chartContainerCapabilities,
  chartContainerDefaults,
  chartSpecPatchFor,
  createChartObjectFormatProvider,
  migrateLegacyChartBackground,
  readChartContainer,
  resolveChartContainer,
} from "../chartObjectFormat";
import type { ChartSpec } from "../../types";

const baseSpec = {
  mark: "bar",
  data: "Sheet1!A1:D13",
  hasHeaders: true,
  seriesOrientation: "columns",
  categoryIndex: 0,
  series: [{ name: "Revenue", sourceIndex: 1, color: null }],
  title: "Sales",
  xAxis: { title: null, gridLines: false, showLabels: true, labelAngle: 0, min: null, max: null },
  yAxis: { title: null, gridLines: true, showLabels: true, labelAngle: 0, min: null, max: null },
  legend: { visible: false, position: "bottom" },
  palette: "default",
} as unknown as ChartSpec;

function entry(chartId: string, spec: unknown = baseSpec) {
  return {
    id: chartId,
    sheetIndex: 0,
    specJson: JSON.stringify({ chartId, name: "Chart 1", sheetIndex: 0, x: 10, y: 20, width: 400, height: 300, spec }),
  };
}

const invokeBackend = vi.fn();
const reportOther = vi.fn();

function makeProvider(): ObjectFormatProvider {
  return createChartObjectFormatProvider({
    getStoredSpec: (id) => getPreviewBaseSpec(id),
    updateSpec: (id, patch) => updateChartSpec(id, patch),
    previewSpec: (id, patch) => previewChartSpec(id, patch),
    restorePreview: () => restoreChartSpecPreview(),
    repaint: () => syncChartRegions(),
    flushQuietly: () => flushPendingChartSavesQuietly(),
    reportOther,
  });
}

function region(): GridRegion {
  return {
    id: "chart-c1",
    type: "chart",
    startRow: 0,
    startCol: 0,
    endRow: 0,
    endCol: 0,
    floating: { x: 10, y: 20, width: 400, height: 300 },
    data: { chartId: "c1", name: "Chart 1" },
  };
}

async function load(spec: unknown = baseSpec): Promise<void> {
  invokeBackend.mockReset();
  invokeBackend.mockResolvedValueOnce([entry("c1", spec)]);
  await loadChartsFromBackend({ stampSheetIds: false });
  invokeBackend.mockReset();
  // Every write resolves on a LATER macrotask, as an IPC round-trip does.
  invokeBackend.mockImplementation((cmd: string) => {
    log.push(cmd);
    return new Promise((resolve) => setTimeout(() => resolve(undefined), 0));
  });
}

beforeEach(async () => {
  log.length = 0;
  reportOther.mockReset();
  resetChartStore();
  resetObjectFormatProviders();
  chartsBackend.set(invokeBackend);
  await load();
  setGridRegions([region()]);
});

describe("read: the container the pane shows, from the chart's one-spelling fields", () => {
  it("title text from spec.title, colour / size from the theme, the rest from spec.container", () => {
    const spec = {
      ...baseSpec,
      config: { theme: { titleColor: "#123456", titleFontSize: 18 } },
      container: { title: { bold: false, align: "left" }, border: { radius: 8 } },
    } as ChartSpec;
    expect(readChartContainer(spec)).toEqual({
      title: { bold: false, align: "left", text: "Sales", color: "#123456", fontSize: 18 },
      border: { radius: 8 },
    });
  });

  it("a chart that stores nothing reads as nothing (the defaults show)", () => {
    expect(readChartContainer({ ...baseSpec, title: null })).toEqual({});
  });

  it("the defaults are today's chart frame: white, a 1 px #d0d0d0 border, the title painted by the chart", () => {
    const d = chartContainerDefaults(baseSpec);
    expect(d.background).toMatchObject({ show: true, color: "#ffffff", alpha: 1 });
    expect(d.border).toEqual({ show: true, color: "#d0d0d0", width: 1, radius: 0 });
    expect(d.paint).toEqual({ background: "core", border: "core", title: "family", shadow: "core" });
    expect(d.title).toMatchObject({ show: true, bold: true, align: "center", wrap: false });
  });
});

describe("commit: a container patch split back into the chart's spellings", () => {
  // The mapping table of the spec (S9a tests).
  const cases: Array<[string, Parameters<typeof chartSpecPatchFor>[1], Partial<ChartSpec>]> = [
    ["title text -> spec.title", { title: { text: "Q3" } }, { title: "Q3" }],
    ["an emptied title text -> no title (null)", { title: { text: "" } }, { title: null }],
    ["title colour -> theme.titleColor", { title: { color: "#ff0000" } }, { config: { theme: { titleColor: "#ff0000" } } } as never],
    ["title size -> theme.titleFontSize", { title: { fontSize: 20 } }, { config: { theme: { titleFontSize: 20 } } } as never],
    ["title bold -> container.title.bold", { title: { bold: false } }, { container: { title: { bold: false } } }],
    ["background -> the container, never the theme", { background: { color: "#000000" } }, { container: { background: { color: "#000000" } } }],
  ];
  for (const [name, patch, expected] of cases) {
    it(name, () => {
      expect(chartSpecPatchFor(baseSpec, patch)).toEqual(expected);
    });
  }

  it("a null leaf clears with an EXPLICIT undefined (the store's deep merge would keep a missing key)", () => {
    const spec = { ...baseSpec, container: { border: { radius: 8, color: "#ff0000" } } } as ChartSpec;
    const patch = chartSpecPatchFor(spec, { border: { radius: null } })!;
    expect(patch.container).toEqual({ border: { radius: undefined, color: "#ff0000" } });
    expect("radius" in (patch.container!.border as object)).toBe(true);
  });

  it("clearing the last leaf removes the container key altogether", () => {
    const spec = { ...baseSpec, container: { border: { radius: 8 } } } as ChartSpec;
    const patch = chartSpecPatchFor(spec, { border: { radius: null } })!;
    expect(patch).toEqual({ container: undefined });
    expect("container" in patch).toBe(true);
  });

  it("a cleared title colour goes back to the theme default", () => {
    expect(chartSpecPatchFor(baseSpec, { title: { color: null } })).toEqual({ config: { theme: { titleColor: undefined } } });
  });

  it("the committed spec carries no second spelling of the title", async () => {
    registerObjectFormatProvider(makeProvider());
    await commitObjectFormat([{ region: region(), patch: { title: { text: "Q3", color: "#ff0000", bold: false } } }]);
    const spec = getChartById("c1")!.spec;
    expect(spec.title).toBe("Q3");
    expect(spec.config?.theme?.titleColor).toBe("#ff0000");
    expect(spec.container).toEqual({ title: { bold: false } });
  });
});

describe("ONE commit = ONE undo step labelled Format Object, the write INSIDE it", () => {
  it("begin, update_chart, commit -- in that order, once", async () => {
    registerObjectFormatProvider(makeProvider());
    const out = await commitObjectFormat([{ region: region(), patch: { border: { radius: 12 } } }]);
    expect(out).toEqual({ applied: 1, refused: [] });
    expect(log).toEqual([`begin:${OBJECT_FORMAT_UNDO_LABEL}`, "update_chart", "commit"]);
    expect(getChartById("c1")!.spec.container).toEqual({ border: { radius: 12 } });
  });

  it("NEGATIVE CONTROL: a provider without `flush` lets the debounced write escape the transaction", async () => {
    // Proves the test above has teeth: the store's save is DEBOUNCED, so
    // without the flush the write lands after the step closed.
    const provider = makeProvider();
    delete (provider as { flush?: unknown }).flush;
    registerObjectFormatProvider(provider);
    await commitObjectFormat([{ region: region(), patch: { border: { radius: 12 } } }]);
    expect(log).toEqual([`begin:${OBJECT_FORMAT_UNDO_LABEL}`, "commit"]);
    await flushPendingChartSavesQuietly();
    expect(log).toEqual([`begin:${OBJECT_FORMAT_UNDO_LABEL}`, "commit", "update_chart"]);
  });

  it("a refused write is a refusal of the commit, with the backend's own sentence", async () => {
    registerObjectFormatProvider(makeProvider());
    invokeBackend.mockImplementation((cmd: string) => {
      log.push(cmd);
      return Promise.reject(new Error("The sheet is protected."));
    });
    const out = await commitObjectFormat([{ region: region(), patch: { border: { radius: 12 } } }]);
    expect(out.applied).toBe(0);
    expect(out.refused).toEqual(["The sheet is protected."]);
    // Rolled back to what the backend holds.
    expect(getChartById("c1")!.spec.container).toBeUndefined();
  });
});

describe("preview: a transient write", () => {
  it("shows the patch, writes nothing, and the end restores the stored spec", async () => {
    registerObjectFormatProvider(makeProvider());
    previewObjectFormat(region(), { background: { color: "#000000" } });
    expect(getChartById("c1")!.spec.container).toEqual({ background: { color: "#000000" } });
    // The pane reads the LITERAL, not the preview.
    expect(readObjectFormat(region())!.stored.background).toBeUndefined();
    endObjectFormatPreview();
    expect(getChartById("c1")!.spec.container).toBeUndefined();
    await flushPendingChartSavesQuietly();
    expect(log).toEqual([]);
  });
});

describe("the binding table (WP-D catalog)", () => {
  it("the provider's bindingPath answers FROM CONTAINER_BINDING_PATHS, and every pointer is a catalog row", () => {
    const p = makeProvider();
    for (const field of VISUAL_CONTAINER_FIELD_IDS) {
      const path = p.bindingPath!(region(), field);
      expect(path, field).toBe(CONTAINER_BINDING_PATHS[field]);
      if (path !== null) expect(isBindablePath(CONTAINER_BINDING_KIND, path), path).toBeTruthy();
    }
  });

  it("lockAspect is never bindable; the title's three facts bind at their own rows", () => {
    expect(CONTAINER_BINDING_PATHS.lockAspect).toBeNull();
    expect(CONTAINER_BINDING_PATHS["title.text"]).toBe("/spec/title");
    expect(CONTAINER_BINDING_PATHS["title.color"]).toBe("/spec/config/theme/titleColor");
    expect(CONTAINER_BINDING_PATHS["title.fontSize"]).toBe("/spec/config/theme/titleFontSize");
  });

  it("the binding ref is the chart id (async, ruling R5)", async () => {
    await expect(makeProvider().bindingRef!(region())).resolves.toEqual({ kind: "chart", id: "c1" });
  });
});

describe("capabilities and data formats", () => {
  it("a data format only for a design-query chart whose mark paints it", () => {
    expect(chartContainerCapabilities(baseSpec).dataFormat).toBe(false);
    const dq = (mark: string) =>
      ({ ...baseSpec, mark, data: { type: "designQuery", dslText: "VALUES: [Sales]", connectionId: "1" } }) as unknown as ChartSpec;
    // The four tile visuals write the Rust-formatted source text: offered.
    for (const mark of ["card", "multiRowCard", "kpi", "gauge"]) {
      expect(chartContainerCapabilities(dq(mark)).dataFormat, mark).toBe(true);
    }
    // A column / bar / line / pie chart's labels, ticks and tooltips never read
    // spec.fieldFormats: offering the card there saved a format nothing painted.
    // SABOTAGE (confirmed): drop the DATA_FORMAT_MARKS test -> "bar" is offered.
    for (const mark of ["bar", "horizontalBar", "line", "pie", "area", "combo"]) {
      expect(chartContainerCapabilities(dq(mark)).dataFormat, mark).toBe(false);
    }
  });

  it("setDataFormat writes spec.fieldFormats[measure] as ONE step; null deletes the key", async () => {
    await load({ ...baseSpec, data: { type: "designQuery", dslText: "VALUES: [Sales]", connectionId: "1" } });
    const p = makeProvider();
    await p.setDataFormat!(region(), "Sales", "#,##0.00");
    expect(getChartById("c1")!.spec.fieldFormats).toEqual({ Sales: "#,##0.00" });
    expect(log).toEqual(["begin:Number Format", "update_chart", "commit"]);
    log.length = 0;
    await p.setDataFormat!(region(), "Sales", null);
    expect(getChartById("c1")!.spec.fieldFormats).toBeUndefined();
    expect(log).toEqual(["begin:Number Format", "update_chart", "commit"]);
  });

  it("setDataFormat refuses a range chart, in words", async () => {
    await expect(makeProvider().setDataFormat!(region(), "Sales", "0%")).rejects.toThrow(/design query/);
  });
});

describe("the legacy outer background moves to the container on load", () => {
  it("theme.background -> container.background.color, theme.backgroundGradient -> .gradient", () => {
    const gradient = { type: "linear", stops: [{ offset: 0, color: "#000" }, { offset: 1, color: "#fff" }] };
    const legacy = { ...baseSpec, config: { theme: { background: "#1e1e1e", backgroundGradient: gradient, plotBackground: "#222" } } };
    const migrated = migrateLegacyChartBackground(legacy as unknown as ChartSpec);
    expect(migrated.container).toEqual({ background: { color: "#1e1e1e", gradient } });
    expect(migrated.config?.theme).toEqual({ plotBackground: "#222" });
  });

  it("a stored chart is read migrated, and resolves to the moved colour", async () => {
    await load({ ...baseSpec, config: { theme: { background: "#1e1e1e" } } });
    const spec = getChartById("c1")!.spec;
    expect(spec.container).toEqual({ background: { color: "#1e1e1e" } });
    expect((spec.config?.theme as Record<string, unknown>).background).toBeUndefined();
    expect(resolveChartContainer("c1", spec).background.color).toBe("#1e1e1e");
  });

  it("a colour the container cannot hold is dropped (the default white shows); nothing to move = the same spec", () => {
    const named = migrateLegacyChartBackground({ ...baseSpec, config: { theme: { background: "navy" } } } as never);
    expect(named.container).toBeUndefined();
    expect(migrateLegacyChartBackground(baseSpec)).toBe(baseSpec);
  });
});

describe("the published region carries the resolved container", () => {
  it("syncChartRegions publishes `container` beside `floating`", async () => {
    const { getGridRegions } = await import("@api/gridOverlays");
    syncChartRegions();
    const r = getGridRegions().find((g) => g.type === "chart") as GridRegion & { container?: { border: { color: string } } };
    expect(r?.container?.border.color).toBe("#d0d0d0");
  });
});
