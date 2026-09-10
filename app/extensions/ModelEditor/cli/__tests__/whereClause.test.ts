// FILENAME: app/extensions/ModelEditor/cli/__tests__/whereClause.test.ts
// PURPOSE: Parsing and evaluation of the `where` clause, and the refusals that
//          make it safe.
// CONTEXT: THE HAZARD THIS CLAUSE CREATES: `where` NARROWS a command, so a
//          clause that is parsed and then ignored does not narrow it — it runs
//          the command widened. `delete measure * where folder="Archive"` would
//          delete every measure in the model and report success, and the
//          confirmation card that should have listed three names would have
//          listed three hundred. Several tests here exist only to prove that
//          cannot happen.

import { describe, expect, it } from "vitest";
import { parseScript } from "../parse";
import {
  describeWhere,
  matchesWhere,
  validateWhere,
  whereKeysFor,
} from "../whereClause";
import { CliError } from "../lex";

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

describe("parsing a where clause", () => {
  it("splits predicates off the command's own options", () => {
    // The lexer sees `hidden=true` and `hidden=false` identically; only the
    // `where` keyword tells them apart. Merging them would turn a coherent
    // command — hide the visible ones — into a contradiction.
    const [cmd] = parseScript('set column * hidden=true where hidden=false');
    expect(cmd.opts.get("hidden")?.[0]?.[0]?.text).toBe("true");
    expect(cmd.where).toEqual([
      { key: "hidden", value: "false", line: 1 },
    ]);
  });

  it("joins predicates with `and`", () => {
    const [cmd] = parseScript('set column * hidden=true where table="Sales" and format=');
    expect(cmd.where).toEqual([
      { key: "table", value: "Sales", line: 1 },
      { key: "format", value: "", line: 1 },
    ]);
  });

  it("treats an absent value as the empty test", () => {
    // `where format=` is "has no format string" — the single most useful
    // predicate, and the reason the value is allowed to be missing at all.
    const [cmd] = parseScript("set measure * format=\"0.0%\" where format=");
    expect(cmd.where).toEqual([{ key: "format", value: "", line: 1 }]);
  });

  it("leaves `where` null when there is no clause", () => {
    // Null and [] must be distinguishable: one means "nothing to evaluate",
    // the other would mean "a clause I must refuse if I cannot evaluate it".
    const [cmd] = parseScript("set column * hidden=true");
    expect(cmd.where).toBeNull();
  });

  it("rejects a bare `where` with nothing after it", () => {
    expect(() => parseScript("set column * hidden=true where")).toThrow(/at least one/i);
  });

  it("rejects a predicate that is not key=value", () => {
    expect(() => parseScript("set column * hidden=true where nonsense")).toThrow(
      /key=value/i,
    );
  });

  it("does not treat a column named `where` as the keyword mid-target", () => {
    // The keyword is only recognised as a bare word in the positional stream;
    // a quoted or bracketed name is a value.
    const [cmd] = parseScript('set column T["where"] hidden=true');
    expect(cmd.where).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Validation — the refusals
// ---------------------------------------------------------------------------

describe("validation refuses rather than silently matching nothing", () => {
  it("rejects an unknown property, naming the valid ones", () => {
    // A typo that matched nothing would be indistinguishable from a true
    // "nothing qualifies" — and the user would believe the wrong one.
    expect(() => validateWhere([{ key: "hiden", value: "true", line: 1 }], "column", 1)).toThrow(
      CliError,
    );
    try {
      validateWhere([{ key: "hiden", value: "true", line: 1 }], "column", 1);
    } catch (e) {
      expect(String(e)).toMatch(/not a property of a column/);
      expect(String(e)).toMatch(/hidden/); // the suggestion list
    }
  });

  it("rejects a kind that has no readable properties", () => {
    expect(() => validateWhere([{ key: "x", value: "1", line: 1 }], "role", 1)).toThrow(
      /cannot filter role/i,
    );
  });

  it("accepts every key it advertises", () => {
    for (const kind of ["column", "measure", "table", "relationship"] as const) {
      for (const key of whereKeysFor(kind)) {
        expect(() => validateWhere([{ key, value: "", line: 1 }], kind, 1)).not.toThrow();
      }
    }
  });
});

// ---------------------------------------------------------------------------
// Evaluation
// ---------------------------------------------------------------------------

const column = (over: Record<string, unknown> = {}) => ({
  table: { name: "Fact_Sales" } as never,
  column: {
    name: "Amount", dataType: "Decimal", displayName: null, description: null,
    isHidden: false, isCalculated: false, isDynamic: false, formula: null,
    lookupResolution: null, sortByColumn: null, formatString: null, ...over,
  } as never,
});

describe("evaluating predicates", () => {
  it("matches a boolean the way the option grammar spells it", () => {
    expect(matchesWhere(column(), [{ key: "hidden", value: "false", line: 1 }], "column")).toBe(true);
    expect(matchesWhere(column(), [{ key: "hidden", value: "true", line: 1 }], "column")).toBe(false);
  });

  it("treats unset and empty as the same answer to `has one?`", () => {
    // formatString is null here; `where format=` must find it.
    expect(matchesWhere(column(), [{ key: "format", value: "", line: 1 }], "column")).toBe(true);
    expect(
      matchesWhere(column({ formatString: "0.0%" }), [{ key: "format", value: "", line: 1 }], "column"),
    ).toBe(false);
  });

  it("filters a column by its OWNING TABLE — the key the whole feature needs", () => {
    expect(matchesWhere(column(), [{ key: "table", value: "Fact_Sales", line: 1 }], "column")).toBe(true);
    expect(matchesWhere(column(), [{ key: "table", value: "Dim_Date", line: 1 }], "column")).toBe(false);
  });

  it("compares case-insensitively, like every other name in this grammar", () => {
    // globToRegex matches names case-insensitively; a `where` that did not
    // would be a rule existing nowhere else in the language.
    expect(matchesWhere(column(), [{ key: "type", value: "decimal", line: 1 }], "column")).toBe(true);
  });

  it("requires EVERY predicate to hold (and, not or)", () => {
    const c = column({ isHidden: true, formatString: "0.0%" });
    expect(
      matchesWhere(c, [
        { key: "hidden", value: "true", line: 1 },
        { key: "format", value: "0.0%", line: 1 },
      ], "column"),
    ).toBe(true);
    expect(
      matchesWhere(c, [
        { key: "hidden", value: "true", line: 1 },
        { key: "format", value: "#,##0", line: 1 },
      ], "column"),
    ).toBe(false);
  });

  it("renders a clause readably for the refusal message", () => {
    expect(
      describeWhere([
        { key: "table", value: "Sales", line: 1 },
        { key: "format", value: "", line: 1 },
      ]),
    ).toBe("table=Sales and format=(empty)");
  });
});
