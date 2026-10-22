//! FILENAME: app/src-tauri/src/calp_collection.rs
//! PURPOSE: Which published application COLLECTS a writeback region's answers,
//! for the publisher's side of writeback: Collected Responses, its exports, its
//! review buttons, the Parquet rollup switch, the respondent roster, the
//! submission watch, scripts and the author's BI writeback tables -- and WHICH
//! STREAMS of it they collect (Writeback > Collect From).
//! CONTEXT: Every one of those used to find a region through the workbook's
//! SUBSCRIPTIONS (`owning_subscription_for_region`), so it only worked for a
//! publisher who ALSO subscribed to their own application from the same
//! workbook. The author's own designated regions (`writeback_draft_regions`)
//! are never subscriptions -- a working copy may not even subscribe to its own
//! application -- so the owner designated B3:B5, published, collected answers,
//! opened Collected Responses and read "No writeback regions in this workbook."
//! (BUG-0553, 2026-10-21).
//!
//! # How an author's region reaches its application
//!
//! A workbook that published (the first publish of a standalone workbook) or
//! that was opened for editing (checkout) carries a `WorkingCopyLink`: the
//! workspace and the application. The region ids survive both routes: a
//! publish ships the draft ids, and checkout restores the manifest's regions as
//! drafts with the same ids. So the author's region is read from the NEWEST
//! version of the linked application whose signed manifest declares that id --
//! the head, not the link's base, because a co-publisher's later push moves
//! subscribers onto a newer version and carry-forward only ever looks DOWN.
//!
//! A region the working copy NO LONGER designates (Writeback > Remove Region,
//! or a push without it) is still collected by every published version that
//! declares it -- a `prod` pointing at an older version keeps receiving
//! answers. Such a region is still listed and still reviewable, resolved from
//! the declaration instead of the draft, with a note saying so.
//!
//! # Which trust question an author asks
//!
//! NOT the subscriber's TOFU pin. A pin is a subscriber's standing decision to
//! accept updates from a key and only Subscribe/Install may write one, so an
//! author who never subscribed to their own application has none, and
//! `load_pinned_manifest_via` would refuse them their own answers. The author
//! asks the DEVELOPER door's question instead -- the version is signed by an
//! authorised publisher of the application, anchored at its root and checked
//! against this computer's developer anchor without recording one
//! (`calp_inspector::open_authorized_content`, the reader the push merge and
//! the hold-back use) -- and then the publisher gate every dashboard command
//! already runs, against the key THAT VERIFIED MANIFEST asserts
//! (`require_publisher_key`), never one re-read from the share.
//!
//! WHICH version to verify is chosen from each version's UNSIGNED manifest
//! (cheap, and trusted for nothing): only the chosen candidate is verified, so
//! a draft no version declares no longer costs one signature verification per
//! version on every listing and every submission-watch pass. A candidate that
//! fails verification is never skipped in silence: the next older one is used
//! and the row says which newer version's answers could not be verified, or,
//! when none verifies, the row is `unreachable` with the reason.
//!
//! # One decision, one place
//!
//! The listing behind the pane and the submission watch, and every command
//! the pane calls, decide through the SAME functions here
//! ([`AuthorWalk::resolve`], [`authorize`]) and get a TYPED refusal
//! ([`CollectionRefusal`]), so the pane can never call a region ready that the
//! commands then refuse, or give a different sentence for it.
//!
//! # Streams (Writeback > Collect From, owner decision 2026-10-22)
//!
//! A SUBSCRIBER-role region reads the one stream its subscription follows,
//! exactly as before. An AUTHOR-role region reads the streams the workbook's
//! Collect From choice names (`WorkingCopyLink::collect_streams`), ONE choice
//! per application:
//!
//! * no choice (the default): the LAST environment of the pipeline -- `prod`,
//!   as a rule -- or every stream when the application has no environments
//!   (which is then just the development line, as before);
//! * "All streams": every stream, including environments defined later;
//! * a set: exactly those streams; an environment defined later is listed
//!   unticked and NOT collected until somebody ticks it.
//!
//! Every publisher read -- [`RegionCollection::filter`] -- refuses a stream the
//! choice does not admit, so no IPC path, script or export reads an author
//! region outside it. Which VERSIONS each read folds is [`collected_versions`]:
//! the streams' own carry-forward (an environment's held versions, never the
//! semver rule), then the carry-forward COMPATIBILITY rule GATHER uses
//! (`carries_forward_from`, BUG-0555).

use std::collections::{BTreeMap, BTreeSet, HashMap, HashSet};

use calp::manifest::VersionManifest;
use calp::writeback::StreamFilter;
use calp::CollectStreams;

use crate::calp_commands::{
    calcula_profile_dir, carries_forward_from, carry_forward_versions, older_package_versions,
    owning_subscription_for_region, require_publisher_key, writeback_region_entries,
    OwningSubscription, PublisherGateRefusal,
};
use crate::AppState;

/// Whose region it is, from this workbook's point of view.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub enum CollectionRole {
    /// One of this workbook's OWN designated regions (or one it designated
    /// before and a published version still declares), collected by the
    /// application the workbook published or was opened for editing from.
    Author,
    /// A region of an application this workbook SUBSCRIBES to (a publisher
    /// reviewing from a subscriber workbook).
    Subscriber,
}

/// Where a region's answers are collected, resolved once per command.
#[derive(Debug, Clone)]
pub(crate) struct RegionCollection {
    pub package_name: String,
    /// The workspace as the user spelled it (the pin/anchor scope source).
    pub registry_path: String,
    /// The version the region is read from: for an author, the newest version
    /// whose VERIFIED manifest declares the region; for a subscriber, the
    /// version the subscription resolved.
    pub read_version: String,
    /// The streams every read of this region admits: an author's Collect From
    /// choice (resolved: the default is the pipeline's last environment), a
    /// subscriber's one stream.
    pub streams: StreamFilter,
    pub role: CollectionRole,
    /// The publisher key the manifest of `read_version` asserts, as VERIFIED
    /// when the region was resolved (the developer door for an author, the
    /// pin for a subscriber). The publisher gate checks possession of exactly
    /// this key.
    pub publisher_key: String,
    /// The region as that same verified manifest declares it: what an older
    /// version's answers must still be compatible with to be carried forward.
    pub declaration: calp::WritebackRegionDeclaration,
    /// WHICH ANSWERS COUNT: the application's identity rule from that same
    /// verified manifest (`VersionManifest::identity_policy`; absent = count
    /// every answer). Every counting read of this region applies it after the
    /// reader's verdicts are attached (`calp::identity_check::admit`).
    pub identity_policy: calp::IdentityPolicy,
    /// A caveat on a readable region, empty when there is none: newer versions
    /// that declare the region but could not be verified on this computer
    /// (their answers are not read), or that the workbook no longer designates
    /// the region.
    pub note: String,
    /// EACH ENVIRONMENT STREAM'S OWN BASE (author role): environment name -> the
    /// OLDER version it points at, when that is not `read_version`. With the
    /// development line ahead of prod, prod's answers are stored under prod's
    /// version and must be judged against THAT version's declaration of the
    /// region -- exactly as a prod subscriber's GATHER judges them -- not the
    /// unpromoted head's (BUG: a head that moved the region or made it Strict
    /// dropped every prod answer from the default view). A stream absent here
    /// is read from `read_version`, as before. Empty for a subscriber, whose
    /// one stream IS its resolved version.
    pub stream_bases: BTreeMap<String, String>,
}

impl RegionCollection {
    /// WHOSE REVIEW DECISIONS COUNT when this region is read (identity phase
    /// 1): the VERIFIED `publisher_key` and its root-signed co-publishers. For a
    /// subscriber the co-publisher list is checked against this computer's PIN;
    /// for the author against the root this computer's DEVELOPER ANCHOR
    /// remembers for the application (the guard a share-writer cannot forge
    /// against a planted first version, docs/design/calp-workspace-collaboration.md
    /// §2.5) -- never the unsigned version list, which a share-writer can extend
    /// with a planted `0.0.1` naming their own key. With no anchor yet (the
    /// first-contact window the developer door already has) the first version
    /// read through the workspace decides.
    pub(crate) fn review_authority(&self, registry: &dyn calp::WorkspaceTransport) -> calp::ReviewAuthority {
        // The pin (subscriber) or the developer anchor (author) for THIS
        // workspace: `calp_commands::review_authority` looks for both.
        let scope = calp::workspace_scope(&self.registry_path).ok();
        crate::calp_commands::review_authority(registry, &self.package_name, &self.publisher_key, scope.as_ref())
    }

    /// The filter a command reads: the collection's own, narrowed to
    /// `requested` when one stream is named (a review passes the ROW's
    /// stream). A requested stream the collection does not admit is REFUSED --
    /// no IPC path reads a region outside what this workbook collects.
    pub(crate) fn filter(&self, requested: Option<&str>) -> Result<StreamFilter, String> {
        match requested {
            None => Ok(self.streams.clone()),
            Some(stream) if self.streams.admits(stream) => Ok(StreamFilter::one(stream)),
            Some(stream) => Err(not_collected_text(stream, &self.streams, self.role)),
        }
    }

