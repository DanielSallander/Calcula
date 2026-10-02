//! FILENAME: app/src-tauri/src/calp_environments.rs
//! PURPOSE: The four commands behind Dev → Test → Prod: read the pipeline,
//! define it, move a pointer, and change which pointer a subscription follows.
//! CONTEXT: An environment is a name → version pointer on ONE development line;
//! promotion moves the pointer and copies nothing (`core/calp/src/environments.rs`
//! carries the model and the threat analysis). This file is the Tauri surface,
//! modelled line for line on `calp_publishers.rs` — same workspace opening, same
//! keypair handling, same "problem is REPORTED, not swallowed" shape.
//!
//! # DocumentEffect: three of these four commands take none
//!
//! `calp_promote` and `calp_set_environments` write to the WORKSPACE, not to the
//! document. They touch no `Persisted<T>`, so they construct neither
//! `mutates` — there is no saved state to dirty — nor `deliberately_clean`,
//! because `CleanReason` is a decision about a write to persisted state that
//! HAPPENS, and here no such write exists. A `deliberately_clean` would be a
//! claim about nothing. `calp_set_co_publishers` is the precedent.
//!
//! `calp_set_subscription_environment` is the exception: it edits the
//! subscription ledger in the open `.cala`, so it dirties — after the target
//! resolves, never before.
//!
//! # A promotion never mints a publisher identity
//!
//! `PublisherKeypair::load_existing`, never `load_or_create`. A profile's
//! keypair is that user's identity for every application they publish and for
//! reviewing writeback; creating one as a side effect of pressing Promote would
//! mint an identity nobody asked for, and the promotion would then be signed by
//! a key no application authorises anyway. The gateway states the same rule for
//! scripts (`require_publish_identity`).

use serde::{Deserialize, Serialize};
use tauri::State;

use crate::AppState;

