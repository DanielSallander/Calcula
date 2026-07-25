//! End-to-end pipeline tests for hierarchy group-by execution: one test per
//! [`RaggedBehavior`] over a small ragged geography fixture, stopper-value
//! normalization, ROLLUP composition, and the typed errors for unsupported
//! query shapes.

use arrow::array::{Array, Float64Array, Int32Array, StringArray};
use arrow::compute::concat_batches;
use arrow::datatypes::{DataType, Field, Schema};
use arrow::record_batch::RecordBatch;
use std::sync::Arc;

use engine_core::compute::measure::sum_measure;
use engine_core::model::column::Column;
use engine_core::model::table::{StorageMode, Table};
use engine_core::model::{DataModel, Hierarchy, HierarchyLevel, RaggedBehavior};
use engine_core::store::InMemoryCache;
use engine_core::types::DataType as EngineDataType;

use super::QueryExecutor;
use crate::error::{QueryError, QueryResult};
use crate::planner::PushdownPlanner;
use crate::registry::{SourceBinding, SourceRegistry};
use crate::request::{HierarchyGroupBy, QueryRequest, TotalsMode, GROUPING_ID_COLUMN};

/// Ragged geography rows: `(country, state, city, amount)`.
///
/// ```text
/// France   IDF    Paris     40
/// USA      WA     Seattle   10
/// USA      WA     Spokane   20
/// USA      NULL   DC        30   <- interior gap (state missing)
/// Vatican  NULL   NULL      50   <- branch stops at country
/// ```
const BASE_ROWS: &[(&str, Option<&str>, Option<&str>, f64)] = &[
    ("France", Some("IDF"), Some("Paris"), 40.0),
    ("USA", Some("WA"), Some("Seattle"), 10.0),
    ("USA", Some("WA"), Some("Spokane"), 20.0),
    ("USA", None, Some("DC"), 30.0),
    ("Vatican", None, None, 50.0),
];

/// In-memory single-table model with a 3-level `Geo` hierarchy
/// (country → state → city) using the given ragged behavior. `state_stopper`
/// adds a stopper value to the (optional) state level.
fn fixture(
    behavior: RaggedBehavior,
    state_stopper: Option<&str>,
    rows: &[(&str, Option<&str>, Option<&str>, f64)],
) -> (DataModel, InMemoryCache, SourceRegistry) {
    let table = Table::new(
        "fact_sales",
        vec![
            Column::new("country", EngineDataType::String),
            Column::new("state", EngineDataType::String),
            Column::new("city", EngineDataType::String),
            Column::new("amount", EngineDataType::Float64),
        ],
    )
    .unwrap()
    .with_storage_mode(StorageMode::InMemory);

    let mut state_level = HierarchyLevel::new("state").with_optional(true);
    if let Some(s) = state_stopper {
        state_level = state_level.with_stopper_value(s);
    }

    let model = DataModel::builder()
        .add_table(table)
        .add_measure(sum_measure("Total", "fact_sales", "amount"))
        .add_hierarchy(
            Hierarchy::new(
                "Geo",
                "fact_sales",
                vec![
                    HierarchyLevel::new("country"),
                    state_level,
                    HierarchyLevel::new("city"),
                ],
            )
            .with_ragged_behavior(behavior),
        )
        .build()
        .unwrap();

    let schema = Arc::new(Schema::new(vec![
        Field::new("country", DataType::Utf8, true),
        Field::new("state", DataType::Utf8, true),
        Field::new("city", DataType::Utf8, true),
        Field::new("amount", DataType::Float64, true),
    ]));
    let batch = RecordBatch::try_new(
        schema,
        vec![
            Arc::new(StringArray::from(
                rows.iter().map(|(c, _, _, _)| Some(*c)).collect::<Vec<_>>(),
            )),
            Arc::new(StringArray::from(
                rows.iter().map(|(_, s, _, _)| *s).collect::<Vec<_>>(),
            )),
            Arc::new(StringArray::from(
                rows.iter().map(|(_, _, c, _)| *c).collect::<Vec<_>>(),
            )),
            Arc::new(Float64Array::from(
                rows.iter().map(|(_, _, _, a)| *a).collect::<Vec<_>>(),
            )),
        ],
    )
    .unwrap();
    let mut cache = InMemoryCache::new();
    cache.store("fact_sales", batch).unwrap();

    // Bind the table so the planner accepts it; the in-memory cache serves
    // the data, so no connector is ever contacted.
    let mut registry = SourceRegistry::new();
    registry.bind("fact_sales", 0, SourceBinding::new("public", "fact_sales"));

    (model, cache, registry)
}