    /// The region declarations of an OLDER `version`, from that version's
    /// VERIFIED manifest, asking the trust question this role asks (the
    /// developer door for an author, the pin for a subscriber).
    pub(crate) fn verified_regions_of(
        &self,
        registry: &dyn calp::WorkspaceTransport,
        version: &str,
    ) -> Result<Vec<calp::WritebackRegionDeclaration>, String> {
        match self.role {
            CollectionRole::Author => crate::calp_inspector::open_authorized_content(
                &self.registry_path,
                &self.package_name,
                &format!("={version}"),
                false,
                None,
            )
            .map(|(_registry, _resolved, manifest)| manifest.writeback_regions.unwrap_or_default()),
            CollectionRole::Subscriber => {
                let scope = calp::workspace_scope(&self.registry_path).map_err(|e| e.to_string())?;
                calp::integrity::load_pinned_manifest_via(
                    registry,
                    &self.package_name,
                    version,
                    &scope,
                    &calcula_profile_dir(),
                )
                .map(|manifest| manifest.writeback_regions.unwrap_or_default())
                .map_err(|e| e.to_string())
            }
        }
    }
}

/// The refusal for a stream a region's reads do not admit.
fn not_collected_text(stream: &str, streams: &StreamFilter, role: CollectionRole) -> String {
    let named = calp::writeback::stream_label(stream);
    match role {
        CollectionRole::Author => format!(
            "{named} is not one of the streams this workbook collects ({}). Change it in Writeback > \
             Collect From.",
            streams.label()
        ),
        CollectionRole::Subscriber => format!(
            "{named} is not this workbook's stream: a subscribed region shows the stream its \
             subscription follows ({}).",
            streams.label()
        ),
    }
}

/// The text for a designated region of a workbook that is not linked to any
/// published application. Also the `detail` of a `notPublished` row.
pub(crate) const NOT_PUBLISHED_TEXT: &str =
    "This workbook has not published an application yet, so nothing has been collected for this \
     region. Publish it (Collaboration > Publish Application) to start collecting responses, or \
     open the published application for editing (Collaboration > Open Application for Editing).";

/// A designated region the linked application does not declare in any version.
pub(crate) fn not_in_pushed_version_text(range: &str, package: &str, head: Option<&str>) -> String {
    match head {
        Some(head) => format!(
            "{range} was designated after the last push of '{package}' (v{head}). Push the \
             application to start collecting responses for it; nothing has been collected yet."
        ),
        None => format!(
            "'{package}' has no published version that declares {range}. Push the application to \
             start collecting responses for it; nothing has been collected yet."
        ),
    }
}

/// The note on a region this workbook no longer designates.
fn removed_region_text(range: &str, package: &str, version: &str) -> String {
    format!(
        "{range} is no longer designated in this workbook, but v{version} of '{package}' still \
         declares it, so answers sent to it are still collected and listed here."
    )
}

/// The note on a readable region when newer versions that declare it could
/// not be verified on this computer.
fn unverified_newer_text(skipped: &[String]) -> String {
    format!(
        "Answers sent to a newer version could not be verified on this computer and are not \
         shown: {}",
        skipped.join("; ")
    )
}

/// The refusal when the default (the last environment) cannot be decided.
fn default_unreadable_text(package: &str, error: &str) -> String {
    format!(
        "Could not find the last environment of '{package}', which is what this workbook collects \
         by default: {error}. Choose the streams to collect in Writeback > Collect From."
    )
}

/// "B3:B5" for a declaration's selector.
fn range_a1(d: &calp::WritebackRegionDeclaration) -> String {
    let tl = calcula_format::cell_ref::to_a1(d.selector.row_start, d.selector.col_start);
    let br = calcula_format::cell_ref::to_a1(d.selector.row_end, d.selector.col_end);
    if tl == br {
        tl
    } else {
        format!("{tl}:{br}")
    }
}

/// THE DEFAULT, decided by the owner (2026-10-22): the LAST environment of the
/// pipeline -- what production subscribers follow, as a rule -- and every
/// stream when the application has no environments (only the development line
/// can then hold answers, which is what was collected before). Test answers
/// never reach a production model table merely because nobody chose.
///
/// FAIL CLOSED like the subscriber side (`resolve_environment`): when the
/// pipeline's latest change was signed by a key the application does not
/// authorise, EVERY entry is marked `unauthorized_pointer` and there is no
/// default to follow -- a share-writer appending a self-signed Pipeline record
/// must not retarget the publisher's inbox, roster and model tables. Otherwise
/// the last environment whose pointer is authorised.
pub(crate) fn default_filter(environments: &[calp::environments::Environment]) -> Result<StreamFilter, String> {
    Ok(match default_environment(environments)? {
        Some(name) => StreamFilter::one(&name),
        None => StreamFilter::All,
    })
}

/// The default stream's name (see [`default_filter`]); `Ok(None)` = no
/// environments (every stream). THE ONE HELPER the reads, the summary and the
/// Collect From view share.
pub(crate) fn default_environment(environments: &[calp::environments::Environment]) -> Result<Option<String>, String> {
    if environments.is_empty() {
        return Ok(None);
    }
    match environments.iter().rev().find(|e| !e.unauthorized_pointer) {
        Some(env) => Ok(Some(env.name.clone())),
        None => Err(
            "the pipeline's latest change was signed by a key this application does not authorise, so \
             there is no environment to follow by default"
                .to_string(),
        ),
    }
}

/// The filter a stored choice resolves to, given the pipeline (read only when
/// the default needs it).
pub(crate) fn resolve_choice(
    choice: Option<&CollectStreams>,
    environments: impl FnOnce() -> Result<Vec<calp::environments::Environment>, String>,
) -> Result<StreamFilter, String> {
    match choice {
        Some(CollectStreams::All) => Ok(StreamFilter::All),
        Some(CollectStreams::Only(set)) => Ok(StreamFilter::Only(set.clone())),
        None => environments().and_then(|envs| default_filter(&envs)),
    }
}

// ============================================================================
// The typed refusal
// ============================================================================

/// Why a region's answers cannot be read here. One value carries both the
/// listing's status and the sentence every command returns, so the two can
/// never disagree.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum CollectionRefusal {
    /// A designated region of a workbook not linked to an application.
    NotPublished,
    /// The linked application declares the region in no version yet.
    NotInPushedVersion(String),
    /// Resolved, but this computer holds no key that may read the answers.
    NotPublisher(String),
    /// The workspace or a version could not be read or was refused.
    Unreachable(String),
}

impl CollectionRefusal {
    pub(crate) fn status(&self) -> CollectionStatus {
        match self {
            CollectionRefusal::NotPublished => CollectionStatus::NotPublished,
            CollectionRefusal::NotInPushedVersion(_) => CollectionStatus::NotInPushedVersion,
            CollectionRefusal::NotPublisher(_) => CollectionStatus::NotPublisher,
            CollectionRefusal::Unreachable(_) => CollectionStatus::Unreachable,
        }
    }

    pub(crate) fn detail(&self) -> String {
        match self {
            CollectionRefusal::NotPublished => NOT_PUBLISHED_TEXT.to_string(),
            CollectionRefusal::NotInPushedVersion(m)
            | CollectionRefusal::NotPublisher(m)
            | CollectionRefusal::Unreachable(m) => m.clone(),
        }
    }
}

impl From<CollectionRefusal> for String {
    fn from(refusal: CollectionRefusal) -> String {
        refusal.detail()
    }
}

impl From<PublisherGateRefusal> for CollectionRefusal {
    fn from(refusal: PublisherGateRefusal) -> CollectionRefusal {
        match refusal {
            PublisherGateRefusal::NotPublisher(m) => CollectionRefusal::NotPublisher(m),
            PublisherGateRefusal::Failed(m) => CollectionRefusal::Unreachable(m),
        }
    }
}

// ============================================================================
// The author's walk over the linked application
// ============================================================================

/// One workspace open over the linked application, read lazily and cached:
/// each version's UNSIGNED declarations (to choose a candidate, trusted for
/// nothing), each verified manifest (only for the candidates chosen) and the
/// pipeline (only when the default stream choice needs it).
pub(crate) struct AuthorWalk {
    link: calp::WorkingCopyLink,
    registry: Option<Box<dyn calp::WorkspaceTransport>>,
    /// Why the workspace or the application could not be read at all.
    workspace_error: Option<String>,
    /// The application's versions, newest first.
    versions: Vec<String>,
    /// version -> what its unsigned manifest declares (`Err` = unreadable).
    listed: HashMap<String, Result<Vec<calp::WritebackRegionDeclaration>, String>>,
    /// version -> its manifest through the developer door, or the refusal.
    verified: HashMap<String, Result<VersionManifest, String>>,
    /// The application's environments in pipeline order, read once.
    environments: Option<Result<Vec<calp::environments::Environment>, String>>,
    /// Every stream tag the answers carry, read once ([`Self::stream_tags_in_records`]).
    stream_tags: Option<BTreeSet<String>>,
}

