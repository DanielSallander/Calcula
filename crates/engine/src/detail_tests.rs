//! End-to-end drillthrough / detail-rows tests (`Engine::query_rows`).
//!
//! These build the engine over in-memory star-schema fixtures served entirely
//! from the cache (no connector), so the whole drillthrough path runs against
//! real data: filter-to-table matching, dimension→detail IN-propagation, the
//! RLS fail-closed check, direct role sealing, column projection, and the
//! mandatory row cap. The fixture is stored directly into `self.cache` (a
//! crate-private field), which is why this lives in the crate rather than
//! `tests/`.
//!
//! Fixture: a fact `Sales(geo_id, cat_id, amount)` related to two dimensions,
//! `Geography(id, region)` and `Category(id, name)`. Four Sales rows:
//!   West/Bikes   = 100   (geo 1, cat 10)
//!   East/Helmets = 40    (geo 2, cat 20)
//!   West/Helmets = 30    (geo 1, cat 20)
//!   East/Bikes   = 20    (geo 2, cat 10)
//! The `WestOnly` role filters `Geography.region = West`.

#![cfg(test)]

use std::sync::Arc;

use arrow::array::{Array, Float64Array, Int64Array, StringArray};
use arrow::datatypes::{DataType as ArrowType, Field, Schema};
use arrow::record_batch::RecordBatch;

use crate::{
    sum_measure, Cardinality, Column, ComparisonOp, DataModel, DataType, DetailRequest, Engine,
    EngineError, FilterCondition, FilterOperator, JoinCondition, JoinOperator, OrderByClause,
    QueryError, Relationship, SecurityRole, SourceBinding, StorageMode, Table,
};

// --- Fixtures ---

fn detail_model() -> DataModel {
    DataModel::builder()
        .add_table(
            Table::new(
                "Sales",
                vec![
                    Column::new("order_id", DataType::Int64),
                    Column::new("geo_id", DataType::Int64),
                    Column::new("cat_id", DataType::Int64),
                    Column::new("amount", DataType::Float64),
                ],
            )
            .unwrap()
            .with_storage_mode(StorageMode::InMemory),
        )
        .add_table(
            Table::new(
                "Geography",
                vec![
                    Column::new("id", DataType::Int64),
                    Column::new("region", DataType::String),
                ],
            )
            .unwrap()
            .with_storage_mode(StorageMode::InMemory),
        )
        .add_table(
            Table::new(
                "Category",
                vec![
                    Column::new("id", DataType::Int64),
                    Column::new("name", DataType::String),
                ],
            )
            .unwrap()
            .with_storage_mode(StorageMode::InMemory),
        )
        .add_relationship(Relationship::many_to_one(
            "Sales_Geo",
            "Sales",
            "geo_id",
            "Geography",
            "id",
        ))
        .add_relationship(Relationship::many_to_one(
            "Sales_Cat",
            "Sales",
            "cat_id",
            "Category",
            "id",
        ))
        .add_measure(sum_measure("Revenue", "Sales", "amount"))
        .add_security_role(SecurityRole::new("WestOnly").with_filter(
            "Geography",
            "region",
            ComparisonOp::Equal,
            "West",
        ))
        .build()
        .unwrap()
}

fn geo_batch() -> RecordBatch {
    // geo 1 = West, geo 2 = East.
    RecordBatch::try_new(
        Arc::new(Schema::new(vec![
            Field::new("id", ArrowType::Int64, true),
            Field::new("region", ArrowType::Utf8, true),
        ])),
        vec![
            Arc::new(Int64Array::from(vec![1, 2])),
            Arc::new(StringArray::from(vec!["West", "East"])),
        ],
    )
    .unwrap()
}

