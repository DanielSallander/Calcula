//! FILENAME: app/extensions/AIChat/__tests__/draftGate.test.ts
// PURPOSE: A script the model gets wrong must never reach the user's review
//          queue, and a rejection must come back as something the model can act
//          on rather than as a refusal.
// CONTEXT: docs/design/local-model-script-authoring.md §5, §11.2.

import { describe, it, expect, vi, beforeEach } from "vitest";

const invoke = vi.fn();
vi.mock("../lib/aiChatBackend", () => ({ aiChatBackend: { invoke: (...a: unknown[]) => invoke(...a) } }));

const { gateToolCall, describeDryRun } = await import("../lib/draftGate");

const GOOD = "export function setup(context) {\n  context.log('x');\n}\n";
const INVENTED = "export function setup(context) {\n  context.api.setCellValu(0, 0, 'x');\n}\n";
const UNDECLARED = "export function setup(context) {\n  context.caps.fetch('https://example.com');\n}\n";
const NO_SETUP = "onClick(() => { context.log('x'); });\n";

// The REAL wire shape, as the Rust backend serialises it (dryRunReportDrift
// pins the field list). The doubles used to omit `applicable`, a shape the
// backend cannot emit — so the judged-failure branch was only ever tested
// against inputs production never produces.
const dryOk = (totalChanges = 1) => ({
  ok: true, error: null, durationMs: 2, changes: [], truncated: false, totalChanges,
  output: [], readBack: [], applicable: true, declinedReason: null,
});
const dryFailed = (error: string) => ({
  ok: false, error, durationMs: 1, changes: [], truncated: false, totalChanges: 0,
  output: [], readBack: [], applicable: true, declinedReason: null,
});

beforeEach(() => {
  invoke.mockReset();
  invoke.mockResolvedValue(dryOk());
});

describe("only the draft path is gated", () => {
  it("lets every other tool through untouched", async () => {
    for (const name of ["set_cell_value", "get_sheet_summary", "create_pivot", "list_script_drafts"]) {
      expect((await gateToolCall(name, { anything: true })).allow, name).toBe(true);
    }
    expect(invoke).not.toHaveBeenCalled();
  });

  it("does NOT gate run_script", async () => {
    // The execute-now path the user asked for explicitly. It is undoable, and
    // refusing it on a static check would be the chat second-guessing a direct
    // instruction.
    expect((await gateToolCall("run_script", { code: INVENTED })).allow).toBe(true);
  });
});

describe("a bad draft is rejected with something the model can act on", () => {
  it("rejects an invented method and names the real one", async () => {
    const v = await gateToolCall("draft_object_script", { source: INVENTED });
    expect(v.allow).toBe(false);
    expect(v.message).toContain("NOT queued for review");
    expect(v.message).toContain("api.setCellValu");
    expect(v.message).toContain("api.setCellValue"); // the suggestion
    expect(v.message).toMatch(/call draft_object_script again/);
  });

  it("rejects an undeclared capability", async () => {
    const v = await gateToolCall("draft_object_script", { source: UNDECLARED });
    expect(v.allow).toBe(false);
    expect(v.message).toContain("// @capability net.fetch");
  });

  it("rejects a script with no setup entry point", async () => {
    const v = await gateToolCall("draft_object_script", { source: NO_SETUP });
    expect(v.allow).toBe(false);
    expect(v.message).toMatch(/defines no `setup` function/);
  });

  it("never dry-runs a draft that already failed the static checks", async () => {
    await gateToolCall("draft_object_script", { source: INVENTED });
    expect(invoke).not.toHaveBeenCalled();
  });
});

describe("L3 — a draft that runs badly is rejected too", () => {
  it("rejects a statically-valid script that throws when run", async () => {
    invoke.mockResolvedValue(dryFailed("TypeError: v.map is not a function"));
    const v = await gateToolCall("draft_object_script", { source: GOOD });
    expect(v.allow).toBe(false);
    expect(v.message).toContain("FAILS when run against a copy of the workbook");
    expect(v.message).toContain("TypeError: v.map is not a function");
  });

  it("allows a script that runs cleanly", async () => {
    invoke.mockResolvedValue(dryOk(3));
    expect((await gateToolCall("draft_object_script", { source: GOOD })).allow).toBe(true);
  });

  it("allows a script that runs cleanly and changes nothing", async () => {
    // "Changed nothing" is only a defect when the task asked for writes, and the
    // gate does not know the task. A read-and-report script is legitimate.
    invoke.mockResolvedValue(dryOk(0));
    expect((await gateToolCall("draft_object_script", { source: GOOD })).allow).toBe(true);
  });
});

