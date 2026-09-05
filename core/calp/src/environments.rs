//! FILENAME: core/calp/src/environments.rs
//! PURPOSE: Environments — Dev → Test → Prod for one application, as named
//! pointers to versions on ONE development line.
//!
//! CONTEXT: An application had exactly one head (the highest semver), so the
//! moment a developer pushed, every end user's next refresh offered them the
//! unreleased work. There was no way to test a version before consumers saw it,
//! no way to hold consumers on a known-good version while development
//! continued, and no way to roll them back without republishing.
//!
//! # The shape, and why it is this shape
//!
//! An **environment** is a name → version pointer. The versions themselves are
//! the ordinary development line: immutable, strictly increasing, published
//! through the ordinary push gates. Promotion moves a pointer and **copies
//! nothing** — artifacts are content-addressed blobs shared at the workspace
//! root, so what was tested is bit-for-bit what ships.
//!
//! Not branches. A branch per developer would make promotion a MERGE between
//! lines, and the merge machinery only works inside a live workbook: it applies
//! the intervening cells through the ordinary edit pipeline so the result is
//! recalculated (`calp_merge.rs`). A headless version-to-version merge needs an
//! evaluator that can run against caller-supplied grids, which `open-items.md`
//! §2.aa costed and declined. A pointer move needs none of that, and it is the
//! reason this feature is small.
//!
//! # Where the state lives, and which copy is the authority
//!
//! | Location | Trust | Role |
//! |---|---|---|
//! | `{application}/promotions.json` | each record signed | **AUTHORITY.** Resolution folds this. |
//! | `calp-manifest.json` → `environments` | unsigned | Listing convenience. Never consulted by resolution. |
//! | `.cala` → `Subscription.environment` | local | Which environment a subscriber follows. |
//!
//! The listing exists for the same reason `VersionEntry.base_version` does: one
//! manifest read renders a browse list, and an `HttpWorkspace` can serve it
//! without the application-artifact route. It is written SECOND, so a crash
//! between the two writes leaves a stale listing over a correct authority, and
//! the next write self-corrects. Never the other order.
//!
//! # Per-record signatures, not a signed file
//!
//! A whole-file signature is made by whoever wrote last, and that signer would
//! then be vouching for every earlier promoter's record — exactly the property
//! `publishers::write_signed` denies to delegates. So each record carries its
//! own signature by its own promoter, and `package_name` and a dense `sequence`
//! sit INSIDE the signed bytes: a record cannot be transplanted between
//! applications, and the log cannot be re-ordered.
//!
//! [`PromotionRecord`] has NO `extra` flatten map, deliberately. The signature
//! is verified over `serde_json::to_vec` of the PARSED struct, so a field the
//! parse dropped would be a field the signature never covered — a split view.
//! Without the map, an unknown field fails the signature instead. The container
//! keeps its `extra`, where the same argument does not apply.
//!
//! # What the signature protects, and what it does not
//!
//! It protects: a share-writer who is not a publisher cannot fabricate a
//! promotion, cannot point `prod` at a version nobody promoted, and cannot make
//! one promoter's act look like another's. Every promotion names the key that
//! made it, and only the holder of that key could have made it.
//!
//! It does NOT protect against replay: someone with write access can restore an
//! older `promotions.json` and roll `prod` back to a version that was
//! legitimately `prod` once. That is the same limit `publishers.json` carries
//! (`publishers.rs`), for the same reason — a dumb file share has no
//! monotonicity to lean on. A client-side high-water mark on `sequence` would
//! make it detectable; it is not built here, and the doc says so rather than
//! implying more than is true.
//!
//! It also inherits delegation's shape: a promotion signed by a delegate who is
//! LATER removed from `publishers.json` stops verifying, exactly as that
//! delegate's published versions already do. The remedy is the same — someone
//! authorised re-promotes.

use std::collections::HashMap;

use serde::{Deserialize, Serialize};

use crate::error::CalpError;
use crate::manifest::SubscriptionTarget;
use crate::signing::PublisherKeypair;
use crate::transport::WorkspaceTransport;
use crate::version::SemVer;

/// The signed promotion log, at the application root beside `publishers.json`.
pub const PROMOTIONS_FILE: &str = "promotions.json";

/// The largest number of environments one application may define.
///
/// A guard on a file anyone with share access can write, not a policy: a
/// pipeline is read into memory and rendered as a list, and nothing a team does
/// by hand approaches this.
const MAX_ENVIRONMENTS: usize = 32;

/// Names an environment may not take, because something else already means them.
///
/// `dev` is the sentinel `is_dev_subscription` matches on (`dev_mode.rs`);
/// `latest` and `head` are pin grammar (`VersionPin::parse`). An environment
/// carrying one of those names would read as the thing it is not in at least
/// one surface, and the surfaces disagree quietly.
pub const RESERVED_ENVIRONMENT_NAMES: &[&str] = &["dev", "latest", "head", "line"];

/// One environment: a name, and the version it currently points at.
///
/// Doubles as the fold's output and the manifest's listing entry — one struct,
/// so the listing cannot describe a shape the fold cannot produce.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Environment {
    pub name: String,
    /// `None` = defined but never promoted into. Subscribing to it is refused
    /// (`EnvironmentEmpty`) rather than silently falling back to the line.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub version: Option<String>,
    /// What this environment pointed at before its current version. Display
    /// only — the rollback candidates come from the whole log, not from here.
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub previous_version: String,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub promoted_at: String,
    /// Display name of whoever promoted. Not verified; `promoter_key` is.
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub promoted_by: String,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub promoter_key: String,
    /// Sequence of the record that last set this entry.
    #[serde(default)]
    pub sequence: u64,
}

/// What one promotion record says happened.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum PromotionEvent {
    /// The whole ordered pipeline AFTER this change. Sent whole, like
    /// `SetCoPublishersParams`: a diff would have to be applied against a state
    /// the writer cannot prove they read.
    Pipeline { environments: Vec<String> },
    /// One pointer moved. `previous_version` is empty for a first promotion.
    Promote {
        environment: String,
        version: String,
        #[serde(default, skip_serializing_if = "String::is_empty")]
        previous_version: String,
    },
}