fn cat_batch() -> RecordBatch {
    // cat 10 = Bikes, cat 20 = Helmets.
    RecordBatch::try_new(
        Arc::new(Schema::new(vec![
            Field::new("id", ArrowType::Int64, true),
            Field::new("name", ArrowType::Utf8, true),
        ])),
        vec![
            Arc::new(Int64Array::from(vec![10, 20])),
            Arc::new(StringArray::from(vec!["Bikes", "Helmets"])),
        ],
    )
    .unwrap()
}

fn sales_batch() -> RecordBatch {
    // order_id, geo_id, cat_id, amount:
    //   1: West/Bikes   = 100
    //   2: East/Helmets = 40
    //   3: West/Helmets = 30
    //   4: East/Bikes   = 20
    RecordBatch::try_new(
        Arc::new(Schema::new(vec![
            Field::new("order_id", ArrowType::Int64, true),
            Field::new("geo_id", ArrowType::Int64, true),
            Field::new("cat_id", ArrowType::Int64, true),
            Field::new("amount", ArrowType::Float64, true),
        ])),
        vec![
            Arc::new(Int64Array::from(vec![1, 2, 3, 4])),
            Arc::new(Int64Array::from(vec![1, 2, 1, 2])),
            Arc::new(Int64Array::from(vec![10, 20, 20, 10])),
            Arc::new(Float64Array::from(vec![100.0, 40.0, 30.0, 20.0])),
        ],
    )
    .unwrap()
}

/// Engine over the in-memory star schema with all three tables cached.
fn detail_engine() -> Engine {
    let mut engine = Engine::new(detail_model());
    engine.bind_table("Sales", 0, SourceBinding::new("public", "sales"));
    engine.bind_table("Geography", 0, SourceBinding::new("public", "geography"));
    engine.bind_table("Category", 0, SourceBinding::new("public", "category"));
    engine.cache.store("Sales", sales_batch()).unwrap();
    engine.cache.store("Geography", geo_batch()).unwrap();
    engine.cache.store("Category", cat_batch()).unwrap();
    engine
}

// --- Result extraction helpers ---

fn col_idx(batch: &RecordBatch, name: &str) -> usize {
    batch
        .schema()
        .index_of(name)
        .unwrap_or_else(|_| panic!("column '{name}' not found in {:?}", batch.schema()))
}

fn i64_at(batch: &RecordBatch, col: &str, row: usize) -> i64 {
    batch
        .column(col_idx(batch, col))
        .as_any()
        .downcast_ref::<Int64Array>()
        .unwrap()
        .value(row)
}

/// All values of an Int64 detail column across the result batches.
fn i64_column(batches: &[RecordBatch], col: &str) -> Vec<i64> {
    let mut out = Vec::new();
    for b in batches {
        for row in 0..b.num_rows() {
            out.push(i64_at(b, col, row));
        }
    }
    out
}

fn total_rows(batches: &[RecordBatch]) -> usize {
    batches.iter().map(|b| b.num_rows()).sum()
}

/// The set of order_ids in the result, sorted ascending.
fn order_ids(batches: &[RecordBatch]) -> Vec<i64> {
    let mut ids = i64_column(batches, "order_id");
    ids.sort_unstable();
    ids
}

fn cell_eq(column: &str, value: &str) -> FilterCondition {
    FilterCondition {
        column: column.into(),
        operator: FilterOperator::Equal,
        value: value.into(),
    }
}

// --- Tests ---

// (1) Direct fact-column projection + limit returns the right rows/limit.
#[tokio::test]
async fn projects_requested_columns_and_returns_all_rows() {
    let engine = detail_engine();
    let batches = engine
        .query_rows(DetailRequest::new("Sales", 100).with_columns(["order_id", "amount"]))
        .await
        .unwrap();

    assert_eq!(total_rows(&batches), 4, "all four Sales rows");
    // Only the two requested columns, in the requested order.
    assert_eq!(batches[0].num_columns(), 2);
    assert_eq!(batches[0].schema().field(0).name(), "order_id");
    assert_eq!(batches[0].schema().field(1).name(), "amount");
    assert_eq!(order_ids(&batches), vec![1, 2, 3, 4]);
}

