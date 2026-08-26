//! FILENAME: app/src/api/scriptHost/scriptEval/__tests__/corpus.test.ts
// PURPOSE: LAYER A of the eval — prove the corpus itself is sound, with no model
//          involved. Every reference solution must pass the real validator, and
//          must require exactly the capabilities its task claims.
// CONTEXT: docs/design/local-model-script-authoring.md M5.
//
//          THIS IS THE HALF THAT KEEPS THE CORPUS HONEST. A task whose reference
//          does not validate is not a hard task — it is a broken one, and it
//          would mark every model wrong for refusing to reproduce a mistake.
//          Because the reference is checked against the LIVE surface, a task
//          also rots the moment the API moves underneath it, which is exactly
//          when someone needs to be told.
//
//          Layer B (scoring a real model) lives in tests/eval/run-eval.mjs and
//          is opt-in: it needs a provider and costs tokens.

import { describe, it, expect } from "vitest";
import * as fs from "fs";
import * as path from "path";
import {
  referenceSource,
  scoreCandidate,
  gradeOutcome,
  extractScript,
  summarize,
  type EvalCorpus,
  type EvalTask,
  type OutcomeGrade,
} from "../index";
import { runTaskOutcome } from "../harness";
import { validateScriptSource, analyzeScript } from "../index";
import { buildSurfacePrompt, SURFACE_ENTRIES } from "../../scriptPrompt";

// __tests__ -> scriptEval -> scriptHost -> api -> src -> app -> repo root.
const REPO = path.resolve(__dirname, "../../../../../..");
const CORPUS_PATH = path.join(REPO, "tests/eval/tasks.json");

const corpus: EvalCorpus = JSON.parse(fs.readFileSync(CORPUS_PATH, "utf8"));
const tasks: EvalTask[] = corpus.tasks;

/** Object types `drafts.rs` will accept — Rust is the authority (M1's guard). */
const DRAFTS_RS = path.join(REPO, "app/src-tauri/src/mcp/drafts.rs");
function rustObjectTypes(): string[] {
  const src = fs.readFileSync(DRAFTS_RS, "utf8");
  const marker = "const VALID_OBJECT_TYPES: &[&str] = &[";
  const body = src.slice(src.indexOf(marker) + marker.length);
  return [...body.slice(0, body.indexOf("];")).matchAll(/"([A-Za-z]+)"/g)].map((m) => m[1]);
}

describe("the corpus is well formed", () => {
  it("has enough tasks to mean something", () => {
    // The design called for 30-50. Fewer than 30 and one lucky guess moves the
    // score too far to publish.
    expect(tasks.length).toBeGreaterThanOrEqual(30);
  });

  it("has unique ids", () => {
    const ids = tasks.map((t) => t.id);
    expect(new Set(ids).size, `duplicate task ids: ${ids.filter((v, i) => ids.indexOf(v) !== i)}`).toBe(ids.length);
  });

  it("targets only object types a draft can actually be saved as", () => {
    const valid = new Set(rustObjectTypes());
    expect(valid.size).toBeGreaterThan(10);
    for (const t of tasks) {
      expect(valid.has(t.objectType), `${t.id} targets "${t.objectType}", which drafts.rs rejects`).toBe(true);
    }
  });

  it("gives every task an intent, hints and at least one required call", () => {
    for (const t of tasks) {
      expect(t.intent.length, `${t.id} has no intent`).toBeGreaterThan(15);
      expect(t.hints.length, `${t.id} has no hints`).toBeGreaterThan(0);
      expect(t.mustCall.length, `${t.id} asserts no behaviour at all`).toBeGreaterThan(0);
      expect(t.reference.length, `${t.id} has no reference solution`).toBeGreaterThan(2);
    }
  });

  it("marks a canary subset that is real and proper", () => {
    const canaries = tasks.filter((t) => t.canary);
    // M7 runs these in-app in about two minutes; too few says nothing, and all
    // of them is not a subset.
    expect(canaries.length).toBeGreaterThanOrEqual(8);
    expect(canaries.length).toBeLessThan(tasks.length);
  });

  it("keeps a canary subset that still spans the failure modes it is meant to detect", () => {
    // A canary set of ten easy grid tasks would score every model 10/10 and tell
    // the user nothing. It has to include the cases that actually separate them.
    const canaries = tasks.filter((t) => t.canary);
    expect(canaries.some((t) => t.expectCapabilities.length > 0), "no capability task").toBe(true);
    expect(canaries.some((t) => t.expectCapabilities.length === 0), "no plain grid task").toBe(true);
    expect(canaries.some((t) => t.id.startsWith("trap-")), "no hallucination trap").toBe(true);
  });
});

