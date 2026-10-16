//! FILENAME: app/extensions/Charts/components/__tests__/elementCardOneStep.test.tsx
// PURPOSE: The "Chart elements" card (the old Format Chart pane's body, now on
//          the object pane's Format tab) keeps the ONE-STEP rule of the
//          visual container (WP-C S9a, review R2-7):
//            - an element edit (here: the legend position) is ONE undo step
//              "Format Chart" with the store's debounced `update_chart` landed
//              INSIDE it, not 300 ms later as a step of its own;
//            - the chart area's Background writes the CONTAINER
//              (`container.background.color`, through commitObjectFormat:
//              "Format Object"), never `config.theme.background`.
// CONTEXT: The real card, the real chart store, the real format seam and the
//          real undo transaction; the backend (chart channel + the undo
//          begin/commit) is doubled into ONE ordered log.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import React from "react";
import { createRoot, type Root } from "react-dom/client";
import { act } from "react";

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

import { setGridRegions } from "@api/gridOverlays";
import { publishChartSelection, resetChartSelectionRegistry } from "@api/chartSelection";
import { registerObjectFormatProvider, resetObjectFormatProviders } from "@api/objectFormat";
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
} from "../../lib/chartStore";
import { chartsBackend } from "../../lib/chartsBackend";
import { createChartObjectFormatProvider } from "../../lib/chartObjectFormat";
import { ChartElementFormatCard, elementFormatCommitSettled } from "../ChartFormatPane";
import type { ChartSpec } from "../../types";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

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
  legend: { visible: true, position: "bottom" },
  palette: "default",
} as unknown as ChartSpec;

const invokeBackend = vi.fn();
let host: HTMLDivElement;
let root: Root;

async function mount(): Promise<void> {
  syncChartRegions();
  const { getGridRegions } = await import("@api/gridOverlays");
  const region = getGridRegions().find((r) => r.type === "chart")!;
  await act(async () => {
    root.render(React.createElement(ChartElementFormatCard, { region, readOnly: false, readOnlyReason: null }));
  });
}

beforeEach(async () => {
  log.length = 0;
  resetChartStore();
  resetObjectFormatProviders();
  resetChartSelectionRegistry();
  setGridRegions([]);
  chartsBackend.set(invokeBackend);
  invokeBackend.mockReset();
  invokeBackend.mockResolvedValueOnce([
    {
      id: "c1",
      sheetIndex: 0,
      specJson: JSON.stringify({ chartId: "c1", name: "Chart 1", sheetIndex: 0, x: 10, y: 20, width: 400, height: 300, spec: baseSpec }),
    },
  ]);
  await loadChartsFromBackend({ stampSheetIds: false });
  invokeBackend.mockReset();
  invokeBackend.mockImplementation((cmd: string) => {
    log.push(cmd);
    return new Promise((resolve) => setTimeout(() => resolve(undefined), 0));
  });
  registerObjectFormatProvider(
    createChartObjectFormatProvider({
      getStoredSpec: (id) => getPreviewBaseSpec(id),
      updateSpec: (id, patch) => updateChartSpec(id, patch),
      previewSpec: (id, patch) => previewChartSpec(id, patch),
      restorePreview: () => restoreChartSpecPreview(),
      repaint: () => syncChartRegions(),
      flushQuietly: () => flushPendingChartSavesQuietly(),
      reportOther: () => {},
    }),
  );
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  resetChartStore();
  setGridRegions([]);
});

async function settle(): Promise<void> {
  for (let i = 0; i < 5; i++) {
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
  }
}

describe("the Chart elements card writes in ONE undo step", () => {
  it("an element edit (legend position) is one 'Format Chart' step, the write inside it", async () => {
    publishChartSelection({ chartId: "c1", chartName: "Chart 1", level: "element", elementId: "legend" });
    await mount();
    const select = Array.from(host.querySelectorAll("select")).find((s) =>
      Array.from(s.options).some((o) => o.value === "top"),
    )!;
    expect(select).toBeDefined();
    await act(async () => {
      select.value = "top";
      select.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await elementFormatCommitSettled();
    expect(getChartById("c1")!.spec.legend.position).toBe("top");
    expect(log).toEqual(["begin:Format Chart", "update_chart", "commit"]);
  });

  it("the chart area's Background writes the CONTAINER (Format Object), never the theme", async () => {
    publishChartSelection({ chartId: "c1", chartName: "Chart 1", level: "chart" });
    await mount();
    const input = host.querySelector('input[type="color"][aria-label="Background"]') as HTMLInputElement;
    expect(input).not.toBeNull();
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
      setter.call(input, "#1e1e1e");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await settle();
    const spec = getChartById("c1")!.spec;
    expect(spec.container).toEqual({ background: { color: "#1e1e1e" } });
    expect((spec.config?.theme as Record<string, unknown> | undefined)?.background).toBeUndefined();
    expect(log).toEqual(["begin:Format Object", "update_chart", "commit"]);
  });
});
