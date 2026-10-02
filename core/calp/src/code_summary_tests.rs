//! FILENAME: core/calp/src/code_summary_tests.rs
//! PURPOSE: The promotion's code summary (plan_M8 S4), behaviourally: what each
//! kind of code reads as, what it means for subscribers, and what is never
//! read at all.
//! CONTEXT: Built over in-memory sides (hand-made manifests and artifacts) and,
//! for the checked reader, a `MemoryWorkspace`. Each test names the sabotage
//! that must turn it red.

use std::collections::BTreeMap;

use serde_json::{json, Value};

use super::*;
use crate::diff::{DiffOptions, DiffSide};
use crate::manifest::{
    PublishedCustomObject, PublishedModuleScript, PublishedNotebook, PublishedObjectScript, VersionManifest,
};
use crate::memory_workspace::MemoryWorkspace;
use crate::transport::WorkspaceTransport;

const SHEET: &str = "0190a000-0000-7000-8000-000000000001";

/// One hand-built version: a manifest and its artifacts.
#[derive(Clone)]
struct V {
    manifest: VersionManifest,
    artifacts: BTreeMap<String, Vec<u8>>,
}

impl V {
    fn new(version: &str) -> Self {
        let manifest: VersionManifest = serde_json::from_value(json!({
            "formatVersion": 1,
            "packageName": "sales",
            "version": version,
            "publishedAt": "2026-10-01T00:00:00Z",
            "sheets": [{ "sheetId": SHEET, "name": "Dashboard" }],
        }))
        .unwrap();
        V { manifest, artifacts: BTreeMap::new() }
    }

    fn put(mut self, rel: &str, value: Value) -> Self {
        self.artifacts.insert(rel.to_string(), serde_json::to_vec_pretty(&value).unwrap());
        self
    }

    fn module(mut self, id: &str, name: &str, source: &str) -> Self {
        self.manifest.module_scripts.push(PublishedModuleScript {
            id: id.to_string(),
            name: name.to_string(),
            scope: "workbook".to_string(),
            description: None,
        });
        self.put(
            &format!("modules/{id}.json"),
            json!({ "id": id, "name": name, "source": source, "scope": { "type": "workbook" } }),
        )
    }

    /// An object script whose MANIFEST ceiling is `caps` (what publish lifts
    /// from the pragmas; set explicitly so a test can make them disagree).
    fn object_script(mut self, id: &str, name: &str, source: &str, caps: &[&str]) -> Self {
        self.manifest.object_scripts.push(PublishedObjectScript {
            id: id.to_string(),
            name: name.to_string(),
            object_type: "workbook".to_string(),
            instance_id: None,
            description: None,
            capabilities: caps.iter().map(|c| c.to_string()).collect(),
        });
        self.put(
            &format!("object_scripts/{id}.json"),
            json!({ "id": id, "name": name, "objectType": "workbook", "source": source }),
        )
    }

    fn notebook(mut self, id: &str, name: &str, cells: &[(&str, &str)]) -> Self {
        self.manifest.notebooks.push(PublishedNotebook {
            id: id.to_string(),
            name: name.to_string(),
            cell_count: cells.len(),
            description: None,
        });
        let cells: Vec<Value> = cells.iter().map(|(cid, src)| json!({ "id": cid, "source": src })).collect();
        self.put(&format!("notebooks/{id}.json"), json!({ "id": id, "name": name, "cells": cells }))
    }

    /// A module LISTED under `listed_id` whose file says its id is `def_id`.
    /// Publish never writes one; a hand-built, signed version can, and a
    /// subscriber's pull materializes it under the FILE's id.
    fn module_file(mut self, listed_id: &str, def_id: &str, name: &str, source: &str) -> Self {
        self.manifest.module_scripts.push(PublishedModuleScript {
            id: listed_id.to_string(),
            name: name.to_string(),
            scope: "workbook".to_string(),
            description: None,
        });
        self.put(
            &format!("modules/{listed_id}.json"),
            json!({ "id": def_id, "name": name, "source": source, "scope": { "type": "workbook" } }),
        )
    }

    /// An object script LISTED under `listed_id` whose file says its id is `def_id`.
    fn object_script_file(mut self, listed_id: &str, def_id: &str, source: &str, caps: &[&str]) -> Self {
        self.manifest.object_scripts.push(PublishedObjectScript {
            id: listed_id.to_string(),
            name: "On open".to_string(),
            object_type: "workbook".to_string(),
            instance_id: None,
            description: None,
            capabilities: caps.iter().map(|c| c.to_string()).collect(),
        });
        self.put(
            &format!("object_scripts/{listed_id}.json"),
            json!({ "id": def_id, "name": "On open", "objectType": "workbook", "source": source }),
        )
    }

    /// A notebook LISTED under `listed_id` whose file says its id is `def_id`.
    fn notebook_file(mut self, listed_id: &str, def_id: &str, name: &str, cells: &[(&str, &str)]) -> Self {
        self.manifest.notebooks.push(PublishedNotebook {
            id: listed_id.to_string(),
            name: name.to_string(),
            cell_count: cells.len(),
            description: None,
        });
        let cells: Vec<Value> = cells.iter().map(|(cid, src)| json!({ "id": cid, "source": src })).collect();
        self.put(&format!("notebooks/{listed_id}.json"), json!({ "id": def_id, "name": name, "cells": cells }))
    }

    /// `controls.json` exactly as given (several sheet groups, say).
    fn controls_groups(self, groups: Value) -> Self {
        self.put("controls.json", groups)
    }

    /// One MORE `cellType` custom object for the sheet, after any earlier one.
    fn more_cell_types(mut self, cells: Value) -> Self {
        let n = self.manifest.custom_objects.len();
        let payload = format!("custom_objects/{n}.json");
        self.manifest.custom_objects.push(PublishedCustomObject {
            kind: CELL_TYPE_OBJECT_KIND.to_string(),
            id: format!("cell-types-{n}"),
            name: String::new(),
            sheet_id: identity::SheetId::parse(SHEET),
            payload_path: payload.clone(),
            extra: Default::default(),
        });
        self.put(&payload, cells)
    }