describe("every reference solution really works", () => {
  it.each(tasks.map((t) => [t.id, t] as const))("%s validates cleanly", (_id, task) => {
    // Against the surface THIS task's object type can reach. Unnarrowed, a
    // reference calling a member that exists somewhere in the API but not on the
    // context it is attached to would pass Layer A and be dead at run time.
    const report = validateScriptSource(referenceSource(task), task.objectType);
    const errors = report.findings.filter((f) => f.severity === "error");
    expect(
      errors,
      `${task.id}'s reference solution does not pass the validator:\n` +
        errors.map((e) => `  - [${e.code}] ${e.message}`).join("\n") +
        "\n\nA task whose own answer is wrong marks every model wrong for refusing to reproduce it.",
    ).toEqual([]);
  });

  it.each(tasks.map((t) => [t.id, t] as const))("%s requires exactly the capabilities it claims", (_id, task) => {
    const report = validateScriptSource(referenceSource(task), task.objectType);
    expect(
      [...report.observed].sort(),
      `${task.id} claims ${JSON.stringify(task.expectCapabilities)} but its reference is observed to need ` +
        `${JSON.stringify(report.observed)}`,
    ).toEqual([...task.expectCapabilities].sort());
  });

  it.each(tasks.map((t) => [t.id, t] as const))("%s scores its own reference as a pass", (_id, task) => {
    const score = scoreCandidate(task, referenceSource(task));
    expect(
      score.passed,
      `${task.id}: ${JSON.stringify({ missing: score.missingCalls, invented: score.inventedMethods })}`,
    ).toBe(true);
    expect(score.score).toBe(1);
  });
});

describe("the scorer separates good answers from bad ones", () => {
  const task = tasks.find((t) => t.id === "cap-storage-counter")!;

  it("gives a perfect score only to a working answer", () => {
    expect(scoreCandidate(task, referenceSource(task)).score).toBe(1);
  });

  it("punishes an invented method hardest", () => {
    const invented = referenceSource(task).replace("context.api.setCellValue", "context.api.setCellVal");
    const s = scoreCandidate(task, invented);
    expect(s.reachClean).toBe(false);
    expect(s.inventedMethods.length).toBeGreaterThan(0);
    expect(s.score).toBeLessThan(0.75);
  });

  it("punishes a missing capability pragma", () => {
    const undeclared = referenceSource(task).replace("// @capability storage\n", "");
    const s = scoreCandidate(task, undeclared);
    expect(s.capabilitiesDeclared).toBe(false);
    expect(s.passed).toBe(false);
  });

  it("marks an over-declared script down, but not as far", () => {
    // §11.2: over-declaring produces a reviewer notice, which is the system
    // working. It must cost less than inventing an API or forgetting a pragma.
    const over = "// @capability net.fetch\n" + referenceSource(task);
    const s = scoreCandidate(task, over);
    expect(s.capabilitiesExact).toBe(false);
    expect(s.capabilitiesDeclared).toBe(true);
    expect(s.passed).toBe(false);
    const invented = scoreCandidate(
      task,
      referenceSource(task).replace("context.api.setCellValue", "context.api.setCellVal"),
    );
    expect(s.score).toBeGreaterThan(invented.score);
  });

  it("fails a script that validates but does nothing", () => {
    // The reason `mustCall` exists: an empty setup passes L0, L1 and L2.
    const empty = "export function setup(context) {}\n";
    const s = scoreCandidate(task, empty);
    expect(s.reachClean, "an empty script invents nothing").toBe(true);
    expect(s.behavioural, "but it does not do the job").toBe(false);
    expect(s.passed).toBe(false);
  });

  it("fails a script that does not parse", () => {
    const s = scoreCandidate(task, "export function setup(context) {\n");
    expect(s.parsed).toBe(false);
    expect(s.score).toBeLessThan(0.2);
  });
});

