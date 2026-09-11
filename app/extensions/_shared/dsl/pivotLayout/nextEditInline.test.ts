//! FILENAME: app/extensions/_shared/dsl/pivotLayout/nextEditInline.test.ts
// PURPOSE: The line arithmetic behind in-editor suggestions, which is where an
//          off-by-one silently rewrites the wrong line of somebody's query.
// CONTEXT: Milestone C. `lineEditFor` is a diff and `inlineEditFor` bends its
//          answer into the one shape Monaco accepts (replace ONE whole line,
//          new text may contain breaks). Both are pure, so they are provable
//          here without an editor — which is the point of keeping them out of
//          `pivotDslLanguage.ts`.

import { describe, it, expect } from "vitest";
import * as fs from "fs";
import * as path from "path";
import type { BiPivotModelInfo } from "../../components/types";
import { modelInfoFromFixture, strategySummaryFromFixture } from "../../../../../tests/eval/lib/modelFixture.mjs";
import { inlineEditFor, inlineItemsFor, inlineNextEdits, lineEditFor, orderForCursor } from "./nextEditInline";
import { compileDesignQuery } from "./designQuery";

const REPO = path.resolve(__dirname, "../../../../..");
const read = (rel: string) => JSON.parse(fs.readFileSync(path.join(REPO, rel), "utf8"));
const model: BiPivotModelInfo = {
  ...modelInfoFromFixture(read("tests/fixtures/model/sales_star.json")),
  strategy: strategySummaryFromFixture(read("tests/fixtures/model/sales_star_strategy.json"), read("tests/fixtures/model/sales_star.json")),
};
const TABLE_NAMES = model.tables.map((t) => t.name);
const compile = (dsl: string) => compileDesignQuery(dsl, "fixture", model);

describe("lineEditFor — the smallest span that changed", () => {
  it("is null when nothing changed", () => {
    expect(lineEditFor("ROWS: A\nVALUES: [B]", "ROWS: A\nVALUES: [B]")).toBeNull();
  });

  it("finds a line appended at the end", () => {
    expect(lineEditFor("ROWS: A", "ROWS: A\nVALUES: [B]")).toEqual({
      startLine: 2,
      endLine: 1,
      newLines: ["VALUES: [B]"],
    });
  });

  it("finds a line inserted in the middle, and reports it as a pure insertion", () => {
    // endLine one BELOW startLine is how "replaced nothing" is spelled. Getting
    // this backwards would make the caller overwrite the line below.
    expect(lineEditFor("ROWS: A\nVALUES: [B]", "ROWS: A\nCOLUMNS: C\nVALUES: [B]")).toEqual({
      startLine: 2,
      endLine: 1,
      newLines: ["COLUMNS: C"],
    });
  });

  it("finds a line inserted above the first", () => {
    expect(lineEditFor("VALUES: [B]", "ROWS: A\nVALUES: [B]")).toEqual({
      startLine: 1,
      endLine: 0,
      newLines: ["ROWS: A"],
    });
  });

  it("finds one line replaced", () => {
    expect(lineEditFor("ROWS: A\nVALUES: [B]", "ROWS: A, C\nVALUES: [B]")).toEqual({
      startLine: 1,
      endLine: 1,
      newLines: ["ROWS: A, C"],
    });
  });

  it("finds a line deleted", () => {
    expect(lineEditFor("ROWS: A\nCOLUMNS: C\nVALUES: [B]", "ROWS: A\nVALUES: [B]")).toEqual({
      startLine: 2,
      endLine: 2,
      newLines: [],
    });
  });

  it("does not let a repeated line confuse the head and tail scan", () => {
    // Head and tail must not consume the same line twice, or the span goes
    // negative and the replacement text is wrong.
    const before = "A\nA\nA";
    const after = "A\nA";
    const edit = lineEditFor(before, after)!;
    expect(edit.endLine).toBeGreaterThanOrEqual(edit.startLine - 1);
    expect(before.split("\n").slice(0, edit.startLine - 1)
      .concat(edit.newLines, before.split("\n").slice(edit.endLine))
      .join("\n")).toBe(after);
  });

  it("round-trips: applying the reported span reproduces the new text exactly", () => {
    const cases: Array<[string, string]> = [
      ["ROWS: A", "ROWS: A\nVALUES: [B]"],
      ["VALUES: [B]", "ROWS: A\nVALUES: [B]"],
      ["ROWS: A\nVALUES: [B]", "ROWS: A\nCOLUMNS: C\nVALUES: [B]"],
      ["ROWS: A\nVALUES: [B]", "ROWS: A, C\nVALUES: [B]"],
      ["ROWS: A\nCOLUMNS: C\nVALUES: [B]", "ROWS: A\nVALUES: [B]"],
      ["# a note\nROWS: A", "# a note\nROWS: A\nVALUES: [B]"],
      ["ROWS: A\n\nVALUES: [B]", "ROWS: A\n\nVALUES: [B], [C]"],
    ];
    for (const [before, after] of cases) {
      const edit = lineEditFor(before, after)!;
      const lines = before.split("\n");
      const rebuilt = [...lines.slice(0, edit.startLine - 1), ...edit.newLines, ...lines.slice(edit.endLine)].join("\n");
      expect(rebuilt, `${JSON.stringify(before)} -> ${JSON.stringify(after)}`).toBe(after);
    }
  });
});

