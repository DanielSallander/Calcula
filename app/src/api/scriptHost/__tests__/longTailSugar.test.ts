//! FILENAME: app/src/api/scriptHost/__tests__/longTailSugar.test.ts
// PURPOSE: The long-tail VBA-convenience batch, at the WIRING level:
//          (1) api.range("A1:B2,D4:E5") resolves to a multi-area facet on the
//              right sheet, and a single-area address is unaffected;
//          (2) api.setRowHeight / api.setColumnWidth convert their unit
//              WORKER-SIDE, so the broker row still only ever sees pixels, and
//              the third argument keeps working as a plain sheet ref;
//          (3) api.refreshAllPivots is one allowlisted row, dispatched once;
//          (4) the onBeforeSave detail carries `kind` ("save" | "saveAs")
//              across the sandbox boundary, and nothing else new does.
// CONTEXT: The pure model (slicing bounds, area splitting, the unit maths) is
//          tested in worker/canonicalModel.test.ts; this file is about what
//          actually crosses to the host.

import { describe, expect, it } from "vitest";
import { ALLOWLIST, thinWorkbookPathDetail } from "../allowlist";
import { vNone } from "../validators";
import { buildWorkerContext, type WorkerRuntime } from "../worker/contextShims";
import type { MountSpec, W2H } from "../protocol";
import type { ScriptRange, ScriptRangeAreas } from "../worker/canonicalModel";

interface PostedCall {
  callId: number;
  method: string;
  args: unknown[];
}

function makeContext(): {
  api: Record<string, unknown>;
  rt: WorkerRuntime;
  calls: PostedCall[];
  drain: () => void;
} {
  const calls: PostedCall[] = [];
  const spec = {
    protocolVersion: 1,
    scriptId: "long-tail-test",
    objectType: "sheet",
    instanceId: null,
    tier: "unlocked",
    capabilities: [],
    apiVersion: "1.0.0",
    scriptName: "LongTail",
    packageInfo: null,
    snapshot: {},
    source: "",
  } as unknown as MountSpec;
  const { context, rt } = buildWorkerContext(spec, (msg: W2H) => {
    if (msg.t === "call") calls.push({ callId: msg.callId, method: msg.method, args: msg.args });
  });
  const drain = (): void => {
    for (const entry of rt.pending.values()) clearTimeout(entry.timer);
    rt.pending.clear();
  };
  return { api: context.api as Record<string, unknown>, rt, calls, drain };
}

/** Settle every RPC this shim call needed, in the order the worker asked. */
async function settle(
  rt: WorkerRuntime,
  calls: PostedCall[],
  answers: Record<string, unknown>,
): Promise<void> {
  // Answers arrive as the worker posts them; one microtask turn per call is
  // enough because each shim path awaits its previous call.
  for (let guard = 0; guard < 10; guard++) {
    let settledOne = false;
    for (const call of calls) {
      if (!rt.pending.has(call.callId)) continue;
      if (!(call.method in answers)) continue;
      rt.settleCall(call.callId, true, answers[call.method]);
      settledOne = true;
    }
    await Promise.resolve();
    await Promise.resolve();
    if (!settledOne && guard > 0) break;
  }
}

// ============================================================================
// (1) api.range: multi-area
// ============================================================================