    fn functions(self, library: Value) -> Self {
        self.module(CUSTOM_FUNCTIONS_LIB_ID, "Custom Functions", &library.to_string())
    }

    fn controls(self, controls: Value) -> Self {
        self.put("controls.json", json!([{ "sheetId": SHEET, "controls": controls }]))
    }

    fn cell_types(mut self, cells: Value) -> Self {
        self.manifest.custom_objects.push(PublishedCustomObject {
            kind: CELL_TYPE_OBJECT_KIND.to_string(),
            id: "cell-types".to_string(),
            name: String::new(),
            sheet_id: identity::SheetId::parse(SHEET),
            payload_path: "custom_objects/0.json".to_string(),
            extra: Default::default(),
        });
        self.put("custom_objects/0.json", cells)
    }

    fn validator(mut self, region: &str, name: &str, source: Option<&str>) -> Self {
        let mut schema = json!({ "valueType": "number", "customValidator": name });
        if let Some(src) = source {
            schema["customValidatorSource"] = json!(src);
        }
        let declaration = serde_json::from_value(json!({
            "id": region,
            "selector": { "sheetId": SHEET, "rowStart": 0, "rowEnd": 2, "colStart": 0, "colEnd": 0 },
            "schema": schema,
        }))
        .unwrap();
        self.manifest.writeback_regions.get_or_insert_with(Vec::new).push(declaration);
        self
    }

    fn side(&self) -> DiffSide<'_> {
        DiffSide::InMemory { manifest: &self.manifest, artifacts: &self.artifacts }
    }
}

fn summary_with(from: Option<&V>, to: &V, allowed: &[&str]) -> CodeSummary {
    let from_side = from.map(|v| v.side());
    code_summary(from_side.as_ref(), &to.side(), &DiffOptions::default(), allowed).expect("code summary")
}

fn summary(from: Option<&V>, to: &V) -> CodeSummary {
    summary_with(from, to, &[])
}

fn listing(s: &CodeSummary) -> String {
    s.changes
        .iter()
        .map(|c| format!("{:?} {} {:?} {:?}", c.kind, c.id, c.change, c.consequence))
        .collect::<Vec<_>>()
        .join("\n")
}

fn row<'a>(s: &'a CodeSummary, kind: CodeKind, id_contains: &str) -> &'a CodeChange {
    s.changes
        .iter()
        .find(|c| c.kind == kind && c.id.contains(id_contains))
        .unwrap_or_else(|| panic!("no {kind:?} row for `{id_contains}` in:\n{}", listing(s)))
}

fn button(row: u64, col: u64, props: Value) -> Value {
    json!({ "row": row, "col": col, "controlType": "button", "properties": props })
}

fn stat(value: &str) -> Value {
    json!({ "valueType": "static", "value": value })
}

/// A first promotion has no "before": every piece of code of the target is new,
/// and everybody is asked.
///
/// SABOTAGE: have `code_summary` return an empty summary when `from` is None.
#[test]
fn a_first_promotion_lists_every_code_item_as_new() {
    let to = V::new("1.0.0")
        .module("mod-report", "Report", "Calcula.setCellValue(0, 0, 'ran');")
        .object_script("obj-1", "On open", "function setup(context) {}", &[])
        .notebook("nb-1", "Analysis", &[("c1", "1 + 1")])
        .functions(json!({ "functions": [{ "name": "DOUBLE", "params": ["x"], "body": "return x * 2;" }] }))
        .controls(json!([button(3, 1, json!({ "onSelect": stat("Report();"), "text": stat("Go") }))]))
        .cell_types(json!([
            { "row": 2, "col": 2, "typeId": "calcula.button", "params": { "label": "Run", "action": { "kind": "script", "scriptId": "mod-report" } } }
        ]))
        .validator("region-1", "positive", Some("(v) => v > 0"));

    let s = summary(None, &to);
    assert_eq!(s.changes.len(), 7, "every code item, once:\n{}", listing(&s));
    assert!(
        s.changes.iter().all(|c| c.change == CodeChangeKind::Added),
        "a first promotion has only additions:\n{}",
        listing(&s)
    );
    assert!(s.asks_approval_again, "a first promotion asks everyone");
    assert_eq!(row(&s, CodeKind::Macro, "mod-report").consequence, SubscriberConsequence::AsksApprovalAgain);
    assert_eq!(row(&s, CodeKind::ObjectScript, "obj-1").consequence, SubscriberConsequence::AsksApprovalAgain);
    assert_eq!(row(&s, CodeKind::Notebook, "nb-1").consequence, SubscriberConsequence::AsksApprovalAgain);
    assert_eq!(row(&s, CodeKind::CustomFunction, "DOUBLE").consequence, SubscriberConsequence::AsksApprovalAgain);
    assert_eq!(row(&s, CodeKind::ButtonCode, "B4:onSelect").consequence, SubscriberConsequence::AsksApprovalAgain);
    assert_eq!(row(&s, CodeKind::WritebackValidator, "region-1").consequence, SubscriberConsequence::AsksApprovalAgain);
    // The button cell runs the macro, whose own row is what asks.
    let cell = row(&s, CodeKind::ButtonCellAction, "C3:action");
    assert_eq!(cell.consequence, SubscriberConsequence::RunsAfterApproval);
    assert!(cell.detail.contains("mod-report"), "{}", cell.detail);
    assert!(row(&s, CodeKind::Macro, "mod-report").before.is_none(), "nothing before a first promotion");
}

