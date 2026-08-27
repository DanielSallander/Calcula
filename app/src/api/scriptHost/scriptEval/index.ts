//! FILENAME: app/src/api/scriptHost/scriptEval/index.ts
// PURPOSE: Score one candidate script against one eval task. Pure — no I/O, no
//          model, no filesystem — so the same function serves the CI corpus
//          check, the offline runner, and M7's in-app `canaryScore`.
// CONTEXT: docs/design/local-model-script-authoring.md §11.3, M5.
//
//          THE CORPUS IS AT tests/eval/tasks.json, deliberately outside `app/`:
//          the owner's decision was that it ships as a public developer/CI
//          artifact, because withholding it would make every compatibility claim
//          about a model unfalsifiable.
//
//          WHY SCORING IS NOT JUST "DID IT VALIDATE". A script can pass L0-L2 and
//          still not do the job — `export function setup() {}` validates
//          perfectly and achieves nothing. So a task also names the chains its
//          solution must actually call. That is a weak behavioural assertion
//          rather than a real one (it cannot tell a correct SUM from a wrong
//          one), and it is honest about being weak: the strong check is the
//          dry-run diff, which needs a live workbook and belongs to the runner,
//          not here.

import { validateScriptSource } from "../scriptValidation";
import { analyzeScript } from "../scriptValidation/analyze";
// Type-only: this module is deliberately executor-free and stays importable
// everywhere, so nothing from the preview backend enters it at runtime.
import type { PreviewStubs } from "../scriptPreview/backend";

/** A cell seeded into the harness grid before the run (input-string form). */
export interface CellSeedSpec {
  row: number;
  col: number;
  value: string;
}

/**
 * One cell the outcome must hold AFTER the task's event handler ran.
 *
 * `value` is compared exactly against the cell's INPUT STRING — the same
 * vocabulary `ai_dry_run_script`'s `readBack` reports (formulas as `=...`,
 * integers without `.0`, text verbatim, empty as `""`). `match` is a
 * case-insensitive regular expression instead, for cells where several
 * spellings are equally correct (`=SUM(B2:B100)` vs `=sum($B$2:$B$100)`).
 * Exactly one of the two must be present.
 */
export interface CellExpectation {
  row: number;
  col: number;
  value?: string;
  match?: string;
}

/**
 * Canned answers for the capability stubs the outcome harness provides.
 *
 * An ALIAS, not a second declaration: the backend that honours these lives in
 * `scriptPreview/backend.ts` and is shared with the in-app dry run, so the
 * vocabulary has to be one type. A parallel interface here would drift the
 * moment either side gained a stub.
 */
export type OutcomeStubs = PreviewStubs;

/**
 * The per-task expectations that turn L3 from a signal into a grade.
 *
 * A task that carries one is GRADABLE: the runner executes the candidate
 * against a seeded in-memory grid, fires `event`, and compares what the grid
 * and the script's output actually hold against `expect` / `expectOutput`.
 * A task without one is scored statically, exactly as before.
 */
export interface TaskOutcome {
  /**
   * The HOOK the harness fires, exactly as the product's forwarder does — for
   * a button, `button:clicked` reaches `context.onClick(handler)` and nothing
   * else. Deliberately NOT an exposed-method name: `context.expose('onClick',
   * …)` never receives a click in the product, and a harness that fell back to
   * it would grade a dead script as working.
   */
  event: string;
  /**
   * How many times the hook fires, sequentially (default 1). A persistence
   * task needs it: one click cannot distinguish a counter from a reset —
   * both write "1" — while two clicks separate "2" from "1".
   */
  eventCount?: number;
  /** Cells written into the grid BEFORE the run, so the task is deterministic. */
  fixture?: CellSeedSpec[];
  /** Cells that must hold these values after the run. */
  expect?: CellExpectation[];
  /** Substrings that must appear in the script's log/notify output. */
  expectOutput?: string[];
  /**
   * Case-insensitive regexes the joined output must match. Use where a
   * substring is too weak — "3" as a substring also matches "13", "30" and a
   * row coordinate; `(^|[^0-9])3([^0-9]|$)` matches only the count.
   */
  matchOutput?: string[];
  stubs?: OutcomeStubs;
}