/// Plan + execute a hierarchy request against a fixture.
async fn run(
    behavior: RaggedBehavior,
    state_stopper: Option<&str>,
    rows: &[(&str, Option<&str>, Option<&str>, f64)],
    request: QueryRequest,
) -> QueryResult<Vec<RecordBatch>> {
    let (model, cache, registry) = fixture(behavior, state_stopper, rows);
    let plan = PushdownPlanner::plan(&request, &model, &registry, &[])?;
    QueryExecutor::execute(&plan, &model, &registry, Some(&cache), None, None, &[]).await
}

fn geo_request(depth: usize) -> QueryRequest {
    QueryRequest {
        measures: vec!["Total".into()],
        hierarchy_group_by: Some(HierarchyGroupBy::new("Geo", depth)),
        ..Default::default()
    }
}

type Row3 = (Option<String>, Option<String>, Option<String>, f64);

/// Extract `(country, state, city, Total)` rows in result order.
fn rows3(batches: &[RecordBatch]) -> Vec<Row3> {
    let combined = concat_batches(&batches[0].schema(), batches).unwrap();
    let col = |name: &str| -> Vec<Option<String>> {
        let idx = combined.schema().index_of(name).unwrap();
        let cast = arrow::compute::cast(combined.column(idx), &DataType::Utf8).unwrap();
        let arr = cast.as_any().downcast_ref::<StringArray>().unwrap();
        (0..arr.len())
            .map(|i| (!arr.is_null(i)).then(|| arr.value(i).to_string()))
            .collect()
    };
    let totals = {
        let idx = combined.schema().index_of("Total").unwrap();
        let arr = combined
            .column(idx)
            .as_any()
            .downcast_ref::<Float64Array>()
            .unwrap();
        (0..arr.len()).map(|i| arr.value(i)).collect::<Vec<_>>()
    };
    let (c, s, ci) = (col("country"), col("state"), col("city"));
    (0..totals.len())
        .map(|i| (c[i].clone(), s[i].clone(), ci[i].clone(), totals[i]))
        .collect()
}

fn row3(c: &str, s: Option<&str>, ci: Option<&str>, t: f64) -> Row3 {
    (
        Some(c.to_string()),
        s.map(str::to_string),
        ci.map(str::to_string),
        t,
    )
}

/// ShowBlanks: NULL level values appear as-is; default ordering covers the
/// appended level columns (country, state, city ascending, NULLs last).
#[tokio::test]
async fn show_blanks_returns_blank_levels_as_is() {
    let batches = run(RaggedBehavior::ShowBlanks, None, BASE_ROWS, geo_request(3))
        .await
        .unwrap();
    assert_eq!(
        rows3(&batches),
        vec![
            row3("France", Some("IDF"), Some("Paris"), 40.0),
            row3("USA", Some("WA"), Some("Seattle"), 10.0),
            row3("USA", Some("WA"), Some("Spokane"), 20.0),
            row3("USA", None, Some("DC"), 30.0),
            row3("Vatican", None, None, 50.0),
        ]
    );
}

/// HideMembers: rows blank at any included level are filtered from the
/// result (the incomplete branches disappear at this depth).
#[tokio::test]
async fn hide_members_filters_incomplete_branches() {
    let batches = run(RaggedBehavior::HideMembers, None, BASE_ROWS, geo_request(3))
        .await
        .unwrap();
    assert_eq!(
        rows3(&batches),
        vec![
            row3("France", Some("IDF"), Some("Paris"), 40.0),
            row3("USA", Some("WA"), Some("Seattle"), 10.0),
            row3("USA", Some("WA"), Some("Spokane"), 20.0),
        ]
    );
}

