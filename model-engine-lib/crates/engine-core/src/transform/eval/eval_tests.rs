//! Evaluating each step over real batches, including nulls.
//!
//! Schema derivation is tested separately and purely; these tests are about
//! the other half of the contract — that the rows a step produces are the
//! rows it promised, and that the batch it returns actually matches the
//! schema derivation said it would.

use std::sync::Arc;

use arrow::array::{
    Array, ArrayRef, BooleanArray, Date32Array, Float64Array, Int64Array, StringArray,
};
use arrow::datatypes::{DataType as ArrowType, Field, Schema};
use arrow::record_batch::RecordBatch;

use crate::compute::aggregate::AggregateOp;
use crate::compute::udf::UdfRegistry;
use crate::error::EngineResult;
use crate::model::Column;
use crate::transform::eval::{apply_steps, conform_to_declared};
use crate::transform::parts::{
    CastErrorPolicy, ColumnRename, GroupAggregate, RowRange, SortKey, TextOp, TypeChange,
};
use crate::transform::schema::derive_pipeline_schema;
use crate::transform::{schemas_match, TransformStep};
use crate::types::DataType;

/// The model schema of [`sales_batch`].
fn sales_columns() -> Vec<Column> {
    vec![
        Column::new("id", DataType::Int64),
        Column::new("region", DataType::String),
        Column::new("status", DataType::String),
        Column::new("amount", DataType::Float64),
        Column::new("cost", DataType::Float64),
        Column::new("order_date", DataType::Date),
    ]
}

/// Five orders across two regions, with a null region and a null amount so
/// every step meets the null case.
fn sales_batch() -> RecordBatch {
    let schema = Arc::new(Schema::new(vec![
        Field::new("id", ArrowType::Int64, true),
        Field::new("region", ArrowType::Utf8, true),
        Field::new("status", ArrowType::Utf8, true),
        Field::new("amount", ArrowType::Float64, true),
        Field::new("cost", ArrowType::Float64, true),
        Field::new("order_date", ArrowType::Date32, true),
    ]));
    let columns: Vec<ArrayRef> = vec![
        Arc::new(Int64Array::from(vec![1, 2, 3, 4, 5])),
        Arc::new(StringArray::from(vec![
            Some("north"),
            None,
            Some("south"),
            Some("north"),
            Some("south"),
        ])),
        Arc::new(StringArray::from(vec![
            "open",
            "cancelled",
            "open",
            "  open  ",
            "closed",
        ])),
        Arc::new(Float64Array::from(vec![
            Some(100.0),
            Some(50.0),
            Some(200.0),
            None,
            Some(75.0),
        ])),
        Arc::new(Float64Array::from(vec![40.0, 20.0, 120.0, 10.0, 25.0])),
        Arc::new(Date32Array::from(vec![20000, 20001, 20002, 20003, 20004])),
    ];
    RecordBatch::try_new(schema, columns).unwrap()
}

/// Run a pipeline over [`sales_batch`] and return the result.
async fn run(steps: &[TransformStep]) -> EngineResult<RecordBatch> {
    apply_steps(
        "Sales",
        sales_batch(),
        &sales_columns(),
        steps,
        steps.len(),
        &UdfRegistry::new(),
    )
    .await
}

/// Run a pipeline and assert the batch matches the schema derivation promised
/// — the invariant the whole design rests on.
async fn run_checked(steps: &[TransformStep]) -> RecordBatch {
    let derived = derive_pipeline_schema("Sales", &sales_columns(), steps).unwrap();
    let batch = run(steps).await.unwrap();
    let conformed = conform_to_declared("Sales", steps.len(), &batch, &derived)
        .unwrap_or_else(|e| panic!("pipeline output does not conform to its derived schema: {e}"));
    assert_eq!(
        conformed.num_columns(),
        derived.len(),
        "column count disagrees with derivation"
    );
    for (index, column) in derived.iter().enumerate() {
        assert_eq!(
            conformed.schema().field(index).name(),
            column.name(),
            "column {index} name disagrees with derivation"
        );
    }
    conformed
}

/// Read a string column as owned options.
fn strings(batch: &RecordBatch, name: &str) -> Vec<Option<String>> {
    let index = batch.schema().index_of(name).unwrap();
    let array = batch
        .column(index)
        .as_any()
        .downcast_ref::<StringArray>()
        .expect("string column");
    (0..array.len())
        .map(|i| {
            if array.is_null(i) {
                None
            } else {
                Some(array.value(i).to_string())
            }
        })
        .collect()
}

/// Read a float column.
fn floats(batch: &RecordBatch, name: &str) -> Vec<Option<f64>> {
    let index = batch.schema().index_of(name).unwrap();
    let array = batch
        .column(index)
        .as_any()
        .downcast_ref::<Float64Array>()
        .expect("float column");
    (0..array.len())
        .map(|i| {
            if array.is_null(i) {
                None
            } else {
                Some(array.value(i))
            }
        })
        .collect()
}

/// Read an integer column.
fn ints(batch: &RecordBatch, name: &str) -> Vec<Option<i64>> {
    let index = batch.schema().index_of(name).unwrap();
    let array = batch
        .column(index)
        .as_any()
        .downcast_ref::<Int64Array>()
        .expect("int column");
    (0..array.len())
        .map(|i| {
            if array.is_null(i) {
                None
            } else {
                Some(array.value(i))
            }
        })
        .collect()
}

// --- Column-shaping steps ---

#[tokio::test]
async fn remove_and_select_project_the_expected_columns() {
    let batch = run_checked(&[TransformStep::RemoveColumns {
        columns: vec!["cost".into(), "order_date".into()],
    }])
    .await;
    assert_eq!(batch.num_columns(), 4);
    assert_eq!(batch.num_rows(), 5);

    let batch = run_checked(&[TransformStep::SelectColumns {
        columns: vec!["amount".into(), "id".into()],
    }])
    .await;
    assert_eq!(batch.schema().field(0).name(), "amount");
    assert_eq!(batch.schema().field(1).name(), "id");
}