/** One task from tests/eval/tasks.json. */
export interface EvalTask {
  id: string;
  /** In the in-app probe subset (M7's canaryScore). */
  canary: boolean;
  objectType: string;
  /** The user's words — what a model is actually given. */
  intent: string;
  /** Terms handed to the prompt assembler (M4) for ranking. */
  hints: string[];
  /** Capabilities the correct solution requires. Order-insensitive. */
  expectCapabilities: string[];
  /** Chains a correct solution has to call. */
  mustCall: string[];
  /** A solution that really works, kept as lines for readable diffs. */
  reference: string[];
  /** Why this task is interesting, when that is not obvious. */
  notes?: string;
  /** Expected-diff grading spec. Absent = static scoring only. */
  outcome?: TaskOutcome;
}

export interface EvalCorpus {
  version: number;
  tasks: EvalTask[];
}

/** The reference solution as a single source string. */
export function referenceSource(task: EvalTask): string {
  return task.reference.join("\n") + "\n";
}

/**
 * What actually happened when a candidate ran in the outcome harness.
 *
 * Produced by `runTaskOutcome` (harness.ts) — kept as a separate type so the
 * pure grading below needs no executor and stays importable everywhere.
 */
export interface OutcomeObservation {
  /** Mount + event handler completed without throwing. */
  ran: boolean;
  /** The failure, when `ran` is false. */
  error?: string;
  /**
   * A REAL surface member the harness does not implement was called. The run
   * is then evidence about the harness, not the script — the task becomes
   * ungradable for this candidate, never a failure.
   */
  harnessGap?: string;
  /** Input strings of every cell the task's `expect` names, after the run. */
  readBack: Array<{ row: number; col: number; value: string }>;
  /** Everything the script logged or notified, in order. */
  output: string[];
  /** Cells whose input string differs from the seeded state. */
  totalChanges: number;
}

/** The graded outcome: expectations compared against an observation. */
export interface OutcomeGrade {
  /** False when a harness gap made the run meaningless for grading. */
  gradable: boolean;
  ran: boolean;
  error?: string;
  harnessGap?: string;
  checksTotal: number;
  checksPassed: number;
  /** Expected-vs-actual for every cell check that failed. */
  wrongCells: Array<{ row: number; col: number; expected: string; actual: string }>;
  /** `expectOutput` entries that never appeared in the script's output. */
  missingOutput: string[];
  /** 0..1 — the fraction of checks that held. 0 when the script did not run. */
  grade: number;
}

/**
 * Grade an observation against a task's expectations. Pure — the executor
 * lives in harness.ts, and the offline runner feeds this from a subprocess.
 *
 * A harness gap grades NOTHING: scoring a candidate down because the harness
 * cannot service a legal call would blame the model for the emulator, which is
 * the exact failure `ai_dry_run_script`'s decline gate exists to prevent.
 */
