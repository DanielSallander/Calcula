//! Combined feature validation tests — 20 test cases comparing engine results
//! against direct SQL queries on the AdventureWorks BI schema.
//!
//! Tests combinations of features that are individually tested elsewhere but
//! not tested together: QUERY-in-VAR + named contexts, QUERY + DAX functions,
//! QUERY with multiple aggregates, mixed scalar VAR + QUERY bindings,
//! and KEEP-on-intermediate + cross-dimension GROUP BY.
//!
//! Run with: `cargo test -p engine --test combined_validation -- --ignored --nocapture`

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

/// Tolerance for grand totals.
/// Combined features (QUERY + context + DAX functions) can compound precision diffs.
const GRAND_TOTAL_TOLERANCE: f64 = 0.04;
/// Tolerance for grouped queries.
const GROUPED_TOLERANCE: f64 = 0.05;

// ---------------------------------------------------------------------------
// Model setup — includes named contexts for combined testing
// ---------------------------------------------------------------------------

fn build_model(measures: Vec<(&str, &str)>) -> EngineResult<DataModel> {
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

    // Named contexts for combined tests.
    let ctx_defs: Vec<(&str, &str)> = vec![
        (
            "ctx_bikes",
            r#"KEEP(dim_product, dim_product[categoryname] = "Bikes")"#,
        ),
        (
            "ctx_accessories",
            r#"KEEP(dim_product, dim_product[categoryname] = "Accessories")"#,
        ),
        ("ctx_2014", "KEEP(dim_date, dim_date[year] = 2014)"),
        ("ctx_2013", "KEEP(dim_date, dim_date[year] = 2013)"),
        (
            "ctx_us",
            r#"KEEP(dim_customer, dim_customer[country] = "United States")"#,
        ),
    ];

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

    // Add named contexts.
    for (name, expr_text) in &ctx_defs {
        let ctx = parse_context(name, expr_text)
            .unwrap_or_else(|e| panic!("Failed to parse CONTEXT '{name}': {e}"));
        builder = builder.add_context(ctx);
    }

    // Add measures.
    for (name, expr_text) in &measures {
        let expr = parse_measure(expr_text)
            .unwrap_or_else(|e| panic!("Failed to parse measure '{name}': {e}"));
        builder = builder.add_measure(expression_measure(*name, expr));
    }

    builder.build()
}

