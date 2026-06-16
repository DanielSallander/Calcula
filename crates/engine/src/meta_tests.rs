//! End-to-end tests for the result-column metadata sidecar
//! (`Engine::query_with_meta`).

#![cfg(test)]

use std::sync::Arc;

use arrow::array::{Float64Array, Int64Array, StringArray};
use arrow::datatypes::{DataType as ArrowType, Field, Schema};
use arrow::record_batch::RecordBatch;

use crate::{
    sum_measure, Column, ColumnRef, DataModel, DataType, Engine, RankBy, ResultColumnKind,
    Relationship, SourceBinding, StorageMode, Table,
};

fn meta_model() -> DataModel {
    let in_mem = |t: Table| t.with_storage_mode(StorageMode::InMemory);
    DataModel::builder()
        .add_table(in_mem(
            Table::new(
                "Sales",
                vec![
                    Column::new("prod_id", DataType::Int64),
                    Column::new("amount", DataType::Float64),
                ],
            )
            .unwrap(),
        ))
        .add_table(in_mem(
            Table::new(
                "Product",
                vec![
                    Column::new("id", DataType::Int64),
                    Column::new("name", DataType::String).with_display_name("Product Name"),
                ],
            )
            .unwrap(),
        ))
        .add_relationship(Relationship::many_to_one(
            "Sales_Product",
            "Sales",
            "prod_id",
            "Product",
            "id",
        ))
        .add_measure(
            sum_measure("Revenue", "Sales", "amount")
                .with_format_string("#,##0.00")
                .with_description("Total sales revenue"),
        )
        .build()
        .unwrap()
}

fn meta_engine() -> Engine {
    let mut engine = Engine::new(meta_model());
    engine.bind_table("Sales", 0, SourceBinding::new("public", "sales"));
    engine.bind_table("Product", 0, SourceBinding::new("public", "product"));
    engine
        .cache
        .store(
            "Sales",
            RecordBatch::try_new(
                Arc::new(Schema::new(vec![
                    Field::new("prod_id", ArrowType::Int64, true),
                    Field::new("amount", ArrowType::Float64, true),
                ])),
                vec![
                    Arc::new(Int64Array::from(vec![1, 2])),
                    Arc::new(Float64Array::from(vec![100.0, 60.0])),
                ],
            )
            .unwrap(),
        )
        .unwrap();
    engine
        .cache
        .store(
            "Product",
            RecordBatch::try_new(
                Arc::new(Schema::new(vec![
                    Field::new("id", ArrowType::Int64, true),
                    Field::new("name", ArrowType::Utf8, true),
                ])),
                vec![
                    Arc::new(Int64Array::from(vec![1, 2])),
                    Arc::new(StringArray::from(vec!["Bikes", "Helmets"])),
                ],
            )
            .unwrap(),
        )
        .unwrap();
    engine
}

#[tokio::test]
async fn metadata_classifies_dimension_and_measure_columns() {
    let engine = meta_engine();
    let (_, meta) = engine
        .query_with_meta(QueryRequest_for(&["Revenue"], &[("Product", "name")]))
        .await
        .unwrap();

    let name = meta.iter().find(|c| c.name == "name").expect("name column");
    assert_eq!(name.kind, ResultColumnKind::Dimension);
    assert_eq!(name.source_table.as_deref(), Some("Product"));
    assert_eq!(name.source_column.as_deref(), Some("name"));
    assert_eq!(name.display_name.as_deref(), Some("Product Name"));
    // Grouped string dimensions arrive dictionary-encoded; metadata reports the
    // underlying String type.
    assert_eq!(name.data_type, Some(DataType::String));

    let revenue = meta
        .iter()
        .find(|c| c.name == "Revenue")
        .expect("Revenue column");
    assert_eq!(revenue.kind, ResultColumnKind::Measure);
    assert_eq!(revenue.measure.as_deref(), Some("Revenue"));
    assert_eq!(revenue.format_string.as_deref(), Some("#,##0.00"));
    assert_eq!(revenue.description.as_deref(), Some("Total sales revenue"));
}

