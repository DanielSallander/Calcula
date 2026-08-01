//! FILENAME: app/src-tauri/src/scripting/scheduler.rs
//! PURPOSE: The persistent, consented job scheduler behind the `schedule`
//!          capability — Calcula's answer to VBA's `Application.OnTime`.
//!          Jobs live in the WORKBOOK (export_jobs/import_jobs are the .cala
//!          round-trip), so a nightly refresh or an end-of-day snapshot
//!          survives reload instead of dying with the renderer's setInterval.
//!
//! CONTEXT: docs/design/script-sandbox-architecture.md — the `schedule`
//!          capability is Rust-enforced (RUST_MIRRORED_CAPABILITIES), so the
//!          grant is re-checked HERE on every single firing. Revoking the
//!          capability stops the job at its next tick; it does not merely
//!          stop new registrations.
//!
//! SCOPE BOUNDARY — READ THIS BEFORE EXTENDING:
//! This is a "while Calcula is open" scheduler, NOT a headless agent. There is
//! deliberately no background process, no OS task-scheduler registration and no
//! wake-from-closed behaviour. The honest consent string says exactly that
//! ("run on a schedule while Calcula is open, without you starting it"), and
//! the capability must never quietly grow past it: a workbook that can run code
//! when the user is not looking at it is a different, much larger consent
//! decision than the one this capability asks for.
//!
//! WHO OWNS THE CLOCK: the renderer ticks (`op: "due"`), because the JS the job
//! invokes lives in a renderer worker realm and Rust cannot call into it. Rust
//! stays the AUTHORITY on everything that matters — what is persisted, what is
//! due, whether the grant still holds, whether a job may overlap itself, and
//! what gets audited. A compromised renderer can tick faster; it cannot make an
//! ungranted, unmounted or too-frequent job fire, because "due" re-derives all
//! of that from state Rust owns.

use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};

use calcula_format::features::scheduled_jobs::ScheduledJobDef;
use serde::{Deserialize, Serialize};
use tauri::State;

use crate::net_commands::record_capability_call;
use crate::scripting::CapabilityStore;

/// The capability id every op in this module re-checks.
pub const SCHEDULE_CAPABILITY: &str = "schedule";

/// Floor on how often a job may fire, in seconds.
///
/// 30s matches the pre-existing script-connector refresh floor
/// (`MIN_REFRESH_SECS` in @api/scriptConnectors) — that scheduler is folded
/// into this one, so the floor has to agree or adopting it would silently
/// speed a connector up. It is also the smallest interval where "background
/// automation" stays distinguishable from "a busy loop with extra steps".
pub const MIN_INTERVAL_SECS: u64 = 30;

/// Hard ceiling on jobs per workbook. A schedule is a persistent, consented
/// grant of the user's future CPU; an unbounded list of them is a resource
/// commitment nobody reviewed.
pub const MAX_JOBS: usize = 64;

/// Watchdog: a job still flagged "running" after this long is presumed dead
/// (its renderer never reported completion — worker crash, window reload
/// mid-run) and force-released, so a wedged run cannot silently retire a job
/// forever. Deliberately generous: a legitimate nightly refresh that pulls a
/// large dataset can run for minutes.
pub const MAX_RUN_MS: i64 = 10 * 60 * 1000;

/// Cadence discriminants (kept as validated strings rather than a serde enum so
/// the wire shape mirrors 1:1 into TS without tagged-union ceremony).
pub const CADENCE_EVERY: &str = "every";
pub const CADENCE_DAILY_AT: &str = "dailyAt";

// ---------------------------------------------------------------------------
// Job model
// ---------------------------------------------------------------------------

/// One persisted scheduled job.
///
/// `object_type` / `instance_id` / `handler` together name the EXPOSED method
/// the job invokes (`context.expose(...)`). That is the whole invocation
/// surface: a job can only ever call a method the script itself published, via
/// the same `callExposedMethod` path the connector host uses. There is no
/// second way in — a job cannot name arbitrary source, an arbitrary command, or
/// another script's private function.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ScheduledJob {
    /// Stable job id (`sched-<n>` minted here, or restored from the workbook).
    pub id: String,
    /// The OWNING script — supplied by the host from the authoritative script
    /// definition, never by the script itself.
    pub script_id: String,
    /// Script surface that registered the job ("object-script",
    /// "extension-worker", "connector", …). Recorded for the transparency
    /// panel and the audit trail.
    pub surface: String,
    /// Exposed-method address.
    pub object_type: String,
    pub instance_id: Option<String>,
    pub handler: String,
    /// CADENCE_EVERY or CADENCE_DAILY_AT.
    pub cadence: String,
    /// For CADENCE_EVERY: seconds between firings (>= MIN_INTERVAL_SECS).
    pub interval_secs: u64,
    /// For CADENCE_DAILY_AT: minutes since LOCAL midnight, [0, 1440).
    pub minute_of_day: u32,
    /// Epoch millis (UTC) of the next firing.
    pub next_run_ms: i64,
    /// A cancelled job is removed outright; `enabled: false` is the softer
    /// "paused by the user from the transparency panel" state.
    pub enabled: bool,
    /// Human label for the transparency panel (script-supplied, bounded).
    pub label: Option<String>,

    // ---- Runtime bookkeeping (persisted for the "last run" column, but
    // ---- `running` is always reset to false on import: an in-flight run
    // ---- cannot survive the process that was running it).
    /// Self-overlap guard: true between a "due" hand-out and its "complete".
    #[serde(default)]
    pub running: bool,
    /// When the current run started (epoch millis), for the watchdog.
    #[serde(default)]
    pub running_since_ms: i64,
    #[serde(default)]
    pub last_run_ms: i64,
    #[serde(default)]
    pub last_ok: bool,
    #[serde(default)]
    pub last_error: Option<String>,
    #[serde(default)]
    pub run_count: u64,
    /// Set once when a firing was skipped for a missing grant, so a revoked
    /// capability audits ONE denial instead of one per tick forever. Cleared on
    /// the next successful firing. Not persisted.
    #[serde(skip)]
    denial_logged: bool,
}

/// The subset handed to the renderer when a job comes due.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DueJob {
    pub id: String,
    pub script_id: String,
    /// Which host-side cycle wraps the call. "connector" jobs run the connector
    /// host's feed cycle (which itself enters the script realm through the very
    /// same callExposedMethod); everything else calls the exposed method
    /// directly. Script code is only ever entered one way either path.
    pub surface: String,
    pub object_type: String,
    pub instance_id: Option<String>,
    pub handler: String,
}

#[derive(Default)]
struct SchedulerInner {
    jobs: Vec<ScheduledJob>,
    seq: u64,
}

fn scheduler() -> &'static Mutex<SchedulerInner> {
    static SCHEDULER: OnceLock<Mutex<SchedulerInner>> = OnceLock::new();
    SCHEDULER.get_or_init(|| Mutex::new(SchedulerInner::default()))
}

fn now_ms() -> i64 {
    chrono::Utc::now().timestamp_millis()
}

// ---------------------------------------------------------------------------
// Cadence arithmetic
// ---------------------------------------------------------------------------