/// HideMembers at a shallower depth: only the included levels matter — DC
/// (NULL state) and Vatican (NULL state) disappear, complete branches stay.
#[tokio::test]
async fn hide_members_depth_two_checks_only_included_levels() {
    let batches = run(RaggedBehavior::HideMembers, None, BASE_ROWS, geo_request(2))
        .await
        .unwrap();
    let combined = concat_batches(&batches[0].schema(), &batches).unwrap();
    assert_eq!(combined.num_rows(), 2);
    let rows = rows3_depth2(&batches);
    assert_eq!(
        rows,
        vec![
            (Some("France".into()), Some("IDF".into()), 40.0),
            (Some("USA".into()), Some("WA".into()), 30.0),
        ]
    );
}

/// Extract `(country, state, Total)` rows in result order (depth-2 results).
fn rows3_depth2(batches: &[RecordBatch]) -> Vec<(Option<String>, Option<String>, f64)> {
    let combined = concat_batches(&batches[0].schema(), batches).unwrap();
    let col = |name: &str| -> Vec<Option<String>> {
        let idx = combined.schema().index_of(name).unwrap();
        let cast = arrow::compute::cast(combined.column(idx), &DataType::Utf8).unwrap();
        let arr = cast.as_any().downcast_ref::<StringArray>().unwrap();
        (0..arr.len())
            .map(|i| (!arr.is_null(i)).then(|| arr.value(i).to_string()))
            .collect()
    };
    let totals = {
        let idx = combined.schema().index_of("Total").unwrap();
        let arr = combined
            .column(idx)
            .as_any()
            .downcast_ref::<Float64Array>()
            .unwrap();
        (0..arr.len()).map(|i| arr.value(i)).collect::<Vec<_>>()
    };
    let (c, s) = (col("country"), col("state"));
    (0..totals.len())
        .map(|i| (c[i].clone(), s[i].clone(), totals[i]))
        .collect()
}

/// RepeatParent: blanks are filled with the nearest non-blank parent and
/// grouping happens on the filled values. The default ordering uses the
/// filled values too ("USA" < "WA" puts DC's branch before Washington's).
#[tokio::test]
async fn repeat_parent_fills_blanks_with_parent_values() {
    let batches = run(
        RaggedBehavior::RepeatParent,
        None,
        BASE_ROWS,
        geo_request(3),
    )
    .await
    .unwrap();
    assert_eq!(
        rows3(&batches),
        vec![
            row3("France", Some("IDF"), Some("Paris"), 40.0),
            row3("USA", Some("USA"), Some("DC"), 30.0),
            row3("USA", Some("WA"), Some("Seattle"), 10.0),
            row3("USA", Some("WA"), Some("Spokane"), 20.0),
            row3("Vatican", Some("Vatican"), Some("Vatican"), 50.0),
        ]
    );
}

/// ShowAsLeaf: interior gaps are filled like RepeatParent (DC's missing
/// state shows USA) but trailing blanks stay NULL (Vatican ends at the
/// country level — nothing is fabricated below its natural level).
#[tokio::test]
async fn show_as_leaf_fills_interior_keeps_trailing_blanks() {
    let batches = run(RaggedBehavior::ShowAsLeaf, None, BASE_ROWS, geo_request(3))
        .await
        .unwrap();
    assert_eq!(
        rows3(&batches),
        vec![
            row3("France", Some("IDF"), Some("Paris"), 40.0),
            row3("USA", Some("USA"), Some("DC"), 30.0),
            row3("USA", Some("WA"), Some("Seattle"), 10.0),
            row3("USA", Some("WA"), Some("Spokane"), 20.0),
            row3("Vatican", None, None, 50.0),
        ]
    );
}