#[tokio::test]
async fn rename_moves_the_name_and_leaves_the_values() {
    let batch = run_checked(&[TransformStep::RenameColumns {
        renames: vec![ColumnRename::new("amount", "net")],
    }])
    .await;
    assert_eq!(
        floats(&batch, "net"),
        vec![Some(100.0), Some(50.0), Some(200.0), None, Some(75.0)]
    );
}

#[tokio::test]
async fn change_type_casts_values() {
    let batch = run_checked(&[TransformStep::ChangeType {
        changes: vec![TypeChange::new("cost", DataType::Int64)],
        on_error: CastErrorPolicy::Fail,
    }])
    .await;
    assert_eq!(
        ints(&batch, "cost"),
        vec![Some(40), Some(20), Some(120), Some(10), Some(25)]
    );
}

#[tokio::test]
async fn a_failing_cast_stops_the_refresh_by_default() {
    // "open" is not a number. The default policy must refuse rather than
    // quietly turn every status into null.
    let error = run(&[TransformStep::ChangeType {
        changes: vec![TypeChange::new("status", DataType::Int64)],
        on_error: CastErrorPolicy::Fail,
    }])
    .await
    .unwrap_err();
    let message = error.to_string();
    assert!(message.contains("status"), "got {message}");
    assert!(message.contains("step 0"), "must name the step: {message}");
}

#[tokio::test]
async fn the_null_policy_turns_unconvertible_values_into_nulls() {
    let batch = run_checked(&[TransformStep::ChangeType {
        changes: vec![TypeChange::new("status", DataType::Int64)],
        on_error: CastErrorPolicy::Null,
    }])
    .await;
    assert_eq!(ints(&batch, "status"), vec![None, None, None, None, None]);
}

#[tokio::test]
async fn add_column_computes_per_row_and_propagates_nulls() {
    let batch = run_checked(&[TransformStep::AddColumn {
        name: "margin".into(),
        expression: "amount - cost".into(),
        data_type: None,
    }])
    .await;
    assert_eq!(
        floats(&batch, "margin"),
        // Row 4's amount is null, so its margin is null — Arrow's own
        // semantics, not a substituted zero.
        vec![Some(60.0), Some(30.0), Some(80.0), None, Some(50.0)]
    );
}

#[tokio::test]
async fn add_column_can_use_a_conditional() {
    let batch = run_checked(&[TransformStep::AddColumn {
        name: "band".into(),
        expression: "IF(amount >= 100, \"large\", \"small\")".into(),
        data_type: Some(DataType::String),
    }])
    .await;
    let bands = strings(&batch, "band");
    assert_eq!(bands[0], Some("large".into()));
    assert_eq!(bands[1], Some("small".into()));
}

#[tokio::test]
async fn transform_column_rewrites_in_place_and_keeps_its_position() {
    // The formula surface's headline: reshape a column rather than append one.
    let batch = run_checked(&[TransformStep::TransformColumn {
        column: "status".into(),
        expression: "UPPER([status])".into(),
        data_type: None,
    }])
    .await;
    let schema = batch.schema();
    let fields: Vec<&str> = schema.fields().iter().map(|f| f.name().as_str()).collect();
    assert!(
        fields.contains(&"status"),
        "the column is rewritten, not replaced by a new one: {fields:?}"
    );
    let values = strings(&batch, "status");
    for value in values.iter().flatten() {
        assert_eq!(
            value,
            &value.to_uppercase(),
            "every non-null value went through the formula"
        );
    }
}

#[tokio::test]
async fn transform_column_reads_the_pre_step_value() {
    // `[amount]` on the right-hand side is the value BEFORE this step, because
    // SQL evaluates a select list against the input row. The alternative
    // reading — that it sees its own output — would make the step meaningless.
    let batch = run_checked(&[TransformStep::TransformColumn {
        column: "amount".into(),
        expression: "[amount] * 2".into(),
        data_type: None,
    }])
    .await;
    let doubled = floats(&batch, "amount");
    let original = floats(&run_checked(&[]).await, "amount");
    for (a, b) in doubled.iter().zip(original.iter()) {
        match (a, b) {
            (Some(a), Some(b)) => assert!((a - b * 2.0).abs() < 1e-9, "{a} != 2 * {b}"),
            (None, None) => {}
            other => panic!("null mismatch: {other:?}"),
        }
    }
}

#[tokio::test]
async fn two_transform_column_steps_on_one_column_compose() {
    // Each step sees the previous step's OUTPUT — the ordinary pipeline
    // semantics — while the expression inside one step sees its own input.
    let batch = run_checked(&[
        TransformStep::TransformColumn {
            column: "amount".into(),
            expression: "[amount] * 2".into(),
            data_type: None,
        },
        TransformStep::TransformColumn {
            column: "amount".into(),
            expression: "[amount] + 1".into(),
            data_type: None,
        },
    ])
    .await;
    let result = floats(&batch, "amount");
    let original = floats(&run_checked(&[]).await, "amount");
    for (a, b) in result.iter().zip(original.iter()) {
        match (a, b) {
            (Some(a), Some(b)) => assert!((a - (b * 2.0 + 1.0)).abs() < 1e-9, "{a}"),
            (None, None) => {}
            other => panic!("null mismatch: {other:?}"),
        }
    }
}

