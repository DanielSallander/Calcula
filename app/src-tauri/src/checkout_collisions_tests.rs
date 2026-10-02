//! FILENAME: app/src-tauri/src/checkout_collisions_tests.rs
//! PURPOSE: The checkout's collision gate (see `checkout_collisions.rs`): which
//! ids collide and whose they are, what the refusal says, that a refused
//! checkout writes nothing but its audit row, and that `calp_checkout` runs the
//! gate before its `DocumentEffect`.

use std::path::Path;

use tempfile::TempDir;

use calp::publish::{self, PublishRequest, PushMode};
use calp::version::SemVer;
use calp::workspace::LocalWorkspace;
use persistence::{SavedCell, Sheet, Workbook};

use super::*;
use crate::calp_commands::{materialize_pull_result, MaterializeMode};
use crate::document_effect::test_seed_effect;

/// A name no real application uses (the authorised reader consults this
/// machine's pin store read-only).
const PKG: &str = "checkout-collision-gate";

// ============================================================================
// Fixtures
// ============================================================================

fn held(id: &str, name: &str, stamp: Option<&str>) -> HeldItem {
    HeldItem { id: id.to_string(), name: name.to_string(), stamp: stamp.map(str::to_string) }
}

fn holds(modules: &[HeldItem], notebooks: &[HeldItem], names: &[HeldItem]) -> WorkbookHolds {
    let keyed = |items: &[HeldItem]| items.iter().map(|h| (h.id.clone(), h.clone())).collect();
    WorkbookHolds { modules: keyed(modules), notebooks: keyed(notebooks), names: keyed(names) }
}

fn module(id: &str, name: &str) -> persistence::SavedScript {
    persistence::SavedScript {
        id: id.to_string(),
        name: name.to_string(),
        description: None,
        source: format!("// {name}\nCalcula.log('{id}');"),
        scope: persistence::SavedScriptScope::Workbook,
        source_package: None,
    }
}

fn notebook(id: &str, name: &str) -> persistence::SavedNotebook {
    persistence::SavedNotebook { id: id.to_string(), name: name.to_string(), cells: Vec::new(), source_package: None }
}

fn published_name(name: &str, refers_to: &str) -> calp::manifest::PublishedNamedRange {
    calp::manifest::PublishedNamedRange {
        name: name.to_string(),
        refers_to: refers_to.to_string(),
        sheet_id: None,
        extra: Default::default(),
    }
}

/// A subscription (to `package`) whose ledger claims one object.
fn subscription_claiming(package: &str, kind: &str, id: &str) -> calp::manifest::Subscription {
    let mut sub: calp::manifest::Subscription = serde_json::from_value(serde_json::json!({
        "packageName": package,
        "registryUrl": "C:/elsewhere",
        "versionPin": "latest",
        "resolvedVersion": "1.0.0",
        "resolvedAt": "2026-09-30T00:00:00Z",
        "sheets": []
    }))
    .expect("a minimal subscription");
    sub.objects.push(calp::manifest::SubscribedObject {
        kind: kind.to_string(),
        id: id.to_string(),
        name: String::new(),
        extra: Default::default(),
    });
    sub
}

// ============================================================================
// 1. Which ids collide, and whose they are
// ============================================================================

/// The three kinds the design names, each against the workbook's own item or
/// another application's; the Custom Functions library is exempt; an id the
/// workbook does not use is not a collision.
///
/// SABOTAGE: return an empty list from `find_checkout_collisions`; separately,
/// drop the `CUSTOM_FUNCTIONS_LIB_ID` exemption (the library then collides).
#[test]
fn an_application_item_whose_id_the_workbook_already_uses_collides() {
    let modules = [
        module("macro-report", "Report"),
        module("macro-new", "New"),
        module(CUSTOM_FUNCTIONS_LIB_ID, "Custom Functions"),
    ];
    let notebooks = [notebook("nb-analysis", "Analysis")];
    let names = [published_name("Rate", "=Data!$A$1"), published_name("Fresh", "=1")];
    let incoming = Incoming { modules: &modules, notebooks: &notebooks, names: &names };
    let workbook = holds(
        &[
            held("macro-report", "My report", None),
            held(CUSTOM_FUNCTIONS_LIB_ID, "Custom Functions (data)", None),
        ],
        &[held("nb-analysis", "Finance analysis", Some("finance"))],
        &[held("RATE", "rate", None)],
    );

    let found = find_checkout_collisions(PKG, &incoming, &workbook, &[]);
    assert_eq!(
        found,
        vec![
            CheckoutCollision {
                kind: CollisionKind::Macro,
                id: "macro-report".to_string(),
                name: "My report".to_string(),
                holder: Holder::Yours,
            },
            CheckoutCollision {
                kind: CollisionKind::Notebook,
                id: "nb-analysis".to_string(),
                name: "Finance analysis".to_string(),
                holder: Holder::Application("finance".to_string()),
            },
            CheckoutCollision {
                kind: CollisionKind::Name,
                id: "RATE".to_string(),
                name: "rate".to_string(),
                holder: Holder::Yours,
            },
        ],
        "names collide case-insensitively; the library and an unused id do not collide"
    );
}