impl AuthorWalk {
    /// Open the linked workspace ONCE and read the application's version list.
    pub(crate) fn open(link: &calp::WorkingCopyLink) -> AuthorWalk {
        let mut walk = AuthorWalk {
            link: link.clone(),
            registry: None,
            workspace_error: None,
            versions: Vec::new(),
            listed: HashMap::new(),
            verified: HashMap::new(),
            environments: None,
            stream_tags: None,
        };
        match crate::calp_registry::open_workspace_scoped(&link.registry_url) {
            Ok((registry, _scope)) => {
                match registry.get_application_manifest(&link.package_name) {
                    Ok(app) => {
                        let mut v = app.parsed_versions();
                        v.sort();
                        v.reverse();
                        walk.versions = v.into_iter().map(|v| v.to_string()).collect();
                    }
                    Err(e) => {
                        walk.workspace_error = Some(format!(
                            "Could not read '{}' in the workspace {}: {}",
                            link.package_name, link.registry_url, e
                        ))
                    }
                }
                walk.registry = Some(registry);
            }
            Err(e) => {
                walk.workspace_error = Some(format!(
                    "Could not read '{}' in the workspace {}: {}",
                    link.package_name, link.registry_url, e
                ))
            }
        }
        walk
    }

    /// The opened workspace (for the gate and the environments), if it opened.
    pub(crate) fn registry(&self) -> Option<&dyn calp::WorkspaceTransport> {
        self.registry.as_deref()
    }

    /// The application's newest version.
    pub(crate) fn head(&self) -> Option<&str> {
        self.versions.first().map(|v| v.as_str())
    }

    /// The link this walk reads.
    pub(crate) fn link(&self) -> &calp::WorkingCopyLink {
        &self.link
    }

    /// The application's environments in PIPELINE ORDER, read once per walk
    /// on the publisher's anchor (`PromotionTrust::Workspace`: an author acting
    /// on an application they can write, after the publisher gate).
    pub(crate) fn environments(&mut self) -> Result<Vec<calp::environments::Environment>, String> {
        if self.environments.is_none() {
            let read = match self.registry.as_deref() {
                Some(registry) => calp::environments::environments_via(
                    registry,
                    &self.link.package_name,
                    calp::environments::PromotionTrust::Workspace,
                )
                .map_err(|e| e.to_string()),
                None => Err(self.workspace_error.clone().unwrap_or_default()),
            };
            self.environments = Some(read);
        }
        self.environments.clone().expect("just read")
    }

    /// The streams this workbook's author regions collect: the Collect From
    /// choice, or the default (the last environment). Refused, by name, when
    /// the default is asked for and the pipeline cannot be read -- never a
    /// silent fall back to every stream.
    pub(crate) fn collect_filter(&mut self) -> Result<StreamFilter, CollectionRefusal> {
        let choice = self.link.collect_choice();
        let package = self.link.package_name.clone();
        resolve_choice(choice.as_ref(), || self.environments())
            .map_err(|e| CollectionRefusal::Unreachable(default_unreadable_text(&package, &e)))
    }

    /// What `version`'s UNSIGNED manifest declares. Trusted for nothing: it
    /// only decides which version is worth verifying.
    fn listed(&mut self, version: &str) -> &Result<Vec<calp::WritebackRegionDeclaration>, String> {
        if !self.listed.contains_key(version) {
            let read = match self.registry.as_deref() {
                Some(registry) => registry
                    .get_version_manifest(&self.link.package_name, version)
                    .map(|m| m.writeback_regions.unwrap_or_default())
                    .map_err(|e| e.to_string()),
                None => Err(self.workspace_error.clone().unwrap_or_default()),
            };
            self.listed.insert(version.to_string(), read);
        }
        &self.listed[version]
    }

    /// `version` through the developer door, verified once per walk.
    fn verify(&mut self, version: &str) -> &Result<VersionManifest, String> {
        if !self.verified.contains_key(version) {
            let read = crate::calp_inspector::open_authorized_content(
                &self.link.registry_url,
                &self.link.package_name,
                &format!("={version}"),
                false,
                None,
            )
            .map(|(_registry, _resolved, manifest)| manifest);
            self.verified.insert(version.to_string(), read);
        }
        &self.verified[version]
    }

    /// The publisher key of the NEWEST version that verifies through the
    /// developer door, region or no region -- the key the Collect From setter
    /// gates on. A version that does not verify is never trusted for it.
    pub(crate) fn newest_verified_publisher_key(&mut self) -> Result<String, CollectionRefusal> {
        if let Some(e) = &self.workspace_error {
            return Err(CollectionRefusal::Unreachable(e.clone()));
        }
        let mut skipped: Vec<String> = Vec::new();
        for version in self.versions.clone() {
            match self.verify(&version) {
                Ok(manifest) => return Ok(manifest.publisher_key.clone()),
                Err(e) => skipped.push(format!("v{version}: {e}")),
            }
        }
        Err(CollectionRefusal::Unreachable(if skipped.is_empty() {
            format!(
                "'{}' has no published version in the workspace {}.",
                self.link.package_name, self.link.registry_url
            )
        } else {
            format!(
                "No version of '{}' could be verified on this computer: {}",
                self.link.package_name,
                skipped.join("; ")
            )
        }))
    }

    /// Every stream TAG any answer to this application carries, in any version
    /// -- so an environment that has left the pipeline but still holds answers
    /// stays choosable instead of being dropped in silence the first time
    /// somebody narrows "All streams". Tags are not trusted for anything but
    /// being offered: ticking one is the publisher's own act. Read ONCE per
    /// walk (every version's answers are loaded and checked).
    pub(crate) fn stream_tags_in_records(&mut self) -> &BTreeSet<String> {
        if self.stream_tags.is_none() {
            let mut tags = BTreeSet::new();
            if let Some(registry) = self.registry.as_deref() {
                for version in &self.versions {
                    // Tags only: whose decisions count does not matter here, so
                    // no review authority is needed.
                    if let Ok(subs) = registry.load_current_submissions(
                        &self.link.package_name,
                        version,
                        &calp::ReviewAuthority::none(),
                    ) {
                        tags.extend(subs.into_iter().map(|s| s.environment));
                    }
                }
            }
            self.stream_tags = Some(tags);
        }
        self.stream_tags.as_ref().expect("just read")
    }

    /// Point the walk at `link` (the same application, its choice just
    /// changed), keeping everything already read.
    pub(crate) fn relink(&mut self, link: calp::WorkingCopyLink) {
        self.link = link;
    }

    /// Every region id some version's unsigned manifest declares, with the
    /// NEWEST declaration of it -- for listing the regions this workbook no
    /// longer designates. Each is still verified before it is read.
    pub(crate) fn declared_regions(&mut self) -> Vec<calp::WritebackRegionDeclaration> {
        let mut seen: HashSet<String> = HashSet::new();
        let mut out = Vec::new();
        for version in self.versions.clone() {
            if let Ok(declared) = self.listed(&version) {
                for d in declared.clone() {
                    if seen.insert(d.id.clone()) {
                        out.push(d);
                    }
                }
            }
        }
        out
    }

    /// THE AUTHOR'S RESOLUTION, used by the listing and by every command: the
    /// newest version whose VERIFIED manifest declares `region_id`, read
    /// through the workbook's Collect From choice.
    ///
    /// Candidates come from the unsigned listing; a version whose listing
    /// cannot be read is a candidate too (verification decides). A candidate
    /// that fails verification is recorded, never skipped in silence: when an
    /// older one verifies, the collection's note names the newer versions whose
    /// answers are not shown; when none does, the refusal is `Unreachable` with
    /// every reason.
    ///
    /// `range` is the A1 text of the region (for the push-first sentence);
    /// `designated` is false for a region this workbook no longer designates.
    pub(crate) fn resolve(
        &mut self,
        region_id: &str,
        range: &str,
        designated: bool,
    ) -> Result<RegionCollection, CollectionRefusal> {
        if let Some(e) = &self.workspace_error {
            return Err(CollectionRefusal::Unreachable(e.clone()));
        }
        let mut skipped: Vec<String> = Vec::new();
        let mut found: Option<(String, String, calp::WritebackRegionDeclaration, calp::IdentityPolicy)> = None;
        for version in self.versions.clone() {
            let candidate = match self.listed(&version) {
                Ok(declared) => declared.iter().any(|d| d.id == region_id),
                Err(_) => true,
            };
            if !candidate {
                continue;
            }
            match self.verify(&version) {
                Ok(manifest) => {
                    // The unsigned listing said otherwise (or could not be
                    // read): the verified manifest decides.
                    let Some(declaration) = manifest
                        .writeback_regions
                        .as_ref()
                        .and_then(|r| r.iter().find(|d| d.id == region_id))
                        .cloned()
                    else {
                        continue;
                    };
                    found = Some((
                        version,
                        manifest.publisher_key.clone(),
                        declaration,
                        manifest.identity_policy.unwrap_or_default(),
                    ));
                    break;
                }
                Err(e) => skipped.push(format!("v{version}: {e}")),
            }
        }
        let Some((version, publisher_key, declaration, identity_policy)) = found else {
            return Err(if skipped.is_empty() {
                CollectionRefusal::NotInPushedVersion(not_in_pushed_version_text(
                    range,
                    &self.link.package_name,
                    self.head(),
                ))
            } else {
                CollectionRefusal::Unreachable(format!(
                    "No version of '{}' that may declare {} could be verified on this computer: {}",
                    self.link.package_name,
                    range,
                    skipped.join("; ")
                ))
            });
        };
        let streams = self.collect_filter()?;
        let stream_bases = self.stream_bases(&streams, &version);
        let mut notes: Vec<String> = Vec::new();
        if !designated {
            notes.push(removed_region_text(range, &self.link.package_name, &version));
        }
        if !skipped.is_empty() {
            notes.push(unverified_newer_text(&skipped));
        }
        Ok(RegionCollection {
            package_name: self.link.package_name.clone(),
            registry_path: self.link.registry_url.clone(),
            read_version: version,
            streams,
            role: CollectionRole::Author,
            publisher_key,
            declaration,
            identity_policy,
            note: notes.join(" "),
            stream_bases,
        })
    }

