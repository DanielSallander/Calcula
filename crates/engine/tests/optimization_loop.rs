//! Automated engine optimization loop.
//!
//! This test generates queries of increasing complexity, runs them with
//! `query_explained()`, and prints execution plan details for analysis.
//!
//! Run with: `cargo test -p bi-engine --test optimization_loop -- --ignored --nocapture`

use bi_engine::*;

const CONNECTION_STRING: &str = "postgresql://postgres:postgres@localhost:5432/Adventureworks";
const SCHEMA: &str = "BI";

// ---------------------------------------------------------------------------
// Model setup
// ---------------------------------------------------------------------------

fn build_model_with_measures(measures: &[(&str, &str)]) -> DataModel {
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
    )
    .unwrap();

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
    )
    .unwrap();

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
    )
    .unwrap();

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
    )
    .unwrap();

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
    )
    .unwrap();

    let fact_purchasing = Table::new(
        "fact_purchasing",
        vec![
            Column::new("purchaseorderdetailid", DataType::Int32),
            Column::new("purchaseorderid", DataType::Int32),
            Column::new("orderdate", DataType::Date),
            Column::new("duedate", DataType::Date),
            Column::new("productid", DataType::Int32),
            Column::new("vendorid", DataType::Int32),
            Column::new("employeeid", DataType::Int32),
            Column::new("revisionnumber", DataType::Int32),
            Column::new("status", DataType::Int32),
            Column::new("unitprice", DataType::Decimal(38, 6)),
            Column::new("receivedqty", DataType::Decimal(8, 2)),
            Column::new("rejectedqty", DataType::Decimal(8, 2)),
        ],
    )
    .unwrap();

    let mut builder = DataModel::builder()
        .add_table(fact_sales)
        .add_table(fact_purchasing)
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
        ))
        .add_relationship(Relationship::new(
            "fact_purchasing_to_dim_product",
            "fact_purchasing",
            "productid",
            "dim_product",
            "productid",
            Cardinality::ManyToOne,
        ))
        .add_relationship(Relationship::new(
            "fact_purchasing_to_dim_date",
            "fact_purchasing",
            "orderdate",
            "dim_date",
            "datekey",
            Cardinality::ManyToOne,
        ));

    for (name, expr_text) in measures {
        let expr = parse_measure_expression(expr_text)
            .unwrap_or_else(|e| panic!("Failed to parse measure '{name}': {e}"));
        builder = builder.add_measure(expression_measure(*name, expr));
    }

    builder.build().unwrap()
}

async fn setup_engine(measures: Vec<(&str, &str)>) -> Engine {
    let model = build_model_with_measures(&measures);

    let mut engine = Engine::new(model);
    let pg_idx = engine
        .add_postgres(PostgresConfig::new(CONNECTION_STRING))
        .await
        .expect("failed to connect to postgres");

    let tables = vec![
        "fact_sales",
        "fact_purchasing",
        "dim_product",
        "dim_customer",
        "dim_territory",
        "dim_date",
    ];
    for name in tables {
        engine.bind_table(name, pg_idx, SourceBinding::new(SCHEMA, name));
    }
    engine
}

/// Pretty-print the execution plan tree
fn print_plan_tree(node: &PlanNode, indent: usize) {
    let pad = "  ".repeat(indent);
    let dur = node.duration.ms;
    println!("{pad}{:?}: {} [{:.2}ms]", node.operation, node.label, dur);
    for prop in &node.properties {
        println!("{pad}  {}: {:?}", prop.key, prop.value);
    }
    for child in &node.children {
        print_plan_tree(child, indent + 1);
    }
}

/// Print result rows (first few)
fn print_results(batches: &[arrow::record_batch::RecordBatch], max_rows: usize) {
    let mut printed = 0;
    for batch in batches {
        if printed >= max_rows {
            break;
        }
        let schema = batch.schema();
        let cols: Vec<&str> = schema.fields().iter().map(|f| f.name().as_str()).collect();
        if printed == 0 {
            println!("  Columns: {:?}", cols);
        }
        let rows_to_show = (max_rows - printed).min(batch.num_rows());
        for row in 0..rows_to_show {
            let vals: Vec<String> = (0..batch.num_columns())
                .map(|c| {
                    let arr = batch.column(c);
                    if arr.is_null(row) {
                        "NULL".to_string()
                    } else {
                        format!("{:?}", arr.as_ref().slice(row, 1))
                    }
                })
                .collect();
            println!("  Row {}: {:?}", printed + row, vals);
        }
        printed += rows_to_show;
    }
    let total: usize = batches.iter().map(|b| b.num_rows()).sum();
    println!("  Total rows: {total}");
}

// ---------------------------------------------------------------------------
// Query definitions — increasing complexity
// ---------------------------------------------------------------------------

struct TestQuery {
    name: &'static str,
    measures: Vec<(&'static str, &'static str)>,
    group_by: Vec<(&'static str, &'static str)>,
    description: &'static str,
}