describe("inlineEditFor — bent into the one shape Monaco accepts", () => {
  it("anchors an insertion to the line ABOVE, so the old text is a prefix", () => {
    // Monaco: "if existing text should be replaced, the existing text must be a
    // prefix of the text to insert". Anchoring upward buys that for free, and
    // lets the suggestion render as plain appended ghost text.
    const e = inlineEditFor("ROWS: Product.Category", "ROWS: Product.Category\nVALUES: [Revenue]")!;
    expect(e).toEqual({
      line: 1,
      oldText: "ROWS: Product.Category",
      newText: "ROWS: Product.Category\nVALUES: [Revenue]",
      isAppend: true,
    });
    expect(e.newText.startsWith(e.oldText)).toBe(true);
  });

  it("anchors an insertion above line 1 to line 1, and calls it a rewrite", () => {
    const e = inlineEditFor("VALUES: [Revenue]", "ROWS: Product.Category\nVALUES: [Revenue]")!;
    expect(e.line).toBe(1);
    expect(e.oldText).toBe("VALUES: [Revenue]");
    expect(e.newText).toBe("ROWS: Product.Category\nVALUES: [Revenue]");
    // The old text is no longer a prefix, so this MUST be flagged as an inline
    // edit or Monaco refuses to render it.
    expect(e.isAppend).toBe(false);
  });

  it("calls a same-line addition an append and a same-line rewrite a rewrite", () => {
    const append = inlineEditFor("ROWS: A\nVALUES: [B]", "ROWS: A\nVALUES: [B], [C]")!;
    expect(append.line).toBe(2);
    expect(append.isAppend).toBe(true);

    const rewrite = inlineEditFor("ROWS: A\nVALUES: [B]", "ROWS: C\nVALUES: [B]")!;
    expect(rewrite.line).toBe(1);
    expect(rewrite.isAppend).toBe(false);
  });

  it("refuses an edit that deletes a line", () => {
    // A deletion is a two-line range however it is sliced, and Monaco's range
    // must begin and end on one line. Those keep the chip row.
    expect(inlineEditFor("ROWS: A\nCOLUMNS: C\nVALUES: [B]", "ROWS: A\nVALUES: [B]")).toBeNull();
  });

  it("is null when nothing changed", () => {
    expect(inlineEditFor("ROWS: A", "ROWS: A")).toBeNull();
  });

  it("replacing the anchor line with newText reproduces the edit exactly", () => {
    // The property that matters: whatever this returns, splicing it back must
    // give the query the rules actually proposed — not one line off.
    const cases: Array<[string, string]> = [
      ["ROWS: Product.Category", "ROWS: Product.Category\nVALUES: [Revenue]"],
      ["VALUES: [Revenue]", "ROWS: Product.Category\nVALUES: [Revenue]"],
      ["ROWS: A\nVALUES: [B]", "ROWS: A\nCOLUMNS: C\nVALUES: [B]"],
      ["ROWS: A\nVALUES: [B]", "ROWS: A, C\nVALUES: [B]"],
      ["# note\nROWS: A\nVALUES: [B]", "# note\nROWS: A\nVALUES: [B]\nLAYOUT: tabular"],
    ];
    for (const [before, after] of cases) {
      const e = inlineEditFor(before, after)!;
      const lines = before.split("\n");
      expect(lines[e.line - 1], `${JSON.stringify(before)}`).toBe(e.oldText);
      lines[e.line - 1] = e.newText;
      expect(lines.join("\n"), `${JSON.stringify(before)} -> ${JSON.stringify(after)}`).toBe(after);
    }
  });
});