    /// Each collected ENVIRONMENT stream whose authorised pointer names a
    /// version OLDER than `read_version` (the development line ahead of it):
    /// that stream is judged against its own version
    /// ([`RegionCollection::stream_bases`]). A pointer at or above
    /// `read_version` (above: a version that does not declare the region or
    /// did not verify) keeps `read_version`, as before. A pipeline that cannot
    /// be read keeps `read_version` for every stream.
    fn stream_bases(&mut self, streams: &StreamFilter, read_version: &str) -> BTreeMap<String, String> {
        let mut bases = BTreeMap::new();
        let StreamFilter::Only(set) = streams else {
            return bases;
        };
        if set.iter().all(|s| s.is_empty()) {
            return bases;
        }
        let Ok(envs) = self.environments() else {
            return bases;
        };
        let Ok(read) = calp::SemVer::parse(read_version) else {
            return bases;
        };
        for env in envs {
            if !set.contains(&env.name) || env.unauthorized_pointer {
                continue;
            }
            let Some(pointer) = env.version.as_deref() else { continue };
            if matches!(calp::SemVer::parse(pointer), Ok(v) if v < read) {
                bases.insert(env.name.clone(), pointer.to_string());
            }
        }
        bases
    }
}

// ============================================================================
// The resolver and the gate
// ============================================================================

/// The designated region `region_id` of this workbook, or `None` when it is not
/// one of the workbook's own.
fn own_designation(
    state: &AppState,
    region_id: &str,
) -> Result<Option<calp::WritebackRegionDeclaration>, String> {
    let drafts = state.writeback_draft_regions.read().map_err(|e| e.to_string())?;
    Ok(drafts.iter().find(|d| d.id == region_id).cloned())
}

/// The subscriber-role collection of an owning subscription.
fn subscriber_collection(owner: OwningSubscription) -> RegionCollection {
    let OwningSubscription {
        package_name,
        resolved_version,
        registry_path,
        environment,
        publisher_key,
        declaration,
        identity_policy,
    } = owner;
    RegionCollection {
        package_name,
        registry_path,
        read_version: resolved_version,
        // A subscribed region reads the ONE stream its subscription follows:
        // that is what a GATHER on these sheets computes.
        streams: StreamFilter::one(&environment),
        role: CollectionRole::Subscriber,
        publisher_key,
        declaration,
        identity_policy,
        note: String::new(),
        stream_bases: BTreeMap::new(),
    }
}

/// THE ONE RESOLVER every publisher-side writeback command goes through, with
/// a TYPED refusal.
///
/// 1. One of this workbook's OWN designated regions -> the AUTHOR role: the
///    linked application, read from the newest version that declares it
///    ([`AuthorWalk::resolve`]). Refused, with a sentence that says what to do,
///    when the workbook is not linked or the application does not declare it.
/// 2. Otherwise the SUBSCRIBER role, exactly as before
///    (`owning_subscription_for_region`).
/// 3. Otherwise, in a linked workbook, a region the working copy NO LONGER
///    designates that a published version still declares: the AUTHOR role
///    through the declaration (Writeback > Remove Region must not hide the
///    answers a `prod` on an older version is still collecting).
///
/// The subscriber-only callers -- submit, the lifecycle check, the layer, the
/// preview -- keep calling `owning_subscription_for_region`; a submission is
/// always a subscriber's act.
pub(crate) fn resolve_collection(
    state: &AppState,
    region_id: &str,
) -> Result<RegionCollection, CollectionRefusal> {
    let link = state
        .working_copy_link
        .read()
        .map_err(|e| CollectionRefusal::Unreachable(e.to_string()))?
        .clone();
    if let Some(designation) =
        own_designation(state, region_id).map_err(CollectionRefusal::Unreachable)?
    {
        let link = link.ok_or(CollectionRefusal::NotPublished)?;
        return AuthorWalk::open(&link).resolve(region_id, &range_a1(&designation), true);
    }
    match owning_subscription_for_region(state, region_id) {
        Ok(owner) => Ok(subscriber_collection(owner)),
        Err(subscriber_error) => {
            if let Some(link) = link {
                let mut walk = AuthorWalk::open(&link);
                if let Some(e) = walk.workspace_error.clone() {
                    return Err(CollectionRefusal::Unreachable(e));
                }
                if let Some(declared) = walk.declared_regions().into_iter().find(|d| d.id == region_id) {
                    return walk.resolve(region_id, &range_a1(&declared), false);
                }
            }
            Err(CollectionRefusal::Unreachable(subscriber_error))
        }
    }
}

/// [`resolve_collection`] with the refusal as its sentence.
pub(crate) fn collection_for_region(
    state: &AppState,
    region_id: &str,
) -> Result<RegionCollection, String> {
    resolve_collection(state, region_id).map_err(String::from)
}

/// THE PUBLISHER GATE for a resolved collection: possession of the key its
/// VERIFIED manifest asserts (or a co-publisher key on the root-signed list).
pub(crate) fn authorize(
    registry: &dyn calp::WorkspaceTransport,
    collection: &RegionCollection,
) -> Result<(), CollectionRefusal> {
    let scope = calp::workspace_scope(&collection.registry_path).ok();
    require_publisher_key(registry, &collection.package_name, &collection.publisher_key, scope.as_ref())
        .map_err(CollectionRefusal::from)
}

/// [`resolve_collection`] plus the publisher gate, returning the opened
/// workspace so a command resolves and authorizes ONCE.
pub(crate) fn publisher_collection(
    state: &AppState,
    region_id: &str,
) -> Result<(RegionCollection, Box<dyn calp::WorkspaceTransport>), String> {
    let collection = resolve_collection(state, region_id)?;
    let (registry, _scope) = crate::calp_registry::open_workspace_scoped(&collection.registry_path)
        .map_err(|e| e.to_string())?;
    authorize(registry.as_ref(), &collection)?;
    Ok((collection, registry))
}

/// The versions a reader of `filter` folds, before the compatibility rule:
/// `read_version`, then
///
/// * every OLDER version (semver) for EVERY stream -- an environment can only
///   ever point at a version that exists, so every answer any stream holds for
///   a region read from `read_version` is at or below it;
/// * for a SET of streams, the union of each stream's own carry-forward --
///   `carry_forward_versions`, the ONE answer the subscriber's own reads use:
///   an environment's HELD versions (so a rollback never hides answers, and a
///   log that does not verify carries NOTHING forward rather than mixing in
///   versions the environment never ran), the semver rule for the line. For an
///   AUTHOR the union is clipped at `read_version`: a held version above it
///   either does not declare the region or failed verification, and its
///   answers are not read (the collection's note names it).
///
/// The subscriber's own walk (one stream, unclipped) is exactly what it was.
pub(crate) fn stream_versions(
    registry: &dyn calp::WorkspaceTransport,
    collection: &RegionCollection,
    filter: &StreamFilter,
) -> Vec<String> {
    let read = collection.read_version.as_str();
    let mut versions = vec![read.to_string()];
    match filter {
        StreamFilter::All => {
            for v in older_package_versions(registry, &collection.package_name, read) {
                if !versions.contains(&v) {
                    versions.push(v);
                }
            }
        }
        StreamFilter::Only(streams) => {
            let ceiling = calp::SemVer::parse(read).ok();
            for stream in streams {
                for v in carry_forward_versions(registry, &collection.package_name, read, stream) {
                    let above_read = collection.role == CollectionRole::Author
                        && matches!((&ceiling, calp::SemVer::parse(&v)), (Some(c), Ok(x)) if x > *c);
                    if !above_read && !versions.contains(&v) {
                        versions.push(v);
                    }
                }
            }
        }
    }
    versions
}

/// THE VERSIONS WHOSE ANSWERS A PUBLISHER READ COLLECTS for a region, with the
/// versions left out and why.
#[derive(Debug, Clone, Default)]
pub(crate) struct CollectedVersions {
    pub versions: Vec<String>,
    /// version -> the streams whose answers are read FROM THAT VERSION. Each
    /// stream is carried forward from its OWN base
    /// ([`RegionCollection::stream_bases`]), so one version can hold answers
    /// that count for prod and not for the development line. A version absent
    /// here is read under the whole filter.
    pub admitted: HashMap<String, StreamFilter>,
    /// "v1.0.0: ..." for each older version whose answers were not carried
    /// forward although it declares the region (incompatible, Strict, or not
    /// verifiable here). Logged by the readers; never silent.
    pub excluded: Vec<String>,
}

impl CollectedVersions {
    /// The streams read from `version` (every reader filters each version's
    /// rows with exactly this).
    pub(crate) fn filter_for(&self, version: &str, whole: &StreamFilter) -> StreamFilter {
        self.admitted.get(version).cloned().unwrap_or_else(|| whole.clone())
    }

    fn admit(&mut self, version: &str, streams: &StreamFilter) {
        if !self.versions.iter().any(|v| v == version) {
            self.versions.push(version.to_string());
        }
        let merged = match (self.admitted.remove(version), streams) {
            (None, s) => s.clone(),
            (Some(StreamFilter::All), _) | (_, StreamFilter::All) => StreamFilter::All,
            (Some(StreamFilter::Only(mut a)), StreamFilter::Only(b)) => {
                a.extend(b.iter().cloned());
                StreamFilter::Only(a)
            }
        };
        self.admitted.insert(version.to_string(), merged);
    }
}