#[tokio::test]
async fn a_bracketed_column_evaluates_the_same_as_a_bare_one() {
    // Bracket resolution must reach the REFRESH path, not only validation. It
    // would otherwise pass model build and fail at refresh as a measure
    // reference — validated on one path, broken on the other.
    let bracketed = run_checked(&[TransformStep::AddColumn {
        name: "m1".into(),
        expression: "[amount] - [cost]".into(),
        data_type: None,
    }])
    .await;
    let bare = run_checked(&[TransformStep::AddColumn {
        name: "m2".into(),
        expression: "amount - cost".into(),
        data_type: None,
    }])
    .await;
    assert_eq!(floats(&bracketed, "m1"), floats(&bare, "m2"));
}

#[tokio::test]
async fn a_declared_type_is_cast_mid_pipeline_so_a_later_step_agrees() {
    // `conform_to_declared` runs ONCE, after the whole pipeline. So without a
    // cast here the batch and the derived schema disagree from this step on,
    // and the NEXT step type-checks against derivation. The text step after it
    // is what makes this test non-vacuous.
    let batch = run_checked(&[
        TransformStep::TransformColumn {
            column: "amount".into(),
            // The declared type does the conversion: the expression is
            // numeric, the column becomes text.
            expression: "[amount]".into(),
            data_type: Some(DataType::String),
        },
        TransformStep::TextTransform {
            columns: vec!["amount".into()],
            operation: TextOp::Trim,
        },
    ])
    .await;
    assert_eq!(
        batch
            .schema()
            .field_with_name("amount")
            .unwrap()
            .data_type(),
        &arrow::datatypes::DataType::Utf8,
        "the declared type reached the batch, so the text step could run"
    );
}

#[tokio::test]
async fn split_column_splits_and_nulls_absent_parts() {
    let batch = run_checked(&[TransformStep::SplitColumn {
        column: "status".into(),
        delimiter: " ".into(),
        parts: 2,
        keep_original: false,
    }])
    .await;
    // "cancelled" has no delimiter, so its second part is absent -> null.
    assert_eq!(strings(&batch, "status.1")[1], Some("cancelled".into()));
    assert_eq!(strings(&batch, "status.2")[1], None);
}

#[tokio::test]
async fn text_transform_trims_in_place() {
    let batch = run_checked(&[TransformStep::TextTransform {
        columns: vec!["status".into()],
        operation: TextOp::Trim,
    }])
    .await;
    // Row 4 was "  open  ".
    assert_eq!(strings(&batch, "status")[3], Some("open".into()));
    // Column order is preserved by the in-place rewrite.
    assert_eq!(batch.schema().field(2).name(), "status");
}

#[tokio::test]
async fn text_transform_upper_leaves_nulls_null() {
    let batch = run_checked(&[TransformStep::TextTransform {
        columns: vec!["region".into()],
        operation: TextOp::Upper,
    }])
    .await;
    let regions = strings(&batch, "region");
    assert_eq!(regions[0], Some("NORTH".into()));
    assert_eq!(regions[1], None, "upper(NULL) must stay NULL");
}

#[tokio::test]
async fn replace_values_rewrites_whole_values_and_substrings() {
    let batch = run_checked(&[TransformStep::ReplaceValues {
        column: "status".into(),
        find: "cancelled".into(),
        replace: "void".into(),
        match_entire_value: true,
    }])
    .await;
    assert_eq!(strings(&batch, "status")[1], Some("void".into()));

    let batch = run_checked(&[TransformStep::ReplaceValues {
        column: "region".into(),
        find: "th".into(),
        replace: "TH".into(),
        match_entire_value: false,
    }])
    .await;
    assert_eq!(strings(&batch, "region")[0], Some("norTH".into()));
}

#[tokio::test]
async fn whole_value_replace_works_on_a_numeric_column() {
    let batch = run_checked(&[TransformStep::ReplaceValues {
        column: "cost".into(),
        find: "40".into(),
        replace: "45".into(),
        match_entire_value: true,
    }])
    .await;
    assert_eq!(floats(&batch, "cost")[0], Some(45.0));
}

#[tokio::test]
async fn fill_down_carries_the_last_non_null_value() {
    let batch = run_checked(&[TransformStep::FillDown {
        columns: vec!["region".into()],
    }])
    .await;
    assert_eq!(
        strings(&batch, "region"),
        vec![
            Some("north".into()),
            // Row 2's null takes row 1's value.
            Some("north".into()),
            Some("south".into()),
            Some("north".into()),
            Some("south".into()),
        ]
    );
}

#[tokio::test]
async fn fill_down_leaves_a_leading_null_null() {
    // There is nothing above the first row to carry down; inventing a value
    // would be worse than leaving the gap.
    let schema = Arc::new(Schema::new(vec![Field::new("v", ArrowType::Utf8, true)]));
    let batch = RecordBatch::try_new(
        schema,
        vec![Arc::new(StringArray::from(vec![None, Some("a"), None])) as ArrayRef],
    )
    .unwrap();
    let columns = vec![Column::new("v", DataType::String)];
    let out = apply_steps(
        "T",
        batch,
        &columns,
        &[TransformStep::FillDown {
            columns: vec!["v".into()],
        }],
        1,
        &UdfRegistry::new(),
    )
    .await
    .unwrap();
    assert_eq!(
        strings(&out, "v"),
        vec![None, Some("a".into()), Some("a".into())]
    );
}

// --- Row-shaping steps ---

#[tokio::test]
async fn filter_rows_keeps_matching_rows() {
    let batch = run_checked(&[TransformStep::FilterRows {
        condition: "status <> \"cancelled\"".into(),
    }])
    .await;
    assert_eq!(batch.num_rows(), 4);
    assert!(!strings(&batch, "status").contains(&Some("cancelled".into())));
}

