//! Interactive REPL for testing measures against a live database.
//!
//! Connects to the AdventureWorks BI schema and lets you define and query
//! measures using the DAX-like expression syntax.
//!
//! # Usage
//!
//! ```text
//! cargo run -p engine --example repl
//! ```
//!
//! # Commands
//!
//! ```text
//! measure [, measure2, ...]                          — compute measures (grand total)
//! measure [, ...] BY table[column] [, ...]           — grouped by dimensions
//! measure [, ...] BY ... WHERE col = val [, ...]     — with filters
//! :define Name = SUM(table[column])                — define a new measure
//! :define Name = SUM(t[col], KEEP(d, d[x] = v))   — measure with context ops
//! :remove Name                                     — remove a user-defined measure
//! :measures                                        — list available measures
//! :tables                                          — list tables and columns
//! :model                                           — show full model summary
//! :plan <query>                                    — show execution plan
//! :parse <expression>                              — parse and show expression tree
//! :help                                            — show this help
//! :quit                                            — exit
//! ```

use std::io::{self, BufRead, Write as _};
use std::time::Instant;

use arrow::util::pretty::pretty_format_batches;
use engine::*;

const CONNECTION_STRING: &str = "postgresql://postgres:postgres@localhost:5432/Adventureworks";
const SCHEMA: &str = "BI";

/// Build the AdventureWorks BI star-schema data model.
fn build_base_model() -> EngineResult<DataModel> {
    // -- Fact table --
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

    // -- Dimension tables --
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

    // -- Relationships (star schema: fact -> dim) --
    let rel_product = Relationship::new(
        "fact_sales_to_dim_product",
        "fact_sales",
        "productid",
        "dim_product",
        "productid",
        Cardinality::ManyToOne,
    );

    let rel_customer = Relationship::new(
        "fact_sales_to_dim_customer",
        "fact_sales",
        "customerid",
        "dim_customer",
        "customerid",
        Cardinality::ManyToOne,
    );

    let rel_territory = Relationship::new(
        "fact_sales_to_dim_territory",
        "fact_sales",
        "territoryid",
        "dim_territory",
        "territoryid",
        Cardinality::ManyToOne,
    );

    let rel_date = Relationship::new(
        "fact_sales_to_dim_date",
        "fact_sales",
        "orderdate",
        "dim_date",
        "datekey",
        Cardinality::ManyToOne,
    );

    // -- Built-in measures --
    let revenue = sum_measure("Revenue", "fact_sales", "linetotal");
    let order_qty = sum_measure("Order Qty", "fact_sales", "orderqty");
    let order_count = count_measure("Order Count", "fact_sales", "salesorderdetailid");
    let distinct_products = distinct_count_measure("Distinct Products", "fact_sales", "productid");
    let avg_unit_price = average_measure("Avg Unit Price", "fact_sales", "unitprice");

    DataModel::builder()
        .add_table(fact_sales)
        .add_table(dim_product)
        .add_table(dim_customer)
        .add_table(dim_territory)
        .add_table(dim_date)
        .add_relationship(rel_product)
        .add_relationship(rel_customer)
        .add_relationship(rel_territory)
        .add_relationship(rel_date)
        .add_measure(revenue)
        .add_measure(order_qty)
        .add_measure(order_count)
        .add_measure(distinct_products)
        .add_measure(avg_unit_price)
        .build()
}

/// Rebuild the DataModel by cloning the existing one and adding extra measures.
fn rebuild_model_with_measures(
    base: &DataModel,
    extra_measures: &[(String, String, Expression)],
) -> EngineResult<DataModel> {
    let mut builder = DataModel::builder();

    for t in base.tables() {
        builder = builder.add_table(t.clone());
    }
    for r in base.relationships() {
        builder = builder.add_relationship(r.clone());
    }
    for m in base.measures() {
        builder = builder.add_measure(m.clone());
    }
    for cc in base.calculated_columns() {
        builder = builder.add_calculated_column(cc.clone());
    }
    for ctx in base.contexts() {
        builder = builder.add_context(ctx.clone());
    }
    for tv in base.table_variables() {
        builder = builder.add_table_variable(tv.clone());
    }

    // Add user-defined measures.
    for (name, table, expr) in extra_measures {
        builder = builder.add_measure(expression_measure(name, table, expr.clone()));
    }

    builder.build()
}

