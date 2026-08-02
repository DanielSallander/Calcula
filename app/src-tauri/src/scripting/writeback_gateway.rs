//! FILENAME: app/src-tauri/src/scripting/writeback_gateway.rs
//! PURPOSE: The ONE broker-reachable door for scripted .calp writeback and
//!          distribution automation — `script_writeback`, an action-multiplexed
//!          gateway behind the `distribution.writeback` capability.
//! CONTEXT: Mirrors the `script_bi_model` gateway (app/src-tauri/src/bi/
//!          model_editor.rs) in shape AND rigor: main-window guard, an
//!          authoritative Rust re-check of the capability grant (the TS broker
//!          gate is advisory — the renderer may be compromised), a server-side
//!          allowlist of actions, an Ed25519 publisher gate on the two
//!          publisher-only actions, per-script rate buckets, always-on audit
//!          via `record_capability_call`, and dispatch into the SAME
//!          `calp_*` command functions the interactive UI calls — so a scripted
//!          submission is exactly as constrained as a human one (schema,
//!          lifecycle, completeness, ownership, registry trust).
//!
//! WHY ONE COMMAND: the app registers ~660 Tauri commands in `generate_handler!`
//! and the debug dispatch frame nearly exhausts the 32 MB main-thread stack
//! reserve set in build.rs. Seven writeback verbs would be seven frames; one
//! `action` discriminator is one.
//!
//! DELIBERATE DEVIATION from the agreed contract's `pub async fn`: this command
//! is SYNC. Every function it dispatches into is sync and does registry I/O,
//! and an HTTP registry (`calp_registry::HttpRegistry`) uses
//! `reqwest::blocking`, which must NOT run on the async runtime. Tauri runs
//! sync commands on a worker thread, exactly like every other `calp_*` command.
//! The IPC surface is identical from TypeScript (`invoke("script_writeback",
//! { … })`), so nothing frontend-side changes.

use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};
use std::time::Instant;

use serde::Serialize;
use serde_json::{json, Value};
use tauri::{State, Window};

use crate::calp_commands as calp_cmds;
use crate::scripting::CapabilityStore;
use crate::AppState;

/// The capability id this gateway is gated on. Mirrored (frontend-side) in
/// app/src/api/scriptHost/capabilityIds.ts.
pub const WRITEBACK_CAPABILITY: &str = "distribution.writeback";

// ---------------------------------------------------------------------------
// Rate buckets
// ---------------------------------------------------------------------------

/// Registry/index READS (listRegions, getLayer, previewSubmission,
/// listSubmissions). Each is a bounded read; a dashboard-style script polling
/// once a second is already abusive, so 60/min is generous.
const WRITEBACK_READS_PER_MINUTE: usize = 60;

/// DRAFT saves (saveDraft, and the draft leg of cellGuard). One draft = one
/// cell, and the whole point of this gateway is "auto-fill the form": a macro
/// filling a 200-cell region in a loop must not trip a limit. Deliberately much
/// higher than `script_bi_model`'s 30/min, because a draft is a cheap in-memory
/// write — except for `immediate` regions, which auto-submit and are therefore
/// additionally covered by the submit bucket inside `calp_save_writeback_draft`
/// (they go through `submit_region_internal`).
const WRITEBACK_DRAFTS_PER_MINUTE: usize = 240;

/// SUBMITS and publisher REVIEW decisions (submitRegion, setSubmissionState).
/// These leave the machine: each one is a batch of registry writes plus a
/// rollup refresh, and both are irreversible in the "other people can see it
/// now" sense. Deliberately the tightest bucket — an automation loop that needs
/// more than 12 submit batches a minute is a bug or an attack.
const WRITEBACK_SUBMITS_PER_MINUTE: usize = 12;

const RATE_WINDOW_SECS: u64 = 60;

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum Bucket {
    Read,
    Draft,
    Submit,
}

impl Bucket {
    fn limit(self) -> usize {
        match self {
            Bucket::Read => WRITEBACK_READS_PER_MINUTE,
            Bucket::Draft => WRITEBACK_DRAFTS_PER_MINUTE,
            Bucket::Submit => WRITEBACK_SUBMITS_PER_MINUTE,
        }
    }

    fn name(self) -> &'static str {
        match self {
            Bucket::Read => "read",
            Bucket::Draft => "draft",
            Bucket::Submit => "submit",
        }
    }
}

