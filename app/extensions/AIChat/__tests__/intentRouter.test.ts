//! FILENAME: app/extensions/AIChat/__tests__/intentRouter.test.ts
// PURPOSE: Each rule family of the intent router, one at a time, with the
//          precedence pairs and the "two strong classes means ask" contract.
// CONTEXT: The corpus test (`intentRouter.corpus.test.ts`) is the gate that
//          matters — it routes every utterance in `tests/eval/intents.json` and
//          fails on one decisive miss. These tests exist for the other reason a
//          unit test exists: when the corpus test reds, they say WHICH rule.

import { describe, it, expect } from "vitest";
import { buildModelFieldIndex } from "@api";
import { routeIntent, describeRoute, fieldsNamed } from "../lib/intentRouter";

const STAR = buildModelFieldIndex([
  {
    tables: [
      { name: "Sales", columns: [{ name: "Date" }, { name: "Amount" }, { name: "Quantity" }] },
      { name: "Product", columns: [{ name: "Category" }, { name: "Name" }] },
      { name: "Subcategory", columns: [{ name: "SubcategoryName" }] },
      { name: "Customer", columns: [{ name: "Segment" }] },
      { name: "Geography", columns: [{ name: "Region" }, { name: "Country" }] },
      { name: "Date", columns: [{ name: "Year" }, { name: "Month" }, { name: "MonthName" }] },
    ],
    measures: [{ name: "Revenue" }, { name: "Cost" }, { name: "Margin" }, { name: "MarginPct" }, { name: "Customers" }],
  },
]);
const withModel = (text: string) => routeIntent(text, { fields: STAR });

describe("a leading equals sign", () => {
  it("is a formula, decisively, before anything else is considered", () => {
    const r = routeIntent("=SUM(B2:B100)");
    expect(r).toMatchObject({ intent: "formula", decisive: true });
  });
});

describe("script: durability signals, not the word 'script'", () => {
  const DURABLE = [
    ["When this button is clicked, copy the value in A1 into B1.", "event"],
    ["colour the row red whenever the total goes negative", "event"],
    ["every 15 minutes, refresh the totals", "schedule"],
    ["remember the count across sessions", "persists"],
    ["ask the user to confirm before clearing the sheet", "run-time"],
    ["expose a command that recalculates everything", "entry point"],
    ["download the current USD rate from https://api.example.com/rates and put it in B2", "capability"],
    ["get JSON from the api and put the count in A1", "capability"],
    ["make something reusable that cleans up the names", "explicit"],
  ] as const;
  for (const [text, kind] of DURABLE) {
    it(`${kind}: ${text.slice(0, 44)}...`, () => {
      const r = routeIntent(text);
      expect(r.intent, r.matched.join(" | ")).toBe("script");
      expect(r.decisive).toBe(true);
      expect(r.matched[0]).toContain(kind);
    });
  }

  it("a schedule is a GROUPING when it follows for/per/by, and a timer when it has a verb", () => {
    expect(withModel("revenue for every month we have data for, most recent first").intent).toBe("bi-query");
    expect(routeIntent("automate the report every week").intent).toBe("script");
    expect(routeIntent("every morning, email the summary").intent).toBe("script");
  });

  it("a one-off phrase cancels an EXPLICIT script word and never a durable signal", () => {
    expect(routeIntent("just automate the totals right now").intent).not.toBe("script");
    expect(routeIntent("quickly automate this").intent).not.toBe("script");
    // The user said WHICH thing they want; but an event is not undone by "just".
    expect(routeIntent("when this button is clicked, just copy A1 to B1").intent).toBe("script");
  });

  it("beats format and data-op when the edit is ON an event", () => {
    expect(routeIntent("bold the header row every time new data is imported")).toMatchObject({ intent: "script", decisive: true });
    expect(routeIntent("make overdue rows red whenever the status column changes")).toMatchObject({ intent: "script", decisive: true });
    expect(routeIntent("add a button that formats the selection as currency")).toMatchObject({ intent: "script", decisive: true });
  });

  it("the substring traps stay closed", () => {
    for (const text of [
      "add a description to the chart",
      "put the subscription total in B4",
      "paste the transcript into column A",
      "format the prescription column as text",
      "chart the macroeconomic indicators by quarter",
    ]) {
      expect(routeIntent(text).intent, text).not.toBe("script");
    }
    // ...and the suppressor is a word too.
    expect(routeIntent("adjust the totals automatically whenever the source changes").intent).toBe("script");
    expect(routeIntent("readjust the column widths every time the data loads").intent).toBe("script");
  });
});

