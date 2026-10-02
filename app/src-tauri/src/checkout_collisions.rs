//! FILENAME: app/src-tauri/src/checkout_collisions.rs
//! PURPOSE: A checkout refuses to open an application whose macro, notebook or
//! defined name has the same identity as one this workbook already holds
//! (BUG-0257 phase 1, owner decision 2026-09-30).
//! CONTEXT: Checkout is ADDITIVE: the application lands beside whatever the
//! workbook already has. For module scripts, notebooks and names that meant a
//! silent choice on every id both sides use -- the materializer keeps the
//! workbook's own (`materialize_distributed_scripts`' preserve-local rule, and
//! "don't clobber a name the user already defined") and drops the
//! application's. The working-copy link, meanwhile, records the application's
//! ids from the INCOMING lists, so the next push's filter
//! (`calp_push_scope::withhold_content_not_in_application`) finds the
//! workbook's same-id item on the application's list and ships it -- the
//! author's own `RATE`, pointing at a sheet the package does not contain, or
//! their private `macro-report`, signed under their key as the application's.
//! And the application's own copy is gone from the next version besides: the
//! same kind of loss as BUG-0257.
//!
//! Neither half can be fixed after the fact: which of two same-id items is "the
//! application's" is not knowable once one of them is dropped. So the checkout
//! refuses, BEFORE its `DocumentEffect` (the workbook is left exactly as it was,
//! not even marked modified), naming every colliding item and whose it is, with
//! the remedy: check the application out into a new workbook (the Open for
//! Editing dialog offers that as a button), or rename or remove the workbook's
//! own item first.
//!
//! ONE EXEMPTION, BY DESIGN: the Custom Functions library record
//! (`CUSTOM_FUNCTIONS_LIB_ID`). Its id is the same in every workbook, and it has
//! its own per-function merge; refusing on it would refuse every application
//! that ships a function.
//!
//! WHAT IS NOT A COLLISION: an item this workbook holds that is stamped with
//! THIS application's name and that no subscription claims -- a leftover of an
//! earlier copy of the same application, which the materializer replaces with
//! the version being opened. A same-named application from ANOTHER workspace
//! that the workbook subscribes to stamps the same name, but its subscription's
//! ledger claims the item, so it is a collision (the materializer would
//! otherwise overwrite that subscription's module in place).
//!
//! A REFUSAL IS A LEVER, so it is recorded. An application can ship a module id
//! that matches a predictable local one (`macro-<slug>`) and block every
//! developer who owns it; the refusal goes to the audit trail with the colliding
//! ids (`AuditEvent::CheckoutRefused`, always recorded), so a repeated block is
//! visible rather than a mystery.

use std::collections::HashMap;

use crate::calp_push_scope::CUSTOM_FUNCTIONS_LIB_ID;

/// What kind of application item collided.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub(crate) enum CollisionKind {
    /// A module script (the macro library's unit; also any standalone module).
    Macro,
    Notebook,
    /// A defined name (Name Manager). Keyed case-insensitively, whatever its
    /// scope -- the name table has one key per name.
    Name,
}

impl CollisionKind {
    fn noun(self) -> &'static str {
        match self {
            CollisionKind::Macro => "macro",
            CollisionKind::Notebook => "notebook",
            CollisionKind::Name => "name",
        }
    }

    /// The provenance-ledger kind a subscription records the item under, which
    /// is also what the audit row calls it.
    fn ledger_kind(self) -> &'static str {
        match self {
            CollisionKind::Macro => "moduleScript",
            CollisionKind::Notebook => "notebook",
            CollisionKind::Name => "namedRange",
        }
    }
}

/// Whose the item already in the workbook is.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum Holder {
    /// The workbook's own: no provenance stamp, no subscription claims it.
    Yours,
    /// Another application's (stamped with it, or claimed by a subscription).
    Application(String),
}

/// One application item whose identity the workbook already uses.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct CheckoutCollision {
    pub(crate) kind: CollisionKind,
    /// The id both sides use (a name's UPPERCASED key).
    pub(crate) id: String,
    /// The display name of the item already in the workbook.
    pub(crate) name: String,
    pub(crate) holder: Holder,
}

impl CheckoutCollision {
    /// The phrase the refusal and the log use: `macro 'Report' (id macro-report,
    /// yours)`.
    fn describe(&self) -> String {
        let whose = match &self.holder {
            Holder::Yours => "yours".to_string(),
            Holder::Application(app) => format!("from application '{app}'"),
        };
        match self.kind {
            CollisionKind::Name => format!("name '{}' ({whose})", self.name),
            _ => format!("{} '{}' (id {}, {whose})", self.kind.noun(), self.name, self.id),
        }
    }
}

