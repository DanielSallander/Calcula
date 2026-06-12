//! Reads measure definitions and queries from `measures.txt` and executes them
//! against the AdventureWorks BI database.
//!
//! # Usage
//!
//! ```text
//! cargo run -p engine --example run_measures
//! ```
//!
//! Edit `crates/engine/examples/measures.txt` to change measures and queries.
//! Lines starting with `//` are comments. Supported directives:
//!
//! ```text
//! VAR Name = KEEP(table, table[column] = value)
//! DEFINE Name = SUM(table[column])
//! QUERY: measure1, measure2 BY table.column
//! ```

use std::path::Path;
use std::time::Instant;

use arrow::util::pretty::pretty_format_batches;
use bi_engine::*;

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

fn main() {
    if let Err(e) = run() {
        eprintln!("Error: {e}");
        std::process::exit(1);
    }
}

#[tokio::main]
async fn run() -> Result<(), Box<dyn std::error::Error>> {
    // Locate measures.txt next to this source file.
    let measures_path = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("examples")
        .join("measures.txt");

    println!("Reading measures from: {}", measures_path.display());
    let content = std::fs::read_to_string(&measures_path)
        .map_err(|e| format!("Cannot read {}: {e}", measures_path.display()))?;

    // Parse the file into vars, defines, and queries.
    let mut vars: Vec<(String, String)> = Vec::new(); // (name, expression_text)
    let mut defines: Vec<(String, String)> = Vec::new(); // (name, expression_text)
    let mut queries: Vec<String> = Vec::new();

    for (line_no, raw_line) in content.lines().enumerate() {
        let line = raw_line.trim();
        if line.is_empty() || line.starts_with("//") {
            continue;
        }

        if let Some(rest) = line.strip_prefix("VAR ") {
            if let Some((name, expr)) = rest.split_once('=') {
                let name = name.trim().to_string();
                let expr = expr.trim().to_string();
                if name.is_empty() || expr.is_empty() {
                    eprintln!(
                        "  Line {}: invalid VAR (empty name or expression)",
                        line_no + 1
                    );
                    continue;
                }
                vars.push((name, expr));
            } else {
                eprintln!(
                    "  Line {}: VAR missing '=' — expected: VAR Name = KEEP(table, filter)",
                    line_no + 1
                );
            }
        } else if let Some(rest) = line.strip_prefix("DEFINE ") {
            if let Some((name, expr)) = rest.split_once('=') {
                let name = name.trim().to_string();
                let expr = expr.trim().to_string();
                if name.is_empty() || expr.is_empty() {
                    eprintln!(
                        "  Line {}: invalid DEFINE (empty name or expression)",
                        line_no + 1
                    );
                    continue;
                }
                defines.push((name, expr));
            } else {
                eprintln!(
                    "  Line {}: DEFINE missing '=' — expected: DEFINE Name = expression",
                    line_no + 1
                );
            }
        } else if let Some(rest) = line.strip_prefix("QUERY:") {
            let q = rest.trim().to_string();
            if q.is_empty() {
                eprintln!("  Line {}: empty QUERY", line_no + 1);
                continue;
            }
            queries.push(q);
        } else {
            eprintln!(
                "  Line {}: unknown directive '{}' (expected VAR, DEFINE, or QUERY:)",
                line_no + 1,
                line
            );
        }
    }

    if vars.is_empty() && defines.is_empty() && queries.is_empty() {
        println!(
            "No variables, measures, or queries found. Edit measures.txt and uncomment some lines."
        );
        return Ok(());
    }

    // Build the base data model.
    let base_model = build_base_model()?;

    // Parse table variable definitions and add them to the model.
    let mut builder = clone_model_into_builder(&base_model);

    if !vars.is_empty() {
        println!();
        println!("Variables:");
        for (name, expr_text) in &vars {
            match parse_table_variable(expr_text) {
                Ok((source, filters)) => {
                    println!("  + VAR {} = {} (source: {})", name, expr_text, source);
                    builder =
                        builder.add_table_variable(TableVariable::new(name, &source, filters));
                }
                Err(e) => {
                    eprintln!("  ! VAR {} — parse error: {e}", name);
                }
            }
        }
    }

    // Parse measure expressions and add them to the model.
    let mut measure_names: Vec<String> = base_model
        .measures()
        .iter()
        .map(|m| m.name().to_string())
        .collect();

    println!();
    println!("Measures:");
    for (name, expr_text) in &defines {
        match parse_measure(expr_text) {
            Ok(expr) => {
                println!("  + {} = {}", name, expr_text);
                builder = builder.add_measure(expression_measure(name, expr));
                measure_names.push(name.clone());
            }
            Err(e) => {
                eprintln!("  ! {} — parse error: {e}", name);
            }
        }
    }

    let model = builder.build()?;

    // Connect to PostgreSQL.
    let target = test_target();
    let auth = test_auth();
    println!();
    println!(
        "Connecting to {}:{}...",
        target.host,
        target.port.unwrap_or(5432)
    );
    let mut engine = Engine::new(model);
    let pg_idx = engine.add_postgres(target, auth).await?;

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
    println!("Connected! ({} tables bound)", table_names.len());

    // Execute queries.
    println!();
    for (i, query_str) in queries.iter().enumerate() {
        println!("--- Query {} ---", i + 1);
        println!("  {}", query_str);
        println!();

        match parse_query(query_str, engine.model()) {
            Ok(request) => {
                let start = Instant::now();
                match engine.query(request).await {
                    Ok(batches) => print_results(&batches, start.elapsed()),
                    Err(e) => eprintln!("  Query error: {e}"),
                }
            }
            Err(e) => eprintln!("  Parse error: {e}"),
        }
        println!();
    }

    println!("Done.");
    Ok(())
}

