//! FILENAME: app/src-tauri/src/calp_push_scope.rs
//! PURPOSE: What a push may carry: THIS application's content, and nothing that
//! belongs to the author privately or to another application (BUG-0261).
//! CONTEXT: `publish()` reads an absent list as "everything in the workbook",
//! which was harmless while checkout REPLACED the document. Additive checkout
//! ended that: a working copy holds the author's own content AND whatever its
//! other SUBSCRIPTIONS brought in, beside the application's. Everything a push
//! carries is checksummed and Ed25519-signed under the PUSHER's key, and every
//! subscriber pinned to that key (or to a root that lists it) accepts it as the
//! application's.
//!
//! Module scripts, notebooks and names were already filtered against the
//! working-copy link's record of the base version. Three routes were not, and
//! each re-signed somebody else's code under the developer's key:
//!
//!   * OBJECT SCRIPTS. Every object script in the workbook shipped, including
//!     the `Distributed` scripts of any OTHER application the workbook subscribes
//!     to. Core publish scrubs provenance, so they reached this application's
//!     subscribers as this application's code.
//!   * THE CUSTOM FUNCTIONS LIBRARY. One reserved record, merged PER FUNCTION on
//!     every pull, so it holds the author's own functions beside every
//!     application's. It shipped whole whenever the application had a library.
//!   * PANE CONTROLS, and their `pane-{id}` object scripts: workbook-scoped, no
//!     base filter at all.
//!
//! The rule: a push keeps THIS application's content and withholds everything
//! else. "This application's" is either stamped with its name (while the
//! workbook holds it), or the author's own unstamped content that the base
//! version already carried -- module scripts, notebooks, names, pane controls
//! and custom functions are measured against the working-copy link's record of
//! the base; the author's own LOCAL object scripts ship with their host (a
//! script bound to a button or chart on a sheet the push leaves behind stays
//! behind with it). A standalone
//! workbook's first publish has no record, so everything of the author's ships
//! and becomes the record. What a push withholds is returned, named, so the push
//! report can SAY so -- a withheld item used to be a log line only, which is a
//! silent drop to the person pushing.
//!
//! "This application" is a provenance stamp compared by NAME, because that is
//! all a stamp carries. Two things narrow it back to the application: the stamp
//! only counts when the workbook HOLDS this workspace's application of that name
//! (its working-copy link targets it, or -- for a subscriber's "view changes"
//! diff, which runs this same assembly -- it subscribes to it; a real push from
//! a subscriber is refused before assembly), and a stamped item that ANOTHER
//! subscription's ledger claims is that subscription's, even when the two
//! applications share a name.
//!
//! Pure over plain data so it can be tested by behaviour. The one door that
//! calls it is `assemble_publish_workbook` (publish, the dry-run preview, the
//! working-copy and subscriber diffs and the push merge all go through that
//! door), which reads the link and the subscriptions under their own short
//! locks and hands them in.
//!
//! # "Include in application" (M4)
//!
//! A macro, notebook or workbook name the author creates IN a working copy is
//! theirs and the application never had it, so the rule above withholds it --
//! and a button linked to that new macro then ships dead. The push dialog can
//! therefore ADD such an item to the application: the author opens its code,
//! ticks "Include in application", and the request names it as
//! [`IncludedItem`] `{kind, id, hash}`. The item is kept only when all three
//! match what the carrier holds NOW -- the hash is computed HERE, in Rust, over
//! the exact text the dialog showed ([`WithheldContent::code`]), so code that
//! changed after it was read is withheld again rather than shipped under the
//! author's key unread. Another application's code, the Custom Functions
//! record and reserved (`__calcula_`) ids are never includable, whatever a
//! request says. Once a push ships an included item, the working-copy link
//! records it like any other shipped content, so the next push keeps it without
//! a tick.

use serde::{Deserialize, Serialize};

/// The reserved module-script id under which the Custom Functions (JS UDF)
/// library is persisted as JSON data. Mirrors `PERSIST_SCRIPT_ID` in
/// `@api/customFunctions.ts`; `calp_commands::CUSTOM_FUNCTIONS_LIB_ID` is this.
pub(crate) const CUSTOM_FUNCTIONS_LIB_ID: &str = "__calcula_custom_functions__";

/// What kind of thing a push left behind.
///
/// `Deserialize` because an [`IncludedItem`] names one on the wire. Only
/// [`WithheldKind::ModuleScript`], [`WithheldKind::Notebook`] and
/// [`WithheldKind::NamedRange`] can be included today (see
/// [`is_includable_kind`]); a pane control or a custom function joins by being
/// added there, never by a request naming it.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum WithheldKind {
    ObjectScript,
    ModuleScript,
    CustomFunction,
    Notebook,
    PaneControl,
    NamedRange,
}

/// Why a push left it behind.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum WithheldReason {
    /// Your own, and the application never had it. It stays in this workbook.
    NotInApplication,
    /// Another application's: it arrived through a subscription (or a working
    /// copy of a different application). Publishing it here would sign that
    /// application's code under your key.
    OtherApplication,
}

/// One item a push (or its preview) withheld, named so the push report can
/// show it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WithheldContent {
    pub kind: WithheldKind,
    pub id: String,
    pub name: String,
    pub reason: WithheldReason,
    /// The application it belongs to, for `OtherApplication`. Empty for your
    /// own content (and when a distributed item carries no application name).
    pub owner: String,
    /// The push dialog may ADD it to the application ("Include in
    /// application"): your own module script, notebook or workbook name, never
    /// another application's, the Custom Functions record or a reserved id.
    pub includable: bool,
    /// sha256 of [`Self::code`]'s text for your own module script, notebook or
    /// name (empty otherwise). What an [`IncludedItem`] must name for the item
    /// to ship: computed here, never by the page.
    pub content_hash: String,
    /// The exact text `content_hash` covers, for an includable item (empty
    /// otherwise): a module's source, a notebook's cell sources as a JSON array
    /// in order, a name's `refers_to`. The dialog shows THIS before it lets the
    /// author tick it -- nothing ships under their key that was not on screen.
    pub code: String,
    /// A caveat the author should read before including it. For a name whose
    /// `refers_to` names a sheet this push does not publish, which would reach a
    /// subscriber pointing at nothing -- or at a sheet of theirs with that name.
    pub detail: String,
}

impl WithheldContent {
    fn new(kind: WithheldKind, id: &str, name: &str, owner: Option<String>) -> Self {
        let (reason, owner) = match owner {
            Some(owner) => (WithheldReason::OtherApplication, owner),
            None => (WithheldReason::NotInApplication, String::new()),
        };
        Self {
            kind,
            id: id.to_string(),
            name: name.to_string(),
            reason,
            owner,
            includable: false,
            content_hash: String::new(),
            code: String::new(),
            detail: String::new(),
        }
    }

    /// Your OWN module script, notebook or name the application never had,
    /// hashed over `code` -- the one constructor that can make an item
    /// includable, and only for an includable kind and id.
    fn yours(kind: WithheldKind, id: &str, name: &str, code: &str, detail: String) -> Self {
        let includable = is_includable_kind(kind) && !is_never_includable_id(id);
        Self {
            includable,
            content_hash: content_hash(code),
            code: if includable { code.to_string() } else { String::new() },
            detail,
            ..Self::new(kind, id, name, None)
        }
    }

    /// The one-line form the log keeps.
    pub(crate) fn describe(&self) -> String {
        let kind = match self.kind {
            WithheldKind::ObjectScript => "object script",
            WithheldKind::ModuleScript => "script",
            WithheldKind::CustomFunction => "custom function",
            WithheldKind::Notebook => "notebook",
            WithheldKind::PaneControl => "pane control",
            WithheldKind::NamedRange => "name",
        };
        match self.reason {
            WithheldReason::NotInApplication => format!("{kind} '{}'", self.name),
            WithheldReason::OtherApplication if self.owner.is_empty() => {
                format!("{kind} '{}' (another application's)", self.name)
            }
            WithheldReason::OtherApplication => {
                format!("{kind} '{}' (application '{}')", self.name, self.owner)
            }
        }
    }
}

/// The kinds the push dialog can add to an application today.
pub(crate) fn is_includable_kind(kind: WithheldKind) -> bool {
    matches!(kind, WithheldKind::ModuleScript | WithheldKind::Notebook | WithheldKind::NamedRange)
}

/// Ids that can never be added, whatever a request says: the Custom Functions
/// record (one merged library, filtered per function -- including it whole
/// would publish every function in it) and every reserved internal record.
fn is_never_includable_id(id: &str) -> bool {
    id == CUSTOM_FUNCTIONS_LIB_ID || crate::scripting::commands::is_reserved_script_id(id)
}

/// The identity of an item's content: sha256 over its canonical text.
pub(crate) fn content_hash(code: &str) -> String {
    calp::integrity::sha256_hex(code.as_bytes())
}

/// A notebook's canonical text: its cells' sources as a JSON array, in order.
/// Execution output never ships (core publish strips it), so it is not part of
/// what the author reviews.
pub(crate) fn notebook_code(notebook: &persistence::SavedNotebook) -> String {
    let sources: Vec<&str> = notebook.cells.iter().map(|c| c.source.as_str()).collect();
    serde_json::to_string(&sources).unwrap_or_default()
}

/// One item the author asked a push to ADD to the application, naming the
/// content hash the dialog showed ("Include in application"). Only the push
/// dialog fills these, with the code on screen; the scripted publish never
/// forwards one (`collaboration_gateway`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IncludedItem {
    pub kind: WithheldKind,
    pub id: String,
    pub hash: String,
}

impl IncludedItem {
    /// Does this request name `item` -- the same kind and id? A workbook name
    /// is matched ignoring case, as every name comparison is.
    fn names(&self, item: &WithheldContent) -> bool {
        self.kind == item.kind
            && match item.kind {
                WithheldKind::NamedRange => self.id.to_uppercase() == item.id.to_uppercase(),
                _ => self.id == item.id,
            }
    }
}

/// What the filter decided: what stays in the workbook, and what it kept only
/// because the request included it.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub(crate) struct PushContent {
    pub(crate) withheld: Vec<WithheldContent>,
    /// Your own items the request INCLUDED -- they ship, under your key, and
    /// the push report names them as "Added to the application".
    pub(crate) added: Vec<WithheldContent>,
}

/// Everything the filter needs to know about WHICH application is being
/// pushed, read by the caller from live state.
pub(crate) struct PushScope<'a> {
    pub(crate) registry_path: &'a str,
    pub(crate) package_name: &'a str,
    pub(crate) link: Option<&'a calp::WorkingCopyLink>,
    pub(crate) subscriptions: &'a [calp::manifest::Subscription],
    /// The WORKBOOK indices of the sheets this push publishes -- the same list
    /// the assembly was given. An object script bound to something on any other
    /// sheet has no host in the application.
    pub(crate) published_sheets: &'a [usize],
    /// What the push request asked to ADD ("Include in application"). Empty
    /// for every caller but the push dialog's publish, preview and diff.
    pub(crate) included: &'a [IncludedItem],
}

