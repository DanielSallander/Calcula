//! FILENAME: core/calp/src/working_copy.rs
//! PURPOSE: The working-copy link — a `.cala`'s record of the application it is
//! a working copy of. Not a WORKSPACE link: it names one application, and the
//! workspace is only how that application is reached.
//! CONTEXT: `.calp` had provenance in one direction only. A subscriber's
//! `Subscription` records where its sheets came from; nothing recorded where a
//! publisher's sheets were going, so the author's own workbook could not answer
//! "which application is this, and which version am I working from" — which is
//! the question every push gate needs answered.

use std::collections::HashMap;

use identity::SheetId;
use serde::{Deserialize, Serialize};

/// A workbook's link to the application it is a working copy of.
///
/// Written at checkout, and at the first publish of a standalone workbook (so
/// creating an application also makes the workbook its working copy). Persisted
/// in the `.cala` beside the subscription manifest and the override layer.
///
/// A workbook holds at most ONE of these. A `.cala` is a working copy of one
/// application; it may separately SUBSCRIBE to others, but it may never be both
/// a working copy and a subscriber of the same application — see
/// `docs/design/calp-workspace-collaboration.md` §2.3.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkingCopyLink {
    pub format_version: u32,
    /// The workspace location in the USER'S spelling — the same string that was
    /// handed to `open_workspace_scoped`, so re-opening resolves to the same
    /// pin scope. (`Subscription::registry_url` carries the same convention.)
    pub registry_url: String,
    pub package_name: String,
    /// The application kind at link time ("report", "dataset", …). Advisory: it
    /// prefills the push dialog rather than gating anything.
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub kind: String,
    /// The version this working copy was checked out from, or last pushed /
    /// merged to. This is the base the next push declares, and the value the
    /// base-version gate compares against the workspace head.
    pub base_version: String,
    pub checked_out_at: String,
    /// The last version pushed FROM this working copy; empty until it pushes.
    /// Kept beside `base_version` (which it usually equals after a push)
    /// because they diverge the moment a checkout is made from an older
    /// version, and the status UI wants to say so.
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub last_pushed_version: String,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub last_pushed_at: String,
    /// The sheets the base version contained. The push dialog defaults its
    /// sheet selection to these, so a push does not silently drop a sheet the
    /// application had merely because the author did not re-tick it — and it
    /// does so OFFLINE, without a workspace round trip.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub base_sheets: Vec<WorkingCopySheetRef>,
    /// Ids of the module scripts and notebooks the base version contained.
    ///
    /// THE SAME JOB `base_sheets` DOES, for content that has no tick list.
    /// Checkout stopped replacing the document, so a working copy now holds the
    /// author's OWN scripts and notebooks beside the application's — and a push
    /// published every one of them, because `publish()` reads a `None` script
    /// list as "all from the workbook". A private module holding an API token
    /// went into the shared workspace, checksummed and signed under the
    /// author's key, disclosed only as a bare count.
    ///
    /// Empty means "the application has none" whenever the link carries its
    /// record ([`WorkingCopyLink::content_recorded`]). A link from before the
    /// record existed cannot say which, and a push from it is REFUSED by the
    /// host (`CALP_PUSH_LINK_UNRECORDED`) rather than falling back to publishing
    /// everything -- the leak the record exists to close.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub base_script_ids: Vec<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub base_notebook_ids: Vec<String>,
    /// UPPERCASED keys of the workbook-scoped named ranges the base version had.
    ///
    /// Same job again, and the same leak: a pull is ADDITIVE for names, so an
    /// application whose `RATE` collides with the author's own is silently
    /// dropped — and `publish()` then ships the AUTHOR's `RATE` as the
    /// application's, pointing at a sheet the package does not even contain.
    /// Every subscriber's next refresh takes that definition.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub base_named_range_keys: Vec<String>,
    /// Ids of the Controls-pane controls the base version carried (BUG-0261).
    ///
    /// Same job again. Pane controls are workbook-scoped, and checkout is
    /// additive, so the author's own pane controls -- and any pulled in by a
    /// SUBSCRIPTION to another application -- sit beside the application's, and a
    /// push shipped every one of them together with their `pane-{id}` object
    /// scripts, signed under the author's key.
    ///
    /// An `Option`, unlike the lists above, because "the application had no pane
    /// controls" and "not recorded" must be different answers: an empty list
    /// read as "not recorded" would publish every private pane control of a
    /// working copy whose application has none. `None` is a link written before
    /// this field existed: the assembly reads it as empty and a real push from
    /// it is refused ([`WorkingCopyLink::content_recorded`]).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub base_pane_control_ids: Option<Vec<String>>,
    /// TRIMMED, UPPERCASED names of the Custom Functions the base version
    /// carried (BUG-0261).
    ///
    /// Same job again, one level down. The Custom Functions library is ONE
    /// record (`__calcula_custom_functions__`) merged per function on every
    /// pull, so the author's own functions -- which may declare `net.fetch` --
    /// sit in the same record as the application's, and a push shipped the whole
    /// record. A function another application brought in is recognisable by its
    /// `sourcePackage` stamp; the author's own carries none, and neither does a
    /// function a standalone workbook published as a NEW application. This list
    /// is what tells those two apart.
    ///
    /// An `Option` for the pane-control reason: "the application had no
    /// functions" (`Some([])`) must not read as "not recorded" (`None`, a link
    /// from before the field, whose push the host refuses).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub base_custom_function_names: Option<Vec<String>>,
    /// WHICH STREAMS this working copy's publisher-side reads collect for the
    /// application's writeback regions (Writeback > Collect From, 2026-10-22):
    /// Collected Responses, its exports, the roster, review, the submission
    /// watch, scripts and the author's BI writeback tables all read through it.
    ///
    /// `None` is the DEFAULT, decided by the owner: the LAST environment of the
    /// application's pipeline (production, as a rule) when it has environments,
    /// and every stream -- which is then just the development line -- when it
    /// has none. Test answers must never reach a production model table merely
    /// because nobody chose; a person who wants them ticks them.
    ///
    /// A view of the application's answers that belongs to THIS workbook: user
    /// files never reach a package, so a subscriber never sees it, and it
    /// changes nothing anyone else reads. Read it through
    /// [`WorkingCopyLink::collect_choice`], which drops what a hand-edited file
    /// could smuggle in (an empty set, a name no environment may carry).
    ///
    /// LENIENT on read: a value of the wrong shape reads as no choice instead
    /// of failing the whole link -- which would open the workbook as
    /// standalone and lose what it is a working copy OF.
    #[serde(default, skip_serializing_if = "Option::is_none", deserialize_with = "lenient_collect_streams")]
    pub collect_streams: Option<CollectStreams>,
    #[serde(flatten, default, skip_serializing_if = "HashMap::is_empty")]
    pub extra: HashMap<String, serde_json::Value>,
}

