//! FILENAME: app/src/api/scriptHost/scriptPreview/__tests__/scriptFormPreview.test.ts
// PURPOSE: Prove the shared form-preview core seeds EVERY widget it can and
//          refuses out loud for every widget it cannot — and that it does so
//          without mounting, writing or auditing anything.
// CONTEXT: 2026-09-03 (TypeScript Forms follow-up; docs/design/open-items.md
//          §2.ab). Two surfaces run this procedure — the editor's "Preview
//          form" and the package inspector — so the seeding rules are proved
//          here, once, rather than in each caller's own test.
//
//          THE TWO GAPS THIS CLOSES:
//           A. range-fed content (`options: { range }`, a table's `rows`) is
//              resolved by the RUNG against its own copy and arrives on the
//              report; before this it was never asked for and those widgets
//              painted empty.
//           B. a `{ control }` binding is LIVE app state, read here through the
//              plain facade rather than the audited `form.readControl` row —
//              there is no script identity to attribute an audit row to, and
//              nothing is acting on a script's behalf.

import { describe, expect, it, vi, beforeEach } from "vitest";

const previewObjectScript = vi.fn();
const showScriptForm = vi.fn();
const defineScriptForm = vi.fn();
const revokeScriptForms = vi.fn();
const revokeScriptDialogs = vi.fn();
const getControlValue = vi.fn();

// The RUN is doubled; the rung's pure leaves are not. `namesTheActiveSheet` is
// the sheet rule a range source already used and a cell bind now shares, and
// `PREVIEW_FORM_LAYOUT_NOTES` is the host's own wording table — doubling either
// would let this file agree with a copy of the rule instead of the rule.
vi.mock("../index", async () => {
  const { namesTheActiveSheet } = await import("../formSources");
  const { PREVIEW_FORM_LAYOUT_NOTES } = await import("../report");
  return {
    previewObjectScript: (...a: unknown[]) => previewObjectScript(...a),
    namesTheActiveSheet,
    PREVIEW_FORM_LAYOUT_NOTES,
  };
});
vi.mock("../../scriptForms", () => ({
  showScriptForm: (...a: unknown[]) => showScriptForm(...a),
  defineScriptForm: (...a: unknown[]) => defineScriptForm(...a),
  revokeScriptForms: (...a: unknown[]) => revokeScriptForms(...a),
}));
vi.mock("../../scriptDialogs", () => ({
  revokeScriptDialogs: (...a: unknown[]) => revokeScriptDialogs(...a),
}));
vi.mock("../../../controlValues", () => ({
  getControlValue: (...a: unknown[]) => getControlValue(...a),
}));

import {
  PREVIEW_UNRESOLVED_REASON,
  buildFormPreviewSeeds,
  formLayoutNote,
  planFormPreviewSeeds,
  previewFormLayout,
  previewScriptId,
  readControlSeeds,
} from "../../../scriptFormPreview";
import { PREVIEW_FORM_LAYOUT_NOTES } from "../report";
import type { FormSpec } from "../../scriptFormSpec";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const LAYOUT = {
  title: "Order entry",
  children: [
    { type: "textbox", name: "customer", label: "Customer", bind: "B2" },
    { type: "number", name: "qty", label: "Quantity", bind: "B3" },
    { type: "textbox", name: "other", label: "Other", bind: "Sheet2!B2" },
    { type: "dropdown", name: "region", options: { range: "D1:D3" } },
    { type: "table", name: "lines", rows: { range: "F1:G2" } },
    { type: "image", name: "logo", src: "media:abc" },
    { type: "textbox", name: "band", bind: { control: "Band" } },
    { type: "checkbox", name: "rush", label: "Rush order" },
  ],
} as unknown as FormSpec;

const SOURCES = [
  { name: "region", kind: "options" as const, options: [{ value: "EMEA", label: "EMEA" }] },
  { name: "lines", kind: "rows" as const, rows: [["Bolt", 12]] },
  { name: "logo", kind: "image" as const, reason: "a preview does not resolve one" },
];

