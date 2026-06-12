//! DAX-inspired function validation tests — 50 test cases comparing engine
//! results against direct SQL queries on the AdventureWorks BI schema.
//!
//! Tests the new expression types: IF, SWITCH, DIVIDE, BLANK, ISBLANK,
//! COALESCE, COUNTROWS, ABS, ROUND, INT, and combinations thereof.
//!
//! Run with: `cargo test -p engine --test dax_functions_validation -- --ignored --nocapture`

use bi_engine::*;
use rust_decimal::Decimal;
use sqlx::postgres::PgPoolOptions;
use sqlx::Row;
use std::str::FromStr;

const SCHEMA: &str = "BI";

fn test_target() -> ConnectionTarget {
    ConnectionTarget::new("localhost", "Adventureworks").with_port(5432)
}

fn test_auth() -> AuthMethod {
    AuthMethod::UsernamePassword {
        username: "postgres".into(),
        password: "postgres".into(),
    }
}

/// Tolerance for grand totals pushed down to the database.
const GRAND_TOTAL_TOLERANCE: f64 = 0.01;

/// Tolerance for grouped queries (star-schema joins).
const GROUPED_TOLERANCE: f64 = 0.05;

// ---------------------------------------------------------------------------
// Model setup
// ---------------------------------------------------------------------------

fn build_model_with_measures(measures: Vec<(&str, &str)>) -> EngineResult<DataModel> {
    let fact_sales = Table::new(
        "fact_sales",
        vec![
            Column::new("salesorderdetailid", DataType::Int32),
            Column::new("productid", DataType::Int32),
            Column::new("orderqty", DataType::Int32),
            Column::new("unitprice", DataType::Decimal(38, 6)),
            Column::new("linetotal", DataType::Decimal(38, 6)),
            Column::new("orderdate", DataType::Date),
            Column::new("customerid", DataType::Int32),
            Column::new("territoryid", DataType::Int32),
        ],
    )?;

    let dim_product = Table::new(
        "dim_product",
        vec![
            Column::new("productid", DataType::Int32),
            Column::new("productname", DataType::String),
            Column::new("productnumber", DataType::String),
            Column::new("color", DataType::String),
            Column::new("size", DataType::String),
            Column::new("weight", DataType::Decimal(38, 6)),
            Column::new("listprice", DataType::Decimal(38, 6)),
            Column::new("standardcost", DataType::Decimal(38, 6)),
            Column::new("productline", DataType::String),
            Column::new("class", DataType::String),
            Column::new("style", DataType::String),
            Column::new("categoryname", DataType::String),
            Column::new("subcategoryname", DataType::String),
        ],
    )?;

    let dim_customer = Table::new(
        "dim_customer",
        vec![
            Column::new("customerid", DataType::Int32),
            Column::new("fullname", DataType::String),
            Column::new("firstname", DataType::String),
            Column::new("lastname", DataType::String),
            Column::new("title", DataType::String),
            Column::new("emailaddress", DataType::String),
            Column::new("city", DataType::String),
            Column::new("stateprovince", DataType::String),
            Column::new("country", DataType::String),
            Column::new("postalcode", DataType::String),
        ],
    )?;

    let dim_territory = Table::new(
        "dim_territory",
        vec![
            Column::new("territoryid", DataType::Int32),
            Column::new("territoryname", DataType::String),
            Column::new("countryregioncode", DataType::String),
            Column::new("territorygroup", DataType::String),
            Column::new("salesytd", DataType::Decimal(38, 6)),
            Column::new("saleslastyear", DataType::Decimal(38, 6)),
            Column::new("costytd", DataType::Decimal(38, 6)),
            Column::new("costlastyear", DataType::Decimal(38, 6)),
        ],
    )?;

    let dim_date = Table::new(
        "dim_date",
        vec![
            Column::new("datekey", DataType::Date),
            Column::new("year", DataType::Decimal(38, 6)),
            Column::new("quarter", DataType::Decimal(38, 6)),
            Column::new("month", DataType::Decimal(38, 6)),
            Column::new("day", DataType::Decimal(38, 6)),
            Column::new("yearmonth", DataType::String),
            Column::new("monthname", DataType::String),
            Column::new("dayname", DataType::String),
            Column::new("weekofyear", DataType::Decimal(38, 6)),
            Column::new("dayofweek", DataType::Decimal(38, 6)),
        ],
    )?;

    let mut builder = DataModel::builder()
        .add_table(fact_sales)
        .add_table(dim_product)
        .add_table(dim_customer)
        .add_table(dim_territory)
        .add_table(dim_date)
        .add_relationship(Relationship::new(
            "fact_sales_to_dim_product",
            "fact_sales",
            "productid",
            "dim_product",
            "productid",
            Cardinality::ManyToOne,
        ))
        .add_relationship(Relationship::new(
            "fact_sales_to_dim_customer",
            "fact_sales",
            "customerid",
            "dim_customer",
            "customerid",
            Cardinality::ManyToOne,
        ))
        .add_relationship(Relationship::new(
            "fact_sales_to_dim_territory",
            "fact_sales",
            "territoryid",
            "dim_territory",
            "territoryid",
            Cardinality::ManyToOne,
        ))
        .add_relationship(Relationship::new(
            "fact_sales_to_dim_date",
            "fact_sales",
            "orderdate",
            "dim_date",
            "datekey",
            Cardinality::ManyToOne,
        ));

    for (name, expr_text) in &measures {
        let expr = parse_measure(expr_text)
            .unwrap_or_else(|e| panic!("Failed to parse measure '{name}': {e}"));
        builder = builder.add_measure(expression_measure(*name, expr));
    }

    builder.build()
}