/// Per-(script, bucket) rolling one-minute window. Own state — never shared
/// with net.fetch's window or the bi.model gateway's.
fn check_rate(script_id: &str, bucket: Bucket) -> Result<(), String> {
    static WINDOWS: OnceLock<Mutex<HashMap<(String, &'static str), Vec<Instant>>>> = OnceLock::new();
    let windows = WINDOWS.get_or_init(|| Mutex::new(HashMap::new()));
    let mut windows = windows.lock().unwrap();
    let now = Instant::now();
    let window = windows
        .entry((script_id.to_string(), bucket.name()))
        .or_default();
    window.retain(|t| now.duration_since(*t).as_secs() < RATE_WINDOW_SECS);
    if window.len() >= bucket.limit() {
        return Err(format!(
            "RateLimited: distribution.writeback allows {} {} operations per minute",
            bucket.limit(),
            bucket.name()
        ));
    }
    window.push(now);
    Ok(())
}

#[cfg(test)]
fn reset_rate_state() {
    // Tests share the process-wide window map; each rate test uses its own
    // script id, so nothing to reset globally — this exists to document that
    // invariant at the one place it matters.
}

// ---------------------------------------------------------------------------
// Action allowlist
// ---------------------------------------------------------------------------

/// The SERVER-SIDE action allowlist. Anything not in this enum is not reachable
/// from a script, whatever the broker sends. Note what is deliberately absent:
/// designating/removing/updating writeback REGIONS (authoring governance — a
/// script must not be able to move the collection surface), publishing,
/// pulling, subscribing, detaching, and every CSV/Parquet export (bulk
/// exfiltration of other submitters' answers).
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum Action {
    ListRegions,
    GetLayer,
    SaveDraft,
    SubmitRegion,
    PreviewSubmission,
    ListSubmissions,
    SetSubmissionState,
    CellGuard,
}

impl Action {
    fn parse(raw: &str) -> Result<Action, String> {
        Ok(match raw {
            "listRegions" => Action::ListRegions,
            "getLayer" => Action::GetLayer,
            "saveDraft" => Action::SaveDraft,
            "submitRegion" => Action::SubmitRegion,
            "previewSubmission" => Action::PreviewSubmission,
            "listSubmissions" => Action::ListSubmissions,
            "setSubmissionState" => Action::SetSubmissionState,
            "cellGuard" => Action::CellGuard,
            other => {
                return Err(format!(
                    "Unknown action '{}' (expected listRegions | getLayer | saveDraft | \
                     submitRegion | previewSubmission | listSubmissions | setSubmissionState | \
                     cellGuard)",
                    other
                ))
            }
        })
    }

    fn as_str(self) -> &'static str {
        match self {
            Action::ListRegions => "listRegions",
            Action::GetLayer => "getLayer",
            Action::SaveDraft => "saveDraft",
            Action::SubmitRegion => "submitRegion",
            Action::PreviewSubmission => "previewSubmission",
            Action::ListSubmissions => "listSubmissions",
            Action::SetSubmissionState => "setSubmissionState",
            Action::CellGuard => "cellGuard",
        }
    }

    /// THE SECURITY BOUNDARY between a subscriber's script and a publisher's.
    /// `listSubmissions` returns every submitter's raw values + identity (the
    /// `own_only` visibility promise), and `setSubmissionState` decides what
    /// GATHER aggregates under an `on_approval` policy — getting this wrong
    /// would let a subscriber's script approve its own submissions.
    fn is_publisher_only(self) -> bool {
        matches!(self, Action::ListSubmissions | Action::SetSubmissionState)
    }

    fn bucket(self) -> Bucket {
        match self {
            Action::ListRegions
            | Action::GetLayer
            | Action::PreviewSubmission
            | Action::ListSubmissions => Bucket::Read,
            Action::SaveDraft | Action::CellGuard => Bucket::Draft,
            Action::SubmitRegion | Action::SetSubmissionState => Bucket::Submit,
        }
    }
}

// ---------------------------------------------------------------------------
// Payload helpers
// ---------------------------------------------------------------------------

/// Pull a typed field out of the gateway payload (absent -> serde default for
/// `Option<T>`, a clear error for required fields). Same helper shape as the
/// bi.model gateway's `gateway_field`.
fn field<T: serde::de::DeserializeOwned>(
    payload: &serde_json::Map<String, Value>,
    key: &str,
) -> Result<T, String> {
    serde_json::from_value(payload.get(key).cloned().unwrap_or(Value::Null))
        .map_err(|e| format!("payload field '{}': {}", key, e))
}

/// The target of a publisher-only action: a grid REGION or a model writeback
/// COLUMN. Discriminated by which id the payload carries, so one action covers
/// both surfaces without a second command.
enum PublisherTarget {
    Region(String),
    ModelColumn(String),
}

fn publisher_target(payload: &serde_json::Map<String, Value>) -> Result<PublisherTarget, String> {
    let region: Option<String> = field(payload, "regionId")?;
    let column: Option<String> = field(payload, "writebackId")?;
    match (region, column) {
        (Some(r), None) => Ok(PublisherTarget::Region(r)),
        (None, Some(c)) => Ok(PublisherTarget::ModelColumn(c)),
        (Some(_), Some(_)) => {
            Err("Pass either 'regionId' (grid region) or 'writebackId' (model column), not both"
                .to_string())
        }
        (None, None) => {
            Err("Missing target: pass 'regionId' (grid region) or 'writebackId' (model column)"
                .to_string())
        }
    }
}

// ---------------------------------------------------------------------------
// cellGuard result
// ---------------------------------------------------------------------------

/// Answer to "may this script write this grid cell, and what happened to the
/// value?" — see `Action::CellGuard`.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WritebackCellGuard {
    /// Whether the cell is claimed by a published writeback region.
    pub in_region: bool,
    /// The claiming region's id (only when `inRegion`).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub region_id: Option<String>,
    /// The region's declared value type, so the caller can report it.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub value_type: Option<String>,
    /// True when a schema-validated draft was saved for this cell. When this is
    /// true the caller MUST let the normal grid write proceed (so the cell
    /// displays what was drafted) — exactly what the interactive commit guard
    /// does by returning `action: "allow"` after a successful draft save.
    pub draft_saved: bool,
}