/// THIS application's own leftover (stamped with its name, claimed by no
/// subscription) is replaced by the materializer, so it is not a collision --
/// but a SUBSCRIPTION's ledger claim makes it one: a same-named application
/// from another workspace stamps the same name, and opening this one would
/// overwrite that subscription's module in place.
///
/// SABOTAGE: drop the subscription-claim arm of `holder_of`.
#[test]
fn this_applications_own_leftover_is_replaced_unless_another_subscription_claims_it() {
    let modules = [module("macro-report", "Report")];
    let incoming = Incoming { modules: &modules, notebooks: &[], names: &[] };
    let workbook = holds(&[held("macro-report", "Report", Some(PKG))], &[], &[]);
    assert!(
        find_checkout_collisions(PKG, &incoming, &workbook, &[]).is_empty(),
        "an earlier copy of this same application is not somebody else's item"
    );

    let other_workspace = subscription_claiming(PKG, "moduleScript", "macro-report");
    let found = find_checkout_collisions(PKG, &incoming, &workbook, &[other_workspace]);
    assert_eq!(found.len(), 1, "{found:?}");
    assert_eq!(found[0].holder, Holder::Application(PKG.to_string()));

    // A name has no stamp; a subscription's claim is the only thing that makes
    // it another application's rather than the workbook's own.
    let names = [published_name("Rate", "=1")];
    let incoming = Incoming { modules: &[], notebooks: &[], names: &names };
    let workbook = holds(&[], &[], &[held("RATE", "Rate", None)]);
    let claimed = subscription_claiming("finance", "namedRange", "RATE");
    assert_eq!(
        find_checkout_collisions(PKG, &incoming, &workbook, &[claimed])[0].holder,
        Holder::Application("finance".to_string())
    );
}

// ============================================================================
// 2. What the refusal says
// ============================================================================

/// The refusal is the only thing the developer sees: it must carry the code the
/// dialog keys its remedy on, name every item and whose it is, say why, and
/// name the remedy. A long list is cut with a count, never silently.
///
/// SABOTAGE: drop the "new workbook" sentence; separately, drop the
/// "and N more" tail.
#[test]
fn the_refusal_names_each_item_whose_it_is_and_the_remedy() {
    let one = [CheckoutCollision {
        kind: CollisionKind::Macro,
        id: "macro-report".to_string(),
        name: "Report".to_string(),
        holder: Holder::Yours,
    }];
    let text = collision_refusal("sales", &one);
    assert!(text.starts_with("CALP_CHECKOUT_COLLISION:"), "{text}");
    assert!(text.contains("macro 'Report' (id macro-report, yours)"), "{text}");
    assert!(text.contains("an item with the same identity"), "{text}");
    assert!(text.contains("publish the workbook's copy as part of 'sales'"), "{text}");
    assert!(text.contains("into a new workbook"), "the remedy is missing: {text}");
    assert!(text.contains("rename or remove it"), "{text}");

    let many: Vec<CheckoutCollision> = (0..11)
        .map(|i| CheckoutCollision {
            kind: CollisionKind::Name,
            id: format!("N{i:02}"),
            name: format!("N{i:02}"),
            holder: Holder::Application("finance".to_string()),
        })
        .collect();
    let text = collision_refusal("sales", &many);
    assert!(text.contains("name 'N00' (from application 'finance')"), "{text}");
    assert!(text.contains("name 'N07'"), "{text}");
    assert!(!text.contains("name 'N08'"), "the list is capped: {text}");
    assert!(text.contains("and 3 more"), "a capped list must say how many it left out: {text}");
    assert!(text.contains("rename or remove them"), "{text}");
}

// ============================================================================
// 3. Through a real signed workspace
// ============================================================================

