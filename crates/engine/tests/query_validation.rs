//! QUERY-in-VAR and KEEP-on-intermediate-table validation tests — 25 test cases
//! comparing engine results against direct SQL queries on the AdventureWorks BI schema.
//!
//! Tests QUERY() bindings that produce intermediate tables, two-stage aggregation
//! (aggregate-then-aggregate), and KEEP filters on intermediate results.
//!
//! Run with: `cargo test -p engine --test query_validation -- --ignored --nocapture`

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

/// Tolerance for grand totals (local DataFusion aggregation).
/// Two-stage aggregation (QUERY-in-VAR) can compound decimal precision differences.
const GRAND_TOTAL_TOLERANCE: f64 = 0.04;
/// Tolerance for grouped queries (star-schema join + aggregation).
const GROUPED_TOLERANCE: f64 = 0.05;

// ---------------------------------------------------------------------------
// Model setup
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
// Test cases 1-5: QUERY-in-VAR grand totals — basic two-stage aggregation
// ---------------------------------------------------------------------------

/// Tests 1-5: QUERY bindings with AVG/MAX/MIN/SUM/COUNT over grouped aggregations
#[tokio::test]
#[ignore]
async fn validate_01_to_05_query_in_var_grand_totals() {
    let measures = vec![
        // 1: Average monthly revenue — AVG of monthly SUM(linetotal)
        (
            "AvgMonthlyRev",
            r#"VAR monthly = QUERY(SUM(fact_sales[linetotal]) AS revenue BY dim_date[year], dim_date[month]) RETURN AVG(monthly[revenue])"#,
        ),
        // 2: Max monthly revenue — peak month
        (
            "MaxMonthlyRev",
            r#"VAR monthly = QUERY(SUM(fact_sales[linetotal]) AS revenue BY dim_date[year], dim_date[month]) RETURN MAX(monthly[revenue])"#,
        ),
        // 3: Min monthly revenue — lowest month
        (
            "MinMonthlyRev",
            r#"VAR monthly = QUERY(SUM(fact_sales[linetotal]) AS revenue BY dim_date[year], dim_date[month]) RETURN MIN(monthly[revenue])"#,
        ),
        // 4: Count of months with sales
        (
            "MonthCount",
            r#"VAR monthly = QUERY(SUM(fact_sales[linetotal]) AS revenue BY dim_date[year], dim_date[month]) RETURN COUNTROWS(monthly)"#,
        ),
        // 5: Sum of monthly revenues (should equal total revenue)
        (
            "SumMonthlyRev",
            r#"VAR monthly = QUERY(SUM(fact_sales[linetotal]) AS revenue BY dim_date[year], dim_date[month]) RETURN SUM(monthly[revenue])"#,
        ),
    ];

    let mut engine = setup_engine(measures).await;
    let pool = make_pool().await;

    let cases: Vec<(&str, &str)> = vec![
        (
            "AvgMonthlyRev",
            r#"SELECT AVG(monthly_rev) FROM (SELECT SUM(f.linetotal) AS monthly_rev FROM "BI".fact_sales f JOIN "BI".dim_date d ON f.orderdate = d.datekey GROUP BY d.year, d.month) sub"#,
        ),
        (
            "MaxMonthlyRev",
            r#"SELECT MAX(monthly_rev) FROM (SELECT SUM(f.linetotal) AS monthly_rev FROM "BI".fact_sales f JOIN "BI".dim_date d ON f.orderdate = d.datekey GROUP BY d.year, d.month) sub"#,
        ),
        (
            "MinMonthlyRev",
            r#"SELECT MIN(monthly_rev) FROM (SELECT SUM(f.linetotal) AS monthly_rev FROM "BI".fact_sales f JOIN "BI".dim_date d ON f.orderdate = d.datekey GROUP BY d.year, d.month) sub"#,
        ),
        (
            "MonthCount",
            r#"SELECT COUNT(*)::numeric FROM (SELECT SUM(f.linetotal) AS monthly_rev FROM "BI".fact_sales f JOIN "BI".dim_date d ON f.orderdate = d.datekey GROUP BY d.year, d.month) sub"#,
        ),
        (
            "SumMonthlyRev",
            r#"SELECT SUM(monthly_rev) FROM (SELECT SUM(f.linetotal) AS monthly_rev FROM "BI".fact_sales f JOIN "BI".dim_date d ON f.orderdate = d.datekey GROUP BY d.year, d.month) sub"#,
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
// Test cases 6-10: QUERY with cross-table group-by and multiple aggregates
// ---------------------------------------------------------------------------

/// Tests 6-10: QUERY with dimension group-by columns and multiple aggregate outputs
#[tokio::test]
#[ignore]
async fn validate_06_to_10_query_cross_table_and_multi_agg() {
    let measures = vec![
        // 6: Average category revenue — SUM by category, then AVG
        (
            "AvgCatRev",
            r#"VAR by_cat = QUERY(SUM(fact_sales[linetotal]) AS revenue BY dim_product[categoryname]) RETURN AVG(by_cat[revenue])"#,
        ),
        // 7: Max category revenue
        (
            "MaxCatRev",
            r#"VAR by_cat = QUERY(SUM(fact_sales[linetotal]) AS revenue BY dim_product[categoryname]) RETURN MAX(by_cat[revenue])"#,
        ),
        // 8: Average yearly revenue — SUM by year, then AVG
        (
            "AvgYearlyRev",
            r#"VAR by_year = QUERY(SUM(fact_sales[linetotal]) AS revenue BY dim_date[year]) RETURN AVG(by_year[revenue])"#,
        ),
        // 9: Average country revenue — SUM by country, then AVG
        (
            "AvgCountryRev",
            r#"VAR by_country = QUERY(SUM(fact_sales[linetotal]) AS revenue BY dim_customer[country]) RETURN AVG(by_country[revenue])"#,
        ),
        // 10: Count of distinct territory groups with sales
        (
            "TerritoryGroupCount",
            r#"VAR by_tg = QUERY(SUM(fact_sales[linetotal]) AS revenue BY dim_territory[territorygroup]) RETURN COUNTROWS(by_tg)"#,
        ),
    ];

    let mut engine = setup_engine(measures).await;
    let pool = make_pool().await;

    let cases: Vec<(&str, &str)> = vec![
        (
            "AvgCatRev",
            r#"SELECT AVG(cat_rev) FROM (SELECT SUM(f.linetotal) AS cat_rev FROM "BI".fact_sales f JOIN "BI".dim_product p ON f.productid = p.productid WHERE p.categoryname IS NOT NULL GROUP BY p.categoryname) sub"#,
        ),
        (
            "MaxCatRev",
            r#"SELECT MAX(cat_rev) FROM (SELECT SUM(f.linetotal) AS cat_rev FROM "BI".fact_sales f JOIN "BI".dim_product p ON f.productid = p.productid WHERE p.categoryname IS NOT NULL GROUP BY p.categoryname) sub"#,
        ),
        (
            "AvgYearlyRev",
            r#"SELECT AVG(yr_rev) FROM (SELECT SUM(f.linetotal) AS yr_rev FROM "BI".fact_sales f JOIN "BI".dim_date d ON f.orderdate = d.datekey GROUP BY d.year) sub"#,
        ),
        (
            "AvgCountryRev",
            r#"SELECT AVG(c_rev) FROM (SELECT SUM(f.linetotal) AS c_rev FROM "BI".fact_sales f JOIN "BI".dim_customer c ON f.customerid = c.customerid WHERE c.country IS NOT NULL GROUP BY c.country) sub"#,
        ),
        (
            "TerritoryGroupCount",
            r#"SELECT COUNT(*)::numeric FROM (SELECT SUM(f.linetotal) AS tg_rev FROM "BI".fact_sales f JOIN "BI".dim_territory t ON f.territoryid = t.territoryid WHERE t.territorygroup IS NOT NULL GROUP BY t.territorygroup) sub"#,
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
// Test cases 11-15: QUERY with arithmetic on results and multiple bindings
// ---------------------------------------------------------------------------

/// Tests 11-15: Arithmetic on QUERY results, DIVIDE, multiple QUERYs
#[tokio::test]
#[ignore]
async fn validate_11_to_15_query_arithmetic_and_multi_binding() {
    let measures = vec![
        // 11: Revenue range — MAX monthly - MIN monthly
        (
            "MonthlyRange",
            r#"VAR monthly = QUERY(SUM(fact_sales[linetotal]) AS revenue BY dim_date[year], dim_date[month]) RETURN MAX(monthly[revenue]) - MIN(monthly[revenue])"#,
        ),
        // 12: Average quarterly revenue
        (
            "AvgQuarterlyRev",
            r#"VAR quarterly = QUERY(SUM(fact_sales[linetotal]) AS revenue BY dim_date[year], dim_date[quarter]) RETURN AVG(quarterly[revenue])"#,
        ),
        // 13: Max quarterly revenue
        (
            "MaxQuarterlyRev",
            r#"VAR quarterly = QUERY(SUM(fact_sales[linetotal]) AS revenue BY dim_date[year], dim_date[quarter]) RETURN MAX(quarterly[revenue])"#,
        ),
        // 14: Average yearly order qty
        (
            "AvgYearlyQty",
            r#"VAR by_year = QUERY(SUM(fact_sales[orderqty]) AS total_qty BY dim_date[year]) RETURN AVG(by_year[total_qty])"#,
        ),
        // 15: Max yearly order count
        (
            "MaxYearlyOrders",
            r#"VAR by_year = QUERY(COUNT(fact_sales[salesorderdetailid]) AS order_count BY dim_date[year]) RETURN MAX(by_year[order_count])"#,
        ),
    ];

    let mut engine = setup_engine(measures).await;
    let pool = make_pool().await;

    let cases: Vec<(&str, &str)> = vec![
        (
            "MonthlyRange",
            r#"SELECT MAX(monthly_rev) - MIN(monthly_rev) FROM (SELECT SUM(f.linetotal) AS monthly_rev FROM "BI".fact_sales f JOIN "BI".dim_date d ON f.orderdate = d.datekey GROUP BY d.year, d.month) sub"#,
        ),
        (
            "AvgQuarterlyRev",
            r#"SELECT AVG(qtr_rev) FROM (SELECT SUM(f.linetotal) AS qtr_rev FROM "BI".fact_sales f JOIN "BI".dim_date d ON f.orderdate = d.datekey GROUP BY d.year, d.quarter) sub"#,
        ),
        (
            "MaxQuarterlyRev",
            r#"SELECT MAX(qtr_rev) FROM (SELECT SUM(f.linetotal) AS qtr_rev FROM "BI".fact_sales f JOIN "BI".dim_date d ON f.orderdate = d.datekey GROUP BY d.year, d.quarter) sub"#,
        ),
        (
            "AvgYearlyQty",
            r#"SELECT AVG(yr_qty) FROM (SELECT SUM(f.orderqty::numeric) AS yr_qty FROM "BI".fact_sales f JOIN "BI".dim_date d ON f.orderdate = d.datekey GROUP BY d.year) sub"#,
        ),
        (
            "MaxYearlyOrders",
            r#"SELECT MAX(yr_orders) FROM (SELECT COUNT(f.salesorderdetailid)::numeric AS yr_orders FROM "BI".fact_sales f JOIN "BI".dim_date d ON f.orderdate = d.datekey GROUP BY d.year) sub"#,
        ),
    ];

    for (i, (measure, sql)) in cases.iter().enumerate() {
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
}

// ---------------------------------------------------------------------------
// Test cases 16-20: KEEP on intermediate tables
// ---------------------------------------------------------------------------

/// Tests 16-20: KEEP filters applied to intermediate QUERY results
#[tokio::test]
#[ignore]
async fn validate_16_to_20_keep_on_intermediate() {
    let measures = vec![
        // 16: Revenue only for year 2014 from yearly intermediate
        (
            "Rev2014FromYearly",
            r#"VAR by_year = QUERY(SUM(fact_sales[linetotal]) AS revenue BY dim_date[year]) RETURN SUM(by_year[revenue], KEEP(by_year, by_year[year] = 2014))"#,
        ),
        // 17: Revenue only for year 2013 from yearly intermediate
        (
            "Rev2013FromYearly",
            r#"VAR by_year = QUERY(SUM(fact_sales[linetotal]) AS revenue BY dim_date[year]) RETURN SUM(by_year[revenue], KEEP(by_year, by_year[year] = 2013))"#,
        ),
        // 18: Max monthly revenue filtered to Q1 months (month <= 3)
        // Using quarter-level grouping: keep only quarter 1
        (
            "Q1QuarterlyRev",
            r#"VAR quarterly = QUERY(SUM(fact_sales[linetotal]) AS revenue BY dim_date[year], dim_date[quarter]) RETURN SUM(quarterly[revenue], KEEP(quarterly, quarterly[quarter] = 1))"#,
        ),
        // 19: Count of years in yearly intermediate (should equal distinct years)
        (
            "YearCount",
            r#"VAR by_year = QUERY(SUM(fact_sales[linetotal]) AS revenue BY dim_date[year]) RETURN COUNTROWS(by_year)"#,
        ),
        // 20: Average category revenue for non-null categories
        (
            "AvgCatRevKeep",
            r#"VAR by_cat = QUERY(SUM(fact_sales[linetotal]) AS revenue BY dim_product[categoryname]) RETURN AVG(by_cat[revenue])"#,
        ),
    ];

    let mut engine = setup_engine(measures).await;
    let pool = make_pool().await;

    // 16: Revenue for 2014 only — same as direct KEEP on dim_date
    println!("  Running Test16: Rev2014FromYearly...");
    compare_grand_total(
        &mut engine, &pool, "Rev2014FromYearly",
        r#"SELECT SUM(revenue) FROM (SELECT d.year, SUM(f.linetotal) AS revenue FROM "BI".fact_sales f JOIN "BI".dim_date d ON f.orderdate = d.datekey GROUP BY d.year) sub WHERE sub.year = 2014"#,
        GRAND_TOTAL_TOLERANCE, "Test16: Rev2014FromYearly",
    ).await;
    println!("  Test16 OK");

    // 17: Revenue for 2013
    println!("  Running Test17: Rev2013FromYearly...");
    compare_grand_total(
        &mut engine, &pool, "Rev2013FromYearly",
        r#"SELECT SUM(revenue) FROM (SELECT d.year, SUM(f.linetotal) AS revenue FROM "BI".fact_sales f JOIN "BI".dim_date d ON f.orderdate = d.datekey GROUP BY d.year) sub WHERE sub.year = 2013"#,
        GRAND_TOTAL_TOLERANCE, "Test17: Rev2013FromYearly",
    ).await;
    println!("  Test17 OK");

    // 18: Q1 quarterly revenue sum
    println!("  Running Test18: Q1QuarterlyRev...");
    compare_grand_total(
        &mut engine, &pool, "Q1QuarterlyRev",
        r#"SELECT SUM(revenue) FROM (SELECT d.year, d.quarter, SUM(f.linetotal) AS revenue FROM "BI".fact_sales f JOIN "BI".dim_date d ON f.orderdate = d.datekey GROUP BY d.year, d.quarter) sub WHERE sub.quarter = 1"#,
        GRAND_TOTAL_TOLERANCE, "Test18: Q1QuarterlyRev",
    ).await;
    println!("  Test18 OK");

    // 19: Count of distinct years
    println!("  Running Test19: YearCount...");
    compare_grand_total(
        &mut engine, &pool, "YearCount",
        r#"SELECT COUNT(*)::numeric FROM (SELECT d.year, SUM(f.linetotal) AS revenue FROM "BI".fact_sales f JOIN "BI".dim_date d ON f.orderdate = d.datekey GROUP BY d.year) sub"#,
        GRAND_TOTAL_TOLERANCE, "Test19: YearCount",
    ).await;
    println!("  Test19 OK");

    // 20: Average category revenue
    println!("  Running Test20: AvgCatRevKeep...");
    compare_grand_total(
        &mut engine, &pool, "AvgCatRevKeep",
        r#"SELECT AVG(revenue) FROM (SELECT p.categoryname, SUM(f.linetotal) AS revenue FROM "BI".fact_sales f JOIN "BI".dim_product p ON f.productid = p.productid WHERE p.categoryname IS NOT NULL GROUP BY p.categoryname) sub"#,
        GRAND_TOTAL_TOLERANCE, "Test20: AvgCatRevKeep",
    ).await;
    println!("  Test20 OK");
}

// ---------------------------------------------------------------------------
// Test cases 21-25: QUERY-in-VAR grouped output + KEEP combinations
// ---------------------------------------------------------------------------

/// Tests 21-25: QUERY measures in grouped queries and advanced KEEP combinations
#[tokio::test]
#[ignore]
async fn validate_21_to_25_query_grouped_and_advanced() {
    let measures = vec![
        // 21: Average monthly revenue — grand total (same as test 1 but different agg)
        (
            "AvgMonthlyRev",
            r#"VAR monthly = QUERY(SUM(fact_sales[linetotal]) AS revenue BY dim_date[year], dim_date[month]) RETURN AVG(monthly[revenue])"#,
        ),
        // 22: Sum of quarterly revenues for Q4 only via KEEP
        (
            "Q4QuarterlyRev",
            r#"VAR quarterly = QUERY(SUM(fact_sales[linetotal]) AS revenue BY dim_date[year], dim_date[quarter]) RETURN SUM(quarterly[revenue], KEEP(quarterly, quarterly[quarter] = 4))"#,
        ),
        // 23: Average subcategory revenue
        (
            "AvgSubcatRev",
            r#"VAR by_subcat = QUERY(SUM(fact_sales[linetotal]) AS revenue BY dim_product[subcategoryname]) RETURN AVG(by_subcat[revenue])"#,
        ),
        // 24: Max territory revenue
        (
            "MaxTerritoryRev",
            r#"VAR by_terr = QUERY(SUM(fact_sales[linetotal]) AS revenue BY dim_territory[territoryname]) RETURN MAX(by_terr[revenue])"#,
        ),
        // 25: Sum of yearly order quantities for 2014 via KEEP
        (
            "Qty2014FromYearly",
            r#"VAR by_year = QUERY(SUM(fact_sales[orderqty]) AS total_qty BY dim_date[year]) RETURN SUM(by_year[total_qty], KEEP(by_year, by_year[year] = 2014))"#,
        ),
    ];

    let mut engine = setup_engine(measures).await;
    let pool = make_pool().await;

    // 21: Average monthly revenue grouped by year
    println!("  Running Test21: AvgMonthlyRev BY year...");
    compare_grouped(
        &mut engine, &pool, "AvgMonthlyRev", "dim_date", "year",
        r#"SELECT d2.year, AVG(monthly_rev) FROM (SELECT d.year, d.month, SUM(f.linetotal) AS monthly_rev FROM "BI".fact_sales f JOIN "BI".dim_date d ON f.orderdate = d.datekey GROUP BY d.year, d.month) sub JOIN (SELECT DISTINCT year FROM "BI".dim_date) d2 ON sub.year = d2.year GROUP BY d2.year ORDER BY d2.year"#,
        GROUPED_TOLERANCE, "Test21: AvgMonthlyRev BY year",
    ).await;
    println!("  Test21 OK");

    // 22: Q4 quarterly revenue
    println!("  Running Test22: Q4QuarterlyRev...");
    compare_grand_total(
        &mut engine, &pool, "Q4QuarterlyRev",
        r#"SELECT SUM(revenue) FROM (SELECT d.year, d.quarter, SUM(f.linetotal) AS revenue FROM "BI".fact_sales f JOIN "BI".dim_date d ON f.orderdate = d.datekey GROUP BY d.year, d.quarter) sub WHERE sub.quarter = 4"#,
        GRAND_TOTAL_TOLERANCE, "Test22: Q4QuarterlyRev",
    ).await;
    println!("  Test22 OK");

    // 23: Average subcategory revenue
    println!("  Running Test23: AvgSubcatRev...");
    compare_grand_total(
        &mut engine, &pool, "AvgSubcatRev",
        r#"SELECT AVG(subcat_rev) FROM (SELECT p.subcategoryname, SUM(f.linetotal) AS subcat_rev FROM "BI".fact_sales f JOIN "BI".dim_product p ON f.productid = p.productid WHERE p.subcategoryname IS NOT NULL GROUP BY p.subcategoryname) sub"#,
        GRAND_TOTAL_TOLERANCE, "Test23: AvgSubcatRev",
    ).await;
    println!("  Test23 OK");

    // 24: Max territory revenue
    println!("  Running Test24: MaxTerritoryRev...");
    compare_grand_total(
        &mut engine, &pool, "MaxTerritoryRev",
        r#"SELECT MAX(terr_rev) FROM (SELECT t.territoryname, SUM(f.linetotal) AS terr_rev FROM "BI".fact_sales f JOIN "BI".dim_territory t ON f.territoryid = t.territoryid WHERE t.territoryname IS NOT NULL GROUP BY t.territoryname) sub"#,
        GRAND_TOTAL_TOLERANCE, "Test24: MaxTerritoryRev",
    ).await;
    println!("  Test24 OK");

    // 25: Yearly qty for 2014 via KEEP on intermediate
    println!("  Running Test25: Qty2014FromYearly...");
    compare_grand_total(
        &mut engine, &pool, "Qty2014FromYearly",
        r#"SELECT SUM(total_qty) FROM (SELECT d.year, SUM(f.orderqty::numeric) AS total_qty FROM "BI".fact_sales f JOIN "BI".dim_date d ON f.orderdate = d.datekey GROUP BY d.year) sub WHERE sub.year = 2014"#,
        GRAND_TOTAL_TOLERANCE, "Test25: Qty2014FromYearly",
    ).await;
    println!("  Test25 OK");
}

// ---------------------------------------------------------------------------
// Test cases 26-30: Cross-dimension GROUP BY (context propagation)
// ---------------------------------------------------------------------------

/// Tests 26-30: QUERY-in-VAR grouped by a dimension NOT in the QUERY's own
/// GROUP BY. The engine must inject the outer group-by into the QUERY's
/// materialization so each group gets its own intermediate aggregation.
#[tokio::test]
#[ignore]
async fn validate_26_to_30_cross_dimension_group_by() {
    let measures = vec![
        // 26: Average monthly revenue, grouped by category
        //     QUERY groups by (year, month). Outer GROUP BY = category.
        //     Engine injects category → intermediate = (year, month, category, revenue)
        //     Then AVG(revenue) GROUP BY category = per-category avg monthly revenue.
        (
            "AvgMonthlyRevByCat",
            r#"VAR monthly = QUERY(SUM(fact_sales[linetotal]) AS revenue BY dim_date[year], dim_date[month]) RETURN AVG(monthly[revenue])"#,
        ),
        // 27: Max monthly revenue, grouped by country
        (
            "MaxMonthlyRevByCountry",
            r#"VAR monthly = QUERY(SUM(fact_sales[linetotal]) AS revenue BY dim_date[year], dim_date[month]) RETURN MAX(monthly[revenue])"#,
        ),
        // 28: Average yearly revenue, grouped by category
        (
            "AvgYearlyRevByCat",
            r#"VAR by_year = QUERY(SUM(fact_sales[linetotal]) AS revenue BY dim_date[year]) RETURN AVG(by_year[revenue])"#,
        ),
        // 29: Count of months with sales, grouped by territory group
        (
            "MonthCountByTerrGroup",
            r#"VAR monthly = QUERY(SUM(fact_sales[linetotal]) AS revenue BY dim_date[year], dim_date[month]) RETURN COUNTROWS(monthly)"#,
        ),
        // 30: Average quarterly revenue, grouped by category
        (
            "AvgQtrRevByCat",
            r#"VAR quarterly = QUERY(SUM(fact_sales[linetotal]) AS revenue BY dim_date[year], dim_date[quarter]) RETURN AVG(quarterly[revenue])"#,
        ),
    ];

    let mut engine = setup_engine(measures).await;
    let pool = make_pool().await;

    // 26: AvgMonthlyRevByCat BY categoryname
    // SQL equivalent: for each category, compute monthly SUM then AVG over months
    println!("  Running Test26: AvgMonthlyRevByCat BY category...");
    compare_grouped(
        &mut engine, &pool, "AvgMonthlyRevByCat", "dim_product", "categoryname",
        r#"SELECT sub.categoryname, AVG(sub.revenue) FROM (SELECT p.categoryname, d.year, d.month, SUM(f.linetotal) AS revenue FROM "BI".fact_sales f JOIN "BI".dim_date d ON f.orderdate = d.datekey JOIN "BI".dim_product p ON f.productid = p.productid WHERE p.categoryname IS NOT NULL GROUP BY p.categoryname, d.year, d.month) sub GROUP BY sub.categoryname ORDER BY sub.categoryname"#,
        GROUPED_TOLERANCE, "Test26: AvgMonthlyRevByCat BY category",
    ).await;
    println!("  Test26 OK");

    // 27: MaxMonthlyRevByCountry BY country
    println!("  Running Test27: MaxMonthlyRevByCountry BY country...");
    compare_grouped(
        &mut engine, &pool, "MaxMonthlyRevByCountry", "dim_customer", "country",
        r#"SELECT sub.country, MAX(sub.revenue) FROM (SELECT c.country, d.year, d.month, SUM(f.linetotal) AS revenue FROM "BI".fact_sales f JOIN "BI".dim_date d ON f.orderdate = d.datekey JOIN "BI".dim_customer c ON f.customerid = c.customerid WHERE c.country IS NOT NULL GROUP BY c.country, d.year, d.month) sub GROUP BY sub.country ORDER BY sub.country"#,
        GROUPED_TOLERANCE, "Test27: MaxMonthlyRevByCountry BY country",
    ).await;
    println!("  Test27 OK");

    // 28: AvgYearlyRevByCat BY categoryname
    println!("  Running Test28: AvgYearlyRevByCat BY category...");
    compare_grouped(
        &mut engine, &pool, "AvgYearlyRevByCat", "dim_product", "categoryname",
        r#"SELECT sub.categoryname, AVG(sub.revenue) FROM (SELECT p.categoryname, d.year, SUM(f.linetotal) AS revenue FROM "BI".fact_sales f JOIN "BI".dim_date d ON f.orderdate = d.datekey JOIN "BI".dim_product p ON f.productid = p.productid WHERE p.categoryname IS NOT NULL GROUP BY p.categoryname, d.year) sub GROUP BY sub.categoryname ORDER BY sub.categoryname"#,
        GROUPED_TOLERANCE, "Test28: AvgYearlyRevByCat BY category",
    ).await;
    println!("  Test28 OK");

    // 29: MonthCountByTerrGroup BY territorygroup
    println!("  Running Test29: MonthCountByTerrGroup BY territorygroup...");
    compare_grouped(
        &mut engine, &pool, "MonthCountByTerrGroup", "dim_territory", "territorygroup",
        r#"SELECT sub.territorygroup, COUNT(*)::numeric FROM (SELECT t.territorygroup, d.year, d.month, SUM(f.linetotal) AS revenue FROM "BI".fact_sales f JOIN "BI".dim_date d ON f.orderdate = d.datekey JOIN "BI".dim_territory t ON f.territoryid = t.territoryid WHERE t.territorygroup IS NOT NULL GROUP BY t.territorygroup, d.year, d.month) sub GROUP BY sub.territorygroup ORDER BY sub.territorygroup"#,
        GROUPED_TOLERANCE, "Test29: MonthCountByTerrGroup BY territorygroup",
    ).await;
    println!("  Test29 OK");

    // 30: AvgQtrRevByCat BY categoryname
    println!("  Running Test30: AvgQtrRevByCat BY category...");
    compare_grouped(
        &mut engine, &pool, "AvgQtrRevByCat", "dim_product", "categoryname",
        r#"SELECT sub.categoryname, AVG(sub.revenue) FROM (SELECT p.categoryname, d.year, d.quarter, SUM(f.linetotal) AS revenue FROM "BI".fact_sales f JOIN "BI".dim_date d ON f.orderdate = d.datekey JOIN "BI".dim_product p ON f.productid = p.productid WHERE p.categoryname IS NOT NULL GROUP BY p.categoryname, d.year, d.quarter) sub GROUP BY sub.categoryname ORDER BY sub.categoryname"#,
        GROUPED_TOLERANCE, "Test30: AvgQtrRevByCat BY category",
    ).await;
    println!("  Test30 OK");
}