/// Coerce a raw JSON value into a `SubmissionValue` using the region's DECLARED
/// type — never the value's shape. Same rule (and same reason) as the
/// interactive commit guard in app/extensions/Distribution/index.ts: a product
/// code "12345" typed into a TEXT region must travel as text, not be sniffed
/// into a number and rejected.
///
/// Values that do not fit the declared type are passed through as Text so the
/// authoritative `ValueSchema::validate` produces the real, user-facing message
/// ("Expected a number, got 'abc'.") instead of this function inventing one.
fn coerce_submission_value(
    raw: &Value,
    value_type: Option<calp::writeback::ValueType>,
) -> calp::writeback::SubmissionValue {
    use calp::writeback::{SubmissionValue, ValueType};

    // The string form the grid would commit — the interactive path coerces from
    // exactly this, so both paths must agree.
    let text = match raw {
        Value::Null => String::new(),
        Value::String(s) => s.clone(),
        Value::Bool(b) => {
            if *b {
                "TRUE".to_string()
            } else {
                "FALSE".to_string()
            }
        }
        Value::Number(n) => n.to_string(),
        other => other.to_string(),
    };
    let trimmed = text.trim();
    if trimmed.is_empty() {
        return SubmissionValue::Empty;
    }
    let as_bool = |s: &str| match s.to_ascii_lowercase().as_str() {
        "true" => Some(true),
        "false" => Some(false),
        _ => None,
    };

    match value_type {
        Some(ValueType::Number) | Some(ValueType::Integer) => match raw {
            Value::Number(n) => n
                .as_f64()
                .map(|value| SubmissionValue::Number { value })
                .unwrap_or_else(|| SubmissionValue::Text {
                    value: trimmed.to_string(),
                }),
            _ => match trimmed.parse::<f64>() {
                Ok(value) => SubmissionValue::Number { value },
                Err(_) => SubmissionValue::Text {
                    value: trimmed.to_string(),
                },
            },
        },
        Some(ValueType::Boolean) => match raw {
            Value::Bool(b) => SubmissionValue::Boolean { value: *b },
            _ => match as_bool(trimmed) {
                Some(value) => SubmissionValue::Boolean { value },
                None => SubmissionValue::Text {
                    value: trimmed.to_string(),
                },
            },
        },
        Some(ValueType::Text) | Some(ValueType::Date) | Some(ValueType::Enum) => {
            SubmissionValue::Text {
                value: trimmed.to_string(),
            }
        }
        // Unschematized region: fall back to shape sniffing, matching the
        // interactive guard's `default:` branch.
        None => {
            if let Ok(value) = trimmed.parse::<f64>() {
                SubmissionValue::Number { value }
            } else if let Some(value) = as_bool(trimmed) {
                SubmissionValue::Boolean { value }
            } else {
                SubmissionValue::Text {
                    value: trimmed.to_string(),
                }
            }
        }
    }
}

// ---------------------------------------------------------------------------
// Grant mirroring
// ---------------------------------------------------------------------------

// The grantable-capability vocabulary is owned by the store that holds the
// grants (`capability_store::GRANTABLE_CAPABILITIES` / `is_grantable`). This
// command used to keep a private copy, and the copy drifted: it omitted
// `schedule`, so `grant_script_capability` hard-errored on the one capability
// `script_scheduler` gates every registration AND every firing on — making the
// scheduler unreachable for object scripts while looking implemented.

/// Mirror a consent-granted capability into the authoritative backend store.
/// The frontend's consent store is the system of record (it persists); this
/// re-establishes the in-memory grant that every Rust gate re-checks per call.
/// Main window only — the same rule as `grant_script_net_origin` /
/// `grant_script_bi`, which this generalizes.
#[tauri::command]
pub fn grant_script_capability(
    cap_store: State<CapabilityStore>,
    script_id: String,
    capability: String,
    window: Window,
) -> Result<(), String> {
    crate::security::window_guard::require_label(&window, crate::security::window_guard::MAIN)?;
    if !crate::scripting::capability_store::is_grantable(&capability) {
        return Err(format!(
            "InvalidCapability: {} (expected one of {})",
            capability,
            crate::scripting::capability_store::GRANTABLE_CAPABILITIES.join(", ")
        ));
    }
    cap_store.grant(&script_id, &capability);
    crate::log_info!(
        "SECURITY",
        "grant_script_capability: script={} capability={}",
        script_id,
        capability
    );
    Ok(())
}

// ---------------------------------------------------------------------------
// The gateway
// ---------------------------------------------------------------------------