describe("extracting a script from a model reply", () => {
  it("takes the fenced block and drops the chatter around it", () => {
    const reply = "Sure! Here you go:\n\n```js\nexport function setup(context) {}\n```\n\nHope that helps.";
    expect(extractScript(reply)).toBe("export function setup(context) {}\n");
  });

  it("handles an unlabelled fence and a ts label", () => {
    expect(extractScript("```\nconst a = 1;\n```")).toBe("const a = 1;\n");
    expect(extractScript("```typescript\nconst a = 1;\n```")).toBe("const a = 1;\n");
  });

  it("takes a bare reply verbatim, because some models answer with plain code", () => {
    expect(extractScript("export function setup(context) {}")).toBe("export function setup(context) {}\n");
  });
});

describe("the corpus is answerable within a small model's budget", () => {
  it.each(tasks.filter((t) => t.canary).map((t) => [t.id, t] as const))(
    "%s can see every method its reference needs at a 4k surface budget",
    (_id, task) => {
      // The point of M4's hints. If a canary task's required methods do not
      // survive the budget, the eval is measuring the prompt builder rather than
      // the model — and a user on an 8k model would be scored on an impossible
      // task.
      const prompt = buildSurfacePrompt({
        objectType: task.objectType,
        budgetTokens: 4000,
        hints: [...task.hints, task.intent],
      });
      // A mustCall entry may name alternatives ("a|b") — the prompt is
      // sufficient when ANY of them survives the budget.
      const missing = task.mustCall.filter(
        (spec) => !spec.split("|").some((c) => prompt.includedChains.includes(c)),
      );
      expect(
        missing,
        `${task.id}: the prompt at 4k tokens omits ${JSON.stringify(missing)}, so no model could answer it`,
      ).toEqual([]);
    },
  );

  // The GRADED slice is held to a stronger bar at BOTH working budgets: every
  // chain the reference actually CALLS must survive, not just mustCall. A
  // graded task whose reference-called member fell out of the prompt scores a
  // model on outcomes it was never shown the tools for — measured live before
  // this guard: api.setCellValue absent from grid-sum-in-script's prompt at
  // the runner's default 8k budget while every sibling setter was included.
  const gradable = tasks.filter((t) => t.outcome);
  const surfaceChains = new Set(SURFACE_ENTRIES.map((e) => e.chain));
  it.each(
    gradable.flatMap((t) => [4000, 8000].map((budget) => [`${t.id} @ ${budget}`, t, budget] as const)),
  )("%s: every chain the reference calls survives the budget", (_label, task, budget) => {
    const prompt = buildSurfacePrompt({
      objectType: task.objectType,
      budgetTokens: budget,
      hints: [...task.hints, task.intent],
    });
    const called = [
      ...new Set(analyzeScript(referenceSource(task)).calls.map((c) => c.chain)),
    ].filter((c) => surfaceChains.has(c));
    const missing = called.filter((c) => !prompt.includedChains.includes(c));
    expect(
      missing,
      `${task.id}: the prompt at ${budget} tokens omits ${JSON.stringify(missing)} — a graded task ` +
        `whose reference cannot be written from its own prompt grades the prompt, not the model`,
    ).toEqual([]);
  });
});

