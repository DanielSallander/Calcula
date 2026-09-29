//! FILENAME: app/src-tauri/src/calp_validation_source_tests.rs
//! PURPOSE: A LIST validation's source range travels through a `.calp`
//!          application and lands on the right sheet (wave C, W11).
//!
//! A list validation names its source range by sheet INDEX
//! (`ListSource::Range.sheet_index`), not by name or id. The publish carried
//! that index verbatim -- the PUBLISHER's workbook position -- and subscribe,
//! checkout and refresh materialized it verbatim too, so on a subscriber whose
//! sheets sit elsewhere (any subscriber with sheets of its own) the dropdown
//! listed whatever local sheet had that number. No error anywhere.
//!
//! The rule now matches the pivots' grid source (`prune_unpublished_pivots` /
//! `restore_pulled_pivots`): publish canonicalizes the index to the source
//! sheet's POSITION in the application, and every pull resolves a position to
//! where that pulled sheet landed. A source on a sheet the application does not
//! carry cannot name any sheet on the other side, so it leaves as an empty list.

use std::path::Path;

use tempfile::TempDir;

use calp::publish::{self, PublishRequest, PushMode};
use calp::version::{SemVer, VersionPin};

use crate::calp_commands::{materialize_pull_result, MaterializeMode};
use crate::data_validation as dv;

fn test_effect() -> crate::document_effect::DocumentEffect {
    crate::document_effect::DocumentEffect::mutates(&crate::persistence::FileState::default())
}

fn list_range(sheet_index: Option<usize>) -> dv::ValidationRange {
    dv::ValidationRange {
        start_row: 0,
        start_col: 0,
        end_row: 9,
        end_col: 0,
        validation: dv::DataValidation {
            rule: dv::DataValidationRule::List(dv::ListRule {
                source: dv::ListSource::Range { sheet_index, start_row: 0, start_col: 0, end_row: 4, end_col: 0 },
                in_cell_dropdown: true,
            }),
            ..dv::DataValidation::default()
        },
    }
}

/// The publisher: Report (validated, list source on Lists) and Lists.
fn report_and_lists() -> persistence::Workbook {
    let mut wb = persistence::Workbook::default();
    wb.sheets = vec![
        persistence::Sheet::new("Report".to_string()),
        persistence::Sheet::new("Lists".to_string()),
    ];
    wb.data_validations = vec![persistence::SavedSheetDataValidations {
        sheet_id: wb.sheets[0].id,
        ranges: serde_json::to_value(vec![list_range(Some(1)), list_range(None)]).unwrap(),
    }];
    wb
}

