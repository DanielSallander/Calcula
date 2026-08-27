//! FILENAME: app/extensions/AIChat/lib/authorJobs.ts
// PURPOSE: Run script authoring as a BACKGROUND JOB that outlives the pane, and
//          publish enough progress that a slow local model never looks stuck.
// CONTEXT: 2026-08-24. The guided screen owned its run in component state, so
//          closing the task pane — or switching to another one — abandoned a
//          job that had already spent minutes of a CPU-bound model's time. And
//          the only progress it showed was one line per completed ROUND: on
//          qwen2.5:7b that is a blank screen for a minute or more between
//          updates, which is indistinguishable from a hang.
//
//          THE STORE IS MODULE-LEVEL, DELIBERATELY. React state dies with the
//          component; this must not. A job is registered here, the screen
//          SUBSCRIBES to it, and the two have independent lifetimes — which is
//          the whole of "let me go and do something else while it works".
//
//          NOT PERSISTED, and not backend state. A run is a few minutes of one
//          session; writing it into the workbook would put a transient UI
//          concern into a `.cala`, and reloading the app mid-run has no run to
//          resume anyway (the model call would be long gone).
//
//          AMENDED 2026-08-26, because a written decision is being reversed and
//          leaving both statements standing is how this repo grows headers that
//          lie:
//          A RUN IN FLIGHT IS STILL SESSION STATE and still unresumable: this
//          store dies with the session and the model call would be long gone.
//          What now leaves this module is the CLOSED record. An EDIT's record
//          is handed to the editor to persist once a human accepts, rejects or
//          saves; a CREATE's record is persisted by the runner itself, under
//          the draft id, when the draft is queued for review — a session-only
//          bucket the save path filters out of the archive, until Save re-keys
//          it onto the real script id and it becomes persistent. A decided
//          fact about the author's own scripts belongs in the workbook for the
//          same reason the audit trail does.

import { showToast } from "@api";
import { runAuthor, type AuthorRound, type AuthorRunResult } from "./authorRunner";
import { scriptNameFromIntent } from "./scriptName";

/** One line in a job's progress log. */
export interface JobStep {
  /** Milliseconds since the job started. Shown so a long gap is visible AS a gap. */
  at: number;
  text: string;
  kind: "info" | "roundOk" | "roundBad" | "done" | "error";
  detail?: string;
}

export type JobState = "running" | "done" | "failed" | "cancelled";

/** What the job is FOR. An edit reports differently and delivers differently. */
export type JobKind = "create" | "edit";

export interface AuthorJob {
  id: string;
  kind: JobKind;
  /** EDIT: the document being changed, so the toast can name it. */
  documentName?: string;
  /** CREATE: the name the draft will carry, so the toast and the recap quote
   *  the same string the editor shows. Undefined for an EDIT, which changes a
   *  script that is already named. */
  scriptName?: string;
  intent: string;
  objectType: string;
  model: string;
  startedAt: number;
  endedAt?: number;
  state: JobState;
  /** What is happening RIGHT NOW, for the live line and the status bar. */
  phase: string;
  /**
   * A volatile reading from inside the current phase, e.g. how many lines the
   * model has produced so far. REPLACES itself and is never appended to the
   * step log — it exists to prove liveness during a six-minute generation, and
   * a log full of "41 lines... 42 lines..." would bury the steps that matter.
   */
  live?: string;
  steps: JobStep[];
  rounds: AuthorRound[];
  result?: AuthorRunResult;
  error?: string;
}

type Listener = () => void;

/**
 * THE STORE IS IMMUTABLE, and that is not a style preference.
 *
 * `useSyncExternalStore` compares snapshots with `Object.is`. Mutating a job in
 * place and handing back the same reference means React concludes nothing
 * changed and never re-renders — the first version of this file did exactly
 * that, and Stop appeared to do nothing because the step it logged was invisible.
 * The mirror-image trap is a derived getter that builds a FRESH array on every
 * call (`jobs.filter(...)`): `Object.is` then fails every time and the component
 * re-renders forever. So every mutation replaces the array AND the job, and the
 * derived views are memoised against the array's identity.
 */
let jobs: readonly AuthorJob[] = [];
const listeners = new Set<Listener>();

/** Cancel flags, kept beside the store rather than on the job: a job handed to
 *  a subscriber is a snapshot, and a mutable flag on it would be a lie. */
const cancelled = new Set<string>();

function emit(): void {
  // Copied before iteration: a listener that unsubscribes during notification
  // would otherwise mutate the set being walked.
  for (const l of [...listeners]) l();
}