describe("expected-diff grading — the corpus half of L3", () => {
  const gradable = tasks.filter((t) => t.outcome);

  it("keeps enough gradable tasks to mean something", () => {
    // Below this the grade is decoration: a model could ace the graded slice
    // by luck while failing the class the corpus exists to measure.
    expect(gradable.length).toBeGreaterThanOrEqual(15);
    expect(gradable.filter((t) => t.canary).length).toBeGreaterThanOrEqual(8);
  });

  it("every outcome spec is well formed", () => {
    for (const t of gradable) {
      const o = t.outcome!;
      expect(o.event.length, `${t.id} names no event`).toBeGreaterThan(0);
      const checks =
        (o.expect?.length ?? 0) + (o.expectOutput?.length ?? 0) + (o.matchOutput?.length ?? 0);
      expect(checks, `${t.id} carries an outcome that grades nothing`).toBeGreaterThan(0);
      for (const e of o.expect ?? []) {
        const forms = [e.value !== undefined, e.match !== undefined].filter(Boolean).length;
        expect(forms, `${t.id} R${e.row + 1}C${e.col + 1}: exactly one of value/match`).toBe(1);
        if (e.match !== undefined) {
          expect(() => new RegExp(e.match!, "i"), `${t.id}: invalid match regex`).not.toThrow();
        }
      }
      for (const p of o.matchOutput ?? []) {
        expect(() => new RegExp(p, "i"), `${t.id}: invalid matchOutput regex`).not.toThrow();
      }
      if (o.eventCount !== undefined) {
        expect(o.eventCount, `${t.id}: eventCount must be a small positive integer`).toBeGreaterThan(0);
        expect(Number.isInteger(o.eventCount)).toBe(true);
      }
    }
  });

  // THE HONESTY ANCHOR. The harness serves a fake backend behind the real
  // surface; the only proof its semantics match the product's is that every
  // reference — code that is known to do the job — grades perfectly through
  // it. A reference below 1.0 means the harness or the expectation is wrong,
  // never the model, and this is the test that says so before any model runs.
  it.each(gradable.map((t) => [t.id, t] as const))(
    "%s's reference solution grades 1.0 through the harness",
    async (_id, task) => {
      const obs = await runTaskOutcome(task, referenceSource(task));
      expect(obs.harnessGap, `harness gap on the REFERENCE: ${obs.harnessGap}`).toBeUndefined();
      const grade = gradeOutcome(task.outcome!, obs);
      expect(grade.ran, `reference did not run: ${obs.error}`).toBe(true);
      expect(
        grade.grade,
        `${task.id}: ${JSON.stringify({ wrong: grade.wrongCells, missingOutput: grade.missingOutput, output: obs.output })}`,
      ).toBe(1);
      // And the combined score keeps the reference at a perfect pass.
      const score = scoreCandidate(task, referenceSource(task), grade);
      expect(score.graded).toBe(true);
      expect(score.score).toBe(1);
      expect(score.passed).toBe(true);
    },
  );

  it("a script that writes the WRONG value is caught by the grade and by nothing else", async () => {
    // The measured six-in-eleven class: parses, invents nothing, declares
    // correctly, calls every required chain — and does the wrong thing.
    const task = gradable.find((t) => t.id === "grid-read-write-cell")!;
    const wrong = referenceSource(task).replace(
      "context.api.setCellValue(0, 1, value);",
      "context.api.setCellValue(0, 1, 'oops');",
    );
    expect(scoreCandidate(task, wrong).passed, "statically invisible — that is the point").toBe(true);
    const grade = gradeOutcome(task.outcome!, await runTaskOutcome(task, wrong));
    expect(grade.ran).toBe(true);
    expect(grade.grade).toBeLessThan(1);
    expect(grade.wrongCells).toEqual([{ row: 0, col: 1, expected: "42", actual: "oops" }]);
    const score = scoreCandidate(task, wrong, grade);
    expect(score.passed).toBe(false);
    expect(score.score).toBeLessThan(scoreCandidate(task, referenceSource(task), grade && { ...grade, grade: 1, wrongCells: [] }).score);
  });

  it("the dead shape — expose('onClick') — grades zero, exactly as the product behaves", async () => {
    // The corpus itself shipped teaching this shape. A click fires the onClick
    // HOOK; an exposed method named "onClick" never hears it, and the product's
    // own click path diagnoses it as "never registered a click handler".
    const task = gradable.find((t) => t.id === "trap-vba-cells-idiom")!;
    const dead = referenceSource(task).replace("context.onClick(", "context.expose('onClick', ");
    const obs = await runTaskOutcome(task, dead);
    expect(obs.ran).toBe(false);
    expect(obs.error).toMatch(/expose/);
    expect(gradeOutcome(task.outcome!, obs).grade).toBe(0);
  });

  it("a throwing handler is a failed run, not a clean one", async () => {
    // dispatchEvent reports handler errors out-of-band and returns normally —
    // the harness must read that channel or a crash grades as success.
    const task = gradable.find((t) => t.id === "trap-vba-cells-idiom")!;
    const throwing = [
      "export function setup(context) {",
      "  context.onClick(() => { throw new Error('boom'); });",
      "}",
    ].join("\n");
    const obs = await runTaskOutcome(task, throwing);
    expect(obs.ran).toBe(false);
    expect(obs.error).toContain("boom");
  });

  it("an async handler that rejects is a failed run too", async () => {
    const task = gradable.find((t) => t.id === "trap-vba-cells-idiom")!;
    const rejecting = [
      "export function setup(context) {",
      "  context.onClick(async () => {",
      "    await context.api.getCellValue(0, 0);",
      "    throw new Error('late-boom');",
      "  });",
      "}",
    ].join("\n");
    const obs = await runTaskOutcome(task, rejecting);
    expect(obs.ran).toBe(false);
    expect(obs.error).toContain("late-boom");
  });

  it("an undeclared capability dies at run time with PermissionDenied, like the broker", async () => {
    const task = gradable.find((t) => t.id === "trap-undeclared-capability")!;
    const undeclared = referenceSource(task).replace("// @capability storage\n", "");
    const obs = await runTaskOutcome(task, undeclared);
    expect(obs.ran).toBe(false);
    expect(obs.error).toContain("storage");
  });

  it("a harness gap makes the task ungradable — never a model failure", async () => {
    const task = gradable.find((t) => t.id === "grid-sort-by-first-column")!;
    // orientation:"columns" is real surface the harness deliberately does not
    // serve; the observation must say "I cannot judge this", not "wrong".
    const columnsSort = [
      "export function setup(context) {",
      "  context.onClick(async () => {",
      "    await context.api.sortRange(1, 0, 3, 4, [{ key: 0 }], { orientation: 'columns' });",
      "  });",
      "}",
    ].join("\n");
    const obs = await runTaskOutcome(task, columnsSort);
    expect(obs.harnessGap).toContain("sortRange");
    const grade = gradeOutcome(task.outcome!, obs);
    expect(grade.gradable).toBe(false);
    const score = scoreCandidate(task, columnsSort, grade);
    expect(score.graded, "an ungradable run must not touch the score").toBe(false);
  });

  it("the grade carries half the combined score", () => {
    const task = gradable.find((t) => t.id === "grid-read-write-cell")!;
    const zeroGrade: OutcomeGrade = {
      gradable: true,
      ran: true,
      checksTotal: 1,
      checksPassed: 0,
      wrongCells: [{ row: 0, col: 1, expected: "42", actual: "" }],
      missingOutput: [],
      grade: 0,
    };
    const graded = scoreCandidate(task, referenceSource(task), zeroGrade);
    const staticOnly = scoreCandidate(task, referenceSource(task));
    expect(staticOnly.score).toBe(1);
    expect(graded.score).toBe(0.5);
    expect(graded.passed).toBe(false);
  });

  it("the arithmetic-check reference sums against a fixture with a text distractor", async () => {
    // Pins that the grade is computing VALUES, not diff presence: the fixture
    // holds 10 + 20 + 5.5 + 0.5 with "n/a" in the middle, and only 36 passes.
    const task = gradable.find((t) => t.id === "grid-sum-in-script")!;
    const offByOne = referenceSource(task).replace(
      "await context.api.setCellValue(100, 1, total);",
      "await context.api.setCellValue(100, 1, total + 1);",
    );
    const grade = gradeOutcome(task.outcome!, await runTaskOutcome(task, offByOne));
    expect(grade.ran).toBe(true);
    expect(grade.wrongCells).toEqual([{ row: 100, col: 1, expected: "36", actual: "37" }]);
  });

  it("numeric spellings are canonicalized the way the backend types them", async () => {
    // The product parses "36.00" into the NUMBER 36 whose input string is
    // "36"; a harness that stored the author's spelling verbatim graded
    // `total.toFixed(2)` — a correct sum — as the wrong value.
    const task = gradable.find((t) => t.id === "grid-sum-in-script")!;
    const formatted = referenceSource(task).replace(
      "await context.api.setCellValue(100, 1, total);",
      "await context.api.setCellValue(100, 1, total.toFixed(2));",
    );
    const grade = gradeOutcome(task.outcome!, await runTaskOutcome(task, formatted));
    expect(grade.ran).toBe(true);
    expect(grade.wrongCells).toEqual([]);
    expect(grade.grade).toBe(1);
  });

  it("a NON-RETURNED .then chain's tail write still lands before the grid is observed", async () => {
    // dispatchEvent awaits only thenables a handler RETURNS. The product has
    // no early observation point at all — the host executes each call as it
    // arrives — so the callback idiom performs the task correctly there, and
    // a harness that snapshotted one microtask early graded it wrong. The
    // drain-to-quiescence loop is what this pins.
    const task = gradable.find((t) => t.id === "grid-read-write-cell")!;
    const thenChain = [
      "export function setup(context) {",
      "  context.onClick(() => {",
      "    context.api.getCellValue(0, 0).then((value) => {",
      "      context.api.setCellValue(0, 1, value);",
      "    });",
      "  });",
      "}",
    ].join("\n");
    const grade = gradeOutcome(task.outcome!, await runTaskOutcome(task, thenChain));
    expect(grade.ran).toBe(true);
    expect(grade.grade, JSON.stringify(grade.wrongCells)).toBe(1);
  });

  it("a missing expected output is missing, not silently forgiven", async () => {
    // Sabotage `missingOutput = []` in gradeOutcome and only THIS test reds —
    // the reference anchors exercise the passing side of the check only.
    const task = gradable.find((t) => t.id === "trap-office-js-idiom")!;
    const wrongMessage = referenceSource(task).replace(
      "context.notify('A1 is ' + value, 'info');",
      "context.notify('done', 'info');",
    );
    const grade = gradeOutcome(task.outcome!, await runTaskOutcome(task, wrongMessage));
    expect(grade.ran).toBe(true);
    expect(grade.missingOutput).toEqual(["Quarterly"]);
    expect(grade.grade).toBeLessThan(1);
  });

  it("matchOutput anchors the count: a coordinate report does not pass as a count", async () => {
    // The old substring "3" also matched row coordinates and miscounts like
    // "13" — the anchored regex is what makes the count a COUNT.
    const task = gradable.find((t) => t.id === "grid-count-matches")!;
    const positions = referenceSource(task).replace(
      "context.notify(found.totalCount + ' overdue cells', 'info');",
      "context.notify('overdue at rows 5, 6 and 8', 'info');",
    );
    const grade = gradeOutcome(task.outcome!, await runTaskOutcome(task, positions));
    expect(grade.ran).toBe(true);
    expect(grade.grade, "positions are not a count").toBeLessThan(1);
    const miscount = referenceSource(task).replace(
      "found.totalCount + ' overdue cells'",
      "'13 overdue cells'",
    );
    const miscountGrade = gradeOutcome(task.outcome!, await runTaskOutcome(task, miscount));
    expect(miscountGrade.grade, "13 contains 3 but is not 3").toBeLessThan(1);
  });

  it("cell `match` is case-insensitive: a lowercase formula spelling grades clean", async () => {
    const task = gradable.find((t) => t.id === "grid-sum-column")!;
    const lower = referenceSource(task).replace("'=SUM(B2:B100)'", "'=sum(b2:b100)'");
    const grade = gradeOutcome(task.outcome!, await runTaskOutcome(task, lower));
    expect(grade.ran).toBe(true);
    expect(grade.grade, JSON.stringify(grade.wrongCells)).toBe(1);
  });

  it("ignoring the confirm answer fails the guard task", async () => {
    // The outcome stubs confirm:false and expects the cells to SURVIVE — the
    // task is about the guard, and a candidate that clears regardless of the
    // answer now produces the exact wrong grid.
    const task = gradable.find((t) => t.id === "cap-dialog-confirm-before-clearing")!;
    const ignoresAnswer = referenceSource(task).replace(
      "    const ok = await context.caps.dialog.confirm('Clear A1:D100?');\n    if (!ok) return;\n",
      "    await context.caps.dialog.confirm('Clear A1:D100?');\n",
    );
    expect(ignoresAnswer, "the replace must have applied").not.toBe(referenceSource(task));
    const grade = gradeOutcome(task.outcome!, await runTaskOutcome(task, ignoresAnswer));
    expect(grade.ran).toBe(true);
    expect(grade.grade).toBeLessThan(1);
  });

  it("a counter that resets every click fails the two-click persistence check", async () => {
    const task = gradable.find((t) => t.id === "cap-storage-counter")!;
    const resets = [
      "// @capability storage",
      "export function setup(context) {",
      "  context.onClick(async () => {",
      "    await context.caps.storage.set('clicks', '1');",
      "    await context.api.setCellValue(0, 0, 1);",
      "  });",
      "}",
    ].join("\n");
    const grade = gradeOutcome(task.outcome!, await runTaskOutcome(task, resets));
    expect(grade.ran).toBe(true);
    expect(grade.wrongCells).toEqual([{ row: 0, col: 0, expected: "2", actual: "1" }]);
  });

  it("an uncaught write failure fails the error-handling task; a caught one passes", async () => {
    // stubs.failWrite makes the copy write throw once — the error the task is
    // ABOUT. Without it, an unconditional success-notify graded 1.0.
    const task = gradable.find((t) => t.id === "shape-report-errors")!;
    const noCatch = [
      "export function setup(context) {",
      "  context.onClick(async () => {",
      "    const value = await context.api.getCellValue(0, 0);",
      "    await context.api.setCellValue(0, 1, value);",
      "    context.notify('copied', 'success');",
      "  });",
      "}",
    ].join("\n");
    const uncaught = gradeOutcome(task.outcome!, await runTaskOutcome(task, noCatch));
    expect(uncaught.ran, "the injected failure must surface as a failed run").toBe(false);
    expect(uncaught.grade).toBe(0);
    const caught = gradeOutcome(task.outcome!, await runTaskOutcome(task, referenceSource(task)));
    expect(caught.grade).toBe(1);
  });
});

