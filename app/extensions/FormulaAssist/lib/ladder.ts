//! FILENAME: app/extensions/FormulaAssist/lib/ladder.ts
// PURPOSE: Turn "what the user asked for" into a proposal the engine has
//          judged — context, worked examples, one generation, verification,
//          and at most two stall-checked repairs.
// CONTEXT: This is the whole feature. Everything else in the folder shows the
//          result of this function or writes the cell it produced.
//
// FIVE THINGS HERE ARE MEASURED RATHER THAN CHOSEN, and each one is a rule the
// next person must not "simplify" away:
//
//  1. CONTEXT IS AN ENHANCEMENT, NOT A PREREQUISITE. `formula_context` reads a
//     live sheet and can fail for reasons that have nothing to do with the
//     request (a sheet index that moved, a backend not yet bound). Failing the
//     whole request because the enhancement failed would turn a slightly worse
//     answer into no answer at all.
//
//  2. RETRIEVAL IS NOT OPTIONAL. Measured on the 60-task corpus: 22/60 pass
//     with three worked examples against 8/60 without (McNemar p=0.0005), for
//     39 prompt tokens. Nearly triple the pass rate is not a nice-to-have.
//
//  3. THE PATTERN LIBRARY IS IMPORTED LAZILY. It is ~350 KB. A static import
//     would drag it into the startup bundle of every user who never asks for a
//     formula.
//
//  4. A REPAIR THAT REPEATS ITSELF STOPS THE LADDER. Measured on
//     qwen2.5-coder:1.5b: of 38 tasks given a repair round, the model returned
//     a BYTE-IDENTICAL formula 30 times. Spending a second generation on the
//     31st is 15 seconds of a person's life for a guaranteed identical answer.
//     So: same formula as last round -> stop immediately.
//
//  5. A REPLY WITH NO FORMULA IS A RESULT, NOT AN EXCEPTION. `extractProposal`
//     already tolerates prose, fences and truncated JSON. When even that finds
//     nothing, the honest answer is "nothing could be judged" — the DECLINED
//     state, which shows the reason and never a preview.
//
// WHY `deps` IS A PARAMETER. Every outside edge — the two backend commands, the
// model, the pattern library, the phase callback — arrives as a function. The
// test suite drives the real ladder with fakes rather than a mocked module
// graph, so what it proves is the ORDER and the DECISIONS, which is what breaks.

import type { AiCompletionProvider } from "@api/aiCompletionService";
import type {
  FormulaAssistRequest,
  FormulaProposal as SeamProposal,
} from "@api/formulaAssistService";
import type { RetrievablePattern } from "@api/formulaAssist";
import {
  FORMULA_SYSTEM_PROMPT,
  buildIndex,
  buildRepairPrompt,
  buildUserPrompt,
  extractProposal,
  rankPatterns,
  responseFormat,
} from "@api/formulaAssist";
import { columnToLetter, getAiCompletionProvider } from "@api";
import {
  fetchFormulaContext,
  findingLine,
  headerWords,
  toPromptContext,
  toVerification,
  verifyFormula,
} from "./backend";
import type { FormulaVerifyReport, RegionContext } from "./backend";
import { describeFunctions } from "./explain";

/** At most two REPAIRS, so at most three generations in the worst case. */
export const MAX_REPAIR_ROUNDS = 2;

/** Worked examples per request. The measured configuration. */
export const RETRIEVED_EXAMPLES = 3;

/**
 * Rows of a fill-down the VERIFIER evaluates.
 *
 * Three, because three is what the seam promises to show. Verifying the whole
 * column would make the preview cost scale with the sheet for no extra
 * information: a fill-down that is wrong is wrong in row 2.
 */
export const FILL_DOWN_PREVIEW_ROWS = 3;

/**
 * Reply budget. Generous enough for a LET with several bindings, small enough
 * that a model looping inside `assumptions` (measured: 52 of 60 tasks on a 1.5B
 * model) stops rather than running for a minute.
 */