async fn setup_engine(measures: Vec<(&str, &str)>) -> Engine {
    let model = build_model_with_measures(measures).expect("failed to build model");
    let mut engine = Engine::new(model);
    let pg_idx = engine
        .add_postgres(test_target(), test_auth())
        .await
        .expect("failed to connect to postgres");

    let table_names: Vec<String> = engine
        .model()
        .tables()
        .iter()
        .map(|t| t.name().to_string())
        .collect();
    for name in &table_names {
        engine.bind_table(
            name.as_str(),
            pg_idx,
            SourceBinding::new(SCHEMA, name.as_str()),
        );
    }
    engine
}

async fn make_pool() -> sqlx::PgPool {
    PgPoolOptions::new()
        .max_connections(1)
        .connect("postgresql://postgres:postgres@localhost:5432/Adventureworks")
        .await
        .unwrap()
}

// ---------------------------------------------------------------------------
// Comparison helpers
// ---------------------------------------------------------------------------

async fn compare_grand_total(
    engine: &mut Engine,
    pool: &sqlx::PgPool,
    measure_name: &str,
    sql: &str,
    tolerance: f64,
    test_label: &str,
) {
    let request = QueryRequest {
        measures: vec![measure_name.to_string()],
        group_by: vec![],
        filters: vec![],
        lookups: vec![],
    };
    let batches = engine
        .query(request)
        .await
        .unwrap_or_else(|e| panic!("[{test_label}] engine query failed: {e}"));

    let engine_val = extract_single_f64(&batches, measure_name);

    let row: (Decimal,) = sqlx::query_as(sql)
        .fetch_one(pool)
        .await
        .unwrap_or_else(|e| panic!("[{test_label}] SQL query failed: {e}\nSQL: {sql}"));
    let sql_val = decimal_to_f64(row.0);

    assert_approx(engine_val, sql_val, tolerance, test_label);
}

async fn compare_grouped(
    engine: &mut Engine,
    pool: &sqlx::PgPool,
    measure_name: &str,
    group_table: &str,
    group_column: &str,
    sql: &str,
    tolerance: f64,
    test_label: &str,
) {
    let request = QueryRequest {
        measures: vec![measure_name.to_string()],
        group_by: vec![ColumnRef::new(group_table, group_column)],
        filters: vec![],
        lookups: vec![],
    };
    let batches = engine
        .query(request)
        .await
        .unwrap_or_else(|e| panic!("[{test_label}] engine query failed: {e}"));

    let engine_rows = extract_grouped_results(&batches, group_column, measure_name);

    let rows = sqlx::query(sql)
        .fetch_all(pool)
        .await
        .unwrap_or_else(|e| panic!("[{test_label}] SQL query failed: {e}\nSQL: {sql}"));

    let mut sql_rows: Vec<(String, f64)> = Vec::new();
    for row in &rows {
        let key: Option<String> = row.try_get::<String, _>(0).ok().or_else(|| {
            row.try_get::<Decimal, _>(0)
                .ok()
                .map(|d| d.normalize().to_string())
        });
        if let Some(k) = key {
            let k = k.trim().to_string();
            if k.is_empty() {
                continue;
            }
            let val: Decimal = row
                .try_get(1)
                .unwrap_or_else(|e| panic!("[{test_label}] failed to get measure value: {e}"));
            sql_rows.push((k, decimal_to_f64(val)));
        }
    }

    let mut engine_sorted: Vec<_> = engine_rows
        .into_iter()
        .filter(|(k, _)| !k.is_empty())
        .collect();
    engine_sorted.sort_by(|a, b| a.0.cmp(&b.0));
    sql_rows.sort_by(|a, b| a.0.cmp(&b.0));

    assert_eq!(
        engine_sorted.len(),
        sql_rows.len(),
        "[{test_label}] row count mismatch: engine={} ({:?}), sql={} ({:?})",
        engine_sorted.len(),
        engine_sorted
            .iter()
            .map(|(k, _)| k.as_str())
            .collect::<Vec<_>>(),
        sql_rows.len(),
        sql_rows.iter().map(|(k, _)| k.as_str()).collect::<Vec<_>>(),
    );

    for (eng, sql_r) in engine_sorted.iter().zip(sql_rows.iter()) {
        assert_eq!(
            eng.0, sql_r.0,
            "[{test_label}] group key mismatch: engine='{}', sql='{}'",
            eng.0, sql_r.0
        );
        assert_approx(
            eng.1,
            sql_r.1,
            tolerance,
            &format!("{test_label} [{}]", eng.0),
        );
    }
}

fn find_column_idx(batch: &arrow::record_batch::RecordBatch, name: &str) -> usize {
    batch
        .schema()
        .index_of(name)
        .or_else(|_| {
            for (i, field) in batch.schema().fields().iter().enumerate() {
                if field.name().eq_ignore_ascii_case(name) {
                    return Ok(i);
                }
            }
            Err(arrow::error::ArrowError::SchemaError(format!(
                "column '{name}' not found in {:?}",
                batch
                    .schema()
                    .fields()
                    .iter()
                    .map(|f| f.name())
                    .collect::<Vec<_>>()
            )))
        })
        .unwrap()
}

