//! FILENAME: app/extensions/Charts/components/__tests__/formatPanePreviewStore.test.ts
// PURPOSE: CI-14 — the STORE half of the transient preview: the guards that
//          make a missed exit path harmless instead of corrupting.
// CONTEXT:
//          The pane-level exits (mouse-out, commit, pane close, deselect) are
//          proved in formatPanePreview.test.tsx by driving the real DOM. This
//          file proves the three things no pane can promise:
//
//          1. A REAL EDIT NEVER MERGES ONTO A PREVIEW. If it did, the preview
//             would be written into the document by a command innocent of it —
//             the corruption the transient-write rule exists to prevent. So
//             `updateChartSpec` / `replaceChartSpec` restore first, and that is
//             tested by leaving a preview standing DELIBERATELY.
//
//          2. AN UNRELATED PENDING SAVE CANNOT CARRY A PREVIEW TO DISK. This is
//             the exit path that does not exist: a drag scheduled a save 200 ms
//             ago, the reader is now hovering a swatch, and the debounce fires.
//             `toEntry` serialises the WHOLE chart, spec included, so without a
//             guard the preview is persisted by a save about geometry.
//
//          3. THE PREVIEW DIES WITH ITS DOCUMENT. Chart deletion, File > New /
//             Open and a store reset all drop it — a restore token aimed at a
//             chart id from another workbook is the document-scoped-state
//             defect in miniature.
//
//          The store is REAL throughout and the 300 ms debounce is allowed to
//          run: "nothing was persisted" is asserted on the backend channel, not
//          on a spy over the function we hoped would not be called.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const alertAsync = vi.fn<(message: string, options?: unknown) => Promise<void>>(
  () => Promise.resolve(),
);
vi.mock("@api/dialogs", () => ({ alertAsync: (m: string, o?: unknown) => alertAsync(m, o) }));
vi.mock("@api/gridOverlays", () => ({
  removeGridRegionsByType: vi.fn(),
  addGridRegions: vi.fn(),
}));
vi.mock("@api/events", () => ({
  AppEvents: { GRID_REFRESH: "app:grid-refresh", MUTATION_REFRESH: "app:mutation-refresh" },
  emitAppEvent: vi.fn(),
}));

import {
  deleteChart,
  getChartById,
  getPreviewBaseSpec,
  isChartSpecPreviewActive,
  loadChartsFromBackend,
  moveChart,
  previewChartSpec,
  replaceChartSpec,
  resetChartStore,
  restoreChartSpecPreview,
  undoDeleteChart,
  updateChartSpec,
} from "../../lib/chartStore";
import { chartsBackend } from "../../lib/chartsBackend";
import type { ChartSpec } from "../../types";

// ----------------------------------------------------------------------------
// Fixture
// ----------------------------------------------------------------------------

const A = "chart-a";
const B = "chart-b";
const PREVIEW_COLOUR = "#ed7d31";

function spec(title: string): ChartSpec {
  return {
    mark: "bar",
    data: "Sheet1!A1:C4",
    hasHeaders: true,
    seriesOrientation: "columns",
    categoryIndex: 0,
    series: [{ name: "Revenue", sourceIndex: 1, color: null }],
    title,
    xAxis: {},
    yAxis: {},
    legend: { visible: true, position: "right" },
    palette: "default",
  } as unknown as ChartSpec;
}

const invokeBackend = vi.fn();

function entryFor(id: string, title: string) {
  return {
    id,
    sheetIndex: 0,
    specJson: JSON.stringify({
      chartId: id,
      name: id,
      sheetIndex: 0,
      x: 10,
      y: 20,
      width: 400,
      height: 300,
      spec: spec(title),
    }),
  };
}

async function seed(ids: string[] = [A]): Promise<void> {
  invokeBackend.mockImplementation(async (command: string) => {
    if (command === "get_charts") return ids.map((id) => entryFor(id, id));
    return undefined;
  });
  await loadChartsFromBackend();
  invokeBackend.mockClear();
}