#[tokio::test]
async fn filter_rows_drops_rows_whose_condition_is_null() {
    // SQL WHERE semantics: a null comparison is not true, so the row goes.
    // Row 2's region is null.
    let batch = run_checked(&[TransformStep::FilterRows {
        condition: "region = \"north\"".into(),
    }])
    .await;
    assert_eq!(batch.num_rows(), 2);
    assert_eq!(ints(&batch, "id"), vec![Some(1), Some(4)]);
}

#[tokio::test]
async fn sort_orders_rows_and_puts_nulls_last() {
    let batch = run_checked(&[TransformStep::Sort {
        by: vec![SortKey::descending("amount")],
    }])
    .await;
    assert_eq!(
        floats(&batch, "amount"),
        vec![Some(200.0), Some(100.0), Some(75.0), Some(50.0), None]
    );
}

#[tokio::test]
async fn sort_ascending_also_puts_nulls_last() {
    let batch = run_checked(&[TransformStep::Sort {
        by: vec![SortKey::ascending("amount")],
    }])
    .await;
    assert_eq!(
        floats(&batch, "amount"),
        vec![Some(50.0), Some(75.0), Some(100.0), Some(200.0), None]
    );
}

#[tokio::test]
async fn remove_duplicates_keeps_the_first_occurrence() {
    // Regions repeat: north(id 1), null(2), south(3), north(4), south(5).
    // First-wins must keep ids 1, 2, 3.
    let batch = run_checked(&[TransformStep::RemoveDuplicates {
        columns: vec!["region".into()],
    }])
    .await;
    assert_eq!(ints(&batch, "id"), vec![Some(1), Some(2), Some(3)]);
}

#[tokio::test]
async fn remove_duplicates_over_every_column_keeps_all_distinct_rows() {
    let batch = run_checked(&[TransformStep::RemoveDuplicates { columns: vec![] }]).await;
    assert_eq!(batch.num_rows(), 5);
}

#[tokio::test]
async fn keep_and_remove_rows_slice_the_right_range() {
    let batch = run_checked(&[TransformStep::KeepRows {
        range: RowRange::FirstN { count: 2 },
    }])
    .await;
    assert_eq!(ints(&batch, "id"), vec![Some(1), Some(2)]);

    let batch = run_checked(&[TransformStep::RemoveRows {
        range: RowRange::FirstN { count: 2 },
    }])
    .await;
    assert_eq!(ints(&batch, "id"), vec![Some(3), Some(4), Some(5)]);

    let batch = run_checked(&[TransformStep::RemoveRows {
        range: RowRange::Range {
            offset: 1,
            count: 2,
        },
    }])
    .await;
    assert_eq!(ints(&batch, "id"), vec![Some(1), Some(4), Some(5)]);

    let batch = run_checked(&[TransformStep::KeepRows {
        range: RowRange::LastN { count: 2 },
    }])
    .await;
    assert_eq!(ints(&batch, "id"), vec![Some(4), Some(5)]);
}

#[tokio::test]
async fn group_by_aggregates_within_groups() {
    let batch = run_checked(&[
        TransformStep::FilterRows {
            condition: "region = \"north\"".into(),
        },
        TransformStep::GroupBy {
            group_by: vec!["region".into()],
            aggregates: vec![
                GroupAggregate::new("amount", AggregateOp::Sum, "total"),
                GroupAggregate::count_rows("orders"),
            ],
        },
    ])
    .await;
    assert_eq!(batch.num_rows(), 1);
    assert_eq!(strings(&batch, "region"), vec![Some("north".into())]);
    // Rows 1 and 4 are north; row 4's amount is null and SUM skips it.
    assert_eq!(floats(&batch, "total"), vec![Some(100.0)]);
    assert_eq!(ints(&batch, "orders"), vec![Some(2)]);
}

#[tokio::test]
async fn group_by_with_no_keys_aggregates_the_whole_table() {
    let batch = run_checked(&[TransformStep::GroupBy {
        group_by: vec![],
        aggregates: vec![GroupAggregate::count_rows("orders")],
    }])
    .await;
    assert_eq!(batch.num_rows(), 1);
    assert_eq!(ints(&batch, "orders"), vec![Some(5)]);
}

#[tokio::test]
async fn formula_aggregates_compute_the_sumif_family() {
    // The SUMIF / AVERAGEIF / COUNTIF idioms, in one step. The batch's
    // statuses are ["open","cancelled","open","  open  ","closed"] with
    // amounts [100, 50, 200, null, 75] — so status = "open" matches rows 0
    // and 2 exactly (the padded "  open  " is a different value).
    //
    // The column aggregate sits BETWEEN formula aggregates on purpose: the
    // output column order is the aggregate-vector order, whichever kind each
    // entry is, and run_checked asserts the batch against derivation.
    let batch = run_checked(&[TransformStep::GroupBy {
        group_by: vec![],
        aggregates: vec![
            GroupAggregate::formula(
                AggregateOp::Sum,
                "open_total",
                "IF([status] = \"open\", [amount], BLANK())",
            ),
            GroupAggregate::new("amount", AggregateOp::Sum, "total"),
            GroupAggregate::formula(
                AggregateOp::Average,
                "open_avg",
                "IF([status] = \"open\", [amount], BLANK())",
            ),
            GroupAggregate::count_rows("rows"),
            GroupAggregate::formula(
                AggregateOp::Count,
                "big_orders",
                "IF([amount] > 80, 1, BLANK())",
            ),
        ],
    }])
    .await;
    assert_eq!(batch.num_rows(), 1);
    assert_eq!(floats(&batch, "open_total"), vec![Some(300.0)]);
    assert_eq!(floats(&batch, "total"), vec![Some(425.0)]);
    assert_eq!(floats(&batch, "open_avg"), vec![Some(150.0)]);
    assert_eq!(ints(&batch, "rows"), vec![Some(5)]);
    // amounts over 80: 100 and 200. The null amount makes the condition null,
    // which lands in the blank branch — not counted, not an error.
    assert_eq!(ints(&batch, "big_orders"), vec![Some(2)]);
}

