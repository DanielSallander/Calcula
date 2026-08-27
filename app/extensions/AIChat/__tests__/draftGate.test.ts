//! FILENAME: app/extensions/AIChat/__tests__/draftGate.test.ts
// PURPOSE: A script the model gets wrong must never reach the user's review
//          queue, and a rejection must come back as something the model can act
//          on rather than as a refusal.
// CONTEXT: docs/design/local-model-script-authoring.md §5, §11.2.

import { describe, it, expect, vi, beforeEach } from "vitest";

// The gate's L3 is now the faithful Worker-realm preview, not the Rust
// interpreter's `ai_dry_run_script` — which declined every source this gate
// ever handed it, so the rung was dead here. `previewObjectScript` is doubled
// rather than run: it needs a real Worker, and jsdom has none.
const preview = vi.fn();
vi.mock("@api/scriptHost/scriptPreview", () => ({
  previewObjectScript: (...a: unknown[]) => preview(...a),
}));

const { gateToolCall, describeDryRun, NEEDS_UNLOCKED, NEEDS_UNLOCKED_USER } =
  await import("../lib/draftGate");

const GOOD = "export function setup(context) {\n  context.log('x');\n}\n";
const INVENTED = "export function setup(context) {\n  context.api.setCellValu(0, 0, 'x');\n}\n";
const UNDECLARED = "export function setup(context) {\n  context.caps.fetch('https://example.com');\n}\n";
const NO_SETUP = "onClick(() => { context.log('x'); });\n";

// The REAL report shape. Both rungs produce it: `ai_dry_run_script` serialises
// it (dryRunReportDrift pins the field list against the Rust struct) and the
// Worker-realm preview builds the same one (previewEntry.test.ts pins its
// keys). The doubles used to omit `applicable`, a shape neither can emit — so
// the judged-failure branch was only ever tested against inputs production
// never produces.
const dryOk = (totalChanges = 1) => ({
  ok: true, error: null, durationMs: 2, changes: [], truncated: false, totalChanges,
  output: [], readBack: [], unexercisedHooks: [], applicable: true, declinedReason: null,
});
const dryFailed = (error: string) => ({
  ok: false, error, durationMs: 1, changes: [], truncated: false, totalChanges: 0,
  output: [], readBack: [], unexercisedHooks: [], applicable: true, declinedReason: null,
});

beforeEach(() => {
  preview.mockReset();
  preview.mockResolvedValue(dryOk());
});

describe("only the draft path is gated", () => {
  it("lets every other tool through untouched", async () => {
    for (const name of ["set_cell_value", "get_sheet_summary", "create_pivot", "list_script_drafts"]) {
      expect((await gateToolCall(name, { anything: true })).allow, name).toBe(true);
    }
    expect(preview).not.toHaveBeenCalled();
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
    expect(preview).not.toHaveBeenCalled();
  });
});

describe("L3 — a draft that runs badly is rejected too", () => {
  it("rejects a statically-valid script that throws when run", async () => {
    preview.mockResolvedValue(dryFailed("TypeError: v.map is not a function"));
    const v = await gateToolCall("draft_object_script", { source: GOOD });
    expect(v.allow).toBe(false);
    expect(v.message).toContain("FAILS when run against a copy of the workbook");
    expect(v.message).toContain("TypeError: v.map is not a function");
  });

  it("allows a script that runs cleanly", async () => {
    preview.mockResolvedValue(dryOk(3));
    expect((await gateToolCall("draft_object_script", { source: GOOD })).allow).toBe(true);
  });

  it("allows a script that runs cleanly and changes nothing", async () => {
    // "Changed nothing" is only a defect when the task asked for writes, and the
    // gate does not know the task. A read-and-report script is legitimate.
    preview.mockResolvedValue(dryOk(0));
    expect((await gateToolCall("draft_object_script", { source: GOOD })).allow).toBe(true);
  });
});

