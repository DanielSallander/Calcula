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
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CoPublishersParams {
    pub registry_path: String,
    pub package_name: String,
}

/// Who may publish this package.
#[tauri::command]
pub fn calp_list_co_publishers(
    params: CoPublishersParams,
    window: tauri::Window,
) -> Result<CoPublishersResponse, String> {
    crate::security::window_guard::require_label(&window, crate::security::window_guard::MAIN)?;
    let (registry, _scope) = crate::calp_registry::open_registry_scoped(&params.registry_path)
        .map_err(|e| e.to_string())?;
    let profile = crate::calp_commands::calcula_profile_dir();

    let root_key =
        calp::publishers::root_key_of(&registry, &params.package_name).map_err(|e| e.to_string())?;
    let Some(root_key) = root_key else {
        return Ok(CoPublishersResponse {
            package_name: params.package_name,
            root_key: String::new(),
            you_are_the_root: false,
            you_may_publish: false,
            co_publishers: Vec::new(),
            problem: "This package has no signed versions yet, so there is nobody to \
                      authorize on its behalf."
                .to_string(),
        });
    };

    let you_are_the_root =
        calp::signing::profile_holds_publisher_key(&profile, &root_key).unwrap_or(false);

    let (co_publishers, problem) =
        match calp::publishers::load_verified(&registry, &params.package_name, &root_key) {
            Ok(Some(list)) => (
                list.authorized_keys
                    .iter()
                    .map(|entry| CoPublisherInfo {
                        is_you: calp::signing::profile_holds_publisher_key(&profile, &entry.key)
                            .unwrap_or(false),
                        key: entry.key.clone(),
                        name: entry.name.clone(),
                        added_at: entry.added_at.clone(),
                    })
                    .collect(),
                String::new(),
            ),
            Ok(None) => (Vec::new(), String::new()),
            Err(e) => (Vec::new(), e.to_string()),
        };

    let you_may_publish =
        you_are_the_root || co_publishers.iter().any(|c| c.is_you);

    Ok(CoPublishersResponse {
        package_name: params.package_name,
        root_key,
        you_are_the_root,
        you_may_publish,
        co_publishers,
        problem,
    })
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
    let (registry, _scope) = crate::calp_registry::open_registry_scoped(&params.registry_path)
        .map_err(|e| e.to_string())?;
    let profile = crate::calp_commands::calcula_profile_dir();

    let root_key = calp::publishers::root_key_of(&registry, &params.package_name)
        .map_err(|e| e.to_string())?
        .ok_or_else(|| {
            format!(
                "'{}' has no signed versions, so there is nobody to authorize on its \
                 behalf yet.",
                params.package_name
            )
        })?;

    // Only the root may sign the list. Checked here for a clear message, and
    // again inside `write_signed` — the second check is the one that matters,
    // because it compares the key that will actually do the signing.
    let keypair = calp::signing::PublisherKeypair::load_existing(&profile)
        .map_err(|e| e.to_string())?
        .ok_or_else(|| "This computer has no publisher key yet.".to_string())?;
    if keypair.public_key_hex() != root_key {
        return Err(format!(
            "Only the publisher who created '{}' can change who may publish to it.",
            params.package_name
        ));
    }

    let now = chrono::Utc::now().to_rfc3339();

    // Read-modify-write so `revision` climbs. It is monotonic on purpose: a
    // client that has seen revision N can notice an older list being served
    // back at it, which is the only defence a dumb file share allows against
    // somebody restoring a list that still has a valid signature.
    let previous =
        calp::publishers::load_verified(&registry, &params.package_name, &root_key).ok().flatten();
    let mut list = previous
        .clone()
        .unwrap_or_else(|| calp::publishers::PublisherList::new(&params.package_name, &root_key, &now));
    list.revision = previous.map(|p| p.revision + 1).unwrap_or(1);
    list.updated_at = now.clone();
    list.authorized_keys = params
        .co_publishers
        .iter()
        .filter(|entry| !entry.key.trim().is_empty())
        .map(|entry| calp::publishers::AuthorizedKey {
            key: entry.key.trim().to_lowercase(),
            name: entry.name.clone(),
            added_at: now.clone(),
        })
        .collect();

    calp::publishers::write_signed(&registry, &list, &keypair).map_err(|e| e.to_string())?;

    calp_list_co_publishers(
        CoPublishersParams {
            registry_path: params.registry_path,
            package_name: params.package_name,
        },
        window,
    )
}