describe("summarize", () => {
  it("reports the mean and lists only the failures", () => {
    const scores = tasks.slice(0, 3).map((t) => scoreCandidate(t, referenceSource(t)));
    const s = summarize(scores);
    expect(s.total).toBe(3);
    expect(s.passed).toBe(3);
    expect(s.meanScore).toBe(1);
    expect(s.failures).toEqual([]);
  });
});

describe("a script with no entry point cannot score full marks", () => {
  /**
   * `scoreCandidate` called the validator and then ignored its VERDICT, reading
   * two finding codes and never `no-entry-point`. A bare top-level line has no
   * `setup`, so the mount tail calls nothing and the script does NOTHING — yet
   * the bare-`context` fallback still resolved its calls and it scored 1.0 with
   * `passed: true`. That number is the in-app `canaryScore` which PICKS THE
   * AUTHORING TIER, so the inflation changed what the product did.
   */
  const TASK: EvalTask = {
    id: "synthetic-no-entry-point",
    canary: false,
    objectType: "button",
    intent: "Write Hello into A1 when clicked.",
    hints: ["cell"],
    expectCapabilities: [],
    mustCall: ["api.setCellValue"],
    reference: [
      "export function setup(context) {",
      "  context.onClick(() => context.api.setCellValue(0, 0, 'Hello'));",
      "}",
    ],
  };

  it("scores a setup-less script below a passing mark", () => {
    const score = scoreCandidate(TASK, "context.api.setCellValue(0, 0, 'Hello');\n");

    // It really does look clean on every OTHER axis — that is why it scored 1.0.
    expect(score.parsed).toBe(true);
    expect(score.reachClean).toBe(true);
    expect(score.capabilitiesDeclared).toBe(true);
    expect(score.behavioural).toBe(true);
    // ...but it mounts and does nothing.
    expect(score.mountable).toBe(false);
    expect(score.passed).toBe(false);
    expect(score.score).toBeLessThan(1);
  });

  it("leaves a script that DOES have setup scoring exactly as before", () => {
    const score = scoreCandidate(TASK, referenceSource(TASK));

    expect(score.mountable).toBe(true);
    expect(score.passed).toBe(true);
    // parsed(0.05) + mountable(0.10) replaces the old parsed(0.15), so every
    // previously-measured number stays comparable.
    expect(score.score).toBe(1);
  });
});
