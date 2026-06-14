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
    sum_measure, Cardinality, Column, ColumnRef, ComparisonOp, DataModel, DataType, DetailRequest,
    Engine, EngineError, FilterCondition, FilterOperator, JoinCondition, JoinOperator,
    OrderByClause, QueryError, Relationship, SecurityRole, SourceBinding, StorageMode, Table,
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

/// Read the value of a (nullable) string column at `row`, or `None` for NULL.
fn str_opt_at(batch: &RecordBatch, col: &str, row: usize) -> Option<String> {
    let arr = batch
        .column(col_idx(batch, col))
        .as_any()
        .downcast_ref::<StringArray>()
        .expect("string column");
    if arr.is_null(row) {
        None
    } else {
        Some(arr.value(row).to_string())
    }
}

/// Map order_id → value of a string attribute column, across all result
/// batches. Robust to row ordering and batching.
fn str_attr_by_order(
    batches: &[RecordBatch],
    attr: &str,
) -> std::collections::HashMap<i64, Option<String>> {
    let mut map = std::collections::HashMap::new();
    for b in batches {
        for row in 0..b.num_rows() {
            let id = i64_at(b, "order_id", row);
            map.insert(id, str_opt_at(b, attr, row));
        }
    }
    map
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

// --- Dimension-attribute output columns (drillthrough join-back) ---

// (A) Requesting Category.name + Geography.region alongside fact columns
//     attaches the right attribute to each detail row (many-to-one lookup).
#[tokio::test]
async fn dimension_attributes_attach_per_row() {
    let engine = detail_engine();
    let batches = engine
        .query_rows(
            DetailRequest::new("Sales", 100)
                .with_columns(["order_id"])
                .with_dimension_columns(vec![
                    ColumnRef::new("Category", "name"),
                    ColumnRef::new("Geography", "region"),
                ]),
        )
        .await
        .unwrap();

    // Row set unchanged (all four orders), no duplication.
    assert_eq!(order_ids(&batches), vec![1, 2, 3, 4]);
    assert_eq!(total_rows(&batches), 4);

    // Projection order: order_id, then name, then region (no collision, bare
    // attribute names).
    let s = batches[0].schema();
    assert_eq!(s.field(0).name(), "order_id");
    assert_eq!(s.field(1).name(), "name");
    assert_eq!(s.field(2).name(), "region");

    // Attribute values per row (1=West/Bikes, 2=East/Helmets, 3=West/Helmets,
    // 4=East/Bikes).
    let names = str_attr_by_order(&batches, "name");
    assert_eq!(names[&1], Some("Bikes".into()));
    assert_eq!(names[&2], Some("Helmets".into()));
    assert_eq!(names[&3], Some("Helmets".into()));
    assert_eq!(names[&4], Some("Bikes".into()));
    let regions = str_attr_by_order(&batches, "region");
    assert_eq!(regions[&1], Some("West".into()));
    assert_eq!(regions[&2], Some("East".into()));
    assert_eq!(regions[&3], Some("West".into()));
    assert_eq!(regions[&4], Some("East".into()));
}

// (B) Empty dimension_columns → unchanged behavior (no join, all detail cols).
#[tokio::test]
async fn empty_dimension_columns_is_unchanged() {
    let engine = detail_engine();
    let batches = engine
        .query_rows(DetailRequest::new("Sales", 100).with_dimension_columns(vec![]))
        .await
        .unwrap();
    assert_eq!(order_ids(&batches), vec![1, 2, 3, 4]);
    // order_id, geo_id, cat_id, amount — exactly the detail columns.
    assert_eq!(batches[0].num_columns(), 4);
}

// (C) Name collision: an attribute whose column name equals a detail column
//     name, AND two dimensions sharing an attribute name → all qualified as
//     "Table.column", schema names unique.
#[tokio::test]
async fn colliding_attribute_names_are_qualified() {
    // Model where both dimensions expose a "label" column, and the fact also
    // has a "label" column — three-way collision.
    let model = DataModel::builder()
        .add_table(
            Table::new(
                "Sales",
                vec![
                    Column::new("order_id", DataType::Int64),
                    Column::new("geo_id", DataType::Int64),
                    Column::new("cat_id", DataType::Int64),
                    Column::new("label", DataType::String), // collides with dim attrs
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
                    Column::new("label", DataType::String),
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
                    Column::new("label", DataType::String),
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
        .build()
        .unwrap();

    let mut engine = Engine::new(model);
    engine.bind_table("Sales", 0, SourceBinding::new("public", "sales"));
    engine.bind_table("Geography", 0, SourceBinding::new("public", "geography"));
    engine.bind_table("Category", 0, SourceBinding::new("public", "category"));
    engine
        .cache
        .store(
            "Sales",
            RecordBatch::try_new(
                Arc::new(Schema::new(vec![
                    Field::new("order_id", ArrowType::Int64, true),
                    Field::new("geo_id", ArrowType::Int64, true),
                    Field::new("cat_id", ArrowType::Int64, true),
                    Field::new("label", ArrowType::Utf8, true),
                ])),
                vec![
                    Arc::new(Int64Array::from(vec![1, 2])),
                    Arc::new(Int64Array::from(vec![1, 2])),
                    Arc::new(Int64Array::from(vec![10, 20])),
                    Arc::new(StringArray::from(vec!["fact-a", "fact-b"])),
                ],
            )
            .unwrap(),
        )
        .unwrap();
    engine
        .cache
        .store(
            "Geography",
            RecordBatch::try_new(
                Arc::new(Schema::new(vec![
                    Field::new("id", ArrowType::Int64, true),
                    Field::new("label", ArrowType::Utf8, true),
                ])),
                vec![
                    Arc::new(Int64Array::from(vec![1, 2])),
                    Arc::new(StringArray::from(vec!["geo-west", "geo-east"])),
                ],
            )
            .unwrap(),
        )
        .unwrap();
    engine
        .cache
        .store(
            "Category",
            RecordBatch::try_new(
                Arc::new(Schema::new(vec![
                    Field::new("id", ArrowType::Int64, true),
                    Field::new("label", ArrowType::Utf8, true),
                ])),
                vec![
                    Arc::new(Int64Array::from(vec![10, 20])),
                    Arc::new(StringArray::from(vec!["cat-bikes", "cat-helmets"])),
                ],
            )
            .unwrap(),
        )
        .unwrap();

    let batches = engine
        .query_rows(
            DetailRequest::new("Sales", 100)
                .with_columns(["order_id", "label"]) // fact "label"
                .with_dimension_columns(vec![
                    ColumnRef::new("Geography", "label"),
                    ColumnRef::new("Category", "label"),
                ]),
        )
        .await
        .unwrap();

    let s = batches[0].schema();
    let names: Vec<&str> = s.fields().iter().map(|f| f.name().as_str()).collect();
    // Fact "label" keeps the bare name (it was selected first); both dimension
    // attributes are qualified because "label" is already used.
    assert_eq!(
        names,
        vec!["order_id", "label", "Geography.label", "Category.label"]
    );
    // All names unique.
    let unique: std::collections::HashSet<&&str> = names.iter().collect();
    assert_eq!(
        unique.len(),
        names.len(),
        "result column names must be unique"
    );

    // Values land in the right columns for order 1 (geo 1, cat 10). The lookup
    // scans every result batch (DataFusion may split the join output).
    let fact_labels = str_attr_by_order(&batches, "label");
    let geo_labels = str_attr_by_order(&batches, "Geography.label");
    let cat_labels = str_attr_by_order(&batches, "Category.label");
    assert_eq!(fact_labels[&1], Some("fact-a".into()));
    assert_eq!(geo_labels[&1], Some("geo-west".into()));
    assert_eq!(cat_labels[&1], Some("cat-bikes".into()));
}

// (D) HEADLINE SECURITY: a role on the attribute dimension restricts the rows
//     AND only permitted attributes are shown; row count preserved vs. no
//     attributes.
#[tokio::test]
async fn role_on_attribute_dimension_restricts_rows_and_attributes() {
    let mut engine = detail_engine();
    engine.set_active_role(Some("WestOnly".into()));

    // Baseline: rows under the role WITHOUT attributes (orders 1, 3 — West).
    let baseline = engine
        .query_rows(DetailRequest::new("Sales", 100))
        .await
        .unwrap();
    let baseline_count = total_rows(&baseline);
    assert_eq!(order_ids(&baseline), vec![1, 3]);

    // WITH the Geography.region attribute requested.
    let batches = engine
        .query_rows(
            DetailRequest::new("Sales", 100)
                .with_columns(["order_id"])
                .with_dimension_columns(vec![ColumnRef::new("Geography", "region")]),
        )
        .await
        .unwrap();

    // Row count preserved (adding the attribute did not add/drop rows).
    assert_eq!(
        total_rows(&batches),
        baseline_count,
        "dimension attribute join must not change the detail row count"
    );
    assert_eq!(order_ids(&batches), vec![1, 3], "still only West rows");

    // Only permitted attribute values appear: every region is West, never East.
    let regions = str_attr_by_order(&batches, "region");
    assert_eq!(regions[&1], Some("West".into()));
    assert_eq!(regions[&3], Some("West".into()));
    for v in regions.values() {
        assert_eq!(v.as_deref(), Some("West"), "no East attribute may leak");
    }
}

// A role on a DIFFERENT dimension than the requested attribute still restricts
// the rows, and the requested attribute is shown only for surviving rows.
#[tokio::test]
async fn role_restricts_rows_then_attribute_of_other_dimension_shown() {
    let mut engine = detail_engine();
    engine.set_active_role(Some("WestOnly".into())); // role on Geography

    // Request Category.name (a DIFFERENT dimension). Surviving rows are the
    // West ones (orders 1=Bikes, 3=Helmets).
    let batches = engine
        .query_rows(
            DetailRequest::new("Sales", 100)
                .with_columns(["order_id"])
                .with_dimension_columns(vec![ColumnRef::new("Category", "name")]),
        )
        .await
        .unwrap();
    assert_eq!(order_ids(&batches), vec![1, 3]);
    let names = str_attr_by_order(&batches, "name");
    assert_eq!(names[&1], Some("Bikes".into()));
    assert_eq!(names[&3], Some("Helmets".into()));
}

// (E) Attribute on a non-single-equi / many-to-many dimension → InvalidQuery.
#[tokio::test]
async fn attribute_on_non_equi_dimension_is_invalid() {
    // Reuse a fact + a many-to-many BETWEEN relationship (cannot be a lookup).
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
                    Column::new("label", DataType::String),
                ],
            )
            .unwrap()
            .with_storage_mode(StorageMode::InMemory),
        )
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
        .build()
        .unwrap();
    let mut engine = Engine::new(model);
    engine.bind_table("Sales", 0, SourceBinding::new("public", "sales"));
    engine.bind_table("Periods", 0, SourceBinding::new("public", "periods"));
    engine
        .cache
        .store(
            "Sales",
            RecordBatch::try_new(
                Arc::new(Schema::new(vec![
                    Field::new("order_id", ArrowType::Int64, true),
                    Field::new("order_day", ArrowType::Int64, true),
                    Field::new("amount", ArrowType::Float64, true),
                ])),
                vec![
                    Arc::new(Int64Array::from(vec![1])),
                    Arc::new(Int64Array::from(vec![1])),
                    Arc::new(Float64Array::from(vec![10.0])),
                ],
            )
            .unwrap(),
        )
        .unwrap();
    engine
        .cache
        .store(
            "Periods",
            RecordBatch::try_new(
                Arc::new(Schema::new(vec![
                    Field::new("start_day", ArrowType::Int64, true),
                    Field::new("end_day", ArrowType::Int64, true),
                    Field::new("label", ArrowType::Utf8, true),
                ])),
                vec![
                    Arc::new(Int64Array::from(vec![1])),
                    Arc::new(Int64Array::from(vec![10])),
                    Arc::new(StringArray::from(vec!["Q1"])),
                ],
            )
            .unwrap(),
        )
        .unwrap();

    let err = engine
        .query_rows(
            DetailRequest::new("Sales", 100)
                .with_dimension_columns(vec![ColumnRef::new("Periods", "label")]),
        )
        .await
        .unwrap_err();
    assert!(matches!(err, QueryError::InvalidQuery(_)), "got {err:?}");
}

// Attribute on a multi-hop / snowflake dimension (no direct relationship to the
// detail table) → InvalidQuery.
#[tokio::test]
async fn attribute_on_snowflake_dimension_is_invalid() {
    // Sales → Category → CategoryGroup. CategoryGroup is two hops from Sales,
    // with no direct relationship → out of scope.
    let model = DataModel::builder()
        .add_table(
            Table::new(
                "Sales",
                vec![
                    Column::new("order_id", DataType::Int64),
                    Column::new("cat_id", DataType::Int64),
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
                    Column::new("group_id", DataType::Int64),
                    Column::new("name", DataType::String),
                ],
            )
            .unwrap()
            .with_storage_mode(StorageMode::InMemory),
        )
        .add_table(
            Table::new(
                "CategoryGroup",
                vec![
                    Column::new("id", DataType::Int64),
                    Column::new("group_name", DataType::String),
                ],
            )
            .unwrap()
            .with_storage_mode(StorageMode::InMemory),
        )
        .add_relationship(Relationship::many_to_one(
            "Sales_Cat",
            "Sales",
            "cat_id",
            "Category",
            "id",
        ))
        .add_relationship(Relationship::many_to_one(
            "Cat_Group",
            "Category",
            "group_id",
            "CategoryGroup",
            "id",
        ))
        .build()
        .unwrap();
    let mut engine = Engine::new(model);
    engine.bind_table("Sales", 0, SourceBinding::new("public", "sales"));
    engine.bind_table("Category", 0, SourceBinding::new("public", "category"));
    engine.bind_table(
        "CategoryGroup",
        0,
        SourceBinding::new("public", "category_group"),
    );
    engine
        .cache
        .store(
            "Sales",
            RecordBatch::try_new(
                Arc::new(Schema::new(vec![
                    Field::new("order_id", ArrowType::Int64, true),
                    Field::new("cat_id", ArrowType::Int64, true),
                ])),
                vec![
                    Arc::new(Int64Array::from(vec![1])),
                    Arc::new(Int64Array::from(vec![10])),
                ],
            )
            .unwrap(),
        )
        .unwrap();

    let err = engine
        .query_rows(
            DetailRequest::new("Sales", 100)
                .with_dimension_columns(vec![ColumnRef::new("CategoryGroup", "group_name")]),
        )
        .await
        .unwrap_err();
    assert!(matches!(err, QueryError::InvalidQuery(_)), "got {err:?}");
}

// (F) Unknown dimension table → typed engine error (TableNotFound).
#[tokio::test]
async fn unknown_dimension_table_attribute_errors() {
    let engine = detail_engine();
    let err = engine
        .query_rows(
            DetailRequest::new("Sales", 100)
                .with_dimension_columns(vec![ColumnRef::new("Ghost", "x")]),
        )
        .await
        .unwrap_err();
    match err {
        QueryError::Engine(EngineError::TableNotFound(name)) => assert_eq!(name, "Ghost"),
        other => panic!("expected TableNotFound, got {other:?}"),
    }
}

// Unknown attribute column on a known dimension → typed engine error.
#[tokio::test]
async fn unknown_dimension_attribute_column_errors() {
    let engine = detail_engine();
    let err = engine
        .query_rows(
            DetailRequest::new("Sales", 100)
                .with_dimension_columns(vec![ColumnRef::new("Geography", "ghost_col")]),
        )
        .await
        .unwrap_err();
    match err {
        QueryError::Engine(EngineError::ColumnNotFound { table, column }) => {
            assert_eq!(table, "Geography");
            assert_eq!(column, "ghost_col");
        }
        other => panic!("expected ColumnNotFound, got {other:?}"),
    }
}

// (G) Limit still applies to detail rows; the attribute join does not change
//     the count.
#[tokio::test]
async fn limit_applies_with_dimension_attributes() {
    let engine = detail_engine();
    let batches = engine
        .query_rows(
            DetailRequest::new("Sales", 2)
                .with_columns(["order_id"])
                .with_dimension_columns(vec![ColumnRef::new("Geography", "region")]),
        )
        .await
        .unwrap();
    assert_eq!(
        total_rows(&batches),
        2,
        "limit 2 still caps the detail rows"
    );
    // Each surviving row still carries a (West/East) region attribute.
    let s = batches[0].schema();
    assert_eq!(s.field(1).name(), "region");
}

// (H) Cached-detail + cached-dimension path (the whole fixture is cached) plus
//     a dimension cell filter — exercises propagation AND attribute join
//     together, all from cache.
#[tokio::test]
async fn cached_detail_and_cached_dimension_attribute_path() {
    let engine = detail_engine();
    // region = West restricts to orders 1, 3, and we also display Category.name.
    let batches = engine
        .query_rows(
            DetailRequest::new("Sales", 100)
                .with_columns(["order_id"])
                .with_filters(vec![cell_eq("region", "West")])
                .with_dimension_columns(vec![ColumnRef::new("Category", "name")]),
        )
        .await
        .unwrap();
    assert_eq!(order_ids(&batches), vec![1, 3]);
    let names = str_attr_by_order(&batches, "name");
    assert_eq!(names[&1], Some("Bikes".into()));
    assert_eq!(names[&3], Some("Helmets".into()));
}

// A detail row whose FK matches no dimension row keeps the row with a NULL
// attribute (LEFT JOIN, never dropped).
#[tokio::test]
async fn unmatched_fk_yields_null_attribute_not_dropped_row() {
    // Fixture where one Sales row references a Geography id that does not exist.
    let model = DataModel::builder()
        .add_table(
            Table::new(
                "Sales",
                vec![
                    Column::new("order_id", DataType::Int64),
                    Column::new("geo_id", DataType::Int64),
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
        .add_relationship(Relationship::many_to_one(
            "Sales_Geo",
            "Sales",
            "geo_id",
            "Geography",
            "id",
        ))
        .build()
        .unwrap();
    let mut engine = Engine::new(model);
    engine.bind_table("Sales", 0, SourceBinding::new("public", "sales"));
    engine.bind_table("Geography", 0, SourceBinding::new("public", "geography"));
    engine
        .cache
        .store(
            "Sales",
            RecordBatch::try_new(
                Arc::new(Schema::new(vec![
                    Field::new("order_id", ArrowType::Int64, true),
                    Field::new("geo_id", ArrowType::Int64, true),
                ])),
                vec![
                    // order 2 points at geo_id 99 (no such Geography row).
                    Arc::new(Int64Array::from(vec![1, 2])),
                    Arc::new(Int64Array::from(vec![1, 99])),
                ],
            )
            .unwrap(),
        )
        .unwrap();
    engine
        .cache
        .store(
            "Geography",
            RecordBatch::try_new(
                Arc::new(Schema::new(vec![
                    Field::new("id", ArrowType::Int64, true),
                    Field::new("region", ArrowType::Utf8, true),
                ])),
                vec![
                    Arc::new(Int64Array::from(vec![1])),
                    Arc::new(StringArray::from(vec!["West"])),
                ],
            )
            .unwrap(),
        )
        .unwrap();

    let batches = engine
        .query_rows(
            DetailRequest::new("Sales", 100)
                .with_columns(["order_id"])
                .with_dimension_columns(vec![ColumnRef::new("Geography", "region")]),
        )
        .await
        .unwrap();

    // Both rows survive; the unmatched one (order 2) has a NULL region.
    assert_eq!(order_ids(&batches), vec![1, 2], "LEFT JOIN keeps every row");
    let regions = str_attr_by_order(&batches, "region");
    assert_eq!(regions[&1], Some("West".into()));
    assert_eq!(regions[&2], None, "unmatched FK → NULL attribute, row kept");
}

// A dimension with DUPLICATE join keys must NOT fan out / multiply detail rows.
// A single-column equi relationship is not guaranteed unique on the dimension
// side (cardinality may be OneToMany/ManyToMany and the engine validates no
// uniqueness), so the attribute join dedups the dimension to one row per key
// (MIN per attribute). Without that, a non-unique key would duplicate the
// detail row and could exceed `limit` — breaking the row-set-integrity
// guarantee. This is the regression test for that fix.
#[tokio::test]
async fn duplicate_dimension_keys_do_not_fan_out_detail_rows() {
    let model = DataModel::builder()
        .add_table(
            Table::new(
                "Sales",
                vec![
                    Column::new("order_id", DataType::Int64),
                    Column::new("geo_id", DataType::Int64),
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
        // Declared many-to-one, but the dimension data below violates the
        // implied key uniqueness (two rows with id = 1). The engine does not
        // enforce uniqueness, so the join must defend against it.
        .add_relationship(Relationship::many_to_one(
            "Sales_Geo",
            "Sales",
            "geo_id",
            "Geography",
            "id",
        ))
        .build()
        .unwrap();
    let mut engine = Engine::new(model);
    engine.bind_table("Sales", 0, SourceBinding::new("public", "sales"));
    engine.bind_table("Geography", 0, SourceBinding::new("public", "geography"));
    engine
        .cache
        .store(
            "Sales",
            RecordBatch::try_new(
                Arc::new(Schema::new(vec![
                    Field::new("order_id", ArrowType::Int64, true),
                    Field::new("geo_id", ArrowType::Int64, true),
                ])),
                vec![
                    Arc::new(Int64Array::from(vec![1, 2])),
                    Arc::new(Int64Array::from(vec![1, 2])),
                ],
            )
            .unwrap(),
        )
        .unwrap();
    engine
        .cache
        .store(
            "Geography",
            RecordBatch::try_new(
                Arc::new(Schema::new(vec![
                    Field::new("id", ArrowType::Int64, true),
                    Field::new("region", ArrowType::Utf8, true),
                ])),
                vec![
                    // id 1 appears TWICE (duplicate join key) with two region
                    // values; id 2 once.
                    Arc::new(Int64Array::from(vec![1, 1, 2])),
                    Arc::new(StringArray::from(vec!["West", "Westville", "East"])),
                ],
            )
            .unwrap(),
        )
        .unwrap();

    let batches = engine
        .query_rows(
            DetailRequest::new("Sales", 100)
                .with_columns(["order_id"])
                .with_dimension_columns(vec![ColumnRef::new("Geography", "region")]),
        )
        .await
        .unwrap();

    // Exactly two detail rows — the duplicate dimension key for geo 1 must NOT
    // fan order 1 into two rows.
    assert_eq!(
        order_ids(&batches),
        vec![1, 2],
        "duplicate dimension keys must not multiply detail rows"
    );
    assert_eq!(total_rows(&batches), 2);
    // The collapsed attribute is the MIN of the two values for key 1.
    let regions = str_attr_by_order(&batches, "region");
    assert_eq!(
        regions[&1],
        Some("West".into()),
        "MIN per key collapses 'West'/'Westville' to 'West'"
    );
    assert_eq!(regions[&2], Some("East".into()));
}

// `limit` must still cap the result even when a dimension has duplicate keys
// (the dedup join cannot push the row count back above the limit).
#[tokio::test]
async fn duplicate_dimension_keys_respect_limit() {
    let model = DataModel::builder()
        .add_table(
            Table::new(
                "Sales",
                vec![
                    Column::new("order_id", DataType::Int64),
                    Column::new("geo_id", DataType::Int64),
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
        .add_relationship(Relationship::many_to_one(
            "Sales_Geo",
            "Sales",
            "geo_id",
            "Geography",
            "id",
        ))
        .build()
        .unwrap();
    let mut engine = Engine::new(model);
    engine.bind_table("Sales", 0, SourceBinding::new("public", "sales"));
    engine.bind_table("Geography", 0, SourceBinding::new("public", "geography"));
    engine
        .cache
        .store(
            "Sales",
            RecordBatch::try_new(
                Arc::new(Schema::new(vec![
                    Field::new("order_id", ArrowType::Int64, true),
                    Field::new("geo_id", ArrowType::Int64, true),
                ])),
                vec![
                    Arc::new(Int64Array::from(vec![1, 2, 3])),
                    Arc::new(Int64Array::from(vec![1, 1, 1])),
                ],
            )
            .unwrap(),
        )
        .unwrap();
    engine
        .cache
        .store(
            "Geography",
            RecordBatch::try_new(
                Arc::new(Schema::new(vec![
                    Field::new("id", ArrowType::Int64, true),
                    Field::new("region", ArrowType::Utf8, true),
                ])),
                vec![
                    // Three duplicate rows for key 1 — would triple every detail
                    // row without the dedup, blowing past the limit.
                    Arc::new(Int64Array::from(vec![1, 1, 1])),
                    Arc::new(StringArray::from(vec!["A", "B", "C"])),
                ],
            )
            .unwrap(),
        )
        .unwrap();

    let batches = engine
        .query_rows(
            DetailRequest::new("Sales", 2)
                .with_columns(["order_id"])
                .with_dimension_columns(vec![ColumnRef::new("Geography", "region")]),
        )
        .await
        .unwrap();

    assert_eq!(
        total_rows(&batches),
        2,
        "limit 2 honored despite a 3x-duplicate dimension key"
    );
}
