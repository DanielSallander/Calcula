//! FILENAME: app/src-tauri/src/bi/active_query_sheet_tests.rs
//! PURPOSE: BUG-0138 -- a BI query result block follows its SHEET, not the
//!          index its sheet had when the block was inserted.
//!
//! Each connection's `ActiveQuery` stored the sheet INDEX its block was
//! inserted on, and nothing re-aimed it: after a sheet move or delete,
//! `bi_refresh_connection` cleared and rewrote the block on whichever sheet
//! inherited the index -- overwriting that sheet's cells with query rows that
//! looked exactly like fresh data. The refresh now resolves the block's sheet
//! from the sheet's IDENTITY (`live_active_queries`) and writes the block at
//! the index that resolution returns, and drops the block of a deleted sheet.
//! The block's protected region (edit protection) moves with its sheet on a
//! move and a copy as well, and its `BIResult.*` names are written quoted.
//!
//! The engine query itself is not needed to prove any of this. A move or
//! delete can also land WHILE the query runs (the refresh awaits the engine),
//! so the write resolves the block's sheet once more, under the grid locks it
//! writes with (`with_block_sheet`); the refresh itself never reads the
//! block's stored index (pinned below by its source).

use std::collections::HashMap;

use crate::bi::commands::{live_active_queries, repoint_result_names, with_block_sheet};
use crate::bi::types::{ActiveQuery, BiQueryRequest, BiQueryResult, BiState, Connection, ConnectionType};
use crate::persistence::{FileState, UserFilesState};
use crate::AppState;

struct Book {
    state: AppState,
    file: FileState,
    bi: BiState,
    conn: identity::EntityId,
    region: identity::EntityId,
    slicer: crate::slicer::SlicerState,
    timeline: crate::timeline_slicer::TimelineSlicerState,
    filters: crate::ribbon_filter::RibbonFilterState,
}

/// Sheets named `names` (the first is the default Sheet1), Sheet1 active, and
/// one connection whose single result block sits at A1:B3 of sheet `on`.
fn book(names: &[&str], on: usize) -> Book {
    let state = crate::create_app_state();
    let file = FileState::default();
    if names[0] != "Sheet1" {
        crate::sheets::rename_sheet_inner(&state, &file, &crate::pivot::PivotState::new(), 0, names[0].to_string(), false)
            .expect("rename the first sheet");
    }
    for name in &names[1..] {
        crate::sheets::add_sheet_inner(&state, &file, Some(name.to_string()), ::persistence::SheetKind::Worksheet)
            .expect("add a sheet");
    }
    crate::sheets::activate_sheet(&state, 0).expect("back to the first sheet");

    let conn = identity::EntityId::from_bytes(identity::generate_uuid_v7());
    let region = identity::EntityId::from_bytes(identity::generate_uuid_v7());
    let sheet_id = state.sheet_ids.read().unwrap()[on];
    let request = BiQueryRequest { measures: vec![], group_by: vec![], filters: vec![] };
    let mut active_queries = HashMap::new();
    active_queries.insert(
        region,
        ActiveQuery { request, sheet_index: on, sheet_id, start_row: 0, start_col: 0, end_row: 2, end_col: 1, region_id: region },
    );
    let connection = Connection {
        id: conn,
        name: "Sales".into(),
        description: String::new(),
        connection_type: ConnectionType::PostgreSQL,
        connection_string: String::new(),
        server: String::new(),
        database: String::new(),
        preferred_auth: "Integrated".into(),
        model_path: None,
        engine: None,
        model_key: None,
        connector_index: None,
        bindings: vec![],
        last_refreshed: None,
        created_at: String::new(),
        is_connected: true,
        active_queries,
        package_data_source_id: None,
        active_role: None,
        base_model: None,
        calculated_measures: vec![],
    };
    let bi = BiState::new();
    bi.connections.lock().unwrap().insert(conn, connection);
    state.protected_regions.lock().unwrap().push(crate::ProtectedRegion {
        id: format!("bi-{}", region),
        region_type: "bi".to_string(),
        owner_id: region,
        sheet_index: on,
        start_row: 0,
        start_col: 0,
        end_row: 2,
        end_col: 1,
    });
    Book {
        state,
        file: FileState::default(),
        bi,
        conn,
        region,
        slicer: crate::slicer::SlicerState::new(),
        timeline: crate::timeline_slicer::TimelineSlicerState::new(),
        filters: crate::ribbon_filter::RibbonFilterState::new(),
    }
}

/// Mark `sheet`'s A1 with `text` (the value a stale block would overwrite).
fn mark(b: &Book, sheet: usize, text: &str) {
    let seed = crate::document_effect::test_seed_effect();
    b.state.grids.write(&seed).unwrap()[sheet].set_cell(0, 0, engine::Cell::new_text(text.to_string()));
    if *b.state.active_sheet.read().unwrap() == sheet {
        b.state.grid.write(&seed).unwrap().set_cell(0, 0, engine::Cell::new_text(text.to_string()));
    }
}

