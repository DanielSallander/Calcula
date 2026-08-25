//! FILENAME: app/extensions/AIChat/lib/authorRunner.ts
// PURPOSE: Drive the ALREADY-BUILT authoring pipeline (`authorScript`, M7) from
//          the chat's selected model, and hand the finished draft to the Object
//          Script Editor through the existing review path.
// CONTEXT: 2026-08-24. `authorScript` does generate -> validate -> dry-run ->
//          repair, tier-aware, with the API surface prefixed and an
//          `expectsWrites` check that catches "ran but changed nothing". A grep
//          found it had ZERO UI callers: the whole pipeline was built, graded by
//          the eval corpus, and never given a door. The only mention anywhere in
//          an extension was a comment in `draftGate` explaining why it had NOT
//          been bolted into the chat's tool loop.
//
//          WHY IT BELONGS BESIDE THE CHAT RATHER THAN INSIDE IT. The tool loop
//          asks the model to choose: script or direct action, and then which of
//          two dozen tools. Measured across qwen2.5-coder:3b and qwen2.5:7b,
//          that choice is where local models fail — they write reasonable
//          JavaScript and pick the wrong tool. `authorScript` has NO tool
//          selection step at all: the user has already said "a script, attached
//          to this", so the model only has to do the part it is good at.
//
//          THE DRAFT GOES OUT THE SAME DOOR AS EVERY OTHER ONE. On success this
//          calls `draft_object_script` through `ai_chat_run_tool` rather than
//          inventing a second delivery route: that reuses the Rust draft store,
//          the `mcp:script-draft` event, the audit entry, the editor hand-off and
//          the "NOT mounted, NOT running" invariant. Nothing here mounts or runs
//          anything.

import { aiChatBackend } from "./aiChatBackend";
import type { ChatResponse } from "./aiTypes";
import { readProfile } from "./probeRunner";

/** One repair round, as the UI shows it. */
export interface AuthorRound {
  round: number;
  ok: boolean;
  /** Error messages from this round's validation, already trimmed for display. */
  problems: string[];
}

export interface AuthorRunRequest {
  intent: string;
  objectType: string;
  providerId: string;
  model: string;
  baseUrl?: string;
  /** Called as each round completes, so a slow local run is not a frozen dialog. */
  onRound?: (round: AuthorRound) => void;
  /** Polled between rounds so the user can abandon a long run. */
  isCancelled?: () => boolean;
}

export interface AuthorRunResult {
  ok: boolean;
  source: string;
  /** One sentence for the user. */
  summary: string;
  rounds: AuthorRound[];
  /** Set when the draft reached the review queue. Drives "Open in editor". */
  draftId?: string;
  /** Set when queueing the draft failed, even though authoring succeeded. */
  deliveryError?: string;
}

/**
 * The default profile for a model nobody has probed.
 *
 * `canaryScore: 0` lands on the ASSISTED tier: six repair rounds and the
 * worked template in the system prompt. That is the right default for an
 * unmeasured local model — the rounds cost electricity and seconds, and §1a's
 * whole argument is that spending them is what lets a modest machine produce a
 * usable script. A model that has been probed gets its measured plan instead.
 */
const UNPROBED_CONTEXT_TOKENS = 8192;

function profileFor(providerId: string, model: string) {
  const measured = readProfile(providerId, model);
  if (measured) return measured;
  return {
    providerId,
    model,
    contextTokens: UNPROBED_CONTEXT_TOKENS,
    decodeTokensPerSec: 0,
    emitsFencedCode: true,
    canaryScore: 0,
    tasksScored: 0,
    tasksTotal: 0,
    measuredAt: new Date().toISOString(),
  };
}

/**
 * Lazy, for the same reason `apiSurface.ts` is: this module's dependency graph
 * reaches the 167 KB generated surface, and the extension activates at app
 * startup whether or not anyone authors a script.
 */
async function load() {
  const [authoring, profile, preview] = await Promise.all([
    import("@api/scriptHost/scriptAuthoring"),
    import("@api/scriptHost/modelProfile"),
    import("@api/scriptHost/scriptPreview"),
  ]);
  return {
    authorScript: authoring.authorScript,
    planFor: profile.planFor,
    previewObjectScript: preview.previewObjectScript,
  };
}