export function gradeOutcome(outcome: TaskOutcome, obs: OutcomeObservation): OutcomeGrade {
  const expects = outcome.expect ?? [];
  const outs = outcome.expectOutput ?? [];
  const outMatches = outcome.matchOutput ?? [];
  const checksTotal = expects.length + outs.length + outMatches.length;

  if (obs.harnessGap) {
    return {
      gradable: false,
      ran: obs.ran,
      error: obs.error,
      harnessGap: obs.harnessGap,
      checksTotal,
      checksPassed: 0,
      wrongCells: [],
      missingOutput: [],
      grade: 0,
    };
  }
  if (!obs.ran) {
    return {
      gradable: true,
      ran: false,
      error: obs.error,
      checksTotal,
      checksPassed: 0,
      wrongCells: [],
      missingOutput: [...outs, ...outMatches.map((p) => `/${p}/i`)],
      grade: 0,
    };
  }

  const observed = new Map(obs.readBack.map((c) => [`${c.row},${c.col}`, c.value]));
  const wrongCells: OutcomeGrade["wrongCells"] = [];
  let checksPassed = 0;
  for (const e of expects) {
    // A cell the harness never reported reads as empty — the harness fills
    // readBack from `expect` itself, so absence only happens on a caller bug,
    // and "" is the honest observation for it either way.
    const actual = observed.get(`${e.row},${e.col}`) ?? "";
    const ok = e.match != null ? new RegExp(e.match, "i").test(actual) : actual === (e.value ?? "");
    if (ok) checksPassed++;
    else {
      wrongCells.push({
        row: e.row,
        col: e.col,
        expected: e.match != null ? `/${e.match}/i` : (e.value ?? ""),
        actual,
      });
    }
  }

  const joined = obs.output.join("\n");
  const missingOutput = [
    ...outs.filter((s) => !joined.includes(s)),
    ...outMatches.filter((p) => !new RegExp(p, "i").test(joined)).map((p) => `/${p}/i`),
  ];
  checksPassed += outs.length + outMatches.length - missingOutput.length;

  return {
    gradable: true,
    ran: true,
    checksTotal,
    checksPassed,
    wrongCells,
    missingOutput,
    grade: checksTotal === 0 ? 1 : Number((checksPassed / checksTotal).toFixed(4)),
  };
}

export interface TaskScore {
  taskId: string;
  /** L0 — it is JavaScript. */
  parsed: boolean;
  /** It defines the `setup` entry point the host mount actually calls. */
  mountable: boolean;
  /** L1 — every method it calls exists. */
  reachClean: boolean;
  /** L2 — no capability used without being declared. */
  capabilitiesDeclared: boolean;
  /** The declared set is exactly what the task expects: no more, no less. */
  capabilitiesExact: boolean;
  /** Every chain in `mustCall` was actually called. */
  behavioural: boolean;
  /** Chains the task required that the candidate never called. */
  missingCalls: string[];
  /** Methods it invented. The single most diagnostic failure. */
  inventedMethods: string[];
  /**
   * True when an outcome grade participated in `score`. False for a task with
   * no expectations, for a caller that graded nothing (the in-app probe never
   * executes model output — the renderer is the wrong place to run it), and
   * for a harness-gap run, which grades nothing by design.
   */
  graded: boolean;
  /**
   * The outcome grade, whenever one was ATTEMPTED — including a harness-gap
   * run (`graded: false`, `outcome.gradable: false`). Kept so a JSON report
   * can tell "ungradable" apart from "never gradable"; a gap that silently
   * vanished from the record would make a gap-heavy model look fully graded.
   */
  outcome?: OutcomeGrade;
  /** 0..1. Weighted so "invented an API" costs more than "missed a step". */
  score: number;
  /** True only when every component passed. */
  passed: boolean;
}

const WEIGHTS = {
  parsed: 0.05,
  /**
   * It has an entry point the host will actually call.
   *
   * Split out of `parsed`'s original 0.15 rather than added on top, so a script
   * that HAS a `setup` scores exactly what it scored before and every measured
   * number in the design doc stays comparable. Only the broken case moves.
   */
  mountable: 0.1,
  reachClean: 0.3,
  capabilitiesDeclared: 0.25,
  capabilitiesExact: 0.1,
  behavioural: 0.2,
} as const;

/**
 * How much of a graded task's score the OUTCOME carries.
 *
 * Half, deliberately. A script that is statically perfect and writes the WRONG
 * VALUE is the silent-corruption class this project catalogues — it must not
 * score above a script with a visible static defect and the right values, and
 * at 0.5 it cannot: full static marks with a zero grade caps at 0.5, below
 * every threshold that means anything. The static half is kept intact (same
 * components, same relative weights) so the per-component diagnostics stay
 * comparable with every number measured before grading existed; the COMBINED
 * score of a graded task is a new, stricter scale, and the design doc's
 * measured baselines (0.550 / 0.646) are static-only numbers.
 */
const OUTCOME_WEIGHT = 0.5;

