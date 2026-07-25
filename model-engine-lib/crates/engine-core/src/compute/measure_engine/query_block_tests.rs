//! Tests for two-stage QUERY-in-VAR evaluation (scalar, grouped, and
//! KEEP/CLEAR on intermediate tables).

use datafusion::common::ScalarValue;

use super::MeasureEngine;
use crate::compute::aggregate::AggregateOp;
use crate::compute::expression::{self as expr, ComparisonOp, Expression};
use crate::compute::measure::expression_measure;
use crate::model::column::Column;
use crate::model::schema::DataModel;
use crate::model::table::Table;
use crate::store::ColumnStore;
use crate::types::{DataType, TableColumn, Value};

fn query_test_store() -> ColumnStore {
    let mut store = ColumnStore::new();

    let orders = Table::new(
        "Orders",
        vec![
            Column::new("id", DataType::Int64),
            Column::new("product_id", DataType::Int64),
            Column::new("amount", DataType::Float64),
            Column::new("month", DataType::Int64),
        ],
    )
    .unwrap();

    let products = Table::new(
        "Products",
        vec![
            Column::new("id", DataType::Int64),
            Column::new("category", DataType::String),
        ],
    )
    .unwrap();

    store.register_table(orders).unwrap();
    store.register_table(products).unwrap();

    // 6 orders across 3 months and 2 products
    store
        .insert_rows(
            "Orders",
            vec![
                // Month 1: product 1 = 100, product 2 = 50
                vec![
                    Value::Int64(1),
                    Value::Int64(1),
                    Value::Float64(100.0),
                    Value::Int64(1),
                ],
                vec![
                    Value::Int64(2),
                    Value::Int64(2),
                    Value::Float64(50.0),
                    Value::Int64(1),
                ],
                // Month 2: product 1 = 200, product 2 = 80
                vec![
                    Value::Int64(3),
                    Value::Int64(1),
                    Value::Float64(200.0),
                    Value::Int64(2),
                ],
                vec![
                    Value::Int64(4),
                    Value::Int64(2),
                    Value::Float64(80.0),
                    Value::Int64(2),
                ],
                // Month 3: product 1 = 150, product 2 = 70
                vec![
                    Value::Int64(5),
                    Value::Int64(1),
                    Value::Float64(150.0),
                    Value::Int64(3),
                ],
                vec![
                    Value::Int64(6),
                    Value::Int64(2),
                    Value::Float64(70.0),
                    Value::Int64(3),
                ],
            ],
        )
        .unwrap();

    store
        .insert_rows(
            "Products",
            vec![
                vec![Value::Int64(1), Value::String("A".into())],
                vec![Value::Int64(2), Value::String("B".into())],
            ],
        )
        .unwrap();

    store
}

#[tokio::test]
async fn evaluate_query_in_var_avg_of_monthly_sums() {
    // VAR monthly = QUERY(SUM(Orders[amount]) AS revenue BY Orders[month])
    // RETURN AVG(monthly[revenue])
    //
    // Monthly sums: month1=150, month2=280, month3=220
    // AVG = 650/3 ≈ 216.667

    let model = DataModel::builder()
        .add_table(
            Table::new(
                "Orders",
                vec![
                    Column::new("id", DataType::Int64),
                    Column::new("product_id", DataType::Int64),
                    Column::new("amount", DataType::Float64),
                    Column::new("month", DataType::Int64),
                ],
            )
            .unwrap(),
        )
        .add_measure(expression_measure(
            "AvgMonthlyRevenue",
            Expression::Block {
                query_scoped_bindings: Vec::new(),
                bindings: vec![(
                    "monthly".to_string(),
                    Expression::Query {
                        aggregates: vec![(
                            expr::agg(AggregateOp::Sum, expr::qualified_col("Orders", "amount")),
                            "revenue".to_string(),
                        )],
                        group_by: vec![("Orders".to_string(), "month".to_string())],
                        top: None,
                    },
                )],
                result: Box::new(expr::agg(
                    AggregateOp::Average,
                    Expression::QualifiedColumnRef {
                        table_or_var: "monthly".to_string(),
                        column: "revenue".to_string(),
                    },
                )),
            },
        ))
        .build()
        .unwrap();

    let store = query_test_store();
    let engine = MeasureEngine::new(&model, &store);

    let result = engine.evaluate("AvgMonthlyRevenue").await.unwrap();
    let val = result.as_f64().unwrap();
    // AVG(150, 280, 220) = 650/3 ≈ 216.667
    assert!((val - 650.0 / 3.0).abs() < 0.01);
}

