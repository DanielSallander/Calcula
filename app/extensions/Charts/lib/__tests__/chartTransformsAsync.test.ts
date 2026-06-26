//! FILENAME: app/extensions/Charts/lib/__tests__/chartTransformsAsync.test.ts
// PURPOSE: Feature 1 — applyTransformsAsync awaits SANDBOXED transforms IN PIPELINE
//          ORDER while running built-ins/in-process steps synchronously. The runner
//          decides per step (Promise => sandbox, null => sync). A `[builtin, sandbox]`
//          pipeline must feed the builtin's OUTPUT to the sandbox step (the key
//          correctness property vs pre-resolving against raw data); a sandbox throw
//          or malformed return degrades to a diagnostic + the unchanged input.

import { describe, it, expect } from "vitest";
import { applyTransformsAsync, isValidParsedChartData, type SandboxTransformRunner } from "../chartTransforms";
import type { ParsedChartData, TransformSpec, TransformDiagnostic } from "../../types";

const baseData = (): ParsedChartData => ({
  categories: ["a", "b"],
  series: [{ name: "S", values: [1, 2], color: null }],
});

// Treats any `sandbox:*` type as a sandbox step; `impl` maps the input data->output.
const runnerFor = (impls: Record<string, (d: ParsedChartData, spec: TransformSpec, params: ReadonlyMap<string, unknown> | undefined) => Promise<ParsedChartData>>): SandboxTransformRunner =>
  (type, data, transform, params) => (impls[type] ? impls[type](data, transform, params) : null);

const custom = (type: string, extra: Record<string, unknown> = {}): TransformSpec => ({ type, ...extra } as never);

describe("applyTransformsAsync", () => {
  it("runs a sandbox transform and flows its output on", async () => {
    const runner = runnerFor({
      "sandbox:double": async (d) => ({ ...d, series: d.series.map((s) => ({ ...s, values: s.values.map((v) => v * 2) })) }),
    });
    const out = await applyTransformsAsync(baseData(), [custom("sandbox:double")], runner);
    expect(out.series[0].values).toEqual([2, 4]);
  });

  it("feeds a built-in's OUTPUT into a later sandbox step (pipeline order, not raw data)", async () => {
    // sort desc by S -> [b(2), a(1)]; then sandbox doubles -> [4, 2]. If the sandbox
    // ran against RAW data it would see [1,2] and produce [2,4] with categories [a,b].
    const runner = runnerFor({
      "sandbox:double": async (d) => ({ ...d, series: d.series.map((s) => ({ ...s, values: s.values.map((v) => v * 2) })) }),
    });
    const out = await applyTransformsAsync(
      baseData(),
      [{ type: "sort", field: "S", order: "desc" }, custom("sandbox:double")],
      runner,
    );
    expect(out.categories).toEqual(["b", "a"]);
    expect(out.series[0].values).toEqual([4, 2]);
  });

  it("feeds a sandbox step's output into a later BUILT-IN step", async () => {
    // sandbox negates -> [-1,-2]; then sort asc by S -> [-2(b), -1(a)].
    const runner = runnerFor({
      "sandbox:neg": async (d) => ({ ...d, series: d.series.map((s) => ({ ...s, values: s.values.map((v) => -v) })) }),
    });
    const out = await applyTransformsAsync(
      baseData(),
      [custom("sandbox:neg"), { type: "sort", field: "S", order: "asc" }],
      runner,
    );
    expect(out.categories).toEqual(["b", "a"]);
    expect(out.series[0].values).toEqual([-2, -1]);
  });

  it("degrades to a diagnostic + input data when a sandbox transform throws", async () => {
    const runner = runnerFor({ "sandbox:boom": async () => { throw new Error("kaboom"); } });
    const diags: TransformDiagnostic[] = [];
    const out = await applyTransformsAsync(baseData(), [custom("sandbox:boom")], runner, diags);
    expect(out.series[0].values).toEqual([1, 2]); // unchanged
    expect(diags.some((d) => d.severity === "error" && d.message.includes("kaboom"))).toBe(true);
  });

  it("degrades when a sandbox transform returns a malformed value", async () => {
    const runner = runnerFor({ "sandbox:bad": async () => ({ nope: true } as unknown as ParsedChartData) });
    const diags: TransformDiagnostic[] = [];
    const out = await applyTransformsAsync(baseData(), [custom("sandbox:bad")], runner, diags);
    expect(out.series[0].values).toEqual([1, 2]); // unchanged
    expect(diags.some((d) => d.severity === "error" && d.message.includes("invalid chart data"))).toBe(true);
  });

  it("rejects a sandbox return whose series lack values[] (would crash downstream)", async () => {
    const runner = runnerFor({
      "sandbox:bad": async () => ({ categories: ["a", "b"], series: [{ name: "x" }] } as unknown as ParsedChartData),
    });
    const diags: TransformDiagnostic[] = [];
    const out = await applyTransformsAsync(
      baseData(),
      [custom("sandbox:bad"), { type: "sort", field: "S", order: "asc" }],
      runner, diags,
    );
    expect(out.series[0].values).toEqual([1, 2]); // unchanged; pipeline did not crash
    expect(diags.some((d) => d.severity === "error" && d.message.includes("invalid chart data"))).toBe(true);
  });

  it("routes a null-runner step to the synchronous pipeline (built-ins still work)", async () => {
    const runner: SandboxTransformRunner = () => null; // nothing is a sandbox transform
    const out = await applyTransformsAsync(baseData(), [{ type: "sort", field: "S", order: "desc" }], runner);
    expect(out.categories).toEqual(["b", "a"]);
  });

  it("passes the named params to the sandbox runner", async () => {
    let seen: unknown;
    const runner = runnerFor({
      "sandbox:p": async (d, _spec, params) => { seen = params?.get("Threshold"); return d; },
    });
    await applyTransformsAsync(baseData(), [custom("sandbox:p")], runner, undefined, undefined, undefined, new Map([["Threshold", 42]]));
    expect(seen).toBe(42);
  });
});

describe("isValidParsedChartData", () => {
  it("accepts well-formed data and rejects malformed shapes", () => {
    expect(isValidParsedChartData({ categories: [], series: [] })).toBe(true);
    expect(isValidParsedChartData({ categories: ["a"], series: [{ name: "S", values: [1] }] })).toBe(true);
    expect(isValidParsedChartData(null)).toBe(false);
    expect(isValidParsedChartData({ categories: [] })).toBe(false);
    expect(isValidParsedChartData({ categories: [], series: [{ name: "x" }] })).toBe(false);
    expect(isValidParsedChartData({ categories: [], series: [{ values: [1] }] })).toBe(false);
  });
});