describe("api.range with a comma address", () => {
  it("answers a multi-area facet bound to the ACTIVE sheet", async () => {
    const { api, rt, calls } = makeContext();
    const promise = (api.range as (a: string) => Promise<ScriptRange | ScriptRangeAreas>)(
      "A1:B2,D4:E5",
    );
    await settle(rt, calls, {
      "api.getSheetNames": ["Intro", "Data"],
      "api.getActiveSheet": 1,
    });
    const result = await promise;
    expect("areas" in result).toBe(true);
    const areas = result as ScriptRangeAreas;
    expect(areas.count).toBe(2);
    expect(areas.address).toBe("A1:B2,D4:E5");
    // The areas must read the ACTIVE sheet (index 1), not sheet 0.
    calls.length = 0;
    void areas.areas[1].getValue();
    // sheet.getCellValue args are [row, col, sheetIndex] — D4 on sheet 1.
    expect(calls[0].method).toBe("sheet.getCellValue");
    expect(calls[0].args).toEqual([3, 3, 1]);
    for (const entry of rt.pending.values()) clearTimeout(entry.timer);
  });

  it("a \"Sheet!\" prefix on the FIRST area binds every area to that sheet", async () => {
    const { api, rt, calls } = makeContext();
    const promise = (api.range as (a: string) => Promise<ScriptRange | ScriptRangeAreas>)(
      "Data!A1:B2,D4:E5",
    );
    await settle(rt, calls, { "api.getSheetNames": ["Intro", "Data"] });
    const areas = (await promise) as ScriptRangeAreas;
    expect(areas.count).toBe(2);
    calls.length = 0;
    void areas.areas[1].getValue();
    // Data (index 1), resolved ONCE from the first area and shared by both.
    expect(calls[0].args).toEqual([3, 3, 1]);
    for (const entry of rt.pending.values()) clearTimeout(entry.timer);
  });

  it("REJECTS a second area that names its own sheet", async () => {
    const { api, rt, calls, drain } = makeContext();
    const promise = (api.range as (a: string) => Promise<unknown>)("Data!A1,Intro!B2");
    await settle(rt, calls, { "api.getSheetNames": ["Intro", "Data"] });
    await expect(promise).rejects.toThrow(/only the FIRST area/);
    drain();
  });

  it("REJECTS a named range or table inside a comma list", async () => {
    const { api, rt, calls, drain } = makeContext();
    const promise = (api.range as (a: string) => Promise<unknown>)("A1:B2,SalesData");
    await settle(rt, calls, {
      "api.getSheetNames": ["Sheet1"],
      "api.getActiveSheet": 0,
    });
    await expect(promise).rejects.toThrow(/must be an A1 rectangle/);
    drain();
  });

  it("a single-area address still answers an ordinary ScriptRange", async () => {
    const { api, rt, calls, drain } = makeContext();
    const promise = (api.range as (a: string) => Promise<ScriptRange | ScriptRangeAreas>)("A1:B2");
    await settle(rt, calls, {
      "api.getSheetNames": ["Sheet1"],
      "api.getActiveSheet": 0,
    });
    const result = await promise;
    expect("areas" in result).toBe(false);
    expect((result as ScriptRange).address).toBe("A1:B2");
    drain();
  });
});

// ============================================================================
// (2) dimension units convert WORKER-SIDE
// ============================================================================

