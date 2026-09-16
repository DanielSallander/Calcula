//! FILENAME: app/extensions/AIChat/__tests__/intentRouter.corpus.test.ts
// PURPOSE: The intent router routes the WHOLE corpus in CI, and one decisive
//          miss fails the build.
// CONTEXT: docs/design/ai-intent-router.md pins two numbers: rules-only >= 80 %
//          and 100 % precision on the decisive subset. The second is the one
//          that matters — a decisive wrong route is the apply-formatting-over-
//          the-wrong-range failure, and it is silent — so it is asserted over
//          EVERY row here rather than reported by the runner.
//
//          THE SPLIT IS THE RUNNER'S SPLIT, imported rather than copied, so this
//          test and `run-intent-eval.mjs --router` cannot disagree about which
//          rows were held out. The held-out half is where the recall floor is
//          asserted, because the rules were tuned against the other half and a
//          floor on the tuned half would be a floor on memorisation.
//
//          Measured 2026-09-16 when this gate was written: all 214 — macro 98.9 %,
//          decisive precision 100 % (0 wrong of 201 decided); held-out 96 — macro
//          97.8 %, 95/96. The floors below leave room for a rule to be REMOVED
//          when a better one arrives without failing the build; they are not
//          the measured values.

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { buildModelFieldIndex } from "@api";
import { routeIntent, INTENTS, type Intent } from "../lib/intentRouter";
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore -- plain ESM eval module, no type declarations by design
import { splitOf } from "../../../../tests/eval/run-intent-eval-split.mjs";

const repo = join(process.cwd(), "..");
const corpus = JSON.parse(readFileSync(join(repo, "tests/eval/intents.json"), "utf8")) as {
  utterances: Array<{ id: string; text: string; intent: Intent; decisive: boolean; why: string }>;
};
const fixture = JSON.parse(readFileSync(join(repo, "tests/fixtures/model/sales_star.json"), "utf8"));
const fields = buildModelFieldIndex([fixture.model ?? fixture]);

interface Row {
  id: string;
  split: "tune" | "held-out";
  expected: Intent;
  expectedDecisive: boolean;
  got: Intent;
  decisive: boolean;
  clarify?: [Intent, Intent];
  why: string;
  correct: boolean;
}

const rows: Row[] = corpus.utterances.map((u) => {
  const r = routeIntent(u.text, { fields });
  // A clarify pair containing the expected intent is the designed answer for a
  // NON-decisive utterance ("genuinely two requests; the design says ask").
  const clarifyCredit = Boolean(r.clarify && !u.decisive && r.clarify.includes(u.intent));
  return {
    id: u.id,
    split: splitOf(u.id),
    expected: u.intent,
    expectedDecisive: u.decisive,
    got: r.intent,
    decisive: r.decisive,
    clarify: r.clarify,
    why: r.matched.join(" | "),
    correct: r.intent === u.intent || clarifyCredit,
  };
});

const describeRow = (r: Row) =>
  `${r.id} [${r.split}] wanted ${r.expected}, got ${r.clarify ? `ask(${r.clarify.join("/")})` : r.got}${r.decisive ? " DECISIVELY" : ""} — ${r.why}`;

describe("the intent router over the whole corpus", () => {
  it("routes a corpus of the size the design asked for", () => {
    expect(corpus.utterances.length).toBeGreaterThanOrEqual(120);
    expect(rows.filter((r) => r.split === "held-out").length).toBeGreaterThanOrEqual(60);
  });

  it("NEVER decides wrongly — 100 % precision on every decision, every split", () => {
    // The contract. Not a floor, not a rate: zero. A rule that fires must be right.
    const wrong = rows.filter((r) => r.decisive && r.got !== r.expected);
    expect(wrong.map(describeRow)).toEqual([]);
  });

  it("never offers a script for something that is not one", () => {
    // The expensive false positive: an offer card and a ~6,000-token API surface.
    const falseScript = rows.filter((r) => r.got === "script" && r.expected !== "script");
    expect(falseScript.map(describeRow)).toEqual([]);
  });

  it("clears the design's recall target on the HELD-OUT half, macro-averaged", () => {
    const held = rows.filter((r) => r.split === "held-out");
    const present = INTENTS.filter((i) => held.some((r) => r.expected === i));
    const macro =
      present.reduce((acc, i) => {
        const of = held.filter((r) => r.expected === i);
        return acc + of.filter((r) => r.correct).length / of.length;
      }, 0) / present.length;
    // The design says 0.80. Measured 0.978 when written; the floor sits between
    // so a rule can be simplified without a red and a real regression cannot hide.
    expect(macro, `held-out macro recall ${(macro * 100).toFixed(1)}%`).toBeGreaterThanOrEqual(0.9);
  });

  it("routes every known-defect regression case correctly", () => {
    const wrong = rows.filter((r) => r.id.startsWith("rg-") && !r.correct);
    expect(wrong.map(describeRow)).toEqual([]);
  });

  it("reaches every intent — none is unreachable by construction any more", () => {
    // The two detectors it replaced could express three of nine.
    const reached = new Set(rows.filter((r) => r.correct).map((r) => r.expected));
    expect([...INTENTS].filter((i) => !reached.has(i))).toEqual([]);
  });

  it("only ever asks when two STRONG classes genuinely survive", () => {
    // A clarify on a row the corpus marks decisive means a rule failed to
    // settle something the design says rules settle. Reported, and capped.
    const askedOnDecisive = rows.filter((r) => r.clarify && r.expectedDecisive);
    expect(askedOnDecisive.length, askedOnDecisive.map(describeRow).join("\n")).toBeLessThanOrEqual(2);
  });
});
