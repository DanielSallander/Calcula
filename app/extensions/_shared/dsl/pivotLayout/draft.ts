//! FILENAME: app/extensions/_shared/dsl/pivotLayout/draft.ts
// PURPOSE: Turn "what the user asked for" into a design query the compiler
//          has judged — candidates, one generation, compile, at most one
//          stall-checked repair, and a dry run when the host can run one.
// CONTEXT: The extension-side half of the design-query assistant. The pure
//          pieces (which names to show, the prompt, the schema, the grammar,
//          the extraction) live in `@api/designQueryAssist`, which may not
//          import this folder; the compiler and the dry run live here and are
//          injected, so the eval runner can drive this loop with the real
//          compiler and a fake model.
//
// FOUR RULES CARRIED OVER FROM THE FORMULA LADDER, each measured there:
//
//  1. THE VERIFIER CARRIES THE QUALITY. Every proposal is compiled against the
//     live model before anyone sees it, and a query that fails to compile is
//     reported as invalid with the compiler's own findings, never shown as a
//     result. A dry run, where the host provides one, is a second check that
//     the model's engine can actually answer it.
//
//  2. A REPAIR THAT REPEATS ITSELF STOPS THE LADDER. At temperature zero a
//     small model shown its own answer mostly repeats it; a second identical
//     round is a full generation for a guaranteed identical answer.
//
//  3. A REPLY WITH NO QUERY IS A RESULT, NOT AN EXCEPTION. The honest answer
//     is "nothing could be judged" — DECLINED — and no query is offered.
//
//  4. GRAMMAR BEATS SCHEMA WHERE IT IS HONOURED. With a grammar the runtime
//     cannot name a column it was not shown; the reply is then the bare query
//     and no schema is sent with it. Elsewhere the schema constrains the
//     envelope and the compiler does the rest.

import type { AiCompletionProvider } from "@api/aiCompletionService";
import {
  buildDesignQueryGrammar,
  buildRepairPrompt,
  buildUserPrompt,
  chooseCandidates,
  designQuerySystemPrompt,
  designQueryResponseSchema,
  extractDesignQuery,
  type CompilerFinding,
  type DesignQueryCandidates,
  type DesignQueryModel,
} from "@api/designQueryAssist";
import type { CompiledDesignQuery, DesignQueryRequest } from "./designQuery";
import type { DslError } from "./errors";

/** At most one REPAIR, so at most two generations. */
export const MAX_REPAIR_ROUNDS = 1;

/** A query is short; a small model that starts explaining fills whatever it is given. */
export const MAX_REPLY_TOKENS = 320;

export type DraftPhase =
  | { kind: "asking"; model: string; round: number }
  | { kind: "compiling" }
  | { kind: "repairing"; round: number }
  | { kind: "running" };

/** What a dry run reports: enough to say "it answers, and how big it is". */
export interface DryRunSummary {
  rowCount: number;
  colCount: number;
}

export interface DraftDeps {
  provider: AiCompletionProvider;
  /** The compiler, bound to the model and connection the host holds. */
  compile: (dsl: string) => CompiledDesignQuery;
  /** Run the compiled request without materialising anything. Optional: a pivot editor compiles live and needs none. */
  dryRun?: (request: DesignQueryRequest) => Promise<DryRunSummary>;
  onPhase?: (phase: DraftPhase) => void;
  signal?: AbortSignal;
  maxRepairs?: number;
  /**
   * The turn this one refines. Absent for a first ask.
   *
   * Two things change when it is present, and the second is the one that is
   * easy to miss: the prompt carries the previous query as the thing to modify,
   * AND the candidate names are ranked from BOTH intents joined. Ranking from
   * the new intent alone is the trap — "make it monthly" mentions no measure and
   * no dimension, so `chooseCandidates` would score every name at zero and could
   * hand the follow-up a NARROWER list than the turn it is refining, dropping
   * the very columns the query already uses.
   */
  prior?: { intent: string; dsl: string };
}

export interface DesignQueryDraft {
  /**
   * `compiled`: the query compiles (and ran, when a dry run was available).
   * `invalid`: the query does not compile after the repair budget; the text
   *   is still returned so the person can fix it with the editor's markers.
   * `declined`: no query could be read out of the reply. Nothing to show.
   */
  status: "compiled" | "invalid" | "declined";
  dsl: string;
  explanation: string;
  errors: DslError[];
  warnings: DslError[];
  request: DesignQueryRequest | null;
  /** The dry run's answer, its refusal, or null when none was run. */
  dryRun: DryRunSummary | { error: string } | null;
  /** How many model round trips it took. 1 means first time. */
  rounds: number;
  model: string;
  /** One sentence for a person. */
  summary: string;
  candidates: DesignQueryCandidates;
  /** True when the runtime was handed a grammar rather than a schema. */
  grammarUsed: boolean;
}

function findingsOf(compiled: CompiledDesignQuery): CompilerFinding[] {
  return compiled.errors.map((e) => ({ line: e.location?.line, message: e.message }));
}