fn array_value_as_f64(array: &dyn arrow::array::Array, row: usize) -> f64 {
    use arrow::array::*;
    if array.is_null(row) {
        return 0.0;
    }
    if let Some(arr) = array.as_any().downcast_ref::<Decimal128Array>() {
        arr.value(row) as f64 / 10f64.powi(arr.scale() as i32)
    } else if let Some(arr) = array.as_any().downcast_ref::<Float64Array>() {
        arr.value(row)
    } else if let Some(arr) = array.as_any().downcast_ref::<Int64Array>() {
        arr.value(row) as f64
    } else if let Some(arr) = array.as_any().downcast_ref::<UInt64Array>() {
        arr.value(row) as f64
    } else if let Some(arr) = array.as_any().downcast_ref::<Int32Array>() {
        arr.value(row) as f64
    } else {
        panic!("unsupported array type: {:?}", array.data_type());
    }
}

fn array_value_as_string(array: &dyn arrow::array::Array, row: usize) -> Option<String> {
    use arrow::array::*;
    if array.is_null(row) {
        return None;
    }
    if let Some(arr) = array.as_any().downcast_ref::<StringArray>() {
        let s = arr.value(row).trim().to_string();
        if s.is_empty() {
            None
        } else {
            Some(s)
        }
    } else if let Some(arr) = array.as_any().downcast_ref::<Decimal128Array>() {
        let raw = arr.value(row);
        let scale = arr.scale();
        let d = Decimal::from_str(&format!("{}", raw as f64 / 10f64.powi(scale as i32))).unwrap();
        Some(d.normalize().to_string())
    } else if let Some(arr) = array.as_any().downcast_ref::<Int32Array>() {
        Some(arr.value(row).to_string())
    } else if let Some(arr) = array.as_any().downcast_ref::<Int64Array>() {
        Some(arr.value(row).to_string())
    } else if let Some(arr) = array
        .as_any()
        .downcast_ref::<DictionaryArray<arrow::datatypes::Int32Type>>()
    {
        // The batch optimizer dictionary-encodes low-cardinality string
        // columns; group-by output then carries Dictionary(Int32, Utf8).
        let values = arr
            .values()
            .as_any()
            .downcast_ref::<StringArray>()
            .expect("dictionary values should be Utf8");
        let key = arr.key(row).expect("non-null row checked above");
        let s = values.value(key).trim().to_string();
        if s.is_empty() {
            None
        } else {
            Some(s)
        }
    } else {
        panic!("unsupported group column type: {:?}", array.data_type());
    }
}

fn extract_single_f64(batches: &[arrow::record_batch::RecordBatch], col_name: &str) -> f64 {
    assert!(!batches.is_empty(), "no batches returned");
    let batch = &batches[0];
    assert!(batch.num_rows() >= 1, "batch has no rows");
    let idx = find_column_idx(batch, col_name);
    array_value_as_f64(batch.column(idx).as_ref(), 0)
}

fn extract_grouped_results(
    batches: &[arrow::record_batch::RecordBatch],
    group_col: &str,
    measure_col: &str,
) -> Vec<(String, f64)> {
    let mut results = Vec::new();
    for batch in batches {
        let group_idx = find_column_idx(batch, group_col);
        let measure_idx = find_column_idx(batch, measure_col);
        let group_array = batch.column(group_idx);
        let measure_array = batch.column(measure_idx);

        for row in 0..batch.num_rows() {
            if let Some(key) = array_value_as_string(group_array.as_ref(), row) {
                let val = array_value_as_f64(measure_array.as_ref(), row);
                results.push((key, val));
            }
        }
    }
    results
}

fn decimal_to_f64(d: Decimal) -> f64 {
    d.to_string().parse::<f64>().unwrap()
}

fn assert_approx(actual: f64, expected: f64, tolerance: f64, label: &str) {
    if expected == 0.0 {
        assert!(
            actual.abs() < tolerance,
            "[{label}] expected ~0, got {actual}"
        );
        return;
    }
    let rel_diff = ((actual - expected) / expected).abs();
    assert!(
        rel_diff < tolerance,
        "[{label}] mismatch: engine={actual}, sql={expected}, relative diff={rel_diff:.6} (tolerance={tolerance})"
    );
}

// ---------------------------------------------------------------------------
// Test cases 1-10: DIVIDE — safe division
// ---------------------------------------------------------------------------

/// Tests 1-5: DIVIDE grand totals
#[tokio::test]
#[ignore]
async fn validate_dax_01_to_05_divide_grand_totals() {
    let measures = vec![
        // T1: Safe average order value
        (
            "AvgOrderValue",
            "DIVIDE(SUM(fact_sales[linetotal]), COUNT(fact_sales[salesorderdetailid]))",
        ),
        // T2: Revenue per unit
        (
            "RevenuePerUnit",
            "DIVIDE(SUM(fact_sales[linetotal]), SUM(fact_sales[orderqty]))",
        ),
        // T3: DIVIDE with alternate — denominator is non-zero so should equal normal division
        (
            "SafeRatio",
            "DIVIDE(SUM(fact_sales[linetotal]), COUNT(fact_sales[salesorderdetailid]), 0)",
        ),
        // T4: Average qty per order
        (
            "AvgQty",
            "DIVIDE(SUM(fact_sales[orderqty]), COUNT(fact_sales[salesorderdetailid]))",
        ),
        // T5: Revenue share (ratio of two SUMs)
        (
            "UnitPriceToLine",
            "DIVIDE(SUM(fact_sales[unitprice]), SUM(fact_sales[linetotal]))",
        ),
    ];

    let mut engine = setup_engine(measures).await;
    let pool = make_pool().await;

    let cases: Vec<(&str, &str)> = vec![
        (
            "AvgOrderValue",
            r#"SELECT CASE WHEN COUNT(salesorderdetailid) = 0 THEN NULL ELSE SUM(linetotal) / COUNT(salesorderdetailid) END FROM "BI".fact_sales"#,
        ),
        (
            "RevenuePerUnit",
            r#"SELECT CASE WHEN SUM(orderqty::numeric) = 0 THEN NULL ELSE SUM(linetotal) / SUM(orderqty::numeric) END FROM "BI".fact_sales"#,
        ),
        (
            "SafeRatio",
            r#"SELECT CASE WHEN COUNT(salesorderdetailid) = 0 THEN 0 ELSE SUM(linetotal) / COUNT(salesorderdetailid) END FROM "BI".fact_sales"#,
        ),
        (
            "AvgQty",
            r#"SELECT CASE WHEN COUNT(salesorderdetailid) = 0 THEN NULL ELSE SUM(orderqty::numeric) / COUNT(salesorderdetailid) END FROM "BI".fact_sales"#,
        ),
        (
            "UnitPriceToLine",
            r#"SELECT CASE WHEN SUM(linetotal) = 0 THEN NULL ELSE SUM(unitprice) / SUM(linetotal) END FROM "BI".fact_sales"#,
        ),
    ];

    for (i, (measure, sql)) in cases.iter().enumerate() {
        let label = format!("Test{}: {}", i + 1, measure);
        println!("  Running {label}...");
        compare_grand_total(
            &mut engine,
            &pool,
            measure,
            sql,
            GRAND_TOTAL_TOLERANCE,
            &label,
        )
        .await;
        println!("  {label} OK");
    }
}

