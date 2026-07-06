//! Integration tests for the PostgreSQL connector.
//!
//! These tests require a local PostgreSQL instance with the AdventureWorks
//! database. Run with: `cargo test -p engine-connectors -- --ignored`

use arrow::datatypes::DataType as ArrowDataType;
use engine_connectors::auth::{AuthMethod, ConnectionTarget};
use engine_connectors::postgres::PostgresConnector;
use engine_connectors::traits::{Connector, FetchRequest, FilterCondition, FilterOperator};
use engine_core::types::DataType;

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

// --- Connection tests ---

#[tokio::test]
#[ignore]
async fn connect_to_adventureworks() {
    let connector = connect().await;
    connector.close().await;
}

// --- Schema introspection tests ---

#[tokio::test]
#[ignore]
async fn list_tables_returns_adventureworks_tables() {
    let connector = connect().await;
    let tables = connector.list_tables().await.unwrap();

    // AdventureWorks has tables in multiple schemas.
    assert!(!tables.is_empty());

    // Check that a known table exists.
    let has_sales_header = tables
        .iter()
        .any(|t| t.schema == "sales" && t.name == "salesorderheader");
    assert!(
        has_sales_header,
        "sales.salesorderheader not found in table list"
    );

    let has_products = tables
        .iter()
        .any(|t| t.schema == "production" && t.name == "product");
    assert!(has_products, "production.product not found in table list");

    connector.close().await;
}

#[tokio::test]
#[ignore]
async fn introspect_salesorderheader_columns() {
    let connector = connect().await;
    let table = connector
        .introspect_table("sales", "salesorderheader")
        .await
        .unwrap();

    // The table should have known columns.
    let salesorderid = table.column("salesorderid").unwrap();
    assert_eq!(salesorderid.data_type(), &DataType::Int32);
    assert!(!salesorderid.nullable());

    let subtotal = table.column("subtotal").unwrap();
    assert!(matches!(subtotal.data_type(), DataType::Decimal(_, _)));
    assert!(!subtotal.nullable());

    let orderdate = table.column("orderdate").unwrap();
    assert_eq!(orderdate.data_type(), &DataType::Timestamp);

    let shipdate = table.column("shipdate").unwrap();
    assert!(shipdate.nullable());

    // Check that a custom domain type (e.g., "Flag") was resolved.
    let onlineorderflag = table.column("onlineorderflag").unwrap();
    assert_eq!(
        onlineorderflag.data_type(),
        &DataType::Boolean,
        "custom domain type 'Flag' should resolve to Boolean"
    );

    connector.close().await;
}

// --- Row count test ---

#[tokio::test]
#[ignore]
async fn row_count_matches_expected() {
    let connector = connect().await;
    let count = connector
        .row_count("sales", "salesorderheader")
        .await
        .unwrap();
    assert_eq!(count, 31465, "expected 31465 rows in salesorderheader");
    connector.close().await;
}

// --- Data fetching tests ---

#[tokio::test]
#[ignore]
async fn fetch_full_table_returns_record_batches() {
    let connector = connect().await;
    let batches = connector
        .fetch_data(&FetchRequest {
            schema: Some("sales".into()),
            table: "salesorderheader".into(),
            ..Default::default()
        })
        .await
        .unwrap();

    // Should have at least one batch.
    assert!(!batches.is_empty());

    // Total row count across all batches.
    let total_rows: usize = batches.iter().map(|b| b.num_rows()).sum();
    assert_eq!(total_rows, 31465);

    // Check column count (salesorderheader has 25 columns).
    assert_eq!(batches[0].num_columns(), 25);

    connector.close().await;
}

#[tokio::test]
#[ignore]
async fn fetch_with_column_selection() {
    let connector = connect().await;
    let batches = connector
        .fetch_data(&FetchRequest {
            schema: Some("sales".into()),
            table: "salesorderheader".into(),
            columns: vec!["salesorderid".into(), "subtotal".into()],
            limit: Some(5),
            ..Default::default()
        })
        .await
        .unwrap();

    assert_eq!(batches.len(), 1);
    let batch = &batches[0];
    assert_eq!(batch.num_columns(), 2);
    assert_eq!(batch.num_rows(), 5);

    // Verify column names.
    assert_eq!(batch.schema().field(0).name(), "salesorderid");
    assert_eq!(batch.schema().field(1).name(), "subtotal");

    connector.close().await;
}