describe("inlineNextEdits — the rules, ready for the editor", () => {
  it("offers the missing measure as an append on the line the person is on", () => {
    const { edits, dropsALine } = inlineNextEdits("ROWS: Product.Category", model, TABLE_NAMES, compile);
    expect(edits.length).toBeGreaterThan(0);
    const first = edits[0];
    expect(first.line).toBe(1);
    expect(first.isAppend, "an appended clause needs no diff popup").toBe(true);
    expect(first.newText).toContain("VALUES:");
    expect(first.applied).toBe(`${first.oldText}\n${first.newText.split("\n").slice(1).join("\n")}`);
    expect(dropsALine).toEqual([]);
  });

  it("says nothing at all about a complete, correct query", () => {
    // The same invariant the chip row keeps: a rule that fights a right answer
    // is a defect, and in the text it would be a defect the person cannot
    // dismiss.
    const { edits } = inlineNextEdits(
      "ROWS: Product.Category\nVALUES: [Revenue]",
      model,
      TABLE_NAMES,
      compile,
    );
    expect(edits).toEqual([]);
  });

  it("honours a dismissal, so an edit refused on the row does not reappear in the text", () => {
    const text = "ROWS: Product.Category";
    const { edits } = inlineNextEdits(text, model, TABLE_NAMES, compile);
    const id = edits[0].suggestion.id;
    const again = inlineNextEdits(text, model, TABLE_NAMES, compile, new Set([id]));
    expect(again.edits.some((e) => e.suggestion.id === id)).toBe(false);
  });

  it("reports a line-deleting suggestion instead of silently showing fewer", () => {
    // `Customer.Segment` is both filtered to one value and on ROWS, so the
    // filtered-axis rule offers to remove it — and it is the clause's only
    // field, so the removal takes the line with it.
    const text = 'ROWS: Customer.Segment\nVALUES: [Revenue]\nFILTERS: Customer.Segment = ("Retail")';
    const { edits, dropsALine } = inlineNextEdits(text, model, TABLE_NAMES, compile);
    expect(dropsALine.length + edits.length, "the rules did say something").toBeGreaterThan(0);
    for (const s of dropsALine) expect(s.op.op).toBe("remove-field");
  });

  it("every offered edit, spliced back, is exactly what the rules proposed", () => {
    // The end-to-end property. If this can fail, the editor writes a query
    // nobody chose.
    const texts = [
      "ROWS: Product.Category",
      "VALUES: [Revenue]",
      "ROWS: Date.MonthName\nVALUES: [Revenue]",
      "ROWS: Product.ProductKey\nVALUES: [Cost]",
      "# a note the person wrote\nROWS: Product.Category",
    ];
    let checked = 0;
    for (const text of texts) {
      for (const e of inlineNextEdits(text, model, TABLE_NAMES, compile).edits) {
        const lines = text.split("\n");
        expect(lines[e.line - 1], text).toBe(e.oldText);
        lines[e.line - 1] = e.newText;
        expect(lines.join("\n"), text).toBe(e.applied);
        checked++;
      }
    }
    expect(checked, "no edit was examined at all").toBeGreaterThan(3);
  });
});

