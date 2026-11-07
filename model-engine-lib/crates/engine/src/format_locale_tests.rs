//! DAX `FORMAT` residuals of BUG-0522 (BUG-0731, ledger programme 2), end
//! to end through the engine:
//!
//! - the 3-argument `FORMAT(value, format_string, locale_name)` formats in
//!   the culture the name names (the parser accepted the argument and the SQL
//!   DROPPED it, so every FORMAT wrote the engine's own culture);
//! - a context-driven calculated column holding FORMAT is never pushed into a
//!   source GROUP BY: FORMAT is the engine's own UDF `calcula_format`, which
//!   PostgreSQL does not have.
//!
//! Fixture: `Sales(prod_id, amount)` -> `Product(id, name)`; Bikes' amounts
//! total 130, Helmets' 60.

#![cfg(test)]

use std::collections::HashMap;
use std::sync::Arc;

use arrow::array::{Array, DictionaryArray, Float64Array, Int64Array, StringArray};
use arrow::datatypes::{DataType as ArrowType, Field, Int32Type, Schema};
use arrow::record_batch::RecordBatch;

use crate::{
    expression_measure, parse_measure, parse_measure_expression, sum_measure, CancellationToken,
    Column, ColumnRef, ContextColumn, DataModel, DataType, Engine, FormatCulture, QueryRequest,
    Relationship, SourceBinding, StorageMode, Table,
};