/// [`stream_versions`], then THE CARRY-FORWARD RULE GATHER uses
/// (`carries_forward_from`): an older version counts only when its VERIFIED
/// declaration of the region is compatible with `read_version`'s -- same cells,
/// compatible schema -- and the region is not bound to one version (`Strict`).
///
/// Without this (BUG-0555) Collected Responses, its exports, the roster and
/// the author's model tables carried every older version's answers forward:
/// a region that slid down two rows filed last quarter's answers against the
/// wrong rows, and the totals looked plausible.
///
/// PER STREAM (BUG-0563): an environment stream whose pointer names an OLDER
/// version than `read_version` (the development line ahead of prod) is
/// carried forward from ITS version, against ITS declaration -- the versions it
/// held (`carry_forward_versions`), judged exactly as a prod subscriber's
/// GATHER judges them. Every other stream keeps `read_version` as its base.
pub(crate) fn collected_versions(
    registry: &dyn calp::WorkspaceTransport,
    collection: &RegionCollection,
    filter: &StreamFilter,
) -> CollectedVersions {
    let mut out = CollectedVersions::default();
    let mut verified: HashMap<String, Result<Vec<calp::WritebackRegionDeclaration>, String>> = HashMap::new();
    let mut regions_of = |version: &str| -> Result<Vec<calp::WritebackRegionDeclaration>, String> {
        verified
            .entry(version.to_string())
            .or_insert_with(|| collection.verified_regions_of(registry, version))
            .clone()
    };

    // Which streams leave the head's base.
    let rebased: Vec<(String, String)> = match filter {
        StreamFilter::All => Vec::new(),
        StreamFilter::Only(set) => set
            .iter()
            .filter_map(|s| collection.stream_bases.get(s).map(|base| (s.clone(), base.clone())))
            .collect(),
    };
    let head_filter: Option<StreamFilter> = match filter {
        StreamFilter::All => Some(StreamFilter::All),
        StreamFilter::Only(set) => {
            let rest: std::collections::BTreeSet<String> =
                set.iter().filter(|s| !rebased.iter().any(|(r, _)| r == *s)).cloned().collect();
            (!rest.is_empty()).then_some(StreamFilter::Only(rest))
        }
    };

    // One walk: `versions` judged against `base`'s `declaration`, admitting
    // `streams` from each version that carries forward.
    let walk = |out: &mut CollectedVersions,
                    base: &str,
                    declaration: &calp::WritebackRegionDeclaration,
                    versions: Vec<String>,
                    streams: &StreamFilter,
                    regions_of: &mut dyn FnMut(&str) -> Result<Vec<calp::WritebackRegionDeclaration>, String>| {
        let strict = matches!(declaration.version_binding, Some(calp::writeback::VersionBinding::Strict));
        for version in versions {
            if version == base {
                out.admit(&version, streams);
                continue;
            }
            if strict {
                out.excluded.push(format!(
                    "v{version}: the region is bound to one version, so answers sent to earlier versions are not carried forward"
                ));
                continue;
            }
            match regions_of(&version) {
                Ok(old_regions) => {
                    if !old_regions.iter().any(|r| r.id == declaration.id) {
                        // Nothing to carry: the version does not declare it.
                        continue;
                    }
                    if carries_forward_from(declaration, &old_regions) {
                        out.admit(&version, streams);
                    } else {
                        out.excluded.push(format!(
                            "v{version}: the region's cells or value type changed since, so its answers would land on the wrong cells"
                        ));
                    }
                }
                Err(e) => out.excluded.push(format!("v{version}: could not be verified on this computer: {e}")),
            }
        }
    };

    if let Some(head_filter) = &head_filter {
        let versions = stream_versions(registry, collection, head_filter);
        walk(&mut out, &collection.read_version, &collection.declaration, versions, head_filter, &mut regions_of);
    }
    let ceiling = calp::SemVer::parse(&collection.read_version).ok();
    for (stream, base) in &rebased {
        let one = StreamFilter::one(stream);
        let declaration = match regions_of(base) {
            Ok(regions) => regions.into_iter().find(|r| r.id == collection.declaration.id),
            Err(e) => {
                out.excluded.push(format!("v{base} ({stream}): could not be verified on this computer: {e}"));
                continue;
            }
        };
        let Some(declaration) = declaration else {
            // The version this environment runs does not declare the region:
            // nothing is collected for it there; older versions it held are
            // judged against the head's declaration, as before.
            let versions: Vec<String> = carry_forward_versions(registry, &collection.package_name, base, stream);
            walk(&mut out, &collection.read_version, &collection.declaration, versions, &one, &mut regions_of);
            continue;
        };
        let mut versions = vec![base.clone()];
        for v in carry_forward_versions(registry, &collection.package_name, base, stream) {
            let above_read = matches!((&ceiling, calp::SemVer::parse(&v)), (Some(c), Ok(x)) if x > *c);
            if !above_read && !versions.contains(&v) {
                versions.push(v);
            }
        }
        walk(&mut out, base, &declaration, versions, &one, &mut regions_of);
    }
    // The read version first, as every reader expects.
    if let Some(at) = out.versions.iter().position(|v| v == &collection.read_version) {
        let read = out.versions.remove(at);
        out.versions.insert(0, read);
    }
    out
}

/// The name a stream goes by in an audit row or a sentence (`None` = every
/// stream).
pub(crate) fn stream_label(stream: Option<&str>) -> String {
    match stream {
        None => "every stream".to_string(),
        Some(environment) => calp::writeback::stream_label(environment),
    }
}

// ============================================================================
// The listing behind Collected Responses and the submission watch
// ============================================================================

/// Whether a listed region's answers can be read here, and if not, why.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub enum CollectionStatus {
    /// Resolved and this computer is a publisher of the application.
    Ready,
    /// A designated region of a workbook not linked to an application.
    NotPublished,
    /// The linked application declares the region in no version yet.
    NotInPushedVersion,
    /// The application is resolved but this computer holds no key that may
    /// read its answers.
    NotPublisher,
    /// The workspace or a version could not be read or was refused.
    Unreachable,
}

/// One region the publisher's Collected Responses pane can show.
///
/// IPC types of the writeback collaboration surface live beside their command
/// and are mirrored in `@api/collaboration` (as every `calp_*` type is), not in
/// `api_types.rs` / `types.ts` -- the documented exception in
/// docs/design/calp-writeback.md ("Which streams the publisher collects").
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CollectionRegionInfo {
    pub region_id: String,
    pub role: CollectionRole,
    /// The sheet the cells are on in THIS workbook.
    pub sheet_id: String,
    /// `None` when that sheet is no longer in the workbook.
    pub sheet_index: Option<usize>,
    pub sheet_name: Option<String>,
    pub row_start: u32,
    pub row_end: u32,
    pub col_start: u32,
    pub col_end: u32,
    pub package_name: Option<String>,
    pub registry_url: Option<String>,
    /// The version the answers are read from (when resolved).
    pub version: Option<String>,
    /// The application's environments that point at a version (row labels).
    /// Empty = only the development line exists.
    pub environments: Vec<String>,
    /// What every read of this region collects, RESOLVED: `None` = every
    /// stream; otherwise the streams in order (`""` = the development line).
    /// An author region follows the workbook's Collect From choice, a
    /// subscribed region its subscription's one stream. The submission watch
    /// re-baselines a region whose value changes, so a newly collected
    /// stream's old answers are never announced as "received".
    pub collecting: Option<Vec<String>>,
    /// Whether this workbook still designates the region (author rows); a
    /// region removed from the working copy that a published version still
    /// declares is listed with `false`. Always true for a subscribed region.
    pub designated: bool,
    pub status: CollectionStatus,
    /// A user-facing sentence for every status but `ready`.
    pub detail: String,
    /// A caveat on a `ready` row (newer versions whose answers could not be
    /// verified here; a region no longer designated). Empty when none.
    pub note: String,
}

/// Environment names an application offers, with a version behind them.
fn environment_names(envs: Result<Vec<calp::environments::Environment>, String>) -> Vec<String> {
    envs.map(|envs| {
        envs.into_iter()
            .filter(|e| e.version.is_some() && !e.unauthorized_pointer)
            .map(|e| e.name)
            .collect()
    })
    .unwrap_or_default()
}

/// A row in its not-yet-resolved shape.
#[allow(clippy::too_many_arguments)]
fn base_row(
    region_id: &str,
    role: CollectionRole,
    sheet_id: String,
    sheet_index: Option<usize>,
    sheet_name: Option<String>,
    selector: (u32, u32, u32, u32),
    package_name: Option<String>,
    registry_url: Option<String>,
    designated: bool,
) -> CollectionRegionInfo {
    CollectionRegionInfo {
        region_id: region_id.to_string(),
        role,
        sheet_id,
        sheet_index,
        sheet_name,
        row_start: selector.0,
        row_end: selector.1,
        col_start: selector.2,
        col_end: selector.3,
        package_name,
        registry_url,
        version: None,
        environments: Vec::new(),
        collecting: None,
        designated,
        status: CollectionStatus::Unreachable,
        detail: String::new(),
        note: String::new(),
    }
}

