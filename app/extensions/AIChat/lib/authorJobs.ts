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

import { showToast } from "@api";
import { runAuthor, type AuthorRound, type AuthorRunResult } from "./authorRunner";

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
  const job: AuthorJob = {
    id,
    kind: req.baseSource !== undefined ? "edit" : "create",
    documentName: req.documentName,
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
        showToast(toastFor(req, result), {
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
function toastFor(req: StartJobRequest, result: AuthorRunResult): string {
  const what = req.documentName ? `"${shortIntent(req.documentName)}"` : `"${shortIntent(req.intent)}"`;
  if (req.baseSource !== undefined) {
    if (!result.ok) return `Could not edit ${what} — open the script editor for details.`;
    return result.unchanged
      ? `${what} needed no change, according to the model.`
      : `A change to ${what} is ready for you to review.`;
  }
  return result.ok
    ? `Script ready for review: ${what}`
    : `Could not write ${what} — open AI Chat for details.`;
}

/** A few words of the intent, for a toast that has to fit on one line. */
export function shortIntent(intent: string): string {
  const oneLine = intent.replace(/\s+/g, " ").trim();
  return oneLine.length <= 40 ? oneLine : `${oneLine.slice(0, 37)}...`;
}

/** `1.4s` / `2m 05s` — a duration a person reads at a glance. */
export function formatElapsed(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "";
  const secs = Math.floor(ms / 1000);
  if (secs < 60) return `${secs}s`;
  return `${Math.floor(secs / 60)}m ${String(secs % 60).padStart(2, "0")}s`;
}