#[tokio::test]
async fn metadata_marks_the_rank_column() {
    let engine = meta_engine();
    let mut req = QueryRequest_for(&["Revenue"], &[("Product", "name")]);
    req.rank_by = Some(RankBy::new("Revenue", "Revenue Rank"));
    let (_, meta) = engine.query_with_meta(req).await.unwrap();

    let rank = meta
        .iter()
        .find(|c| c.name == "Revenue Rank")
        .expect("rank column present");
    assert_eq!(rank.kind, ResultColumnKind::Rank);
    assert_eq!(rank.data_type, Some(DataType::Int64));
}

#[tokio::test]
async fn metadata_marks_a_kpi_base_measure() {
    use crate::{Kpi, KpiTarget};
    let in_mem = |t: Table| t.with_storage_mode(StorageMode::InMemory);
    let model = DataModel::builder()
        .add_table(in_mem(
            Table::new(
                "Sales",
                vec![
                    Column::new("prod_id", DataType::Int64),
                    Column::new("amount", DataType::Float64),
                ],
            )
            .unwrap(),
        ))
        .add_table(in_mem(
            Table::new(
                "Product",
                vec![
                    Column::new("id", DataType::Int64),
                    Column::new("name", DataType::String),
                ],
            )
            .unwrap(),
        ))
        .add_relationship(Relationship::many_to_one(
            "Sales_Product",
            "Sales",
            "prod_id",
            "Product",
            "id",
        ))
        .add_measure(sum_measure("Revenue", "Sales", "amount"))
        .add_measure(sum_measure("Cost", "Sales", "amount"))
        .add_kpi(Kpi::new("Revenue Goal", "Revenue", KpiTarget::Constant(1000.0)))
        .build()
        .unwrap();
    let mut engine = Engine::new(model);
    engine.bind_table("Sales", 0, SourceBinding::new("public", "sales"));
    engine.bind_table("Product", 0, SourceBinding::new("public", "product"));
    engine
        .cache
        .store(
            "Sales",
            RecordBatch::try_new(
                Arc::new(Schema::new(vec![
                    Field::new("prod_id", ArrowType::Int64, true),
                    Field::new("amount", ArrowType::Float64, true),
                ])),
                vec![
                    Arc::new(Int64Array::from(vec![1, 2])),
                    Arc::new(Float64Array::from(vec![100.0, 60.0])),
                ],
            )
            .unwrap(),
        )
        .unwrap();
    engine
        .cache
        .store(
            "Product",
            RecordBatch::try_new(
                Arc::new(Schema::new(vec![
                    Field::new("id", ArrowType::Int64, true),
                    Field::new("name", ArrowType::Utf8, true),
                ])),
                vec![
                    Arc::new(Int64Array::from(vec![1, 2])),
                    Arc::new(StringArray::from(vec!["A", "B"])),
                ],
            )
            .unwrap(),
        )
        .unwrap();

    let (_, meta) = engine
        .query_with_meta(QueryRequest_for(
            &["Revenue", "Cost"],
            &[("Product", "name")],
        ))
        .await
        .unwrap();
    let revenue = meta.iter().find(|c| c.name == "Revenue").unwrap();
    assert_eq!(revenue.kpi_name.as_deref(), Some("Revenue Goal"));
    let cost = meta.iter().find(|c| c.name == "Cost").unwrap();
    assert_eq!(cost.kpi_name, None, "a non-KPI measure has no kpi_name");
}

