//! Integration tests for the query planner and executor.
//!
//! These tests require a local PostgreSQL instance with the AdventureWorks
//! database. Run with: `cargo test -p engine-query -- --ignored`

use engine_connectors::auth::{AuthMethod, ConnectionTarget};
use engine_connectors::postgres::PostgresConnector;
use engine_connectors::traits::Connector;
use engine_connectors::{
    AggregateExpr, AggregateFunction, FetchRequest, FilterCondition, FilterOperator,
};
use engine_core::compute::measure::sum_measure;
use engine_core::model::schema::DataModel;
use engine_core::model::{Column, Relationship, Table};
use engine_core::types::DataType;
use engine_query::{
    AnyConnector, ColumnRef, PushdownPlanner, QueryExecutor, QueryRequest, SourceBinding,
    SourceRegistry,
};

async fn connect() -> PostgresConnector {
    let target = ConnectionTarget::new("localhost", "Adventureworks").with_port(5432);
    let auth = AuthMethod::UsernamePassword {
        username: "postgres".into(),
        password: "postgres".into(),
    };
    PostgresConnector::connect(target, auth)
        .await
        .expect("failed to connect to AdventureWorks")
}

// --- Direct connector aggregate pushdown tests ---

#[tokio::test]
#[ignore]
async fn pushed_sum_aggregate_returns_result() {
    let connector = connect().await;
    let batches = connector
        .fetch_data(&FetchRequest {
            schema: Some("sales".into()),
            table: "salesorderdetail".into(),
            aggregates: vec![AggregateExpr {
                column: "unitprice".into(),
                function: AggregateFunction::Sum,
                alias: Some("total_price".into()),
            }],
            ..Default::default()
        })
        .await
        .unwrap();

    assert_eq!(batches.len(), 1);
    let batch = &batches[0];
    assert_eq!(batch.num_rows(), 1);
    assert_eq!(batch.num_columns(), 1);
    assert_eq!(batch.schema().field(0).name(), "total_price");

    connector.close().await;
}

#[tokio::test]
#[ignore]
async fn pushed_sum_grouped_by_column() {
    let connector = connect().await;
    let batches = connector
        .fetch_data(&FetchRequest {
            schema: Some("sales".into()),
            table: "salesorderdetail".into(),
            group_by: vec!["productid".into()],
            aggregates: vec![AggregateExpr {
                column: "orderqty".into(),
                function: AggregateFunction::Sum,
                alias: Some("total_qty".into()),
            }],
            ..Default::default()
        })
        .await
        .unwrap();

    assert!(!batches.is_empty());
    let batch = &batches[0];
    // Should have productid + total_qty columns.
    assert_eq!(batch.num_columns(), 2);
    // Multiple products → multiple rows.
    assert!(batch.num_rows() > 1);

    connector.close().await;
}

#[tokio::test]
#[ignore]
async fn pushed_aggregate_with_filter() {
    let connector = connect().await;
    let batches = connector
        .fetch_data(&FetchRequest {
            schema: Some("sales".into()),
            table: "salesorderdetail".into(),
            filters: vec![FilterCondition::new(
                "productid",
                FilterOperator::Equal,
                "776",
            )],
            aggregates: vec![AggregateExpr {
                column: "orderqty".into(),
                function: AggregateFunction::Sum,
                alias: Some("total_qty".into()),
            }],
            ..Default::default()
        })
        .await
        .unwrap();

    assert_eq!(batches.len(), 1);
    let batch = &batches[0];
    assert_eq!(batch.num_rows(), 1);
    assert_eq!(batch.num_columns(), 1);

    connector.close().await;
}

// --- End-to-end planner + executor tests ---