/// Fill a row from the ONE decision: the resolution and the gate.
fn settle(
    row: &mut CollectionRegionInfo,
    decided: Result<(RegionCollection, Vec<String>), CollectionRefusal>,
) {
    match decided {
        Ok((collection, environments)) => {
            row.package_name = Some(collection.package_name);
            row.registry_url = Some(collection.registry_path);
            row.version = Some(collection.read_version);
            row.collecting = collection.streams.streams();
            row.status = CollectionStatus::Ready;
            row.detail = String::new();
            row.note = collection.note;
            row.environments = environments;
        }
        Err(refusal) => {
            row.status = refusal.status();
            row.detail = refusal.detail();
        }
    }
}

/// Every region whose answers this workbook could show: its OWN designated
/// regions first (one workspace walk for the linked application, not one per
/// region), then the regions a published version still declares that the
/// working copy no longer designates, then the subscribed regions of the index.
///
/// Every row is decided by the SAME functions the commands call --
/// [`AuthorWalk::resolve`] / the subscriber route of [`resolve_collection`],
/// then [`authorize`] -- batched so one workspace open and one gate serve every
/// row of one application.
/// The workbook's OWN regions whose answers this computer may read -- resolved
/// and gated through the SAME functions as the listing ([`AuthorWalk::resolve`],
/// [`authorize`]) -- over ONE workspace walk with one gate per publisher key,
/// and nothing of the subscriber half. Returned with the walk, whose opened
/// workspace the caller reads the rows through, and each region's sheet name
/// in this workbook. For the BI author pass, which used to list every region
/// (subscribed applications included) and then re-walk the workspace per
/// region. `None` for a workbook that is not linked to an application.
pub(crate) fn ready_author_collections(
    state: &AppState,
) -> Result<Option<(AuthorWalk, Vec<(RegionCollection, Option<String>)>)>, String> {
    let Some(link) = state.working_copy_link.read().map_err(|e| e.to_string())?.clone() else {
        return Ok(None);
    };
    let (sheet_ids, sheet_names) = {
        let ids = state.sheet_ids.read().map_err(|e| e.to_string())?.clone();
        let names = state.sheet_names.read().map_err(|e| e.to_string())?.clone();
        (ids, names)
    };
    let sheet_name_of = |sheet_id: &identity::SheetId| {
        sheet_ids.iter().position(|s| s == sheet_id).and_then(|i| sheet_names.get(i).cloned())
    };
    let drafts = state.writeback_draft_regions.read().map_err(|e| e.to_string())?.clone();
    let subscribed: HashSet<String> = writeback_region_entries(state)?.into_iter().map(|e| e.region_id).collect();

    let mut walk = AuthorWalk::open(&link);
    if walk.workspace_error.is_some() {
        return Ok(Some((walk, Vec::new())));
    }
    let mut candidates: Vec<(String, String, bool, Option<String>)> = drafts
        .iter()
        .map(|d| (d.id.clone(), range_a1(d), true, sheet_name_of(&d.selector.sheet_id)))
        .collect();
    let draft_ids: HashSet<String> = drafts.iter().map(|d| d.id.clone()).collect();
    for declared in walk.declared_regions() {
        if draft_ids.contains(&declared.id) || subscribed.contains(&declared.id) {
            continue;
        }
        candidates.push((declared.id.clone(), range_a1(&declared), false, sheet_name_of(&declared.selector.sheet_id)));
    }
    let mut gate: HashMap<String, bool> = HashMap::new();
    let mut ready = Vec::new();
    for (region_id, range, designated, sheet_name) in candidates {
        let collection = match walk.resolve(&region_id, &range, designated) {
            Ok(c) => c,
            Err(_) => continue,
        };
        let allowed = *gate.entry(collection.publisher_key.clone()).or_insert_with(|| match walk.registry() {
            Some(registry) => authorize(registry, &collection).is_ok(),
            None => false,
        });
        if allowed {
            ready.push((collection, sheet_name));
        }
    }
    Ok(Some((walk, ready)))
}

pub(crate) fn list_collection_regions(state: &AppState) -> Result<Vec<CollectionRegionInfo>, String> {
    let mut rows: Vec<CollectionRegionInfo> = Vec::new();
    let (sheet_ids, sheet_names) = {
        let ids = state.sheet_ids.read().map_err(|e| e.to_string())?.clone();
        let names = state.sheet_names.read().map_err(|e| e.to_string())?.clone();
        (ids, names)
    };
    let sheet_index_of = |sheet_id: &identity::SheetId| sheet_ids.iter().position(|s| s == sheet_id);
    let subscribed: Vec<calp::WritebackRegionEntry> = writeback_region_entries(state)?;

    // ---- the author's own regions ----
    let drafts = state.writeback_draft_regions.read().map_err(|e| e.to_string())?.clone();
    let link = state.working_copy_link.read().map_err(|e| e.to_string())?.clone();
    if let Some(link) = link.as_ref() {
        let mut walk = AuthorWalk::open(link);
        // One gate per verified publisher key, one environment read (the
        // walk caches it for the default stream choice too).
        let mut gate: HashMap<String, Result<(), CollectionRefusal>> = HashMap::new();
        let environments: Vec<String> = if walk.registry().is_some() {
            environment_names(walk.environments())
        } else {
            Vec::new()
        };
        let mut decide = |walk: &mut AuthorWalk, region_id: &str, range: &str, designated: bool| {
            let collection = walk.resolve(region_id, range, designated)?;
            let verdict = gate
                .entry(collection.publisher_key.clone())
                .or_insert_with(|| match walk.registry() {
                    Some(registry) => authorize(registry, &collection),
                    None => Err(CollectionRefusal::Unreachable("The workspace could not be read.".to_string())),
                })
                .clone();
            verdict.map(|()| (collection, environments.clone()))
        };

        let mut own: Vec<CollectionRegionInfo> = Vec::new();
        for d in &drafts {
            let sheet_index = sheet_index_of(&d.selector.sheet_id);
            let mut row = base_row(
                &d.id,
                CollectionRole::Author,
                d.selector.sheet_id.to_string(),
                sheet_index,
                sheet_index.and_then(|i| sheet_names.get(i).cloned()),
                (d.selector.row_start, d.selector.row_end, d.selector.col_start, d.selector.col_end),
                Some(link.package_name.clone()),
                Some(link.registry_url.clone()),
                true,
            );
            settle(&mut row, decide(&mut walk, &d.id, &range_a1(d), true));
            own.push(row);
        }

        // Regions a published version still declares that this workbook no
        // longer designates (and does not subscribe to): still collecting.
        // Only a region that RESOLVES is listed -- one that cannot be verified
        // is not designated here and has nothing to show.
        let draft_ids: HashSet<&str> = drafts.iter().map(|d| d.id.as_str()).collect();
        let subscribed_ids: HashSet<&str> = subscribed.iter().map(|e| e.region_id.as_str()).collect();
        for declared in walk.declared_regions() {
            if draft_ids.contains(declared.id.as_str()) || subscribed_ids.contains(declared.id.as_str()) {
                continue;
            }
            let decided = decide(&mut walk, &declared.id, &range_a1(&declared), false);
            if decided.is_err() {
                continue;
            }
            let sheet_index = sheet_index_of(&declared.selector.sheet_id);
            let mut row = base_row(
                &declared.id,
                CollectionRole::Author,
                declared.selector.sheet_id.to_string(),
                sheet_index,
                sheet_index.and_then(|i| sheet_names.get(i).cloned()),
                (
                    declared.selector.row_start,
                    declared.selector.row_end,
                    declared.selector.col_start,
                    declared.selector.col_end,
                ),
                Some(link.package_name.clone()),
                Some(link.registry_url.clone()),
                false,
            );
            settle(&mut row, decided);
            own.push(row);
        }
        own.sort_by(|a, b| {
            (!a.designated, a.sheet_index.unwrap_or(usize::MAX), a.row_start, a.col_start)
                .cmp(&(!b.designated, b.sheet_index.unwrap_or(usize::MAX), b.row_start, b.col_start))
        });
        rows.extend(own);
    } else {
        let mut own: Vec<CollectionRegionInfo> = drafts
            .iter()
            .map(|d| {
                let sheet_index = sheet_index_of(&d.selector.sheet_id);
                let mut row = base_row(
                    &d.id,
                    CollectionRole::Author,
                    d.selector.sheet_id.to_string(),
                    sheet_index,
                    sheet_index.and_then(|i| sheet_names.get(i).cloned()),
                    (d.selector.row_start, d.selector.row_end, d.selector.col_start, d.selector.col_end),
                    None,
                    None,
                    true,
                );
                settle(&mut row, Err(CollectionRefusal::NotPublished));
                row
            })
            .collect();
        own.sort_by(|a, b| {
            (a.sheet_index.unwrap_or(usize::MAX), a.row_start, a.col_start)
                .cmp(&(b.sheet_index.unwrap_or(usize::MAX), b.row_start, b.col_start))
        });
        rows.extend(own);
    }

    // ---- regions of subscribed applications (a publisher reviewing from a
    // subscriber workbook) ----
    let own_ids: HashSet<String> = rows.iter().map(|r| r.region_id.clone()).collect();
    // (registry, package, publisher key) -> (gate, environments): one workspace
    // open and one gate per subscribed application version.
    let mut by_application: BTreeMap<(String, String, String), (Result<(), CollectionRefusal>, Vec<String>)> =
        BTreeMap::new();
    for entry in subscribed {
        if own_ids.contains(&entry.region_id) {
            continue;
        }
        let mut row = base_row(
            &entry.region_id,
            CollectionRole::Subscriber,
            entry.sheet_id.to_string(),
            Some(entry.sheet_index),
            entry.sheet_name.clone(),
            (entry.row_start, entry.row_end, entry.col_start, entry.col_end),
            entry.package_name.clone(),
            entry.registry_url.clone(),
            true,
        );
        let decided = match owning_subscription_for_region(state, &entry.region_id) {
            Ok(owner) => {
                let collection = subscriber_collection(owner);
                let key = (
                    collection.registry_path.clone(),
                    collection.package_name.clone(),
                    collection.publisher_key.clone(),
                );
                let (verdict, envs) = by_application
                    .entry(key)
                    .or_insert_with(|| {
                        match crate::calp_registry::open_workspace_scoped(&collection.registry_path) {
                            Ok((registry, scope)) => {
                                let verdict = authorize(registry.as_ref(), &collection);
                                // A subscriber's menu of streams is anchored on
                                // its pin, as the subscription pane's is.
                                let envs = environment_names(
                                    calp::environments::environments_via(
                                        registry.as_ref(),
                                        &collection.package_name,
                                        calp::environments::PromotionTrust::Pinned {
                                            scope: &scope,
                                            profile_dir: &calcula_profile_dir(),
                                        },
                                    )
                                    .map_err(|e| e.to_string()),
                                );
                                (verdict, envs)
                            }
                            Err(e) => (Err(CollectionRefusal::Unreachable(e.to_string())), Vec::new()),
                        }
                    })
                    .clone();
                verdict.map(|()| (collection, envs))
            }
            Err(e) => Err(CollectionRefusal::Unreachable(e)),
        };
        settle(&mut row, decided);
        rows.push(row);
    }
    Ok(rows)
}