/// Multiplexed, consent-gated writeback/distribution gateway for sandboxed
/// scripts and distributed extensions.
///
/// `action` is one of: `listRegions` | `getLayer` | `saveDraft` |
/// `submitRegion` | `previewSubmission` | `listSubmissions` |
/// `setSubmissionState` | `cellGuard`. `payload` carries the action's
/// arguments in camelCase, mirroring the interactive commands 1:1.
///
/// Enforcement, in order:
/// 1. main-window guard;
/// 2. action allowlist (unknown actions never reach a dispatch);
/// 3. `cellGuard` on an UNCLAIMED cell answers `{ inRegion: false }` and stops —
///    no grant needed, because "this cell is not a writeback cell" must be
///    answerable on every script grid write, including from scripts that hold
///    no writeback capability at all;
/// 4. authoritative `distribution.writeback` grant re-check (audited on denial);
/// 5. publisher-only actions: Ed25519 `require_publisher` over the SIGNED
///    version manifest, before dispatch (audited on denial);
/// 6. per-script rate bucket;
/// 7. dispatch into the same `calp_*` functions the UI calls — every schema,
///    lifecycle, completeness, ownership and registry-trust check comes along
///    unchanged;
/// 8. always-on audit of the outcome.
#[tauri::command]
pub fn script_writeback(
    state: State<AppState>,
    cap_store: State<CapabilityStore>,
    script_id: String,
    action: String,
    payload: Option<Value>,
    window: Window,
) -> Result<Value, String> {
    // (1) Broker-routed calls run in the main window.
    crate::security::window_guard::require_label(&window, crate::security::window_guard::MAIN)?;

    // (2) Server-side action allowlist.
    let act = Action::parse(&action)?;
    let p = payload
        .and_then(|v| v.as_object().cloned())
        .unwrap_or_default();

    // (3) cellGuard fast path: an unclaimed cell is not a writeback matter.
    if act == Action::CellGuard {
        if let Some(early) = cell_guard_unclaimed(&state, &p)? {
            return Ok(early);
        }
    }

    // (4) Authoritative capability re-check — the TS broker's gate is advisory.
    if !cap_store.is_granted(&script_id, WRITEBACK_CAPABILITY) {
        crate::log_warn!(
            "SECURITY",
            "script_writeback DENIED (distribution.writeback not granted): script={} action={}",
            script_id,
            act.as_str()
        );
        let err = "PermissionDenied: distribution.writeback not granted for this script";
        crate::net_commands::record_capability_call(
            &state.audit_log,
            WRITEBACK_CAPABILITY,
            &script_id,
            false,
            Some(act.as_str()),
            Some(err),
        );
        return Err(err.to_string());
    }

    // (5) Publisher gate for the review/see-all actions.
    let mut target: Option<PublisherTarget> = None;
    if act.is_publisher_only() {
        let t = publisher_target(&p)?;
        let check = match &t {
            PublisherTarget::Region(region_id) => {
                calp_cmds::require_region_publisher(&state, region_id)
            }
            PublisherTarget::ModelColumn(writeback_id) => {
                calp_cmds::require_model_writeback_publisher(&state, writeback_id)
            }
        };
        if let Err(e) = check {
            crate::log_warn!(
                "SECURITY",
                "script_writeback DENIED (not the publisher): script={} action={}",
                script_id,
                act.as_str()
            );
            crate::net_commands::record_capability_call(
                &state.audit_log,
                WRITEBACK_CAPABILITY,
                &script_id,
                false,
                Some(&audit_detail(act, &p)),
                Some(&e),
            );
            return Err(e);
        }
        target = Some(t);
    }

    // (6) Rate limit.
    if let Err(e) = check_rate(&script_id, act.bucket()) {
        crate::net_commands::record_capability_call(
            &state.audit_log,
            WRITEBACK_CAPABILITY,
            &script_id,
            false,
            Some(&audit_detail(act, &p)),
            Some(&e),
        );
        return Err(e);
    }

    // (7) Dispatch.
    let detail = audit_detail(act, &p);
    let result = dispatch(act, target, &state, &p, &window);

    // (8) Always-on audit (success + failure), mirroring bi.query/bi.sql/bi.model.
    match &result {
        Ok(_) => crate::net_commands::record_capability_call(
            &state.audit_log,
            WRITEBACK_CAPABILITY,
            &script_id,
            true,
            Some(&detail),
            None,
        ),
        Err(e) => crate::net_commands::record_capability_call(
            &state.audit_log,
            WRITEBACK_CAPABILITY,
            &script_id,
            false,
            Some(&detail),
            Some(e),
        ),
    }
    result
}

/// The audit `detail` string for an action: the action plus the region/column
/// it touched. NON-SENSITIVE by construction — ids only, never submitted
/// values or submitter identities.
fn audit_detail(act: Action, p: &serde_json::Map<String, Value>) -> String {
    let target = p
        .get("regionId")
        .or_else(|| p.get("writebackId"))
        .and_then(|v| v.as_str());
    match target {
        Some(t) => format!("{} — {}", act.as_str(), t),
        None => act.as_str().to_string(),
    }
}

/// `cellGuard` step (3): if the addressed cell is NOT claimed by a published
/// writeback region, answer `{ inRegion: false }` immediately.
///
/// Ungated on purpose: this is the question the grid write path asks on EVERY
/// script cell write, and answering "no" must not require a capability the
/// script has no reason to hold. It leaks nothing — a `false` says only that
/// the workbook's own, already-listable writeback regions do not cover the cell.
fn cell_guard_unclaimed(
    state: &AppState,
    p: &serde_json::Map<String, Value>,
) -> Result<Option<Value>, String> {
    let (_, region) = cell_guard_target(state, p)?;
    if region.is_none() {
        return Ok(Some(serde_json::to_value(WritebackCellGuard {
            in_region: false,
            region_id: None,
            value_type: None,
            draft_saved: false,
        })
        .map_err(|e| e.to_string())?));
    }
    Ok(None)
}