/// `collect_streams` from whatever a `.cala` holds: the stored shape, or no
/// choice (the default) for anything else.
fn lenient_collect_streams<'de, D>(deserializer: D) -> Result<Option<CollectStreams>, D::Error>
where
    D: serde::Deserializer<'de>,
{
    let raw = Option::<serde_json::Value>::deserialize(deserializer)?;
    Ok(raw.and_then(|v| serde_json::from_value::<CollectStreams>(v).ok()))
}

/// The publisher's explicit choice of streams to collect from. The absence of a
/// choice (`WorkingCopyLink::collect_streams == None`) is the default, the last
/// environment of the pipeline -- see that field.
///
/// Serialised as `"all"` or `{"only": ["", "prod"]}`: a unit and a newtype
/// variant, never a struct variant (whose fields `rename_all` would not touch).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum CollectStreams {
    /// Every stream, including environments defined after the choice.
    All,
    /// Exactly these streams; `""` is the development line. An environment
    /// defined later is NOT collected until it is ticked.
    Only(std::collections::BTreeSet<String>),
}

/// What the base version carried, beyond its sheets: the record every push
/// filters against (`WorkingCopyLink::record_content` / `record_push`).
///
/// Named fields rather than positional arguments: these are five lists of the
/// same type, and two swapped positional lists compile.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct WorkingCopyContent {
    pub script_ids: Vec<String>,
    pub notebook_ids: Vec<String>,
    /// UPPERCASED workbook-scoped name keys.
    pub named_range_keys: Vec<String>,
    pub pane_control_ids: Vec<String>,
    /// TRIMMED, UPPERCASED Custom Functions names.
    pub custom_function_names: Vec<String>,
}