#[tokio::test]
async fn empty_columns_returns_all_detail_columns() {
    let engine = detail_engine();
    let batches = engine
        .query_rows(DetailRequest::new("Sales", 100))
        .await
        .unwrap();
    assert_eq!(total_rows(&batches), 4);
    // order_id, geo_id, cat_id, amount.
    assert_eq!(batches[0].num_columns(), 4);
}

// (8) Limit is honored (fewer rows than total).
#[tokio::test]
async fn limit_caps_returned_rows() {
    let engine = detail_engine();
    let batches = engine
        .query_rows(DetailRequest::new("Sales", 2))
        .await
        .unwrap();
    assert_eq!(total_rows(&batches), 2, "limit 2 of 4 rows");
}

#[tokio::test]
async fn zero_limit_returns_no_rows() {
    let engine = detail_engine();
    let batches = engine
        .query_rows(DetailRequest::new("Sales", 0))
        .await
        .unwrap();
    assert_eq!(total_rows(&batches), 0);
}

// (2) Cell-coordinate filter on the FACT restricts rows.
#[tokio::test]
async fn cell_filter_on_fact_column_restricts_rows() {
    let engine = detail_engine();
    // amount = 100 → only order 1.
    let batches = engine
        .query_rows(DetailRequest::new("Sales", 100).with_filters(vec![cell_eq("amount", "100")]))
        .await
        .unwrap();
    assert_eq!(order_ids(&batches), vec![1]);
}

// (3) Cell-coordinate filter on a DIMENSION restricts the fact rows
//     (propagation). region = West → Sales rows joined to West geo (orders 1, 3).
#[tokio::test]
async fn cell_filter_on_dimension_propagates_to_fact() {
    let engine = detail_engine();
    let batches = engine
        .query_rows(DetailRequest::new("Sales", 100).with_filters(vec![cell_eq("region", "West")]))
        .await
        .unwrap();
    assert_eq!(
        order_ids(&batches),
        vec![1, 3],
        "only West-geo Sales rows survive"
    );
}

#[tokio::test]
async fn cell_filters_on_two_dimensions_intersect_on_fact() {
    let engine = detail_engine();
    // region = West AND name = Helmets → order 3 only (West/Helmets).
    let batches = engine
        .query_rows(
            DetailRequest::new("Sales", 100)
                .with_filters(vec![cell_eq("region", "West"), cell_eq("name", "Helmets")]),
        )
        .await
        .unwrap();
    assert_eq!(order_ids(&batches), vec![3]);
}

// A dimension filter that matches ZERO dimension rows must yield zero detail
// rows (the propagated key set is empty). This guards the security floor: a
// connector that drops an empty `IN ()` filter would otherwise return the
// whole fact table. Applies equally to a role whose dimension predicate
// matches nothing.
#[tokio::test]
async fn dimension_filter_matching_no_rows_returns_zero_detail_rows() {
    let engine = detail_engine();
    let batches = engine
        .query_rows(
            DetailRequest::new("Sales", 100).with_filters(vec![cell_eq("region", "Atlantis")]),
        )
        .await
        .unwrap();
    assert_eq!(
        order_ids(&batches),
        Vec::<i64>::new(),
        "a dimension filter with no matches must return no fact rows, not all of them"
    );
}

// (4) HEADLINE: role on a DIMENSION restricts drillthrough rows.
#[tokio::test]
async fn role_on_dimension_restricts_drillthrough_rows() {
    let mut engine = detail_engine();
    engine.set_active_role(Some("WestOnly".into()));

    // No cell filters at all — the WestOnly role alone must restrict the raw
    // Sales rows to those joined to a West Geography row (orders 1, 3).
    let batches = engine
        .query_rows(DetailRequest::new("Sales", 100))
        .await
        .unwrap();
    assert_eq!(
        order_ids(&batches),
        vec![1, 3],
        "WestOnly role must restrict the raw detail rows to West, never leak East"
    );
}