/// Parse a user query line into a QueryRequest.
///
/// Format: `measure1, measure2 BY table.col1, table.col2 WHERE col = val, col2 = val2`
fn parse_query(input: &str, model: &DataModel) -> Result<QueryRequest, String> {
    let input = input.trim();

    // Split by WHERE first
    let (before_where, filters) = if let Some(idx) = input.to_uppercase().find(" WHERE ") {
        let (before, after) = input.split_at(idx);
        let after = &after[7..]; // skip " WHERE "
        (before.trim(), parse_filters(after)?)
    } else {
        (input, vec![])
    };

    // Split by BY
    let (measures_str, group_by) = if let Some(idx) = before_where.to_uppercase().find(" BY ") {
        let (before, after) = before_where.split_at(idx);
        let after = &after[4..]; // skip " BY "
        (before.trim(), parse_group_by(after)?)
    } else {
        (before_where, vec![])
    };

    // Parse measures
    let measures: Vec<String> = measures_str
        .split(',')
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .collect();

    if measures.is_empty() {
        return Err("No measures specified".into());
    }

    // Validate measures exist
    let known: Vec<&str> = model.measures().iter().map(|m| m.name()).collect();
    for m in &measures {
        if !known.contains(&m.as_str()) {
            return Err(format!(
                "Unknown measure '{}'. Available: {}",
                m,
                known.join(", ")
            ));
        }
    }

    Ok(QueryRequest {
        measures,
        group_by,
        filters,
        lookups: vec![],
    })
}

fn parse_group_by(input: &str) -> Result<Vec<ColumnRef>, String> {
    let mut refs = Vec::new();
    for part in input.split(',') {
        let part = part.trim();
        if part.is_empty() {
            continue;
        }
        let (table, column) = parse_column_ref(part)
            .ok_or_else(|| format!("Invalid column ref '{}' — use table[column]", part))?;
        refs.push(ColumnRef::new(table, column));
    }
    Ok(refs)
}

/// Parse a column reference in bracket notation `table[column]` or dot notation `table.column`.
fn parse_column_ref(s: &str) -> Option<(&str, &str)> {
    if let Some(bracket) = s.find('[') {
        if s.ends_with(']') {
            let table = s[..bracket].trim();
            let column = s[bracket + 1..s.len() - 1].trim();
            if !table.is_empty() && !column.is_empty() {
                return Some((table, column));
            }
        }
    }
    if let Some((table, column)) = s.split_once('.') {
        let table = table.trim();
        let column = column.trim();
        if !table.is_empty() && !column.is_empty() {
            return Some((table, column));
        }
    }
    None
}

fn parse_filters(input: &str) -> Result<Vec<FilterCondition>, String> {
    let mut filters = Vec::new();
    for part in input.split(',') {
        let part = part.trim();
        if part.is_empty() {
            continue;
        }
        if let Some(idx) = part.find("!=") {
            let col = part[..idx].trim().to_string();
            let val = part[idx + 2..].trim().to_string();
            filters.push(FilterCondition {
                column: col,
                operator: FilterOperator::NotEqual,
                value: val,
            });
        } else if let Some(idx) = part.find('=') {
            let col = part[..idx].trim().to_string();
            let val = part[idx + 1..].trim().to_string();
            filters.push(FilterCondition {
                column: col,
                operator: FilterOperator::Equal,
                value: val,
            });
        } else {
            return Err(format!("Invalid filter '{}' — use column = value", part));
        }
    }
    Ok(filters)
}

fn print_help() {
    println!();
    println!("  QUERY SYNTAX:");
    println!("    measure1, measure2                         grand total");
    println!("    measure BY table[column]                   grouped");
    println!("    measure BY table[col] WHERE col = val      filtered");
    println!();
    println!("  DEFINE MEASURES:");
    println!("    :define Name = SUM(table[column])");
    println!("    :define Name = SUM(t[col], KEEP(dim, dim[year] = 2024))");
    println!("    :define Name = SUM(t[a]) / COUNT(t[b])");
    println!("    :define Name = SUM(t[price] * t[qty])");
    println!("    :define Name = SUM(t[col], CLEAR(dim))");
    println!("    :define Name = SUM(t[col], RESET())");
    println!();
    println!("  EXAMPLES:");
    println!("    Revenue");
    println!("    Revenue, Order Qty BY dim_product[categoryname]");
    println!(
        "    :define Rev2014 = SUM(fact_sales[linetotal], KEEP(dim_date, dim_date[year] = 2014))"
    );
    println!("    Revenue, Rev2014 BY dim_product[categoryname]");
    println!();
    println!("  COMMANDS:");
    println!("    :define N = expr  define a new measure");
    println!("    :remove N         remove a user-defined measure");
    println!("    :parse expr       parse and show expression tree (debug)");
    println!("    :measures         list available measures");
    println!("    :tables           list tables and columns");
    println!("    :model            full model summary");
    println!("    :plan <query>     show execution plan");
    println!("    :help             show this help");
    println!("    :quit             exit");
    println!();
}