/// One sheet of the base version: its application sheet id and the name it had.
///
/// There is deliberately no local-id field. Checkout preserves application sheet
/// ids, so in a working copy the application id and the local id are the same
/// value — recording a mapping would be recording that they are equal, and a
/// second copy of a fact is a second place for it to go wrong.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkingCopySheetRef {
    pub sheet_id: SheetId,
    pub name: String,
}

impl WorkingCopyLink {
    /// A link for a working copy freshly checked out at `version`.
    pub fn new(
        registry_url: &str,
        package_name: &str,
        kind: &str,
        version: &str,
        now: &str,
        base_sheets: Vec<WorkingCopySheetRef>,
    ) -> Self {
        Self {
            format_version: 1,
            registry_url: registry_url.to_string(),
            package_name: package_name.to_string(),
            kind: kind.to_string(),
            base_version: version.to_string(),
            checked_out_at: now.to_string(),
            last_pushed_version: String::new(),
            last_pushed_at: String::new(),
            base_sheets,
            // Filled by `record_content` right after construction — the caller
            // has the pulled result, this constructor does not.
            base_script_ids: Vec::new(),
            base_notebook_ids: Vec::new(),
            base_named_range_keys: Vec::new(),
            base_pane_control_ids: None,
            base_custom_function_names: None,
            // The default (the last environment), until the publisher chooses.
            collect_streams: None,
            extra: HashMap::new(),
        }
    }

    /// The stored Collect From choice, NORMALISED: names no environment may
    /// carry are dropped, and an empty set reads as no choice (the default).
    ///
    /// The setter refuses both, but the value is also restored from a `.cala`
    /// that anyone may have hand-edited, and an empty or misspelled set there
    /// would make every publisher-side read report "No submissions yet" with
    /// no error anywhere.
    pub fn collect_choice(&self) -> Option<CollectStreams> {
        match &self.collect_streams {
            None => None,
            Some(CollectStreams::All) => Some(CollectStreams::All),
            Some(CollectStreams::Only(set)) => {
                let kept: std::collections::BTreeSet<String> = set
                    .iter()
                    .filter(|s| s.is_empty() || crate::environments::validate_environment_name(s).is_ok())
                    .cloned()
                    .collect();
                if kept.is_empty() {
                    None
                } else {
                    Some(CollectStreams::Only(kept))
                }
            }
        }
    }

    /// Carry the Collect From choice over from the link this one REPLACES, when
    /// both name the same application in the same workspace (checkout of the
    /// application this workbook was already linked to). Without it, opening
    /// the same application for editing again would silently widen or move
    /// what the author's model tables collect. A different application starts
    /// from the default.
    pub fn carry_collect_choice_from(&mut self, replaced: Option<&WorkingCopyLink>) {
        if let Some(old) = replaced {
            if old.targets(&self.registry_url, &self.package_name) {
                self.collect_streams = old.collect_streams.clone();
            }
        }
    }

    /// Record which module scripts, notebooks, names, pane controls and custom
    /// functions the base version carried.
    ///
    /// Separate from `new` because the ids come from the pulled result rather
    /// than from the link's own identity, and both the checkout and the
    /// first-publish paths build the link before they have them.
    pub fn record_content(&mut self, content: WorkingCopyContent) {
        let WorkingCopyContent {
            script_ids,
            notebook_ids,
            named_range_keys,
            pane_control_ids,
            custom_function_names,
        } = content;
        self.base_script_ids = script_ids;
        self.base_notebook_ids = notebook_ids;
        self.base_named_range_keys = named_range_keys;
        // Always `Some`: this link was written by a build that knows the
        // fields, so an empty list means "the application has none".
        self.base_pane_control_ids = Some(pane_control_ids);
        self.base_custom_function_names = Some(custom_function_names);
    }

