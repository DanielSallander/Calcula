//! FILENAME: core/calp/src/error.rs
//! PURPOSE: Error types for .calp operations.

use thiserror::Error;

#[derive(Error, Debug)]
pub enum CalpError {
    #[error("IO error: {0}")]
    Io(#[from] std::io::Error),

    #[error("JSON error: {0}")]
    Json(#[from] serde_json::Error),

    #[error("Application not found: {0}")]
    ApplicationNotFound(String),

    #[error("Version not found: {package} {version}")]
    VersionNotFound { package: String, version: String },

    #[error("No version satisfies constraint '{pin}' for application '{package}'")]
    NoMatchingVersion { package: String, pin: String },

    #[error("Invalid version string: {0}")]
    InvalidVersion(String),

    #[error("Invalid version pin: {0}")]
    InvalidPin(String),

    #[error("Application already exists: {0}")]
    ApplicationAlreadyExists(String),

    #[error("Version already published: {package} {version}")]
    VersionAlreadyPublished { package: String, version: String },

    #[error("Sheet not found in workbook: {0}")]
    SheetNotFound(String),

    /// Two sheets in one published version would carry the same name.
    ///
    /// A workbook cannot hold two sheets with the same name — `ensure_sheet_name_is_free`
    /// refuses it, case-insensitively — but a published VERSION could, because
    /// `VersionManifest.sheets` is a plain `Vec` keyed by nothing. A subscriber
    /// pulling such a version gets one of them renamed by
    /// `resolve_sheet_name_collisions`, and since cross-sheet formulas inside a
    /// package are stored as raw TEXT and resolved by a first-match
    /// case-insensitive name lookup, the package's own `=Sheet1!A1` would then
    /// bind to whichever sheet won the name — silently, with no `#REF!`.
    #[error("Two sheets in this version would both be called '{name}'. {detail}")]
    DuplicateSheetName { name: String, detail: String },

    /// The workspace moved between a refresh PREVIEW and its APPLY.
    ///
    /// The refresh dialog is non-modal by design, and the two halves each
    /// resolve the version pin independently — so a publisher pushing while the
    /// user decides would otherwise land a version the dialog never displayed,
    /// with the user's per-cell "take theirs" decisions applied to values they
    /// were never shown. Refusing is the only honest answer; pulling the stale
    /// previewed version instead would be the same lie pointed the other way.
    #[error("{0}")]
    RefreshMoved(String),

    #[error("Workspace error: {0}")]
    Workspace(String),

    #[error("Format error: {0}")]
    Format(String),

    // -- Application integrity (S5 phase 1: SHA-256 artifact checksums) --------
    // Phase 2 adds manifest signature variants (Ed25519 + TOFU pinning),
    // e.g. ManifestSignatureInvalid / PublisherKeyChanged. See integrity.rs.

    #[error("Integrity check failed: {file} in {package}@{version} does not match its published checksum")]
    ChecksumMismatch { package: String, version: String, file: String },

    #[error("Integrity check failed: {file} in {package}@{version} is listed in the manifest but missing from the workspace")]
    MissingArtifact { package: String, version: String, file: String },

    #[error("Integrity check failed: {file} in {package}@{version} is not listed in the published checksums (file added after publish?)")]
    UnlistedArtifact { package: String, version: String, file: String },

    #[error("Application {package}@{version} was published without integrity checksums — republish it")]
    MissingChecksums { package: String, version: String },

    // -- Publisher signing (S5 phase 2: Ed25519 manifest signature + TOFU) --

    #[error("Application {package}@{version} is not signed (missing manifest signature or publisher key) — republish it with a signing-capable publisher")]
    MissingSignature { package: String, version: String },

    #[error("Integrity check failed: the manifest signature for {package}@{version} is invalid (manifest tampered or signed by a different key)")]
    ManifestSignatureInvalid { package: String, version: String },

    #[error("Publisher key for application {package}@{version} changed since first use: pinned {pinned} but this version is signed by {got} — refusing to trust (possible application hijack)")]
    PublisherKeyChanged { package: String, version: String, pinned: String, got: String },

    #[error("Application {package}@{version} is signed by {got}, but nobody on this computer has ever agreed to trust that publisher for '{package}' from {scope}. Subscribe to it (Distribution > Subscribe to Application) to review the publisher and trust it — a signature alone is not trust.")]
    PublisherNotPinned { package: String, version: String, scope: String, got: String },

    #[error("The application name '{package}' is already trusted on this computer from a DIFFERENT workspace: {other_scope} is pinned to publisher {pinned}, but {scope} is offering {package}@{version} signed by {got}. Two workspaces claiming one name is exactly what an application hijack looks like. Review both publishers before accepting this one.")]
    PublisherNameConflict {
        package: String,
        version: String,
        /// The workspace being contacted now, in the USER'S spelling.
        scope: String,
        /// The workspace that already holds a pin for this name, in the user's
        /// spelling.
        other_scope: String,
        /// The key pinned for the other workspace.
        pinned: String,
        /// The key this workspace is offering.
        got: String,
    },

    // -- Compatibility contract --------------------------------------------

    #[error("This application needs a newer version of Calcula: {package}@{version} requires app v{required} but this app is v{current}. Please update Calcula.")]
    AppTooOld { package: String, version: String, required: String, current: String },

    // -- Push gates (workspace collaboration) -------------------------------
    // These messages ARE the user-facing copy: the command layer renders
    // CalpError with Display and adds nothing. Write them for the developer
    // who just hit the gate, not for a log file.

    #[error("Cannot push {package}: you started from v{expected_base}, but the workspace is now at v{actual_latest} (published by {latest_published_by}). Open the latest version, re-apply your changes, and push again.")]
    BaseVersionStale {
        package: String,
        expected_base: String,
        actual_latest: String,
        latest_published_by: String,
    },

    #[error("'{package}' is published by {holder_name} (key {holder_key}). This computer holds a different publisher key, and pushing would break every subscriber's trust pin. Ask {holder_name} to push this change.")]
    NotThePublisher { package: String, holder_name: String, holder_key: String },

    #[error("A change summary is required to push {package}: say what changed, in a sentence or two. Subscribers and co-developers read it in the version history.")]
    MissingChangeSummary { package: String },

    #[error("Cannot push {package} as v{version}: the workspace already has v{latest}, and each version must be higher than the one before it. Use v{suggested} or higher.")]
    VersionNotGreater { package: String, version: String, latest: String, suggested: String },

    #[error("Another publish to this workspace is in progress — try again in a minute. (Workspace: {workspace})")]
    WorkspaceBusy { workspace: String },

    // -- Co-publishing (delegation) -----------------------------------------

    #[error("The list of who may publish '{package}' cannot be trusted: {reason}. Until that is resolved, only the publisher who created the package can push to it.")]
    PublisherListInvalid { package: String, reason: String },

    #[error("'{package}' does not list this computer's publisher key among those allowed to publish it. Ask {root_holder} — the publisher who created the package — to add you as a co-publisher, or to push this change for you.")]
    NotAuthorizedPublisher { package: String, root_holder: String },

    // -- Environments (the promotion pipeline) ------------------------------
    // Same rule as the push gates above: these strings ARE the user-facing
    // copy. An environment is a named pointer to one version on the
    // development line; promoting moves the pointer and copies nothing.

    #[error("'{package}' has no environment called '{environment}'. It has: {available}.")]
    EnvironmentNotFound { package: String, environment: String, available: String },

    #[error("'{package}' has an environment called '{environment}', but nothing has been promoted into it yet. Ask whoever publishes it to promote a version, or follow the development line instead.")]
    EnvironmentEmpty { package: String, environment: String },

    #[error("'{name}' cannot be an environment name: {reason}")]
    InvalidEnvironmentName { name: String, reason: String },

    #[error("This computer's publisher key is not allowed to promote '{package}'. Ask {root_holder} — the publisher who created the application — to add you as a co-publisher, or to promote it for you.")]
    NotAuthorizedToPromote { package: String, root_holder: String },

    #[error("Cannot move {package} '{environment}' to v{version}: an environment can only move to {allowed}.")]
    PromotionNotLinear { package: String, environment: String, version: String, allowed: String },

    #[error("'{package}' '{environment}' is already at v{version}.")]
    EnvironmentAlreadyAt { package: String, environment: String, version: String },

    #[error("'{package}' '{environment}' moved while you were deciding: it was at {shown} when you were shown it, and is at {actual} now. Re-open the promotion so you can see what you are actually promoting over.")]
    PromotionStale { package: String, environment: String, shown: String, actual: String },

    #[error("The promotion history of '{package}' cannot be trusted: {reason}. Its environments are unavailable until the publisher repairs it.")]
    PromotionLogInvalid { package: String, reason: String },
}