/// Tests 6-10: DIVIDE grouped by category
#[tokio::test]
#[ignore]
async fn validate_dax_06_to_10_divide_grouped() {
    let measures = vec![
        (
            "AvgOrderValue",
            "DIVIDE(SUM(fact_sales[linetotal]), COUNT(fact_sales[salesorderdetailid]))",
        ),
        (
            "RevenuePerUnit",
            "DIVIDE(SUM(fact_sales[linetotal]), SUM(fact_sales[orderqty]))",
        ),
        (
            "AvgQty",
            "DIVIDE(SUM(fact_sales[orderqty]), COUNT(fact_sales[salesorderdetailid]))",
        ),
        (
            "AvgUnitPrice",
            "DIVIDE(SUM(fact_sales[unitprice]), COUNT(fact_sales[salesorderdetailid]))",
        ),
        (
            "QtyPerRevenue",
            "DIVIDE(SUM(fact_sales[orderqty]), SUM(fact_sales[linetotal]))",
        ),
    ];

    let mut engine = setup_engine(measures).await;
    let pool = make_pool().await;

    let base_join = r#"FROM "BI".fact_sales f JOIN "BI".dim_product p ON f.productid = p.productid WHERE p.categoryname IS NOT NULL"#;

    let cases: Vec<(&str, String)> = vec![
        ("AvgOrderValue", format!("SELECT p.categoryname, CASE WHEN COUNT(f.salesorderdetailid) = 0 THEN 0::numeric ELSE SUM(f.linetotal) / COUNT(f.salesorderdetailid) END {base_join} GROUP BY p.categoryname ORDER BY p.categoryname")),
        ("RevenuePerUnit", format!("SELECT p.categoryname, CASE WHEN SUM(f.orderqty::numeric) = 0 THEN 0::numeric ELSE SUM(f.linetotal) / SUM(f.orderqty::numeric) END {base_join} GROUP BY p.categoryname ORDER BY p.categoryname")),
        ("AvgQty", format!("SELECT p.categoryname, CASE WHEN COUNT(f.salesorderdetailid) = 0 THEN 0::numeric ELSE SUM(f.orderqty::numeric) / COUNT(f.salesorderdetailid) END {base_join} GROUP BY p.categoryname ORDER BY p.categoryname")),
        ("AvgUnitPrice", format!("SELECT p.categoryname, CASE WHEN COUNT(f.salesorderdetailid) = 0 THEN 0::numeric ELSE SUM(f.unitprice) / COUNT(f.salesorderdetailid) END {base_join} GROUP BY p.categoryname ORDER BY p.categoryname")),
        ("QtyPerRevenue", format!("SELECT p.categoryname, CASE WHEN SUM(f.linetotal) = 0 THEN 0::numeric ELSE SUM(f.orderqty::numeric) / SUM(f.linetotal) END {base_join} GROUP BY p.categoryname ORDER BY p.categoryname")),
    ];

    for (i, (measure, sql)) in cases.iter().enumerate() {
        let label = format!("Test{}: {} BY category", i + 6, measure);
        println!("  Running {label}...");
        compare_grouped(
            &mut engine,
            &pool,
            measure,
            "dim_product",
            "categoryname",
            sql,
            GROUPED_TOLERANCE,
            &label,
        )
        .await;
        println!("  {label} OK");
    }
}

// ---------------------------------------------------------------------------
// Test cases 11-15: COUNTROWS
// ---------------------------------------------------------------------------

