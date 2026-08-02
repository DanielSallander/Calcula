//! FILENAME: app/src-tauri/src/scripting/distribution_gateway.rs
//! PURPOSE: The ONE broker-reachable door for scripted .calp DISTRIBUTION —
//!          `script_distribution`, an action-multiplexed gateway behind TWO
//!          capabilities that are deliberately NOT one:
//!            * `distribution.publish`   — OUTBOUND. Pushes this workbook to a
//!              registry under the USER'S publisher identity, where other people
//!              will pull it.
//!            * `distribution.subscribe` — INBOUND. Brings SOMEBODY ELSE'S
//!              content — including object scripts, module scripts, notebooks
//!              and model overlays — into this workbook.
//!          They are different risk classes, so they are different grants with
//!          different consent text. Holding one never implies the other.
//!
//! CONTEXT: Same shape AND same rigor as `script_writeback`
//!          (scripting/writeback_gateway.rs) and `script_bi_model`
//!          (bi/model_editor.rs): main-window guard, a SERVER-SIDE action
//!          allowlist, an authoritative Rust re-check of the capability grant
//!          (the TS broker gate is advisory — assume the renderer is
//!          compromised), its own rate buckets, always-on `record_capability_call`
//!          audit, and dispatch into the SAME `calp_*` command functions the
//!          interactive UI calls.
//!
//! WHY DISPATCHING INTO THE EXISTING COMMANDS IS THE SECURITY DESIGN, not a
//! convenience: `calp_pull` / `calp_refresh_apply` run `calp::pull::pull`, which
//! verifies the Ed25519 manifest signature, resolves TOFU against the profile's
//! pin store, re-hashes every artifact against the signature-sealed checksum map
//! and enforces `min_app_version`. There is no second implementation here that
//! could drift, and therefore no "script path" that skips a check.
//!
//! THREE THINGS A SCRIPT MAY NEVER DO HERE, and where each is enforced:
//!   1. CONSENT ON THE USER'S BEHALF. Nothing in this file mounts, runs or
//!      approves anything. A pulled object script lands forced-Restricted +
//!      Distributed (calp::pull), i.e. unmounted and consent-gated; module
//!      scripts and notebooks land inert. The gateway returns data; the human
//!      still answers the consent prompt.
//!   2. WIDEN THE TRUST SET. Every action that names a registry is refused
//!      unless that location is already one of the machine's SAVED registries
//!      or one of this workbook's existing subscriptions (`require_configured_registry`).
//!      Adding a registry, and dev-subscribing to an arbitrary local path, stay
//!      human-only — otherwise this capability is a code-delivery channel.
//!   3. BECOME A PUBLISHER. `calp::publish::publish` CREATES a publisher keypair
//!      on first use. A script must never mint the cryptographic identity other
//!      people will TOFU-pin, so `require_publish_identity` demands the profile
//!      already holds one, and — for a package name that already exists —
//!      demands it is THAT package's key, through the same `require_publisher`
//!      gate the writeback review actions use.
//!
//! WHY ONE COMMAND: the app registers ~660 Tauri commands in `generate_handler!`
//! and the debug dispatch frame nearly exhausts the 32 MB main-thread stack
//! reserve set in build.rs. Eleven distribution verbs would be eleven frames;
//! one `action` discriminator is one.
//!
//! SYNC, like `script_writeback` and every other `calp_*` command: an HTTP
//! registry uses `reqwest::blocking`, which must not run on the async runtime.
//! Tauri runs sync commands on a worker thread. The IPC surface is unchanged
//! from TypeScript (`invoke("script_distribution", { … })`).

use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};
use std::time::Instant;

use serde_json::{json, Value};
use tauri::{State, Window};

use calp::transport::RegistryTransport;

use crate::calp_commands as calp_cmds;
use crate::scripting::CapabilityStore;
use crate::AppState;

/// OUTBOUND: publish this workbook to a registry under the user's publisher
/// identity. Mirrored (frontend-side) in app/src/api/scriptHost/capabilityIds.ts.
pub const PUBLISH_CAPABILITY: &str = "distribution.publish";

/// INBOUND: bring somebody else's published content into this workbook.
pub const SUBSCRIBE_CAPABILITY: &str = "distribution.subscribe";

// ---------------------------------------------------------------------------
// Rate buckets
// ---------------------------------------------------------------------------

/// Purely LOCAL enumerations (listRegistries, listSubscriptions,
/// publishPreview). No registry is contacted; nothing leaves the machine.
const LOCAL_READS_PER_MINUTE: usize = 60;

/// Registry READS (browseRegistry, inspectPackage, nextVersion,
/// refreshPreview). Each one contacts a registry — for an `https://` registry
/// that is real egress — so it is an order of magnitude tighter than a local
/// read, while still leaving room for a package manager UI driven by a script.
const REGISTRY_READS_PER_MINUTE: usize = 20;

/// INBOUND materialization (pull, refreshApply). Each one writes sheets,
/// scripts, models and writeback regions into the workbook and can only be
/// undone by hand, so this is deliberately a "human pace" limit.
const PULLS_PER_MINUTE: usize = 6;

/// OUTBOUND publishes (publish, publishModel). The tightest bucket in the app.
/// A publish is heavy (it writes and signs a whole package tree), it LEAVES THE
/// MACHINE, and — unlike everything else here — other people will pull the
/// result. Three a minute is already far past any legitimate automation.
const PUBLISHES_PER_MINUTE: usize = 3;

/// ...and a hard SESSION ceiling on top of the per-minute bucket. A per-minute
/// limit alone still permits 180 published versions an hour, which is not a
/// rate any human workflow reaches and is exactly the shape of a script stuck
/// in a loop pushing garbage into a registry other people subscribe to. This is
/// per process: closing and reopening Calcula clears it, which keeps the
/// failure mode "ask the human" rather than "wedge the machine".
const PUBLISHES_PER_SESSION: usize = 20;

const RATE_WINDOW_SECS: u64 = 60;

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum Bucket {
    Local,
    RegistryRead,
    Pull,
    Publish,
}

impl Bucket {
    fn limit(self) -> usize {
        match self {
            Bucket::Local => LOCAL_READS_PER_MINUTE,
            Bucket::RegistryRead => REGISTRY_READS_PER_MINUTE,
            Bucket::Pull => PULLS_PER_MINUTE,
            Bucket::Publish => PUBLISHES_PER_MINUTE,
        }
    }

    fn name(self) -> &'static str {
        match self {
            Bucket::Local => "local read",
            Bucket::RegistryRead => "registry read",
            Bucket::Pull => "pull",
            Bucket::Publish => "publish",
        }
    }

    fn capability(self) -> &'static str {
        match self {
            Bucket::Publish => PUBLISH_CAPABILITY,
            _ => SUBSCRIBE_CAPABILITY,
        }
    }
}

/// Per-(script, bucket) rolling one-minute window. Own state — never shared
/// with net.fetch's window, the bi.model gateway's, or the writeback gateway's.
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
            "RateLimited: {} allows {} {} operations per minute",
            bucket.capability(),
            bucket.limit(),
            bucket.name()
        ));
    }
    window.push(now);
    Ok(())
}

/// Process-wide count of publishes performed through this gateway. Deliberately
/// NOT per script: the ceiling protects the registry other people subscribe to,
/// and a script that hits it must not be able to buy another 20 by registering
/// under a second id.
fn check_session_publish_budget() -> Result<(), String> {
    static PUBLISHED: OnceLock<Mutex<usize>> = OnceLock::new();
    let counter = PUBLISHED.get_or_init(|| Mutex::new(0));
    let mut count = counter.lock().unwrap();
    if *count >= PUBLISHES_PER_SESSION {
        return Err(format!(
            "RateLimited: scripts may publish at most {} package versions per Calcula session \
             (this one has published {}). Publish from File > Publish Package… or restart Calcula.",
            PUBLISHES_PER_SESSION, *count
        ));
    }
    *count += 1;
    Ok(())
}

// ---------------------------------------------------------------------------
// Action allowlist
// ---------------------------------------------------------------------------

