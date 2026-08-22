//! FILENAME: app/extensions/AIChat/lib/probeRunner.ts
// PURPOSE: Run the capability probe against the selected model and remember the
//          result, so the picker can answer "will this model work for Calcula?"
//          with a number instead of a vibe.
// CONTEXT: docs/design/local-model-script-authoring.md §4b, §10, M7.
//
//          THE PROFILE IS CACHED PER (provider, model), not per session. The
//          probe costs a dozen completions — minutes on a slow local model — and
//          re-running it every time the picker opens would make choosing a model
//          the most expensive thing in the product. It is invalidated by
//          re-running it, never silently: a stale score is still a MEASURED
//          score, and the date it was taken is shown beside it.
//
//          IT LIVES IN EXTENSION SETTINGS, like the selection itself: a
//          measurement of the user's machine and the user's model is neither
//          document state nor something to write into a `.cala`.

import { getSetting, setSetting } from "@api";
import { probeModel, describeProfile, planFor, type ModelProfile } from "@api/scriptHost/modelProfile";
import { aiChatBackend } from "./aiChatBackend";
import { TOOLS } from "./chatTools";
import type { ChatResponse, ChatToolDef } from "./aiTypes";

const EXT_ID = "calcula.ai-chat";
const PROFILE_PREFIX = "profile:";

/**
 * Enough for a short reply or a truncated tool call, and no more.
 *
 * The pre-flight below does not READ what comes back — it only needs the request
 * to be accepted — so paying for a real answer twice would be pure latency on a
 * slow local model.
 */
const PREFLIGHT_MAX_TOKENS = 64;

/**
 * What the user is told when the provider takes a plain message and refuses the
 * same message carrying Calcula's tools.
 *
 * Exported so the guard in `__tests__/probeRunner.test.ts` asserts the real
 * string rather than a copy that can drift away from it.
 */
export const TOOL_SURFACE_REFUSED =
  "This provider accepted a plain message but REFUSED the same message carrying Calcula's " +
  "tool definitions. The chat sends those with every message, so this model cannot be used " +
  "until the tool schemas and the provider agree. The server's own words follow.";

function key(providerId: string, model: string): string {
  return `${PROFILE_PREFIX}${providerId}:${model}`;
}

/** The stored profile for a model, or null when it has never been probed. */
export function readProfile(providerId: string, model: string): ModelProfile | null {
  const raw = getSetting(EXT_ID, key(providerId, model), "");
  if (!raw) return null;
  try {
    return JSON.parse(raw) as ModelProfile;
  } catch {
    // A corrupt entry is treated as "never probed" rather than crashing the
    // picker — the cost of being wrong is one re-run.
    return null;
  }
}

export function writeProfile(profile: ModelProfile): void {
  setSetting(EXT_ID, key(profile.providerId, profile.model), JSON.stringify(profile));
}

export interface RunProbeOptions {
  providerId: string;
  model: string;
  baseUrl?: string;
  contextTokens?: number;
  onProgress?: (done: number, total: number) => void;
  /** Polled between tasks so a slow probe can be abandoned. */
  isCancelled?: () => boolean;
}

/**
 * One completion through the selected provider.
 *
 * Non-streaming on purpose: the probe scores finished answers, and a dozen
 * streams would produce a flicker of deltas the user cannot read while telling
 * them nothing the final text does not.
 */
function makeComplete(opts: RunProbeOptions) {
  return async (system: string, user: string): Promise<string> => {
    if (opts.isCancelled?.()) throw new Error("cancelled");
    const resp = await aiChatBackend.invoke<ChatResponse>("ai_chat_complete", {
      request: {
        providerId: opts.providerId,
        model: opts.model,
        system,
        messages: [{ role: "user", content: [{ type: "text", text: user }] }],
        tools: [],
      },
      baseUrlOverride: opts.baseUrl || null,
    });
    return resp.blocks
      .filter((b): b is Extract<typeof b, { type: "text" }> => b.type === "text")
      .map((b) => b.text)
      .join("\n");
  };
}

/**
 * One cheap completion, carrying exactly the tools it is given.
 *
 * Returns the response so a caller can inspect it. `checkToolSurface` DISCARDS
 * it on purpose — a model handed two dozen workbook tools and asked whether it
 * is ready may well answer with a tool call, and that is a perfectly good
 * outcome: nothing here executes it, and the only question being asked is
 * whether the request was ACCEPTED. `probeNativeToolCall` below is the caller
 * that does look.
 */
async function preflight(
  opts: RunProbeOptions,
  tools: ChatToolDef[],
  message = "ready?",
  system = "Reply with the single word: ready.",
): Promise<ChatResponse> {
  if (opts.isCancelled?.()) throw new Error("cancelled");
  return aiChatBackend.invoke<ChatResponse>("ai_chat_complete", {
    request: {
      providerId: opts.providerId,
      model: opts.model,
      system,
      messages: [{ role: "user", content: [{ type: "text", text: message }] }],
      tools,
      maxTokens: PREFLIGHT_MAX_TOKENS,
    },
    baseUrlOverride: opts.baseUrl || null,
  });
}

/**
 * The one tool used to ask "can you actually emit a tool call?".
 *
 * Deliberately trivial and deliberately NOT one of Calcula's: a real tool's
 * description competes for the model's attention with the instruction, and a
 * zero-argument tool removes every reason to fail other than the mechanism
 * itself. It is never dispatched — `ai_chat_run_tool` has no arm for this name,
 * and nothing here calls it.
 */
