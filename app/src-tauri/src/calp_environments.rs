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
                key: r.key.clone(),
                is_rollback,
            }
        })
        .collect();
    rows.reverse();

    (infos, rows, String::new())
}

/// May this computer promote? The push gate's question, asked the push gate's
/// way — root or a delegate in the root-signed list.
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
    let keys = calp::publish::resolve_authorized_keys(registry, package_name, &head)
        .unwrap_or_default();
    let may = keys
        .iter()
        .any(|k| calp::signing::profile_holds_publisher_key(profile, k).unwrap_or(false));
    (may, head.to_string())
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
#[tauri::command]
pub fn calp_promotion_impact(
    params: PromotionImpactParams,
    window: tauri::Window,
) -> Result<PromotionImpactResponse, String> {
    crate::security::window_guard::require_label(
        &window,
        crate::security::window_guard::MAIN_AND_APPLICATION_INSPECTOR,
    )?;
    let (registry, _scope) = crate::calp_registry::open_workspace_scoped(&params.registry_path)
        .map_err(|e| e.to_string())?;

    // Where the target currently points, from the SIGNED log — the version its
    // subscribers are actually on, which is what the change is measured from.
    let from = calp::environments::environments(registry.as_ref(), &params.package_name)
        .ok()
        .and_then(|envs| {
            envs.into_iter()
                .find(|e| e.name == params.environment)
                .and_then(|e| e.version)
        });

    // NO GUESS AT THE TARGET. The promote command picks a natural source when
    // no version is named — head for the first environment, the previous one's
    // pointer otherwise — and reproducing that rule here would be a second copy
    // of it, free to drift into reporting the cost of a promotion that is not
    // the one about to happen. The dialog always knows the version it is
    // offering, so an unnamed one answers nothing rather than answering wrong.
    let to = params.version.trim().to_string();
    if to.is_empty() {
        return Ok(PromotionImpactResponse { writeback_report: String::new() });
    }

    Ok(PromotionImpactResponse {
        writeback_report: describe_writeback_change(
            registry.as_ref(),
            &params.package_name,
            from.as_deref(),
            &to,
        ),
    })
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
    let (registry, _scope) = crate::calp_registry::open_workspace_scoped(&params.registry_path)
        .map_err(|e| e.to_string())?;
    let profile = crate::calp_commands::calcula_profile_dir();
    let keypair = require_identity(&profile)?;

    let version = match &params.version {
        Some(v) => Some(calp::SemVer::parse(v).map_err(|e| e.to_string())?),
        None => None,
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
            registry.as_ref(),
            &params.package_name,
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
fn describe_writeback_change(
    registry: &dyn calp::transport::WorkspaceTransport,
    package_name: &str,
    from: Option<&str>,
    to: &str,
) -> String {
    let regions = |version: &str| -> Vec<calp::WritebackRegionDeclaration> {
        registry
            .get_version_manifest(package_name, version)
            .ok()
            .and_then(|m| m.writeback_regions)
            .unwrap_or_default()
    };
    let new_regions = regions(to);
    // Nothing promoted into this environment yet: subscribers receive the
    // version whole, and there is no earlier collection to invalidate.
    let Some(from) = from else {
        return String::new();
    };
    let old_regions = regions(from);
    if old_regions.is_empty() && new_regions.is_empty() {
        return String::new();
    }

    let compat = calp::writeback::check_region_compatibility(&old_regions, &new_regions);
    let mut parts: Vec<String> = Vec::new();
    if !compat.incompatible.is_empty() {
        parts.push(format!(
            "{} region(s) moved or changed shape, so submissions already collected against              them stop counting: {}",
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

    let (registry, _scope) = crate::calp_registry::open_workspace_scoped(&params.registry_url)
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
    calp::environments::resolve_target(registry.as_ref(), &params.package_name, &target)
        .map_err(|e| e.to_string())?;

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