fn a1_of_sheet_named(b: &Book, name: &str) -> String {
    let index = b.state.sheet_names.read().unwrap().iter().position(|n| n == name).expect("sheet");
    let active = *b.state.active_sheet.read().unwrap();
    let cell = if index == active {
        b.state.grid.read().unwrap().get_cell(0, 0).cloned()
    } else {
        b.state.grids.read().unwrap()[index].get_cell(0, 0).cloned()
    };
    cell.map(|c| crate::format_cell_value_simple(&c.value)).unwrap_or_default()
}

fn one_row_result() -> BiQueryResult {
    BiQueryResult {
        columns: vec!["Region".to_string(), "Revenue".to_string()],
        rows: vec![vec![Some("East".to_string()), Some("10".to_string())]],
        row_count: 1,
    }
}

fn bi_region_sheet(b: &Book) -> Option<usize> {
    b.state
        .protected_regions
        .lock()
        .unwrap()
        .iter()
        .find(|r| r.region_type == "bi" && r.owner_id == b.region)
        .map(|r| r.sheet_index)
}

/// The ledger's repro: a block on Sheet2, Sheet2 moved to the front, Refresh.
#[test]
fn a_refreshed_block_follows_its_sheet_through_a_move() {
    let b = book(&["Sheet1", "Sheet2", "Sheet3"], 1);
    mark(&b, 0, "keep me");
    crate::sheets::move_sheet_impl(&b.state, &b.file, &b.slicer, &b.timeline, &b.filters, 1, 0)
        .expect("move Sheet2 to the front");

    let live = live_active_queries(&b.state, &b.bi, b.conn).expect("the connection");
    assert_eq!(live.len(), 1);
    assert_eq!(live[0].sheet_index, 0, "the block's sheet (Sheet2) is at index 0 now");
    let names = b.state.sheet_names.read().unwrap().clone();
    assert_eq!(names[live[0].sheet_index], "Sheet2", "the refresh would write onto {:?}", names);
    assert_eq!(a1_of_sheet_named(&b, "Sheet1"), "keep me");
    assert_eq!(bi_region_sheet(&b), Some(0), "the block's protected region guards its own sheet");
    // The connection itself remembers the new position.
    let stored = b.bi.connections.lock().unwrap()[&b.conn].active_queries[&b.region].sheet_index;
    assert_eq!(stored, 0, "the stored index was not re-stamped");
}

#[test]
fn a_block_whose_sheet_was_deleted_is_dropped_not_rewritten_elsewhere() {
    let b = book(&["Sheet1", "Sheet2", "Sheet3"], 1);
    mark(&b, 2, "keep me");
    crate::sheets::delete_sheet_impl(
        &b.state,
        &b.file,
        &crate::pivot::PivotState::new(),
        &UserFilesState::default(),
        &crate::pane_control::PaneControlState::new(),
        &b.filters,
        &b.slicer,
        &b.timeline,
        1,
        false,
    )
    .expect("delete Sheet2");

    let live = live_active_queries(&b.state, &b.bi, b.conn).expect("the connection");
    assert!(live.is_empty(), "a block whose sheet is gone must not be refreshed anywhere: {:?}", live.iter().map(|q| q.sheet_index).collect::<Vec<_>>());
    assert!(
        b.bi.connections.lock().unwrap()[&b.conn].active_queries.is_empty(),
        "the dead block stayed on the connection"
    );
    assert_eq!(a1_of_sheet_named(&b, "Sheet3"), "keep me");
}

#[test]
fn the_blocks_protected_region_follows_a_move_and_a_copy() {
    let b = book(&["Sheet1", "Sheet2", "Sheet3"], 2);
    crate::sheets::move_sheet_impl(&b.state, &b.file, &b.slicer, &b.timeline, &b.filters, 2, 0)
        .expect("move Sheet3 to the front");
    assert_eq!(bi_region_sheet(&b), Some(0), "a move left the block's protection on another sheet");

    // A copy inserted before the block's sheet renumbers it.
    crate::sheets::copy_sheet_impl(&b.state, &b.file, &b.slicer, &b.timeline, &b.filters, 1, None)
        .expect("copy Sheet1");
    let names = b.state.sheet_names.read().unwrap().clone();
    let at = names.iter().position(|n| n == "Sheet3").unwrap();
    assert_eq!(bi_region_sheet(&b), Some(at), "a copy left the block's protection on another sheet: {:?}", names);
}

// ---------------------------------------------------------------------------
// A move or delete WHILE the query runs (wave-B fix-up of BUG-0138)
// ---------------------------------------------------------------------------
//
// `live_active_queries` resolves each block's sheet BEFORE the refresh awaits
// the engine lock and the query, and `move_sheet` / `delete_sheet` are
// synchronous commands that run during those awaits. The refresh used to write
// at the index it had resolved before them -- onto whichever sheet had
// inherited it -- and to set the block's protected region back to that index
// after the move had remapped it. The write now goes through
// `with_block_sheet`, which resolves the sheet again, from its identity, under
// the grid locks the write holds to its end.

