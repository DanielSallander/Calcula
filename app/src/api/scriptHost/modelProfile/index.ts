//! FILENAME: app/src/api/scriptHost/modelProfile/index.ts
// PURPOSE: Measure what the selected model can actually do, and derive the
//          authoring strategy from the measurement rather than from its name.
// CONTEXT: docs/design/local-model-script-authoring.md §4b, §4c, M7.
//
//          WHY PROBE INSTEAD OF DETECTING HARDWARE. Reading VRAM answers the
//          wrong question ("how many gigabytes") and lies besides — shared
//          memory, unified memory, other processes — while costing permanent
//          detection code across four vendors. What a user actually wants to
//          know is "will this model work for Calcula?", and the only honest
//          answer runs OUR tasks through OUR validator. That is `canaryScore`.
//
//          THE PROBE IS PER-MODEL, NOT PER-LOCAL-MODEL. A cloud model is
//          measured the same way, which is what removes the hand-maintained
//          vendor-by-feature matrix that would otherwise be stale the week after
//          it was written (§4b, and an explicit anti-goal in §2).
//
//          ONE HONEST CORRECTION TO §4b. That section described `contextTokens`
//          as "measured, not what the card claims". It is NOT measured here, and
//          pretending otherwise would be the kind of over-claim this programme
//          keeps finding: establishing a real context limit means binary-
//          searching with very long prompts, which is slow locally and costs
//          money on a metered endpoint. It is a declared SETTING with a
//          conservative default, and `contextTokens` is documented as such.

import { CANARY_TASKS, type CanaryTask } from "../generated/canaryTasks";
import { scoreCandidate, extractScript, type EvalTask } from "../scriptEval";
import { buildSurfacePrompt } from "../scriptPrompt";

/** A single completion, injected so the probe is testable without a provider. */
export type CompleteFn = (system: string, user: string) => Promise<string>;

export interface ModelProfile {
  providerId: string;
  model: string;
  /**
   * DECLARED, not measured — see the header. Conservative default so a small
   * model is not handed a prompt it will silently truncate.
   */
  contextTokens: number;
  /** Timed over the canary run. 0 when nothing completed. */
  decodeTokensPerSec: number;
  /** Replies came back in a fenced code block. True for essentially everything. */
  emitsFencedCode: boolean;
  /** Fraction of canary tasks passed, 0..1. The field that actually matters. */
  canaryScore: number;
  /** How many of the canary tasks were attempted without a transport error. */
  tasksScored: number;
  tasksTotal: number;
  /**
   * Whether the model emitted a NATIVE tool call when handed a tool and told to
   * use it.
   *
   * OPTIONAL because `probeModel` does not measure it — it has no provider, only
   * a `CompleteFn` returning text, and a native tool call is by definition not
   * text. The AI Chat's own probe runner fills it in (`probeRunner.ts`), so an
   * older profile simply carries `undefined` and says nothing.
   *
   * WHY IT IS WORTH A FIELD. `emitsFencedCode` above is TRUE for essentially
   * every model, and for script authoring that is exactly what you want. For the
   * CHAT it is the failure mode: a model that answers a request for action with
   * a fenced ```json tool call does nothing at all. The profile scored such a
   * model at 60% and pronounced it fine while the chat was unusable, because
   * nothing in the probe had ever sent a tool. Advisory only — Calcula now
   * recovers a textual call, so `false` is a warning, never a lock-out.
   */
  emitsNativeToolCalls?: boolean;
  /** ISO date, so a stale profile can be re-run rather than trusted forever. */
  measuredAt: string;
}

export const DEFAULT_CONTEXT_TOKENS = 8192;

/**
 * Authoring strategy, derived from the profile (§4c).
 *
 * The CONTRACT does not change between tiers — intent in, validated draft out.
 * Only the internal strategy does, which is what lets one pipeline serve an 8k
 * local model and a frontier cloud one without branching anywhere else.
 */
export type AuthoringTier = "assisted" | "standard" | "direct";

export interface TierPlan {
  tier: AuthoringTier;
  /** Tokens the API surface may spend. */
  surfaceBudgetTokens: number;
  /** How many times a rejected draft is sent back for repair. */
  repairRounds: number;
  /** Shown to the user, so a weak model is never a silent downgrade (§10). */
  rationale: string;
}

/**
 * Choose the strategy.
 *
 * Repair rounds go UP as the model gets weaker, which is backwards only if you
 * are paying per token. Locally a round costs electricity and a few seconds, so
 * spending them where they are needed is the whole reason a modest machine can
 * produce a usable script at all (§1a).
 */