export function subscribeToJobs(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Replace one job with an updated copy, and publish. */
function update(id: string, change: (job: AuthorJob) => AuthorJob): void {
  const next = jobs.map((j) => (j.id === id ? change(j) : j));
  // Identity check: a change that produced the same object is not a change, and
  // publishing it would wake every subscriber for nothing.
  if (next.every((j, i) => j === jobs[i])) return;
  jobs = next;
  emit();
}

// --- Derived views, memoised against `jobs` so their identity is stable ------

let allCache: { from: readonly AuthorJob[]; value: AuthorJob[] } | null = null;
let runningCache: { from: readonly AuthorJob[]; value: AuthorJob[] } | null = null;

/** Every job this session, newest first. */
export function allJobs(): AuthorJob[] {
  if (!allCache || allCache.from !== jobs) allCache = { from: jobs, value: [...jobs].reverse() };
  return allCache.value;
}

export function jobById(id: string): AuthorJob | undefined {
  return jobs.find((j) => j.id === id);
}

/** The most recent job, running or not — what the guided screen shows. */
export function latestJob(): AuthorJob | undefined {
  return jobs[jobs.length - 1];
}

export function runningJobs(): AuthorJob[] {
  if (!runningCache || runningCache.from !== jobs) {
    runningCache = { from: jobs, value: jobs.filter((j) => j.state === "running") };
  }
  return runningCache.value;
}

/** Test hook: forget everything. */
export function __resetJobs(): void {
  jobs = [];
  allCache = null;
  runningCache = null;
  cancelled.clear();
  listeners.clear();
}

export function cancelJob(id: string): void {
  const job = jobById(id);
  if (!job || job.state !== "running") return;
  cancelled.add(id);
  update(id, (j) => ({
    ...j,
    phase: "Stopping...",
    steps: [...j.steps, { at: Date.now() - j.startedAt, kind: "info", text: "Stop requested." }],
  }));
}

/** Append a step and wake every subscriber. */
function push(id: string, step: Omit<JobStep, "at">): void {
  update(id, (j) => ({
    ...j,
    steps: [...j.steps, { ...step, at: Date.now() - j.startedAt }],
  }));
}

function setPhase(id: string, phase: string): void {
  // Clearing `live` is load-bearing: a token count left over from the previous
  // phase would sit under the new one claiming the model is still writing.
  update(id, (j) => (j.phase === phase && j.live === undefined ? j : { ...j, phase, live: undefined }));
}

let counter = 0;

export interface StartJobRequest {
  intent: string;
  objectType: string;
  providerId: string;
  model: string;
  baseUrl?: string;
  /** EDIT MODE: the script on screen. Its presence switches the whole run. */
  baseSource?: string;
  /** EDIT MODE: the document name, for the toast. */
  documentName?: string;
  /** Called once when the run ends, however it ends. Used by the editor bridge. */
  onDone?: (result: AuthorRunResult) => void;
  /**
   * Progress, forwarded to a caller that cannot subscribe to this store.
   *
   * The guided screen reads the job directly; the Object Script Editor is a
   * SEPARATE WINDOW with its own JS realm, so for it the store may as well not
   * exist. This is how a six-minute run stays visible over there.
   */
  onPhaseForCaller?: (phase: string, live?: string) => void;
}

/**
 * Start authoring in the background. Returns immediately with the job id.
 *
 * The promise inside is deliberately NOT returned: a caller that awaited it
 * would re-create the coupling this module exists to remove. Everything a
 * caller needs arrives through `subscribeToJobs`.
 */
export function startAuthorJob(req: StartJobRequest): string {
  const id = `job-${Date.now()}-${counter++}`;
  // The same discriminator the job's own `kind` uses one line below, so the two
  // cannot disagree. `runAuthor` is handed `req.intent` unchanged and derives
  // the name with this same pure function, so one input cannot produce two
  // names without a code change.
  const scriptName = req.baseSource === undefined ? scriptNameFromIntent(req.intent) : undefined;
  const job: AuthorJob = {
    id,
    kind: req.baseSource !== undefined ? "edit" : "create",
    documentName: req.documentName,
    scriptName,
    intent: req.intent,
    objectType: req.objectType,
    model: req.model,
    startedAt: Date.now(),
    state: "running",
    phase: "Starting...",
    steps: [],
    rounds: [],
  };
  jobs = [...jobs, job];
  emit();

  void (async () => {
    try {
      const result = await runAuthor({
        intent: req.intent,
        objectType: req.objectType,
        baseSource: req.baseSource,
        providerId: req.providerId,
        model: req.model,
        baseUrl: req.baseUrl,
        isCancelled: () => cancelled.has(id),
        onPhase: (phase, detail) => {
          setPhase(id, phase);
          push(id, { kind: "info", text: phase, detail });
          req.onPhaseForCaller?.(phase);
        },
        onLiveProgress: (text) => {
          update(id, (j) => (j.live === text ? j : { ...j, live: text }));
          req.onPhaseForCaller?.(jobById(id)?.phase ?? "", text);
        },
        onRound: (round) => {
          update(id, (j) => ({
            ...j,
            rounds: [...j.rounds, round],
            steps: [...j.steps, {
              at: Date.now() - j.startedAt,
              kind: round.ok ? "roundOk" : "roundBad",
              text: `Attempt ${round.round + 1}: ${round.ok ? "passed every check" : "rejected"}`,
              detail: round.problems.join(" | ") || undefined,
            }],
          }));
        },
      });
      const wasCancelled = cancelled.has(id);
      update(id, (j) => ({
        ...j,
        result,
        state: wasCancelled ? "cancelled" : "done",
        endedAt: Date.now(),
        phase: result.ok ? "Finished" : "Finished — not accepted",
        steps: [...j.steps, {
          at: Date.now() - j.startedAt,
          kind: result.ok ? "done" : "error",
          text: result.summary,
        }],
      }));
      // The whole point of a background job is that the user is elsewhere. A
      // toast is what tells them it is worth coming back.
      if (!wasCancelled) {
        showToast(toastFor(req, result, scriptName), {
          type: result.ok ? (result.unchanged ? "info" : "success") : "warning",
        });
      }
      // The bridge's only way home: the editor window is not subscribed to this
      // store and never can be. Fired AFTER the state is published so a handler
      // that reads the job sees the finished one.
      req.onDone?.(result);
    } catch (e) {
      const wasCancelled = cancelled.has(id);
      update(id, (j) => ({
        ...j,
        state: wasCancelled ? "cancelled" : "failed",
        endedAt: Date.now(),
        error: wasCancelled ? undefined : `${e}`,
        phase: wasCancelled ? "Stopped" : "Failed",
        steps: [...j.steps, {
          at: Date.now() - j.startedAt,
          kind: wasCancelled ? "info" : "error",
          text: wasCancelled ? "Stopped at your request." : `${e}`,
        }],
      }));
      if (!wasCancelled) {
        showToast(`Script authoring failed: ${e}`, { type: "error" });
      }
      // Fired on EVERY ending, including this one. A bridge that only heard
      // about success would leave the editor showing a spinner forever.
      req.onDone?.({
        ok: false,
        source: "",
        summary: wasCancelled ? "Stopped at your request." : `${e}`,
        rounds: [],
        // Required, and empty is the truth here: the run threw or was stopped,
        // so no preview ever reported which handlers it managed to fire.
        unexercisedHooks: [],
        // A required field one arm forgets to fill is the same failure this
        // arm exists to prevent. "failed" not "exhausted": a run that threw and
        // a model that ran out of attempts are different facts, and an author
        // who pressed Stop must not be told the model gave up.
        run: {
          runId: id,
          kind: req.baseSource !== undefined ? "edit" : "create",
          outcome: wasCancelled ? "cancelled" : "failed",
          startedAt: new Date(job.startedAt).toISOString(),
          elapsedMs: Date.now() - job.startedAt,
          instruction: req.intent,
          objectType: req.objectType,
          providerId: req.providerId,
          model: req.model,
          tier: "",
          surfaceTokens: 0,
          surfaceTruncated: false,
          summary: wasCancelled ? "Stopped at your request." : `${e}`,
          attempts: [],
          notices: [],
          changedNothing: false,
          unexercisedHooks: [],
        },
      });
    } finally {
      cancelled.delete(id);
    }
  })();

  return id;
}

/**
 * The completion toast, in terms of what the job actually was.
 *
 * An EDIT names the document, because the user started it from that document
 * and "ready for review" without saying WHICH script is the kind of message
 * that sends someone hunting.
 */
function toastFor(req: StartJobRequest, result: AuthorRunResult, scriptName?: string): string {
  const what = req.documentName ? `"${shortIntent(req.documentName)}"` : `"${shortIntent(req.intent)}"`;
  if (req.baseSource !== undefined) {
    if (!result.ok) return `Could not edit ${what} — open the script editor for details.`;
    return result.unchanged
      ? `${what} needed no change, according to the model.`
      : `A change to ${what} is ready for you to review.`;
  }
  // CREATE quotes the NAME the editor will show, not the first words of the
  // request: a toast that says one thing and a tab that says another is how a
  // user loses track of which draft is which. `shortIntent` is the fallback for
  // a caller that never derived a name.
  const named = scriptName ? `"${scriptName}"` : what;
  return result.ok
    ? `Script ready for review: ${named}`
    : `Could not write ${named} — open AI Chat for details.`;
}

/** A few words of the intent, for a toast that has to fit on one line. */
export function shortIntent(intent: string): string {
  const oneLine = intent.replace(/\s+/g, " ").trim();
  return oneLine.length <= 40 ? oneLine : `${oneLine.slice(0, 37)}...`;
}

// MOVED, NOT COPIED. The Object Script Editor is a separate window and cannot
// import AIChat's internals, so the one definition lives in `_shared` and this
// re-export keeps all four existing call sites — and `authorJobs.test.ts:20`,
// which imports it from here — compiling untouched.
export { formatElapsed } from "../../_shared/formatElapsed";