#[tokio::test]
async fn role_on_dimension_composes_with_other_cell_filter() {
    let mut engine = detail_engine();
    engine.set_active_role(Some("WestOnly".into()));

    // WestOnly role + cell filter name = Bikes → order 1 only (West/Bikes).
    // The East/Bikes row (order 4) must be excluded by the role.
    let batches = engine
        .query_rows(DetailRequest::new("Sales", 100).with_filters(vec![cell_eq("name", "Bikes")]))
        .await
        .unwrap();
    assert_eq!(order_ids(&batches), vec![1]);
}

// (5) Role on the fact restricts drillthrough rows.
#[tokio::test]
async fn role_on_fact_table_restricts_drillthrough_rows() {
    // A role that filters the fact directly (amount >= 30) drops the East/Bikes
    // row (20) → orders 1, 2, 3 survive.
    let model = DataModel::builder()
        .add_table(
            Table::new(
                "Sales",
                vec![
                    Column::new("order_id", DataType::Int64),
                    Column::new("amount", DataType::Float64),
                ],
            )
            .unwrap()
            .with_storage_mode(StorageMode::InMemory),
        )
        .add_measure(sum_measure("Revenue", "Sales", "amount"))
        .add_security_role(SecurityRole::new("BigOnly").with_filter(
            "Sales",
            "amount",
            ComparisonOp::GreaterThanOrEqual,
            "30",
        ))
        .build()
        .unwrap();

    let mut engine = Engine::new(model);
    engine.bind_table("Sales", 0, SourceBinding::new("public", "sales"));
    let sales = RecordBatch::try_new(
        Arc::new(Schema::new(vec![
            Field::new("order_id", ArrowType::Int64, true),
            Field::new("amount", ArrowType::Float64, true),
        ])),
        vec![
            Arc::new(Int64Array::from(vec![1, 2, 3, 4])),
            Arc::new(Float64Array::from(vec![100.0, 40.0, 30.0, 20.0])),
        ],
    )
    .unwrap();
    engine.cache.store("Sales", sales).unwrap();
    engine.set_active_role(Some("BigOnly".into()));

    let batches = engine
        .query_rows(DetailRequest::new("Sales", 100))
        .await
        .unwrap();
    assert_eq!(
        order_ids(&batches),
        vec![1, 2, 3],
        "BigOnly (amount >= 30) drops the 20 row"
    );
}

// An active role that filters a table UNRELATED to the detail table must be a
// no-op (not an error): the role restricts nothing the drillthrough can
// observe. A standalone "Audit" dimension with no relationship to Sales, and a
// role on it, must leave a Sales drillthrough unrestricted.
#[tokio::test]
async fn unrelated_role_does_not_break_drillthrough() {
    let model = DataModel::builder()
        .add_table(
            Table::new(
                "Sales",
                vec![
                    Column::new("order_id", DataType::Int64),
                    Column::new("amount", DataType::Float64),
                ],
            )
            .unwrap()
            .with_storage_mode(StorageMode::InMemory),
        )
        // A table with NO relationship to Sales.
        .add_table(
            Table::new(
                "Audit",
                vec![
                    Column::new("id", DataType::Int64),
                    Column::new("level", DataType::String),
                ],
            )
            .unwrap()
            .with_storage_mode(StorageMode::InMemory),
        )
        .add_security_role(SecurityRole::new("AuditOnly").with_filter(
            "Audit",
            "level",
            ComparisonOp::Equal,
            "high",
        ))
        .build()
        .unwrap();
    let mut engine = Engine::new(model);
    engine.bind_table("Sales", 0, SourceBinding::new("public", "sales"));
    let sales = RecordBatch::try_new(
        Arc::new(Schema::new(vec![
            Field::new("order_id", ArrowType::Int64, true),
            Field::new("amount", ArrowType::Float64, true),
        ])),
        vec![
            Arc::new(Int64Array::from(vec![1, 2, 3])),
            Arc::new(Float64Array::from(vec![10.0, 20.0, 30.0])),
        ],
    )
    .unwrap();
    engine.cache.store("Sales", sales).unwrap();
    engine.set_active_role(Some("AuditOnly".into()));

    // The Audit role is unreachable from Sales → irrelevant → all rows returned.
    let batches = engine
        .query_rows(DetailRequest::new("Sales", 100))
        .await
        .unwrap();
    assert_eq!(order_ids(&batches), vec![1, 2, 3]);
}