const MAX_REPLY_TOKENS = 600;

/** What the popover puts on its live phase line. A CPU model takes ~15s. */
export type LadderPhase =
  | { kind: "context" }
  | { kind: "retrieval" }
  | { kind: "asking"; round: number; model: string }
  | { kind: "verifying"; round: number }
  | { kind: "repairing"; round: number };

export interface LadderDeps {
  fetchContext: (
    sheetIndex: number,
    row: number,
    col: number,
  ) => Promise<RegionContext>;
  verify: typeof verifyFormula;
  /** Null when no model is configured. Checked, never assumed. */
  getProvider: () => AiCompletionProvider | null;
  /** Lazy — see rule 3 in the header. */
  loadPatterns: () => Promise<readonly RetrievablePattern[]>;
  onPhase?: (phase: LadderPhase) => void;
}

/** The real edges. Overridden wholesale by the tests. */
export function defaultLadderDeps(
  onPhase?: (phase: LadderPhase) => void,
): LadderDeps {
  return {
    fetchContext: fetchFormulaContext,
    verify: verifyFormula,
    getProvider: getAiCompletionProvider,
    loadPatterns: async () => {
      const mod = await import("@api/formulaAssist/generated/formulaPatterns");
      return mod.FORMULA_PATTERNS;
    },
    onPhase,
  };
}

// ---------------------------------------------------------------------------
// Proposal construction
// ---------------------------------------------------------------------------

function a1Of(row: number, col: number): string {
  return `${columnToLetter(col)}${row + 1}`;
}

interface Shell {
  target: SeamProposal["target"];
  model: string;
}

function baseProposal(shell: Shell): SeamProposal {
  return {
    status: "unverified",
    formulaInvariant: "",
    formulaLocalized: "",
    explanation: "",
    assumptions: [],
    fillDown: false,
    verification: null,
    target: shell.target,
    rounds: 0,
    model: shell.model,
    summary: "",
  };
}

/**
 * The no-model outcome.
 *
 * A RESULT, not a refusal: the caller still gets Explain and Verify, neither of
 * which needs a model, and the summary says exactly where to turn one on rather
 * than leaving a disabled control with no reason — the failure mode this whole
 * programme has been fixing.
 */
function noModelProposal(shell: Shell): SeamProposal {
  return {
    ...baseProposal(shell),
    status: "no-model",
    summary:
      "No AI model is selected. Choose one in the AI Chat panel to ask for a formula — " +
      "Explain and Verify work without one.",
  };
}

function declinedProposal(shell: Shell, reason: string, rounds: number): SeamProposal {
  return {
    ...baseProposal(shell),
    status: "declined",
    rounds,
    verification: {
      verified: false,
      display: "",
      fillDownDisplays: [],
      findings: [],
      declineReason: reason,
    },
    summary: reason,
  };
}

// ---------------------------------------------------------------------------
// The ladder
// ---------------------------------------------------------------------------

/**
 * Ask for a formula and hand back what the engine made of it.
 *
 * REJECTS ONLY ON A TRANSPORT FAILURE. A model that answers nonsense, a
 * verifier that declines, a reply with no formula in it — all of those are
 * proposals with a status, because a caller that has to try/catch to find out
 * whether the answer was good will eventually stop drawing the distinction.
 */