/// Resolve which sheet+cell a `cellGuard` payload addresses and which region
/// (if any) claims it.
///
/// `sheetId` is optional: omit it to guard the ACTIVE sheet, which is the sheet
/// `update_cell` writes to — the script write path has no sheet parameter, so
/// asking about any other sheet would be asking the wrong question.
fn cell_guard_target(
    state: &AppState,
    p: &serde_json::Map<String, Value>,
) -> Result<((identity::SheetId, u32, u32), Option<String>), String> {
    let row: u32 = field(p, "row")?;
    let col: u32 = field(p, "col")?;
    let sheet_id: Option<String> = field(p, "sheetId")?;
    let sid = match sheet_id {
        Some(raw) => identity::SheetId::parse(&raw)
            .ok_or_else(|| format!("Invalid sheetId: {}", raw))?,
        None => calp_cmds::active_sheet_id(state)?,
    };
    let region = calp_cmds::writeback_region_at(state, sid, row, col);
    Ok(((sid, row, col), region))
}

/// Dispatch into the EXISTING commands. Every one of them re-runs its own
/// window guard and its own authorization — this gateway adds constraints, it
/// never replaces them.
fn dispatch(
    act: Action,
    target: Option<PublisherTarget>,
    state: &State<AppState>,
    p: &serde_json::Map<String, Value>,
    window: &Window,
) -> Result<Value, String> {
    match act {
        Action::ListRegions => {
            let regions = calp_cmds::calp_get_writeback_regions(state.clone(), window.clone())?;
            serde_json::to_value(regions).map_err(|e| e.to_string())
        }
        Action::GetLayer => {
            let layer = calp_cmds::calp_get_writeback_layer(state.clone(), window.clone())?;
            serde_json::to_value(layer).map_err(|e| e.to_string())
        }
        Action::SaveDraft => {
            let region_id: String = field(p, "regionId")?;
            let sheet_id: String = field(p, "sheetId")?;
            let row: u32 = field(p, "row")?;
            let col: u32 = field(p, "col")?;
            let value: calp::writeback::SubmissionValue = field(p, "value")?;
            calp_cmds::calp_save_writeback_draft(
                state.clone(),
                region_id,
                sheet_id,
                row,
                col,
                value,
                window.clone(),
            )?;
            Ok(json!({ "draftSaved": true }))
        }
        Action::SubmitRegion => {
            let region_id: String = field(p, "regionId")?;
            let submitted =
                calp_cmds::calp_submit_region(state.clone(), region_id, window.clone())?;
            Ok(json!({ "submitted": submitted }))
        }
        Action::PreviewSubmission => {
            let region_id: String = field(p, "regionId")?;
            let preview = calp_cmds::calp_preview_region_submission(
                state.clone(),
                region_id,
                window.clone(),
            )?;
            serde_json::to_value(preview).map_err(|e| e.to_string())
        }
        Action::ListSubmissions => match target {
            Some(PublisherTarget::Region(region_id)) => {
                let rows = calp_cmds::calp_load_region_submissions(
                    state.clone(),
                    region_id,
                    window.clone(),
                )?;
                serde_json::to_value(rows).map_err(|e| e.to_string())
            }
            Some(PublisherTarget::ModelColumn(writeback_id)) => {
                let rows = calp_cmds::calp_list_model_submissions(
                    state.clone(),
                    writeback_id,
                    window.clone(),
                )?;
                serde_json::to_value(rows).map_err(|e| e.to_string())
            }
            None => Err("Internal: publisher target not resolved".to_string()),
        },
        Action::SetSubmissionState => {
            let new_state: String = field(p, "newState")?;
            let reason: Option<String> = field(p, "reason")?;
            match target {
                Some(PublisherTarget::Region(region_id)) => {
                    let submitter_id: String = field(p, "submitterId")?;
                    let cell_row: u32 = field(p, "cellRow")?;
                    let cell_col: u32 = field(p, "cellCol")?;
                    let submission_id: Option<String> = field(p, "submissionId")?;
                    calp_cmds::calp_set_submission_state(
                        state.clone(),
                        region_id,
                        submitter_id,
                        cell_row,
                        cell_col,
                        new_state,
                        reason,
                        submission_id,
                        window.clone(),
                    )?;
                    Ok(json!({ "reviewed": true }))
                }
                Some(PublisherTarget::ModelColumn(writeback_id)) => {
                    let submission_id: String = field(p, "submissionId")?;
                    calp_cmds::calp_set_model_submission_state(
                        state.clone(),
                        writeback_id,
                        submission_id,
                        new_state,
                        reason,
                        window.clone(),
                    )?;
                    Ok(json!({ "reviewed": true }))
                }
                None => Err("Internal: publisher target not resolved".to_string()),
            }
        }
        Action::CellGuard => {
            // Reaching here means the cell IS claimed (the unclaimed case
            // returned at step 3) and the script holds the capability.
            let ((sid, row, col), region) = cell_guard_target(state, p)?;
            let region_id = region.ok_or_else(|| {
                "Internal: cellGuard reached the draft leg for an unclaimed cell".to_string()
            })?;
            let decl = calp_cmds::writeback_declaration(state, &region_id);
            let value_type = decl
                .as_ref()
                .and_then(|d| d.schema.as_ref())
                .map(|s| s.value_type.clone());
            let raw = p.get("value").cloned().unwrap_or(Value::Null);
            let submission_value = coerce_submission_value(&raw, value_type.clone());

            // The SAME authoritative draft gate the interactive editor uses:
            // schema validation, lifecycle policy, ownership, auto-submit for
            // `immediate` regions. A rejection propagates verbatim so the
            // script sees the real reason.
            calp_cmds::calp_save_writeback_draft(
                state.clone(),
                region_id.clone(),
                sid.to_string(),
                row,
                col,
                submission_value,
                window.clone(),
            )?;

            serde_json::to_value(WritebackCellGuard {
                in_region: true,
                region_id: Some(region_id),
                value_type: value_type.map(|t| value_type_str(&t).to_string()),
                draft_saved: true,
            })
            .map_err(|e| e.to_string())
        }
    }
}