impl PushScope<'_> {
    /// Does the request include `item` AS IT IS NOW? The item must be
    /// includable and the request must name its kind, id AND current hash: a
    /// tick given to code that changed since is not a tick for this code.
    fn includes(&self, item: &WithheldContent) -> bool {
        item.includable
            && self
                .included
                .iter()
                .any(|i| i.names(item) && i.hash == item.content_hash)
    }

    /// The working-copy link, only when it targets the application being pushed.
    /// A link belongs to ONE application; creating a new one from the same
    /// workbook must not be filtered against -- or borrow -- its record.
    fn link_for_this_application(&self) -> Option<&calp::WorkingCopyLink> {
        self.link
            .filter(|l| l.targets(self.registry_path, self.package_name))
    }

    /// Is `s` the workbook's subscription to THIS application (same name, same
    /// workspace)?
    ///
    /// A real push from such a workbook is refused before it assembles anything
    /// (`CALP_PUSH_IS_SUBSCRIBER`), so this never lets a subscriber publish. It
    /// matters for the OTHER callers of the assembly: a subscriber's "view
    /// changes" diff runs this very assembly against the application it
    /// subscribes to, and treating that application's own scripts as foreign
    /// would report every one of them REMOVED -- a change the reset never makes.
    fn is_this_applications_subscription(&self, s: &calp::manifest::Subscription) -> bool {
        s.package_name == self.package_name && calp::same_workspace(&s.registry_url, self.registry_path)
    }

    /// Does this workbook hold THIS application at all -- as its working copy,
    /// or as a subscription? Only then can a stamp naming it be its content.
    fn holds_this_application(&self) -> bool {
        self.link_for_this_application().is_some()
            || self
                .subscriptions
                .iter()
                .any(|s| self.is_this_applications_subscription(s))
    }

    /// The owner of an item that carries a provenance stamp, or `None` when the
    /// item is YOURS or THIS application's (i.e. may ship).
    ///
    /// `stamp` is the application name the item was pulled from; empty means it
    /// carries no stamp and is the author's own. A stamped item is this
    /// application's only when the stamp names it AND the workbook holds this
    /// application AND no OTHER subscription's ledger claims the item -- a
    /// subscription to a same-named application in another workspace stamps the
    /// same name.
    fn foreign_owner(&self, ledger_kind: &str, id: &str, stamp: &str) -> Option<String> {
        if stamp.is_empty() {
            return None;
        }
        if let Some(claimant) = self.subscription_claiming(ledger_kind, id) {
            return if self.is_this_applications_subscription(claimant) {
                None
            } else {
                Some(claimant.package_name.clone())
            };
        }
        if stamp == self.package_name && self.holds_this_application() {
            return None;
        }
        Some(stamp.to_string())
    }

    /// The subscription whose provenance ledger lists this object, if any.
    fn subscription_claiming(
        &self,
        ledger_kind: &str,
        id: &str,
    ) -> Option<&calp::manifest::Subscription> {
        self.subscriptions
            .iter()
            .find(|s| s.objects.iter().any(|o| o.kind == ledger_kind && o.id == id))
    }

    /// The application a subscription-claimed object belongs to, or `None` when
    /// no subscription claims it or the claimant is THIS application.
    fn foreign_claimant(&self, ledger_kind: &str, id: &str) -> Option<String> {
        self.subscription_claiming(ledger_kind, id)
            .filter(|s| !self.is_this_applications_subscription(s))
            .map(|s| s.package_name.clone())
    }
}

/// Remove from the publish carrier everything that is not this application's
/// or the author's own-and-part-of-the-application, and return what was removed
/// -- and what the request's "Include in application" kept (`added`).
///
/// `object_scripts` is the request's explicit list and `workbook.object_scripts`
/// the carrier's own (which a `None` list falls back to); both get the SAME rule
/// so the two cannot disagree about what ships.
pub(crate) fn withhold_content_not_in_application(
    workbook: &mut persistence::Workbook,
    object_scripts: &mut Option<Vec<persistence::SavedObjectScript>>,
    scope: &PushScope<'_>,
) -> PushContent {
    let mut withheld: Vec<WithheldContent> = Vec::new();
    let mut added: Vec<WithheldContent> = Vec::new();
    let link = scope.link_for_this_application();
    // YOUR OWN item the application never had: withheld -- unless the request
    // includes it as it is now, in which case it ships and is named as added.
    // Returns whether it stays on the carrier.
    let mut yours = |item: WithheldContent, withheld: &mut Vec<WithheldContent>| -> bool {
        if scope.includes(&item) {
            added.push(item);
            return true;
        }
        withheld.push(item);
        false
    };

    // ---- Module scripts and notebooks -------------------------------------
    //
    // ANOTHER APPLICATION'S are withheld always: a module stamped with a
    // different application (or claimed by a subscription) is that
    // application's code, working copy or not.
    //
    // YOUR OWN are withheld only when the application never had them. The link
    // records what the base version carried, the same job `base_sheets` does for
    // the tick list.
    //
    // A link RECORDS every list (`record_content` / `record_push`), so an
    // EMPTY list means "the application has none", and the author's private
    // module -- the one holding an API token -- stays home even from an
    // application with no scripts at all.
    //
    // There is NO fallback for a link written before the record existed: it
    // used to publish everything, which is the leak this filter exists to
    // close, and the product has no backward-compatibility promise to keep
    // (CLAUDE.md). A real push from such a link is refused in `calp_publish`
    // (`CALP_PUSH_LINK_UNRECORDED`, with the remedy); here -- where the dry-run
    // preview and the diffs run too -- its missing lists read as empty, so the
    // preview shows exactly what such a push would leave behind.
    let base_ids_recorded = link.is_some();
    let keep_scripts: std::collections::HashSet<&str> = link
        .map(|l| l.base_script_ids.iter().map(|s| s.as_str()).collect())
        .unwrap_or_default();
    let keep_notebooks: std::collections::HashSet<&str> = link
        .map(|l| l.base_notebook_ids.iter().map(|s| s.as_str()).collect())
        .unwrap_or_default();

    workbook.scripts.retain_mut(|s| {
        if s.id == CUSTOM_FUNCTIONS_LIB_ID {
            // Subscriber-owned by construction (the merge keeps its record stamp
            // empty), so the question is asked PER FUNCTION instead.
            if base_ids_recorded && !keep_scripts.contains(s.id.as_str()) {
                // The application never had a library: none of these functions
                // is its code. Named one by one -- "Custom Functions (data)" says
                // nothing about which of your functions stayed home.
                withheld.extend(withhold_whole_function_library(&s.source));
                return false;
            }
            return filter_custom_function_library(&mut s.source, scope, &mut withheld);
        }
        let stamp = s.source_package.as_deref().unwrap_or("");
        if let Some(owner) = scope.foreign_owner("moduleScript", &s.id, stamp) {
            withheld.push(WithheldContent::new(WithheldKind::ModuleScript, &s.id, &s.name, Some(owner)));
            return false;
        }
        if base_ids_recorded && !keep_scripts.contains(s.id.as_str()) {
            let item = WithheldContent::yours(WithheldKind::ModuleScript, &s.id, &s.name, &s.source, String::new());
            return yours(item, &mut withheld);
        }
        true
    });

    workbook.notebooks.retain(|n| {
        let stamp = n.source_package.as_deref().unwrap_or("");
        if let Some(owner) = scope.foreign_owner("notebook", &n.id, stamp) {
            withheld.push(WithheldContent::new(WithheldKind::Notebook, &n.id, &n.name, Some(owner)));
            return false;
        }
        if base_ids_recorded && !keep_notebooks.contains(n.id.as_str()) {
            let item =
                WithheldContent::yours(WithheldKind::Notebook, &n.id, &n.name, &notebook_code(n), String::new());
            return yours(item, &mut withheld);
        }
        true
    });

    // ---- Named ranges ------------------------------------------------------
    //
    // The author's own workbook-scoped names stay home unless the base version
    // carried a name with that key.
    //
    // THIS FILTER CANNOT TELL TWO SAME-KEY NAMES APART, and neither can the
    // module and notebook filters above: they keep by KEY. A pull is ADDITIVE,
    // so an application whose `RATE` (or `macro-report`, or notebook) shares an
    // id with the author's own used to be silently DROPPED at checkout while
    // the link recorded the key as the application's -- and the author's `RATE`,
    // pointing at a sheet the package does not contain, then passed this filter
    // and shipped as the application's. That is closed at the door, not here:
    // `calp_checkout` refuses such a checkout before anything is written
    // (`checkout_collisions::refuse_checkout_collisions`, BUG-0264), so a link
    // this build writes never records a key the workbook's own item holds.
    //
    // Only workbook-scoped names are filtered here: a SHEET-scoped name rides
    // with its sheet, and the sheet selection already decides whether that sheet
    // ships at all.
    if let Some(link) = link {
        {
            let keep_names: std::collections::HashSet<String> = link
                .base_named_range_keys
                .iter()
                .map(|k| k.to_uppercase())
                .collect();
            // The sheets this push leaves behind, for a name's caveat.
            let published: std::collections::HashSet<usize> = scope.published_sheets.iter().copied().collect();
            let unpublished_sheets: Vec<String> = workbook
                .sheets
                .iter()
                .enumerate()
                .filter(|(i, _)| !published.contains(i))
                .map(|(_, s)| s.name.clone())
                .collect();
            workbook.named_ranges.retain(|nr| {
                if nr.sheet_id.is_some() {
                    return true;
                }
                // ANOTHER APPLICATION'S NAME -- one a subscription's pull
                // ledgered (by the uppercased key) -- is that application's,
                // LAMBDAs included: withheld as such, and never includable.
                // Asked FIRST, as for a pane control: a name carries no stamp
                // of its own, so the ledger is the only thing that can tell an
                // imported name from one the author wrote, and "Include in
                // application" would otherwise re-sign it under the author's key.
                if let Some(owner) = scope.foreign_claimant("namedRange", &nr.name.to_uppercase()) {
                    withheld.push(WithheldContent::new(WithheldKind::NamedRange, &nr.name, &nr.name, Some(owner)));
                    return false;
                }
                let keep = keep_names.contains(&nr.name.to_uppercase());
                if keep {
                    return true;
                }
                let detail = unpublished_sheet_caveat(&nr.refers_to, &unpublished_sheets);
                let item = WithheldContent::yours(WithheldKind::NamedRange, &nr.name, &nr.name, &nr.refers_to, detail);
                yours(item, &mut withheld)
            });
        }
    }

    // ---- Pane controls -----------------------------------------------------
    //
    // Workbook-scoped, so an additive checkout leaves the author's own -- and
    // any a subscription brought in -- beside the application's. A control a
    // subscription's ledger claims is that application's; one the base version
    // did not carry is the author's. A link that lacks the record (`None`, from
    // before it existed) reads as "the application had none" -- see above.
    let base_pane_ids: Option<std::collections::HashSet<&str>> = link.map(|l| {
        l.base_pane_control_ids
            .iter()
            .flatten()
            .map(|s| s.as_str())
            .collect()
    });
    // "pane-{id}" of every control that stayed behind, so the control's object
    // script follows it: a script shipped without its control is a host-less
    // script in every subscriber's workbook.
    let mut withheld_pane_hosts: std::collections::HashSet<String> =
        std::collections::HashSet::new();
    workbook.pane_controls.retain(|pc| {
        let id = pc.id.to_string();
        let owner = scope.foreign_claimant("paneControl", &id);
        let keep = owner.is_none()
            && base_pane_ids.as_ref().map_or(true, |base| base.contains(id.as_str()));
        if !keep {
            withheld_pane_hosts.insert(format!("pane-{id}"));
            withheld.push(WithheldContent::new(WithheldKind::PaneControl, &id, &pc.name, owner));
        }
        keep
    });

    // ---- Object scripts ----------------------------------------------------
    //
    // LOCAL scripts are the author's and ship -- as part of the application, so
    // only when what they are bound to ships too: a pane control that stayed
    // behind, or an object on a sheet this push does not carry. Additive
    // checkout leaves the author's private sheets beside the application's, and
    // their buttons' and charts' scripts used to ship HOST-LESS into every
    // subscriber's version, signed under the author's key -- BUG-0261's own leak
    // (a private script holding an API token) through the object-script channel.
    // DISTRIBUTED scripts ship only when they are this application's. Core
    // publish scrubs provenance, so anything that got past here would reach
    // subscribers indistinguishable from this application's code.
    let left_behind_hosts = hosts_on_unpublished_sheets(workbook, scope.published_sheets);
    //
    // The verdict: `None` ships; `Some(owner)` is withheld, `owner` being the
    // application it belongs to (`None` = it is yours).
    let object_script_verdict = |s: &persistence::SavedObjectScript| -> Option<Option<String>> {
        match s.provenance {
            persistence::ScriptProvenance::Distributed => {
                let stamp = s.package_name.as_deref().unwrap_or("");
                if stamp.is_empty() {
                    // Distributed with no application named: only THIS
                    // application's own subscription ledger can vouch for it.
                    match scope.subscription_claiming("objectScript", &s.id) {
                        Some(claimant) if scope.is_this_applications_subscription(claimant) => None,
                        Some(claimant) => Some(Some(claimant.package_name.clone())),
                        None => Some(Some(String::new())),
                    }
                } else {
                    scope.foreign_owner("objectScript", &s.id, stamp).map(Some)
                }
            }
            // Yours. It stays home with the pane control it is bound to, and
            // with an object on a sheet this push leaves behind.
            persistence::ScriptProvenance::Local => s
                .instance_id
                .as_deref()
                .filter(|instance| {
                    withheld_pane_hosts.contains(*instance)
                        || left_behind_hosts.is_left_behind(&s.object_type, instance)
                })
                .map(|_| None),
        }
    };
    let mut reported: std::collections::HashSet<String> = std::collections::HashSet::new();
    let mut object_script_rule =
        |s: &persistence::SavedObjectScript, withheld: &mut Vec<WithheldContent>| -> bool {
            match object_script_verdict(s) {
                None => true,
                Some(owner) => {
                    // Both copies go through here; report each script once.
                    if reported.insert(s.id.clone()) {
                        withheld.push(WithheldContent::new(
                            WithheldKind::ObjectScript,
                            &s.id,
                            &s.name,
                            owner,
                        ));
                    }
                    false
                }
            }
        };
    if let Some(list) = object_scripts.as_mut() {
        list.retain(|s| object_script_rule(s, &mut withheld));
    }
    workbook
        .object_scripts
        .retain(|s| object_script_rule(s, &mut withheld));

    let by_kind_and_name = |a: &WithheldContent, b: &WithheldContent| {
        a.kind
            .cmp(&b.kind)
            .then_with(|| a.name.cmp(&b.name))
            .then_with(|| a.id.cmp(&b.id))
    };
    withheld.sort_by(by_kind_and_name);
    added.sort_by(by_kind_and_name);
    PushContent { withheld, added }
}