/// `bi_refresh_connection`'s body, comments stripped (the census shape).
fn refresh_body() -> String {
    let src = include_str!("commands.rs").replace("\r\n", "\n");
    let start = src
        .find("pub async fn bi_refresh_connection(")
        .expect("bi_refresh_connection is gone");
    let rest = &src[start..];
    let end = rest.find("\n}\n").expect("no closing brace");
    rest[..end]
        .lines()
        .map(|l| match l.find("//") {
            Some(i) => &l[..i],
            None => l,
        })
        .collect::<Vec<_>>()
        .join("\n")
}

#[test]
fn the_refresh_never_writes_at_the_index_it_resolved_before_the_query() {
    let body = refresh_body();
    assert!(
        !body.contains("active_query.sheet_index"),
        "bi_refresh_connection reads the block's STORED sheet index, resolved before the query's \
         `.await`s -- a sheet moved or deleted during the query sends that write to another sheet"
    );
    for direct in ["state.grids.", "state.grid."] {
        assert!(
            !body.contains(direct),
            "bi_refresh_connection takes `{direct}` itself: every grid write of a refresh goes \
             through the guards `with_block_sheet` resolved the block's sheet under"
        );
    }
    assert!(
        body.contains("with_block_sheet(&state, active_query.sheet_id"),
        "bi_refresh_connection no longer writes through `with_block_sheet`"
    );
}

#[test]
fn a_move_during_the_query_moves_the_write_with_its_sheet() {
    let b = book(&["Sheet1", "Sheet2", "Sheet3"], 1);
    let live = live_active_queries(&b.state, &b.bi, b.conn).expect("the connection");
    assert_eq!(live[0].sheet_index, 1, "resolved before the query: Sheet2 at index 1");

    // ...the query is out, and the user drags Sheet2 to the front.
    crate::sheets::move_sheet_impl(&b.state, &b.file, &b.slicer, &b.timeline, &b.filters, 1, 0)
        .expect("move Sheet2 to the front");

    let at = with_block_sheet(&b.state, live[0].sheet_id, |target| target.sheet_index).expect("the locks");
    assert_eq!(at, Some(0), "the write resolved the block onto another sheet than Sheet2");
    let names = b.state.sheet_names.read().unwrap().clone();
    assert_eq!(names[0], "Sheet2", "{:?}", names);
}

#[test]
fn a_delete_during_the_query_leaves_the_write_nowhere_to_go() {
    let b = book(&["Sheet1", "Sheet2", "Sheet3"], 1);
    let live = live_active_queries(&b.state, &b.bi, b.conn).expect("the connection");
    crate::sheets::delete_sheet_impl(
        &b.state,
        &b.file,
        &crate::pivot::PivotState::new(),
        &UserFilesState::default(),
        &crate::pane_control::PaneControlState::new(),
        &b.filters,
        &b.slicer,
        &b.timeline,
        1,
        false,
    )
    .expect("delete Sheet2");
    let at = with_block_sheet(&b.state, live[0].sheet_id, |target| target.sheet_index).expect("the locks");
    assert_eq!(at, None, "a deleted sheet's block was aimed at index {:?}", at);
}

#[test]
fn a_sheet_move_waits_until_the_block_write_is_done() {
    use std::sync::atomic::{AtomicBool, Ordering};
    let b = book(&["Sheet1", "Sheet2", "Sheet3"], 1);
    let live = live_active_queries(&b.state, &b.bi, b.conn).expect("the connection");
    let moved = AtomicBool::new(false);
    std::thread::scope(|s| {
        let at = with_block_sheet(&b.state, live[0].sheet_id, |target| {
            s.spawn(|| {
                crate::sheets::move_sheet_impl(&b.state, &b.file, &b.slicer, &b.timeline, &b.filters, 1, 0)
                    .expect("move Sheet2 to the front");
                moved.store(true, Ordering::SeqCst);
            });
            std::thread::sleep(std::time::Duration::from_millis(200));
            assert!(
                !moved.load(Ordering::SeqCst),
                "a sheet move completed while the block's write held its sheet: the index the \
                 write uses could change under it"
            );
            target.sheet_index
        })
        .expect("the locks");
        assert_eq!(at, Some(1));
    });
    assert!(moved.load(Ordering::SeqCst), "the move never ran once the write let go");
    assert_eq!(b.state.sheet_names.read().unwrap()[0], "Sheet2");
}

#[test]
fn the_result_names_quote_a_sheet_name_that_needs_it() {
    let b = book(&["Sheet1", "My Data"], 1);
    let live = live_active_queries(&b.state, &b.bi, b.conn).expect("the connection");
    repoint_result_names(&b.state, &crate::document_effect::test_seed_effect(), live[0].sheet_index, &live[0], &one_row_result(), 1);
    let names = b.state.named_ranges.read().unwrap();
    let region = names.get("BIRESULT.REGION").expect("the BIResult.Region name");
    let parsed = parser::parse(&region.refers_to)
        .unwrap_or_else(|e| panic!("`{}` does not parse: {:?}", region.refers_to, e));
    match parsed {
        engine::Expression::Range { sheet: Some(s), .. } => assert_eq!(s, "My Data"),
        other => panic!("`{}` -> {:?}", region.refers_to, other),
    }
}
