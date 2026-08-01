//! FILENAME: core/calcula-format/src/features/scheduled_jobs.rs
//! PURPOSE: On-disk schema for the workbook's scheduled-job registry — the
//!          persisted half of the consented `schedule` capability. Lives at
//!          `files/scheduled_jobs.json` inside the .cala ZIP.
//!
//! CONTEXT: app/src-tauri/src/scripting/scheduler.rs owns the runtime registry
//!          and every gate; this module owns ONLY the bytes on disk. The split
//!          is deliberate: the file format has to be readable and reviewable
//!          without the enforcement code, because "what will this workbook run
//!          when I open it?" must be answerable from the file itself.
//!
//! WHY THIS SECTION IS SAFE TO CARRY IN A DOCUMENT
//! A scheduled job is NOT code. It is a *pointer* to a method that some script
//! in this same workbook already published with `context.expose(...)`, plus a
//! cadence. Restoring one authorizes nothing:
//!   * the script it names must already be in the workbook (and therefore
//!     already subject to Script Security, consent and the trust prompt);
//!   * `script_hash` binds the job to the EXACT source that was consented to,
//!     so editing (or swapping) the script invalidates every job that named it;
//!   * nothing in this file can name a capability, a command, a URL, or a
//!     function that the owning script did not itself expose.
//! Everything that decides whether a job may actually RUN — mount state, the
//! live `schedule` grant, the Script Security level, the interval floor — is
//! re-derived in Rust at firing time and is deliberately NOT stored here. A
//! hand-edited (or hostile) `scheduled_jobs.json` can therefore only ever ask
//! for less than it already had, never more.
//!
//! WHY IT CANNOT RIDE A .calp PACKAGE
//! Publishing copies a curated subset of the workbook into the package; the
//! `user_files` map — where this section lives — is excluded from .calp by
//! policy ("workbook files are subscriber-local"), and the `calp` crate never
//! reads `Workbook::user_files` at all. So a publisher cannot attach a schedule
//! to a subscriber's workbook: a distributed script still has to ask for the
//! `schedule` capability at the subscriber's own consent prompt, and the job
//! only comes into existence when that consented script registers it locally.
//! Choosing `user_files` over a new typed `Workbook` field is what makes that a
//! STRUCTURAL guarantee rather than a promise somebody has to keep re-checking.

use serde::{Deserialize, Serialize};

use crate::error::FormatError;

/// Path of the section inside the archive's user-files area (the ZIP entry is
/// `files/scheduled_jobs.json`).
pub const SCHEDULED_JOBS_FILE: &str = "scheduled_jobs.json";

/// Manifest `features` id declared when the section is present, so a reader can
/// tell "this workbook schedules work" from the manifest alone.
pub const SCHEDULED_JOBS_FEATURE: &str = "scheduled_jobs";

/// Minimum `.cala` format version a reader must be to handle this section.
///
/// This is the scheduler's link in the format stamp chain. It matters for a
/// reason specific to persisted automation: an older reader would not merely
/// *ignore* the section, it would drop it on the next save — silently deleting
/// schedules the user still believes are armed. Refusing to open is the honest
/// failure mode; being silently disarmed is not.
pub const SCHEDULED_JOBS_MIN_FORMAT_VERSION: u32 = 2;

/// Schema version of this envelope, independent of the archive's format
/// version (the archive version says "can you read this file at all", this one
/// says "which shape are the rows in").
pub const SCHEDULED_JOBS_SCHEMA_VERSION: u32 = 1;

/// One persisted scheduled job.
///
/// Field-for-field the durable subset of the runtime `ScheduledJob`, plus
/// `script_hash`. Transient run state (`running`, `runningSinceMs`) is
/// deliberately absent: an in-flight run cannot outlive the process that owned
/// it, so persisting it could only ever resurrect a lie.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ScheduledJobDef {
    pub id: String,
    /// The owning script's id, as carried by this same workbook.
    pub script_id: String,
    /// SHA-256 (hex) of that script's source at the moment the workbook was
    /// saved. The load path recomputes it and drops the job on any mismatch:
    /// consent was given to a specific body of code, so a job may not survive
    /// that code being replaced.
    pub script_hash: String,
    /// Registering surface ("object-script", "connector", …) — transparency
    /// metadata; it selects which host wrapper makes the call, never whether
    /// the call is allowed.
    pub surface: String,
    pub object_type: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub instance_id: Option<String>,
    /// The exposed-method name (or, for the connector surface, the connector's
    /// source id). Never arbitrary source text.
    pub handler: String,
    /// "every" | "dailyAt".
    pub cadence: String,
    #[serde(default)]
    pub interval_secs: u64,
    #[serde(default)]
    pub minute_of_day: u32,
    pub next_run_ms: i64,
    pub enabled: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub label: Option<String>,
    #[serde(default)]
    pub last_run_ms: i64,
    #[serde(default)]
    pub last_ok: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_error: Option<String>,
    #[serde(default)]
    pub run_count: u64,
}

