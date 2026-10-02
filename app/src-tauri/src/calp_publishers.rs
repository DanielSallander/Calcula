//! FILENAME: app/src-tauri/src/calp_publishers.rs
//! PURPOSE: Manage who, besides the package's creator, may publish to it.
//! CONTEXT: A profile holds ONE Ed25519 keypair, used for every package that
//! user publishes and for reviewing writeback. Handing a colleague "the team
//! key" therefore overwrites their own identity machine-wide and destroys
//! attribution — so delegation, not key sharing, is how a second developer gets
//! to push. See `core/calp/src/publishers.rs` for the trust chain and its
//! honest limit.

use serde::{Deserialize, Serialize};
use tauri::State;

use crate::AppState;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CoPublisherInfo {
    /// Lowercase hex of the Ed25519 public key.
    pub key: String,
    /// Display only — the key is what authorizes.
    pub name: String,
    pub added_at: String,
    /// Whether THIS computer holds this key.
    pub is_you: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CoPublishersResponse {
    pub package_name: String,
    /// The key that published version 1 — the anchor the whole chain hangs
    /// from, and the only key that can change the list. Empty for a package
    /// with no signed versions.
    pub root_key: String,
    /// Whether this computer holds the root key, i.e. whether the list can be
    /// changed from here.
    pub you_are_the_root: bool,
    /// Whether this computer may publish at all (root or an authorized
    /// delegate).
    pub you_may_publish: bool,
    /// Delegates. Empty when the package has no list — which is the normal
    /// state for a package with one publisher, not an error.
    pub co_publishers: Vec<CoPublisherInfo>,
    /// Set when a list exists but could not be trusted. Reported rather than
    /// treated as "no delegates", because those two must not look alike.
    pub problem: String,
    /// Set by a change of the list when the workspace was serving an OLDER list
    /// than one this computer had already seen (a rollback): says which
    /// revision was served, which was seen, and which the new list became.
    pub notice: String,
    /// Set when the workspace serves a list OLDER than one this computer has
    /// seen: somebody put a list back that still carries the creator's valid
    /// signature. Its entries are NOT `co_publishers` -- a rolled-back list is
    /// not the current one, and an editor that started from it would sign
    /// everyone it re-adds back in -- they are shown here, apart, so the
    /// creator can see whom it re-adds before replacing it.
    pub rolled_back: Option<RolledBackList>,
}

/// A co-publisher list the workspace serves that is older than one this
/// computer has seen.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RolledBackList {
    /// The revision the workspace serves now.
    pub served_revision: u64,
    /// The highest revision this computer has seen.
    pub seen_revision: u64,
    /// Who the served (older) list names. Not the current list.
    pub served_co_publishers: Vec<CoPublisherInfo>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CoPublishersParams {
    pub registry_path: String,
    pub package_name: String,
}

fn co_publisher_infos(profile: &std::path::Path, list: &calp::publishers::PublisherList) -> Vec<CoPublisherInfo> {
    list.authorized_keys
        .iter()
        .map(|entry| CoPublisherInfo {
            is_you: calp::signing::profile_holds_publisher_key(profile, &entry.key).unwrap_or(false),
            key: entry.key.clone(),
            name: entry.name.clone(),
            added_at: entry.added_at.clone(),
        })
        .collect()
}

/// Who may publish this package.
#[tauri::command]
pub fn calp_list_co_publishers(
    params: CoPublishersParams,
    window: tauri::Window,
) -> Result<CoPublishersResponse, String> {
    crate::security::window_guard::require_label(&window, crate::security::window_guard::MAIN)?;
    let (registry, scope) = crate::calp_registry::open_workspace_scoped(&params.registry_path)
        .map_err(|e| e.to_string())?;
    let profile = crate::calp_commands::calcula_profile_dir();
    Ok(list_co_publishers_core(registry.as_ref(), &scope, &profile, &params.package_name))
}

/// [`calp_list_co_publishers`] without the window.
///
/// THE LIST IS JUDGED BEFORE IT IS SHOWN. The editor builds the NEW list from
/// this listing, so a listing that presented whatever the workspace serves let
/// a ROLLED-BACK list -- an older one the creator really signed, put back by
/// someone they had removed -- become the creator's own next list: their next
/// add or remove re-signed the removed delegate in, at a revision every machine
/// accepts. So the root is PROVED (never the unsigned listing's first entry),
/// the served list is checked against what this computer remembers (`CheckOnly`:
/// a listing is a read and records nothing), and a rolled-back list is reported
/// apart (`rolled_back`), never as `co_publishers`. A root that contradicts
/// what this computer remembers shows no list at all.
pub(crate) fn list_co_publishers_core(
    registry: &dyn calp::transport::WorkspaceTransport,
    scope: &calp::WorkspaceScope,
    profile: &std::path::Path,
    package: &str,
) -> CoPublishersResponse {
    let refused = |root_key: String, you_are_the_root: bool, problem: String| CoPublishersResponse {
        package_name: package.to_string(),
        root_key,
        you_are_the_root,
        you_may_publish: you_are_the_root,
        co_publishers: Vec::new(),
        problem,
        notice: String::new(),
        rolled_back: None,
    };

    let root = match calp::publishers::verified_root(registry, package) {
        Ok(root) => root,
        Err(e) => return refused(String::new(), false, e.to_string()),
    };
    let you_are_the_root = calp::signing::profile_holds_publisher_key(profile, &root.root_key).unwrap_or(false);

    // A list that exists but cannot be trusted is REPORTED, never "no
    // delegates": the two must not look alike.
    let served = match calp::publishers::load_verified(registry, package, &root.root_key) {
        Ok(served) => served,
        Err(e) => return refused(root.root_key, you_are_the_root, e.to_string()),
    };

    let authority = calp::publishers::RootAnchoredPublishers {
        root_key: root.root_key.clone(),
        root_name: root.root_name.clone(),
        root_version: root.root_version.clone(),
        list: served.clone(),
    };
    let check = calp::AnchorGate { profile_dir: profile, scope, policy: calp::AnchorPolicy::CheckOnly };
    match calp::developer_anchor::anchor_root(&check, package, &authority) {
        Ok(_) => {}
        Err(calp::CalpError::PublisherListRolledBack { seen, found, .. }) => {
            let served_co_publishers = served.as_ref().map(|l| co_publisher_infos(profile, l)).unwrap_or_default();
            return CoPublishersResponse {
                rolled_back: Some(RolledBackList { served_revision: found, seen_revision: seen, served_co_publishers }),
                ..refused(
                    root.root_key,
                    you_are_the_root,
                    format!(
                        "The workspace is serving revision {found} of this list, and this computer has \
                         already seen revision {seen}: someone put an older list back, with the creator's \
                         old signature. It is not shown as the current list. Only the creator can repair \
                         it, by writing a new one."
                    ),
                )
            };
        }
        Err(other) => {
            return refused(root.root_key, you_are_the_root, crate::calp_inspector::developer_refusal_text(&other))
        }
    }

    let co_publishers = served.as_ref().map(|l| co_publisher_infos(profile, l)).unwrap_or_default();
    let you_may_publish = you_are_the_root || co_publishers.iter().any(|c| c.is_you);
    CoPublishersResponse {
        package_name: package.to_string(),
        root_key: root.root_key,
        you_are_the_root,
        you_may_publish,
        co_publishers,
        problem: String::new(),
        notice: String::new(),
        rolled_back: None,
    }
}

/// This computer's own publisher key, so a developer can send it to whoever
/// owns the package they want to push to.
///
/// A public key is public: it identifies, it does not authorize. Reading it
/// creates the keypair if this profile has none, exactly as a first publish
/// would — otherwise a developer could not tell anyone their key until after
/// they had published something, which is the wrong way round.
#[tauri::command]
pub fn calp_my_publisher_key(window: tauri::Window) -> Result<CoPublisherInfo, String> {
    crate::security::window_guard::require_label(&window, crate::security::window_guard::MAIN)?;
    let keypair =
        calp::signing::PublisherKeypair::load_or_create(&crate::calp_commands::calcula_profile_dir())
            .map_err(|e| e.to_string())?;
    Ok(CoPublisherInfo {
        key: keypair.public_key_hex(),
        name: keypair.display_name(),
        added_at: String::new(),
        is_you: true,
    })
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SetCoPublishersParams {
    pub registry_path: String,
    pub package_name: String,
    /// The complete list of delegates after this change. Sent whole rather than
    /// as add/remove operations because the artifact IS the whole list — a
    /// partial update read-modify-writes it anyway, and doing that in the UI
    /// would put a second copy of the merge logic there.
    pub co_publishers: Vec<CoPublisherEntry>,
    /// The served revision of a ROLLED-BACK list the creator knowingly
    /// replaces. The editor sets it only after a confirmation that names whom
    /// the served list re-adds; without it -- or naming another revision -- a
    /// change on top of a rolled-back list is refused, because a list built
    /// from what the workspace served would sign the removed back in.
    #[serde(default)]
    pub acknowledged_rolled_back_revision: Option<u64>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CoPublisherEntry {
    pub key: String,
    #[serde(default)]
    pub name: String,
}

/// Replace the co-publisher list. Only the root publisher can.
#[tauri::command]
pub fn calp_set_co_publishers(
    _state: State<AppState>,
    params: SetCoPublishersParams,
    window: tauri::Window,
) -> Result<CoPublishersResponse, String> {
    crate::security::window_guard::require_label(&window, crate::security::window_guard::MAIN)?;
    let (registry, scope) = crate::calp_registry::open_workspace_scoped(&params.registry_path)
        .map_err(|e| e.to_string())?;
    let profile = crate::calp_commands::calcula_profile_dir();

    let notice = set_co_publishers_core(
        registry.as_ref(),
        &scope,
        &profile,
        &params.package_name,
        &params.co_publishers,
        params.acknowledged_rolled_back_revision,
    )?;

    let mut response = calp_list_co_publishers(
        CoPublishersParams {
            registry_path: params.registry_path,
            package_name: params.package_name,
        },
        window,
    )?;
    response.notice = notice;
    Ok(response)
}

/// The revision a newly written co-publisher list gets: one above BOTH the
/// revision the workspace serves and the highest this computer has seen.
///
/// `served + 1` alone let a ROLLED-BACK list lower the revision: restoring
/// revision 3 over 5 and then editing it wrote revision 4, which every machine
/// that had seen 5 would refuse as a rollback -- the creator's own repair would
/// read as the attack it repairs.
pub(crate) fn next_list_revision(served: Option<u64>, mark: u64) -> u64 {
    served.unwrap_or(0).max(mark) + 1
}

/// [`calp_set_co_publishers`] without the window: prove the root, check it
/// against what this computer remembers, write the list at
/// [`next_list_revision`], and raise this computer's mark to it. Returns a
/// notice (empty unless the workspace was serving a rolled-back list).
///
/// A ROLLED-BACK served list is REFUSED unless `acknowledged_rolled_back_revision`
/// names exactly the revision served: the editor builds `entries` from what it
/// was shown, and an editor that started from the rolled-back list would sign
/// everyone that list re-adds back in, at a revision every machine accepts. The
/// listing (`list_co_publishers_core`) shows such a list apart, and the editor
/// acknowledges it only after a confirmation naming whom it re-adds.
pub(crate) fn set_co_publishers_core(
    registry: &dyn calp::transport::WorkspaceTransport,
    scope: &calp::WorkspaceScope,
    profile: &std::path::Path,
    package: &str,
    entries: &[CoPublisherEntry],
    acknowledged_rolled_back_revision: Option<u64>,
) -> Result<String, String> {
    // THE ROOT, proved by its own signature -- never the unsigned version
    // listing, which a share-writer can prepend a first version of their own
    // to. Without its co-publisher list: a list that is tampered or rolled back
    // must not lock the creator out of the only repair there is, replacing it.
    let root = calp::publishers::verified_root(registry, package).map_err(|e| e.to_string())?;

    // Only the root may sign the list. Checked here for a clear message, and
    // again inside `write_signed` — the second check is the one that matters,
    // because it compares the key that will actually do the signing.
    let keypair = calp::signing::PublisherKeypair::load_existing(profile)
        .map_err(|e| e.to_string())?
        .ok_or_else(|| "This computer has no publisher key yet.".to_string())?;
    if keypair.public_key_hex() != root.root_key {
        return Err(format!(
            "Only the publisher who created '{package}' can change who may publish to it."
        ));
    }

    // The list the workspace serves now. One that exists but cannot be trusted
    // is REPLACED -- that is the repair -- and counts as no revision served.
    let served = calp::publishers::load_verified(registry, package, &root.root_key).ok().flatten();
    let authority = calp::publishers::RootAnchoredPublishers {
        root_key: root.root_key.clone(),
        root_name: root.root_name.clone(),
        root_version: root.root_version.clone(),
        list: served.clone(),
    };

    // WHAT THIS COMPUTER REMEMBERS. A root that contradicts it refuses (as at
    // checkout and push). A served list OLDER than the one this computer saw is
    // what the creator may be here to fix -- but only KNOWINGLY: a change whose
    // request does not acknowledge that exact served revision was built from a
    // listing that did not say so, and is refused.
    let record = calp::AnchorGate {
        profile_dir: profile,
        scope,
        policy: calp::AnchorPolicy::RecordOnFirstContact { via: calp::AnchoredBy::PublisherList },
    };
    let (mark, rolled_back_from) = match calp::developer_anchor::anchor_root(&record, package, &authority) {
        Ok(calp::AnchorStatus::FirstContact { recorded }) => (recorded.publishers_revision, None),
        Ok(calp::AnchorStatus::Matches { anchor }) => (anchor.publishers_revision, None),
        Ok(calp::AnchorStatus::NotAnchored) => (0, None),
        Err(calp::CalpError::PublisherListRolledBack { seen, found, .. })
            if acknowledged_rolled_back_revision == Some(found) =>
        {
            (seen, Some(found))
        }
        Err(refused) => return Err(crate::calp_inspector::developer_refusal_text(&refused)),
    };

    let now = chrono::Utc::now().to_rfc3339();
    let mut list = served
        .clone()
        .unwrap_or_else(|| calp::publishers::PublisherList::new(package, &root.root_key, &now));
    // Monotonic on purpose, and never below what this computer has seen: a
    // machine that has seen revision N refuses an older list served back at it,
    // the only defence a dumb file share allows against somebody restoring a
    // list that still has a valid signature.
    list.revision = next_list_revision(served.as_ref().map(|p| p.revision), mark);
    list.updated_at = now.clone();
    list.authorized_keys = entries
        .iter()
        .filter(|entry| !entry.key.trim().is_empty())
        .map(|entry| calp::publishers::AuthorizedKey {
            key: entry.key.trim().to_lowercase(),
            name: entry.name.clone(),
            added_at: now.clone(),
        })
        .collect();

    calp::publishers::write_signed(registry, &list, &keypair).map_err(|e| e.to_string())?;

    // Raise this computer's mark to the revision just written. A raise needs no
    // recording policy -- it is monotonic, and the list verifies under the root.
    let written = calp::publishers::RootAnchoredPublishers {
        list: Some(list.clone()),
        ..authority
    };
    let raise = calp::AnchorGate {
        profile_dir: profile,
        scope,
        policy: calp::AnchorPolicy::CheckOnly,
    };
    calp::developer_anchor::anchor_root(&raise, package, &written)
        .map_err(|e| crate::calp_inspector::developer_refusal_text(&e))?;

    Ok(match rolled_back_from {
        Some(found) => format!(
            "The workspace was serving revision {found} of this list, and this computer had \
             already seen revision {mark}: someone put an older list back. Your list replaces it \
             as revision {}.",
            list.revision
        ),
        None => String::new(),
    })
}