/** Error messages from a validation report, trimmed for a progress line. */
function problemsOf(report: { findings: Array<{ severity: string; message: string }> }): string[] {
  return report.findings
    .filter((f) => f.severity === "error")
    .map((f) => f.message)
    .slice(0, 3);
}

export async function runAuthor(req: AuthorRunRequest): Promise<AuthorRunResult> {
  const { authorScript, planFor, previewObjectScript } = await load();
  const plan = planFor(profileFor(req.providerId, req.model));

  /** One completion through the user's selected provider. */
  const complete = async (system: string, user: string): Promise<string> => {
    if (req.isCancelled?.()) throw new Error("cancelled");
    const resp = await aiChatBackend.invoke<ChatResponse>("ai_chat_complete", {
      request: {
        providerId: req.providerId,
        model: req.model,
        system,
        messages: [{ role: "user", content: [{ type: "text", text: user }] }],
        tools: [],
        // Code generation, like tool selection, is not a creative decision here:
        // the repair loop is a far better recovery mechanism than a lucky sample.
        temperature: 0,
      },
      baseUrlOverride: req.baseUrl || null,
    });
    return resp.blocks
      .filter((b): b is Extract<typeof b, { type: "text" }> => b.type === "text")
      .map((b) => b.text)
      .join("\n");
  };

  const rounds: AuthorRound[] = [];
  const result = await authorScript({
    intent: req.intent,
    objectType: req.objectType,
    plan,
    complete,
    // Only so a give-up message can name what gave up.
    model: req.model,
    // L3, in the realm the script will actually mount into, at the tier it will
    // actually mount at. A preview that cannot run DECLINES rather than guessing
    // — `authorScript` reads `applicable` and does not treat that as a failure.
    dryRun: (source: string) =>
      previewObjectScript({ source, objectType: req.objectType, tier: "restricted" }),
    // The user asked for something that changes the workbook. Without this a
    // script that mounts cleanly and does nothing scores as a success — the
    // quietest failure this system has.
    expectsWrites: true,
    onAttempt: (round: number, report: { findings: Array<{ severity: string; message: string }> }) => {
      const entry: AuthorRound = {
        round,
        ok: report.findings.every((f) => f.severity !== "error"),
        problems: problemsOf(report),
      };
      rounds.push(entry);
      req.onRound?.(entry);
    },
  });

  if (!result.ok) {
    // The best attempt is returned even on failure: a script that is 90% right
    // is worth showing, and the editor is where a person fixes the rest.
    return { ok: false, source: result.source, summary: result.summary, rounds };
  }

  // Delivered through the ordinary review path — same store, same audit, same
  // "NOT mounted" invariant as a draft the chat's tool loop produces.
  try {
    const text = await aiChatBackend.invoke<string>("ai_chat_run_tool", {
      name: "draft_object_script",
      input: {
        name: titleFor(req.intent),
        object_type: req.objectType,
        description: req.intent,
        source: result.source,
      },
    });
    const id = /\(id=(draft-[0-9a-fA-F]+)\)/.exec(text)?.[1];
    return { ok: true, source: result.source, summary: result.summary, rounds, draftId: id };
  } catch (e) {
    // Authoring SUCCEEDED; only delivery failed. Reported separately so the user
    // is not told their script is broken when it is sitting right there.
    return {
      ok: true,
      source: result.source,
      summary: result.summary,
      rounds,
      deliveryError: `${e}`,
    };
  }
}

/**
 * A short display name from the user's own words.
 *
 * `validate_draft` (mcp/drafts.rs) rejects an empty name, and the editor tab
 * shows it, so it has to be non-empty and readable rather than a uuid.
 */
export function titleFor(intent: string): string {
  const words = intent.trim().split(/\s+/).slice(0, 6).join(" ");
  const trimmed = words.length > 48 ? `${words.slice(0, 45)}...` : words;
  return trimmed || "AI script";
}