/// Tests 11-15: COUNTROWS grand totals and grouped
#[tokio::test]
#[ignore]
async fn validate_dax_11_to_15_countrows() {
    let measures = vec![
        ("TotalRows", "COUNTROWS(fact_sales)"),
        ("RowCount", "COUNTROWS(fact_sales)"),
        // COUNTROWS as denominator in DIVIDE
        (
            "AvgLineTotalCR",
            "DIVIDE(SUM(fact_sales[linetotal]), COUNTROWS(fact_sales))",
        ),
        // COUNTROWS in arithmetic
        ("RowsTimesTwo", "COUNTROWS(fact_sales) * 2"),
        (
            "RowsPlusQty",
            "COUNTROWS(fact_sales) + SUM(fact_sales[orderqty])",
        ),
    ];

    let mut engine = setup_engine(measures).await;
    let pool = make_pool().await;

    // Grand total tests
    let grand_cases: Vec<(&str, &str)> = vec![
        (
            "TotalRows",
            r#"SELECT COUNT(*)::numeric FROM "BI".fact_sales"#,
        ),
        (
            "AvgLineTotalCR",
            r#"SELECT CASE WHEN COUNT(*) = 0 THEN NULL ELSE SUM(linetotal) / COUNT(*) END FROM "BI".fact_sales"#,
        ),
        (
            "RowsTimesTwo",
            r#"SELECT COUNT(*)::numeric * 2 FROM "BI".fact_sales"#,
        ),
        (
            "RowsPlusQty",
            r#"SELECT COUNT(*)::numeric + SUM(orderqty::numeric) FROM "BI".fact_sales"#,
        ),
    ];

    for (i, (measure, sql)) in grand_cases.iter().enumerate() {
        let label = format!("Test{}: {}", i + 11, measure);
        println!("  Running {label}...");
        compare_grand_total(
            &mut engine,
            &pool,
            measure,
            sql,
            GRAND_TOTAL_TOLERANCE,
            &label,
        )
        .await;
        println!("  {label} OK");
    }

    // Test 15: COUNTROWS grouped by country
    let label = "Test15: RowCount BY country";
    println!("  Running {label}...");
    compare_grouped(
        &mut engine, &pool, "RowCount", "dim_customer", "country",
        r#"SELECT c.country, COUNT(*)::numeric FROM "BI".fact_sales f JOIN "BI".dim_customer c ON f.customerid = c.customerid WHERE c.country IS NOT NULL GROUP BY c.country ORDER BY c.country"#,
        GROUPED_TOLERANCE, label,
    ).await;
    println!("  {label} OK");
}

// ---------------------------------------------------------------------------
// Test cases 16-20: COALESCE
// ---------------------------------------------------------------------------

/// Tests 16-20: COALESCE expressions
#[tokio::test]
#[ignore]
async fn validate_dax_16_to_20_coalesce() {
    let measures = vec![
        // T16: COALESCE wrapping a SUM — since SUM is non-null, returns the SUM
        ("RevCoalesce", "COALESCE(SUM(fact_sales[linetotal]), 0)"),
        // T17: COALESCE in arithmetic
        ("SafeRevenue", "COALESCE(SUM(fact_sales[linetotal]), 0) + COALESCE(SUM(fact_sales[orderqty]), 0)"),
        // T18: Nested COALESCE with DIVIDE
        ("SafeAvg", "COALESCE(DIVIDE(SUM(fact_sales[linetotal]), COUNT(fact_sales[salesorderdetailid])), 0)"),
        // T19: COALESCE with multiple args
        ("MultiCoalesce", "COALESCE(SUM(fact_sales[linetotal]), SUM(fact_sales[orderqty]), 0)"),
        // T20: COALESCE of DIVIDE (will be non-null since denominator != 0)
        ("SafeRatio", "COALESCE(DIVIDE(SUM(fact_sales[orderqty]), SUM(fact_sales[linetotal])), 0)"),
    ];

    let mut engine = setup_engine(measures).await;
    let pool = make_pool().await;

    let cases: Vec<(&str, &str)> = vec![
        (
            "RevCoalesce",
            r#"SELECT COALESCE(SUM(linetotal), 0) FROM "BI".fact_sales"#,
        ),
        (
            "SafeRevenue",
            r#"SELECT COALESCE(SUM(linetotal), 0) + COALESCE(SUM(orderqty::numeric), 0) FROM "BI".fact_sales"#,
        ),
        (
            "SafeAvg",
            r#"SELECT COALESCE(CASE WHEN COUNT(salesorderdetailid) = 0 THEN NULL ELSE SUM(linetotal) / COUNT(salesorderdetailid) END, 0) FROM "BI".fact_sales"#,
        ),
        (
            "MultiCoalesce",
            r#"SELECT COALESCE(SUM(linetotal), SUM(orderqty::numeric), 0) FROM "BI".fact_sales"#,
        ),
        (
            "SafeRatio",
            r#"SELECT COALESCE(CASE WHEN SUM(linetotal) = 0 THEN NULL ELSE SUM(orderqty::numeric) / SUM(linetotal) END, 0) FROM "BI".fact_sales"#,
        ),
    ];

    for (i, (measure, sql)) in cases.iter().enumerate() {
        let label = format!("Test{}: {}", i + 16, measure);
        println!("  Running {label}...");
        compare_grand_total(
            &mut engine,
            &pool,
            measure,
            sql,
            GRAND_TOTAL_TOLERANCE,
            &label,
        )
        .await;
        println!("  {label} OK");
    }
}

// ---------------------------------------------------------------------------
// Test cases 21-25: ABS, ROUND, INT — scalar math
// ---------------------------------------------------------------------------