fn publish_as(dir: &TempDir, prof: &Path, wb: &persistence::Workbook, version: (u32, u32, u32), base: Option<(u32, u32, u32)>) {
    let reg = calp::workspace::LocalWorkspace::open(dir.path()).unwrap();
    let mode = match base {
        None => PushMode::CreateNew,
        Some((a, b, c)) => PushMode::Update { expected_base: SemVer::new(a, b, c) },
    };
    let request = PublishRequest {
        workbook: wb,
        package_name: "lists".to_string(),
        version: SemVer::new(version.0, version.1, version.2),
        kind: "report".to_string(),
        mode,
        change_summary: "v".to_string(),
        sheet_indices: vec![0, 1],
        now: "2026-09-28T00:00:00Z".to_string(),
        published_by: "author".to_string(),
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
    publish::publish(&reg, &request, prof).expect("publish failed");
}

fn pull_latest(dir: &TempDir, prof: &Path) -> calp::pull::PullResult {
    let reg = calp::workspace::LocalWorkspace::open(dir.path()).unwrap();
    let scope = calp::workspace_scope(dir.path().to_str().unwrap()).unwrap();
    calp::pull::pull(
        &reg,
        &calp::pull::PullRequest {
            package_name: "lists".to_string(),
            target: calp::manifest::SubscriptionTarget::Line(VersionPin::Latest),
            now: "2026-09-28T01:00:00Z".to_string(),
        },
        &scope,
        prof,
        calp::integrity::PinPolicy::PinOnFirstUse,
    )
    .expect("pull failed")
}

struct Harness {
    state: crate::AppState,
    pivot: crate::pivot::types::PivotState,
    bi: crate::bi::types::BiState,
    scripts: crate::scripting::types::ScriptState,
    ribbon: crate::ribbon_filter::RibbonFilterState,
    pane: crate::pane_control::PaneControlState,
    slicer: crate::slicer::SlicerState,
    timeline: crate::timeline_slicer::TimelineSlicerState,
}

impl Harness {
    /// A subscriber with sheets of its OWN (Sheet1, Mine), so a pulled sheet
    /// never lands at the index it had on the publisher.
    fn with_own_sheets() -> Self {
        let h = Self {
            state: crate::create_app_state(),
            pivot: crate::pivot::types::PivotState::new(),
            bi: crate::bi::types::BiState::new(),
            scripts: crate::scripting::types::ScriptState::new(),
            ribbon: crate::ribbon_filter::RibbonFilterState::new(),
            pane: crate::pane_control::PaneControlState::new(),
            slicer: crate::slicer::SlicerState::new(),
            timeline: crate::timeline_slicer::TimelineSlicerState::new(),
        };
        crate::sheets::add_sheet_inner(
            &h.state,
            &crate::persistence::FileState::default(),
            Some("Mine".to_string()),
            ::persistence::SheetKind::Worksheet,
        )
        .expect("add Mine");
        crate::sheets::activate_sheet(&h.state, 0).expect("back to Sheet1");
        h
    }

    fn subscribe(&self, result: calp::pull::PullResult) {
        materialize_pull_result(
            &self.state,
            &test_effect(),
            &self.pivot,
            &self.bi,
            &self.scripts,
            &self.ribbon,
            &self.pane,
            &self.slicer,
            &self.timeline,
            result,
            MaterializeMode::Subscribe,
            None,
        )
        .expect("materialization failed");
    }

    fn refresh(&self, result: calp::pull::PullResult) {
        let mut payloads = vec![calp::refresh::RefreshPayload { subscription_index: 0, pull_result: result }];
        let names = crate::calp_commands::prepare_refresh_payloads(&self.state, &mut payloads)
            .expect("the refresh's pre-effect pass refused");
        crate::calp_commands::apply_refresh_payloads(
            &self.state,
            &test_effect(),
            &crate::persistence::UserFilesState::default(),
            &self.pivot,
            &self.scripts,
            &self.bi,
            &self.ribbon,
            &self.pane,
            &self.slicer,
            &self.timeline,
            payloads,
            names,
            &[],
            "2026-09-28T02:00:00Z",
            None,
        )
        .expect("refresh failed");
    }

    fn index_of(&self, name: &str) -> usize {
        self.state.sheet_names.read().unwrap().iter().position(|n| n == name).expect("the sheet")
    }

    /// The list sources validating `sheet`, in stored order.
    fn sources_on(&self, sheet: usize) -> Vec<dv::ListSource> {
        self.state.data_validations.read().unwrap()[&sheet]
            .iter()
            .map(|r| match &r.validation.rule {
                dv::DataValidationRule::List(l) => l.source.clone(),
                other => panic!("{:?}", other),
            })
            .collect()
    }
}

fn source_sheet(source: &dv::ListSource) -> Option<Option<usize>> {
    match source {
        dv::ListSource::Range { sheet_index, .. } => Some(*sheet_index),
        dv::ListSource::Values(_) => None,
    }
}

#[test]
fn a_subscribed_list_validation_lists_the_pulled_source_sheet() {
    let dir = TempDir::new().unwrap();
    let prof = TempDir::new().unwrap();
    publish_as(&dir, prof.path(), &report_and_lists(), (1, 0, 0), None);
    let h = Harness::with_own_sheets();
    h.subscribe(pull_latest(&dir, prof.path()));
    let (report, lists) = (h.index_of("Report"), h.index_of("Lists"));
    assert_ne!(lists, 1, "fixture: the pulled Lists must not land at its publisher index");
    let sources = h.sources_on(report);
    assert_eq!(
        source_sheet(&sources[0]),
        Some(Some(lists)),
        "the subscribed dropdown lists the subscriber's sheet {:?} instead of the pulled Lists",
        h.state.sheet_names.read().unwrap().get(match source_sheet(&sources[0]) {
            Some(Some(i)) => i,
            _ => usize::MAX,
        })
    );
    assert_eq!(source_sheet(&sources[1]), Some(None), "a same-sheet source was rewritten");
}

/// The PUBLISH half: the host's assembly canonicalizes a list source from the
/// publisher's workbook index to the sheet's position in the application. A
/// publisher with an UNPUBLISHED sheet before the published ones is the case a
/// verbatim index gets wrong on every subscriber; a source on the unpublished
/// sheet has nothing to name there and leaves as an empty list.
#[test]
fn a_published_list_source_travels_as_its_application_position() {
    let mut wb = persistence::Workbook::default();
    wb.sheets = vec![
        persistence::Sheet::new("Notes".to_string()),
        persistence::Sheet::new("Report".to_string()),
        persistence::Sheet::new("Lists".to_string()),
    ];
    wb.data_validations = vec![persistence::SavedSheetDataValidations {
        sheet_id: wb.sheets[1].id,
        ranges: serde_json::to_value(vec![list_range(Some(2)), list_range(Some(0)), list_range(None)]).unwrap(),
    }];
    let untouched = persistence::SavedSheetDataValidations {
        sheet_id: wb.sheets[1].id,
        ranges: serde_json::to_value(vec![list_range(None)]).unwrap(),
    };
    wb.data_validations.push(untouched.clone());

    crate::calp_commands::canonicalize_validation_list_sources(&mut wb, &[1, 2]);

    let ranges: Vec<dv::ValidationRange> = serde_json::from_value(wb.data_validations[0].ranges.clone()).unwrap();
    let sources: Vec<Option<Option<usize>>> = ranges
        .iter()
        .map(|r| match &r.validation.rule {
            dv::DataValidationRule::List(l) => source_sheet(&l.source),
            other => panic!("{:?}", other),
        })
        .collect();
    assert_eq!(
        sources,
        vec![Some(Some(1)), None, Some(None)],
        "Lists (workbook 2) is the application's second sheet; Notes is not published; a same-sheet source stays"
    );
    assert_eq!(wb.data_validations[1].ranges, untouched.ranges, "a payload with nothing to canonicalize was rewritten");

    // ...and end to end: published from that workbook, the subscriber's
    // dropdown lists the pulled Lists.
    let dir = TempDir::new().unwrap();
    let prof = TempDir::new().unwrap();
    let reg = calp::workspace::LocalWorkspace::open(dir.path()).unwrap();
    let request = PublishRequest {
        workbook: &wb,
        package_name: "lists".to_string(),
        version: SemVer::new(1, 0, 0),
        kind: "report".to_string(),
        mode: PushMode::CreateNew,
        change_summary: "v".to_string(),
        sheet_indices: vec![1, 2],
        now: "2026-09-28T00:00:00Z".to_string(),
        published_by: "author".to_string(),
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
    publish::publish(&reg, &request, prof.path()).expect("publish failed");
    let h = Harness::with_own_sheets();
    h.subscribe(pull_latest(&dir, prof.path()));
    let sources = h.sources_on(h.index_of("Report"));
    assert_eq!(source_sheet(&sources[0]), Some(Some(h.index_of("Lists"))), "{:?}", sources[0]);
}

#[test]
fn a_refreshed_list_validation_lists_the_pulled_source_sheet() {
    let dir = TempDir::new().unwrap();
    let prof = TempDir::new().unwrap();
    let wb = report_and_lists();
    publish_as(&dir, prof.path(), &wb, (1, 0, 0), None);
    let h = Harness::with_own_sheets();
    h.subscribe(pull_latest(&dir, prof.path()));
    publish_as(&dir, prof.path(), &wb, (1, 1, 0), Some((1, 0, 0)));
    h.refresh(pull_latest(&dir, prof.path()));
    let (report, lists) = (h.index_of("Report"), h.index_of("Lists"));
    let sources = h.sources_on(report);
    assert_eq!(
        source_sheet(&sources[0]),
        Some(Some(lists)),
        "after a refresh the dropdown lists another sheet: {:?}",
        sources[0]
    );
}

// ---------------------------------------------------------------------------
// The PUBLISH DOOR calls it (review C)
// ---------------------------------------------------------------------------
//
// The tests above drive `canonicalize_validation_list_sources` and core
// publish directly. Neither reaches `assemble_publish_workbook` -- it takes
// nine Tauri `State`s -- and that assembly is the ONE door the publish, the
// dry-run preview and the working-copy diff go through. Replacing its call
// with a no-op left the whole suite green while every subscriber's dropdown
// went back to listing whichever local sheet had the publisher's index. A
// source census pins the call where the behaviour tests cannot reach.

/// The code of free function `name` in `src`: from its `fn name(` line to the
/// first line that is exactly `}` (the crate's convention for a free item),
/// with every `//` comment removed -- a comment must not satisfy the census.
fn fn_code(src: &str, name: &str) -> String {
    let header = format!("fn {}(", name);
    let lines: Vec<&str> = src.lines().collect();
    let start = lines
        .iter()
        .position(|l| l.contains(&header) && !l.trim_start().starts_with("//"))
        .unwrap_or_else(|| panic!("`fn {}(` is gone: update this census, do not delete it", name));
    let end = lines[start + 1..]
        .iter()
        .position(|l| *l == "}")
        .map(|off| start + 1 + off)
        .unwrap_or(lines.len() - 1);
    lines[start..=end]
        .iter()
        .map(|l| l.split("//").next().unwrap_or(""))
        .collect::<Vec<_>>()
        .join("\n")
}

/// Does an assembly body canonicalize the carrier it BUILT, before returning
/// it? The call must come after the workbook exists and before the `Ok((`.
fn canonicalizes_what_it_returns(body: &str) -> bool {
    let built = body.find("build_workbook_for_save_with_slicers(");
    let call = body.find("canonicalize_validation_list_sources(&mut workbook, sheet_indices)");
    let returned = body.rfind("Ok((");
    matches!((built, call, returned), (Some(b), Some(c), Some(r)) if b < c && c < r)
}

#[test]
fn the_publish_assembly_canonicalizes_every_list_source_it_ships() {
    let src = include_str!("calp_commands.rs").replace("\r\n", "\n");
    let body = fn_code(&src, "assemble_publish_workbook");
    assert!(
        canonicalizes_what_it_returns(&body),
        "`assemble_publish_workbook` no longer canonicalizes the list-validation sources of the \
         workbook it returns: every published dropdown leaves naming the PUBLISHER's sheet index, \
         and a subscriber lists whichever local sheet has that number"
    );
    // ...and every workbook-shaped publish path goes through that assembly
    // (`calp_publish_model` ships no sheets).
    for door in ["calp_publish", "calp_publish_preview", "publish_into_for_preview"] {
        assert!(
            fn_code(&src, door).contains("assemble_publish_workbook("),
            "`{}` assembles its carrier around `assemble_publish_workbook`, so its list sources are \
             not canonicalized",
            door
        );
    }
}

/// THE POSITIVE CONTROL: a source census that matched nothing would pass as
/// cheerfully as one that matched everything.
#[test]
fn the_publish_census_can_tell_a_canonicalizing_assembly_from_one_that_does_not() {
    let good = "fn a() {\n    let mut workbook = build_workbook_for_save_with_slicers(s)?;\n    \
                canonicalize_validation_list_sources(&mut workbook, sheet_indices);\n    Ok((w, p))\n}";
    let commented = "fn b() {\n    let mut workbook = build_workbook_for_save_with_slicers(s)?;\n    \
                     // canonicalize_validation_list_sources(&mut workbook, sheet_indices);\n    Ok((w, p))\n}";
    let too_early = "fn c() {\n    canonicalize_validation_list_sources(&mut workbook, sheet_indices);\n    \
                     let mut workbook = build_workbook_for_save_with_slicers(s)?;\n    Ok((w, p))\n}";
    let missing = "fn d() {\n    let mut workbook = build_workbook_for_save_with_slicers(s)?;\n    Ok((w, p))\n}";
    assert!(canonicalizes_what_it_returns(&fn_code(good, "a")));
    for (what, body) in [("a commented-out call", commented), ("a call before the build", too_early), ("no call", missing)] {
        assert!(
            !canonicalizes_what_it_returns(&fn_code(body, &body[3..4])),
            "the census admits {}",
            what
        );
    }
}
