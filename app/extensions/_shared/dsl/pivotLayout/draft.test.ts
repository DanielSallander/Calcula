//! FILENAME: app/extensions/_shared/dsl/pivotLayout/draft.test.ts
// PURPOSE: The drafting loop's ORDER and DECISIONS, driven with the real
//          compiler over the fixture model and a fake model reply.
// CONTEXT: What breaks in a loop like this is never the arithmetic, it is the
//          sequence: compile before dry run, repair once with the compiler's
//          own words, stop on a repeated answer, decline a reply with no query,
//          send a grammar only where it is honoured and never a schema with it.

import { describe, it, expect, vi } from "vitest";
import * as fs from "fs";
import * as path from "path";
import type { AiCompletionProvider, AiCompletionRequest } from "@api/aiCompletionService";
import { draftDesignQuery } from "./draft";
import { compileDesignQuery } from "./designQuery";
import type { BiPivotModelInfo } from "../../components/types";
import { modelInfoFromFixture, strategySummaryFromFixture } from "../../../../../tests/eval/lib/modelFixture.mjs";

const REPO = path.resolve(__dirname, "../../../../..");
const read = (rel: string) => JSON.parse(fs.readFileSync(path.join(REPO, rel), "utf8"));
const bundle = read("tests/fixtures/model/sales_star.json");
const strategyDoc = read("tests/fixtures/model/sales_star_strategy.json");
const model: BiPivotModelInfo = {
  ...modelInfoFromFixture(bundle),
  strategy: strategySummaryFromFixture(strategyDoc, bundle),
};

/** A provider that answers from a queue, recording every request. */
function provider(replies: string[], opts: { grammar?: boolean } = {}) {
  const requests: AiCompletionRequest[] = [];
  const p: AiCompletionProvider = {
    isConfigured: () => true,
    modelLabel: () => "fake-1.5b",
    isLocal: () => true,
    honorsSchema: () => true,
    honorsGrammar: () => opts.grammar ?? false,
    complete: vi.fn(async (req: AiCompletionRequest) => {
      requests.push(req);
      const text = replies.shift() ?? "";
      return { text, truncated: false, model: "fake-1.5b", durationMs: 1 };
    }),
  };
  return { p, requests };
}

const compile = (dsl: string) => compileDesignQuery(dsl, "fixture", model);
const json = (dsl: string) => JSON.stringify({ dsl, explanation: "x" });