/// The caveat for including a workbook name whose `refers_to` names a sheet
/// this push leaves behind, or empty. Every sheet reference is found through
/// the one parser (`SheetRenames` marks a GONE sheet's references), never by
/// matching text, so `'My notes'!A1` and `MY NOTES!A1` are one sheet.
fn unpublished_sheet_caveat(refers_to: &str, unpublished_sheets: &[String]) -> String {
    let named: Vec<&str> = unpublished_sheets
        .iter()
        .filter(|sheet| {
            calp::sheet_renames::SheetRenames::new(std::iter::empty::<(&str, &str)>())
                .with_gone([sheet.as_str()])
                .rename_formula(refers_to)
                .is_some()
        })
        .map(String::as_str)
        .collect();
    if named.is_empty() {
        return String::new();
    }
    format!(
        "It refers to {}, which this push does not publish: on a subscriber's computer the name \
         would point at nothing, or at a sheet of their own with that name.",
        named.iter().map(|s| format!("'{s}'")).collect::<Vec<_>>().join(", ")
    )
}

/// One "Include in application" the push would NOT honour, and why.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct UnhonouredInclusion {
    pub(crate) item: IncludedItem,
    /// The item's display name when the workbook still holds it, else its id.
    pub(crate) name: String,
    pub(crate) why: String,
}

/// Every requested inclusion the filtered carrier does not carry EXACTLY as the
/// author reviewed it -- the kind, the id AND the hash they were shown.
///
/// The filter already keeps only a hash-exact match ([`PushScope::includes`]),
/// so a changed item stays withheld; this is the second, independent check
/// that turns that silent drop into a refusal (`CALP_PUSH_INCLUDED_CHANGED`,
/// `held_button_code::refuse_push_on_changed_inclusion`). It is judged against
/// `added` by the hash too, so it holds even if the filter ever stops doing so.
pub(crate) fn unhonoured_inclusions(
    requested: &[IncludedItem],
    added: &[WithheldContent],
    withheld: &[WithheldContent],
) -> Vec<UnhonouredInclusion> {
    requested
        .iter()
        .filter_map(|req| {
            if added.iter().any(|a| req.names(a) && a.content_hash == req.hash) {
                return None;
            }
            let (name, why) = match withheld.iter().find(|w| req.names(w)) {
                Some(w) if w.reason == WithheldReason::OtherApplication => (
                    w.name.clone(),
                    if w.owner.is_empty() {
                        "it is another application's code, and a push never publishes that as yours".to_string()
                    } else {
                        format!(
                            "it is the application '{}''s code, and a push never publishes that as yours",
                            w.owner
                        )
                    },
                ),
                Some(w) if !w.includable => (
                    w.name.clone(),
                    "it cannot be added to an application (it is not a macro, notebook or name of yours)"
                        .to_string(),
                ),
                Some(w) => (w.name.clone(), "it changed since you reviewed it".to_string()),
                // Carried under another hash: whatever carried it, it is not
                // the code the author read.
                None if added.iter().any(|a| req.names(a)) => (
                    added.iter().find(|a| req.names(a)).map(|a| a.name.clone()).unwrap_or_default(),
                    "it changed since you reviewed it".to_string(),
                ),
                None => (
                    req.id.clone(),
                    "it is no longer one of your items this push would leave behind (removed, renamed, or \
                     already part of the application)"
                        .to_string(),
                ),
            };
            Some(UnhonouredInclusion { item: req.clone(), name, why })
        })
        .collect()
}

/// The objects an object script can be bound to that sit on a sheet the push
/// does NOT publish, so a script bound to one would ship without its host.
struct LeftBehindHosts {
    /// `published_sheets` as a set of workbook indices.
    published_indices: std::collections::HashSet<usize>,
    /// Chart, slicer and timeline ids (their `EntityId` text) on an unpublished
    /// sheet. An id that names no known object is NOT here: a binding the
    /// filter cannot resolve keeps the old behaviour and ships.
    charts: std::collections::HashSet<String>,
    slicers: std::collections::HashSet<String>,
    timelines: std::collections::HashSet<String>,
}

impl LeftBehindHosts {
    /// Is `instance` (a script's binding) an object this push leaves behind?
    fn is_left_behind(&self, object_type: &persistence::ScriptableObjectType, instance: &str) -> bool {
        // A floating object (a button, a shape, any control) binds by the
        // DERIVED id `control-<sheet>-<row>-<col>`, whatever its script's type:
        // `Some(None)` is the answer `canonicalize_control_bindings` turns into
        // an orphaned binding -- the sheet is not in the application.
        if let Some(on_published) = crate::sheets::remap_control_instance_id(instance, &|i| {
            self.published_indices.contains(&i).then_some(i)
        }) {
            return on_published.is_none();
        }
        match object_type {
            persistence::ScriptableObjectType::Chart => self.charts.contains(instance),
            persistence::ScriptableObjectType::Slicer => self.slicers.contains(instance),
            persistence::ScriptableObjectType::Timeline => self.timelines.contains(instance),
            _ => false,
        }
    }
}

fn hosts_on_unpublished_sheets(workbook: &persistence::Workbook, published_sheets: &[usize]) -> LeftBehindHosts {
    let published_ids: std::collections::HashSet<identity::SheetId> = published_sheets
        .iter()
        .filter_map(|&i| workbook.sheets.get(i).map(|s| s.id))
        .collect();
    let off = |sheet: &identity::SheetId| !published_ids.contains(sheet);
    LeftBehindHosts {
        published_indices: published_sheets.iter().copied().collect(),
        charts: workbook.charts.iter().filter(|c| off(&c.sheet_id)).map(|c| c.id.to_string()).collect(),
        slicers: workbook.slicers.iter().filter(|c| off(&c.sheet_id)).map(|c| c.id.to_string()).collect(),
        timelines: workbook
            .timeline_slicers
            .iter()
            .filter(|c| off(&c.sheet_id))
            .map(|c| c.id.to_string())
            .collect(),
    }
}

/// What a filtered carrier SHIPS, in the shape the working-copy link records
/// after a push (`WorkingCopyLink::record_push`), so the NEXT push is measured
/// against this version rather than against the checkout's.
///
/// Read off the carrier `publish()` serialized, never off live state: a script,
/// function or pane control THIS push withheld is not the application's, and
/// recording it would ship it on the next push. And a function this push
/// shipped IS the application's from now on -- which is how a standalone
/// workbook's first publish keeps its own functions on every later push.
pub(crate) fn shipped_content(workbook: &persistence::Workbook) -> calp::WorkingCopyContent {
    calp::WorkingCopyContent {
        script_ids: workbook.scripts.iter().map(|s| s.id.clone()).collect(),
        notebook_ids: workbook.notebooks.iter().map(|n| n.id.clone()).collect(),
        named_range_keys: workbook.named_ranges.iter().map(|nr| nr.name.to_uppercase()).collect(),
        pane_control_ids: workbook.pane_controls.iter().map(|pc| pc.id.to_string()).collect(),
        custom_function_names: workbook
            .scripts
            .iter()
            .find(|s| s.id == CUSTOM_FUNCTIONS_LIB_ID)
            .map(|s| library_function_keys(&s.source, None))
            .unwrap_or_default(),
    }
}

/// The functions of a library record, as JSON values. `None` when the record
/// does not parse as a library -- nothing mounts from such a record anywhere.
fn parse_functions(source: &str) -> Option<(serde_json::Value, Vec<serde_json::Value>)> {
    let lib: serde_json::Value = serde_json::from_str(source).ok()?;
    let functions = lib.get("functions")?.as_array()?.clone();
    Some((lib, functions))
}

fn function_name(f: &serde_json::Value) -> String {
    f.get("name").and_then(|n| n.as_str()).unwrap_or("").to_string()
}

fn function_stamp(f: &serde_json::Value) -> String {
    f.get("sourcePackage")
        .and_then(|p| p.as_str())
        .map(|p| p.trim().to_string())
        .unwrap_or_default()
}

/// The key a function is recorded and compared under: its name trimmed and
/// uppercased, the key the pull's per-function merge uses for collisions
/// (`merge_custom_function_library`), so the two agree about "the same name".
fn function_key(f: &serde_json::Value) -> String {
    function_name(f).trim().to_uppercase()
}

/// The function keys of a library record, sorted and de-duplicated -- every
/// function, or with `stamped_with` only those stamped with that application.
/// Empty for a record that does not parse as a library.
///
/// This is what the working-copy link records as the base version's functions
/// (`WorkingCopyLink::base_custom_function_names`): at checkout, the functions
/// the pull's merge STAMPED with the application (a function it collision-
/// skipped is not the application's in this workbook -- the author's same-named
/// one is, and recording the name would ship theirs as the application's); at a
/// push, every function the push shipped.
pub(crate) fn library_function_keys(source: &str, stamped_with: Option<&str>) -> Vec<String> {
    let Some((_, functions)) = parse_functions(source) else {
        return Vec::new();
    };
    let mut keys: Vec<String> = functions
        .iter()
        .filter(|f| stamped_with.is_none_or(|pkg| function_stamp(f) == pkg))
        .map(function_key)
        .filter(|k| !k.is_empty())
        .collect();
    keys.sort();
    keys.dedup();
    keys
}