#[tokio::test]
async fn evaluate_query_in_var_max_of_monthly_sums() {
    // VAR monthly = QUERY(SUM(Orders[amount]) AS revenue BY Orders[month])
    // RETURN MAX(monthly[revenue])
    //
    // Monthly sums: month1=150, month2=280, month3=220
    // MAX = 280

    let model = DataModel::builder()
        .add_table(
            Table::new(
                "Orders",
                vec![
                    Column::new("id", DataType::Int64),
                    Column::new("product_id", DataType::Int64),
                    Column::new("amount", DataType::Float64),
                    Column::new("month", DataType::Int64),
                ],
            )
            .unwrap(),
        )
        .add_measure(expression_measure(
            "MaxMonthlyRevenue",
            Expression::Block {
                query_scoped_bindings: Vec::new(),
                bindings: vec![(
                    "monthly".to_string(),
                    Expression::Query {
                        aggregates: vec![(
                            expr::agg(AggregateOp::Sum, expr::qualified_col("Orders", "amount")),
                            "revenue".to_string(),
                        )],
                        group_by: vec![("Orders".to_string(), "month".to_string())],
                        top: None,
                    },
                )],
                result: Box::new(expr::agg(
                    AggregateOp::Max,
                    Expression::QualifiedColumnRef {
                        table_or_var: "monthly".to_string(),
                        column: "revenue".to_string(),
                    },
                )),
            },
        ))
        .build()
        .unwrap();

    let store = query_test_store();
    let engine = MeasureEngine::new(&model, &store);

    let result = engine.evaluate("MaxMonthlyRevenue").await.unwrap();
    assert_eq!(result.as_f64(), Some(280.0));
}

