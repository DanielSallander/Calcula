//! FILENAME: app/src/api/scriptHost/generated/__tests__/canaryTasks.test.ts
// PURPOSE: The in-app probe's tasks and the CI corpus must be the SAME tasks.
// CONTEXT: Owner decision §11.3 — "both read the same task definitions, so the
//          number a user sees in the picker and the number CI reports cannot
//          diverge." The corpus lives outside `app/` and cannot be imported by
//          Vite, so the subset is generated in; this is what makes "generated
//          from" a fact rather than a comment.

import { describe, it, expect } from "vitest";
import * as fs from "fs";
import * as path from "path";
import { CANARY_TASKS } from "../canaryTasks";
// The GENERATOR's own renderer, so the check cannot drift from what `npm run
// gen:canary-tasks` actually writes.
import { renderCanaryModule } from "../../../../../scripts/gen-canary-tasks.mjs";

// __tests__ -> generated -> scriptHost -> api -> src -> app -> repo root.
const REPO = path.resolve(__dirname, "../../../../../..");
const CORPUS_PATH = path.join(REPO, "tests/eval/tasks.json");
const GENERATED_PATH = path.resolve(__dirname, "../canaryTasks.ts");

const corpus = JSON.parse(fs.readFileSync(CORPUS_PATH, "utf8"));

describe("the canary subset is generated from the corpus", () => {
  it("matches the committed canaryTasks.ts byte for byte", () => {
    expect(
      fs.readFileSync(GENERATED_PATH, "utf8") === renderCanaryModule(corpus),
      "src/api/scriptHost/generated/canaryTasks.ts is stale — run `npm run gen:canary-tasks`.",
    ).toBe(true);
  });

  it("holds exactly the tasks the corpus marks as canaries", () => {
    const fromCorpus = corpus.tasks
      .filter((t: { canary: boolean }) => t.canary)
      .map((t: { id: string }) => t.id)
      .sort();
    expect(CANARY_TASKS.map((t) => t.id).sort()).toEqual(fromCorpus);
  });

  it("carries no reference solutions into the renderer bundle", () => {
    // The probe scores a MODEL's answer. Shipping the answers beside the
    // questions is dead weight, and it puts them in the same process as the
    // thing being measured.
    //
    // Asserted on the DATA, not on the file text: the banner explains that
    // references are stripped, so the word "reference" legitimately appears in
    // the comment and a substring check on the whole file fails on its own
    // documentation.
    for (const t of CANARY_TASKS) {
      expect(Object.keys(t), `${t.id} carries extra fields`).toEqual(
        expect.not.arrayContaining(["reference"]),
      );
    }
    const data = fs.readFileSync(GENERATED_PATH, "utf8");
    const arrayBody = data.slice(data.indexOf("CANARY_TASKS"));
    expect(arrayBody).not.toContain("export function setup");
    expect(arrayBody).not.toContain("@capability");
  });

  it("keeps every field the probe actually needs", () => {
    for (const t of CANARY_TASKS) {
      expect(t.id, "id").toBeTruthy();
      expect(t.objectType, `${t.id} objectType`).toBeTruthy();
      expect(t.intent.length, `${t.id} intent`).toBeGreaterThan(15);
      expect(t.hints.length, `${t.id} hints`).toBeGreaterThan(0);
      expect(t.mustCall.length, `${t.id} mustCall`).toBeGreaterThan(0);
    }
  });

  it("is small enough to run in a couple of minutes, and big enough to mean something", () => {
    expect(CANARY_TASKS.length).toBeGreaterThanOrEqual(8);
    expect(CANARY_TASKS.length).toBeLessThanOrEqual(16);
    expect(CANARY_TASKS.length).toBeLessThan(corpus.tasks.length);
  });
});
