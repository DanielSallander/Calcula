// FILENAME: app/extensions/ModelEditor/__tests__/bulkEdit.test.ts
// PURPOSE: The command a bulk edit composes must target exactly the objects
//          that were selected — no more, no fewer, none mistargeted.
// CONTEXT: A bulk edit is executed by handing a STRING to the CLI, so a quoting
//          slip is not a syntax error you notice: `set column Order Date[x]`
//          parses as two positionals and hits something else, or nothing, and
//          reports success either way. These tests pin the quoting.

import { describe, expect, it } from "vitest";
import {
  buildSetColumnsCommand,
  buildSetCommand,
  columnRef,
  option,
  quoteName,
  shared,
  unquotableNames,
} from "../lib/bulkEdit";

describe("quoteName", () => {
  it("leaves a plain identifier bare", () => {
    expect(quoteName("OrderDate")).toBe("OrderDate");
    expect(quoteName("BI.dim_customer")).toBe("BI.dim_customer");
    expect(quoteName("col_1")).toBe("col_1");
  });

  it("quotes anything with a space — the slip that silently mistargets", () => {
    expect(quoteName("Order Date")).toBe('"Order Date"');
  });

  it("quotes a name with a comma, which the lexer would otherwise split", () => {
    expect(quoteName("Amount, net")).toBe('"Amount, net"');
  });

  it("falls back to brackets when the name contains a double quote", () => {
    // The grammar has no string escapes, so a quoted form is impossible.
    expect(quoteName('He said "hi"')).toBe('[He said "hi"]');
  });
});

describe("unquotableNames", () => {
  it("reports a name this grammar genuinely cannot express", () => {
    // Both a quote AND a bracket: neither quoting nor bracketing survives.
    expect(unquotableNames(['a"b[c]'])).toEqual(['a"b[c]']);
  });

  it("passes everything expressible", () => {
    expect(unquotableNames(["Plain", "With Space", 'With"Quote', "With[Bracket]"])).toEqual([]);
  });
});

describe("buildSetColumnsCommand", () => {
  it("targets every selected column in ONE command", () => {
    const cmd = buildSetColumnsCommand(
      [
        { table: "Fact_Sales", column: "ETLBatchId" },
        { table: "Fact_Sales", column: "RowHash" },
        { table: "Fact_Sales", column: "LoadedAt" },
      ],
      { hidden: true },
    );
    // One command means one backend batch: one undo step, and ONE
    // cross-window recalc instead of three.
    expect(cmd).toBe(
      "set column Fact_Sales[ETLBatchId] Fact_Sales[RowHash] Fact_Sales[LoadedAt] hidden=true",
    );
  });

  it("quotes a table name that needs it", () => {
    const cmd = buildSetColumnsCommand([{ table: "Order Header", column: "Id" }], { hidden: false });
    expect(cmd).toBe('set column "Order Header"[Id] hidden=false');
  });

  it("uses the empty-value spelling to CLEAR a property", () => {
    const cmd = buildSetColumnsCommand([{ table: "T", column: "c" }], { format: "" });
    expect(cmd).toBe("set column T[c] format=");
  });

  it("returns null rather than an empty command when nothing is selected", () => {
    // An empty command would run, succeed, and change nothing — success is the
    // worst possible report for "you selected nothing".
    expect(buildSetColumnsCommand([], { hidden: true })).toBeNull();
  });

  it("returns null when no property was actually changed", () => {
    expect(buildSetColumnsCommand([{ table: "T", column: "c" }], {})).toBeNull();
  });
});

describe("option", () => {
  it("renders booleans the way the grammar spells them", () => {
    expect(option("hidden", true)).toBe("hidden=true");
    expect(option("hidden", false)).toBe("hidden=false");
  });

  it("quotes a value containing a space", () => {
    expect(option("format", "#,##0.00 kr")).toBe('format="#,##0.00 kr"');
  });
});

describe("columnRef / buildSetCommand", () => {
  it("builds a qualified column reference", () => {
    expect(columnRef("Dim_Date", "Year")).toBe("Dim_Date[Year]");
  });

  it("builds a single-object set for Copy as command", () => {
    expect(buildSetCommand("measure", "Margin %", { format: "0.0%" })).toBe(
      'set measure "Margin %" format="0.0%"',
    );
  });
});

describe("shared", () => {
  const cols = [
    { name: "a", isHidden: true },
    { name: "b", isHidden: true },
    { name: "c", isHidden: false },
  ];

  it("reports a value every item agrees on", () => {
    expect(shared(cols.slice(0, 2), (c) => c.isHidden)).toEqual({ kind: "same", value: true });
  });

  it("reports mixed when they disagree — never a guess", () => {
    // Guessing here would make one click silently flip the odd one out.
    expect(shared(cols, (c) => c.isHidden)).toEqual({ kind: "mixed" });
  });

  it("reports none for an empty selection", () => {
    expect(shared([], (c: { isHidden: boolean }) => c.isHidden)).toEqual({ kind: "none" });
  });
});