/// The SERVER-SIDE action allowlist. Anything not in this enum is unreachable
/// from a script whatever the broker sends.
///
/// WHAT IS DELIBERATELY ABSENT, and why each refusal is a decision rather than
/// an omission (the same way earlier waves recorded "no OS clipboard" and "no
/// real printing"):
///
///  * `detach` — severs every subscription and converts distributed sheets into
///    ordinary local ones. It DESTROYS PROVENANCE: after it, the workbook can
///    no longer say where its content came from, which is the transparency
///    property the whole .calp model rests on. Irreversible, and invisible if a
///    script does it.
///  * `resetSubscription` — discards the subscriber's own edits, formatting and
///    overrides on the package's sheets. It is a destructive action against the
///    USER'S work, not the publisher's, and no automation reason justifies
///    handing it out.
///  * override manipulation (`revertOverride`, `acceptUpstream`, `keepOverride`,
///    `exportOverrides`, `importOverrides`) — an override IS the user's
///    deliberate divergence from the publisher. `acceptUpstream` silently
///    erases that decision; `importOverrides` is worse, injecting cell content
///    from a hand-carried patch file that never passed through the signed pull
///    path at all. Both are exactly the "content arrives without verification"
///    shape this gateway exists to prevent.
///  * `devSubscribe` / `devRefresh` — subscribe to an ARBITRARY local .cala
///    path, with NO signature, NO publisher key and NO TOFU pin. This is the
///    single most direct code-delivery channel in the distribution system and
///    it is human-only, permanently.
///  * `addRegistry` / `removeRegistry` — configuring which registries this
///    machine trusts is the decision that makes every other check meaningful.
///    A script that could add a registry could then legitimately pull from it.
///  * `saveDataSourceConfig` / `getDataSources` / `refreshData` — credential
///    bearing. `saveDataSourceConfig` takes a connection string (which carries
///    passwords), and the other two disclose server/database names. BI reach
///    for scripts is the `bi.query` / `bi.sql` / `bi.model` family, which is
///    consent-gated on its own terms.
///  * `exportPackageHtml` — renders a whole package to a self-contained HTML
///    string in the script's hands. Nothing needs it, and it is a tidy
///    exfiltration primitive for anything that also holds `net.fetch`.
///  * the writeback verbs — they already have their own gateway and their own
///    capability (`script_writeback` / `distribution.writeback`).
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum Action {
    // ---- INBOUND (distribution.subscribe) ----
    ListRegistries,
    ListSubscriptions,
    BrowseRegistry,
    InspectPackage,
    Pull,
    RefreshPreview,
    RefreshApply,
    // ---- OUTBOUND (distribution.publish) ----
    PublishPreview,
    NextVersion,
    Publish,
    PublishModel,
}

const ACTION_NAMES: &str = "listRegistries | listSubscriptions | browseRegistry | inspectPackage | \
                            pull | refreshPreview | refreshApply | publishPreview | nextVersion | \
                            publish | publishModel";

impl Action {
    fn parse(raw: &str) -> Result<Action, String> {
        Ok(match raw {
            "listRegistries" => Action::ListRegistries,
            "listSubscriptions" => Action::ListSubscriptions,
            "browseRegistry" => Action::BrowseRegistry,
            "inspectPackage" => Action::InspectPackage,
            "pull" => Action::Pull,
            "refreshPreview" => Action::RefreshPreview,
            "refreshApply" => Action::RefreshApply,
            "publishPreview" => Action::PublishPreview,
            "nextVersion" => Action::NextVersion,
            "publish" => Action::Publish,
            "publishModel" => Action::PublishModel,
            other => {
                return Err(format!(
                    "Unknown action '{}' (expected {})",
                    other, ACTION_NAMES
                ))
            }
        })
    }

    fn as_str(self) -> &'static str {
        match self {
            Action::ListRegistries => "listRegistries",
            Action::ListSubscriptions => "listSubscriptions",
            Action::BrowseRegistry => "browseRegistry",
            Action::InspectPackage => "inspectPackage",
            Action::Pull => "pull",
            Action::RefreshPreview => "refreshPreview",
            Action::RefreshApply => "refreshApply",
            Action::PublishPreview => "publishPreview",
            Action::NextVersion => "nextVersion",
            Action::Publish => "publish",
            Action::PublishModel => "publishModel",
        }
    }

    /// THE CAPABILITY SPLIT. Outbound and inbound are separate grants because
    /// they are separate risks: publishing puts the user's name on content other
    /// people will run; pulling puts other people's content in front of the
    /// user. A script that legitimately needs one almost never needs the other.
    fn capability(self) -> &'static str {
        match self {
            Action::PublishPreview
            | Action::NextVersion
            | Action::Publish
            | Action::PublishModel => PUBLISH_CAPABILITY,
            _ => SUBSCRIBE_CAPABILITY,
        }
    }

    /// Whether this action WRITES to a registry (and therefore needs proof of
    /// publisher-key possession, not merely the capability).
    fn is_publishing_write(self) -> bool {
        matches!(self, Action::Publish | Action::PublishModel)
    }

    fn bucket(self) -> Bucket {
        match self {
            Action::ListRegistries | Action::ListSubscriptions | Action::PublishPreview => {
                Bucket::Local
            }
            Action::BrowseRegistry
            | Action::InspectPackage
            | Action::NextVersion
            | Action::RefreshPreview => Bucket::RegistryRead,
            Action::Pull | Action::RefreshApply => Bucket::Pull,
            Action::Publish | Action::PublishModel => Bucket::Publish,
        }
    }

    /// Actions whose payload names a registry LOCATION. Every one of them is
    /// refused unless the user already configured that location.
    ///
    /// `pull` is the one that matters most: it is the action that brings
    /// somebody else's CODE into the workbook, so an unconfigured location here
    /// would turn this capability into a code-delivery channel.
    ///
    /// `refreshPreview` / `refreshApply` are absent on purpose: they take no
    /// location at all and act only on subscriptions that already exist, so
    /// they are inside the boundary by construction.
    fn names_a_registry(self) -> bool {
        matches!(
            self,
            Action::BrowseRegistry
                | Action::InspectPackage
                | Action::Pull
                | Action::NextVersion
                | Action::Publish
                | Action::PublishModel
        )
    }
}

// ---------------------------------------------------------------------------
// Payload helpers
// ---------------------------------------------------------------------------

/// Pull a typed field out of the gateway payload (absent -> serde default for
/// `Option<T>`, a clear error for required fields). Same helper shape as the
/// writeback gateway's `field`.
fn field<T: serde::de::DeserializeOwned>(
    payload: &serde_json::Map<String, Value>,
    key: &str,
) -> Result<T, String> {
    serde_json::from_value(payload.get(key).cloned().unwrap_or(Value::Null))
        .map_err(|e| format!("payload field '{}': {}", key, e))
}

/// The registry location a payload names.
fn registry_location(payload: &serde_json::Map<String, Value>) -> Result<String, String> {
    let raw: String = field(payload, "registryPath")?;
    if raw.trim().is_empty() {
        return Err("payload field 'registryPath' must be a non-empty registry location".to_string());
    }
    Ok(raw)
}

// ---------------------------------------------------------------------------
// RULE: a script may act only on registries the USER has already configured
// ---------------------------------------------------------------------------

/// Comparison form of a registry location. Locations are written by hand in
/// several equivalent spellings (`file://C:\reg`, `C:/reg`, `C:\reg\`), and a
/// subscription stores `file://` + whatever was passed at pull, so the
/// comparison has to normalize or it would refuse the user's OWN registry.
///
/// Used ONLY for comparison — the caller always passes the ORIGINAL string on
/// to `open_registry`, so normalization can never widen what is opened.
fn normalize_location(raw: &str) -> String {
    let s = raw.trim();
    // The crate's ONE `file://` stripper. A local `strip_prefix` left
    // `file:///C:/reg` as `/C:/reg`, which then failed to match the same
    // registry configured as `C:\reg` — a refusal of the user's own registry,
    // which is the failure this function exists to avoid.
    let s = calp::registry_id::strip_file_scheme(s);
    let s = s.replace('\\', "/");
    let s = s.trim_end_matches('/').to_string();
    // Windows paths are case-insensitive, and so are scheme + host of a URL.
    // Lowercasing the whole string can only make the match MORE permissive
    // against the user's own configured list, never against anything else.
    s.to_lowercase()
}

