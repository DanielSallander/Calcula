//! FILENAME: app/src/api/scriptHost/scheduler.ts
// PURPOSE: The renderer half of the persistent job scheduler (the `schedule`
//          capability — Calcula's Application.OnTime replacement). Rust owns
//          the schedule (persistence, due-ness, grant re-check, no-self-overlap,
//          audit); this module owns only the CLOCK and the INVOCATION, because
//          the JS a job runs lives in a renderer worker realm that Rust cannot
//          reach into.
//
// CONTEXT: scripting/scheduler.rs is the authority. Read its header for the
//          scope boundary ("while Calcula is open" — no headless runtime) and
//          for why the renderer ticking does not weaken the gate: a faster tick
//          buys nothing, since `due` re-derives grant + mount + overlap +
//          interval from state Rust owns and hands back only what may run.
//
// INVOCATION: a job calls a method the script EXPOSED (context.expose), through
//          the same callExposedMethod path the connector host uses. There is
//          deliberately no second invocation path — a timer must not be able to
//          reach anything an ordinary cross-script call could not.
//
// BOUNDED WORK: every firing is bounded twice over. In the renderer the relayed
//          call carries METHOD_CALL_TIMEOUT_MS (30s, protocol.ts), so a wedged
//          worker rejects rather than hangs; in Rust the MAX_RUN_MS watchdog
//          releases a job whose renderer never reported back at all. The
//          Rust-QuickJS surfaces are separately bounded by the interpreter's
//          interrupt-handler deadline (core/script-engine/src/limits.rs).

import { invokeBackend } from "../backend";
import { listMountedHandles } from "./broker";

/** How often the renderer asks Rust "what is due?".
 *
 *  Well below MIN_INTERVAL_SECS (30s) so a job fires close to its slot, and
 *  cheap: the tick is one command that usually returns an empty array. The
 *  pump only runs while at least one job exists (see `syncPump`), so a workbook
 *  with no schedules pays nothing. */
const TICK_MS = 10_000;

/** One persisted job, mirroring Rust `ScheduledJob` (camelCase per the golden
 *  rule). Used by the transparency panel. */
export interface ScheduledJob {
  id: string;
  scriptId: string;
  surface: string;
  objectType: string;
  instanceId: string | null;
  handler: string;
  /** "every" | "dailyAt" */
  cadence: string;
  intervalSecs: number;
  minuteOfDay: number;
  nextRunMs: number;
  enabled: boolean;
  label: string | null;
  running: boolean;
  runningSinceMs: number;
  lastRunMs: number;
  lastOk: boolean;
  lastError: string | null;
  runCount: number;
}

/** The shape Rust hands back from `due` — just enough to make the call. */
interface DueJob {
  id: string;
  scriptId: string;
  surface: string;
  objectType: string;
  instanceId: string | null;
  handler: string;
}

/** The surface marking a job that drives a script-fed BI connector's refresh
 *  cycle; its `handler` is the connector's sourceId, not an exposed method. */
const CONNECTOR_SURFACE = "connector";

type SchedulerRequest = Record<string, unknown> & { op: string };

function schedulerCall<T>(request: SchedulerRequest): Promise<T> {
  return invokeBackend<T>("script_scheduler", { request });
}

// ---------------------------------------------------------------------------
// The pump
// ---------------------------------------------------------------------------

let timer: ReturnType<typeof setInterval> | null = null;
/** Re-entrancy guard: a slow tick must not stack on the next interval. */
let ticking = false;

/**
 * One sweep: ask Rust what may run, run it, report each outcome back.
 *
 * Failures are reported, never thrown: a job whose handler throws is a normal
 * outcome (recorded + audited + re-armed), not a reason to stop the pump. The
 * `complete` report is what releases Rust's self-overlap guard, so it must
 * happen on BOTH paths — hence the try/finally-shaped await chain below.
 */
async function tick(): Promise<void> {
  if (ticking) return;
  ticking = true;
  try {
    const mountedScriptIds = listMountedHandles().map((h) => h.scriptId);
    const due = await schedulerCall<DueJob[]>({ op: "due", mountedScriptIds });
    if (!Array.isArray(due) || due.length === 0) return;

    // Sequential on purpose: scheduled work is background work, and firing a
    // batch of jobs concurrently is the fastest way to make an automated
    // workbook feel like a hung one.
    const { callExposedMethod } = await import("../scriptableObjects");
    // Dynamic: host.ts imports THIS module dynamically, so a static edge back
    // would close the cycle (and pull the whole host into the scheduler's graph).
    const { isScriptDebugPaused } = await import("./host");
    for (const job of due) {
      // A SCRIPT STOPPED AT A BREAKPOINT CANNOT RUN A JOB. Rust already handed
      // this job out and is holding its no-self-overlap slot open, so calling a
      // paused script would park the relay on METHOD_CALL_TIMEOUT_MS (30s) and,
      // worse, tell Rust "it ran" — the same lie the save/close verdict path
      // refuses to tell (see callWorkbookBeforeLifecycle). Report the skip
      // instead: the slot is released immediately, the job re-arms normally, and
      // the reason is visible in the audit trail rather than showing up as a
      // mysterious timeout.
      //
      // RESIDUAL RACE, stated rather than hidden: a script that pauses BETWEEN
      // this check and the relay still gets one call, which then times out. That
      // is the same window every debugger has, and the 30s bound contains it.
      if (isScriptDebugPaused(job.scriptId)) {
        try {
          await schedulerCall({
            op: "complete",
            jobId: job.id,
            ok: false,
            error: "skipped: script paused in debugger",
          });
        } catch {
          /* The Rust watchdog releases the job if this report is lost. */
        }
        continue;
      }
      let ok = true;
      let error: string | undefined;
      try {
        if (job.surface === CONNECTOR_SURFACE) {
          // A connector job runs the connector host's FEED cycle (fetch every
          // declared table, hand the rows to the volume-capped Rust gate).
          // That cycle enters the script realm through exactly the same
          // callExposedMethod call as everything else — this branch chooses
          // which host-side wrapper runs, not how script code is reached.
          const { refreshScriptConnector } = await import("../scriptConnectors");
          await refreshScriptConnector(job.handler);
        } else {
          await callExposedMethod(job.objectType, job.instanceId, job.handler);
        }
      } catch (e) {
        ok = false;
        error = e instanceof Error ? e.message : String(e);
        console.warn(
          `[scheduler] job ${job.id} (${job.scriptId} -> ${job.handler}) failed:`,
          error,
        );
      }
      try {
        await schedulerCall({ op: "complete", jobId: job.id, ok, error: error ?? null });
      } catch {
        /* The Rust watchdog releases the job if this report is lost. */
      }
    }
  } catch (e) {
    console.warn("[scheduler] tick failed:", e);
  } finally {
    ticking = false;
    void syncPump();
  }
}