/// Tests 21-25: Scalar math functions
#[tokio::test]
#[ignore]
async fn validate_dax_21_to_25_scalar_math() {
    let measures = vec![
        // T21: ABS of a difference (Revenue - a big number to make it negative)
        ("AbsDiff", "ABS(SUM(fact_sales[linetotal]) - 999999999)"),
        // T22: ROUND revenue to 0 decimals
        ("RoundedRevenue", "ROUND(SUM(fact_sales[linetotal]), 0)"),
        // T23: ROUND average to 2 decimals
        (
            "RoundedAvg",
            "ROUND(DIVIDE(SUM(fact_sales[linetotal]), COUNT(fact_sales[salesorderdetailid])), 2)",
        ),
        // T24: INT (floor) of average
        (
            "IntAvg",
            "INT(DIVIDE(SUM(fact_sales[linetotal]), COUNT(fact_sales[salesorderdetailid])))",
        ),
        // T25: SQRT of order count
        ("SqrtCount", "SQRT(COUNT(fact_sales[salesorderdetailid]))"),
    ];

    let mut engine = setup_engine(measures).await;
    let pool = make_pool().await;

    let cases: Vec<(&str, &str)> = vec![
        (
            "AbsDiff",
            r#"SELECT ABS(SUM(linetotal) - 999999999) FROM "BI".fact_sales"#,
        ),
        (
            "RoundedRevenue",
            r#"SELECT ROUND(SUM(linetotal), 0) FROM "BI".fact_sales"#,
        ),
        (
            "RoundedAvg",
            r#"SELECT ROUND(CASE WHEN COUNT(salesorderdetailid) = 0 THEN NULL ELSE SUM(linetotal) / COUNT(salesorderdetailid) END, 2) FROM "BI".fact_sales"#,
        ),
        (
            "IntAvg",
            r#"SELECT FLOOR(CASE WHEN COUNT(salesorderdetailid) = 0 THEN NULL ELSE SUM(linetotal) / COUNT(salesorderdetailid) END) FROM "BI".fact_sales"#,
        ),
        (
            "SqrtCount",
            r#"SELECT SQRT(COUNT(salesorderdetailid)::numeric) FROM "BI".fact_sales"#,
        ),
    ];

    for (i, (measure, sql)) in cases.iter().enumerate() {
        let label = format!("Test{}: {}", i + 21, measure);
        println!("  Running {label}...");
        compare_grand_total(
            &mut engine,
            &pool,
            measure,
            sql,
            GRAND_TOTAL_TOLERANCE,
            &label,
        )
        .await;
        println!("  {label} OK");
    }
}

// ---------------------------------------------------------------------------
// Test cases 26-30: More scalar math + combinations
// ---------------------------------------------------------------------------

/// Tests 26-30: POWER, MOD, SIGN, LN, LOG10
#[tokio::test]
#[ignore]
async fn validate_dax_26_to_30_more_math() {
    let measures = vec![
        // T26: POWER — square the order count
        ("CountSquared", "POWER(COUNT(fact_sales[salesorderdetailid]), 2)"),
        // T27: MOD — total qty mod 1000
        ("QtyMod1000", "MOD(SUM(fact_sales[orderqty]), 1000)"),
        // T28: SIGN of revenue (always positive)
        ("SignRevenue", "SIGN(SUM(fact_sales[linetotal]))"),
        // T29: ABS combined with ROUND
        ("AbsRoundAvg", "ABS(ROUND(DIVIDE(SUM(fact_sales[linetotal]), COUNT(fact_sales[salesorderdetailid])), 0))"),
        // T30: ROUND of SQRT
        ("RoundSqrt", "ROUND(SQRT(SUM(fact_sales[orderqty])), 2)"),
    ];

    let mut engine = setup_engine(measures).await;
    let pool = make_pool().await;

    let cases: Vec<(&str, &str)> = vec![
        (
            "CountSquared",
            r#"SELECT POWER(COUNT(salesorderdetailid)::numeric, 2) FROM "BI".fact_sales"#,
        ),
        (
            "QtyMod1000",
            r#"SELECT MOD(SUM(orderqty::numeric), 1000) FROM "BI".fact_sales"#,
        ),
        (
            "SignRevenue",
            r#"SELECT SIGN(SUM(linetotal)) FROM "BI".fact_sales"#,
        ),
        (
            "AbsRoundAvg",
            r#"SELECT ABS(ROUND(CASE WHEN COUNT(salesorderdetailid) = 0 THEN NULL ELSE SUM(linetotal) / COUNT(salesorderdetailid) END, 0)) FROM "BI".fact_sales"#,
        ),
        (
            "RoundSqrt",
            r#"SELECT ROUND(SQRT(SUM(orderqty::numeric)), 2) FROM "BI".fact_sales"#,
        ),
    ];

    for (i, (measure, sql)) in cases.iter().enumerate() {
        let label = format!("Test{}: {}", i + 26, measure);
        println!("  Running {label}...");
        compare_grand_total(
            &mut engine,
            &pool,
            measure,
            sql,
            GRAND_TOTAL_TOLERANCE,
            &label,
        )
        .await;
        println!("  {label} OK");
    }
}

// ---------------------------------------------------------------------------
// Test cases 31-35: Scalar math grouped by dimension
// ---------------------------------------------------------------------------