// --- Model building (same star schema as repl.rs) ---

fn build_base_model() -> EngineResult<DataModel> {
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

    DataModel::builder()
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
        ))
        .build()
}

/// Clone an existing model's structure into a new builder (preserving tables,
/// relationships, calculated columns, contexts, and table variables — but NOT
/// measures, so the caller can add their own set).
fn clone_model_into_builder(model: &DataModel) -> DataModelBuilder {
    let mut builder = DataModel::builder();
    for t in model.tables() {
        builder = builder.add_table(t.clone());
    }
    for r in model.relationships() {
        builder = builder.add_relationship(r.clone());
    }
    for cc in model.calculated_columns() {
        builder = builder.add_calculated_column(cc.clone());
    }
    for ctx in model.contexts() {
        builder = builder.add_context(ctx.clone());
    }
    for tv in model.table_variables() {
        builder = builder.add_table_variable(tv.clone());
    }
    builder
}

// --- Query parsing (reused from repl.rs) ---

fn parse_query(input: &str, model: &DataModel) -> Result<QueryRequest, String> {
    let input = input.trim();

    let (before_where, filters) = if let Some(idx) = input.to_uppercase().find(" WHERE ") {
        let (before, after) = input.split_at(idx);
        let after = &after[7..];
        (before.trim(), parse_filters(after)?)
    } else {
        (input, vec![])
    };

    let (measures_str, group_by) = if let Some(idx) = before_where.to_uppercase().find(" BY ") {
        let (before, after) = before_where.split_at(idx);
        let after = &after[4..];
        (before.trim(), parse_group_by(after)?)
    } else {
        (before_where, vec![])
    };

    let measures: Vec<String> = measures_str
        .split(',')
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .collect();

    if measures.is_empty() {
        return Err("No measures specified".into());
    }

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
        ..Default::default()
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
    // Bracket notation: table[column]
    if let Some(bracket) = s.find('[') {
        if s.ends_with(']') {
            let table = s[..bracket].trim();
            let column = s[bracket + 1..s.len() - 1].trim();
            if !table.is_empty() && !column.is_empty() {
                return Some((table, column));
            }
        }
    }
    // Dot notation fallback: table.column
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

fn print_results(batches: &[arrow::record_batch::RecordBatch], elapsed: std::time::Duration) {
    let total_rows: usize = batches.iter().map(|b| b.num_rows()).sum();
    if total_rows == 0 {
        println!("  (no results)");
    } else {
        match pretty_format_batches(batches) {
            Ok(table) => println!("{table}"),
            Err(e) => println!("  Display error: {e}"),
        }
    }
    println!(
        "  ({total_rows} rows, {:.1}ms)",
        elapsed.as_secs_f64() * 1000.0
    );
}