export async function assistFormula(
  req: FormulaAssistRequest,
  deps: LadderDeps = defaultLadderDeps(),
): Promise<SeamProposal> {
  const target = {
    sheetIndex: req.sheetIndex,
    row: req.row,
    col: req.col,
    a1: a1Of(req.row, req.col),
  };
  const phase = deps.onPhase ?? ((): void => {});

  // --- 1. Context ---------------------------------------------------------
  phase({ kind: "context" });
  let context: RegionContext | null = null;
  try {
    context = await deps.fetchContext(req.sheetIndex, req.row, req.col);
  } catch {
    // Rule 1: carry on without it. A worse prompt beats no answer.
    context = null;
  }

  // --- 2. Worked examples -------------------------------------------------
  phase({ kind: "retrieval" });
  let examples: RetrievablePattern[] = [];
  try {
    const patterns = await deps.loadPatterns();
    const index = buildIndex(patterns);
    examples = rankPatterns(
      index,
      { intent: req.intent, headers: headerWords(context) },
      RETRIEVED_EXAMPLES,
    ).map((r) => r.pattern);
  } catch {
    // Retrieval nearly triples the pass rate, so losing it is a real loss —
    // but it is still an enhancement, and a missing artifact must not be the
    // reason a user gets nothing.
    examples = [];
  }

  // --- 3. The model -------------------------------------------------------
  const provider = deps.getProvider();
  if (!provider || !provider.isConfigured()) {
    return noModelProposal({ target, model: "" });
  }
  const model = provider.modelLabel() || "the selected model";
  const shell: Shell = { target, model };

  let userText = buildUserPrompt({
    intent: req.intent,
    context: context ? toPromptContext(context) : null,
    examples,
    expected: req.expected,
  });
  // The measured prompt had no live tables in it, so the table hint is APPENDED
  // rather than folded into `renderRegionContext` — the block that was scored
  // stays byte-identical, and a workbook that has a real table gets the one
  // extra line that lets the model write structured references.
  if (context?.table) {
    const t = context.table;
    userText += `\n\nTable "${t.name}" columns: ${t.columns.join(", ")}${
      t.targetColumn ? `. The target cell is in column "${t.targetColumn}".` : ""
    }`;
  }

  const messages: Array<{ role: "user" | "assistant"; text: string }> = [
    { role: "user", text: userText },
  ];
  // `responseFormat` builds the OpenAI-compatible `response_format` envelope;
  // the seam takes the schema itself. Unwrapped here rather than duplicating
  // the schema, so there is still exactly one copy of it.
  const responseSchema = responseFormat().json_schema as {
    name: string;
    schema: Record<string, unknown>;
  };

  let rounds = 0;
  let lastFormula = "";
  let lastExtracted: ReturnType<typeof extractProposal> = null;
  let lastReport: FormulaVerifyReport | null = null;
  let stalled = false;
  let truncated = false;

  for (let attempt = 0; attempt <= MAX_REPAIR_ROUNDS; attempt++) {
    rounds++;
    phase({ kind: "asking", round: rounds, model });

    const reply = await provider.complete(
      {
        system: FORMULA_SYSTEM_PROMPT,
        messages,
        maxTokens: MAX_REPLY_TOKENS,
        temperature: 0,
        responseSchema,
      },
      { signal: req.signal },
    );
    truncated = reply.truncated;
    messages.push({ role: "assistant", text: reply.text });

    // --- 4. Extraction ----------------------------------------------------
    const extracted = extractProposal(reply.text);
    if (!extracted) {
      // Rule 5. Say WHY, and say it differently when the reply was cut off,
      // because "the model wrote half an answer" and "the reply hit the token
      // limit" are indistinguishable in the text and only one is the user's
      // problem to solve.
      return declinedProposal(
        shell,
        truncated
          ? "The model's reply hit its length limit before it finished a formula. Try a shorter request, or a larger model."
          : "The model's reply contained no formula.",
        rounds,
      );
    }

    // Rule 4: the stall check, BEFORE another verification or generation.
    if (attempt > 0 && extracted.formula === lastFormula) {
      stalled = true;
      break;
    }

    lastExtracted = extracted;
    lastFormula = extracted.formula;

    // --- 5. Verification --------------------------------------------------
    phase({ kind: "verifying", round: rounds });
    const report = await deps.verify({
      formula: extracted.formula,
      sheetIndex: req.sheetIndex,
      row: req.row,
      col: req.col,
      fillDownRows: extracted.fillDown ? FILL_DOWN_PREVIEW_ROWS : 0,
    });
    lastReport = report;

    if (report.verdict === "declined") {
      return {
        ...baseProposal(shell),
        status: "declined",
        formulaInvariant: report.normalized,
        formulaLocalized: report.localized,
        explanation: extracted.explanation,
        assumptions: extracted.assumptions,
        fillDown: extracted.fillDown,
        rounds,
        verification: toVerification(report, target),
        summary:
          report.declineReason ??
          "The engine could not judge this formula, so it is not offered as an answer.",
      };
    }

    if (report.verdict === "verified" && report.rung === "f2") {
      return await verifiedProposal(shell, extracted, report, rounds, target);
    }

    if (attempt === MAX_REPAIR_ROUNDS) break;

    // --- 6. Repair --------------------------------------------------------
    phase({ kind: "repairing", round: rounds + 1 });
    messages.push({
      role: "user",
      text: buildRepairPrompt(extracted.formula, report.findings.map(findingLine)),
    });
  }

  return await unverifiedProposal(
    shell,
    lastExtracted,
    lastReport,
    rounds,
    target,
    { stalled, truncated },
  );
}