describe("L3 runs at the tier the draft actually MOUNTS at", () => {
  // `draftToScriptDefinition` (ScriptableObjects/lib/scriptDrafts.ts) mounts
  // every AI draft "restricted" — never pre-escalated. The preview defaulted to
  // "unlocked", so the rung green-lit scripts reaching `context.api.*`, the user
  // pressed Save, and the script was refused by a gate the preview had never
  // consulted.

  it("previews at the restricted tier, not the preview default", async () => {
    await gateToolCall("draft_object_script", { source: GOOD, object_type: "button" });
    expect(preview).toHaveBeenCalledTimes(1);
    expect(preview.mock.calls[0][0]).toMatchObject({ objectType: "button", tier: "restricted" });
  });

  it("does NOT reject a sound script that merely needs the unlocked tier", async () => {
    // The diagnosis is a DEDUCTION: the tier is the only thing that changed
    // between the two runs, so passing at unlocked means the tier was the issue.
    preview
      .mockResolvedValueOnce(dryFailed("api.setRangeFormat requires unlocked access; this script is restricted"))
      .mockResolvedValueOnce(dryOk(4));

    const v = await gateToolCall("draft_object_script", { source: GOOD, object_type: "button" });
    expect(v.allow, "notices never block").toBe(true);
    expect(preview.mock.calls[0][0]).toMatchObject({ tier: "restricted" });
    expect(preview.mock.calls[1][0]).toMatchObject({ tier: "unlocked" });
    // The user is told what to do, and the model is told to tell them.
    expect(v.note).toContain(NEEDS_UNLOCKED);
    expect(v.note).toContain("Unlocked");
    // ...and it still says what the script would DO.
    expect(v.note).toContain("4 cells");
  });

  it("still rejects a script that fails at BOTH tiers", async () => {
    // A real runtime error is not a permissions problem, and re-running at a
    // higher tier must not launder it into one.
    preview.mockResolvedValue(dryFailed("TypeError: v.map is not a function"));
    const v = await gateToolCall("draft_object_script", { source: GOOD, object_type: "button" });
    expect(v.allow).toBe(false);
    expect(v.message).toContain("TypeError: v.map is not a function");
    expect(preview).toHaveBeenCalledTimes(2);
  });

  it("pays for the second run only when the first one failed", async () => {
    preview.mockResolvedValue(dryOk(2));
    const v = await gateToolCall("draft_object_script", { source: GOOD, object_type: "button" });
    expect(v.allow).toBe(true);
    expect(preview, "a passing draft costs one preview, not two").toHaveBeenCalledTimes(1);
    expect(v.note).not.toContain("Unlocked");
  });
});

describe("the gate fails OPEN when it cannot reach a verdict", () => {
  it("allows the draft when the dry-run command is unavailable", async () => {
    // A gate that turns its own failure into a rejection makes the chat refuse
    // work for a reason the user cannot act on.
    preview.mockRejectedValue(new Error("Unknown command"));
    expect((await gateToolCall("draft_object_script", { source: GOOD })).allow).toBe(true);
  });

  it("leaves an empty source to the backend's own validation", async () => {
    const v = await gateToolCall("draft_object_script", { source: "" });
    expect(v.allow).toBe(true);
    expect(preview).not.toHaveBeenCalled();
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
   * A decline still happens, for a narrower and more honest reason than before.
   * The old one was structural — the wrong realm, every time. The new ones are
   * situational: the preview backend cannot serve some member the script
   * called, the workbook could not be copied, or there is no Worker realm in
   * this environment at all. In every case the answer is about the PREVIEW, so
   * drawing a conclusion from it would repeat the original defect — answering
   * "it FAILS when run" for code that was already correct, and sending the
   * model off to repair it.
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
    unexercisedHooks: [],
    applicable: false,
    declinedReason: "the preview cannot serve api.createChart",
  });

  it("allows a draft the preview could not host", async () => {
    preview.mockResolvedValue(declined());
    expect((await gateToolCall("draft_object_script", { source: GOOD })).allow).toBe(true);
  });

  it("still rejects on the STATIC checks — declining does not disable the ladder", async () => {
    preview.mockResolvedValue(declined());
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
    preview.mockResolvedValue(dryFailed("TypeError: x is not a function"));
    const v = await gateToolCall("draft_object_script", { source: GOOD });
    expect(v.allow).toBe(false);
    expect(v.message).toContain("TypeError");
  });
});