/// The wire spelling of a declared value type (mirrors
/// `calp_get_writeback_regions`, so the frontend sees one vocabulary).
fn value_type_str(t: &calp::writeback::ValueType) -> &'static str {
    use calp::writeback::ValueType;
    match t {
        ValueType::Number => "number",
        ValueType::Integer => "integer",
        ValueType::Text => "text",
        ValueType::Date => "date",
        ValueType::Boolean => "boolean",
        ValueType::Enum => "enum",
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use calp::writeback::{SubmissionValue, ValueType};

    // -----------------------------------------------------------------------
    // Action allowlist + the publisher boundary
    // -----------------------------------------------------------------------

    #[test]
    fn unknown_actions_are_rejected() {
        assert!(Action::parse("listRegions").is_ok());
        for bad in [
            "",
            "publish",
            "addRegion",
            "removeRegion",
            "exportCsv",
            "SaveDraft",
            "submit_region",
        ] {
            assert!(
                Action::parse(bad).is_err(),
                "action '{}' must not be dispatchable",
                bad
            );
        }
    }

    #[test]
    fn only_review_and_see_all_are_publisher_only() {
        // The security boundary: a subscriber's script must never be able to
        // approve its own submissions or read everyone else's answers.
        assert!(Action::ListSubmissions.is_publisher_only());
        assert!(Action::SetSubmissionState.is_publisher_only());
        // ...and the contributor actions must NOT be publisher-gated, or a
        // data-collection form could only be filled in by its own publisher.
        for a in [
            Action::ListRegions,
            Action::GetLayer,
            Action::SaveDraft,
            Action::SubmitRegion,
            Action::PreviewSubmission,
            Action::CellGuard,
        ] {
            assert!(!a.is_publisher_only(), "{:?} must not be publisher-only", a);
        }
    }

    #[test]
    fn publisher_target_requires_exactly_one_id() {
        let region: serde_json::Map<String, Value> =
            serde_json::from_value(json!({ "regionId": "r1" })).unwrap();
        assert!(matches!(
            publisher_target(&region).unwrap(),
            PublisherTarget::Region(r) if r == "r1"
        ));

        let column: serde_json::Map<String, Value> =
            serde_json::from_value(json!({ "writebackId": "w1" })).unwrap();
        assert!(matches!(
            publisher_target(&column).unwrap(),
            PublisherTarget::ModelColumn(c) if c == "w1"
        ));

        let both: serde_json::Map<String, Value> =
            serde_json::from_value(json!({ "regionId": "r1", "writebackId": "w1" })).unwrap();
        assert!(publisher_target(&both).is_err());

        let neither: serde_json::Map<String, Value> =
            serde_json::from_value(json!({ "submissionId": "s1" })).unwrap();
        assert!(publisher_target(&neither).is_err());
    }

    // -----------------------------------------------------------------------
    // Grant enforcement (the store half; the command half is asserted by the
    // gateway's step-4 branch, which reads exactly this predicate)
    // -----------------------------------------------------------------------

    #[test]
    fn grant_enforcement_is_deny_by_default_and_capability_exact() {
        let store = CapabilityStore::new();
        assert!(
            !store.is_granted("s1", WRITEBACK_CAPABILITY),
            "a script with no grant must be denied"
        );

        // Holding a DIFFERENT capability does not open this gate.
        store.grant("s1", "bi.query");
        assert!(!store.is_granted("s1", WRITEBACK_CAPABILITY));

        store.grant("s1", WRITEBACK_CAPABILITY);
        assert!(store.is_granted("s1", WRITEBACK_CAPABILITY));
        // ...and the grant is per-script.
        assert!(!store.is_granted("s2", WRITEBACK_CAPABILITY));

        store.revoke_script("s1");
        assert!(!store.is_granted("s1", WRITEBACK_CAPABILITY));
    }

    #[test]
    fn grantable_capability_list_is_closed() {
        use crate::scripting::capability_store::is_grantable;
        assert!(is_grantable(WRITEBACK_CAPABILITY));
        // `distribution.publish` used to stand here as an INVENTED id. It is a
        // real capability now (B3, scripting/distribution_gateway.rs), so the
        // negative case moved to spellings that must stay unreachable — the
        // namespace root and a plausible-looking sub-id.
        for invented in [
            "distribution",
            "distribution.writeback.submit",
            "distribution.pull",
            "fs.write",
            "",
        ] {
            assert!(!is_grantable(invented), "'{}' must not be grantable", invented);
        }
        // ...and holding one distribution capability must never satisfy
        // another's gate: the store is one exact-match set, not a namespace.
        assert!(is_grantable("distribution.publish"));
        assert!(is_grantable("distribution.subscribe"));
        let store = CapabilityStore::new();
        store.grant("s1", "distribution.subscribe");
        assert!(!store.is_granted("s1", WRITEBACK_CAPABILITY));
        assert!(!store.is_granted("s1", "distribution.publish"));
        // The one that drifted: `script_scheduler` is dead code without it.
        assert!(is_grantable("schedule"));
    }

    // -----------------------------------------------------------------------
    // Rate limiting
    // -----------------------------------------------------------------------

    #[test]
    fn submit_bucket_is_the_tightest_and_trips_at_its_limit() {
        reset_rate_state();
        let script = "rate-submit-test";
        for i in 0..WRITEBACK_SUBMITS_PER_MINUTE {
            assert!(
                check_rate(script, Bucket::Submit).is_ok(),
                "submit {} of {} must be allowed",
                i + 1,
                WRITEBACK_SUBMITS_PER_MINUTE
            );
        }
        let err = check_rate(script, Bucket::Submit).unwrap_err();
        assert!(err.starts_with("RateLimited:"), "got: {}", err);
        assert!(err.contains("distribution.writeback"), "got: {}", err);

        // Buckets are independent: exhausting submits must not block a read...
        assert!(check_rate(script, Bucket::Read).is_ok());
        // ...and must not block a draft (form-filling stays usable).
        assert!(check_rate(script, Bucket::Draft).is_ok());
    }

    #[test]
    fn rate_windows_are_per_script() {
        reset_rate_state();
        for _ in 0..WRITEBACK_SUBMITS_PER_MINUTE {
            check_rate("rate-script-a", Bucket::Submit).unwrap();
        }
        assert!(check_rate("rate-script-a", Bucket::Submit).is_err());
        // A different script starts with a fresh window.
        assert!(check_rate("rate-script-b", Bucket::Submit).is_ok());
    }

    #[test]
    fn draft_bucket_allows_bulk_form_filling() {
        reset_rate_state();
        let script = "rate-draft-test";
        // The headline use case: a macro filling a 200-cell region in a loop.
        for i in 0..200 {
            assert!(
                check_rate(script, Bucket::Draft).is_ok(),
                "draft {} must be allowed — bulk fill is the point of this gateway",
                i + 1
            );
        }
        assert!(WRITEBACK_DRAFTS_PER_MINUTE > WRITEBACK_SUBMITS_PER_MINUTE);
        assert!(WRITEBACK_READS_PER_MINUTE > WRITEBACK_SUBMITS_PER_MINUTE);
    }

    #[test]
    fn every_action_maps_to_a_bucket_matching_its_weight() {
        assert_eq!(Action::SaveDraft.bucket(), Bucket::Draft);
        assert_eq!(Action::CellGuard.bucket(), Bucket::Draft);
        assert_eq!(Action::SubmitRegion.bucket(), Bucket::Submit);
        assert_eq!(Action::SetSubmissionState.bucket(), Bucket::Submit);
        assert_eq!(Action::ListRegions.bucket(), Bucket::Read);
        assert_eq!(Action::GetLayer.bucket(), Bucket::Read);
        assert_eq!(Action::PreviewSubmission.bucket(), Bucket::Read);
        assert_eq!(Action::ListSubmissions.bucket(), Bucket::Read);
    }

    // -----------------------------------------------------------------------
    // Audit
    // -----------------------------------------------------------------------

    fn audit_entries(
        log: &std::sync::Mutex<calp::audit::AuditLog>,
    ) -> Vec<calp::audit::AuditEntry> {
        log.lock().unwrap().entries.clone()
    }

    #[test]
    fn denials_and_successes_both_write_an_audit_row() {
        let log = std::sync::Mutex::new(calp::audit::AuditLog::default());

        // The exact call the gateway's grant-denial branch makes.
        crate::net_commands::record_capability_call(
            &log,
            WRITEBACK_CAPABILITY,
            "script-1",
            false,
            Some("submitRegion — region-a"),
            Some("PermissionDenied: distribution.writeback not granted for this script"),
        );
        // ...and its success branch.
        crate::net_commands::record_capability_call(
            &log,
            WRITEBACK_CAPABILITY,
            "script-1",
            true,
            Some("submitRegion — region-a"),
            None,
        );

        let entries = audit_entries(&log);
        assert_eq!(entries.len(), 2, "both outcomes must be recorded");
        for e in &entries {
            assert!(matches!(
                e.event,
                calp::audit::AuditEvent::CapabilityCall
            ));
            assert_eq!(
                e.extra.get("capability").and_then(|v| v.as_str()),
                Some(WRITEBACK_CAPABILITY)
            );
            assert_eq!(
                e.extra.get("scriptId").and_then(|v| v.as_str()),
                Some("script-1")
            );
            assert_eq!(
                e.extra.get("detail").and_then(|v| v.as_str()),
                Some("submitRegion — region-a"),
                "the audited detail must name the action AND the region"
            );
        }
        assert_eq!(entries[0].extra.get("ok").and_then(|v| v.as_bool()), Some(false));
        assert_eq!(entries[1].extra.get("ok").and_then(|v| v.as_bool()), Some(true));
        assert!(entries[0].description.contains("DENIED"));
    }

    #[test]
    fn audit_detail_names_the_action_and_target_only() {
        let region: serde_json::Map<String, Value> = serde_json::from_value(
            json!({ "regionId": "region-a", "value": "secret-salary-figure" }),
        )
        .unwrap();
        let detail = audit_detail(Action::SaveDraft, &region);
        assert_eq!(detail, "saveDraft — region-a");
        assert!(
            !detail.contains("secret-salary-figure"),
            "submitted VALUES must never reach the audit detail"
        );

        let column: serde_json::Map<String, Value> =
            serde_json::from_value(json!({ "writebackId": "col-x" })).unwrap();
        assert_eq!(
            audit_detail(Action::SetSubmissionState, &column),
            "setSubmissionState — col-x"
        );

        let empty: serde_json::Map<String, Value> = serde_json::Map::new();
        assert_eq!(audit_detail(Action::ListRegions, &empty), "listRegions");
    }

    // -----------------------------------------------------------------------
    // Value coercion (the script path must produce EXACTLY the SubmissionValue
    // the interactive commit guard would, so the shared ValueSchema gate then
    // applies identically)
    // -----------------------------------------------------------------------

    #[test]
    fn coercion_follows_the_declared_type_not_the_value_shape() {
        // A numeric-looking product code in a TEXT region stays text.
        assert_eq!(
            coerce_submission_value(&json!("12345"), Some(ValueType::Text)),
            SubmissionValue::Text {
                value: "12345".to_string()
            }
        );
        // A numeric string in a NUMBER region becomes a number.
        assert_eq!(
            coerce_submission_value(&json!("42.5"), Some(ValueType::Number)),
            SubmissionValue::Number { value: 42.5 }
        );
        // A JSON number in a number region.
        assert_eq!(
            coerce_submission_value(&json!(7), Some(ValueType::Integer)),
            SubmissionValue::Number { value: 7.0 }
        );
        // Non-numeric text in a NUMBER region is passed through as text so the
        // authoritative schema gate produces the real message.
        assert_eq!(
            coerce_submission_value(&json!("abc"), Some(ValueType::Number)),
            SubmissionValue::Text {
                value: "abc".to_string()
            }
        );
        // Booleans, both wire forms.
        assert_eq!(
            coerce_submission_value(&json!(true), Some(ValueType::Boolean)),
            SubmissionValue::Boolean { value: true }
        );
        assert_eq!(
            coerce_submission_value(&json!("FALSE"), Some(ValueType::Boolean)),
            SubmissionValue::Boolean { value: false }
        );
        // Dates and enums travel as text (same as the interactive guard).
        assert_eq!(
            coerce_submission_value(&json!("2026-07-31"), Some(ValueType::Date)),
            SubmissionValue::Text {
                value: "2026-07-31".to_string()
            }
        );
        // Blank in any region is Empty — which `required` then rejects.
        for t in [
            Some(ValueType::Number),
            Some(ValueType::Text),
            Some(ValueType::Boolean),
            None,
        ] {
            assert_eq!(
                coerce_submission_value(&json!("   "), t.clone()),
                SubmissionValue::Empty
            );
            assert_eq!(
                coerce_submission_value(&Value::Null, t),
                SubmissionValue::Empty
            );
        }
        // Unschematized region: shape sniffing.
        assert_eq!(
            coerce_submission_value(&json!("13"), None),
            SubmissionValue::Number { value: 13.0 }
        );
        assert_eq!(
            coerce_submission_value(&json!("hello"), None),
            SubmissionValue::Text {
                value: "hello".to_string()
            }
        );
    }

    #[test]
    fn scripted_values_meet_the_same_schema_gate_as_interactive_ones() {
        // The gateway never validates by itself — it coerces, then hands the
        // value to `calp_save_writeback_draft`, which calls exactly this. This
        // asserts the pairing: what the coercion produces is what the schema
        // judges, with no script-specific leniency.
        let schema = calp::writeback::ValueSchema {
            value_type: ValueType::Integer,
            required: true,
            min: Some(1.0),
            max: Some(10.0),
            max_length: None,
            pattern: None,
            enum_values: Vec::new(),
            extra: Default::default(),
        };

        let ok = coerce_submission_value(&json!("5"), Some(ValueType::Integer));
        assert!(schema.validate(&ok).is_ok());

        let fractional = coerce_submission_value(&json!("5.5"), Some(ValueType::Integer));
        assert!(schema.validate(&fractional).is_err(), "integer region");

        let too_big = coerce_submission_value(&json!(99), Some(ValueType::Integer));
        assert!(schema.validate(&too_big).is_err(), "max bound");

        let blank = coerce_submission_value(&json!(""), Some(ValueType::Integer));
        assert!(schema.validate(&blank).is_err(), "required");

        let not_a_number = coerce_submission_value(&json!("abc"), Some(ValueType::Integer));
        assert!(schema.validate(&not_a_number).is_err(), "type");
    }
}
