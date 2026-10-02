//! FILENAME: app/src/api/__tests__/workingCopyCodeWire.test.ts
// PURPOSE: `diffWorkingCopy` can ask for the CODE this push changes
//          (`codeSummary`, owner question 14), and its answer's TypeScript shape
//          is Rust's, field for field.
// CONTEXT: The real @api wrapper with only the backend door doubled, plus drift
//          checks that read, at test time, Rust `WorkingCopyDiff`,
//          `WorkingCopyCode` and `DiffWorkingCopyParams`
//          (app/src-tauri/src/calp_diff.rs). The push dialog reads the code with
//          the Promote dialog's reader (`promotionCodeFromImpact`), so a renamed
//          field would leave it reading `undefined` -- which that reader turns
//          into a failure, but a missing opt-in would make the backend answer
//          `code: null` to every push.

import { describe, it, expect, vi, beforeEach } from "vitest";
import fs from "node:fs";
import path from "node:path";

const h = vi.hoisted(() => ({ calls: [] as { cmd: string; args: unknown }[] }));

vi.mock("../backend", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../backend")>()),
  invokeBackend: async (cmd: string, args?: unknown) => {
    h.calls.push({ cmd, args });
    return {
      packageName: "sales",
      baseVersion: "1.0.0",
      diff: {},
      code: { codeChanges: [], asksApprovalAgain: false, codeError: null },
    };
  },
}));

import {
  diffWorkingCopy,
  type PromotionImpact,
  type WorkingCopyCode,
  type WorkingCopyDiff,
} from "../collaboration";

const DIFF_RS = "../../../src-tauri/src/calp_diff.rs";

beforeEach(() => {
  h.calls.length = 0;
});

function rustBody(file: string, struct: string): string {
  const src = fs.readFileSync(path.resolve(__dirname, file), "utf8");
  const start = src.indexOf(`pub struct ${struct} {`);
  expect(start, `Rust ${struct} not found in ${file}`).toBeGreaterThanOrEqual(0);
  return src.slice(start, src.indexOf("\n}\n", start));
}

function rustFields(file: string, struct: string): string[] {
  return [...rustBody(file, struct).matchAll(/^\s*pub (\w+):/gm)].map((m) =>
    m[1].replace(/_(\w)/g, (_, c: string) => c.toUpperCase()),
  );
}

describe("diffWorkingCopy", () => {
  // SABOTAGE: drop the params spread in the wrapper (the opt-in never reaches Rust).
  it("passes `codeSummary` through to calp_diff_working_copy", async () => {
    const answer = await diffWorkingCopy({ codeSummary: true, customObjects: [] });
    expect(h.calls).toHaveLength(1);
    expect(h.calls[0].cmd).toBe("calp_diff_working_copy");
    expect((h.calls[0].args as { params: Record<string, unknown> }).params.codeSummary).toBe(true);
    expect(answer.code?.codeError).toBeNull();
  });
});

describe("the wire shape is Rust's", () => {
  // SABOTAGE: rename a field of the TS interface (e.g. `code` -> `codeSummary`).
  it("WorkingCopyDiff: every Rust field is a TypeScript field, camelCased", () => {
    const sample: Required<WorkingCopyDiff> = {
      packageName: "",
      baseVersion: "",
      diff: {} as WorkingCopyDiff["diff"],
      code: null,
    };
    expect(rustFields(DIFF_RS, "WorkingCopyDiff").sort()).toEqual(Object.keys(sample).sort());
  });

  it("WorkingCopyCode: every Rust field is a TypeScript field -- the promotion impact's three code fields", () => {
    const sample: Required<WorkingCopyCode> = { codeChanges: [], asksApprovalAgain: false, codeError: null };
    expect(rustFields(DIFF_RS, "WorkingCopyCode").sort()).toEqual(Object.keys(sample).sort());
    // ONE reader reads both answers: the push's code is assignable to the slice
    // of the promotion's impact that `promotionCodeFromImpact` picks.
    const asImpact: Pick<PromotionImpact, "codeChanges" | "asksApprovalAgain" | "codeError"> = sample;
    expect(asImpact.codeError).toBeNull();
  });

  it("`code` and `codeError` are null when absent (Rust serializes None as null, no skip)", () => {
    const diff = rustBody(DIFF_RS, "WorkingCopyDiff");
    expect(diff).toContain("pub code: Option<WorkingCopyCode>,");
    expect(diff, "a skip would make the TS field optional, not nullable").not.toContain("skip_serializing_if");
    const code = rustBody(DIFF_RS, "WorkingCopyCode");
    expect(code).toContain("pub code_error: Option<String>,");
    expect(code).not.toContain("skip_serializing_if");
  });

  it("the opt-in is a request field Rust reads, defaulting to false", () => {
    const params = rustBody(DIFF_RS, "DiffWorkingCopyParams");
    expect(params).toMatch(/#\[serde\(default\)\]\s*pub code_summary: bool,/);
    const ts = fs.readFileSync(path.resolve(__dirname, "../collaboration.ts"), "utf8");
    const start = ts.indexOf("export async function diffWorkingCopy(");
    const signature = ts.slice(start, ts.indexOf("): Promise<WorkingCopyDiff>", start));
    expect(signature).toContain("codeSummary?: boolean;");
  });
});
