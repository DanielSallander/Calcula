//! VAR/RETURN scalar variable and Named Context validation tests — 20 test cases
//! comparing engine results against direct SQL queries on the AdventureWorks BI schema.
//!
//! Tests VAR/RETURN blocks (inline substitution, chained references, with scalar functions)
//! and named contexts (bare context names, inherited contexts, composed contexts).
//!
//! Run with: `cargo test -p engine --test var_context_validation -- --ignored --nocapture`

use engine::*;
use rust_decimal::Decimal;
use sqlx::postgres::PgPoolOptions;
use sqlx::Row;
use std::str::FromStr;

const CONNECTION_STRING: &str = "postgresql://postgres:postgres@localhost:5432/Adventureworks";
const SCHEMA: &str = "BI";

/// Tolerance for grand totals (local DataFusion aggregation).
const GRAND_TOTAL_TOLERANCE: f64 = 0.035;
/// Tolerance for grouped queries (star-schema join + aggregation).
const GROUPED_TOLERANCE: f64 = 0.05;

// ---------------------------------------------------------------------------
// Model setup with named contexts and VAR/RETURN measures
// ---------------------------------------------------------------------------

/// Build a model with the AdventureWorks star schema, named contexts, and measures.
///
/// Named contexts defined:
///   ctx_bikes       = KEEP(dim_product, dim_product[categoryname] = "Bikes")
///   ctx_accessories = KEEP(dim_product, dim_product[categoryname] = "Accessories")
///   ctx_clothing    = KEEP(dim_product, dim_product[categoryname] = "Clothing")
///   ctx_2014        = KEEP(dim_date, dim_date[year] = 2014)
///   ctx_2013        = KEEP(dim_date, dim_date[year] = 2013)
///   ctx_bikes_2014  = ctx_bikes, KEEP(dim_date, dim_date[year] = 2014)
///   ctx_us          = KEEP(dim_customer, dim_customer[country] = "United States")
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

    // Parse named context definitions.
    let ctx_defs: Vec<(&str, &str)> = vec![
        (
            "ctx_bikes",
            r#"KEEP(dim_product, dim_product[categoryname] = "Bikes")"#,
        ),
        (
            "ctx_accessories",
            r#"KEEP(dim_product, dim_product[categoryname] = "Accessories")"#,
        ),
        (
            "ctx_clothing",
            r#"KEEP(dim_product, dim_product[categoryname] = "Clothing")"#,
        ),
        ("ctx_2014", "KEEP(dim_date, dim_date[year] = 2014)"),
        ("ctx_2013", "KEEP(dim_date, dim_date[year] = 2013)"),
        (
            "ctx_bikes_2014",
            r#"ctx_bikes, KEEP(dim_date, dim_date[year] = 2014)"#,
        ),
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
        .add_postgres(PostgresConfig::new(CONNECTION_STRING))
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
        .connect(CONNECTION_STRING)
        .await
        .unwrap()
}

// ---------------------------------------------------------------------------
// Comparison helpers
// ---------------------------------------------------------------------------

