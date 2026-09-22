//! FILENAME: app/extensions/Charts/lib/__tests__/chartSaveFlushOrdering.test.ts
// PURPOSE: The pending chart saves must be IN AppState before `save_file` runs,
//          not merely started before it.
// CONTEXT: The first attempt at this hooked `AppEvents.BEFORE_SAVE`. That is a
//          synchronous `dispatchEvent` which does not await its listeners, while
//          `flushDirtyCharts` awaits each `update_chart` in turn — so with TWO
//          dirty charts the listener got as far as chart A's first await, the
//          caller posted `save_file`, and chart B's write went out AFTER it. The
//          recorded order was ["update_chart", "save_file", "update_chart"] and
//          the file on disk held B's old spec while the UI reported a clean save.
//
//          Two halves, because either alone is a false pass:
//            (1) the MECHANISM — a guard registered with `registerLifecycleGuard`
//                is awaited by `checkLifecycleGuards`, which `saveFile` awaits
//                before `save_file` and `Layout` awaits before `isFileModified`;
//            (2) the WIRING — `extensions/Charts/index.ts` uses that mechanism.
//          (2) is read as source for the reason chartsExtensionWiring.test.ts
//          gives: importing activate() pulls in half the extension.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "fs";
import path from "path";

vi.mock("@api/dialogs", () => ({ alertAsync: () => Promise.resolve() }));

import {
  loadChartsFromBackend,
  updateChartSpec,
  flushPendingChartSaves,
  resetChartStore,
} from "../chartStore";
import { chartsBackend } from "../chartsBackend";
import {
  registerLifecycleGuard,
  checkLifecycleGuards,
  resetLifecycleGuards,
} from "@api/lifecycleGuards";
import type { ChartSpec } from "../../types";

const baseSpec = {
  mark: "bar",
  data: "Sheet1!A1:D13",
  hasHeaders: true,
  seriesOrientation: "columns",
  categoryIndex: 0,
  series: [{ name: "Revenue", sourceIndex: 1, color: null }],
  title: "Persisted",
  xAxis: { title: null, gridLines: false, showLabels: true, labelAngle: 0, min: null, max: null },
  yAxis: { title: null, gridLines: true, showLabels: true, labelAngle: 0, min: null, max: null },
  legend: { visible: false, position: "bottom" },
  palette: "default",
} as unknown as ChartSpec;

const entry = (chartId: string, name: string) => ({
  id: chartId,
  sheetIndex: 0,
  specJson: JSON.stringify({
    chartId, name, sheetIndex: 0, x: 10, y: 20, width: 400, height: 300, spec: baseSpec,
  }),
});

const invokeBackend = vi.fn();

/** Every backend command, in the order it was POSTED. */
let order: string[] = [];

beforeEach(async () => {
  resetChartStore();
  resetLifecycleGuards();
  order = [];
  invokeBackend.mockReset();
  chartsBackend.set(invokeBackend);

  invokeBackend.mockResolvedValueOnce([entry("c1", "Revenue"), entry("c2", "Units")]);
  await loadChartsFromBackend();
  invokeBackend.mockReset();

  // Every update_chart resolves on a LATER macrotask, which is what an IPC
  // round-trip does. A promise that resolves in the same microtask would hide
  // the very interleaving this test exists to catch.
  invokeBackend.mockImplementation((cmd: string) => {
    order.push(cmd);
    return new Promise((resolve) => setTimeout(() => resolve(undefined), 0));
  });
});

/** What `saveFile` does: ask the guards, THEN write the file. */
async function saveLikeTheFileApi(): Promise<void> {
  await checkLifecycleGuards("save", { path: "C:/tmp/book.cala", kind: "save" });
  order.push("save_file");
}

describe("two charts edited inside one debounce window are both in the saved file", () => {
  it("a lifecycle guard that awaits the flush puts BOTH update_chart calls before save_file", async () => {
    registerLifecycleGuard(async (action) => {
      if (action === "save" || action === "close") await flushPendingChartSaves();
      return null;
    });

    updateChartSpec("c1", { title: "A edited" } as Partial<ChartSpec>);
    updateChartSpec("c2", { title: "B edited" } as Partial<ChartSpec>);

    await saveLikeTheFileApi();

    expect(order).toEqual(["update_chart", "update_chart", "save_file"]);
  });

  it("NEGATIVE CONTROL: a guard that does not await the flush loses the second chart", async () => {
    // The shape the BEFORE_SAVE listener had. If this produced the same order as
    // the test above, the test above would be proving nothing about awaiting.
    registerLifecycleGuard(async (action) => {
      if (action === "save" || action === "close") void flushPendingChartSaves();
      return null;
    });

    updateChartSpec("c1", { title: "A edited" } as Partial<ChartSpec>);
    updateChartSpec("c2", { title: "B edited" } as Partial<ChartSpec>);

    await saveLikeTheFileApi();

    expect(order).toEqual(["update_chart", "save_file"]);
    expect(order.indexOf("save_file")).toBeLessThan(2);
  });

  it("the guard never cancels the save", async () => {
    registerLifecycleGuard(async (action) => {
      if (action === "save" || action === "close") await flushPendingChartSaves();
      return null;
    });
    updateChartSpec("c1", { title: "A edited" } as Partial<ChartSpec>);
    // A non-null verdict here would CANCEL Ctrl+S — charts insist on being in
    // the save, they never veto it.
    expect(await checkLifecycleGuards("save", { path: "x", kind: "save" })).toBeNull();
    expect(await checkLifecycleGuards("close")).toBeNull();
  });

  it("close is covered too: the flush is awaited before the dirty flag is read", async () => {
    // `Layout.tsx` awaits checkLifecycleGuards("close") and only THEN calls
    // isFileModified(), which is the read that decides whether the
    // close-without-saving prompt appears.
    registerLifecycleGuard(async (action) => {
      if (action === "save" || action === "close") await flushPendingChartSaves();
      return null;
    });
    updateChartSpec("c1", { title: "A edited" } as Partial<ChartSpec>);
    updateChartSpec("c2", { title: "B edited" } as Partial<ChartSpec>);

    await checkLifecycleGuards("close");
    order.push("is_file_modified");

    expect(order).toEqual(["update_chart", "update_chart", "is_file_modified"]);
  });
});

describe("the Charts extension uses that mechanism", () => {
  it("registers the flush as a lifecycle GUARD, not as a BEFORE_SAVE listener", () => {
    const source = readFileSync(path.resolve(__dirname, "../../index.ts"), "utf8");

    const at = source.indexOf("registerLifecycleGuard(");
    expect(at, "Charts registers no lifecycle guard").toBeGreaterThan(-1);

    // The flush is inside THAT call, and it is AWAITED.
    const body = source.slice(at, at + 400);
    expect(body).toContain("await flushPendingChartSaves()");
    expect(body).toContain('action === "save"');
    expect(body).toContain('action === "close"');

    // And the fire-and-forget spelling is gone from the file entirely.
    expect(source).not.toContain("void flushPendingChartSaves()");
  });
});