/** Start the pump if it is not already running. */
function startPump(): void {
  if (timer != null) return;
  timer = setInterval(() => void tick(), TICK_MS);
}

/** Stop the pump (no jobs left / workbook closed). */
export function stopSchedulerPump(): void {
  if (timer != null) {
    clearInterval(timer);
    timer = null;
  }
}

/**
 * Run the pump iff this workbook has at least one job. Called after every
 * mutation and after every tick, so a workbook that cancels its last schedule
 * stops paying for a timer, and one that loads jobs from disk starts one
 * without anybody having to remember to.
 */
export async function syncPump(): Promise<void> {
  try {
    const jobs = await schedulerCall<ScheduledJob[]>({ op: "list" });
    if (Array.isArray(jobs) && jobs.length > 0) startPump();
    else stopSchedulerPump();
  } catch {
    /* best-effort; the next mutation re-syncs */
  }
}

// ---------------------------------------------------------------------------
// Registration (called by the host's cap.schedule* executors with the
// AUTHORITATIVE script identity — never with anything the script supplied)
// ---------------------------------------------------------------------------

export interface ScheduleOwner {
  scriptId: string;
  surface: string;
  objectType: string;
  instanceId: string | null;
}

/** Register (or re-arm) a fixed-interval job. */
export async function scheduleEvery(
  owner: ScheduleOwner,
  intervalSecs: number,
  handler: string,
  label?: string,
): Promise<ScheduledJob> {
  const job = await schedulerCall<ScheduledJob>({
    op: "every",
    scriptId: owner.scriptId,
    surface: owner.surface,
    objectType: owner.objectType,
    instanceId: owner.instanceId,
    handler,
    intervalSecs: Math.floor(intervalSecs),
    label: label ?? null,
  });
  void syncPump();
  return job;
}

/** Register (or re-arm) a daily job at a LOCAL "HH:MM". */
export async function scheduleAt(
  owner: ScheduleOwner,
  timeOfDay: string,
  handler: string,
  label?: string,
): Promise<ScheduledJob> {
  const [h, m] = timeOfDay.split(":");
  const job = await schedulerCall<ScheduledJob>({
    op: "at",
    scriptId: owner.scriptId,
    surface: owner.surface,
    objectType: owner.objectType,
    instanceId: owner.instanceId,
    handler,
    minuteOfDay: Number(h) * 60 + Number(m),
    label: label ?? null,
  });
  void syncPump();
  return job;
}

/** A script's OWN jobs (the `cap.scheduleList` answer). */
export function listScheduledJobsForScript(scriptId: string): Promise<ScheduledJob[]> {
  return schedulerCall<ScheduledJob[]>({ op: "list", scriptId });
}

/** Cancel one of a script's own jobs (owner-checked in Rust). */
export async function cancelScheduledJobForScript(
  scriptId: string,
  jobId: string,
): Promise<boolean> {
  const r = await schedulerCall<{ cancelled: boolean }>({ op: "cancel", scriptId, jobId });
  void syncPump();
  return r.cancelled === true;
}

// ---------------------------------------------------------------------------
// Trusted UI surface (transparency panel) — the user must always be able to
// SEE and STOP what runs in their own workbook. These pass no scriptId, so
// Rust's owner check does not constrain them.
// ---------------------------------------------------------------------------

/** EVERY scheduled job in this workbook, whatever script owns it. */
export function listAllScheduledJobs(): Promise<ScheduledJob[]> {
  return schedulerCall<ScheduledJob[]>({ op: "list" });
}

/** Cancel any job outright (the panel's Cancel button). */
export async function cancelScheduledJob(jobId: string): Promise<boolean> {
  const r = await schedulerCall<{ cancelled: boolean }>({ op: "cancel", jobId });
  void syncPump();
  return r.cancelled === true;
}

/** Pause/resume a job without forgetting it (the panel's toggle). */
export async function setScheduledJobEnabled(jobId: string, enabled: boolean): Promise<void> {
  await schedulerCall({ op: "setEnabled", jobId, enabled });
  void syncPump();
}