/**
 * Score a candidate against a task.
 *
 * The weights encode what actually costs a user. `reachClean` is heaviest
 * because an invented method is the failure that cannot be recovered from
 * without a repair round, and `capabilitiesDeclared` is next because an
 * undeclared capability passes review and dies at run time (§5b). Over-declaring
 * (`capabilitiesExact`) is the lightest: it produces a reviewer notice, which is
 * the system working as designed rather than a defect.
 *
 * `outcome` is the graded result of actually RUNNING the candidate against the
 * task's fixture (harness.ts / run-eval.mjs). When present and gradable it
 * carries `OUTCOME_WEIGHT` of the score and gates `passed` — a script that runs
 * and writes the wrong values has not passed, no matter how clean it looks.
 * Callers that cannot execute the candidate (the in-app probe: the renderer
 * must never run model output) simply omit it and get the static score.
 */
export function scoreCandidate(task: EvalTask, candidate: string, outcome?: OutcomeGrade): TaskScore {
  // Checked against the members THIS task's object type can actually reach.
  // Unnarrowed, a button candidate calling `context.cell.setValue(...)` — a
  // TypeError the moment the script mounts — scored as reach-clean, and reach is
  // the heaviest component here. It is also the number the in-app probe turns
  // into `canaryScore`, which PICKS THE AUTHORING TIER, so a too-generous reach
  // check hands a model the direct tier on drafts that are dead at run time.
  const report = validateScriptSource(candidate, task.objectType);
  const analysis = report.analysis;

  const parsed = analysis.parsed;
  // The grader used to call the validator and then ignore its VERDICT, reading
  // only two finding codes. A script with no `setup` raises `no-entry-point` as
  // a `severity: "error"` — the host's mount tail simply never calls anything,
  // so it mounts and does NOTHING — and it scored 1.0 / `passed: true`, because
  // the bare-`context` fallback still resolved its calls. That inflates the
  // in-app `canaryScore` that picks the authoring tier, which is the one number
  // here that changes what the product does.
  const mountable =
    parsed && !report.findings.some((f) => f.code === "no-entry-point");
  // `wrong-object-type` is the same defect as `unknown-member` one axis over:
  // the member exists, it is simply not on the context THIS object is handed.
  // Both are dead code at run time, so both must cost `reachClean`.
  const inventedMethods = report.findings
    .filter((f) => f.code === "unknown-member" || f.code === "wrong-object-type")
    .map((f) => f.message);
  const reachClean = parsed && inventedMethods.length === 0;
  const capabilitiesDeclared =
    parsed && !report.findings.some((f) => f.code === "undeclared-capability");

  const expected = [...task.expectCapabilities].sort();
  const declared = [...report.declared].sort();
  const capabilitiesExact =
    expected.length === declared.length && expected.every((c, i) => c === declared[i]);

  const called = new Set(analysis.calls.map((c) => c.chain));
  // A mustCall entry may name ALTERNATIVES ("api.setCellFormula|api.setCellValue"):
  // the product supports several routes to the same write, and where the OUTCOME
  // already pins the result, insisting on one route scores a correct solution
  // down for solving the problem a different, valid way.
  const missingCalls = task.mustCall.filter((spec) => !spec.split("|").some((c) => called.has(c)));
  const behavioural = parsed && missingCalls.length === 0;

  const staticScore =
    (parsed ? WEIGHTS.parsed : 0) +
    (mountable ? WEIGHTS.mountable : 0) +
    (reachClean ? WEIGHTS.reachClean : 0) +
    (capabilitiesDeclared ? WEIGHTS.capabilitiesDeclared : 0) +
    (capabilitiesExact ? WEIGHTS.capabilitiesExact : 0) +
    (behavioural ? WEIGHTS.behavioural : 0);

  const staticPassed =
    parsed &&
    mountable &&
    reachClean &&
    capabilitiesDeclared &&
    capabilitiesExact &&
    behavioural;

  // An observation only counts against a task that ASKED to be graded, and a
  // harness-gap run counts against nobody.
  const graded = outcome != null && outcome.gradable && task.outcome != null;
  const score = graded
    ? staticScore * (1 - OUTCOME_WEIGHT) + outcome.grade * OUTCOME_WEIGHT
    : staticScore;

  return {
    taskId: task.id,
    parsed,
    mountable,
    reachClean,
    capabilitiesDeclared,
    capabilitiesExact,
    behavioural,
    missingCalls,
    inventedMethods,
    graded,
    outcome: task.outcome != null ? outcome : undefined,
    score: Number(score.toFixed(4)),
    passed: staticPassed && (!graded || outcome.grade === 1),
  };
}

