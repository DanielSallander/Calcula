//! FILENAME: app/extensions/Charts/lib/__tests__/chartPreviewAfterRefusal.test.ts
// PURPOSE: A live colour preview that is up when the backend REFUSES a chart
//          write must not survive the rollback.
// CONTEXT: `rollbackToPersisted` put the chart back to the last confirmed spec
//          and the modal said "Nothing was written to the workbook, so what you
//          see now matches what is stored" — while `activePreview.original`
//          still held the REFUSED spec. The next mouse-out spent that token and
//          painted the refused edit back onto the canvas; the next real edit
//          then deep-merged onto it and persisted it. `formatPanePreviewStore`
//          covers deletion, File > New/Open and reset, and had no
//          persist-failure case at all.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const alertAsync = vi.fn<(message: string, options?: unknown) => Promise<void>>(
  () => Promise.resolve(),
);
vi.mock("@api/dialogs", () => ({ alertAsync: (m: string, o?: unknown) => alertAsync(m, o) }));

import {
  getChartById,
  loadChartsFromBackend,
  updateChartSpec,
  previewChartSpec,
  restoreChartSpecPreview,
  isChartSpecPreviewActive,
  getPreviewBaseSpec,
  flushPendingChartSaves,
  resetChartStore,
} from "../chartStore";
import { chartsBackend } from "../chartsBackend";
import type { ChartSpec } from "../../types";

const STORED_TITLE = "Stored";
const EDITED_TITLE = "Refused edit";
const PREVIEW_TITLE = "Hovered";
const PROTECTED = "Sheet is protected: edit objects is not allowed";

const baseSpec = {
  mark: "bar",
  data: "Sheet1!A1:D13",
  hasHeaders: true,
  seriesOrientation: "columns",
  categoryIndex: 0,
  series: [{ name: "Revenue", sourceIndex: 1, color: null }],
  title: STORED_TITLE,
  xAxis: { title: null, gridLines: false, showLabels: true, labelAngle: 0, min: null, max: null },
  yAxis: { title: null, gridLines: true, showLabels: true, labelAngle: 0, min: null, max: null },
  legend: { visible: false, position: "bottom" },
  palette: "default",
} as unknown as ChartSpec;

const entry = () => ({
  id: "c1",
  sheetIndex: 0,
  specJson: JSON.stringify({
    chartId: "c1", name: "Revenue", sheetIndex: 0, x: 10, y: 20, width: 400, height: 300, spec: baseSpec,
  }),
});

const invokeBackend = vi.fn();
let errorSpy: ReturnType<typeof vi.spyOn>;

beforeEach(async () => {
  resetChartStore();
  invokeBackend.mockReset();
  alertAsync.mockReset();
  alertAsync.mockImplementation(() => Promise.resolve());
  chartsBackend.set(invokeBackend);
  errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

  invokeBackend.mockResolvedValueOnce([entry()]);
  await loadChartsFromBackend();
  invokeBackend.mockReset();
});

afterEach(() => {
  errorSpy.mockRestore();
});

/**
 * The live sequence: commit an edit, hover a swatch inside the 300 ms window,
 * and let the debounced flush fire and be refused.
 */
async function editThenPreviewThenRefuse(): Promise<void> {
  updateChartSpec("c1", { title: EDITED_TITLE } as Partial<ChartSpec>);
  previewChartSpec("c1", { title: PREVIEW_TITLE } as Partial<ChartSpec>);
  expect(getChartById("c1")?.spec.title).toBe(PREVIEW_TITLE);

  invokeBackend.mockRejectedValue(PROTECTED);
  await flushPendingChartSaves();
}

describe("a refused write takes the live preview's restore token with it", () => {
  it("mouse-out after the refusal does NOT put the refused edit back", async () => {
    await editThenPreviewThenRefuse();

    // The rollback is what the user was told about.
    expect(getChartById("c1")?.spec.title).toBe(STORED_TITLE);
    expect(alertAsync).toHaveBeenCalledTimes(1);

    // The pointer leaves the swatch.
    restoreChartSpecPreview();

    // THE ASSERTION. Before the fix this was EDITED_TITLE: the restore token
    // still pointed at the spec the backend had just refused.
    expect(getChartById("c1")?.spec.title).toBe(STORED_TITLE);
  });

  it("the store stops reporting a preview once the write is refused", async () => {
    await editThenPreviewThenRefuse();
    expect(isChartSpecPreviewActive("c1")).toBe(false);
    expect(restoreChartSpecPreview()).toBeNull();
  });

  it("the NEXT edit builds on the stored spec, not on the refused one", async () => {
    await editThenPreviewThenRefuse();

    // What a commit would start from.
    expect(getPreviewBaseSpec("c1")?.title).toBe(STORED_TITLE);

    invokeBackend.mockReset();
    invokeBackend.mockResolvedValue(undefined);
    updateChartSpec("c1", { palette: "vivid" } as Partial<ChartSpec>);
    await flushPendingChartSaves();

    const spec = getChartById("c1")?.spec;
    expect(spec?.palette).toBe("vivid");
    // The refused title did not ride along on an unrelated edit.
    expect(spec?.title).toBe(STORED_TITLE);
  });

  it("a preview on a DIFFERENT chart is untouched by this chart's refusal", async () => {
    // Only the refused chart's token is stale; dropping every preview would be
    // a second bug in the other direction.
    previewChartSpec("c1", { title: PREVIEW_TITLE } as Partial<ChartSpec>);
    expect(isChartSpecPreviewActive("c1")).toBe(true);

    // Nothing dirty, nothing refused.
    await flushPendingChartSaves();
    expect(isChartSpecPreviewActive("c1")).toBe(true);
    expect(getChartById("c1")?.spec.title).toBe(PREVIEW_TITLE);

    restoreChartSpecPreview();
    expect(getChartById("c1")?.spec.title).toBe(STORED_TITLE);
  });
});