const TOOL_CALL_CANARY: ChatToolDef = {
  name: "probe_ping",
  description: "Confirm you can call a tool. Takes no arguments. Call it now.",
  inputSchema: { type: "object", properties: {} },
};

/**
 * Does this model emit a NATIVE tool call, or write one as text?
 *
 * WHY THIS EXISTS. §4b claims the probe is "the only honest answer to 'will this
 * model work for Calcula?'" — and until now it measured the opposite of what the
 * chat needs. `emitsFencedCode` is true for essentially every model and is a
 * VIRTUE for script authoring; for the chat, answering a request for action with
 * a fenced tool call is total failure, and that is exactly what a user hit on
 * 2026-08-22. The probe scored the model at a respectable number and said
 * nothing, because it sent `tools: []`.
 *
 * ADVISORY, NEVER FATAL. Calcula now recovers a textual call, so a model that
 * fails this is degraded, not unusable — and a false negative (a model that
 * would have called a REAL tool but not this canary) must not lock out something
 * that works. Returns undefined when the request itself failed, so a transport
 * blip records no verdict rather than a wrong one.
 */
async function probeNativeToolCall(opts: RunProbeOptions): Promise<boolean | undefined> {
  try {
    const resp = await preflight(
      opts,
      [TOOL_CALL_CANARY],
      "Call the probe_ping tool now. Do not reply with text.",
      "You are being tested for tool-calling support. Emit a tool call, not a description of one.",
    );
    return resp.blocks.some((b) => b.type === "toolUse");
  } catch {
    return undefined;
  }
}

/**
 * Prove the provider accepts the payload the CHAT actually sends, before
 * spending minutes measuring how well the model writes code.
 *
 * WHY THIS EXISTS. On 2026-08-22 every message to a running Ollama died with
 * `json: cannot unmarshal number into Go struct field
 * .tools.function.parameters.properties.enum of type string` — `cube_kpi`
 * declared `enum: [1, 2, 3]`, and Ollama decodes that field into a Go
 * `[]string`. The refusal is at JSON-DECODE time, so it lands before any
 * inference. And the probe could not see it: it sent `tools: []`, so "Test this
 * model" pronounced the model healthy while the chat was unusable. §4b claims
 * this probe is "the only honest answer to 'will this model work for Calcula?'"
 * — a probe that never sends a tool cannot make that claim, because the chat
 * sends every tool on every turn.
 *
 * TWO REQUESTS, NOT ONE, and the order is the whole point. A single tools-laden
 * request that fails cannot tell a rejected SCHEMA from a runtime that is simply
 * down, an expired key, or a model that was deleted — and guessing wrong sends
 * the user hunting the wrong thing entirely. Sending the plain one first makes
 * the diagnosis a deduction instead: if it succeeds and the tools-laden one
 * fails, the tools are the only thing that changed. Two near-empty completions
 * against the dozen this function guards is not a cost worth optimising.
 */
async function checkToolSurface(opts: RunProbeOptions): Promise<void> {
  try {
    await preflight(opts, []);
  } catch (e) {
    // Unreachable, unauthorized, no such model — whatever it is, it is NOT the
    // tool surface, and it is reported verbatim rather than reinterpreted.
    throw new Error(`${e}`);
  }
  try {
    await preflight(opts, TOOLS);
  } catch (e) {
    throw new Error(`${TOOL_SURFACE_REFUSED}\n\n${e}`);
  }
}

/** Run the probe and persist the result. */
export async function runProbe(opts: RunProbeOptions): Promise<ModelProfile> {
  // Deliberately fatal, and deliberately BEFORE the canary run. A model whose
  // transport refuses our tools cannot be used at all, so reporting a score for
  // it would be the same lie in a more convincing shape — and no profile is
  // written, so the picker keeps saying "Not tested yet." rather than banking a
  // verdict for a model that never ran.
  await checkToolSurface(opts);

  // Before the canary run, because it is two cheap completions against that
  // run's dozen, and because a user who abandons a slow probe should still have
  // learned the one thing that decides whether the chat works at all.
  const emitsNativeToolCalls = await probeNativeToolCall(opts);

  const profile = await probeModel({
    providerId: opts.providerId,
    model: opts.model,
    contextTokens: opts.contextTokens,
    complete: makeComplete(opts),
    onProgress: opts.onProgress,
  });
  // Merged rather than passed in: `probeModel` has only a text `CompleteFn` and
  // structurally cannot observe a tool call. Omitted entirely when undecided, so
  // `describeProfile` can tell "measured false" from "never measured".
  const merged: ModelProfile =
    emitsNativeToolCalls === undefined ? profile : { ...profile, emitsNativeToolCalls };
  writeProfile(merged);
  return merged;
}

/**
 * One line for the picker.
 *
 * §10 requires degradation to be VISIBLE: a weak model must say so before the
 * user relies on it, or they blame the product rather than the model they chose.
 * The measurement DATE is included because a profile outlives the model file it
 * describes — pulling a new build of the same tag makes the old number a claim
 * about something that no longer exists.
 */
export function summarizeProfile(profile: ModelProfile | null): string {
  if (!profile) return "Not tested yet.";
  const when = profile.measuredAt.slice(0, 10);
  const partial =
    profile.tasksScored < profile.tasksTotal
      ? ` Only ${profile.tasksScored} of ${profile.tasksTotal} tasks completed, so this is a partial result.`
      : "";
  return `${describeProfile(profile)}${partial} (measured ${when})`;
}

export { planFor };
export type { ModelProfile };