/// A changed macro asks again, and both sources are shown; an unchanged one is
/// not a row.
///
/// SABOTAGE: drop the module pass (`modules(..)`) from `inventory`.
#[test]
fn a_changed_macro_asks_for_approval_again_and_shows_both_sources() {
    let v1 = V::new("1.0.0").module("mod-a", "A", "return 1;").module("mod-b", "B", "return 'same';");
    let v2 = V::new("1.1.0").module("mod-a", "A", "return 2;").module("mod-b", "B", "return 'same';");
    let s = summary(Some(&v1), &v2);
    assert_eq!(s.changes.len(), 1, "{}", listing(&s));
    let a = row(&s, CodeKind::Macro, "mod-a");
    assert_eq!(a.change, CodeChangeKind::Modified);
    assert_eq!(a.consequence, SubscriberConsequence::AsksApprovalAgain);
    assert_eq!(a.before.as_deref(), Some("return 1;"));
    assert_eq!(a.after.as_deref(), Some("return 2;"));
    assert!(s.asks_approval_again);

    // ...and a ROLLBACK is a change too: each Allow replaces the record, so the
    // older code is asked for again.
    let back = summary(Some(&v2), &v1);
    assert_eq!(row(&back, CodeKind::Macro, "mod-a").consequence, SubscriberConsequence::AsksApprovalAgain);

    // Removed: it stops running.
    let v3 = V::new("1.2.0").module("mod-b", "B", "return 'same';");
    let s = summary(Some(&v2), &v3);
    let gone = row(&s, CodeKind::Macro, "mod-a");
    assert_eq!(gone.change, CodeChangeKind::Removed);
    assert_eq!(gone.consequence, SubscriberConsequence::StopsRunning);
    assert!(!s.asks_approval_again, "a removal asks nobody");

    // Identical versions: nothing.
    assert!(summary(Some(&v2), &v2).changes.is_empty());
}

/// An object script that gains a capability says so -- from the SIGNED
/// manifest's ceiling, which is what a subscriber's pull applies, never from
/// the source.
///
/// SABOTAGE: leave `added_capabilities` empty in `row`.
#[test]
fn an_object_script_that_gains_a_capability_says_so() {
    let v1 = V::new("1.0.0").object_script("obj-1", "Fetcher", "function setup(c) {}", &[]);
    let v2 = V::new("1.1.0").object_script(
        "obj-1",
        "Fetcher",
        "// @capability net.fetch\nfunction setup(c) {}",
        &["net.fetch"],
    );
    let s = summary(Some(&v1), &v2);
    let r = row(&s, CodeKind::ObjectScript, "obj-1");
    assert_eq!(r.added_capabilities, vec!["net.fetch".to_string()]);
    assert_eq!(r.consequence, SubscriberConsequence::AsksApprovalAgain);
    assert!(r.detail.contains("runs on the workbook"), "{}", r.detail);

    // A first promotion: every declared capability is gained.
    let first = summary(None, &v2);
    assert_eq!(row(&first, CodeKind::ObjectScript, "obj-1").added_capabilities, vec!["net.fetch".to_string()]);

    // A pragma the manifest does not declare is NOT a capability the
    // subscriber's script gets, so it is not claimed.
    let v3 = V::new("1.2.0").object_script("obj-1", "Fetcher", "// @capability bi.query\nfunction setup(c) {}", &[]);
    let s = summary(Some(&v1), &v3);
    assert!(row(&s, CodeKind::ObjectScript, "obj-1").added_capabilities.is_empty());
}

/// The custom-function library is one JSON module; it is listed per FUNCTION.
///
/// SABOTAGE: treat `CUSTOM_FUNCTIONS_LIB_ID` as an ordinary macro (skip the
/// `custom_functions` split).
#[test]
fn custom_functions_are_listed_per_function() {
    let v1 = V::new("1.0.0").functions(json!({ "functions": [
        { "name": "DOUBLE", "params": ["x"], "body": "return x * 2;" },
        { "name": "HALF", "params": ["x"], "body": "return x / 2;" },
    ] }));
    let v2 = V::new("1.1.0").functions(json!({ "functions": [
        { "name": "DOUBLE", "params": ["x"], "body": "return x + x;" },
        { "name": "TRIPLE", "params": ["x"], "body": "return x * 3;" },
        { "name": "1BAD", "params": [], "body": "return 0;" },
    ] }));
    let s = summary(Some(&v1), &v2);
    assert!(
        s.changes.iter().all(|c| c.kind == CodeKind::CustomFunction),
        "the library is never a macro:\n{}",
        listing(&s)
    );
    let double = row(&s, CodeKind::CustomFunction, "DOUBLE");
    assert_eq!(double.change, CodeChangeKind::Modified);
    assert_eq!(double.name, "DOUBLE(x)");
    assert!(double.before.as_deref().unwrap().contains("return x * 2;"));
    assert!(double.after.as_deref().unwrap().contains("return x + x;"));
    assert_eq!(double.consequence, SubscriberConsequence::AsksApprovalAgain);
    let half = row(&s, CodeKind::CustomFunction, "HALF");
    assert_eq!(half.change, CodeChangeKind::Removed);
    assert_eq!(half.consequence, SubscriberConsequence::StopsRunning);
    assert!(half.detail.contains("remaining custom functions are asked for again"), "{}", half.detail);
    assert_eq!(row(&s, CodeKind::CustomFunction, "TRIPLE").change, CodeChangeKind::Added);
    assert_eq!(row(&s, CodeKind::CustomFunction, "1BAD").consequence, SubscriberConsequence::RemovedOnArrival);

    // ONE APPROVAL OVER THE SET: removing a function re-asks for the rest.
    let v3 = V::new("1.2.0").functions(json!({ "functions": [
        { "name": "DOUBLE", "params": ["x"], "body": "return x * 2;" },
    ] }));
    let s = summary(Some(&v1), &v3);
    assert_eq!(s.changes.len(), 1, "{}", listing(&s));
    assert!(s.asks_approval_again, "the remaining functions' approval covered the removed one");

    // A library this cannot read as functions is ONE row with the whole text.
    let broken = V::new("1.0.0").module(CUSTOM_FUNCTIONS_LIB_ID, "Custom Functions", "{ not json");
    let s = summary(None, &broken);
    let whole = row(&s, CodeKind::CustomFunction, CUSTOM_FUNCTIONS_LIB_ID);
    assert_eq!(whole.after.as_deref(), Some("{ not json"));
    assert_eq!(s.changes.len(), 1);
}