    /// Whether this link carries the record of what its base version held
    /// (`record_content` / `record_push` always write both optional lists).
    ///
    /// `false` only for a link written before the record existed: its empty
    /// lists cannot say whether the application had nothing or nothing was
    /// recorded, so a push from it cannot tell the application's content from
    /// the author's own. The host refuses such a push rather than guess either
    /// way (`CALP_PUSH_LINK_UNRECORDED`).
    pub fn content_recorded(&self) -> bool {
        self.base_pane_control_ids.is_some() && self.base_custom_function_names.is_some()
    }

    /// Whether this link targets the given application in the given workspace.
    ///
    /// The workspace comparison is on the user's spelling, case-insensitively
    /// and ignoring a trailing separator, because the same share reached as
    /// `\\srv\reports` and `\\srv\reports\` is the same share. Callers that
    /// need workspace IDENTITY rather than a UI convenience should compare
    /// `WorkspaceScope::id`s instead — this is the prefill/gate check, and it
    /// errs toward "yes, that's your application" so the gate's refusal text is
    /// about the real problem rather than a trailing backslash.
    pub fn targets(&self, registry_url: &str, package_name: &str) -> bool {
        self.package_name == package_name
            && crate::workspace_id::same_workspace(&self.registry_url, registry_url)
    }