/// Every function of a library record the application never had, named.
fn withhold_whole_function_library(source: &str) -> Vec<WithheldContent> {
    match parse_functions(source) {
        Some((_, functions)) if !functions.is_empty() => functions
            .iter()
            .map(|f| {
                let name = function_name(f);
                let stamp = function_stamp(f);
                // Per function there is no subscription ledger to consult (the
                // record is one merged blob), so the stamp is the whole answer.
                let owner = if stamp.is_empty() { None } else { Some(stamp) };
                WithheldContent::new(WithheldKind::CustomFunction, &name, &name, owner)
            })
            .collect(),
        // Nothing parseable to name: say what the record is.
        _ => vec![WithheldContent::new(
            WithheldKind::ModuleScript,
            CUSTOM_FUNCTIONS_LIB_ID,
            "Custom Functions (data)",
            None,
        )],
    }
}

/// Filter the Custom Functions library PER FUNCTION: keep this application's,
/// withhold every other application's and the author's own the application
/// never had. Returns whether the record still ships.
///
/// Per function, by its `sourcePackage` stamp:
///   * stamped with THIS application (and the workbook holds it): the
///     application's -- ships;
///   * stamped with any other application: that application's code -- withheld,
///     named with its owner, so it is never signed under the pusher's key;
///   * unstamped: the author's own. It ships only when the base version carried
///     a function of that name (`WorkingCopyLink::base_custom_function_names`).
///     A standalone workbook's first publish has no record and ships its own --
///     they ARE the new application's -- and that push records them, so the
///     next push keeps them. In a working copy, the author's private functions
///     (which may declare `net.fetch`) stay home, named. A link that lacks the
///     record (`None`, from before it existed) reads as "the application had
///     none" -- there is no fallback (a real push from it is refused).
///
/// The functions that ship leave PROVENANCE-CLEAN: a function in an application
/// is that application's, and the subscriber's merge stamps its own
/// `sourcePackage`/`sourceDigest` on the way in. Leaving the stamps on made a
/// working copy's untouched library differ from the version it came from.
///
/// A record the filter emptied is dropped rather than shipped as an empty
/// library; one that was ALREADY empty is left alone.
fn filter_custom_function_library(
    source: &mut String,
    scope: &PushScope<'_>,
    withheld: &mut Vec<WithheldContent>,
) -> bool {
    let Some((mut lib, functions)) = parse_functions(source) else {
        // Unparseable: nothing in it mounts on either side, and rewriting bytes
        // we cannot read would be guessing. It ships as it is.
        return true;
    };
    let this_application = scope.holds_this_application();
    // The base version's functions, whenever the workbook is this
    // application's working copy. A missing record reads as none.
    let base_functions: Option<std::collections::HashSet<String>> = scope
        .link_for_this_application()
        .map(|l| {
            l.base_custom_function_names
                .iter()
                .flatten()
                .map(|n| n.trim().to_uppercase())
                .collect()
        });
    let mut kept: Vec<serde_json::Value> = Vec::with_capacity(functions.len());
    let mut changed = false;
    let mut any_withheld = false;
    for mut f in functions {
        let stamp = function_stamp(&f);
        // `None` ships; `Some(owner)` is withheld (`owner` `None` = yours).
        let verdict: Option<Option<String>> = if stamp.is_empty() {
            let in_base = base_functions
                .as_ref()
                .is_none_or(|base| base.contains(&function_key(&f)));
            if in_base { None } else { Some(None) }
        } else if stamp == scope.package_name && this_application {
            None
        } else {
            Some(Some(stamp))
        };
        if let Some(owner) = verdict {
            let name = function_name(&f);
            withheld.push(WithheldContent::new(WithheldKind::CustomFunction, &name, &name, owner));
            any_withheld = true;
            changed = true;
            continue;
        }
        if let Some(obj) = f.as_object_mut() {
            let had_package = obj.remove("sourcePackage").is_some();
            let had_digest = obj.remove("sourceDigest").is_some();
            if had_package || had_digest {
                changed = true;
            }
        }
        kept.push(f);
    }
    if kept.is_empty() && any_withheld {
        return false;
    }
    if changed {
        lib["functions"] = serde_json::Value::Array(kept);
        *source = lib.to_string();
    }
    true
}

#[cfg(test)]
mod tests {
    use super::*;
    use calp::manifest::{SubscribedObject, Subscription};
    use persistence::{
        SavedNamedRange, SavedNotebook, SavedObjectScript, SavedPaneControl, SavedScript,
        SavedScriptScope, ScriptAccessLevel, ScriptProvenance, ScriptableObjectType, Workbook,
    };

    const WS: &str = r"\\server\reports";
    const APP: &str = "sales";

    /// A working-copy link to APP whose base carried these scripts, notebooks,
    /// names and pane controls (`None` = a link from before the pane record).
    /// The base carried NO custom functions; tests about functions set
    /// `base_custom_function_names` themselves.
    fn link(scripts: &[&str], notebooks: &[&str], names: &[&str], panes: Option<&[&str]>) -> calp::WorkingCopyLink {
        let mut l = calp::WorkingCopyLink::new(WS, APP, "report", "1.0.0", "2026-09-29T00:00:00Z", Vec::new());
        l.record_content(calp::WorkingCopyContent {
            script_ids: scripts.iter().map(|s| s.to_string()).collect(),
            notebook_ids: notebooks.iter().map(|s| s.to_string()).collect(),
            named_range_keys: names.iter().map(|s| s.to_uppercase()).collect(),
            pane_control_ids: panes.unwrap_or(&[]).iter().map(|s| s.to_string()).collect(),
            custom_function_names: Vec::new(),
        });
        if panes.is_none() {
            l.base_pane_control_ids = None;
        }
        l
    }

    fn keys(names: &[&str]) -> Option<Vec<String>> {
        Some(names.iter().map(|n| n.to_string()).collect())
    }

    /// The function names a library record holds, in order.
    fn function_names_of(wb: &Workbook) -> Vec<String> {
        let lib = wb
            .scripts
            .iter()
            .find(|s| s.id == CUSTOM_FUNCTIONS_LIB_ID)
            .expect("the library record ships");
        let lib: serde_json::Value = serde_json::from_str(&lib.source).unwrap();
        lib["functions"]
            .as_array()
            .unwrap()
            .iter()
            .map(|f| f["name"].as_str().unwrap().to_string())
            .collect()
    }

    /// A subscription (in ANOTHER workspace) whose provenance ledger lists
    /// `objects` as (kind, id).
    fn subscription(package: &str, objects: &[(&str, &str)]) -> Subscription {
        let mut s: Subscription = serde_json::from_value(serde_json::json!({
            "packageName": package,
            "registryUrl": r"\\server\other",
            "versionPin": "latest",
            "resolvedVersion": "2.0.0",
            "resolvedAt": "2026-09-29T00:00:00Z",
            "sheets": [],
        }))
        .expect("a minimal subscription");
        s.objects = objects
            .iter()
            .map(|(kind, id)| SubscribedObject {
                kind: kind.to_string(),
                id: id.to_string(),
                name: id.to_string(),
                extra: Default::default(),
            })
            .collect();
        s
    }

    fn new_entity() -> identity::EntityId {
        identity::EntityId::from_bytes(identity::generate_uuid_v7())
    }

    fn workbook_name(name: &str) -> SavedNamedRange {
        SavedNamedRange {
            name: name.to_string(),
            refers_to: "=Sheet1!$A$1".to_string(),
            sheet_id: None,
            comment: None,
            folder: None,
        }
    }

    fn object_script(id: &str, provenance: ScriptProvenance, package: Option<&str>, instance: Option<&str>) -> SavedObjectScript {
        SavedObjectScript {
            id: id.to_string(),
            name: format!("{id} script"),
            object_type: ScriptableObjectType::Button,
            instance_id: instance.map(str::to_string),
            source: format!("// {id}"),
            access_level: ScriptAccessLevel::Restricted,
            description: None,
            provenance,
            package_name: package.map(str::to_string),
            package_version: package.map(|_| "1.0.0".to_string()),
            declared_capabilities: Vec::new(),
        }
    }

    fn module(id: &str, source_package: Option<&str>) -> SavedScript {
        SavedScript {
            id: id.to_string(),
            name: format!("{id} module"),
            description: None,
            source: format!("// {id}"),
            scope: SavedScriptScope::Workbook,
            source_package: source_package.map(str::to_string),
        }
    }

    fn notebook(id: &str, source_package: Option<&str>) -> SavedNotebook {
        SavedNotebook {
            id: id.to_string(),
            name: format!("{id} notebook"),
            cells: Vec::new(),
            source_package: source_package.map(str::to_string),
        }
    }

    fn pane(id: identity::EntityId, name: &str) -> SavedPaneControl {
        SavedPaneControl {
            id,
            name: name.to_string(),
            control_type: "button".to_string(),
            config: serde_json::json!({}),
            value: serde_json::Value::Null,
            order: 0,
        }
    }

    fn library(functions: serde_json::Value) -> SavedScript {
        SavedScript {
            id: CUSTOM_FUNCTIONS_LIB_ID.to_string(),
            name: "Custom Functions (data)".to_string(),
            description: None,
            source: serde_json::json!({ "functions": functions, "capabilities": ["net.fetch"] }).to_string(),
            scope: SavedScriptScope::Workbook,
            source_package: None,
        }
    }

    fn scope<'a>(link: Option<&'a calp::WorkingCopyLink>, subs: &'a [Subscription]) -> PushScope<'a> {
        PushScope { registry_path: WS, package_name: APP, link, subscriptions: subs, published_sheets: &[], included: &[] }
    }

    fn run(wb: &mut Workbook, scope: &PushScope<'_>) -> (Vec<WithheldContent>, Vec<String>) {
        let mut list = Some(wb.object_scripts.clone());
        let withheld = withhold_content_not_in_application(wb, &mut list, scope).withheld;
        let shipped: Vec<String> = list.unwrap().iter().map(|s| s.id.clone()).collect();
        let carrier: Vec<String> = wb.object_scripts.iter().map(|s| s.id.clone()).collect();
        assert_eq!(shipped, carrier, "the request's list and the carrier's must agree");
        (withheld, shipped)
    }

    // ------------------------------------------------------------------------
    // Object scripts (BUG-0261 a)
    // ------------------------------------------------------------------------

    /// A working copy that also SUBSCRIBES to another application must not
    /// re-publish that application's object scripts as its own.
    ///
    /// SABOTAGE: make the object-script rule return `true` (the pre-fix
    /// behaviour: every object script in the workbook ships).
    #[test]
    fn another_applications_object_scripts_are_withheld_and_named() {
        let l = link(&[], &[], &[], Some(&[]));
        let subs = [subscription("finance", &[("objectScript", "os-finance")])];
        let mut wb = Workbook::default();
        wb.object_scripts = vec![
            object_script("os-mine", ScriptProvenance::Local, None, None),
            object_script("os-app", ScriptProvenance::Distributed, Some(APP), None),
            object_script("os-finance", ScriptProvenance::Distributed, Some("finance"), None),
        ];
        let (withheld, shipped) = run(&mut wb, &scope(Some(&l), &subs));
        assert_eq!(shipped, vec!["os-mine", "os-app"], "yours and this application's ship");
        assert_eq!(withheld.len(), 1, "{withheld:?}");
        assert_eq!(withheld[0].kind, WithheldKind::ObjectScript);
        assert_eq!(withheld[0].id, "os-finance");
        assert_eq!(withheld[0].name, "os-finance script");
        assert_eq!(withheld[0].reason, WithheldReason::OtherApplication);
        assert_eq!(withheld[0].owner, "finance", "the notice names whose code it is");
    }