#[tokio::test]
async fn a_formula_aggregate_median_over_integers_computes_in_double() {
    // ids are 1..5; id > 1 keeps {2,3,4,5}, an even count whose true median is
    // 3.5. The DOUBLE cast on the FORMULA operand is what makes this 3.5:
    // DataFusion's median over an integer operand returns an integer, and the
    // terminal conform would then cast 3 to 3.0 — plausible and wrong. The
    // cast decision runs off the formula's INFERRED type, because there is no
    // column name to look one up by.
    let batch = run_checked(&[TransformStep::GroupBy {
        group_by: vec![],
        aggregates: vec![GroupAggregate::formula(
            AggregateOp::Median,
            "mid",
            "IF([id] > 1, [id], BLANK())",
        )],
    }])
    .await;
    assert_eq!(floats(&batch, "mid"), vec![Some(3.5)]);
}

#[tokio::test]
async fn formula_aggregates_group_per_key_like_column_ones() {
    // Per-group evaluation, not whole-table: the formula is computed on each
    // row and aggregated within its row's group.
    let batch = run_checked(&[
        // Pin group order so the row assertions are deterministic.
        TransformStep::GroupBy {
            group_by: vec!["status".into()],
            aggregates: vec![GroupAggregate::formula(
                AggregateOp::Sum,
                "big_total",
                "IF([amount] >= 100, [amount], BLANK())",
            )],
        },
        TransformStep::Sort {
            by: vec![SortKey::ascending("status")],
        },
    ])
    .await;
    // Groups sorted: "  open  " (null amount), "cancelled" (50), "closed"
    // (75), "open" (100 + 200). Only "open" has amounts >= 100.
    assert_eq!(
        strings(&batch, "status"),
        vec![
            Some("  open  ".into()),
            Some("cancelled".into()),
            Some("closed".into()),
            Some("open".into()),
        ]
    );
    assert_eq!(
        floats(&batch, "big_total"),
        vec![None, None, None, Some(300.0)]
    );
}

#[tokio::test]
async fn unpivot_produces_one_row_per_value() {
    let batch = run_checked(&[
        TransformStep::SelectColumns {
            columns: vec!["id".into(), "amount".into(), "cost".into()],
        },
        TransformStep::Unpivot {
            columns: vec!["amount".into(), "cost".into()],
            name_column: "measure".into(),
            value_column: "value".into(),
        },
    ])
    .await;

    assert_eq!(batch.num_rows(), 10, "5 rows x 2 unpivoted columns");
    assert_eq!(
        ints(&batch, "id"),
        vec![
            Some(1),
            Some(1),
            Some(2),
            Some(2),
            Some(3),
            Some(3),
            Some(4),
            Some(4),
            Some(5),
            Some(5)
        ]
    );
    assert_eq!(
        strings(&batch, "measure")[..4].to_vec(),
        vec![
            Some("amount".into()),
            Some("cost".into()),
            Some("amount".into()),
            Some("cost".into())
        ]
    );
    let values = floats(&batch, "value");
    assert_eq!(values[0], Some(100.0));
    assert_eq!(values[1], Some(40.0));
    // Row 4's amount is null and must survive the reshape as null.
    assert_eq!(values[6], None);
    assert_eq!(values[7], Some(10.0));
}

#[tokio::test]
async fn pivot_turns_declared_values_into_columns() {
    let batch = run_checked(&[
        TransformStep::SelectColumns {
            columns: vec!["region".into(), "status".into(), "amount".into()],
        },
        TransformStep::Pivot {
            name_column: "status".into(),
            value_column: "amount".into(),
            aggregate: AggregateOp::Sum,
            value_names: vec!["open".into(), "closed".into()],
        },
    ])
    .await;

    let regions = strings(&batch, "region");
    let open = floats(&batch, "open");
    let closed = floats(&batch, "closed");
    let south = regions
        .iter()
        .position(|r| r.as_deref() == Some("south"))
        .unwrap();
    assert_eq!(open[south], Some(200.0));
    assert_eq!(closed[south], Some(75.0));

    let north = regions
        .iter()
        .position(|r| r.as_deref() == Some("north"))
        .unwrap();
    assert_eq!(open[north], Some(100.0));
    // North has no closed order — an absent combination is null, not zero.
    assert_eq!(closed[north], None);
}

// --- Pipelines, previews, and conformance ---

#[tokio::test]
async fn a_multi_step_pipeline_applies_in_order() {
    let steps = vec![
        TransformStep::FilterRows {
            condition: "status <> \"cancelled\"".into(),
        },
        TransformStep::AddColumn {
            name: "margin".into(),
            expression: "amount - cost".into(),
            data_type: Some(DataType::Float64),
        },
        TransformStep::RenameColumns {
            renames: vec![ColumnRename::new("amount", "net")],
        },
        TransformStep::SelectColumns {
            columns: vec!["id".into(), "net".into(), "margin".into()],
        },
    ];
    let batch = run_checked(&steps).await;
    assert_eq!(batch.num_rows(), 4);
    assert_eq!(
        batch
            .schema()
            .fields()
            .iter()
            .map(|f| f.name().as_str())
            .collect::<Vec<_>>(),
        vec!["id", "net", "margin"]
    );
    assert_eq!(floats(&batch, "margin")[0], Some(60.0));
}