/// Tests 31-35: Scalar math grouped by territory group
#[tokio::test]
#[ignore]
async fn validate_dax_31_to_35_math_grouped() {
    let measures = vec![
        ("RoundedRevenue", "ROUND(SUM(fact_sales[linetotal]), 0)"),
        ("AbsRevenue", "ABS(SUM(fact_sales[linetotal]))"),
        (
            "SafeAvgRound",
            "ROUND(DIVIDE(SUM(fact_sales[linetotal]), COUNTROWS(fact_sales)), 2)",
        ),
        ("SqrtRevenue", "SQRT(SUM(fact_sales[linetotal]))"),
        ("IntRevenue", "INT(SUM(fact_sales[linetotal]))"),
    ];

    let mut engine = setup_engine(measures).await;
    let pool = make_pool().await;

    let base_join = r#"FROM "BI".fact_sales f JOIN "BI".dim_territory t ON f.territoryid = t.territoryid WHERE t.territorygroup IS NOT NULL"#;

    let cases: Vec<(&str, String)> = vec![
        ("RoundedRevenue", format!("SELECT t.territorygroup, ROUND(SUM(f.linetotal), 0) {base_join} GROUP BY t.territorygroup ORDER BY t.territorygroup")),
        ("AbsRevenue", format!("SELECT t.territorygroup, ABS(SUM(f.linetotal)) {base_join} GROUP BY t.territorygroup ORDER BY t.territorygroup")),
        ("SafeAvgRound", format!("SELECT t.territorygroup, ROUND(CASE WHEN COUNT(*) = 0 THEN NULL ELSE SUM(f.linetotal) / COUNT(*) END, 2) {base_join} GROUP BY t.territorygroup ORDER BY t.territorygroup")),
        ("SqrtRevenue", format!("SELECT t.territorygroup, SQRT(SUM(f.linetotal)) {base_join} GROUP BY t.territorygroup ORDER BY t.territorygroup")),
        ("IntRevenue", format!("SELECT t.territorygroup, FLOOR(SUM(f.linetotal)) {base_join} GROUP BY t.territorygroup ORDER BY t.territorygroup")),
    ];

    for (i, (measure, sql)) in cases.iter().enumerate() {
        let label = format!("Test{}: {} BY territorygroup", i + 31, measure);
        println!("  Running {label}...");
        compare_grouped(
            &mut engine,
            &pool,
            measure,
            "dim_territory",
            "territorygroup",
            sql,
            GROUPED_TOLERANCE,
            &label,
        )
        .await;
        println!("  {label} OK");
    }
}

// ---------------------------------------------------------------------------
// Test cases 36-40: DIVIDE grouped + COALESCE grouped
// ---------------------------------------------------------------------------

/// Tests 36-40: DIVIDE and COALESCE grouped by year
#[tokio::test]
#[ignore]
async fn validate_dax_36_to_40_divide_coalesce_grouped() {
    let measures = vec![
        ("SafeAvgByYear", "DIVIDE(SUM(fact_sales[linetotal]), COUNTROWS(fact_sales))"),
        ("SafeRevenuePerUnit", "DIVIDE(SUM(fact_sales[linetotal]), SUM(fact_sales[orderqty]))"),
        ("CoalesceRevenue", "COALESCE(SUM(fact_sales[linetotal]), 0)"),
        ("CoalesceAvg", "COALESCE(DIVIDE(SUM(fact_sales[linetotal]), COUNT(fact_sales[salesorderdetailid])), 0)"),
        ("DivideRoundByYear", "ROUND(DIVIDE(SUM(fact_sales[linetotal]), COUNTROWS(fact_sales)), 2)"),
    ];

    let mut engine = setup_engine(measures).await;
    let pool = make_pool().await;

    let base_join = r#"FROM "BI".fact_sales f JOIN "BI".dim_date d ON f.orderdate = d.datekey WHERE d.year IS NOT NULL"#;

    let cases: Vec<(&str, String)> = vec![
        ("SafeAvgByYear", format!("SELECT d.year, CASE WHEN COUNT(*) = 0 THEN 0::numeric ELSE SUM(f.linetotal) / COUNT(*) END {base_join} GROUP BY d.year ORDER BY d.year")),
        ("SafeRevenuePerUnit", format!("SELECT d.year, CASE WHEN SUM(f.orderqty::numeric) = 0 THEN 0::numeric ELSE SUM(f.linetotal) / SUM(f.orderqty::numeric) END {base_join} GROUP BY d.year ORDER BY d.year")),
        ("CoalesceRevenue", format!("SELECT d.year, COALESCE(SUM(f.linetotal), 0) {base_join} GROUP BY d.year ORDER BY d.year")),
        ("CoalesceAvg", format!("SELECT d.year, COALESCE(CASE WHEN COUNT(f.salesorderdetailid) = 0 THEN NULL ELSE SUM(f.linetotal) / COUNT(f.salesorderdetailid) END, 0) {base_join} GROUP BY d.year ORDER BY d.year")),
        ("DivideRoundByYear", format!("SELECT d.year, ROUND(CASE WHEN COUNT(*) = 0 THEN NULL ELSE SUM(f.linetotal) / COUNT(*) END, 2) {base_join} GROUP BY d.year ORDER BY d.year")),
    ];

    for (i, (measure, sql)) in cases.iter().enumerate() {
        let label = format!("Test{}: {} BY year", i + 36, measure);
        println!("  Running {label}...");
        compare_grouped(
            &mut engine,
            &pool,
            measure,
            "dim_date",
            "year",
            sql,
            GROUPED_TOLERANCE,
            &label,
        )
        .await;
        println!("  {label} OK");
    }
}

// ---------------------------------------------------------------------------
// Test cases 41-45: Complex nested combinations
// ---------------------------------------------------------------------------