/// Every registry location this machine/workbook has already committed to:
/// the profile's saved-registry catalogue plus every subscription's registry.
///
/// DEV SUBSCRIPTIONS ARE EXCLUDED. A dev subscription's `registry_url` is
/// `file://<path-to-a-.cala-file>` (calp::dev_mode::make_dev_subscription) — it
/// is not a registry at all, it is one workbook on disk that the author chose to
/// follow with NO signature, NO publisher key and NO TOFU pin. Letting it into
/// this set would launder an arbitrary local path into the script-reachable
/// trust boundary through the one subscription shape that skips every check,
/// which is exactly what the `devSubscribe` refusal above exists to prevent. The
/// refresh path already skips them (`group_subscriptions_by_registry` drops
/// `version_pin == "dev"`), so this keeps the two halves consistent.
fn configured_registries(state: &AppState) -> Result<Vec<String>, String> {
    let mut out: Vec<String> = crate::calp_registry::calp_list_registries()?
        .into_iter()
        .map(|r| r.location)
        .collect();
    let subs = state.subscriptions.lock().map_err(|e| e.to_string())?;
    for sub in &subs.subscriptions {
        if calp::dev_mode::is_dev_subscription(sub) {
            continue;
        }
        out.push(sub.registry_url.clone());
    }
    out.retain(|l| !l.trim().is_empty());
    Ok(out)
}

/// THE INBOUND TRUST BOUNDARY (and the outbound one too). A script may only
/// name a registry the user already added, or one this workbook is already
/// subscribed to.
///
/// Without this, `distribution.subscribe` is a code-delivery channel: a script
/// would name any path or URL it liked, pull attacker-controlled sheets, object
/// scripts, module scripts and model overlays into the workbook, and the only
/// thing between the user and running that code would be a consent prompt they
/// never asked to see. Deciding WHICH registries this machine trusts is the
/// decision that gives the signature and TOFU checks their meaning, so it stays
/// human-only.
///
/// The error names the fix, and lists what IS configured — reaching this error
/// already requires the capability, and `listRegistries` discloses the same
/// list under the same grant, so the message costs nothing and saves a support
/// round trip.
fn require_configured_registry(state: &AppState, requested: &str) -> Result<(), String> {
    let want = normalize_location(requested);
    let configured = configured_registries(state)?;
    if configured
        .iter()
        .any(|c| normalize_location(c) == want && !want.is_empty())
    {
        return Ok(());
    }
    Err(format!(
        "RegistryNotConfigured: '{}' is not one of this machine's saved registries and not one \
         this workbook subscribes to. A script may only use registries you added yourself — add \
         it in the Subscribe dialog (\"Add registry…\") and run this again. Currently configured: {}",
        requested,
        if configured.is_empty() {
            "(none)".to_string()
        } else {
            configured.join(", ")
        }
    ))
}

// ---------------------------------------------------------------------------
// RULE: publishing requires Ed25519 publisher-key POSSESSION
// ---------------------------------------------------------------------------

/// Prove this machine may publish `package_name` into `registry`.
///
/// TWO separate bars, because a new package name and an existing one fail
/// differently:
///
///  1. THE PROFILE MUST ALREADY HOLD A PUBLISHER KEY. `calp::publish::publish`
///     calls `PublisherKeypair::load_or_create`, so an ordinary publish MINTS a
///     keypair on first use. That keypair is the identity every subscriber
///     TOFU-pins under this package name for good — creating it is a decision
///     about who the user IS as a publisher, and a script must not make it on
///     their behalf. `load_existing` never creates, so this is a pure probe.
///  2. IF THE PACKAGE ALREADY EXISTS, THIS PROFILE MUST HOLD *ITS* KEY. Same
///     `require_publisher` gate the writeback review actions use, run against
///     the package's newest published version — so a script cannot push a
///     version of somebody else's package name into a shared registry, where a
///     subscriber's next refresh would report "the publisher changed" and blame
///     the legitimate author.
///
/// Note what this does NOT do: it never creates a key and never pins anything.
fn require_publish_identity(
    registry: &dyn RegistryTransport,
    package_name: &str,
) -> Result<(), String> {
    let profile = calp_cmds::calcula_profile_dir();
    let holds_any = calp::signing::PublisherKeypair::load_existing(&profile)
        .map_err(|e| e.to_string())?
        .is_some();
    if !holds_any {
        return Err(
            "NoPublisherKey: this machine has never published a package, so it has no Ed25519 \
             publisher identity. Publish once yourself (File > Publish Package…) to create it — \
             a script must not create the identity other people will trust as yours."
                .to_string(),
        );
    }

    // An unknown package name (or an unreadable package manifest) means there is
    // no existing key to match; bar (1) is then the whole gate.
    let versions = match registry.list_versions(package_name) {
        Ok(v) => v,
        Err(_) => return Ok(()),
    };
    let Some(latest) = versions.iter().max() else {
        return Ok(());
    };
    calp_cmds::require_publisher(registry, package_name, &latest.to_string()).map_err(|_| {
        format!(
            "NotThePublisher: '{}' already exists in this registry and was signed with a different \
             publisher key. Publishing a new version of it would break every subscriber's trust \
             pin, so it is refused.",
            package_name
        )
    })
}

/// The publisher display name this machine signs as. The script does NOT get to
/// supply `publishedBy`: it is the human-readable byline other people read next
/// to the package, and letting an automation write "Microsoft" there — while
/// the cryptographic `publisherName` said otherwise — would be a spoofing
/// surface for exactly zero benefit.
fn publisher_display_name() -> Result<String, String> {
    let profile = calp_cmds::calcula_profile_dir();
    match calp::signing::PublisherKeypair::load_existing(&profile).map_err(|e| e.to_string())? {
        Some(kp) => Ok(kp.display_name()),
        // Unreachable in practice: require_publish_identity already refused.
        None => Err("NoPublisherKey: no publisher identity on this machine".to_string()),
    }
}