/// The `scheduled_jobs.json` envelope.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ScheduledJobsFile {
    pub schema_version: u32,
    #[serde(default)]
    pub jobs: Vec<ScheduledJobDef>,
}

impl ScheduledJobsFile {
    pub fn new(jobs: Vec<ScheduledJobDef>) -> Self {
        ScheduledJobsFile {
            schema_version: SCHEDULED_JOBS_SCHEMA_VERSION,
            jobs,
        }
    }

    /// Serialize for the archive (pretty, so the section stays reviewable in a
    /// diff — the whole point of a transparent automation record).
    pub fn to_json_bytes(&self) -> Result<Vec<u8>, FormatError> {
        Ok(serde_json::to_vec_pretty(self)?)
    }

    /// Parse from the archive.
    ///
    /// A future schema version is REFUSED rather than best-effort decoded: a
    /// partially understood schedule is worse than none, because the fields a
    /// newer writer added could be exactly the ones that narrow what a job may
    /// do. Malformed bytes are refused for the same reason.
    pub fn from_json_bytes(bytes: &[u8]) -> Result<Self, FormatError> {
        let parsed: ScheduledJobsFile = serde_json::from_slice(bytes)?;
        if parsed.schema_version > SCHEDULED_JOBS_SCHEMA_VERSION {
            return Err(FormatError::InvalidFormat(format!(
                "scheduled_jobs.json schema version {} is newer than this build supports ({})",
                parsed.schema_version, SCHEDULED_JOBS_SCHEMA_VERSION
            )));
        }
        Ok(parsed)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn job() -> ScheduledJobDef {
        ScheduledJobDef {
            id: "sched-1".to_string(),
            script_id: "obj-1".to_string(),
            script_hash: "abc123".to_string(),
            surface: "object-script".to_string(),
            object_type: "shape".to_string(),
            instance_id: Some("i1".to_string()),
            handler: "nightly".to_string(),
            cadence: "dailyAt".to_string(),
            interval_secs: 0,
            minute_of_day: 390,
            next_run_ms: 1_700_000_000_000,
            enabled: true,
            label: Some("Nightly refresh".to_string()),
            last_run_ms: 0,
            last_ok: false,
            last_error: None,
            run_count: 0,
        }
    }

    #[test]
    fn round_trips_through_json() {
        let file = ScheduledJobsFile::new(vec![job()]);
        let bytes = file.to_json_bytes().unwrap();
        let back = ScheduledJobsFile::from_json_bytes(&bytes).unwrap();
        assert_eq!(back.schema_version, SCHEDULED_JOBS_SCHEMA_VERSION);
        assert_eq!(back.jobs.len(), 1);
        assert_eq!(back.jobs[0].script_hash, "abc123");
        assert_eq!(back.jobs[0].minute_of_day, 390);
    }

    #[test]
    fn wire_shape_is_camel_case() {
        // The golden rule: TS mirrors these names exactly.
        let json = String::from_utf8(ScheduledJobsFile::new(vec![job()]).to_json_bytes().unwrap())
            .unwrap();
        assert!(json.contains("\"scriptId\""), "{}", json);
        assert!(json.contains("\"scriptHash\""), "{}", json);
        assert!(json.contains("\"minuteOfDay\""), "{}", json);
        assert!(json.contains("\"schemaVersion\""), "{}", json);
        assert!(!json.contains("script_id"), "{}", json);
    }

    #[test]
    fn a_newer_schema_is_refused_not_guessed() {
        let raw = br#"{"schemaVersion": 99, "jobs": []}"#;
        assert!(ScheduledJobsFile::from_json_bytes(raw).is_err());
    }

    #[test]
    fn transient_run_state_has_no_home_on_disk() {
        // `running` / `runningSinceMs` must not round-trip: a run cannot
        // survive the process that owned it, and a persisted "running: true"
        // would wedge the job behind its own self-overlap guard forever.
        let json = String::from_utf8(ScheduledJobsFile::new(vec![job()]).to_json_bytes().unwrap())
            .unwrap();
        assert!(!json.contains("running"), "{}", json);
    }
}
