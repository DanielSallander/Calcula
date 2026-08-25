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

import { listenTauriEvent } from "@api";
import { aiChatBackend } from "./aiChatBackend";
import { AI_STREAM_EVENT, type ChatResponse, type StreamEvent } from "./aiTypes";
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
  /**
   * Called at every observable step INSIDE a round.
   *
   * A round on a CPU-bound 7B is a minute or more, and `onRound` fires only at
   * the end of one — so a screen driven by rounds alone shows nothing at all for
   * minutes and reads as a hang. The steps come from the two callbacks this
   * module OWNS (`complete` and `dryRun`), which is what makes them available
   * without changing the shared pipeline: it does not know what it is being
   * driven by, and should not have to.
   */
  onPhase?: (phase: string, detail?: string) => void;
  /**
   * The current attempt is still producing text.
   *
   * Distinct from `onPhase`: a phase is a STEP that happened and belongs in the
   * log, while this is a volatile "still going" reading that replaces itself.
   * Measured 2026-08-25: a 9B took 6m35s for one attempt, which without this is
   * six and a half minutes of nothing.
   */
  onLiveProgress?: (text: string) => void;
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
  /**
   * The script ran cleanly against the workbook copy and changed NOTHING.
   *
   * Surfaced rather than acted on: it no longer triggers a repair round (see
   * the `expectsWrites` note below), because the preview runs against whatever
   * workbook is open and a correct script can legitimately match no cells in
   * it. It is still the single most useful thing to tell the user to check.
   */
  changedNothing?: boolean;
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

/**
 * How often a live token count may update the UI.
 *
 * A token-by-token update would push hundreds of lines into the job log and
 * tell the reader nothing a line count does not; a second is fast enough to
 * prove liveness and slow enough to stay readable.
 */
const LIVE_PROGRESS_MS = 1000;

/** Error messages from a validation report, trimmed for a progress line. */
function problemsOf(report: { findings: Array<{ severity: string; message: string }> }): string[] {
  return report.findings
    .filter((f) => f.severity === "error")
    .map((f) => f.message)
    .slice(0, 3);
}