/// One item the workbook already holds, reduced to what the question needs.
#[derive(Debug, Clone)]
pub(crate) struct HeldItem {
    pub(crate) id: String,
    pub(crate) name: String,
    /// Provenance stamp (`source_package`); `None` for the workbook's own and
    /// for names, which carry none.
    pub(crate) stamp: Option<String>,
}

/// What the workbook holds of the three kinds, keyed by id (a name by its
/// UPPERCASED key).
#[derive(Debug, Clone, Default)]
pub(crate) struct WorkbookHolds {
    pub(crate) modules: HashMap<String, HeldItem>,
    pub(crate) notebooks: HashMap<String, HeldItem>,
    pub(crate) names: HashMap<String, HeldItem>,
}

impl WorkbookHolds {
    /// Read the three stores, ONE lock at a time -- each is cloned down to ids,
    /// names and stamps and released before the next is taken, so this can
    /// never sit in a lock-order cycle with a writer.
    pub(crate) fn read(
        state: &crate::AppState,
        script_state: &crate::scripting::types::ScriptState,
    ) -> Result<Self, String> {
        let modules = script_state
            .workbook_scripts
            .read()
            .map_err(|e| e.to_string())?
            .values()
            .map(|s| {
                (
                    s.id.clone(),
                    HeldItem { id: s.id.clone(), name: s.name.clone(), stamp: s.source_package.clone() },
                )
            })
            .collect();
        let notebooks = script_state
            .workbook_notebooks
            .read()
            .map_err(|e| e.to_string())?
            .values()
            .map(|n| {
                (
                    n.id.clone(),
                    HeldItem { id: n.id.clone(), name: n.name.clone(), stamp: n.source_package.clone() },
                )
            })
            .collect();
        let names = state
            .named_ranges
            .read()
            .map_err(|e| e.to_string())?
            .iter()
            .map(|(key, nr)| {
                let key = key.to_uppercase();
                (key.clone(), HeldItem { id: key, name: nr.name.clone(), stamp: None })
            })
            .collect();
        Ok(Self { modules, notebooks, names })
    }
}

/// The application being opened, reduced to the ids it carries.
pub(crate) struct Incoming<'a> {
    pub(crate) modules: &'a [persistence::SavedScript],
    pub(crate) notebooks: &'a [persistence::SavedNotebook],
    pub(crate) names: &'a [calp::manifest::PublishedNamedRange],
}

impl<'a> Incoming<'a> {
    pub(crate) fn of(result: &'a calp::pull::PullResult) -> Self {
        Self { modules: &result.module_scripts, notebooks: &result.notebooks, names: &result.named_ranges }
    }
}

/// Is `held` a collision for an application item of `kind`, and whose is it?
/// `None` when it is not a collision: THIS application's own leftover, which
/// the materializer replaces with the version being opened.
fn holder_of(
    kind: CollisionKind,
    held: &HeldItem,
    package_name: &str,
    subscriptions: &[calp::manifest::Subscription],
) -> Option<Holder> {
    // A subscription's ledger is the strongest claim: it names the application
    // the item came from even when its stamp is a name another workspace also
    // uses. (The checkout has already refused a workbook that subscribes to
    // THIS application in THIS workspace, so a claimant here is another one.)
    if let Some(claimant) = subscriptions
        .iter()
        .find(|s| s.objects.iter().any(|o| o.kind == kind.ledger_kind() && o.id == held.id))
    {
        return Some(Holder::Application(claimant.package_name.clone()));
    }
    match held.stamp.as_deref().filter(|s| !s.is_empty()) {
        None => Some(Holder::Yours),
        Some(stamp) if stamp == package_name => None,
        Some(stamp) => Some(Holder::Application(stamp.to_string())),
    }
}