describe("an allowed draft carries the dry run's observation", () => {
  it("appends a note naming what the draft would change", async () => {
    preview.mockResolvedValue(dryOk(3));
    const v = await gateToolCall("draft_object_script", { source: GOOD });
    expect(v.allow).toBe(true);
    expect(v.note).toContain("3 cells");
  });

  it("carries no note when the preview declined", async () => {
    preview.mockResolvedValue({
      ok: true, error: null, durationMs: 0, changes: [], truncated: false,
      totalChanges: 0, output: [], readBack: [], unexercisedHooks: [], applicable: false,
      declinedReason: "ES module",
    });
    const v = await gateToolCall("draft_object_script", { source: GOOD });
    expect(v.allow).toBe(true);
    expect(v.note).toBeUndefined();
  });
});

describe("the gate previews in the realm the draft will really run in", () => {
  /**
   * This gate guards `draft_object_script` exclusively, so its scripts are
   * object scripts BY DEFINITION — Worker-realm code. It used to hand them to
   * `ai_dry_run_script`, which runs in the Rust interpreter's realm and
   * therefore declined every single one, correctly and unconditionally: the
   * rung was 100% dead here. It now runs the draft in the Worker realm against
   * a copy of the workbook (§5c). `ai_dry_run_script` is unchanged and remains
   * the right rung for a ONE-OFF script, which is that realm's own language.
   */
  it("runs the source through the Worker-realm preview", async () => {
    preview.mockResolvedValue(dryOk());
    await gateToolCall("draft_object_script", { source: GOOD });
    expect(preview).toHaveBeenCalledWith(expect.objectContaining({ source: GOOD }));
  });

  it("previews against the object type the TOOL supplied, not a guess", async () => {
    // `object_type` is a required field of `draft_object_script`, and it decides
    // which context the realm builds and which hooks exist at all. The gate
    // previewed EVERY draft as a button until it read this, so a shape or sheet
    // script was mounted against the wrong context and its own hooks — the
    // handlers where the work actually lives — were never fired.
    preview.mockResolvedValue(dryOk());
    await gateToolCall("draft_object_script", { source: GOOD, object_type: "shape" });
    expect(preview).toHaveBeenCalledWith(expect.objectContaining({ objectType: "shape" }));
  });

  it("falls back to button for the malformed call it deliberately does not police", async () => {
    preview.mockResolvedValue(dryOk());
    await gateToolCall("draft_object_script", { source: GOOD });
    expect(preview).toHaveBeenCalledWith(expect.objectContaining({ objectType: "button" }));
  });

  it("names no event, so the DRAFT's own registrations decide what runs", async () => {
    // The gate has no task description and cannot know what the draft is for,
    // so it must not fail a script for declining to handle a hook. Omitting
    // `event` makes the preview offer every hook the object type HAS and fire
    // exactly the ones the script registered. Firing them at all is worth it: a
    // handler that throws is invisible to `setup` alone, and
    // `context.expose('onClick', …)` — the shape every early draft used —
    // mounts perfectly and never receives a click.
    preview.mockResolvedValue(dryOk());
    await gateToolCall("draft_object_script", { source: GOOD, object_type: "button" });
    const arg = preview.mock.calls[0][0] as { event?: unknown };
    expect(arg.event, "naming one would assert the draft MUST handle it").toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// T11 — the ladder is narrowed to the object the draft is aimed at
// ---------------------------------------------------------------------------

describe("the gate rejects a draft aimed at the wrong object", () => {
  // `onClick` is a ButtonContext/ShapeContext member, `cell` is handed out by
  // SheetContext and TableContext alone. Before L1 knew the object type, both
  // shapes validated CLEAN and threw at mount — the quietest failure the whole
  // pipeline has, because the draft reaches a human's review queue looking fine.
  const ONCLICK = "export function setup(context) {\n  context.onClick(async () => {});\n}\n";
  const CELL_WRITE =
    "export function setup(context) {\n  context.cell.setValue(0, 0, 'x');\n}\n";

  it("rejects a button's onClick in a SHEET script, and never pays for the preview", async () => {
    const v = await gateToolCall("draft_object_script", { source: ONCLICK, object_type: "sheet" });
    expect(v.allow).toBe(false);
    expect(v.message).toContain("context.onClick");
    expect(preview, "a draft that cannot mount must not cost a preview").not.toHaveBeenCalled();
  });

  it("allows the identical source as a BUTTON — the positive control", async () => {
    const v = await gateToolCall("draft_object_script", { source: ONCLICK, object_type: "button" });
    expect(v.allow, "without this the test above passes for a gate that rejects everything").toBe(true);
  });

  it("rejects a cell write from a button, which cannot obtain a cell at all", async () => {
    const v = await gateToolCall("draft_object_script", { source: CELL_WRITE, object_type: "button" });
    expect(v.allow).toBe(false);
    expect(v.message).toContain("context.cell");
    // The repair has to name the objects that CAN, or the model rewrites a name
    // it already had right and the loop cannot converge.
    expect(v.message).toContain("sheet");
  });

  it("allows the same cell write from a SHEET", async () => {
    const v = await gateToolCall("draft_object_script", { source: CELL_WRITE, object_type: "sheet" });
    expect(v.allow).toBe(true);
  });

  it("does not reject a shared member reached from a button", async () => {
    // THE false positive that would matter most: `api.range` is on every context
    // and prefixes nothing, so narrowing must still admit it.
    const source =
      "export function setup(context) {\n" +
      "  context.onClick(async () => {\n" +
      "    const r = await context.api.range('A1');\n" +
      "    r.setValue('x');\n" +
      "  });\n}\n";
    const v = await gateToolCall("draft_object_script", { source, object_type: "button" });
    expect(v.allow, "narrowing must never reject correct code").toBe(true);
  });

  it("never NARROWS on a guessed object type, but still previews as a button", async () => {
    // An unlabelled draft is previewed as SOMETHING because it must be; it is
    // VALIDATED against nothing, because rejecting a correct sheet script for a
    // type nobody claimed is a linter inventing a defect. The source is
    // deliberately one a BUTTON cannot run — silently narrow to "button" here
    // and this becomes `wrong-object-type` on a draft that is perfectly fine.
    const sheetOnly =
      "export function setup(context) {\n  context.onSelectionChange(async () => {});\n}\n";
    const v = await gateToolCall("draft_object_script", { source: sheetOnly });
    expect(v.allow, "an unclaimed type must narrow NOTHING").toBe(true);
    expect(preview).toHaveBeenCalledWith(expect.objectContaining({ objectType: "button" }));
  });

  it("and the control: the same source IS rejected once someone claims 'button'", async () => {
    const sheetOnly =
      "export function setup(context) {\n  context.onSelectionChange(async () => {});\n}\n";
    const v = await gateToolCall("draft_object_script", { source: sheetOnly, object_type: "button" });
    expect(v.allow).toBe(false);
    expect(v.message).toContain("context.onSelectionChange");
  });
});

// ---------------------------------------------------------------------------
// T12 — the verdict carries what the gate computed FOR A HUMAN
// ---------------------------------------------------------------------------

describe("the verdict carries what the gate computed for a human", () => {
  it("carries the ladder's notices, which nothing used to read", async () => {
    const v = await gateToolCall("draft_object_script", {
      source: "// @capability net.fetch\n" + GOOD,
      object_type: "button",
    });
    expect(v.allow, "a notice never blocks").toBe(true);
    // TWO as of 2026-08-26: the over-declared capability, and the run-target
    // notice — `GOOD` is a setup-only script, so it genuinely cannot be started
    // with Run (F5) and saying so is correct. Asserted by CONTENT rather than by
    // count alone, or this test stops naming which notice it is about.
    expect(v.notices).toHaveLength(2);
    expect(v.notices!.some((n) => /net\.fetch.*declared/.test(n.message))).toBe(true);
    // EACH ONE CARRIES ITS CODE, as of 2026-08-26. Both notices arrive at the
    // same severity, and a renderer that cannot tell them apart files "you will
    // not be able to press Run on this" under "check what it declares".
    expect(v.notices!.map((n) => n.code).sort()).toEqual([
      "declared-not-observed",
      "no-run-target",
    ]);
  });

  it("carries the run-target notice for a setup-only script", async () => {
    const v = await gateToolCall("draft_object_script", { source: GOOD, object_type: "button" });
    expect(v.allow, "a notice never blocks").toBe(true);
    expect(v.notices).toHaveLength(1);
    expect(v.notices![0].code).toBe("no-run-target");
    expect(v.notices![0].message).toMatch(/run target|started on demand/);
  });

  it("carries none when the script declares nothing it does not use", async () => {
    // THE ORIGINAL POINT OF THIS CASE — "absent, not an empty array" — needs a
    // script with nothing to say about it at all, which now means one that has a
    // run target too.
    const runnable =
      "async function run() {\n  context.log('x');\n}\n" +
      "export function setup(context) {\n  return run();\n}\n";
    const v = await gateToolCall("draft_object_script", { source: runnable, object_type: "button" });
    expect(v.notices, "absent, not an empty array").toBeUndefined();
  });

  it("says the tier thing TWICE — once to the model, once to the user", async () => {
    preview
      .mockResolvedValueOnce(dryFailed("api.setRangeFormat requires unlocked access"))
      .mockResolvedValueOnce(dryOk(4));
    const v = await gateToolCall("draft_object_script", { source: GOOD, object_type: "button" });
    expect(v.allow).toBe(true);
    expect(v.needsUnlocked).toBe(true);
    expect(v.note).toContain(NEEDS_UNLOCKED);
    expect(v.userNote).toContain(NEEDS_UNLOCKED_USER);
    // THE defect the reviewed design would have shipped: relaying the model's
    // own copy to the person it is about.
    expect(v.userNote, "the user is not 'the user'").not.toContain("Tell the user");
  });

  it("sets userNote on the ordinary path too, so a caller reads ONE field", async () => {
    preview.mockResolvedValue(dryOk(3));
    const v = await gateToolCall("draft_object_script", { source: GOOD, object_type: "button" });
    expect(v.userNote).toBe(v.note);
    expect(v.needsUnlocked).toBeFalsy();
  });
});

describe("describeDryRun names the cells, not just a count", () => {
  const withChanges = (totalChanges: number, cells: Array<[number, number]>) => ({
    ...dryOk(totalChanges),
    changes: cells.map(([row, col]) => ({ row, col, before: "", after: "x" })),
  });

  it("names them, A1-style", () => {
    // `columnToLetter` is 0-based, so {row:1,col:1} is B2.
    const note = describeDryRun(withChanges(2, [[1, 1], [2, 1]]));
    expect(note).toContain("2 cells");
    expect(note).toContain("B2, B3");
  });

  it("says so when it is naming only the first few", () => {
    const note = describeDryRun(withChanges(5, [[0, 0], [1, 0], [2, 0]]));
    expect(note).toContain("5 cells");
    expect(note.endsWith(", ...).")).toBe(true);
  });

  it("keeps the bare count when the report carried no list", () => {
    // A report can legitimately arrive with a count and no entries; inventing
    // "(A1)" for one would be worse than saying less.
    const note = describeDryRun(dryOk(1));
    expect(note).toContain("1 cell.");
    expect(note).not.toContain("(");
  });

  it("refuses to let 'changed no cells' stand alone after an unfired handler", () => {
    const plain = describeDryRun(dryOk(0));
    const caveated = describeDryRun({ ...dryOk(0), unexercisedHooks: ["onSelectionChange"] });
    expect(caveated).not.toBe(plain);
    expect(caveated).toContain("not evidence about the script");
    expect(caveated).toContain("onSelectionChange");
    // ...AND IT ADDRESSES THE READER, NOT THE MODEL. This string is stored as
    // `userNote` too, and ChatView renders that into the transcript — so
    // "Tell the user to..." here reaches the user as an instruction aimed at
    // someone else. The `userNote` guard elsewhere in this file cannot catch
    // it: its double sets `unexercisedHooks: []`, so this branch never runs.
    expect(caveated, "the reader IS the user").not.toContain("Tell the user");
    expect(caveated).toContain("Try it on real data");
    // The control: with nothing unfired, the sentence is byte-identical to what
    // it has always been.
    expect(plain).toBe(" When run against a copy of the workbook it changed no cells.");
  });
});