/// Every writeback region whose answers this workbook can show in Collected
/// Responses, with whether they can be read here and why not. The workbook's
/// OWN designated regions come first (resolved through the application it
/// published or was opened for editing from), then subscribed ones.
#[tauri::command]
pub fn calp_list_collection_regions(
    state: tauri::State<AppState>,
    window: tauri::Window,
) -> Result<Vec<CollectionRegionInfo>, String> {
    crate::security::window_guard::require_label(&window, crate::security::window_guard::MAIN)?;
    list_collection_regions(&state)
}

// ============================================================================
// Writeback > Collect From: the publisher's choice of streams
// ============================================================================

/// What a menu row is.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub enum StreamChoiceKind {
    /// The development line (`""`).
    DevelopmentLine,
    /// An environment of the pipeline, in pipeline order.
    Environment,
    /// A name no longer in the pipeline that is still chosen, or that answers
    /// still carry: listed so it can be ticked or unticked, never dropped in
    /// silence.
    Removed,
}

/// Which kind of choice the workbook holds.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub enum CollectMode {
    /// No choice: the last environment of the pipeline (every stream when
    /// there are no environments).
    Default,
    /// Every stream, including environments defined later.
    All,
    /// Exactly the chosen streams.
    Only,
}

/// One row of the Collect From menu.
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StreamChoice {
    /// `""` = the development line.
    pub stream: String,
    /// "Development line" | "prod"
    pub label: String,
    pub kind: StreamChoiceKind,
    /// Collected under the current choice.
    pub included: bool,
    /// The version an environment points at, if any.
    pub version: Option<String>,
    /// "v1.2.0" | "no version yet" | "pointer not authorised" | "not collected"
    /// | "the default" | "not in the pipeline", joined by " · ". Never a number
    /// formatted for display, so it is the same in every locale.
    pub hint: String,
}

/// Everything the Collect From control shows.
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CollectionStreamsView {
    /// False = no working-copy link: nothing to choose (the control is
    /// disabled with the publish-first sentence).
    pub linked: bool,
    pub package_name: Option<String>,
    pub registry_url: Option<String>,
    pub mode: CollectMode,
    /// The explicit set when `mode` is `only`.
    pub selection: Option<Vec<String>>,
    /// What is collected now, RESOLVED (`None` = every stream). `None` too
    /// when the default cannot be decided (`environments_error`).
    pub collecting: Option<Vec<String>>,
    /// The stream the default means today: the pipeline's last environment.
    pub default_stream: Option<String>,
    /// Line first, then the pipeline in order, then removed names.
    pub choices: Vec<StreamChoice>,
    /// Environments of the pipeline that an explicit choice does NOT collect
    /// (typically a new one, defined after the choice was made).
    pub not_collected: Vec<String>,
    pub environments_error: Option<String>,
    /// "prod (the last environment)" | "All streams" | "Development line, test"
    pub summary: String,
    /// Whether THIS computer may change the choice (it holds the
    /// application's publisher key, or an authorised co-publisher's).
    pub can_change: bool,
    /// Why not, when it may not.
    pub change_refusal: Option<String>,
}

/// What the Collect From command is asked to do.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum CollectionStreamsOp {
    Get,
    Set,
}

/// The Collect From command's argument. A struct with a unit-variant op, never
/// a struct variant (whose fields `rename_all` on an enum would not rename).
#[derive(Debug, Clone, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CollectionStreamsRequest {
    pub op: CollectionStreamsOp,
    /// For `set`: the new choice -- `"all"` or `{"only": [...]}` -- or absent
    /// for the default (the last environment).
    #[serde(default)]
    pub choice: Option<CollectStreams>,
}

/// The refusal for an empty choice.
pub(crate) const EMPTY_CHOICE_TEXT: &str = "Choose at least one stream to collect from.";

/// "Development line" | "prod" -- a menu label.
fn choice_label(stream: &str) -> String {
    if stream.is_empty() {
        "Development line".to_string()
    } else {
        stream.to_string()
    }
}

/// The one-line summary of a choice.
fn summary_of(
    choice: Option<&CollectStreams>,
    environments: &Result<Vec<calp::environments::Environment>, String>,
) -> String {
    match choice {
        Some(CollectStreams::All) => "All streams".to_string(),
        Some(CollectStreams::Only(set)) => set.iter().map(|s| choice_label(s)).collect::<Vec<_>>().join(", "),
        None => match environments {
            Ok(envs) => match default_environment(envs) {
                Ok(Some(name)) => format!("{name} (the last environment)"),
                Ok(None) => "All streams".to_string(),
                Err(_) => "Nothing (the pipeline was changed by a key this application does not authorise)".to_string(),
            },
            Err(_) => "The last environment (the pipeline could not be read)".to_string(),
        },
    }
}

/// Build the Collect From view from an opened walk.
fn streams_view(walk: &mut AuthorWalk) -> CollectionStreamsView {
    let link = walk.link().clone();
    let choice = link.collect_choice();
    let environments = if walk.registry().is_some() {
        walk.environments()
    } else {
        Err(walk.workspace_error.clone().unwrap_or_else(|| "The workspace could not be read.".to_string()))
    };
    let resolved = resolve_choice(choice.as_ref(), || environments.clone());
    let filter = resolved.as_ref().ok().cloned();
    let defined: Vec<calp::environments::Environment> = environments.clone().unwrap_or_default();
    // The SAME default every read follows (`default_environment`): never an
    // environment whose pointer is not authorised.
    let default_stream = default_environment(&defined).ok().flatten();
    // Why the choice cannot be resolved, when it cannot: the pipeline could
    // not be read, or (the default) it was changed by an unauthorised key.
    let environments_error = match (&environments, &resolved) {
        (Err(e), _) => Some(e.clone()),
        (Ok(_), Err(e)) => Some(default_unreadable_text(&link.package_name, e)),
        _ => None,
    };
    let mode = match &choice {
        None => CollectMode::Default,
        Some(CollectStreams::All) => CollectMode::All,
        Some(CollectStreams::Only(_)) => CollectMode::Only,
    };
    let included = |stream: &str| filter.as_ref().is_some_and(|f| f.admits(stream));
    let explicit_not = |stream: &str| mode == CollectMode::Only && !included(stream);

    let mut choices: Vec<StreamChoice> = Vec::new();
    choices.push(StreamChoice {
        stream: String::new(),
        label: choice_label(""),
        kind: StreamChoiceKind::DevelopmentLine,
        included: included(""),
        version: None,
        hint: if explicit_not("") { "not collected".to_string() } else { String::new() },
    });
    for env in &defined {
        let mut hint: Vec<String> = Vec::new();
        match &env.version {
            Some(v) => hint.push(format!("v{v}")),
            None => hint.push("no version yet".to_string()),
        }
        if env.unauthorized_pointer {
            hint.push("pointer not authorised".to_string());
        }
        if mode == CollectMode::Default && default_stream.as_deref() == Some(env.name.as_str()) {
            hint.push("the default".to_string());
        }
        if explicit_not(&env.name) {
            hint.push("not collected".to_string());
        }
        choices.push(StreamChoice {
            stream: env.name.clone(),
            label: choice_label(&env.name),
            kind: StreamChoiceKind::Environment,
            included: included(&env.name),
            version: env.version.clone(),
            hint: hint.join(" · "),
        });
    }
    // Names that are chosen or that answers carry, but that the pipeline no
    // longer defines (a deleted or renamed environment), in name order.
    let mut removed: BTreeSet<String> = walk.stream_tags_in_records().clone();
    if let Some(CollectStreams::Only(set)) = &choice {
        removed.extend(set.iter().cloned());
    }
    for name in removed {
        if name.is_empty() || defined.iter().any(|e| e.name == name) {
            continue;
        }
        if calp::environments::validate_environment_name(&name).is_err() {
            continue;
        }
        let mut hint = vec!["not in the pipeline".to_string()];
        if explicit_not(&name) {
            hint.push("not collected".to_string());
        }
        choices.push(StreamChoice {
            label: choice_label(&name),
            included: included(&name),
            stream: name,
            kind: StreamChoiceKind::Removed,
            version: None,
            hint: hint.join(" · "),
        });
    }
    let not_collected: Vec<String> = match &choice {
        Some(CollectStreams::Only(set)) => {
            defined.iter().filter(|e| !set.contains(&e.name)).map(|e| e.name.clone()).collect()
        }
        _ => Vec::new(),
    };
    let scope = calp::workspace_scope(&link.registry_url).ok();
    let gate: Result<(), CollectionRefusal> = walk.newest_verified_publisher_key().and_then(|key| match walk.registry() {
        Some(registry) => {
            require_publisher_key(registry, &link.package_name, &key, scope.as_ref()).map_err(CollectionRefusal::from)
        }
        None => Err(CollectionRefusal::Unreachable("The workspace could not be read.".to_string())),
    });
    CollectionStreamsView {
        linked: true,
        package_name: Some(link.package_name.clone()),
        registry_url: Some(link.registry_url.clone()),
        mode,
        selection: match &choice {
            Some(CollectStreams::Only(set)) => Some(set.iter().cloned().collect()),
            _ => None,
        },
        collecting: filter.as_ref().and_then(|f| f.streams()),
        default_stream,
        choices,
        not_collected,
        environments_error,
        summary: summary_of(choice.as_ref(), &environments),
        can_change: gate.is_ok(),
        change_refusal: gate.err().map(|r| r.detail()),
    }
}