/// A notebook shows its CELLS' sources, in order -- truncated with the flag set
/// when they exceed the budget.
///
/// SABOTAGE: show the notebook's name instead of its cells (`shown`).
#[test]
fn a_notebook_shows_its_cell_sources() {
    let v1 = V::new("1.0.0").notebook("nb-1", "Analysis", &[("c1", "const a = 1;"), ("c2", "a + 1")]);
    let v2 = V::new("1.1.0").notebook("nb-1", "Analysis", &[("c1", "const a = 2;"), ("c2", "a + 1")]);
    let s = summary(Some(&v1), &v2);
    let r = row(&s, CodeKind::Notebook, "nb-1");
    let after = r.after.as_deref().unwrap();
    assert!(after.contains("// cell c1\nconst a = 2;"), "{after}");
    assert!(after.find("const a = 2;").unwrap() < after.find("a + 1").unwrap(), "in order: {after}");
    assert!(r.before.as_deref().unwrap().contains("const a = 1;"));
    assert_eq!(r.consequence, SubscriberConsequence::AsksApprovalAgain);
    assert!(!r.after_truncated);

    let opts = DiffOptions { max_source_bytes: 12, ..DiffOptions::default() };
    let capped = code_summary(Some(&v1.side()), &v2.side(), &opts, &[]).unwrap();
    let r = row(&capped, CodeKind::Notebook, "nb-1");
    assert!(r.after_truncated && r.before_truncated, "the flags say the text was cut");
    assert!(r.after.as_deref().unwrap().len() <= 12);
}

/// Button CONTROLS: static inline code is held at a subscriber and runs only
/// after the approval of its exact bytes; a link runs after its macro's
/// approval when the application ships that macro and is removed when it does
/// not; formula code is removed; only a button runs anything, and a link that
/// SURVIVES wins over inline code; a package's held key is discarded. A caption
/// edit is not code, and code that merely MOVED asks nobody.
///
/// SABOTAGE: drop the surviving-link branch in `button_controls` (inline code
/// on a linked button then claims to ask for approval).
#[test]
fn inline_button_code_and_links_say_what_subscribers_get() {
    let to = V::new("1.1.0").module("mod-1", "Report", "return 1;").controls(json!([
        button(1, 1, json!({ "onSelect": stat("Report();"), "text": stat("Go") })),
        button(1, 2, json!({ "macroRef": stat("mod-1") })),
        button(1, 3, json!({ "macroRef": stat("missing") })),
        button(1, 4, json!({ "onSelect": { "valueType": "formula", "value": "=A1" } })),
        { "row": 1, "col": 5, "controlType": "checkbox", "properties": { "onSelect": stat("Tick();") } },
        button(1, 6, json!({ "onSelect": stat("Both();"), "macroRef": stat("mod-1") })),
        button(1, 7, json!({ "heldOnSelect": stat("Planted();") })),
        button(1, 8, json!({ "onSelect": stat(""), "text": stat("Empty") })),
    ]));
    let s = summary(None, &to);
    let at = |id: &str| row(&s, CodeKind::ButtonCode, id).consequence;
    assert_eq!(at("B2:onSelect"), SubscriberConsequence::AsksApprovalAgain);
    assert_eq!(row(&s, CodeKind::ButtonCode, "B2:onSelect").name, "B2 \"Go\"");
    assert_eq!(row(&s, CodeKind::ButtonCode, "B2:onSelect").sheet_name.as_deref(), Some("Dashboard"));
    assert_eq!(at("C2:macroRef"), SubscriberConsequence::RunsAfterApproval);
    assert_eq!(at("D2:macroRef"), SubscriberConsequence::RemovedOnArrival);
    assert_eq!(at("E2:onSelect"), SubscriberConsequence::RemovedOnArrival);
    assert_eq!(at("F2:onSelect"), SubscriberConsequence::NeverRuns);
    assert_eq!(at("G2:onSelect"), SubscriberConsequence::NeverRuns);
    assert_eq!(at("G2:macroRef"), SubscriberConsequence::RunsAfterApproval);
    assert_eq!(at("H2:heldOnSelect"), SubscriberConsequence::RemovedOnArrival);
    assert!(
        !s.changes.iter().any(|c| c.id.contains("I2")),
        "the empty slot every recipe button carries is not code:\n{}",
        listing(&s)
    );

    // A caption edit is not code.
    let v1 = V::new("1.0.0").controls(json!([button(3, 1, json!({ "onSelect": stat("Report();"), "text": stat("Go") }))]));
    let v2 = V::new("1.1.0").controls(json!([button(3, 1, json!({ "onSelect": stat("Report();"), "text": stat("Run") }))]));
    assert!(summary(Some(&v1), &v2).changes.is_empty());

    // MOVED: the same bytes at another cell ask nobody -- the approval is of
    // the code, wherever it sits.
    let moved = V::new("1.1.0").controls(json!([button(4, 1, json!({ "onSelect": stat("Report();") }))]));
    let s = summary(Some(&v1), &moved);
    assert_eq!(row(&s, CodeKind::ButtonCode, "B5:onSelect").consequence, SubscriberConsequence::RunsAfterApproval);
    assert_eq!(row(&s, CodeKind::ButtonCode, "B4:onSelect").consequence, SubscriberConsequence::StopsRunning);
    assert!(!s.asks_approval_again, "moving a button re-prompts nobody:\n{}", listing(&s));

    // The link's macro LEAVES the version: same link bytes, but subscribers now
    // remove it -- a change for them.
    let linked = V::new("1.0.0").module("mod-1", "Report", "return 1;").controls(json!([button(1, 2, json!({ "macroRef": stat("mod-1") }))]));
    let orphan = V::new("1.1.0").controls(json!([button(1, 2, json!({ "macroRef": stat("mod-1") }))]));
    let s = summary(Some(&linked), &orphan);
    let link = row(&s, CodeKind::ButtonCode, "C2:macroRef");
    assert_eq!(link.change, CodeChangeKind::Modified);
    assert_eq!(link.consequence, SubscriberConsequence::RemovedOnArrival);
}