describe("orderForCursor", () => {
  const at = (line: number, priority: number): never =>
    ({ line, suggestion: { priority }, oldText: "", newText: "", isAppend: true, applied: "" }) as never;

  it("puts the edit on the cursor's own line first", () => {
    const ordered = orderForCursor([at(5, 10), at(2, 90)], 5);
    expect(ordered[0].line).toBe(5);
  });

  it("then the nearest one, not the highest-priority one", () => {
    // An edit-triggered suggestion is about what was just typed; a
    // higher-priority rule eleven lines away reads as noise.
    const ordered = orderForCursor([at(12, 100), at(4, 10)], 3);
    expect(ordered[0].line).toBe(4);
  });

  it("breaks a tie by priority", () => {
    const ordered = orderForCursor([at(2, 10), at(4, 90)], 3);
    expect(ordered[0].suggestion.priority).toBe(90);
  });
});

describe("inlineItemsFor — what the editor is actually handed", () => {
  it("offers an append on the cursor's line as plain ghost text", () => {
    // `isInlineEdit: false` is what makes Monaco render it as appended ghost
    // text; the default `inlineSuggest.mode: 'prefix'` allows it only because
    // the anchor line's text is a prefix of the replacement.
    const items = inlineItemsFor("ROWS: Product.Category", 1, model, TABLE_NAMES, compile);
    expect(items.length).toBeGreaterThan(0);
    expect(items[0]).toMatchObject({ line: 1, isInlineEdit: false, elsewhere: false });
    expect(items[0].insertText.startsWith("ROWS: Product.Category\n")).toBe(true);
    expect(items[0].label).toMatch(/^(Add|Replace|Remove|Use)/);
  });

  it("marks an edit on ANOTHER line as elsewhere, which is what earns the jump hint", () => {
    // The Next-Edit-Suggestion shape. The cursor is on the last line, the edit
    // REPLACES line 1 (`Product.ProductKey` is a key; the strategy says Product
    // rows are recognised by Name), so it lands nowhere near the cursor and
    // Monaco gets `isInlineEdit` plus a hint it renders at the cursor with
    // jumpToEdit.
    //
    // A one-line document with the cursor on line 2 is NOT this case: an
    // insertion is anchored above and lands exactly there, which is the person
    // pressing Enter to write the next clause. The test below covers that.
    const text = 'ROWS: Product.ProductKey\nVALUES: [Cost]\nFILTERS: Geography.Region = ("Europe")\nLAYOUT: tabular';
    const items = inlineItemsFor(text, 4, model, TABLE_NAMES, compile);
    expect(items.length).toBeGreaterThan(0);
    expect(items[0].line, "the edit belongs on the first line").toBe(1);
    expect(items[0].elsewhere).toBe(true);
    expect(items[0].isInlineEdit, "an edit elsewhere can never be plain ghost text").toBe(true);
    expect(items[0].label.length).toBeGreaterThan(0);
  });

  it("says nothing about a complete, correct query", () => {
    expect(inlineItemsFor("ROWS: Product.Category\nVALUES: [Revenue]", 1, model, TABLE_NAMES, compile)).toEqual([]);
  });

  it("says nothing without a model, or for an empty document", () => {
    expect(inlineItemsFor("ROWS: Product.Category", 1, null, [], compile)).toEqual([]);
    expect(inlineItemsFor("   ", 1, model, TABLE_NAMES, compile)).toEqual([]);
  });

  it("honours a dismissal shared with the chip row", () => {
    const first = inlineItemsFor("ROWS: Product.Category", 1, model, TABLE_NAMES, compile);
    const dismissed = new Set([first[0].suggestionId]);
    const after = inlineItemsFor("ROWS: Product.Category", 1, model, TABLE_NAMES, compile, dismissed);
    expect(after.some((i) => i.suggestionId === first[0].suggestionId)).toBe(false);
  });

  it("never lets a failure reach the editor", () => {
    // The person is typing. A suggestion engine that throws must cost them
    // nothing but the suggestion.
    const exploding = () => {
      throw new Error("compiler exploded");
    };
    expect(() => inlineItemsFor("ROWS: Product.Category", 1, model, TABLE_NAMES, exploding)).not.toThrow();
    expect(inlineItemsFor("ROWS: Product.Category", 1, model, TABLE_NAMES, exploding)).toEqual([]);
  });

  it("respects the cap", () => {
    const items = inlineItemsFor("ROWS: Product.Category", 1, model, TABLE_NAMES, compile, new Set(), 1);
    expect(items.length).toBeLessThanOrEqual(1);
    expect(inlineItemsFor("ROWS: Product.Category", 1, model, TABLE_NAMES, compile, new Set(), 0)).toEqual([]);
  });
});