/// Next firing for a CADENCE_DAILY_AT job, as epoch millis, strictly after
/// `from_ms`. Computed in LOCAL time because "run at 06:30" means the user's
/// 06:30 — which also means a DST shift moves the job by an hour, exactly as
/// it does for every other wall-clock reminder the user owns.
fn next_daily_at_ms(minute_of_day: u32, from_ms: i64) -> i64 {
    use chrono::{Local, TimeZone};
    let from = match Local.timestamp_millis_opt(from_ms).single() {
        Some(t) => t,
        // Ambiguous/absent local time (a DST fold). Fall back to a plain
        // one-day push rather than guessing a wall-clock slot.
        None => return from_ms + 86_400_000,
    };
    let minute = minute_of_day.min(1439);
    for day_offset in 0..3 {
        let day = from.date_naive() + chrono::Duration::days(day_offset);
        let naive = match day.and_hms_opt(minute / 60, minute % 60, 0) {
            Some(n) => n,
            None => continue,
        };
        // A local time can be ambiguous (DST fall-back) or nonexistent
        // (spring-forward). Take the earliest valid instant; skip the day if
        // that wall-clock minute does not exist at all.
        if let Some(dt) = Local.from_local_datetime(&naive).earliest() {
            let ms = dt.timestamp_millis();
            if ms > from_ms {
                return ms;
            }
        }
    }
    from_ms + 86_400_000
}