describe("bi-query: the message names the model's fields", () => {
  it("two business fields, or one plus a calendar grain, is a report", () => {
    expect(withModel("revenue by region")).toMatchObject({ intent: "bi-query", decisive: true });
    expect(withModel("revenue per year")).toMatchObject({ intent: "bi-query", decisive: true });
    expect(withModel("margin percentage by category, with the regions as columns")).toMatchObject({ intent: "bi-query", decisive: true });
  });

  it("reaches fields by plural and by everyday synonym", () => {
    expect(withModel("which three subcategories shift the most units")).toMatchObject({ intent: "bi-query", decisive: true });
    expect(withModel("sales by country")).toMatchObject({ intent: "bi-query", decisive: true });
    const named = fieldsNamed("turnover per client segment", STAR);
    expect(named.measures).toContain("turnover");
    expect(named.dimensions).toContain("segment");
  });

  it("a calendar word ALONE is a time expression, not a report", () => {
    const r = withModel("is this month better or worse than last month");
    expect(r.intent).toBe("analyze");
    expect(r.decisive).toBe(true);
  });

  it("a single business field with nothing else is a lean, never decisive", () => {
    const r = withModel("show me revenue");
    expect(r.intent).toBe("bi-query");
    expect(r.decisive).toBe(false);
  });

  it("bare statistics words do not steal a report for the formula rule", () => {
    expect(withModel("average sales amount per customer segment")).toMatchObject({ intent: "bi-query", decisive: true });
    expect(withModel("the average of the Amount column by product category")).toMatchObject({ intent: "bi-query", decisive: true });
  });

  it("a report is not one without a model to name — the same words are a lean elsewhere", () => {
    const r = routeIntent("revenue by region");
    expect(r.decisive).toBe(false);
  });

  it("a cell reference makes it a sheet request, not a report", () => {
    expect(withModel("put the revenue total in B4").intent).not.toBe("bi-query");
  });
});

describe("chart beats bi-query and analyze", () => {
  it("'line chart of revenue by month' is a chart", () => {
    expect(withModel("make a line chart of revenue by month")).toMatchObject({ intent: "chart", decisive: true });
  });
  it("'add a trendline to the sales chart' is a chart change, not an analysis", () => {
    expect(withModel("add a trendline to the sales chart")).toMatchObject({ intent: "chart", decisive: true });
  });
});

describe("formula versus data-op: the verb governs", () => {
  it("asking FOR a formula is a formula, even with a write verb and a cell", () => {
    expect(routeIntent("write a formula to look up the price for the product in A2")).toMatchObject({ intent: "formula", decisive: true });
    expect(routeIntent("what formula gives the average of column D ignoring blanks")).toMatchObject({ intent: "formula", decisive: true });
    expect(routeIntent("why does C7 show #DIV/0!")).toMatchObject({ intent: "formula", decisive: true });
  });
  it("COPYING a formula is a copy", () => {
    const r = routeIntent("Read the formula in C10 and copy the same formula into C11.");
    expect(r.intent).toBe("data-op");
  });
});

describe("data-op: a write verb with a target", () => {
  for (const text of [
    "Set cell A1 to Hello. Do it the simplest way.",
    "put the subscription total in B4",
    "delete the empty rows between 40 and 60",
    "split column A into first and last name",
    "remove duplicate rows keeping the first",
    "Write today's date into A1.",
  ]) {
    it(text, () => {
      expect(routeIntent(text).intent).toBe("data-op");
    });
  }

  it("an edit with a CELL target outranks a trailing formatting word", () => {
    const r = routeIntent("Build a small summary: put a Totals header in A1, sum column C into B1, and bold both.");
    expect(r.intent).toBe("data-op");
  });

  it("but appearance with no write verb is format", () => {
    expect(routeIntent("make A1:D1 bold")).toMatchObject({ intent: "format", decisive: true });
    expect(routeIntent("colour any cell over 100 red").intent).toBe("format");
    expect(routeIntent("format the prescription column as text")).toMatchObject({ intent: "format", decisive: true });
  });
});