export async function runAuthor(req: AuthorRunRequest): Promise<AuthorRunResult> {
  const phase = (text: string, detail?: string) => req.onPhase?.(text, detail);

  phase("Loading Calcula's script API");
  const { authorScript, planFor, previewObjectScript } = await load();
  const plan = planFor(profileFor(req.providerId, req.model));
  phase(
    `Plan: ${plan.tier} — up to ${plan.repairRounds} corrections`,
    plan.rationale,
  );

  /** Which attempt `complete` is serving. It is called once per round, in order. */
  let attempt = 0;
  const totalAttempts = plan.repairRounds + 1;

  /**
   * One completion through the user's selected provider, STREAMED.
   *
   * WHY STREAMED, when nothing here needs the deltas. Measured 2026-08-25 on a
   * local qwen3.5:9b: a single attempt took SIX MINUTES AND THIRTY-FIVE SECONDS
   * to produce 73 lines. Non-streaming, that is one progress line at the start
   * and nothing until it lands — and there is no way for the user to tell it
   * apart from a hang, which is exactly what they asked about. The return value
   * is still the whole text and the loop is unchanged; the deltas only drive
   * `onLiveProgress`.
   *
   * The listener is registered per call rather than once for the module: an
   * authoring run makes at most seven of these, minutes apart, and a listener
   * that outlived its request would keep counting another pane's tokens.
   */
  const complete = async (system: string, user: string): Promise<string> => {
    if (req.isCancelled?.()) throw new Error("cancelled");
    attempt += 1;
    const label = `attempt ${attempt} of ${totalAttempts}`;
    phase(
      `Writing the script with ${req.model} (${label})`,
      attempt === 1 ? undefined : "Correcting the previous attempt",
    );

    const streamId = `author-${Date.now()}-${attempt}`;
    let streamed = "";
    let lastReport = 0;
    const off = await listenTauriEvent<StreamEvent>(AI_STREAM_EVENT, (event) => {
      if (!event || event.streamId !== streamId || event.type !== "textDelta") return;
      streamed += event.text;
      // Throttled: a token-by-token phase update would push hundreds of lines
      // into the job log and tell the reader nothing a line count does not.
      const now = Date.now();
      if (now - lastReport < LIVE_PROGRESS_MS) return;
      lastReport = now;
      req.onLiveProgress?.(`${req.model} is writing... ${streamed.split("\n").length} lines so far`);
    });

    try {
      const resp = await aiChatBackend.invoke<ChatResponse>("ai_chat_complete_stream", {
        request: {
          providerId: req.providerId,
          model: req.model,
          system,
          messages: [{ role: "user", content: [{ type: "text", text: user }] }],
          tools: [],
          // Code generation, like tool selection, is not a creative decision
          // here: the repair loop is a far better recovery mechanism than a
          // lucky sample.
          temperature: 0,
        },
        streamId,
        baseUrlOverride: req.baseUrl || null,
      });
      const text = resp.blocks
        .filter((b): b is Extract<typeof b, { type: "text" }> => b.type === "text")
        .map((b) => b.text)
        .join("\n");
      phase(`${req.model} replied (${text.split("\n").length} lines)`);
      phase("Checking it against Calcula's API");
      return text;
    } finally {
      // Always: a run that threw must not leave a listener counting deltas for
      // a stream id nobody will ever emit again.
      off();
    }
  };

  /** The last preview report, for the warning below. */
  let lastDryRun: { ok: boolean; applicable?: boolean; totalChanges: number } | null = null;
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
    dryRun: async (source: string) => {
      phase("Running it against a copy of your workbook");
      const report = await previewObjectScript({
        source, objectType: req.objectType, tier: "restricted",
      });
      // Remembered for the RESULT, since it no longer drives a repair round.
      lastDryRun = report;
      phase(
        report.applicable === false
          ? "The preview could not judge this script"
          : report.ok
            ? `It ran, changing ${report.totalChanges} cell${report.totalChanges === 1 ? "" : "s"}`
            : "It failed when run",
        report.applicable === false
          ? report.declinedReason ?? undefined
          : report.ok
            ? undefined
            : report.error ?? undefined,
      );
      return report;
    },
    // NOT `true`, and this was a real cost. Reported 2026-08-25: a qwen3.5:9b
    // draft passed every static check, ran cleanly, changed 0 cells — and was
    // sent back for a repair round that then burned ten minutes and timed out.
    //
    // `AuthorRequest` says this is the CALLER's judgement and warns about
    // exactly that case ("against an empty sheet, a correct 'sort rows 2-500'
    // changes nothing"), and the guided path genuinely CANNOT judge it. The
    // preview runs against a copy of whatever workbook happens to be open, and
    // the reported task — colour each cell whose content is a hex code —
    // legitimately changes nothing when no cell contains one. So "changed
    // nothing" here is weak evidence bought at minutes per round on a local
    // model.
    //
    // It is not DISCARDED: `changedNothing` below carries it to the user as a
    // warning on the result, where they can check their own data against it.
    // The eval corpus still sets this true, because there the fixture IS known.
    expectsWrites: false,
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

  /** True only when the preview actually RAN and reported no changes. */
  const ranButChangedNothing = (): boolean =>
    lastDryRun !== null && lastDryRun.applicable !== false && lastDryRun.ok && lastDryRun.totalChanges === 0;

  if (!result.ok) {
    // The best attempt is returned even on failure: a script that is 90% right
    // is worth showing, and the editor is where a person fixes the rest.
    return { ok: false, source: result.source, summary: result.summary, rounds, changedNothing: ranButChangedNothing() };
  }

  // Delivered through the ordinary review path — same store, same audit, same
  // "NOT mounted" invariant as a draft the chat's tool loop produces.
  phase("Queueing the script for your review");
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
    return { ok: true, source: result.source, summary: result.summary, rounds, draftId: id, changedNothing: ranButChangedNothing() };
  } catch (e) {
    // Authoring SUCCEEDED; only delivery failed. Reported separately so the user
    // is not told their script is broken when it is sitting right there.
    return {
      ok: true,
      source: result.source,
      summary: result.summary,
      rounds,
      deliveryError: `${e}`,
      changedNothing: ranButChangedNothing(),
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