async function verifiedProposal(
  shell: Shell,
  extracted: NonNullable<ReturnType<typeof extractProposal>>,
  report: FormulaVerifyReport,
  rounds: number,
  target: SeamProposal["target"],
): Promise<SeamProposal> {
  return {
    ...baseProposal(shell),
    status: "verified",
    formulaInvariant: report.normalized,
    formulaLocalized: report.localized,
    explanation:
      extracted.explanation || (await describeFunctions(report.functionsUsed)),
    assumptions: assumptionsWith(extracted.assumptions, report),
    fillDown: extracted.fillDown,
    rounds,
    verification: toVerification(report, target),
    // Verified needs no apology, but `summary` is part of the seam and a caller
    // that renders it unconditionally should get a sentence, not "".
    summary: `Verified by Calcula's engine on ${target.a1}.`,
  };
}

async function unverifiedProposal(
  shell: Shell,
  extracted: ReturnType<typeof extractProposal>,
  report: FormulaVerifyReport | null,
  rounds: number,
  target: SeamProposal["target"],
  how: { stalled: boolean; truncated: boolean },
): Promise<SeamProposal> {
  if (!extracted) {
    return declinedProposal(
      shell,
      "The model produced no formula that could be checked.",
      rounds,
    );
  }

  const firstFinding = report?.findings.length ? findingLine(report.findings[0]) : "";
  const summary = how.stalled
    ? `The model returned the same formula again, so it stopped after ${rounds} tries. ` +
      (firstFinding || "Calcula could not verify it.")
    : how.truncated && !firstFinding
      ? "The model's reply hit its length limit, and Calcula could not verify the formula."
      : firstFinding
        ? `Calcula could not verify this formula: ${firstFinding}`
        : "Calcula could not verify this formula.";

  return {
    ...baseProposal(shell),
    status: "unverified",
    formulaInvariant: report?.normalized ?? extracted.formula,
    formulaLocalized: report?.localized ?? extracted.formula,
    explanation:
      extracted.explanation ||
      (report ? await describeFunctions(report.functionsUsed) : ""),
    assumptions: assumptionsWith(extracted.assumptions, report),
    fillDown: extracted.fillDown,
    rounds,
    verification: report ? toVerification(report, target) : null,
    summary,
  };
}

/**
 * The model's own assumptions, plus the one the ENGINE noticed.
 *
 * A model that wrote `=SUMMA(A1;B1)` produced a localized formula. The verifier
 * undoes that (`delocalizedFromLocale`), and the user is entitled to know it
 * happened: the formula they are about to accept is not character-for-character
 * what the model said.
 */
function assumptionsWith(
  own: readonly string[],
  report: FormulaVerifyReport | null,
): readonly string[] {
  if (!report?.delocalizedFromLocale) return own;
  return [
    ...own,
    `The model wrote this formula with ${report.delocalizedFromLocale} separators; Calcula converted it before checking.`,
  ];
}