#[tokio::test]
async fn upto_reproduces_the_pipeline_as_of_a_step() {
    // The preview contract: running the first N steps gives exactly what the
    // step list shows at position N.
    let steps = vec![
        TransformStep::FilterRows {
            condition: "status <> \"cancelled\"".into(),
        },
        TransformStep::RemoveColumns {
            columns: vec!["cost".into()],
        },
    ];

    let as_of_source = apply_steps(
        "Sales",
        sales_batch(),
        &sales_columns(),
        &steps,
        0,
        &UdfRegistry::new(),
    )
    .await
    .unwrap();
    assert_eq!(as_of_source.num_rows(), 5, "no steps applied");
    assert_eq!(as_of_source.num_columns(), 6);

    let as_of_first = apply_steps(
        "Sales",
        sales_batch(),
        &sales_columns(),
        &steps,
        1,
        &UdfRegistry::new(),
    )
    .await
    .unwrap();
    assert_eq!(as_of_first.num_rows(), 4, "filter applied");
    assert_eq!(as_of_first.num_columns(), 6, "removal not yet applied");
}

#[tokio::test]
async fn upto_beyond_the_pipeline_is_clamped() {
    let steps = vec![TransformStep::RemoveColumns {
        columns: vec!["cost".into()],
    }];
    let batch = apply_steps(
        "Sales",
        sales_batch(),
        &sales_columns(),
        &steps,
        99,
        &UdfRegistry::new(),
    )
    .await
    .unwrap();
    assert_eq!(batch.num_columns(), 5);
}

#[tokio::test]
async fn an_empty_pipeline_returns_the_batch_untouched() {
    let batch = run(&[]).await.unwrap();
    assert_eq!(batch.num_rows(), 5);
    assert_eq!(batch.num_columns(), 6);
}

#[tokio::test]
async fn every_step_produces_the_schema_derivation_promised() {
    // The load-bearing invariant, checked across the whole catalog rather
    // than one step at a time: if evaluation and derivation ever disagree,
    // a refresh writes a batch the model cannot describe.
    let catalog = crate::transform::test_support::one_of_every_step();
    let mut covered = 0usize;
    for step in &catalog {
        let steps = [step.clone()];
        let derived = match derive_pipeline_schema("Sales", &sales_columns(), &steps) {
            Ok(derived) => derived,
            // A step this fixture's schema cannot accept is derivation's
            // business, not evaluation's.
            Err(_) => continue,
        };
        covered += 1;
        let batch = run(&steps)
            .await
            .unwrap_or_else(|e| panic!("evaluating {} failed: {e}", step.type_name()));

        let produced: Vec<String> = batch
            .schema()
            .fields()
            .iter()
            .map(|f| f.name().clone())
            .collect();
        let expected: Vec<String> = derived.iter().map(|c| c.name().to_string()).collect();
        assert_eq!(
            produced,
            expected,
            "step {} produced different columns than derivation promised",
            step.type_name()
        );
        conform_to_declared("Sales", 0, &batch, &derived).unwrap_or_else(|e| {
            panic!(
                "step {} does not conform to its derived schema: {e}",
                step.type_name()
            )
        });
    }
    // Without this the loop could `continue` past every step and still pass,
    // reporting green while covering nothing.
    assert_eq!(
        covered,
        catalog.len(),
        "only {covered} of {} steps were actually exercised",
        catalog.len()
    );
}

#[tokio::test]
async fn conform_reports_a_column_the_pipeline_did_not_produce() {
    // The source-drift case: the model expects a column the data lacks.
    let batch = sales_batch();
    let mut declared = sales_columns();
    declared.push(Column::new("surcharge", DataType::Float64));
    let error = conform_to_declared("Sales", 0, &batch, &declared).unwrap_err();
    let message = error.to_string();
    assert!(message.contains("surcharge"), "got {message}");
    assert!(
        message.contains("source schema"),
        "must say how to fix it: {message}"
    );
}

#[tokio::test]
async fn conform_casts_a_widened_result_back_to_the_declared_type() {
    let schema = Arc::new(Schema::new(vec![Field::new("n", ArrowType::Int64, false)]));
    let batch = RecordBatch::try_new(
        schema,
        vec![Arc::new(Int64Array::from(vec![1_i64, 2, 3])) as ArrayRef],
    )
    .unwrap();
    let declared = vec![Column::non_nullable("n", DataType::Float64)];
    let conformed = conform_to_declared("T", 0, &batch, &declared).unwrap();
    assert_eq!(conformed.schema().field(0).data_type(), &ArrowType::Float64);
}

#[tokio::test]
async fn conform_widens_nullability_rather_than_producing_an_invalid_batch() {
    // A declared non-nullable column whose data carries nulls must not be
    // stamped non-nullable — that batch would be structurally invalid.
    let schema = Arc::new(Schema::new(vec![Field::new("n", ArrowType::Int64, true)]));
    let batch = RecordBatch::try_new(
        schema,
        vec![Arc::new(Int64Array::from(vec![Some(1_i64), None])) as ArrayRef],
    )
    .unwrap();
    let declared = vec![Column::non_nullable("n", DataType::Int64)];
    let conformed = conform_to_declared("T", 0, &batch, &declared).unwrap();
    assert!(conformed.schema().field(0).is_nullable());
}

#[tokio::test]
async fn a_boolean_flag_column_can_be_added() {
    // `addColumn` may compute a condition, which is why the evaluator parses
    // with the condition grammar rather than the measure-expression grammar.
    let steps = [TransformStep::AddColumn {
        name: "is_open".into(),
        expression: "status = \"open\"".into(),
        data_type: Some(DataType::Boolean),
    }];
    let batch = run_checked(&steps).await;
    let index = batch.schema().index_of("is_open").unwrap();
    let flags = batch
        .column(index)
        .as_any()
        .downcast_ref::<BooleanArray>()
        .expect("boolean column");
    assert!(flags.value(0));
    assert!(!flags.value(1));
}

