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
  extractScript,
  summarize,
  type EvalCorpus,
  type EvalTask,
} from "../index";
import { validateScriptSource } from "../../scriptValidation";
import { buildSurfacePrompt } from "../../scriptPrompt";

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
    const report = validateScriptSource(referenceSource(task));
    const errors = report.findings.filter((f) => f.severity === "error");
    expect(
      errors,
      `${task.id}'s reference solution does not pass the validator:\n` +
        errors.map((e) => `  - [${e.code}] ${e.message}`).join("\n") +
        "\n\nA task whose own answer is wrong marks every model wrong for refusing to reproduce it.",
    ).toEqual([]);
  });

  it.each(tasks.map((t) => [t.id, t] as const))("%s requires exactly the capabilities it claims", (_id, task) => {
    const report = validateScriptSource(referenceSource(task));
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
      const missing = task.mustCall.filter((c) => !prompt.includedChains.includes(c));
      expect(
        missing,
        `${task.id}: the prompt at 4k tokens omits ${JSON.stringify(missing)}, so no model could answer it`,
      ).toEqual([]);
    },
  );
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
