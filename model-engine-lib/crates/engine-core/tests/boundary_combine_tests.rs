//! The boundary combiner (`measure_engine/boundary.rs`) of a compound measure
//! whose sub-aggregates carry their own KEEPs, grouped through a non-equi
//! (cumulative `<=`) relationship -- NEW-boundary-combiner-keys, open-ledger
//! round E.
//!
//! Each sub-aggregate is evaluated on its own and the results are joined on
//! the group keys. The combiner took the keys from the FIRST sub-result only,
//! so a group that sub did not produce came back with a NULL key; and a
//! sub-aggregate with no rows at all was registered with NO columns, so the
//! combining SQL failed with DataFusion's `FieldNotFound __sub_tbl_0.year`.
//! DAX: the measure is evaluated per group, and a sub-aggregate with no rows
//! in a group is BLANK there (`BLANK + 30 = 30`).
//!
//! Fixture: `Sales(order_date, product_id, amount)` -> `Products(id,
//! category)` (many-to-one) and `Sales.order_date <= DateDim.date_key`
//! (many-to-many, the cumulative boundary). Sales: a Books sale of 30 in 2020,
//! an Electronics sale of 100 in 2021 and one of 50 in 2022; DateDim has one
//! key per year. So cumulatively Books is 30 in every year and Electronics is
//! BLANK in 2020, 100 in 2021 and 150 in 2022.

use std::collections::HashMap;

use arrow::array::{Array, Float64Array, StringArray};
use arrow::datatypes::DataType as ArrowType;
use engine_core::compute::aggregate::AggregateOp;
use engine_core::compute::expression::{self as expr, ArithmeticOp, Expression, FilterPredicate};
use engine_core::compute::measure::expression_measure;
use engine_core::compute::measure_engine::MeasureEngine;
use engine_core::model::column::Column;
use engine_core::model::relationship::{JoinCondition, JoinOperator, Relationship};
use engine_core::model::schema::DataModel;
use engine_core::model::table::Table;
use engine_core::store::ColumnStore;
use engine_core::types::{DataType, TableColumn, Value};

fn keep_category(category: &str) -> Expression {
    Expression::Keep {
        expr: Box::new(expr::agg(
            AggregateOp::Sum,
            expr::qualified_col("Sales", "amount"),
        )),
        filters: vec![FilterPredicate::new(
            "Products",
            "category",
            engine_core::compute::expression::ComparisonOp::Equal,
            category,
        )],
        variables: Vec::new(),
        conditions: Vec::new(),
        in_predicates: Vec::new(),
    }
}

fn plus(left: Expression, right: Expression) -> Expression {
    Expression::BinaryOp {
        left: Box::new(left),
        op: ArithmeticOp::Add,
        right: Box::new(right),
    }
}

fn model() -> DataModel {
    DataModel::builder()
        .add_table(
            Table::new(
                "Sales",
                vec![
                    Column::new("order_date", DataType::Int64),
                    Column::new("product_id", DataType::Int64),
                    Column::new("amount", DataType::Float64),
                ],
            )
            .unwrap(),
        )
        .add_table(
            Table::new(
                "Products",
                vec![
                    Column::new("id", DataType::Int64),
                    Column::new("category", DataType::String),
                ],
            )
            .unwrap(),
        )
        .add_table(
            Table::new(
                "DateDim",
                vec![
                    Column::new("date_key", DataType::Int64),
                    Column::new("year", DataType::String),
                ],
            )
            .unwrap(),
        )
        .add_relationship(Relationship::many_to_one(
            "Sales_Products",
            "Sales",
            "product_id",
            "Products",
            "id",
        ))
        .add_relationship(Relationship::many_to_many(
            "Sales_DateDim_LTE",
            "Sales",
            "DateDim",
            vec![JoinCondition::new(
                "order_date",
                "date_key",
                JoinOperator::LessThanOrEqual,
            )],
        ))
        // The FIRST sub-aggregate has no row in 2020.
        .add_measure(expression_measure(
            "ElectronicsPlusBooks",
            plus(keep_category("Electronics"), keep_category("Books")),
        ))
        // The first sub-aggregate has no row in ANY year.
        .add_measure(expression_measure(
            "ToysPlusBooks",
            plus(keep_category("Toys"), keep_category("Books")),
        ))
        // The LAST sub-aggregate has no row at all.
        .add_measure(expression_measure(
            "BooksPlusToys",
            plus(keep_category("Books"), keep_category("Toys")),
        ))
        // Three sub-aggregates, the middle one missing 2020.
        .add_measure(expression_measure(
            "BooksElectronicsBooks",
            plus(
                plus(keep_category("Books"), keep_category("Electronics")),
                keep_category("Books"),
            ),
        ))
        .build()
        .unwrap()
}