async fn compare_grand_total(
    engine: &Engine,
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
    engine: &Engine,
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
// Test cases 1-5: VAR/RETURN scalar variables (grand totals)
// ---------------------------------------------------------------------------

/// Tests 1-5: VAR/RETURN with simple aggregates, chained references, DIVIDE, ROUND
#[tokio::test]
#[ignore]
async fn validate_01_to_05_var_return_grand_totals() {
    let measures = vec![
        // 1: Simple VAR/RETURN — average order value via DIVIDE
        (
            "AvgOrderVar",
            r#"VAR rev = SUM(fact_sales[linetotal]) VAR orders = COUNT(fact_sales[salesorderdetailid]) RETURN DIVIDE(rev, orders)"#,
        ),
        // 2: Chained VAR references — revenue per unit rounded
        (
            "RevPerUnitRounded",
            r#"VAR rev = SUM(fact_sales[linetotal]) VAR qty = SUM(fact_sales[orderqty]) VAR ratio = DIVIDE(rev, qty) RETURN ROUND(ratio, 2)"#,
        ),
        // 3: VAR with arithmetic — double revenue minus total qty
        (
            "RevDiff",
            r#"VAR rev = SUM(fact_sales[linetotal]) VAR qty = SUM(fact_sales[orderqty]) RETURN (rev * 2) - qty"#,
        ),
        // 4: VAR with ABS — absolute difference between revenue and 50M
        (
            "AbsDiffFrom50M",
            r#"VAR rev = SUM(fact_sales[linetotal]) RETURN ABS(rev - 50000000)"#,
        ),
        // 5: VAR with nested DIVIDE + ROUND — avg unit price rounded to integer
        (
            "AvgPriceInt",
            r#"VAR total = SUM(fact_sales[unitprice]) VAR cnt = COUNT(fact_sales[unitprice]) RETURN ROUND(DIVIDE(total, cnt), 0)"#,
        ),
    ];

    let engine = setup_engine(measures).await;
    let pool = make_pool().await;

    let cases: Vec<(&str, &str)> = vec![
        (
            "AvgOrderVar",
            r#"SELECT SUM(linetotal) / COUNT(salesorderdetailid) FROM "BI".fact_sales"#,
        ),
        (
            "RevPerUnitRounded",
            r#"SELECT ROUND(SUM(linetotal) / SUM(orderqty::numeric), 2) FROM "BI".fact_sales"#,
        ),
        (
            "RevDiff",
            r#"SELECT SUM(linetotal) * 2 - SUM(orderqty::numeric) FROM "BI".fact_sales"#,
        ),
        (
            "AbsDiffFrom50M",
            r#"SELECT ABS(SUM(linetotal) - 50000000) FROM "BI".fact_sales"#,
        ),
        (
            "AvgPriceInt",
            r#"SELECT ROUND(SUM(unitprice) / COUNT(unitprice), 0) FROM "BI".fact_sales"#,
        ),
    ];

    for (i, (measure, sql)) in cases.iter().enumerate() {
        let label = format!("Test{}: {}", i + 1, measure);
        println!("  Running {label}...");
        compare_grand_total(&engine, &pool, measure, sql, GRAND_TOTAL_TOLERANCE, &label).await;
        println!("  {label} OK");
    }
}

// ---------------------------------------------------------------------------
// Test cases 6-10: Named contexts (grand totals)
// ---------------------------------------------------------------------------

/// Tests 6-10: Named context references as bare names in measure context arguments
#[tokio::test]
#[ignore]
async fn validate_06_to_10_named_contexts_grand_totals() {
    let measures = vec![
        // 6: ctx_bikes — revenue for Bikes only
        ("BikesRevCtx", "SUM(fact_sales[linetotal], ctx_bikes)"),
        // 7: ctx_2014 — revenue for 2014 only
        ("Rev2014Ctx", "SUM(fact_sales[linetotal], ctx_2014)"),
        // 8: ctx_bikes_2014 — composed: Bikes in 2014 (inherits ctx_bikes + KEEP year)
        ("Bikes2014Ctx", "SUM(fact_sales[linetotal], ctx_bikes_2014)"),
        // 9: ctx_accessories — count for Accessories
        (
            "AccOrders",
            "COUNT(fact_sales[salesorderdetailid], ctx_accessories)",
        ),
        // 10: ctx_us — US revenue
        ("USRevCtx", "SUM(fact_sales[linetotal], ctx_us)"),
    ];

    let engine = setup_engine(measures).await;
    let pool = make_pool().await;

    let cases: Vec<(&str, &str)> = vec![
        (
            "BikesRevCtx",
            r#"SELECT SUM(f.linetotal) FROM "BI".fact_sales f JOIN "BI".dim_product p ON f.productid = p.productid WHERE p.categoryname = 'Bikes'"#,
        ),
        (
            "Rev2014Ctx",
            r#"SELECT SUM(f.linetotal) FROM "BI".fact_sales f JOIN "BI".dim_date d ON f.orderdate = d.datekey WHERE d.year = 2014"#,
        ),
        (
            "Bikes2014Ctx",
            r#"SELECT SUM(f.linetotal) FROM "BI".fact_sales f JOIN "BI".dim_product p ON f.productid = p.productid JOIN "BI".dim_date d ON f.orderdate = d.datekey WHERE p.categoryname = 'Bikes' AND d.year = 2014"#,
        ),
        (
            "AccOrders",
            r#"SELECT COUNT(f.salesorderdetailid)::numeric FROM "BI".fact_sales f JOIN "BI".dim_product p ON f.productid = p.productid WHERE p.categoryname = 'Accessories'"#,
        ),
        (
            "USRevCtx",
            r#"SELECT SUM(f.linetotal) FROM "BI".fact_sales f JOIN "BI".dim_customer c ON f.customerid = c.customerid WHERE c.country = 'United States'"#,
        ),
    ];

    for (i, (measure, sql)) in cases.iter().enumerate() {
        let label = format!("Test{}: {}", i + 6, measure);
        println!("  Running {label}...");
        compare_grand_total(&engine, &pool, measure, sql, GRAND_TOTAL_TOLERANCE, &label).await;
        println!("  {label} OK");
    }
}

// ---------------------------------------------------------------------------
// Test cases 11-15: Named contexts grouped
// ---------------------------------------------------------------------------

/// Tests 11-15: Named contexts in grouped queries
#[tokio::test]
#[ignore]
async fn validate_11_to_15_named_contexts_grouped() {
    let measures = vec![
        // 11: ctx_bikes grouped by year
        ("BikesRevCtx", "SUM(fact_sales[linetotal], ctx_bikes)"),
        // 12: ctx_2014 grouped by category
        ("Rev2014Ctx", "SUM(fact_sales[linetotal], ctx_2014)"),
        // 13: ctx_clothing grouped by country
        ("ClothingRevCtx", "SUM(fact_sales[linetotal], ctx_clothing)"),
        // 14: ctx_2013 total qty grouped by territory group
        ("Qty2013Ctx", "SUM(fact_sales[orderqty], ctx_2013)"),
        // 15: ctx_2013 revenue grouped by color
        ("Rev2013Color", "SUM(fact_sales[linetotal], ctx_2013)"),
    ];

    let engine = setup_engine(measures).await;
    let pool = make_pool().await;

    // 11: BikesRevCtx BY year
    println!("  Running Test11: BikesRevCtx BY year...");
    compare_grouped(
        &engine, &pool, "BikesRevCtx", "dim_date", "year",
        r#"SELECT d.year, SUM(f.linetotal) FROM "BI".fact_sales f JOIN "BI".dim_product p ON f.productid = p.productid JOIN "BI".dim_date d ON f.orderdate = d.datekey WHERE p.categoryname = 'Bikes' GROUP BY d.year ORDER BY d.year"#,
        GROUPED_TOLERANCE, "Test11: BikesRevCtx BY year",
    ).await;
    println!("  Test11 OK");

    // 12: Rev2014Ctx BY category
    println!("  Running Test12: Rev2014Ctx BY category...");
    compare_grouped(
        &engine, &pool, "Rev2014Ctx", "dim_product", "categoryname",
        r#"SELECT p.categoryname, SUM(f.linetotal) FROM "BI".fact_sales f JOIN "BI".dim_product p ON f.productid = p.productid JOIN "BI".dim_date d ON f.orderdate = d.datekey WHERE d.year = 2014 AND p.categoryname IS NOT NULL GROUP BY p.categoryname ORDER BY p.categoryname"#,
        GROUPED_TOLERANCE, "Test12: Rev2014Ctx BY category",
    ).await;
    println!("  Test12 OK");

    // 13: ClothingRevCtx BY country
    println!("  Running Test13: ClothingRevCtx BY country...");
    compare_grouped(
        &engine, &pool, "ClothingRevCtx", "dim_customer", "country",
        r#"SELECT c.country, SUM(f.linetotal) FROM "BI".fact_sales f JOIN "BI".dim_product p ON f.productid = p.productid JOIN "BI".dim_customer c ON f.customerid = c.customerid WHERE p.categoryname = 'Clothing' AND c.country IS NOT NULL GROUP BY c.country ORDER BY c.country"#,
        GROUPED_TOLERANCE, "Test13: ClothingRevCtx BY country",
    ).await;
    println!("  Test13 OK");

    // 14: Qty2013Ctx BY territory group
    println!("  Running Test14: Qty2013Ctx BY territorygroup...");
    compare_grouped(
        &engine, &pool, "Qty2013Ctx", "dim_territory", "territorygroup",
        r#"SELECT t.territorygroup, SUM(f.orderqty::numeric) FROM "BI".fact_sales f JOIN "BI".dim_territory t ON f.territoryid = t.territoryid JOIN "BI".dim_date d ON f.orderdate = d.datekey WHERE d.year = 2013 AND t.territorygroup IS NOT NULL GROUP BY t.territorygroup ORDER BY t.territorygroup"#,
        GROUPED_TOLERANCE, "Test14: Qty2013Ctx BY territorygroup",
    ).await;
    println!("  Test14 OK");

    // 15: Rev2013Color BY color
    println!("  Running Test15: Rev2013Color BY color...");
    compare_grouped(
        &engine, &pool, "Rev2013Color", "dim_product", "color",
        r#"SELECT p.color, SUM(f.linetotal) FROM "BI".fact_sales f JOIN "BI".dim_product p ON f.productid = p.productid JOIN "BI".dim_date d ON f.orderdate = d.datekey WHERE d.year = 2013 AND p.color IS NOT NULL GROUP BY p.color ORDER BY p.color"#,
        GROUPED_TOLERANCE, "Test15: Rev2013Color BY color",
    ).await;
    println!("  Test15 OK");
}

// ---------------------------------------------------------------------------
// Test cases 16-20: VAR/RETURN combined with named contexts and grouped queries
// ---------------------------------------------------------------------------

/// Tests 16-20: VAR/RETURN measures in grouped queries, plus VAR combined with KEEP
#[tokio::test]
#[ignore]
async fn validate_16_to_20_var_return_grouped_and_combined() {
    let measures = vec![
        // 16: VAR/RETURN avg order value grouped by category
        (
            "AvgOrderVar",
            r#"VAR rev = SUM(fact_sales[linetotal]) VAR orders = COUNT(fact_sales[salesorderdetailid]) RETURN DIVIDE(rev, orders)"#,
        ),
        // 17: VAR/RETURN revenue per unit grouped by year
        (
            "RevPerUnit",
            r#"VAR rev = SUM(fact_sales[linetotal]) VAR qty = SUM(fact_sales[orderqty]) RETURN DIVIDE(rev, qty)"#,
        ),
        // 18: VAR/RETURN with ROUND grouped by territory group
        (
            "RoundedAvg",
            r#"VAR total = SUM(fact_sales[linetotal]) VAR cnt = COUNT(fact_sales[salesorderdetailid]) RETURN ROUND(DIVIDE(total, cnt), 0)"#,
        ),
        // 19: VAR with subtraction — revenue minus total qty (grand total)
        (
            "RevMinusQty",
            r#"VAR rev = SUM(fact_sales[linetotal]) VAR qty = SUM(fact_sales[orderqty]) RETURN rev - qty"#,
        ),
        // 20: VAR with multiplication — double the total qty (grand total)
        (
            "DoubleQtyVar",
            r#"VAR qty = SUM(fact_sales[orderqty]) RETURN qty * 2"#,
        ),
    ];

    let engine = setup_engine(measures).await;
    let pool = make_pool().await;

    // 16: AvgOrderVar BY category
    println!("  Running Test16: AvgOrderVar BY category...");
    compare_grouped(
        &engine, &pool, "AvgOrderVar", "dim_product", "categoryname",
        r#"SELECT p.categoryname, SUM(f.linetotal) / COUNT(f.salesorderdetailid) FROM "BI".fact_sales f JOIN "BI".dim_product p ON f.productid = p.productid WHERE p.categoryname IS NOT NULL GROUP BY p.categoryname ORDER BY p.categoryname"#,
        GROUPED_TOLERANCE, "Test16: AvgOrderVar BY category",
    ).await;
    println!("  Test16 OK");

    // 17: RevPerUnit BY year
    println!("  Running Test17: RevPerUnit BY year...");
    compare_grouped(
        &engine, &pool, "RevPerUnit", "dim_date", "year",
        r#"SELECT d.year, SUM(f.linetotal) / SUM(f.orderqty::numeric) FROM "BI".fact_sales f JOIN "BI".dim_date d ON f.orderdate = d.datekey GROUP BY d.year ORDER BY d.year"#,
        GROUPED_TOLERANCE, "Test17: RevPerUnit BY year",
    ).await;
    println!("  Test17 OK");

    // 18: RoundedAvg BY territory group
    println!("  Running Test18: RoundedAvg BY territorygroup...");
    compare_grouped(
        &engine, &pool, "RoundedAvg", "dim_territory", "territorygroup",
        r#"SELECT t.territorygroup, ROUND(SUM(f.linetotal) / COUNT(f.salesorderdetailid), 0) FROM "BI".fact_sales f JOIN "BI".dim_territory t ON f.territoryid = t.territoryid WHERE t.territorygroup IS NOT NULL GROUP BY t.territorygroup ORDER BY t.territorygroup"#,
        GROUPED_TOLERANCE, "Test18: RoundedAvg BY territorygroup",
    ).await;
    println!("  Test18 OK");

    // 19: RevMinusQty grand total
    println!("  Running Test19: RevMinusQty grand total...");
    compare_grand_total(
        &engine,
        &pool,
        "RevMinusQty",
        r#"SELECT SUM(linetotal) - SUM(orderqty::numeric) FROM "BI".fact_sales"#,
        GRAND_TOTAL_TOLERANCE,
        "Test19: RevMinusQty",
    )
    .await;
    println!("  Test19 OK");

    // 20: DoubleQtyVar grand total
    println!("  Running Test20: DoubleQtyVar grand total...");
    compare_grand_total(
        &engine,
        &pool,
        "DoubleQtyVar",
        r#"SELECT SUM(orderqty::numeric) * 2 FROM "BI".fact_sales"#,
        GRAND_TOTAL_TOLERANCE,
        "Test20: DoubleQtyVar",
    )
    .await;
    println!("  Test20 OK");
}