/// INLINE CODE IS SHADOWED ONLY BY A LINK THAT SURVIVES. A subscriber's
/// admission judges the two slots separately (`held_button_code::admit_wiring`):
/// a link to a macro the version does not land is REMOVED, while static inline
/// code is HELD -- and the button door, finding no link, runs that inline code
/// once its bytes are approved (`control_action::decide_control`). So the
/// inline code of a button whose link is removed ASKS, and a version whose only
/// change is dropping the linked macro is a change for that code too: it
/// starts running.
///
/// SABOTAGE: restore the bare `link.is_some()` test in `button_controls`.
#[test]
fn inline_code_next_to_a_removed_link_asks_for_approval() {
    // (a) The link names a macro this version does not carry.
    let to = V::new("1.0.0").controls(json!([button(
        1,
        1,
        json!({ "onSelect": stat("Inline();"), "macroRef": stat("missing") })
    )]));
    let s = summary(None, &to);
    assert_eq!(row(&s, CodeKind::ButtonCode, "B2:macroRef").consequence, SubscriberConsequence::RemovedOnArrival);
    let inline = row(&s, CodeKind::ButtonCode, "B2:onSelect");
    assert_eq!(
        inline.consequence,
        SubscriberConsequence::AsksApprovalAgain,
        "the link is removed on arrival, so a click runs the inline code:\n{}",
        listing(&s)
    );
    assert!(inline.detail.contains("link is removed"), "the row says why it runs: {}", inline.detail);
    assert!(s.asks_approval_again);

    // (b) The linked macro LEAVES the version; the button itself is unchanged.
    let both = |version: &str| {
        V::new(version).controls(json!([button(
            1,
            1,
            json!({ "onSelect": stat("Inline();"), "macroRef": stat("mod-1") })
        )]))
    };
    let v1 = both("1.0.0").module("mod-1", "Report", "return 1;");
    let v2 = both("1.1.0");
    let s = summary(Some(&v1), &v2);
    let inline = row(&s, CodeKind::ButtonCode, "B2:onSelect");
    assert_eq!(inline.change, CodeChangeKind::Modified, "the same bytes START RUNNING:\n{}", listing(&s));
    assert_eq!(inline.consequence, SubscriberConsequence::AsksApprovalAgain);
    assert!(s.asks_approval_again, "the headline must not say nobody is asked:\n{}", listing(&s));
    assert_eq!(row(&s, CodeKind::ButtonCode, "B2:macroRef").consequence, SubscriberConsequence::RemovedOnArrival);
}

/// THE SUMMARY SHOWS WHAT SUBSCRIBERS RECEIVE WHEN A VERSION CARRIES TWO OF A
/// THING UNDER ONE KEY -- and never hides the other one. A pull materializes a
/// module or a notebook by the id in its FILE, and the LAST of two with one id
/// stands (`materialize_distributed_scripts` inserts; the same application's
/// entry is no conflict); a control or a cell type lands by CELL, and the LAST
/// entry at a cell stands (`materialize_saved_controls`,
/// `materialize_saved_cell_types`), whatever its kind. Publish never writes
/// such a version; a hand-built one signed by an authorised developer can, and
/// the promotion review is the step that must catch it.
///
/// SABOTAGE: keep the FIRST entry under a key in `inventory`'s `put` (the
/// benign body is then shown and the one subscribers run is hidden).
#[test]
fn a_duplicate_shows_the_body_subscribers_receive_and_lists_the_other() {
    // MODULES: two files, one id.
    let v1 = V::new("1.0.0").module("mod-a", "Report", "Benign();");
    let v2 = V::new("1.1.0")
        .module("mod-a", "Report", "Benign();")
        .module_file("mod-a-copy", "mod-a", "Report", "Exfiltrate();");
    let s = summary(Some(&v1), &v2);
    let live = row(&s, CodeKind::Macro, "mod-a");
    assert_eq!(live.id, "mod-a");
    assert_eq!(live.change, CodeChangeKind::Modified, "{}", listing(&s));
    assert_eq!(live.after.as_deref(), Some("Exfiltrate();"), "the body subscribers RUN is the last one");
    assert_eq!(live.consequence, SubscriberConsequence::AsksApprovalAgain);
    let other = row(&s, CodeKind::Macro, &format!("mod-a{DUPLICATE_ID_MARK}"));
    assert_eq!(other.after.as_deref(), Some("Benign();"));
    assert_eq!(other.consequence, SubscriberConsequence::NeverRuns);
    assert!(other.detail.contains("same id"), "{}", other.detail);
    assert!(s.asks_approval_again);

    // NOTEBOOKS: the same rule.
    let n1 = V::new("1.0.0").notebook("nb-1", "Analysis", &[("c1", "benign()")]);
    let n2 = V::new("1.1.0")
        .notebook("nb-1", "Analysis", &[("c1", "benign()")])
        .notebook_file("nb-copy", "nb-1", "Analysis", &[("c1", "evil()")]);
    let s = summary(Some(&n1), &n2);
    let live = row(&s, CodeKind::Notebook, "nb-1");
    assert!(live.after.as_deref().unwrap().contains("evil()"), "{}", listing(&s));
    assert_eq!(live.consequence, SubscriberConsequence::AsksApprovalAgain);

    // CONTROLS: two entries at B2, in one sheet group and in two groups.
    let c1 = V::new("1.0.0").controls(json!([button(1, 1, json!({ "onSelect": stat("Benign();") }))]));
    let c2 = V::new("1.1.0").controls(json!([
        button(1, 1, json!({ "onSelect": stat("Benign();") })),
        button(1, 1, json!({ "onSelect": stat("Evil();") })),
    ]));
    let s = summary(Some(&c1), &c2);
    let live = row(&s, CodeKind::ButtonCode, "B2:onSelect");
    assert!(!live.id.contains(DUPLICATE_ID_MARK));
    assert_eq!(live.after.as_deref(), Some("Evil();"), "{}", listing(&s));
    assert_eq!(live.consequence, SubscriberConsequence::AsksApprovalAgain);
    let other = row(&s, CodeKind::ButtonCode, &format!("B2:onSelect{DUPLICATE_ID_MARK}"));
    assert_eq!(other.after.as_deref(), Some("Benign();"));
    assert_eq!(other.consequence, SubscriberConsequence::NeverRuns);

    let groups = V::new("1.1.0").controls_groups(json!([
        { "sheetId": SHEET, "controls": [button(1, 1, json!({ "onSelect": stat("Benign();") }))] },
        { "sheetId": SHEET, "controls": [button(1, 1, json!({ "onSelect": stat("Evil();") }))] },
    ]));
    let s = summary(Some(&c1), &groups);
    assert_eq!(row(&s, CodeKind::ButtonCode, "B2:onSelect").after.as_deref(), Some("Evil();"), "{}", listing(&s));

    // A LATER CONTROL OF ANOTHER KIND at the cell replaces the button: its code
    // never arrives, so it stops running.
    let covered = V::new("1.1.0").controls(json!([
        button(1, 1, json!({ "onSelect": stat("Benign();") })),
        { "row": 1, "col": 1, "controlType": "checkbox", "properties": {} },
    ]));
    let s = summary(Some(&c1), &covered);
    let gone = row(&s, CodeKind::ButtonCode, "B2:onSelect");
    assert_eq!(gone.change, CodeChangeKind::Removed, "{}", listing(&s));
    assert_eq!(gone.consequence, SubscriberConsequence::StopsRunning);

    // CELL TYPES: two cellType objects for one sheet, one cell.
    let b1 = V::new("1.0.0")
        .module("mod-1", "Report", "return 1;")
        .module("mod-2", "Wipe", "return 2;")
        .cell_types(json!([
            { "row": 0, "col": 0, "typeId": "calcula.button", "params": { "action": { "kind": "script", "scriptId": "mod-1" } } }
        ]));
    let b2 = b1.clone().more_cell_types(json!([
        { "row": 0, "col": 0, "typeId": "calcula.button", "params": { "action": { "kind": "script", "scriptId": "mod-2" } } }
    ]));
    let s = summary(Some(&b1), &b2);
    let live = row(&s, CodeKind::ButtonCellAction, "A1:action");
    assert!(!live.id.contains(DUPLICATE_ID_MARK));
    assert!(live.after.as_deref().unwrap().contains("mod-2"), "{}", listing(&s));
    assert_eq!(live.change, CodeChangeKind::Modified);
    assert!(row(&s, CodeKind::ButtonCellAction, &format!("A1:action{DUPLICATE_ID_MARK}"))
        .after
        .as_deref()
        .unwrap()
        .contains("mod-1"));

    // A LATER CELL TYPE OF ANOTHER KIND at the cell replaces the button: its
    // action never arrives, so it stops running.
    let checked = b1.clone().more_cell_types(json!([
        { "row": 0, "col": 0, "typeId": "calcula.checkbox", "params": {} }
    ]));
    let s = summary(Some(&b1), &checked);
    let gone = row(&s, CodeKind::ButtonCellAction, "A1:action");
    assert_eq!(gone.change, CodeChangeKind::Removed, "{}", listing(&s));
    assert_eq!(gone.consequence, SubscriberConsequence::StopsRunning);
}