/// ["Data"] with a macro, a notebook and a workbook-scoped name, published as
/// PKG 1.0.0 and checked out (the signer gate included).
fn published_application(dir: &TempDir, prof: &Path) -> calp::pull::PullResult {
    let mut data = Sheet::new("Data".to_string());
    data.cells.insert((0, 0), SavedCell::from_cell(&engine::cell::Cell::new_number(0.25)));
    let mut wb = Workbook::default();
    wb.sheets = vec![data];
    wb.scripts = vec![module("macro-report", "Report")];
    wb.notebooks = vec![notebook("nb-analysis", "Analysis")];
    wb.named_ranges = vec![persistence::SavedNamedRange {
        name: "Rate".to_string(),
        refers_to: "=Data!$A$1".to_string(),
        sheet_id: None,
        comment: None,
        folder: None,
    }];
    let reg = LocalWorkspace::open(dir.path()).unwrap();
    publish::publish(
        &reg,
        &PublishRequest {
            workbook: &wb,
            package_name: PKG.to_string(),
            version: SemVer::new(1, 0, 0),
            kind: "report".to_string(),
            mode: PushMode::CreateNew,
            change_summary: "first".to_string(),
            sheet_indices: vec![0],
            now: "2026-09-30T00:00:00Z".to_string(),
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
        },
        prof,
    )
    .expect("publish failed");
    let scope = calp::workspace_scope(&dir.path().to_string_lossy()).unwrap();
    calp::checkout::checkout(&reg, PKG, None, "2026-09-30T01:00:00Z", &scope, prof)
        .expect("checkout")
        .pulled
}

/// The author's workbook: their own `macro-report` and their own `RATE`.
fn authors_workbook() -> (crate::AppState, crate::scripting::types::ScriptState) {
    let state = crate::create_app_state();
    let scripts = crate::scripting::types::ScriptState::new();
    let effect = test_seed_effect();
    scripts.workbook_scripts.write(&effect).unwrap().insert(
        "macro-report".to_string(),
        crate::scripting::types::WorkbookScript {
            id: "macro-report".to_string(),
            name: "My report".to_string(),
            description: None,
            source: "Calcula.log('MINE');".to_string(),
            scope: Default::default(),
            source_package: None,
        },
    );
    state.named_ranges.write(&effect).unwrap().insert(
        "RATE".to_string(),
        crate::named_ranges::NamedRange {
            name: "RATE".to_string(),
            sheet_index: None,
            refers_to: "=Sheet1!$B$9".to_string(),
            comment: None,
            folder: None,
        },
    );
    (state, scripts)
}

/// THE PREMISE, pinned as it is below the gate: an additive checkout KEEPS the
/// workbook's same-id items and drops the application's, while the ids
/// `calp_checkout` records as the application's come from the INCOMING lists
/// -- so the next push's filter would keep the author's `RATE` and
/// `macro-report` as the application's. This is what the gate exists to stop
/// from being reached; it passes with or without the gate, by design.
#[test]
fn below_the_gate_a_checkout_keeps_the_workbooks_item_and_drops_the_applications() {
    let dir = TempDir::new().unwrap();
    let prof = TempDir::new().unwrap();
    let pulled = published_application(&dir, prof.path());
    let recorded_as_the_applications: Vec<String> =
        pulled.named_ranges.iter().map(|n| n.name.to_uppercase()).collect();
    let recorded_scripts: Vec<String> = pulled.module_scripts.iter().map(|s| s.id.clone()).collect();

    let (state, scripts) = authors_workbook();
    let effect = crate::document_effect::DocumentEffect::mutates(&crate::persistence::FileState::default());
    materialize_pull_result(
        &state,
        &effect,
        &crate::pivot::types::PivotState::new(),
        &crate::bi::types::BiState::new(),
        &scripts,
        &crate::ribbon_filter::RibbonFilterState::new(),
        &crate::pane_control::PaneControlState::new(),
        &crate::slicer::SlicerState::new(),
        &crate::timeline_slicer::TimelineSlicerState::new(),
        pulled,
        MaterializeMode::Checkout,
        None,
    )
    .expect("materialization failed");

    assert_eq!(state.named_ranges.read().unwrap()["RATE"].refers_to, "=Sheet1!$B$9", "the author's RATE was kept");
    assert!(recorded_as_the_applications.contains(&"RATE".to_string()), "...and recorded as the application's");
    assert_eq!(scripts.workbook_scripts.read().unwrap()["macro-report"].source, "Calcula.log('MINE');");
    assert!(recorded_scripts.contains(&"macro-report".to_string()));
}