describe("the gate fails OPEN when it cannot reach a verdict", () => {
  it("allows the draft when the dry-run command is unavailable", async () => {
    // A gate that turns its own failure into a rejection makes the chat refuse
    // work for a reason the user cannot act on.
    invoke.mockRejectedValue(new Error("Unknown command"));
    expect((await gateToolCall("draft_object_script", { source: GOOD })).allow).toBe(true);
  });

  it("leaves an empty source to the backend's own validation", async () => {
    const v = await gateToolCall("draft_object_script", { source: "" });
    expect(v.allow).toBe(true);
    expect(invoke).not.toHaveBeenCalled();
  });

  it("does not throw on a malformed input object", async () => {
    expect((await gateToolCall("draft_object_script", null)).allow).toBe(true);
    expect((await gateToolCall("draft_object_script", { source: 42 })).allow).toBe(true);
  });
});

describe("describeDryRun", () => {
  it("says what a passing draft would change", () => {
    expect(describeDryRun(dryOk(1))).toContain("1 cell.");
    expect(describeDryRun(dryOk(7))).toContain("7 cells.");
    expect(describeDryRun(dryOk(0))).toContain("changed no cells");
  });

  it("says nothing when there is no report or the run failed", () => {
    expect(describeDryRun(null)).toBe("");
    expect(describeDryRun(dryFailed("x"))).toBe("");
  });
});

describe("a dry run that DECLINED is not a verdict", () => {
  /**
   * The preview runs in the interpreter's realm; an object script is authored
   * against the Worker realm's `context`. The two share a fraction of one
   * surface and the interpreter rejects `export` outright, so the preview
   * answered "it FAILS when run" for every valid draft this feature produced —
   * and the model then spent its repair rounds on correct code.
   */
  const declined = () => ({
    ok: true,
    error: null,
    durationMs: 0,
    changes: [],
    truncated: false,
    totalChanges: 0,
    output: [],
    readBack: [],
    applicable: false,
    declinedReason: "the script is an ES module (`export`/`import`)",
  });

  it("allows a draft the preview could not host", async () => {
    invoke.mockResolvedValue(declined());
    expect((await gateToolCall("draft_object_script", { source: GOOD })).allow).toBe(true);
  });

  it("still rejects on the STATIC checks — declining does not disable the ladder", async () => {
    invoke.mockResolvedValue(declined());
    const v = await gateToolCall("draft_object_script", { source: INVENTED });
    expect(v.allow).toBe(false);
    expect(v.message).toContain("api.setCellValue");
  });

  it("says nothing about a script it never ran", () => {
    // "it changed no cells" reads as a finding, and would be fabricated.
    expect(describeDryRun(declined())).toBe("");
    expect(describeDryRun(dryOk(0))).toContain("changed no cells");
  });

  it("a report that DID run is still judged", async () => {
    invoke.mockResolvedValue(dryFailed("TypeError: x is not a function"));
    const v = await gateToolCall("draft_object_script", { source: GOOD });
    expect(v.allow).toBe(false);
    expect(v.message).toContain("TypeError");
  });
});

describe("an allowed draft carries the dry run's observation", () => {
  it("appends a note naming what the draft would change", async () => {
    invoke.mockResolvedValue(dryOk(3));
    const v = await gateToolCall("draft_object_script", { source: GOOD });
    expect(v.allow).toBe(true);
    expect(v.note).toContain("3 cells");
  });

  it("carries no note when the preview declined", async () => {
    invoke.mockResolvedValue({
      ok: true, error: null, durationMs: 0, changes: [], truncated: false,
      totalChanges: 0, output: [], readBack: [], applicable: false,
      declinedReason: "ES module",
    });
    const v = await gateToolCall("draft_object_script", { source: GOOD });
    expect(v.allow).toBe(true);
    expect(v.note).toBeUndefined();
  });
});

describe("the gate labels its dry runs", () => {
  /**
   * This gate guards `draft_object_script` exclusively, so its scripts are
   * object scripts BY DEFINITION — the label lets the backend decline
   * authoritatively instead of guessing from substrings, which both under- and
   * over-declined (adversarial review, 2026-08-20).
   */
  it("sends surface: object-script with every dry run", async () => {
    invoke.mockResolvedValue(dryOk());
    await gateToolCall("draft_object_script", { source: GOOD });
    expect(invoke).toHaveBeenCalledWith(
      "ai_dry_run_script",
      expect.objectContaining({ surface: "object-script" }),
    );
  });
});