#[tokio::test]
async fn an_empty_input_batch_survives_every_step() {
    // A source that returns no rows must not turn into a crash or a batch
    // with no columns.
    let empty = RecordBatch::new_empty(sales_batch().schema());
    let catalog = crate::transform::test_support::one_of_every_step();
    let mut covered = 0usize;
    for step in &catalog {
        let steps = [step.clone()];
        let Ok(derived) = derive_pipeline_schema("Sales", &sales_columns(), &steps) else {
            continue;
        };
        covered += 1;
        let batch = apply_steps(
            "Sales",
            empty.clone(),
            &sales_columns(),
            &steps,
            1,
            &UdfRegistry::new(),
        )
        .await
        .unwrap_or_else(|e| panic!("step {} failed on an empty batch: {e}", step.type_name()));
        assert_eq!(
            batch.num_columns(),
            derived.len(),
            "step {} lost its columns on an empty batch",
            step.type_name()
        );
    }
    assert_eq!(
        covered,
        catalog.len(),
        "only {covered} of {} steps were actually exercised",
        catalog.len()
    );
}

#[tokio::test]
async fn identifiers_and_literals_carrying_quotes_are_not_injectable() {
    // Column names and step literals come from model files, which are shared
    // between users. A name that closes a quoted identifier must be escaped,
    // not executed.
    let schema = Arc::new(Schema::new(vec![
        Field::new("ev\"il", ArrowType::Utf8, true),
        Field::new("v", ArrowType::Int64, true),
    ]));
    let batch = RecordBatch::try_new(
        schema,
        vec![
            Arc::new(StringArray::from(vec!["a'; DROP TABLE t; --", "b"])) as ArrayRef,
            Arc::new(Int64Array::from(vec![1_i64, 2])) as ArrayRef,
        ],
    )
    .unwrap();
    let columns = vec![
        Column::new("ev\"il", DataType::String),
        Column::new("v", DataType::Int64),
    ];

    let steps = [TransformStep::ReplaceValues {
        column: "ev\"il".into(),
        find: "a'; DROP TABLE t; --".into(),
        replace: "safe".into(),
        match_entire_value: true,
    }];
    let out = apply_steps("T", batch, &columns, &steps, 1, &UdfRegistry::new())
        .await
        .unwrap();
    assert_eq!(
        strings(&out, "ev\"il"),
        vec![Some("safe".into()), Some("b".into())]
    );
}

#[tokio::test]
async fn a_step_failure_names_the_step_that_failed() {
    let steps = vec![
        TransformStep::RemoveColumns {
            columns: vec!["cost".into()],
        },
        TransformStep::ChangeType {
            changes: vec![TypeChange::new("status", DataType::Int64)],
            on_error: CastErrorPolicy::Fail,
        },
    ];
    let error = run(&steps).await.unwrap_err();
    match error {
        crate::error::EngineError::TransformFailed { step_index, .. } => {
            assert_eq!(step_index, 1)
        }
        other => panic!("expected TransformFailed, got {other:?}"),
    }
}

#[tokio::test]
async fn derived_and_declared_schemas_agree_for_a_realistic_pipeline() {
    let steps = vec![
        TransformStep::FilterRows {
            condition: "status <> \"cancelled\"".into(),
        },
        TransformStep::TextTransform {
            columns: vec!["status".into()],
            operation: TextOp::Trim,
        },
        TransformStep::FillDown {
            columns: vec!["region".into()],
        },
        TransformStep::AddColumn {
            name: "margin".into(),
            expression: "amount - cost".into(),
            data_type: Some(DataType::Float64),
        },
        TransformStep::GroupBy {
            group_by: vec!["region".into()],
            aggregates: vec![
                GroupAggregate::new("margin", AggregateOp::Sum, "total_margin"),
                GroupAggregate::count_rows("orders"),
            ],
        },
        TransformStep::Sort {
            by: vec![SortKey::ascending("region")],
        },
    ];
    let derived = derive_pipeline_schema("Sales", &sales_columns(), &steps).unwrap();
    let batch = run(&steps).await.unwrap();
    let conformed = conform_to_declared("Sales", steps.len(), &batch, &derived).unwrap();

    let as_columns: Vec<Column> = conformed
        .schema()
        .fields()
        .iter()
        .map(|f| {
            let data_type = derived
                .iter()
                .find(|c| c.name() == f.name())
                .unwrap()
                .data_type()
                .clone();
            Column::new(f.name(), data_type).with_nullable(f.is_nullable())
        })
        .collect();
    assert!(
        schemas_match(&derived, &as_columns)
            || derived
                .iter()
                .zip(&as_columns)
                .all(|(a, b)| a.name() == b.name() && a.data_type() == b.data_type()),
        "derived {derived:?} vs produced {as_columns:?}"
    );
    assert_eq!(conformed.num_rows(), 2, "north and south");
}

// --- Regressions for the adversarial review -------------------------------

/// Build a one-column batch plus its model schema, for the narrow numeric
/// regressions below.
fn numeric_fixture(name: &str, values: Vec<f64>) -> (RecordBatch, Vec<Column>) {
    let schema = Arc::new(Schema::new(vec![
        Field::new("g", ArrowType::Utf8, true),
        Field::new(name, ArrowType::Float64, true),
    ]));
    let groups: Vec<&str> = values.iter().map(|_| "g1").collect();
    let batch = RecordBatch::try_new(
        schema,
        vec![
            Arc::new(StringArray::from(groups)) as ArrayRef,
            Arc::new(Float64Array::from(values)) as ArrayRef,
        ],
    )
    .unwrap();
    let columns = vec![
        Column::new("g", DataType::String),
        Column::new(name, DataType::Float64),
    ];
    (batch, columns)
}