fn engine() -> Engine {
    let measure = |name: &str, formula: &str| {
        expression_measure(name, parse_measure(formula).unwrap_or_else(|e| panic!("{name}: {e}")))
    };
    let model = DataModel::builder()
        .add_table(
            Table::new(
                "Sales",
                vec![Column::new("prod_id", DataType::Int64), Column::new("amount", DataType::Float64)],
            )
            .unwrap()
            .with_storage_mode(StorageMode::InMemory),
        )
        .add_table(
            Table::new(
                "Product",
                vec![Column::new("id", DataType::Int64), Column::new("name", DataType::String)],
            )
            .unwrap()
            .with_storage_mode(StorageMode::InMemory),
        )
        .add_relationship(Relationship::many_to_one("Sales_Product", "Sales", "prod_id", "Product", "id"))
        .add_measure(measure("Own", "FORMAT(SUM(Sales[amount]) * -10, \"Currency\")"))
        .add_measure(measure("InGerman", "FORMAT(SUM(Sales[amount]) * -10, \"Currency\", \"de-DE\")"))
        .add_measure(measure("InEnglish", "FORMAT(SUM(Sales[amount]) * -10, \"Currency\", \"en-US\")"))
        .add_measure(measure("InBritish", "FORMAT(SUM(Sales[amount]) * -10, \"Currency\", \"en-GB\")"))
        .add_measure(measure("InNowhere", "FORMAT(SUM(Sales[amount]), \"0\", \"xx-YY\")"))
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
                    Arc::new(Int64Array::from(vec![1, 1, 2])),
                    Arc::new(Float64Array::from(vec![100.0, 30.0, 60.0])),
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

/// One measure grouped by `Product[name]`, as text.
async fn by_product(engine: &Engine, measure: &str) -> Result<HashMap<String, String>, String> {
    let batches = engine
        .query(QueryRequest {
            measures: vec![measure.into()],
            group_by: vec![ColumnRef::new("Product", "name")],
            ..Default::default()
        })
        .await
        .map_err(|e| e.to_string())?;
    let mut out = HashMap::new();
    for b in &batches {
        let g = b.column(b.schema().index_of("name").unwrap());
        let m = arrow::compute::cast(b.column(b.schema().index_of(measure).unwrap()), &ArrowType::Utf8)
            .unwrap();
        let m = m.as_any().downcast_ref::<StringArray>().unwrap().clone();
        for row in 0..b.num_rows() {
            let key = if let Some(a) = g.as_any().downcast_ref::<StringArray>() {
                a.value(row).to_string()
            } else if let Some(a) = g.as_any().downcast_ref::<DictionaryArray<Int32Type>>() {
                let values = a.values().as_any().downcast_ref::<StringArray>().unwrap();
                values.value(a.key(row).unwrap()).to_string()
            } else {
                panic!("unexpected group array type: {:?}", g.data_type());
            };
            out.insert(key, m.value(row).to_string());
        }
    }
    Ok(out)
}

#[tokio::test]
async fn the_third_argument_of_format_names_the_culture() {
    let mut engine = engine();
    engine.set_format_culture(FormatCulture::sv_se());
    // The engine's own culture, then the cultures a name names.
    assert_eq!(by_product(&engine, "Own").await.unwrap()["Bikes"], "-1\u{a0}300,00 kr");
    assert_eq!(by_product(&engine, "InGerman").await.unwrap()["Bikes"], "-1.300,00 \u{20ac}");
    assert_eq!(by_product(&engine, "InEnglish").await.unwrap()["Helmets"], "($600.00)");
    // A name no culture answers to fails the query -- also en-GB, until the
    // host names it.
    let err = by_product(&engine, "InNowhere").await.unwrap_err();
    assert!(err.contains("xx-YY"), "{err}");
    let err = by_product(&engine, "InBritish").await.unwrap_err();
    assert!(err.contains("en-GB"), "{err}");
    engine.set_named_format_cultures(vec![FormatCulture {
        name: "en-GB".into(),
        currency_symbol: "\u{a3}".into(),
        currency_negative_parentheses: false,
        ..FormatCulture::en_us()
    }]);
    assert_eq!(by_product(&engine, "InBritish").await.unwrap()["Bikes"], "-\u{a3}1,300.00");
    // The engine's own culture moving does not move a named one.
    engine.set_format_culture(FormatCulture::en_us());
    assert_eq!(by_product(&engine, "Own").await.unwrap()["Bikes"], "($1,300.00)");
    assert_eq!(by_product(&engine, "InGerman").await.unwrap()["Bikes"], "-1.300,00 \u{20ac}");
}

/// A PostgreSQL-bound fact (a lazy connector that never connects -- the
/// pushdown decision reads the connector's KIND only) with a context column
/// whose expression is `expression`, and a disconnected in-memory as-of
/// table holding the scalar `[Threshold]` (50).
fn pushdown_engine(expression: &str) -> Engine {
    let model = DataModel::builder()
        .add_table(
            Table::new(
                "Fact",
                vec![Column::new("id", DataType::Int64), Column::new("amount", DataType::Float64)],
            )
            .unwrap(),
        )
        .add_table(
            Table::new("Limits", vec![Column::new("v", DataType::Float64)])
                .unwrap()
                .with_storage_mode(StorageMode::InMemory),
        )
        .add_measure(sum_measure("Revenue", "Fact", "amount"))
        .add_measure(expression_measure("Threshold", parse_measure("MAX(Limits[v])").unwrap()))
        .add_context_column(ContextColumn::new(
            "Band",
            "Fact",
            parse_measure_expression(expression).unwrap(),
            DataType::String,
        ))
        .build()
        .unwrap();
    let mut engine = Engine::new(model);
    let pg = engine.add_source(crate::PostgresConnector::lazy_unconnected());
    engine.bind_table("Fact", pg, SourceBinding::new("public", "fact"));
    engine.bind_table("Limits", pg, SourceBinding::new("mem", "limits"));
    engine
        .cache
        .store(
            "Limits",
            RecordBatch::try_new(
                Arc::new(Schema::new(vec![Field::new("v", ArrowType::Float64, true)])),
                vec![Arc::new(Float64Array::from(vec![50.0]))],
            )
            .unwrap(),
        )
        .unwrap();
    engine
}

#[tokio::test]
async fn a_context_column_holding_format_is_never_pushed_to_the_source() {
    let request = QueryRequest {
        measures: vec!["Revenue".into()],
        group_by: vec![ColumnRef::new("Fact", "Band")],
        ..Default::default()
    };
    let token = CancellationToken::new();
    // The positive control: a plain context column IS pushed (its CASE is
    // resolved for the source GROUP BY).
    let plain = pushdown_engine("IF(Fact[amount] > [Threshold], \"big\", \"small\")");
    let cases = plain.resolve_pushable_context_columns(&request, &token).await.unwrap();
    assert_eq!(cases.len(), 1, "the plain context column is pushed: {cases:?}");
    // With FORMAT, the column is computed locally: no case is resolved, so
    // the planner never renders `calcula_format` into PostgreSQL SQL.
    let formatted =
        pushdown_engine("IF(Fact[amount] > [Threshold], FORMAT(Fact[amount], \"0\"), \"small\")");
    let cases = formatted.resolve_pushable_context_columns(&request, &token).await.unwrap();
    assert!(cases.is_empty(), "a FORMAT context column must stay local: {cases:?}");
}

/// A drill-through (detail rows) of a context column holding FORMAT computes
/// it per row with the engine's UDFs. The detail session had none, so it
/// failed "Invalid function 'calcula_format'" while the grouped query
/// answered (wave 1 dax lane's new defect; wave 3 lane engfix).
#[tokio::test]
async fn a_drill_through_computes_a_context_column_holding_format() {
    let model = DataModel::builder()
        .add_table(
            Table::new(
                "Fact",
                vec![Column::new("id", DataType::Int64), Column::new("amount", DataType::Float64)],
            )
            .unwrap()
            .with_storage_mode(StorageMode::InMemory),
        )
        .add_table(
            Table::new("Limits", vec![Column::new("v", DataType::Float64)])
                .unwrap()
                .with_storage_mode(StorageMode::InMemory),
        )
        .add_measure(sum_measure("Revenue", "Fact", "amount"))
        .add_measure(expression_measure("Threshold", parse_measure("MAX(Limits[v])").unwrap()))
        .add_context_column(ContextColumn::new(
            "Band",
            "Fact",
            parse_measure_expression(
                "IF(Fact[amount] > [Threshold], FORMAT(Fact[amount], \"0\"), \"small\")",
            )
            .unwrap(),
            DataType::String,
        ))
        .build()
        .unwrap();
    let mut engine = Engine::new(model);
    engine.bind_table("Fact", 0, SourceBinding::new("public", "fact"));
    engine.bind_table("Limits", 0, SourceBinding::new("public", "limits"));
    engine
        .cache
        .store(
            "Fact",
            RecordBatch::try_new(
                Arc::new(Schema::new(vec![
                    Field::new("id", ArrowType::Int64, true),
                    Field::new("amount", ArrowType::Float64, true),
                ])),
                vec![
                    Arc::new(Int64Array::from(vec![1, 2])),
                    Arc::new(Float64Array::from(vec![70.0, 20.0])),
                ],
            )
            .unwrap(),
        )
        .unwrap();
    engine
        .cache
        .store(
            "Limits",
            RecordBatch::try_new(
                Arc::new(Schema::new(vec![Field::new("v", ArrowType::Float64, true)])),
                vec![Arc::new(Float64Array::from(vec![50.0]))],
            )
            .unwrap(),
        )
        .unwrap();
    let rows = engine
        .query_rows(
            crate::DetailRequest::new("Fact", 10)
                .with_context_columns(vec![ColumnRef::new("Fact", "Band")]),
        )
        .await
        .unwrap_or_else(|e| panic!("the drill-through: {e}"));
    let mut bands: HashMap<i64, String> = HashMap::new();
    for b in &rows {
        let ids = b.column(b.schema().index_of("id").unwrap());
        let ids = ids.as_any().downcast_ref::<Int64Array>().unwrap();
        let band = b.column(b.schema().index_of("Band").unwrap());
        let band = arrow::compute::cast(band, &ArrowType::Utf8).unwrap();
        let band = band.as_any().downcast_ref::<StringArray>().unwrap();
        for row in 0..b.num_rows() {
            bands.insert(ids.value(row), band.value(row).to_string());
        }
    }
    assert_eq!(bands[&1], "70", "{bands:?}");
    assert_eq!(bands[&2], "small", "{bands:?}");
}