/// THE SIGNED SHAPE. See the module header for why it has no `extra` map.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PromotionRecord {
    pub format_version: u32,
    /// Inside the signature: a record cannot be moved to another application.
    pub package_name: String,
    /// Inside the signature, and dense from 1: the log cannot be re-ordered,
    /// and a removed record leaves a gap the fold refuses.
    pub sequence: u64,
    pub event: PromotionEvent,
    pub at: String,
    /// Promoter display name. Not verified; `key` is.
    pub by: String,
    /// The promoter's Ed25519 public key, lowercase hex. This is what is
    /// checked, against the set `publish::resolve_authorized_keys` returns.
    pub key: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SignedPromotion {
    pub record: PromotionRecord,
    pub signature: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PromotionLog {
    pub format_version: u32,
    pub package_name: String,
    pub promotions: Vec<SignedPromotion>,
    #[serde(flatten, default, skip_serializing_if = "HashMap::is_empty")]
    pub extra: HashMap<String, serde_json::Value>,
}

/// What one promotion did, for the caller's report.
#[derive(Debug, Clone, PartialEq)]
pub struct PromotionResult {
    pub package_name: String,
    pub environment: String,
    /// The version this environment held before. `None` = it held nothing.
    pub from: Option<String>,
    pub to: String,
    /// True when `to` is LOWER than `from`. The caller must say "rolled back"
    /// rather than "updated" — a subscriber reading a downgrade as an update
    /// is the lie this flag exists to prevent.
    pub is_rollback: bool,
    pub sequence: u64,
}

// ---------------------------------------------------------------------------
// Names
// ---------------------------------------------------------------------------

/// An environment name is a path component AND a lowercase identifier.
///
/// The path-component half is `validate_component`'s (this name reaches no path
/// today, but a `promotions/` subtree is the obvious next storage shape and a
/// name that could escape it would be a hole waiting). The identifier half is
/// this function's: environments are compared by name across machines, so
/// `Prod` and `prod` being different environments would strand subscribers on
/// the spelling their dialog happened to show.
pub fn validate_environment_name(name: &str) -> Result<(), CalpError> {
    let invalid = |reason: &str| {
        Err(CalpError::InvalidEnvironmentName {
            name: name.to_string(),
            reason: reason.to_string(),
        })
    };
    if name.is_empty() {
        return invalid("it is empty");
    }
    if name.len() > 32 {
        return invalid("it is longer than 32 characters");
    }
    // The path-component rules first, so a traversal attempt is refused as one.
    crate::workspace::validate_component(name, "environment name").map_err(|e| {
        CalpError::InvalidEnvironmentName { name: name.to_string(), reason: e.to_string() }
    })?;
    if !name
        .chars()
        .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-')
    {
        return invalid("use lowercase letters, digits and hyphens only");
    }
    if name.starts_with('-') || name.ends_with('-') {
        return invalid("it must not start or end with a hyphen");
    }
    if RESERVED_ENVIRONMENT_NAMES.contains(&name) {
        return invalid(
            "that word already means something else here — 'dev' is the local preview \
             subscription, and 'latest', 'head' and 'line' name the development line",
        );
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// Reading: load, verify, fold
// ---------------------------------------------------------------------------

/// The bytes a record's signature covers.
///
/// Serialized from the PARSED struct, never from the file's own bytes, which is
/// what makes the missing `extra` map load-bearing: a field the parse dropped
/// is a field these bytes do not contain, so the signature fails.
fn record_bytes(record: &PromotionRecord) -> Result<Vec<u8>, CalpError> {
    Ok(serde_json::to_vec(record)?)
}

fn sign_record(record: &PromotionRecord, keypair: &PublisherKeypair) -> Result<String, CalpError> {
    Ok(keypair.sign(&record_bytes(record)?))
}

/// Load the log and verify every record, or say why it cannot be trusted.
///
/// `Ok(None)` means the application has no log — the common case, and not a
/// failure. Every other way the log can be wrong is an ERROR, on
/// `publishers::load_verified`'s reasoning: "there is no log" and "there is a
/// log I could not trust" must not produce the same behaviour, because the
/// tamperer's goal may be exactly to make the real pipeline disappear and drop
/// every subscriber back onto the development line.
fn load_verified_log(
    registry: &dyn WorkspaceTransport,
    package: &str,
    authorized_keys: &[String],
) -> Result<Option<PromotionLog>, CalpError> {
    let Some(bytes) = registry.read_application_artifact(package, PROMOTIONS_FILE)? else {
        return Ok(None);
    };
    let invalid = |reason: String| CalpError::PromotionLogInvalid {
        package: package.to_string(),
        reason,
    };
    let log: PromotionLog = serde_json::from_slice(&bytes)
        .map_err(|e| invalid(format!("it is unreadable ({e})")))?;

    if log.package_name != package {
        return Err(invalid(format!(
            "it names the application '{}', not this one",
            log.package_name
        )));
    }

    for (i, signed) in log.promotions.iter().enumerate() {
        let expected_seq = (i as u64) + 1;
        if signed.record.sequence != expected_seq {
            return Err(invalid(format!(
                "the history jumps from entry {} to entry {} — a record has been removed \
                 or re-ordered",
                expected_seq.saturating_sub(1),
                signed.record.sequence
            )));
        }
        if signed.record.package_name != package {
            return Err(invalid(format!(
                "entry {} was written for a different application ('{}')",
                expected_seq, signed.record.package_name
            )));
        }
        if !authorized_keys.iter().any(|k| *k == signed.record.key) {
            return Err(invalid(format!(
                "entry {} was signed by a key that is not allowed to publish this \
                 application",
                expected_seq
            )));
        }
        let record_bytes = record_bytes(&signed.record)?;
        crate::signing::verify_signature(
            &signed.record.key,
            &record_bytes,
            &signed.signature,
            package,
            PROMOTIONS_FILE,
        )
        .map_err(|_| invalid(format!("entry {expected_seq} has been altered since it was signed")))?;
    }

    Ok(Some(log))
}

/// The current pipeline, folded from a verified log.
///
/// `Pipeline` replaces the ordered list, carrying each retained name's pointer
/// across; a name that is removed loses its pointer, and one that is removed and
/// re-added comes back empty. `Promote` moves one pointer.
fn fold(log: &PromotionLog, package: &str) -> Result<Vec<Environment>, CalpError> {
    let mut envs: Vec<Environment> = Vec::new();
    for signed in &log.promotions {
        let r = &signed.record;
        match &r.event {
            PromotionEvent::Pipeline { environments } => {
                let mut next: Vec<Environment> = Vec::with_capacity(environments.len());
                for name in environments {
                    match envs.iter().find(|e| e.name == *name) {
                        Some(existing) => next.push(existing.clone()),
                        None => next.push(Environment {
                            name: name.clone(),
                            version: None,
                            previous_version: String::new(),
                            promoted_at: r.at.clone(),
                            promoted_by: r.by.clone(),
                            promoter_key: r.key.clone(),
                            sequence: r.sequence,
                        }),
                    }
                }
                envs = next;
            }
            PromotionEvent::Promote { environment, version, previous_version } => {
                let Some(entry) = envs.iter_mut().find(|e| e.name == *environment) else {
                    // Cannot be produced legitimately: `promote` checks the
                    // environment exists under the lock. So this is a log
                    // somebody assembled by hand, and it must not resolve.
                    return Err(CalpError::PromotionLogInvalid {
                        package: package.to_string(),
                        reason: format!(
                            "entry {} promotes an environment ('{}') that the pipeline does \
                             not contain",
                            r.sequence, environment
                        ),
                    });
                };
                entry.version = Some(version.clone());
                entry.previous_version = previous_version.clone();
                entry.promoted_at = r.at.clone();
                entry.promoted_by = r.by.clone();
                entry.promoter_key = r.key.clone();
                entry.sequence = r.sequence;
            }
        }
    }
    Ok(envs)
}

/// Every version an environment has ever pointed at, newest first.
///
/// Both sides of every `Promote` record for that name, so a rollback target is
/// a version the environment demonstrably held rather than merely one that is
/// older. Survives a remove-and-re-add: the history is the log's, not the
/// current entry's.
pub fn versions_held(log: &PromotionLog, environment: &str) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for signed in &log.promotions {
        if let PromotionEvent::Promote { environment: name, version, previous_version } =
            &signed.record.event
        {
            if name != environment {
                continue;
            }
            for v in [version, previous_version] {
                if !v.is_empty() && !out.contains(v) {
                    out.push(v.clone());
                }
            }
        }
    }
    out.sort_by(|a, b| match (SemVer::parse(a), SemVer::parse(b)) {
        (Ok(x), Ok(y)) => y.cmp(&x),
        _ => b.cmp(a),
    });
    out
}

/// The keys allowed to promote this application: the same set the push gate
/// consults, so "who may publish" and "who may promote" cannot drift apart.
fn authorized_keys(
    registry: &dyn WorkspaceTransport,
    package: &str,
) -> Result<(Vec<String>, Option<SemVer>, String), CalpError> {
    let manifest = registry.get_application_manifest(package)?;
    let head = crate::publish::head_version(&manifest);
    let keys = match &head {
        Some(h) => crate::publish::resolve_authorized_keys(registry, package, h)?,
        None => Vec::new(),
    };
    let root_holder = head
        .as_ref()
        .and_then(|h| registry.get_version_manifest(package, &h.to_string()).ok())
        .map(|m| m.publisher_name)
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| "the publisher who created it".to_string());
    Ok((keys, head, root_holder))
}

/// The application's environments, folded from its verified log.
///
/// An application with no log has none — that is today's behaviour and the
/// default, not a degraded state.
pub fn environments(
    registry: &dyn WorkspaceTransport,
    package: &str,
) -> Result<Vec<Environment>, CalpError> {
    let (keys, _head, _) = authorized_keys(registry, package)?;
    match load_verified_log(registry, package, &keys)? {
        Some(log) => fold(&log, package),
        None => Ok(Vec::new()),
    }
}

/// The verified promotion history, oldest first.
pub fn promotion_history(
    registry: &dyn WorkspaceTransport,
    package: &str,
) -> Result<Vec<PromotionRecord>, CalpError> {
    let (keys, _head, _) = authorized_keys(registry, package)?;
    Ok(match load_verified_log(registry, package, &keys)? {
        Some(log) => log.promotions.into_iter().map(|s| s.record).collect(),
        None => Vec::new(),
    })
}

/// Every version an environment has EVER held, newest first.
///
/// From the signed log, never from the version listing. Two readers need this
/// and they need the same answer: the rollback picker (which may only offer a
/// version this environment actually ran) and writeback carry-forward (which
/// may only count submissions made against one). A second hand-rolled fold
/// would give them two answers, and the one that drifted would be silently
/// wrong — an offered rollback the backend refuses, or a subscriber's own
/// numbers vanishing after a rollback.
///
/// Includes the CURRENT version. Callers that want candidates filter it out.
pub fn versions_held_by(
    registry: &dyn WorkspaceTransport,
    package: &str,
    environment: &str,
) -> Result<Vec<String>, CalpError> {
    let history = promotion_history(registry, package)?;
    let mut out: Vec<String> = Vec::new();
    for record in &history {
        if let PromotionEvent::Promote { environment: name, version, previous_version } =
            &record.event
        {
            if name != environment {
                continue;
            }
            // BOTH ends of every move it made. The version it came FROM is one
            // it ran, and after two promotions forward that is the only place
            // the older one still appears.
            for v in [version, previous_version] {
                if !v.is_empty() && !out.contains(v) {
                    out.push(v.clone());
                }
            }
        }
    }
    out.sort_by(|a, b| match (SemVer::parse(a), SemVer::parse(b)) {
        (Ok(x), Ok(y)) => y.cmp(&x),
        _ => b.cmp(a),
    });
    Ok(out)
}

/// The version an environment currently points at.
///
/// FAILS CLOSED in every direction. A missing environment, an empty one, or a
/// log that does not verify all refuse by name; none of them falls back to the
/// development line, because falling back is precisely the accident this
/// feature exists to prevent — a consumer silently promoted onto unreleased
/// work the day an admin renames something.
pub fn resolve_environment(
    registry: &dyn WorkspaceTransport,
    package: &str,
    environment: &str,
) -> Result<SemVer, CalpError> {
    let envs = environments(registry, package)?;
    let Some(entry) = envs.iter().find(|e| e.name == environment) else {
        return Err(CalpError::EnvironmentNotFound {
            package: package.to_string(),
            environment: environment.to_string(),
            available: if envs.is_empty() {
                "no environments at all".to_string()
            } else {
                envs.iter().map(|e| e.name.as_str()).collect::<Vec<_>>().join(", ")
            },
        });
    };
    let Some(version) = &entry.version else {
        return Err(CalpError::EnvironmentEmpty {
            package: package.to_string(),
            environment: environment.to_string(),
        });
    };
    SemVer::parse(version).map_err(|_| CalpError::PromotionLogInvalid {
        package: package.to_string(),
        reason: format!("'{environment}' points at '{version}', which is not a version"),
    })
}

/// The version a subscription should be at: through its environment's pointer,
/// or through its pin on the development line.
///
/// THE ONE PLACE the two are told apart. Every resolver goes through here so a
/// forgotten branch is impossible rather than merely unlikely — the shape the
/// dead `channel:` pin prefix had, where twelve call sites each remembered to
/// special-case a string and nothing produced it.
pub fn resolve_target(
    registry: &dyn WorkspaceTransport,
    package: &str,
    target: &SubscriptionTarget,
) -> Result<SemVer, CalpError> {
    match target {
        SubscriptionTarget::Line(pin) => registry.resolve_version(package, pin),
        SubscriptionTarget::Environment(name) => resolve_environment(registry, package, name),
    }
}

// ---------------------------------------------------------------------------
// Writing: set_pipeline, promote
// ---------------------------------------------------------------------------

/// Append a record and write both files, log FIRST.
///
/// The caller holds the workspace lock. See the module header for the ordering.
fn commit(
    registry: &dyn WorkspaceTransport,
    package: &str,
    mut log: PromotionLog,
    record: PromotionRecord,
    keypair: &PublisherKeypair,
) -> Result<Vec<Environment>, CalpError> {
    let signature = sign_record(&record, keypair)?;
    let sequence = record.sequence;
    log.promotions.push(SignedPromotion { record, signature });
    let envs = fold(&log, package)?;

    // THE AUTHORITY FIRST. A crash between these two writes leaves a stale
    // listing over a correct log; resolution folds the log, so nothing resolves
    // wrongly, and the next write repairs the listing. The other order would
    // publish a pointer nothing had authorised.
    let bytes = serde_json::to_vec_pretty(&log)?;
    registry.write_application_artifact(package, PROMOTIONS_FILE, &bytes)?;

    let mut manifest = registry.get_application_manifest(package)?;
    manifest.environments = envs.clone();
    manifest.promotion_sequence = sequence;
    registry.write_application_manifest(&manifest)?;

    Ok(envs)
}

/// Define the ordered pipeline. An empty list removes every environment.
///
/// `expected_sequence` is the log length the caller read. Two admins editing
/// the pipeline from two machines serialize on the lock, but the lock cannot see
/// that the second one's READ was stale — the same lost-update the base-version
/// gate exists for, one file over.
pub fn set_pipeline(
    registry: &dyn WorkspaceTransport,
    package: &str,
    names: &[String],
    expected_sequence: u64,
    keypair: &PublisherKeypair,
    now: &str,
) -> Result<Vec<Environment>, CalpError> {
    if names.len() > MAX_ENVIRONMENTS {
        return Err(CalpError::InvalidEnvironmentName {
            name: format!("{} environments", names.len()),
            reason: format!("an application may define at most {MAX_ENVIRONMENTS}"),
        });
    }
    for name in names {
        validate_environment_name(name)?;
    }
    for (i, name) in names.iter().enumerate() {
        if names[..i].iter().any(|earlier| earlier == name) {
            return Err(CalpError::InvalidEnvironmentName {
                name: name.clone(),
                reason: "it is listed twice".to_string(),
            });
        }
    }

    let _lock = registry.lock()?;
    let (keys, _head, root_holder) = authorized_keys(registry, package)?;
    require_authorized(&keys, keypair, package, &root_holder)?;
    let log = load_verified_log(registry, package, &keys)?
        .unwrap_or_else(|| new_log(package));

    if log.promotions.len() as u64 != expected_sequence {
        return Err(CalpError::PromotionStale {
            package: package.to_string(),
            environment: "the pipeline".to_string(),
            shown: format!("{expected_sequence} change(s) ago"),
            actual: format!("{} change(s) ago", log.promotions.len()),
        });
    }

    let record = PromotionRecord {
        format_version: 1,
        package_name: package.to_string(),
        sequence: log.promotions.len() as u64 + 1,
        event: PromotionEvent::Pipeline { environments: names.to_vec() },
        at: now.to_string(),
        by: keypair.display_name(),
        key: keypair.public_key_hex(),
    };
    commit(registry, package, log, record, keypair)
}

/// Move one environment's pointer.
///
/// `version` `None` takes the natural source: the line's head for the first
/// environment, the previous environment's current version otherwise — which is
/// the "Promote test → prod" button with nothing typed.
///
/// `expected_current` is what the caller's dialog SHOWED this environment
/// holding (`Some(None)` = "it showed nothing"). A push or a colleague's
/// promotion can land between the dialog rendering and the click, and promoting
/// over a pointer nobody looked at is the defect `PreviewedVersions` closed for
/// refresh. `None` skips the check, for callers with nothing to compare.
#[allow(clippy::too_many_arguments)]
pub fn promote(
    registry: &dyn WorkspaceTransport,
    package: &str,
    environment: &str,
    version: Option<SemVer>,
    expected_current: Option<Option<String>>,
    keypair: &PublisherKeypair,
    now: &str,
) -> Result<PromotionResult, CalpError> {
    let _lock = registry.lock()?;

    let (keys, head, root_holder) = authorized_keys(registry, package)?;
    require_authorized(&keys, keypair, package, &root_holder)?;
    let Some(head) = head else {
        return Err(CalpError::PromotionNotLinear {
            package: package.to_string(),
            environment: environment.to_string(),
            version: version.map(|v| v.to_string()).unwrap_or_default(),
            allowed: "a version that has been published — this application has none yet"
                .to_string(),
        });
    };

    let log = load_verified_log(registry, package, &keys)?
        .unwrap_or_else(|| new_log(package));
    let envs = fold(&log, package)?;

    let Some(index) = envs.iter().position(|e| e.name == environment) else {
        return Err(CalpError::EnvironmentNotFound {
            package: package.to_string(),
            environment: environment.to_string(),
            available: if envs.is_empty() {
                "no environments at all".to_string()
            } else {
                envs.iter().map(|e| e.name.as_str()).collect::<Vec<_>>().join(", ")
            },
        });
    };
    let current = envs[index].version.clone();

    // What the caller was looking at is what the caller may promote over.
    if let Some(shown) = expected_current {
        if shown != current {
            return Err(CalpError::PromotionStale {
                package: package.to_string(),
                environment: environment.to_string(),
                shown: shown.map(|v| format!("v{v}")).unwrap_or_else(|| "empty".to_string()),
                actual: current
                    .clone()
                    .map(|v| format!("v{v}"))
                    .unwrap_or_else(|| "empty".to_string()),
            });
        }
    }

    // The natural source: the line for the first environment, the one before it
    // otherwise. Promotion is forward through the pipeline, one step at a time.
    let source_label;
    let target = match version {
        Some(v) => {
            source_label = "a version on the development line".to_string();
            v
        }
        None => {
            if index == 0 {
                source_label = "the development line".to_string();
                head.clone()
            } else {
                let previous = &envs[index - 1];
                let Some(pv) = &previous.version else {
                    return Err(CalpError::PromotionNotLinear {
                        package: package.to_string(),
                        environment: environment.to_string(),
                        version: "nothing".to_string(),
                        allowed: format!(
                            "what '{}' holds — and '{}' has nothing in it yet",
                            previous.name, previous.name
                        ),
                    });
                };
                source_label = previous.name.clone();
                SemVer::parse(pv).map_err(|_| CalpError::PromotionLogInvalid {
                    package: package.to_string(),
                    reason: format!("'{}' points at '{}', which is not a version", previous.name, pv),
                })?
            }
        }
    };
    let _ = source_label;
    let target_str = target.to_string();

    if current.as_deref() == Some(target_str.as_str()) {
        return Err(CalpError::EnvironmentAlreadyAt {
            package: package.to_string(),
            environment: environment.to_string(),
            version: target_str,
        });
    }

    // The version must exist, be signed, and be signed by a key this
    // application authorises. Without the last check a promotion could point an
    // environment at a version a stranger wrote into the share, and every
    // subscriber of that environment would then fail at pull with a checksum or
    // trust error they cannot act on.
    if !registry.version_exists(package, &target_str) {
        return Err(CalpError::VersionNotFound {
            package: package.to_string(),
            version: target_str,
        });
    }
    let signed_manifest =
        crate::integrity::load_signed_manifest_via(registry, package, &target_str)?;
    if !keys.iter().any(|k| *k == signed_manifest.manifest.publisher_key) {
        return Err(CalpError::PromotionNotLinear {
            package: package.to_string(),
            environment: environment.to_string(),
            version: target_str,
            allowed: "a version published by someone this application allows to publish it"
                .to_string(),
        });
    }

    // LINEAR DISCIPLINE. The first environment draws from anywhere on the line;
    // the rest take what the environment before them holds. A version this
    // environment has HELD before is always allowed — that is a rollback, and
    // refusing it would mean the only way back from a bad release is another
    // release.
    let held = versions_held(&log, environment);
    let allowed_by_position = if index == 0 {
        true
    } else {
        envs[index - 1].version.as_deref() == Some(target_str.as_str())
    };
    if !allowed_by_position && !held.contains(&target_str) {
        let mut allowed = if index == 0 {
            "any version on the development line".to_string()
        } else {
            match &envs[index - 1].version {
                Some(v) => format!("v{} (what '{}' holds)", v, envs[index - 1].name),
                None => format!("what '{}' holds — and it has nothing yet", envs[index - 1].name),
            }
        };
        if !held.is_empty() {
            allowed.push_str(&format!(
                ", or a version it has held before: {}",
                held.iter().map(|v| format!("v{v}")).collect::<Vec<_>>().join(", ")
            ));
        }
        return Err(CalpError::PromotionNotLinear {
            package: package.to_string(),
            environment: environment.to_string(),
            version: target_str,
            allowed,
        });
    }

    let previous_version = current.clone().unwrap_or_default();
    let is_rollback = match (&current, SemVer::parse(&target_str)) {
        (Some(c), Ok(t)) => SemVer::parse(c).map(|cv| t < cv).unwrap_or(false),
        _ => false,
    };
    let sequence = log.promotions.len() as u64 + 1;
    let record = PromotionRecord {
        format_version: 1,
        package_name: package.to_string(),
        sequence,
        event: PromotionEvent::Promote {
            environment: environment.to_string(),
            version: target_str.clone(),
            previous_version,
        },
        at: now.to_string(),
        by: keypair.display_name(),
        key: keypair.public_key_hex(),
    };
    commit(registry, package, log, record, keypair)?;

    Ok(PromotionResult {
        package_name: package.to_string(),
        environment: environment.to_string(),
        from: current,
        to: target_str,
        is_rollback,
        sequence,
    })
}

fn new_log(package: &str) -> PromotionLog {
    PromotionLog {
        format_version: 1,
        package_name: package.to_string(),
        promotions: Vec::new(),
        extra: HashMap::new(),
    }
}

/// An EMPTY authorised set is a refusal here, and that differs from the push
/// gate on purpose.
///
/// Push reads an empty set as "no continuity to enforce" — an application whose
/// first version predates signing has nobody to break faith with. A promotion
/// is the opposite case: its whole product is a record subscribers verify, and
/// a record signed by a key nothing authorises is one no subscriber can accept.
/// Writing it would produce a pipeline that resolves for its author and refuses
/// for everyone else.
fn require_authorized(
    keys: &[String],
    keypair: &PublisherKeypair,
    package: &str,
    root_holder: &str,
) -> Result<(), CalpError> {
    if keys.iter().any(|k| *k == keypair.public_key_hex()) {
        return Ok(());
    }
    Err(CalpError::NotAuthorizedToPromote {
        package: package.to_string(),
        root_holder: root_holder.to_string(),
    })
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use crate::publish::{self, PublishRequest};
    use crate::signing::PublisherKeypair;
    use crate::workspace::LocalWorkspace;
    use tempfile::TempDir;

    const NOW: &str = "2026-09-05T00:00:00Z";

    fn workbook() -> persistence::Workbook {
        let mut sheet = persistence::Sheet::new("Sheet1".to_string());
        sheet.cells.insert(
            (0, 0),
            persistence::SavedCell::from_cell(&engine::cell::Cell::new_number(1.0)),
        );
        let mut wb = persistence::Workbook::default();
        wb.sheets = vec![sheet];
        wb
    }

    /// A workspace with `versions` published under `pkg`, all by `prof`'s key.
    fn published(dir: &TempDir, prof: &std::path::Path, versions: &[(u32, u32, u32)]) -> LocalWorkspace {
        let reg = LocalWorkspace::open(dir.path()).unwrap();
        let wb = workbook();
        for v in versions {
            let request = PublishRequest {
                workbook: &wb,
                package_name: "app".to_string(),
                version: SemVer::new(v.0, v.1, v.2),
                kind: "report".to_string(),
                mode: publish::test_mode_for(&reg, "app"),
                change_summary: "push".to_string(),
                sheet_indices: vec![0],
                now: NOW.to_string(),
                published_by: "tester".to_string(),
                writeback_regions: None,
                model_writebacks: None,
                object_scripts: None,
                module_scripts: None,
                notebooks: None,
                data_sources: Vec::new(),
                excluded_regions: Vec::new(),
                custom_objects: Vec::new(),
                include_comments: false,
                min_app_version: String::new(),
            };
            publish::publish(&reg, &request, prof).expect("publish");
        }
        reg
    }

    fn keypair(prof: &TempDir) -> PublisherKeypair {
        PublisherKeypair::load_or_create(prof.path()).unwrap()
    }

    fn names(envs: &[Environment]) -> Vec<String> {
        envs.iter().map(|e| e.name.clone()).collect()
    }

    fn version_of(envs: &[Environment], name: &str) -> Option<String> {
        envs.iter().find(|e| e.name == name).and_then(|e| e.version.clone())
    }

    fn pipeline(reg: &LocalWorkspace, kp: &PublisherKeypair, list: &[&str]) -> Vec<Environment> {
        let names: Vec<String> = list.iter().map(|s| s.to_string()).collect();
        let seq = reg.get_application_manifest("app").unwrap().promotion_sequence;
        set_pipeline(reg, "app", &names, seq, kp, NOW).expect("set_pipeline")
    }

    /// An application with no promotion log has no environments, and asking for
    /// one says so rather than resolving to anything.
    ///
    /// SABOTAGE: treat an absent `promotions.json` as `PromotionLogInvalid`.
    /// Every application in every existing workspace then reports a corrupt
    /// pipeline, and the browse list fills with a problem nobody caused.
    #[test]
    fn an_application_starts_with_no_environments() {
        let dir = TempDir::new().unwrap();
        let prof = TempDir::new().unwrap();
        let reg = published(&dir, prof.path(), &[(1, 0, 0)]);

        assert!(environments(&reg, "app").unwrap().is_empty());
        assert!(promotion_history(&reg, "app").unwrap().is_empty());
        match resolve_environment(&reg, "app", "prod") {
            Err(CalpError::EnvironmentNotFound { available, .. }) => {
                assert!(available.contains("no environments"), "{available}");
            }
            other => panic!("expected EnvironmentNotFound, got {other:?}"),
        }
    }

    /// The pipeline keeps the ORDER it was given: promotion is forward through
    /// it, so the order IS the meaning.
    ///
    /// SABOTAGE: sort the names. `[test, prod]` and `[prod, test]` then promote
    /// in the same direction, and "promote to prod" takes from whichever name
    /// sorts first.
    #[test]
    fn set_pipeline_keeps_the_order_it_was_given() {
        let dir = TempDir::new().unwrap();
        let prof = TempDir::new().unwrap();
        let reg = published(&dir, prof.path(), &[(1, 0, 0)]);
        let kp = keypair(&prof);

        let envs = pipeline(&reg, &kp, &["test", "prod"]);
        assert_eq!(names(&envs), vec!["test", "prod"]);
        assert!(envs.iter().all(|e| e.version.is_none()), "nothing promoted yet");

        // Re-reading through the verified fold gives the same answer as the
        // write did — the listing is not a second opinion.
        assert_eq!(environments(&reg, "app").unwrap(), envs);

        let reordered = pipeline(&reg, &kp, &["prod", "test"]);
        assert_eq!(names(&reordered), vec!["prod", "test"]);
    }

    /// The FIRST environment draws from the development line and defaults to
    /// its head; the rest take what the environment before them holds.
    ///
    /// SABOTAGE: make the natural source `envs[i-1]` for `i == 0` too — the
    /// first environment then has nothing to promote from and the pipeline can
    /// never be started.
    #[test]
    fn the_first_environment_promotes_from_the_line_and_defaults_to_head() {
        let dir = TempDir::new().unwrap();
        let prof = TempDir::new().unwrap();
        let reg = published(&dir, prof.path(), &[(1, 0, 0), (1, 1, 0)]);
        let kp = keypair(&prof);
        pipeline(&reg, &kp, &["test", "prod"]);

        let r = promote(&reg, "app", "test", None, None, &kp, NOW).unwrap();
        assert_eq!(r.to, "1.1.0", "the head of the line");
        assert!(!r.is_rollback);
        assert_eq!(r.from, None);

        // prod takes what test holds, not the head.
        let r2 = promote(&reg, "app", "prod", None, None, &kp, NOW).unwrap();
        assert_eq!(r2.to, "1.1.0");
        assert_eq!(resolve_environment(&reg, "app", "prod").unwrap().to_string(), "1.1.0");
    }

    /// PROMOTION IS LINEAR. An environment takes what the one before it holds —
    /// not whatever is newest — or the pipeline is decoration.
    ///
    /// SABOTAGE: delete the `allowed_by_position` arm and accept any version on
    /// the line. `prod` can then be promoted straight past `test`, which is the
    /// entire thing a pipeline exists to prevent.
    #[test]
    fn promotion_is_linear() {
        let dir = TempDir::new().unwrap();
        let prof = TempDir::new().unwrap();
        let reg = published(&dir, prof.path(), &[(1, 0, 0), (1, 1, 0)]);
        let kp = keypair(&prof);
        pipeline(&reg, &kp, &["test", "prod"]);
        promote(&reg, "app", "test", Some(SemVer::new(1, 0, 0)), None, &kp, NOW).unwrap();

        // test holds 1.0.0, so prod may not jump to 1.1.0.
        match promote(&reg, "app", "prod", Some(SemVer::new(1, 1, 0)), None, &kp, NOW) {
            Err(CalpError::PromotionNotLinear { allowed, .. }) => {
                assert!(allowed.contains("1.0.0"), "names what IS allowed: {allowed}");
                assert!(allowed.contains("test"), "and where it comes from: {allowed}");
            }
            other => panic!("expected PromotionNotLinear, got {other:?}"),
        }
        // What test holds is allowed.
        promote(&reg, "app", "prod", Some(SemVer::new(1, 0, 0)), None, &kp, NOW).unwrap();
    }

    /// ROLLBACK: an environment may return to a version IT HELD, and the result
    /// says which direction it went.
    ///
    /// SABOTAGE: derive the held-versions list from the manifest LISTING
    /// (`envs[i].previous_version`) instead of the log. Only the single most
    /// recent step is then reachable, and a rollback across two promotions —
    /// the case a bad release actually produces — is refused.
    #[test]
    fn a_rollback_to_a_version_the_environment_held_is_allowed_and_flagged() {
        let dir = TempDir::new().unwrap();
        let prof = TempDir::new().unwrap();
        let reg = published(&dir, prof.path(), &[(1, 0, 0), (1, 1, 0), (1, 2, 0)]);
        let kp = keypair(&prof);
        pipeline(&reg, &kp, &["prod"]);

        promote(&reg, "app", "prod", Some(SemVer::new(1, 0, 0)), None, &kp, NOW).unwrap();
        promote(&reg, "app", "prod", Some(SemVer::new(1, 1, 0)), None, &kp, NOW).unwrap();
        promote(&reg, "app", "prod", Some(SemVer::new(1, 2, 0)), None, &kp, NOW).unwrap();

        // Two steps back, not one.
        let r = promote(&reg, "app", "prod", Some(SemVer::new(1, 0, 0)), None, &kp, NOW).unwrap();
        assert!(r.is_rollback, "1.0.0 is lower than 1.2.0");
        assert_eq!(r.from.as_deref(), Some("1.2.0"));
        assert_eq!(resolve_environment(&reg, "app", "prod").unwrap().to_string(), "1.0.0");

        // A version it has never held is still refused, even though it is on
        // the line and older than the head.
        let dir2 = TempDir::new().unwrap();
        let prof2 = TempDir::new().unwrap();
        let reg2 = published(&dir2, prof2.path(), &[(1, 0, 0), (1, 1, 0)]);
        let kp2 = keypair(&prof2);
        let seq = reg2.get_application_manifest("app").unwrap().promotion_sequence;
        set_pipeline(&reg2, "app", &["test".into(), "prod".into()], seq, &kp2, NOW).unwrap();
        promote(&reg2, "app", "test", Some(SemVer::new(1, 1, 0)), None, &kp2, NOW).unwrap();
        assert!(matches!(
            promote(&reg2, "app", "prod", Some(SemVer::new(1, 0, 0)), None, &kp2, NOW),
            Err(CalpError::PromotionNotLinear { .. })
        ));
    }

    /// Promoting is publishing: the same authorised set, so "who may push" and
    /// "who may promote" cannot drift apart.
    ///
    /// SABOTAGE: skip `require_authorized`. Anyone with write access to the
    /// share can then point prod anywhere, which is the whole property the
    /// signature exists to establish.
    #[test]
    fn only_an_authorised_key_may_promote() {
        let dir = TempDir::new().unwrap();
        let prof = TempDir::new().unwrap();
        let stranger_prof = TempDir::new().unwrap();
        let reg = published(&dir, prof.path(), &[(1, 0, 0)]);
        let kp = keypair(&prof);
        let stranger = keypair(&stranger_prof);
        assert_ne!(kp.public_key_hex(), stranger.public_key_hex());

        pipeline(&reg, &kp, &["prod"]);
        match promote(&reg, "app", "prod", None, None, &stranger, NOW) {
            Err(CalpError::NotAuthorizedToPromote { .. }) => {}
            other => panic!("expected NotAuthorizedToPromote, got {other:?}"),
        }
        // ...and the stranger cannot define a pipeline either.
        assert!(matches!(
            set_pipeline(&reg, "app", &["x".into()], 1, &stranger, NOW),
            Err(CalpError::NotAuthorizedToPromote { .. })
        ));
    }

    /// A DELEGATE may promote, and the record names the delegate — the reason
    /// delegation exists instead of a shared team key.
    ///
    /// SABOTAGE: resolve the authorised set from the head manifest's
    /// `publisher_key` alone. Co-publishing then works for pushes and not for
    /// promotions, and a team with a release manager cannot ship.
    #[test]
    fn a_delegate_may_promote_and_is_named_in_the_record() {
        let dir = TempDir::new().unwrap();
        let prof = TempDir::new().unwrap();
        let delegate_prof = TempDir::new().unwrap();
        let reg = published(&dir, prof.path(), &[(1, 0, 0)]);
        let root = keypair(&prof);
        let delegate = keypair(&delegate_prof);

        let list = crate::publishers::PublisherList {
            format_version: 1,
            package_name: "app".to_string(),
            root_key: root.public_key_hex(),
            revision: 1,
            updated_at: NOW.to_string(),
            authorized_keys: vec![crate::publishers::AuthorizedKey {
                key: delegate.public_key_hex(),
                name: "delegate".to_string(),
                added_at: NOW.to_string(),
            }],
            extra: std::collections::HashMap::new(),
        };
        crate::publishers::write_signed(&reg, &list, &root).unwrap();

        pipeline(&reg, &root, &["prod"]);
        let r = promote(&reg, "app", "prod", None, None, &delegate, NOW).unwrap();
        assert_eq!(r.to, "1.0.0");

        let history = promotion_history(&reg, "app").unwrap();
        let last = history.last().unwrap();
        assert_eq!(last.key, delegate.public_key_hex(), "attributed to the delegate");
        // And the fold agrees, so the Explorer shows who moved prod.
        let envs = environments(&reg, "app").unwrap();
        assert_eq!(envs[0].promoter_key, delegate.public_key_hex());
    }

    /// A pointer may only name a version that EXISTS and is properly signed.
    ///
    /// SABOTAGE: check `version_exists` alone. A promotion can then point at a
    /// half-written or tampered version directory, and every subscriber of that
    /// environment fails at pull with a checksum error they cannot act on.
    #[test]
    fn a_missing_or_unsigned_version_cannot_be_promoted() {
        let dir = TempDir::new().unwrap();
        let prof = TempDir::new().unwrap();
        let reg = published(&dir, prof.path(), &[(1, 0, 0)]);
        let kp = keypair(&prof);
        pipeline(&reg, &kp, &["prod"]);

        assert!(matches!(
            promote(&reg, "app", "prod", Some(SemVer::new(9, 9, 9)), None, &kp, NOW),
            Err(CalpError::VersionNotFound { .. })
        ));

        // Break the signature of the version that DOES exist.
        let sig_path = dir
            .path()
            .join("app")
            .join("1.0.0")
            .join(crate::integrity::VERSION_MANIFEST_SIG_FILE);
        std::fs::write(&sig_path, b"00").unwrap();
        assert!(matches!(
            promote(&reg, "app", "prod", Some(SemVer::new(1, 0, 0)), None, &kp, NOW),
            Err(CalpError::ManifestSignatureInvalid { .. })
        ));
    }

    /// AN ALTERED OR TRUNCATED LOG IS AN ERROR, NEVER AN ABSENT PIPELINE.
    ///
    /// "There is no log" and "there is a log I could not trust" must not produce
    /// the same behaviour: the tamperer's goal may be exactly to make the
    /// pipeline disappear and drop every subscriber back onto the line.
    ///
    /// SABOTAGE: `.ok()` the verification, or `unwrap_or_default()` the load.
    #[test]
    fn a_tampered_log_is_an_error_not_an_absent_pipeline() {
        let dir = TempDir::new().unwrap();
        let prof = TempDir::new().unwrap();
        let reg = published(&dir, prof.path(), &[(1, 0, 0), (1, 1, 0)]);
        let kp = keypair(&prof);
        pipeline(&reg, &kp, &["prod"]);
        promote(&reg, "app", "prod", Some(SemVer::new(1, 0, 0)), None, &kp, NOW).unwrap();

        let log_path = dir.path().join("app").join(PROMOTIONS_FILE);
        let good = std::fs::read(&log_path).unwrap();

        // (a) Edit the version a record points at, leaving its signature.
        let edited = String::from_utf8(good.clone()).unwrap().replace("1.0.0", "1.1.0");
        std::fs::write(&log_path, edited.as_bytes()).unwrap();
        match environments(&reg, "app") {
            Err(CalpError::PromotionLogInvalid { reason, .. }) => {
                assert!(reason.contains("altered"), "{reason}");
            }
            other => panic!("expected PromotionLogInvalid, got {other:?}"),
        }

        // (b) Remove the FIRST record, leaving a dense-looking tail. The
        // sequence check catches it: entry 2 cannot be the first entry.
        let mut log: PromotionLog = serde_json::from_slice(&good).unwrap();
        log.promotions.remove(0);
        std::fs::write(&log_path, serde_json::to_vec_pretty(&log).unwrap()).unwrap();
        match environments(&reg, "app") {
            Err(CalpError::PromotionLogInvalid { reason, .. }) => {
                assert!(reason.contains("removed or re-ordered"), "{reason}");
            }
            other => panic!("expected PromotionLogInvalid, got {other:?}"),
        }

        // And resolution fails closed rather than falling back to the line.
        std::fs::write(&log_path, serde_json::to_vec_pretty(&log).unwrap()).unwrap();
        assert!(matches!(
            resolve_environment(&reg, "app", "prod"),
            Err(CalpError::PromotionLogInvalid { .. })
        ));
    }

    /// A record signed for ANOTHER application cannot be transplanted into this
    /// one — `package_name` is inside the signed bytes.
    ///
    /// SABOTAGE: drop the `package_name` check in `load_verified_log`. A
    /// promotion legitimately made for `staging-app` then moves `prod` here.
    #[test]
    fn a_record_borrowed_from_another_application_is_refused() {
        let dir = TempDir::new().unwrap();
        let prof = TempDir::new().unwrap();
        let reg = published(&dir, prof.path(), &[(1, 0, 0)]);
        let kp = keypair(&prof);
        pipeline(&reg, &kp, &["prod"]);

        // A record whose signature is valid, for a different application.
        let mut record = PromotionRecord {
            format_version: 1,
            package_name: "other-app".to_string(),
            sequence: 2,
            event: PromotionEvent::Promote {
                environment: "prod".to_string(),
                version: "1.0.0".to_string(),
                previous_version: String::new(),
            },
            at: NOW.to_string(),
            by: kp.display_name(),
            key: kp.public_key_hex(),
        };
        let signature = sign_record(&record, &kp).unwrap();
        record.package_name = "other-app".to_string();

        let log_path = dir.path().join("app").join(PROMOTIONS_FILE);
        let mut log: PromotionLog =
            serde_json::from_slice(&std::fs::read(&log_path).unwrap()).unwrap();
        log.promotions.push(SignedPromotion { record, signature });
        std::fs::write(&log_path, serde_json::to_vec_pretty(&log).unwrap()).unwrap();

        match environments(&reg, "app") {
            Err(CalpError::PromotionLogInvalid { reason, .. }) => {
                assert!(reason.contains("different application"), "{reason}");
            }
            other => panic!("expected PromotionLogInvalid, got {other:?}"),
        }
    }

    /// THE AUTHORITY IS WRITTEN FIRST. A crash between the two writes must
    /// leave a stale LISTING over a correct log, never a pointer the log does
    /// not justify.
    ///
    /// SABOTAGE: swap the two writes in `commit`.
    #[test]
    fn the_log_is_written_before_the_listing() {
        const SELF: &str = include_str!("environments.rs");
        let body = SELF
            .split("fn commit(")
            .nth(1)
            .expect("commit is gone")
            .split("\nfn ")
            .next()
            .unwrap();
        let log_at = body.find("write_application_artifact(").expect("log write is gone");
        let listing_at = body
            .find("write_application_manifest(")
            .expect("listing write is gone");
        assert!(log_at < listing_at, "the log must be written before the listing");
    }

    /// The SIGNED record carries no `extra` flatten map.
    ///
    /// The signature is verified over `serde_json::to_vec` of the PARSED
    /// struct, so a field the parse dropped is a field the signature never
    /// covered — a split view between what was signed and what is read. Without
    /// the map, an unknown field fails the signature instead.
    ///
    /// SABOTAGE: add `#[serde(flatten)] extra` to `PromotionRecord`.
    #[test]
    fn the_signed_record_has_no_extra_map() {
        const SELF: &str = include_str!("environments.rs");
        let decl = SELF
            .split("pub struct PromotionRecord {")
            .nth(1)
            .expect("PromotionRecord is gone")
            .split('}')
            .next()
            .unwrap();
        assert!(
            !decl.contains("flatten"),
            "PromotionRecord must not carry a flatten map: {decl}"
        );
    }

    /// Names are identifiers, not free text: they are compared across machines.
    ///
    /// SABOTAGE: drop the reserved list. An environment called `dev` then
    /// collides with the local-preview sentinel, and one called `latest` reads
    /// as pin grammar in half the surfaces.
    #[test]
    fn reserved_and_malformed_names_are_refused() {
        for bad in [
            "", "Prod", "a b", "a:b", "a/b", "-x", "x-", "dev", "latest", "head", "line",
            "prod!", "..",
        ] {
            assert!(
                validate_environment_name(bad).is_err(),
                "should have refused {bad:?}"
            );
        }
        for good in ["prod", "test", "uat", "pre-prod", "stage2"] {
            validate_environment_name(good).unwrap_or_else(|e| panic!("{good}: {e}"));
        }

        let dir = TempDir::new().unwrap();
        let prof = TempDir::new().unwrap();
        let reg = published(&dir, prof.path(), &[(1, 0, 0)]);
        let kp = keypair(&prof);
        // Duplicates are refused too — two entries of one name have no ordering.
        assert!(matches!(
            set_pipeline(&reg, "app", &["prod".into(), "prod".into()], 0, &kp, NOW),
            Err(CalpError::InvalidEnvironmentName { .. })
        ));
    }

    /// Both mutators take the workspace lock BEFORE they read the state they
    /// are about to act on: a check outside the lock is a TOCTOU window on a
    /// share two people publish to.
    ///
    /// SABOTAGE: delete `let _lock = registry.lock()?;` from either.
    #[test]
    fn the_mutators_lock_before_they_read() {
        const SELF: &str = include_str!("environments.rs");
        for name in ["pub fn set_pipeline(", "pub fn promote("] {
            let body = SELF.split(name).nth(1).expect(name).split("\n}\n").next().unwrap();
            let lock = body.find("registry.lock()").unwrap_or_else(|| panic!("{name} has no lock"));
            let read = body
                .find("authorized_keys(registry")
                .unwrap_or_else(|| panic!("{name} does not read the authorised set"));
            assert!(lock < read, "{name} reads workspace state before locking");
        }
    }

    /// A promotion signed by a delegate who is LATER removed stops verifying —
    /// the same rule that delegate's published versions already follow.
    ///
    /// Not a defect: it is what "the current list decides" means, and the
    /// remedy is that someone authorised re-promotes. Pinned so the behaviour
    /// is a decision rather than a discovery.
    #[test]
    fn a_promotion_by_a_removed_delegate_stops_verifying() {
        let dir = TempDir::new().unwrap();
        let prof = TempDir::new().unwrap();
        let delegate_prof = TempDir::new().unwrap();
        let reg = published(&dir, prof.path(), &[(1, 0, 0)]);
        let root = keypair(&prof);
        let delegate = keypair(&delegate_prof);

        let mut list = crate::publishers::PublisherList {
            format_version: 1,
            package_name: "app".to_string(),
            root_key: root.public_key_hex(),
            revision: 1,
            updated_at: NOW.to_string(),
            authorized_keys: vec![crate::publishers::AuthorizedKey {
                key: delegate.public_key_hex(),
                name: "delegate".to_string(),
                added_at: NOW.to_string(),
            }],
            extra: std::collections::HashMap::new(),
        };
        crate::publishers::write_signed(&reg, &list, &root).unwrap();
        pipeline(&reg, &root, &["prod"]);
        promote(&reg, "app", "prod", None, None, &delegate, NOW).unwrap();
        assert_eq!(resolve_environment(&reg, "app", "prod").unwrap().to_string(), "1.0.0");

        // The root removes the delegate.
        list.revision = 2;
        list.authorized_keys.clear();
        crate::publishers::write_signed(&reg, &list, &root).unwrap();

        match environments(&reg, "app") {
            Err(CalpError::PromotionLogInvalid { reason, .. }) => {
                assert!(reason.contains("not allowed to publish"), "{reason}");
            }
            other => panic!("expected PromotionLogInvalid, got {other:?}"),
        }
    }

    /// A promotion carries the pointer the caller was SHOWN, and is refused if
    /// it moved. The `PreviewedVersions` lesson, one file over: a colleague's
    /// promotion can land between the dialog rendering and the click.
    ///
    /// SABOTAGE: ignore `expected_current`.
    #[test]
    fn a_promotion_over_a_pointer_that_moved_is_refused() {
        let dir = TempDir::new().unwrap();
        let prof = TempDir::new().unwrap();
        let reg = published(&dir, prof.path(), &[(1, 0, 0), (1, 1, 0)]);
        let kp = keypair(&prof);
        pipeline(&reg, &kp, &["test", "prod"]);
        promote(&reg, "app", "test", Some(SemVer::new(1, 0, 0)), None, &kp, NOW).unwrap();
        promote(&reg, "app", "prod", Some(SemVer::new(1, 0, 0)), None, &kp, NOW).unwrap();

        // The dialog rendered when prod held nothing; it now holds 1.0.0.
        match promote(&reg, "app", "prod", Some(SemVer::new(1, 0, 0)), Some(None), &kp, NOW) {
            Err(CalpError::PromotionStale { shown, actual, .. }) => {
                assert_eq!(shown, "empty");
                assert_eq!(actual, "v1.0.0");
            }
            other => panic!("expected PromotionStale, got {other:?}"),
        }

        // The pipeline edit carries the same token.
        assert!(matches!(
            set_pipeline(&reg, "app", &["test".into()], 0, &kp, NOW),
            Err(CalpError::PromotionStale { .. })
        ));
    }

    /// Promoting an environment to what it already holds is refused, so the
    /// history does not fill with entries that changed nothing.
    #[test]
    fn promoting_to_the_current_version_is_refused() {
        let dir = TempDir::new().unwrap();
        let prof = TempDir::new().unwrap();
        let reg = published(&dir, prof.path(), &[(1, 0, 0)]);
        let kp = keypair(&prof);
        pipeline(&reg, &kp, &["prod"]);
        promote(&reg, "app", "prod", None, None, &kp, NOW).unwrap();
        assert!(matches!(
            promote(&reg, "app", "prod", Some(SemVer::new(1, 0, 0)), None, &kp, NOW),
            Err(CalpError::EnvironmentAlreadyAt { .. })
        ));
    }

    /// Removing an environment drops its pointer; re-adding the name starts it
    /// empty rather than resurrecting where it used to point.
    ///
    /// SABOTAGE: carry the pointer across a removal. A name reused for a
    /// different purpose then silently inherits the old one's version.
    #[test]
    fn a_removed_environment_loses_its_pointer() {
        let dir = TempDir::new().unwrap();
        let prof = TempDir::new().unwrap();
        let reg = published(&dir, prof.path(), &[(1, 0, 0)]);
        let kp = keypair(&prof);
        pipeline(&reg, &kp, &["test", "prod"]);
        promote(&reg, "app", "test", None, None, &kp, NOW).unwrap();
        assert_eq!(version_of(&environments(&reg, "app").unwrap(), "test").as_deref(), Some("1.0.0"));

        pipeline(&reg, &kp, &["prod"]);
        assert!(matches!(
            resolve_environment(&reg, "app", "test"),
            Err(CalpError::EnvironmentNotFound { .. })
        ));

        pipeline(&reg, &kp, &["test", "prod"]);
        assert_eq!(version_of(&environments(&reg, "app").unwrap(), "test"), None);
        match resolve_environment(&reg, "app", "test") {
            Err(CalpError::EnvironmentEmpty { .. }) => {}
            other => panic!("expected EnvironmentEmpty, got {other:?}"),
        }
    }

    /// An empty pipeline is legal: it means "no environments", which is where
    /// every application starts and what a team may go back to.
    #[test]
    fn a_pipeline_can_be_emptied() {
        let dir = TempDir::new().unwrap();
        let prof = TempDir::new().unwrap();
        let reg = published(&dir, prof.path(), &[(1, 0, 0)]);
        let kp = keypair(&prof);
        pipeline(&reg, &kp, &["prod"]);
        let envs = pipeline(&reg, &kp, &[]);
        assert!(envs.is_empty());
        assert!(environments(&reg, "app").unwrap().is_empty());
    }

    /// `resolve_target` is the ONE place a pin and an environment are told
    /// apart, and it never falls through from one to the other.
    ///
    /// SABOTAGE: make the `Environment` arm fall back to `resolve_version` when
    /// the environment is missing. Every subscriber of a removed environment
    /// then rides the development line — silently promoted onto unreleased
    /// work, which is the accident this whole feature exists to prevent.
    #[test]
    fn resolve_target_never_falls_back_to_the_line() {
        let dir = TempDir::new().unwrap();
        let prof = TempDir::new().unwrap();
        let reg = published(&dir, prof.path(), &[(1, 0, 0), (1, 1, 0)]);
        let kp = keypair(&prof);
        pipeline(&reg, &kp, &["prod"]);
        promote(&reg, "app", "prod", Some(SemVer::new(1, 0, 0)), None, &kp, NOW).unwrap();

        let line = SubscriptionTarget::Line(crate::version::VersionPin::Latest);
        assert_eq!(resolve_target(&reg, "app", &line).unwrap().to_string(), "1.1.0");

        let env = SubscriptionTarget::Environment("prod".to_string());
        assert_eq!(resolve_target(&reg, "app", &env).unwrap().to_string(), "1.0.0");

        let gone = SubscriptionTarget::Environment("staging".to_string());
        assert!(matches!(
            resolve_target(&reg, "app", &gone),
            Err(CalpError::EnvironmentNotFound { .. })
        ));
    }

    /// An application manifest written before environments existed loads with
    /// none, and a subscription without the field follows the line.
    ///
    /// SABOTAGE: drop `#[serde(default)]` from either field.
    #[test]
    fn absent_fields_default_to_todays_behaviour() {
        let json = r#"{
            "formatVersion": 1, "name": "app", "kind": "report",
            "created": "2026-01-01T00:00:00Z", "versions": [],
            "channel": "prod"
        }"#;
        let m: crate::manifest::ApplicationManifest = serde_json::from_str(json).unwrap();
        assert!(m.environments.is_empty());
        assert_eq!(m.promotion_sequence, 0);
        // The dead field's key is preserved verbatim rather than misread.
        assert!(m.extra.contains_key("channel"));

        let sub_json = r#"{
            "packageName": "app", "registryUrl": "file:///w", "versionPin": "^1.0",
            "resolvedVersion": "1.0.0", "resolvedAt": "2026-01-01T00:00:00Z",
            "sheets": [], "channel": "prod"
        }"#;
        let s: crate::manifest::Subscription = serde_json::from_str(sub_json).unwrap();
        assert_eq!(s.environment, None, "a stale 'channel' is NOT an environment");
        assert!(matches!(s.target().unwrap(), SubscriptionTarget::Line(_)));
    }

    /// An environment subscription stores NO pin, so a resolver that forgot the
    /// environment branch fails loudly instead of reporting "up to date".
    ///
    /// SABOTAGE: mirror the resolved version into `version_pin`. The same
    /// omission then reports no update forever — silently.
    #[test]
    fn an_environment_subscription_stores_no_pin() {
        let target = SubscriptionTarget::Environment("prod".to_string());
        assert_eq!(crate::manifest::Subscription::pin_for(&target), "");
        assert_eq!(
            crate::manifest::Subscription::environment_for(&target),
            Some("prod".to_string())
        );
        // And the empty pin is not silently parseable.
        assert!(crate::version::VersionPin::parse("").is_err());

        let line = SubscriptionTarget::Line(crate::version::VersionPin::Latest);
        assert_eq!(crate::manifest::Subscription::pin_for(&line), "latest");
        assert_eq!(crate::manifest::Subscription::environment_for(&line), None);
    }
}
