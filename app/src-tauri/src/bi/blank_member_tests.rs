//! FILENAME: app/src-tauri/src/bi/blank_member_tests.rs
//! PURPOSE: A model's value lists offer the BLANK member, and a pinned
//!          selection naming it keeps the blank rows (wave C, W6).
//!
//! A model slicer, a ribbon filter and a pinned pivot slicer list their items
//! from `bi_get_column_values_core`, which dropped every NULL (and empty)
//! value. So the blank rows had no item: a level-1 selection could not say
//! whether they should show (wave B withdrew A1's blank-hiding for model lists
//! for exactly that reason), a pinned selection -- an IN-list the ENGINE
//! applies -- silently dropped them, and the has-data shading never matched a
//! blank record. The lists now offer the blank member as
//! `pivot_engine::BLANK_ITEM_LABEL` ("(blank)"), last, as Excel lists it and as
//! a pivot's own lists already did; a cross filter that selects it matches the
//! blank records; and the engine's scoped IN-list reads the label as BLANK.
//!
//! Engine-backed over an in-memory model (no database), like
//! `slicer/model_slicer_tests.rs`.

use std::collections::HashMap;
use std::sync::Arc;

use arrow::array::{Array, Float64Array, StringArray};
use arrow::datatypes::{DataType as ArrowType, Field, Schema};
use arrow::record_batch::RecordBatch;
use bi_engine::{
    sum_measure, Column, DataModel, DataType, Engine, InMemoryConnector, QueryRequest, SourceBinding,
    StorageMode, Table,
};
use tokio::sync::Mutex as TokioMutex;

use crate::bi::types::{BiCrossFilter, BiState, Connection, ConnectionId, ConnectionType};

fn sales_model() -> DataModel {
    DataModel::builder()
        .add_table(
            Table::new(
                "Sales",
                vec![
                    Column::new("region", DataType::String),
                    Column::new("year", DataType::String),
                    Column::new("amount", DataType::Float64),
                ],
            )
            .unwrap()
            .with_storage_mode(StorageMode::InMemory),
        )
        .add_measure(sum_measure("Revenue", "Sales", "amount"))
        .build()
        .unwrap()
}

/// Sales rows: (East, Y1, 10), (West, Y1, 20), (NULL, Y2, 30), (North, NULL, 40),
/// ("", Y3, 50) -- a NULL region, a NULL year and an EMPTY region.
fn sales_with_blanks() -> RecordBatch {
    RecordBatch::try_new(
        Arc::new(Schema::new(vec![
            Field::new("region", ArrowType::Utf8, true),
            Field::new("year", ArrowType::Utf8, true),
            Field::new("amount", ArrowType::Float64, true),
        ])),
        vec![
            Arc::new(StringArray::from(vec![Some("East"), Some("West"), None, Some("North"), Some("")])),
            Arc::new(StringArray::from(vec![Some("Y1"), Some("Y1"), Some("Y2"), None, Some("Y3")])),
            Arc::new(Float64Array::from(vec![10.0, 20.0, 30.0, 40.0, 50.0])),
        ],
    )
    .unwrap()
}

fn sales_without_blanks() -> RecordBatch {
    RecordBatch::try_new(
        Arc::new(Schema::new(vec![
            Field::new("region", ArrowType::Utf8, true),
            Field::new("year", ArrowType::Utf8, true),
            Field::new("amount", ArrowType::Float64, true),
        ])),
        vec![
            Arc::new(StringArray::from(vec!["East", "West"])),
            Arc::new(StringArray::from(vec!["Y1", "Y2"])),
            Arc::new(Float64Array::from(vec![10.0, 20.0])),
        ],
    )
    .unwrap()
}

/// A BiState holding one cache-warm connection over `batch`.
async fn bi_over(batch: RecordBatch) -> (BiState, ConnectionId) {
    let mut engine = Engine::new(sales_model());
    let idx = engine.add_in_memory_source(InMemoryConnector::new().with_table("public", "sales", batch));
    engine.bind_table("Sales", idx, SourceBinding::new("public", "sales"));
    let _ = engine
        .query_auto_refresh(QueryRequest {
            measures: vec!["Revenue".into()],
            group_by: vec![bi_engine::ColumnRef::new("Sales", "region")],
            ..Default::default()
        })
        .await;
    let conn = identity::EntityId::from_bytes(identity::generate_uuid_v7());
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
        engine: Some(Arc::new(TokioMutex::new(engine))),
        model_key: None,
        connector_index: Some(idx),
        bindings: vec![],
        last_refreshed: None,
        created_at: String::new(),
        is_connected: true,
        active_queries: HashMap::new(),
        package_data_source_id: None,
        active_role: None,
        base_model: None,
        calculated_measures: vec![],
    };
    let bi = BiState::new();
    bi.connections.lock().unwrap().insert(conn, connection);
    (bi, conn)
}

fn strings(v: &[&str]) -> Vec<String> {
    v.iter().map(|s| s.to_string()).collect()
}

/// The label the host lists and the label the engine reads are ONE spelling.
#[test]
fn the_host_and_the_engine_spell_the_blank_member_alike() {
    assert!(
        bi_engine::is_blank_member_label(pivot_engine::BLANK_ITEM_LABEL),
        "the engine does not read the host's blank label {:?} (it reads {:?})",
        pivot_engine::BLANK_ITEM_LABEL,
        bi_engine::BLANK_MEMBER_LABEL
    );
}