/// Stopper values are NULL-equivalent under every behavior: a "#" state is
/// blanked by ShowBlanks and filled by RepeatParent.
#[tokio::test]
async fn stopper_value_is_treated_as_null_equivalent() {
    let rows: Vec<(&str, Option<&str>, Option<&str>, f64)> =
        vec![("Monaco", Some("#"), Some("Monte Carlo"), 60.0)];

    // ShowBlanks: the stopper cell surfaces as NULL.
    let batches = run(RaggedBehavior::ShowBlanks, Some("#"), &rows, geo_request(3))
        .await
        .unwrap();
    assert_eq!(
        rows3(&batches),
        vec![row3("Monaco", None, Some("Monte Carlo"), 60.0)]
    );

    // RepeatParent: the stopper cell is filled with the parent value.
    let batches = run(
        RaggedBehavior::RepeatParent,
        Some("#"),
        &rows,
        geo_request(3),
    )
    .await
    .unwrap();
    assert_eq!(
        rows3(&batches),
        vec![row3("Monaco", Some("Monaco"), Some("Monte Carlo"), 60.0)]
    );

    // HideMembers: the stopper row is hidden like a NULL.
    let batches = run(
        RaggedBehavior::HideMembers,
        Some("#"),
        &rows,
        geo_request(3),
    )
    .await
    .unwrap();
    let total_rows: usize = batches.iter().map(|b| b.num_rows()).sum();
    assert_eq!(total_rows, 0);
}

/// Sorted `(country, state, grouping_id, Total)` rows of a depth-2 rollup
/// result (sorting in the test makes tie-ordering between a NULL-state
/// detail row and its subtotal row deterministic).
fn rollup_rows(batches: &[RecordBatch]) -> Vec<(Option<String>, Option<String>, i32, f64)> {
    let combined = concat_batches(&batches[0].schema(), batches).unwrap();
    let col = |name: &str| -> Vec<Option<String>> {
        let idx = combined.schema().index_of(name).unwrap();
        let cast = arrow::compute::cast(combined.column(idx), &DataType::Utf8).unwrap();
        let arr = cast.as_any().downcast_ref::<StringArray>().unwrap();
        (0..arr.len())
            .map(|i| (!arr.is_null(i)).then(|| arr.value(i).to_string()))
            .collect()
    };
    let gids = {
        let idx = combined.schema().index_of(GROUPING_ID_COLUMN).unwrap();
        let arr = combined
            .column(idx)
            .as_any()
            .downcast_ref::<Int32Array>()
            .unwrap();
        (0..arr.len()).map(|i| arr.value(i)).collect::<Vec<_>>()
    };
    let totals = {
        let idx = combined.schema().index_of("Total").unwrap();
        let arr = combined
            .column(idx)
            .as_any()
            .downcast_ref::<Float64Array>()
            .unwrap();
        (0..arr.len()).map(|i| arr.value(i)).collect::<Vec<_>>()
    };
    let (c, s) = (col("country"), col("state"));
    let mut rows: Vec<_> = (0..totals.len())
        .map(|i| (c[i].clone(), s[i].clone(), gids[i], totals[i]))
        .collect();
    rows.sort_by(|a, b| (&a.0, &a.1, a.2).cmp(&(&b.0, &b.1, b.2)));
    rows
}

/// Hierarchy + ROLLUP compose: the levels become group-by columns, so the
/// rollup yields per-level drill subtotals with the standard
/// `__grouping_id` contract (bit 0 = country, bit 1 = state).
#[tokio::test]
async fn hierarchy_with_rollup_yields_drill_subtotals() {
    let request = QueryRequest {
        totals: TotalsMode::Rollup,
        ..geo_request(2)
    };
    let batches = run(RaggedBehavior::ShowBlanks, None, BASE_ROWS, request)
        .await
        .unwrap();

    let some = |s: &str| Some(s.to_string());
    assert_eq!(
        rollup_rows(&batches),
        vec![
            // Grand total (both levels rolled up).
            (None, None, 3, 150.0),
            // Per-country subtotals (state rolled up).
            (some("France"), None, 2, 40.0),
            (some("France"), some("IDF"), 0, 40.0),
            (some("USA"), None, 0, 30.0), // DC detail row (real NULL state).
            (some("USA"), None, 2, 60.0),
            (some("USA"), some("WA"), 0, 30.0),
            (some("Vatican"), None, 0, 50.0),
            (some("Vatican"), None, 2, 50.0),
        ]
    );
}