/// Where the materializer keeps the FIRST of two (an object script whose id is
/// already present is skipped; a function whose name is taken is not applied;
/// a submit finds the first region with its id; a pull takes the FIRST
/// custom-function library), the first is the live row -- and the other is
/// still listed, never silently dropped.
///
/// SABOTAGE: drop the duplicate row in `put` (keep the live one only).
#[test]
fn a_first_wins_duplicate_is_listed_too() {
    let v = V::new("1.0.0")
        .object_script("obj-1", "On open", "first();", &[])
        .object_script_file("obj-1-copy", "obj-1", "second();", &["net.fetch"]);
    let s = summary(None, &v);
    assert_eq!(row(&s, CodeKind::ObjectScript, "obj-1").after.as_deref(), Some("first();"), "{}", listing(&s));
    let other = row(&s, CodeKind::ObjectScript, &format!("obj-1{DUPLICATE_ID_MARK}"));
    assert_eq!(other.after.as_deref(), Some("second();"));
    assert_eq!(other.consequence, SubscriberConsequence::NeverRuns);
    assert!(other.added_capabilities.is_empty(), "a script that never arrives gains nothing");

    // A SECOND custom-function library never lands: its functions are not
    // asked for.
    let libs = V::new("1.0.0")
        .functions(json!({ "functions": [{ "name": "DOUBLE", "params": ["x"], "body": "return x * 2;" }] }))
        .module_file(
            "cf-copy",
            CUSTOM_FUNCTIONS_LIB_ID,
            "Custom Functions",
            &json!({ "functions": [{ "name": "TRIPLE", "params": ["x"], "body": "return x * 3;" }] }).to_string(),
        );
    let s = summary(None, &libs);
    assert_eq!(row(&s, CodeKind::CustomFunction, "DOUBLE").consequence, SubscriberConsequence::AsksApprovalAgain);
    assert!(
        !s.changes.iter().any(|c| c.id == "TRIPLE"),
        "a function of the second library is not one subscribers receive:\n{}",
        listing(&s)
    );
    let second = row(&s, CodeKind::CustomFunction, &format!("{CUSTOM_FUNCTIONS_LIB_ID}{DUPLICATE_ID_MARK}"));
    assert_eq!(second.consequence, SubscriberConsequence::NeverRuns);
    assert!(second.after.as_deref().unwrap().contains("TRIPLE"));
}

/// A LINK LANDS BY THE ID IN THE MODULE'S FILE. The subscriber's landed set is
/// the ids its materializer applied (`landed_macros: applied_module_ids`), which
/// are the files' ids -- not the manifest's listing.
///
/// SABOTAGE: build `shipped_macros` from `manifest.module_scripts[].id` again.
#[test]
fn a_link_reaches_the_id_the_module_file_carries() {
    let v = V::new("1.0.0").module_file("listed-name", "real-id", "Report", "return 1;").controls(json!([
        button(1, 1, json!({ "macroRef": stat("real-id") })),
        button(1, 2, json!({ "macroRef": stat("listed-name") })),
    ]));
    let s = summary(None, &v);
    assert_eq!(row(&s, CodeKind::ButtonCode, "B2:macroRef").consequence, SubscriberConsequence::RunsAfterApproval, "{}", listing(&s));
    assert_eq!(row(&s, CodeKind::ButtonCode, "C2:macroRef").consequence, SubscriberConsequence::RemovedOnArrival);
}