#[tokio::test]
async fn pivot_with_count_rows_counts_each_value_not_the_whole_group() {
    // REGRESSION: `render_sql` discards its operand for CountRows and emits a
    // bare COUNT(*), so every pivoted column used to receive the group's TOTAL
    // row count. Plausible numbers, no error — the worst kind of wrong.
    let steps = [
        TransformStep::SelectColumns {
            columns: vec!["region".into(), "status".into(), "amount".into()],
        },
        TransformStep::Pivot {
            name_column: "status".into(),
            value_column: "amount".into(),
            aggregate: AggregateOp::CountRows,
            value_names: vec!["open".into(), "closed".into()],
        },
    ];
    let batch = run_checked(&steps).await;

    let regions = strings(&batch, "region");
    let open = ints(&batch, "open");
    let closed = ints(&batch, "closed");

    let south = regions
        .iter()
        .position(|r| r.as_deref() == Some("south"))
        .unwrap();
    assert_eq!(open[south], Some(1), "south has exactly one open row");
    assert_eq!(closed[south], Some(1), "south has exactly one closed row");

    let north = regions
        .iter()
        .position(|r| r.as_deref() == Some("north"))
        .unwrap();
    assert_eq!(open[north], Some(1), "north has one exactly-'open' row");
    assert_eq!(
        closed[north], None,
        "north has no closed row — an absent combination is blank, not the group size"
    );
}

#[tokio::test]
async fn change_type_refuses_to_round_under_the_failing_policy() {
    // REGRESSION: arrow's `safe: false` converts float->int through NumCast,
    // which TRUNCATES toward zero and errors only on NaN/overflow. 10.7 became
    // 10 with no complaint, under the one policy whose contract is to stop.
    let (batch, columns) = numeric_fixture("v", vec![10.7, 2.0]);
    let steps = [TransformStep::ChangeType {
        changes: vec![TypeChange::new("v", DataType::Int64)],
        on_error: CastErrorPolicy::Fail,
    }];
    let error = apply_steps("T", batch, &columns, &steps, 1, &UdfRegistry::new())
        .await
        .unwrap_err();
    let message = error.to_string();
    assert!(message.contains('v'), "must name the column: {message}");
    assert!(message.contains("rounding"), "must say why: {message}");
}

#[tokio::test]
async fn change_type_blanks_unroundable_values_under_the_null_policy() {
    // The other half of the contract: "cannot be represented" becomes blank.
    let (batch, columns) = numeric_fixture("v", vec![10.7, 2.0]);
    let steps = [TransformStep::ChangeType {
        changes: vec![TypeChange::new("v", DataType::Int64)],
        on_error: CastErrorPolicy::Null,
    }];
    let out = apply_steps("T", batch, &columns, &steps, 1, &UdfRegistry::new())
        .await
        .unwrap();
    assert_eq!(
        ints(&out, "v"),
        vec![None, Some(2)],
        "10.7 is not a whole number; 2.0 exactly is"
    );
}

#[tokio::test]
async fn an_exact_float_to_int_cast_still_succeeds() {
    // The guard must not turn a legitimate, lossless cast into an error.
    let (batch, columns) = numeric_fixture("v", vec![10.0, -3.0, 0.0]);
    let steps = [TransformStep::ChangeType {
        changes: vec![TypeChange::new("v", DataType::Int64)],
        on_error: CastErrorPolicy::Fail,
    }];
    let out = apply_steps("T", batch, &columns, &steps, 1, &UdfRegistry::new())
        .await
        .unwrap();
    assert_eq!(ints(&out, "v"), vec![Some(10), Some(-3), Some(0)]);
}

#[tokio::test]
async fn median_over_integers_is_not_truncated_by_integer_arithmetic() {
    // REGRESSION: DataFusion's `median` returns its INPUT type and averages the
    // two middle values with that type's arithmetic, so the median of 1 and 2
    // over Int64 came back 1 — and the terminal cast to the derived Float64
    // made the wrong number look deliberate.
    let schema = Arc::new(Schema::new(vec![
        Field::new("g", ArrowType::Utf8, true),
        Field::new("n", ArrowType::Int64, true),
    ]));
    let batch = RecordBatch::try_new(
        schema,
        vec![
            Arc::new(StringArray::from(vec!["g1", "g1"])) as ArrayRef,
            Arc::new(Int64Array::from(vec![1_i64, 2])) as ArrayRef,
        ],
    )
    .unwrap();
    let columns = vec![
        Column::new("g", DataType::String),
        Column::new("n", DataType::Int64),
    ];
    let steps = [TransformStep::GroupBy {
        group_by: vec!["g".into()],
        aggregates: vec![GroupAggregate::new("n", AggregateOp::Median, "mid")],
    }];
    let out = apply_steps("T", batch, &columns, &steps, 1, &UdfRegistry::new())
        .await
        .unwrap();
    assert_eq!(
        floats(&out, "mid"),
        vec![Some(1.5)],
        "the median of 1 and 2 is 1.5, and the column was DERIVED as Float64"
    );
}

#[tokio::test]
async fn whole_value_replace_on_a_numeric_column_rewrites_only_that_value() {
    // The positive control for the typed-literal rendering: the numeric branch
    // must still work now that it renders a parsed value instead of raw text.
    let (batch, columns) = numeric_fixture("v", vec![1.0, 2.0]);
    let steps = [TransformStep::ReplaceValues {
        column: "v".into(),
        find: "1".into(),
        replace: "9".into(),
        match_entire_value: true,
    }];
    let out = apply_steps("T", batch, &columns, &steps, 1, &UdfRegistry::new())
        .await
        .unwrap();
    assert_eq!(floats(&out, "v"), vec![Some(9.0), Some(2.0)]);
}
