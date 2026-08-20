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
import type { ChatResponse } from "./aiTypes";

const EXT_ID = "calcula.ai-chat";
const PROFILE_PREFIX = "profile:";

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

/** Run the probe and persist the result. */
export async function runProbe(opts: RunProbeOptions): Promise<ModelProfile> {
  const profile = await probeModel({
    providerId: opts.providerId,
    model: opts.model,
    contextTokens: opts.contextTokens,
    complete: makeComplete(opts),
    onProgress: opts.onProgress,
  });
  writeProfile(profile);
  return profile;
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