/// A button CELL's command follows Calcula's list: removed on arrival while it
/// is not on it, and its own approval when it is. A script action runs after
/// its macro's approval, or is removed when the version does not carry it.
///
/// SABOTAGE: ignore `allowed_button_commands` (treat every command as listed).
#[test]
fn a_button_cell_command_follows_the_list() {
    let to = V::new("1.0.0").module("mod-1", "Report", "return 1;").cell_types(json!([
        { "row": 0, "col": 0, "typeId": "calcula.button", "params": { "label": "Bold", "action": { "kind": "command", "commandId": "format.bold" } } },
        { "row": 1, "col": 0, "typeId": "calcula.button", "params": { "action": { "kind": "script", "scriptId": "mod-1", "functionName": "Go" } } },
        { "row": 2, "col": 0, "typeId": "calcula.button", "params": { "action": { "kind": "script", "scriptId": "not-shipped" } } },
        { "row": 3, "col": 0, "typeId": "calcula.button", "params": { "action": { "kind": "teleport" } } },
        { "row": 4, "col": 0, "typeId": "calcula.button", "params": { "heldAction": { "kind": "script", "scriptId": "mod-1" } } },
        { "row": 5, "col": 0, "typeId": "calcula.checkbox", "params": { "action": { "kind": "command", "commandId": "x" } } },
        { "row": 6, "col": 0, "typeId": "calcula.button", "params": { "label": "Nothing", "action": null } },
    ]));
    let s = summary_with(None, &to, &[]);
    let at = |s: &CodeSummary, id: &str| row(s, CodeKind::ButtonCellAction, id).consequence;
    assert_eq!(at(&s, "A1:action"), SubscriberConsequence::RemovedOnArrival);
    assert!(row(&s, CodeKind::ButtonCellAction, "A1:action").detail.contains("not on Calcula's list"));
    assert_eq!(at(&s, "A2:action"), SubscriberConsequence::RunsAfterApproval);
    assert!(row(&s, CodeKind::ButtonCellAction, "A2:action").after.as_deref().unwrap().contains("then calls Go()"));
    assert_eq!(at(&s, "A3:action"), SubscriberConsequence::RemovedOnArrival);
    assert_eq!(at(&s, "A4:action"), SubscriberConsequence::RemovedOnArrival);
    assert_eq!(at(&s, "A5:heldAction"), SubscriberConsequence::RemovedOnArrival);
    assert_eq!(s.changes.iter().filter(|c| c.kind == CodeKind::ButtonCellAction).count(), 5, "{}", listing(&s));

    let listed = summary_with(None, &to, &["format.bold"]);
    assert_eq!(at(&listed, "A1:action"), SubscriberConsequence::AsksApprovalAgain);
}

/// Cells, charts, media, models and a button's CAPTION are not code: a version
/// pair differing only in those produces no row.
///
/// SABOTAGE: treat the `text` property as a code slot in `button_controls`.
#[test]
fn cells_charts_media_and_captions_produce_no_rows() {
    let base = |version: &str, value: f64, caption: &str| {
        V::new(version)
            .module("mod-1", "Report", "return 1;")
            .put(&format!("sheets/{SHEET}/data.json"), json!({ "cells": { "A1": { "t": "n", "v": value } } }))
            .put("charts.json", json!([{ "id": "c1", "specJson": format!("{{\"v\":{value}}}") }]))
            .put("media/abc", json!({ "bytes": value }))
            .put("models/ds/model.json", json!({ "measures": [{ "name": "M", "source": format!("{value}") }] }))
            .controls(json!([
                button(0, 0, json!({ "onSelect": stat("Report();"), "text": stat(caption) })),
                { "row": 0, "col": 1, "controlType": "checkbox", "properties": { "text": stat(caption) } },
            ]))
    };
    let s = summary(Some(&base("1.0.0", 1.0, "Go")), &base("1.1.0", 2.0, "Run"));
    assert!(s.changes.is_empty(), "nothing here is code:\n{}", listing(&s));
    assert!(!s.asks_approval_again);
}

/// Through a CHECKED side every read is held to the signed checksum: bytes
/// that differ are an error, never a row; a listed artifact that is missing is
/// an error; a path the signed map does not list reads as absent.
///
/// SABOTAGE: skip the hash comparison in `DiffSide::PublishedChecked`'s `read`.
#[test]
fn a_tampered_artifact_on_a_checked_side_is_an_error() {
    let v = V::new("1.0.0").module("mod-1", "Report", "return 1;");
    let ws = MemoryWorkspace::new();
    let mut manifest = v.manifest.clone();
    for (rel, bytes) in &v.artifacts {
        ws.write_artifact("sales", "1.0.0", rel, bytes).unwrap();
        manifest.artifact_checksums.insert(rel.clone(), crate::integrity::sha256_hex(bytes));
    }
    let side = |m: &VersionManifest| -> Result<CodeSummary, CalpError> {
        let checked = DiffSide::PublishedChecked { transport: &ws, package: "sales", version: "1.0.0", manifest: m };
        code_summary(None, &checked, &DiffOptions::default(), &[])
    };

    // Positive control: untampered bytes read normally.
    let ok = side(&manifest).expect("the signed bytes read");
    assert_eq!(row(&ok, CodeKind::Macro, "mod-1").after.as_deref(), Some("return 1;"));

    // Tampered after signing.
    ws.write_artifact(
        "sales",
        "1.0.0",
        "modules/mod-1.json",
        br#"{"id":"mod-1","name":"Report","source":"Exfiltrate();","scope":{"type":"workbook"}}"#,
    )
    .unwrap();
    match side(&manifest) {
        Err(CalpError::ChecksumMismatch { file, .. }) => assert_eq!(file, "modules/mod-1.json"),
        other => panic!("tampered bytes must be an error, got {other:?}"),
    }

    // Listed but missing.
    let mut missing = manifest.clone();
    missing.artifact_checksums.insert("modules/mod-2.json".into(), "00".repeat(32));
    missing.module_scripts.push(PublishedModuleScript {
        id: "mod-2".into(),
        name: "Two".into(),
        scope: "workbook".into(),
        description: None,
    });
    let ws_fresh = MemoryWorkspace::new();
    let checked = DiffSide::PublishedChecked { transport: &ws_fresh, package: "sales", version: "1.0.0", manifest: &missing };
    assert!(matches!(
        code_summary(None, &checked, &DiffOptions::default(), &[]),
        Err(CalpError::MissingArtifact { .. })
    ));

    // UNLISTED: a loose file the signed map does not name is never read.
    let mut unlisted = manifest.clone();
    unlisted.artifact_checksums.remove("modules/mod-1.json");
    let s = side(&unlisted).expect("an unlisted path is absent, not an error");
    assert!(s.changes.is_empty(), "bytes outside the signed map were read:\n{}", listing(&s));
}