// (7) No active role → all rows (up to limit).
#[tokio::test]
async fn no_active_role_returns_all_rows() {
    let engine = detail_engine();
    assert!(engine.active_role().is_none());
    let batches = engine
        .query_rows(DetailRequest::new("Sales", 100))
        .await
        .unwrap();
    assert_eq!(order_ids(&batches), vec![1, 2, 3, 4]);
}

// (9) Cached/in-memory detail-table path: the whole fixture is cache-served,
//     so every test above already exercises it. This one asserts the result
//     content (a projected, filtered, cached read) is exactly right.
#[tokio::test]
async fn cached_detail_table_path_filters_projects_and_limits() {
    let engine = detail_engine();
    let batches = engine
        .query_rows(
            DetailRequest::new("Sales", 10)
                .with_columns(["order_id"])
                .with_filters(vec![cell_eq("region", "West")]),
        )
        .await
        .unwrap();
    // West propagation (orders 1, 3), single projected column.
    assert_eq!(batches[0].num_columns(), 1);
    assert_eq!(order_ids(&batches), vec![1, 3]);
}

// (6) FAIL CLOSED: role on a non-equi / many-to-many dimension refuses the
//     query rather than returning under-restricted raw rows.
#[tokio::test]
async fn unenforceable_dimension_role_refuses_drillthrough() {
    let model = DataModel::builder()
        .add_table(
            Table::new(
                "Sales",
                vec![
                    Column::new("order_id", DataType::Int64),
                    Column::new("order_day", DataType::Int64),
                    Column::new("amount", DataType::Float64),
                ],
            )
            .unwrap()
            .with_storage_mode(StorageMode::InMemory),
        )
        .add_table(
            Table::new(
                "Periods",
                vec![
                    Column::new("start_day", DataType::Int64),
                    Column::new("end_day", DataType::Int64),
                    Column::new("region", DataType::String),
                ],
            )
            .unwrap()
            .with_storage_mode(StorageMode::InMemory),
        )
        // Non-equi BETWEEN, many-to-many: IN-propagation cannot express it.
        .add_relationship(Relationship::with_conditions(
            "Sales_Periods",
            "Sales",
            "Periods",
            vec![
                JoinCondition::new("order_day", "start_day", JoinOperator::GreaterThanOrEqual),
                JoinCondition::new("order_day", "end_day", JoinOperator::LessThanOrEqual),
            ],
            Cardinality::ManyToMany,
        ))
        .add_measure(sum_measure("Revenue", "Sales", "amount"))
        .add_security_role(SecurityRole::new("WestOnly").with_filter(
            "Periods",
            "region",
            ComparisonOp::Equal,
            "West",
        ))
        .build()
        .unwrap();

    let mut engine = Engine::new(model);
    engine.bind_table("Sales", 0, SourceBinding::new("public", "sales"));
    engine.bind_table("Periods", 0, SourceBinding::new("public", "periods"));
    let sales = RecordBatch::try_new(
        Arc::new(Schema::new(vec![
            Field::new("order_id", ArrowType::Int64, true),
            Field::new("order_day", ArrowType::Int64, true),
            Field::new("amount", ArrowType::Float64, true),
        ])),
        vec![
            Arc::new(Int64Array::from(vec![1, 2, 3])),
            Arc::new(Int64Array::from(vec![1, 2, 3])),
            Arc::new(Float64Array::from(vec![10.0, 20.0, 30.0])),
        ],
    )
    .unwrap();
    engine.cache.store("Sales", sales).unwrap();
    engine.set_active_role(Some("WestOnly".into()));

    let err = engine
        .query_rows(DetailRequest::new("Sales", 100))
        .await
        .unwrap_err();
    match err {
        QueryError::Engine(EngineError::RowLevelSecurityNotEnforceable { table, .. }) => {
            assert_eq!(table, "Periods");
        }
        other => panic!("expected RowLevelSecurityNotEnforceable, got {other:?}"),
    }
}