describe("draftDesignQuery", () => {
  it("compiles a good first answer, runs it, and reports both", async () => {
    const { p, requests } = provider([json("ROWS: Product.Category\nVALUES: [Revenue]")]);
    const dryRun = vi.fn(async () => ({ rowCount: 4, colCount: 2 }));
    const phases: string[] = [];

    const draft = await draftDesignQuery("revenue by category", model, {
      provider: p, compile, dryRun, onPhase: (ph) => phases.push(ph.kind),
    });

    expect(draft.status).toBe("compiled");
    expect(draft.dsl).toBe("ROWS: Product.Category\nVALUES: [Revenue]");
    expect(draft.request?.rowFields).toEqual([{ table: "Product", column: "Category", isLookup: undefined }]);
    expect(dryRun).toHaveBeenCalledWith(draft.request);
    expect(draft.dryRun).toEqual({ rowCount: 4, colCount: 2 });
    expect(draft.rounds).toBe(1);
    expect(draft.summary).toContain("Compiled by Calcula");
    expect(draft.summary).toContain("4 rows × 2 columns");
    expect(phases).toEqual(["asking", "compiling", "running"]);
    // The prompt carried the candidate names and the schema, not a grammar.
    expect(requests[0].messages[0].text).toContain("[Revenue]");
    expect(requests[0].responseSchema?.name).toBe("calcula_design_query");
    expect(requests[0].grammar).toBeUndefined();
    expect(requests[0].temperature).toBe(0);
  });

  it("sends the compiler's findings back once, and accepts the corrected query", async () => {
    const { p, requests } = provider([
      json("ROWS: Product.Colour\nVALUES: [Revenue]"),
      json("ROWS: Product.Category\nVALUES: [Revenue]"),
    ]);

    const draft = await draftDesignQuery("revenue by category", model, { provider: p, compile });

    expect(draft.status).toBe("compiled");
    expect(draft.rounds).toBe(2);
    expect(draft.summary).toContain("after 2 tries");
    // The repair turn is APPENDED: the first message is untouched, then the
    // model's reply, then the findings quoting the query and the compiler.
    const second = requests[1].messages;
    expect(second).toHaveLength(3);
    expect(second[0]).toEqual(requests[0].messages[0]);
    expect(second[1].role).toBe("assistant");
    expect(second[2].text).toContain("ROWS: Product.Colour");
    expect(second[2].text).toMatch(/Unknown|not found|Colour/i);
  });

  it("stops on a byte-identical repair rather than compiling it again", async () => {
    const bad = json("ROWS: Product.Colour\nVALUES: [Revenue]");
    const { p } = provider([bad, bad]);
    const compileSpy = vi.fn(compile);

    const draft = await draftDesignQuery("revenue by category", model, { provider: p, compile: compileSpy });

    expect(draft.status).toBe("invalid");
    expect(draft.rounds).toBe(2);
    expect(compileSpy).toHaveBeenCalledTimes(1);
    expect(draft.dsl).toBe("ROWS: Product.Colour\nVALUES: [Revenue]");
    expect(draft.errors.length).toBeGreaterThan(0);
    expect(draft.summary).toContain("could not compile");
  });

  it("is invalid, with the text kept, when the repair budget is spent", async () => {
    const { p } = provider([
      json("ROWS: Product.Colour\nVALUES: [Revenue]"),
      json("ROWS: Product.Hue\nVALUES: [Revenue]"),
    ]);
    const draft = await draftDesignQuery("revenue by category", model, { provider: p, compile });
    expect(draft.status).toBe("invalid");
    expect(draft.dsl).toBe("ROWS: Product.Hue\nVALUES: [Revenue]");
    expect(draft.request).toBeNull();
  });

  it("declines a reply with no query in it, and offers nothing", async () => {
    const { p } = provider(["I am not able to help with that."]);
    const dryRun = vi.fn();
    const draft = await draftDesignQuery("revenue by category", model, { provider: p, compile, dryRun });
    expect(draft.status).toBe("declined");
    expect(draft.dsl).toBe("");
    expect(dryRun).not.toHaveBeenCalled();
    expect(draft.summary).toContain("did not answer with a query");
  });

  it("sends a grammar and no schema where the runtime honours one, and reads the bare query back", async () => {
    const { p, requests } = provider(["ROWS: Geography.Region\nVALUES: [Revenue]\n"], { grammar: true });
    const draft = await draftDesignQuery("revenue by region", model, { provider: p, compile });
    expect(draft.status).toBe("compiled");
    expect(draft.grammarUsed).toBe(true);
    expect(requests[0].grammar).toContain('"Geography.Region"');
    expect(requests[0].responseSchema).toBeUndefined();
  });

  it("treats a refused dry run as an answer, not a failure", async () => {
    const { p } = provider([json("ROWS: Product.Category\nVALUES: [Revenue]")]);
    const dryRun = vi.fn(async () => {
      throw new Error("Calculation groups aren't supported in design queries yet.");
    });
    const draft = await draftDesignQuery("revenue by category", model, { provider: p, compile, dryRun });
    expect(draft.status).toBe("compiled");
    expect(draft.dryRun).toEqual({ error: "Calculation groups aren't supported in design queries yet." });
    expect(draft.summary).toContain("running it was refused");
  });

  it("propagates a transport failure rather than presenting it as a result", async () => {
    const p: AiCompletionProvider = {
      isConfigured: () => true, modelLabel: () => "m", isLocal: () => true,
      honorsSchema: () => true, honorsGrammar: () => false,
      complete: async () => { throw new Error("Could not reach Ollama"); },
    };
    await expect(draftDesignQuery("x", model, { provider: p, compile })).rejects.toThrow("Could not reach Ollama");
  });
});