fn sales_detail_model() -> DataModel {
    let detail = Table::new(
        "SalesDetail",
        vec![
            Column::new("salesorderdetailid", DataType::Int32),
            Column::new("salesorderid", DataType::Int32),
            Column::new("productid", DataType::Int32),
            Column::non_nullable("orderqty", DataType::Int32),
            Column::new("unitprice", DataType::Decimal(38, 6)),
        ],
    )
    .unwrap();

    DataModel::builder()
        .add_table(detail)
        .add_measure(sum_measure("TotalQty", "SalesDetail", "orderqty"))
        .build()
        .unwrap()
}

fn star_schema_model() -> DataModel {
    let detail = Table::new(
        "SalesDetail",
        vec![
            Column::new("salesorderdetailid", DataType::Int32),
            Column::new("salesorderid", DataType::Int32),
            Column::new("productid", DataType::Int32),
            Column::non_nullable("orderqty", DataType::Int32),
            Column::new("unitprice", DataType::Decimal(38, 6)),
        ],
    )
    .unwrap();

    let product = Table::new(
        "Product",
        vec![
            Column::non_nullable("productid", DataType::Int32),
            Column::new("name", DataType::String),
        ],
    )
    .unwrap();

    DataModel::builder()
        .add_table(detail)
        .add_table(product)
        .add_relationship(Relationship::many_to_one(
            "Detail_Product",
            "SalesDetail",
            "productid",
            "Product",
            "productid",
        ))
        .add_measure(sum_measure("TotalQty", "SalesDetail", "orderqty"))
        .build()
        .unwrap()
}

async fn make_registry() -> SourceRegistry {
    let connector = connect().await;
    let mut registry = SourceRegistry::new();
    let idx = registry.add_connector(AnyConnector::Postgres(connector));
    registry.bind(
        "SalesDetail",
        idx,
        SourceBinding::new("sales", "salesorderdetail"),
    );
    registry.bind("Product", idx, SourceBinding::new("production", "product"));
    registry
}

/// Registry simulating cross-source: fact table on one connector, dimension on another.
/// Both point to the same PostgreSQL database but use separate connections.
async fn make_cross_source_registry() -> SourceRegistry {
    let conn_a = connect().await;
    let conn_b = connect().await;
    let mut registry = SourceRegistry::new();
    let idx_a = registry.add_connector(AnyConnector::Postgres(conn_a));
    let idx_b = registry.add_connector(AnyConnector::Postgres(conn_b));
    registry.bind(
        "SalesDetail",
        idx_a,
        SourceBinding::new("sales", "salesorderdetail"),
    );
    registry.bind(
        "Product",
        idx_b,
        SourceBinding::new("production", "product"),
    );
    registry
}

#[tokio::test]
#[ignore]
async fn end_to_end_pushed_aggregation() {
    let model = sales_detail_model();
    let registry = make_registry().await;

    let request = QueryRequest {
        measures: vec!["TotalQty".into()],
        group_by: vec![ColumnRef::new("SalesDetail", "productid")],
        filters: vec![],
        lookups: vec![],
        ..Default::default()
    };

    let plan = PushdownPlanner::plan(&request, &model, &registry, &[]).unwrap();

    // Should be pushed to source (single table).
    assert!(matches!(
        plan,
        engine_query::QueryPlan::PushedAggregation { .. }
    ));

    let batches = QueryExecutor::execute(&plan, &model, &registry, None, None, None, &[])
        .await
        .unwrap();

    assert!(!batches.is_empty());
    let batch = &batches[0];
    // productid + TotalQty columns.
    assert_eq!(batch.num_columns(), 2);
    assert!(batch.num_rows() > 1);
}

#[tokio::test]
#[ignore]
async fn end_to_end_pushed_aggregation_no_groupby() {
    let model = sales_detail_model();
    let registry = make_registry().await;

    let request = QueryRequest {
        measures: vec!["TotalQty".into()],
        group_by: vec![],
        filters: vec![],
        lookups: vec![],
        ..Default::default()
    };

    let plan = PushdownPlanner::plan(&request, &model, &registry, &[]).unwrap();
    let batches = QueryExecutor::execute(&plan, &model, &registry, None, None, None, &[])
        .await
        .unwrap();

    assert_eq!(batches.len(), 1);
    let batch = &batches[0];
    assert_eq!(batch.num_rows(), 1);
    assert_eq!(batch.num_columns(), 1);
}