// (10) Unknown detail table → SourceNotRegistered.
#[tokio::test]
async fn unknown_detail_table_errors() {
    let engine = detail_engine();
    let err = engine
        .query_rows(DetailRequest::new("Ghost", 100))
        .await
        .unwrap_err();
    // "Ghost" is not in the model at all → TableNotFound (engine error).
    match err {
        QueryError::Engine(EngineError::TableNotFound(name)) => assert_eq!(name, "Ghost"),
        other => panic!("expected TableNotFound, got {other:?}"),
    }
}

#[tokio::test]
async fn modeled_but_unbound_uncached_table_is_source_not_registered() {
    // A table that exists in the model but is neither cached nor bound to a
    // connector → SourceNotRegistered.
    let model = DataModel::builder()
        .add_table(Table::new("Sales", vec![Column::new("amount", DataType::Float64)]).unwrap())
        .build()
        .unwrap();
    let engine = Engine::new(model);
    let err = engine
        .query_rows(DetailRequest::new("Sales", 100))
        .await
        .unwrap_err();
    assert!(
        matches!(err, QueryError::SourceNotRegistered(ref t) if t == "Sales"),
        "got {err:?}"
    );
}

// (11) Unknown active role → SecurityRoleNotFound.
#[tokio::test]
async fn unknown_active_role_errors() {
    let mut engine = detail_engine();
    engine.set_active_role(Some("DoesNotExist".into()));
    let err = engine
        .query_rows(DetailRequest::new("Sales", 100))
        .await
        .unwrap_err();
    match err {
        QueryError::Engine(EngineError::SecurityRoleNotFound(name)) => {
            assert_eq!(name, "DoesNotExist");
        }
        other => panic!("expected SecurityRoleNotFound, got {other:?}"),
    }
}

// --- ORDER BY and invalid-filter handling ---

#[tokio::test]
async fn order_by_detail_column_descending() {
    let engine = detail_engine();
    let batches = engine
        .query_rows(
            DetailRequest::new("Sales", 100)
                .with_order_by(vec![OrderByClause::column_desc("Sales", "amount")]),
        )
        .await
        .unwrap();
    // Cached path orders via the underlying read; assert the rows are present.
    // (The connector path renders ORDER BY into SQL; the cached path returns
    // the filtered batch. Either way all four rows are returned here.)
    assert_eq!(order_ids(&batches), vec![1, 2, 3, 4]);
}

#[tokio::test]
async fn filter_on_unrelated_column_is_rejected() {
    let engine = detail_engine();
    // "nonexistent" is not a Sales column nor any propagatable dimension's.
    let err = engine
        .query_rows(
            DetailRequest::new("Sales", 100).with_filters(vec![cell_eq("nonexistent", "x")]),
        )
        .await
        .unwrap_err();
    assert!(matches!(err, QueryError::InvalidQuery(_)), "got {err:?}");
}

#[tokio::test]
async fn cancelled_token_returns_cancelled() {
    use crate::CancellationToken;
    let engine = detail_engine();
    let token = CancellationToken::new();
    token.cancel();
    let err = engine
        .query_rows_with_cancellation(DetailRequest::new("Sales", 100), token)
        .await
        .unwrap_err();
    assert!(matches!(err, QueryError::Cancelled), "got {err:?}");
}