/** A preview patch that is visible in the spec and cannot occur by accident. */
function previewPatch(): Partial<ChartSpec> {
  return {
    dataPointOverrides: [{ seriesIndex: 0, categoryIndex: 0, color: PREVIEW_COLOUR }],
  } as Partial<ChartSpec>;
}

function liveSpec(id: string): ChartSpec {
  const chart = getChartById(id);
  if (chart === null) throw new Error(`chart ${id} is gone`);
  return chart.spec;
}

/** Everything that reached the backend channel for `command`. */
function calls(command: string): unknown[] {
  return invokeBackend.mock.calls.filter((c) => c[0] === command).map((c) => c[1]);
}

/** The spec as it was actually serialised for persistence. */
function persistedSpec(payload: unknown): ChartSpec {
  const entry = (payload as { entry: { specJson: string } }).entry;
  return (JSON.parse(entry.specJson) as { spec: ChartSpec }).spec;
}

/** Let the real 300 ms debounce fire. */
async function settleDebounce(): Promise<void> {
  await new Promise((r) => setTimeout(r, 360));
  await new Promise((r) => setTimeout(r, 0));
}

let errorSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  resetChartStore();
  invokeBackend.mockReset();
  alertAsync.mockReset();
  alertAsync.mockImplementation(() => Promise.resolve());
  chartsBackend.set(invokeBackend);
  errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  errorSpy.mockRestore();
  resetChartStore();
});

// ============================================================================
// The preview itself
// ============================================================================

describe("previewChartSpec writes to the render-time spec and nowhere else", () => {
  it("shows the patch, schedules NO save, and restores on demand", async () => {
    await seed();
    const before = liveSpec(A);

    previewChartSpec(A, previewPatch());
    expect(liveSpec(A).dataPointOverrides?.[0]?.color).toBe(PREVIEW_COLOUR);
    expect(isChartSpecPreviewActive(A)).toBe(true);

    await settleDebounce();
    expect(calls("update_chart")).toEqual([]);

    expect(restoreChartSpecPreview()).toBe(A);
    expect(liveSpec(A)).toBe(before);
    expect(isChartSpecPreviewActive()).toBe(false);
    // A second restore is a no-op, not a second mutation.
    expect(restoreChartSpecPreview()).toBeNull();
  });

  it("merges each preview onto the STORED spec, never onto the previous one", async () => {
    await seed();
    previewChartSpec(A, { title: "first" });
    previewChartSpec(A, { legend: { visible: false, position: "top" } } as Partial<ChartSpec>);

    // The second preview replaced the first outright.
    expect(liveSpec(A).title).toBe(A);
    expect(liveSpec(A).legend?.visible).toBe(false);

    restoreChartSpecPreview();
    expect(liveSpec(A).legend?.visible).toBe(true);
  });

  it("previewing a second chart restores the first", async () => {
    await seed([A, B]);
    previewChartSpec(A, { title: "preview-a" });
    previewChartSpec(B, { title: "preview-b" });

    expect(liveSpec(A).title).toBe(A);
    expect(liveSpec(B).title).toBe("preview-b");
    expect(isChartSpecPreviewActive(A)).toBe(false);
    expect(isChartSpecPreviewActive(B)).toBe(true);
  });

  it("hands a commit the STORED spec to build from", async () => {
    await seed();
    previewChartSpec(A, previewPatch());
    expect(getPreviewBaseSpec(A)?.dataPointOverrides).toBeUndefined();
    // With no preview up, the base IS the live spec.
    restoreChartSpecPreview();
    expect(getPreviewBaseSpec(A)).toBe(liveSpec(A));
  });

  it("ignores a chart it does not have", async () => {
    await seed();
    previewChartSpec("no-such-chart", previewPatch());
    expect(isChartSpecPreviewActive()).toBe(false);
  });
});

// ============================================================================
// Guard 1 — a real edit never merges onto a preview
// ============================================================================