// ---------------------------------------------------------------------------
// Wire types
// ---------------------------------------------------------------------------

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EnvironmentInfo {
    pub name: String,
    /// `None` = defined but nothing promoted into it yet.
    pub version: Option<String>,
    pub previous_version: String,
    pub promoted_at: String,
    /// Display name of the promoter. Not verified; `promoter_key` is.
    pub promoted_by: String,
    pub promoter_key: String,
    /// Whether THIS computer holds the key that last moved this pointer.
    pub is_you: bool,
    /// The record that set this pointer was signed by a key the application no
    /// longer authorises.
    ///
    /// Carried to the UI so the Explorer can name the environment and offer the
    /// repair. Without this field the whole marking was invisible: the core
    /// computed it, resolution refused on it, and the user saw an environment
    /// that looked healthy while every subscriber's refresh failed.
    pub unauthorized_pointer: bool,
    pub sequence: u64,
    /// Every version this environment has held, newest first — the rollback
    /// candidates, computed from the whole signed log rather than from
    /// `previous_version` alone, so a rollback across two promotions is
    /// reachable.
    pub held_versions: Vec<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PromotionHistoryEntry {
    pub sequence: u64,
    /// `"pipeline"` or `"promote"`.
    pub kind: String,
    /// Empty for a `pipeline` entry.
    pub environment: String,
    pub version: String,
    pub previous_version: String,
    /// The whole ordered pipeline, for a `pipeline` entry.
    pub environments: Vec<String>,
    pub at: String,
    pub by: String,
    pub key: String,
    pub is_you: bool,
    /// Whether the signer of this record is STILL entitled to promote.
    ///
    /// A verified signature only proves the record was not edited after signing.
    /// A record signed by a key that was never in the root-signed publisher
    /// list, or has since been removed from it, verifies exactly as cleanly —
    /// and the pointer it set is refused by `mark_unauthorized_pointers`. The
    /// history table must not present the two alike, or the audit trail that
    /// exists to name a stranger's promotion is what launders it.
    pub authorized: bool,
    /// True when this entry moved an environment BACKWARDS.
    pub is_rollback: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EnvironmentsResponse {
    pub package_name: String,
    /// The head of the development line — where the next push lands, and what
    /// the first environment promotes from. Empty for an application with no
    /// published versions.
    pub head_version: String,
    pub environments: Vec<EnvironmentInfo>,
    pub history: Vec<PromotionHistoryEntry>,
    /// Whether this computer may promote: the root key, or a delegate in the
    /// root-signed list. The same question the push gate asks.
    pub you_may_promote: bool,
    /// Whether the workspace can be written at all. False for an `https://`
    /// workspace, which is read-only — promotion there is refused up front
    /// rather than at the write.
    pub writable: bool,
    /// Set when the promotion log exists but could not be trusted. REPORTED
    /// rather than rendered as "no environments": those two must not look
    /// alike, because the tamperer's goal may be exactly to make the pipeline
    /// disappear and drop every subscriber back onto the line.
    pub problem: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EnvironmentsParams {
    pub registry_path: String,
    pub package_name: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SetEnvironmentsParams {
    pub registry_path: String,
    pub package_name: String,
    /// The whole ordered pipeline. Empty removes every environment.
    pub environments: Vec<String>,
    /// The `promotionSequence` the caller read. A colleague's promotion landing
    /// between the dialog opening and Save would otherwise be lost silently —
    /// the workspace lock serializes the writes but cannot see that this
    /// caller's READ was stale.
    pub expected_sequence: u64,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PromoteParams {
    pub registry_path: String,
    pub package_name: String,
    pub environment: String,
    /// The version to move to. Omitted takes the natural source: the line's
    /// head for the first environment, the previous environment's pointer
    /// otherwise.
    #[serde(default)]
    pub version: Option<String>,
    /// Whether the caller is asserting what it saw. A UI always is; anything
    /// that cannot say what it looked at leaves this false and gets no check.
    ///
    /// TWO FIELDS rather than an `Option<Option<String>>`, because that shape
    /// does not survive JSON: serde reads `null` as the OUTER `None`, so
    /// "the dialog showed an empty environment" and "the caller is not
    /// checking" would arrive identical — and the second silently disables the
    /// gate. Two fields cannot collapse into each other.
    #[serde(default)]
    pub check_current: bool,
    /// What the caller's dialog SHOWED this environment holding; empty for
    /// "it showed nothing". Read only when `check_current` is true.
    #[serde(default)]
    pub expected_current: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PromoteResponse {
    /// What this promotion does to data ALREADY COLLECTED in this environment —
    /// regions that moved, were removed, or are new. Empty when nothing is
    /// affected, so an application without writeback carries no noise.
    pub writeback_report: String,
    pub environment: String,
    pub from: Option<String>,
    pub to: String,
    pub is_rollback: bool,
    pub sequence: u64,
    pub environments: Vec<EnvironmentInfo>,
}

/// A read-only "what would this promotion cost" query.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PromotionImpactParams {
    pub registry_path: String,
    pub package_name: String,
    pub environment: String,
    /// The version the dialog is offering. Empty means "whatever the natural
    /// source holds", which is what the promote command would pick.
    #[serde(default)]
    pub version: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PromotionImpactResponse {
    /// What the promotion does to data already collected in this environment.
    /// Empty when nothing is affected.
    pub writeback_report: String,
    /// The CODE that changes between the version this environment holds (none,
    /// on a first promotion) and the target, with what each change means for
    /// its subscribers (plan_M8 S4, `calp::code_summary`). Empty when
    /// `code_error` is set: an empty list then means "not known", never
    /// "nothing changes".
    pub code_changes: Vec<calp::code_summary::CodeChange>,
    /// Whether anyone in this environment will be asked to approve the
    /// application's code again before it runs.
    pub asks_approval_again: bool,
    /// Why the code could not be compared -- a target signed by a key the
    /// application does not authorise, an artifact that fails its signed
    /// checksum, a version that cannot be read. NAMED, never swallowed, and
    /// serialized as `null` when there is none (TS `codeError: string | null`).
    /// The writeback report is computed either way -- unless where the
    /// environment points cannot be read, which leaves BOTH unknown, and both
    /// say so.
    pub code_error: Option<String>,
}

impl PromotionImpactResponse {
    /// The answer for an unnamed target: nothing is known, nothing is claimed.
    fn empty() -> Self {
        PromotionImpactResponse {
            writeback_report: String::new(),
            code_changes: Vec::new(),
            asks_approval_again: false,
            code_error: None,
        }
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SetSubscriptionEnvironmentParams {
    pub registry_url: String,
    pub package_name: String,
    /// The environment to follow, or `None` to follow the development line.
    #[serde(default)]
    pub environment: Option<String>,
    /// The pin to use when moving BACK to the line. Ignored when `environment`
    /// is given.
    #[serde(default)]
    pub version_pin: String,
}

// ---------------------------------------------------------------------------
// Shared shaping
// ---------------------------------------------------------------------------

fn to_infos(
    envs: &[calp::environments::Environment],
    log_held: &dyn Fn(&str) -> Vec<String>,
    profile: &std::path::Path,
) -> Vec<EnvironmentInfo> {
    envs.iter()
        .map(|e| EnvironmentInfo {
            name: e.name.clone(),
            version: e.version.clone(),
            previous_version: e.previous_version.clone(),
            promoted_at: e.promoted_at.clone(),
            promoted_by: e.promoted_by.clone(),
            is_you: !e.promoter_key.is_empty()
                && calp::signing::profile_holds_publisher_key(profile, &e.promoter_key)
                    .unwrap_or(false),
            promoter_key: e.promoter_key.clone(),
            unauthorized_pointer: e.unauthorized_pointer,
            sequence: e.sequence,
            held_versions: log_held(&e.name)
                .into_iter()
                .filter(|v| Some(v) != e.version.as_ref())
                .collect(),
        })
        .collect()
}

/// Environments as the UI wants them, from a workspace already opened.
fn read_environments(
    registry: &dyn calp::transport::WorkspaceTransport,
    package_name: &str,
    profile: &std::path::Path,
) -> (Vec<EnvironmentInfo>, Vec<PromotionHistoryEntry>, String) {
    let envs = match calp::environments::environments(registry, package_name) {
        Ok(e) => e,
        Err(e) => return (Vec::new(), Vec::new(), e.to_string()),
    };
    let history = calp::environments::promotion_history(registry, package_name).unwrap_or_default();

    // Who may promote TODAY. A record's signature verifying says only that
    // nobody edited it; it says nothing about whether its signer was ever
    // entitled to promote. Resolved once for the whole table.
    let authorized_keys =
        calp::environments::authorized_promoter_keys(registry, package_name).unwrap_or_default();

    // Rollback candidates per environment.
    //
    // ONE FOLD, IN CORE. This used to be a local closure over the history we
    // already held — cheaper by one read, and a second source of truth for
    // "which versions has this environment run". Writeback carry-forward now
    // asks the same question, and the answer decides whether a subscriber's own
    // submissions still count after a rollback. Two folds would be two answers,
    // and the one that drifted would be wrong in silence.
    let held = |name: &str| -> Vec<String> {
        calp::environments::versions_held_by(registry, package_name, name).unwrap_or_default()
    };

    let infos = to_infos(&envs, &held, profile);

    // The history, newest first, with each promotion's direction resolved so
    // the Inspector can say "rolled back" without re-deriving it.
    let mut rows: Vec<PromotionHistoryEntry> = history
        .iter()
        .map(|r| {
            let (kind, environment, version, previous_version, environments) = match &r.event {
                calp::environments::PromotionEvent::Pipeline { environments } => (
                    "pipeline",
                    String::new(),
                    String::new(),
                    String::new(),
                    environments.clone(),
                ),
                calp::environments::PromotionEvent::Promote {
                    environment, version, previous_version,
                } => (
                    "promote",
                    environment.clone(),
                    version.clone(),
                    previous_version.clone(),
                    Vec::new(),
                ),
            };
            let is_rollback = match (
                calp::SemVer::parse(&previous_version),
                calp::SemVer::parse(&version),
            ) {
                (Ok(prev), Ok(next)) => next < prev,
                _ => false,
            };
            PromotionHistoryEntry {
                sequence: r.sequence,
                kind: kind.to_string(),
                environment,
                version,
                previous_version,
                environments,
                at: r.at.clone(),
                by: r.by.clone(),
                is_you: calp::signing::profile_holds_publisher_key(profile, &r.key)
                    .unwrap_or(false),
                authorized: !r.key.is_empty() && authorized_keys.iter().any(|k| k == &r.key),
                key: r.key.clone(),
                is_rollback,
            }
        })
        .collect();
    rows.reverse();

    (infos, rows, String::new())
}

/// This profile's publisher key (lowercase hex), or empty when it has none. A
/// promotion never mints one (see the module header).
fn profile_public_key(profile: &std::path::Path) -> String {
    calp::signing::PublisherKeypair::load_existing(profile)
        .ok()
        .flatten()
        .map(|k| k.public_key_hex())
        .unwrap_or_default()
}

/// May this computer promote? The push gate's question, asked the push gate's
/// way — root or a delegate in the root-signed list — and anchored at the
/// application's PROVED root (its first version, verified by its own
/// signature), the same root [`promotion_gate`] judges by. Never the unsigned
/// listing's first entry, and never the head signer: those name a planter as
/// readily as the creator.
fn may_promote(
    registry: &dyn calp::transport::WorkspaceTransport,
    package_name: &str,
    profile: &std::path::Path,
) -> (bool, String) {
    let Ok(manifest) = registry.get_application_manifest(package_name) else {
        return (false, String::new());
    };
    let Some(head) = calp::publish::head_version(&manifest) else {
        return (false, head_of(&manifest));
    };
    let may = calp::publishers::root_anchored_publishers(registry, package_name)
        .map(|authority| authority.allows(&profile_public_key(profile)))
        .unwrap_or(false);
    (may, head.to_string())
}

/// The version a promotion with nothing typed would point `environment` at:
/// the line's head for the first environment, the previous environment's
/// version otherwise (core `promote`'s "natural source"). `None` when there is
/// none -- core then refuses the promotion with its own words.
///
/// `calp_promote` hands the answer to core as an EXPLICIT version, so the
/// version this gate judged is the one core signs, and core's own linear rule
/// still applies to it: a disagreement here can only refuse, never sign an
/// unjudged version.
fn natural_promotion_target(
    registry: &dyn calp::transport::WorkspaceTransport,
    package: &str,
    environment: &str,
) -> Result<Option<calp::SemVer>, calp::CalpError> {
    let envs = calp::environments::environments(registry, package)?;
    let Some(index) = envs.iter().position(|e| e.name == environment) else {
        return Ok(None);
    };
    if index == 0 {
        let manifest = registry.get_application_manifest(package)?;
        return Ok(calp::publish::head_version(&manifest));
    }
    Ok(envs[index - 1].version.as_deref().and_then(|v| calp::SemVer::parse(v).ok()))
}

/// THE PROMOTION'S DEVELOPER GATE, before anything is signed.
///
/// A promotion is a SIGNED decision about which version every subscriber of an
/// environment receives, so it asks what every developer door asks
/// (BUG-0262 and the developer anchor) -- core `promote`'s own authority check
/// finds the root through the unsigned listing and falls back to the head
/// signer, which a share-writer's planted first version satisfies:
///
/// 1. the application's root, PROVED, against what this computer remembers
///    (`CheckOnly`: a contradiction or a rolled-back co-publisher list refuses;
///    moving a pointer is not an act that records an anchor);
/// 2. the promoter's own key must be one that proved root authorises;
/// 3. the TARGET version's signer (from its verified manifest) must be too.
///
/// Returns the target it judged (`None` when there is none to judge -- core
/// refuses that promotion itself).
pub(crate) fn promotion_gate(
    registry: &dyn calp::transport::WorkspaceTransport,
    scope: &calp::WorkspaceScope,
    profile: &std::path::Path,
    package: &str,
    environment: &str,
    version: Option<&calp::SemVer>,
) -> Result<Option<calp::SemVer>, calp::CalpError> {
    let authority = calp::publishers::root_anchored_publishers(registry, package)?;
    let check = calp::AnchorGate { profile_dir: profile, scope, policy: calp::AnchorPolicy::CheckOnly };
    calp::developer_anchor::anchor_root(&check, package, &authority)?;
    if !authority.allows(&profile_public_key(profile)) {
        return Err(calp::CalpError::NotAuthorizedPublisher {
            package: package.to_string(),
            root_holder: authority.root_holder(),
        });
    }
    let target = match version {
        Some(v) => Some(v.clone()),
        None => natural_promotion_target(registry, package, environment)?,
    };
    if let Some(target) = &target {
        let target = target.to_string();
        // A version that does not exist is core's to refuse, in its words.
        if registry.version_exists(package, &target) {
            let signed = calp::integrity::load_signed_manifest_via(registry, package, &target)?;
            calp::publishers::authorize_signer(
                registry,
                package,
                &target,
                &signed.manifest.publisher_key,
                &signed.manifest.publisher_name,
                &check,
            )?;
        }
    }
    Ok(target)
}

fn head_of(manifest: &calp::manifest::ApplicationManifest) -> String {
    calp::publish::head_version(manifest)
        .map(|v| v.to_string())
        .unwrap_or_default()
}

/// An `https://` workspace is read-only. Refused UP FRONT rather than at the
/// write, so the UI can grey the action with a reason instead of offering a
/// button that always fails. Same predicate the push gate uses.
fn workspace_is_writable(registry_path: &str) -> bool {
    !registry_path.trim_start().to_lowercase().starts_with("http")
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

/// The application's pipeline, its promotion history, and whether this computer
/// may move a pointer.
///
/// Reachable from the Application Inspector as well as the main window: the
/// Inspector's whole job is answering "what is in this application and who put
/// it there", and a promotion is exactly that. Read-only, so widening the guard
/// costs nothing.
#[tauri::command]
pub fn calp_environments(
    params: EnvironmentsParams,
    window: tauri::Window,
) -> Result<EnvironmentsResponse, String> {
    crate::security::window_guard::require_label(
        &window,
        crate::security::window_guard::MAIN_AND_APPLICATION_INSPECTOR,
    )?;
    let (registry, _scope) = crate::calp_registry::open_workspace_scoped(&params.registry_path)
        .map_err(|e| e.to_string())?;
    let profile = crate::calp_commands::calcula_profile_dir();

    let (environments, history, problem) =
        read_environments(registry.as_ref(), &params.package_name, &profile);
    let (you_may_promote, head_version) =
        may_promote(registry.as_ref(), &params.package_name, &profile);

    Ok(EnvironmentsResponse {
        package_name: params.package_name,
        head_version,
        environments,
        history,
        you_may_promote,
        writable: workspace_is_writable(&params.registry_path),
        problem,
    })
}

/// What a promotion would do to data already collected in the target
/// environment — regions that moved, were removed, or are new.
///
/// A SEPARATE READ so the promote window can show it BEFORE the confirm. The
/// same report comes back from `calp_promote`, but a report that arrives after
/// the decision is a receipt, not a warning: a promotion is a version change for
/// everyone in that environment, and it inherits every rule a version change has
/// always had for collected data.
///
/// Read-only, no `DocumentEffect`, and reachable from the Inspector for the same
/// reason `calp_environments` is.
///
/// It also carries the CODE summary (plan_M8 S4): what code changes for the
/// environment's subscribers, read before anything else in the Promote dialog
/// -- including on a FIRST promotion, where every piece of the target's code is
/// new. No new command: it is the same "what would this promotion cost" read.
#[tauri::command]
pub fn calp_promotion_impact(
    params: PromotionImpactParams,
    window: tauri::Window,
) -> Result<PromotionImpactResponse, String> {
    crate::security::window_guard::require_label(
        &window,
        crate::security::window_guard::MAIN_AND_APPLICATION_INSPECTOR,
    )?;
    promotion_impact_core(
        &params.registry_path,
        &params.package_name,
        &params.environment,
        &params.version,
    )
}

/// [`calp_promotion_impact`] without the window: everything it computes, so a
/// test can hold it against real signed workspaces.
pub(crate) fn promotion_impact_core(
    registry_path: &str,
    package: &str,
    environment: &str,
    version: &str,
) -> Result<PromotionImpactResponse, String> {
    let (registry, _scope) =
        crate::calp_registry::open_workspace_scoped(registry_path).map_err(|e| e.to_string())?;

    // NO GUESS AT THE TARGET. The promote command picks a natural source when
    // no version is named — head for the first environment, the previous one's
    // pointer otherwise — and reproducing that rule here would be a second copy
    // of it, free to drift into reporting the cost of a promotion that is not
    // the one about to happen. The dialog always knows the version it is
    // offering, so an unnamed one answers nothing rather than answering wrong.
    let to = version.trim().to_string();
    if to.is_empty() {
        return Ok(PromotionImpactResponse::empty());
    }

    // Where the target currently points, from the SIGNED log — the version its
    // subscribers are actually on, which is what the change is measured from.
    //
    // A LOG THAT CANNOT BE READ IS NOT "NO VERSION". Read as one, the summary
    // would be a first promotion's: every piece of the target's code "new",
    // no approval reused, and no "stops running" row for code the environment
    // runs today -- a read failure that looks like a normal answer. It is
    // reported, in place of both reports.
    let from = match calp::environments::environments(registry.as_ref(), package) {
        Ok(envs) => envs
            .into_iter()
            .find(|e| e.name == environment)
            .and_then(|e| e.version),
        Err(e) => {
            let why = format!("where {environment} points cannot be read ({e})");
            return Ok(PromotionImpactResponse {
                writeback_report: format!(
                    "What this promotion does to data already collected in {environment} is not known: {why}"
                ),
                code_changes: Vec::new(),
                asks_approval_again: false,
                code_error: Some(why),
            });
        }
    };

    let writeback_report = describe_writeback_change(registry_path, package, environment, from.as_deref(), &to);

    // A failure to compare the code is REPORTED beside the writeback report,
    // never instead of it and never as an empty list: "no code changes" and
    // "the code could not be read" must not look alike.
    let (code_changes, asks_approval_again, code_error) =
        match promotion_code_summary(registry_path, package, environment, from.as_deref(), &to) {
            Ok(summary) => (summary.changes, summary.asks_approval_again, None),
            Err(e) => (Vec::new(), false, Some(e)),
        };

    Ok(PromotionImpactResponse { writeback_report, code_changes, asks_approval_again, code_error })
}

/// The code summary between the environment's pointer and the target.
///
/// * THE TARGET is opened through the AUTHORISED reader -- its signer must be one
///   the application's proved root authorises, anchored against what this
///   computer remembers (`CheckOnly`) -- which is the judgement
///   [`promotion_gate`] makes about the target at Promote (the gate also asks
///   for the promoter's own key, which a preview need not). So the preview never
///   shows code the promotion would refuse over its signer.
/// * THE POINTER'S VERSION is opened through the VERIFIED reader: it is what the
///   environment's subscribers already hold, even if its signer was removed
///   from the publisher list since.
/// * Neither walks every artifact up front. Both are read as
///   `DiffSide::PublishedChecked`, so each code artifact the summary reads is
///   held to its signed checksum, and no sheet is read at all.
/// * A button cell's command is judged against the same list the subscriber's
///   admission uses (`button_cells::DISTRIBUTABLE_BUTTON_COMMANDS`).
fn promotion_code_summary(
    registry_path: &str,
    package: &str,
    environment: &str,
    from: Option<&str>,
    to: &str,
) -> Result<calp::code_summary::CodeSummary, String> {
    let (to_registry, to_version, to_manifest) =
        crate::calp_inspector::open_authorized_content(registry_path, package, &format!("={to}"), false, None)
            .map_err(|e| format!("v{to} cannot be shown: {e}"))?;
    let held = match from {
        Some(version) => Some(
            crate::calp_inspector::open_verified_content(registry_path, package, &format!("={version}"), false)
                .map_err(|e| format!("v{version}, the version {environment} holds, cannot be read: {e}"))?,
        ),
        None => None,
    };
    let to_side = calp::DiffSide::PublishedChecked {
        transport: to_registry.as_ref(),
        package,
        version: &to_version,
        manifest: &to_manifest,
    };
    let from_side = held.as_ref().map(|(registry, version, manifest)| calp::DiffSide::PublishedChecked {
        transport: registry.as_ref(),
        package,
        version,
        manifest,
    });
    calp::code_summary::code_summary(
        from_side.as_ref(),
        &to_side,
        &calp::DiffOptions::default(),
        crate::button_cells::DISTRIBUTABLE_BUTTON_COMMANDS,
    )
    .map_err(|e| format!("the code of v{to} could not be compared: {e}"))
}

/// Define the ordered pipeline. An empty list removes every environment.
///
/// No `DocumentEffect`: this writes to the workspace, not to the document.
#[tauri::command]
pub fn calp_set_environments(
    params: SetEnvironmentsParams,
    window: tauri::Window,
) -> Result<EnvironmentsResponse, String> {
    crate::security::window_guard::require_label(&window, crate::security::window_guard::MAIN)?;
    if !workspace_is_writable(&params.registry_path) {
        return Err(
            "CALP_ENV_READONLY_WORKSPACE: this workspace is served over HTTP and cannot be \
             written to. Environments are defined in the workspace that holds the application."
                .to_string(),
        );
    }
    let (registry, _scope) = crate::calp_registry::open_workspace_scoped(&params.registry_path)
        .map_err(|e| e.to_string())?;
    let profile = crate::calp_commands::calcula_profile_dir();
    let keypair = require_identity(&profile)?;

    calp::environments::set_pipeline(
        registry.as_ref(),
        &params.package_name,
        &params.environments,
        params.expected_sequence,
        &keypair,
        &chrono::Utc::now().to_rfc3339(),
    )
    .map_err(|e| e.to_string())?;

    let (environments, history, problem) =
        read_environments(registry.as_ref(), &params.package_name, &profile);
    let (you_may_promote, head_version) =
        may_promote(registry.as_ref(), &params.package_name, &profile);
    Ok(EnvironmentsResponse {
        package_name: params.package_name,
        head_version,
        environments,
        history,
        you_may_promote,
        writable: true,
        problem,
    })
}

/// Move one environment's pointer. Forward is a promotion; to a version it held
/// before is a rollback. Both go through the same gates and the same signature.
///
/// No `DocumentEffect`: this writes to the workspace, not to the document.
#[tauri::command]
pub fn calp_promote(
    state: State<AppState>,
    params: PromoteParams,
    window: tauri::Window,
) -> Result<PromoteResponse, String> {
    crate::security::window_guard::require_label(&window, crate::security::window_guard::MAIN)?;
    if !workspace_is_writable(&params.registry_path) {
        return Err(
            "CALP_ENV_READONLY_WORKSPACE: this workspace is served over HTTP and cannot be \
             written to. Promote from a workspace you can write to."
                .to_string(),
        );
    }
    let (registry, scope) = crate::calp_registry::open_workspace_scoped(&params.registry_path)
        .map_err(|e| e.to_string())?;
    let profile = crate::calp_commands::calcula_profile_dir();
    let keypair = require_identity(&profile)?;

    let requested = match &params.version {
        Some(v) => Some(calp::SemVer::parse(v).map_err(|e| e.to_string())?),
        None => None,
    };

    // GATE: who this computer remembers as the creator, whether that proved
    // root authorises THIS key, and whether it authorises whoever signed the
    // version the pointer would move to -- before anything is signed. Refusals
    // leave an always-on `SignerRefused` row at the "promote" door.
    let version = match promotion_gate(
        registry.as_ref(),
        &scope,
        &profile,
        &params.package_name,
        &params.environment,
        requested.as_ref(),
    ) {
        // The version the gate JUDGED is the one core signs.
        Ok(judged) => judged.or(requested),
        Err(refused) => {
            let label = requested.as_ref().map(|v| v.to_string()).unwrap_or_default();
            crate::calp_inspector::record_signer_refusal(&state, "promote", &params.package_name, &label, &refused);
            return Err(crate::calp_inspector::developer_refusal_text(&refused));
        }
    };

    let expected_current = params.check_current.then(|| {
        let shown = params.expected_current.trim();
        if shown.is_empty() { None } else { Some(shown.to_string()) }
    });

    let result = calp::environments::promote(
        registry.as_ref(),
        &params.package_name,
        &params.environment,
        version,
        expected_current,
        &keypair,
        &chrono::Utc::now().to_rfc3339(),
    )
    .map_err(|e| e.to_string())?;

    let (environments, _history, _problem) =
        read_environments(registry.as_ref(), &params.package_name, &profile);
    Ok(PromoteResponse {
        writeback_report: describe_writeback_change(
            &params.registry_path,
            &params.package_name,
            &result.environment,
            result.from.as_deref(),
            &result.to,
        ),
        environment: result.environment,
        from: result.from,
        to: result.to,
        is_rollback: result.is_rollback,
        sequence: result.sequence,
        environments,
    })
}

/// What a promotion does to data already collected in this environment.
///
/// A PROMOTION IS A VERSION CHANGE FOR EVERY SUBSCRIBER OF THAT ENVIRONMENT, so
/// it inherits every rule a version change has always had for collected data:
/// a moved or resized region invalidates strict submissions, a removed region
/// orphans them. The promoter is the person deciding, so the promoter is the
/// person who has to see it — the refresh preview's version of this warning
/// arrives too late, on somebody else's screen, after the decision.
///
/// Empty when nothing is affected, so an application without writeback carries
/// no noise about a feature it does not use.
///
/// READ FROM THE SIGNED MANIFESTS, through the verified reader the code summary
/// beside it uses for the version an environment holds
/// (`calp_inspector::open_verified_content`). The regions and model columns a
/// version collects into are declared in its version manifest, and only the
/// signed reading of it is the publisher's statement: the unsigned copy is
/// whatever anyone who can write to the share last wrote, so reading it let an
/// edit make a promotion that orphans collected data say "nothing affected".
///
/// A VERSION THAT CANNOT BE READ THAT WAY IS SAID, never read as one that
/// declares nothing -- which reported "nothing affected", or a region "no
/// longer" existing in a version nobody read. The sentence takes the report's
/// place, the way an unreadable pointer already does in
/// [`promotion_impact_core`].
fn describe_writeback_change(
    registry_path: &str,
    package_name: &str,
    environment: &str,
    from: Option<&str>,
    to: &str,
) -> String {
    // Nothing promoted into this environment yet: subscribers receive the
    // version whole, and there is no earlier collection to invalidate -- so
    // there is nothing to read either.
    let Some(from) = from else {
        return String::new();
    };
    let signed = |version: &str| -> Result<calp::manifest::VersionManifest, String> {
        crate::calp_inspector::open_verified_content(registry_path, package_name, &format!("={version}"), false)
            .map(|(_registry, _version, manifest)| manifest)
    };
    let not_known = |why: String| -> String {
        format!("What this promotion does to data already collected in {environment} is not known: {why}")
    };
    let held = match signed(from) {
        Ok(manifest) => manifest,
        Err(e) => {
            return not_known(format!("v{from}, the version {environment} holds, cannot be read ({e})"));
        }
    };
    let target = match signed(to) {
        Ok(manifest) => manifest,
        Err(e) => return not_known(format!("v{to} cannot be read ({e})")),
    };
    let old_regions = held.writeback_regions.unwrap_or_default();
    let new_regions = target.writeback_regions.unwrap_or_default();
    let old_columns = held.model_writebacks.unwrap_or_default();
    let new_columns = target.model_writebacks.unwrap_or_default();
    // An application may collect through MODEL COLUMNS and no grid regions at
    // all, so the empty short-circuit has to consider both.
    if old_regions.is_empty() && new_regions.is_empty() && old_columns.is_empty() && new_columns.is_empty() {
        return String::new();
    }

    let compat = calp::writeback::check_region_compatibility(&old_regions, &new_regions);
    let mut parts: Vec<String> = Vec::new();
    if !compat.incompatible.is_empty() {
        parts.push(format!(
            "{} region(s) moved or changed shape, so submissions already collected against \
             them stop counting: {}",
            compat.incompatible.len(),
            compat
                .incompatible
                .iter()
                .map(|(id, reason)| format!("{id} ({reason})"))
                .collect::<Vec<_>>()
                .join(", ")
        ));
    }
    if !compat.removed.is_empty() {
        parts.push(format!(
            "{} region(s) no longer exist in v{to}, so what was collected there is orphaned: {}",
            compat.removed.len(),
            compat.removed.join(", ")
        ));
    }
    if !compat.added.is_empty() {
        parts.push(format!(
            "{} new region(s) start empty: {}",
            compat.added.len(),
            compat.added.join(", ")
        ));
    }

    // MODEL WRITEBACK COLUMNS TOO. The subscriber's refresh path runs
    // `check_model_writeback_compatibility` and audits what it loses, so a
    // promotion that re-keys or removes a master-data column used to report
    // "nothing affected" to the promoter and surface later, on somebody else's
    // machine. The promoter is the one deciding, so the promoter is the one who
    // has to see it — which is this helper's own stated contract.
    let model_compat = calp::writeback::check_model_writeback_compatibility(&old_columns, &new_columns);
    if !model_compat.incompatible.is_empty() {
        parts.push(format!(
            "{} writeback column(s) changed key or shape, so values already collected against \
             them stop counting: {}",
            model_compat.incompatible.len(),
            model_compat
                .incompatible
                .iter()
                .map(|(id, reason)| format!("{id} ({reason})"))
                .collect::<Vec<_>>()
                .join(", ")
        ));
    }
    if !model_compat.removed.is_empty() {
        parts.push(format!(
            "{} writeback column(s) no longer exist in v{to}: {}",
            model_compat.removed.len(),
            model_compat.removed.join(", ")
        ));
    }

    parts.join(" · ")
}

/// Change which environment a subscription follows, or move it to the
/// development line.
///
/// PULLS NOTHING. It rewrites the target and stops; the next refresh is what
/// moves the content, and the preview shows what that will be. Making this pull
/// would turn a two-word choice into an unreviewed content change.
#[tauri::command]
pub fn calp_set_subscription_environment(
    state: State<AppState>,
    file_state: State<crate::persistence::FileState>,
    params: SetSubscriptionEnvironmentParams,
    window: tauri::Window,
) -> Result<(), String> {
    crate::security::window_guard::require_label(&window, crate::security::window_guard::MAIN)?;

    let (registry, scope) = crate::calp_registry::open_workspace_scoped(&params.registry_url)
        .map_err(|e| e.to_string())?;

    // The target must RESOLVE before anything is written. A switch to an
    // environment that does not exist, or one nothing has been promoted into,
    // would leave the subscription pointing at nothing — refusing every refresh
    // from then on, having been accepted here without complaint.
    let target = match &params.environment {
        Some(env) => calp::manifest::SubscriptionTarget::Environment(env.clone()),
        None => calp::manifest::SubscriptionTarget::Line(
            calp::VersionPin::parse(&params.version_pin).map_err(|e| {
                format!(
                    "CALP_ENV_SWITCH_NO_PIN: moving back to the development line needs a version \
                     pin (for example `latest` or `^1.0`): {e}"
                )
            })?,
        ),
    };
    // THE ANCHOR THE REFRESH WILL USE. This gate exists so a switch that the
    // next refresh would refuse is refused HERE instead. Asked against the
    // workspace's own account it answers a different question than the refresh
    // does, and accepts exactly the switch it was written to catch.
    calp::environments::resolve_target_via(
        registry.as_ref(),
        &params.package_name,
        &target,
        calp::environments::PromotionTrust::Pinned {
            scope: &scope,
            profile_dir: &crate::calp_commands::calcula_profile_dir(),
        },
    )
    .map_err(|e| e.to_string())?;

    // EVERY REFUSAL FIRST, then the effect. `DocumentEffect::mutates` dirties
    // AT CONSTRUCTION, so building it before the not-subscribed check marked a
    // clean workbook as unsaved for an operation that then refused — the user
    // got a "save changes?" prompt for a switch that never happened. A no-op
    // switch is refused here too, rather than signing an audit row reading
    // "now follows environment 'prod' (was: environment 'prod')".
    {
        let subs = state.subscriptions.read().map_err(|e| e.to_string())?;
        let Some(existing) = subs.subscriptions.iter().find(|s| {
            s.package_name == params.package_name
                && calp::same_workspace(&s.registry_url, &params.registry_url)
        }) else {
            return Err(format!(
                "CALP_ENV_SWITCH_NOT_SUBSCRIBED: this workbook does not subscribe to '{}' from \
                 that workspace.",
                params.package_name
            ));
        };
        let already = existing.environment == calp::manifest::Subscription::environment_for(&target)
            && existing.version_pin == calp::manifest::Subscription::pin_for(&target);
        if already {
            return Ok(());
        }
    }

    // The last refusal is behind us.
    let effect = crate::document_effect::DocumentEffect::mutates(&file_state);
    let described = {
        let mut subs = state.subscriptions.write(&effect).map_err(|e| e.to_string())?;
        let Some(sub) = subs.subscriptions.iter_mut().find(|s| {
            s.package_name == params.package_name
                && calp::same_workspace(&s.registry_url, &params.registry_url)
        }) else {
            return Err(format!(
                "CALP_ENV_SWITCH_NOT_SUBSCRIBED: this workbook does not subscribe to '{}' from \
                 that workspace.",
                params.package_name
            ));
        };
        let was = sub
            .environment
            .clone()
            .map(|e| format!("environment '{e}'"))
            .unwrap_or_else(|| format!("the development line (pin {})", sub.version_pin));
        sub.version_pin = calp::manifest::Subscription::pin_for(&target);
        sub.environment = calp::manifest::Subscription::environment_for(&target);
        let now = sub
            .environment
            .clone()
            .map(|e| format!("environment '{e}'"))
            .unwrap_or_else(|| format!("the development line (pin {})", sub.version_pin));
        format!("'{}' now follows {} (was: {})", params.package_name, now, was)
    };

    // WHAT THE SWITCH ACTUALLY CHANGED, invalidated. `sub.environment` is the
    // field every writeback reader filters on, so re-targeting it changes what
    // `=GATHER()` and the BI dataset tables should compute RIGHT NOW — the
    // published content is what waits for the next refresh, not this. Without
    // the invalidation the model tables kept serving the previous stream's
    // submissions until an unrelated submit, approve, pull or reopen, and the
    // steady state after a linear promotion is both environments on one version,
    // so nothing else would have touched it.
    crate::calp_commands::invalidate_gather_cache(&state);

    crate::calp_commands::record_audit_event(
        &state,
        calp::audit::AuditEvent::SubscriptionEnvironmentChanged,
        described,
    );
    Ok(())
}

/// The signing identity, or a refusal that does not create one.
fn require_identity(
    profile: &std::path::Path,
) -> Result<calp::signing::PublisherKeypair, String> {
    match calp::signing::PublisherKeypair::load_existing(profile).map_err(|e| e.to_string())? {
        Some(kp) => Ok(kp),
        None => Err(
            "CALP_ENV_NO_IDENTITY: this computer has no publisher key yet, so it cannot sign a \
             promotion. Publish an application first — that is what creates your key."
                .to_string(),
        ),
    }
}

// The M2 writeback INTERLOCK stood here: promotion of any application that
// collected writeback was refused by name, because a submission was filed under
// the version it was made against and carried nothing to say which stream it
// came from — so promoting prod onto a version testers had been filling in
// turned their dummy answers into production data, in every prod subscriber's
// GATHER total and in the publisher's dashboard, indistinguishable from the
// real thing.
//
// It is gone because the cause is: `WritebackSubmission.environment` is stamped
// at submit and every reader filters on it through `calp::writeback::visible_in`.
// What promotion now carries instead is `describe_writeback_change` above —
// not a refusal, but the report a promoter is owed about data already collected.
