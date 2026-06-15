//! FILENAME: app/src/api/scriptHost/worker/__tests__/tableContextRange.test.ts
// PURPOSE: Verify the C3-polish table-context Range facet — that table.range()/
//          cell() build a ScriptRange whose data ops route to the EXISTING
//          own-object table.getCellValue / table.setCellValue broker aspects
//          (table-relative coordinates), adding no new privileged surface.

import { describe, it, expect } from "vitest";
import { buildWorkerContext } from "../contextShims";
import type { MountSpec, W2H } from "../../protocol";

function tableContext() {
  const spec: MountSpec = {
    protocolVersion: 1,
    scriptId: "s1",
    objectType: "table",
    instanceId: "tbl-1",
    tier: "restricted",
    capabilities: [],
    apiVersion: "1.0",
    source: "",
    scriptName: "T",
    snapshot: {},
  };
  const posts: Extract<W2H, { t: "call" }>[] = [];
  const post = (msg: W2H) => {
    if (msg.t === "call") posts.push(msg);
  };
  const { context, rt } = buildWorkerContext(spec, post);
  return { table: context as Record<string, any>, rt, posts };
}

describe("table context Range facet (C3 polish)", () => {
  it("range() builds a ScriptRange with table-relative geometry", () => {
    const { table } = tableContext();
    const r = table.range("A1:B3");
    expect(r.address).toBe("A1:B3");
    expect(r.rowCount).toBe(3);
    expect(r.colCount).toBe(2);
    expect(r.isSingleCell).toBe(false);
  });

  it("getValue() routes to the own-object table.getCellValue aspect", async () => {
    const { table, rt, posts } = tableContext();
    const p = table.cell(1, 2).getValue();
    const call = posts.find((m) => m.method === "object.getState");
    expect(call, "expected an object.getState call").toBeDefined();
    expect(call!.args).toEqual(["table.getCellValue", [1, 2]]);
    rt.settleCall(call!.callId, true, "hello", undefined);
    expect(await p).toBe("hello");
  });

  it("setValue() routes to the own-object table.setCellValue aspect", async () => {
    const { table, rt, posts } = tableContext();
    const p = table.cell(0, 0).setValue("x");
    const call = posts.find((m) => m.method === "object.setState");
    expect(call, "expected an object.setState call").toBeDefined();
    expect(call!.args).toEqual(["table.setCellValue", [0, 0, "x"]]);
    rt.settleCall(call!.callId, true, undefined, undefined);
    await p;
  });

  it("a sheet-relative-style address maps to table-relative offsets", async () => {
    const { table, rt, posts } = tableContext();
    // "B2" -> table-relative (row 1, col 1)
    const p = table.range("B2").getValue();
    const call = posts.find((m) => m.method === "object.getState");
    expect(call!.args).toEqual(["table.getCellValue", [1, 1]]);
    rt.settleCall(call!.callId, true, "v", undefined);
    expect(await p).toBe("v");
  });
});