/// The view for a workbook with no working-copy link.
fn unlinked_view() -> CollectionStreamsView {
    CollectionStreamsView {
        linked: false,
        package_name: None,
        registry_url: None,
        mode: CollectMode::Default,
        selection: None,
        collecting: None,
        default_stream: None,
        choices: Vec::new(),
        not_collected: Vec::new(),
        environments_error: None,
        summary: String::new(),
        can_change: false,
        change_refusal: Some(NOT_PUBLISHED_TEXT.to_string()),
    }
}

/// Collect From, read.
pub(crate) fn collection_streams_view(state: &AppState) -> Result<CollectionStreamsView, String> {
    let link = state.working_copy_link.read().map_err(|e| e.to_string())?.clone();
    Ok(match link {
        None => unlinked_view(),
        Some(link) => streams_view(&mut AuthorWalk::open(&link)),
    })
}

/// Normalise a requested choice: trim, refuse an empty set and a name no
/// environment may carry.
fn normalise_choice(choice: Option<CollectStreams>) -> Result<Option<CollectStreams>, String> {
    match choice {
        None => Ok(None),
        Some(CollectStreams::All) => Ok(Some(CollectStreams::All)),
        Some(CollectStreams::Only(set)) => {
            let set: BTreeSet<String> = set.into_iter().map(|s| s.trim().to_string()).collect();
            if set.is_empty() {
                return Err(EMPTY_CHOICE_TEXT.to_string());
            }
            for name in &set {
                if !name.is_empty() {
                    calp::environments::validate_environment_name(name)
                        .map_err(|e| format!("'{name}' cannot be collected: {e}"))?;
                }
            }
            Ok(Some(CollectStreams::Only(set)))
        }
    }
}

/// Collect From, written. Refused unless this workbook is linked, the
/// workspace can be read, and THIS computer holds the application's publisher
/// key (or an authorised co-publisher's) -- the same proof as reading the
/// answers: a computer that may not read them may not reshape what the
/// workbook collects either. A name must be "" or one the pipeline defines,
/// the stored choice already names, or answers carry; inventing one is
/// refused. Setting what is already stored changes nothing and does not dirty
/// the workbook.
///
/// Otherwise: the workbook is dirtied (the choice is saved with it), the
/// change is AUDITED whether or not auditing is on, and the author's BI
/// writeback tables are rebuilt.
pub(crate) fn set_collection_streams(
    state: &AppState,
    file_state: &crate::persistence::FileState,
    choice: Option<CollectStreams>,
) -> Result<CollectionStreamsView, String> {
    let link = state
        .working_copy_link
        .read()
        .map_err(|e| e.to_string())?
        .clone()
        .ok_or_else(|| NOT_PUBLISHED_TEXT.to_string())?;
    let choice = normalise_choice(choice)?;

    let mut walk = AuthorWalk::open(&link);
    if let Some(e) = walk.workspace_error.clone() {
        return Err(format!("Collect From can only be changed while the workspace can be read. {e}"));
    }
    let key = walk.newest_verified_publisher_key().map_err(String::from)?;
    {
        let registry = walk.registry().ok_or_else(|| "The workspace could not be read.".to_string())?;
        let scope = calp::workspace_scope(&link.registry_url).ok();
        require_publisher_key(registry, &link.package_name, &key, scope.as_ref())
            .map_err(CollectionRefusal::from)
            .map_err(String::from)?;
    }

    if let Some(CollectStreams::Only(set)) = &choice {
        let defined: Vec<String> = walk.environments().map(|e| e.into_iter().map(|e| e.name).collect()).unwrap_or_default();
        let stored: BTreeSet<String> = match &link.collect_streams {
            Some(CollectStreams::Only(s)) => s.clone(),
            _ => BTreeSet::new(),
        };
        for name in set {
            if name.is_empty() || defined.contains(name) || stored.contains(name) {
                continue;
            }
            if !walk.stream_tags_in_records().contains(name) {
                return Err(format!(
                    "'{name}' is not an environment of '{}', and no answer was sent in it.",
                    link.package_name
                ));
            }
        }
    }

    if link.collect_streams == choice {
        // Nothing changes: no effect, no dirty, no audit row.
        return Ok(streams_view(&mut walk));
    }

    let before = summary_of(link.collect_streams.as_ref(), &walk.environments());
    let after = summary_of(choice.as_ref(), &walk.environments());
    {
        // The link is re-checked UNDER the lock: a checkout or a File > New
        // between the read above and this write would otherwise receive a
        // choice made for another application.
        let pending = state.working_copy_link.lock_pending().map_err(|e| e.to_string())?;
        match pending.as_ref() {
            Some(current) if current.package_name == link.package_name && current.registry_url == link.registry_url => {}
            _ => return Err("The workbook's application changed while Collect From was being saved. Try again.".to_string()),
        }
        let effect = crate::document_effect::DocumentEffect::mutates(file_state);
        let mut guard = pending.authorize(&effect);
        if let Some(current) = guard.as_mut() {
            current.collect_streams = choice.clone();
        }
    }

    {
        let now = chrono::Utc::now().to_rfc3339();
        let user = crate::calp_commands::audit_user(state);
        let mut extra = HashMap::new();
        extra.insert("application".to_string(), serde_json::Value::String(link.package_name.clone()));
        extra.insert("workspace".to_string(), serde_json::Value::String(link.registry_url.clone()));
        extra.insert("from".to_string(), serde_json::Value::String(before.clone()));
        extra.insert("to".to_string(), serde_json::Value::String(after.clone()));
        if let Ok(mut audit) = state.audit_log.write(&crate::document_effect::DocumentEffect::deliberately_clean(
            crate::document_effect::CleanReason::AuditTrail,
        )) {
            audit.record_with_extra(
                calp::audit::AuditEvent::CollectionStreamsChanged,
                &format!("Collect From for '{}' changed from {} to {}", link.package_name, before, after),
                &user,
                &now,
                extra,
            );
        }
    }
    // The author's model tables follow the choice.
    crate::bi::writeback_source::invalidate_writeback_bi();

    let link = state.working_copy_link.read().map_err(|e| e.to_string())?.clone();
    Ok(match link {
        None => unlinked_view(),
        // The SAME walk, re-linked to the stored choice: the workspace, the
        // verified versions, the pipeline and the stream tags it already read
        // are still what they were a moment ago (one tag scan per Set, not
        // three).
        Some(link) => {
            walk.relink(link);
            streams_view(&mut walk)
        }
    })
}

/// Writeback > Collect From: read (`op: "get"`) or change (`op: "set"`) which
/// streams this workbook collects its own regions' answers from. ASYNC: it
/// reads the workspace (the pipeline, the gate, the stream tags), and an
/// unreachable share must never freeze the window.
#[tauri::command(async)]
pub fn calp_collection_streams(
    state: tauri::State<'_, AppState>,
    file_state: tauri::State<'_, crate::persistence::FileState>,
    request: CollectionStreamsRequest,
    window: tauri::Window,
) -> Result<CollectionStreamsView, String> {
    crate::security::window_guard::require_label(&window, crate::security::window_guard::MAIN)?;
    match request.op {
        CollectionStreamsOp::Get => collection_streams_view(&state),
        CollectionStreamsOp::Set => set_collection_streams(&state, &file_state, request.choice),
    }
}