fn print_measures(model: &DataModel, user_measure_names: &[String]) {
    println!();
    println!("  Available measures:");
    for m in model.measures() {
        let detail = match (m.simple_operation(), m.simple_column()) {
            (Some(op), Some(col)) => format!("{:?}({}.{})", op, m.table(), col),
            _ => format!("expression({})", m.table()),
        };
        let marker = if user_measure_names.contains(&m.name().to_string()) {
            " [user]"
        } else {
            ""
        };
        println!("    - {}{} ({})", m.name(), marker, detail);
    }
    println!();
}

fn print_tables(model: &DataModel) {
    println!();
    for t in model.tables() {
        println!("  {}:", t.name());
        for c in t.columns() {
            println!("    - {} ({:?})", c.name(), c.data_type());
        }
        println!();
    }
}

#[tokio::main]
async fn main() {
    println!("Calcula Engine REPL — AdventureWorks BI");
    println!("========================================");

    // Build base model
    let base_model = match build_base_model() {
        Ok(m) => m,
        Err(e) => {
            eprintln!("Failed to build model: {e}");
            return;
        }
    };

    // Connect to PostgreSQL
    println!("Connecting to {}...", CONNECTION_STRING);
    let pg_config = PostgresConfig::new(CONNECTION_STRING);
    let mut engine = Engine::new(base_model.clone());

    let pg_idx = match engine.add_postgres(pg_config).await {
        Ok(idx) => idx,
        Err(e) => {
            eprintln!("Failed to connect: {e}");
            return;
        }
    };
    println!("Connected!");

    // Bind all tables to the BI schema
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

    println!(
        "Model: {} tables, {} measures. Type :help for syntax.",
        engine.model().tables().len(),
        engine.model().measures().len()
    );
    println!();

    // User-defined measures: (name, table, expression)
    let mut user_measures: Vec<(String, String, Expression)> = Vec::new();

    /// Rebuild engine model with updated measures, preserving registry.
    fn rebuild_engine(
        base_model: &DataModel,
        user_measures: &[(String, String, Expression)],
        engine: &mut Engine,
    ) -> bool {
        match rebuild_model_with_measures(base_model, user_measures) {
            Ok(new_model) => {
                engine.set_model(new_model);
                true
            }
            Err(e) => {
                println!("  Model rebuild error: {e}");
                false
            }
        }
    }

    let stdin = io::stdin();
    let mut stdout = io::stdout();

    loop {
        print!("calcula> ");
        stdout.flush().unwrap();

        let mut line = String::new();
        match stdin.lock().read_line(&mut line) {
            Ok(0) => break, // EOF
            Err(e) => {
                eprintln!("Read error: {e}");
                break;
            }
            _ => {}
        }

        let line = line.trim();
        if line.is_empty() {
            continue;
        }

        match line {
            ":quit" | ":q" | ":exit" => break,
            ":help" | ":h" => {
                print_help();
                continue;
            }
            ":measures" | ":m" => {
                let names: Vec<String> = user_measures.iter().map(|(n, _, _)| n.clone()).collect();
                print_measures(engine.model(), &names);
                continue;
            }
            ":tables" | ":t" => {
                print_tables(engine.model());
                continue;
            }
            ":model" => {
                let names: Vec<String> = user_measures.iter().map(|(n, _, _)| n.clone()).collect();
                print_measures(engine.model(), &names);
                print_tables(engine.model());
                println!("  Relationships:");
                for r in engine.model().relationships() {
                    let conditions_str: Vec<String> = r
                        .conditions()
                        .iter()
                        .map(|c| {
                            format!(
                                "{}.{} {} {}.{}",
                                r.from_table(),
                                c.from_column(),
                                c.operator().as_sql(),
                                r.to_table(),
                                c.to_column()
                            )
                        })
                        .collect();
                    println!(
                        "    {} -> {} ({})",
                        r.from_table(),
                        r.to_table(),
                        conditions_str.join(", ")
                    );
                }
                println!();
                continue;
            }
            _ => {}
        }

        // :define Name = expression
        if let Some(rest) = line.strip_prefix(":define ") {
            if let Some((name, expr_str)) = rest.split_once('=') {
                let name = name.trim().to_string();
                let expr_str = expr_str.trim();

                if name.is_empty() {
                    println!("  Error: measure name cannot be empty");
                    continue;
                }

                match parse_measure(expr_str) {
                    Ok((table, expr)) => {
                        // Remove existing measure with same name if any.
                        user_measures.retain(|(n, _, _)| n != &name);
                        println!("  Parsed: {} = {} (table: {})", name, expr_str, table);
                        user_measures.push((name.clone(), table, expr));

                        // Rebuild engine with new measure.
                        if rebuild_engine(&base_model, &user_measures, &mut engine) {
                            println!(
                                "  Measure '{}' defined. ({} total measures)",
                                name,
                                engine.model().measures().len()
                            );
                        }
                    }
                    Err(e) => println!("  Parse error: {e}"),
                }
            } else {
                println!("  Syntax: :define Name = SUM(table[column])");
            }
            continue;
        }

        // :remove Name
        if let Some(name) = line.strip_prefix(":remove ") {
            let name = name.trim();
            let before = user_measures.len();
            user_measures.retain(|(n, _, _)| n != name);
            if user_measures.len() < before {
                rebuild_engine(&base_model, &user_measures, &mut engine);
                println!("  Measure '{}' removed.", name);
            } else {
                println!("  No user-defined measure '{}' found.", name);
            }
            continue;
        }

        // :parse expression — debug: show parsed AST
        if let Some(expr_str) = line.strip_prefix(":parse ") {
            match parse_measure_expression(expr_str.trim()) {
                Ok(expr) => {
                    println!("  AST: {:#?}", expr);
                    println!("  SQL: {}", expr.to_sql_string());
                    println!("  has_aggregate: {}", expr.has_aggregate());
                    println!("  has_context_ops: {}", expr.has_context_ops());
                    if let Ok((table, _)) = parse_measure(expr_str.trim()) {
                        println!("  inferred table: {}", table);
                    }
                }
                Err(e) => println!("  Parse error: {e}"),
            }
            continue;
        }

        // Check for :plan prefix
        let (query_str, show_plan) = if let Some(rest) = line.strip_prefix(":plan ") {
            (rest, true)
        } else {
            (line, false)
        };

        // Parse and execute query
        let request = match parse_query(query_str, engine.model()) {
            Ok(r) => r,
            Err(e) => {
                println!("  Parse error: {e}");
                continue;
            }
        };

        let start = Instant::now();

        if show_plan {
            match engine.query_explained(request).await {
                Ok((batches, plan)) => {
                    let elapsed = start.elapsed();
                    println!();
                    match serde_json::to_string_pretty(&plan) {
                        Ok(json) => println!("{json}"),
                        Err(e) => println!("  (plan serialization error: {e})"),
                    }
                    println!();
                    print_results(&batches, elapsed);
                }
                Err(e) => println!("  Query error: {e}"),
            }
        } else {
            match engine.query(request).await {
                Ok(batches) => {
                    let elapsed = start.elapsed();
                    print_results(&batches, elapsed);
                }
                Err(e) => println!("  Query error: {e}"),
            }
        }
    }

    println!("Goodbye!");
}

fn print_results(batches: &[arrow::record_batch::RecordBatch], elapsed: std::time::Duration) {
    let total_rows: usize = batches.iter().map(|b| b.num_rows()).sum();
    if total_rows == 0 {
        println!("  (no results)");
    } else {
        match pretty_format_batches(batches) {
            Ok(table) => println!("\n{table}"),
            Err(e) => println!("  Display error: {e}"),
        }
    }
    println!(
        "  ({total_rows} rows, {:.1}ms)",
        elapsed.as_secs_f64() * 1000.0
    );
    println!();
}