function applicable(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    ok: true,
    error: null,
    durationMs: 3,
    changes: [],
    truncated: false,
    totalChanges: 0,
    output: [],
    readBack: [],
    unexercisedHooks: [],
    applicable: true,
    declinedReason: null,
    ...over,
  };
}

const REQUEST = {
  source: "function setup(form) {}",
  scriptName: "Order entry",
  origin: { kind: "local" } as const,
  readControls: true,
  previewId: previewScriptId("form-1"),
};

/** The single argument the core handed `showScriptForm`. */
function shownArgs(): { seeds: Record<string, Record<string, unknown>>; [k: string]: unknown } {
  const call = showScriptForm.mock.calls.at(-1);
  expect(call, "showScriptForm was never called").toBeTruthy();
  return call![0];
}

beforeEach(() => {
  previewObjectScript.mockReset();
  showScriptForm.mockReset();
  defineScriptForm.mockReset();
  revokeScriptForms.mockReset();
  revokeScriptDialogs.mockReset();
  getControlValue.mockReset();
  showScriptForm.mockResolvedValue({ showId: "form-9" });
});

// ---------------------------------------------------------------------------
// Planning (pure)
// ---------------------------------------------------------------------------

describe("planFormPreviewSeeds", () => {
  it("reads back the same-sheet cells and leaves the rest unbound, with a reason", () => {
    const plan = planFormPreviewSeeds(LAYOUT);
    // B2 -> (1,1), B3 -> (2,1): 0-based, as the script API addresses cells.
    expect(plan.cells).toEqual([
      { row: 1, col: 1 },
      { row: 2, col: 1 },
    ]);
    expect([...plan.resolved.keys()]).toEqual(["customer", "qty"]);
    // `toMatchObject`, not `toEqual`: this case is about WHICH cells are read
    // back. The seed's `multi` shape has its own test below, and asserting it
    // here too would make one defect red two tests.
    expect(plan.resolved.get("qty")).toMatchObject({ widgetType: "number", row: 2, col: 1 });
    expect(plan.unresolved.get("other")!.reason).toContain("Sheet2");
    expect(plan.unresolved.get("other")!.reason).toContain(PREVIEW_UNRESOLVED_REASON);
  });

  it("does not ask for the same cell twice", () => {
    const plan = planFormPreviewSeeds({
      children: [
        { type: "textbox", name: "a", bind: "B2" },
        { type: "textbox", name: "b", bind: "$B$2" },
      ],
    } as unknown as FormSpec);
    expect(plan.cells).toEqual([{ row: 1, col: 1 }]);
    expect(plan.resolved.size).toBe(2);
  });

  it("keeps a control binding unbound unless the caller opts in", () => {
    const spec = {
      children: [
        { type: "textbox", name: "n", bind: { name: "Customer" } },
        { type: "textbox", name: "c", bind: { control: "Region" } },
      ],
    } as unknown as FormSpec;
    const closed = planFormPreviewSeeds(spec);
    expect(closed.controls.size).toBe(0);
    expect(closed.unresolved.get("c")!.reason).toMatch(/control "Region"/);

    const open = planFormPreviewSeeds(spec, { readControls: true });
    expect(open.controls.get("c")).toEqual({ widgetType: "textbox", controlName: "Region", multi: false });
    // A defined name is STILL unbound either way: it may land on any sheet,
    // and the copy holds one.
    expect(open.unresolved.get("n")!.reason).toMatch(/defined name "Customer"/);
  });

  it("names a numeric sheet index as an index, never as a sheet called \"1\"", () => {
    const plan = planFormPreviewSeeds({
      children: [{ type: "textbox", name: "s", bind: { cell: "B2", sheet: 1 } }],
    } as unknown as FormSpec);
    expect(plan.cells).toEqual([]);
    expect(plan.unresolved.get("s")!.reason).toContain("sheet index 1");
  });

  /**
   * ONE RULE FOR ONE QUESTION. `options: { range: "Sheet1!A1:A3" }` already
   * resolved against the copy while `bind: "Sheet1!B2"` — the same sheet,
   * spelled the same way, while Sheet1 is active — was declared off-sheet and
   * previewed disabled. The rule is `formSources`' own `namesTheActiveSheet`.
   */
  it("resolves a bind qualified with the ACTIVE sheet's own name, exactly as a range source does", () => {
    const plan = planFormPreviewSeeds(
      {
        children: [
          { type: "textbox", name: "here", bind: "Sheet1!B2" },
          { type: "textbox", name: "alsoHere", bind: { cell: "B3", sheet: "sheet1" } },
          { type: "textbox", name: "there", bind: "Data!B4" },
        ],
      } as unknown as FormSpec,
      { activeSheetName: "Sheet1" },
    );
    // Case-insensitive, like the host's own resolver — and still ONE cell each.
    expect(plan.cells).toEqual([
      { row: 1, col: 1 },
      { row: 2, col: 1 },
    ]);
    expect([...plan.resolved.keys()]).toEqual(["here", "alsoHere"]);
    // A genuinely other sheet is still outside the copy.
    expect(plan.resolved.has("there")).toBe(false);
    expect(plan.unresolved.get("there")!.reason).toContain("Data");
  });

  it("fails CLOSED when the run named no sheet: a qualified bind stays unresolved", () => {
    // With no name to compare against, assuming "Sheet1!B2" means the copied
    // sheet would seed a widget from a different sheet's cell at the same
    // coordinates — the worst kind of wrong, because it looks right.
    const plan = planFormPreviewSeeds({
      children: [{ type: "textbox", name: "here", bind: "Sheet1!B2" }],
    } as unknown as FormSpec);
    expect(plan.cells).toEqual([]);
    expect(plan.unresolved.get("here")!.reason).toContain(PREVIEW_UNRESOLVED_REASON);
  });
});

