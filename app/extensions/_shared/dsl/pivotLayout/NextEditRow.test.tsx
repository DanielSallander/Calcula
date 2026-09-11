//! FILENAME: app/extensions/_shared/dsl/pivotLayout/NextEditRow.test.tsx
// PURPOSE: The suggestion row's wiring: what it shows, what accepting does,
//          what dismissing remembers, and what the compiler is allowed to veto.
// CONTEXT: The rules are proved in `@api`, the edits in `nextEditFacts.test.ts`,
//          the corpus gate in `nextEditCorpus.test.ts`. This file pins the
//          three rules the component keeps: accept edits the text and nothing
//          else, a chip is earned by the compiler, a dismissed chip stays
//          dismissed.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import * as fs from "fs";
import * as path from "path";
import type { BiPivotModelInfo } from "../../components/types";
import { modelInfoFromFixture, strategySummaryFromFixture } from "../../../../../tests/eval/lib/modelFixture.mjs";

// Set BEFORE React renders anything. Without it React 18 warns "the current
// testing environment is not configured to support act(...)" and `act` stops
// flushing effects synchronously, which turns every debounce in this file into
// a race: the same command produced 19 passed, then 4 failed, then a different
// 7 failed. The file had been relying on some OTHER test file in the same
// worker setting the flag first, so it passed in a full-suite run and failed
// when run alone under load. Every other React test file here sets it itself.
Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

const { NextEditRow, chipsFor, MODEL_CHIP_DEFAULT } = await import("./NextEditRow");
// From `nextEditFacts`, which owns the cap: the row imports it there too, and
// a re-export nobody needs is a second name for one thing.
const { MAX_CHIPS } = await import("./nextEditFacts");
const { registerAiCompletionProvider } = await import("@api");
const { suggestNextEdits } = await import("@api/designQueryAssist");
const { factsFromDsl } = await import("./nextEditFacts");

const REPO = path.resolve(__dirname, "../../../../..");
const read = (rel: string) => JSON.parse(fs.readFileSync(path.join(REPO, rel), "utf8"));
const model: BiPivotModelInfo = {
  ...modelInfoFromFixture(read("tests/fixtures/model/sales_star.json")),
  strategy: strategySummaryFromFixture(read("tests/fixtures/model/sales_star_strategy.json"), read("tests/fixtures/model/sales_star.json")),
};

let container: HTMLDivElement;
let root: Root;
const onApply = vi.fn();

async function render(text: string, over: Partial<React.ComponentProps<typeof NextEditRow>> = {}): Promise<void> {
  await act(async () => {
    root.render(React.createElement(NextEditRow, { text, biModel: model, connectionId: "fixture", onApply, debounceMs: 0, ...over }));
  });
}