describe("analyze and question", () => {
  it("analysis vocabulary routes to analyze", () => {
    for (const text of ["analyse this data", "anything unusual in this range?", "are there any outliers in column C", "explain these numbers to me"]) {
      expect(routeIntent(text).intent, text).toBe("analyze");
    }
  });
  it("a question about the product is a lean, never decisive", () => {
    for (const text of ["what does a pivot table do", "can Calcula open an Excel file", "how do I share this workbook with my team"]) {
      const r = routeIntent(text);
      expect(r.intent, text).toBe("question");
      expect(r.decisive).toBe(false);
    }
  });
  it("a formula word vetoes analysis, as the old detector did", () => {
    expect(routeIntent("explain the formula in C10").intent).toBe("formula");
  });

  // THE TIER-0 PRE-ROUTE CONTRACT, carried over from `analysisIntent.ts` when
  // that detector was deleted (2026-09-16). ChatView computes the facts BEFORE
  // the model sees an `analyze` message, so the centre of this class must be
  // solid: every English case the old detector fired on still routes here,
  // and everything it stayed quiet for still goes elsewhere. The old Swedish
  // cases ("analysera markeringen") are NOT carried: the programme is
  // English-only by owner decision, and a missed pre-route costs nothing new
  // — the model keeps analyze_range as a tool.
  it("computes the facts first for every English case the old detector fired on", () => {
    for (const text of [
      "what is going on in this data?",
      "What's going on with revenue?",
      "analyse the selection",
      "analyze this range for me",
      "are there any outliers in column C?",
      "is there a trend here",
      "summarise the data in B2:D40",
      "explain these numbers",
      "what stands out in this table?",
      "anything interesting in the sales figures?",
      "give me some insights",
      "is revenue seasonal?",
      "ANALYSE THIS",
    ]) {
      expect(routeIntent(text), text).toMatchObject({ intent: "analyze", decisive: true });
    }
  });
  it("stays out of the way for everything the old detector stayed quiet on", () => {
    for (const text of [
      "what is in A1 to C3?",
      "sum column B",
      "make A1:A3 yellow",
      "which charts are there?",
      "delete the empty rows",
      "create a script that colours each cell by its value",
      "write a macro to total the columns",
      // The word must be a word: "trendy" is not "trend", and a product called
      // "Insightful" is not a request for insights.
      "rename the sheet to Trendy Products",
      "set B2 to Insightful",
      "",
    ]) {
      expect(routeIntent(text).intent, text).not.toBe("analyze");
    }
    // The old "defer to the formula assistant" veto had no destination; the
    // formula it deferred to now IS the route.
    expect(routeIntent("give me a formula for the trend in column B")).toMatchObject({ intent: "formula", decisive: true });
  });
});

describe("two strong classes: ask, never guess", () => {
  it("genuinely two requests produce a clarify pair and no decision", () => {
    const r = withModel("analyse the sales and then automate the report every week");
    expect(r.decisive).toBe(false);
    expect(r.intent).toBe("unclear");
    expect(r.clarify).toBeDefined();
    expect(r.clarify).toContain("script");
    expect(r.clarify).toContain("analyze");
    expect(describeRoute(r)).toMatch(/either .* or .*/);
  });
  it("an explicit macro that also mentions analysis is the macro", () => {
    expect(routeIntent("write a macro that flags outliers every month")).toMatchObject({ intent: "script", decisive: true });
  });
});

describe("unclear is the fallback, with no vocabulary of its own", () => {
  for (const text of ["fix this", "can you help", "do the thing we discussed"]) {
    it(text, () => {
      const r = routeIntent(text);
      expect(r.intent).toBe("unclear");
      expect(r.decisive).toBe(false);
      expect(r.clarify).toBeUndefined();
    });
  }
  it("says nothing in the transcript for a lean or an unclear", () => {
    expect(describeRoute(routeIntent("fix this"))).toBeNull();
    expect(describeRoute(routeIntent("what does a pivot table do"))).toBeNull();
    expect(describeRoute(routeIntent("make A1:D1 bold"))).toMatch(/^Routed as format/);
  });
});

describe("object type rides along for the offer card and the API surface", () => {
  it("names the object a script attaches to", () => {
    expect(routeIntent("I want a button that refreshes the sales block").objectType).toBe("button");
    expect(routeIntent("when this cell changes, recalculate the total").objectType).toBe("cell");
    expect(routeIntent("create a script that colours cells").objectType).toBeNull();
  });
});