/// Next firing for `job` strictly after `from_ms`.
///
/// For interval jobs the next run is measured from NOW, not from the previous
/// scheduled slot. That is the deliberate choice: it means a job that was due
/// while the app was closed fires ONCE on reopen and then settles, instead of
/// replaying every slot it missed as a burst.
fn compute_next_run(job: &ScheduledJob, from_ms: i64) -> i64 {
    if job.cadence == CADENCE_DAILY_AT {
        next_daily_at_ms(job.minute_of_day, from_ms)
    } else {
        from_ms + (job.interval_secs.max(MIN_INTERVAL_SECS) as i64) * 1000
    }
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

const MAX_ID_LEN: usize = 200;
const MAX_LABEL_LEN: usize = 200;

fn validate_registration(
    script_id: &str,
    handler: &str,
    cadence: &str,
    interval_secs: u64,
    minute_of_day: u32,
    label: &Option<String>,
) -> Result<(), String> {
    if script_id.is_empty() || script_id.len() > MAX_ID_LEN {
        return Err("scriptId must be a non-empty string".to_string());
    }
    if handler.is_empty() || handler.len() > MAX_ID_LEN {
        return Err("handler must be a non-empty exposed-method name".to_string());
    }
    match cadence {
        CADENCE_EVERY => {
            if interval_secs < MIN_INTERVAL_SECS {
                return Err(format!(
                    "interval must be at least {} seconds (got {})",
                    MIN_INTERVAL_SECS, interval_secs
                ));
            }
            // A year of seconds is well past any legitimate cadence and keeps
            // the millisecond arithmetic far from overflow.
            if interval_secs > 366 * 24 * 3600 {
                return Err("interval must be at most one year".to_string());
            }
        }
        CADENCE_DAILY_AT => {
            if minute_of_day >= 1440 {
                return Err("minuteOfDay must be in [0, 1440)".to_string());
            }
        }
        other => return Err(format!("unknown cadence '{}'", other)),
    }
    if let Some(l) = label {
        if l.len() > MAX_LABEL_LEN {
            return Err("label is too long".to_string());
        }
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// Core operations (pure over the job store — unit-tested directly)
// ---------------------------------------------------------------------------

/// Register or REPLACE a job. Identity is (script_id, object_type, instance_id,
/// handler, cadence-kind): re-registering the same handler on remount updates
/// the existing job in place instead of accumulating duplicates — the same
/// idempotent-install contract the connector host already relies on.
#[allow(clippy::too_many_arguments)]
fn upsert_job(
    inner: &mut SchedulerInner,
    script_id: &str,
    surface: &str,
    object_type: &str,
    instance_id: Option<String>,
    handler: &str,
    cadence: &str,
    interval_secs: u64,
    minute_of_day: u32,
    label: Option<String>,
    now: i64,
) -> Result<ScheduledJob, String> {
    validate_registration(script_id, handler, cadence, interval_secs, minute_of_day, &label)?;

    let existing = inner.jobs.iter().position(|j| {
        j.script_id == script_id
            && j.object_type == object_type
            && j.instance_id.as_deref() == instance_id.as_deref()
            && j.handler == handler
            && j.cadence == cadence
    });

    if existing.is_none() && inner.jobs.len() >= MAX_JOBS {
        return Err(format!(
            "too many scheduled jobs in this workbook (limit {})",
            MAX_JOBS
        ));
    }

    match existing {
        Some(idx) => {
            let job = &mut inner.jobs[idx];
            job.surface = surface.to_string();
            job.interval_secs = interval_secs;
            job.minute_of_day = minute_of_day;
            job.label = label;
            job.enabled = true;
            job.denial_logged = false;
            // Re-arm from now so a remount cannot be used to fire immediately
            // and repeatedly by re-registering in a loop.
            job.next_run_ms = compute_next_run(job, now);
            Ok(job.clone())
        }
        None => {
            inner.seq += 1;
            let mut job = ScheduledJob {
                id: format!("sched-{}", inner.seq),
                script_id: script_id.to_string(),
                surface: surface.to_string(),
                object_type: object_type.to_string(),
                instance_id,
                handler: handler.to_string(),
                cadence: cadence.to_string(),
                interval_secs,
                minute_of_day,
                next_run_ms: 0,
                enabled: true,
                label,
                running: false,
                running_since_ms: 0,
                last_run_ms: 0,
                last_ok: false,
                last_error: None,
                run_count: 0,
                denial_logged: false,
            };
            job.next_run_ms = compute_next_run(&job, now);
            inner.jobs.push(job.clone());
            Ok(job)
        }
    }
}

/// Remove a job. `owner` constrains the removal to that script's own jobs (a
/// script cancelling its own schedule); `None` is the TRUSTED UI path (the
/// transparency panel's Cancel button), which may cancel anything.
fn cancel_job(inner: &mut SchedulerInner, job_id: &str, owner: Option<&str>) -> bool {
    let before = inner.jobs.len();
    inner
        .jobs
        .retain(|j| j.id != job_id || owner.is_some_and(|o| j.script_id != o));
    inner.jobs.len() != before
}

/// The result of one `due` sweep: what to run, plus what was denied (already
/// audited by the caller that has the audit log).
struct DueSweep {
    due: Vec<DueJob>,
    /// (script_id, handler) pairs skipped because the grant is gone. Audited
    /// once per job until it next succeeds.
    denied: Vec<(String, String)>,
    /// Jobs force-released by the watchdog.
    watchdogged: Vec<(String, String)>,
}

/// Select the jobs that may fire right now.
///
/// Every gate that matters is re-derived here, in this order:
///   1. the job is enabled and actually due;
///   2. its owning script is MOUNTED in the calling renderer (an unmounted
///      script has no worker realm and no exposed method to call, and a
///      workbook whose scripts were never consented never mounts them — which
///      is what stops a hostile workbook from running jobs on open);
///   3. the job is not already running (self-overlap guard);
///   4. the `schedule` grant STILL holds for that script.
/// Only then is the job marked running and handed out.
fn sweep_due(
    inner: &mut SchedulerInner,
    mounted: &[String],
    is_granted: &dyn Fn(&str) -> bool,
    now: i64,
) -> DueSweep {
    let mut sweep = DueSweep { due: Vec::new(), denied: Vec::new(), watchdogged: Vec::new() };

    for job in inner.jobs.iter_mut() {
        // Watchdog first: release a run whose renderer never reported back, so
        // a single lost completion cannot retire the job permanently.
        if job.running && now - job.running_since_ms > MAX_RUN_MS {
            job.running = false;
            job.last_ok = false;
            job.last_error = Some("run did not report completion (timed out)".to_string());
            job.next_run_ms = compute_next_run(job, now);
            sweep.watchdogged.push((job.script_id.clone(), job.handler.clone()));
            continue;
        }
        if !job.enabled || job.running || job.next_run_ms > now {
            continue;
        }
        if !mounted.iter().any(|m| m == &job.script_id) {
            continue;
        }
        if !is_granted(&job.script_id) {
            // Push the slot forward so a revoked job does not spin, and audit
            // the refusal exactly once until it works again.
            job.next_run_ms = compute_next_run(job, now);
            if !job.denial_logged {
                job.denial_logged = true;
                sweep.denied.push((job.script_id.clone(), job.handler.clone()));
            }
            continue;
        }
        job.running = true;
        job.running_since_ms = now;
        job.denial_logged = false;
        sweep.due.push(DueJob {
            id: job.id.clone(),
            script_id: job.script_id.clone(),
            surface: job.surface.clone(),
            object_type: job.object_type.clone(),
            instance_id: job.instance_id.clone(),
            handler: job.handler.clone(),
        });
    }
    sweep
}

/// Record the outcome of a firing and re-arm the job.
fn complete_job(
    inner: &mut SchedulerInner,
    job_id: &str,
    ok: bool,
    error: Option<String>,
    now: i64,
) -> Option<ScheduledJob> {
    let job = inner.jobs.iter_mut().find(|j| j.id == job_id)?;
    job.running = false;
    job.running_since_ms = 0;
    job.last_run_ms = now;
    job.last_ok = ok;
    job.last_error = error;
    job.run_count += 1;
    job.next_run_ms = compute_next_run(job, now);
    Some(job.clone())
}

// ---------------------------------------------------------------------------
// Workbook persistence (the .cala round-trip)
// ---------------------------------------------------------------------------
//
// THE THREAT MODEL, WRITTEN DOWN, BECAUSE A PERSISTED JOB IS "CODE THAT RUNS
// WHEN A WORKBOOK IS OPENED":
//
// 1. WHY THE WORKBOOK IS THE RIGHT HOME AT ALL. A job addresses
//    (script_id, object_type, instance_id, handler) — four workbook-scoped
//    identities. In a user-profile store those names would be meaningless for
//    every other document, and worse, ambiguous ACROSS documents: two workbooks
//    with an object script called "refresh" would collide into one schedule.
//    The consent string the user actually agreed to also says it out loud —
//    "saved in this workbook, so it resumes next time you open it" — so the
//    workbook is both the correct engineering home and the promised one.
//
//    The obvious objection to a workbook home is "then a shared workbook
//    carries jobs to other people". It does — as a PROPOSAL, never as an
//    authorization, which is exactly the status the workbook already gives the
//    script source sitting next to it. See gate (3).
//
// 2. RESTORING GRANTS NOTHING. `import_jobs_for_workbook` writes into the job
//    list and touches nothing else. It never calls CapabilityStore::grant, and
//    it cannot: the store is in-memory, starts empty every launch, and is
//    populated only by the main-window consent flow. So the state a restored
//    job needs in order to fire literally does not exist yet at load time.
//
// 3. FOUR INDEPENDENT GATES STAND BETWEEN "RESTORED" AND "FIRED", and three of
//    them are Rust-authoritative:
//      a. Script Security "disabled" -> `due` returns [] regardless of what is
//         stored (the global off switch outranks any stored consent);
//      b. the owning script must be MOUNTED, which for an unconsented workbook
//         never happens — mounting IS the consent decision;
//      c. the live `schedule` grant is re-checked per firing against the
//         CapabilityStore, so an unconsented (or revoked) script is skipped and
//         audited;
//      d. the job must have survived load-time reconciliation below.
//    None of these is stored in the file, so no amount of editing the file can
//    turn them off.
//
// 4. LOAD-TIME RECONCILIATION binds a job to the exact code that was consented
//    to. A job is dropped unless its owning script is carried by THIS workbook
//    AND that script's source still hashes to what it hashed to when the job
//    was saved. A deleted script, a renamed id, an edited body, or a swapped
//    implementation therefore all disarm the job instead of silently redirecting
//    the timer at new code. The same rule runs on the way OUT (`export`), so we
//    never write a job we would refuse to read back.
//
// 5. .calp CANNOT USE THIS AS AN AUTO-RUN VECTOR. The section lives in the
//    workbook's `user_files` map, and `user_files` is excluded from .calp by
//    publish policy — the `calp` crate never reads `Workbook::user_files` at
//    all, so there is no code path that could copy a schedule into a package.
//    A distributed script therefore reaches a subscriber with exactly the reach
//    it has today: it must be consented at the subscriber's own prompt, must
//    declare `schedule` within its capability ceiling, and only then can it
//    register a job — locally, in the subscriber's own workbook, under the
//    subscriber's own grant. Persisted schedules add nothing to what
//    distributed-script consent already permits. Storing the section in
//    `user_files` rather than as a typed `Workbook` field is what makes that a
//    STRUCTURAL property instead of a rule someone has to keep re-checking.

/// Why a persisted job was refused at load. Surfaced in the audit trail so a
/// disarmed schedule is visible rather than mysterious.
#[derive(Debug, Clone)]
pub struct DroppedJob {
    pub script_id: String,
    pub handler: String,
    pub reason: String,
}

/// Result of restoring a workbook's schedule.
#[derive(Debug, Default)]
pub struct JobImportOutcome {
    pub restored: usize,
    pub dropped: Vec<DroppedJob>,
}

/// Convert a live job to its persisted form, binding it to `script_hash`.
fn job_to_def(job: &ScheduledJob, script_hash: &str) -> ScheduledJobDef {
    ScheduledJobDef {
        id: job.id.clone(),
        script_id: job.script_id.clone(),
        script_hash: script_hash.to_string(),
        surface: job.surface.clone(),
        object_type: job.object_type.clone(),
        instance_id: job.instance_id.clone(),
        handler: job.handler.clone(),
        cadence: job.cadence.clone(),
        interval_secs: job.interval_secs,
        minute_of_day: job.minute_of_day,
        next_run_ms: job.next_run_ms,
        enabled: job.enabled,
        label: job.label.clone(),
        last_run_ms: job.last_run_ms,
        last_ok: job.last_ok,
        last_error: job.last_error.clone(),
        run_count: job.run_count,
    }
}

/// Every job that this workbook is entitled to carry, for the .cala writer.
///
/// `script_hashes` maps script id -> SHA-256 of the source the workbook is
/// about to persist. A job whose owning script is NOT in that map is not
/// written: the schedule of a script the workbook does not carry (a 3rd-party
/// extension worker, say) is session-scoped by construction, because there is
/// no honest way for this document to vouch for code it does not contain — and
/// the same id on another machine could name entirely different code. Writing
/// it anyway would only produce a row the load path is obliged to drop.
pub fn export_jobs_for_workbook(script_hashes: &HashMap<String, String>) -> Vec<ScheduledJobDef> {
    let inner = scheduler().lock().unwrap();
    inner
        .jobs
        .iter()
        .filter_map(|job| script_hashes.get(&job.script_id).map(|h| job_to_def(job, h)))
        .collect()
}

/// Replace the job list from a loaded workbook.
///
/// This is the ONLY way jobs enter the registry from disk, and it is a pure
/// state replacement: it grants nothing, mounts nothing, and starts nothing.
///
/// Every row is treated as untrusted input, because a `.cala` is a file and a
/// file can be hand-edited or hostile:
///   * the owning script must be carried by THIS workbook, and its source must
///     still hash to what it hashed to at save time (gate 4 above) — otherwise
///     the job is dropped and the refusal audited;
///   * an unknown cadence, an empty script/handler, or a duplicate id is
///     dropped outright;
///   * an interval below `MIN_INTERVAL_SECS` is raised back to the floor and an
///     out-of-range `minute_of_day` is clamped, so the file cannot buy a faster
///     schedule than the live API would have allowed;
///   * `running` never comes back true — a run cannot outlive its process, and a
///     stuck "running" would wedge the job behind its own overlap guard;
///   * the list is capped at `MAX_JOBS`.
///
/// A due-in-the-past job keeps its stale timestamp on purpose: it fires ONCE
/// shortly after the workbook opens — subject to every gate above — which is
/// the "the nightly job did not run while you were away" behaviour users
/// expect, and is why `compute_next_run` measures from now rather than
/// replaying missed slots.
pub fn import_jobs_for_workbook(
    defs: Vec<ScheduledJobDef>,
    script_hashes: &HashMap<String, String>,
) -> JobImportOutcome {
    let mut outcome = JobImportOutcome::default();
    let mut inner = scheduler().lock().unwrap();
    // Wholesale replacement: the previous workbook's schedule must never leak
    // into this one (it would otherwise be saved into a document that never
    // agreed to it).
    inner.jobs.clear();
    inner.seq = 0;

    let mut max_seq = 0u64;
    let mut seen_ids: std::collections::HashSet<String> = std::collections::HashSet::new();

    for def in defs {
        // One refusal ladder, evaluated before anything is moved out of `def`,
        // so every drop reason reaches the audit trail with the job's identity
        // still intact.
        let refusal: Option<&str> = if def.cadence != CADENCE_EVERY && def.cadence != CADENCE_DAILY_AT
        {
            Some("unknown cadence")
        } else if def.script_id.is_empty() || def.handler.is_empty() || def.id.is_empty() {
            Some("job is missing its script, handler or id")
        } else {
            match script_hashes.get(&def.script_id) {
                None => Some("the owning script is no longer in this workbook"),
                // Consent was given to a specific body of code. New code needs
                // a new decision, so the schedule disarms rather than silently
                // pointing the timer at something the user never approved.
                Some(current) if *current != def.script_hash => {
                    Some("the owning script's source changed since the schedule was saved")
                }
                Some(_) if !seen_ids.insert(def.id.clone()) => Some("duplicate job id"),
                Some(_) if inner.jobs.len() >= MAX_JOBS => {
                    Some("workbook exceeds the scheduled-job limit")
                }
                Some(_) => None,
            }
        };
        if let Some(reason) = refusal {
            outcome.dropped.push(DroppedJob {
                script_id: def.script_id.clone(),
                handler: def.handler.clone(),
                reason: reason.to_string(),
            });
            continue;
        }

        if let Some(n) = def.id.strip_prefix("sched-").and_then(|s| s.parse::<u64>().ok()) {
            max_seq = max_seq.max(n);
        }
        inner.jobs.push(ScheduledJob {
            id: def.id,
            script_id: def.script_id,
            surface: def.surface,
            object_type: def.object_type,
            instance_id: def.instance_id,
            handler: def.handler,
            interval_secs: if def.cadence == CADENCE_EVERY {
                def.interval_secs.max(MIN_INTERVAL_SECS)
            } else {
                def.interval_secs
            },
            minute_of_day: if def.minute_of_day >= 1440 { 0 } else { def.minute_of_day },
            cadence: def.cadence,
            next_run_ms: def.next_run_ms,
            enabled: def.enabled,
            label: def.label,
            running: false,
            running_since_ms: 0,
            last_run_ms: def.last_run_ms,
            last_ok: def.last_ok,
            last_error: def.last_error,
            run_count: def.run_count,
            denial_logged: false,
        });
        outcome.restored += 1;
    }

    // Continue the id sequence past anything restored, so a new job in this
    // session can never collide with a persisted one.
    inner.seq = max_seq;
    outcome
}

/// Whether this workbook currently schedules anything. Used by the "Save As
/// xlsx" fidelity report: xlsx has nowhere to keep a schedule, so saving there
/// disarms every job and the user has to be told before it happens.
pub fn has_scheduled_jobs() -> bool {
    !scheduler().lock().unwrap().jobs.is_empty()
}

/// Drop every job (workbook close / new workbook).
pub fn reset_jobs() {
    let mut inner = scheduler().lock().unwrap();
    inner.jobs.clear();
    inner.seq = 0;
}

/// Drop a script's jobs entirely — called when a script is DELETED (not merely
/// unmounted; unmount just stops it from being due).
pub fn remove_script_jobs(script_id: &str) {
    let mut inner = scheduler().lock().unwrap();
    inner.jobs.retain(|j| j.script_id != script_id);
}

// ---------------------------------------------------------------------------
// The single multiplexed Tauri command
// ---------------------------------------------------------------------------

/// Request payload for `script_scheduler`. One command, an `op` discriminant —
/// the same shape `bi_script_source` uses, and for the same reason: the app's
/// `generate_handler!` dispatch frame is a Windows stack-headroom budget (see
/// build.rs `/STACK`), so a new subsystem buys ONE command, not eight.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SchedulerRequest {
    /// "every" | "at" | "list" | "cancel" | "setEnabled" | "due" | "complete"
    pub op: String,
    /// Owning script id — REQUIRED for every op a script can reach. The host
    /// fills it from the authoritative script definition.
    #[serde(default)]
    pub script_id: Option<String>,
    #[serde(default)]
    pub surface: Option<String>,
    #[serde(default)]
    pub object_type: Option<String>,
    #[serde(default)]
    pub instance_id: Option<String>,
    #[serde(default)]
    pub handler: Option<String>,
    #[serde(default)]
    pub interval_secs: Option<u64>,
    #[serde(default)]
    pub minute_of_day: Option<u32>,
    #[serde(default)]
    pub label: Option<String>,
    #[serde(default)]
    pub job_id: Option<String>,
    #[serde(default)]
    pub enabled: Option<bool>,
    /// "due": the script ids currently MOUNTED in the calling renderer.
    #[serde(default)]
    pub mounted_script_ids: Option<Vec<String>>,
    /// "complete": outcome of the firing.
    #[serde(default)]
    pub ok: Option<bool>,
    #[serde(default)]
    pub error: Option<String>,
}

/// Register / inspect / cancel / drive persistent scheduled jobs.
///
/// SECURITY, in the order it is enforced:
///  * main-window only (a secondary webview cannot schedule anything);
///  * Script Security "disabled" hard-stops every firing, whatever is persisted
///    — the global off switch outranks a stored consent;
///  * the `schedule` grant is re-checked from the authoritative CapabilityStore
///    on registration AND on every firing, so a revoke takes effect at the next
///    tick rather than at the next reload;
///  * `list` is deliberately UNGATED for the trusted UI (no script_id): the
///    user must always be able to SEE and CANCEL what runs in their workbook,
///    and a transparency surface that a revoked grant could blank out would
///    defeat its own purpose.
#[tauri::command]
pub fn script_scheduler(
    cap_store: State<'_, CapabilityStore>,
    script_state: State<'_, crate::scripting::types::ScriptState>,
    app_state: State<'_, crate::AppState>,
    request: SchedulerRequest,
    window: tauri::Window,
) -> Result<serde_json::Value, String> {
    crate::security::window_guard::require_label(&window, crate::security::window_guard::MAIN)?;
    let now = now_ms();

    // Ops a SCRIPT can reach carry a script_id and re-check the grant. `list`,
    // `cancel` without a script_id, and `setEnabled` are the trusted-UI paths.
    let script_op = matches!(request.op.as_str(), "every" | "at");
    if script_op {
        let script_id = request
            .script_id
            .as_deref()
            .ok_or_else(|| "scriptId is required".to_string())?;
        if !cap_store.is_granted(script_id, SCHEDULE_CAPABILITY) {
            crate::log_warn!(
                "SECURITY",
                "script_scheduler DENIED (schedule not granted): script={} op={}",
                script_id,
                request.op
            );
            record_capability_call(
                &app_state.audit_log,
                SCHEDULE_CAPABILITY,
                script_id,
                false,
                Some(&request.op),
                Some("schedule not granted"),
            );
            return Err("PermissionDenied: schedule not granted for this script".to_string());
        }
    }

    match request.op.as_str() {
        // ---- Registration -------------------------------------------------
        "every" | "at" => {
            let script_id = request.script_id.clone().unwrap_or_default();
            let cadence = if request.op == "at" { CADENCE_DAILY_AT } else { CADENCE_EVERY };
            let job = {
                let mut inner = scheduler().lock().unwrap();
                upsert_job(
                    &mut inner,
                    &script_id,
                    request.surface.as_deref().unwrap_or("object-script"),
                    request.object_type.as_deref().unwrap_or(""),
                    request.instance_id.clone(),
                    request.handler.as_deref().unwrap_or(""),
                    cadence,
                    request.interval_secs.unwrap_or(MIN_INTERVAL_SECS),
                    request.minute_of_day.unwrap_or(0),
                    request.label.clone(),
                    now,
                )
            };
            match job {
                Ok(j) => {
                    record_capability_call(
                        &app_state.audit_log,
                        SCHEDULE_CAPABILITY,
                        &script_id,
                        true,
                        Some(&format!("scheduled {} ({})", j.handler, j.cadence)),
                        None,
                    );
                    serde_json::to_value(j).map_err(|e| e.to_string())
                }
                Err(e) => {
                    record_capability_call(
                        &app_state.audit_log,
                        SCHEDULE_CAPABILITY,
                        &script_id,
                        false,
                        Some(&request.op),
                        Some(&e),
                    );
                    Err(e)
                }
            }
        }

        // ---- Transparency + user control ----------------------------------
        "list" => {
            let inner = scheduler().lock().unwrap();
            let jobs: Vec<&ScheduledJob> = match request.script_id.as_deref() {
                Some(sid) => inner.jobs.iter().filter(|j| j.script_id == sid).collect(),
                None => inner.jobs.iter().collect(),
            };
            serde_json::to_value(jobs).map_err(|e| e.to_string())
        }
        "cancel" => {
            let job_id = request
                .job_id
                .as_deref()
                .ok_or_else(|| "jobId is required".to_string())?;
            let removed = {
                let mut inner = scheduler().lock().unwrap();
                cancel_job(&mut inner, job_id, request.script_id.as_deref())
            };
            if removed {
                record_capability_call(
                    &app_state.audit_log,
                    SCHEDULE_CAPABILITY,
                    request.script_id.as_deref().unwrap_or(""),
                    true,
                    Some(&format!("cancelled job {}", job_id)),
                    None,
                );
            }
            Ok(serde_json::json!({ "cancelled": removed }))
        }
        "setEnabled" => {
            let job_id = request
                .job_id
                .as_deref()
                .ok_or_else(|| "jobId is required".to_string())?;
            let enabled = request.enabled.unwrap_or(true);
            // Scoped so the registry lock is released before the audit write:
            // pausing is a user GOVERNANCE action and must be recorded on the
            // same trail as `cancel`, but never while holding the scheduler.
            let toggled = {
                let mut inner = scheduler().lock().unwrap();
                match inner.jobs.iter_mut().find(|j| j.id == job_id) {
                    Some(job) => {
                        job.enabled = enabled;
                        if enabled {
                            job.denial_logged = false;
                            job.next_run_ms = compute_next_run(job, now);
                        }
                        Some((job.script_id.clone(), job.handler.clone()))
                    }
                    None => None,
                }
            };
            match toggled {
                Some((script_id, handler)) => {
                    // Symmetric with the `cancel` arm: "one audit trail spans
                    // all script activity" is false the moment a user action
                    // that starts or stops automation leaves no entry.
                    record_capability_call(
                        &app_state.audit_log,
                        SCHEDULE_CAPABILITY,
                        &script_id,
                        true,
                        Some(&format!(
                            "{} job {} ({})",
                            if enabled { "resumed" } else { "paused" },
                            job_id,
                            handler
                        )),
                        None,
                    );
                    Ok(serde_json::json!({ "enabled": enabled }))
                }
                None => Err(format!("no such scheduled job: {}", job_id)),
            }
        }

        // ---- The firing loop (renderer-ticked, Rust-authorized) -----------
        "due" => {
            // The global off switch outranks every stored consent.
            let level = script_state
                .security_level
                .lock()
                .map(|l| l.clone())
                .unwrap_or_else(|_| "prompt".to_string());
            if level == "disabled" {
                return Ok(serde_json::json!([]));
            }
            let mounted = request.mounted_script_ids.clone().unwrap_or_default();
            let sweep = {
                let mut inner = scheduler().lock().unwrap();
                let granted = |sid: &str| cap_store.is_granted(sid, SCHEDULE_CAPABILITY);
                sweep_due(&mut inner, &mounted, &granted, now)
            };
            for (script_id, handler) in &sweep.denied {
                crate::log_warn!(
                    "SECURITY",
                    "script_scheduler: job skipped (schedule revoked): script={} handler={}",
                    script_id,
                    handler
                );
                record_capability_call(
                    &app_state.audit_log,
                    SCHEDULE_CAPABILITY,
                    script_id,
                    false,
                    Some(&format!("scheduled run of {}", handler)),
                    Some("schedule not granted (revoked)"),
                );
            }
            for (script_id, handler) in &sweep.watchdogged {
                record_capability_call(
                    &app_state.audit_log,
                    SCHEDULE_CAPABILITY,
                    script_id,
                    false,
                    Some(&format!("scheduled run of {}", handler)),
                    Some("run did not report completion (timed out)"),
                );
            }
            for job in &sweep.due {
                record_capability_call(
                    &app_state.audit_log,
                    SCHEDULE_CAPABILITY,
                    &job.script_id,
                    true,
                    Some(&format!("scheduled run of {}", job.handler)),
                    None,
                );
            }
            serde_json::to_value(sweep.due).map_err(|e| e.to_string())
        }
        "complete" => {
            let job_id = request
                .job_id
                .as_deref()
                .ok_or_else(|| "jobId is required".to_string())?;
            let ok = request.ok.unwrap_or(false);
            let completed = {
                let mut inner = scheduler().lock().unwrap();
                complete_job(&mut inner, job_id, ok, request.error.clone(), now)
            };
            match completed {
                Some(job) => {
                    if !ok {
                        record_capability_call(
                            &app_state.audit_log,
                            SCHEDULE_CAPABILITY,
                            &job.script_id,
                            false,
                            Some(&format!("scheduled run of {}", job.handler)),
                            request.error.as_deref().or(Some("job failed")),
                        );
                    }
                    Ok(serde_json::json!({ "nextRunMs": job.next_run_ms }))
                }
                None => Ok(serde_json::json!({ "nextRunMs": 0 })),
            }
        }

        other => Err(format!("unknown scheduler op '{}'", other)),
    }
}

// ---------------------------------------------------------------------------
// Tests — the store logic is pure over SchedulerInner, so every guarantee the
// capability makes is testable without a Tauri app handle.
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    fn inner() -> SchedulerInner {
        SchedulerInner::default()
    }

    fn add(inner: &mut SchedulerInner, script: &str, handler: &str, secs: u64, now: i64) -> ScheduledJob {
        upsert_job(
            inner, script, "object-script", "shape", Some("i1".into()), handler,
            CADENCE_EVERY, secs, 0, None, now,
        )
        .expect("job should register")
    }

    const GRANTED: &dyn Fn(&str) -> bool = &|_: &str| true;
    const REVOKED: &dyn Fn(&str) -> bool = &|_: &str| false;

    /// The job registry is a process-global singleton, so the tests that drive
    /// it through the REAL persistence entry points have to run one at a time.
    /// Without this they interleave and the failures look like logic bugs.
    ///
    /// It used to be a `static LOCK` DECLARED HERE — and `persistence.rs`'s
    /// scheduled-job tests declared their own, separate one. Two mutexes over
    /// one registry, in the same test binary: each module was serialized against
    /// itself and neither against the other, so a `reset_jobs()` here would land
    /// in the middle of a save/reload round-trip there. That flake reproduced
    /// only under `cargo test`'s default parallelism and vanished under
    /// `--test-threads=1`. There is now exactly ONE lock, and both modules take
    /// it.
    fn global_guard() -> std::sync::MutexGuard<'static, ()> {
        crate::persistence::scheduler_test_guard()
    }

    /// The live job list (the `list` op's view), for assertions.
    fn live_jobs() -> Vec<ScheduledJob> {
        scheduler().lock().unwrap().jobs.clone()
    }

    fn hashes(pairs: &[(&str, &str)]) -> HashMap<String, String> {
        pairs
            .iter()
            .map(|(id, source)| {
                (
                    (*id).to_string(),
                    calp::integrity::sha256_hex(source.as_bytes()),
                )
            })
            .collect()
    }

    #[test]
    fn minimum_interval_is_enforced_on_registration() {
        let mut i = inner();
        let err = upsert_job(
            &mut i, "s1", "object-script", "shape", None, "tick",
            CADENCE_EVERY, 5, 0, None, 0,
        )
        .unwrap_err();
        assert!(err.contains("at least 30 seconds"), "got: {}", err);
        assert!(i.jobs.is_empty(), "a rejected job must not be stored");

        // Exactly at the floor is fine.
        assert!(upsert_job(
            &mut i, "s1", "object-script", "shape", None, "tick",
            CADENCE_EVERY, MIN_INTERVAL_SECS, 0, None, 0,
        )
        .is_ok());
    }

    #[test]
    fn a_job_never_overlaps_itself() {
        let mut i = inner();
        let now = 1_000_000;
        add(&mut i, "s1", "tick", 30, now);
        let mounted = vec!["s1".to_string()];

        // Due after the interval elapses.
        let t1 = now + 30_000;
        let sweep = sweep_due(&mut i, &mounted, GRANTED, t1);
        assert_eq!(sweep.due.len(), 1, "job should fire once due");

        // While it is still running, no further tick may hand it out again —
        // this is the guard that stops a slow nightly refresh from stacking.
        let sweep2 = sweep_due(&mut i, &mounted, GRANTED, t1 + 60_000);
        assert!(sweep2.due.is_empty(), "a running job must not be re-issued");

        // Only after completion does it become eligible again.
        let job_id = i.jobs[0].id.clone();
        complete_job(&mut i, &job_id, true, None, t1 + 61_000);
        let sweep3 = sweep_due(&mut i, &mounted, GRANTED, t1 + 61_000 + 30_000);
        assert_eq!(sweep3.due.len(), 1, "a completed job re-arms");
    }

    #[test]
    fn the_grant_is_rechecked_at_every_fire_and_a_revoke_stops_it() {
        let mut i = inner();
        let now = 1_000_000;
        add(&mut i, "s1", "tick", 30, now);
        let mounted = vec!["s1".to_string()];

        // Granted: fires.
        let t1 = now + 30_000;
        assert_eq!(sweep_due(&mut i, &mounted, GRANTED, t1).due.len(), 1);
        let job_id = i.jobs[0].id.clone();
        complete_job(&mut i, &job_id, true, None, t1);

        // Revoked: the SAME persisted, enabled job stops firing — the grant is
        // consulted per firing, not merely at registration.
        let t2 = t1 + 30_000;
        let sweep = sweep_due(&mut i, &mounted, REVOKED, t2);
        assert!(sweep.due.is_empty(), "a revoked grant must stop the job");
        assert_eq!(sweep.denied.len(), 1, "the refusal is audited");
        assert!(i.jobs[0].enabled, "the job is skipped, not silently deleted");

        // ...and it does not spin: the denial audits ONCE, not every tick.
        let sweep2 = sweep_due(&mut i, &mounted, REVOKED, t2 + 60_000);
        assert!(sweep2.due.is_empty());
        assert!(sweep2.denied.is_empty(), "denial must not be re-audited every tick");

        // Re-granting resumes it.
        let sweep3 = sweep_due(&mut i, &mounted, GRANTED, t2 + 120_000);
        assert_eq!(sweep3.due.len(), 1, "a re-granted job resumes");
    }

    #[test]
    fn an_unmounted_script_never_fires() {
        let mut i = inner();
        let now = 1_000_000;
        add(&mut i, "s1", "tick", 30, now);
        // Nothing mounted: a workbook whose scripts were never consented (and
        // so never mounted) must not start running jobs on open.
        let sweep = sweep_due(&mut i, &[], GRANTED, now + 60_000);
        assert!(sweep.due.is_empty(), "an unmounted script has nothing to call");
        // A DIFFERENT script being mounted does not help.
        let sweep2 = sweep_due(&mut i, &["other".to_string()], GRANTED, now + 60_000);
        assert!(sweep2.due.is_empty());
    }

    #[test]
    fn cancel_removes_the_job_and_is_owner_checked() {
        let mut i = inner();
        add(&mut i, "s1", "tick", 30, 0);
        let job_id = i.jobs[0].id.clone();

        // A different script cannot cancel someone else's schedule.
        assert!(!cancel_job(&mut i, &job_id, Some("s2")));
        assert_eq!(i.jobs.len(), 1);

        // The owner can.
        assert!(cancel_job(&mut i, &job_id, Some("s1")));
        assert!(i.jobs.is_empty());

        // A cancelled job never fires again.
        let sweep = sweep_due(&mut i, &["s1".to_string()], GRANTED, 10_000_000);
        assert!(sweep.due.is_empty());
    }

    #[test]
    fn deleting_a_script_removes_exactly_its_own_jobs() {
        // `remove_script_jobs` is what object_script_commands calls when a
        // script is DELETED (not merely unmounted). A deleted script's job can
        // neither fire nor persist, but it would otherwise linger in the
        // transparency panel as a live-looking job for code that is gone.
        let _g = global_guard();
        reset_jobs();
        {
            let mut inner = scheduler().lock().unwrap();
            add(&mut inner, "doomed", "tick", 30, 0);
            add(&mut inner, "doomed", "other", 60, 0);
            add(&mut inner, "survivor", "tick", 30, 0);
        }
        assert_eq!(live_jobs().len(), 3);

        remove_script_jobs("doomed");

        let left = live_jobs();
        assert_eq!(left.len(), 1, "only the surviving script's job may remain");
        assert_eq!(left[0].script_id, "survivor");

        // Removing an unknown script is a no-op, not a panic or a mass wipe.
        remove_script_jobs("never-existed");
        assert_eq!(live_jobs().len(), 1);
        reset_jobs();
    }

    #[test]
    fn trusted_ui_cancel_needs_no_owner() {
        let mut i = inner();
        add(&mut i, "s1", "tick", 30, 0);
        let job_id = i.jobs[0].id.clone();
        // The transparency panel's Cancel passes no script_id — the user can
        // always stop anything running in their own workbook.
        assert!(cancel_job(&mut i, &job_id, None));
        assert!(i.jobs.is_empty());
    }

    #[test]
    fn persistence_round_trip_preserves_the_schedule() {
        let _g = global_guard();
        reset_jobs();
        let now = 1_700_000_000_000;
        let sources = hashes(&[("s1", "export function nightly() {}"), ("s2", "feed()")]);
        {
            let mut i = scheduler().lock().unwrap();
            upsert_job(
                &mut i, "s1", "object-script", "shape", Some("i1".into()), "nightly",
                CADENCE_DAILY_AT, 0, 390, Some("Nightly refresh".into()), now,
            )
            .unwrap();
            upsert_job(
                &mut i, "s2", "connector", "shape", None, "fetchTable",
                CADENCE_EVERY, 300, 0, None, now,
            )
            .unwrap();
            // Simulate a run in flight when the workbook is saved.
            i.jobs[1].running = true;
            i.jobs[1].running_since_ms = now;
        }

        let saved = export_jobs_for_workbook(&sources);
        assert_eq!(saved.len(), 2);
        assert_eq!(saved[0].script_hash, sources["s1"], "the job is bound to its script's source");
        reset_jobs();
        assert!(live_jobs().is_empty(), "reset clears the store");

        let outcome = import_jobs_for_workbook(saved.clone(), &sources);
        assert_eq!(outcome.restored, 2, "both jobs survive the round-trip");
        assert!(outcome.dropped.is_empty());
        let restored = live_jobs();

        let nightly = restored.iter().find(|j| j.handler == "nightly").unwrap();
        assert_eq!(nightly.cadence, CADENCE_DAILY_AT);
        assert_eq!(nightly.minute_of_day, 390);
        assert_eq!(nightly.label.as_deref(), Some("Nightly refresh"));
        assert_eq!(nightly.next_run_ms, saved[0].next_run_ms, "the slot is preserved");

        let feed = restored.iter().find(|j| j.handler == "fetchTable").unwrap();
        assert_eq!(feed.interval_secs, 300);
        assert!(!feed.running, "an in-flight run must not survive the process");

        reset_jobs();
    }

    #[test]
    fn import_sanitizes_untrusted_file_content() {
        let _g = global_guard();
        reset_jobs();
        let sources = hashes(&[("s1", "src")]);
        let mut too_fast = ScheduledJobDef {
            id: "sched-9".into(), script_id: "s1".into(),
            script_hash: sources["s1"].clone(), surface: "object-script".into(),
            object_type: "shape".into(), instance_id: None, handler: "tick".into(),
            cadence: CADENCE_EVERY.into(), interval_secs: 1, minute_of_day: 0,
            next_run_ms: 0, enabled: true, label: None,
            last_run_ms: 0, last_ok: false, last_error: None, run_count: 0,
        };
        let bogus_cadence = ScheduledJobDef {
            id: "sched-11".into(),
            cadence: "wheneverIFeelLikeIt".into(),
            ..too_fast.clone()
        };
        let no_handler = ScheduledJobDef {
            id: "sched-12".into(),
            handler: String::new(),
            ..too_fast.clone()
        };
        too_fast.minute_of_day = 99_999;

        let outcome = import_jobs_for_workbook(
            vec![too_fast, bogus_cadence, no_handler],
            &sources,
        );
        let jobs = live_jobs();
        assert_eq!(outcome.restored, 1, "unknown cadence and handler-less rows are dropped");
        assert_eq!(outcome.dropped.len(), 2);
        assert_eq!(jobs.len(), 1);
        assert_eq!(jobs[0].interval_secs, MIN_INTERVAL_SECS, "the floor is re-applied on load");
        assert_eq!(jobs[0].minute_of_day, 0, "an out-of-range minute is clamped");
        assert!(!jobs[0].running, "a file can never assert an in-flight run");

        // The id sequence continues past the restored ids, so a new job in this
        // session cannot collide with a persisted one.
        {
            let mut i = scheduler().lock().unwrap();
            let fresh = add(&mut i, "s1", "other", 30, 0);
            assert_eq!(fresh.id, "sched-10");
        }
        reset_jobs();
    }

    #[test]
    fn a_job_whose_script_is_gone_is_dropped_on_load() {
        let _g = global_guard();
        reset_jobs();
        let sources = hashes(&[("s1", "src")]);
        {
            let mut i = scheduler().lock().unwrap();
            add(&mut i, "s1", "tick", 30, 0);
        }
        let saved = export_jobs_for_workbook(&sources);
        assert_eq!(saved.len(), 1);
        reset_jobs();

        // The workbook now carries a DIFFERENT set of scripts: s1 was deleted.
        let outcome = import_jobs_for_workbook(saved, &hashes(&[("s2", "other")]));
        assert_eq!(outcome.restored, 0, "an orphaned job must not be restored");
        assert!(live_jobs().is_empty());
        assert_eq!(outcome.dropped.len(), 1);
        assert!(
            outcome.dropped[0].reason.contains("no longer in this workbook"),
            "got: {}",
            outcome.dropped[0].reason
        );
        reset_jobs();
    }

    #[test]
    fn a_job_whose_script_source_changed_is_dropped_on_load() {
        let _g = global_guard();
        reset_jobs();
        let before = hashes(&[("s1", "export function tick() { refresh(); }")]);
        {
            let mut i = scheduler().lock().unwrap();
            add(&mut i, "s1", "tick", 30, 0);
        }
        let saved = export_jobs_for_workbook(&before);
        reset_jobs();

        // Same script id, different body. Consent was for the OLD body, so the
        // schedule disarms instead of pointing the timer at unreviewed code.
        let after = hashes(&[("s1", "export function tick() { exfiltrate(); }")]);
        let outcome = import_jobs_for_workbook(saved.clone(), &after);
        assert_eq!(outcome.restored, 0);
        assert!(live_jobs().is_empty());
        assert!(
            outcome.dropped[0].reason.contains("source changed"),
            "got: {}",
            outcome.dropped[0].reason
        );

        // ...and the identical body still restores, so the hash is a binding,
        // not a one-shot fuse.
        assert_eq!(import_jobs_for_workbook(saved, &before).restored, 1);
        reset_jobs();
    }

    #[test]
    fn a_job_whose_script_is_not_workbook_owned_is_never_persisted() {
        let _g = global_guard();
        reset_jobs();
        {
            let mut i = scheduler().lock().unwrap();
            add(&mut i, "workbook-script", "tick", 30, 0);
            add(&mut i, "extension-worker-7", "poll", 30, 0);
        }
        // Only the workbook-carried script has a source this document can vouch
        // for; the extension worker's schedule stays session-scoped rather than
        // being written as a row the load path would have to drop.
        let saved = export_jobs_for_workbook(&hashes(&[("workbook-script", "src")]));
        assert_eq!(saved.len(), 1);
        assert_eq!(saved[0].script_id, "workbook-script");
        reset_jobs();
    }

    #[test]
    fn restoring_a_job_never_makes_it_fire_without_a_live_grant() {
        let _g = global_guard();
        reset_jobs();
        let sources = hashes(&[("s1", "src")]);
        {
            let mut i = scheduler().lock().unwrap();
            add(&mut i, "s1", "tick", 30, 0);
        }
        let saved = export_jobs_for_workbook(&sources);
        reset_jobs();
        assert_eq!(import_jobs_for_workbook(saved, &sources).restored, 1);

        // Sweep against the LIVE registry, releasing the lock each time so a
        // failed assertion cannot poison the global mutex for the other tests.
        let sweep = |mounted: &[String], granted: &dyn Fn(&str) -> bool, now: i64| {
            let mut i = scheduler().lock().unwrap();
            sweep_due(&mut i, mounted, granted, now)
        };
        let mounted = vec!["s1".to_string()];

        // The restored job is long past due. It still may not run, because
        // import grants nothing: on a fresh launch the CapabilityStore is empty,
        // which is what REVOKED models here.
        let s1 = sweep(&mounted, REVOKED, 9_999_999_999);
        assert!(s1.due.is_empty(), "a restored job must not fire ungranted");
        assert_eq!(s1.denied.len(), 1, "and the refusal is audited");

        // Not mounted + granted is equally inert — an unconsented workbook
        // never mounts its scripts, so the schedule stays dormant. (The denial
        // above pushed the slot forward, so step past it.)
        let s2 = sweep(&[], GRANTED, 9_999_999_999 + 60_000);
        assert!(s2.due.is_empty(), "a restored job must not fire unmounted");

        // Only once BOTH hold does it run.
        let s3 = sweep(&mounted, GRANTED, 9_999_999_999 + 60_000);
        assert_eq!(s3.due.len(), 1, "mounted + granted is what finally lets it fire");
        reset_jobs();
    }

    #[test]
    fn opening_a_workbook_replaces_the_previous_workbooks_schedule() {
        let _g = global_guard();
        reset_jobs();
        let a = hashes(&[("a1", "src-a")]);
        {
            let mut i = scheduler().lock().unwrap();
            add(&mut i, "a1", "tick", 30, 0);
        }
        // Opening workbook B (which carries no schedule) must not leave A's
        // jobs behind, or B would be saved with a schedule it never agreed to.
        let outcome = import_jobs_for_workbook(Vec::new(), &hashes(&[("b1", "src-b")]));
        assert_eq!(outcome.restored, 0);
        assert!(live_jobs().is_empty(), "the previous workbook's jobs must not leak");
        assert!(
            export_jobs_for_workbook(&a).is_empty(),
            "and therefore cannot be written into the new document"
        );
        reset_jobs();
    }

    #[test]
    fn the_import_limit_matches_the_registration_limit() {
        let _g = global_guard();
        reset_jobs();
        let sources = hashes(&[("s1", "src")]);
        let defs: Vec<ScheduledJobDef> = (0..MAX_JOBS + 5)
            .map(|n| ScheduledJobDef {
                id: format!("sched-{}", n + 1),
                script_id: "s1".into(),
                script_hash: sources["s1"].clone(),
                surface: "object-script".into(),
                object_type: "shape".into(),
                instance_id: None,
                handler: format!("h{}", n),
                cadence: CADENCE_EVERY.into(),
                interval_secs: 60,
                minute_of_day: 0,
                next_run_ms: 0,
                enabled: true,
                label: None,
                last_run_ms: 0,
                last_ok: false,
                last_error: None,
                run_count: 0,
            })
            .collect();
        let outcome = import_jobs_for_workbook(defs, &sources);
        assert_eq!(outcome.restored, MAX_JOBS, "a file cannot exceed the live cap");
        assert_eq!(outcome.dropped.len(), 5);
        reset_jobs();
    }

    #[test]
    fn reregistering_updates_in_place_and_rearms() {
        let mut i = inner();
        let now = 1_000_000;
        let first = add(&mut i, "s1", "tick", 30, now);
        assert_eq!(first.next_run_ms, now + 30_000);

        // A remount re-registers the SAME handler: one job, updated — not two.
        let again = add(&mut i, "s1", "tick", 600, now + 5_000);
        assert_eq!(i.jobs.len(), 1, "re-registration is idempotent");
        assert_eq!(again.id, first.id);
        assert_eq!(again.interval_secs, 600);
        // Re-armed from the new "now", so a remount loop cannot force immediate
        // repeated firing.
        assert_eq!(again.next_run_ms, now + 5_000 + 600_000);
    }

    #[test]
    fn the_job_limit_is_enforced() {
        let mut i = inner();
        for n in 0..MAX_JOBS {
            assert!(upsert_job(
                &mut i, "s1", "object-script", "shape", None, &format!("h{}", n),
                CADENCE_EVERY, 30, 0, None, 0,
            )
            .is_ok());
        }
        let err = upsert_job(
            &mut i, "s1", "object-script", "shape", None, "one-too-many",
            CADENCE_EVERY, 30, 0, None, 0,
        )
        .unwrap_err();
        assert!(err.contains("too many scheduled jobs"), "got: {}", err);
        // ...but updating an EXISTING job at the limit still works.
        assert!(upsert_job(
            &mut i, "s1", "object-script", "shape", None, "h0",
            CADENCE_EVERY, 60, 0, None, 0,
        )
        .is_ok());
    }

    #[test]
    fn the_watchdog_releases_a_run_that_never_reported_back() {
        let mut i = inner();
        let now = 1_000_000;
        add(&mut i, "s1", "tick", 30, now);
        let mounted = vec!["s1".to_string()];
        let t1 = now + 30_000;
        assert_eq!(sweep_due(&mut i, &mounted, GRANTED, t1).due.len(), 1);

        // The renderer died mid-run: no "complete" ever arrives. Before the
        // watchdog window the job stays held...
        assert!(sweep_due(&mut i, &mounted, GRANTED, t1 + MAX_RUN_MS - 1).due.is_empty());
        // ...and after it, the run is released and audited as a failure.
        let sweep = sweep_due(&mut i, &mounted, GRANTED, t1 + MAX_RUN_MS + 1);
        assert_eq!(sweep.watchdogged.len(), 1);
        assert!(!i.jobs[0].running, "the stuck run is released");
        assert!(i.jobs[0].last_error.is_some());
    }

    #[test]
    fn daily_cadence_lands_on_the_next_local_slot() {
        use chrono::{Local, TimeZone, Timelike};
        let now = Local.with_ymd_and_hms(2026, 7, 31, 9, 0, 0).unwrap();
        // 06:30 today has passed -> tomorrow's 06:30.
        let next = next_daily_at_ms(390, now.timestamp_millis());
        let dt = Local.timestamp_millis_opt(next).unwrap();
        assert_eq!((dt.hour(), dt.minute()), (6, 30));
        assert!(next > now.timestamp_millis());

        // 23:15 is still ahead today.
        let later = next_daily_at_ms(23 * 60 + 15, now.timestamp_millis());
        let dt2 = Local.timestamp_millis_opt(later).unwrap();
        assert_eq!((dt2.hour(), dt2.minute()), (23, 15));
        assert_eq!(dt2.date_naive(), now.date_naive(), "same day when still ahead");
    }

    #[test]
    fn a_disabled_job_does_not_fire_but_survives() {
        let mut i = inner();
        let now = 1_000_000;
        add(&mut i, "s1", "tick", 30, now);
        i.jobs[0].enabled = false;
        let mounted = vec!["s1".to_string()];
        assert!(sweep_due(&mut i, &mounted, GRANTED, now + 60_000).due.is_empty());
        assert_eq!(i.jobs.len(), 1, "pausing is not deleting");
        i.jobs[0].enabled = true;
        i.jobs[0].next_run_ms = now;
        assert_eq!(sweep_due(&mut i, &mounted, GRANTED, now + 60_000).due.len(), 1);
    }
}
