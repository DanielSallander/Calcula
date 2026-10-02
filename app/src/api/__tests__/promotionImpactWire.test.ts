//! FILENAME: app/src/api/__tests__/promotionImpactWire.test.ts
// PURPOSE: `promotionImpact` is the ONE wrapper of `calp_promotion_impact`, and
//          its answer now carries the promotion's code summary (plan_M8 S5).
//          Its TypeScript shape must be Rust's, field for field.
// CONTEXT: The real @api wrapper with only the backend door doubled, plus drift
//          checks that read, at test time, Rust `PromotionImpactResponse`
//          (app/src-tauri/src/calp_environments.rs) and core `CodeChange`
//          (core/calp/src/code_summary.rs): every serialized field there is a
//          field here, camelCased. A renamed field would leave the Promote
//          dialog reading `undefined` -- and an undefined code list reads like
//          "no code changes".

import { describe, it, expect, vi, beforeEach } from "vitest";
import fs from "node:fs";
import path from "node:path";

const h = vi.hoisted(() => ({ calls: [] as { cmd: string; args: unknown }[] }));

vi.mock("../backend", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../backend")>()),
  invokeBackend: async (cmd: string, args?: unknown) => {
    h.calls.push({ cmd, args });
    return {
      writebackReport: "",
      codeChanges: [],
      asksApprovalAgain: false,
      codeError: null,
    };
  },
}));

import { promotionImpact, type PromotionCodeChange, type PromotionImpact } from "../collaboration";

beforeEach(() => {
  h.calls.length = 0;
});

function rustFields(file: string, struct: string): string[] {
  const src = fs.readFileSync(path.resolve(__dirname, file), "utf8");
  const start = src.indexOf(`pub struct ${struct} {`);
  expect(start, `Rust ${struct} not found in ${file}`).toBeGreaterThanOrEqual(0);
  const body = src.slice(start, src.indexOf("\n}\n", start));
  return [...body.matchAll(/^\s*pub (\w+):/gm)].map((m) => m[1].replace(/_(\w)/g, (_, c: string) => c.toUpperCase()));
}

describe("promotionImpact", () => {
  it("asks calp_promotion_impact with the params, and hands the answer back", async () => {
    const answer = await promotionImpact({
      registryPath: "C:/ws",
      packageName: "sales",
      environment: "prod",
      version: "1.1.0",
    });
    expect(h.calls).toEqual([
      {
        cmd: "calp_promotion_impact",
        args: { params: { registryPath: "C:/ws", packageName: "sales", environment: "prod", version: "1.1.0" } },
      },
    ]);
    expect(answer.codeError).toBeNull();
    expect(answer.codeChanges).toEqual([]);
  });
});

describe("the wire shape is Rust's", () => {
  // SABOTAGE: rename one field of the TS interface (e.g. `codeError` -> `codeErr`).
  it("PromotionImpactResponse: every Rust field is a TypeScript field, camelCased", () => {
    const sample: Required<PromotionImpact> = {
      writebackReport: "",
      codeChanges: [],
      asksApprovalAgain: false,
      codeError: null,
    };
    expect(rustFields("../../../src-tauri/src/calp_environments.rs", "PromotionImpactResponse").sort()).toEqual(
      Object.keys(sample).sort(),
    );
  });

  it("CodeChange: every core field is a TypeScript field, camelCased", () => {
    const sample: Required<PromotionCodeChange> = {
      kind: "macro",
      id: "",
      name: "",
      sheetName: null,
      change: "added",
      detail: "",
      consequence: "asksApprovalAgain",
      before: null,
      after: null,
      beforeTruncated: false,
      afterTruncated: false,
      addedCapabilities: [],
    };
    expect(rustFields("../../../../core/calp/src/code_summary.rs", "CodeChange").sort()).toEqual(
      Object.keys(sample).sort(),
    );
  });

  it("`codeError` is null when absent (Rust serializes None as null, no skip)", () => {
    const src = fs.readFileSync(path.resolve(__dirname, "../../../src-tauri/src/calp_environments.rs"), "utf8");
    const start = src.indexOf("pub struct PromotionImpactResponse {");
    const body = src.slice(start, src.indexOf("\n}\n", start));
    expect(body).toContain("pub code_error: Option<String>,");
    expect(body, "a skip would make the TS field optional, not nullable").not.toContain("skip_serializing_if");
  });
});