    /// A stamp is only a NAME. A subscription to a same-named application in
    /// ANOTHER workspace stamps the same name, and its ledger is what says the
    /// script is not ours.
    ///
    /// SABOTAGE: drop the `subscription_claiming` check from `foreign_owner`.
    #[test]
    fn a_same_named_application_from_another_workspace_is_still_another_application() {
        let l = link(&[], &[], &[], Some(&[]));
        let subs = [subscription(APP, &[("objectScript", "os-twin")])];
        let mut wb = Workbook::default();
        wb.object_scripts = vec![
            object_script("os-app", ScriptProvenance::Distributed, Some(APP), None),
            object_script("os-twin", ScriptProvenance::Distributed, Some(APP), None),
        ];
        let (withheld, shipped) = run(&mut wb, &scope(Some(&l), &subs));
        assert_eq!(shipped, vec!["os-app"]);
        assert_eq!(withheld.iter().map(|w| w.id.as_str()).collect::<Vec<_>>(), vec!["os-twin"]);
        assert_eq!(withheld[0].reason, WithheldReason::OtherApplication);
    }

    /// The stamp counts only when the workbook is THIS application's working
    /// copy. Creating a new application from a workbook that holds another
    /// application's distributed scripts must not publish them as the new one's.
    ///
    /// SABOTAGE: drop `&& self.link_for_this_application().is_some()` from
    /// `foreign_owner`.
    #[test]
    fn without_a_link_to_this_application_no_distributed_script_is_ours() {
        let other_link = {
            let mut l = link(&[], &[], &[], Some(&[]));
            l.package_name = "sales-2025".to_string();
            l
        };
        for link in [None, Some(&other_link)] {
            let mut wb = Workbook::default();
            wb.object_scripts = vec![
                object_script("os-mine", ScriptProvenance::Local, None, None),
                object_script("os-stamped", ScriptProvenance::Distributed, Some(APP), None),
                object_script("os-nameless", ScriptProvenance::Distributed, None, None),
            ];
            let (withheld, shipped) = run(&mut wb, &scope(link, &[]));
            assert_eq!(shipped, vec!["os-mine"], "link {:?}", link.map(|l| &l.package_name));
            let ids: Vec<&str> = withheld.iter().map(|w| w.id.as_str()).collect();
            assert_eq!(ids, vec!["os-nameless", "os-stamped"]);
            assert!(withheld.iter().all(|w| w.reason == WithheldReason::OtherApplication));
        }
    }

    /// Both copies are filtered, so a `None` request list (which falls back to
    /// the carrier's) cannot reintroduce what the explicit list dropped -- and a
    /// script present in both is reported ONCE.
    #[test]
    fn the_carriers_own_list_gets_the_same_rule() {
        let mut wb = Workbook::default();
        wb.object_scripts = vec![object_script("os-q", ScriptProvenance::Distributed, Some("q"), None)];
        let mut none: Option<Vec<SavedObjectScript>> = None;
        let withheld = withhold_content_not_in_application(&mut wb, &mut none, &scope(None, &[])).withheld;
        assert!(wb.object_scripts.is_empty(), "the fallback list is filtered too");
        assert_eq!(withheld.len(), 1);

        let mut wb = Workbook::default();
        wb.object_scripts = vec![object_script("os-q", ScriptProvenance::Distributed, Some("q"), None)];
        let (withheld, shipped) = run(&mut wb, &scope(None, &[]));
        assert!(shipped.is_empty());
        assert_eq!(withheld.len(), 1, "reported once, not once per copy: {withheld:?}");
    }

    // ------------------------------------------------------------------------
    // The Custom Functions library (BUG-0261 b)
    // ------------------------------------------------------------------------

    /// Filtered PER FUNCTION: this application's ship (stamped with it, or
    /// unstamped and carried by the base), another application's is withheld
    /// and named, and the shipped functions leave provenance-clean.
    ///
    /// SABOTAGE: make `filter_custom_function_library` return `true` without
    /// touching the record (the pre-fix behaviour: the merged record shipped
    /// whole).
    #[test]
    fn the_function_library_ships_only_this_applications() {
        let mut l = link(&[CUSTOM_FUNCTIONS_LIB_ID], &[], &[], Some(&[]));
        l.base_custom_function_names = keys(&["MINE", "APPFN"]);
        let mut wb = Workbook::default();
        wb.scripts = vec![library(serde_json::json!([
            { "name": "MINE", "params": [], "body": "return 1" },
            { "name": "APPFN", "params": [], "body": "return 2", "sourcePackage": APP, "sourceDigest": "abc" },
            { "name": "LEAK", "params": [], "body": "return fetch()", "sourcePackage": "finance", "sourceDigest": "def" },
        ]))];
        let (withheld, _) = run(&mut wb, &scope(Some(&l), &[]));

        assert_eq!(withheld.len(), 1, "{withheld:?}");
        assert_eq!(withheld[0].kind, WithheldKind::CustomFunction);
        assert_eq!(withheld[0].name, "LEAK");
        assert_eq!(withheld[0].owner, "finance");

        assert_eq!(wb.scripts.len(), 1, "the library record still ships");
        let lib: serde_json::Value = serde_json::from_str(&wb.scripts[0].source).unwrap();
        let names: Vec<&str> = lib["functions"]
            .as_array()
            .unwrap()
            .iter()
            .map(|f| f["name"].as_str().unwrap())
            .collect();
        assert_eq!(names, vec!["MINE", "APPFN"]);
        assert!(
            !wb.scripts[0].source.contains("sourcePackage") && !wb.scripts[0].source.contains("sourceDigest"),
            "shipped functions leave provenance-clean: {}",
            wb.scripts[0].source
        );
        assert_eq!(lib["capabilities"], serde_json::json!(["net.fetch"]), "the rest of the record is untouched");
    }

    /// An application that never had a library ships none of yours, and says
    /// which functions stayed home by NAME rather than as one opaque record.
    #[test]
    fn a_library_the_application_never_had_is_withheld_function_by_function() {
        let l = link(&["macro-1"], &[], &[], Some(&[]));
        let mut wb = Workbook::default();
        wb.scripts = vec![
            module("macro-1", Some(APP)),
            library(serde_json::json!([
                { "name": "PRIVATE", "params": [], "body": "return 1" },
                { "name": "THEIRS", "params": [], "body": "return 2", "sourcePackage": "finance" },
            ])),
        ];
        let (withheld, _) = run(&mut wb, &scope(Some(&l), &[]));
        assert_eq!(wb.scripts.iter().map(|s| s.id.as_str()).collect::<Vec<_>>(), vec!["macro-1"]);
        let named: Vec<(&str, WithheldReason, &str)> = withheld
            .iter()
            .map(|w| (w.name.as_str(), w.reason, w.owner.as_str()))
            .collect();
        assert_eq!(
            named,
            vec![
                ("PRIVATE", WithheldReason::NotInApplication, ""),
                ("THEIRS", WithheldReason::OtherApplication, "finance"),
            ]
        );
    }

    /// A record the filter EMPTIED does not ship as an empty library.
    #[test]
    fn a_library_left_with_nothing_is_not_published() {
        let mut wb = Workbook::default();
        wb.scripts = vec![library(serde_json::json!([
            { "name": "THEIRS", "params": [], "body": "return 2", "sourcePackage": "finance" },
        ]))];
        let (withheld, _) = run(&mut wb, &scope(None, &[]));
        assert!(wb.scripts.is_empty(), "{:?}", wb.scripts);
        assert_eq!(withheld.len(), 1);
    }

    /// THE DEVELOPER'S OWN FUNCTIONS STAY HOME (BUG-0261). A working copy's
    /// library holds the application's functions (stamped by the checkout's
    /// merge) beside the author's own, which carry no stamp -- and may declare
    /// `net.fetch`. Only the application's ship: the base record says which
    /// unstamped names are the application's, and a private one is withheld
    /// and named as yours.
    ///
    /// SABOTAGE: let every unstamped function ship (`in_base` always `true` in
    /// `filter_custom_function_library`) -- the pre-fix rule.
    #[test]
    fn a_working_copy_keeps_the_authors_private_functions_home() {
        let mut l = link(&[CUSTOM_FUNCTIONS_LIB_ID], &[], &[], Some(&[]));
        // The checkout recorded APPFN; EDITED is an application function the
        // base carried that no longer carries a stamp.
        l.base_custom_function_names = keys(&["APPFN", "EDITED"]);
        let mut wb = Workbook::default();
        wb.scripts = vec![library(serde_json::json!([
            { "name": "APPFN", "params": [], "body": "return 1", "sourcePackage": APP, "sourceDigest": "a" },
            { "name": "edited ", "params": [], "body": "return 2" },
            { "name": "PRIVATE", "params": [], "body": "return fetch('https://example.invalid')" },
            { "name": "LEAK", "params": [], "body": "return 3", "sourcePackage": "finance" },
        ]))];
        let (withheld, _) = run(&mut wb, &scope(Some(&l), &[]));

        assert_eq!(function_names_of(&wb), vec!["APPFN", "edited "], "only the application's ship");
        let got: Vec<(&str, WithheldReason, &str)> = withheld
            .iter()
            .map(|w| (w.name.as_str(), w.reason, w.owner.as_str()))
            .collect();
        assert_eq!(
            got,
            vec![
                ("LEAK", WithheldReason::OtherApplication, "finance"),
                ("PRIVATE", WithheldReason::NotInApplication, ""),
            ]
        );
    }

    /// A standalone workbook's FIRST publish has no record: the author's own
    /// functions ARE the new application's and ship. The push records what it
    /// shipped (`shipped_content`), so the next push keeps them -- and withholds
    /// a function the author adds afterwards, until it is added on purpose.
    ///
    /// SABOTAGE: return an empty `custom_function_names` from `shipped_content`
    /// (the second push then withholds the application's own functions).
    #[test]
    fn a_first_publish_ships_the_authors_functions_and_the_next_push_keeps_them() {
        let mut wb = Workbook::default();
        wb.scripts = vec![library(serde_json::json!([
            { "name": "MINE", "params": [], "body": "return 1" },
            { "name": "Other", "params": [], "body": "return 2" },
        ]))];
        let (withheld, _) = run(&mut wb, &scope(None, &[]));
        assert!(withheld.is_empty(), "{withheld:?}");
        let shipped = shipped_content(&wb);
        assert_eq!(shipped.custom_function_names, vec!["MINE", "OTHER"]);
        assert_eq!(shipped.script_ids, vec![CUSTOM_FUNCTIONS_LIB_ID]);

        // The publish turned the workbook into the application's working copy.
        let mut l = calp::WorkingCopyLink::new(WS, APP, "report", "1.0.0", "2026-09-29T00:00:00Z", Vec::new());
        l.record_push("1.0.0", "2026-09-29T00:00:00Z", Vec::new(), shipped);

        let mut next = Workbook::default();
        next.scripts = vec![library(serde_json::json!([
            { "name": "MINE", "params": [], "body": "return 10" },
            { "name": "Other", "params": [], "body": "return 2" },
            { "name": "LATER", "params": [], "body": "return 3" },
        ]))];
        let (withheld, _) = run(&mut next, &scope(Some(&l), &[]));
        assert_eq!(function_names_of(&next), vec!["MINE", "Other"], "the application's own functions still ship");
        assert_eq!(withheld.len(), 1, "{withheld:?}");
        assert_eq!(withheld[0].name, "LATER");
        assert_eq!(withheld[0].reason, WithheldReason::NotInApplication);
    }