#[tokio::test]
async fn metadata_does_not_misclassify_dimension_colliding_with_a_measure_name() {
    // A dimension column `tier` and a measure `Tier` (case-insensitive match).
    // The dimension must stay a Dimension with its source attribution — not be
    // tagged a Measure and given the measure's numeric format string.
    let in_mem = |t: Table| t.with_storage_mode(StorageMode::InMemory);
    let model = DataModel::builder()
        .add_table(in_mem(
            Table::new(
                "Sales",
                vec![
                    Column::new("prod_id", DataType::Int64),
                    Column::new("amount", DataType::Float64),
                ],
            )
            .unwrap(),
        ))
        .add_table(in_mem(
            Table::new(
                "Product",
                vec![
                    Column::new("id", DataType::Int64),
                    Column::new("tier", DataType::String),
                ],
            )
            .unwrap(),
        ))
        .add_relationship(Relationship::many_to_one(
            "Sales_Product",
            "Sales",
            "prod_id",
            "Product",
            "id",
        ))
        .add_measure(sum_measure("Tier", "Sales", "amount").with_format_string("#,##0.00"))
        .build()
        .unwrap();
    let mut engine = Engine::new(model);
    engine.bind_table("Sales", 0, SourceBinding::new("public", "sales"));
    engine.bind_table("Product", 0, SourceBinding::new("public", "product"));
    engine
        .cache
        .store(
            "Sales",
            RecordBatch::try_new(
                Arc::new(Schema::new(vec![
                    Field::new("prod_id", ArrowType::Int64, true),
                    Field::new("amount", ArrowType::Float64, true),
                ])),
                vec![
                    Arc::new(Int64Array::from(vec![1, 2])),
                    Arc::new(Float64Array::from(vec![100.0, 60.0])),
                ],
            )
            .unwrap(),
        )
        .unwrap();
    engine
        .cache
        .store(
            "Product",
            RecordBatch::try_new(
                Arc::new(Schema::new(vec![
                    Field::new("id", ArrowType::Int64, true),
                    Field::new("tier", ArrowType::Utf8, true),
                ])),
                vec![
                    Arc::new(Int64Array::from(vec![1, 2])),
                    Arc::new(StringArray::from(vec!["Gold", "Silver"])),
                ],
            )
            .unwrap(),
        )
        .unwrap();

    let (_, meta) = engine
        .query_with_meta(QueryRequest_for(&["Tier"], &[("Product", "tier")]))
        .await
        .unwrap();

    let tier_dim = meta
        .iter()
        .find(|c| c.name.eq_ignore_ascii_case("tier") && c.kind == ResultColumnKind::Dimension)
        .expect("the `tier` dimension column is classified as a Dimension");
    assert_eq!(tier_dim.source_table.as_deref(), Some("Product"));
    assert_eq!(tier_dim.source_column.as_deref(), Some("tier"));
    assert!(
        tier_dim.format_string.is_none(),
        "a dimension must not inherit the measure's format string"
    );

    let tier_measure = meta
        .iter()
        .find(|c| c.name == "Tier" && c.kind == ResultColumnKind::Measure)
        .expect("the `Tier` measure column is classified as a Measure");
    assert_eq!(tier_measure.measure.as_deref(), Some("Tier"));
    assert_eq!(tier_measure.format_string.as_deref(), Some("#,##0.00"));
}

#[test]
fn validate_measure_text_accepts_valid_and_rejects_bad() {
    let engine = meta_engine();
    // Valid: references the existing measure.
    assert!(engine.validate_measure_text("Double", "[Revenue] * 2").is_ok());
    assert!(engine
        .validate_measure_text("More", "SUM(Sales[amount])")
        .is_ok());
    // Unknown qualified column.
    assert!(engine
        .validate_measure_text("Bad", "SUM(Sales[nope])")
        .is_err());
    // Syntax error (unbalanced).
    assert!(engine.validate_measure_text("Syntax", "SUM(").is_err());
    // Unregistered UDF call.
    assert!(engine
        .validate_measure_text("Udf", "no_such_udf(Sales[amount])")
        .is_err());
}

// Local helper to build a request (named oddly to avoid clashing with the
// re-exported QueryRequest type while keeping the call sites terse).
#[allow(non_snake_case)]
fn QueryRequest_for(measures: &[&str], group_by: &[(&str, &str)]) -> crate::QueryRequest {
    crate::QueryRequest {
        measures: measures.iter().map(|s| s.to_string()).collect(),
        group_by: group_by
            .iter()
            .map(|(t, c)| ColumnRef::new(*t, *c))
            .collect(),
        ..Default::default()
    }
}