function summarise(draft: Omit<DesignQueryDraft, "summary">): string {
  switch (draft.status) {
    case "compiled": {
      const ran =
        draft.dryRun === null
          ? ""
          : "error" in draft.dryRun
            ? ` It compiled, but running it was refused: ${draft.dryRun.error}`
            : ` Ran on the model: ${draft.dryRun.rowCount} row${draft.dryRun.rowCount === 1 ? "" : "s"} × ${draft.dryRun.colCount} column${draft.dryRun.colCount === 1 ? "" : "s"}.`;
      return `Compiled by Calcula${draft.rounds > 1 ? ` after ${draft.rounds} tries` : ""}.${ran}`;
    }
    case "invalid":
      return `${draft.model} wrote a query Calcula could not compile${draft.rounds > 1 ? " even after a correction" : ""}. The text is in the editor with its errors marked.`;
    case "declined":
      return `${draft.model} did not answer with a query. Try rewording, or write the query yourself.`;
  }
}

/**
 * Draft a design query for `intent` over `model`.
 *
 * Rejects only on a transport failure or a cancel; a bad answer is a RESULT.
 */
export async function draftDesignQuery(
  intent: string,
  model: DesignQueryModel,
  deps: DraftDeps,
): Promise<DesignQueryDraft> {
  const maxRepairs = deps.maxRepairs ?? MAX_REPAIR_ROUNDS;
  const modelLabel = deps.provider.modelLabel() || "the model";
  // BOTH intents rank the candidates on a follow-up. See `DraftDeps.prior`:
  // a refinement like "make it monthly" names nothing the ranker can score, so
  // ranking from it alone would narrow the list below what the query it is
  // editing already uses.
  const candidates = chooseCandidates(
    model,
    deps.prior ? `${deps.prior.intent}\n${intent}` : intent,
  );

  const grammar = deps.provider.honorsGrammar() === true ? buildDesignQueryGrammar(candidates) : null;
  const responseSchema = grammar ? undefined : designQueryResponseSchema();
  // The grammar can only emit the bare query, so the prompt asks for exactly
  // that; asking for JSON under a grammar that forbids it made every reply
  // start with the most probable LEGAL token, which was an unasked LAYOUT.
  const format = grammar ? "bare" : "json";

  const messages: Array<{ role: "user" | "assistant"; text: string }> = [
    { role: "user", text: buildUserPrompt({ intent, candidates, format, prior: deps.prior }) },
  ];

  let dsl = "";
  let explanation = "";
  let compiled: CompiledDesignQuery | null = null;
  let rounds = 0;

  for (let round = 0; round <= maxRepairs; round++) {
    deps.onPhase?.({ kind: "asking", model: modelLabel, round: round + 1 });
    const reply = await deps.provider.complete(
      {
        system: designQuerySystemPrompt(format),
        messages,
        maxTokens: MAX_REPLY_TOKENS,
        temperature: 0,
        ...(responseSchema ? { responseSchema } : {}),
        ...(grammar ? { grammar } : {}),
      },
      { signal: deps.signal },
    );
    rounds = round + 1;

    const proposal = extractDesignQuery(reply.text);
    if (!proposal) {
      const declined: Omit<DesignQueryDraft, "summary"> = {
        status: "declined", dsl: "", explanation: "", errors: [], warnings: [], request: null,
        dryRun: null, rounds, model: reply.model || modelLabel, candidates, grammarUsed: grammar !== null,
      };
      return { ...declined, summary: summarise(declined) };
    }

    // STALL: the repair returned the same query. Stop rather than compile it
    // again and send the same findings again.
    if (round > 0 && proposal.dsl === dsl) break;

    dsl = proposal.dsl;
    explanation = proposal.explanation;
    deps.onPhase?.({ kind: "compiling" });
    compiled = deps.compile(dsl);
    if (compiled.request) break;

    if (round < maxRepairs) {
      deps.onPhase?.({ kind: "repairing", round: round + 2 });
      messages.push({ role: "assistant", text: reply.text });
      messages.push({ role: "user", text: buildRepairPrompt(dsl, findingsOf(compiled), format) });
    }
  }

  if (!compiled || !compiled.request) {
    const invalid: Omit<DesignQueryDraft, "summary"> = {
      status: "invalid", dsl, explanation,
      errors: compiled?.errors ?? [], warnings: compiled?.warnings ?? [],
      request: null, dryRun: null, rounds, model: modelLabel, candidates, grammarUsed: grammar !== null,
    };
    return { ...invalid, summary: summarise(invalid) };
  }

  let dryRun: DesignQueryDraft["dryRun"] = null;
  if (deps.dryRun) {
    deps.onPhase?.({ kind: "running" });
    try {
      dryRun = await deps.dryRun(compiled.request);
    } catch (e) {
      // A refusal is an ANSWER. The query compiled; the engine said no, and
      // the person is told what it said rather than shown a green tick.
      dryRun = { error: e instanceof Error ? e.message : String(e) };
    }
  }

  const done: Omit<DesignQueryDraft, "summary"> = {
    status: "compiled", dsl, explanation,
    errors: [], warnings: compiled.warnings, request: compiled.request,
    dryRun, rounds, model: modelLabel, candidates, grammarUsed: grammar !== null,
  };
  return { ...done, summary: summarise(done) };
}