/// Fields a script is NOT allowed to set on a publish, each with the reason.
/// Rejected loudly rather than ignored silently — an author who passes one has
/// a wrong mental model of what a scripted publish is, and a quiet override
/// would leave them believing it worked.
fn reject_forbidden_publish_fields(p: &serde_json::Map<String, Value>) -> Result<(), String> {
    if p.contains_key("publishedBy") {
        return Err(
            "'publishedBy' is not settable from a script: the byline is taken from this machine's \
             publisher identity, so an automation cannot publish under somebody else's name."
                .to_string(),
        );
    }
    if p.contains_key("customObjects") {
        return Err(
            "'customObjects' is not settable from a script: package payloads are collected by \
             Calcula from registered providers, never supplied by the caller. Publish from \
             File > Publish Package… if this package needs extension-contributed objects."
                .to_string(),
        );
    }
    if p.get("includeComments").and_then(|v| v.as_bool()) == Some(true) {
        return Err(
            "'includeComments' cannot be turned on from a script: threaded comments are internal \
             discussion, and shipping them to a registry is a privacy decision only the person \
             publishing can make. Publish from File > Publish Package… to include them."
                .to_string(),
        );
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// The gateway
// ---------------------------------------------------------------------------

/// Multiplexed, consent-gated .calp distribution gateway for sandboxed scripts.
///
/// `action` is one of [`ACTION_NAMES`]; `payload` carries that action's
/// arguments in camelCase, mirroring the interactive commands 1:1.
///
/// Enforcement, in order:
///  1. main-window guard;
///  2. server-side action allowlist (unknown actions never reach a dispatch);
///  3. authoritative re-check of the action's OWN capability grant
///     (`distribution.publish` vs `distribution.subscribe` — never both from
///     one grant), audited on denial;
///  4. registry-configuration gate for every action that names a location;
///  5. Ed25519 publisher-key possession for the two actions that WRITE to a
///     registry, audited on denial;
///  6. per-script rate bucket (+ the session publish ceiling);
///  7. dispatch into the same `calp_*` commands the UI calls — signature, TOFU,
///     artifact integrity and the `min_app_version` gate all come along
///     unchanged, because they are the same code;
///  8. always-on audit of the outcome, naming what moved and to/from where.
#[allow(clippy::too_many_arguments)]
#[tauri::command]
pub fn script_distribution(
    state: State<AppState>,
    bi_state: State<crate::bi::types::BiState>,
    pivot_state: State<crate::pivot::types::PivotState>,
    script_state: State<crate::scripting::types::ScriptState>,
    slicer_state: State<crate::slicer::SlicerState>,
    ribbon_filter_state: State<crate::ribbon_filter::RibbonFilterState>,
    pane_control_state: State<crate::pane_control::PaneControlState>,
    user_files_state: State<crate::persistence::UserFilesState>,
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
    let capability = act.capability();

    // (3) Authoritative capability re-check — the TS broker's gate is advisory.
    //     The two capabilities are checked SEPARATELY: a script granted
    //     `distribution.subscribe` gets no publish action, and vice versa.
    if !cap_store.is_granted(&script_id, capability) {
        crate::log_warn!(
            "SECURITY",
            "script_distribution DENIED ({} not granted): script={} action={}",
            capability,
            script_id,
            act.as_str()
        );
        let err = format!(
            "PermissionDenied: {} not granted for this script",
            capability
        );
        crate::net_commands::record_capability_call(
            &state.audit_log,
            capability,
            &script_id,
            false,
            Some(act.as_str()),
            Some(&err),
        );
        return Err(err);
    }

    // (4) Only registries the user already configured.
    if act.names_a_registry() {
        let location = registry_location(&p)?;
        if let Err(e) = require_configured_registry(&state, &location) {
            crate::log_warn!(
                "SECURITY",
                "script_distribution DENIED (registry not configured): script={} action={}",
                script_id,
                act.as_str()
            );
            crate::net_commands::record_capability_call(
                &state.audit_log,
                capability,
                &script_id,
                false,
                Some(&audit_detail(act, &p, &state)),
                Some(&e),
            );
            return Err(e);
        }
    }

    // (5) Publisher-key possession for the two registry WRITES.
    if act.is_publishing_write() {
        reject_forbidden_publish_fields(&p)?;
        let location = registry_location(&p)?;
        let package_name: String = field(&p, "packageName")?;
        let (registry, _scope) =
            crate::calp_registry::open_registry_scoped(&location).map_err(|e| e.to_string())?;
        if let Err(e) = require_publish_identity(registry.as_ref(), &package_name) {
            crate::log_warn!(
                "SECURITY",
                "script_distribution DENIED (no publisher key): script={} package={}",
                script_id,
                package_name
            );
            crate::net_commands::record_capability_call(
                &state.audit_log,
                capability,
                &script_id,
                false,
                Some(&audit_detail(act, &p, &state)),
                Some(&e),
            );
            return Err(e);
        }
    }

    // (6) Rate limits.
    if let Err(e) = check_rate(&script_id, act.bucket()) {
        crate::net_commands::record_capability_call(
            &state.audit_log,
            capability,
            &script_id,
            false,
            Some(&audit_detail(act, &p, &state)),
            Some(&e),
        );
        return Err(e);
    }
    if act.is_publishing_write() {
        if let Err(e) = check_session_publish_budget() {
            crate::net_commands::record_capability_call(
                &state.audit_log,
                capability,
                &script_id,
                false,
                Some(&audit_detail(act, &p, &state)),
                Some(&e),
            );
            return Err(e);
        }
    }

    // (7) Dispatch. The detail is built BEFORE the call, so a failure is
    //     audited against what was attempted rather than against nothing.
    let detail = audit_detail(act, &p, &state);
    let result = dispatch(
        act,
        &state,
        &bi_state,
        &pivot_state,
        &script_state,
        &slicer_state,
        &ribbon_filter_state,
        &pane_control_state,
        &user_files_state,
        &p,
        &window,
    );

    // (8) Always-on audit (success + failure).
    match &result {
        Ok(_) => crate::net_commands::record_capability_call(
            &state.audit_log,
            capability,
            &script_id,
            true,
            Some(&detail),
            None,
        ),
        Err(e) => crate::net_commands::record_capability_call(
            &state.audit_log,
            capability,
            &script_id,
            false,
            Some(&detail),
            Some(e),
        ),
    }
    result
}

/// The audit `detail` for an action: WHAT moved and TO/FROM WHERE. Ids,
/// versions and registry locations only — never cell values, never submitted
/// answers. This is the line a user reads afterwards to answer "what did that
/// script send, and to whom?", so the registry location is deliberately in it.
fn audit_detail(
    act: Action,
    p: &serde_json::Map<String, Value>,
    state: &AppState,
) -> String {
    let s = |k: &str| p.get(k).and_then(|v| v.as_str()).unwrap_or("");
    let registry = s("registryPath");
    match act {
        Action::Publish | Action::PublishModel => format!(
            "{} — {} v{} -> {}",
            act.as_str(),
            s("packageName"),
            s("version"),
            registry
        ),
        Action::Pull => format!(
            "{} — {} @{} <- {}",
            act.as_str(),
            s("packageName"),
            s("versionPin"),
            registry
        ),
        Action::InspectPackage => format!(
            "{} — {} @{} <- {}",
            act.as_str(),
            s("packageName"),
            s("versionPin"),
            registry
        ),
        Action::NextVersion => {
            format!("{} — {} <- {}", act.as_str(), s("packageName"), registry)
        }
        Action::BrowseRegistry => format!("{} — {}", act.as_str(), registry),
        Action::RefreshPreview | Action::RefreshApply => {
            format!("{} — {}", act.as_str(), subscribed_packages_summary(state))
        }
        _ => act.as_str().to_string(),
    }
}

/// A bounded, human-readable list of the packages a refresh would touch — the
/// "from where" half of the audit line for the two actions whose payload names
/// nothing at all.
fn subscribed_packages_summary(state: &AppState) -> String {
    const MAX_NAMED: usize = 8;
    let Ok(subs) = state.subscriptions.lock() else {
        return "(subscriptions unavailable)".to_string();
    };
    let names: Vec<String> = subs
        .subscriptions
        .iter()
        .map(|s| format!("{}@{}", s.package_name, s.registry_url))
        .collect();
    if names.is_empty() {
        return "(no subscriptions)".to_string();
    }
    if names.len() <= MAX_NAMED {
        return names.join(", ");
    }
    format!(
        "{}, +{} more",
        names[..MAX_NAMED].join(", "),
        names.len() - MAX_NAMED
    )
}

/// The `PullParams` a SCRIPTED pull runs with.
///
/// The one field the interactive Subscribe dialog does not set is
/// `requirePinned`. TOFU pinning is a trust COMMIT — it decides which Ed25519
/// key this machine will accept for this package name from then on — and
/// `calp_pull` may mint one because a human was shown the publisher in the
/// Subscribe review and said yes. A script is not that human: left unset,
/// `cap.pkgPull` would pin whatever key the registry served at that instant,
/// silently, and the genuine publisher's next release would read as
/// `publisherChanged`. `Action::RefreshApply` already reasoned its way to
/// `RequirePinned`; Pull gets the same answer.
///
/// A function rather than an inline literal so the guarantee is unit-testable
/// without a running Tauri app.
fn scripted_pull_params(
    registry_path: &str,
    package_name: &str,
    version_pin: &str,
) -> Result<calp_cmds::PullParams, String> {
    serde_json::from_value(json!({
        "registryPath": registry_path,
        "packageName": package_name,
        "versionPin": version_pin,
        "requirePinned": true,
    }))
    .map_err(|e| e.to_string())
}

/// Dispatch into the EXISTING commands. Every one of them re-runs its own
/// window guard and its own verification — this gateway adds constraints, it
/// never replaces them, and it holds NO copy of the pull/publish logic.
#[allow(clippy::too_many_arguments)]
fn dispatch(
    act: Action,
    state: &State<AppState>,
    bi_state: &State<crate::bi::types::BiState>,
    pivot_state: &State<crate::pivot::types::PivotState>,
    script_state: &State<crate::scripting::types::ScriptState>,
    slicer_state: &State<crate::slicer::SlicerState>,
    ribbon_filter_state: &State<crate::ribbon_filter::RibbonFilterState>,
    pane_control_state: &State<crate::pane_control::PaneControlState>,
    user_files_state: &State<crate::persistence::UserFilesState>,
    p: &serde_json::Map<String, Value>,
    window: &Window,
) -> Result<Value, String> {
    match act {
        Action::ListRegistries => {
            let list = crate::calp_registry::calp_list_registries()?;
            serde_json::to_value(list).map_err(|e| e.to_string())
        }
        Action::ListSubscriptions => {
            let subs = calp_cmds::calp_get_subscriptions(state.clone(), window.clone())?;
            serde_json::to_value(subs).map_err(|e| e.to_string())
        }
        Action::BrowseRegistry => {
            let registry_path = registry_location(p)?;
            let packages = calp_cmds::calp_browse_registry(registry_path, window.clone())?;
            serde_json::to_value(packages).map_err(|e| e.to_string())
        }
        Action::InspectPackage => {
            // The SAME pre-pull review the Subscribe dialog shows: it verifies
            // the Ed25519 signature and resolves TOFU before returning a word.
            let registry_path = registry_location(p)?;
            let package_name: String = field(p, "packageName")?;
            let version_pin: String = field(p, "versionPin")?;
            let inspection = calp_cmds::calp_inspect_package(
                registry_path,
                package_name,
                version_pin,
                window.clone(),
            )?;
            serde_json::to_value(inspection).map_err(|e| e.to_string())
        }
        Action::Pull => {
            // THE inbound path. `calp_pull` -> `calp::pull::pull` runs the
            // signature check, the TOFU pin, the per-artifact SHA-256 walk and
            // the min_app_version gate, then materializes object scripts as
            // Restricted + Distributed (unmounted, consent-gated) and module
            // scripts / notebooks as inert data. Nothing here mounts anything.
            let registry_path = registry_location(p)?;
            let package_name: String = field(p, "packageName")?;
            let version_pin: String = field(p, "versionPin")?;
            //
            // ONE gate the interactive Subscribe dialog does not have:
            // `requirePinned`. TOFU pinning is a trust COMMIT — it decides which
            // Ed25519 key this machine will accept for this package name from
            // now on — and `calp_pull` is allowed to mint one because a human
            // was shown the publisher in the Subscribe review and said yes. A
            // script is not that human. Left unset, `cap.pkgPull` would pin
            // whatever key the registry served at that instant, silently, and
            // the genuine publisher's next release would then read as
            // `publisherChanged`. `Action::RefreshApply` below already reasoned
            // its way here; Pull gets the same answer.
            let params = scripted_pull_params(&registry_path, &package_name, &version_pin)?;
            let response = calp_cmds::calp_pull(
                state.clone(),
                pivot_state.clone(),
                bi_state.clone(),
                script_state.clone(),
                ribbon_filter_state.clone(),
                pane_control_state.clone(),
                slicer_state.clone(),
                params,
                window.clone(),
            )
            .map_err(|e| {
                // Only the PIN refusal gets the extra sentence. Appending it to
                // "version not found" or "app too old" would send the author
                // chasing a trust problem they do not have.
                if e.contains("has ever agreed to trust") {
                    format!(
                        "{} This call came from a script, which is never allowed to establish \
                         that trust on your behalf — subscribe to '{}' once from \
                         Data > Subscribe to Package and the script will work from then on.",
                        e, package_name
                    )
                } else {
                    e
                }
            })?;
            serde_json::to_value(response).map_err(|e| e.to_string())
        }
        Action::RefreshPreview => {
            let preview = calp_cmds::calp_refresh_preview(state.clone(), window.clone())?;
            serde_json::to_value(preview).map_err(|e| e.to_string())
        }
        Action::RefreshApply => {
            // Same gates as a first pull EXCEPT the pin policy, which is the
            // difference that matters: `calp_refresh_apply` passes
            // `PinPolicy::RequirePinned` to `calp::refresh::pull_all_updates`,
            // so a version signed by a changed publisher key fails here as it
            // would in the Refresh dialog — AND a subscription whose publisher
            // this machine never pinned fails too, rather than acquiring the pin
            // from an action a script labelled "refresh".
            let result = calp_cmds::calp_refresh_apply(
                state.clone(),
                user_files_state.clone(),
                pivot_state.clone(),
                script_state.clone(),
                bi_state.clone(),
                ribbon_filter_state.clone(),
                pane_control_state.clone(),
                slicer_state.clone(),
                window.clone(),
            )?;
            serde_json::to_value(result).map_err(|e| e.to_string())
        }
        Action::PublishPreview => {
            let sheet_indices: Option<Vec<usize>> = field(p, "sheetIndices")?;
            let params = serde_json::from_value(json!({
                "sheetIndices": sheet_indices,
                "includeComments": false,
            }))
            .map_err(|e| e.to_string())?;
            let preview = calp_cmds::calp_publish_preview(
                state.clone(),
                bi_state.clone(),
                pivot_state.clone(),
                script_state.clone(),
                slicer_state.clone(),
                ribbon_filter_state.clone(),
                pane_control_state.clone(),
                user_files_state.clone(),
                params,
                window.clone(),
            )?;
            serde_json::to_value(preview).map_err(|e| e.to_string())
        }
        Action::NextVersion => {
            let registry_path = registry_location(p)?;
            let package_name: String = field(p, "packageName")?;
            let bump: String = field(p, "bump")?;
            let next =
                calp_cmds::calp_next_version(registry_path, package_name, bump, window.clone())?;
            Ok(json!({ "version": next }))
        }
        Action::Publish => {
            let registry_path = registry_location(p)?;
            let package_name: String = field(p, "packageName")?;
            let version: String = field(p, "version")?;
            let kind: Option<String> = field(p, "kind")?;
            let sheet_indices: Option<Vec<usize>> = field(p, "sheetIndices")?;
            let params = serde_json::from_value(json!({
                "registryPath": registry_path,
                "packageName": package_name,
                "version": version,
                "kind": kind.unwrap_or_else(|| "report".to_string()),
                "sheetIndices": sheet_indices.unwrap_or_default(),
                // Server-supplied, never caller-supplied (see the three
                // rejections in reject_forbidden_publish_fields).
                "publishedBy": publisher_display_name()?,
                "includeComments": false,
            }))
            .map_err(|e| e.to_string())?;
            let mut response = calp_cmds::calp_publish(
                state.clone(),
                bi_state.clone(),
                pivot_state.clone(),
                script_state.clone(),
                slicer_state.clone(),
                ribbon_filter_state.clone(),
                pane_control_state.clone(),
                user_files_state.clone(),
                params,
                window.clone(),
            )?;
            response.warnings.push(SCRIPT_PUBLISH_PAYLOAD_NOTE.to_string());
            serde_json::to_value(response).map_err(|e| e.to_string())
        }
        Action::PublishModel => {
            let registry_path = registry_location(p)?;
            let package_name: String = field(p, "packageName")?;
            let version: String = field(p, "version")?;
            let connection_id: String = field(p, "connectionId")?;
            let params = serde_json::from_value(json!({
                "registryPath": registry_path,
                "packageName": package_name,
                "version": version,
                "publishedBy": publisher_display_name()?,
                "connectionId": connection_id,
            }))
            .map_err(|e| e.to_string())?;
            let response = calp_cmds::calp_publish_model(
                state.clone(),
                bi_state.clone(),
                params,
                window.clone(),
            )?;
            serde_json::to_value(response).map_err(|e| e.to_string())
        }
    }
}

/// Appended to every scripted `publish` response. A scripted publish carries
/// Calcula's own built-in custom objects but NOT the ones registered by
/// frontend distributable-object providers, because the caller is not allowed
/// to supply them and the providers live in the renderer. Saying so in the
/// response is the difference between a documented limit and a silent drop.
pub const SCRIPT_PUBLISH_PAYLOAD_NOTE: &str =
    "Published from a script: extension-contributed custom objects were not collected. \
     Publish from File > Publish Package… if this package needs them.";

#[cfg(test)]
mod tests {
    use super::*;

    // -----------------------------------------------------------------------
    // A SCRIPTED pull may never create a TOFU pin
    // -----------------------------------------------------------------------

    /// The security property: `cap.pkgPull` runs under `RequirePinned`, so a
    /// package this machine has never trusted fails instead of being pinned.
    ///
    /// Before this, `Action::Pull` forwarded only registryPath/packageName/
    /// versionPin, so `calp_pull` selected `PinOnFirstUse` — the policy whose
    /// whole justification is "a human was shown the publisher and said yes".
    /// The human in a scripted pull is the SCRIPT AUTHOR, who may not even be
    /// the person whose machine is deciding whom to trust.
    #[test]
    fn a_scripted_pull_runs_under_require_pinned() {
        let params = scripted_pull_params("file:///regs/main", "acme.finance", "^1.0.0")
            .expect("params build");
        assert!(
            params.require_pinned,
            "the scripted gateway must not be able to mint a TOFU pin"
        );
        assert_eq!(
            crate::calp_commands::pull_pin_policy(&params),
            calp::integrity::PinPolicy::RequirePinned,
            "requirePinned must map to the policy that writes nothing to the pin store"
        );
    }

    /// The interactive Subscribe dialog is unchanged: it still pins, because it
    /// is the one flow with a human reviewing the publisher.
    #[test]
    fn the_interactive_pull_still_pins_on_first_use() {
        let interactive: crate::calp_commands::PullParams = serde_json::from_value(json!({
            "registryPath": "file:///regs/main",
            "packageName": "acme.finance",
            "versionPin": "^1.0.0",
        }))
        .expect("params build");
        assert!(
            !interactive.require_pinned,
            "requirePinned must DEFAULT to false so the Subscribe dialog is unaffected"
        );
        assert_eq!(
            crate::calp_commands::pull_pin_policy(&interactive),
            calp::integrity::PinPolicy::PinOnFirstUse
        );
    }

    /// `requirePinned` OUTRANKS `acceptNameConflict`: a script that sets both
    /// must not get the conflict-accepting pinning policy.
    #[test]
    fn require_pinned_outranks_accept_name_conflict() {
        let both: crate::calp_commands::PullParams = serde_json::from_value(json!({
            "registryPath": "file:///regs/main",
            "packageName": "acme.finance",
            "versionPin": "^1.0.0",
            "requirePinned": true,
            "acceptNameConflict": true,
        }))
        .expect("params build");
        assert_eq!(
            crate::calp_commands::pull_pin_policy(&both),
            calp::integrity::PinPolicy::RequirePinned
        );
    }

    /// And the conflict-accepting policy is still reachable from the UI path,
    /// which is the only caller that can have shown the conflict.
    #[test]
    fn accept_name_conflict_alone_still_reaches_the_accepting_policy() {
        let ui: crate::calp_commands::PullParams = serde_json::from_value(json!({
            "registryPath": "file:///regs/main",
            "packageName": "acme.finance",
            "versionPin": "^1.0.0",
            "acceptNameConflict": true,
        }))
        .expect("params build");
        assert_eq!(
            crate::calp_commands::pull_pin_policy(&ui),
            calp::integrity::PinPolicy::PinAcceptingNameConflict
        );
    }

    // -----------------------------------------------------------------------
    // Action allowlist + the capability split
    // -----------------------------------------------------------------------

    #[test]
    fn unknown_actions_are_rejected() {
        assert!(Action::parse("pull").is_ok());
        for bad in ["", "Pull", "pull_package", "publish_package", "listregistries"] {
            assert!(
                Action::parse(bad).is_err(),
                "action '{}' must not be dispatchable",
                bad
            );
        }
    }

    #[test]
    fn the_deliberately_absent_actions_stay_absent() {
        // Each of these is a recorded refusal in the Action doc comment, not an
        // oversight. If a future wave wants one, it has to delete a paragraph
        // that says why — which is the point.
        for refused in [
            "detach",
            "resetSubscription",
            "revertOverride",
            "acceptUpstream",
            "keepOverride",
            "exportOverrides",
            "importOverrides",
            "devSubscribe",
            "devRefresh",
            "addRegistry",
            "removeRegistry",
            "saveDataSourceConfig",
            "getDataSources",
            "refreshData",
            "exportPackageHtml",
            "submitRegion",
        ] {
            assert!(
                Action::parse(refused).is_err(),
                "'{}' must not be dispatchable from a script",
                refused
            );
        }
    }

    #[test]
    fn outbound_and_inbound_are_separate_capabilities() {
        for inbound in [
            Action::ListRegistries,
            Action::ListSubscriptions,
            Action::BrowseRegistry,
            Action::InspectPackage,
            Action::Pull,
            Action::RefreshPreview,
            Action::RefreshApply,
        ] {
            assert_eq!(
                inbound.capability(),
                SUBSCRIBE_CAPABILITY,
                "{:?} must need the inbound capability",
                inbound
            );
        }
        for outbound in [
            Action::PublishPreview,
            Action::NextVersion,
            Action::Publish,
            Action::PublishModel,
        ] {
            assert_eq!(
                outbound.capability(),
                PUBLISH_CAPABILITY,
                "{:?} must need the outbound capability",
                outbound
            );
        }
        assert_ne!(PUBLISH_CAPABILITY, SUBSCRIBE_CAPABILITY);
    }

    #[test]
    fn a_subscribe_grant_never_buys_a_publish_action() {
        // The store half of gateway step (3): the command asks for exactly
        // act.capability(), so holding the other one denies.
        let store = CapabilityStore::new();
        store.grant("s1", SUBSCRIBE_CAPABILITY);
        assert!(store.is_granted("s1", SUBSCRIBE_CAPABILITY));
        assert!(!store.is_granted("s1", PUBLISH_CAPABILITY));
        for a in [Action::Publish, Action::PublishModel, Action::PublishPreview] {
            assert!(
                !store.is_granted("s1", a.capability()),
                "{:?} must be denied to a subscribe-only script",
                a
            );
        }
        // ...and the reverse.
        let store2 = CapabilityStore::new();
        store2.grant("s2", PUBLISH_CAPABILITY);
        for a in [Action::Pull, Action::RefreshApply, Action::InspectPackage] {
            assert!(
                !store2.is_granted("s2", a.capability()),
                "{:?} must be denied to a publish-only script",
                a
            );
        }
    }

    #[test]
    fn both_capabilities_are_grantable_in_the_backend_store() {
        use crate::scripting::capability_store::is_grantable;
        assert!(is_grantable(PUBLISH_CAPABILITY));
        assert!(is_grantable(SUBSCRIBE_CAPABILITY));
        // Exact match only — no namespace widening.
        for invented in ["distribution", "distribution.pull", "distribution.*", ""] {
            assert!(!is_grantable(invented), "'{}' must not be grantable", invented);
        }
    }

    #[test]
    fn only_registry_writes_need_the_publisher_key() {
        assert!(Action::Publish.is_publishing_write());
        assert!(Action::PublishModel.is_publishing_write());
        for a in [
            Action::PublishPreview,
            Action::NextVersion,
            Action::Pull,
            Action::RefreshApply,
            Action::ListRegistries,
        ] {
            assert!(!a.is_publishing_write(), "{:?}", a);
        }
    }

    #[test]
    fn every_action_that_names_a_registry_is_gated_on_the_configured_set() {
        // The pairing that matters: an action whose payload carries
        // `registryPath` MUST answer true here, or it would reach
        // `open_registry` with an arbitrary caller-supplied location.
        for a in [
            Action::BrowseRegistry,
            Action::InspectPackage,
            Action::NextVersion,
            Action::Publish,
            Action::PublishModel,
        ] {
            assert!(a.names_a_registry(), "{:?} takes a registryPath", a);
        }
        // Pull is asserted separately, loudly, because it is THE action a
        // missing gate would turn into a code-delivery channel.
        assert!(
            Action::Pull.names_a_registry(),
            "pull names a registry and MUST be gated on the configured set — \
             without this, a script pulls attacker-controlled content"
        );
        // These name nothing: they act on subscriptions that already exist.
        for a in [
            Action::RefreshPreview,
            Action::RefreshApply,
            Action::ListRegistries,
            Action::ListSubscriptions,
            Action::PublishPreview,
        ] {
            assert!(!a.names_a_registry(), "{:?}", a);
        }
    }

    // -----------------------------------------------------------------------
    // Registry normalization + the configured-set boundary
    // -----------------------------------------------------------------------

    #[test]
    fn location_normalization_matches_the_spellings_users_actually_write() {
        let canonical = normalize_location(r"C:\registries\team");
        assert_eq!(normalize_location("C:/registries/team"), canonical);
        assert_eq!(normalize_location(r"file://C:\registries\team"), canonical);
        assert_eq!(normalize_location("C:/Registries/Team/"), canonical);
        assert_eq!(normalize_location("  C:/registries/team  "), canonical);

        let url = normalize_location("https://packages.example.com/reg");
        assert_eq!(normalize_location("https://packages.example.com/reg/"), url);
        assert_eq!(normalize_location("HTTPS://Packages.Example.com/reg"), url);
    }

    #[test]
    fn normalization_does_not_collapse_different_registries() {
        // The whole point of the gate is that it refuses; a normalizer that
        // over-matches would silently admit a neighbouring path.
        assert_ne!(
            normalize_location("C:/registries/team"),
            normalize_location("C:/registries/team-evil")
        );
        assert_ne!(
            normalize_location("https://packages.example.com/reg"),
            normalize_location("https://packages.example.com.evil.test/reg")
        );
        assert_ne!(
            normalize_location("C:/registries/team"),
            normalize_location("C:/registries")
        );
        // An empty request must never match an empty configured entry (the
        // configured list drops blanks, and the matcher rejects empties too).
        assert_eq!(normalize_location(""), "");
        assert_eq!(normalize_location("file://"), "");
    }

    #[test]
    fn a_dev_subscription_never_becomes_a_configured_registry() {
        // A dev subscription follows one .cala file with NO signature, NO
        // publisher key and NO TOFU pin. `configured_registries` skips them, so
        // an author's local iteration loop can never launder an arbitrary path
        // into the set a script may name. Asserted against the SAME predicate
        // the production code uses, so the two cannot drift.
        let dev = calp::manifest::Subscription {
            package_name: "dev:draft".to_string(),
            registry_url: "file://C:/work/draft.cala".to_string(),
            version_pin: "dev".to_string(),
            resolved_version: "0.0.0".to_string(),
            resolved_at: String::new(),
            sheets: Vec::new(),
            channel: "dev".to_string(),
            data_source_configs: Vec::new(),
            objects: Vec::new(),
            extra: Default::default(),
        };
        assert!(calp::dev_mode::is_dev_subscription(&dev));

        let real = calp::manifest::Subscription {
            package_name: "sales-report".to_string(),
            registry_url: "file://C:/registries/team".to_string(),
            version_pin: "^1.0.0".to_string(),
            resolved_version: "1.2.0".to_string(),
            resolved_at: String::new(),
            sheets: Vec::new(),
            channel: String::new(),
            data_source_configs: Vec::new(),
            objects: Vec::new(),
            extra: Default::default(),
        };
        assert!(!calp::dev_mode::is_dev_subscription(&real));

        // And the production source really applies it (the state-bearing half
        // of configured_registries needs an AppState, which a unit test has no
        // business building — this pins the call instead).
        assert!(
            production_source().contains("calp::dev_mode::is_dev_subscription(sub)"),
            "configured_registries must skip dev subscriptions"
        );
    }

    #[test]
    fn the_refusal_names_the_fix() {
        // Failure text is a security surface: a user who cannot tell WHY a
        // script was refused will look for a way to turn the check off.
        let msg = format!(
            "RegistryNotConfigured: '{}' is not one of this machine's saved registries and not one \
             this workbook subscribes to. A script may only use registries you added yourself — add \
             it in the Subscribe dialog (\"Add registry…\") and run this again. Currently configured: {}",
            "C:/evil", "(none)"
        );
        assert!(msg.starts_with("RegistryNotConfigured:"));
        assert!(msg.contains("Add registry"));
    }

    // -----------------------------------------------------------------------
    // Rate limiting
    // -----------------------------------------------------------------------

    #[test]
    fn publish_is_the_tightest_bucket_by_a_wide_margin() {
        assert!(PUBLISHES_PER_MINUTE < PULLS_PER_MINUTE);
        assert!(PULLS_PER_MINUTE < REGISTRY_READS_PER_MINUTE);
        assert!(REGISTRY_READS_PER_MINUTE < LOCAL_READS_PER_MINUTE);
        assert_eq!(Action::Publish.bucket(), Bucket::Publish);
        assert_eq!(Action::PublishModel.bucket(), Bucket::Publish);
        assert_eq!(Action::Pull.bucket(), Bucket::Pull);
        assert_eq!(Action::RefreshApply.bucket(), Bucket::Pull);
        assert_eq!(Action::BrowseRegistry.bucket(), Bucket::RegistryRead);
        assert_eq!(Action::InspectPackage.bucket(), Bucket::RegistryRead);
        assert_eq!(Action::NextVersion.bucket(), Bucket::RegistryRead);
        assert_eq!(Action::RefreshPreview.bucket(), Bucket::RegistryRead);
        assert_eq!(Action::ListRegistries.bucket(), Bucket::Local);
        assert_eq!(Action::ListSubscriptions.bucket(), Bucket::Local);
        assert_eq!(Action::PublishPreview.bucket(), Bucket::Local);
    }

    #[test]
    fn the_publish_bucket_trips_at_its_limit_and_names_its_capability() {
        let script = "dist-rate-publish";
        for i in 0..PUBLISHES_PER_MINUTE {
            assert!(
                check_rate(script, Bucket::Publish).is_ok(),
                "publish {} of {} must be allowed",
                i + 1,
                PUBLISHES_PER_MINUTE
            );
        }
        let err = check_rate(script, Bucket::Publish).unwrap_err();
        assert!(err.starts_with("RateLimited:"), "got: {}", err);
        assert!(err.contains(PUBLISH_CAPABILITY), "got: {}", err);
        // Buckets are independent: a spent publish budget must not block the
        // read that would explain why (or an unrelated pull).
        assert!(check_rate(script, Bucket::Local).is_ok());
        assert!(check_rate(script, Bucket::RegistryRead).is_ok());
        assert!(check_rate(script, Bucket::Pull).is_ok());
    }

    #[test]
    fn rate_windows_are_per_script() {
        for _ in 0..PULLS_PER_MINUTE {
            check_rate("dist-rate-a", Bucket::Pull).unwrap();
        }
        assert!(check_rate("dist-rate-a", Bucket::Pull).is_err());
        assert!(check_rate("dist-rate-b", Bucket::Pull).is_ok());
    }

    #[test]
    fn the_inbound_bucket_names_the_inbound_capability() {
        let script = "dist-rate-pull-name";
        for _ in 0..PULLS_PER_MINUTE {
            check_rate(script, Bucket::Pull).unwrap();
        }
        let err = check_rate(script, Bucket::Pull).unwrap_err();
        assert!(err.contains(SUBSCRIBE_CAPABILITY), "got: {}", err);
    }

    // -----------------------------------------------------------------------
    // Publish payload rejections
    // -----------------------------------------------------------------------

    #[test]
    fn a_script_cannot_publish_under_somebody_elses_byline() {
        let p: serde_json::Map<String, Value> =
            serde_json::from_value(json!({ "publishedBy": "Microsoft" })).unwrap();
        let err = reject_forbidden_publish_fields(&p).unwrap_err();
        assert!(err.contains("publishedBy"), "got: {}", err);
        assert!(err.contains("somebody else's name"), "got: {}", err);
    }

    #[test]
    fn a_script_cannot_inject_package_payloads_or_leak_comments() {
        let objects: serde_json::Map<String, Value> =
            serde_json::from_value(json!({ "customObjects": [] })).unwrap();
        assert!(reject_forbidden_publish_fields(&objects).is_err());

        let comments: serde_json::Map<String, Value> =
            serde_json::from_value(json!({ "includeComments": true })).unwrap();
        let err = reject_forbidden_publish_fields(&comments).unwrap_err();
        assert!(err.contains("privacy"), "got: {}", err);

        // Explicit false is fine — it matches what the gateway forces anyway.
        let off: serde_json::Map<String, Value> =
            serde_json::from_value(json!({ "includeComments": false })).unwrap();
        assert!(reject_forbidden_publish_fields(&off).is_ok());

        let clean: serde_json::Map<String, Value> =
            serde_json::from_value(json!({ "packageName": "p", "version": "1.0.0" })).unwrap();
        assert!(reject_forbidden_publish_fields(&clean).is_ok());
    }

    #[test]
    fn a_scripted_publish_discloses_what_it_could_not_carry() {
        assert!(SCRIPT_PUBLISH_PAYLOAD_NOTE.contains("not collected"));
        assert!(SCRIPT_PUBLISH_PAYLOAD_NOTE.contains("Publish Package"));
    }

    // -----------------------------------------------------------------------
    // Audit
    // -----------------------------------------------------------------------

    #[test]
    fn the_audit_detail_names_what_moved_and_where_it_went() {
        let publish: serde_json::Map<String, Value> = serde_json::from_value(json!({
            "packageName": "sales-report",
            "version": "2.1.0",
            "registryPath": "C:/registries/team",
        }))
        .unwrap();
        // A publish leaves the machine — the audit line must say where to.
        let detail = audit_detail_for_test(Action::Publish, &publish);
        assert_eq!(detail, "publish — sales-report v2.1.0 -> C:/registries/team");

        let pull: serde_json::Map<String, Value> = serde_json::from_value(json!({
            "packageName": "vendor-kpis",
            "versionPin": "^1.0.0",
            "registryPath": "https://packages.example.com/reg",
        }))
        .unwrap();
        assert_eq!(
            audit_detail_for_test(Action::Pull, &pull),
            "pull — vendor-kpis @^1.0.0 <- https://packages.example.com/reg"
        );

        assert_eq!(
            audit_detail_for_test(Action::BrowseRegistry, &pull),
            "browseRegistry — https://packages.example.com/reg"
        );
        assert_eq!(
            audit_detail_for_test(Action::ListRegistries, &pull),
            "listRegistries"
        );
    }

    /// `audit_detail` needs an AppState only for the two refresh actions; this
    /// exercises the payload-derived branches, which are the ones carrying the
    /// "what and where" the audit requirement is about.
    fn audit_detail_for_test(act: Action, p: &serde_json::Map<String, Value>) -> String {
        let s = |k: &str| p.get(k).and_then(|v| v.as_str()).unwrap_or("");
        let registry = s("registryPath");
        match act {
            Action::Publish | Action::PublishModel => format!(
                "{} — {} v{} -> {}",
                act.as_str(),
                s("packageName"),
                s("version"),
                registry
            ),
            Action::Pull | Action::InspectPackage => format!(
                "{} — {} @{} <- {}",
                act.as_str(),
                s("packageName"),
                s("versionPin"),
                registry
            ),
            Action::NextVersion => {
                format!("{} — {} <- {}", act.as_str(), s("packageName"), registry)
            }
            Action::BrowseRegistry => format!("{} — {}", act.as_str(), registry),
            _ => act.as_str().to_string(),
        }
    }

    #[test]
    fn both_outcomes_write_an_audit_row_naming_the_capability() {
        let log = std::sync::Mutex::new(calp::audit::AuditLog::default());
        crate::net_commands::record_capability_call(
            &log,
            SUBSCRIBE_CAPABILITY,
            "script-1",
            false,
            Some("pull — vendor-kpis @^1.0.0 <- C:/reg"),
            Some("RegistryNotConfigured: 'C:/evil' is not one of this machine's saved registries"),
        );
        crate::net_commands::record_capability_call(
            &log,
            PUBLISH_CAPABILITY,
            "script-1",
            true,
            Some("publish — sales-report v2.1.0 -> C:/reg"),
            None,
        );
        let entries = log.lock().unwrap().entries.clone();
        assert_eq!(entries.len(), 2);
        assert_eq!(
            entries[0].extra.get("capability").and_then(|v| v.as_str()),
            Some(SUBSCRIBE_CAPABILITY)
        );
        assert_eq!(
            entries[1].extra.get("capability").and_then(|v| v.as_str()),
            Some(PUBLISH_CAPABILITY)
        );
        assert!(entries[0].description.contains("DENIED"));
        assert!(entries[1]
            .extra
            .get("detail")
            .and_then(|v| v.as_str())
            .unwrap()
            .contains("C:/reg"));
    }

    // -----------------------------------------------------------------------
    // The properties that must hold on the SCRIPT path specifically
    // -----------------------------------------------------------------------

    #[test]
    fn a_pulled_object_script_is_forced_restricted_and_distributed() {
        // RULE 1, at its source. `calp::pull` stamps every object script it
        // materializes Restricted + Distributed regardless of what the package
        // said, which is what makes the frontend consent gate fire and what
        // keeps the script off the unlocked-tier distribution rows. The gateway
        // adds nothing to this and — crucially — removes nothing: it dispatches
        // into calp_pull, so the same stamping runs.
        let source = std::fs::read_to_string(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../../core/calp/src/pull.rs"
        ))
        .expect("core/calp/src/pull.rs must be readable from the app crate");
        assert!(
            source.contains("script.access_level = persistence::ScriptAccessLevel::Restricted"),
            "pulled object scripts must be forced to the restricted tier"
        );
        assert!(
            source.contains("script.provenance = persistence::ScriptProvenance::Distributed"),
            "pulled object scripts must be stamped distributed so consent is required"
        );
    }

    /// This module's PRODUCTION source — everything above the test module.
    /// Splitting it out matters: the drift guards below name the forbidden
    /// strings as literals, so scanning the whole file would always match
    /// itself and the guards would be vacuously green.
    fn production_source() -> &'static str {
        include_str!("distribution_gateway.rs")
            .split("#[cfg(test)]")
            .next()
            .expect("split always yields at least one part")
    }

    #[test]
    fn the_gateway_holds_no_copy_of_the_verification_logic() {
        // RULE 2, as a source-level drift guard. If a future change starts
        // calling calp::pull / calp::publish / the signing primitives DIRECTLY
        // from this gateway instead of through the calp_* commands, the "same
        // functions, same checks" argument stops being true and this fails.
        let me = production_source();
        for forbidden in [
            "calp::pull::pull(",
            "calp::publish::publish(",
            "calp::refresh::pull_all_updates(",
            "verify_signature(",
            "pin_publisher(",
            "check_min_app_version(",
            // A cross-registry NAME CONFLICT is accepted by a human answering a
            // second, differently-worded question in the Subscribe dialog. A
            // SCRIPT has no way to ask that question, so it must never be able
            // to answer it: the params literal above names exactly three fields
            // and `acceptNameConflict` defaults to false, which makes a
            // conflicting scripted pull fail with PublisherNameConflict rather
            // than pin a second claimant to a familiar package name.
            "acceptNameConflict",
        ] {
            assert!(
                !me.contains(forbidden),
                "this gateway must not reimplement verification — found `{}`. Dispatch into the \
                 calp_* command instead, so the script path and the UI path are the same code.",
                forbidden
            );
        }
        // ...and it really does dispatch into them.
        for expected in [
            "calp_cmds::calp_pull(",
            "calp_cmds::calp_refresh_apply(",
            "calp_cmds::calp_publish(",
            "calp_cmds::calp_inspect_package(",
        ] {
            assert!(me.contains(expected), "missing dispatch into {}", expected);
        }
    }

    #[test]
    fn the_gateway_never_mounts_grants_or_consents() {
        // RULE 1, as a source-level drift guard: no path in this file may grant
        // a capability, record consent, or start executing anything.
        let me = production_source();
        for forbidden in [
            ".grant(",
            "grant_script_capability",
            "grant_script_net_origin",
            "ScriptEngine",
            "mountScript",
            "applyConsentedCapabilities",
        ] {
            assert!(
                !me.contains(forbidden),
                "the distribution gateway must never {} — consent is the user's, always",
                forbidden
            );
        }
    }
}