/// THE GATE, through a real signed checkout: every colliding item is named, the
/// workbook is left exactly as it was, and the refusal is in the audit trail
/// with its ids -- although collaboration auditing is off. A workbook without
/// the same ids passes.
///
/// SABOTAGE: return `Ok(())` from `refuse_checkout_collisions` before it looks;
/// separately, drop its `record_audit_event_with_extra` call.
#[test]
fn a_refused_checkout_names_every_collision_writes_nothing_and_leaves_an_audit_row() {
    let dir = TempDir::new().unwrap();
    let prof = TempDir::new().unwrap();
    let pulled = published_application(&dir, prof.path());

    let (state, scripts) = authors_workbook();
    let refusal = refuse_checkout_collisions(&state, &scripts, PKG, &pulled)
        .expect_err("a checkout over the author's own macro-report and RATE must be refused");
    assert!(refusal.starts_with("CALP_CHECKOUT_COLLISION:"), "{refusal}");
    assert!(refusal.contains("macro 'My report' (id macro-report, yours)"), "{refusal}");
    assert!(refusal.contains("name 'RATE' (yours)"), "{refusal}");
    assert!(!refusal.contains("nb-analysis"), "the notebook does not collide: {refusal}");

    // Nothing but the audit row was written.
    assert_eq!(scripts.workbook_scripts.read().unwrap().len(), 1);
    assert_eq!(scripts.workbook_scripts.read().unwrap()["macro-report"].source, "Calcula.log('MINE');");
    assert_eq!(state.named_ranges.read().unwrap().len(), 1);
    assert_eq!(state.named_ranges.read().unwrap()["RATE"].refers_to, "=Sheet1!$B$9");
    assert_eq!(state.sheet_names.read().unwrap().len(), 1, "no sheet arrived");

    let log = state.audit_log.read().unwrap();
    assert!(!log.enabled, "precondition: collaboration auditing is off");
    let rows: Vec<&calp::audit::AuditEntry> = log
        .entries
        .iter()
        .filter(|e| matches!(e.event, calp::audit::AuditEvent::CheckoutRefused))
        .collect();
    assert_eq!(rows.len(), 1, "the refusal left no audit row: {:?}", log.entries);
    let ids: Vec<String> = rows[0].extra["collisions"]
        .as_array()
        .expect("the colliding ids are structured")
        .iter()
        .map(|c| format!("{}:{}", c["kind"].as_str().unwrap(), c["id"].as_str().unwrap()))
        .collect();
    assert_eq!(ids, vec!["moduleScript:macro-report", "namedRange:RATE"]);
    assert_eq!(rows[0].extra["application"], PKG);
    assert!(rows[0].description.contains("macro-report"), "{}", rows[0].description);
    drop(log);

    // A workbook that does not use those ids opens.
    let clean_state = crate::create_app_state();
    let clean_scripts = crate::scripting::types::ScriptState::new();
    refuse_checkout_collisions(&clean_state, &clean_scripts, PKG, &pulled)
        .expect("a workbook with no colliding ids is not refused");
    assert!(clean_state.audit_log.read().unwrap().entries.is_empty(), "no row for a checkout that was not refused");
}

// ============================================================================
// 4. Where the gate sits
// ============================================================================

/// The code (comments stripped per line) of `calp_checkout`.
fn calp_checkout_code() -> String {
    let src = std::fs::read_to_string(Path::new(env!("CARGO_MANIFEST_DIR")).join("src/calp_commands.rs"))
        .expect("cannot read calp_commands.rs");
    let start = src.find("pub fn calp_checkout(").expect("calp_checkout is gone");
    let rest = &src[start..];
    let end = rest[1..].find("\n#[tauri::command]").map(|i| i + 1).unwrap_or(rest.len());
    rest[..end]
        .lines()
        .map(|l| match l.find("//") {
            Some(i) => &l[..i],
            None => l,
        })
        .collect::<Vec<_>>()
        .join("\n")
}

/// `calp_checkout` runs the gate on the version it read, after the role gates
/// and BEFORE its `DocumentEffect` -- a refused checkout must leave the
/// workbook clean, not merely unchanged -- and propagates the refusal.
///
/// SABOTAGE: move the gate below `DocumentEffect::mutates(`; separately,
/// delete it.
#[test]
fn calp_checkout_refuses_collisions_before_its_document_effect() {
    let body = calp_checkout_code();
    let read = body.find("calp::checkout::prepare_checkout(").expect("checkout reads the version");
    let roles = body.find("CALP_CHECKOUT_IS_SUBSCRIBER").expect("the role gates");
    let gate = body
        .find("crate::checkout_collisions::refuse_checkout_collisions(")
        .expect("calp_checkout no longer refuses id collisions");
    let effect = body.find("DocumentEffect::mutates(").expect("checkout constructs its effect");
    assert!(read < gate, "the gate needs the version it judges");
    assert!(roles < gate, "a workbook with the wrong role is refused for THAT first");
    assert!(gate < effect, "the collision gate runs after the DocumentEffect: a refusal would dirty the workbook");
    assert!(
        body[gate..effect].contains(")?;"),
        "the gate's refusal is not propagated before the effect"
    );
}