#[tokio::test]
#[ignore]
async fn end_to_end_local_aggregation_star_schema() {
    let model = star_schema_model();
    let registry = make_registry().await;

    let request = QueryRequest {
        measures: vec!["TotalQty".into()],
        group_by: vec![ColumnRef::new("Product", "name")],
        filters: vec![],
        lookups: vec![],
        ..Default::default()
    };

    let plan = PushdownPlanner::plan(&request, &model, &registry, &[]).unwrap();

    // Same-source star schema → pushed join aggregation.
    assert!(matches!(
        plan,
        engine_query::QueryPlan::PushedJoinAggregation { .. }
    ));

    let batches = QueryExecutor::execute(&plan, &model, &registry, None, None, None, &[])
        .await
        .unwrap();

    assert!(!batches.is_empty());
    let batch = &batches[0];
    // name + TotalQty columns.
    assert_eq!(batch.num_columns(), 2);
    // Multiple products → multiple rows.
    assert!(batch.num_rows() > 1);
}

#[tokio::test]
#[ignore]
async fn end_to_end_pushed_with_filter() {
    let model = sales_detail_model();
    let registry = make_registry().await;

    let request = QueryRequest {
        measures: vec!["TotalQty".into()],
        group_by: vec![],
        filters: vec![FilterCondition::new(
            "productid",
            FilterOperator::Equal,
            "776",
        )],
        lookups: vec![],
        ..Default::default()
    };

    let plan = PushdownPlanner::plan(&request, &model, &registry, &[]).unwrap();
    let batches = QueryExecutor::execute(&plan, &model, &registry, None, None, None, &[])
        .await
        .unwrap();

    assert_eq!(batches.len(), 1);
    let batch = &batches[0];
    assert_eq!(batch.num_rows(), 1);
}

// --- Cross-source join tests ---

#[tokio::test]
#[ignore]
async fn end_to_end_cross_source_star_schema() {
    let model = star_schema_model();
    let registry = make_cross_source_registry().await;

    let request = QueryRequest {
        measures: vec!["TotalQty".into()],
        group_by: vec![ColumnRef::new("Product", "name")],
        filters: vec![],
        lookups: vec![],
        ..Default::default()
    };

    let plan = PushdownPlanner::plan(&request, &model, &registry, &[]).unwrap();

    // Cross-source: must be local aggregation.
    assert!(matches!(
        plan,
        engine_query::QueryPlan::LocalAggregation { .. }
    ));

    let batches = QueryExecutor::execute(&plan, &model, &registry, None, None, None, &[])
        .await
        .unwrap();

    assert!(!batches.is_empty());
    let batch = &batches[0];
    // name + TotalQty columns.
    assert_eq!(batch.num_columns(), 2);
    // Multiple products → multiple rows.
    assert!(batch.num_rows() > 1);
}

#[tokio::test]
#[ignore]
async fn end_to_end_cross_source_no_groupby() {
    let model = star_schema_model();
    let registry = make_cross_source_registry().await;

    // Scalar aggregation: no group-by, just the measure.
    // Even though the model has two tables on different sources,
    // TotalQty only needs SalesDetail.
    let request = QueryRequest {
        measures: vec!["TotalQty".into()],
        group_by: vec![],
        filters: vec![],
        lookups: vec![],
        ..Default::default()
    };

    let plan = PushdownPlanner::plan(&request, &model, &registry, &[]).unwrap();
    let batches = QueryExecutor::execute(&plan, &model, &registry, None, None, None, &[])
        .await
        .unwrap();

    assert_eq!(batches.len(), 1);
    let batch = &batches[0];
    assert_eq!(batch.num_rows(), 1);
    assert_eq!(batch.num_columns(), 1);
}
