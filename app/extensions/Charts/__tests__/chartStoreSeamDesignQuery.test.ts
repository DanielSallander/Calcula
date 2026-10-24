//! FILENAME: app/extensions/Charts/__tests__/chartStoreSeamDesignQuery.test.ts
// PURPOSE: The Charts extension answers the two PURE @api chart store seam
//          methods a caller outside Charts needs before it commits to anything
//          (contract C6; docs/design/model-drillthrough.md 2.8):
//            - `buildDesignQueryChartSpec` completes a design-query chart from
//              Charts' OWN default skeleton (the drill-through used to hand-copy
//              the recipe into _shared -- review F3);
//            - `validateChartSpec` is the very gate `createChart` runs, so the
//              drill-through can refuse an invalid chart BEFORE it adds its
//              temporary sheet (review F5 / presentation-gate) -- the same
//              verdict createChart would reach, proved here by createChart
//              refusing exactly the spec the seam refused.
// CONTEXT: Activated through the real extension entry (the lifecycle harness),
//          so this is the registration in Charts/index.ts that is under test,
//          not the library function behind it.

import { describe, it, expect, vi } from "vitest";
import { loadHarness, settle, type Loader } from "../../ModelMenu/__tests__/lifecycleHarness";

vi.mock("@api/backend", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@api/backend")>()),
  listenForEvent: vi.fn(async () => () => {}),
  listenTauriEvent: vi.fn(async () => () => {}),
}));
vi.mock("@tauri-apps/api/core", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tauri-apps/api/core")>()),
  invoke: vi.fn(async (cmd: string) => (cmd === "get_all_styles" ? [] : null)),
}));
vi.mock("@tauri-apps/api/event", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tauri-apps/api/event")>()),
  emit: vi.fn(async () => undefined),
  listen: vi.fn(async () => () => {}),
}));

const CHARTS: Loader = () => import("..");

const REQUEST = {
  dslText: 'ROWS: Product.Category\nVALUES: [Revenue]\nFILTERS: [Geo.Region] = ("West")',
  connectionId: "conn-1",
  mark: "bar",
  markOptions: { stackMode: "stacked" },
  title: "Product detail: West",
};

describe("the Charts extension's chart store seam: buildDesignQueryChartSpec + validateChartSpec (C6)", () => {
  it("builds the drill chart from Charts' own skeleton, validates with createChart's gate, and is gone after deactivate", async () => {
    const { ext, context } = await loadHarness(CHARTS);
    await ext.activate(context);
    await settle();
    // The registry and the library as the activated extension sees them
    // (the harness re-imports every module per load).
    const { getChartStoreService } = await import("@api/componentStoreRegistry");
    const { buildDesignQueryChartSpec, defaultChartSkeleton } = await import("../lib/chartSpecDefaults");

    const store = getChartStoreService();
    expect(store, "Charts registered no chart store service").not.toBeNull();
    expect(typeof store!.buildDesignQueryChartSpec, "the seam has no buildDesignQueryChartSpec").toBe("function");
    expect(typeof store!.validateChartSpec, "the seam has no validateChartSpec").toBe("function");

    const spec = store!.buildDesignQueryChartSpec(REQUEST);
    // Charts' own builder, from Charts' own skeleton.
    expect(spec).toEqual(buildDesignQueryChartSpec(REQUEST));
    const skeleton = defaultChartSkeleton("bar");
    expect(spec.xAxis).toEqual(skeleton.xAxis);
    expect(spec.yAxis).toEqual(skeleton.yAxis);
    expect(spec.legend).toEqual(skeleton.legend);
    expect(spec.palette).toBe(skeleton.palette);
    expect(spec.data).toEqual({ type: "designQuery", dslText: REQUEST.dslText, connectionId: "conn-1" });
    expect(spec.markOptions).toEqual({ stackMode: "stacked" });
    expect(spec.title).toBe(REQUEST.title);

    // A complete, valid spec by createChart's own gate.
    expect(store!.validateChartSpec(spec)).toEqual([]);

    // A presentation createChart would refuse: the seam says so first, with
    // the reason -- and createChart, given the same spec, refuses it too.
    const bad = store!.buildDesignQueryChartSpec({ ...REQUEST, markOptions: { innerRadius: 0.4 } });
    const violations = store!.validateChartSpec(bad);
    expect(violations.join("\n")).toContain("spec.markOptions: unknown property 'innerRadius'");
    expect(() => store!.createChart(bad, { sheetIndex: 0 })).toThrow("unknown property 'innerRadius'");
    expect(store!.validateChartSpec({ ...spec, mark: "bar-3d" }).join("\n")).toContain("spec.mark");

    // PURE: building and validating created nothing.
    expect(store!.listCharts()).toEqual([]);

    await ext.deactivate?.();
    await settle();
  });
});