describe("a preview left standing cannot reach the document", () => {
  it("updateChartSpec restores before it merges", async () => {
    await seed();
    previewChartSpec(A, previewPatch());

    // The caller "forgot" to restore — the exact defect class under guard.
    updateChartSpec(A, { title: "a real edit" });

    expect(liveSpec(A).title).toBe("a real edit");
    expect(liveSpec(A).dataPointOverrides).toBeUndefined();
    expect(isChartSpecPreviewActive()).toBe(false);

    await settleDebounce();
    const written = calls("update_chart");
    expect(written).toHaveLength(1);
    expect(JSON.stringify(persistedSpec(written[0]))).not.toContain(PREVIEW_COLOUR);
  });

  it("replaceChartSpec drops the preview instead of overwriting under it", async () => {
    await seed();
    previewChartSpec(A, previewPatch());

    replaceChartSpec(A, spec("replaced"));

    expect(liveSpec(A).title).toBe("replaced");
    expect(liveSpec(A).dataPointOverrides).toBeUndefined();
    // The restore token is gone, so a late restore cannot resurrect the old
    // spec on top of the replacement.
    expect(restoreChartSpecPreview()).toBeNull();
    expect(liveSpec(A).title).toBe("replaced");
  });
});

// ============================================================================
// Guard 2 — an unrelated pending save must not carry the preview
// ============================================================================

describe("a save scheduled by something else persists the STORED spec", () => {
  it("a drag's debounced flush does not write the hovered colour", async () => {
    await seed();
    // A drag schedules a save...
    moveChart(A, 120, 240);
    // ...and the reader is hovering a swatch when it fires.
    previewChartSpec(A, previewPatch());

    await settleDebounce();

    const written = calls("update_chart");
    expect(written).toHaveLength(1);
    const persisted = persistedSpec(written[0]);
    expect(persisted.dataPointOverrides).toBeUndefined();
    // The geometry the drag actually produced still landed.
    const entry = (written[0] as { entry: { specJson: string } }).entry;
    expect((JSON.parse(entry.specJson) as { x: number }).x).toBe(120);

    // And the preview is STILL on screen — the pointer has not moved.
    expect(liveSpec(A).dataPointOverrides?.[0]?.color).toBe(PREVIEW_COLOUR);
    expect(isChartSpecPreviewActive(A)).toBe(true);
  });
});

// ============================================================================
// Guard 3 — the preview dies with its chart, and with its document
// ============================================================================

describe("the preview does not outlive what it was previewing", () => {
  it("chart deletion restores first, so undo brings back the stored chart", async () => {
    await seed();
    previewChartSpec(A, previewPatch());

    invokeBackend.mockImplementation(async () => undefined);
    deleteChart(A);
    expect(isChartSpecPreviewActive()).toBe(false);

    const restored = undoDeleteChart();
    expect(restored?.spec.dataPointOverrides).toBeUndefined();
  });

  it("File > New / Open drops it with the outgoing document", async () => {
    await seed();
    previewChartSpec(A, previewPatch());

    // The same chart id in a different workbook is the nastiest case: a
    // surviving restore token would overwrite the NEW document's spec with the
    // old one's.
    await seed([A]);
    expect(isChartSpecPreviewActive()).toBe(false);
    expect(restoreChartSpecPreview()).toBeNull();
    expect(liveSpec(A).dataPointOverrides).toBeUndefined();

    updateChartSpec(A, { title: "fresh" });
    await settleDebounce();
    const written = calls("update_chart");
    expect(written).toHaveLength(1);
    expect(JSON.stringify(persistedSpec(written[0]))).not.toContain(PREVIEW_COLOUR);
  });

  it("a store reset drops it", async () => {
    await seed();
    previewChartSpec(A, previewPatch());
    resetChartStore();
    expect(isChartSpecPreviewActive()).toBe(false);
    expect(restoreChartSpecPreview()).toBeNull();
  });
});
