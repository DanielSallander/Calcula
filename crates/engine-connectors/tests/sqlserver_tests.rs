//! Integration tests for the SQL Server connector.
//!
//! These tests require a local SQL Server instance with AdventureWorks.
//! Run with: `cargo test -p engine-connectors -- --ignored`

use engine_connectors::sqlserver::{SqlServerConfig, SqlServerConnector};
use engine_connectors::traits::{AggregateExpr, AggregateFunction, Connector, FetchRequest};

/// Connection string for the test SQL Server instance.
///
/// Set the `SQLSERVER_TEST_URL` environment variable to override.
fn test_connection_string() -> String {
    std::env::var("SQLSERVER_TEST_URL").unwrap_or_else(|_| {
        "server=tcp:localhost,1433;user=sa;password=YourPassword;database=AdventureWorks;TrustServerCertificate=true".into()
    })
}

async fn connect() -> SqlServerConnector {
    SqlServerConnector::connect(SqlServerConfig::new(test_connection_string()))
        .await
        .expect("failed to connect to SQL Server")
}

#[tokio::test]
#[ignore]
async fn connect_to_sqlserver() {
    let _conn = connect().await;
}

#[tokio::test]
#[ignore]
async fn list_tables_returns_tables() {
    let conn = connect().await;
    let tables = conn.list_tables().await.unwrap();
    assert!(!tables.is_empty(), "expected at least one table");
}

#[tokio::test]
#[ignore]
async fn introspect_table_returns_columns() {
    let conn = connect().await;
    let tables = conn.list_tables().await.unwrap();
    assert!(!tables.is_empty());

    let first = &tables[0];
    let table = conn
        .introspect_table(&first.schema, &first.name)
        .await
        .unwrap();
    assert!(!table.columns().is_empty());
}

#[tokio::test]
#[ignore]
async fn fetch_data_returns_batches() {
    let conn = connect().await;
    let tables = conn.list_tables().await.unwrap();
    let first = &tables[0];

    let request = FetchRequest {
        schema: Some(first.schema.clone()),
        table: first.name.clone(),
        limit: Some(5),
        ..Default::default()
    };

    let batches = conn.fetch_data(&request).await.unwrap();
    assert!(!batches.is_empty());
    assert!(batches[0].num_rows() <= 5);
}

#[tokio::test]
#[ignore]
async fn row_count_returns_positive() {
    let conn = connect().await;
    let tables = conn.list_tables().await.unwrap();
    let first = &tables[0];

    let count = conn.row_count(&first.schema, &first.name).await.unwrap();
    assert!(count > 0);
}

#[tokio::test]
#[ignore]
async fn execute_query_returns_results() {
    let conn = connect().await;
    let batches = conn.execute_query("SELECT TOP(3) 1 AS val").await.unwrap();
    assert!(!batches.is_empty());
    assert_eq!(batches[0].num_rows(), 3);
}

#[tokio::test]
#[ignore]
async fn aggregate_pushdown_sum() {
    let conn = connect().await;
    let tables = conn.list_tables().await.unwrap();
    // Find a table to test against.
    if tables.is_empty() {
        return;
    }
    let first = &tables[0];
    let table = conn
        .introspect_table(&first.schema, &first.name)
        .await
        .unwrap();
    // Use COUNT(*) on the first column as a generic aggregate test.
    let col_name = table.columns()[0].name().to_string();

    let request = FetchRequest {
        schema: Some(first.schema.clone()),
        table: first.name.clone(),
        aggregates: vec![AggregateExpr {
            column: col_name,
            function: AggregateFunction::Count,
            alias: Some("cnt".into()),
        }],
        ..Default::default()
    };

    let batches = conn.fetch_data(&request).await.unwrap();
    assert!(!batches.is_empty());
    assert_eq!(batches[0].num_rows(), 1);
}