/// Every application item whose id this workbook already uses, in a stable
/// order (kind, then id). Pure over plain data.
pub(crate) fn find_checkout_collisions(
    package_name: &str,
    incoming: &Incoming<'_>,
    holds: &WorkbookHolds,
    subscriptions: &[calp::manifest::Subscription],
) -> Vec<CheckoutCollision> {
    let mut found: Vec<CheckoutCollision> = Vec::new();
    let mut check = |kind: CollisionKind, id: &str, held: Option<&HeldItem>| {
        let Some(held) = held else { return };
        if let Some(holder) = holder_of(kind, held, package_name, subscriptions) {
            found.push(CheckoutCollision { kind, id: id.to_string(), name: held.name.clone(), holder });
        }
    };
    for module in incoming.modules {
        // The one id that collides BY DESIGN: the Custom Functions library is
        // merged per function, never replaced or skipped whole.
        if module.id == CUSTOM_FUNCTIONS_LIB_ID {
            continue;
        }
        check(CollisionKind::Macro, &module.id, holds.modules.get(&module.id));
    }
    for notebook in incoming.notebooks {
        check(CollisionKind::Notebook, &notebook.id, holds.notebooks.get(&notebook.id));
    }
    for name in incoming.names {
        let key = name.name.to_uppercase();
        check(CollisionKind::Name, &key, holds.names.get(&key));
    }
    found.sort_by(|a, b| a.kind.cmp(&b.kind).then_with(|| a.id.cmp(&b.id)));
    found.dedup_by(|a, b| a.kind == b.kind && a.id == b.id);
    found
}

/// The machine-readable prefix the Open for Editing dialog keys its remedy on.
pub(crate) const CHECKOUT_COLLISION_CODE: &str = "CALP_CHECKOUT_COLLISION";

/// How many items the refusal lists by name before it says "and N more".
const LISTED: usize = 8;

/// The refusal: names every colliding item (up to `LISTED`) and whose it is,
/// says what opening it here would do, and names the remedy.
pub(crate) fn collision_refusal(package_name: &str, collisions: &[CheckoutCollision]) -> String {
    let mut listed: Vec<String> = collisions.iter().take(LISTED).map(CheckoutCollision::describe).collect();
    if collisions.len() > LISTED {
        listed.push(format!("and {} more", collisions.len() - LISTED));
    }
    let (items, them) = if collisions.len() == 1 { ("an item", "it") } else { ("items", "them") };
    format!(
        "{CHECKOUT_COLLISION_CODE}: '{package_name}' was not opened for editing. This workbook \
         already has {items} with the same identity as the application's own: {}. Opened here, \
         the workbook's copy would be kept and the application's dropped -- and your next push \
         would publish the workbook's copy as part of '{package_name}'. Check the application out into \
         a new workbook instead (Open Application for Editing offers it), or rename or remove {them} \
         in this workbook first.",
        listed.join("; ")
    )
}

/// The checkout's gate. Reads what the workbook holds, and when anything the
/// application carries collides: records the refusal (always, with the ids in
/// `extra`) and returns the refusal text. Writes NOTHING else, so a caller that
/// runs it before its `DocumentEffect` leaves the workbook exactly as it was.
pub(crate) fn refuse_checkout_collisions(
    state: &crate::AppState,
    script_state: &crate::scripting::types::ScriptState,
    package_name: &str,
    result: &calp::pull::PullResult,
) -> Result<(), String> {
    let holds = WorkbookHolds::read(state, script_state)?;
    let subscriptions: Vec<calp::manifest::Subscription> =
        state.subscriptions.read().map_err(|e| e.to_string())?.subscriptions.clone();
    let collisions = find_checkout_collisions(package_name, &Incoming::of(result), &holds, &subscriptions);
    if collisions.is_empty() {
        return Ok(());
    }

    let version = result.resolved_version.to_string();
    let ids: Vec<String> =
        collisions.iter().map(|c| format!("{}:{}", c.kind.ledger_kind(), c.id)).collect();
    crate::log_warn!(
        "CALP",
        "checkout of '{}' v{} refused: {} id collision(s): {}",
        package_name,
        version,
        collisions.len(),
        ids.join(", ")
    );
    let mut extra: HashMap<String, serde_json::Value> = HashMap::new();
    extra.insert("application".to_string(), serde_json::Value::String(package_name.to_string()));
    extra.insert("version".to_string(), serde_json::Value::String(version.clone()));
    extra.insert(
        "collisions".to_string(),
        serde_json::Value::Array(
            collisions
                .iter()
                .map(|c| {
                    serde_json::json!({
                        "kind": c.kind.ledger_kind(),
                        "id": c.id,
                        "holder": match &c.holder {
                            Holder::Yours => String::new(),
                            Holder::Application(app) => app.clone(),
                        },
                    })
                })
                .collect(),
        ),
    );
    crate::calp_commands::record_audit_event_with_extra(
        state,
        calp::audit::AuditEvent::CheckoutRefused,
        format!(
            "Checkout of '{}' v{} refused: {} item(s) with the same id as the workbook's own ({})",
            package_name,
            version,
            collisions.len(),
            ids.join(", ")
        ),
        extra,
    );
    Err(collision_refusal(package_name, &collisions))
}

#[cfg(test)]
#[path = "checkout_collisions_tests.rs"]
mod tests;