export function planFor(profile: ModelProfile): TierPlan {
  const surface = Math.max(1000, Math.floor(profile.contextTokens * 0.45));
  if (profile.canaryScore >= 0.85) {
    return {
      tier: "direct",
      surfaceBudgetTokens: surface,
      repairRounds: 1,
      rationale: `Scored ${pct(profile.canaryScore)} on the built-in tasks — authoring directly.`,
    };
  }
  if (profile.canaryScore >= 0.5) {
    return {
      tier: "standard",
      surfaceBudgetTokens: surface,
      repairRounds: 3,
      rationale: `Scored ${pct(profile.canaryScore)} on the built-in tasks — drafts will be checked and corrected up to 3 times.`,
    };
  }
  return {
    tier: "assisted",
    surfaceBudgetTokens: surface,
    repairRounds: 6,
    rationale:
      `Scored ${pct(profile.canaryScore)} on the built-in tasks. This model struggles with Calcula's API; ` +
      `drafts will be corrected up to 6 times and may still need your edits.`,
  };
}

function pct(v: number): string {
  return `${Math.round(v * 100)}%`;
}

/**
 * One sentence for the model picker.
 *
 * §10 requires that degradation be VISIBLE. A quality drop the user cannot see
 * is a transparency defect, and it is also the thing that makes them blame the
 * product rather than the model they chose.
 */
export function describeProfile(profile: ModelProfile): string {
  const speed =
    profile.decodeTokensPerSec > 0
      ? ` It generates at about ${Math.round(profile.decodeTokensPerSec)} tokens/sec.`
      : "";
  // Only stated when it was actually MEASURED false. `undefined` means the probe
  // predates the check, and inventing a verdict for it would be the same lie in
  // a smaller shape.
  const toolCalls =
    profile.emitsNativeToolCalls === false
      ? " It did NOT emit a native tool call in the probe: expect it to write tool calls as text. " +
        "Calcula recovers those, and asks you before running anything that changes the workbook."
      : "";
  return `${planFor(profile).rationale}${speed}${toolCalls}`;
}

const PROBE_SYSTEM = [
  "You write Calcula object scripts.",
  "Reply with ONE fenced JavaScript code block and nothing else.",
  "The script must export `setup(context)` and reach the API through `context`.",
  "Declare any privileged capability with a `// @capability <id>` comment at the top.",
].join("\n");

/** A canary task carries no reference solution; the scorer needs the shape. */
function asEvalTask(task: CanaryTask): EvalTask {
  return {
    id: task.id,
    canary: true,
    objectType: task.objectType,
    intent: task.intent,
    hints: [...task.hints],
    expectCapabilities: [...task.expectCapabilities],
    mustCall: [...task.mustCall],
    reference: [],
  };
}

export interface ProbeOptions {
  providerId: string;
  model: string;
  complete: CompleteFn;
  contextTokens?: number;
  /** Injected so tests are deterministic; defaults to the wall clock. */
  now?: () => number;
  /** Reported after each task so a two-minute probe can show progress. */
  onProgress?: (done: number, total: number) => void;
}

/**
 * Run the canary tasks and build a profile.
 *
 * A task that throws is NOT scored as zero. Recording a transport failure as a
 * model failure quietly blames the model for a laptop that went to sleep — the
 * same rule the offline runner follows, and `tasksScored` is reported so a
 * partial probe can never masquerade as a complete one.
 */
export async function probeModel(options: ProbeOptions): Promise<ModelProfile> {
  const now = options.now ?? (() => Date.now());
  const contextTokens = options.contextTokens ?? DEFAULT_CONTEXT_TOKENS;
  const surfaceBudget = Math.max(1000, Math.floor(contextTokens * 0.45));

  let totalScore = 0;
  let scored = 0;
  let fencedReplies = 0;
  let approxTokens = 0;
  const started = now();

  for (const [index, task] of CANARY_TASKS.entries()) {
    const evalTask = asEvalTask(task);
    const surface = buildSurfacePrompt({
      objectType: task.objectType,
      budgetTokens: surfaceBudget,
      hints: [...task.hints, task.intent],
    });
    const user = `${surface.text}\n\n# Task (the script is attached to a "${task.objectType}")\n${task.intent}`;
    try {
      const reply = await options.complete(PROBE_SYSTEM, user);
      if (reply.includes("```")) fencedReplies++;
      approxTokens += Math.ceil(reply.length / 3.6);
      totalScore += scoreCandidate(evalTask, extractScript(reply)).score;
      scored++;
    } catch {
      // Left uncounted on purpose — see the doc comment.
    }
    options.onProgress?.(index + 1, CANARY_TASKS.length);
  }

  const elapsedSecs = Math.max(0.001, (now() - started) / 1000);
  return {
    providerId: options.providerId,
    model: options.model,
    contextTokens,
    decodeTokensPerSec: approxTokens > 0 ? approxTokens / elapsedSecs : 0,
    emitsFencedCode: scored > 0 && fencedReplies / scored >= 0.5,
    canaryScore: scored > 0 ? Number((totalScore / scored).toFixed(4)) : 0,
    tasksScored: scored,
    tasksTotal: CANARY_TASKS.length,
    measuredAt: new Date(now()).toISOString(),
  };
}

export { CANARY_TASKS };
export type { CanaryTask };