/// A writeback VALIDATOR is code that lives in the manifest. A body change
/// asks again at the next submit; a name without a body refuses every submit;
/// a removed validator stops running.
///
/// SABOTAGE: drop the `writeback_validators(..)` pass from `inventory`.
#[test]
fn a_changed_writeback_validator_asks_for_approval_again() {
    let v1 = V::new("1.0.0").validator("region-1", "positive", Some("(v) => v > 0"));
    let v2 = V::new("1.1.0").validator("region-1", "positive", Some("(v) => v >= 0"));
    let s = summary(Some(&v1), &v2);
    assert_eq!(s.changes.len(), 1, "{}", listing(&s));
    let r = row(&s, CodeKind::WritebackValidator, "region-1");
    assert_eq!(r.change, CodeChangeKind::Modified);
    assert_eq!(r.consequence, SubscriberConsequence::AsksApprovalAgain);
    assert_eq!(r.before.as_deref(), Some("(v) => v > 0"));
    assert_eq!(r.after.as_deref(), Some("(v) => v >= 0"));
    assert_eq!(r.sheet_name.as_deref(), Some("Dashboard"));
    assert!(s.asks_approval_again, "a changed validator asks again: the headline must not say otherwise");

    let wishful = V::new("1.2.0").validator("region-1", "positive", None);
    assert_eq!(
        row(&summary(Some(&v1), &wishful), CodeKind::WritebackValidator, "region-1").consequence,
        SubscriberConsequence::BlocksSubmit
    );
    let none = V::new("1.3.0");
    let s = summary(Some(&v1), &none);
    assert_eq!(row(&s, CodeKind::WritebackValidator, "region-1").consequence, SubscriberConsequence::StopsRunning);
}

/// A script under a reserved id is never a macro: subscribers refuse the WHOLE
/// version over it, so it is its own row, listed even when it did not change.
///
/// SABOTAGE: drop the `reserved_reason` check in `modules`.
#[test]
fn a_reserved_module_is_never_a_macro() {
    let v = V::new("1.0.0")
        .module("__calcula_secret", "Hidden", "evil();")
        .module("buttonAction:abc", "Claim", "claim();")
        .object_script("buttonAction:def", "Claim too", "x();", &[])
        .notebook("__calcula_nb", "Hidden notebook", &[("c1", "1")]);
    let s = summary(None, &v);
    assert!(!s.changes.iter().any(|c| c.kind == CodeKind::Macro), "a reserved id read as a macro:\n{}", listing(&s));
    assert_eq!(s.changes.iter().filter(|c| c.kind == CodeKind::ReservedScript).count(), 4, "{}", listing(&s));
    assert!(s
        .changes
        .iter()
        .all(|c| c.consequence == SubscriberConsequence::RefusesVersion && c.detail.contains("refuse the whole version")));

    // Unchanged in both: still listed, because it still blocks the target.
    let s = summary(Some(&v), &v);
    assert_eq!(s.changes.len(), 4, "{}", listing(&s));
    assert!(s.changes.iter().all(|c| c.change == CodeChangeKind::Unchanged));

    // The custom-function library's id is reserved-shaped but is NOT refused.
    let lib = V::new("1.0.0").functions(json!({ "functions": [] }));
    assert!(summary(None, &lib).changes.iter().all(|c| c.kind != CodeKind::ReservedScript));
}

/// The wire value of every variant is its camelCase name: the TypeScript drift
/// test derives the table keys that way from this file's source.
#[test]
fn the_wire_values_are_the_camel_cased_variant_names() {
    fn camel(debug: String) -> String {
        let mut chars = debug.chars();
        let first = chars.next().unwrap().to_ascii_lowercase();
        std::iter::once(first).chain(chars).collect()
    }
    for k in CodeKind::ALL {
        assert_eq!(serde_json::to_value(k).unwrap(), json!(camel(format!("{k:?}"))));
    }
    for c in CodeChangeKind::ALL {
        assert_eq!(serde_json::to_value(c).unwrap(), json!(camel(format!("{c:?}"))));
    }
    for c in SubscriberConsequence::ALL {
        assert_eq!(serde_json::to_value(c).unwrap(), json!(camel(format!("{c:?}"))));
    }
    // And a row's fields are camelCase, every one present (no skips): the
    // TypeScript mirror reads `codeError`-style nulls, never absences.
    let s = summary(None, &V::new("1.0.0").module("m", "M", "x"));
    let wire = serde_json::to_value(&s.changes[0]).unwrap();
    let mut keys: Vec<&str> = wire.as_object().unwrap().keys().map(|k| k.as_str()).collect();
    keys.sort_unstable();
    assert_eq!(
        keys,
        vec![
            "addedCapabilities", "after", "afterTruncated", "before", "beforeTruncated", "change",
            "consequence", "detail", "id", "kind", "name", "sheetName",
        ]
    );
}
