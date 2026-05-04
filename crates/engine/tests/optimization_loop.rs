//! Automated engine optimization loop.
//!
//! This test generates queries of increasing complexity, runs them with
//! `query_explained()`, and prints execution plan details for analysis.
//!
//! Run with: `cargo test -p bi-engine --test optimization_loop -- --ignored --nocapture`

use engine::*;

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

    for (name, expr_text) in measures {
        let expr = parse_measure(expr_text)
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

        let engine = setup_engine(q.measures.clone()).await;

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