describe("api.setRowHeight / api.setColumnWidth units", () => {
  it("default and explicit px pass straight through", () => {
    const { api, calls, drain } = makeContext();
    void (api.setRowHeight as (...a: unknown[]) => Promise<void>)(0, 40);
    void (api.setRowHeight as (...a: unknown[]) => Promise<void>)(1, 40, { unit: "px" });
    void (api.setColumnWidth as (...a: unknown[]) => Promise<void>)(2, 120);
    void (api.setColumnWidth as (...a: unknown[]) => Promise<void>)(3, 120, { unit: "px" });
    expect(calls.map((c) => [c.method, ...c.args])).toEqual([
      ["api.setRowHeight", 0, 40, undefined],
      ["api.setRowHeight", 1, 40, undefined],
      ["api.setColumnWidth", 2, 120, undefined],
      ["api.setColumnWidth", 3, 120, undefined],
    ]);
    drain();
  });

  it("pt and chars are converted BEFORE the broker call (it only sees pixels)", () => {
    const { api, calls, drain } = makeContext();
    void (api.setRowHeight as (...a: unknown[]) => Promise<void>)(0, 15, { unit: "pt" });
    void (api.setColumnWidth as (...a: unknown[]) => Promise<void>)(1, 8.47, { unit: "chars" });
    expect(calls[0].args[1]).toBe(20); // 15pt * 96/72
    expect(calls[1].args[1]).toBeCloseTo(64.29, 10); // 8.47 chars * 7 + 5
    drain();
  });

  it("the third argument still accepts a plain sheet ref, and the bag carries one", () => {
    const { api, calls, drain } = makeContext();
    void (api.setRowHeight as (...a: unknown[]) => Promise<void>)(0, 40, "Sheet2");
    void (api.setRowHeight as (...a: unknown[]) => Promise<void>)(1, 30, {
      unit: "pt",
      sheet: 2,
    });
    void (api.setColumnWidth as (...a: unknown[]) => Promise<void>)(2, 120, 1);
    expect(calls.map((c) => [c.method, ...c.args])).toEqual([
      ["api.setRowHeight", 0, 40, "Sheet2"],
      ["api.setRowHeight", 1, 40, 2],
      ["api.setColumnWidth", 2, 120, 1],
    ]);
    drain();
  });

  it("an unknown unit REJECTS instead of quietly meaning pixels", async () => {
    const { api, drain } = makeContext();
    expect(() =>
      (api.setRowHeight as (...a: unknown[]) => Promise<void>)(0, 40, { unit: "em" }),
    ).toThrow(/"px" or "pt"/);
    expect(() =>
      (api.setColumnWidth as (...a: unknown[]) => Promise<void>)(0, 40, { unit: "pt" }),
    ).toThrow(/"px" or "chars"/);
    drain();
  });
});

// ============================================================================
// (3) api.refreshAllPivots
// ============================================================================

describe("api.refreshAllPivots", () => {
  it("is an unlocked-tier mutate with no capability and no arguments", () => {
    const policy = ALLOWLIST["api.refreshAllPivots"];
    expect(policy).toMatchObject({ tier: "unlocked", class: "mutate" });
    expect(policy.capability).toBeUndefined();
    expect(policy.validate).toBe(vNone);
    expect(policy.desc).toMatch(/pivot/i);
  });

  it("dispatches ONE call, not a loop over the pivots", () => {
    const { api, calls, drain } = makeContext();
    void (api.refreshAllPivots as () => Promise<unknown>)();
    expect(calls).toHaveLength(1);
    expect(calls[0].method).toBe("api.refreshAllPivots");
    expect(calls[0].args).toEqual([]);
    drain();
  });
});

// ============================================================================
// (4) the onBeforeSave detail keeps its FLAVOUR across the sandbox boundary
// ============================================================================

describe("thinWorkbookPathDetail", () => {
  it("reduces the path to a file name and carries the save kind", () => {
    expect(thinWorkbookPathDetail({ path: "C:/Users/Ada/Consulting/q4.cala", kind: "saveAs" }))
      .toEqual({ fileName: "q4.cala", kind: "saveAs" });
    expect(thinWorkbookPathDetail({ path: "C:/books/q4.cala", kind: "save" }))
      .toEqual({ fileName: "q4.cala", kind: "save" });
  });

  it("omits kind when there is none (close and print carry no flavour)", () => {
    expect(thinWorkbookPathDetail({})).toEqual({ fileName: null });
    expect(thinWorkbookPathDetail(undefined)).toEqual({ fileName: null });
  });

  it("drops an unrecognised kind rather than forwarding it", () => {
    expect(thinWorkbookPathDetail({ path: "a.cala", kind: "export" }))
      .toEqual({ fileName: "a.cala" });
    expect(thinWorkbookPathDetail({ path: "a.cala", kind: 7 }))
      .toEqual({ fileName: "a.cala" });
  });

  it("still refuses to forward the FOLDER, kind or not", () => {
    const thinned = thinWorkbookPathDetail({
      path: "C:/Users/Ada/Consulting/ClientX/q4.cala",
      kind: "save",
    });
    expect(JSON.stringify(thinned)).not.toContain("Consulting");
    expect(JSON.stringify(thinned)).not.toContain("ClientX");
  });
});