#[tokio::test]
async fn a_model_value_list_offers_the_blank_member_last() {
    let (bi, conn) = bi_over(sales_with_blanks()).await;
    let values = super::commands::bi_get_column_values_core(&bi, conn, "Sales", "region").await.expect("the values");
    assert_eq!(
        values,
        strings(&["East", "North", "West", pivot_engine::BLANK_ITEM_LABEL]),
        "the model's value list does not offer the blank member (NULL and empty) exactly once, last"
    );
}

#[tokio::test]
async fn a_column_with_no_blank_records_offers_no_blank_member() {
    let (bi, conn) = bi_over(sales_without_blanks()).await;
    let values = super::commands::bi_get_column_values_core(&bi, conn, "Sales", "region").await.expect("the values");
    assert_eq!(values, strings(&["East", "West"]), "a blank member was offered for a column without blanks");
}

/// The has-data shading: a target value is available when some record carrying
/// it passes every cross filter. A blank record carries the blank member, and a
/// cross filter selecting the blank member admits the blank records.
#[tokio::test]
async fn available_values_carry_the_blank_member_both_ways() {
    let (bi, conn) = bi_over(sales_with_blanks()).await;
    // Target region, cross filter year = Y2: the only Y2 record has a NULL region.
    let by_y2 = super::commands::bi_get_column_available_values_core(
        &bi,
        conn,
        "Sales",
        "region",
        &[BiCrossFilter { table: "Sales".into(), column: "year".into(), values: strings(&["Y2"]) }],
    )
    .await
    .expect("available");
    assert_eq!(by_y2, strings(&[pivot_engine::BLANK_ITEM_LABEL]), "a blank-region record has no available item");

    // Cross filter year = (blank): the only NULL-year record is North's.
    let by_blank_year = super::commands::bi_get_column_available_values_core(
        &bi,
        conn,
        "Sales",
        "region",
        &[BiCrossFilter { table: "Sales".into(), column: "year".into(), values: strings(&["(Blank)"]) }],
    )
    .await
    .expect("available");
    assert_eq!(by_blank_year, strings(&["North"]), "a cross selection of the blank member admits no blank record");
}

/// A PINNED selection travels INSIDE the engine query as a level-tagged
/// IN-list (`pivot/commands.rs`, `scoped_in_filters`), carrying the list's own
/// items -- the blank member among them. The engine must read it as BLANK:
/// selecting East and (blank) keeps the NULL- and empty-region rows.
#[tokio::test]
async fn a_pinned_selection_naming_the_blank_member_keeps_the_blank_rows() {
    let (bi, conn) = bi_over(sales_with_blanks()).await;
    let engine_arc = bi.connections.lock().unwrap()[&conn].engine.clone().unwrap();
    let engine = engine_arc.lock().await;
    let batches = engine
        .query(QueryRequest {
            measures: vec!["Revenue".into()],
            group_by: vec![bi_engine::ColumnRef::new("Sales", "year")],
            scoped_in_filters: vec![bi_engine::ScopedInFilter {
                table: Some("Sales".into()),
                filter: bi_engine::InFilter::new("region", ["East", pivot_engine::BLANK_ITEM_LABEL]),
                level: 2,
            }],
            ..Default::default()
        })
        .await
        .expect("the pinned query");
    let mut total = 0.0;
    for b in &batches {
        let idx = b.schema().index_of("Revenue").expect("Revenue");
        let col = b.column(idx).as_any().downcast_ref::<Float64Array>().expect("f64");
        for r in 0..b.num_rows() {
            if !col.is_null(r) {
                total += col.value(r);
            }
        }
    }
    // East 10 + NULL region 30 + empty region 50.
    assert_eq!(total, 90.0, "a pinned (blank) selection dropped the blank rows");
}

/// Found with W6: the CUBE formula builder picks its members from the same
/// model value list, so it now offers `(blank)`. A CUBEVALUE member naming it
/// must read the column's blank rows (NULL and empty), as a slicer selection
/// does -- not the literal text `(blank)`, which matches no row and answers
/// `#N/A`. A member naming an ordinary value is unchanged.
#[tokio::test]
async fn a_cube_value_member_naming_the_blank_member_reads_the_blank_rows() {
    let (bi, _conn) = bi_over(sales_with_blanks()).await;
    let value = |member: &'static str| {
        let bi = &bi;
        async move {
            super::cube::script_cube_value(bi, "Sales", &["[Revenue]".to_string(), member.to_string()])
                .await
                .unwrap_or_else(|e| panic!("CUBEVALUE over `{member}`: {:?}", super::cube::cube_err_message(e)))
        }
    };
    // The NULL region (30) + the empty region (50).
    assert_eq!(value("Sales[region]=(blank)").await, Some(80.0), "a (blank) CUBE member read no blank row");
    assert_eq!(value("Sales[region]=(Blank)").await, Some(80.0), "the label is read in any case");
    // The spelling the CUBE builder writes (`buildFormula.ts` quotes a value
    // holding parentheses; the parser unquotes it).
    assert_eq!(value("Sales[region]='(blank)'").await, Some(80.0), "the builder's quoted (blank) read no blank row");
    assert_eq!(value("Sales[region]=East").await, Some(10.0), "an ordinary member changed");
}