    /// Record a successful push: the pushed version becomes the new base.
    pub fn record_push(
        &mut self,
        version: &str,
        now: &str,
        sheets: Vec<WorkingCopySheetRef>,
        // What actually shipped, so the NEXT push's filter is measured against
        // this version rather than against the checkout's. A script added to the
        // application by this push belongs to it from now on.
        shipped: WorkingCopyContent,
    ) {
        self.base_version = version.to_string();
        self.last_pushed_version = version.to_string();
        self.last_pushed_at = now.to_string();
        self.base_sheets = sheets;
        self.record_content(shipped);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn link() -> WorkingCopyLink {
        WorkingCopyLink::new(
            r"\\server\reports",
            "sales",
            "report",
            "1.2.0",
            "2026-08-29T00:00:00Z",
            Vec::new(),
        )
    }

    #[test]
    fn targets_ignores_trailing_separator_and_case() {
        let l = link();
        assert!(l.targets(r"\\server\reports", "sales"));
        assert!(l.targets(r"\\server\reports\", "sales"));
        assert!(l.targets(r"\\SERVER\Reports", "sales"));
        assert!(!l.targets(r"\\server\other", "sales"));
        // The application name is NOT case-folded: workspaces are case-sensitive
        // directories and the pin store's exact `get` is too.
        assert!(!l.targets(r"\\server\reports", "Sales"));
    }

    #[test]
    fn record_push_advances_the_base() {
        let mut l = link();
        assert_eq!(l.last_pushed_version, "");
        l.record_push(
            "1.3.0",
            "2026-08-30T00:00:00Z",
            Vec::new(),
            WorkingCopyContent::default(),
        );
        assert_eq!(l.base_version, "1.3.0");
        assert_eq!(l.last_pushed_version, "1.3.0");
        assert_eq!(l.last_pushed_at, "2026-08-30T00:00:00Z");
    }

    /// Each list lands in ITS field. Five lists of one type were positional
    /// arguments until BUG-0261 added the fifth; two swapped lists compile, and
    /// a swap would filter the next push against the wrong kind of id.
    #[test]
    fn a_push_records_each_list_in_its_own_field() {
        let mut l = link();
        let ids = |s: &str| vec![s.to_string()];
        l.record_push(
            "1.3.0",
            "2026-08-30T00:00:00Z",
            Vec::new(),
            WorkingCopyContent {
                script_ids: ids("macro-1"),
                notebook_ids: ids("nb-1"),
                named_range_keys: ids("RATE"),
                pane_control_ids: ids("pc-1"),
                custom_function_names: ids("FXRATE"),
            },
        );
        assert_eq!(l.base_script_ids, ids("macro-1"));
        assert_eq!(l.base_notebook_ids, ids("nb-1"));
        assert_eq!(l.base_named_range_keys, ids("RATE"));
        assert_eq!(
            l.base_pane_control_ids,
            Some(ids("pc-1")),
            "a push records what shipped, so the next push is measured from it"
        );
        assert_eq!(l.base_custom_function_names, Some(ids("FXRATE")));
    }

    /// "The application has none" is not "not recorded" (BUG-0261), for pane
    /// controls and for custom functions alike.
    ///
    /// An empty base list must survive a save as an EMPTY list, or the push
    /// filter reads it as a link written before the field existed and publishes
    /// every private pane control -- or every private custom function -- of a
    /// working copy whose application has none.
    ///
    /// SABOTAGE: have `record_content` store an empty function list as `None`
    /// (the empty record then reads as "not recorded").
    #[test]
    fn an_empty_record_is_not_the_same_as_no_record() {
        let mut l = link();
        assert_eq!(l.base_pane_control_ids, None, "a fresh link has recorded nothing yet");
        assert!(!l.content_recorded(), "a fresh link has not recorded its content");
        assert_eq!(l.base_custom_function_names, None, "a fresh link has recorded nothing yet");
        l.record_content(WorkingCopyContent::default());
        assert!(l.content_recorded(), "an EMPTY record is a record");
        assert_eq!(l.base_pane_control_ids, Some(Vec::new()));
        assert_eq!(l.base_custom_function_names, Some(Vec::new()));

        let json = serde_json::to_string(&l).unwrap();
        assert!(json.contains("\"basePaneControlIds\":[]"), "{json}");
        assert!(json.contains("\"baseCustomFunctionNames\":[]"), "{json}");
        let back: WorkingCopyLink = serde_json::from_str(&json).unwrap();
        assert_eq!(back.base_pane_control_ids, Some(Vec::new()), "the empty record survives a save");
        assert_eq!(back.base_custom_function_names, Some(Vec::new()), "the empty record survives a save");

        // A link from before the fields existed deserializes as "not recorded".
        let legacy = json
            .replace(",\"basePaneControlIds\":[]", "")
            .replace(",\"baseCustomFunctionNames\":[]", "");
        assert!(!legacy.contains("basePaneControlIds"), "{legacy}");
        assert!(!legacy.contains("baseCustomFunctionNames"), "{legacy}");
        let old: WorkingCopyLink = serde_json::from_str(&legacy).unwrap();
        assert_eq!(old.base_pane_control_ids, None);
        assert_eq!(old.base_custom_function_names, None);
        assert!(!old.content_recorded(), "an old link's push is refused, not guessed");
    }

    /// The Collect From choice survives a save in both shapes, a link without
    /// it reads as the default, and the wire shape is `"all"` /
    /// `{"only": [...]}` under the camelCase key.
    ///
    /// SABOTAGE: mark `collect_streams` `#[serde(skip_serializing)]` -- the
    /// choice is lost on every save and the round trip fails.
    #[test]
    fn the_collect_choice_round_trips_and_defaults_to_none() {
        let mut l = link();
        assert_eq!(l.collect_streams, None, "a fresh link uses the default");
        let plain = serde_json::to_string(&l).unwrap();
        assert!(!plain.contains("collectStreams"), "no choice, no key: {plain}");

        l.collect_streams = Some(CollectStreams::Only(["".to_string(), "prod".to_string()].into_iter().collect()));
        let json = serde_json::to_string(&l).unwrap();
        assert!(json.contains("\"collectStreams\":{\"only\":[\"\",\"prod\"]}"), "{json}");
        let back: WorkingCopyLink = serde_json::from_str(&json).unwrap();
        assert_eq!(back, l);

        l.collect_streams = Some(CollectStreams::All);
        let json = serde_json::to_string(&l).unwrap();
        assert!(json.contains("\"collectStreams\":\"all\""), "{json}");
        let back: WorkingCopyLink = serde_json::from_str(&json).unwrap();
        assert_eq!(back.collect_streams, Some(CollectStreams::All));

        let old: WorkingCopyLink = serde_json::from_str(&plain).unwrap();
        assert_eq!(old.collect_streams, None);
    }

    /// A hand-edited or corrupted `.cala` cannot make the publisher collect
    /// nothing in silence: an empty set, or a set of names no environment may
    /// carry, reads as the default; a valid name beside a bad one is kept.
    ///
    /// SABOTAGE: return `self.collect_streams.clone()` from `collect_choice`.
    #[test]
    fn a_stored_choice_is_normalised_on_read() {
        let mut l = link();
        l.collect_streams = Some(CollectStreams::Only(Default::default()));
        assert_eq!(l.collect_choice(), None, "an empty set is no choice");
        l.collect_streams = Some(CollectStreams::Only(["Prod".to_string(), "../x".to_string()].into_iter().collect()));
        assert_eq!(l.collect_choice(), None, "names no environment may carry are dropped");
        l.collect_streams = Some(CollectStreams::Only(["Prod".to_string(), "prod".to_string(), "".to_string()].into_iter().collect()));
        assert_eq!(
            l.collect_choice(),
            Some(CollectStreams::Only(["".to_string(), "prod".to_string()].into_iter().collect()))
        );
        l.collect_streams = Some(CollectStreams::All);
        assert_eq!(l.collect_choice(), Some(CollectStreams::All));

        // A value of the wrong SHAPE reads as no choice -- and, above all,
        // does not fail the whole link (which would reopen the workbook as
        // standalone, forgetting what it is a working copy of).
        let plain = serde_json::to_value(link()).unwrap();
        for bogus in [serde_json::json!("everything"), serde_json::json!({ "only": 5 }), serde_json::json!(7)] {
            let mut v = plain.clone();
            v["collectStreams"] = bogus.clone();
            let back: WorkingCopyLink = serde_json::from_value(v).unwrap_or_else(|e| panic!("{bogus}: {e}"));
            assert_eq!(back.collect_streams, None, "{bogus}");
            assert_eq!(back.package_name, "sales");
        }
    }

    /// Checkout of the SAME application keeps the choice; another application
    /// (or another workspace) starts from the default.
    ///
    /// SABOTAGE: make `carry_collect_choice_from` a no-op.
    #[test]
    fn checkout_of_the_same_application_keeps_the_choice_and_another_resets_it() {
        let mut old = link();
        old.collect_streams = Some(CollectStreams::Only(["prod".to_string()].into_iter().collect()));

        let mut same = WorkingCopyLink::new(r"\\SERVER\reports\", "sales", "report", "1.3.0", "t", Vec::new());
        same.carry_collect_choice_from(Some(&old));
        assert_eq!(same.collect_streams, old.collect_streams, "same application: the choice is kept");

        let mut other = WorkingCopyLink::new(r"\\server\reports", "budget", "report", "1.0.0", "t", Vec::new());
        other.carry_collect_choice_from(Some(&old));
        assert_eq!(other.collect_streams, None, "another application starts at the default");

        let mut elsewhere = WorkingCopyLink::new(r"\\server\other", "sales", "report", "1.0.0", "t", Vec::new());
        elsewhere.carry_collect_choice_from(Some(&old));
        assert_eq!(elsewhere.collect_streams, None, "another workspace starts at the default");

        let mut first = WorkingCopyLink::new(r"\\server\reports", "sales", "report", "1.0.0", "t", Vec::new());
        first.carry_collect_choice_from(None);
        assert_eq!(first.collect_streams, None);
    }

    #[test]
    fn round_trips_through_json_with_camel_case_keys() {
        let mut l = link();
        l.base_sheets = vec![WorkingCopySheetRef {
            sheet_id: SheetId::from_bytes(identity::generate_uuid_v7()),
            name: "Dashboard".to_string(),
        }];
        let json = serde_json::to_string(&l).unwrap();
        assert!(json.contains("\"baseVersion\""), "camelCase over the wire: {json}");
        assert!(json.contains("\"baseSheets\""));
        // Empty optional strings are omitted rather than written as "".
        assert!(!json.contains("lastPushedVersion"));
        let back: WorkingCopyLink = serde_json::from_str(&json).unwrap();
        assert_eq!(back, l);
    }
}