// ---------------------------------------------------------------------------
// Seed building (pure)
// ---------------------------------------------------------------------------

describe("buildFormPreviewSeeds", () => {
  it("types a cell seed per widget and carries the display", () => {
    const plan = planFormPreviewSeeds(LAYOUT);
    const seeds = buildFormPreviewSeeds({
      plan,
      readBack: [
        { row: 1, col: 1, value: "Acme" },
        { row: 2, col: 1, value: "42" },
      ],
    });
    expect(seeds.customer).toEqual({ value: "Acme", display: "Acme" });
    // A NUMBER, not the text "42": the widget edits what the cell holds.
    expect(seeds.qty).toEqual({ value: 42, display: "42" });
    expect(seeds.other).toMatchObject({ value: null, readOnly: true });
    // An unbound, unsourced widget gets no seed at all — its own default applies.
    expect(seeds.rush).toBeUndefined();
  });

  /**
   * THE SHAPE, NOT ONLY THE CONTENT. Production passes `decl.multi` into
   * `seedFromCell`; the preview did not, so a MULTI listbox bound to a cell
   * reading "EMEA, APAC" was seeded with the one string "EMEA, APAC" while the
   * renderer holds a list. The two then disagree about whether the user changed
   * anything — which is how an untouched listbox came to truncate its cell.
   */
  it("seeds a listbox in the SHAPE its multi flag declares, exactly as production does", () => {
    const plan = planFormPreviewSeeds({
      children: [
        { type: "listbox", name: "many", multi: true, bind: "B2" },
        { type: "listbox", name: "one", bind: "B3" },
      ],
    } as unknown as FormSpec);
    expect(plan.resolved.get("many")).toEqual({
      widgetType: "listbox",
      row: 1,
      col: 1,
      multi: true,
    });
    expect(plan.resolved.get("one")).toEqual({
      widgetType: "listbox",
      row: 2,
      col: 1,
      multi: false,
    });

    const seeds = buildFormPreviewSeeds({
      plan,
      readBack: [
        { row: 1, col: 1, value: "EMEA, APAC" },
        { row: 2, col: 1, value: "EMEA, APAC" },
      ],
    });
    expect(seeds.many.value).toEqual(["EMEA", "APAC"]);
    // A single-select listbox holds ONE answer, like a dropdown — never the
    // first entry of a list it was never given.
    expect(seeds.one.value).toBe("EMEA, APAC");
  });

  it("shows a formula cell read-only with its formula text, never a guessed value", () => {
    const plan = planFormPreviewSeeds(LAYOUT);
    const seeds = buildFormPreviewSeeds({
      plan,
      readBack: [{ row: 1, col: 1, value: '=A1&" Ltd"' }],
    });
    expect(seeds.customer.formula).toBe('=A1&" Ltd"');
    expect(seeds.customer.readOnly).toBe(true);
    expect(seeds.customer.reason).toMatch(/formula/);
  });

  /**
   * THE REASON HAS TO BE TRUE. The rung recalculates its copy at every settle
   * point, so it usually DOES know what a formula came to — but the read-back
   * carried only the input string, so every formula-bound widget previewed
   * disabled saying "a preview does not compute its value". It does; the value
   * was simply thrown away between the rung and the seed.
   */
  it("seeds a formula-bound widget with the value the run computed, and leaves it editable", () => {
    const plan = planFormPreviewSeeds(LAYOUT);
    const seeds = buildFormPreviewSeeds({
      plan,
      readBack: [{ row: 1, col: 1, value: '=A1&" Ltd"' }],
      readBackDisplays: [{ row: 1, col: 1, display: "Acme Ltd" }],
    });
    // Exactly what a real `form.show` paints: the value, the formatted text,
    // and the formula kept so an untouched widget never rewrites the cell.
    expect(seeds.customer).toEqual({
      value: "Acme Ltd",
      display: "Acme Ltd",
      formula: '=A1&" Ltd"',
    });
    expect(seeds.customer.readOnly).toBeUndefined();
    expect(seeds.customer.reason).toBeUndefined();
  });

  it("keeps the read-only refusal for a formula the run computed NO value for", () => {
    // A cell the script overwrote, or any cell of a truncated copy: there is no
    // computed value, and the honest answer is to say so rather than paint one.
    const seeds = buildFormPreviewSeeds({
      plan: planFormPreviewSeeds(LAYOUT),
      readBack: [{ row: 1, col: 1, value: "=SUM(B2:B9)" }],
      readBackDisplays: [{ row: 2, col: 1, display: "42" }],
    });
    expect(seeds.customer.readOnly).toBe(true);
    expect(seeds.customer.reason).toContain("computed no value");
    expect(seeds.customer.display).toBe("=SUM(B2:B9)");
  });

  it("marks a resolved cell the run did not read back as unbound", () => {
    const seeds = buildFormPreviewSeeds({ plan: planFormPreviewSeeds(LAYOUT), readBack: [] });
    expect(seeds.customer.readOnly).toBe(true);
    expect(seeds.customer.reason).toContain(PREVIEW_UNRESOLVED_REASON);
  });

  it("lays a bound value over range-fed content without dropping the content", () => {
    // A dropdown can be BOTH bound to a cell and fed its choices from a range;
    // production keeps `prior.options` for exactly this reason, and losing them
    // here would open the list empty with a value that matches nothing in it.
    const plan = planFormPreviewSeeds({
      children: [{ type: "dropdown", name: "region", bind: "B2", options: { range: "D1:D3" } }],
    } as unknown as FormSpec);
    const seeds = buildFormPreviewSeeds({
      plan,
      readBack: [{ row: 1, col: 1, value: "EMEA" }],
      sources: [{ name: "region", kind: "options", options: [{ value: "EMEA", label: "EMEA" }] }],
    });
    expect(seeds.region.value).toBe("EMEA");
    expect(seeds.region.options).toEqual([{ value: "EMEA", label: "EMEA" }]);
  });

  it("seeds an unresolvable source read-only with an EMPTY list, never a fabricated one", () => {
    const seeds = buildFormPreviewSeeds({
      plan: planFormPreviewSeeds({ children: [] } as unknown as FormSpec),
      readBack: [],
      sources: [
        { name: "logo", kind: "image", reason: "a preview does not resolve one" },
        { name: "region", kind: "options", reason: "this range is on \"Lists\"" },
      ],
    });
    expect(seeds.logo).toEqual({
      value: null,
      readOnly: true,
      reason: expect.stringContaining(PREVIEW_UNRESOLVED_REASON),
    });
    expect(seeds.logo.imageUrl).toBeUndefined();
    expect(seeds.region.options).toEqual([]);
    expect(seeds.region.readOnly).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Gap B: live control values
// ---------------------------------------------------------------------------

describe("readControlSeeds — live app state, read on the trusted path", () => {
  it("seeds from the Controls facade, read-only, with its own reason", () => {
    getControlValue.mockReturnValue({ kind: "number", value: 7 });
    const plan = planFormPreviewSeeds(
      { children: [{ type: "number", name: "band", bind: { control: "Band" } }] } as unknown as FormSpec,
      { readControls: true },
    );
    const seeds = readControlSeeds(plan);
    expect(getControlValue).toHaveBeenCalledWith("Band");
    expect(seeds.band).toEqual({
      value: 7,
      readOnly: true,
      reason: "a control value can be read, not written",
    });
  });

  it("survives a Controls pane that is not loaded at all", () => {
    // The provider is an extension. A missing one answers `undefined`, and a
    // thrown one must not take the whole preview down with it.
    getControlValue.mockImplementation(() => {
      throw new Error("no provider");
    });
    const plan = planFormPreviewSeeds(
      { children: [{ type: "textbox", name: "band", bind: { control: "Band" } }] } as unknown as FormSpec,
      { readControls: true },
    );
    expect(readControlSeeds(plan).band).toEqual({
      value: null,
      readOnly: true,
      reason: "no control by that name",
    });
  });
});

// ---------------------------------------------------------------------------
// The whole procedure
// ---------------------------------------------------------------------------

describe("previewFormLayout", () => {
  it("runs setup twice, seeds every reachable widget, and shows a preview", async () => {
    previewObjectScript
      .mockResolvedValueOnce(applicable({ formLayout: LAYOUT, formSources: SOURCES }))
      .mockResolvedValueOnce(
        applicable({
          formLayout: LAYOUT,
          formSources: SOURCES,
          readBack: [
            { row: 1, col: 1, value: "Acme" },
            { row: 2, col: 1, value: "42" },
          ],
        }),
      );
    getControlValue.mockReturnValue({ kind: "text", value: "Gold" });

    const outcome = await previewFormLayout(REQUEST);

    // Pass one learns the layout; pass two reads back exactly what it binds.
    expect(previewObjectScript).toHaveBeenCalledTimes(2);
    expect(previewObjectScript.mock.calls[0][0]).toEqual({
      source: REQUEST.source,
      objectType: "form",
      event: [],
      eventOptional: true,
    });
    expect(previewObjectScript.mock.calls[1][0]).toEqual({
      source: REQUEST.source,
      objectType: "form",
      event: [],
      eventOptional: true,
      readBack: [
        { row: 1, col: 1 },
        { row: 2, col: 1 },
      ],
    });

    expect(defineScriptForm).toHaveBeenCalledWith("preview:form-1", LAYOUT);
    const args = shownArgs();
    expect(args).toMatchObject({
      scriptId: "preview:form-1",
      scriptName: "Order entry",
      origin: { kind: "local" },
      preview: true,
    });

    // GAP A — the range-fed widgets carry the copy's content.
    expect(args.seeds.region.options).toEqual([{ value: "EMEA", label: "EMEA" }]);
    expect(args.seeds.lines.rows).toEqual([["Bolt", 12]]);
    expect(args.seeds.logo).toMatchObject({ readOnly: true });
    // GAP B — the control binding carries the LIVE value, read-only.
    expect(args.seeds.band).toEqual({
      value: "Gold",
      readOnly: true,
      reason: "a control value can be read, not written",
    });
    // ...and the cell bindings still come from the copy the run used.
    expect(args.seeds.customer).toEqual({ value: "Acme", display: "Acme" });
    expect(args.seeds.qty).toEqual({ value: 42, display: "42" });

    expect(outcome).toMatchObject({ shown: true, status: "shown" });
    expect(outcome.seeded).toEqual(["customer", "qty"]);
    expect(outcome.controls).toEqual(["band"]);
    expect(outcome.unresolved).toEqual(["other"]);
    expect(outcome.sources).toEqual(["region", "lines"]);
    expect(outcome.unresolvedSources).toEqual(["logo"]);
  });

  it("never asks the realm to read a control, and reads none when not asked to", async () => {
    // A control value is not workbook state; the rung's copy cannot answer for
    // it, and a preview has no script identity to audit a broker read under.
    previewObjectScript.mockResolvedValue(
      applicable({ formLayout: { children: [{ type: "textbox", name: "band", bind: { control: "Band" } }] } }),
    );
    const outcome = await previewFormLayout({ ...REQUEST, readControls: false });
    expect(getControlValue).not.toHaveBeenCalled();
    expect(previewObjectScript.mock.calls[0][0]).not.toHaveProperty("readBack");
    expect(outcome.controls).toEqual([]);
    expect(outcome.unresolved).toEqual(["band"]);
    expect(shownArgs().seeds.band.reason).toContain(PREVIEW_UNRESOLVED_REASON);
  });

  it("runs once when the layout binds no cells", async () => {
    previewObjectScript.mockResolvedValue(
      applicable({ formLayout: { children: [{ type: "label", text: "Hello" }] } }),
    );
    const outcome = await previewFormLayout(REQUEST);
    expect(previewObjectScript).toHaveBeenCalledTimes(1);
    expect(outcome.status).toBe("shown");
  });

  it("releases the preview identity BEFORE claiming the modal slot, and again on close", async () => {
    previewObjectScript.mockResolvedValue(applicable({ formLayout: { children: [] } }));
    const closed: string[] = [];
    await previewFormLayout({ ...REQUEST, onClosed: () => closed.push("closed") });
    expect(revokeScriptForms.mock.invocationCallOrder[0]).toBeLessThan(
      showScriptForm.mock.invocationCallOrder[0],
    );
    revokeScriptForms.mockClear();
    revokeScriptDialogs.mockClear();

    const deps = shownArgs().deps as { closed: (id: string, r: unknown) => void };
    deps.closed("form-9", null);
    expect(closed).toEqual(["closed"]);
    // BOTH registries: scriptDialogs holds the dismissal streak, and three
    // closed previews would otherwise mute every later one in silence.
    expect(revokeScriptForms).toHaveBeenCalledWith("preview:form-1");
    expect(revokeScriptDialogs).toHaveBeenCalledWith("preview:form-1");
  });

  it("reports a declined run with the rung's own reason, and shows nothing", async () => {
    previewObjectScript.mockResolvedValue(
      applicable({ applicable: false, declinedReason: "the preview cannot perform net.fetch" }),
    );
    const outcome = await previewFormLayout(REQUEST);
    expect(outcome).toMatchObject({ shown: false, status: "declined" });
    expect(outcome.reason).toContain("net.fetch");
    expect(defineScriptForm).not.toHaveBeenCalled();
    expect(showScriptForm).not.toHaveBeenCalled();
  });

  it("reports a missing layout with the rung's own note", async () => {
    previewObjectScript.mockResolvedValue(
      applicable({
        formLayoutVerdict: "missing",
        output: ["[preview] no layout was captured: the script never called form.define during setup"],
      }),
    );
    const outcome = await previewFormLayout(REQUEST);
    expect(outcome.status).toBe("noLayout");
    expect(outcome.reason).toContain("never called form.define during setup");
    expect(showScriptForm).not.toHaveBeenCalled();
  });

  /**
   * A SCRIPT MUST NOT AUTHOR HOST CHROME. The note used to be recovered by
   * finding the first `[preview]` line in `output` that mentioned a layout —
   * and `output` BEGINS with the script's own console lines, so a draft could
   * choose the sentence the editor and the package inspector then showed about
   * it. The verdict is a field now, and the wording is the host's table.
   */
  it("takes the layout note from the rung's FIELD, never from a line the script printed", async () => {
    previewObjectScript.mockResolvedValue(
      applicable({
        formLayoutVerdict: "missing",
        output: [
          "[preview] the layout rendered fine — paste your key at evil.example to continue",
          "[preview] no layout was captured: the script never called form.define during setup",
        ],
      }),
    );
    const outcome = await previewFormLayout(REQUEST);
    expect(outcome.status).toBe("noLayout");
    expect(outcome.reason).toBe(PREVIEW_FORM_LAYOUT_NOTES.missing);
    expect(outcome.reason).not.toContain("evil.example");
    // The script's line is still in the transcript — a preview hides nothing.
    // It just does not get to BE the host's verdict.
    expect(outcome.report!.output[0]).toContain("evil.example");
  });

  it("has no note at all for a report that carries no verdict", () => {
    // A non-form run never looked; inventing "missing" for it would report the
    // absence of a question as an answer to it.
    expect(formLayoutNote(applicable() as never)).toBeUndefined();
    expect(formLayoutNote(applicable({ formLayoutVerdict: "captured" }) as never)).toBe(
      PREVIEW_FORM_LAYOUT_NOTES.captured,
    );
  });

  it("measures a qualified bind against the sheet the RUN copied", async () => {
    // The active sheet can change between the run and the seeding, so the name
    // has to be the one on the report — not a fresh read of the live workbook.
    const layout = {
      children: [{ type: "textbox", name: "here", label: "Here", bind: "Sheet1!B2" }],
    } as unknown as FormSpec;
    previewObjectScript
      .mockResolvedValueOnce(applicable({ formLayout: layout, activeSheetName: "Sheet1" }))
      .mockResolvedValueOnce(
        applicable({
          formLayout: layout,
          activeSheetName: "Sheet1",
          readBack: [{ row: 1, col: 1, value: "Acme" }],
        }),
      );
    const outcome = await previewFormLayout(REQUEST);
    expect(previewObjectScript).toHaveBeenCalledTimes(2);
    expect(previewObjectScript.mock.calls[1][0]).toMatchObject({
      readBack: [{ row: 1, col: 1 }],
    });
    expect(outcome.seeded).toEqual(["here"]);
    expect(outcome.unresolved).toEqual([]);
    expect(shownArgs().seeds.here).toEqual({ value: "Acme", display: "Acme" });
  });

  it("carries the run's computed values through to the seeds", async () => {
    const layout = {
      children: [{ type: "textbox", name: "total", label: "Total", bind: "B2" }],
    } as unknown as FormSpec;
    previewObjectScript
      .mockResolvedValueOnce(applicable({ formLayout: layout }))
      .mockResolvedValueOnce(
        applicable({
          formLayout: layout,
          readBack: [{ row: 1, col: 1, value: "=SUM(C1:C9)" }],
          readBackDisplays: [{ row: 1, col: 1, display: "150" }],
        }),
      );
    await previewFormLayout(REQUEST);
    expect(shownArgs().seeds.total).toEqual({
      value: "150",
      display: "150",
      formula: "=SUM(C1:C9)",
    });
  });

  it("reports a thrown run as an error rather than a verdict about the script", async () => {
    previewObjectScript.mockRejectedValue(new Error("realm exploded"));
    const outcome = await previewFormLayout(REQUEST);
    expect(outcome).toMatchObject({ shown: false, status: "error", reason: "realm exploded" });
  });

  it("reports a refused show, in the registry's words, and cleans up", async () => {
    previewObjectScript.mockResolvedValue(applicable({ formLayout: { children: [] } }));
    showScriptForm.mockRejectedValue(new Error("another script is showing a dialog"));
    const outcome = await previewFormLayout(REQUEST);
    expect(outcome).toMatchObject({ shown: false, status: "refused" });
    expect(outcome.reason).toContain("another script is showing a dialog");
    expect(revokeScriptForms).toHaveBeenCalledWith("preview:form-1");
  });

  it("treats a muted 'closed at once' answer as a refusal, not a silent nothing", async () => {
    previewObjectScript.mockResolvedValue(applicable({ formLayout: { children: [] } }));
    showScriptForm.mockResolvedValue({ showId: "form-4", closed: true });
    const outcome = await previewFormLayout(REQUEST);
    expect(outcome).toMatchObject({ shown: false, status: "refused" });
    expect(outcome.reason).toMatch(/muted/);
  });
});