fn store() -> ColumnStore {
    let model = model();
    let mut store = ColumnStore::new();
    for t in ["Sales", "Products", "DateDim"] {
        store.register_table(model.table(t).unwrap().clone()).unwrap();
    }
    store
        .insert_rows(
            "Sales",
            vec![
                vec![Value::Int64(20200101), Value::Int64(2), Value::Float64(30.0)],
                vec![Value::Int64(20210101), Value::Int64(1), Value::Float64(100.0)],
                vec![Value::Int64(20220101), Value::Int64(1), Value::Float64(50.0)],
            ],
        )
        .unwrap();
    store
        .insert_rows(
            "Products",
            vec![
                vec![Value::Int64(1), Value::String("Electronics".into())],
                vec![Value::Int64(2), Value::String("Books".into())],
                vec![Value::Int64(3), Value::String("Toys".into())],
            ],
        )
        .unwrap();
    store
        .insert_rows(
            "DateDim",
            vec![
                vec![Value::Int64(20200601), Value::String("2020".into())],
                vec![Value::Int64(20210601), Value::String("2021".into())],
                vec![Value::Int64(20220601), Value::String("2022".into())],
            ],
        )
        .unwrap();
    store
}

/// year -> value (`None` is BLANK); a NULL year is keyed `"<NULL>"`.
async fn by_year(measure: &str) -> HashMap<String, Option<f64>> {
    let model = model();
    let store = store();
    let engine = MeasureEngine::new(&model, &store);
    let batch = engine
        .evaluate_grouped(measure, &[TableColumn::new("DateDim", "year")])
        .await
        .unwrap_or_else(|e| panic!("{measure}: {e}"));
    let years = batch.column(batch.schema().index_of("year").unwrap()).clone();
    let years = arrow::compute::cast(&years, &ArrowType::Utf8).unwrap();
    let years = years.as_any().downcast_ref::<StringArray>().unwrap();
    let values = batch.column(batch.schema().index_of(measure).unwrap()).clone();
    let values = arrow::compute::cast(&values, &ArrowType::Float64).unwrap();
    let values = values.as_any().downcast_ref::<Float64Array>().unwrap();
    let mut out = HashMap::new();
    for row in 0..batch.num_rows() {
        let year = if years.is_null(row) {
            "<NULL>".to_string()
        } else {
            years.value(row).to_string()
        };
        let value = (!values.is_null(row)).then(|| values.value(row));
        assert!(
            out.insert(year.clone(), value).is_none(),
            "{measure}: the year {year} came back twice"
        );
    }
    out
}

fn years(pairs: &[(&str, f64)]) -> HashMap<String, Option<f64>> {
    pairs.iter().map(|(y, v)| ((*y).to_string(), Some(*v))).collect()
}

#[tokio::test]
async fn a_group_the_first_sub_aggregate_lacks_keeps_its_key() {
    // 2020: BLANK + 30 = 30, keyed 2020 (it came back keyed NULL).
    assert_eq!(
        by_year("ElectronicsPlusBooks").await,
        years(&[("2020", 30.0), ("2021", 130.0), ("2022", 180.0)])
    );
    assert_eq!(
        by_year("BooksElectronicsBooks").await,
        years(&[("2020", 60.0), ("2021", 160.0), ("2022", 210.0)])
    );
}

#[tokio::test]
async fn a_sub_aggregate_with_no_rows_is_blank_not_an_error() {
    // Toys has no sale: BLANK + 30 in every year, whichever side it is on.
    let books = years(&[("2020", 30.0), ("2021", 30.0), ("2022", 30.0)]);
    assert_eq!(by_year("ToysPlusBooks").await, books);
    assert_eq!(by_year("BooksPlusToys").await, books);
}