const chips = () => [...container.querySelectorAll("[data-testid='next-edit-chip']")];
const accepts = () => [...container.querySelectorAll("[data-testid='next-edit-accept']")].map((b) => b.textContent);
const click = async (el: Element) => {
  await act(async () => {
    el.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
};

beforeEach(() => {
  onApply.mockReset();
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

describe("NextEditRow", () => {
  it("renders nothing for empty text or a query with nothing to add", async () => {
    await render("");
    expect(container.querySelector("[data-testid='next-edit-row']")).toBeNull();
    await render("ROWS: Product.Category\nCOLUMNS: Customer.Segment\nVALUES: [Revenue]");
    expect(container.querySelector("[data-testid='next-edit-row']")).toBeNull();
  });

  it("offers the strategy's breakdown for a bare measure, with its reason", async () => {
    await render("VALUES: [Revenue]");
    expect(accepts()).toContain("Add ROWS: Product.Category");
    expect(container.textContent).toContain("The strategy analyses Revenue by Product.Category.");
    expect(chips()[0].getAttribute("data-source")).toBe("strategy");
  });

  it("accept puts the edited text back and creates nothing", async () => {
    await render("VALUES: [Revenue]");
    await click(container.querySelector("[data-testid='next-edit-accept']")!);
    expect(onApply).toHaveBeenCalledTimes(1);
    expect(onApply).toHaveBeenCalledWith("ROWS: Product.Category\nVALUES: [Revenue]");
  });

  it("asks to remove a never-slice-by column and ranks it first", async () => {
    await render("ROWS: Product.Name, Product.Category\nVALUES: [Revenue]");
    expect(accepts()[0]).toBe("Remove Product.Name from ROWS");
    await click(container.querySelector("[data-testid='next-edit-accept']")!);
    expect(onApply).toHaveBeenCalledWith("ROWS: Product.Category\nVALUES: [Revenue]");
  });

  it("a dismissed suggestion stays dismissed while the query keeps its shape", async () => {
    await render("VALUES: [Revenue]");
    const before = accepts();
    expect(before.length).toBeGreaterThan(0);
    await click(container.querySelector("[data-testid='next-edit-dismiss']")!);
    expect(accepts()).not.toContain(before[0]);
    // The same text again (a keystroke elsewhere and back): still gone.
    await render("VALUES: [Revenue] ");
    expect(accepts()).not.toContain(before[0]);
    // A different edit for a different shape is a different suggestion.
    await render("ROWS: Product.Name\nVALUES: [Revenue]");
    expect(accepts()).toContain("Remove Product.Name from ROWS");
  });

  it("vetoes an edit that introduces an error, and keeps one that does not", async () => {
    // The bar is "no worse than the query already was", not "compiles cleanly".
    const worse = vi.fn((dsl: string) =>
      dsl.includes("ROWS:") ? { request: null, errors: [{}], warnings: [] } : { request: {} as never, errors: [], warnings: [] },
    );
    await render("VALUES: [Revenue]", { compile: worse });
    expect(worse).toHaveBeenCalled();
    expect(container.querySelector("[data-testid='next-edit-row']"), "the edit broke a query that compiled").toBeNull();

    const neutral = vi.fn(() => ({ request: {} as never, errors: [], warnings: [] }));
    await render("VALUES: [Revenue]", { compile: neutral });
    expect(accepts()).toContain("Add ROWS: Product.Category");
  });

  it("vetoes an edit that introduces a new WARNING", async () => {
    const warns = vi.fn((dsl: string) => ({
      request: {} as never,
      errors: [],
      warnings: dsl.includes("ROWS:") ? [{}] : [],
    }));
    await render("VALUES: [Revenue]", { compile: warns });
    expect(container.querySelector("[data-testid='next-edit-row']")).toBeNull();
  });

  it("still suggests on a query the compiler cannot parse at all — the @param case", async () => {
    // The real compiler, no injected double. The hosts substitute `@Name`
    // control parameters before they compile; this row does not, so an
    // absolute "must compile" bar silenced every query using the Reports
    // @param binding — exactly the half-finished queries a suggestion is
    // worth most on. Both the original and the edited text carry the same
    // lexer error, so the edit is not worse and the chip stands.
    await render('ROWS: Product.Category\nFILTERS: Geography.Region = @Region');
    expect(accepts(), "a missing VALUES is still worth saying on an @param query").toContain("Add VALUES: [Revenue]");
  });

  it("caps the row at three chips, choosing the three highest-priority ones", () => {
    const busy = [
      "ROWS: Product.Name, Customer.Segment, Customer.CustomerKey, Date.MonthName",
      "VALUES: [Revenue]",
      'FILTERS: Customer.Segment = ("Consumer")',
    ].join("\n");
    const uncapped = suggestNextEdits(factsFromDsl(busy, model.tables.map((t) => t.name)), model as never);
    expect(uncapped.length, "the input must produce MORE than the cap, or this test proves nothing").toBeGreaterThan(MAX_CHIPS);
    const shown = chipsFor(busy, model, "fixture", new Set());
    expect(shown).toHaveLength(MAX_CHIPS);
    const priorities = shown.map((c) => c.suggestion.priority);
    expect([...priorities].sort((a, b) => b - a)).toEqual(priorities);
    expect(Math.min(...priorities), "the three shown are the three most important").toBeGreaterThanOrEqual(
      Math.max(...uncapped.slice(MAX_CHIPS).map((s) => s.priority)),
    );
  });
});

describe("accepting a chip edits what is in the editor NOW", () => {
  // The first version carried a precomputed string on each chip, so accepting a
  // second chip reverted the first and accepting during the 300 ms debounce
  // threw away everything typed since.
  const STALE = 100_000;

  it("applies the edit to the current text, not to the text the chip was built from", async () => {
    await render("VALUES: [Revenue]");
    expect(accepts()).toContain("Add ROWS: Product.Category");
    // The parent applied something else in the meantime; the chips are stale.
    await render("VALUES: [Revenue]\nTOP 3 BY [Revenue]", { debounceMs: STALE });
    await click(container.querySelector("[data-testid='next-edit-accept']")!);
    expect(onApply).toHaveBeenCalledWith("ROWS: Product.Category\nVALUES: [Revenue]\nTOP 3 BY [Revenue]");
  });

  it("writes nothing and drops the chip when its edit no longer applies", async () => {
    await render("ROWS: Product.Name\nVALUES: [Revenue]");
    expect(accepts()).toContain("Remove Product.Name from ROWS");
    // Someone already removed it.
    await render("VALUES: [Revenue]\nTOP 3 BY [Revenue]", { debounceMs: STALE });
    await click(container.querySelector("[data-testid='next-edit-accept']")!);
    expect(onApply, "a stale chip must never write a stale query over the person's work").not.toHaveBeenCalled();
    expect(accepts()).not.toContain("Remove Product.Name from ROWS");
  });
});

describe("the model's chip (Milestone B)", () => {
  // Registered through the real seam rather than mocked: what is being proved
  // is that the row asks the SAME provider every other AI surface asks, and
  // obeys the same `honorsGrammar` gate.
  let unregister: (() => void) | null = null;

  function provider(over: Partial<{ grammar: boolean | undefined; reply: string; configured: boolean }> = {}) {
    const calls: Array<{ system: string; user: string; grammar?: string }> = [];
    const p = {
      calls,
      isConfigured: () => over.configured ?? true,
      modelLabel: () => "qwen2.5-coder-1.5b",
      isLocal: () => true,
      honorsSchema: () => true,
      honorsGrammar: () => ("grammar" in over ? over.grammar : true),
      complete: async (req: { system: string; messages: Array<{ text: string }>; grammar?: string }) => {
        calls.push({ system: req.system, user: req.messages[0].text, grammar: req.grammar });
        return { text: over.reply ?? "TOP 3 BY [Revenue]", truncated: false, model: "qwen2.5-coder-1.5b", durationMs: 5 };
      },
    };
    unregister = registerAiCompletionProvider(p as never);
    return p;
  }

  /**
   * Render with the model's chip switched ON.
   *
   * Every test in this block opts in, because `MODEL_CHIP_DEFAULT` is false:
   * a `render()` here would leave the model unasked, and the two tests that
   * assert NOTHING is asked would then pass without exercising the gate they
   * name. A vacuous negative test is worse than no test — it reports the guard
   * as covered.
   */
  async function ask(text: string, over: Partial<React.ComponentProps<typeof NextEditRow>> = {}): Promise<void> {
    await render(text, { askModel: true, ...over });
  }

  /** Let the debounce timer fire and the completion promise settle. */
  async function settle(): Promise<void> {
    for (let i = 0; i < 8; i++) await act(async () => { await new Promise((r) => setTimeout(r, 1)); });
  }

  afterEach(() => {
    unregister?.();
    unregister = null;
  });

  it("asks the model for one clause and shows it AFTER the rules", async () => {
    const p = provider({ reply: "TOP 3 BY [Cost]" });
    // A query that produces a RULE chip as well as room for the model's. The
    // first version used `ROWS: Product.Category\nVALUES: [Revenue]`, which is
    // a complete, correct query — the rules say nothing about it, so the
    // model's chip was the only chip on the row and "the model never outranks a
    // rule" compared it against nothing. `Product.ProductKey` has role "key"
    // and Cost has no never-slice-by, so key-to-label fires here.
    await ask("ROWS: Product.ProductKey\nVALUES: [Cost]");
    await settle();
    expect(p.calls, "exactly one request per settled text").toHaveLength(1);
    expect(p.calls[0].grammar, "a grammar, or the model could name a column it was not shown").toContain("root ::=");
    expect(p.calls[0].user).toContain("Query so far:");
    expect(p.calls[0].user).toContain("ROWS: Product.ProductKey");
    const labels = accepts();
    expect(labels.length, "a rule chip AND the model's, or the ordering below proves nothing").toBeGreaterThan(1);
    expect(labels).toContain("Add TOP 3 BY [Cost]");
    expect(labels[labels.length - 1], "the model never outranks a rule").toBe("Add TOP 3 BY [Cost]");
    const rows = [...container.querySelectorAll("[data-testid='next-edit-chip']")];
    expect(rows[0].getAttribute("data-source"), "a rule is first").not.toBe("model");
    const chip = rows[rows.length - 1];
    expect(chip.getAttribute("data-source")).toBe("model");
    expect(chip.textContent).toContain("qwen2.5-coder-1.5b");
  });

  it("does not show a second chip for an edit a rule already proposes", async () => {
    // The grammar cannot stop the model agreeing with a rule, and two chips
    // that write the same query are one chip and a distraction — the rule's,
    // which can say WHY from the document, is the one worth keeping.
    //
    // The collision is on the RESULTING TEXT, not on the op. No rule emits
    // `add-clause` — the rules say `add-field VALUES [Revenue]` and let
    // `applyEditOp` create the clause line — while the model can emit nothing
    // else. Two different ops, one identical query, which is why the dedup
    // compares the applied text. The reply is therefore derived from the line
    // a rule's edit actually ADDS. A first version looked for a rule chip whose
    // op was `add-clause` and found none, so the test failed loudly rather than
    // passing vacuously; an earlier one replied with a clause the query already
    // had, which `applyEditOp` refuses, and that DID pass for the wrong reason.
    const text = "ROWS: Product.Category";
    const ruleChip = chipsFor(text, model, "fixture", new Set()).find(
      (c) => c.applied.startsWith(`${text}\n`) && c.applied.split("\n").length === 2,
    );
    expect(ruleChip, "this fixture must produce a rule chip that adds exactly one line").toBeTruthy();
    const sameLine = ruleChip!.applied.split("\n")[1];

    const p = provider({ reply: sameLine });
    await ask(text);
    await settle();
    expect(p.calls, "the model is still asked").toHaveLength(1);
    const chipEls = [...container.querySelectorAll("[data-testid='next-edit-chip']")];
    expect(chipEls.length, "the rule's chip is still there").toBeGreaterThan(0);
    expect(
      chipEls.filter((c) => c.getAttribute("data-source") === "model"),
      `no model chip duplicating the rule's "${sameLine}"`,
    ).toHaveLength(0);
  });

  it("still shows the model's chip when it proposes something no rule did", async () => {
    // The positive control for the test above: the dedup must drop a duplicate
    // and nothing else.
    const p = provider({ reply: "LAYOUT: tabular" });
    await ask("ROWS: Product.Category");
    await settle();
    expect(p.calls).toHaveLength(1);
    const sources = [...container.querySelectorAll("[data-testid='next-edit-chip']")].map((c) => c.getAttribute("data-source"));
    expect(sources, "a clause no rule proposed is still offered").toContain("model");
  });

  it("accepting it adds the clause in canonical position", async () => {
    provider({ reply: 'FILTERS: Geography.Region = ("Europe")' });
    await ask("ROWS: Product.Category\nVALUES: [Revenue]\nLAYOUT: tabular");
    await settle();
    const accept = [...container.querySelectorAll("[data-testid='next-edit-accept']")].pop()!;
    await click(accept);
    expect(onApply).toHaveBeenCalledWith(
      'ROWS: Product.Category\nVALUES: [Revenue]\nFILTERS: Geography.Region = ("Europe")\nLAYOUT: tabular',
    );
  });

  it("asks nothing of a runtime that does not honour a grammar", async () => {
    const p = provider({ grammar: false });
    await ask("ROWS: Product.Category\nVALUES: [Revenue]");
    await settle();
    expect(p.calls, "a wrong clause is worse than no clause").toHaveLength(0);
    const p2 = provider({ grammar: undefined });
    await ask("ROWS: Geography.Region\nVALUES: [Revenue]");
    await settle();
    expect(p2.calls, "unmeasured is not a yes").toHaveLength(0);
  });

  it("asks nothing when no model is selected", async () => {
    const p = provider({ configured: false });
    await ask("ROWS: Product.Category\nVALUES: [Revenue]");
    await settle();
    expect(p.calls).toHaveLength(0);
  });

  it("holds the model's clause to the same veto as a rule's edit", async () => {
    // The grammar makes an invented NAME impossible; it cannot make a clause
    // SENSIBLE. The compile check is what stands between the two.
    provider({ reply: "SORT: Product.Category DESC" });
    await ask("ROWS: Product.Category\nVALUES: [Revenue]", {
      compile: (dsl: string) => ({ request: dsl.includes("SORT") ? null : ({} as never), errors: dsl.includes("SORT") ? [{}] : [], warnings: [] }),
    });
    await settle();
    expect(accepts()).not.toContain("Add SORT: Product.Category DESC");
  });

  it("says nothing when the model returns nothing — a finished query", async () => {
    provider({ reply: "   " });
    await ask("ROWS: Product.Category\nVALUES: [Revenue]");
    await settle();
    expect(accepts().some((l) => l?.startsWith("Add "))).toBe(false);
  });

  it("is OFF unless a caller asks for it, and the rules' chips are unaffected", async () => {
    // The decision the measurement made, pinned. `run-next-edit-eval.mjs` on
    // the built-in 1.5B: 0 of 80 next clauses right, a chip on 52 of 52 queries
    // that were already finished, median 686 ms against a 400 ms gate. If this
    // ever flips back to on, it should be because a run said so.
    expect(MODEL_CHIP_DEFAULT, "see the measurement above MODEL_CHIP_DEFAULT").toBe(false);
    const p = provider({ reply: "TOP 3 BY [Revenue]" });
    // A query with no VALUES, so the rules DO have something to say: a
    // complete query would leave the row empty for the rules' own reasons and
    // prove nothing about the model being off.
    await render("ROWS: Product.Category");
    await settle();
    expect(p.calls, "no request at all without an explicit askModel").toHaveLength(0);
    expect(accepts().some((l) => l?.startsWith("Add TOP")), "no model chip").toBe(false);
    // ...and Tier 0 is untouched: the row is still worth having.
    expect(chips().length, "the rules' chips do not depend on the model").toBeGreaterThan(0);
  });
});