#[tokio::test]
#[ignore]
async fn fetch_with_limit() {
    let connector = connect().await;
    let batches = connector
        .fetch_data(&FetchRequest {
            schema: Some("sales".into()),
            table: "salesorderheader".into(),
            limit: Some(10),
            ..Default::default()
        })
        .await
        .unwrap();

    let total_rows: usize = batches.iter().map(|b| b.num_rows()).sum();
    assert_eq!(total_rows, 10);

    connector.close().await;
}

#[tokio::test]
#[ignore]
async fn fetch_with_filter() {
    let connector = connect().await;
    let batches = connector
        .fetch_data(&FetchRequest {
            schema: Some("sales".into()),
            table: "salesorderheader".into(),
            columns: vec!["salesorderid".into(), "customerid".into()],
            filters: vec![FilterCondition::new(
                "customerid",
                FilterOperator::Equal,
                "29825",
            )],
            ..Default::default()
        })
        .await
        .unwrap();

    let total_rows: usize = batches.iter().map(|b| b.num_rows()).sum();
    assert!(
        total_rows > 0,
        "expected at least one order for customer 29825"
    );

    // Verify all rows have the expected customer ID.
    for batch in &batches {
        let col = batch
            .column(1)
            .as_any()
            .downcast_ref::<arrow::array::Int32Array>()
            .expect("customerid should be Int32");
        for i in 0..col.len() {
            assert_eq!(col.value(i), 29825);
        }
    }

    connector.close().await;
}

// --- Raw SQL test ---

#[tokio::test]
#[ignore]
async fn execute_raw_query() {
    let connector = connect().await;
    let batches = connector
        .execute_query("SELECT COUNT(*) AS cnt FROM sales.salesorderheader")
        .await
        .unwrap();

    assert_eq!(batches.len(), 1);
    let batch = &batches[0];
    assert_eq!(batch.num_rows(), 1);
    assert_eq!(batch.num_columns(), 1);

    connector.close().await;
}

// --- Type conversion tests ---

#[tokio::test]
#[ignore]
async fn timestamp_columns_convert_correctly() {
    let connector = connect().await;
    let batches = connector
        .fetch_data(&FetchRequest {
            schema: Some("sales".into()),
            table: "salesorderheader".into(),
            columns: vec!["orderdate".into()],
            limit: Some(1),
            ..Default::default()
        })
        .await
        .unwrap();

    let batch = &batches[0];
    let schema = batch.schema();
    let field = schema.field(0);
    assert!(
        matches!(
            field.data_type(),
            ArrowDataType::Timestamp(arrow::datatypes::TimeUnit::Microsecond, _)
        ),
        "orderdate should be Timestamp(Microsecond)"
    );

    // Value should be non-null.
    assert_eq!(batch.column(0).null_count(), 0);

    connector.close().await;
}

#[tokio::test]
#[ignore]
async fn numeric_columns_convert_to_decimal() {
    let connector = connect().await;
    let batches = connector
        .fetch_data(&FetchRequest {
            schema: Some("sales".into()),
            table: "salesorderheader".into(),
            columns: vec!["subtotal".into()],
            limit: Some(5),
            ..Default::default()
        })
        .await
        .unwrap();

    let batch = &batches[0];
    let schema = batch.schema();
    let field = schema.field(0);
    assert!(
        matches!(field.data_type(), ArrowDataType::Decimal128(_, _)),
        "subtotal should be Decimal128"
    );

    connector.close().await;
}

#[tokio::test]
#[ignore]
async fn null_values_preserved_in_arrow_conversion() {
    let connector = connect().await;
    // shipdate is nullable in salesorderheader.
    let batches = connector
        .fetch_data(&FetchRequest {
            schema: Some("sales".into()),
            table: "salesorderheader".into(),
            columns: vec!["shipdate".into()],
            ..Default::default()
        })
        .await
        .unwrap();

    let total_nulls: usize = batches.iter().map(|b| b.column(0).null_count()).sum();
    // Some orders may not have shipped yet, so there might be nulls.
    // If no nulls exist, try a different column.
    // For AdventureWorks, salespersonid is nullable.
    if total_nulls == 0 {
        let batches2 = connector
            .fetch_data(&FetchRequest {
                schema: Some("sales".into()),
                table: "salesorderheader".into(),
                columns: vec!["salespersonid".into()],
                ..Default::default()
            })
            .await
            .unwrap();
        let nulls: usize = batches2.iter().map(|b| b.column(0).null_count()).sum();
        assert!(nulls > 0, "expected some null values in salespersonid");
    }

    connector.close().await;
}