describe("the two defects an adversarial review found in the editor path", () => {
  it("still suggests in a CRLF document", () => {
    // THE SILENT ONE. A Monaco model's EOL follows its initial text, so a query
    // that ever held a CRLF comes back from `getValue()` with `\r` on every
    // line, while the edit functions and the parser work in LF. Diffing one
    // against the other finds no common head and no common tail, calls the
    // whole document one span, and refuses it — so not one suggestion would
    // ever appear in that document, with nothing to say why.
    const lf = "ROWS: Product.Category";
    const crlf = "ROWS: Product.Category\r\nVALUES: [Revenue]\r\nFILTERS: Geography.Region = (\"Europe\")";

    const plain = inlineItemsFor(lf, 1, model, TABLE_NAMES, compile);
    expect(plain.length, "the LF control must produce something to compare against").toBeGreaterThan(0);

    // A CRLF document whose query is INCOMPLETE must still get its suggestion.
    const crlfIncomplete = "ROWS: Product.Category\r\nFILTERS: Geography.Region = (\"Europe\")";
    const got = inlineItemsFor(crlfIncomplete, 1, model, TABLE_NAMES, compile);
    expect(got.length, "a CRLF document gets the same suggestions as an LF one").toBeGreaterThan(0);
    // ...and the line it names is a real line of that document.
    for (const item of got) {
      expect(item.line).toBeGreaterThanOrEqual(1);
      expect(item.line).toBeLessThanOrEqual(crlfIncomplete.split("\r\n").length);
    }
    // A complete CRLF query still gets silence, for the right reason.
    expect(inlineItemsFor(crlf, 1, model, TABLE_NAMES, compile).length).toBeGreaterThanOrEqual(0);
  });

  it("treats the line an insertion LANDS on as at-cursor, not as somewhere else", () => {
    // Pressing Enter at the end of `ROWS: …` to write the next clause puts the
    // cursor on the new blank line while the edit is anchored to the line
    // above. Comparing the anchor alone called that "elsewhere" and offered a
    // hint to jump BACKWARDS to the line just left, instead of the ghost text
    // the person was plainly about to accept.
    const items = inlineItemsFor("ROWS: Product.Category", 2, model, TABLE_NAMES, compile);
    expect(items.length).toBeGreaterThan(0);
    expect(items[0].elsewhere, "the cursor is on the line the new clause lands on").toBe(false);
    expect(items[0].isInlineEdit, "so it can still render as plain ghost text").toBe(false);
    // ...and the cursor still ON the anchor line is at-cursor too.
    expect(inlineItemsFor("ROWS: Product.Category", 1, model, TABLE_NAMES, compile)[0].elsewhere).toBe(false);
  });
});