    /// A link from before the function record existed (`None`) gets NO
    /// fallback: your own unstamped functions stay home too (the product keeps
    /// no backward-compatibility promise, and a real push from such a link is
    /// refused outright in `calp_publish`).
    ///
    /// SABOTAGE: restore the `is_none_or` fallback (`base_functions` = `None`
    /// for a link without the record).
    #[test]
    fn an_unrecorded_function_list_is_not_a_licence_to_ship_yours() {
        let mut l = link(&[CUSTOM_FUNCTIONS_LIB_ID], &[], &[], Some(&[]));
        l.base_custom_function_names = None;
        let mut wb = Workbook::default();
        wb.scripts = vec![library(serde_json::json!([
            { "name": "MINE", "params": [], "body": "return 1" },
            { "name": "APPFN", "params": [], "body": "return 2", "sourcePackage": APP },
            { "name": "LEAK", "params": [], "body": "return 3", "sourcePackage": "finance" },
        ]))];
        let (withheld, _) = run(&mut wb, &scope(Some(&l), &[]));
        assert_eq!(function_names_of(&wb), vec!["APPFN"], "only the application's stamped function ships");
        let got: Vec<(&str, WithheldReason)> = withheld.iter().map(|w| (w.name.as_str(), w.reason)).collect();
        assert_eq!(
            got,
            vec![("LEAK", WithheldReason::OtherApplication), ("MINE", WithheldReason::NotInApplication)]
        );
    }

    /// The keys a record is recorded under: trimmed, uppercased, sorted and
    /// de-duplicated, optionally only one application's -- the key the pull's
    /// per-function merge compares names by.
    #[test]
    fn library_function_keys_are_the_merges_keys() {
        let source = serde_json::json!({ "functions": [
            { "name": " fxRate ", "sourcePackage": APP },
            { "name": "mine" },
            { "name": "LEAK", "sourcePackage": "finance" },
            { "name": "FXRATE", "sourcePackage": APP },
            { "name": "" },
        ] })
        .to_string();
        assert_eq!(library_function_keys(&source, None), vec!["FXRATE", "LEAK", "MINE"]);
        assert_eq!(library_function_keys(&source, Some(APP)), vec!["FXRATE"]);
        assert_eq!(library_function_keys("not json", None), Vec::<String>::new());
    }

    // ------------------------------------------------------------------------
    // Module scripts / notebooks / names: the old filter, now reported
    // ------------------------------------------------------------------------

    /// The private content the base filter already withheld is now RETURNED,
    /// named, instead of reaching only the log -- and another application's
    /// modules are withheld even from a first publish with no link.
    #[test]
    fn private_and_foreign_modules_notebooks_and_names_are_reported() {
        let l = link(&["macro-app"], &["nb-app"], &["RATE"], Some(&[]));
        let subs = [subscription("finance", &[("moduleScript", "macro-fin")])];
        let mut wb = Workbook::default();
        wb.scripts = vec![
            module("macro-app", Some(APP)),
            module("macro-private", None),
            module("macro-fin", Some("finance")),
        ];
        wb.notebooks = vec![notebook("nb-app", Some(APP)), notebook("nb-private", None)];
        wb.named_ranges = vec![workbook_name("RATE"), workbook_name("MYNAME")];
        let (withheld, _) = run(&mut wb, &scope(Some(&l), &subs));
        let got: Vec<(WithheldKind, &str, WithheldReason, &str)> = withheld
            .iter()
            .map(|w| (w.kind, w.id.as_str(), w.reason, w.owner.as_str()))
            .collect();
        assert_eq!(
            got,
            vec![
                (WithheldKind::ModuleScript, "macro-fin", WithheldReason::OtherApplication, "finance"),
                (WithheldKind::ModuleScript, "macro-private", WithheldReason::NotInApplication, ""),
                (WithheldKind::Notebook, "nb-private", WithheldReason::NotInApplication, ""),
                (WithheldKind::NamedRange, "MYNAME", WithheldReason::NotInApplication, ""),
            ]
        );
        assert_eq!(wb.scripts.iter().map(|s| s.id.as_str()).collect::<Vec<_>>(), vec!["macro-app"]);

        // No link at all (a first publish of a new application): your own
        // modules ship as before, another application's do not.
        let mut wb = Workbook::default();
        wb.scripts = vec![module("macro-private", None), module("macro-fin", Some("finance"))];
        let (withheld, _) = run(&mut wb, &scope(None, &[]));
        assert_eq!(wb.scripts.iter().map(|s| s.id.as_str()).collect::<Vec<_>>(), vec!["macro-private"]);
        assert_eq!(withheld.len(), 1);
        assert_eq!(withheld[0].owner, "finance");
    }

    /// AN APPLICATION WITH NO SCRIPTS, NOTEBOOKS OR NAMES STILL KEEPS YOURS HOME.
    /// A link this build wrote records every list, so an EMPTY one means "the
    /// application has none" -- the author's private module (the one holding an
    /// API token) must not ship merely because the application has no modules
    /// to compare it with. A link from before the record gets no fallback
    /// either (it used to publish everything).
    ///
    /// SABOTAGE: make `base_ids_recorded` depend on the link's lists being
    /// non-empty (the pre-fix "empty means not recorded" fallback).
    #[test]
    fn an_application_with_no_scripts_or_names_still_keeps_the_authors_home() {
        let recorded = link(&[], &[], &[], Some(&[]));
        let private_workbook = || {
            let mut wb = Workbook::default();
            wb.scripts = vec![module("macro-token", None)];
            wb.notebooks = vec![notebook("nb-private", None)];
            wb.named_ranges = vec![workbook_name("MYNAME")];
            wb
        };

        let mut wb = private_workbook();
        let (withheld, _) = run(&mut wb, &scope(Some(&recorded), &[]));
        assert!(
            wb.scripts.is_empty() && wb.notebooks.is_empty() && wb.named_ranges.is_empty(),
            "nothing of yours ships: {:?} {:?} {:?}",
            wb.scripts.iter().map(|s| &s.id).collect::<Vec<_>>(),
            wb.notebooks.iter().map(|n| &n.id).collect::<Vec<_>>(),
            wb.named_ranges.iter().map(|n| &n.name).collect::<Vec<_>>(),
        );
        let got: Vec<(WithheldKind, &str, WithheldReason)> =
            withheld.iter().map(|w| (w.kind, w.id.as_str(), w.reason)).collect();
        assert_eq!(
            got,
            vec![
                (WithheldKind::ModuleScript, "macro-token", WithheldReason::NotInApplication),
                (WithheldKind::Notebook, "nb-private", WithheldReason::NotInApplication),
                (WithheldKind::NamedRange, "MYNAME", WithheldReason::NotInApplication),
            ]
        );

        // A link from BEFORE the record: no fallback -- nothing of yours ships
        // from it either (and `calp_publish` refuses the real push).
        let mut legacy = recorded.clone();
        legacy.base_pane_control_ids = None;
        legacy.base_custom_function_names = None;
        let mut wb = private_workbook();
        let (withheld, _) = run(&mut wb, &scope(Some(&legacy), &[]));
        assert_eq!(withheld.len(), 3, "{withheld:?}");
        assert_eq!((wb.scripts.len(), wb.notebooks.len(), wb.named_ranges.len()), (0, 0, 0));
    }

    // ------------------------------------------------------------------------
    // Pane controls (BUG-0261 c)
    // ------------------------------------------------------------------------

    /// Pane controls the base version did not carry -- the author's own, or a
    /// subscription's -- stay behind, and so do their `pane-{id}` scripts.
    ///
    /// SABOTAGE: make the pane-control `retain` keep everything.
    #[test]
    fn pane_controls_the_application_never_had_stay_behind_with_their_scripts() {
        let app_pane = new_entity();
        let my_pane = new_entity();
        let fin_pane = new_entity();
        let l = link(&[], &[], &[], Some(&[&app_pane.to_string()]));
        let subs = [subscription("finance", &[("paneControl", &fin_pane.to_string())])];
        let mut wb = Workbook::default();
        wb.pane_controls = vec![pane(app_pane, "Region"), pane(my_pane, "Scratch"), pane(fin_pane, "Quarter")];
        wb.object_scripts = vec![
            object_script("os-app-pane", ScriptProvenance::Distributed, Some(APP), Some(&format!("pane-{app_pane}"))),
            object_script("os-my-pane", ScriptProvenance::Local, None, Some(&format!("pane-{my_pane}"))),
            object_script("os-fin-pane", ScriptProvenance::Distributed, Some("finance"), Some(&format!("pane-{fin_pane}"))),
        ];
        let (withheld, shipped) = run(&mut wb, &scope(Some(&l), &subs));

        assert_eq!(wb.pane_controls.iter().map(|p| p.name.as_str()).collect::<Vec<_>>(), vec!["Region"]);
        assert_eq!(shipped, vec!["os-app-pane"], "a withheld control's script does not ship host-less");
        let panes: Vec<(&str, WithheldReason, &str)> = withheld
            .iter()
            .filter(|w| w.kind == WithheldKind::PaneControl)
            .map(|w| (w.name.as_str(), w.reason, w.owner.as_str()))
            .collect();
        assert_eq!(
            panes,
            vec![
                ("Quarter", WithheldReason::OtherApplication, "finance"),
                ("Scratch", WithheldReason::NotInApplication, ""),
            ]
        );
        let my_script = withheld.iter().find(|w| w.id == "os-my-pane").expect("the host-less script is named");
        assert_eq!(my_script.reason, WithheldReason::NotInApplication, "it is yours, and stays with you");
    }

    /// A link from before the record existed (`None`) gets no fallback: your
    /// own pane controls stay home too, and a subscription's are still another
    /// application's.
    ///
    /// SABOTAGE: map a `None` `base_pane_control_ids` to "keep everything".
    #[test]
    fn an_unrecorded_pane_list_keeps_your_pane_controls_home() {
        let mine = new_entity();
        let theirs = new_entity();
        let l = link(&["x"], &[], &[], None);
        let subs = [subscription("finance", &[("paneControl", &theirs.to_string())])];
        let mut wb = Workbook::default();
        wb.pane_controls = vec![pane(mine, "Mine"), pane(theirs, "Theirs")];
        let (withheld, _) = run(&mut wb, &scope(Some(&l), &subs));
        assert!(wb.pane_controls.is_empty(), "{:?}", wb.pane_controls.iter().map(|p| &p.name).collect::<Vec<_>>());
        let got: Vec<(&str, WithheldReason)> = withheld.iter().map(|w| (w.name.as_str(), w.reason)).collect();
        assert_eq!(got, vec![("Mine", WithheldReason::NotInApplication), ("Theirs", WithheldReason::OtherApplication)]);
    }

    // ------------------------------------------------------------------------
    // Object scripts whose host stays behind (review finding, BUG-0261)
    // ------------------------------------------------------------------------

    /// A sheet with a chart and a slicer, for the host tests.
    fn sheet_with_objects(name: &str) -> (persistence::Sheet, persistence::SavedChart) {
        let sheet = persistence::Sheet::new(name.to_string());
        let chart = persistence::SavedChart { id: new_entity(), sheet_id: sheet.id, spec_json: "{}".to_string() };
        (sheet, chart)
    }