/** A model's reply, split into the code it fenced and the prose around it. */
export interface ModelReply {
  /** The script, exactly as `extractScript` has always returned it. */
  source: string;
  /**
   * Everything the model said OUTSIDE the fence, with any further fenced
   * blocks removed.
   *
   * THIS IS THE SENTENCE THE OWNER WENT LOOKING FOR. Reported 2026-08-26:
   * "I could not see the reasoning or the results from the chat." The reason
   * was one line long — `extractScript` kept `fenced[1]` and dropped every word
   * around it, so the model's account of what it changed was destroyed at the
   * moment it arrived. Nothing downstream could show it because nothing
   * downstream ever had it.
   */
  note: string;
  /**
   * The model's INLINE scratchpad — the contents of `<think>...</think>`
   * blocks, joined.
   *
   * Measured 2026-08-27: nothing in ai/stream.rs strips these. A server that
   * splits reasoning into `reasoning_content` routes it to `ReasoningDelta`
   * and out of the text — but Ollama delivers deepseek-r1/qwen3 reasoning
   * INLINE in `content` unless configured otherwise, so it arrives here. Kept
   * separate from `note` because the two are different artifacts: the note is
   * the model's account of what it DID, the scratchpad is how it got there,
   * and a multi-thousand-character think block rendered as the "summary"
   * would bury the sentence the reader came for.
   */
  thinking: string;
}

/**
 * The one fence grammar. The scan in `splitReply` and its final capture read
 * the SAME expression — two spellings of "a fence" would drift, and the scan's
 * whole job is deciding which text the capture is allowed to see.
 */
const FENCE = /```(?:javascript|js|typescript|ts)?\s*\n([\s\S]*?)```/;
const FENCE_SCAN = new RegExp(FENCE.source, "g");

const THINK_OPEN = "<think>";
const THINK_CLOSE = "</think>";