async fn setup_engine(measures: Vec<(&str, &str)>) -> Engine {
    let model = build_model(measures).expect("failed to build model");
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
// Test cases 1-5: QUERY-in-VAR + named contexts (grand totals)
//
// QUERY source data is filtered by a named context, then two-stage
// aggregation runs on the filtered subset.
// ---------------------------------------------------------------------------

/// Tests 1-5: QUERY bindings where the source aggregate uses a named context
/// to filter to a subset (e.g., only Bikes, only 2014, only US customers).
#[tokio::test]
#[ignore]
async fn validate_01_to_05_query_with_named_context() {
    let measures = vec![
        // 1: Avg monthly bikes revenue — QUERY(SUM bikes) by month, then AVG
        (
            "AvgMonthlyBikesRev",
            r#"VAR monthly = QUERY(SUM(fact_sales[linetotal], ctx_bikes) AS revenue BY dim_date[year], dim_date[month]) RETURN AVG(monthly[revenue])"#,
        ),
        // 2: Max monthly accessories revenue
        (
            "MaxMonthlyAccRev",
            r#"VAR monthly = QUERY(SUM(fact_sales[linetotal], ctx_accessories) AS revenue BY dim_date[year], dim_date[month]) RETURN MAX(monthly[revenue])"#,
        ),
        // 3: Avg quarterly revenue for 2014 only
        (
            "AvgQtr2014Rev",
            r#"VAR quarterly = QUERY(SUM(fact_sales[linetotal], ctx_2014) AS revenue BY dim_date[quarter]) RETURN AVG(quarterly[revenue])"#,
        ),
        // 4: Count of months with US sales
        (
            "USMonthCount",
            r#"VAR monthly = QUERY(SUM(fact_sales[linetotal], ctx_us) AS revenue BY dim_date[year], dim_date[month]) RETURN COUNTROWS(monthly)"#,
        ),
        // 5: Sum of yearly bikes revenue (should equal total bikes revenue)
        (
            "SumYearlyBikesRev",
            r#"VAR by_year = QUERY(SUM(fact_sales[linetotal], ctx_bikes) AS revenue BY dim_date[year]) RETURN SUM(by_year[revenue])"#,
        ),
    ];

    let mut engine = setup_engine(measures).await;
    let pool = make_pool().await;

    let cases: Vec<(&str, &str)> = vec![
        (
            "AvgMonthlyBikesRev",
            r#"SELECT AVG(monthly_rev) FROM (SELECT SUM(f.linetotal) AS monthly_rev FROM "BI".fact_sales f JOIN "BI".dim_date d ON f.orderdate = d.datekey JOIN "BI".dim_product p ON f.productid = p.productid WHERE p.categoryname = 'Bikes' GROUP BY d.year, d.month) sub"#,
        ),
        (
            "MaxMonthlyAccRev",
            r#"SELECT MAX(monthly_rev) FROM (SELECT SUM(f.linetotal) AS monthly_rev FROM "BI".fact_sales f JOIN "BI".dim_date d ON f.orderdate = d.datekey JOIN "BI".dim_product p ON f.productid = p.productid WHERE p.categoryname = 'Accessories' GROUP BY d.year, d.month) sub"#,
        ),
        (
            "AvgQtr2014Rev",
            r#"SELECT AVG(qtr_rev) FROM (SELECT d.quarter, SUM(f.linetotal) AS qtr_rev FROM "BI".fact_sales f JOIN "BI".dim_date d ON f.orderdate = d.datekey WHERE d.year = 2014 GROUP BY d.quarter) sub"#,
        ),
        (
            "USMonthCount",
            r#"SELECT COUNT(*)::numeric FROM (SELECT SUM(f.linetotal) AS monthly_rev FROM "BI".fact_sales f JOIN "BI".dim_date d ON f.orderdate = d.datekey JOIN "BI".dim_customer c ON f.customerid = c.customerid WHERE c.country = 'United States' GROUP BY d.year, d.month) sub"#,
        ),
        (
            "SumYearlyBikesRev",
            r#"SELECT SUM(yr_rev) FROM (SELECT SUM(f.linetotal) AS yr_rev FROM "BI".fact_sales f JOIN "BI".dim_date d ON f.orderdate = d.datekey JOIN "BI".dim_product p ON f.productid = p.productid WHERE p.categoryname = 'Bikes' GROUP BY d.year) sub"#,
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

// ---------------------------------------------------------------------------
// Test cases 6-10: QUERY + DAX functions on results (grand totals)
//
// Apply DIVIDE, ROUND, and arithmetic to QUERY intermediate results.
// ---------------------------------------------------------------------------

/// Tests 6-10: DAX functions (DIVIDE, ROUND) applied to QUERY binding results
#[tokio::test]
#[ignore]
async fn validate_06_to_10_query_with_dax_functions() {
    let measures = vec![
        // 6: DIVIDE(MAX monthly, MIN monthly) — ratio of peak to trough
        (
            "PeakToTrough",
            r#"VAR monthly = QUERY(SUM(fact_sales[linetotal]) AS revenue BY dim_date[year], dim_date[month]) RETURN DIVIDE(MAX(monthly[revenue]), MIN(monthly[revenue]))"#,
        ),
        // 7: ROUND(AVG monthly revenue, 0) — rounded avg monthly
        (
            "RoundedAvgMonthly",
            r#"VAR monthly = QUERY(SUM(fact_sales[linetotal]) AS revenue BY dim_date[year], dim_date[month]) RETURN ROUND(AVG(monthly[revenue]), 0)"#,
        ),
        // 8: Average monthly order qty
        (
            "AvgMonthlyQty",
            r#"VAR monthly = QUERY(SUM(fact_sales[orderqty]) AS qty BY dim_date[year], dim_date[month]) RETURN AVG(monthly[qty])"#,
        ),
        // 9: DIVIDE(SUM monthly revenue, COUNTROWS) — should equal AVG
        (
            "DivSumByCount",
            r#"VAR monthly = QUERY(SUM(fact_sales[linetotal]) AS revenue BY dim_date[year], dim_date[month]) RETURN DIVIDE(SUM(monthly[revenue]), COUNTROWS(monthly))"#,
        ),
        // 10: Max yearly revenue minus min yearly revenue (yearly range)
        (
            "YearlyRange",
            r#"VAR by_year = QUERY(SUM(fact_sales[linetotal]) AS revenue BY dim_date[year]) RETURN MAX(by_year[revenue]) - MIN(by_year[revenue])"#,
        ),
    ];

    let mut engine = setup_engine(measures).await;
    let pool = make_pool().await;

    let cases: Vec<(&str, &str)> = vec![
        (
            "PeakToTrough",
            r#"SELECT MAX(monthly_rev) / MIN(monthly_rev) FROM (SELECT SUM(f.linetotal) AS monthly_rev FROM "BI".fact_sales f JOIN "BI".dim_date d ON f.orderdate = d.datekey GROUP BY d.year, d.month) sub"#,
        ),
        (
            "RoundedAvgMonthly",
            r#"SELECT ROUND(AVG(monthly_rev), 0) FROM (SELECT SUM(f.linetotal) AS monthly_rev FROM "BI".fact_sales f JOIN "BI".dim_date d ON f.orderdate = d.datekey GROUP BY d.year, d.month) sub"#,
        ),
        (
            "AvgMonthlyQty",
            r#"SELECT AVG(monthly_qty) FROM (SELECT SUM(f.orderqty::numeric) AS monthly_qty FROM "BI".fact_sales f JOIN "BI".dim_date d ON f.orderdate = d.datekey GROUP BY d.year, d.month) sub"#,
        ),
        (
            "DivSumByCount",
            r#"SELECT SUM(monthly_rev) / COUNT(*)::numeric FROM (SELECT SUM(f.linetotal) AS monthly_rev FROM "BI".fact_sales f JOIN "BI".dim_date d ON f.orderdate = d.datekey GROUP BY d.year, d.month) sub"#,
        ),
        (
            "YearlyRange",
            r#"SELECT MAX(yr_rev) - MIN(yr_rev) FROM (SELECT SUM(f.linetotal) AS yr_rev FROM "BI".fact_sales f JOIN "BI".dim_date d ON f.orderdate = d.datekey GROUP BY d.year) sub"#,
        ),
    ];

    for (i, (measure, sql)) in cases.iter().enumerate() {
        let label = format!("Test{}: {}", i + 6, measure);
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
// Test cases 11-15: QUERY + named context + cross-dimension GROUP BY
//
// A QUERY filtered by a named context, then placed in a grouped query
// where the GROUP BY dimension is NOT in the QUERY's own GROUP BY.
// ---------------------------------------------------------------------------

/// Tests 11-15: QUERY + context + cross-dimension grouping
#[tokio::test]
#[ignore]
async fn validate_11_to_15_query_context_cross_dimension() {
    let measures = vec![
        // 11: Avg monthly bikes revenue, grouped by year (cross-dimension)
        //     QUERY groups by (year, month) filtered to Bikes.
        //     Outer GROUP BY = year. Year is IN the QUERY's GROUP BY, so no injection needed.
        (
            "AvgMonthlyBikesRev",
            r#"VAR monthly = QUERY(SUM(fact_sales[linetotal], ctx_bikes) AS revenue BY dim_date[year], dim_date[month]) RETURN AVG(monthly[revenue])"#,
        ),
        // 12: Avg monthly 2014 revenue, grouped by category (cross-dimension)
        //     QUERY groups by (year, month) filtered to 2014.
        //     Outer GROUP BY = category → category injected into QUERY.
        (
            "AvgMonthly2014RevByCat",
            r#"VAR monthly = QUERY(SUM(fact_sales[linetotal], ctx_2014) AS revenue BY dim_date[month]) RETURN AVG(monthly[revenue])"#,
        ),
        // 13: Max quarterly bikes revenue, grouped by year
        (
            "MaxQtrBikesRevByYear",
            r#"VAR quarterly = QUERY(SUM(fact_sales[linetotal], ctx_bikes) AS revenue BY dim_date[year], dim_date[quarter]) RETURN MAX(quarterly[revenue])"#,
        ),
        // 14: Count of months with US sales, grouped by year
        (
            "USMonthCountByYear",
            r#"VAR monthly = QUERY(SUM(fact_sales[linetotal], ctx_us) AS revenue BY dim_date[year], dim_date[month]) RETURN COUNTROWS(monthly)"#,
        ),
        // 15: Avg yearly accessories revenue, grouped by territory group (cross-dimension)
        (
            "AvgYearlyAccByTerr",
            r#"VAR by_year = QUERY(SUM(fact_sales[linetotal], ctx_accessories) AS revenue BY dim_date[year]) RETURN AVG(by_year[revenue])"#,
        ),
    ];

    let mut engine = setup_engine(measures).await;
    let pool = make_pool().await;

    // 11: AvgMonthlyBikesRev BY year — year is in QUERY's GROUP BY
    println!("  Running Test11: AvgMonthlyBikesRev BY year...");
    compare_grouped(
        &mut engine, &pool, "AvgMonthlyBikesRev", "dim_date", "year",
        r#"SELECT sub.year, AVG(sub.revenue) FROM (SELECT d.year, d.month, SUM(f.linetotal) AS revenue FROM "BI".fact_sales f JOIN "BI".dim_date d ON f.orderdate = d.datekey JOIN "BI".dim_product p ON f.productid = p.productid WHERE p.categoryname = 'Bikes' GROUP BY d.year, d.month) sub GROUP BY sub.year ORDER BY sub.year"#,
        GROUPED_TOLERANCE, "Test11: AvgMonthlyBikesRev BY year",
    ).await;
    println!("  Test11 OK");

    // 12: AvgMonthly2014RevByCat BY categoryname — category injected
    println!("  Running Test12: AvgMonthly2014RevByCat BY category...");
    compare_grouped(
        &mut engine, &pool, "AvgMonthly2014RevByCat", "dim_product", "categoryname",
        r#"SELECT sub.categoryname, AVG(sub.revenue) FROM (SELECT p.categoryname, d.month, SUM(f.linetotal) AS revenue FROM "BI".fact_sales f JOIN "BI".dim_date d ON f.orderdate = d.datekey JOIN "BI".dim_product p ON f.productid = p.productid WHERE d.year = 2014 AND p.categoryname IS NOT NULL GROUP BY p.categoryname, d.month) sub GROUP BY sub.categoryname ORDER BY sub.categoryname"#,
        GROUPED_TOLERANCE, "Test12: AvgMonthly2014RevByCat BY category",
    ).await;
    println!("  Test12 OK");

    // 13: MaxQtrBikesRevByYear BY year — year is in QUERY's GROUP BY
    println!("  Running Test13: MaxQtrBikesRevByYear BY year...");
    compare_grouped(
        &mut engine, &pool, "MaxQtrBikesRevByYear", "dim_date", "year",
        r#"SELECT sub.year, MAX(sub.revenue) FROM (SELECT d.year, d.quarter, SUM(f.linetotal) AS revenue FROM "BI".fact_sales f JOIN "BI".dim_date d ON f.orderdate = d.datekey JOIN "BI".dim_product p ON f.productid = p.productid WHERE p.categoryname = 'Bikes' GROUP BY d.year, d.quarter) sub GROUP BY sub.year ORDER BY sub.year"#,
        GROUPED_TOLERANCE, "Test13: MaxQtrBikesRevByYear BY year",
    ).await;
    println!("  Test13 OK");

    // 14: USMonthCountByYear BY year — year is in QUERY's GROUP BY
    println!("  Running Test14: USMonthCountByYear BY year...");
    compare_grouped(
        &mut engine, &pool, "USMonthCountByYear", "dim_date", "year",
        r#"SELECT sub.year, COUNT(*)::numeric FROM (SELECT d.year, d.month, SUM(f.linetotal) AS revenue FROM "BI".fact_sales f JOIN "BI".dim_date d ON f.orderdate = d.datekey JOIN "BI".dim_customer c ON f.customerid = c.customerid WHERE c.country = 'United States' GROUP BY d.year, d.month) sub GROUP BY sub.year ORDER BY sub.year"#,
        GROUPED_TOLERANCE, "Test14: USMonthCountByYear BY year",
    ).await;
    println!("  Test14 OK");

    // 15: AvgYearlyAccByTerr BY territorygroup — territory injected
    println!("  Running Test15: AvgYearlyAccByTerr BY territorygroup...");
    compare_grouped(
        &mut engine, &pool, "AvgYearlyAccByTerr", "dim_territory", "territorygroup",
        r#"SELECT sub.territorygroup, AVG(sub.revenue) FROM (SELECT t.territorygroup, d.year, SUM(f.linetotal) AS revenue FROM "BI".fact_sales f JOIN "BI".dim_date d ON f.orderdate = d.datekey JOIN "BI".dim_product p ON f.productid = p.productid JOIN "BI".dim_territory t ON f.territoryid = t.territoryid WHERE p.categoryname = 'Accessories' AND t.territorygroup IS NOT NULL GROUP BY t.territorygroup, d.year) sub GROUP BY sub.territorygroup ORDER BY sub.territorygroup"#,
        GROUPED_TOLERANCE, "Test15: AvgYearlyAccByTerr BY territorygroup",
    ).await;
    println!("  Test15 OK");
}

// ---------------------------------------------------------------------------
// Test cases 16-20: Mixed scalar VAR + QUERY binding + KEEP + DAX
//
// Combines scalar VARs with QUERY bindings in a single block, applies
// KEEP on intermediate tables, and uses DAX functions on the result.
// ---------------------------------------------------------------------------

/// Tests 16-20: Complex combinations — scalar VAR + QUERY, KEEP on intermediate
/// with DAX functions, cross-dimension KEEP + GROUP BY
#[tokio::test]
#[ignore]
async fn validate_16_to_20_mixed_var_query_keep_dax() {
    let measures = vec![
        // 16: KEEP on QUERY intermediate + ROUND — Q1 average monthly revenue, rounded
        (
            "Q1AvgMonthlyRev",
            r#"VAR monthly = QUERY(SUM(fact_sales[linetotal]) AS revenue BY dim_date[year], dim_date[month], dim_date[quarter]) RETURN ROUND(AVG(monthly[revenue], KEEP(monthly, monthly[quarter] = 1)), 0)"#,
        ),
        // 17: QUERY + context + KEEP combined — avg monthly bikes revenue for Q1 only
        (
            "AvgQ1MonthlyBikesRev",
            r#"VAR monthly = QUERY(SUM(fact_sales[linetotal], ctx_bikes) AS revenue BY dim_date[year], dim_date[month], dim_date[quarter]) RETURN AVG(monthly[revenue], KEEP(monthly, monthly[quarter] = 1))"#,
        ),
        // 18: QUERY + context + DAX ROUND — rounded avg yearly accessories revenue
        (
            "RoundedAvgYearlyAcc",
            r#"VAR by_year = QUERY(SUM(fact_sales[linetotal], ctx_accessories) AS revenue BY dim_date[year]) RETURN ROUND(AVG(by_year[revenue]), 0)"#,
        ),
        // 19: QUERY with KEEP + cross-dimension — Q2 avg monthly revenue by category
        (
            "Q2AvgMonthlyRevByCat",
            r#"VAR monthly = QUERY(SUM(fact_sales[linetotal]) AS revenue BY dim_date[year], dim_date[month], dim_date[quarter]) RETURN AVG(monthly[revenue], KEEP(monthly, monthly[quarter] = 2))"#,
        ),
        // 20: QUERY + context + KEEP on intermediate — Bikes 2013 yearly revenue from QUERY
        (
            "Bikes2013FromQuery",
            r#"VAR by_year = QUERY(SUM(fact_sales[linetotal], ctx_bikes) AS revenue BY dim_date[year]) RETURN SUM(by_year[revenue], KEEP(by_year, by_year[year] = 2013))"#,
        ),
    ];

    let mut engine = setup_engine(measures).await;
    let pool = make_pool().await;

    // 16: Q1AvgMonthlyRev — KEEP quarter=1, then AVG, ROUND
    println!("  Running Test16: Q1AvgMonthlyRev...");
    compare_grand_total(
        &mut engine, &pool, "Q1AvgMonthlyRev",
        r#"SELECT ROUND(AVG(revenue), 0) FROM (SELECT d.year, d.month, d.quarter, SUM(f.linetotal) AS revenue FROM "BI".fact_sales f JOIN "BI".dim_date d ON f.orderdate = d.datekey GROUP BY d.year, d.month, d.quarter) sub WHERE sub.quarter = 1"#,
        GRAND_TOTAL_TOLERANCE, "Test16: Q1AvgMonthlyRev",
    ).await;
    println!("  Test16 OK");

    // 17: AvgQ1MonthlyBikesRev — bikes only, Q1 months only, avg monthly revenue
    println!("  Running Test17: AvgQ1MonthlyBikesRev...");
    compare_grand_total(
        &mut engine, &pool, "AvgQ1MonthlyBikesRev",
        r#"SELECT AVG(revenue) FROM (SELECT d.year, d.month, d.quarter, SUM(f.linetotal) AS revenue FROM "BI".fact_sales f JOIN "BI".dim_date d ON f.orderdate = d.datekey JOIN "BI".dim_product p ON f.productid = p.productid WHERE p.categoryname = 'Bikes' GROUP BY d.year, d.month, d.quarter) sub WHERE sub.quarter = 1"#,
        GRAND_TOTAL_TOLERANCE, "Test17: AvgQ1MonthlyBikesRev",
    ).await;
    println!("  Test17 OK");

    // 18: RoundedAvgYearlyAcc — accessories avg yearly revenue, rounded
    println!("  Running Test18: RoundedAvgYearlyAcc...");
    compare_grand_total(
        &mut engine, &pool, "RoundedAvgYearlyAcc",
        r#"SELECT ROUND(AVG(revenue), 0) FROM (SELECT d.year, SUM(f.linetotal) AS revenue FROM "BI".fact_sales f JOIN "BI".dim_date d ON f.orderdate = d.datekey JOIN "BI".dim_product p ON f.productid = p.productid WHERE p.categoryname = 'Accessories' GROUP BY d.year) sub"#,
        GRAND_TOTAL_TOLERANCE, "Test18: RoundedAvgYearlyAcc",
    ).await;
    println!("  Test18 OK");

    // 19: Q2AvgMonthlyRevByCat — KEEP quarter=2, grouped by category (cross-dimension)
    println!("  Running Test19: Q2AvgMonthlyRevByCat BY category...");
    compare_grouped(
        &mut engine, &pool, "Q2AvgMonthlyRevByCat", "dim_product", "categoryname",
        r#"SELECT sub.categoryname, AVG(sub.revenue) FROM (SELECT p.categoryname, d.year, d.month, d.quarter, SUM(f.linetotal) AS revenue FROM "BI".fact_sales f JOIN "BI".dim_date d ON f.orderdate = d.datekey JOIN "BI".dim_product p ON f.productid = p.productid WHERE p.categoryname IS NOT NULL GROUP BY p.categoryname, d.year, d.month, d.quarter) sub WHERE sub.quarter = 2 GROUP BY sub.categoryname ORDER BY sub.categoryname"#,
        GROUPED_TOLERANCE, "Test19: Q2AvgMonthlyRevByCat BY category",
    ).await;
    println!("  Test19 OK");

    // 20: Bikes2013FromQuery — bikes revenue in 2013 via QUERY + KEEP
    println!("  Running Test20: Bikes2013FromQuery...");
    compare_grand_total(
        &mut engine, &pool, "Bikes2013FromQuery",
        r#"SELECT SUM(revenue) FROM (SELECT d.year, SUM(f.linetotal) AS revenue FROM "BI".fact_sales f JOIN "BI".dim_date d ON f.orderdate = d.datekey JOIN "BI".dim_product p ON f.productid = p.productid WHERE p.categoryname = 'Bikes' GROUP BY d.year) sub WHERE sub.year = 2013"#,
        GRAND_TOTAL_TOLERANCE, "Test20: Bikes2013FromQuery",
    ).await;
    println!("  Test20 OK");
}