    /// THE AUTHOR'S PRIVATE SHEET BESIDE THE APPLICATION. Additive checkout
    /// leaves it there, with its button's and chart's scripts; a push that does
    /// not carry the sheet must not carry them either -- host-less, signed under
    /// the author's key, into every subscriber's version. A Local script bound to
    /// something on a PUBLISHED sheet still ships, and so does one whose binding
    /// names nothing the filter can resolve.
    ///
    /// SABOTAGE: drop `left_behind_hosts.is_left_behind(..)` from the Local arm.
    #[test]
    fn a_local_script_bound_to_an_object_on_an_unpublished_sheet_stays_behind() {
        let l = link(&[], &[], &[], Some(&[]));
        let (app_sheet, app_chart) = sheet_with_objects("Dashboard");
        let (private_sheet, private_chart) = sheet_with_objects("My notes");
        let mut wb = Workbook::default();
        wb.sheets = vec![app_sheet, private_sheet];
        wb.charts = vec![app_chart.clone(), private_chart.clone()];
        let chart_script = |id: &str, chart: &persistence::SavedChart| SavedObjectScript {
            object_type: ScriptableObjectType::Chart,
            ..object_script(id, ScriptProvenance::Local, None, Some(&chart.id.to_string()))
        };
        wb.object_scripts = vec![
            // Workbook index 0 is the application's sheet, 1 the private one.
            object_script("os-app-button", ScriptProvenance::Local, None, Some("control-0-1-1")),
            object_script("os-private-button", ScriptProvenance::Local, None, Some("control-1-4-2")),
            chart_script("os-app-chart", &app_chart),
            chart_script("os-private-chart", &private_chart),
            object_script("os-unbound", ScriptProvenance::Local, None, None),
            object_script("os-unknown-id", ScriptProvenance::Local, None, Some("something-else")),
        ];
        let published = [0usize];
        let scope = PushScope {
            registry_path: WS,
            package_name: APP,
            link: Some(&l),
            subscriptions: &[],
            published_sheets: &published,
            included: &[],
        };
        let (withheld, shipped) = run(&mut wb, &scope);
        assert_eq!(shipped, vec!["os-app-button", "os-app-chart", "os-unbound", "os-unknown-id"], "{withheld:?}");
        let got: Vec<(&str, WithheldKind, WithheldReason)> =
            withheld.iter().map(|w| (w.id.as_str(), w.kind, w.reason)).collect();
        assert_eq!(
            got,
            vec![
                ("os-private-button", WithheldKind::ObjectScript, WithheldReason::NotInApplication),
                ("os-private-chart", WithheldKind::ObjectScript, WithheldReason::NotInApplication),
            ]
        );
    }

    /// What the assembly withheld reaches the PUSH REPORT, by name -- it used to
    /// reach only the log, which to the person pushing is a silent drop.
    ///
    /// SABOTAGE: build the report with `withheld: Vec::new()` in
    /// `compute_publish_report`.
    #[test]
    fn the_push_report_names_what_the_push_withheld() {
        let mut wb = Workbook::default();
        wb.object_scripts = vec![object_script("os-fin", ScriptProvenance::Distributed, Some("finance"), None)];
        wb.scripts = vec![module("macro-private", None)];
        let l = link(&["macro-app"], &[], &[], Some(&[]));
        let mut object_scripts = Some(wb.object_scripts.clone());
        let withheld = withhold_content_not_in_application(&mut wb, &mut object_scripts, &scope(Some(&l), &[])).withheld;
        assert_eq!(withheld.len(), 2, "{withheld:?}");

        let assembly = crate::calp_commands::PublishAssembly {
            workbook: wb,
            writeback_regions: None,
            object_scripts,
            data_sources: Vec::new(),
            model_writebacks: Vec::new(),
            excluded_regions: Vec::new(),
            withheld: withheld.clone(),
            added_to_application: Vec::new(),
            button_code: Default::default(),
            cell_type_objects: Vec::new(),
        };
        let state = crate::create_app_state();
        let selection = crate::calp_commands::PublishSelection::default();
        let report = crate::calp_commands::compute_publish_report(&assembly, &state, &[], false, &selection);
        assert_eq!(report.withheld, withheld);
        let json = serde_json::to_value(&report).unwrap();
        let names: Vec<&str> = json["withheld"]
            .as_array()
            .expect("the report carries a `withheld` list on the wire")
            .iter()
            .map(|w| w["name"].as_str().unwrap())
            .collect();
        assert_eq!(names, vec!["os-fin script", "macro-private module"]);
        assert!(
            report.included.iter().all(|i| i.category != "objectScripts"),
            "the withheld object script is not counted as shipping: {:?}",
            report.included
        );
    }

    /// A SUBSCRIBER's "view changes" diff runs this same assembly against the
    /// application it subscribes to. That application's own code must stay in
    /// the working side, or the diff reports every one of its scripts, modules,
    /// functions and pane controls REMOVED -- changes a reset never makes. Other
    /// applications' code is still withheld.
    ///
    /// SABOTAGE: make `is_this_applications_subscription` return `false`.
    #[test]
    fn a_subscribers_diff_keeps_the_subscribed_applications_own_code() {
        let pane_id = new_entity();
        let mut own = subscription(APP, &[("objectScript", "os-app"), ("moduleScript", "macro-app")]);
        own.registry_url = WS.to_string();
        own.objects.push(SubscribedObject {
            kind: "paneControl".to_string(),
            id: pane_id.to_string(),
            name: "Region".to_string(),
            extra: Default::default(),
        });
        let subs = [own, subscription("finance", &[("objectScript", "os-fin")])];
        let mut wb = Workbook::default();
        wb.object_scripts = vec![
            object_script("os-app", ScriptProvenance::Distributed, Some(APP), None),
            object_script("os-fin", ScriptProvenance::Distributed, Some("finance"), None),
        ];
        wb.scripts = vec![
            module("macro-app", Some(APP)),
            library(serde_json::json!([
                { "name": "APPFN", "params": [], "body": "return 2", "sourcePackage": APP },
                { "name": "FINFN", "params": [], "body": "return 3", "sourcePackage": "finance" },
            ])),
        ];
        wb.pane_controls = vec![pane(pane_id, "Region")];

        let (withheld, shipped) = run(&mut wb, &scope(None, &subs));
        assert_eq!(shipped, vec!["os-app"], "{withheld:?}");
        assert!(wb.scripts.iter().any(|s| s.id == "macro-app"));
        assert_eq!(wb.pane_controls.len(), 1, "the subscribed application's pane control stays");
        let names: Vec<&str> = withheld.iter().map(|w| w.name.as_str()).collect();
        assert_eq!(names, vec!["os-fin script", "FINFN"]);

        // The SAME subscription on another share is a different application.
        let mut elsewhere = subs.clone();
        elsewhere[0].registry_url = r"\\server\elsewhere".to_string();
        let mut wb2 = Workbook::default();
        wb2.object_scripts = vec![object_script("os-app", ScriptProvenance::Distributed, Some(APP), None)];
        let (withheld, shipped) = run(&mut wb2, &scope(None, &elsewhere));
        assert!(shipped.is_empty(), "a same-named application on another share is not this one");
        assert_eq!(withheld[0].owner, APP);
    }

    /// The wire shape the push report carries (camelCase, enum values the
    /// frontend switches on).
    #[test]
    fn withheld_content_serializes_in_camel_case() {
        let w = WithheldContent::new(WithheldKind::CustomFunction, "F", "F", Some("finance".to_string()));
        let json = serde_json::to_value(&w).unwrap();
        assert_eq!(
            json,
            serde_json::json!({
                "kind": "customFunction",
                "id": "F",
                "name": "F",
                "reason": "otherApplication",
                "owner": "finance",
                "includable": false,
                "contentHash": "",
                "code": "",
                "detail": "",
            })
        );
        let mine = WithheldContent::new(WithheldKind::PaneControl, "p", "P", None);
        assert_eq!(serde_json::to_value(&mine).unwrap()["reason"], "notInApplication");
        assert_eq!(serde_json::to_value(&mine).unwrap()["kind"], "paneControl");

        // What the push dialog sends back for "Include in application".
        let wire: IncludedItem =
            serde_json::from_value(serde_json::json!({ "kind": "moduleScript", "id": "macro-new", "hash": "h" }))
                .expect("the dialog's inclusion parses");
        assert_eq!(wire, IncludedItem { kind: WithheldKind::ModuleScript, id: "macro-new".into(), hash: "h".into() });
    }

    // ------------------------------------------------------------------------
    // "Include in application" (M4): the author ADDS their own new macro,
    // notebook or name to the application, with the code on screen.
    // ------------------------------------------------------------------------

    fn include(kind: WithheldKind, id: &str, code: &str) -> IncludedItem {
        IncludedItem { kind, id: id.to_string(), hash: content_hash(code) }
    }