export function splitReply(reply: string): ModelReply {
  // ONE LINEAR SCAN, first-open-wins. The old shape — a think-strip regex over
  // the RAW reply, then fence matching — corrupted real replies in both
  // directions: a fenced script whose CODE contains literal think tags (a
  // tag-filtering utility is exactly such a script) had the span between them
  // deleted from the source and misfiled as "thinking", while an orphan
  // `</think>` with no opener (the reasoning-template shape where the server
  // consumes the opening tag and the stream begins mid-thought) left the whole
  // scratchpad in the note and promoted a fenced sketch inside it as the
  // answer. So the scan walks the reply once and whichever construct OPENS
  // first claims the text: a fence opened outside any think block is answer
  // material verbatim — think tags inside it are literal — while a `<think>`
  // opened outside a fence is scratchpad to its close, fenced sketches
  // included. An orphan `</think>` before any opener means everything before
  // it was scratchpad, already-passed fences included.
  const thoughts: string[] = [];
  let answer = "";
  let sawThink = false;
  let pos = 0;
  while (pos < reply.length) {
    FENCE_SCAN.lastIndex = pos;
    const fence = FENCE_SCAN.exec(reply);
    const fenceAt = fence ? fence.index : -1;
    const openAt = reply.indexOf(THINK_OPEN, pos);
    const closeAt = reply.indexOf(THINK_CLOSE, pos);
    const candidates = [fenceAt, openAt, closeAt].filter((i) => i !== -1);
    if (candidates.length === 0) {
      answer += reply.slice(pos);
      break;
    }
    const next = Math.min(...candidates);
    if (fence && next === fenceAt) {
      // An answer fence, copied whole — nothing inside it is markup.
      answer += reply.slice(pos, fenceAt + fence[0].length);
      pos = fenceAt + fence[0].length;
    } else if (next === openAt) {
      answer += reply.slice(pos, openAt);
      sawThink = true;
      const bodyStart = openAt + THINK_OPEN.length;
      const end = reply.indexOf(THINK_CLOSE, bodyStart);
      if (end === -1) {
        // Cut off mid-thought (a truncated stream): everything after the tag
        // is scratchpad, not answer.
        thoughts.push(reply.slice(bodyStart).trim());
        pos = reply.length;
      } else {
        thoughts.push(reply.slice(bodyStart, end).trim());
        pos = end + THINK_CLOSE.length;
      }
    } else if (!sawThink) {
      // Orphan closer before any opener: the stream began INSIDE a thought,
      // so everything up to here — fences included — was scratchpad.
      thoughts.push(reply.slice(0, closeAt).trim());
      answer = "";
      sawThink = true;
      pos = closeAt + THINK_CLOSE.length;
    } else {
      // A stray closer after real think markup is literal text.
      answer += reply.slice(pos, closeAt + THINK_CLOSE.length);
      pos = closeAt + THINK_CLOSE.length;
    }
  }
  const thinking = thoughts.filter(Boolean).join("\n\n");
  // A reply that was ALL scratchpad (broken, but a truncated reasoning model
  // produces exactly this): fall back to the raw text so a fence inside it is
  // still salvaged rather than returning an empty source for the validator to
  // reject as a parse error with no content.
  const salvaged = answer.trim() === "" && reply.trim() !== "";
  const haystack = salvaged ? reply : answer;

  const fenced = haystack.match(FENCE);
  if (!fenced) return { source: haystack.trim() + "\n", note: "", thinking };
  if (salvaged) {
    // The whole reply was scratchpad, so the honest note is empty — prose here
    // would duplicate `thinking` against the same run budget, with the raw
    // think tag rendered as the model's account — and the promoted fence is
    // cut from the scratchpad so the code is stored once, not twice.
    return {
      source: fenced[1].trim() + "\n",
      note: "",
      thinking: thinking.replace(fenced[0], "").trim(),
    };
  }
  // `RegExpMatchArray.index` is `number | undefined` — a bare `match.index`
  // fails `npm run check-types` (tsconfig.check.json runs with strict null
  // checks; a bare `npx tsc --noEmit` does not and would let it through).
  const at = fenced.index ?? 0;
  const around = haystack.slice(0, at) + haystack.slice(at + fenced[0].length);
  return {
    source: fenced[1].trim() + "\n",
    // A model that emits a SECOND fenced block after its prose would otherwise
    // put raw ``` markers into a note that is rendered as plain text.
    note: around.replace(/```[\s\S]*?```/g, "").trim(),
    thinking,
  };
}

/**
 * Pull a script out of a model's reply.
 *
 * Models fence their code far more reliably than they emit conformant tool-call
 * JSON, which is the whole reason §1a says script authoring suits weak models:
 * the output is ONE artifact in a code block. A reply with no fence at all is
 * taken verbatim, because some models simply answer with bare code.
 *
 * DEFINED IN TERMS OF `splitReply`, not beside it: two functions that both
 * parse a fence are two functions that drift.
 */
export function extractScript(reply: string): string {
  return splitReply(reply).source;
}

export interface CorpusSummary {
  total: number;
  passed: number;
  /** Mean score across every task, 0..1. */
  meanScore: number;
  failures: TaskScore[];
}

export function summarize(scores: TaskScore[]): CorpusSummary {
  const passed = scores.filter((s) => s.passed).length;
  const meanScore = scores.length
    ? Number((scores.reduce((a, s) => a + s.score, 0) / scores.length).toFixed(4))
    : 0;
  return { total: scores.length, passed, meanScore, failures: scores.filter((s) => !s.passed) };
}

/** Re-exported so a runner needs one import. */
export { validateScriptSource, analyzeScript };