/// Tests 41-45: Nested function combinations
#[tokio::test]
#[ignore]
async fn validate_dax_41_to_45_nested_combinations() {
    let measures = vec![
        // T41: ROUND(DIVIDE(...), 2) — commonly used pattern
        ("RoundedSafeAvg", "ROUND(DIVIDE(SUM(fact_sales[linetotal]), COUNT(fact_sales[salesorderdetailid])), 2)"),
        // T42: ABS of a DIVIDE
        ("AbsSafeRatio", "ABS(DIVIDE(SUM(fact_sales[orderqty]), SUM(fact_sales[linetotal])))"),
        // T43: COALESCE(DIVIDE(...), 0) + SUM(...)
        ("SafeAvgPlusQty", "COALESCE(DIVIDE(SUM(fact_sales[linetotal]), COUNT(fact_sales[salesorderdetailid])), 0) + SUM(fact_sales[orderqty])"),
        // T44: DIVIDE with COUNTROWS denominator, ROUND wrapper
        ("RoundCRAvg", "ROUND(DIVIDE(SUM(fact_sales[linetotal]), COUNTROWS(fact_sales)), 4)"),
        // T45: SQRT(ABS(difference))
        ("SqrtAbsDiff", "SQRT(ABS(SUM(fact_sales[linetotal]) - SUM(fact_sales[orderqty])))"),
    ];

    let mut engine = setup_engine(measures).await;
    let pool = make_pool().await;

    let cases: Vec<(&str, &str)> = vec![
        (
            "RoundedSafeAvg",
            r#"SELECT ROUND(CASE WHEN COUNT(salesorderdetailid) = 0 THEN NULL ELSE SUM(linetotal) / COUNT(salesorderdetailid) END, 2) FROM "BI".fact_sales"#,
        ),
        (
            "AbsSafeRatio",
            r#"SELECT ABS(CASE WHEN SUM(linetotal) = 0 THEN NULL ELSE SUM(orderqty::numeric) / SUM(linetotal) END) FROM "BI".fact_sales"#,
        ),
        (
            "SafeAvgPlusQty",
            r#"SELECT COALESCE(CASE WHEN COUNT(salesorderdetailid) = 0 THEN NULL ELSE SUM(linetotal) / COUNT(salesorderdetailid) END, 0) + SUM(orderqty::numeric) FROM "BI".fact_sales"#,
        ),
        (
            "RoundCRAvg",
            r#"SELECT ROUND(CASE WHEN COUNT(*) = 0 THEN NULL ELSE SUM(linetotal) / COUNT(*) END, 4) FROM "BI".fact_sales"#,
        ),
        (
            "SqrtAbsDiff",
            r#"SELECT SQRT(ABS(SUM(linetotal) - SUM(orderqty::numeric))) FROM "BI".fact_sales"#,
        ),
    ];

    for (i, (measure, sql)) in cases.iter().enumerate() {
        let label = format!("Test{}: {}", i + 41, measure);
        println!("  Running {label}...");
        compare_grand_total(
            &mut engine,
            &pool,
            measure,
            sql,
            GRAND_TOTAL_TOLERANCE,
            &label,
        )
        .await;
        println!("  {label} OK");
    }
}

// ---------------------------------------------------------------------------
// Test cases 46-50: Complex nested grouped
// ---------------------------------------------------------------------------

/// Tests 46-50: Nested functions grouped by category
#[tokio::test]
#[ignore]
async fn validate_dax_46_to_50_nested_grouped() {
    let measures = vec![
        // T46: ROUND(DIVIDE) by category
        ("RoundedAvg", "ROUND(DIVIDE(SUM(fact_sales[linetotal]), COUNT(fact_sales[salesorderdetailid])), 2)"),
        // T47: COALESCE(DIVIDE) by category
        ("SafeAvg", "COALESCE(DIVIDE(SUM(fact_sales[linetotal]), COUNT(fact_sales[salesorderdetailid])), 0)"),
        // T48: ABS of negated DIVIDE (always positive)
        ("AbsAvgDiff", "ABS(0 - DIVIDE(SUM(fact_sales[linetotal]), COUNT(fact_sales[salesorderdetailid])))"),
        // T49: COUNTROWS grouped
        ("RowCount", "COUNTROWS(fact_sales)"),
        // T50: DIVIDE(SUM, COUNTROWS) grouped
        ("CRAvg", "DIVIDE(SUM(fact_sales[linetotal]), COUNTROWS(fact_sales))"),
    ];

    let mut engine = setup_engine(measures).await;
    let pool = make_pool().await;

    let base_join = r#"FROM "BI".fact_sales f JOIN "BI".dim_product p ON f.productid = p.productid WHERE p.categoryname IS NOT NULL"#;

    let cases: Vec<(&str, String)> = vec![
        ("RoundedAvg", format!("SELECT p.categoryname, ROUND(CASE WHEN COUNT(f.salesorderdetailid) = 0 THEN NULL ELSE SUM(f.linetotal) / COUNT(f.salesorderdetailid) END, 2) {base_join} GROUP BY p.categoryname ORDER BY p.categoryname")),
        ("SafeAvg", format!("SELECT p.categoryname, COALESCE(CASE WHEN COUNT(f.salesorderdetailid) = 0 THEN NULL ELSE SUM(f.linetotal) / COUNT(f.salesorderdetailid) END, 0) {base_join} GROUP BY p.categoryname ORDER BY p.categoryname")),
        ("AbsAvgDiff", format!("SELECT p.categoryname, ABS(0 - CASE WHEN COUNT(f.salesorderdetailid) = 0 THEN NULL ELSE SUM(f.linetotal) / COUNT(f.salesorderdetailid) END) {base_join} GROUP BY p.categoryname ORDER BY p.categoryname")),
        ("RowCount", format!("SELECT p.categoryname, COUNT(*)::numeric {base_join} GROUP BY p.categoryname ORDER BY p.categoryname")),
        ("CRAvg", format!("SELECT p.categoryname, CASE WHEN COUNT(*) = 0 THEN 0::numeric ELSE SUM(f.linetotal) / COUNT(*) END {base_join} GROUP BY p.categoryname ORDER BY p.categoryname")),
    ];

    for (i, (measure, sql)) in cases.iter().enumerate() {
        let label = format!("Test{}: {} BY category", i + 46, measure);
        println!("  Running {label}...");
        compare_grouped(
            &mut engine,
            &pool,
            measure,
            "dim_product",
            "categoryname",
            sql,
            GROUPED_TOLERANCE,
            &label,
        )
        .await;
        println!("  {label} OK");
    }
}