    fn scope_including<'a>(
        link: Option<&'a calp::WorkingCopyLink>,
        subs: &'a [Subscription],
        included: &'a [IncludedItem],
    ) -> PushScope<'a> {
        PushScope { included, ..scope(link, subs) }
    }

    fn notebook_with(id: &str, sources: &[&str]) -> SavedNotebook {
        SavedNotebook {
            cells: sources
                .iter()
                .enumerate()
                .map(|(i, source)| persistence::SavedNotebookCell {
                    id: format!("c{i}"),
                    source: source.to_string(),
                    last_output: Vec::new(),
                    last_error: None,
                    cells_modified: 0,
                    duration_ms: 0,
                    execution_index: None,
                })
                .collect(),
            ..notebook(id, None)
        }
    }

    /// A macro the author recorded IN the working copy is theirs, so the push
    /// withholds it -- naming it includable, with the exact text it hashed. Once
    /// the request includes that hash, it ships and is named as ADDED.
    ///
    /// SABOTAGE: make `PushScope::includes` return `false`.
    #[test]
    fn an_included_own_module_ships() {
        let l = link(&["macro-app"], &[], &[], Some(&[]));
        let carrier = || {
            let mut wb = Workbook::default();
            wb.scripts = vec![module("macro-app", Some(APP)), module("macro-new", None)];
            wb
        };

        let mut wb = carrier();
        let (withheld, _) = run(&mut wb, &scope(Some(&l), &[]));
        let new = withheld.iter().find(|w| w.id == "macro-new").expect("the new macro is withheld by default");
        assert!(new.includable, "{new:?}");
        assert_eq!(new.code, "// macro-new", "the dialog is shown exactly what is hashed");
        assert_eq!(new.content_hash, content_hash("// macro-new"));

        let included = [include(WithheldKind::ModuleScript, "macro-new", "// macro-new")];
        let mut wb = carrier();
        let mut list = None;
        let content = withhold_content_not_in_application(&mut wb, &mut list, &scope_including(Some(&l), &[], &included));
        assert_eq!(
            wb.scripts.iter().map(|s| s.id.as_str()).collect::<Vec<_>>(),
            vec!["macro-app", "macro-new"],
            "the included macro ships"
        );
        assert!(content.withheld.is_empty(), "{:?}", content.withheld);
        assert_eq!(content.added.iter().map(|a| a.id.as_str()).collect::<Vec<_>>(), vec!["macro-new"]);
        assert_eq!(content.added[0].content_hash, content_hash("// macro-new"));
    }

    /// A notebook is included by the hash of its cells' sources, in order.
    ///
    /// SABOTAGE: make `PushScope::includes` return `false`.
    #[test]
    fn an_included_own_notebook_ships() {
        let l = link(&[], &["nb-app"], &[], Some(&[]));
        let carrier = || {
            let mut wb = Workbook::default();
            wb.notebooks = vec![notebook("nb-app", Some(APP)), notebook_with("nb-new", &["let a = 1;", "a + 1"])];
            wb
        };
        let code = r#"["let a = 1;","a + 1"]"#;

        let mut wb = carrier();
        let (withheld, _) = run(&mut wb, &scope(Some(&l), &[]));
        assert_eq!(withheld.len(), 1, "{withheld:?}");
        assert!(withheld[0].includable);
        assert_eq!(withheld[0].code, code, "a notebook's text is its cell sources, in order");

        let included = [include(WithheldKind::Notebook, "nb-new", code)];
        let mut wb = carrier();
        let content = withhold_content_not_in_application(&mut wb, &mut None, &scope_including(Some(&l), &[], &included));
        assert_eq!(wb.notebooks.iter().map(|n| n.id.as_str()).collect::<Vec<_>>(), vec!["nb-app", "nb-new"]);
        assert!(content.withheld.is_empty());
        assert_eq!(content.added.len(), 1);
    }

    /// A workbook name is included like a macro (matched ignoring case), and
    /// one that points at a sheet this push leaves behind says so before the
    /// author ticks it.
    ///
    /// SABOTAGE: return an empty caveat from `unpublished_sheet_caveat`.
    #[test]
    fn an_included_workbook_name_ships_and_says_when_it_names_an_unpublished_sheet() {
        let l = link(&[], &[], &["RATE"], Some(&[]));
        let carrier = || {
            let mut wb = Workbook::default();
            wb.sheets = vec![persistence::Sheet::new("Dashboard".into()), persistence::Sheet::new("My notes".into())];
            wb.named_ranges = vec![
                workbook_name("RATE"),
                SavedNamedRange { refers_to: "='My notes'!$A$1".into(), ..workbook_name("Secret") },
                SavedNamedRange { refers_to: "=Dashboard!$B$2".into(), ..workbook_name("Total") },
            ];
            wb
        };
        let published = [0usize];
        let base = PushScope { published_sheets: &published, ..scope(Some(&l), &[]) };

        let mut wb = carrier();
        let (withheld, _) = run(&mut wb, &base);
        let secret = withheld.iter().find(|w| w.id == "Secret").expect("withheld");
        assert!(secret.includable);
        assert_eq!(secret.code, "='My notes'!$A$1");
        assert!(secret.detail.contains("'My notes'") && secret.detail.contains("does not publish"), "{}", secret.detail);
        let total = withheld.iter().find(|w| w.id == "Total").expect("withheld");
        assert_eq!(total.detail, "", "a name on a published sheet needs no caveat");

        let included = [IncludedItem { id: "TOTAL".into(), ..include(WithheldKind::NamedRange, "Total", "=Dashboard!$B$2") }];
        let mut wb = carrier();
        let content = withhold_content_not_in_application(
            &mut wb,
            &mut None,
            &PushScope { included: &included, ..base },
        );
        let names: Vec<&str> = wb.named_ranges.iter().map(|n| n.name.as_str()).collect();
        assert_eq!(names, vec!["RATE", "Total"], "the included name ships; the other stays home");
        assert_eq!(content.added.iter().map(|a| a.id.as_str()).collect::<Vec<_>>(), vec!["Total"]);
    }

    /// ANOTHER APPLICATION'S CODE IS NEVER INCLUDABLE: it is not the author's to
    /// sign. A request naming it -- even with the right hash -- changes nothing.
    ///
    /// SABOTAGE: in the module filter, honour `scope.included` BEFORE the
    /// `foreign_owner` check.
    #[test]
    fn another_applications_module_is_never_includable() {
        let l = link(&[], &[], &[], Some(&[]));
        let subs = [subscription("finance", &[("moduleScript", "macro-fin")])];
        let included = [include(WithheldKind::ModuleScript, "macro-fin", "// macro-fin")];
        let mut wb = Workbook::default();
        wb.scripts = vec![module("macro-fin", Some("finance"))];
        let content = withhold_content_not_in_application(&mut wb, &mut None, &scope_including(Some(&l), &subs, &included));
        assert!(wb.scripts.is_empty(), "another application's macro shipped under your key");
        assert!(content.added.is_empty());
        assert_eq!(content.withheld.len(), 1);
        let fin = &content.withheld[0];
        assert!(!fin.includable, "{fin:?}");
        assert_eq!(fin.reason, WithheldReason::OtherApplication);
        assert_eq!((fin.code.as_str(), fin.content_hash.as_str()), ("", ""), "no code is offered for review");
    }

    /// ANOTHER APPLICATION'S WORKBOOK NAME IS NEVER INCLUDABLE. Names carry no
    /// stamp of their own; a subscription's pull ledgers each name it adds by
    /// its UPPERCASED key, and that ledger is what says the name is the other
    /// application's (a LAMBDA included). It is withheld as that application's,
    /// offers no code, and a request naming it is not honoured -- which the
    /// push refuses as `CALP_PUSH_INCLUDED_CHANGED`.
    ///
    /// SABOTAGE: drop the `foreign_claimant("namedRange", ..)` check from the
    /// name filter (the name then reads as "yours", includable).
    #[test]
    fn another_applications_name_is_never_includable() {
        let l = link(&[], &[], &[], Some(&[]));
        let subs = [subscription("finance", &[("namedRange", "FINRATE")])];
        let included = [include(WithheldKind::NamedRange, "FinRate", "=Sheet1!$A$1")];
        let mut wb = Workbook::default();
        wb.named_ranges = vec![workbook_name("FinRate")];
        let content = withhold_content_not_in_application(&mut wb, &mut None, &scope_including(Some(&l), &subs, &included));
        assert!(wb.named_ranges.is_empty(), "another application's name shipped under your key");
        assert!(content.added.is_empty(), "{:?}", content.added);
        assert_eq!(content.withheld.len(), 1, "{:?}", content.withheld);
        let fin = &content.withheld[0];
        assert!(!fin.includable, "{fin:?}");
        assert_eq!(fin.reason, WithheldReason::OtherApplication);
        assert_eq!(fin.owner, "finance");
        assert_eq!((fin.code.as_str(), fin.content_hash.as_str()), ("", ""), "no code is offered for review");
        let unhonoured = unhonoured_inclusions(&included, &content.added, &content.withheld);
        assert_eq!(unhonoured.len(), 1, "including another application's name must refuse the push");

        // Without any inclusion it is still named as the other application's.
        let mut wb = Workbook::default();
        wb.named_ranges = vec![workbook_name("FinRate")];
        let (withheld, _) = run(&mut wb, &scope(Some(&l), &subs));
        assert_eq!(withheld[0].reason, WithheldReason::OtherApplication, "{withheld:?}");
        // ...and the author's OWN name beside it is still theirs to include.
        let mut wb = Workbook::default();
        wb.named_ranges = vec![workbook_name("MyRate")];
        let (withheld, _) = run(&mut wb, &scope(Some(&l), &subs));
        assert!(withheld[0].includable && withheld[0].reason == WithheldReason::NotInApplication, "{withheld:?}");
    }

    /// The Custom Functions record and reserved (`__calcula_`) records are
    /// never includable either, whatever the request says.
    ///
    /// SABOTAGE: make `is_never_includable_id` return `false`.
    #[test]
    fn the_custom_functions_record_and_reserved_ids_are_never_includable() {
        let l = link(&[], &[], &[], Some(&[]));
        let reserved = SavedScript { source: "internal".into(), ..module("__calcula_view_state", None) };
        let unparseable_library = SavedScript { source: "not json".into(), ..library(serde_json::json!([])) };
        let included = [
            include(WithheldKind::ModuleScript, "__calcula_view_state", "internal"),
            include(WithheldKind::ModuleScript, CUSTOM_FUNCTIONS_LIB_ID, "not json"),
        ];
        let mut wb = Workbook::default();
        wb.scripts = vec![reserved, unparseable_library];
        let content = withhold_content_not_in_application(&mut wb, &mut None, &scope_including(Some(&l), &[], &included));
        assert!(wb.scripts.is_empty(), "{:?}", wb.scripts.iter().map(|s| &s.id).collect::<Vec<_>>());
        assert!(content.added.is_empty());
        assert_eq!(content.withheld.len(), 2, "{:?}", content.withheld);
        assert!(content.withheld.iter().all(|w| !w.includable && w.code.is_empty()), "{:?}", content.withheld);
    }

    /// Every own module, notebook and name the push withholds carries the hash
    /// of what the dialog would show; another application's carries none.
    #[test]
    fn withheld_own_items_carry_a_content_hash() {
        let l = link(&[], &[], &[], Some(&[]));
        let subs = [subscription("finance", &[("notebook", "nb-fin")])];
        let mut wb = Workbook::default();
        wb.scripts = vec![module("macro-mine", None)];
        wb.notebooks = vec![notebook_with("nb-mine", &["1"]), notebook("nb-fin", Some("finance"))];
        wb.named_ranges = vec![workbook_name("MYNAME")];
        let (withheld, _) = run(&mut wb, &scope(Some(&l), &subs));
        for w in &withheld {
            match w.reason {
                WithheldReason::NotInApplication => {
                    assert!(!w.content_hash.is_empty(), "{w:?}");
                    assert_eq!(w.content_hash, content_hash(&w.code), "{w:?}");
                }
                WithheldReason::OtherApplication => assert!(w.content_hash.is_empty(), "{w:?}"),
            }
        }
        assert_eq!(withheld.len(), 4, "{withheld:?}");
    }

    /// A TICK FOR CODE THAT CHANGED IS NOT A TICK FOR THIS CODE. The author read
    /// one source; the carrier now holds another -- it stays withheld, offered
    /// again under its new hash.
    ///
    /// SABOTAGE: drop `&& i.hash == item.content_hash` from `PushScope::includes`.
    #[test]
    fn a_stale_inclusion_does_not_keep_changed_code() {
        let l = link(&[], &[], &[], Some(&[]));
        let reviewed = [include(WithheldKind::ModuleScript, "macro-new", "// what the author read")];
        let mut wb = Workbook::default();
        wb.scripts = vec![SavedScript { source: "fetch('https://example.invalid')".into(), ..module("macro-new", None) }];
        let content = withhold_content_not_in_application(&mut wb, &mut None, &scope_including(Some(&l), &[], &reviewed));
        assert!(wb.scripts.is_empty(), "changed code shipped on a stale tick");
        assert!(content.added.is_empty());
        assert_eq!(content.withheld[0].content_hash, content_hash("fetch('https://example.invalid')"));
    }

    /// The push's second check: every requested inclusion must be on the
    /// carrier with the hash the author read.
    ///
    /// SABOTAGE: drop `&& a.content_hash == req.hash` from `unhonoured_inclusions`.
    #[test]
    fn unhonoured_inclusions_name_what_changed_what_is_foreign_and_what_is_gone() {
        let mine = |id: &str, code: &str| WithheldContent::yours(WithheldKind::ModuleScript, id, id, code, String::new());
        let added = [mine("macro-ok", "ok"), mine("macro-swapped", "new bytes")];
        let withheld = [
            mine("macro-edited", "edited"),
            WithheldContent::new(WithheldKind::ModuleScript, "macro-fin", "Fin", Some("finance".into())),
        ];
        let requested = [
            include(WithheldKind::ModuleScript, "macro-ok", "ok"),
            include(WithheldKind::ModuleScript, "macro-swapped", "old bytes"),
            include(WithheldKind::ModuleScript, "macro-edited", "before the edit"),
            include(WithheldKind::ModuleScript, "macro-fin", "x"),
            include(WithheldKind::ModuleScript, "macro-gone", "y"),
        ];
        let got: Vec<(String, String)> = unhonoured_inclusions(&requested, &added, &withheld)
            .into_iter()
            .map(|u| (u.item.id, u.why))
            .collect();
        let ids: Vec<&str> = got.iter().map(|(id, _)| id.as_str()).collect();
        assert_eq!(ids, vec!["macro-swapped", "macro-edited", "macro-fin", "macro-gone"], "{got:?}");
        assert!(got[0].1.contains("changed since you reviewed it"), "{got:?}");
        assert!(got[1].1.contains("changed since you reviewed it"), "{got:?}");
        assert!(got[2].1.contains("'finance'"), "{got:?}");
        assert!(got[3].1.contains("no longer"), "{got:?}");
        assert!(unhonoured_inclusions(&requested[..1], &added, &withheld).is_empty(), "an exact match is honoured");
    }
}