#[tokio::test]
async fn evaluate_query_in_var_with_cross_table_group_by() {
    // VAR by_category = QUERY(SUM(Orders[amount]) AS revenue BY Products[category])
    // RETURN MAX(by_category[revenue])
    //
    // Category A (product 1): 100+200+150 = 450
    // Category B (product 2): 50+80+70 = 200
    // MAX = 450

    use crate::model::relationship::Relationship;

    let model = DataModel::builder()
        .add_table(
            Table::new(
                "Orders",
                vec![
                    Column::new("id", DataType::Int64),
                    Column::new("product_id", DataType::Int64),
                    Column::new("amount", DataType::Float64),
                    Column::new("month", DataType::Int64),
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
        .add_relationship(Relationship::many_to_one(
            "Orders_Products",
            "Orders",
            "product_id",
            "Products",
            "id",
        ))
        .add_measure(expression_measure(
            "MaxCategoryRevenue",
            Expression::Block {
                query_scoped_bindings: Vec::new(),
                bindings: vec![(
                    "by_cat".to_string(),
                    Expression::Query {
                        aggregates: vec![(
                            expr::agg(AggregateOp::Sum, expr::qualified_col("Orders", "amount")),
                            "revenue".to_string(),
                        )],
                        group_by: vec![("Products".to_string(), "category".to_string())],
                        top: None,
                    },
                )],
                result: Box::new(expr::agg(
                    AggregateOp::Max,
                    Expression::QualifiedColumnRef {
                        table_or_var: "by_cat".to_string(),
                        column: "revenue".to_string(),
                    },
                )),
            },
        ))
        .build()
        .unwrap();

    let store = query_test_store();
    let engine = MeasureEngine::new(&model, &store);

    let result = engine.evaluate("MaxCategoryRevenue").await.unwrap();
    assert_eq!(result.as_f64(), Some(450.0));
}

#[tokio::test]
async fn evaluate_query_in_var_grouped_output() {
    // VAR monthly = QUERY(SUM(Orders[amount]) AS revenue BY Orders[month])
    // RETURN AVG(monthly[revenue])
    // Grouped by Orders[month] should return each month's sum (since
    // each group has 1 row in the intermediate table).
    //
    // But this test groups the RETURN by Orders[month], which maps to
    // the "month" column in the intermediate "monthly" table.
    // month1: AVG(150)=150, month2: AVG(280)=280, month3: AVG(220)=220

    let model = DataModel::builder()
        .add_table(
            Table::new(
                "Orders",
                vec![
                    Column::new("id", DataType::Int64),
                    Column::new("product_id", DataType::Int64),
                    Column::new("amount", DataType::Float64),
                    Column::new("month", DataType::Int64),
                ],
            )
            .unwrap(),
        )
        .add_measure(expression_measure(
            "AvgMonthlyRevenue",
            Expression::Block {
                query_scoped_bindings: Vec::new(),
                bindings: vec![(
                    "monthly".to_string(),
                    Expression::Query {
                        aggregates: vec![(
                            expr::agg(AggregateOp::Sum, expr::qualified_col("Orders", "amount")),
                            "revenue".to_string(),
                        )],
                        group_by: vec![("Orders".to_string(), "month".to_string())],
                        top: None,
                    },
                )],
                result: Box::new(expr::agg(
                    AggregateOp::Average,
                    Expression::QualifiedColumnRef {
                        table_or_var: "monthly".to_string(),
                        column: "revenue".to_string(),
                    },
                )),
            },
        ))
        .build()
        .unwrap();

    let store = query_test_store();
    let engine = MeasureEngine::new(&model, &store);

    let result = engine
        .evaluate_grouped("AvgMonthlyRevenue", &[TableColumn::new("Orders", "month")])
        .await
        .unwrap();

    // 3 groups, each with a single intermediate row → AVG = the sum itself
    assert_eq!(result.num_rows(), 3);
    assert_eq!(result.num_columns(), 2); // month + AvgMonthlyRevenue
}

#[tokio::test]
async fn evaluate_query_in_var_count_of_groups() {
    // VAR monthly = QUERY(SUM(Orders[amount]) AS revenue BY Orders[month])
    // RETURN COUNTROWS(monthly)
    //
    // 3 months → COUNTROWS = 3

    let model = DataModel::builder()
        .add_table(
            Table::new(
                "Orders",
                vec![
                    Column::new("id", DataType::Int64),
                    Column::new("product_id", DataType::Int64),
                    Column::new("amount", DataType::Float64),
                    Column::new("month", DataType::Int64),
                ],
            )
            .unwrap(),
        )
        .add_measure(expression_measure(
            "MonthCount",
            Expression::Block {
                query_scoped_bindings: Vec::new(),
                bindings: vec![(
                    "monthly".to_string(),
                    Expression::Query {
                        aggregates: vec![(
                            expr::agg(AggregateOp::Sum, expr::qualified_col("Orders", "amount")),
                            "revenue".to_string(),
                        )],
                        group_by: vec![("Orders".to_string(), "month".to_string())],
                        top: None,
                    },
                )],
                result: Box::new(expr::agg(
                    AggregateOp::CountRows,
                    Expression::TableRef("monthly".to_string()),
                )),
            },
        ))
        .build()
        .unwrap();

    let store = query_test_store();
    let engine = MeasureEngine::new(&model, &store);

    let result = engine.evaluate("MonthCount").await.unwrap();
    let count = match &result.value {
        ScalarValue::Int64(Some(n)) => *n,
        ScalarValue::UInt64(Some(n)) => *n as i64,
        other => panic!("Unexpected scalar type: {other:?}"),
    };
    assert_eq!(count, 3);
}

// --- KEEP/CLEAR on intermediate tables tests ---

#[tokio::test]
async fn evaluate_query_in_var_keep_on_intermediate_table() {
    // VAR monthly = QUERY(SUM(Orders[amount]) AS revenue BY Orders[month])
    // RETURN SUM(monthly[revenue], KEEP(monthly[month] = 2))
    //
    // Monthly sums: month1=150, month2=280, month3=220
    // KEEP(month=2) → only month2 row → SUM = 280
    use crate::compute::expression::FilterPredicate;

    let model = DataModel::builder()
        .add_table(
            Table::new(
                "Orders",
                vec![
                    Column::new("id", DataType::Int64),
                    Column::new("product_id", DataType::Int64),
                    Column::new("amount", DataType::Float64),
                    Column::new("month", DataType::Int64),
                ],
            )
            .unwrap(),
        )
        .add_measure(expression_measure(
            "Month2Revenue",
            Expression::Block {
                query_scoped_bindings: Vec::new(),
                bindings: vec![(
                    "monthly".to_string(),
                    Expression::Query {
                        aggregates: vec![(
                            expr::agg(AggregateOp::Sum, expr::qualified_col("Orders", "amount")),
                            "revenue".to_string(),
                        )],
                        group_by: vec![("Orders".to_string(), "month".to_string())],
                        top: None,
                    },
                )],
                result: Box::new(expr::agg(
                    AggregateOp::Sum,
                    expr::keep(
                        Expression::QualifiedColumnRef {
                            table_or_var: "monthly".to_string(),
                            column: "revenue".to_string(),
                        },
                        vec![FilterPredicate::new(
                            "monthly",
                            "month",
                            ComparisonOp::Equal,
                            "2",
                        )],
                    ),
                )),
            },
        ))
        .build()
        .unwrap();

    let store = query_test_store();
    let engine = MeasureEngine::new(&model, &store);

    let result = engine.evaluate("Month2Revenue").await.unwrap();
    assert_eq!(result.as_f64(), Some(280.0));
}

#[tokio::test]
async fn evaluate_query_in_var_keep_multiple_filters() {
    // VAR by_month_product = QUERY(SUM(Orders[amount]) AS revenue
    //                              BY Orders[month], Orders[product_id])
    // RETURN SUM(by_month_product[revenue],
    //            KEEP(by_month_product[month] = 1, by_month_product[product_id] = 1))
    //
    // Data: month=1, product=1 → amount=100
    // KEEP(month=1 AND product_id=1) → only that row → SUM = 100
    use crate::compute::expression::FilterPredicate;

    let model = DataModel::builder()
        .add_table(
            Table::new(
                "Orders",
                vec![
                    Column::new("id", DataType::Int64),
                    Column::new("product_id", DataType::Int64),
                    Column::new("amount", DataType::Float64),
                    Column::new("month", DataType::Int64),
                ],
            )
            .unwrap(),
        )
        .add_measure(expression_measure(
            "SingleCell",
            Expression::Block {
                query_scoped_bindings: Vec::new(),
                bindings: vec![(
                    "detail".to_string(),
                    Expression::Query {
                        aggregates: vec![(
                            expr::agg(AggregateOp::Sum, expr::qualified_col("Orders", "amount")),
                            "revenue".to_string(),
                        )],
                        group_by: vec![
                            ("Orders".to_string(), "month".to_string()),
                            ("Orders".to_string(), "product_id".to_string()),
                        ],
                        top: None,
                    },
                )],
                result: Box::new(expr::agg(
                    AggregateOp::Sum,
                    expr::keep(
                        Expression::QualifiedColumnRef {
                            table_or_var: "detail".to_string(),
                            column: "revenue".to_string(),
                        },
                        vec![
                            FilterPredicate::new("detail", "month", ComparisonOp::Equal, "1"),
                            FilterPredicate::new("detail", "product_id", ComparisonOp::Equal, "1"),
                        ],
                    ),
                )),
            },
        ))
        .build()
        .unwrap();

    let store = query_test_store();
    let engine = MeasureEngine::new(&model, &store);

    let result = engine.evaluate("SingleCell").await.unwrap();
    assert_eq!(result.as_f64(), Some(100.0));
}

#[tokio::test]
async fn evaluate_query_in_var_keep_grouped() {
    // VAR monthly = QUERY(SUM(Orders[amount]) AS revenue BY Orders[month])
    // RETURN SUM(monthly[revenue], KEEP(monthly[month] >= 2))
    // Grouped by Orders[month]
    //
    // Intermediate: month1=150, month2=280, month3=220
    // KEEP(month >= 2) → month2=280, month3=220
    // Grouped by month: each row has 1 value → SUM = that value
    // Result: 2 rows (month2=280, month3=220)
    use crate::compute::expression::FilterPredicate;

    let model = DataModel::builder()
        .add_table(
            Table::new(
                "Orders",
                vec![
                    Column::new("id", DataType::Int64),
                    Column::new("product_id", DataType::Int64),
                    Column::new("amount", DataType::Float64),
                    Column::new("month", DataType::Int64),
                ],
            )
            .unwrap(),
        )
        .add_measure(expression_measure(
            "FilteredRevenue",
            Expression::Block {
                query_scoped_bindings: Vec::new(),
                bindings: vec![(
                    "monthly".to_string(),
                    Expression::Query {
                        aggregates: vec![(
                            expr::agg(AggregateOp::Sum, expr::qualified_col("Orders", "amount")),
                            "revenue".to_string(),
                        )],
                        group_by: vec![("Orders".to_string(), "month".to_string())],
                        top: None,
                    },
                )],
                result: Box::new(expr::agg(
                    AggregateOp::Sum,
                    expr::keep(
                        Expression::QualifiedColumnRef {
                            table_or_var: "monthly".to_string(),
                            column: "revenue".to_string(),
                        },
                        vec![FilterPredicate::new(
                            "monthly",
                            "month",
                            ComparisonOp::GreaterThanOrEqual,
                            "2",
                        )],
                    ),
                )),
            },
        ))
        .build()
        .unwrap();

    let store = query_test_store();
    let engine = MeasureEngine::new(&model, &store);

    let result = engine
        .evaluate_grouped("FilteredRevenue", &[TableColumn::new("Orders", "month")])
        .await
        .unwrap();

    // KEEP(month >= 2) filters intermediate to 2 rows
    assert_eq!(result.num_rows(), 2);
}

#[tokio::test]
async fn evaluate_query_in_var_keep_scalar_sum() {
    // VAR monthly = QUERY(SUM(Orders[amount]) AS revenue BY Orders[month])
    // RETURN SUM(monthly[revenue], KEEP(monthly[month] >= 2))
    //
    // Intermediate: month1=150, month2=280, month3=220
    // KEEP(month >= 2) → month2+month3 = 500
    use crate::compute::expression::FilterPredicate;

    let model = DataModel::builder()
        .add_table(
            Table::new(
                "Orders",
                vec![
                    Column::new("id", DataType::Int64),
                    Column::new("product_id", DataType::Int64),
                    Column::new("amount", DataType::Float64),
                    Column::new("month", DataType::Int64),
                ],
            )
            .unwrap(),
        )
        .add_measure(expression_measure(
            "RecentRevenue",
            Expression::Block {
                query_scoped_bindings: Vec::new(),
                bindings: vec![(
                    "monthly".to_string(),
                    Expression::Query {
                        aggregates: vec![(
                            expr::agg(AggregateOp::Sum, expr::qualified_col("Orders", "amount")),
                            "revenue".to_string(),
                        )],
                        group_by: vec![("Orders".to_string(), "month".to_string())],
                        top: None,
                    },
                )],
                result: Box::new(expr::agg(
                    AggregateOp::Sum,
                    expr::keep(
                        Expression::QualifiedColumnRef {
                            table_or_var: "monthly".to_string(),
                            column: "revenue".to_string(),
                        },
                        vec![FilterPredicate::new(
                            "monthly",
                            "month",
                            ComparisonOp::GreaterThanOrEqual,
                            "2",
                        )],
                    ),
                )),
            },
        ))
        .build()
        .unwrap();

    let store = query_test_store();
    let engine = MeasureEngine::new(&model, &store);

    let result = engine.evaluate("RecentRevenue").await.unwrap();
    // month2 (280) + month3 (220) = 500
    assert_eq!(result.as_f64(), Some(500.0));
}