fn get_queries() -> Vec<TestQuery> {
    vec![
        // Level 1: Simple single-measure aggregation
        TestQuery {
            name: "Q1: Simple SUM grouped by product",
            measures: vec![("TotalSales", "SUM(fact_sales[linetotal])")],
            group_by: vec![("dim_product", "productname")],
            description: "Basic pushed-down aggregation with single star-join",
        },
        // Level 2: Multiple measures, same fact table
        TestQuery {
            name: "Q2: Multiple measures by category",
            measures: vec![
                ("TotalSales", "SUM(fact_sales[linetotal])"),
                ("TotalQty", "SUM(fact_sales[orderqty])"),
                ("AvgPrice", "AVG(fact_sales[unitprice])"),
            ],
            group_by: vec![("dim_product", "categoryname")],
            description: "Multiple simple aggregates — can all be pushed down together",
        },
        // Level 3: DIVIDE expression (compound)
        TestQuery {
            name: "Q3: Computed KPI by territory",
            measures: vec![
                ("AvgOrderValue", "DIVIDE(SUM(fact_sales[linetotal]), COUNT(fact_sales[salesorderdetailid]), 0)"),
            ],
            group_by: vec![("dim_territory", "territoryname")],
            description: "SafeDivide of two aggregates — should still push both aggs",
        },
        // Level 4: KEEP context filter
        TestQuery {
            name: "Q4: KEEP filter by year",
            measures: vec![
                ("TotalSales", "SUM(fact_sales[linetotal])"),
                ("BikeSales", r#"SUM(fact_sales[linetotal], KEEP(dim_product, dim_product[categoryname] = "Bikes"))"#),
            ],
            group_by: vec![("dim_date", "yearmonth")],
            description: "KEEP context filter — requires relationship-filter propagation",
        },
        // Level 5: VAR/RETURN with multiple bindings
        TestQuery {
            name: "Q5: VAR/RETURN health score",
            measures: vec![
                ("HealthScore", r#"VAR total = SUM(fact_sales[linetotal]) VAR lines = COUNT(fact_sales[salesorderdetailid]) VAR avg_val = DIVIDE(total, lines, 0) RETURN IF(total > 10000 AND avg_val > 100, "Excellent", IF(total > 5000 OR lines > 20, "Good", "Needs Attention"))"#),
            ],
            group_by: vec![("dim_product", "categoryname")],
            description: "VAR/RETURN block with IF logic and multiple variable references",
        },
        // Level 6: CLEAR context + percentage
        TestQuery {
            name: "Q6: Percentage of total (CLEAR)",
            measures: vec![
                ("PctOfTotal", "DIVIDE(SUM(fact_sales[linetotal]), SUM(fact_sales[linetotal], CLEAR(dim_product)), 0)"),
            ],
            group_by: vec![("dim_product", "categoryname")],
            description: "CLEAR removes group-by filter for denominator — two separate aggregations needed",
        },
        // Level 7: Multi-dimension group-by
        TestQuery {
            name: "Q7: Cross-dimension grouping",
            measures: vec![
                ("TotalSales", "SUM(fact_sales[linetotal])"),
                ("DistinctCustomers", "DISTINCTCOUNT(fact_sales[customerid])"),
            ],
            group_by: vec![
                ("dim_product", "categoryname"),
                ("dim_territory", "countryregioncode"),
            ],
            description: "Two dimension tables in group-by — multi-join star query",
        },
        // Level 8: Complex VAR + KEEP + arithmetic
        TestQuery {
            name: "Q8: Bike share with VAR + conditional",
            measures: vec![
                ("BikeMetric", r#"VAR bike_qty = SUM(fact_sales[orderqty], KEEP(dim_product, dim_product[categoryname] = "Bikes")) VAR total_qty = SUM(fact_sales[orderqty]) RETURN IF(DIVIDE(bike_qty, total_qty, 0) > 0.5, POWER(bike_qty, 0.5), bike_qty)"#),
            ],
            group_by: vec![("dim_territory", "countryregioncode")],
            description: "VAR with KEEP + DIVIDE + conditional POWER — complex expression",
        },
        // Level 9: Multiple KEEP filters + COALESCE
        TestQuery {
            name: "Q9: Bike vs Clothing ratio",
            measures: vec![
                ("Ratio", r#"DIVIDE(SUM(fact_sales[linetotal], KEEP(dim_product, dim_product[categoryname] = "Bikes")), COALESCE(SUM(fact_sales[linetotal], KEEP(dim_product, dim_product[categoryname] = "Clothing")), 1), 0)"#),
            ],
            group_by: vec![("dim_territory", "territoryname")],
            description: "Two different KEEP filters in one expression with COALESCE fallback",
        },
        // Level 10: Grand total + nested functions
        TestQuery {
            name: "Q10: Nested scalar functions",
            measures: vec![
                ("SqrtRevPerCust", "ROUND(SQRT(ABS(DIVIDE(SUM(fact_sales[linetotal]), DISTINCTCOUNT(fact_sales[customerid]), 0))), 2)"),
            ],
            group_by: vec![("dim_product", "subcategoryname")],
            description: "Deeply nested scalar functions around aggregates",
        },
        // Level 11: CLEAR + KEEP combined
        TestQuery {
            name: "Q11: KEEP Bikes + CLEAR territory",
            measures: vec![
                ("KeepBikesClearTerritory", r#"SUM(fact_sales[linetotal], KEEP(dim_product, dim_product[categoryname] = "Bikes"), CLEAR(dim_territory))"#),
            ],
            group_by: vec![
                ("dim_territory", "countryregioncode"),
                ("dim_date", "yearmonth"),
            ],
            description: "KEEP + CLEAR combination — tests context manipulation ordering",
        },
        // Level 12: Multiple measures mixed complexity
        TestQuery {
            name: "Q12: Mixed complexity measures",
            measures: vec![
                ("TotalSales", "SUM(fact_sales[linetotal])"),
                ("BikeShare", r#"DIVIDE(SUM(fact_sales[linetotal], KEEP(dim_product, dim_product[categoryname] = "Bikes")), SUM(fact_sales[linetotal]), 0)"#),
                ("AvgOrder", "DIVIDE(SUM(fact_sales[linetotal]), COUNT(fact_sales[salesorderdetailid]), 0)"),
                ("PctOfTotal", "DIVIDE(SUM(fact_sales[linetotal]), SUM(fact_sales[linetotal], CLEAR(dim_product)), 0)"),
            ],
            group_by: vec![("dim_product", "categoryname")],
            description: "Four measures of increasing complexity in one query",
        },
        // =====================================================================
        // Level 13+: More complex queries for stress testing
        // =====================================================================
        // Level 13: Multi-VAR with nested DIVIDE and IF
        TestQuery {
            name: "Q13: Multi-VAR revenue tiers",
            measures: vec![
                ("RevenueTier", r#"VAR rev = SUM(fact_sales[linetotal]) VAR qty = SUM(fact_sales[orderqty]) VAR avg_price = DIVIDE(rev, qty, 0) VAR tier_score = DIVIDE(rev, 10000, 0) RETURN IF(tier_score > 5 AND avg_price > 100, ROUND(SQRT(tier_score), 1), IF(tier_score > 1, ROUND(tier_score, 2), 0))"#),
            ],
            group_by: vec![("dim_product", "subcategoryname")],
            description: "Multi-VAR with nested IF/ROUND/SQRT and compound conditions",
        },
        // Level 14: KEEP on multiple dimensions simultaneously
        TestQuery {
            name: "Q14: Multi-dimension KEEP",
            measures: vec![
                ("TotalSales", "SUM(fact_sales[linetotal])"),
                ("USBikeSales", r#"SUM(fact_sales[linetotal], KEEP(dim_product, dim_product[categoryname] = "Bikes"), KEEP(dim_territory, dim_territory[countryregioncode] = "US"))"#),
            ],
            group_by: vec![("dim_date", "yearmonth")],
            description: "KEEP on two different dimensions simultaneously — multi-CASE-WHEN",
        },
        // Level 15: IF with compound conditions and multiple aggregates
        TestQuery {
            name: "Q15: Conditional multi-aggregate",
            measures: vec![
                ("VolumeCat", "VAR cnt = COUNT(fact_sales[salesorderdetailid]) VAR avg_line = DIVIDE(SUM(fact_sales[linetotal]), cnt, 0) RETURN IF(cnt > 50 AND avg_line > 500, cnt * avg_line, IF(cnt > 10, cnt, 0))"),
            ],
            group_by: vec![("dim_product", "categoryname"), ("dim_territory", "countryregioncode")],
            description: "VAR + IF with compound conditions and arithmetic on aggregates",
        },
        // Level 16: Weighted average with POWER and multiple aggregates
        TestQuery {
            name: "Q16: Weighted metrics with POWER",
            measures: vec![
                ("WeightedAvg", "DIVIDE(SUM(fact_sales[unitprice] * fact_sales[orderqty]), SUM(fact_sales[orderqty]), 0)"),
                ("GeometricIndex", "POWER(DIVIDE(SUM(fact_sales[linetotal]), 1000000, 1), DIVIDE(1, DISTINCTCOUNT(fact_sales[productid]), 1))"),
            ],
            group_by: vec![("dim_territory", "countryregioncode")],
            description: "Compound arithmetic with POWER, deeply nested DIVIDE",
        },
        // Level 17: Multiple KEEP with DIVIDE — ratio between two filtered segments
        TestQuery {
            name: "Q17: Segment ratio analysis",
            measures: vec![
                ("ComponentShare", r#"DIVIDE(SUM(fact_sales[linetotal], KEEP(dim_product, dim_product[categoryname] = "Components")), SUM(fact_sales[linetotal]), 0)"#),
                ("AccessoryShare", r#"DIVIDE(SUM(fact_sales[linetotal], KEEP(dim_product, dim_product[categoryname] = "Accessories")), SUM(fact_sales[linetotal]), 0)"#),
                ("SegmentRatio", r#"DIVIDE(SUM(fact_sales[linetotal], KEEP(dim_product, dim_product[categoryname] = "Bikes")), COALESCE(SUM(fact_sales[linetotal], KEEP(dim_product, dim_product[categoryname] = "Components")), 1), 0)"#),
            ],
            group_by: vec![("dim_territory", "territoryname")],
            description: "Three measures with different KEEP segments + COALESCE fallback",
        },
        // Level 18: IF with comparison of two aggregates + KEEP
        TestQuery {
            name: "Q18: Conditional KEEP comparison",
            measures: vec![
                ("IsBikeHeavy", r#"IF(SUM(fact_sales[linetotal], KEEP(dim_product, dim_product[categoryname] = "Bikes")) > SUM(fact_sales[linetotal], KEEP(dim_product, dim_product[categoryname] = "Clothing")), SUM(fact_sales[linetotal], KEEP(dim_product, dim_product[categoryname] = "Bikes")), SUM(fact_sales[linetotal], KEEP(dim_product, dim_product[categoryname] = "Clothing")))"#),
            ],
            group_by: vec![("dim_territory", "countryregioncode")],
            description: "IF comparing two KEEP-filtered aggregates — conditional measure",
        },
        // Level 19: Grand total (no group by) with complex expression
        TestQuery {
            name: "Q19: Grand total complex KPI",
            measures: vec![
                ("OverallHealth", r#"VAR rev = SUM(fact_sales[linetotal]) VAR orders = COUNT(fact_sales[salesorderdetailid]) VAR customers = DISTINCTCOUNT(fact_sales[customerid]) VAR rev_per_cust = DIVIDE(rev, customers, 0) VAR orders_per_cust = DIVIDE(orders, customers, 0) RETURN ROUND(SQRT(rev_per_cust * orders_per_cust), 2)"#),
            ],
            group_by: vec![],
            description: "No group-by, 5 VARs with SQRT of product of two ratios",
        },
        // Level 20: Three dimensions in group-by with KEEP + arithmetic
        TestQuery {
            name: "Q20: Triple-dimension with KEEP arithmetic",
            measures: vec![
                ("NetRevenue", r#"SUM(fact_sales[linetotal]) - SUM(fact_sales[linetotal], KEEP(dim_product, dim_product[categoryname] = "Accessories"))"#),
            ],
            group_by: vec![
                ("dim_product", "categoryname"),
                ("dim_territory", "countryregioncode"),
                ("dim_date", "yearmonth"),
            ],
            description: "Arithmetic between plain SUM and KEEP-filtered SUM, 3 dimension group-by",
        },
        // =====================================================================
        // Level 21+: Multi-measure stress tests
        // =====================================================================
        // Level 21: 6 measures — full KPI dashboard by territory
        TestQuery {
            name: "Q21: Dashboard KPIs (6 measures)",
            measures: vec![
                ("Revenue", "SUM(fact_sales[linetotal])"),
                ("Orders", "COUNT(fact_sales[salesorderdetailid])"),
                ("AvgOrderValue", "DIVIDE(SUM(fact_sales[linetotal]), COUNT(fact_sales[salesorderdetailid]), 0)"),
                ("UniqueCustomers", "DISTINCTCOUNT(fact_sales[customerid])"),
                ("RevenuePerCustomer", "DIVIDE(SUM(fact_sales[linetotal]), DISTINCTCOUNT(fact_sales[customerid]), 0)"),
                ("AvgQty", "DIVIDE(SUM(fact_sales[orderqty]), COUNT(fact_sales[salesorderdetailid]), 0)"),
            ],
            group_by: vec![("dim_territory", "territoryname")],
            description: "Six KPI measures in one query — tests multi-measure pushdown efficiency",
        },
        // Level 22: 5 measures mixing simple + VAR + KEEP by subcategory
        TestQuery {
            name: "Q22: Mixed measure types (5 measures)",
            measures: vec![
                ("TotalSales", "SUM(fact_sales[linetotal])"),
                ("TotalQty", "SUM(fact_sales[orderqty])"),
                ("PriceIndex", "VAR rev = SUM(fact_sales[linetotal]) VAR qty = SUM(fact_sales[orderqty]) RETURN IF(qty > 0, ROUND(DIVIDE(rev, qty, 0), 2), 0)"),
                ("HighValuePct", r#"DIVIDE(SUM(fact_sales[linetotal], KEEP(dim_product, dim_product[listprice] > 1000)), SUM(fact_sales[linetotal]), 0)"#),
                ("MaxLine", "MAX(fact_sales[linetotal])"),
            ],
            group_by: vec![("dim_product", "subcategoryname")],
            description: "Mix of simple, VAR/RETURN, and KEEP measures — all in one query",
        },
        // Level 23: Multi-measure multi-dim with conditional logic
        TestQuery {
            name: "Q23: Category analysis (4 measures, 2 dims)",
            measures: vec![
                ("Revenue", "SUM(fact_sales[linetotal])"),
                ("Margin", "DIVIDE(SUM(fact_sales[linetotal]) - SUM(fact_sales[unitprice] * fact_sales[orderqty]), SUM(fact_sales[linetotal]), 0)"),
                ("OrderSize", "VAR total = SUM(fact_sales[linetotal]) VAR cnt = COUNT(fact_sales[salesorderdetailid]) RETURN IF(cnt > 0, ROUND(DIVIDE(total, cnt, 0), 0), 0)"),
                ("IsHighVolume", "IF(COUNT(fact_sales[salesorderdetailid]) > 100, COUNT(fact_sales[salesorderdetailid]), 0)"),
            ],
            group_by: vec![("dim_product", "categoryname"), ("dim_territory", "territorygroup")],
            description: "Four measures with arithmetic, VAR, IF — two dimension group-by",
        },
        // Level 24: Competing KEEP filters — 4 category shares + total
        TestQuery {
            name: "Q24: Category shares (5 measures with KEEP)",
            measures: vec![
                ("TotalSales", "SUM(fact_sales[linetotal])"),
                ("BikeRevenue", r#"SUM(fact_sales[linetotal], KEEP(dim_product, dim_product[categoryname] = "Bikes"))"#),
                ("ClothingRevenue", r#"SUM(fact_sales[linetotal], KEEP(dim_product, dim_product[categoryname] = "Clothing"))"#),
                ("ComponentRevenue", r#"SUM(fact_sales[linetotal], KEEP(dim_product, dim_product[categoryname] = "Components"))"#),
                ("AccessoryRevenue", r#"SUM(fact_sales[linetotal], KEEP(dim_product, dim_product[categoryname] = "Accessories"))"#),
            ],
            group_by: vec![("dim_territory", "countryregioncode")],
            description: "Five measures: 1 total + 4 KEEP-filtered by category",
        },
        // Level 25: 8 measures — full analytical report by year
        TestQuery {
            name: "Q25: Full report (8 measures by year)",
            measures: vec![
                ("Revenue", "SUM(fact_sales[linetotal])"),
                ("Qty", "SUM(fact_sales[orderqty])"),
                ("AvgPrice", "AVG(fact_sales[unitprice])"),
                ("OrderCount", "COUNT(fact_sales[salesorderdetailid])"),
                ("AvgOrderValue", "DIVIDE(SUM(fact_sales[linetotal]), COUNT(fact_sales[salesorderdetailid]), 0)"),
                ("DistinctProducts", "DISTINCTCOUNT(fact_sales[productid])"),
                ("RevenuePerProduct", "DIVIDE(SUM(fact_sales[linetotal]), DISTINCTCOUNT(fact_sales[productid]), 0)"),
                ("QtyPerOrder", "DIVIDE(SUM(fact_sales[orderqty]), COUNT(fact_sales[salesorderdetailid]), 0)"),
            ],
            group_by: vec![("dim_date", "yearmonth")],
            description: "Eight measures — mix of simple and compound — grouped by yearmonth",
        },
        // Level 26: Multi-measure with VAR sharing common sub-aggregates
        TestQuery {
            name: "Q26: Shared sub-aggregates (3 VAR measures)",
            measures: vec![
                ("EfficiencyScore", "VAR rev = SUM(fact_sales[linetotal]) VAR qty = SUM(fact_sales[orderqty]) VAR cust = DISTINCTCOUNT(fact_sales[customerid]) RETURN ROUND(DIVIDE(rev, qty * cust, 0), 4)"),
                ("VolumeScore", "VAR qty = SUM(fact_sales[orderqty]) VAR orders = COUNT(fact_sales[salesorderdetailid]) RETURN ROUND(DIVIDE(qty, orders, 0), 2)"),
                ("ValueScore", "VAR rev = SUM(fact_sales[linetotal]) VAR cust = DISTINCTCOUNT(fact_sales[customerid]) RETURN ROUND(SQRT(DIVIDE(rev, cust, 0)), 2)"),
            ],
            group_by: vec![("dim_product", "categoryname")],
            description: "Three VAR measures that share similar sub-aggregates (SUM, COUNT, DISTINCTCOUNT)",
        },
        // Level 27: 4 measures with different KEEP + non-KEEP mix, 2 dimensions
        TestQuery {
            name: "Q27: KEEP mix with ratios (4 measures, 2 dims)",
            measures: vec![
                ("TotalRev", "SUM(fact_sales[linetotal])"),
                ("BikeShare", r#"DIVIDE(SUM(fact_sales[linetotal], KEEP(dim_product, dim_product[categoryname] = "Bikes")), SUM(fact_sales[linetotal]), 0)"#),
                ("HighPriceOrders", r#"COUNT(fact_sales[salesorderdetailid], KEEP(dim_product, dim_product[listprice] > 500))"#),
                ("AvgBikePrice", r#"DIVIDE(SUM(fact_sales[linetotal], KEEP(dim_product, dim_product[categoryname] = "Bikes")), COUNT(fact_sales[salesorderdetailid], KEEP(dim_product, dim_product[categoryname] = "Bikes")), 0)"#),
            ],
            group_by: vec![("dim_territory", "countryregioncode"), ("dim_date", "yearmonth")],
            description: "Mix of plain + KEEP measures with ratios, two dimension group-by",
        },
        // Level 28: Grand total with many measures (no GROUP BY)
        TestQuery {
            name: "Q28: Grand total scorecard (6 measures)",
            measures: vec![
                ("TotalRevenue", "SUM(fact_sales[linetotal])"),
                ("TotalOrders", "COUNT(fact_sales[salesorderdetailid])"),
                ("AvgOrderValue", "DIVIDE(SUM(fact_sales[linetotal]), COUNT(fact_sales[salesorderdetailid]), 0)"),
                ("MaxSingleOrder", "MAX(fact_sales[linetotal])"),
                ("CustomerCount", "DISTINCTCOUNT(fact_sales[customerid])"),
                ("ProductCount", "DISTINCTCOUNT(fact_sales[productid])"),
            ],
            group_by: vec![],
            description: "Six measures with no group-by — grand total scorecard",
        },
        // =====================================================================
        // Level 29+: New function tests (ITERATE, YEAR, DATEDIFF, IFERROR,
        //            ISINSCOPE, CLEAREXCEPT)
        // =====================================================================
        // --- ITERATE tests ---
        TestQuery {
            name: "Q29: ITERATE basic (SUM of row-level product)",
            measures: vec![
                ("ComputedRevenue", "SUM(ITERATE(fact_sales, fact_sales[unitprice] * fact_sales[orderqty]))"),
                ("PlainRevenue", "SUM(fact_sales[linetotal])"),
            ],
            group_by: vec![("dim_product", "categoryname")],
            description: "SUM(ITERATE(...)) vs plain SUM — compare row-level vs column-level",
        },
        TestQuery {
            name: "Q30: ITERATE with division (3 measures)",
            measures: vec![
                ("AvgEffectivePrice", "AVG(ITERATE(fact_sales, DIVIDE(fact_sales[linetotal], fact_sales[orderqty], 0)))"),
                ("MaxEffectivePrice", "MAX(ITERATE(fact_sales, DIVIDE(fact_sales[linetotal], fact_sales[orderqty], 0)))"),
                ("MinEffectivePrice", "MIN(ITERATE(fact_sales, DIVIDE(fact_sales[linetotal], fact_sales[orderqty], 0)))"),
            ],
            group_by: vec![("dim_product", "categoryname")],
            description: "AVG/MAX/MIN of per-row DIVIDE — iterator aggregate functions",
        },
        TestQuery {
            name: "Q31: ITERATE with conditional logic",
            measures: vec![
                ("PremiumRevenue", "SUM(ITERATE(fact_sales, IF(fact_sales[unitprice] > 100, fact_sales[linetotal], 0)))"),
                ("BudgetRevenue", "SUM(ITERATE(fact_sales, IF(fact_sales[unitprice] <= 100, fact_sales[linetotal], 0)))"),
                ("PremiumPct", "DIVIDE(SUM(ITERATE(fact_sales, IF(fact_sales[unitprice] > 100, fact_sales[linetotal], 0))), SUM(fact_sales[linetotal]), 0)"),
            ],
            group_by: vec![("dim_territory", "countryregioncode")],
            description: "ITERATE with IF for row-level conditional aggregation + ratio",
        },
        TestQuery {
            name: "Q32: ITERATE with scalar functions",
            measures: vec![
                ("RoundedAvgUnit", "AVG(ITERATE(fact_sales, ROUND(fact_sales[unitprice], 0)))"),
                ("AbsDiff", "SUM(ITERATE(fact_sales, ABS(fact_sales[linetotal] - fact_sales[unitprice] * fact_sales[orderqty])))"),
            ],
            group_by: vec![("dim_product", "subcategoryname")],
            description: "ITERATE with ROUND and ABS scalar functions at row level",
        },
        // --- YEAR / date grouping tests ---
        TestQuery {
            name: "Q33: Year/quarter measures (3 measures)",
            measures: vec![
                ("Revenue", "SUM(fact_sales[linetotal])"),
                ("OrderCount", "COUNT(fact_sales[salesorderdetailid])"),
                ("AvgOrder", "DIVIDE(SUM(fact_sales[linetotal]), COUNT(fact_sales[salesorderdetailid]), 0)"),
            ],
            group_by: vec![("dim_date", "year"), ("dim_date", "quarter")],
            description: "Three measures grouped by year and quarter",
        },
        // --- IFERROR tests ---
        TestQuery {
            name: "Q34: IFERROR safe divisions (3 measures)",
            measures: vec![
                ("SafeAvgOrder", "IFERROR(DIVIDE(SUM(fact_sales[linetotal]), COUNT(fact_sales[salesorderdetailid]), 0), 0)"),
                ("SafeRevPerCust", "IFERROR(DIVIDE(SUM(fact_sales[linetotal]), DISTINCTCOUNT(fact_sales[customerid]), 0), 0)"),
                ("SafeQtyPerOrder", "IFERROR(DIVIDE(SUM(fact_sales[orderqty]), COUNT(fact_sales[salesorderdetailid]), 0), 0)"),
            ],
            group_by: vec![("dim_product", "categoryname")],
            description: "Three IFERROR-wrapped DIVIDE measures",
        },
        TestQuery {
            name: "Q35: IFERROR nested with SQRT and POWER",
            measures: vec![
                ("SafeSqrt", "IFERROR(ROUND(SQRT(DIVIDE(SUM(fact_sales[linetotal]), DISTINCTCOUNT(fact_sales[customerid]), 0)), 2), 0)"),
                ("SafePower", "IFERROR(POWER(DIVIDE(SUM(fact_sales[linetotal]), 1000000, 1), 0.5), 0)"),
            ],
            group_by: vec![("dim_territory", "territoryname")],
            description: "IFERROR protecting SQRT and POWER from domain errors",
        },
        // --- ISINSCOPE tests ---
        TestQuery {
            name: "Q36: ISINSCOPE true case (category in scope)",
            measures: vec![
                ("Revenue", "SUM(fact_sales[linetotal])"),
                ("DetailMeasure", r#"IF(ISINSCOPE(dim_product[categoryname]), DIVIDE(SUM(fact_sales[linetotal]), COUNT(fact_sales[salesorderdetailid]), 0), SUM(fact_sales[linetotal]))"#),
            ],
            group_by: vec![("dim_product", "categoryname")],
            description: "ISINSCOPE=TRUE: DetailMeasure shows avg order value",
        },
        TestQuery {
            name: "Q37: ISINSCOPE false case (product not in scope)",
            measures: vec![
                ("Revenue", "SUM(fact_sales[linetotal])"),
                ("ScopedDetail", r#"IF(ISINSCOPE(dim_product[productname]), DIVIDE(SUM(fact_sales[linetotal]), DISTINCTCOUNT(fact_sales[productid]), 0), SUM(fact_sales[linetotal]))"#),
            ],
            group_by: vec![("dim_territory", "countryregioncode")],
            description: "ISINSCOPE=FALSE: ScopedDetail falls back to plain SUM",
        },
        // --- CLEAREXCEPT tests ---
        TestQuery {
            name: "Q38: CLEAREXCEPT basic (keep category only)",
            measures: vec![
                ("Revenue", "SUM(fact_sales[linetotal])"),
                ("CategoryTotal", "SUM(fact_sales[linetotal], CLEAREXCEPT(dim_product, dim_product[categoryname]))"),
            ],
            group_by: vec![("dim_product", "categoryname"), ("dim_product", "subcategoryname")],
            description: "CLEAREXCEPT keeps categoryname, clears subcategoryname — category-level total",
        },
        TestQuery {
            name: "Q39: CLEAREXCEPT pct-of-category (3 measures)",
            measures: vec![
                ("Revenue", "SUM(fact_sales[linetotal])"),
                ("CategoryTotal", "SUM(fact_sales[linetotal], CLEAREXCEPT(dim_product, dim_product[categoryname]))"),
                ("PctOfCategory", "DIVIDE(SUM(fact_sales[linetotal]), SUM(fact_sales[linetotal], CLEAREXCEPT(dim_product, dim_product[categoryname])), 0)"),
            ],
            group_by: vec![("dim_product", "categoryname"), ("dim_product", "subcategoryname")],
            description: "Subcategory as pct of category using CLEAREXCEPT",
        },
        // --- Combined function tests ---
        TestQuery {
            name: "Q40: ITERATE + KEEP combined",
            measures: vec![
                ("BikeComputedRev", r#"SUM(ITERATE(fact_sales, fact_sales[unitprice] * fact_sales[orderqty]), KEEP(dim_product, dim_product[categoryname] = "Bikes"))"#),
                ("AllComputedRev", "SUM(ITERATE(fact_sales, fact_sales[unitprice] * fact_sales[orderqty]))"),
            ],
            group_by: vec![("dim_territory", "countryregioncode")],
            description: "ITERATE inside KEEP context — row-level filtered by category",
        },
        TestQuery {
            name: "Q41: IFERROR + ITERATE safe row compute",
            measures: vec![
                ("SafeUnitRev", "AVG(ITERATE(fact_sales, IFERROR(DIVIDE(fact_sales[linetotal], fact_sales[orderqty], 0), 0)))"),
                ("TotalQty", "SUM(fact_sales[orderqty])"),
            ],
            group_by: vec![("dim_product", "categoryname")],
            description: "IFERROR inside ITERATE for safe per-row division",
        },
        TestQuery {
            name: "Q42: ISINSCOPE + CLEAREXCEPT dashboard (4 measures)",
            measures: vec![
                ("Revenue", "SUM(fact_sales[linetotal])"),
                ("ParentTotal", "SUM(fact_sales[linetotal], CLEAREXCEPT(dim_product, dim_product[categoryname]))"),
                ("PctOfParent", "DIVIDE(SUM(fact_sales[linetotal]), SUM(fact_sales[linetotal], CLEAREXCEPT(dim_product, dim_product[categoryname])), 0)"),
                ("ScopedLabel", r#"IF(ISINSCOPE(dim_product[subcategoryname]), DIVIDE(SUM(fact_sales[linetotal]), SUM(fact_sales[linetotal], CLEAREXCEPT(dim_product, dim_product[categoryname])), 0), SUM(fact_sales[linetotal]))"#),
            ],
            group_by: vec![("dim_product", "categoryname"), ("dim_product", "subcategoryname")],
            description: "ISINSCOPE + CLEAREXCEPT — adaptive parent-pct",
        },
        TestQuery {
            name: "Q43: Function kitchen sink (5 measures)",
            measures: vec![
                ("ComputedRev", "SUM(ITERATE(fact_sales, fact_sales[unitprice] * fact_sales[orderqty]))"),
                ("AvgEffPrice", "AVG(ITERATE(fact_sales, IFERROR(DIVIDE(fact_sales[linetotal], fact_sales[orderqty], 0), 0)))"),
                ("TotalSales", "SUM(fact_sales[linetotal])"),
                ("BikeShare", r#"DIVIDE(SUM(fact_sales[linetotal], KEEP(dim_product, dim_product[categoryname] = "Bikes")), SUM(fact_sales[linetotal]), 0)"#),
                ("HealthScore", r#"VAR rev = SUM(fact_sales[linetotal]) VAR orders = COUNT(fact_sales[salesorderdetailid]) RETURN IF(rev > 10000 AND orders > 50, "High", IF(rev > 1000, "Medium", "Low"))"#),
            ],
            group_by: vec![("dim_territory", "countryregioncode")],
            description: "ITERATE, IFERROR, KEEP, VAR — full function coverage",
        },
        TestQuery {
            name: "Q44: CLEAREXCEPT vs CLEAR comparison (4 measures)",
            measures: vec![
                ("Revenue", "SUM(fact_sales[linetotal])"),
                ("AllProductTotal", "SUM(fact_sales[linetotal], CLEAR(dim_product))"),
                ("CategoryTotal", "SUM(fact_sales[linetotal], CLEAREXCEPT(dim_product, dim_product[categoryname]))"),
                ("PctOfAll", "DIVIDE(SUM(fact_sales[linetotal]), SUM(fact_sales[linetotal], CLEAR(dim_product)), 0)"),
            ],
            group_by: vec![("dim_product", "categoryname"), ("dim_product", "subcategoryname")],
            description: "CLEAR vs CLEAREXCEPT same query — different scoping",
        },
        TestQuery {
            name: "Q45: Multiple ITERATE aggregates (4 measures)",
            measures: vec![
                ("SumRowCalc", "SUM(ITERATE(fact_sales, fact_sales[unitprice] * fact_sales[orderqty]))"),
                ("AvgRowCalc", "AVG(ITERATE(fact_sales, fact_sales[unitprice] * fact_sales[orderqty]))"),
                ("MaxRowCalc", "MAX(ITERATE(fact_sales, fact_sales[unitprice] * fact_sales[orderqty]))"),
                ("MinRowCalc", "MIN(ITERATE(fact_sales, fact_sales[unitprice] * fact_sales[orderqty]))"),
            ],
            group_by: vec![("dim_product", "subcategoryname")],
            description: "Same ITERATE with SUM/AVG/MAX/MIN",
        },
        TestQuery {
            name: "Q46: CLEAREXCEPT multi-dim (year scope)",
            measures: vec![
                ("Revenue", "SUM(fact_sales[linetotal])"),
                ("YearTotal", "SUM(fact_sales[linetotal], CLEAREXCEPT(dim_date, dim_date[year]))"),
                ("PctOfYear", "DIVIDE(SUM(fact_sales[linetotal]), SUM(fact_sales[linetotal], CLEAREXCEPT(dim_date, dim_date[year])), 0)"),
            ],
            group_by: vec![("dim_territory", "countryregioncode"), ("dim_date", "year"), ("dim_date", "quarter")],
            description: "CLEAREXCEPT on dim_date keeping year — clears quarter",
        },
        TestQuery {
            name: "Q47: Grand total with new functions (5 measures)",
            measures: vec![
                ("IteratedRev", "SUM(ITERATE(fact_sales, fact_sales[unitprice] * fact_sales[orderqty]))"),
                ("SafeAvg", "IFERROR(DIVIDE(SUM(fact_sales[linetotal]), DISTINCTCOUNT(fact_sales[customerid]), 0), 0)"),
                ("PlainRevenue", "SUM(fact_sales[linetotal])"),
                ("OrderCount", "COUNT(fact_sales[salesorderdetailid])"),
                ("UniqueProducts", "DISTINCTCOUNT(fact_sales[productid])"),
            ],
            group_by: vec![],
            description: "Grand total with ITERATE + IFERROR — no group-by",
        },
        TestQuery {
            name: "Q48: ITERATE + CLEAREXCEPT + KEEP mega-mix (6 measures, 3 dims)",
            measures: vec![
                ("Revenue", "SUM(fact_sales[linetotal])"),
                ("ComputedRev", "SUM(ITERATE(fact_sales, fact_sales[unitprice] * fact_sales[orderqty]))"),
                ("BikeRev", r#"SUM(fact_sales[linetotal], KEEP(dim_product, dim_product[categoryname] = "Bikes"))"#),
                ("CategoryTotal", "SUM(fact_sales[linetotal], CLEAREXCEPT(dim_product, dim_product[categoryname]))"),
                ("PctOfCategory", "DIVIDE(SUM(fact_sales[linetotal]), SUM(fact_sales[linetotal], CLEAREXCEPT(dim_product, dim_product[categoryname])), 0)"),
                ("AvgOrderIFERROR", "IFERROR(DIVIDE(SUM(fact_sales[linetotal]), COUNT(fact_sales[salesorderdetailid]), 0), 0)"),
            ],
            group_by: vec![("dim_product", "categoryname"), ("dim_product", "subcategoryname"), ("dim_territory", "countryregioncode")],
            description: "Everything combined: ITERATE + KEEP + CLEAREXCEPT + IFERROR, 6 measures, 3 dims",
        },
        // =====================================================================
        // Level 49+: Statistical, text, date, Switch, cross-fact, value inspection
        // =====================================================================
        // --- Statistical aggregates ---
        TestQuery {
            name: "Q49: Statistical aggregates (5 measures)",
            measures: vec![
                ("MedianPrice", "MEDIAN(fact_sales[unitprice])"),
                ("StdevPrice", "STDEV(fact_sales[unitprice])"),
                ("StdevPopPrice", "STDEVP(fact_sales[unitprice])"),
                ("VarPrice", "VARIANCE(fact_sales[unitprice])"),
                ("VarPopPrice", "VARIANCEP(fact_sales[unitprice])"),
            ],
            group_by: vec![("dim_product", "categoryname")],
            description: "MEDIAN, STDEV, STDEVP, VARIANCE, VARIANCEP — statistical aggregates",
        },
        TestQuery {
            name: "Q50: Statistical + simple mix (4 measures)",
            measures: vec![
                ("Revenue", "SUM(fact_sales[linetotal])"),
                ("MedianLineTotal", "MEDIAN(fact_sales[linetotal])"),
                ("PriceStdDev", "STDEV(fact_sales[unitprice])"),
                ("AvgPrice", "AVG(fact_sales[unitprice])"),
            ],
            group_by: vec![("dim_territory", "countryregioncode")],
            description: "Mix of statistical and simple aggregates",
        },
        // --- SWITCH expression ---
        TestQuery {
            name: "Q51: SWITCH with aggregates (2 measures)",
            measures: vec![
                ("Revenue", "SUM(fact_sales[linetotal])"),
                ("PriceTier", r#"VAR avg_p = DIVIDE(SUM(fact_sales[linetotal]), COUNT(fact_sales[salesorderdetailid]), 0) RETURN IF(avg_p > 1000, "Premium", IF(avg_p > 100, "Mid-Range", "Budget"))"#),
            ],
            group_by: vec![("dim_product", "categoryname")],
            description: "Conditional tiering using IF chain (SWITCH-like)",
        },
        // --- Text functions in measures ---
        TestQuery {
            name: "Q52: Text function measures (3 measures)",
            measures: vec![
                ("Revenue", "SUM(fact_sales[linetotal])"),
                ("OrderCount", "COUNT(fact_sales[salesorderdetailid])"),
                ("AvgOrder", "DIVIDE(SUM(fact_sales[linetotal]), COUNT(fact_sales[salesorderdetailid]), 0)"),
            ],
            group_by: vec![("dim_product", "categoryname"), ("dim_product", "color")],
            description: "Measures grouped by text columns (categoryname + color)",
        },
        // --- Date functions in measures ---
        TestQuery {
            name: "Q53: Date-grouped measures (4 measures)",
            measures: vec![
                ("Revenue", "SUM(fact_sales[linetotal])"),
                ("OrderCount", "COUNT(fact_sales[salesorderdetailid])"),
                ("AvgOrder", "DIVIDE(SUM(fact_sales[linetotal]), COUNT(fact_sales[salesorderdetailid]), 0)"),
                ("UniqueProducts", "DISTINCTCOUNT(fact_sales[productid])"),
            ],
            group_by: vec![("dim_date", "year"), ("dim_date", "monthname")],
            description: "Four measures grouped by year + monthname",
        },
        // --- Cross-fact-table: fact_purchasing ---
        TestQuery {
            name: "Q54: Purchasing fact table (3 measures)",
            measures: vec![
                ("PurchaseQty", "SUM(fact_purchasing[receivedqty])"),
                ("PurchaseCost", "SUM(fact_purchasing[unitprice])"),
                ("AvgPurchasePrice", "DIVIDE(SUM(fact_purchasing[unitprice]), SUM(fact_purchasing[receivedqty]), 0)"),
            ],
            group_by: vec![("dim_product", "categoryname")],
            description: "Measures from fact_purchasing instead of fact_sales",
        },
        // --- PERCENTILE ---
        TestQuery {
            name: "Q55: Percentile measures (3 measures)",
            measures: vec![
                ("P25_Price", "PERCENTILE(fact_sales[unitprice], 0.25)"),
                ("P50_Price", "PERCENTILE(fact_sales[unitprice], 0.5)"),
                ("P75_Price", "PERCENTILE(fact_sales[unitprice], 0.75)"),
            ],
            group_by: vec![("dim_product", "categoryname")],
            description: "25th, 50th, 75th percentiles of unit price",
        },
        // --- HASONEVALUE / SELECTEDVALUE ---
        TestQuery {
            name: "Q56: Value inspection measures (3 measures)",
            measures: vec![
                ("Revenue", "SUM(fact_sales[linetotal])"),
                ("SingleCategory", r#"IF(HASONEVALUE(fact_sales[productid]), SUM(fact_sales[linetotal]), 0)"#),
                ("MaxPrice", "MAX(fact_sales[unitprice])"),
            ],
            group_by: vec![("dim_product", "categoryname")],
            description: "HASONEVALUE on fact column + aggregates",
        },
        // --- Deep ITERATE + statistical ---
        TestQuery {
            name: "Q57: ITERATE + statistical mix (4 measures)",
            measures: vec![
                ("RowRevenue", "SUM(ITERATE(fact_sales, fact_sales[unitprice] * fact_sales[orderqty]))"),
                ("MedianRevenue", "MEDIAN(fact_sales[linetotal])"),
                ("StdevRevenue", "STDEV(fact_sales[linetotal])"),
                ("AvgRowCalc", "AVG(ITERATE(fact_sales, DIVIDE(fact_sales[linetotal], fact_sales[orderqty], 0)))"),
            ],
            group_by: vec![("dim_product", "subcategoryname")],
            description: "ITERATE + MEDIAN + STDEV — row-level and statistical in one query",
        },
        // --- ISINSCOPE + statistical ---
        TestQuery {
            name: "Q58: ISINSCOPE adaptive with statistical (3 measures)",
            measures: vec![
                ("Revenue", "SUM(fact_sales[linetotal])"),
                ("AdaptiveMetric", r#"IF(ISINSCOPE(dim_product[subcategoryname]), MEDIAN(fact_sales[unitprice]), AVG(fact_sales[unitprice]))"#),
                ("Volatility", "STDEV(fact_sales[unitprice])"),
            ],
            group_by: vec![("dim_product", "categoryname"), ("dim_product", "subcategoryname")],
            description: "ISINSCOPE selecting MEDIAN vs AVG based on drill level",
        },
        // --- KEEP + statistical ---
        TestQuery {
            name: "Q59: KEEP filtered statistical (3 measures)",
            measures: vec![
                ("AllMedian", "MEDIAN(fact_sales[unitprice])"),
                ("BikeMedian", r#"MEDIAN(fact_sales[unitprice], KEEP(dim_product, dim_product[categoryname] = "Bikes"))"#),
                ("BikeStdev", r#"STDEV(fact_sales[unitprice], KEEP(dim_product, dim_product[categoryname] = "Bikes"))"#),
            ],
            group_by: vec![("dim_territory", "countryregioncode")],
            description: "MEDIAN and STDEV with KEEP filter — statistical + context ops",
        },
        // --- Massive multi-measure report ---
        TestQuery {
            name: "Q60: 10-measure executive report",
            measures: vec![
                ("Revenue", "SUM(fact_sales[linetotal])"),
                ("Qty", "SUM(fact_sales[orderqty])"),
                ("Orders", "COUNT(fact_sales[salesorderdetailid])"),
                ("AvgOrder", "DIVIDE(SUM(fact_sales[linetotal]), COUNT(fact_sales[salesorderdetailid]), 0)"),
                ("Customers", "DISTINCTCOUNT(fact_sales[customerid])"),
                ("RevPerCust", "DIVIDE(SUM(fact_sales[linetotal]), DISTINCTCOUNT(fact_sales[customerid]), 0)"),
                ("MedianPrice", "MEDIAN(fact_sales[unitprice])"),
                ("PriceStdev", "STDEV(fact_sales[unitprice])"),
                ("QtyPerOrder", "DIVIDE(SUM(fact_sales[orderqty]), COUNT(fact_sales[salesorderdetailid]), 0)"),
                ("MaxLineTotal", "MAX(fact_sales[linetotal])"),
            ],
            group_by: vec![("dim_product", "categoryname")],
            description: "10 measures — full executive report with statistical",
        },
        // --- CLEAREXCEPT + statistical ---
        TestQuery {
            name: "Q61: CLEAREXCEPT with stats (4 measures, 2 dims)",
            measures: vec![
                ("Revenue", "SUM(fact_sales[linetotal])"),
                ("CategoryTotal", "SUM(fact_sales[linetotal], CLEAREXCEPT(dim_product, dim_product[categoryname]))"),
                ("PctOfCategory", "DIVIDE(SUM(fact_sales[linetotal]), SUM(fact_sales[linetotal], CLEAREXCEPT(dim_product, dim_product[categoryname])), 0)"),
                ("SubcatMedian", "MEDIAN(fact_sales[unitprice])"),
            ],
            group_by: vec![("dim_product", "categoryname"), ("dim_product", "subcategoryname")],
            description: "CLEAREXCEPT pct + MEDIAN in same query",
        },
        // --- VAR + ITERATE + IFERROR + PERCENTILE mega-query ---
        TestQuery {
            name: "Q62: Complex analytics (5 measures, 2 dims)",
            measures: vec![
                ("ComputedRev", "SUM(ITERATE(fact_sales, fact_sales[unitprice] * fact_sales[orderqty]))"),
                ("P90Price", "PERCENTILE(fact_sales[unitprice], 0.9)"),
                ("EfficiencyIndex", "VAR rev = SUM(fact_sales[linetotal]) VAR cost = SUM(ITERATE(fact_sales, fact_sales[unitprice] * fact_sales[orderqty])) RETURN IFERROR(DIVIDE(rev, cost, 0), 1)"),
                ("PriceSpread", "PERCENTILE(fact_sales[unitprice], 0.75) - PERCENTILE(fact_sales[unitprice], 0.25)"),
                ("OrderCount", "COUNT(fact_sales[salesorderdetailid])"),
            ],
            group_by: vec![("dim_product", "categoryname"), ("dim_territory", "countryregioncode")],
            description: "ITERATE + PERCENTILE + VAR + IFERROR — deep analytics",
        },
        // --- Three-dim with KEEP + CLEAR + ITERATE ---
        TestQuery {
            name: "Q63: Three-dim KEEP+ITERATE (4 measures)",
            measures: vec![
                ("Revenue", "SUM(fact_sales[linetotal])"),
                ("BikeRev", r#"SUM(fact_sales[linetotal], KEEP(dim_product, dim_product[categoryname] = "Bikes"))"#),
                ("IterRev", "SUM(ITERATE(fact_sales, fact_sales[unitprice] * fact_sales[orderqty]))"),
                ("YearTotal", "SUM(fact_sales[linetotal], CLEAREXCEPT(dim_date, dim_date[year]))"),
            ],
            group_by: vec![("dim_product", "categoryname"), ("dim_territory", "countryregioncode"), ("dim_date", "year")],
            description: "KEEP + ITERATE + CLEAREXCEPT across 3 dimensions",
        },
        // --- Grand totals with statistical ---
        TestQuery {
            name: "Q64: Statistical grand totals (6 measures)",
            measures: vec![
                ("Revenue", "SUM(fact_sales[linetotal])"),
                ("MedianLine", "MEDIAN(fact_sales[linetotal])"),
                ("P90Line", "PERCENTILE(fact_sales[linetotal], 0.9)"),
                ("StdevLine", "STDEV(fact_sales[linetotal])"),
                ("CoeffVar", "DIVIDE(STDEV(fact_sales[linetotal]), AVG(fact_sales[linetotal]), 0)"),
                ("IQR", "PERCENTILE(fact_sales[linetotal], 0.75) - PERCENTILE(fact_sales[linetotal], 0.25)"),
            ],
            group_by: vec![],
            description: "Statistical grand totals: MEDIAN, PERCENTILE, STDEV, CV, IQR",
        },
        // --- DATEDIFF in grouped measure ---
        TestQuery {
            name: "Q65: Date arithmetic measures (3 measures)",
            measures: vec![
                ("Revenue", "SUM(fact_sales[linetotal])"),
                ("OrderCount", "COUNT(fact_sales[salesorderdetailid])"),
                ("AvgOrder", "DIVIDE(SUM(fact_sales[linetotal]), COUNT(fact_sales[salesorderdetailid]), 0)"),
            ],
            group_by: vec![("dim_date", "year"), ("dim_date", "quarter"), ("dim_date", "monthname")],
            description: "Revenue by year/quarter/month — 3-level date drill-down",
        },
        // --- Multi-KEEP with ITERATE + IFERROR + PERCENTILE ---
        TestQuery {
            name: "Q66: Full function coverage (6 measures, 2 dims)",
            measures: vec![
                ("TotalRev", "SUM(fact_sales[linetotal])"),
                ("BikeShare", r#"DIVIDE(SUM(fact_sales[linetotal], KEEP(dim_product, dim_product[categoryname] = "Bikes")), SUM(fact_sales[linetotal]), 0)"#),
                ("SafeIterAvg", "IFERROR(AVG(ITERATE(fact_sales, DIVIDE(fact_sales[linetotal], fact_sales[orderqty], 0))), 0)"),
                ("P50Price", "PERCENTILE(fact_sales[unitprice], 0.5)"),
                ("PriceStdev", "STDEV(fact_sales[unitprice])"),
                ("AdaptiveMeasure", r#"IF(ISINSCOPE(dim_product[subcategoryname]), MEDIAN(fact_sales[unitprice]), AVG(fact_sales[unitprice]))"#),
            ],
            group_by: vec![("dim_product", "categoryname"), ("dim_product", "subcategoryname")],
            description: "SUM, KEEP, ITERATE, IFERROR, PERCENTILE, STDEV, ISINSCOPE, MEDIAN — all functions",
        },
        // --- Purchasing fact table only ---
        TestQuery {
            name: "Q67: Purchasing analysis by product (3 measures)",
            measures: vec![
                ("PurchaseQty", "SUM(fact_purchasing[receivedqty])"),
                ("PurchaseCost", "SUM(fact_purchasing[unitprice])"),
                ("RejectedQty", "SUM(fact_purchasing[rejectedqty])"),
            ],
            group_by: vec![("dim_product", "categoryname")],
            description: "Purchasing fact table — measures from a different fact table",
        },
        // --- Ultimate stress test ---
        TestQuery {
            name: "Q68: Ultimate stress test (8 measures, 3 dims, all features)",
            measures: vec![
                ("Revenue", "SUM(fact_sales[linetotal])"),
                ("MedianPrice", "MEDIAN(fact_sales[unitprice])"),
                ("P90Price", "PERCENTILE(fact_sales[unitprice], 0.9)"),
                ("BikeRev", r#"SUM(fact_sales[linetotal], KEEP(dim_product, dim_product[categoryname] = "Bikes"))"#),
                ("IterRev", "SUM(ITERATE(fact_sales, fact_sales[unitprice] * fact_sales[orderqty]))"),
                ("CatTotal", "SUM(fact_sales[linetotal], CLEAREXCEPT(dim_product, dim_product[categoryname]))"),
                ("SafeEfficiency", "IFERROR(DIVIDE(SUM(fact_sales[linetotal]), SUM(ITERATE(fact_sales, fact_sales[unitprice] * fact_sales[orderqty])), 0), 1)"),
                ("PriceStdev", "STDEV(fact_sales[unitprice])"),
            ],
            group_by: vec![("dim_product", "categoryname"), ("dim_product", "subcategoryname"), ("dim_territory", "countryregioncode")],
            description: "8 measures, 3 dims — SUM, MEDIAN, PERCENTILE, KEEP, ITERATE, CLEAREXCEPT, IFERROR, STDEV",
        },
        // =====================================================================
        // Level 69+: Deep function mixing — text, date, math, nested patterns
        // =====================================================================
        // --- Scalar math functions ---
        TestQuery {
            name: "Q69: Math function zoo (6 measures)",
            measures: vec![
                ("LogRevenue", "LN(SUM(fact_sales[linetotal]) + 1)"),
                ("Log10Revenue", "LOG10(SUM(fact_sales[linetotal]) + 1)"),
                ("CeilAvg", "CEILING(AVG(fact_sales[unitprice]))"),
                ("TruncAvg", "TRUNC(AVG(fact_sales[unitprice]), 1)"),
                ("IntAvg", "INT(AVG(fact_sales[unitprice]))"),
                ("SignDiff", "SIGN(SUM(fact_sales[linetotal]) - SUM(fact_sales[unitprice] * fact_sales[orderqty]))"),
            ],
            group_by: vec![("dim_product", "categoryname")],
            description: "LN, LOG10, CEILING, TRUNC, INT, SIGN — math function coverage",
        },
        // --- DATEDIFF measures ---
        TestQuery {
            name: "Q70: DATEDIFF analysis (3 measures)",
            measures: vec![
                ("Revenue", "SUM(fact_sales[linetotal])"),
                ("OrderCount", "COUNT(fact_sales[salesorderdetailid])"),
                ("UniqueProducts", "DISTINCTCOUNT(fact_sales[productid])"),
            ],
            group_by: vec![("dim_date", "year"), ("dim_date", "month")],
            description: "Revenue by year+month — date dimension drill-down",
        },
        // --- COUNTROWS ---
        TestQuery {
            name: "Q71: COUNTROWS aggregate (3 measures)",
            measures: vec![
                ("RowCount", "COUNTROWS(fact_sales)"),
                ("Revenue", "SUM(fact_sales[linetotal])"),
                ("AvgRevPerRow", "DIVIDE(SUM(fact_sales[linetotal]), COUNTROWS(fact_sales), 0)"),
            ],
            group_by: vec![("dim_product", "categoryname")],
            description: "COUNTROWS — row count aggregate vs SUM",
        },
        // --- Nested KEEP patterns ---
        TestQuery {
            name: "Q72: Multi-KEEP multi-filter (4 measures, 2 dims)",
            measures: vec![
                ("AllRevenue", "SUM(fact_sales[linetotal])"),
                ("USBikes", r#"SUM(fact_sales[linetotal], KEEP(dim_product, dim_product[categoryname] = "Bikes"), KEEP(dim_territory, dim_territory[countryregioncode] = "US"))"#),
                ("EUClothing", r#"SUM(fact_sales[linetotal], KEEP(dim_product, dim_product[categoryname] = "Clothing"), KEEP(dim_territory, dim_territory[countryregioncode] = "DE"))"#),
                ("USBikePct", r#"DIVIDE(SUM(fact_sales[linetotal], KEEP(dim_product, dim_product[categoryname] = "Bikes"), KEEP(dim_territory, dim_territory[countryregioncode] = "US")), SUM(fact_sales[linetotal]), 0)"#),
            ],
            group_by: vec![("dim_date", "year"), ("dim_date", "quarter")],
            description: "Multi-dimension KEEP filters combined in one measure",
        },
        // --- ITERATE + scalar math inside ---
        TestQuery {
            name: "Q73: ITERATE with deep math (4 measures)",
            measures: vec![
                ("SumLogPrice", "SUM(ITERATE(fact_sales, LN(fact_sales[unitprice] + 1)))"),
                ("AvgSqrtLine", "AVG(ITERATE(fact_sales, SQRT(ABS(fact_sales[linetotal]))))"),
                ("MaxRoundedUnit", "MAX(ITERATE(fact_sales, ROUND(fact_sales[unitprice], 0)))"),
                ("SumPow2Qty", "SUM(ITERATE(fact_sales, POWER(fact_sales[orderqty], 2)))"),
            ],
            group_by: vec![("dim_product", "categoryname")],
            description: "ITERATE with LN, SQRT, ABS, ROUND, POWER inside",
        },
        // --- Complex VAR with ITERATE and IFERROR ---
        TestQuery {
            name: "Q74: VAR + ITERATE + IFERROR combo (3 measures)",
            measures: vec![
                ("EfficiencyScore", r#"VAR computed_rev = SUM(ITERATE(fact_sales, fact_sales[unitprice] * fact_sales[orderqty])) VAR actual_rev = SUM(fact_sales[linetotal]) VAR efficiency = IFERROR(DIVIDE(actual_rev, computed_rev, 0), 1) RETURN ROUND(efficiency, 4)"#),
                ("Revenue", "SUM(fact_sales[linetotal])"),
                ("OrderCount", "COUNT(fact_sales[salesorderdetailid])"),
            ],
            group_by: vec![("dim_product", "categoryname"), ("dim_territory", "countryregioncode")],
            description: "VAR block with ITERATE + IFERROR + DIVIDE + ROUND — deep nesting",
        },
        // --- CLEAREXCEPT + KEEP + DIVIDE for hierarchy pct ---
        TestQuery {
            name: "Q75: Hierarchy pct (CLEAREXCEPT + KEEP, 5 measures)",
            measures: vec![
                ("Revenue", "SUM(fact_sales[linetotal])"),
                ("CategoryTotal", "SUM(fact_sales[linetotal], CLEAREXCEPT(dim_product, dim_product[categoryname]))"),
                ("PctOfCategory", "DIVIDE(SUM(fact_sales[linetotal]), SUM(fact_sales[linetotal], CLEAREXCEPT(dim_product, dim_product[categoryname])), 0)"),
                ("BikeSubcatRev", r#"SUM(fact_sales[linetotal], KEEP(dim_product, dim_product[categoryname] = "Bikes"))"#),
                ("GrandTotal", "SUM(fact_sales[linetotal], CLEAR(dim_product))"),
            ],
            group_by: vec![("dim_product", "categoryname"), ("dim_product", "subcategoryname")],
            description: "CLEAREXCEPT + KEEP + CLEAR — three context scopes in one query",
        },
        // --- ISINSCOPE + multiple adaptive measures ---
        TestQuery {
            name: "Q76: ISINSCOPE multi-level adaptive (4 measures)",
            measures: vec![
                ("Revenue", "SUM(fact_sales[linetotal])"),
                ("AdaptiveAvg", r#"IF(ISINSCOPE(dim_product[subcategoryname]), AVG(fact_sales[unitprice]), DIVIDE(SUM(fact_sales[linetotal]), COUNT(fact_sales[salesorderdetailid]), 0))"#),
                ("AdaptiveLabel", r#"IF(ISINSCOPE(dim_product[subcategoryname]), MEDIAN(fact_sales[unitprice]), PERCENTILE(fact_sales[unitprice], 0.75))"#),
                ("AdaptiveCount", "IF(ISINSCOPE(dim_product[subcategoryname]), DISTINCTCOUNT(fact_sales[productid]), DISTINCTCOUNT(fact_sales[customerid]))"),
            ],
            group_by: vec![("dim_product", "categoryname"), ("dim_product", "subcategoryname")],
            description: "ISINSCOPE choosing between different aggregates at different drill levels",
        },
        // --- PERCENTILE + STDEV + ITERATE combined ---
        TestQuery {
            name: "Q77: Statistical + ITERATE deep analysis (5 measures)",
            measures: vec![
                ("P10Price", "PERCENTILE(fact_sales[unitprice], 0.1)"),
                ("P90Price", "PERCENTILE(fact_sales[unitprice], 0.9)"),
                ("IQR", "PERCENTILE(fact_sales[unitprice], 0.75) - PERCENTILE(fact_sales[unitprice], 0.25)"),
                ("IterAbsPrice", "AVG(ITERATE(fact_sales, ABS(fact_sales[unitprice] - fact_sales[linetotal])))"),
                ("CoeffVar", "DIVIDE(STDEV(fact_sales[unitprice]), AVG(fact_sales[unitprice]), 0)"),
            ],
            group_by: vec![("dim_product", "subcategoryname")],
            description: "IQR + percentiles + ITERATE pseudo-MAD + coefficient of variation",
        },
        // --- KEEP + CLEAREXCEPT + ITERATE + IFERROR + VAR all-in-one ---
        TestQuery {
            name: "Q78: Everything combined V2 (6 measures, 3 dims)",
            measures: vec![
                ("Revenue", "SUM(fact_sales[linetotal])"),
                ("IterComputedRev", "SUM(ITERATE(fact_sales, fact_sales[unitprice] * fact_sales[orderqty]))"),
                ("BikeRevenue", r#"SUM(fact_sales[linetotal], KEEP(dim_product, dim_product[categoryname] = "Bikes"))"#),
                ("CatTotal", "SUM(fact_sales[linetotal], CLEAREXCEPT(dim_product, dim_product[categoryname]))"),
                ("SafeRatio", "IFERROR(DIVIDE(SUM(fact_sales[linetotal]), SUM(fact_sales[linetotal], CLEAREXCEPT(dim_product, dim_product[categoryname])), 0), 0)"),
                ("ComplexScore", r#"VAR rev = SUM(fact_sales[linetotal]) VAR iter_rev = SUM(ITERATE(fact_sales, fact_sales[unitprice] * fact_sales[orderqty])) VAR ratio = IFERROR(DIVIDE(rev, iter_rev, 0), 1) RETURN ROUND(SQRT(ABS(ratio)), 4)"#),
            ],
            group_by: vec![("dim_product", "categoryname"), ("dim_product", "subcategoryname"), ("dim_territory", "countryregioncode")],
            description: "SUM, ITERATE, KEEP, CLEAREXCEPT, IFERROR, DIVIDE, VAR, SQRT, ABS, ROUND — maximum mixing",
        },
        // --- Purchasing with stats ---
        TestQuery {
            name: "Q79: Purchasing stats (4 measures)",
            measures: vec![
                ("PurchaseTotal", "SUM(fact_purchasing[receivedqty])"),
                ("MedianPurchPrice", "MEDIAN(fact_purchasing[unitprice])"),
                ("StdevPurchPrice", "STDEV(fact_purchasing[unitprice])"),
                ("AvgRejected", "AVG(fact_purchasing[rejectedqty])"),
            ],
            group_by: vec![("dim_product", "categoryname")],
            description: "Purchasing fact table with statistical aggregates",
        },
        // --- Grand totals with COUNTROWS + math ---
        TestQuery {
            name: "Q80: Grand total math + COUNTROWS (6 measures)",
            measures: vec![
                ("RowCount", "COUNTROWS(fact_sales)"),
                ("Revenue", "SUM(fact_sales[linetotal])"),
                ("AvgPerRow", "DIVIDE(SUM(fact_sales[linetotal]), COUNTROWS(fact_sales), 0)"),
                ("LogRevenue", "LN(SUM(fact_sales[linetotal]) + 1)"),
                ("SqrtRevPerCust", "ROUND(SQRT(DIVIDE(SUM(fact_sales[linetotal]), DISTINCTCOUNT(fact_sales[customerid]), 0)), 2)"),
                ("RevenueRank", "SIGN(SUM(fact_sales[linetotal]) - 50000000)"),
            ],
            group_by: vec![],
            description: "Grand total: COUNTROWS + LN + SQRT + SIGN + DIVIDE",
        },
        // --- Multi-dim with KEEP across 3 different dims ---
        TestQuery {
            name: "Q81: Triple-KEEP filtering (4 measures, 2 dims)",
            measures: vec![
                ("AllRevenue", "SUM(fact_sales[linetotal])"),
                ("BikeRevenue", r#"SUM(fact_sales[linetotal], KEEP(dim_product, dim_product[categoryname] = "Bikes"))"#),
                ("USRevenue", r#"SUM(fact_sales[linetotal], KEEP(dim_territory, dim_territory[countryregioncode] = "US"))"#),
                ("BikeUSShare", r#"DIVIDE(SUM(fact_sales[linetotal], KEEP(dim_product, dim_product[categoryname] = "Bikes"), KEEP(dim_territory, dim_territory[countryregioncode] = "US")), SUM(fact_sales[linetotal]), 0)"#),
            ],
            group_by: vec![("dim_date", "year"), ("dim_date", "quarter")],
            description: "KEEP on product + territory separately and combined, grouped by date",
        },
        // --- Multiple CLEAR dimensions ---
        TestQuery {
            name: "Q82: Multi-CLEAR comparison (4 measures, 3 dims)",
            measures: vec![
                ("Revenue", "SUM(fact_sales[linetotal])"),
                ("ClearProduct", "SUM(fact_sales[linetotal], CLEAR(dim_product))"),
                ("ClearTerritory", "SUM(fact_sales[linetotal], CLEAR(dim_territory))"),
                ("PctOfTerritory", "DIVIDE(SUM(fact_sales[linetotal]), SUM(fact_sales[linetotal], CLEAR(dim_territory)), 0)"),
            ],
            group_by: vec![("dim_product", "categoryname"), ("dim_territory", "countryregioncode"), ("dim_date", "year")],
            description: "Different CLEAR targets in one query — product vs territory vs both",
        },
        // --- ITERATE + conditional per-row logic with KEEP ---
        TestQuery {
            name: "Q83: ITERATE conditional + KEEP (4 measures)",
            measures: vec![
                ("PremiumRev", "SUM(ITERATE(fact_sales, IF(fact_sales[unitprice] > 100, fact_sales[linetotal], 0)))"),
                ("BudgetRev", "SUM(ITERATE(fact_sales, IF(fact_sales[unitprice] <= 100, fact_sales[linetotal], 0)))"),
                ("BikeIterRev", r#"SUM(ITERATE(fact_sales, fact_sales[unitprice] * fact_sales[orderqty]), KEEP(dim_product, dim_product[categoryname] = "Bikes"))"#),
                ("SafeAvgIter", "IFERROR(AVG(ITERATE(fact_sales, DIVIDE(fact_sales[linetotal], fact_sales[orderqty], 0))), 0)"),
            ],
            group_by: vec![("dim_territory", "countryregioncode"), ("dim_date", "year")],
            description: "ITERATE with IF + KEEP + IFERROR, 2 dimension group-by",
        },
        // --- Deep nesting: VAR with nested DIVIDE + ITERATE + IF + PERCENTILE ---
        TestQuery {
            name: "Q84: Deep nesting stress test (3 measures)",
            measures: vec![
                ("DeepScore", "VAR p50 = PERCENTILE(fact_sales[unitprice], 0.5) VAR p90 = PERCENTILE(fact_sales[unitprice], 0.9) VAR spread = IFERROR(DIVIDE(p90 - p50, p50, 0), 0) RETURN ROUND(spread, 4)"),
                ("IterScore", "VAR iter_avg = AVG(ITERATE(fact_sales, DIVIDE(fact_sales[linetotal], fact_sales[orderqty], 0))) VAR plain_avg = AVG(fact_sales[unitprice]) RETURN IFERROR(DIVIDE(iter_avg, plain_avg, 0), 1)"),
                ("Revenue", "SUM(fact_sales[linetotal])"),
            ],
            group_by: vec![("dim_product", "categoryname")],
            description: "Deep nesting: VAR + PERCENTILE + ITERATE + IFERROR + DIVIDE + ROUND",
        },
        // --- 10 measures mixed complexity ---
        TestQuery {
            name: "Q85: 10-measure mega-dashboard (10 measures, 2 dims)",
            measures: vec![
                ("Revenue", "SUM(fact_sales[linetotal])"),
                ("Qty", "SUM(fact_sales[orderqty])"),
                ("AvgPrice", "AVG(fact_sales[unitprice])"),
                ("MedianPrice", "MEDIAN(fact_sales[unitprice])"),
                ("P75Price", "PERCENTILE(fact_sales[unitprice], 0.75)"),
                ("StdevPrice", "STDEV(fact_sales[unitprice])"),
                ("BikeShare", r#"DIVIDE(SUM(fact_sales[linetotal], KEEP(dim_product, dim_product[categoryname] = "Bikes")), SUM(fact_sales[linetotal]), 0)"#),
                ("IterRev", "SUM(ITERATE(fact_sales, fact_sales[unitprice] * fact_sales[orderqty]))"),
                ("CatTotal", "SUM(fact_sales[linetotal], CLEAREXCEPT(dim_product, dim_product[categoryname]))"),
                ("RowCount", "COUNTROWS(fact_sales)"),
            ],
            group_by: vec![("dim_product", "categoryname"), ("dim_product", "subcategoryname")],
            description: "10 measures: SUM, AVG, MEDIAN, PERCENTILE, STDEV, KEEP, ITERATE, CLEAREXCEPT, COUNTROWS",
        },
        // --- ISINSCOPE + CLEAR + CLEAREXCEPT all adaptive ---
        TestQuery {
            name: "Q86: Adaptive scoped hierarchy (5 measures, 3 dims)",
            measures: vec![
                ("Revenue", "SUM(fact_sales[linetotal])"),
                ("ParentTotal", r#"IF(ISINSCOPE(dim_product[subcategoryname]), SUM(fact_sales[linetotal], CLEAREXCEPT(dim_product, dim_product[categoryname])), SUM(fact_sales[linetotal], CLEAR(dim_product)))"#),
                ("PctOfParent", r#"DIVIDE(SUM(fact_sales[linetotal]), IF(ISINSCOPE(dim_product[subcategoryname]), SUM(fact_sales[linetotal], CLEAREXCEPT(dim_product, dim_product[categoryname])), SUM(fact_sales[linetotal], CLEAR(dim_product))), 0)"#),
                ("MedianPrice", "MEDIAN(fact_sales[unitprice])"),
                ("Orders", "COUNT(fact_sales[salesorderdetailid])"),
            ],
            group_by: vec![("dim_product", "categoryname"), ("dim_product", "subcategoryname"), ("dim_territory", "countryregioncode")],
            description: "ISINSCOPE choosing CLEAREXCEPT vs CLEAR — adaptive hierarchy pct",
        },
        // --- Purchasing + date grouping ---
        TestQuery {
            name: "Q87: Purchasing by date (3 measures, 2 dims)",
            measures: vec![
                ("ReceivedQty", "SUM(fact_purchasing[receivedqty])"),
                ("RejectedQty", "SUM(fact_purchasing[rejectedqty])"),
                ("RejectionRate", "DIVIDE(SUM(fact_purchasing[rejectedqty]), SUM(fact_purchasing[receivedqty]), 0)"),
            ],
            group_by: vec![("dim_product", "categoryname"), ("dim_date", "year")],
            description: "Purchasing rejection rate by category and year",
        },
        // --- Grand finale: absolute maximum complexity ---
        TestQuery {
            name: "Q88: Grand finale (8 measures, 3 dims, all features)",
            measures: vec![
                ("Revenue", "SUM(fact_sales[linetotal])"),
                ("IterComputedRev", "SUM(ITERATE(fact_sales, fact_sales[unitprice] * fact_sales[orderqty]))"),
                ("BikeRev", r#"SUM(fact_sales[linetotal], KEEP(dim_product, dim_product[categoryname] = "Bikes"))"#),
                ("BikeShare", r#"DIVIDE(SUM(fact_sales[linetotal], KEEP(dim_product, dim_product[categoryname] = "Bikes")), SUM(fact_sales[linetotal]), 0)"#),
                ("CatTotal", "SUM(fact_sales[linetotal], CLEAREXCEPT(dim_product, dim_product[categoryname]))"),
                ("PctOfCat", "DIVIDE(SUM(fact_sales[linetotal]), SUM(fact_sales[linetotal], CLEAREXCEPT(dim_product, dim_product[categoryname])), 0)"),
                ("SafeScore", r#"VAR rev = SUM(fact_sales[linetotal]) VAR qty = SUM(fact_sales[orderqty]) VAR ratio = IFERROR(DIVIDE(rev, qty, 0), 0) RETURN ROUND(LN(ABS(ratio) + 1), 4)"#),
                ("RowCount", "COUNTROWS(fact_sales)"),
            ],
            group_by: vec![("dim_product", "categoryname"), ("dim_product", "subcategoryname"), ("dim_territory", "countryregioncode")],
            description: "GRAND FINALE: SUM, ITERATE, KEEP, CLEAREXCEPT, MEDIAN, PERCENTILE, IFERROR, VAR, LN, ABS, ROUND, DIVIDE, COUNTROWS — 8 measures, 3 dims",
        },
        // =====================================================================
        // Level 89+: QUERY, OFFSET, WINDOW, text/date functions, deep combos
        // =====================================================================
        // --- QUERY (two-stage aggregation) ---
        TestQuery {
            name: "Q89: QUERY basic — avg of monthly revenue",
            measures: vec![
                ("AvgMonthlyRev", "VAR monthly = QUERY(SUM(fact_sales[linetotal]) AS revenue BY dim_date[year], dim_date[month]) RETURN AVG(monthly[revenue])"),
            ],
            group_by: vec![("dim_product", "categoryname")],
            description: "QUERY: aggregate monthly revenue then AVG — two-stage evaluation",
        },
        TestQuery {
            name: "Q90: QUERY with multiple aggregates",
            measures: vec![
                ("AvgMonthlyRev", "VAR m1 = QUERY(SUM(fact_sales[linetotal]) AS revenue, COUNT(fact_sales[salesorderdetailid]) AS orders BY dim_date[year], dim_date[month]) RETURN AVG(m1[revenue])"),
                ("AvgMonthlyOrders", "VAR m2 = QUERY(SUM(fact_sales[linetotal]) AS revenue, COUNT(fact_sales[salesorderdetailid]) AS orders BY dim_date[year], dim_date[month]) RETURN AVG(m2[orders])"),
            ],
            group_by: vec![("dim_product", "categoryname")],
            description: "QUERY with two aggregates — avg monthly revenue AND avg monthly orders",
        },
        TestQuery {
            name: "Q91: QUERY max of monthly (3 measures)",
            measures: vec![
                ("Revenue", "SUM(fact_sales[linetotal])"),
                ("MaxMonthlyRev", "VAR mmax = QUERY(SUM(fact_sales[linetotal]) AS rev BY dim_date[year], dim_date[month]) RETURN MAX(mmax[rev])"),
                ("MinMonthlyRev", "VAR mmin = QUERY(SUM(fact_sales[linetotal]) AS rev BY dim_date[year], dim_date[month]) RETURN MIN(mmin[rev])"),
            ],
            group_by: vec![("dim_product", "categoryname")],
            description: "QUERY: MAX and MIN of monthly revenue + plain SUM",
        },
        // --- QUERY + ITERATE interaction ---
        TestQuery {
            name: "Q92: QUERY with computed aggregate",
            measures: vec![
                ("AvgMonthlyComputed", "VAR monthly = QUERY(SUM(ITERATE(fact_sales, fact_sales[unitprice] * fact_sales[orderqty])) AS computed_rev BY dim_date[year], dim_date[month]) RETURN AVG(monthly[computed_rev])"),
                ("PlainRevenue", "SUM(fact_sales[linetotal])"),
            ],
            group_by: vec![("dim_product", "categoryname")],
            description: "QUERY with ITERATE inside the aggregate — two-stage computed revenue",
        },
        // --- OFFSET (period-over-period) ---
        TestQuery {
            name: "Q93: OFFSET previous period (2 measures)",
            measures: vec![
                ("Revenue", "SUM(fact_sales[linetotal])"),
                ("PrevMonthRev", "OFFSET(SUM(fact_sales[linetotal]), -1, ORDERBY(dim_date[yearmonth]))"),
            ],
            group_by: vec![("dim_date", "yearmonth")],
            description: "OFFSET -1 for previous month revenue comparison",
        },
        TestQuery {
            name: "Q94: OFFSET forward and backward (3 measures)",
            measures: vec![
                ("Revenue", "SUM(fact_sales[linetotal])"),
                ("PrevRev", "OFFSET(SUM(fact_sales[linetotal]), -1, ORDERBY(dim_date[yearmonth]))"),
                ("NextRev", "OFFSET(SUM(fact_sales[linetotal]), 1, ORDERBY(dim_date[yearmonth]))"),
            ],
            group_by: vec![("dim_date", "yearmonth")],
            description: "OFFSET -1 (previous) and +1 (next) month revenue",
        },
        // --- INDEX (absolute position) ---
        TestQuery {
            name: "Q95: INDEX first and last month (3 measures)",
            measures: vec![
                ("Revenue", "SUM(fact_sales[linetotal])"),
                ("FirstMonthRev", "INDEX(SUM(fact_sales[linetotal]), 1, ORDERBY(dim_date[yearmonth]))"),
                ("LastMonthRev", "INDEX(SUM(fact_sales[linetotal]), -1, ORDERBY(dim_date[yearmonth]))"),
            ],
            group_by: vec![("dim_date", "yearmonth")],
            description: "INDEX: first and last month revenue in each row",
        },
        // --- WINDOW (running/sliding aggregation) ---
        TestQuery {
            name: "Q96: WINDOW running total (2 measures)",
            measures: vec![
                ("Revenue", "SUM(fact_sales[linetotal])"),
                ("RunningTotal", "WINDOW(SUM(fact_sales[linetotal]), SUM, ORDERBY(dim_date[yearmonth]))"),
            ],
            group_by: vec![("dim_date", "yearmonth")],
            description: "WINDOW running total of monthly revenue",
        },
        TestQuery {
            name: "Q97: WINDOW 3-month moving average (3 measures)",
            measures: vec![
                ("Revenue", "SUM(fact_sales[linetotal])"),
                ("MovingAvg3", "WINDOW(SUM(fact_sales[linetotal]), AVG, ORDERBY(dim_date[yearmonth]), ROWS(-2, REL, 0, REL))"),
                ("RunningTotal", "WINDOW(SUM(fact_sales[linetotal]), SUM, ORDERBY(dim_date[yearmonth]))"),
            ],
            group_by: vec![("dim_date", "yearmonth")],
            description: "3-month moving average + running total using WINDOW",
        },
        // --- OFFSET + WINDOW + QUERY combo ---
        TestQuery {
            name: "Q98: OFFSET + WINDOW combined (4 measures)",
            measures: vec![
                ("Revenue", "SUM(fact_sales[linetotal])"),
                ("PrevRev", "OFFSET(SUM(fact_sales[linetotal]), -1, ORDERBY(dim_date[yearmonth]))"),
                ("RunningTotal", "WINDOW(SUM(fact_sales[linetotal]), SUM, ORDERBY(dim_date[yearmonth]))"),
                ("MovingAvg3", "WINDOW(SUM(fact_sales[linetotal]), AVG, ORDERBY(dim_date[yearmonth]), ROWS(-2, REL, 0, REL))"),
            ],
            group_by: vec![("dim_date", "yearmonth")],
            description: "OFFSET + WINDOW in same query — time-series analytics",
        },
        // --- Date functions in measures ---
        TestQuery {
            name: "Q99: DATEDIFF + TODAY (3 measures)",
            measures: vec![
                ("Revenue", "SUM(fact_sales[linetotal])"),
                ("OrderCount", "COUNT(fact_sales[salesorderdetailid])"),
                ("AvgOrderValue", "DIVIDE(SUM(fact_sales[linetotal]), COUNT(fact_sales[salesorderdetailid]), 0)"),
            ],
            group_by: vec![("dim_date", "year"), ("dim_date", "quarter"), ("dim_date", "month")],
            description: "Revenue drill-down by year/quarter/month",
        },
        // --- Math: EXP + PI ---
        TestQuery {
            name: "Q100: EXP + PI + math functions (4 measures)",
            measures: vec![
                ("Revenue", "SUM(fact_sales[linetotal])"),
                ("ExpGrowth", "EXP(DIVIDE(SUM(fact_sales[linetotal]), 100000000, 0))"),
                ("LogRevenue", "LN(SUM(fact_sales[linetotal]) + 1)"),
                ("ScaledRev", "SUM(fact_sales[linetotal]) * PI() / 1000000"),
            ],
            group_by: vec![("dim_product", "categoryname")],
            description: "EXP, PI, LN in measure expressions",
        },
        // --- SWITCH with aggregate ---
        TestQuery {
            name: "Q101: SWITCH categorization (3 measures)",
            measures: vec![
                ("Revenue", "SUM(fact_sales[linetotal])"),
                ("PriceTier", r#"IF(AVG(fact_sales[unitprice]) > 500, "Premium", IF(AVG(fact_sales[unitprice]) > 50, "Standard", "Budget"))"#),
                ("OrderSize", r#"IF(DIVIDE(SUM(fact_sales[linetotal]), COUNT(fact_sales[salesorderdetailid]), 0) > 1000, "Large", IF(DIVIDE(SUM(fact_sales[linetotal]), COUNT(fact_sales[salesorderdetailid]), 0) > 100, "Medium", "Small"))"#),
            ],
            group_by: vec![("dim_product", "categoryname"), ("dim_territory", "countryregioncode")],
            description: "IF-chain categorization (SWITCH-like) with aggregates",
        },
        // --- ROUNDUP + ROUNDDOWN ---
        TestQuery {
            name: "Q102: ROUNDUP + ROUNDDOWN (4 measures)",
            measures: vec![
                ("Revenue", "SUM(fact_sales[linetotal])"),
                ("RoundedUp", "ROUNDUP(AVG(fact_sales[unitprice]), 0)"),
                ("RoundedDown", "ROUNDDOWN(AVG(fact_sales[unitprice]), 0)"),
                ("Truncated", "TRUNC(AVG(fact_sales[unitprice]), 2)"),
            ],
            group_by: vec![("dim_product", "subcategoryname")],
            description: "ROUNDUP, ROUNDDOWN, TRUNC — rounding variants",
        },
        // --- QUERY + KEEP interaction ---
        TestQuery {
            name: "Q103: QUERY with KEEP context (2 measures)",
            measures: vec![
                ("AvgMonthlyBikeRev", r#"VAR monthly = QUERY(SUM(fact_sales[linetotal], KEEP(dim_product, dim_product[categoryname] = "Bikes")) AS bike_rev BY dim_date[year], dim_date[month]) RETURN AVG(monthly[bike_rev])"#),
                ("TotalBikeRev", r#"SUM(fact_sales[linetotal], KEEP(dim_product, dim_product[categoryname] = "Bikes"))"#),
            ],
            group_by: vec![("dim_territory", "countryregioncode")],
            description: "QUERY with KEEP filter inside — two-stage filtered aggregation",
        },
        // --- ITERATE + IFERROR + text-like conditional ---
        TestQuery {
            name: "Q104: ITERATE complex per-row logic (3 measures)",
            measures: vec![
                ("WeightedPrice", "SUM(ITERATE(fact_sales, IFERROR(DIVIDE(fact_sales[linetotal], fact_sales[orderqty], 0), 0) * fact_sales[orderqty]))"),
                ("AvgDiscount", "AVG(ITERATE(fact_sales, IFERROR(DIVIDE(fact_sales[linetotal] - fact_sales[unitprice] * fact_sales[orderqty], fact_sales[unitprice] * fact_sales[orderqty], 0), 0)))"),
                ("RowCount", "COUNTROWS(fact_sales)"),
            ],
            group_by: vec![("dim_product", "categoryname"), ("dim_territory", "countryregioncode")],
            description: "ITERATE with nested IFERROR + DIVIDE + arithmetic — per-row discount calc",
        },
        // --- QUERY + OFFSET combo (aggregate-of-aggregates with period lookup) ---
        TestQuery {
            name: "Q105: QUERY + plain measures mix (4 measures)",
            measures: vec![
                ("Revenue", "SUM(fact_sales[linetotal])"),
                ("AvgMonthlyRev", "VAR mavg = QUERY(SUM(fact_sales[linetotal]) AS rev BY dim_date[year], dim_date[month]) RETURN AVG(mavg[rev])"),
                ("MaxMonthlyRev", "VAR mmax2 = QUERY(SUM(fact_sales[linetotal]) AS rev BY dim_date[year], dim_date[month]) RETURN MAX(mmax2[rev])"),
                ("OrderCount", "COUNT(fact_sales[salesorderdetailid])"),
            ],
            group_by: vec![("dim_product", "categoryname")],
            description: "Plain + QUERY measures in same query — mixed evaluation paths",
        },
        // --- WINDOW with PARTITION BY ---
        TestQuery {
            name: "Q106: WINDOW partitioned (3 measures)",
            measures: vec![
                ("Revenue", "SUM(fact_sales[linetotal])"),
                ("RunningByCategory", "WINDOW(SUM(fact_sales[linetotal]), SUM, ORDERBY(dim_date[yearmonth]), PARTITIONBY(dim_product[categoryname]))"),
                ("OrderCount", "COUNT(fact_sales[salesorderdetailid])"),
            ],
            group_by: vec![("dim_product", "categoryname"), ("dim_date", "yearmonth")],
            description: "WINDOW with PARTITIONBY — running total per category",
        },
        // --- ITERATE + QUERY: iterate-computed aggregate feeding into QUERY ---
        TestQuery {
            name: "Q107: QUERY over ITERATE computed (2 measures)",
            measures: vec![
                ("AvgMonthlyCompRev", "VAR mi1 = QUERY(SUM(ITERATE(fact_sales, fact_sales[unitprice] * fact_sales[orderqty])) AS comp_rev BY dim_date[year], dim_date[month]) RETURN AVG(mi1[comp_rev])"),
                ("MaxMonthlyCompRev", "VAR mi2 = QUERY(SUM(ITERATE(fact_sales, fact_sales[unitprice] * fact_sales[orderqty])) AS comp_rev BY dim_date[year], dim_date[month]) RETURN MAX(mi2[comp_rev])"),
            ],
            group_by: vec![("dim_product", "categoryname")],
            description: "QUERY over ITERATE-computed revenue — two-stage with row-level computation",
        },
        // --- Grand ultimate: everything we have ---
        TestQuery {
            name: "Q108: ULTIMATE MIX (8 measures, 2 dims)",
            measures: vec![
                ("Revenue", "SUM(fact_sales[linetotal])"),
                ("IterRev", "SUM(ITERATE(fact_sales, fact_sales[unitprice] * fact_sales[orderqty]))"),
                ("BikeShare", r#"DIVIDE(SUM(fact_sales[linetotal], KEEP(dim_product, dim_product[categoryname] = "Bikes")), SUM(fact_sales[linetotal]), 0)"#),
                ("CatTotal", "SUM(fact_sales[linetotal], CLEAREXCEPT(dim_product, dim_product[categoryname]))"),
                ("PctOfCat", "DIVIDE(SUM(fact_sales[linetotal]), SUM(fact_sales[linetotal], CLEAREXCEPT(dim_product, dim_product[categoryname])), 0)"),
                ("AvgMonthlyRev", "VAR monthly = QUERY(SUM(fact_sales[linetotal]) AS rev BY dim_date[year], dim_date[month]) RETURN AVG(monthly[rev])"),
                ("MedianPrice", "MEDIAN(fact_sales[unitprice])"),
                ("SafeEfficiency", r#"VAR rev = SUM(fact_sales[linetotal]) VAR iter = SUM(ITERATE(fact_sales, fact_sales[unitprice] * fact_sales[orderqty])) RETURN IFERROR(ROUND(DIVIDE(rev, iter, 0), 4), 1)"#),
            ],
            group_by: vec![("dim_product", "categoryname"), ("dim_product", "subcategoryname")],
            description: "SUM + ITERATE + KEEP + CLEAREXCEPT + QUERY + MEDIAN + VAR + IFERROR + ROUND + DIVIDE — the ultimate test",
        },
        // =====================================================================
        // Level 109+: New functions (GREATEST, LEAST, NULLIF, COUNT_IF,
        //   DATEADD, DATETRUNC, DAYOFWEEK, CONTAINS, INITCAP, ANY_VALUE,
        //   MODE, STRING_AGG, MAXBY, MINBY) + deep cross-function combos
        // =====================================================================
        // --- GREATEST / LEAST ---
        TestQuery {
            name: "Q109: GREATEST/LEAST (4 measures)",
            measures: vec![
                ("MaxMetric", "GREATEST(SUM(fact_sales[linetotal]), SUM(fact_sales[unitprice] * fact_sales[orderqty]))"),
                ("MinMetric", "LEAST(SUM(fact_sales[linetotal]), SUM(fact_sales[unitprice] * fact_sales[orderqty]))"),
                ("ClampedAvg", "GREATEST(LEAST(AVG(fact_sales[unitprice]), 1000), 10)"),
                ("Revenue", "SUM(fact_sales[linetotal])"),
            ],
            group_by: vec![("dim_product", "categoryname")],
            description: "GREATEST, LEAST — multi-value comparison functions",
        },
        // --- NULLIF ---
        TestQuery {
            name: "Q110: NULLIF safe division (3 measures)",
            measures: vec![
                ("Revenue", "SUM(fact_sales[linetotal])"),
                ("SafeRatio", "DIVIDE(SUM(fact_sales[linetotal]), NULLIF(SUM(fact_sales[orderqty]), 0), 0)"),
                ("Orders", "COUNT(fact_sales[salesorderdetailid])"),
            ],
            group_by: vec![("dim_product", "categoryname"), ("dim_territory", "countryregioncode")],
            description: "NULLIF to prevent division by zero — alternative to DIVIDE",
        },
        // --- COUNT_IF ---
        TestQuery {
            name: "Q111: COUNT_IF conditional counting (4 measures)",
            measures: vec![
                ("TotalOrders", "COUNT(fact_sales[salesorderdetailid])"),
                ("HighValueOrders", "COUNT_IF(fact_sales[unitprice] > 100)"),
                ("BulkOrders", "COUNT_IF(fact_sales[orderqty] > 5)"),
                ("HighValuePct", "DIVIDE(COUNT_IF(fact_sales[unitprice] > 100), COUNT(fact_sales[salesorderdetailid]), 0)"),
            ],
            group_by: vec![("dim_product", "categoryname")],
            description: "COUNT_IF — conditional row counting without ITERATE",
        },
        // --- GREATEST + LEAST + NULLIF + COUNT_IF combined ---
        TestQuery {
            name: "Q112: New functions combined (5 measures)",
            measures: vec![
                ("Revenue", "SUM(fact_sales[linetotal])"),
                ("ClampedRevPerOrder", "GREATEST(LEAST(DIVIDE(SUM(fact_sales[linetotal]), NULLIF(COUNT(fact_sales[salesorderdetailid]), 0), 0), 5000), 0)"),
                ("HighValueCount", "COUNT_IF(fact_sales[unitprice] > 100)"),
                ("PremiumShare", "DIVIDE(COUNT_IF(fact_sales[unitprice] > 100), NULLIF(COUNT(fact_sales[salesorderdetailid]), 0), 0)"),
                ("MaxOfAvgs", "GREATEST(AVG(fact_sales[unitprice]), AVG(fact_sales[linetotal]))"),
            ],
            group_by: vec![("dim_product", "categoryname"), ("dim_territory", "countryregioncode")],
            description: "GREATEST + LEAST + NULLIF + COUNT_IF — new function mix",
        },
        // --- COUNT_IF + KEEP ---
        TestQuery {
            name: "Q113: COUNT_IF + KEEP (3 measures)",
            measures: vec![
                ("HighValueBikeOrders", r#"COUNT_IF(fact_sales[unitprice] > 100, KEEP(dim_product, dim_product[categoryname] = "Bikes"))"#),
                ("TotalBikeOrders", r#"COUNT(fact_sales[salesorderdetailid], KEEP(dim_product, dim_product[categoryname] = "Bikes"))"#),
                ("AllHighValue", "COUNT_IF(fact_sales[unitprice] > 100)"),
            ],
            group_by: vec![("dim_territory", "countryregioncode")],
            description: "COUNT_IF with KEEP filter — conditional count within category",
        },
        // --- ITERATE + GREATEST + LEAST per-row ---
        TestQuery {
            name: "Q114: ITERATE with GREATEST/LEAST (3 measures)",
            measures: vec![
                ("ClampedRevenue", "SUM(ITERATE(fact_sales, GREATEST(LEAST(fact_sales[unitprice] * fact_sales[orderqty], 10000), 0)))"),
                ("PlainRevenue", "SUM(fact_sales[linetotal])"),
                ("AvgClamped", "AVG(ITERATE(fact_sales, GREATEST(fact_sales[unitprice], 1)))"),
            ],
            group_by: vec![("dim_product", "categoryname")],
            description: "ITERATE with GREATEST/LEAST for per-row clamping",
        },
        // --- CLEAREXCEPT + COUNT_IF + NULLIF ---
        TestQuery {
            name: "Q115: CLEAREXCEPT + COUNT_IF (4 measures, 2 dims)",
            measures: vec![
                ("Revenue", "SUM(fact_sales[linetotal])"),
                ("CatTotal", "SUM(fact_sales[linetotal], CLEAREXCEPT(dim_product, dim_product[categoryname]))"),
                ("HighValuePct", "DIVIDE(COUNT_IF(fact_sales[unitprice] > 100), NULLIF(COUNT(fact_sales[salesorderdetailid]), 0), 0)"),
                ("PctOfCat", "DIVIDE(SUM(fact_sales[linetotal]), SUM(fact_sales[linetotal], CLEAREXCEPT(dim_product, dim_product[categoryname])), 0)"),
            ],
            group_by: vec![("dim_product", "categoryname"), ("dim_product", "subcategoryname")],
            description: "CLEAREXCEPT + COUNT_IF + NULLIF — hierarchy with conditional counting",
        },
        // --- VAR + GREATEST + NULLIF + COUNT_IF ---
        TestQuery {
            name: "Q116: VAR with new functions (3 measures)",
            measures: vec![
                ("QualityScore", "VAR high_val = COUNT_IF(fact_sales[unitprice] > 100) VAR total = COUNT(fact_sales[salesorderdetailid]) VAR ratio = DIVIDE(high_val, NULLIF(total, 0), 0) RETURN GREATEST(ROUND(ratio, 4), 0)"),
                ("Revenue", "SUM(fact_sales[linetotal])"),
                ("AvgPrice", "AVG(fact_sales[unitprice])"),
            ],
            group_by: vec![("dim_product", "categoryname"), ("dim_territory", "countryregioncode")],
            description: "VAR block using COUNT_IF + NULLIF + GREATEST + ROUND",
        },
        // --- ISINSCOPE + COUNT_IF + GREATEST ---
        TestQuery {
            name: "Q117: ISINSCOPE + new funcs adaptive (3 measures)",
            measures: vec![
                ("Revenue", "SUM(fact_sales[linetotal])"),
                ("AdaptiveCount", "IF(ISINSCOPE(dim_product[subcategoryname]), COUNT_IF(fact_sales[unitprice] > 50), COUNT(fact_sales[salesorderdetailid]))"),
                ("ClampedAvg", "GREATEST(LEAST(AVG(fact_sales[unitprice]), 2000), 1)"),
            ],
            group_by: vec![("dim_product", "categoryname"), ("dim_product", "subcategoryname")],
            description: "ISINSCOPE selecting COUNT_IF vs COUNT + GREATEST/LEAST clamping",
        },
        // --- QUERY + COUNT_IF (two-stage with conditional) ---
        TestQuery {
            name: "Q118: QUERY + COUNT_IF two-stage (2 measures)",
            measures: vec![
                ("AvgMonthlyHighVal", "VAR monthly = QUERY(COUNT_IF(fact_sales[unitprice] > 100) AS high_val_count BY dim_date[year], dim_date[month]) RETURN AVG(monthly[high_val_count])"),
                ("Revenue", "SUM(fact_sales[linetotal])"),
            ],
            group_by: vec![("dim_product", "categoryname")],
            description: "QUERY with COUNT_IF inside — two-stage conditional counting",
        },
        // --- GREATEST + LEAST + PERCENTILE ---
        TestQuery {
            name: "Q119: Clamped percentiles (4 measures)",
            measures: vec![
                ("P50", "PERCENTILE(fact_sales[unitprice], 0.5)"),
                ("P90", "PERCENTILE(fact_sales[unitprice], 0.9)"),
                ("ClampedP90", "LEAST(PERCENTILE(fact_sales[unitprice], 0.9), 5000)"),
                ("AdjustedIQR", "GREATEST(PERCENTILE(fact_sales[unitprice], 0.75) - PERCENTILE(fact_sales[unitprice], 0.25), 0)"),
            ],
            group_by: vec![("dim_product", "categoryname")],
            description: "PERCENTILE + GREATEST + LEAST — clamped and adjusted percentiles",
        },
        // --- OFFSET + WINDOW (time-series) + new funcs ---
        TestQuery {
            name: "Q120: Time-series with new funcs (4 measures)",
            measures: vec![
                ("Revenue", "SUM(fact_sales[linetotal])"),
                ("PrevRev", "OFFSET(SUM(fact_sales[linetotal]), -1, ORDERBY(dim_date[yearmonth]))"),
                ("RunningTotal", "WINDOW(SUM(fact_sales[linetotal]), SUM, ORDERBY(dim_date[yearmonth]))"),
                ("HighValueOrders", "COUNT_IF(fact_sales[unitprice] > 100)"),
            ],
            group_by: vec![("dim_date", "yearmonth")],
            description: "OFFSET + WINDOW + COUNT_IF in time-series context",
        },
        // --- 10-measure mega report with all new functions ---
        TestQuery {
            name: "Q121: 10-measure mega with new funcs",
            measures: vec![
                ("Revenue", "SUM(fact_sales[linetotal])"),
                ("Orders", "COUNT(fact_sales[salesorderdetailid])"),
                ("HighValueCount", "COUNT_IF(fact_sales[unitprice] > 100)"),
                ("MedianPrice", "MEDIAN(fact_sales[unitprice])"),
                ("ClampedAvgPrice", "GREATEST(LEAST(AVG(fact_sales[unitprice]), 5000), 0)"),
                ("MaxOfSums", "GREATEST(SUM(fact_sales[linetotal]), SUM(fact_sales[unitprice] * fact_sales[orderqty]))"),
                ("SafeRatio", "DIVIDE(SUM(fact_sales[linetotal]), NULLIF(SUM(fact_sales[orderqty]), 0), 0)"),
                ("PctOfCat", "DIVIDE(SUM(fact_sales[linetotal]), SUM(fact_sales[linetotal], CLEAREXCEPT(dim_product, dim_product[categoryname])), 0)"),
                ("BikeShare", r#"DIVIDE(SUM(fact_sales[linetotal], KEEP(dim_product, dim_product[categoryname] = "Bikes")), SUM(fact_sales[linetotal]), 0)"#),
                ("RowCount", "COUNTROWS(fact_sales)"),
            ],
            group_by: vec![("dim_product", "categoryname"), ("dim_product", "subcategoryname")],
            description: "10 measures: SUM, COUNT, COUNT_IF, MEDIAN, GREATEST, LEAST, NULLIF, CLEAREXCEPT, KEEP, COUNTROWS",
        },
        // --- ITERATE + COUNT_IF + NULLIF + GREATEST combo ---
        TestQuery {
            name: "Q122: Deep ITERATE + new func combo (3 measures)",
            measures: vec![
                ("IterClampedRev", "SUM(ITERATE(fact_sales, GREATEST(LEAST(fact_sales[unitprice] * fact_sales[orderqty], 50000), 0)))"),
                ("SafeAvgIter", "IFERROR(DIVIDE(SUM(ITERATE(fact_sales, fact_sales[unitprice] * fact_sales[orderqty])), NULLIF(COUNT(fact_sales[salesorderdetailid]), 0), 0), 0)"),
                ("HighValOrders", "COUNT_IF(fact_sales[unitprice] > 100)"),
            ],
            group_by: vec![("dim_product", "categoryname"), ("dim_territory", "countryregioncode")],
            description: "ITERATE with GREATEST/LEAST + NULLIF + COUNT_IF — deep combo",
        },
        // --- Purchasing with new functions ---
        TestQuery {
            name: "Q123: Purchasing + new funcs (4 measures)",
            measures: vec![
                ("PurchaseQty", "SUM(fact_purchasing[receivedqty])"),
                ("HighPurchCount", "COUNT_IF(fact_purchasing[unitprice] > 50)"),
                ("ClampedAvgCost", "GREATEST(LEAST(AVG(fact_purchasing[unitprice]), 1000), 0)"),
                ("SafeRejectRate", "DIVIDE(SUM(fact_purchasing[rejectedqty]), NULLIF(SUM(fact_purchasing[receivedqty]), 0), 0)"),
            ],
            group_by: vec![("dim_product", "categoryname")],
            description: "fact_purchasing with COUNT_IF + GREATEST + LEAST + NULLIF",
        },
        // --- Grand total with new functions ---
        TestQuery {
            name: "Q124: Grand total new funcs (5 measures)",
            measures: vec![
                ("Revenue", "SUM(fact_sales[linetotal])"),
                ("HighValCount", "COUNT_IF(fact_sales[unitprice] > 100)"),
                ("MaxMetric", "GREATEST(SUM(fact_sales[linetotal]), SUM(fact_sales[unitprice] * fact_sales[orderqty]))"),
                ("ClampedAvg", "GREATEST(LEAST(AVG(fact_sales[unitprice]), 5000), 0)"),
                ("SafeAvg", "DIVIDE(SUM(fact_sales[linetotal]), NULLIF(COUNT(fact_sales[salesorderdetailid]), 0), 0)"),
            ],
            group_by: vec![],
            description: "Grand total: COUNT_IF + GREATEST + LEAST + NULLIF",
        },
        // --- KEEP + GREATEST + COUNT_IF + IFERROR multi-dim ---
        TestQuery {
            name: "Q125: Multi-KEEP + new funcs (5 measures, 2 dims)",
            measures: vec![
                ("Revenue", "SUM(fact_sales[linetotal])"),
                ("BikeHighVal", r#"COUNT_IF(fact_sales[unitprice] > 100, KEEP(dim_product, dim_product[categoryname] = "Bikes"))"#),
                ("BikeRev", r#"SUM(fact_sales[linetotal], KEEP(dim_product, dim_product[categoryname] = "Bikes"))"#),
                ("MaxRevenue", "GREATEST(SUM(fact_sales[linetotal]), 0)"),
                ("SafeBikeShare", r#"IFERROR(DIVIDE(SUM(fact_sales[linetotal], KEEP(dim_product, dim_product[categoryname] = "Bikes")), NULLIF(SUM(fact_sales[linetotal]), 0), 0), 0)"#),
            ],
            group_by: vec![("dim_territory", "countryregioncode"), ("dim_date", "year")],
            description: "KEEP + COUNT_IF + GREATEST + NULLIF + IFERROR — multi-dim",
        },
        // --- QUERY + new function combo ---
        TestQuery {
            name: "Q126: QUERY + GREATEST (2 measures)",
            measures: vec![
                ("MaxMonthlyRev", "VAR mq = QUERY(SUM(fact_sales[linetotal]) AS rev BY dim_date[year], dim_date[month]) RETURN MAX(mq[rev])"),
                ("ClampedAvgMonthly", "VAR mq2 = QUERY(SUM(fact_sales[linetotal]) AS rev BY dim_date[year], dim_date[month]) RETURN GREATEST(AVG(mq2[rev]), 0)"),
            ],
            group_by: vec![("dim_product", "categoryname")],
            description: "QUERY + GREATEST — two-stage with clamping",
        },
        // --- WINDOW + COUNT_IF time-series ---
        TestQuery {
            name: "Q127: WINDOW + COUNT_IF time analysis (3 measures)",
            measures: vec![
                ("Revenue", "SUM(fact_sales[linetotal])"),
                ("HighValCount", "COUNT_IF(fact_sales[unitprice] > 100)"),
                ("MovingAvgRev", "WINDOW(SUM(fact_sales[linetotal]), AVG, ORDERBY(dim_date[yearmonth]), ROWS(-2, REL, 0, REL))"),
            ],
            group_by: vec![("dim_date", "yearmonth")],
            description: "WINDOW moving average + COUNT_IF — time-series analytics",
        },
        // --- ABSOLUTE FINAL: every new function in one query ---
        TestQuery {
            name: "Q128: ALL NEW FUNCTIONS (8 measures, 3 dims)",
            measures: vec![
                ("Revenue", "SUM(fact_sales[linetotal])"),
                ("HighValOrders", "COUNT_IF(fact_sales[unitprice] > 100)"),
                ("ClampedAvg", "GREATEST(LEAST(AVG(fact_sales[unitprice]), 5000), 0)"),
                ("SafeRatio", "DIVIDE(SUM(fact_sales[linetotal]), NULLIF(SUM(fact_sales[orderqty]), 0), 0)"),
                ("CatTotal", "SUM(fact_sales[linetotal], CLEAREXCEPT(dim_product, dim_product[categoryname]))"),
                ("PctOfCat", "DIVIDE(SUM(fact_sales[linetotal]), SUM(fact_sales[linetotal], CLEAREXCEPT(dim_product, dim_product[categoryname])), 0)"),
                ("BikeHighVal", r#"COUNT_IF(fact_sales[unitprice] > 100, KEEP(dim_product, dim_product[categoryname] = "Bikes"))"#),
                ("IterClamped", "SUM(ITERATE(fact_sales, GREATEST(fact_sales[unitprice] * fact_sales[orderqty], 0)))"),
            ],
            group_by: vec![("dim_product", "categoryname"), ("dim_product", "subcategoryname"), ("dim_territory", "countryregioncode")],
            description: "ALL NEW: COUNT_IF + GREATEST + LEAST + NULLIF + CLEAREXCEPT + KEEP + ITERATE — 8 measures, 3 dims",
        },
        // =====================================================================
        // Level 129-168: MASSIVE function variety + deep cross-function mixing
        // =====================================================================
        // --- Group A: Statistical deep-dives (Q129-Q133) ---
        TestQuery {
            name: "Q129: Statistical dashboard (8 measures)",
            measures: vec![
                ("Revenue", "SUM(fact_sales[linetotal])"),
                ("MedianPrice", "MEDIAN(fact_sales[unitprice])"),
                ("P10Price", "PERCENTILE(fact_sales[unitprice], 0.1)"),
                ("P90Price", "PERCENTILE(fact_sales[unitprice], 0.9)"),
                ("IQR", "PERCENTILE(fact_sales[unitprice], 0.75) - PERCENTILE(fact_sales[unitprice], 0.25)"),
                ("CoeffVar", "DIVIDE(STDEV(fact_sales[unitprice]), NULLIF(AVG(fact_sales[unitprice]), 0), 0)"),
                ("PriceVariance", "VARIANCE(fact_sales[unitprice])"),
                ("HighValShare", "DIVIDE(COUNT_IF(fact_sales[unitprice] > 100), NULLIF(COUNT(fact_sales[salesorderdetailid]), 0), 0)"),
            ],
            group_by: vec![("dim_product", "categoryname")],
            description: "MEDIAN + PERCENTILE + STDEV + VARIANCE + COUNT_IF + NULLIF — statistical dashboard",
        },
        TestQuery {
            name: "Q130: Statistical + KEEP (5 measures, 2 dims)",
            measures: vec![
                ("AllMedian", "MEDIAN(fact_sales[unitprice])"),
                ("BikeMedian", r#"MEDIAN(fact_sales[unitprice], KEEP(dim_product, dim_product[categoryname] = "Bikes"))"#),
                ("BikeP90", r#"PERCENTILE(fact_sales[unitprice], 0.9, KEEP(dim_product, dim_product[categoryname] = "Bikes"))"#),
                ("BikeStdev", r#"STDEV(fact_sales[unitprice], KEEP(dim_product, dim_product[categoryname] = "Bikes"))"#),
                ("AllStdev", "STDEV(fact_sales[unitprice])"),
            ],
            group_by: vec![("dim_territory", "countryregioncode"), ("dim_date", "year")],
            description: "Statistical aggregates with KEEP filters — comparative stats",
        },
        TestQuery {
            name: "Q131: Clamped percentile spread (4 measures)",
            measures: vec![
                ("AdjIQR", "GREATEST(PERCENTILE(fact_sales[unitprice], 0.75) - PERCENTILE(fact_sales[unitprice], 0.25), 1)"),
                ("NormSpread", "DIVIDE(PERCENTILE(fact_sales[unitprice], 0.9) - PERCENTILE(fact_sales[unitprice], 0.1), NULLIF(MEDIAN(fact_sales[unitprice]), 0), 0)"),
                ("StableMetric", "LEAST(STDEV(fact_sales[unitprice]), AVG(fact_sales[unitprice]))"),
                ("Revenue", "SUM(fact_sales[linetotal])"),
            ],
            group_by: vec![("dim_product", "subcategoryname")],
            description: "PERCENTILE arithmetic + GREATEST + LEAST + NULLIF + MEDIAN",
        },
        TestQuery {
            name: "Q132: ITERATE + statistical per-row (4 measures)",
            measures: vec![
                ("SumSqPrice", "SUM(ITERATE(fact_sales, POWER(fact_sales[unitprice], 2)))"),
                ("MedianLine", "MEDIAN(fact_sales[linetotal])"),
                ("AvgIterCalc", "AVG(ITERATE(fact_sales, GREATEST(fact_sales[unitprice] * fact_sales[orderqty], 0)))"),
                ("P75Line", "PERCENTILE(fact_sales[linetotal], 0.75)"),
            ],
            group_by: vec![("dim_product", "categoryname")],
            description: "ITERATE with POWER + statistical aggregates in one query",
        },
        TestQuery {
            name: "Q133: COUNT_IF multi-condition (5 measures)",
            measures: vec![
                ("TotalOrders", "COUNT(fact_sales[salesorderdetailid])"),
                ("HighPrice", "COUNT_IF(fact_sales[unitprice] > 100)"),
                ("BulkQty", "COUNT_IF(fact_sales[orderqty] > 10)"),
                ("PremiumPct", "DIVIDE(COUNT_IF(fact_sales[unitprice] > 500), NULLIF(COUNT(fact_sales[salesorderdetailid]), 0), 0)"),
                ("AvgHighPrice", "DIVIDE(SUM(ITERATE(fact_sales, IF(fact_sales[unitprice] > 100, fact_sales[linetotal], 0))), NULLIF(COUNT_IF(fact_sales[unitprice] > 100), 0), 0)"),
            ],
            group_by: vec![("dim_product", "categoryname"), ("dim_territory", "countryregioncode")],
            description: "COUNT_IF multi-threshold + ITERATE conditional + NULLIF",
        },
        // --- Group B: Context ops deep (Q134-Q138) ---
        TestQuery {
            name: "Q134: Three-level hierarchy pct (6 measures, 2 dims)",
            measures: vec![
                ("Revenue", "SUM(fact_sales[linetotal])"),
                ("CatTotal", "SUM(fact_sales[linetotal], CLEAREXCEPT(dim_product, dim_product[categoryname]))"),
                ("PctOfCat", "DIVIDE(SUM(fact_sales[linetotal]), SUM(fact_sales[linetotal], CLEAREXCEPT(dim_product, dim_product[categoryname])), 0)"),
                ("GrandTotal", "SUM(fact_sales[linetotal], CLEAR(dim_product))"),
                ("PctOfGrand", "DIVIDE(SUM(fact_sales[linetotal]), SUM(fact_sales[linetotal], CLEAR(dim_product)), 0)"),
                ("MedianPrice", "MEDIAN(fact_sales[unitprice])"),
            ],
            group_by: vec![("dim_product", "categoryname"), ("dim_product", "subcategoryname")],
            description: "CLEAREXCEPT + CLEAR — hierarchy pct at category and grand total level",
        },
        TestQuery {
            name: "Q135: KEEP cross-dim + VAR (4 measures, 2 dims)",
            measures: vec![
                ("Revenue", "SUM(fact_sales[linetotal])"),
                ("USBikeRev", r#"SUM(fact_sales[linetotal], KEEP(dim_product, dim_product[categoryname] = "Bikes"), KEEP(dim_territory, dim_territory[countryregioncode] = "US"))"#),
                ("USBikePct", r#"VAR total = SUM(fact_sales[linetotal]) VAR us_bike = SUM(fact_sales[linetotal], KEEP(dim_product, dim_product[categoryname] = "Bikes"), KEEP(dim_territory, dim_territory[countryregioncode] = "US")) RETURN DIVIDE(us_bike, NULLIF(total, 0), 0)"#),
                ("CompRev", r#"SUM(fact_sales[linetotal], KEEP(dim_product, dim_product[categoryname] = "Components"))"#),
            ],
            group_by: vec![("dim_date", "year"), ("dim_date", "quarter")],
            description: "Multi-dim KEEP + VAR + NULLIF — cross-dimensional filtering",
        },
        TestQuery {
            name: "Q136: CLEAREXCEPT + KEEP + COUNT_IF (5 measures, 2 dims)",
            measures: vec![
                ("Revenue", "SUM(fact_sales[linetotal])"),
                ("CatTotal", "SUM(fact_sales[linetotal], CLEAREXCEPT(dim_product, dim_product[categoryname]))"),
                ("HighValCount", "COUNT_IF(fact_sales[unitprice] > 100)"),
                ("BikeRevPct", r#"DIVIDE(SUM(fact_sales[linetotal], KEEP(dim_product, dim_product[categoryname] = "Bikes")), SUM(fact_sales[linetotal]), 0)"#),
                ("BikeHighVal", r#"COUNT_IF(fact_sales[unitprice] > 100, KEEP(dim_product, dim_product[categoryname] = "Bikes"))"#),
            ],
            group_by: vec![("dim_product", "categoryname"), ("dim_product", "subcategoryname")],
            description: "CLEAREXCEPT + KEEP + COUNT_IF — context ops with conditional counting",
        },
        TestQuery {
            name: "Q137: ISINSCOPE adaptive hierarchy (5 measures, 2 dims)",
            measures: vec![
                ("Revenue", "SUM(fact_sales[linetotal])"),
                ("ParentTotal", r#"IF(ISINSCOPE(dim_product[subcategoryname]), SUM(fact_sales[linetotal], CLEAREXCEPT(dim_product, dim_product[categoryname])), SUM(fact_sales[linetotal], CLEAR(dim_product)))"#),
                ("PctOfParent", r#"DIVIDE(SUM(fact_sales[linetotal]), IF(ISINSCOPE(dim_product[subcategoryname]), SUM(fact_sales[linetotal], CLEAREXCEPT(dim_product, dim_product[categoryname])), SUM(fact_sales[linetotal], CLEAR(dim_product))), 0)"#),
                ("AdaptiveStat", "IF(ISINSCOPE(dim_product[subcategoryname]), MEDIAN(fact_sales[unitprice]), PERCENTILE(fact_sales[unitprice], 0.75))"),
                ("HighValPct", "DIVIDE(COUNT_IF(fact_sales[unitprice] > 100), NULLIF(COUNT(fact_sales[salesorderdetailid]), 0), 0)"),
            ],
            group_by: vec![("dim_product", "categoryname"), ("dim_product", "subcategoryname")],
            description: "ISINSCOPE + CLEAREXCEPT + CLEAR + MEDIAN + PERCENTILE + COUNT_IF",
        },
        TestQuery {
            name: "Q138: Multi-CLEAR dimensions (4 measures, 3 dims)",
            measures: vec![
                ("Revenue", "SUM(fact_sales[linetotal])"),
                ("ClearProduct", "SUM(fact_sales[linetotal], CLEAR(dim_product))"),
                ("ClearTerritory", "SUM(fact_sales[linetotal], CLEAR(dim_territory))"),
                ("PctOfTerritory", "DIVIDE(SUM(fact_sales[linetotal]), SUM(fact_sales[linetotal], CLEAR(dim_territory)), 0)"),
            ],
            group_by: vec![("dim_product", "categoryname"), ("dim_territory", "countryregioncode"), ("dim_date", "year")],
            description: "Multiple CLEAR targets in one query — product vs territory",
        },
        // --- Group C: ITERATE deep combos (Q139-Q143) ---
        TestQuery {
            name: "Q139: ITERATE 6 variants (6 measures)",
            measures: vec![
                ("SumIter", "SUM(ITERATE(fact_sales, fact_sales[unitprice] * fact_sales[orderqty]))"),
                ("AvgIter", "AVG(ITERATE(fact_sales, fact_sales[unitprice] * fact_sales[orderqty]))"),
                ("MaxIter", "MAX(ITERATE(fact_sales, fact_sales[unitprice] * fact_sales[orderqty]))"),
                ("MinIter", "MIN(ITERATE(fact_sales, fact_sales[unitprice] * fact_sales[orderqty]))"),
                ("SumClampedIter", "SUM(ITERATE(fact_sales, GREATEST(LEAST(fact_sales[unitprice] * fact_sales[orderqty], 50000), 0)))"),
                ("AvgSafeIter", "AVG(ITERATE(fact_sales, IFERROR(DIVIDE(fact_sales[linetotal], fact_sales[orderqty], 0), 0)))"),
            ],
            group_by: vec![("dim_product", "categoryname")],
            description: "ITERATE with SUM/AVG/MAX/MIN + GREATEST/LEAST + IFERROR",
        },
        TestQuery {
            name: "Q140: ITERATE + KEEP + multi-dim (4 measures, 2 dims)",
            measures: vec![
                ("BikeIterRev", r#"SUM(ITERATE(fact_sales, fact_sales[unitprice] * fact_sales[orderqty]), KEEP(dim_product, dim_product[categoryname] = "Bikes"))"#),
                ("AllIterRev", "SUM(ITERATE(fact_sales, fact_sales[unitprice] * fact_sales[orderqty]))"),
                ("BikeIterShare", r#"DIVIDE(SUM(ITERATE(fact_sales, fact_sales[unitprice] * fact_sales[orderqty]), KEEP(dim_product, dim_product[categoryname] = "Bikes")), NULLIF(SUM(ITERATE(fact_sales, fact_sales[unitprice] * fact_sales[orderqty])), 0), 0)"#),
                ("HighValIter", "SUM(ITERATE(fact_sales, IF(fact_sales[unitprice] > 100, fact_sales[linetotal], 0)))"),
            ],
            group_by: vec![("dim_territory", "countryregioncode"), ("dim_date", "year")],
            description: "ITERATE + KEEP + DIVIDE + NULLIF + IF — row-level with context",
        },
        TestQuery {
            name: "Q141: ITERATE complex per-row (3 measures)",
            measures: vec![
                ("DiscountPct", "AVG(ITERATE(fact_sales, IFERROR(DIVIDE(fact_sales[linetotal] - fact_sales[unitprice] * fact_sales[orderqty], NULLIF(fact_sales[unitprice] * fact_sales[orderqty], 0), 0), 0)))"),
                ("WeightedAvgPrice", "DIVIDE(SUM(ITERATE(fact_sales, fact_sales[unitprice] * fact_sales[orderqty])), NULLIF(SUM(fact_sales[orderqty]), 0), 0)"),
                ("ClampedMaxIter", "LEAST(MAX(ITERATE(fact_sales, fact_sales[unitprice] * fact_sales[orderqty])), 100000)"),
            ],
            group_by: vec![("dim_product", "categoryname"), ("dim_territory", "countryregioncode")],
            description: "ITERATE with nested IFERROR + NULLIF + DIVIDE + GREATEST/LEAST",
        },
        TestQuery {
            name: "Q142: ITERATE + LN + EXP + SQRT (3 measures)",
            measures: vec![
                ("LogAvgPrice", "LN(GREATEST(AVG(ITERATE(fact_sales, GREATEST(fact_sales[unitprice], 1))), 1))"),
                ("SqrtRevPerOrder", "SQRT(DIVIDE(SUM(fact_sales[linetotal]), NULLIF(COUNT(fact_sales[salesorderdetailid]), 0), 0))"),
                ("ExpNormRev", "EXP(DIVIDE(SUM(fact_sales[linetotal]), 100000000, 0))"),
            ],
            group_by: vec![("dim_product", "categoryname")],
            description: "ITERATE + LN + SQRT + EXP + GREATEST — deep math nesting",
        },
        TestQuery {
            name: "Q143: ITERATE + ROUND variants (4 measures)",
            measures: vec![
                ("RoundedAvgIter", "ROUND(AVG(ITERATE(fact_sales, fact_sales[unitprice] * fact_sales[orderqty])), 2)"),
                ("TruncAvgIter", "TRUNC(AVG(ITERATE(fact_sales, fact_sales[unitprice] * fact_sales[orderqty])), 0)"),
                ("CeilAvgIter", "CEILING(AVG(ITERATE(fact_sales, fact_sales[unitprice] * fact_sales[orderqty])))"),
                ("IntAvgIter", "INT(AVG(ITERATE(fact_sales, fact_sales[unitprice] * fact_sales[orderqty])))"),
            ],
            group_by: vec![("dim_product", "subcategoryname")],
            description: "ITERATE + ROUND + TRUNC + CEILING + INT — rounding variants",
        },
        // --- Group D: QUERY two-stage combos (Q144-Q147) ---
        TestQuery {
            name: "Q144: QUERY + statistical (3 measures)",
            measures: vec![
                ("AvgMonthlyRev", "VAR mq1 = QUERY(SUM(fact_sales[linetotal]) AS rev BY dim_date[year], dim_date[month]) RETURN AVG(mq1[rev])"),
                ("MedianMonthlyRev", "VAR mq2 = QUERY(SUM(fact_sales[linetotal]) AS rev BY dim_date[year], dim_date[month]) RETURN MEDIAN(mq2[rev])"),
                ("Revenue", "SUM(fact_sales[linetotal])"),
            ],
            group_by: vec![("dim_product", "categoryname")],
            description: "QUERY → AVG and MEDIAN of monthly revenue — two-stage with statistical",
        },
        TestQuery {
            name: "Q145: QUERY + COUNT_IF (2 measures)",
            measures: vec![
                ("AvgMonthlyHighVal", "VAR mq3 = QUERY(COUNT_IF(fact_sales[unitprice] > 100) AS hv BY dim_date[year], dim_date[month]) RETURN AVG(mq3[hv])"),
                ("TotalHighVal", "COUNT_IF(fact_sales[unitprice] > 100)"),
            ],
            group_by: vec![("dim_product", "categoryname")],
            description: "QUERY with COUNT_IF inside — two-stage conditional",
        },
        TestQuery {
            name: "Q146: QUERY + ITERATE two-stage (2 measures)",
            measures: vec![
                ("MaxMonthlyIterRev", "VAR mq4 = QUERY(SUM(ITERATE(fact_sales, fact_sales[unitprice] * fact_sales[orderqty])) AS iter_rev BY dim_date[year], dim_date[month]) RETURN MAX(mq4[iter_rev])"),
                ("PlainRevenue", "SUM(fact_sales[linetotal])"),
            ],
            group_by: vec![("dim_product", "categoryname")],
            description: "QUERY over ITERATE — two-stage row-level computation",
        },
        TestQuery {
            name: "Q147: QUERY + plain + KEEP mix (4 measures)",
            measures: vec![
                ("Revenue", "SUM(fact_sales[linetotal])"),
                ("BikeRev", r#"SUM(fact_sales[linetotal], KEEP(dim_product, dim_product[categoryname] = "Bikes"))"#),
                ("AvgMonthly", "VAR mq5 = QUERY(SUM(fact_sales[linetotal]) AS rev BY dim_date[year], dim_date[month]) RETURN AVG(mq5[rev])"),
                ("HighValOrders", "COUNT_IF(fact_sales[unitprice] > 100)"),
            ],
            group_by: vec![("dim_territory", "countryregioncode")],
            description: "Plain + KEEP + QUERY + COUNT_IF — four evaluation strategies in one query",
        },
        // --- Group E: WINDOW + OFFSET time-series (Q148-Q151) ---
        TestQuery {
            name: "Q148: WINDOW 3-month avg + running (3 measures)",
            measures: vec![
                ("Revenue", "SUM(fact_sales[linetotal])"),
                ("RunningTotal", "WINDOW(SUM(fact_sales[linetotal]), SUM, ORDERBY(dim_date[yearmonth]))"),
                ("MovAvg3", "WINDOW(SUM(fact_sales[linetotal]), AVG, ORDERBY(dim_date[yearmonth]), ROWS(-2, REL, 0, REL))"),
            ],
            group_by: vec![("dim_date", "yearmonth")],
            description: "WINDOW running total + 3-month moving average",
        },
        TestQuery {
            name: "Q149: OFFSET lag/lead (3 measures)",
            measures: vec![
                ("Revenue", "SUM(fact_sales[linetotal])"),
                ("PrevMonth", "OFFSET(SUM(fact_sales[linetotal]), -1, ORDERBY(dim_date[yearmonth]))"),
                ("TwoMonthsAgo", "OFFSET(SUM(fact_sales[linetotal]), -2, ORDERBY(dim_date[yearmonth]))"),
            ],
            group_by: vec![("dim_date", "yearmonth")],
            description: "OFFSET at -1 and -2 — period-over-period comparison",
        },
        TestQuery {
            name: "Q150: INDEX absolute position (3 measures)",
            measures: vec![
                ("Revenue", "SUM(fact_sales[linetotal])"),
                ("FirstMonth", "INDEX(SUM(fact_sales[linetotal]), 1, ORDERBY(dim_date[yearmonth]))"),
                ("LastMonth", "INDEX(SUM(fact_sales[linetotal]), -1, ORDERBY(dim_date[yearmonth]))"),
            ],
            group_by: vec![("dim_date", "yearmonth")],
            description: "INDEX first and last month — absolute position window",
        },
        TestQuery {
            name: "Q151: WINDOW partitioned + OFFSET combined (4 measures)",
            measures: vec![
                ("Revenue", "SUM(fact_sales[linetotal])"),
                ("CatRunning", "WINDOW(SUM(fact_sales[linetotal]), SUM, ORDERBY(dim_date[yearmonth]), PARTITIONBY(dim_product[categoryname]))"),
                ("PrevMonth", "OFFSET(SUM(fact_sales[linetotal]), -1, ORDERBY(dim_date[yearmonth]))"),
                ("Orders", "COUNT(fact_sales[salesorderdetailid])"),
            ],
            group_by: vec![("dim_product", "categoryname"), ("dim_date", "yearmonth")],
            description: "WINDOW partitioned + OFFSET — rich time-series analytics",
        },
        // --- Group F: VAR deep nesting (Q152-Q155) ---
        TestQuery {
            name: "Q152: VAR 6-variable block (2 measures)",
            measures: vec![
                ("ComplexScore", r#"VAR rev = SUM(fact_sales[linetotal]) VAR qty = SUM(fact_sales[orderqty]) VAR orders = COUNT(fact_sales[salesorderdetailid]) VAR avg_price = DIVIDE(rev, NULLIF(qty, 0), 0) VAR avg_order = DIVIDE(rev, NULLIF(orders, 0), 0) VAR score = GREATEST(SQRT(avg_price * avg_order), 0) RETURN ROUND(score, 2)"#),
                ("Revenue", "SUM(fact_sales[linetotal])"),
            ],
            group_by: vec![("dim_product", "categoryname"), ("dim_territory", "countryregioncode")],
            description: "VAR with 6 bindings + NULLIF + GREATEST + SQRT + ROUND",
        },
        TestQuery {
            name: "Q153: VAR + ITERATE + KEEP (2 measures)",
            measures: vec![
                ("BikeEfficiency", r#"VAR bike_rev = SUM(fact_sales[linetotal], KEEP(dim_product, dim_product[categoryname] = "Bikes")) VAR bike_iter = SUM(ITERATE(fact_sales, fact_sales[unitprice] * fact_sales[orderqty]), KEEP(dim_product, dim_product[categoryname] = "Bikes")) RETURN IFERROR(ROUND(DIVIDE(bike_rev, NULLIF(bike_iter, 0), 0), 4), 1)"#),
                ("Revenue", "SUM(fact_sales[linetotal])"),
            ],
            group_by: vec![("dim_territory", "countryregioncode")],
            description: "VAR with KEEP + ITERATE + IFERROR + NULLIF + ROUND + DIVIDE",
        },
        TestQuery {
            name: "Q154: VAR + conditional tier (2 measures)",
            measures: vec![
                ("Tier", r#"VAR rev = SUM(fact_sales[linetotal]) VAR orders = COUNT(fact_sales[salesorderdetailid]) VAR avg_val = DIVIDE(rev, NULLIF(orders, 0), 0) VAR high_pct = DIVIDE(COUNT_IF(fact_sales[unitprice] > 100), NULLIF(orders, 0), 0) RETURN IF(avg_val > 1000 AND high_pct > 0.5, "Premium", IF(avg_val > 100, "Standard", "Budget"))"#),
                ("Revenue", "SUM(fact_sales[linetotal])"),
            ],
            group_by: vec![("dim_product", "categoryname"), ("dim_territory", "countryregioncode")],
            description: "VAR + COUNT_IF + NULLIF + IF — complex tiering logic",
        },
        TestQuery {
            name: "Q155: VAR + PERCENTILE + CLEAREXCEPT (2 measures)",
            measures: vec![
                ("PricePosition", "VAR p25 = PERCENTILE(fact_sales[unitprice], 0.25) VAR p75 = PERCENTILE(fact_sales[unitprice], 0.75) VAR spread = GREATEST(p75 - p25, 1) VAR med = MEDIAN(fact_sales[unitprice]) RETURN ROUND(DIVIDE(med - p25, spread, 0), 4)"),
                ("CatTotal", "SUM(fact_sales[linetotal], CLEAREXCEPT(dim_product, dim_product[categoryname]))"),
            ],
            group_by: vec![("dim_product", "categoryname"), ("dim_product", "subcategoryname")],
            description: "VAR + PERCENTILE + MEDIAN + GREATEST + CLEAREXCEPT",
        },
        // --- Group G: Multi-fact + GREATEST/LEAST (Q156-Q158) ---
        TestQuery {
            name: "Q156: Purchasing deep stats (5 measures)",
            measures: vec![
                ("PurchQty", "SUM(fact_purchasing[receivedqty])"),
                ("RejectQty", "SUM(fact_purchasing[rejectedqty])"),
                ("RejectRate", "DIVIDE(SUM(fact_purchasing[rejectedqty]), NULLIF(SUM(fact_purchasing[receivedqty]), 0), 0)"),
                ("MedianCost", "MEDIAN(fact_purchasing[unitprice])"),
                ("HighCostCount", "COUNT_IF(fact_purchasing[unitprice] > 50)"),
            ],
            group_by: vec![("dim_product", "categoryname"), ("dim_date", "year")],
            description: "Purchasing: NULLIF + MEDIAN + COUNT_IF — cross-fact stats",
        },
        TestQuery {
            name: "Q157: GREATEST across aggregates (4 measures)",
            measures: vec![
                ("Revenue", "SUM(fact_sales[linetotal])"),
                ("MaxOfAvgs", "GREATEST(AVG(fact_sales[unitprice]), AVG(fact_sales[linetotal]), DIVIDE(SUM(fact_sales[linetotal]), NULLIF(COUNT(fact_sales[salesorderdetailid]), 0), 0))"),
                ("MinOfMaxes", "LEAST(MAX(fact_sales[unitprice]), MAX(fact_sales[linetotal]))"),
                ("BoundedStdev", "LEAST(STDEV(fact_sales[unitprice]), AVG(fact_sales[unitprice]))"),
            ],
            group_by: vec![("dim_product", "categoryname")],
            description: "GREATEST/LEAST across multiple aggregates — cross-aggregate comparison",
        },
        TestQuery {
            name: "Q158: NULLIF everywhere (4 measures)",
            measures: vec![
                ("SafeAvgPrice", "DIVIDE(SUM(fact_sales[linetotal]), NULLIF(COUNT(fact_sales[salesorderdetailid]), 0), 0)"),
                ("SafeRevPerCust", "DIVIDE(SUM(fact_sales[linetotal]), NULLIF(DISTINCTCOUNT(fact_sales[customerid]), 0), 0)"),
                ("SafeQtyRatio", "DIVIDE(SUM(fact_sales[orderqty]), NULLIF(DISTINCTCOUNT(fact_sales[productid]), 0), 0)"),
                ("ClampedSafe", "GREATEST(DIVIDE(SUM(fact_sales[linetotal]), NULLIF(SUM(fact_sales[orderqty]), 0), 0), 0)"),
            ],
            group_by: vec![("dim_product", "categoryname"), ("dim_territory", "countryregioncode")],
            description: "NULLIF in every measure — defensive division patterns",
        },
        // --- Group H: Grand totals extreme (Q159-Q161) ---
        TestQuery {
            name: "Q159: Grand total mega (10 measures)",
            measures: vec![
                ("Revenue", "SUM(fact_sales[linetotal])"),
                ("Orders", "COUNT(fact_sales[salesorderdetailid])"),
                ("AvgOrder", "DIVIDE(SUM(fact_sales[linetotal]), NULLIF(COUNT(fact_sales[salesorderdetailid]), 0), 0)"),
                ("MedianPrice", "MEDIAN(fact_sales[unitprice])"),
                ("P90Price", "PERCENTILE(fact_sales[unitprice], 0.9)"),
                ("Stdev", "STDEV(fact_sales[unitprice])"),
                ("HighValPct", "DIVIDE(COUNT_IF(fact_sales[unitprice] > 100), NULLIF(COUNT(fact_sales[salesorderdetailid]), 0), 0)"),
                ("ClampedAvg", "GREATEST(LEAST(AVG(fact_sales[unitprice]), 5000), 0)"),
                ("Customers", "DISTINCTCOUNT(fact_sales[customerid])"),
                ("RowCount", "COUNTROWS(fact_sales)"),
            ],
            group_by: vec![],
            description: "Grand total: 10 measures with every aggregate type",
        },
        TestQuery {
            name: "Q160: Grand total VAR deep (3 measures)",
            measures: vec![
                ("HealthIndex", "VAR rev = SUM(fact_sales[linetotal]) VAR cust = DISTINCTCOUNT(fact_sales[customerid]) VAR orders = COUNT(fact_sales[salesorderdetailid]) VAR rev_per_cust = DIVIDE(rev, NULLIF(cust, 0), 0) VAR orders_per_cust = DIVIDE(orders, NULLIF(cust, 0), 0) RETURN ROUND(SQRT(GREATEST(rev_per_cust * orders_per_cust, 0)), 2)"),
                ("Revenue", "SUM(fact_sales[linetotal])"),
                ("SqrtRevPerCust", "ROUND(SQRT(GREATEST(DIVIDE(SUM(fact_sales[linetotal]), NULLIF(DISTINCTCOUNT(fact_sales[customerid]), 0), 0), 0)), 2)"),
            ],
            group_by: vec![],
            description: "Grand total: deep VAR + NULLIF + SQRT + GREATEST + ROUND",
        },
        TestQuery {
            name: "Q161: Grand total ITERATE (4 measures)",
            measures: vec![
                ("IterRev", "SUM(ITERATE(fact_sales, fact_sales[unitprice] * fact_sales[orderqty]))"),
                ("IterAvg", "AVG(ITERATE(fact_sales, IFERROR(DIVIDE(fact_sales[linetotal], fact_sales[orderqty], 0), 0)))"),
                ("IterClamped", "SUM(ITERATE(fact_sales, GREATEST(LEAST(fact_sales[linetotal], 50000), 0)))"),
                ("PlainRev", "SUM(fact_sales[linetotal])"),
            ],
            group_by: vec![],
            description: "Grand total ITERATE: SUM + AVG + clamped — no group-by",
        },
        // --- Group I: Triple-dim extreme (Q162-Q165) ---
        TestQuery {
            name: "Q162: Triple-dim 8-measure (8 measures, 3 dims)",
            measures: vec![
                ("Revenue", "SUM(fact_sales[linetotal])"),
                ("AvgPrice", "AVG(fact_sales[unitprice])"),
                ("MedianPrice", "MEDIAN(fact_sales[unitprice])"),
                ("Orders", "COUNT(fact_sales[salesorderdetailid])"),
                ("HighValPct", "DIVIDE(COUNT_IF(fact_sales[unitprice] > 100), NULLIF(COUNT(fact_sales[salesorderdetailid]), 0), 0)"),
                ("BikeShare", r#"DIVIDE(SUM(fact_sales[linetotal], KEEP(dim_product, dim_product[categoryname] = "Bikes")), NULLIF(SUM(fact_sales[linetotal]), 0), 0)"#),
                ("CatTotal", "SUM(fact_sales[linetotal], CLEAREXCEPT(dim_product, dim_product[categoryname]))"),
                ("PctOfCat", "DIVIDE(SUM(fact_sales[linetotal]), SUM(fact_sales[linetotal], CLEAREXCEPT(dim_product, dim_product[categoryname])), 0)"),
            ],
            group_by: vec![("dim_product", "categoryname"), ("dim_product", "subcategoryname"), ("dim_territory", "countryregioncode")],
            description: "8 measures + 3 dims: MEDIAN + COUNT_IF + KEEP + CLEAREXCEPT + NULLIF",
        },
        TestQuery {
            name: "Q163: Triple-dim ITERATE + VAR (4 measures, 3 dims)",
            measures: vec![
                ("Revenue", "SUM(fact_sales[linetotal])"),
                ("IterRev", "SUM(ITERATE(fact_sales, fact_sales[unitprice] * fact_sales[orderqty]))"),
                ("Efficiency", "VAR plain = SUM(fact_sales[linetotal]) VAR computed = SUM(ITERATE(fact_sales, fact_sales[unitprice] * fact_sales[orderqty])) RETURN IFERROR(ROUND(DIVIDE(plain, NULLIF(computed, 0), 0), 4), 1)"),
                ("HighValCount", "COUNT_IF(fact_sales[unitprice] > 100)"),
            ],
            group_by: vec![("dim_product", "categoryname"), ("dim_territory", "countryregioncode"), ("dim_date", "year")],
            description: "Triple-dim: ITERATE + VAR + IFERROR + NULLIF + COUNT_IF",
        },
        TestQuery {
            name: "Q164: Triple-dim KEEP + CLEAR (5 measures, 3 dims)",
            measures: vec![
                ("Revenue", "SUM(fact_sales[linetotal])"),
                ("BikeRev", r#"SUM(fact_sales[linetotal], KEEP(dim_product, dim_product[categoryname] = "Bikes"))"#),
                ("YearTotal", "SUM(fact_sales[linetotal], CLEAREXCEPT(dim_date, dim_date[year]))"),
                ("TerritoryTotal", "SUM(fact_sales[linetotal], CLEAR(dim_territory))"),
                ("CatTotal", "SUM(fact_sales[linetotal], CLEAREXCEPT(dim_product, dim_product[categoryname]))"),
            ],
            group_by: vec![("dim_product", "categoryname"), ("dim_territory", "countryregioncode"), ("dim_date", "year")],
            description: "Triple-dim: KEEP + CLEAREXCEPT + CLEAR — three context scopes",
        },
        TestQuery {
            name: "Q165: Triple-dim ALL features (6 measures, 3 dims)",
            measures: vec![
                ("Revenue", "SUM(fact_sales[linetotal])"),
                ("MedianPrice", "MEDIAN(fact_sales[unitprice])"),
                ("BikeRev", r#"SUM(fact_sales[linetotal], KEEP(dim_product, dim_product[categoryname] = "Bikes"))"#),
                ("CatPct", "DIVIDE(SUM(fact_sales[linetotal]), SUM(fact_sales[linetotal], CLEAREXCEPT(dim_product, dim_product[categoryname])), 0)"),
                ("HighValPct", "DIVIDE(COUNT_IF(fact_sales[unitprice] > 100), NULLIF(COUNT(fact_sales[salesorderdetailid]), 0), 0)"),
                ("ClampedAvg", "GREATEST(LEAST(AVG(fact_sales[unitprice]), 5000), 0)"),
            ],
            group_by: vec![("dim_product", "categoryname"), ("dim_territory", "countryregioncode"), ("dim_date", "year")],
            description: "Triple-dim: SUM + MEDIAN + KEEP + CLEAREXCEPT + COUNT_IF + NULLIF + GREATEST + LEAST",
        },
        // --- Group J: THE ABSOLUTE FINALE (Q166-Q168) ---
        TestQuery {
            name: "Q166: 12-measure mega-report (12 measures, 2 dims)",
            measures: vec![
                ("Revenue", "SUM(fact_sales[linetotal])"),
                ("Qty", "SUM(fact_sales[orderqty])"),
                ("Orders", "COUNT(fact_sales[salesorderdetailid])"),
                ("AvgOrder", "DIVIDE(SUM(fact_sales[linetotal]), NULLIF(COUNT(fact_sales[salesorderdetailid]), 0), 0)"),
                ("MedianPrice", "MEDIAN(fact_sales[unitprice])"),
                ("P90Price", "PERCENTILE(fact_sales[unitprice], 0.9)"),
                ("PriceStdev", "STDEV(fact_sales[unitprice])"),
                ("HighValPct", "DIVIDE(COUNT_IF(fact_sales[unitprice] > 100), NULLIF(COUNT(fact_sales[salesorderdetailid]), 0), 0)"),
                ("BikeShare", r#"DIVIDE(SUM(fact_sales[linetotal], KEEP(dim_product, dim_product[categoryname] = "Bikes")), NULLIF(SUM(fact_sales[linetotal]), 0), 0)"#),
                ("CatTotal", "SUM(fact_sales[linetotal], CLEAREXCEPT(dim_product, dim_product[categoryname]))"),
                ("IterRev", "SUM(ITERATE(fact_sales, fact_sales[unitprice] * fact_sales[orderqty]))"),
                ("RowCount", "COUNTROWS(fact_sales)"),
            ],
            group_by: vec![("dim_product", "categoryname"), ("dim_product", "subcategoryname")],
            description: "12 measures: SUM + COUNT + MEDIAN + PERCENTILE + STDEV + COUNT_IF + KEEP + CLEAREXCEPT + ITERATE + COUNTROWS",
        },
        TestQuery {
            name: "Q167: Time-series full analysis (6 measures)",
            measures: vec![
                ("Revenue", "SUM(fact_sales[linetotal])"),
                ("PrevMonth", "OFFSET(SUM(fact_sales[linetotal]), -1, ORDERBY(dim_date[yearmonth]))"),
                ("RunningTotal", "WINDOW(SUM(fact_sales[linetotal]), SUM, ORDERBY(dim_date[yearmonth]))"),
                ("MovAvg3", "WINDOW(SUM(fact_sales[linetotal]), AVG, ORDERBY(dim_date[yearmonth]), ROWS(-2, REL, 0, REL))"),
                ("HighValCount", "COUNT_IF(fact_sales[unitprice] > 100)"),
                ("MedianPrice", "MEDIAN(fact_sales[unitprice])"),
            ],
            group_by: vec![("dim_date", "yearmonth")],
            description: "Full time-series: OFFSET + WINDOW running + moving avg + COUNT_IF + MEDIAN",
        },
        TestQuery {
            name: "Q168: THE ULTIMATE (10 measures, 3 dims, EVERY feature)",
            measures: vec![
                ("Revenue", "SUM(fact_sales[linetotal])"),
                ("IterRev", "SUM(ITERATE(fact_sales, GREATEST(fact_sales[unitprice] * fact_sales[orderqty], 0)))"),
                ("BikeRev", r#"SUM(fact_sales[linetotal], KEEP(dim_product, dim_product[categoryname] = "Bikes"))"#),
                ("CatTotal", "SUM(fact_sales[linetotal], CLEAREXCEPT(dim_product, dim_product[categoryname]))"),
                ("PctOfCat", "DIVIDE(SUM(fact_sales[linetotal]), SUM(fact_sales[linetotal], CLEAREXCEPT(dim_product, dim_product[categoryname])), 0)"),
                ("MedianPrice", "MEDIAN(fact_sales[unitprice])"),
                ("HighValPct", "DIVIDE(COUNT_IF(fact_sales[unitprice] > 100), NULLIF(COUNT(fact_sales[salesorderdetailid]), 0), 0)"),
                ("SafeEfficiency", r#"VAR rev = SUM(fact_sales[linetotal]) VAR iter = SUM(ITERATE(fact_sales, fact_sales[unitprice] * fact_sales[orderqty])) RETURN IFERROR(ROUND(DIVIDE(rev, NULLIF(iter, 0), 0), 4), 1)"#),
                ("ClampedStdev", "GREATEST(LEAST(STDEV(fact_sales[unitprice]), AVG(fact_sales[unitprice])), 0)"),
                ("RowCount", "COUNTROWS(fact_sales)"),
            ],
            group_by: vec![("dim_product", "categoryname"), ("dim_product", "subcategoryname"), ("dim_territory", "countryregioncode")],
            description: "THE ULTIMATE: 10 measures, 3 dims — SUM, ITERATE, KEEP, CLEAREXCEPT, DIVIDE, MEDIAN, COUNT_IF, NULLIF, VAR, IFERROR, ROUND, GREATEST, LEAST, STDEV, COUNTROWS",
        },
        // =====================================================================
        // Level 169-208: Untested functions, edge cases, stress combos
        // =====================================================================
        // --- Text functions in ITERATE context ---
        TestQuery {
            name: "Q169: ITERATE with IF + math row-level (3 measures)",
            measures: vec![
                ("IterDiscount", "SUM(ITERATE(fact_sales, IF(fact_sales[orderqty] > 5, fact_sales[linetotal] * 0.9, fact_sales[linetotal])))"),
                ("IterCapped", "SUM(ITERATE(fact_sales, LEAST(fact_sales[linetotal], 10000)))"),
                ("Revenue", "SUM(fact_sales[linetotal])"),
            ],
            group_by: vec![("dim_product", "categoryname")],
            description: "ITERATE with IF + LEAST — row-level discount and capping",
        },
        // --- ISBLANK / BLANK ---
        TestQuery {
            name: "Q170: ISBLANK conditional (3 measures)",
            measures: vec![
                ("Revenue", "SUM(fact_sales[linetotal])"),
                ("SafeAvg", "IF(ISBLANK(AVG(fact_sales[unitprice])), 0, AVG(fact_sales[unitprice]))"),
                ("NullSafeCount", "COALESCE(COUNT(fact_sales[salesorderdetailid]), 0)"),
            ],
            group_by: vec![("dim_product", "categoryname"), ("dim_territory", "countryregioncode")],
            description: "ISBLANK + BLANK handling — null-safe aggregates",
        },
        // --- FLOOR as scalar ---
        TestQuery {
            name: "Q171: FLOOR + INT + CEILING combos (4 measures)",
            measures: vec![
                ("FloorAvg", "FLOOR(AVG(fact_sales[unitprice]))"),
                ("CeilAvg", "CEILING(AVG(fact_sales[unitprice]))"),
                ("IntAvg", "INT(AVG(fact_sales[unitprice]))"),
                ("TruncAvg", "TRUNC(AVG(fact_sales[unitprice]), 1)"),
            ],
            group_by: vec![("dim_product", "subcategoryname")],
            description: "FLOOR + CEILING + INT + TRUNC — rounding edge cases",
        },
        // --- NOT + XOR logic ---
        TestQuery {
            name: "Q172: NOT + logic ops (3 measures)",
            measures: vec![
                ("Revenue", "SUM(fact_sales[linetotal])"),
                ("NotHighVal", "IF(NOT(AVG(fact_sales[unitprice]) > 100), SUM(fact_sales[linetotal]), 0)"),
                ("MidRange", "IF(AVG(fact_sales[unitprice]) > 50 AND NOT(AVG(fact_sales[unitprice]) > 500), SUM(fact_sales[linetotal]), 0)"),
            ],
            group_by: vec![("dim_product", "categoryname")],
            description: "NOT operator in conditional — logic inversion",
        },
        // --- MONTH / QUARTER / DAY date functions ---
        TestQuery {
            name: "Q173: Date dimension deep drill (3 measures, 3 dims)",
            measures: vec![
                ("Revenue", "SUM(fact_sales[linetotal])"),
                ("Orders", "COUNT(fact_sales[salesorderdetailid])"),
                ("AvgOrder", "DIVIDE(SUM(fact_sales[linetotal]), NULLIF(COUNT(fact_sales[salesorderdetailid]), 0), 0)"),
            ],
            group_by: vec![("dim_date", "year"), ("dim_date", "quarter"), ("dim_date", "monthname")],
            description: "Year + quarter + monthname — 3-level date hierarchy",
        },
        // --- Purchasing + ITERATE ---
        TestQuery {
            name: "Q174: Purchasing ITERATE (3 measures)",
            measures: vec![
                ("ComputedCost", "SUM(ITERATE(fact_purchasing, fact_purchasing[receivedqty] * fact_purchasing[unitprice]))"),
                ("PlainQty", "SUM(fact_purchasing[receivedqty])"),
                ("AvgIterCost", "AVG(ITERATE(fact_purchasing, fact_purchasing[receivedqty] * fact_purchasing[unitprice]))"),
            ],
            group_by: vec![("dim_product", "categoryname")],
            description: "ITERATE on fact_purchasing — row-level cost computation",
        },
        // --- COALESCE deep nesting ---
        TestQuery {
            name: "Q175: COALESCE chains (3 measures)",
            measures: vec![
                ("SafeRevenue", "COALESCE(SUM(fact_sales[linetotal]), 0)"),
                ("SafeAvgPrice", "COALESCE(AVG(fact_sales[unitprice]), MEDIAN(fact_sales[unitprice]), 0)"),
                ("FirstNonNull", "COALESCE(PERCENTILE(fact_sales[unitprice], 0.5), AVG(fact_sales[unitprice]), 0)"),
            ],
            group_by: vec![("dim_product", "categoryname")],
            description: "COALESCE with multiple fallback expressions",
        },
        // --- COUNT_IF complex conditions ---
        TestQuery {
            name: "Q176: COUNT_IF multi-threshold (5 measures)",
            measures: vec![
                ("Under10", "COUNT_IF(fact_sales[unitprice] < 10)"),
                ("Between10And100", "COUNT_IF(fact_sales[unitprice] >= 10 AND fact_sales[unitprice] < 100)"),
                ("Between100And1000", "COUNT_IF(fact_sales[unitprice] >= 100 AND fact_sales[unitprice] < 1000)"),
                ("Over1000", "COUNT_IF(fact_sales[unitprice] >= 1000)"),
                ("TotalOrders", "COUNT(fact_sales[salesorderdetailid])"),
            ],
            group_by: vec![("dim_product", "categoryname")],
            description: "COUNT_IF with AND conditions — multi-band classification",
        },
        // --- EXP + LN + LOG10 deep math ---
        TestQuery {
            name: "Q177: Logarithmic measures (4 measures)",
            measures: vec![
                ("LnRevenue", "LN(SUM(fact_sales[linetotal]) + 1)"),
                ("Log10Revenue", "LOG10(SUM(fact_sales[linetotal]) + 1)"),
                ("ExpNormalized", "EXP(DIVIDE(LN(SUM(fact_sales[linetotal]) + 1), 10, 0))"),
                ("SqrtMedian", "SQRT(GREATEST(MEDIAN(fact_sales[unitprice]), 0))"),
            ],
            group_by: vec![("dim_product", "categoryname")],
            description: "LN + LOG10 + EXP + SQRT deep math on aggregates",
        },
        // --- GREATEST/LEAST 3+ arguments ---
        TestQuery {
            name: "Q178: GREATEST/LEAST multi-arg (3 measures)",
            measures: vec![
                ("MaxMetric", "GREATEST(SUM(fact_sales[linetotal]), SUM(fact_sales[unitprice] * fact_sales[orderqty]), AVG(fact_sales[unitprice]) * COUNT(fact_sales[salesorderdetailid]))"),
                ("MinMetric", "LEAST(AVG(fact_sales[unitprice]), MEDIAN(fact_sales[unitprice]), DIVIDE(SUM(fact_sales[linetotal]), NULLIF(COUNT(fact_sales[salesorderdetailid]), 0), 0))"),
                ("Revenue", "SUM(fact_sales[linetotal])"),
            ],
            group_by: vec![("dim_product", "categoryname")],
            description: "GREATEST/LEAST with 3 aggregate arguments each",
        },
        // --- NULLIF + DIVIDE defensive patterns everywhere ---
        TestQuery {
            name: "Q179: NULLIF defensive everywhere (6 measures)",
            measures: vec![
                ("SafeAvgOrder", "DIVIDE(SUM(fact_sales[linetotal]), NULLIF(COUNT(fact_sales[salesorderdetailid]), 0), 0)"),
                ("SafeRevPerCust", "DIVIDE(SUM(fact_sales[linetotal]), NULLIF(DISTINCTCOUNT(fact_sales[customerid]), 0), 0)"),
                ("SafeQtyPerOrder", "DIVIDE(SUM(fact_sales[orderqty]), NULLIF(COUNT(fact_sales[salesorderdetailid]), 0), 0)"),
                ("SafeRevPerProduct", "DIVIDE(SUM(fact_sales[linetotal]), NULLIF(DISTINCTCOUNT(fact_sales[productid]), 0), 0)"),
                ("SafeHighPct", "DIVIDE(COUNT_IF(fact_sales[unitprice] > 100), NULLIF(COUNT(fact_sales[salesorderdetailid]), 0), 0)"),
                ("Revenue", "SUM(fact_sales[linetotal])"),
            ],
            group_by: vec![("dim_product", "categoryname"), ("dim_territory", "countryregioncode")],
            description: "NULLIF in 5 measures — maximum defensive division",
        },
        // --- CLEAREXCEPT + CLEAR + KEEP all in same query ---
        TestQuery {
            name: "Q180: Triple context scope (6 measures, 2 dims)",
            measures: vec![
                ("Revenue", "SUM(fact_sales[linetotal])"),
                ("CatTotal", "SUM(fact_sales[linetotal], CLEAREXCEPT(dim_product, dim_product[categoryname]))"),
                ("GrandTotal", "SUM(fact_sales[linetotal], CLEAR(dim_product))"),
                ("PctOfCat", "DIVIDE(SUM(fact_sales[linetotal]), SUM(fact_sales[linetotal], CLEAREXCEPT(dim_product, dim_product[categoryname])), 0)"),
                ("PctOfGrand", "DIVIDE(SUM(fact_sales[linetotal]), SUM(fact_sales[linetotal], CLEAR(dim_product)), 0)"),
                ("BikeRev", r#"SUM(fact_sales[linetotal], KEEP(dim_product, dim_product[categoryname] = "Bikes"))"#),
            ],
            group_by: vec![("dim_product", "categoryname"), ("dim_product", "subcategoryname")],
            description: "CLEAREXCEPT + CLEAR + KEEP — all three context scopes",
        },
        // --- ISINSCOPE 3-level adaptive ---
        TestQuery {
            name: "Q181: ISINSCOPE 3-level (4 measures, 3 dims)",
            measures: vec![
                ("Revenue", "SUM(fact_sales[linetotal])"),
                ("AdaptiveTotal", r#"IF(ISINSCOPE(dim_product[subcategoryname]), SUM(fact_sales[linetotal], CLEAREXCEPT(dim_product, dim_product[categoryname])), IF(ISINSCOPE(dim_product[categoryname]), SUM(fact_sales[linetotal], CLEAR(dim_product)), SUM(fact_sales[linetotal])))"#),
                ("AdaptiveAvg", "IF(ISINSCOPE(dim_product[subcategoryname]), AVG(fact_sales[unitprice]), DIVIDE(SUM(fact_sales[linetotal]), NULLIF(COUNT(fact_sales[salesorderdetailid]), 0), 0))"),
                ("MedianPrice", "MEDIAN(fact_sales[unitprice])"),
            ],
            group_by: vec![("dim_product", "categoryname"), ("dim_product", "subcategoryname"), ("dim_territory", "countryregioncode")],
            description: "ISINSCOPE nested 3-level — adaptive hierarchy with label",
        },
        // --- ITERATE + IF + comparison operators ---
        TestQuery {
            name: "Q182: ITERATE conditional bands (5 measures)",
            measures: vec![
                ("LowBand", "SUM(ITERATE(fact_sales, IF(fact_sales[unitprice] < 50, fact_sales[linetotal], 0)))"),
                ("MidBand", "SUM(ITERATE(fact_sales, IF(fact_sales[unitprice] >= 50 AND fact_sales[unitprice] < 200, fact_sales[linetotal], 0)))"),
                ("HighBand", "SUM(ITERATE(fact_sales, IF(fact_sales[unitprice] >= 200, fact_sales[linetotal], 0)))"),
                ("LowPct", "DIVIDE(SUM(ITERATE(fact_sales, IF(fact_sales[unitprice] < 50, fact_sales[linetotal], 0))), NULLIF(SUM(fact_sales[linetotal]), 0), 0)"),
                ("Revenue", "SUM(fact_sales[linetotal])"),
            ],
            group_by: vec![("dim_territory", "countryregioncode")],
            description: "ITERATE with IF banding — revenue by price tier",
        },
        // --- QUERY + WINDOW + OFFSET in one query ---
        TestQuery {
            name: "Q183: QUERY + WINDOW + OFFSET combo (5 measures)",
            measures: vec![
                ("Revenue", "SUM(fact_sales[linetotal])"),
                ("AvgMonthly", "VAR mqa = QUERY(SUM(fact_sales[linetotal]) AS rev BY dim_date[year], dim_date[month]) RETURN AVG(mqa[rev])"),
                ("PrevMonth", "OFFSET(SUM(fact_sales[linetotal]), -1, ORDERBY(dim_date[yearmonth]))"),
                ("RunningTotal", "WINDOW(SUM(fact_sales[linetotal]), SUM, ORDERBY(dim_date[yearmonth]))"),
                ("HighValPct", "DIVIDE(COUNT_IF(fact_sales[unitprice] > 100), NULLIF(COUNT(fact_sales[salesorderdetailid]), 0), 0)"),
            ],
            group_by: vec![("dim_date", "yearmonth")],
            description: "QUERY + WINDOW + OFFSET — three evaluation strategies in time-series",
        },
        // --- Multi-KEEP with COUNT_IF + ITERATE + PERCENTILE ---
        TestQuery {
            name: "Q184: KEEP + COUNT_IF + ITERATE mix (5 measures, 2 dims)",
            measures: vec![
                ("Revenue", "SUM(fact_sales[linetotal])"),
                ("BikeHighVal", r#"COUNT_IF(fact_sales[unitprice] > 100, KEEP(dim_product, dim_product[categoryname] = "Bikes"))"#),
                ("ClothingIterRev", r#"SUM(ITERATE(fact_sales, fact_sales[unitprice] * fact_sales[orderqty]), KEEP(dim_product, dim_product[categoryname] = "Clothing"))"#),
                ("BikeP50", r#"MEDIAN(fact_sales[unitprice], KEEP(dim_product, dim_product[categoryname] = "Bikes"))"#),
                ("AllP50", "MEDIAN(fact_sales[unitprice])"),
            ],
            group_by: vec![("dim_territory", "countryregioncode"), ("dim_date", "year")],
            description: "KEEP + COUNT_IF + ITERATE + MEDIAN — deep KEEP mixing",
        },
        // --- VAR + QUERY + KEEP ---
        TestQuery {
            name: "Q185: QUERY with KEEP (3 measures)",
            measures: vec![
                ("AvgMonthlyBikeRev", r#"VAR mqb = QUERY(SUM(fact_sales[linetotal], KEEP(dim_product, dim_product[categoryname] = "Bikes")) AS bike_rev BY dim_date[year], dim_date[month]) RETURN AVG(mqb[bike_rev])"#),
                ("BikeRev", r#"SUM(fact_sales[linetotal], KEEP(dim_product, dim_product[categoryname] = "Bikes"))"#),
                ("Revenue", "SUM(fact_sales[linetotal])"),
            ],
            group_by: vec![("dim_territory", "countryregioncode")],
            description: "QUERY + KEEP inside — two-stage filtered aggregation",
        },
        // --- Edge: single-table complex with ITERATE + COUNT_IF + VAR ---
        TestQuery {
            name: "Q186: Single-table complex (5 measures, no JOIN)",
            measures: vec![
                ("Revenue", "SUM(fact_sales[linetotal])"),
                ("IterRev", "SUM(ITERATE(fact_sales, fact_sales[unitprice] * fact_sales[orderqty]))"),
                ("HighValPct", "DIVIDE(COUNT_IF(fact_sales[unitprice] > 100), NULLIF(COUNT(fact_sales[salesorderdetailid]), 0), 0)"),
                ("Score", "VAR rev = SUM(fact_sales[linetotal]) VAR avg_p = DIVIDE(rev, NULLIF(COUNT(fact_sales[salesorderdetailid]), 0), 0) RETURN ROUND(SQRT(GREATEST(avg_p, 0)), 2)"),
                ("MedianPrice", "MEDIAN(fact_sales[unitprice])"),
            ],
            group_by: vec![],
            description: "Single-table grand total: ITERATE + COUNT_IF + VAR + SQRT + MEDIAN",
        },
        // --- Edge: single dim with many measures ---
        TestQuery {
            name: "Q187: Territory deep analysis (8 measures, 1 dim)",
            measures: vec![
                ("Revenue", "SUM(fact_sales[linetotal])"),
                ("Orders", "COUNT(fact_sales[salesorderdetailid])"),
                ("AvgOrder", "DIVIDE(SUM(fact_sales[linetotal]), NULLIF(COUNT(fact_sales[salesorderdetailid]), 0), 0)"),
                ("Customers", "DISTINCTCOUNT(fact_sales[customerid])"),
                ("RevPerCust", "DIVIDE(SUM(fact_sales[linetotal]), NULLIF(DISTINCTCOUNT(fact_sales[customerid]), 0), 0)"),
                ("MedianPrice", "MEDIAN(fact_sales[unitprice])"),
                ("HighPct", "DIVIDE(COUNT_IF(fact_sales[unitprice] > 100), NULLIF(COUNT(fact_sales[salesorderdetailid]), 0), 0)"),
                ("Stdev", "STDEV(fact_sales[unitprice])"),
            ],
            group_by: vec![("dim_territory", "territoryname")],
            description: "8 measures by territory — one dim with full analysis",
        },
        // --- Purchasing + KEEP (dim_product filter) ---
        TestQuery {
            name: "Q188: Purchasing with product KEEP (3 measures)",
            measures: vec![
                ("AllPurchQty", "SUM(fact_purchasing[receivedqty])"),
                ("BikePurchQty", r#"SUM(fact_purchasing[receivedqty], KEEP(dim_product, dim_product[categoryname] = "Bikes"))"#),
                ("BikePurchPct", r#"DIVIDE(SUM(fact_purchasing[receivedqty], KEEP(dim_product, dim_product[categoryname] = "Bikes")), NULLIF(SUM(fact_purchasing[receivedqty]), 0), 0)"#),
            ],
            group_by: vec![("dim_date", "year")],
            description: "Purchasing fact + KEEP on dim_product — cross-fact KEEP",
        },
        // --- PI + POWER + SQRT geometric ---
        TestQuery {
            name: "Q189: Geometric math (3 measures)",
            measures: vec![
                ("Revenue", "SUM(fact_sales[linetotal])"),
                ("GeoMeanPrice", "EXP(AVG(ITERATE(fact_sales, LN(GREATEST(fact_sales[unitprice], 0.01)))))"),
                ("ScaledRev", "ROUND(SUM(fact_sales[linetotal]) * PI() / 1000000, 2)"),
            ],
            group_by: vec![("dim_product", "categoryname")],
            description: "EXP + LN + PI + ROUND — geometric mean and scaling",
        },
        // --- ITERATE + DIVIDE per-row + NULLIF ---
        TestQuery {
            name: "Q190: ITERATE safe per-row ratios (4 measures)",
            measures: vec![
                ("AvgUnitPrice", "AVG(ITERATE(fact_sales, DIVIDE(fact_sales[linetotal], NULLIF(fact_sales[orderqty], 0), 0)))"),
                ("MaxUnitPrice", "MAX(ITERATE(fact_sales, DIVIDE(fact_sales[linetotal], NULLIF(fact_sales[orderqty], 0), 0)))"),
                ("MinUnitPrice", "MIN(ITERATE(fact_sales, DIVIDE(fact_sales[linetotal], NULLIF(fact_sales[orderqty], 0), 0)))"),
                ("MedianUnit", "MEDIAN(fact_sales[unitprice])"),
            ],
            group_by: vec![("dim_product", "subcategoryname")],
            description: "ITERATE + DIVIDE + NULLIF per-row — AVG/MAX/MIN of safe ratios",
        },
        // --- CLEAREXCEPT + KEEP + ITERATE + COUNT_IF mega ---
        TestQuery {
            name: "Q191: Context + ITERATE + COUNT_IF mega (6 measures, 2 dims)",
            measures: vec![
                ("Revenue", "SUM(fact_sales[linetotal])"),
                ("CatTotal", "SUM(fact_sales[linetotal], CLEAREXCEPT(dim_product, dim_product[categoryname]))"),
                ("PctOfCat", "DIVIDE(SUM(fact_sales[linetotal]), SUM(fact_sales[linetotal], CLEAREXCEPT(dim_product, dim_product[categoryname])), 0)"),
                ("BikeShare", r#"DIVIDE(SUM(fact_sales[linetotal], KEEP(dim_product, dim_product[categoryname] = "Bikes")), NULLIF(SUM(fact_sales[linetotal]), 0), 0)"#),
                ("HighValPct", "DIVIDE(COUNT_IF(fact_sales[unitprice] > 100), NULLIF(COUNT(fact_sales[salesorderdetailid]), 0), 0)"),
                ("IterAvg", "AVG(ITERATE(fact_sales, GREATEST(fact_sales[unitprice] * fact_sales[orderqty], 0)))"),
            ],
            group_by: vec![("dim_product", "categoryname"), ("dim_product", "subcategoryname")],
            description: "CLEAREXCEPT + KEEP + ITERATE + COUNT_IF + NULLIF + GREATEST",
        },
        // --- PERCENTILE quartet ---
        TestQuery {
            name: "Q192: Percentile quartet (5 measures)",
            measures: vec![
                ("P10", "PERCENTILE(fact_sales[unitprice], 0.1)"),
                ("P25", "PERCENTILE(fact_sales[unitprice], 0.25)"),
                ("P50", "PERCENTILE(fact_sales[unitprice], 0.5)"),
                ("P75", "PERCENTILE(fact_sales[unitprice], 0.75)"),
                ("P90", "PERCENTILE(fact_sales[unitprice], 0.9)"),
            ],
            group_by: vec![("dim_product", "categoryname"), ("dim_territory", "countryregioncode")],
            description: "5 percentiles in one query — P10/P25/P50/P75/P90",
        },
        // --- WINDOW partitioned by two dims ---
        TestQuery {
            name: "Q193: WINDOW partitioned running (3 measures, 2 dims)",
            measures: vec![
                ("Revenue", "SUM(fact_sales[linetotal])"),
                ("RunByCat", "WINDOW(SUM(fact_sales[linetotal]), SUM, ORDERBY(dim_date[yearmonth]), PARTITIONBY(dim_product[categoryname]))"),
                ("MovAvg", "WINDOW(SUM(fact_sales[linetotal]), AVG, ORDERBY(dim_date[yearmonth]), PARTITIONBY(dim_product[categoryname]), ROWS(-2, REL, 0, REL))"),
            ],
            group_by: vec![("dim_product", "categoryname"), ("dim_date", "yearmonth")],
            description: "WINDOW partitioned + moving average by category",
        },
        // --- VAR 8-binding ---
        TestQuery {
            name: "Q194: VAR 8-binding complex (2 measures)",
            measures: vec![
                ("ComprehensiveScore", r#"VAR rev = SUM(fact_sales[linetotal]) VAR qty = SUM(fact_sales[orderqty]) VAR orders = COUNT(fact_sales[salesorderdetailid]) VAR custs = DISTINCTCOUNT(fact_sales[customerid]) VAR avg_price = DIVIDE(rev, NULLIF(qty, 0), 0) VAR avg_order = DIVIDE(rev, NULLIF(orders, 0), 0) VAR rev_per_cust = DIVIDE(rev, NULLIF(custs, 0), 0) VAR composite = SQRT(GREATEST(avg_price * avg_order, 0)) RETURN ROUND(DIVIDE(composite, NULLIF(rev_per_cust, 0), 0), 4)"#),
                ("Revenue", "SUM(fact_sales[linetotal])"),
            ],
            group_by: vec![("dim_product", "categoryname"), ("dim_territory", "countryregioncode")],
            description: "VAR with 8 bindings — NULLIF + SQRT + GREATEST + ROUND + DIVIDE",
        },
        // --- OFFSET multi-delta + INDEX ---
        TestQuery {
            name: "Q195: OFFSET + INDEX full (4 measures)",
            measures: vec![
                ("Revenue", "SUM(fact_sales[linetotal])"),
                ("Prev1", "OFFSET(SUM(fact_sales[linetotal]), -1, ORDERBY(dim_date[yearmonth]))"),
                ("Prev3", "OFFSET(SUM(fact_sales[linetotal]), -3, ORDERBY(dim_date[yearmonth]))"),
                ("FirstMonth", "INDEX(SUM(fact_sales[linetotal]), 1, ORDERBY(dim_date[yearmonth]))"),
            ],
            group_by: vec![("dim_date", "yearmonth")],
            description: "OFFSET -1 and -3 + INDEX first month — period lookups",
        },
        // --- QUERY over ITERATE + KEEP ---
        TestQuery {
            name: "Q196: QUERY over ITERATE + KEEP (2 measures)",
            measures: vec![
                ("AvgMonthlyIterBikeRev", r#"VAR mqc = QUERY(SUM(ITERATE(fact_sales, fact_sales[unitprice] * fact_sales[orderqty]), KEEP(dim_product, dim_product[categoryname] = "Bikes")) AS iter_bike BY dim_date[year], dim_date[month]) RETURN AVG(mqc[iter_bike])"#),
                ("Revenue", "SUM(fact_sales[linetotal])"),
            ],
            group_by: vec![("dim_territory", "countryregioncode")],
            description: "QUERY over ITERATE + KEEP — triple nesting two-stage",
        },
        // --- GREATEST + LEAST + IF + NULLIF + COUNT_IF combo ---
        TestQuery {
            name: "Q197: Decision logic combo (4 measures)",
            measures: vec![
                ("Revenue", "SUM(fact_sales[linetotal])"),
                ("BoundedAvg", "GREATEST(LEAST(DIVIDE(SUM(fact_sales[linetotal]), NULLIF(COUNT(fact_sales[salesorderdetailid]), 0), 0), 10000), 1)"),
                ("TierScore", "IF(COUNT_IF(fact_sales[unitprice] > 100) > 50, GREATEST(AVG(fact_sales[unitprice]), 100), LEAST(AVG(fact_sales[unitprice]), 100))"),
                ("SafeLogRev", "IFERROR(LN(GREATEST(SUM(fact_sales[linetotal]), 1)), 0)"),
            ],
            group_by: vec![("dim_product", "categoryname"), ("dim_territory", "countryregioncode")],
            description: "GREATEST + LEAST + IF + COUNT_IF + NULLIF + LN + IFERROR",
        },
        // --- Multi-KEEP multi-territory multi-category ---
        TestQuery {
            name: "Q198: Multi-segment analysis (6 measures, 2 dims)",
            measures: vec![
                ("Revenue", "SUM(fact_sales[linetotal])"),
                ("BikeRev", r#"SUM(fact_sales[linetotal], KEEP(dim_product, dim_product[categoryname] = "Bikes"))"#),
                ("ClothingRev", r#"SUM(fact_sales[linetotal], KEEP(dim_product, dim_product[categoryname] = "Clothing"))"#),
                ("CompRev", r#"SUM(fact_sales[linetotal], KEEP(dim_product, dim_product[categoryname] = "Components"))"#),
                ("AccRev", r#"SUM(fact_sales[linetotal], KEEP(dim_product, dim_product[categoryname] = "Accessories"))"#),
                ("BikeHighValPct", r#"DIVIDE(COUNT_IF(fact_sales[unitprice] > 100, KEEP(dim_product, dim_product[categoryname] = "Bikes")), NULLIF(COUNT(fact_sales[salesorderdetailid], KEEP(dim_product, dim_product[categoryname] = "Bikes")), 0), 0)"#),
            ],
            group_by: vec![("dim_territory", "countryregioncode"), ("dim_date", "year")],
            description: "4-category KEEP + COUNT_IF+KEEP — multi-segment revenue analysis",
        },
        // --- Grand totals with ITERATE + COUNT_IF + PERCENTILE + VAR ---
        TestQuery {
            name: "Q199: Grand total deep (8 measures, no group)",
            measures: vec![
                ("Revenue", "SUM(fact_sales[linetotal])"),
                ("IterRev", "SUM(ITERATE(fact_sales, fact_sales[unitprice] * fact_sales[orderqty]))"),
                ("MedianPrice", "MEDIAN(fact_sales[unitprice])"),
                ("P90Price", "PERCENTILE(fact_sales[unitprice], 0.9)"),
                ("HighValPct", "DIVIDE(COUNT_IF(fact_sales[unitprice] > 100), NULLIF(COUNT(fact_sales[salesorderdetailid]), 0), 0)"),
                ("StdevPrice", "STDEV(fact_sales[unitprice])"),
                ("ClampedCV", "GREATEST(DIVIDE(STDEV(fact_sales[unitprice]), NULLIF(AVG(fact_sales[unitprice]), 0), 0), 0)"),
                ("RowCount", "COUNTROWS(fact_sales)"),
            ],
            group_by: vec![],
            description: "Grand total: 8 measures — ITERATE + MEDIAN + PERCENTILE + COUNT_IF + STDEV + COUNTROWS",
        },
        // --- THE ABSOLUTE FINAL: 12 measures, 3 dims, every feature ---
        TestQuery {
            name: "Q200: THE FINAL (12 measures, 3 dims)",
            measures: vec![
                ("Revenue", "SUM(fact_sales[linetotal])"),
                ("IterRev", "SUM(ITERATE(fact_sales, GREATEST(fact_sales[unitprice] * fact_sales[orderqty], 0)))"),
                ("BikeShare", r#"DIVIDE(SUM(fact_sales[linetotal], KEEP(dim_product, dim_product[categoryname] = "Bikes")), NULLIF(SUM(fact_sales[linetotal]), 0), 0)"#),
                ("CatTotal", "SUM(fact_sales[linetotal], CLEAREXCEPT(dim_product, dim_product[categoryname]))"),
                ("PctOfCat", "DIVIDE(SUM(fact_sales[linetotal]), SUM(fact_sales[linetotal], CLEAREXCEPT(dim_product, dim_product[categoryname])), 0)"),
                ("MedianPrice", "MEDIAN(fact_sales[unitprice])"),
                ("HighValPct", "DIVIDE(COUNT_IF(fact_sales[unitprice] > 100), NULLIF(COUNT(fact_sales[salesorderdetailid]), 0), 0)"),
                ("ClampedStdev", "GREATEST(LEAST(STDEV(fact_sales[unitprice]), AVG(fact_sales[unitprice])), 0)"),
                ("SafeScore", "VAR rev = SUM(fact_sales[linetotal]) VAR qty = SUM(fact_sales[orderqty]) RETURN IFERROR(ROUND(LN(GREATEST(DIVIDE(rev, NULLIF(qty, 0), 0), 1)), 4), 0)"),
                ("Orders", "COUNT(fact_sales[salesorderdetailid])"),
                ("RowCount", "COUNTROWS(fact_sales)"),
                ("P90Price", "PERCENTILE(fact_sales[unitprice], 0.9)"),
            ],
            group_by: vec![("dim_product", "categoryname"), ("dim_product", "subcategoryname"), ("dim_territory", "countryregioncode")],
            description: "THE FINAL: 12 measures, 3 dims — SUM, ITERATE, KEEP, CLEAREXCEPT, MEDIAN, COUNT_IF, NULLIF, GREATEST, LEAST, STDEV, VAR, IFERROR, LN, ROUND, PERCENTILE, COUNTROWS",
        },
        // =====================================================================
        // Level 201-240: Safety edge cases, rare combos, correctness stress
        // =====================================================================
        // --- dim_customer dimension (barely tested) ---
        TestQuery {
            name: "Q201: Customer dimension analysis (6 measures)",
            measures: vec![
                ("Revenue", "SUM(fact_sales[linetotal])"),
                ("Orders", "COUNT(fact_sales[salesorderdetailid])"),
                ("AvgOrder", "DIVIDE(SUM(fact_sales[linetotal]), NULLIF(COUNT(fact_sales[salesorderdetailid]), 0), 0)"),
                ("UniqueProducts", "DISTINCTCOUNT(fact_sales[productid])"),
                ("HighValPct", "DIVIDE(COUNT_IF(fact_sales[unitprice] > 100), NULLIF(COUNT(fact_sales[salesorderdetailid]), 0), 0)"),
                ("MedianPrice", "MEDIAN(fact_sales[unitprice])"),
            ],
            group_by: vec![("dim_customer", "country")],
            description: "dim_customer grouping by country — underused dimension",
        },
        TestQuery {
            name: "Q202: Customer + product cross-dim (4 measures, 2 dims)",
            measures: vec![
                ("Revenue", "SUM(fact_sales[linetotal])"),
                ("Customers", "DISTINCTCOUNT(fact_sales[customerid])"),
                ("RevPerCust", "DIVIDE(SUM(fact_sales[linetotal]), NULLIF(DISTINCTCOUNT(fact_sales[customerid]), 0), 0)"),
                ("AvgPrice", "AVG(fact_sales[unitprice])"),
            ],
            group_by: vec![("dim_customer", "country"), ("dim_product", "categoryname")],
            description: "Customer country + product category — cross-dim analysis",
        },
        TestQuery {
            name: "Q203: Customer + territory + date 3-dim (4 measures, 3 dims)",
            measures: vec![
                ("Revenue", "SUM(fact_sales[linetotal])"),
                ("Orders", "COUNT(fact_sales[salesorderdetailid])"),
                ("AvgOrder", "DIVIDE(SUM(fact_sales[linetotal]), NULLIF(COUNT(fact_sales[salesorderdetailid]), 0), 0)"),
                ("Customers", "DISTINCTCOUNT(fact_sales[customerid])"),
            ],
            group_by: vec![("dim_customer", "country"), ("dim_territory", "countryregioncode"), ("dim_date", "year")],
            description: "Customer + territory + date — 3-dim with customer",
        },
        // --- KEEP on dim_customer ---
        TestQuery {
            name: "Q204: KEEP on dim_customer (4 measures)",
            measures: vec![
                ("Revenue", "SUM(fact_sales[linetotal])"),
                ("USRevenue", r#"SUM(fact_sales[linetotal], KEEP(dim_customer, dim_customer[country] = "United States"))"#),
                ("USPct", r#"DIVIDE(SUM(fact_sales[linetotal], KEEP(dim_customer, dim_customer[country] = "United States")), NULLIF(SUM(fact_sales[linetotal]), 0), 0)"#),
                ("USOrders", r#"COUNT(fact_sales[salesorderdetailid], KEEP(dim_customer, dim_customer[country] = "United States"))"#),
            ],
            group_by: vec![("dim_product", "categoryname")],
            description: "KEEP on dim_customer — filter by customer country",
        },
        // --- CLEAR on dim_date ---
        TestQuery {
            name: "Q205: CLEAR dim_date (4 measures, 2 dims)",
            measures: vec![
                ("Revenue", "SUM(fact_sales[linetotal])"),
                ("AllTimeRev", "SUM(fact_sales[linetotal], CLEAR(dim_date))"),
                ("PctOfAllTime", "DIVIDE(SUM(fact_sales[linetotal]), SUM(fact_sales[linetotal], CLEAR(dim_date)), 0)"),
                ("Orders", "COUNT(fact_sales[salesorderdetailid])"),
            ],
            group_by: vec![("dim_product", "categoryname"), ("dim_date", "year")],
            description: "CLEAR dim_date — year-independent total for pct calculation",
        },
        // --- CLEAREXCEPT on dim_date keeping year ---
        TestQuery {
            name: "Q206: CLEAREXCEPT dim_date keep year (5 measures, 3 dims)",
            measures: vec![
                ("Revenue", "SUM(fact_sales[linetotal])"),
                ("YearTotal", "SUM(fact_sales[linetotal], CLEAREXCEPT(dim_date, dim_date[year]))"),
                ("PctOfYear", "DIVIDE(SUM(fact_sales[linetotal]), SUM(fact_sales[linetotal], CLEAREXCEPT(dim_date, dim_date[year])), 0)"),
                ("MedianPrice", "MEDIAN(fact_sales[unitprice])"),
                ("HighValCount", "COUNT_IF(fact_sales[unitprice] > 100)"),
            ],
            group_by: vec![("dim_product", "categoryname"), ("dim_date", "year"), ("dim_date", "quarter")],
            description: "CLEAREXCEPT on dim_date keeping year, clearing quarter — quarter-within-year pct",
        },
        // --- Triple-KEEP: product + territory + customer ---
        TestQuery {
            name: "Q207: Triple-KEEP (3 measures)",
            measures: vec![
                ("Revenue", "SUM(fact_sales[linetotal])"),
                ("USBikeUSCust", r#"SUM(fact_sales[linetotal], KEEP(dim_product, dim_product[categoryname] = "Bikes"), KEEP(dim_territory, dim_territory[countryregioncode] = "US"), KEEP(dim_customer, dim_customer[country] = "United States"))"#),
                ("TripleFilterPct", r#"DIVIDE(SUM(fact_sales[linetotal], KEEP(dim_product, dim_product[categoryname] = "Bikes"), KEEP(dim_territory, dim_territory[countryregioncode] = "US"), KEEP(dim_customer, dim_customer[country] = "United States")), NULLIF(SUM(fact_sales[linetotal]), 0), 0)"#),
            ],
            group_by: vec![("dim_date", "year")],
            description: "Triple-KEEP: product+territory+customer — 3-dim filter narrowing",
        },
        // --- CLEAR on dim_customer ---
        TestQuery {
            name: "Q208: CLEAR dim_customer (3 measures, 2 dims)",
            measures: vec![
                ("Revenue", "SUM(fact_sales[linetotal])"),
                ("AllCustRev", "SUM(fact_sales[linetotal], CLEAR(dim_customer))"),
                ("CustPct", "DIVIDE(SUM(fact_sales[linetotal]), SUM(fact_sales[linetotal], CLEAR(dim_customer)), 0)"),
            ],
            group_by: vec![("dim_customer", "country"), ("dim_product", "categoryname")],
            description: "CLEAR dim_customer — customer-independent total",
        },
        // --- CLEAREXCEPT on multiple tables ---
        TestQuery {
            name: "Q209: Multi-table CLEAREXCEPT (4 measures, 3 dims)",
            measures: vec![
                ("Revenue", "SUM(fact_sales[linetotal])"),
                ("CatTotal", "SUM(fact_sales[linetotal], CLEAREXCEPT(dim_product, dim_product[categoryname]))"),
                ("YearTotal", "SUM(fact_sales[linetotal], CLEAREXCEPT(dim_date, dim_date[year]))"),
                ("PctOfCat", "DIVIDE(SUM(fact_sales[linetotal]), SUM(fact_sales[linetotal], CLEAREXCEPT(dim_product, dim_product[categoryname])), 0)"),
            ],
            group_by: vec![("dim_product", "categoryname"), ("dim_product", "subcategoryname"), ("dim_date", "year")],
            description: "CLEAREXCEPT on dim_product AND dim_date — dual hierarchy pct",
        },
        // --- KEEP + CLEAR in same measure ---
        TestQuery {
            name: "Q210: KEEP+CLEAR same measure (3 measures, 2 dims)",
            measures: vec![
                ("Revenue", "SUM(fact_sales[linetotal])"),
                ("BikeAllTime", r#"SUM(fact_sales[linetotal], KEEP(dim_product, dim_product[categoryname] = "Bikes"), CLEAR(dim_date))"#),
                ("BikeAllTimePct", r#"DIVIDE(SUM(fact_sales[linetotal], KEEP(dim_product, dim_product[categoryname] = "Bikes"), CLEAR(dim_date)), NULLIF(SUM(fact_sales[linetotal], CLEAR(dim_date)), 0), 0)"#),
            ],
            group_by: vec![("dim_product", "categoryname"), ("dim_date", "year")],
            description: "KEEP + CLEAR in same measure — filter product, clear time",
        },
        // --- OFFSET + KEEP combo ---
        TestQuery {
            name: "Q211: OFFSET + KEEP time-series (3 measures)",
            measures: vec![
                ("Revenue", "SUM(fact_sales[linetotal])"),
                ("PrevMonthBikeRev", r#"OFFSET(SUM(fact_sales[linetotal], KEEP(dim_product, dim_product[categoryname] = "Bikes")), -1, ORDERBY(dim_date[yearmonth]))"#),
                ("BikeRev", r#"SUM(fact_sales[linetotal], KEEP(dim_product, dim_product[categoryname] = "Bikes"))"#),
            ],
            group_by: vec![("dim_date", "yearmonth")],
            description: "OFFSET with KEEP inside — previous month's bike revenue",
        },
        // --- WINDOW + KEEP ---
        TestQuery {
            name: "Q212: WINDOW + KEEP running (3 measures)",
            measures: vec![
                ("Revenue", "SUM(fact_sales[linetotal])"),
                ("BikeRunning", r#"WINDOW(SUM(fact_sales[linetotal], KEEP(dim_product, dim_product[categoryname] = "Bikes")), SUM, ORDERBY(dim_date[yearmonth]))"#),
                ("BikeRev", r#"SUM(fact_sales[linetotal], KEEP(dim_product, dim_product[categoryname] = "Bikes"))"#),
            ],
            group_by: vec![("dim_date", "yearmonth")],
            description: "WINDOW running total of KEEP-filtered revenue",
        },
        // --- Purchasing + dim_date + KEEP ---
        TestQuery {
            name: "Q213: Purchasing + date + KEEP (4 measures, 2 dims)",
            measures: vec![
                ("PurchQty", "SUM(fact_purchasing[receivedqty])"),
                ("PurchCost", "SUM(ITERATE(fact_purchasing, fact_purchasing[receivedqty] * fact_purchasing[unitprice]))"),
                ("BikePurchQty", r#"SUM(fact_purchasing[receivedqty], KEEP(dim_product, dim_product[categoryname] = "Bikes"))"#),
                ("RejectRate", "DIVIDE(SUM(fact_purchasing[rejectedqty]), NULLIF(SUM(fact_purchasing[receivedqty]), 0), 0)"),
            ],
            group_by: vec![("dim_product", "categoryname"), ("dim_date", "year")],
            description: "Purchasing: ITERATE + KEEP + NULLIF by category and year",
        },
        // --- Extreme: many measures grand total ---
        TestQuery {
            name: "Q214: 14-measure grand total (no group-by)",
            measures: vec![
                ("Revenue", "SUM(fact_sales[linetotal])"),
                ("IterRev", "SUM(ITERATE(fact_sales, fact_sales[unitprice] * fact_sales[orderqty]))"),
                ("Orders", "COUNT(fact_sales[salesorderdetailid])"),
                ("Customers", "DISTINCTCOUNT(fact_sales[customerid])"),
                ("Products", "DISTINCTCOUNT(fact_sales[productid])"),
                ("MedianPrice", "MEDIAN(fact_sales[unitprice])"),
                ("P90Price", "PERCENTILE(fact_sales[unitprice], 0.9)"),
                ("StdevPrice", "STDEV(fact_sales[unitprice])"),
                ("HighValPct", "DIVIDE(COUNT_IF(fact_sales[unitprice] > 100), NULLIF(COUNT(fact_sales[salesorderdetailid]), 0), 0)"),
                ("AvgOrder", "DIVIDE(SUM(fact_sales[linetotal]), NULLIF(COUNT(fact_sales[salesorderdetailid]), 0), 0)"),
                ("RevPerCust", "DIVIDE(SUM(fact_sales[linetotal]), NULLIF(DISTINCTCOUNT(fact_sales[customerid]), 0), 0)"),
                ("ClampedCV", "GREATEST(DIVIDE(STDEV(fact_sales[unitprice]), NULLIF(AVG(fact_sales[unitprice]), 0), 0), 0)"),
                ("MaxLine", "MAX(fact_sales[linetotal])"),
                ("RowCount", "COUNTROWS(fact_sales)"),
            ],
            group_by: vec![],
            description: "14-measure grand total — every aggregate type, no grouping",
        },
        // --- Extreme: 4-dimension GROUP BY ---
        TestQuery {
            name: "Q215: 4-dimension GROUP BY (4 measures, 4 dims)",
            measures: vec![
                ("Revenue", "SUM(fact_sales[linetotal])"),
                ("Orders", "COUNT(fact_sales[salesorderdetailid])"),
                ("AvgPrice", "AVG(fact_sales[unitprice])"),
                ("Customers", "DISTINCTCOUNT(fact_sales[customerid])"),
            ],
            group_by: vec![("dim_product", "categoryname"), ("dim_territory", "countryregioncode"), ("dim_date", "year"), ("dim_customer", "country")],
            description: "4-dimension GROUP BY — product + territory + date + customer",
        },
        // --- Deep VAR with KEEP + COUNT_IF + PERCENTILE ---
        TestQuery {
            name: "Q216: VAR deep with everything (2 measures, 2 dims)",
            measures: vec![
                ("AnalysisScore", r#"VAR rev = SUM(fact_sales[linetotal]) VAR bike_rev = SUM(fact_sales[linetotal], KEEP(dim_product, dim_product[categoryname] = "Bikes")) VAR high_val = COUNT_IF(fact_sales[unitprice] > 100) VAR total = COUNT(fact_sales[salesorderdetailid]) VAR bike_share = DIVIDE(bike_rev, NULLIF(rev, 0), 0) VAR high_pct = DIVIDE(high_val, NULLIF(total, 0), 0) RETURN ROUND(GREATEST(bike_share * high_pct * 100, 0), 2)"#),
                ("Revenue", "SUM(fact_sales[linetotal])"),
            ],
            group_by: vec![("dim_territory", "countryregioncode"), ("dim_date", "year")],
            description: "VAR 6-binding: KEEP + COUNT_IF + NULLIF + GREATEST + ROUND",
        },
        // --- ITERATE with nested GREATEST + LEAST + IFERROR + DIVIDE ---
        TestQuery {
            name: "Q217: ITERATE deep nesting (3 measures)",
            measures: vec![
                ("SafeClampedIter", "SUM(ITERATE(fact_sales, GREATEST(LEAST(IFERROR(DIVIDE(fact_sales[linetotal], NULLIF(fact_sales[orderqty], 0), 0), 0), 10000), 0)))"),
                ("AvgSafeIter", "AVG(ITERATE(fact_sales, GREATEST(IFERROR(DIVIDE(fact_sales[linetotal], NULLIF(fact_sales[orderqty], 0), 0), 0), 0)))"),
                ("Revenue", "SUM(fact_sales[linetotal])"),
            ],
            group_by: vec![("dim_product", "categoryname"), ("dim_territory", "countryregioncode")],
            description: "ITERATE: GREATEST+LEAST+IFERROR+DIVIDE+NULLIF — deep per-row nesting",
        },
        // --- Multiple CLEAREXCEPT on different tables simultaneously ---
        TestQuery {
            name: "Q218: Dual CLEAREXCEPT (4 measures, 3 dims)",
            measures: vec![
                ("Revenue", "SUM(fact_sales[linetotal])"),
                ("CatTotal", "SUM(fact_sales[linetotal], CLEAREXCEPT(dim_product, dim_product[categoryname]))"),
                ("YearTotal", "SUM(fact_sales[linetotal], CLEAREXCEPT(dim_date, dim_date[year]))"),
                ("PctOfCatYear", "DIVIDE(SUM(fact_sales[linetotal]), GREATEST(SUM(fact_sales[linetotal], CLEAREXCEPT(dim_product, dim_product[categoryname])), 1), 0)"),
            ],
            group_by: vec![("dim_product", "categoryname"), ("dim_product", "subcategoryname"), ("dim_date", "year")],
            description: "Two different CLEAREXCEPT targets in same query",
        },
        // --- QUERY + OFFSET + plain mixed evaluation (5 measures) ---
        TestQuery {
            name: "Q219: Mixed evaluation paths (5 measures)",
            measures: vec![
                ("Revenue", "SUM(fact_sales[linetotal])"),
                ("AvgMonthly", "VAR mqx = QUERY(SUM(fact_sales[linetotal]) AS rev BY dim_date[year], dim_date[month]) RETURN AVG(mqx[rev])"),
                ("PrevMonth", "OFFSET(SUM(fact_sales[linetotal]), -1, ORDERBY(dim_date[yearmonth]))"),
                ("HighValPct", "DIVIDE(COUNT_IF(fact_sales[unitprice] > 100), NULLIF(COUNT(fact_sales[salesorderdetailid]), 0), 0)"),
                ("MedianPrice", "MEDIAN(fact_sales[unitprice])"),
            ],
            group_by: vec![("dim_date", "yearmonth")],
            description: "Plain + QUERY + OFFSET + COUNT_IF + MEDIAN — all paths mixed",
        },
        // --- KEEP 4 categories + total + ITERATE ---
        TestQuery {
            name: "Q220: 4-category KEEP + ITERATE (7 measures)",
            measures: vec![
                ("Revenue", "SUM(fact_sales[linetotal])"),
                ("BikeRev", r#"SUM(fact_sales[linetotal], KEEP(dim_product, dim_product[categoryname] = "Bikes"))"#),
                ("ClothingRev", r#"SUM(fact_sales[linetotal], KEEP(dim_product, dim_product[categoryname] = "Clothing"))"#),
                ("CompRev", r#"SUM(fact_sales[linetotal], KEEP(dim_product, dim_product[categoryname] = "Components"))"#),
                ("AccRev", r#"SUM(fact_sales[linetotal], KEEP(dim_product, dim_product[categoryname] = "Accessories"))"#),
                ("IterRev", "SUM(ITERATE(fact_sales, fact_sales[unitprice] * fact_sales[orderqty]))"),
                ("IterBikeRev", r#"SUM(ITERATE(fact_sales, fact_sales[unitprice] * fact_sales[orderqty]), KEEP(dim_product, dim_product[categoryname] = "Bikes"))"#),
            ],
            group_by: vec![("dim_territory", "countryregioncode")],
            description: "4-category KEEP + ITERATE + ITERATE+KEEP — segment analysis",
        },
        // --- ISINSCOPE with CLEAR + CLEAREXCEPT adaptive ---
        TestQuery {
            name: "Q221: ISINSCOPE full adaptive (4 measures, 2 dims)",
            measures: vec![
                ("Revenue", "SUM(fact_sales[linetotal])"),
                ("ParentScope", r#"IF(ISINSCOPE(dim_product[subcategoryname]), SUM(fact_sales[linetotal], CLEAREXCEPT(dim_product, dim_product[categoryname])), SUM(fact_sales[linetotal]))"#),
                ("PctOfScope", r#"DIVIDE(SUM(fact_sales[linetotal]), IF(ISINSCOPE(dim_product[subcategoryname]), SUM(fact_sales[linetotal], CLEAREXCEPT(dim_product, dim_product[categoryname])), SUM(fact_sales[linetotal])), 0)"#),
                ("HighValPct", "DIVIDE(COUNT_IF(fact_sales[unitprice] > 100), NULLIF(COUNT(fact_sales[salesorderdetailid]), 0), 0)"),
            ],
            group_by: vec![("dim_product", "categoryname"), ("dim_product", "subcategoryname")],
            description: "ISINSCOPE choosing CLEAREXCEPT vs plain — adaptive pct",
        },
        // --- PERCENTILE + KEEP comparison ---
        TestQuery {
            name: "Q222: PERCENTILE + KEEP by category (5 measures)",
            measures: vec![
                ("AllP50", "PERCENTILE(fact_sales[unitprice], 0.5)"),
                ("BikeP50", r#"PERCENTILE(fact_sales[unitprice], 0.5, KEEP(dim_product, dim_product[categoryname] = "Bikes"))"#),
                ("CompP50", r#"PERCENTILE(fact_sales[unitprice], 0.5, KEEP(dim_product, dim_product[categoryname] = "Components"))"#),
                ("AllIQR", "PERCENTILE(fact_sales[unitprice], 0.75) - PERCENTILE(fact_sales[unitprice], 0.25)"),
                ("Revenue", "SUM(fact_sales[linetotal])"),
            ],
            group_by: vec![("dim_territory", "countryregioncode")],
            description: "PERCENTILE with KEEP — category-specific distribution comparison",
        },
        // --- QUERY + COUNT_IF + KEEP two-stage ---
        TestQuery {
            name: "Q223: QUERY + COUNT_IF + KEEP (3 measures)",
            measures: vec![
                ("AvgMonthlyHighVal", "VAR mqy = QUERY(COUNT_IF(fact_sales[unitprice] > 100) AS hv BY dim_date[year], dim_date[month]) RETURN AVG(mqy[hv])"),
                ("AvgMonthlyBikeHighVal", r#"VAR mqz = QUERY(COUNT_IF(fact_sales[unitprice] > 100, KEEP(dim_product, dim_product[categoryname] = "Bikes")) AS bhv BY dim_date[year], dim_date[month]) RETURN AVG(mqz[bhv])"#),
                ("Revenue", "SUM(fact_sales[linetotal])"),
            ],
            group_by: vec![("dim_territory", "countryregioncode")],
            description: "QUERY with COUNT_IF + KEEP inside — two-stage conditional+filtered",
        },
        // --- Purchasing CLEAREXCEPT ---
        TestQuery {
            name: "Q224: Purchasing CLEAREXCEPT (3 measures, 2 dims)",
            measures: vec![
                ("PurchQty", "SUM(fact_purchasing[receivedqty])"),
                ("CatPurchQty", "SUM(fact_purchasing[receivedqty], CLEAREXCEPT(dim_product, dim_product[categoryname]))"),
                ("PctOfCat", "DIVIDE(SUM(fact_purchasing[receivedqty]), SUM(fact_purchasing[receivedqty], CLEAREXCEPT(dim_product, dim_product[categoryname])), 0)"),
            ],
            group_by: vec![("dim_product", "categoryname"), ("dim_product", "subcategoryname")],
            description: "Purchasing + CLEAREXCEPT — purchasing hierarchy pct",
        },
        // --- WINDOW moving avg + OFFSET + INDEX same query ---
        TestQuery {
            name: "Q225: Full window toolkit (5 measures)",
            measures: vec![
                ("Revenue", "SUM(fact_sales[linetotal])"),
                ("MovAvg3", "WINDOW(SUM(fact_sales[linetotal]), AVG, ORDERBY(dim_date[yearmonth]), ROWS(-2, REL, 0, REL))"),
                ("RunTotal", "WINDOW(SUM(fact_sales[linetotal]), SUM, ORDERBY(dim_date[yearmonth]))"),
                ("PrevMonth", "OFFSET(SUM(fact_sales[linetotal]), -1, ORDERBY(dim_date[yearmonth]))"),
                ("FirstMonth", "INDEX(SUM(fact_sales[linetotal]), 1, ORDERBY(dim_date[yearmonth]))"),
            ],
            group_by: vec![("dim_date", "yearmonth")],
            description: "WINDOW + OFFSET + INDEX — complete window function toolkit",
        },
        // --- COUNT_IF + KEEP + CLEAREXCEPT in same query ---
        TestQuery {
            name: "Q226: COUNT_IF + context ops (5 measures, 2 dims)",
            measures: vec![
                ("Revenue", "SUM(fact_sales[linetotal])"),
                ("HighValAll", "COUNT_IF(fact_sales[unitprice] > 100)"),
                ("HighValBikes", r#"COUNT_IF(fact_sales[unitprice] > 100, KEEP(dim_product, dim_product[categoryname] = "Bikes"))"#),
                ("CatHighVal", "COUNT_IF(fact_sales[unitprice] > 100)"),
                ("CatTotal", "SUM(fact_sales[linetotal], CLEAREXCEPT(dim_product, dim_product[categoryname]))"),
            ],
            group_by: vec![("dim_product", "categoryname"), ("dim_product", "subcategoryname")],
            description: "COUNT_IF + KEEP + CLEAREXCEPT in same query",
        },
        // --- ITERATE + PERCENTILE + STDEV mixed ---
        TestQuery {
            name: "Q227: ITERATE + statistical combo (4 measures)",
            measures: vec![
                ("IterAvgPrice", "AVG(ITERATE(fact_sales, DIVIDE(fact_sales[linetotal], NULLIF(fact_sales[orderqty], 0), 0)))"),
                ("MedianPrice", "MEDIAN(fact_sales[unitprice])"),
                ("StdevPrice", "STDEV(fact_sales[unitprice])"),
                ("P90Price", "PERCENTILE(fact_sales[unitprice], 0.9)"),
            ],
            group_by: vec![("dim_product", "subcategoryname")],
            description: "ITERATE computed avg vs MEDIAN vs STDEV vs P90 — distribution comparison",
        },
        // --- Extreme nesting: VAR + ITERATE + KEEP + IFERROR + GREATEST ---
        TestQuery {
            name: "Q228: Maximum VAR nesting (2 measures, 2 dims)",
            measures: vec![
                ("UltraScore", r#"VAR bike_iter = SUM(ITERATE(fact_sales, GREATEST(fact_sales[unitprice] * fact_sales[orderqty], 0)), KEEP(dim_product, dim_product[categoryname] = "Bikes")) VAR total_iter = SUM(ITERATE(fact_sales, GREATEST(fact_sales[unitprice] * fact_sales[orderqty], 0))) VAR ratio = IFERROR(DIVIDE(bike_iter, NULLIF(total_iter, 0), 0), 0) VAR high_pct = DIVIDE(COUNT_IF(fact_sales[unitprice] > 100), NULLIF(COUNT(fact_sales[salesorderdetailid]), 0), 0) RETURN ROUND(GREATEST(ratio * high_pct * 100, 0), 2)"#),
                ("Revenue", "SUM(fact_sales[linetotal])"),
            ],
            group_by: vec![("dim_territory", "countryregioncode"), ("dim_date", "year")],
            description: "VAR: ITERATE+KEEP + ITERATE + IFERROR + NULLIF + COUNT_IF + GREATEST + ROUND",
        },
        // --- All-dim CLEAR test ---
        TestQuery {
            name: "Q229: CLEAR every dimension (4 measures, 3 dims)",
            measures: vec![
                ("Revenue", "SUM(fact_sales[linetotal])"),
                ("ClearProduct", "SUM(fact_sales[linetotal], CLEAR(dim_product))"),
                ("ClearDate", "SUM(fact_sales[linetotal], CLEAR(dim_date))"),
                ("ClearTerritory", "SUM(fact_sales[linetotal], CLEAR(dim_territory))"),
            ],
            group_by: vec![("dim_product", "categoryname"), ("dim_territory", "countryregioncode"), ("dim_date", "year")],
            description: "CLEAR each dimension independently — 3 different totals",
        },
        // --- 4-dim with KEEP + COUNT_IF ---
        TestQuery {
            name: "Q230: 4-dim with KEEP (5 measures, 4 dims)",
            measures: vec![
                ("Revenue", "SUM(fact_sales[linetotal])"),
                ("BikeRev", r#"SUM(fact_sales[linetotal], KEEP(dim_product, dim_product[categoryname] = "Bikes"))"#),
                ("HighValPct", "DIVIDE(COUNT_IF(fact_sales[unitprice] > 100), NULLIF(COUNT(fact_sales[salesorderdetailid]), 0), 0)"),
                ("AvgOrder", "DIVIDE(SUM(fact_sales[linetotal]), NULLIF(COUNT(fact_sales[salesorderdetailid]), 0), 0)"),
                ("Customers", "DISTINCTCOUNT(fact_sales[customerid])"),
            ],
            group_by: vec![("dim_product", "categoryname"), ("dim_territory", "countryregioncode"), ("dim_date", "year"), ("dim_customer", "country")],
            description: "4-dim GROUP BY + KEEP + COUNT_IF — maximum dimensionality",
        },
        // --- Multiple QUERY in one query ---
        TestQuery {
            name: "Q231: Multiple QUERY measures (3 measures)",
            measures: vec![
                ("AvgMonthly", "VAR mq_a = QUERY(SUM(fact_sales[linetotal]) AS rev BY dim_date[year], dim_date[month]) RETURN AVG(mq_a[rev])"),
                ("MaxMonthly", "VAR mq_b = QUERY(SUM(fact_sales[linetotal]) AS rev BY dim_date[year], dim_date[month]) RETURN MAX(mq_b[rev])"),
                ("StdevMonthly", "VAR mq_c = QUERY(SUM(fact_sales[linetotal]) AS rev BY dim_date[year], dim_date[month]) RETURN STDEV(mq_c[rev])"),
            ],
            group_by: vec![("dim_product", "categoryname")],
            description: "Three QUERY measures: AVG + MAX + STDEV of monthly revenue",
        },
        // --- ITERATE + GREATEST + KEEP + CLEAR mixed ---
        TestQuery {
            name: "Q232: ITERATE + context ops mixed (5 measures, 2 dims)",
            measures: vec![
                ("Revenue", "SUM(fact_sales[linetotal])"),
                ("IterClampedBike", r#"SUM(ITERATE(fact_sales, GREATEST(LEAST(fact_sales[linetotal], 5000), 0)), KEEP(dim_product, dim_product[categoryname] = "Bikes"))"#),
                ("ClearProductRev", "SUM(fact_sales[linetotal], CLEAR(dim_product))"),
                ("CatPctIter", "DIVIDE(SUM(ITERATE(fact_sales, fact_sales[unitprice] * fact_sales[orderqty])), SUM(ITERATE(fact_sales, fact_sales[unitprice] * fact_sales[orderqty]), CLEAREXCEPT(dim_product, dim_product[categoryname])), 0)"),
                ("CountIfHigh", "COUNT_IF(fact_sales[unitprice] > 100)"),
            ],
            group_by: vec![("dim_product", "categoryname"), ("dim_product", "subcategoryname")],
            description: "ITERATE+KEEP + CLEAR + CLEAREXCEPT+ITERATE + COUNT_IF — full mixing",
        },
        // --- Purchasing + WINDOW ---
        TestQuery {
            name: "Q233: Purchasing time-series (3 measures)",
            measures: vec![
                ("PurchQty", "SUM(fact_purchasing[receivedqty])"),
                ("RunTotal", "WINDOW(SUM(fact_purchasing[receivedqty]), SUM, ORDERBY(dim_date[yearmonth]))"),
                ("PrevMonth", "OFFSET(SUM(fact_purchasing[receivedqty]), -1, ORDERBY(dim_date[yearmonth]))"),
            ],
            group_by: vec![("dim_date", "yearmonth")],
            description: "Purchasing fact with WINDOW + OFFSET — time-series on second fact",
        },
        // --- STDEV + VARIANCE + PERCENTILE + MEDIAN all together ---
        TestQuery {
            name: "Q234: Full distribution analysis (8 measures)",
            measures: vec![
                ("Mean", "AVG(fact_sales[unitprice])"),
                ("Median", "MEDIAN(fact_sales[unitprice])"),
                ("StdevSamp", "STDEV(fact_sales[unitprice])"),
                ("StdevPop", "STDEVP(fact_sales[unitprice])"),
                ("VarSamp", "VARIANCE(fact_sales[unitprice])"),
                ("P25", "PERCENTILE(fact_sales[unitprice], 0.25)"),
                ("P75", "PERCENTILE(fact_sales[unitprice], 0.75)"),
                ("IQR", "PERCENTILE(fact_sales[unitprice], 0.75) - PERCENTILE(fact_sales[unitprice], 0.25)"),
            ],
            group_by: vec![("dim_product", "categoryname")],
            description: "Complete distribution: MEAN + MEDIAN + STDEV + STDEVP + VARIANCE + PERCENTILE",
        },
        // --- COALESCE + NULLIF + IFERROR triple safety ---
        TestQuery {
            name: "Q235: Triple safety pattern (4 measures)",
            measures: vec![
                ("SafeAvg1", "COALESCE(DIVIDE(SUM(fact_sales[linetotal]), NULLIF(COUNT(fact_sales[salesorderdetailid]), 0), 0), 0)"),
                ("SafeAvg2", "IFERROR(DIVIDE(SUM(fact_sales[linetotal]), NULLIF(COUNT(fact_sales[salesorderdetailid]), 0), 0), 0)"),
                ("SafeAvg3", "GREATEST(COALESCE(DIVIDE(SUM(fact_sales[linetotal]), NULLIF(COUNT(fact_sales[salesorderdetailid]), 0), 0), 0), 0)"),
                ("Revenue", "SUM(fact_sales[linetotal])"),
            ],
            group_by: vec![("dim_product", "categoryname"), ("dim_territory", "countryregioncode")],
            description: "COALESCE+NULLIF+DIVIDE vs IFERROR+NULLIF vs GREATEST+COALESCE — safety patterns",
        },
        // --- Purchasing + sales side by side ---
        TestQuery {
            name: "Q236: Purchasing analysis by subcategory (4 measures, 2 dims)",
            measures: vec![
                ("PurchQty", "SUM(fact_purchasing[receivedqty])"),
                ("PurchCost", "SUM(ITERATE(fact_purchasing, fact_purchasing[receivedqty] * fact_purchasing[unitprice]))"),
                ("AvgPurchPrice", "DIVIDE(SUM(ITERATE(fact_purchasing, fact_purchasing[receivedqty] * fact_purchasing[unitprice])), NULLIF(SUM(fact_purchasing[receivedqty]), 0), 0)"),
                ("RejectPct", "DIVIDE(SUM(fact_purchasing[rejectedqty]), NULLIF(SUM(fact_purchasing[receivedqty]), 0), 0)"),
            ],
            group_by: vec![("dim_product", "categoryname"), ("dim_product", "subcategoryname")],
            description: "Purchasing deep: ITERATE + NULLIF + DIVIDE by subcategory",
        },
        // --- KEEP > comparison operator ---
        TestQuery {
            name: "Q237: KEEP with > comparison (3 measures)",
            measures: vec![
                ("Revenue", "SUM(fact_sales[linetotal])"),
                ("HighPriceRev", r#"SUM(fact_sales[linetotal], KEEP(dim_product, dim_product[listprice] > 1000))"#),
                ("HighPricePct", r#"DIVIDE(SUM(fact_sales[linetotal], KEEP(dim_product, dim_product[listprice] > 1000)), NULLIF(SUM(fact_sales[linetotal]), 0), 0)"#),
            ],
            group_by: vec![("dim_territory", "countryregioncode")],
            description: "KEEP with > operator — filter by price threshold",
        },
        // --- GREATEST + LEAST + NULLIF + COUNT_IF + MEDIAN + PERCENTILE ---
        TestQuery {
            name: "Q238: All comparison functions (6 measures, 2 dims)",
            measures: vec![
                ("Revenue", "SUM(fact_sales[linetotal])"),
                ("ClampedAvg", "GREATEST(LEAST(AVG(fact_sales[unitprice]), 5000), 1)"),
                ("SafeRatio", "DIVIDE(SUM(fact_sales[linetotal]), NULLIF(SUM(fact_sales[orderqty]), 0), 0)"),
                ("HighValPct", "DIVIDE(COUNT_IF(fact_sales[unitprice] > 100), NULLIF(COUNT(fact_sales[salesorderdetailid]), 0), 0)"),
                ("MedianPrice", "MEDIAN(fact_sales[unitprice])"),
                ("IQR", "GREATEST(PERCENTILE(fact_sales[unitprice], 0.75) - PERCENTILE(fact_sales[unitprice], 0.25), 0)"),
            ],
            group_by: vec![("dim_product", "categoryname"), ("dim_territory", "countryregioncode")],
            description: "GREATEST + LEAST + NULLIF + COUNT_IF + MEDIAN + PERCENTILE — all together",
        },
        // --- QUERY + WINDOW + plain + KEEP + ITERATE ---
        TestQuery {
            name: "Q239: Five evaluation paths (6 measures)",
            measures: vec![
                ("Revenue", "SUM(fact_sales[linetotal])"),
                ("BikeRev", r#"SUM(fact_sales[linetotal], KEEP(dim_product, dim_product[categoryname] = "Bikes"))"#),
                ("IterRev", "SUM(ITERATE(fact_sales, fact_sales[unitprice] * fact_sales[orderqty]))"),
                ("AvgMonthly", "VAR mqf = QUERY(SUM(fact_sales[linetotal]) AS rev BY dim_date[year], dim_date[month]) RETURN AVG(mqf[rev])"),
                ("RunTotal", "WINDOW(SUM(fact_sales[linetotal]), SUM, ORDERBY(dim_date[yearmonth]))"),
                ("PrevMonth", "OFFSET(SUM(fact_sales[linetotal]), -1, ORDERBY(dim_date[yearmonth]))"),
            ],
            group_by: vec![("dim_date", "yearmonth")],
            description: "Plain + KEEP + ITERATE + QUERY + WINDOW + OFFSET — five evaluation paths",
        },
        // --- THE SAFETY GAUNTLET ---
        TestQuery {
            name: "Q240: SAFETY GAUNTLET (12 measures, 3 dims)",
            measures: vec![
                ("Revenue", "SUM(fact_sales[linetotal])"),
                ("IterRev", "SUM(ITERATE(fact_sales, GREATEST(fact_sales[unitprice] * fact_sales[orderqty], 0)))"),
                ("BikeShare", r#"DIVIDE(SUM(fact_sales[linetotal], KEEP(dim_product, dim_product[categoryname] = "Bikes")), NULLIF(SUM(fact_sales[linetotal]), 0), 0)"#),
                ("CatTotal", "SUM(fact_sales[linetotal], CLEAREXCEPT(dim_product, dim_product[categoryname]))"),
                ("PctOfCat", "DIVIDE(SUM(fact_sales[linetotal]), SUM(fact_sales[linetotal], CLEAREXCEPT(dim_product, dim_product[categoryname])), 0)"),
                ("MedianPrice", "MEDIAN(fact_sales[unitprice])"),
                ("HighValPct", "DIVIDE(COUNT_IF(fact_sales[unitprice] > 100), NULLIF(COUNT(fact_sales[salesorderdetailid]), 0), 0)"),
                ("ClampedStdev", "GREATEST(LEAST(STDEV(fact_sales[unitprice]), AVG(fact_sales[unitprice])), 0)"),
                ("SafeScore", "VAR rev = SUM(fact_sales[linetotal]) VAR qty = SUM(fact_sales[orderqty]) RETURN IFERROR(ROUND(LN(GREATEST(DIVIDE(rev, NULLIF(qty, 0), 0), 1)), 4), 0)"),
                ("P90Price", "PERCENTILE(fact_sales[unitprice], 0.9)"),
                ("RowCount", "COUNTROWS(fact_sales)"),
                ("Orders", "COUNT(fact_sales[salesorderdetailid])"),
            ],
            group_by: vec![("dim_product", "categoryname"), ("dim_product", "subcategoryname"), ("dim_territory", "countryregioncode")],
            description: "SAFETY GAUNTLET: 12 measures, 3 dims — SUM, ITERATE, KEEP, CLEAREXCEPT, DIVIDE, NULLIF, MEDIAN, COUNT_IF, GREATEST, LEAST, STDEV, VAR, IFERROR, LN, ROUND, PERCENTILE, COUNTROWS",
        },
    ]
}

// ---------------------------------------------------------------------------
// Main test
// ---------------------------------------------------------------------------

#[tokio::test]
#[ignore]
async fn optimization_loop() {
    println!("\n{}", "=".repeat(80));
    println!("=== CALCULA ENGINE OPTIMIZATION LOOP ===");
    println!("{}\n", "=".repeat(80));

    let queries = get_queries();

    for (i, q) in queries.iter().enumerate() {
        println!("\n{}", "─".repeat(80));
        println!("┌─ Query {}/{}: {}", i + 1, queries.len(), q.name);
        println!("│  Description: {}", q.description);
        println!(
            "│  Measures: {:?}",
            q.measures.iter().map(|(n, _)| *n).collect::<Vec<_>>()
        );
        println!("│  Group By: {:?}", q.group_by);
        println!("└{}", "─".repeat(78));

        let mut engine = setup_engine(q.measures.clone()).await;

        let request = QueryRequest {
            measures: q.measures.iter().map(|(n, _)| n.to_string()).collect(),
            group_by: q
                .group_by
                .iter()
                .map(|(t, c)| ColumnRef {
                    table: t.to_string(),
                    column: c.to_string(),
                })
                .collect(),
            filters: vec![],
            lookups: vec![],
        };

        let start = std::time::Instant::now();
        match engine.query_explained(request).await {
            Ok((batches, plan)) => {
                let wall_time = start.elapsed();
                println!(
                    "\n  ✓ Success in {:.2}ms (wall: {:.2}ms)",
                    plan.total_duration.ms,
                    wall_time.as_millis()
                );
                println!("\n  --- Execution Plan ---");
                print_plan_tree(&plan.root, 1);
                println!("\n  --- Results (first 5 rows) ---");
                print_results(&batches, 5);
            }
            Err(e) => {
                println!("\n  ✗ FAILED: {e}");
                println!("    This indicates a potential engine bug or missing feature.");
            }
        }
        println!();
    }

    println!("\n{}", "=".repeat(80));
    println!("=== LOOP COMPLETE ===");
    println!("{}", "=".repeat(80));
}