/// HideMembers + ROLLUP: blank detail rows are hidden, but subtotal rows
/// (whose NULLs mean "rolled up", not "blank member") survive — and they
/// still aggregate over all underlying data (hiding is presentation-only).
#[tokio::test]
async fn hide_members_with_rollup_keeps_subtotal_rows() {
    let request = QueryRequest {
        totals: TotalsMode::Rollup,
        ..geo_request(2)
    };
    let batches = run(RaggedBehavior::HideMembers, None, BASE_ROWS, request)
        .await
        .unwrap();

    let some = |s: &str| Some(s.to_string());
    assert_eq!(
        rollup_rows(&batches),
        vec![
            (None, None, 3, 150.0),
            (some("France"), None, 2, 40.0),
            (some("France"), some("IDF"), 0, 40.0),
            // USA's blank-state detail row (DC) is hidden; the subtotal
            // still counts it.
            (some("USA"), None, 2, 60.0),
            (some("USA"), some("WA"), 0, 30.0),
            // Vatican's only detail row is hidden, its subtotal remains.
            (some("Vatican"), None, 2, 50.0),
        ]
    );
}

/// RepeatParent + ROLLUP: grouping (and the rollup) happen on the filled
/// values — DC's branch contributes a (USA, USA) detail row.
#[tokio::test]
async fn repeat_parent_with_rollup_groups_on_filled_values() {
    let request = QueryRequest {
        totals: TotalsMode::Rollup,
        ..geo_request(2)
    };
    let batches = run(RaggedBehavior::RepeatParent, None, BASE_ROWS, request)
        .await
        .unwrap();

    let some = |s: &str| Some(s.to_string());
    assert_eq!(
        rollup_rows(&batches),
        vec![
            (None, None, 3, 150.0),
            (some("France"), None, 2, 40.0),
            (some("France"), some("IDF"), 0, 40.0),
            (some("USA"), None, 2, 60.0),
            (some("USA"), some("USA"), 0, 30.0),
            (some("USA"), some("WA"), 0, 30.0),
            (some("Vatican"), None, 2, 50.0),
            (some("Vatican"), some("Vatican"), 0, 50.0),
        ]
    );
}

/// HideMembers + LIMIT: the limit applies to the rows that survive the
/// post-aggregation filter, not to the pre-filter rows.
#[tokio::test]
async fn hide_members_limit_applies_after_filtering() {
    let request = QueryRequest {
        limit: Some(2),
        ..geo_request(3)
    };
    let batches = run(RaggedBehavior::HideMembers, None, BASE_ROWS, request)
        .await
        .unwrap();
    assert_eq!(
        rows3(&batches),
        vec![
            row3("France", Some("IDF"), Some("Paris"), 40.0),
            row3("USA", Some("WA"), Some("Seattle"), 10.0),
        ]
    );
}

/// Ragged transforms are not supported in the two-stage window-measure
/// path — a typed error, never silently-wrong results.
#[tokio::test]
async fn ragged_hierarchy_with_window_measure_errors_cleanly() {
    use engine_core::compute::aggregate::AggregateOp;
    use engine_core::compute::expression as expr;
    use engine_core::compute::measure::expression_measure;

    let (model, cache, registry) = fixture(RaggedBehavior::RepeatParent, None, BASE_ROWS);
    let model = {
        let mut builder = DataModel::builder();
        for table in model.tables() {
            builder = builder.add_table(table.clone());
        }
        for hierarchy in model.hierarchies() {
            builder = builder.add_hierarchy(hierarchy.clone());
        }
        builder
            .add_measure(expression_measure(
                "RunningTotal",
                expr::Expression::Window {
                    inner: Box::new(expr::agg(
                        AggregateOp::Sum,
                        expr::qualified_col("fact_sales", "amount"),
                    )),
                    function: AggregateOp::Sum,
                    order_by: vec![("fact_sales".into(), "country".into())],
                    partition_by: vec![],
                    frame: None,
                },
            ))
            .build()
            .unwrap()
    };

    let request = QueryRequest {
        measures: vec!["RunningTotal".into()],
        hierarchy_group_by: Some(HierarchyGroupBy::new("Geo", 2)),
        ..Default::default()
    };
    let plan = PushdownPlanner::plan(&request, &model, &registry, &[]).unwrap();
    let err = QueryExecutor::execute(&plan, &model, &registry, Some(&cache), None, None, &[])
        .await
        .unwrap_err();
    match err {
        QueryError::InvalidQuery(msg) => {
            assert!(
                msg.contains("hierarchy ragged behavior") && msg.contains("window measures"),
                "unexpected message: {msg}"
            );
        }
        other => panic!("expected InvalidQuery, got {other:?}"),
    }
}
