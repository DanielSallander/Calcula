# Calcula Engine — Expression Language Reference

This document describes the expression language used to define measures and context manipulation in the Calcula Engine. The language uses a **functional nested syntax** — read inside-out to understand evaluation order.

## Design Principles

1. **Explicit over implicit** — Every operation is visible in the expression. No hidden filter propagation magic.
2. **Fully qualified references** — Column references are always `Table.Column`. No ambiguity.
3. **Inside-out evaluation** — Innermost expression evaluates first. Reading from inside-out tells you exactly what happens.
4. **AND semantics for keep()** — Filters always AND together. To override, explicitly `clear()` then `keep()`.

---

## Text Syntax

The engine includes a built-in parser that converts DAX-like text expressions into the internal `Expression` AST. This is the same syntax used in Calcula Studio's measure editor — the parser lives in the engine so any tool can define measures without building its own parser.

### Syntax Overview

```text
FUNCTION(table[column])
FUNCTION(table[column], CONTEXT_OP(...))
expression +|- expression
expression *|/ expression
( expression )
```

### Aggregation Functions

| Function | Example |
|----------|---------|
| `SUM` | `SUM(Sales[amount])` |
| `COUNT` | `COUNT(Sales[id])` |
| `AVG` / `AVERAGE` | `AVG(Sales[amount])` |
| `MIN` | `MIN(Sales[amount])` |
| `MAX` | `MAX(Sales[amount])` |
| `DISTINCTCOUNT` | `DISTINCTCOUNT(Sales[productid])` |
| `COUNTROWS` | `COUNTROWS(Sales)` |

### Conditional and Logical Functions

| Function | Example |
|----------|---------|
| `IF` | `IF(SUM(t[a]) > 100, "High", "Low")` |
| `SWITCH` | `SWITCH(SUM(t[status]), 1, "Active", 2, "Inactive", "Unknown")` |
| `DIVIDE` | `DIVIDE(SUM(t[a]), COUNT(t[b]))` |
| `BLANK` | `BLANK()` |
| `ISBLANK` | `ISBLANK(SUM(t[a]))` |
| `COALESCE` | `COALESCE(SUM(t[a]), 0)` |

### Information Functions

| Function | Example |
|----------|---------|
| `HASONEVALUE` | `HASONEVALUE(dim_product[categoryname])` |
| `SELECTEDVALUE` | `SELECTEDVALUE(dim_product[categoryname], "Multiple")` |
| `FIRST` | `FIRST(dim_product[name], ORDER BY dim_product[sort_order])` |

### Math Functions

| Function | Example |
|----------|---------|
| `ABS` | `ABS(SUM(t[a]) - 100)` |
| `ROUND` | `ROUND(SUM(t[a]), 2)` |
| `ROUNDUP` | `ROUNDUP(SUM(t[a]), 2)` |
| `ROUNDDOWN` | `ROUNDDOWN(SUM(t[a]), 2)` |
| `INT` | `INT(SUM(t[a]))` |
| `TRUNC` | `TRUNC(SUM(t[a]), 2)` |
| `CEILING` | `CEILING(SUM(t[a]), 10)` |
| `FLOOR` | `FLOOR(SUM(t[a]), 10)` |
| `MOD` | `MOD(SUM(t[a]), 1000)` |
| `POWER` | `POWER(COUNT(t[a]), 2)` |
| `SQRT` | `SQRT(COUNT(t[a]))` |
| `LN` | `LN(SUM(t[a]))` |
| `LOG10` | `LOG10(SUM(t[a]))` |
| `SIGN` | `SIGN(SUM(t[a]))` |

### Arithmetic

Operators `+`, `-`, `*`, `/` with standard precedence. Parentheses for grouping.

```text
SUM(Sales[price] * Sales[qty])
SUM(Sales[amount]) / COUNT(Sales[id])
(SUM(Sales[amount]) - SUM(Sales[cost])) / SUM(Sales[amount])
```

### Context Operations

Context operations appear as **additional arguments** to an aggregation function. Multiple context arguments can be comma-separated:

```text
// Explicit context functions
SUM(Sales[amount], KEEP(dim_date, dim_date[year] = 2024))
SUM(Sales[amount], KEEP(dim_date, dim_date[year] = 2024, dim_date[month] = 6))
SUM(Sales[amount], CLEAR(dim_date))
SUM(Sales[amount], CLEAR(dim_date[year]))
SUM(Sales[amount], RESET())
SUM(Sales[amount], USING(my_context))

// Bare table variable names as context arguments
SUM(Sales[amount], bikes)
SUM(Sales[amount], bikes, year_2024)

// Mix of variables and explicit context ops
SUM(Sales[amount], bikes, KEEP(dim_date, dim_date[year] = 2024))
```

**KEEP** — adds filter conditions (AND semantics):
```text
KEEP(table, table[column] = value)
KEEP(table, table[column] > 100)
KEEP(table, table[column] != "excluded")
```

Supported operators: `=`, `!=`, `>`, `>=`, `<`, `<=`

String values use double quotes: `table[name] = "Bikes"`. Numeric values are unquoted: `table[year] = 2024`.

**CLEAR** — removes filters on a table or column:
```text
CLEAR(table_name)
CLEAR(table[column])
```

**RESET** — removes all filters:
```text
RESET()
```

**USING** — applies a named context:
```text
USING(context_name)
```

### Column References

Columns use bracket syntax: `table[column]`. The table name is required to avoid ambiguity:

```text
SUM(fact_sales[linetotal])
```

Arithmetic inside aggregates can reference multiple columns from the same table:
```text
SUM(Sales[price] * Sales[qty])
```

### Parser API

```rust
use engine::{parse_measure, parse_measure_expression, infer_fact_table};

// Parse expression only — returns the Expression AST
let expr = parse_measure_expression("SUM(Sales[amount])")?;

// Parse with fact-table validation — errors if no qualified column ref
let expr = parse_measure("SUM(Sales[amount], KEEP(dim_date, dim_date[year] = 2024))")?;
assert_eq!(infer_fact_table(&expr), Some("Sales".to_string()));

// Create a named measure from parsed text
use engine::{expression_measure, DataModel};
let measure = expression_measure("Revenue 2024", expr);
```

### Interactive REPL

The `repl` example provides an interactive shell for testing parsed measures against a live database:

```text
cargo run -p engine --example repl
```

Commands:
```text
:define Revenue2024 = SUM(fact_sales[linetotal], KEEP(dim_date, dim_date[year] = 2014))
:define AvgOrder = SUM(fact_sales[linetotal]) / COUNT(fact_sales[salesorderdetailid])
:parse SUM(Sales[amount])
Revenue, Revenue2024 BY dim_product.categoryname
```

---

## Aggregation Functions

These are the core aggregation operations:

| Function | Description | Example |
|----------|-------------|---------|
| `sum` | Sum of values | `sum(Sales.Amount)` |
| `count` | Count of non-null values | `count(Sales.Id)` |
| `average` | Mean of values | `average(Sales.Amount)` |
| `min` | Minimum value | `min(Sales.Amount)` |
| `max` | Maximum value | `max(Sales.Amount)` |
| `distinct_count` | Count of distinct values | `distinct_count(Sales.ProductId)` |
| `count_rows` | Count all rows (including NULLs) | `count_rows(Sales)` |

### Rust API

```rust
use engine::expression::{self as expr};
use engine::AggregateOp;

// Simple: SUM(amount)
let sum_amount = expr::agg(AggregateOp::Sum, expr::col("amount"));

// Expression: SUM(price * quantity)
let revenue = expr::agg(
    AggregateOp::Sum,
    expr::col("price").multiply(expr::col("quantity")),
);

// Ratio: SUM(amount) / COUNT(id)
let avg_order = expr::agg(AggregateOp::Sum, expr::col("amount"))
    .divide(expr::agg(AggregateOp::Count, expr::col("id")));
```

### Convenience Constructors

```rust
let revenue   = sum_measure("Revenue", "Sales", "amount");
let orders    = count_measure("OrderCount", "Sales", "id");
let avg_price = average_measure("AvgPrice", "Sales", "amount");
let unique    = distinct_count_measure("UniqueProducts", "Sales", "product_id");
```

---

## Conditional and Logical Functions

These functions provide branching logic and NULL handling in measure expressions.

### DIVIDE

**Safe division with zero-denominator handling.**

Returns an alternate value (default: BLANK/NULL) when the denominator is zero.

**Text syntax:**
```
DIVIDE(SUM(Sales[amount]), COUNT(Sales[id]))
DIVIDE(SUM(Sales[amount]), COUNT(Sales[id]), 0)
```

**Rust API:**
```rust
// DIVIDE(num, den) — returns NULL on zero
let avg = expr::safe_divide(
    expr::agg(AggregateOp::Sum, expr::col("amount")),
    expr::agg(AggregateOp::Count, expr::col("id")),
    None,
);

// DIVIDE(num, den, 0) — returns 0 on zero
let avg = expr::safe_divide(
    expr::agg(AggregateOp::Sum, expr::col("amount")),
    expr::agg(AggregateOp::Count, expr::col("id")),
    Some(expr::lit_int(0)),
);
```

### COUNTROWS

**Count all rows in a table, including NULLs.**

Unlike COUNT which counts non-null values in a column, COUNTROWS counts all rows — equivalent to SQL `COUNT(*)`.

**Text syntax:**
```
COUNTROWS(Sales)
DIVIDE(SUM(Sales[amount]), COUNTROWS(Sales))
```

**Rust API:**
```rust
let total_rows = expr::count_rows();
```

### IF

**Conditional branching.**

**Text syntax:**
```
IF(SUM(Sales[amount]) > 1000, "High", "Low")
IF(SUM(Sales[qty]) > 10 AND SUM(Sales[amount]) > 100, "Both", "Not both")
```

Conditions support `AND`, `OR`, `NOT`, `XOR`, and comparison operators (`=`, `!=`, `>`, `>=`, `<`, `<=`).

Logical operators are available both as **operators** and as **functions**:
```
// Operator syntax
IF(SUM(t[a]) > 0 AND SUM(t[b]) > 0, "Both", "Neither")

// Function syntax (DAX-compatible)
IF(AND(SUM(t[a]) > 0, SUM(t[b]) > 0), "Both", "Neither")
IF(OR(SUM(t[a]) > 0, SUM(t[b]) > 0), "Either", "Neither")
IF(NOT(SUM(t[a]) = 0), "NonZero", "Zero")
IF(XOR(SUM(t[a]) > 0, SUM(t[b]) > 0), "Exclusive", "Both or Neither")
```

Boolean literals `TRUE` / `FALSE` are available with or without parentheses:
```
IF(SUM(t[a]) > 0, TRUE(), FALSE())
IF(SUM(t[a]) > 0, TRUE, FALSE)
```

**Rust API:**
```rust
let expr = expr::if_expr(
    expr::compare(
        expr::agg(AggregateOp::Sum, expr::col("amount")),
        ComparisonOp::GreaterThan,
        expr::lit(1000.0),
    ),
    expr::lit_str("High"),
    expr::lit_str("Low"),
);
```

### SWITCH

**Multi-way branching on a single expression.**

**Text syntax:**
```
SWITCH(SUM(Sales[status]), 1, "Active", 2, "Inactive", "Unknown")
```

**Rust API:**
```rust
let expr = expr::switch(
    expr::agg(AggregateOp::Sum, expr::col("status")),
    vec![
        (expr::lit_int(1), expr::lit_str("Active")),
        (expr::lit_int(2), expr::lit_str("Inactive")),
    ],
    Some(expr::lit_str("Unknown")),
);
```

### BLANK / ISBLANK

**BLANK** returns a NULL value. **ISBLANK** tests whether an expression is NULL.

**Text syntax:**
```
BLANK()
ISBLANK(SUM(Sales[amount]))
IF(ISBLANK(SUM(Sales[amount])), 0, SUM(Sales[amount]))
```

**Rust API:**
```rust
let b = expr::blank();
let test = expr::is_blank(expr::agg(AggregateOp::Sum, expr::col("amount")));
```

### COALESCE

**Return the first non-NULL value from a list of expressions.**

**Text syntax:**
```
COALESCE(SUM(Sales[amount]), 0)
COALESCE(SUM(Sales[primary]), SUM(Sales[secondary]), 0)
```

**Rust API:**
```rust
let expr = expr::coalesce(vec![
    expr::agg(AggregateOp::Sum, expr::col("amount")),
    expr::lit_int(0),
]);
```

---

## Math Functions

Scalar math functions that operate on numeric values. All math functions force local computation when wrapping aggregations.

| Function | Description | Syntax |
|----------|-------------|--------|
| `ABS` | Absolute value | `ABS(expr)` |
| `ROUND` | Round to N decimals | `ROUND(expr, N)` |
| `ROUNDUP` | Round away from zero | `ROUNDUP(expr, N)` |
| `ROUNDDOWN` | Round toward zero | `ROUNDDOWN(expr, N)` |
| `INT` | Floor to integer | `INT(expr)` |
| `TRUNC` | Truncate toward zero | `TRUNC(expr [, N])` |
| `CEILING` | Round up to multiple | `CEILING(expr [, sig])` |
| `FLOOR` | Round down to multiple | `FLOOR(expr [, sig])` |
| `MOD` | Remainder after division | `MOD(expr, divisor)` |
| `POWER` | Exponentiation | `POWER(base, exp)` |
| `SQRT` | Square root | `SQRT(expr)` |
| `LN` | Natural logarithm | `LN(expr)` |
| `LOG10` | Base-10 logarithm | `LOG10(expr)` |
| `SIGN` | Sign (-1, 0, 1) | `SIGN(expr)` |

**Text syntax examples:**
```
ROUND(DIVIDE(SUM(Sales[amount]), COUNT(Sales[id])), 2)
ABS(SUM(Sales[amount]) - 1000000)
SQRT(COUNT(Sales[id]))
POWER(COUNT(Sales[id]), 2)
MOD(SUM(Sales[qty]), 1000)
INT(DIVIDE(SUM(Sales[amount]), 100000))
```

**Rust API:**
```rust
use engine::expression::{self as expr, ScalarFunction};

let rounded = expr::scalar_fn(
    ScalarFunction::Round,
    vec![expr::agg(AggregateOp::Sum, expr::col("amount")), expr::lit_int(2)],
);

let abs_val = expr::scalar_fn(
    ScalarFunction::Abs,
    vec![expr::agg(AggregateOp::Sum, expr::col("amount"))],
);

let sqrt_val = expr::scalar_fn(
    ScalarFunction::Sqrt,
    vec![expr::agg(AggregateOp::Count, expr::col("id"))],
);
```

---

## Text Functions

Text functions that manipulate string values. See the [function reference](functions/README.md) for full details.

| Function | Description | Syntax |
|----------|-------------|--------|
| `CONCATENATE` | Join text strings | `CONCATENATE(text1, text2, ...)` |
| `COMBINEVALUES` | Join with delimiter | `COMBINEVALUES(delim, text1, text2, ...)` |
| `EXACT` | Case-sensitive compare | `EXACT(text1, text2)` |
| `FIND` | Find position (case-sensitive) | `FIND(find, within [, start])` |
| `SEARCH` | Find position (case-insensitive) | `SEARCH(find, within [, start])` |
| `LEFT` | Left substring | `LEFT(text [, n])` |
| `RIGHT` | Right substring | `RIGHT(text [, n])` |
| `MID` | Middle substring | `MID(text, start, length)` |
| `LEN` | String length | `LEN(text)` |
| `LOWER` | To lowercase | `LOWER(text)` |
| `UPPER` | To uppercase | `UPPER(text)` |
| `TRIM` | Remove leading/trailing spaces | `TRIM(text)` |
| `REPLACE` | Replace by position | `REPLACE(text, start, n, new)` |
| `SUBSTITUTE` | Replace text pattern | `SUBSTITUTE(text, old, new)` |
| `REPT` | Repeat text | `REPT(text, times)` |
| `FIXED` | Number to text | `FIXED(number [, decimals])` |
| `VALUE` | Text to number | `VALUE(text)` |
| `UNICHAR` | Code point to char | `UNICHAR(number)` |
| `UNICODE` | Char to code point | `UNICODE(text)` |
| `LTRIM` | Remove leading chars | `LTRIM(text [, chars])` |
| `RTRIM` | Remove trailing chars | `RTRIM(text [, chars])` |
| `LPAD` | Left-pad to length | `LPAD(text, length [, pad])` |
| `RPAD` | Right-pad to length | `RPAD(text, length [, pad])` |
| `REVERSE` | Reverse characters | `REVERSE(text)` |
| `SPLIT` | Split and extract part | `SPLIT(text, delimiter, part)` |

**Text syntax examples:**
```
UPPER(dim_product[categoryname])
CONCATENATE(dim_customer[firstname], " ", dim_customer[lastname])
COMBINEVALUES("-", dim_date[year], dim_date[month])
IF(LEN(dim_product[name]) > 20, LEFT(dim_product[name], 20), dim_product[name])
SUBSTITUTE(dim_product[name], "Road", "Mountain")
```

**Rust API:**
```rust
use engine::expression::{self as expr, TextFunction};

let upper = expr::text_fn(
    TextFunction::Upper,
    vec![expr::qualified_col("product", "name")],
);

let concat = expr::text_fn(
    TextFunction::Concatenate,
    vec![expr::col("first"), expr::lit_str(" "), expr::col("last")],
);
```

---

## Information Functions

These functions inspect the current evaluation context to check or retrieve values based on distinct counts.

### HASONEVALUE

**Test whether a column has exactly one distinct value in the current context.**

Returns TRUE (1) when the column has exactly one distinct value, FALSE (0) otherwise. Useful in conditional logic to detect when a single value is selected.

**Text syntax:**
```
HASONEVALUE(dim_product[categoryname])
IF(HASONEVALUE(dim_date[year]), SELECTEDVALUE(dim_date[year]), "Multiple")
```

**Rust API:**
```rust
let test = expr::has_one_value(expr::col("categoryname"));
```

**SQL generated:** `(COUNT(DISTINCT "categoryname") = 1)`

### SELECTEDVALUE

**Return the single value of a column if exactly one exists, otherwise return an alternate.**

Checks whether the column has exactly one distinct value. If so, returns it. Otherwise returns the alternate value (default: BLANK/NULL).

**Text syntax:**
```
SELECTEDVALUE(dim_product[categoryname])
SELECTEDVALUE(dim_product[categoryname], "Multiple")
SELECTEDVALUE(dim_date[year], BLANK())
```

**Rust API:**
```rust
// Without alternate — returns NULL when multiple values
let val = expr::selected_value(expr::col("categoryname"), None);

// With alternate
let val = expr::selected_value(
    expr::col("categoryname"),
    Some(expr::lit_str("Multiple")),
);
```

**SQL generated:** `CASE WHEN COUNT(DISTINCT "col") = 1 THEN MIN("col") ELSE alternate END`

### FIRST

**Return the first value of a column ordered by another expression.**

A simplified version of the DAX FIRST function. The DAX parameters `axis`, `blanks`, and `reset` are not supported — these are visual calculation concepts that don't apply to the Calcula Engine's tabular computation model.

**Text syntax:**
```
FIRST(fact_sales[orderdate], ORDER BY fact_sales[orderdate])
FIRST(dim_employee[name], dim_employee[hire_date])
```

The `ORDER BY` keywords are optional — the second argument is always interpreted as the sort expression.

**Rust API:**
```rust
let first_date = expr::first_value(
    expr::col("orderdate"),
    expr::col("orderdate"),
);
```

**SQL generated:** `FIRST_VALUE("col" ORDER BY "sort_col")`

**As a lookup resolution expression:**

FIRST is particularly useful for lookup columns where you want to pick a deterministic value from a 1:many relationship:

```rust
Column::new("product_name", DataType::String)
    .with_lookup_resolution("FIRST(product_name, ORDER BY sort_order)")
```

---

## Context Manipulation Functions

These functions modify the **evaluation context** — the set of active filters applied when computing a measure. Context functions wrap data expressions and are evaluated inside-out.

### keep()

**Add filter conditions to the evaluation context.**

All filters AND with the current context. If the outer context already filters on the same column, both conditions apply (narrowing the result).

**Conceptual syntax:**
```
Revenue_2024 = sum(keep(Sales.Amount, Calendar.Year = 2024))

// Multiple filters (all AND'd)
Revenue_2024_US = sum(keep(Sales.Amount, Calendar.Year = 2024, Sales.Region = "US"))
```

**Rust API:**
```rust
use engine::expression::{self as expr, ComparisonOp, FilterPredicate};
use engine::AggregateOp;

let revenue_2024 = expr::agg(
    AggregateOp::Sum,
    expr::keep(
        expr::col("amount"),
        vec![FilterPredicate::new("Calendar", "Year", ComparisonOp::Equal, "2024")],
    ),
);
```

**Comparison operators available:**

| Operator | Rust Enum | SQL |
|----------|-----------|-----|
| `=` | `ComparisonOp::Equal` | `=` |
| `!=` | `ComparisonOp::NotEqual` | `!=` |
| `>` | `ComparisonOp::GreaterThan` | `>` |
| `>=` | `ComparisonOp::GreaterThanOrEqual` | `>=` |
| `<` | `ComparisonOp::LessThan` | `<` |
| `<=` | `ComparisonOp::LessThanOrEqual` | `<=` |

### clear()

**Remove filters on specific dimensions from the evaluation context.**

Use `clear()` when you want to ignore a particular filter that came from the query context (e.g., the current group-by row or a slicer).

**Conceptual syntax:**
```
// Ignore whatever Region filter the query applies
TotalAllRegions = sum(clear(Sales.Amount, Sales.Region))

// Clear all filters on the Calendar table
TotalAllTime = sum(clear(Sales.Amount, Calendar))
```

**Rust API:**
```rust
use engine::expression::{self as expr};
use engine::{AggregateOp, ClearTarget};

// Clear a specific column
let total_all_regions = expr::agg(
    AggregateOp::Sum,
    expr::clear(
        expr::col("amount"),
        vec![ClearTarget::Column {
            table: "Sales".into(),
            column: "Region".into(),
        }],
    ),
);

// Clear an entire table's filters
let total_all_time = expr::agg(
    AggregateOp::Sum,
    expr::clear(
        expr::col("amount"),
        vec![ClearTarget::Table("Calendar".into())],
    ),
);
```

### reset()

**Remove ALL filters from the evaluation context.**

Evaluates the inner expression against the full, unfiltered dataset. Useful for computing totals or percentages.

**Conceptual syntax:**
```
GrandTotal = sum(reset(Sales.Amount))
```

**Rust API:**
```rust
let grand_total = expr::agg(
    AggregateOp::Sum,
    expr::reset(expr::col("amount")),
);
```

### traverse()

**Force explicit relationship traversal.**

Overrides model-level propagation settings for this specific evaluation. Use when relationships have `FilterPropagation::None` or when you need a specific multi-hop path.

**Conceptual syntax:**
```
// Single hop
RedRevenue = sum(keep(traverse(Sales.Amount, Sales -> Products), Products.Color = "Red"))

// Multi-hop
X = sum(keep(traverse(Sales.Amount, Sales -> Warehouse -> Products), Products.Color = "Red"))
```

**Rust API:**
```rust
use engine::expression::{self as expr, RelationshipPath, FilterPredicate, ComparisonOp};
use engine::AggregateOp;

let red_revenue = expr::agg(
    AggregateOp::Sum,
    expr::keep(
        expr::traverse(
            expr::col("amount"),
            RelationshipPath::new(vec!["Sales", "Products"]),
        ),
        vec![FilterPredicate::new("Products", "Color", ComparisonOp::Equal, "Red")],
    ),
);
```

### Named Contexts (CONTEXT expression family)

**Reusable, named filter configurations.**

Named contexts define composable sets of filter operations that can be referenced by name in measure expressions. They are defined at the model level — either programmatically or via the `CONTEXT` expression syntax — and referenced as bare names in measure context arguments.

**Defining contexts (text syntax):**
```
CONTEXT ctx_bikes = KEEP(dim_product, dim_product[categoryname] = "Bikes")
CONTEXT ctx_2024 = KEEP(dim_date, dim_date[year] = 2024)
CONTEXT ctx_bikes_2024 = ctx_2024, KEEP(dim_product, dim_product[categoryname] = "Bikes")
CONTEXT ctx_no_region = CLEAR(Sales[region])
CONTEXT ctx_fresh = RESET()
CONTEXT ctx_no_inner_date = CLEAR_INNER(dim_date)
CONTEXT ctx_no_outer_region = CLEAR_OUTER(Sales[region])
CONTEXT ctx_derived = ctx_bikes, KEEP(dim_date, dim_date[year] = 2024)
```

Context operations available in definitions:
- `KEEP(table, predicates...)` — add filter conditions
- `CLEAR(table)` / `CLEAR(table[column])` — remove filters
- `CLEAR_INNER(...)` / `CLEAR_OUTER(...)` — source-specific clearing
- `RESET()` / `RESET_INNER()` / `RESET_OUTER()` — remove all filters
- Bare name (e.g., `ctx_2024`) — inherit all operations from another context

**Using contexts in measures (bare name reference):**
```
DEFINE Revenue_Bikes = SUM(fact_sales[linetotal], ctx_bikes)
DEFINE Revenue_Bikes_2024 = SUM(fact_sales[linetotal], ctx_bikes_2024)
DEFINE Revenue_All_Regions = SUM(fact_sales[linetotal], ctx_no_region)
```

Named contexts are referenced as **bare names** — no wrapping function needed. The resolver tries table variables first, then named contexts, so context names must not collide with table or table variable names.

**Combining with other context operations:**
```
DEFINE Revenue = SUM(fact_sales[linetotal], ctx_bikes, KEEP(dim_date, dim_date[year] = 2024))
```

**Parser API:**
```rust
use engine::parse_context;

let ctx = parse_context(
    "ctx_bikes_2024",
    r#"ctx_2024, KEEP(dim_product, dim_product[categoryname] = "Bikes")"#,
).unwrap();
assert_eq!(ctx.name(), "ctx_bikes_2024");
assert_eq!(ctx.operations().len(), 2); // Inherit + Keep
```

**Rust API (programmatic):**
```rust
use engine::*;
use engine::expression::{self as expr, ComparisonOp, FilterPredicate};

// Define context at model level
let ctx = ContextDefinition::new("bikes_2024", vec![
    ContextOp::Keep(vec![
        FilterPredicate::new("Calendar", "Year", ComparisonOp::Equal, "2024"),
        FilterPredicate::new("Products", "Category", ComparisonOp::Equal, "Bikes"),
    ]),
]);

// Add to model and reference by bare name
let model = DataModel::builder()
    .add_table(sales_table)
    .add_context(ctx)
    .add_measure(expression_measure(
        "BikeRevenue",
        "Sales",
        // Bare context name reference via keep_vars
        expr::keep_vars(
            expr::agg(AggregateOp::Sum, expr::col("amount")),
            vec!["bikes_2024".to_string()],
        ),
    ))
    .build()?;
```

### using()

**Apply a named context definition (explicit form).**

The `USING()` function is the explicit way to apply a named context. Bare context names (see above) are the preferred shorthand. Both produce the same result.

**Text syntax:**
```
SUM(Sales[amount], USING(my_context))
// Equivalent to:
SUM(Sales[amount], my_context)
```

**Rust API:**
```rust
let expr = expr::agg(AggregateOp::Sum, expr::using(expr::col("amount"), "bikes_2024"));
```

### VAR / RETURN (Scalar Variables)

**Multi-step calculations with named intermediates.**

VAR/RETURN enables complex measures to define named intermediate values and a final result. Variable bindings can reference earlier bindings. During SQL generation, all VAR references are **inlined** — substituted with their defining expressions.

**Text syntax:**
```
VAR TotalSales = SUM(fact_sales[linetotal])
VAR TotalCost = SUM(fact_sales[unitprice] * fact_sales[orderqty])
RETURN DIVIDE(TotalSales - TotalCost, TotalSales)
```

```
VAR Revenue = SUM(fact_sales[linetotal])
VAR Orders = COUNT(fact_sales[salesorderdetailid])
RETURN ROUND(DIVIDE(Revenue, Orders), 2)
```

Variables are case-insensitive (`var`/`VAR`, `return`/`RETURN`). Variable names cannot be `VAR` or `RETURN`.

Each binding can include context operations:
```
VAR BikeSales = SUM(fact_sales[linetotal], ctx_bikes)
VAR TotalSales = SUM(fact_sales[linetotal])
RETURN DIVIDE(BikeSales, TotalSales)
```

Chained references (later VARs reference earlier ones):
```
VAR Revenue = SUM(fact_sales[linetotal])
VAR DoubleRevenue = Revenue * 2
RETURN DoubleRevenue + 100
```

**Parser API:**
```rust
use engine::parse_measure_expression;

let expr = parse_measure_expression(
    "VAR total = SUM(Sales[amount]) VAR cnt = COUNT(Sales[id]) RETURN DIVIDE(total, cnt)"
).unwrap();
// Produces Expression::Block with 2 bindings and a SafeDivide result.
```

**Rust API (programmatic):**
```rust
let pct_of_total = expression_measure(
    "PctOfTotal",
    "Sales",
    expr::block(
        vec![
            ("actual".into(), expr::agg(AggregateOp::Sum, expr::col("amount"))),
            ("total".into(), expr::agg(AggregateOp::Sum, expr::reset(expr::col("amount")))),
        ],
        expr::col("actual").divide(expr::col("total")),
    ),
);
```

**SQL generation:** VAR bindings are inlined into the result expression before SQL generation. `VAR a = SUM(x) VAR b = a * 2 RETURN b + 1` generates SQL: `((SUM("x") * 2) + 1)`.

### GVAR / RETURN (Query-Scoped Variables)

**A variable evaluated once per query, ignoring the row/group axis.**

A `GVAR` (query-scoped variable) is declared like a `VAR` but is evaluated **once per query context** rather than once per group / visual row. It is computed against the query's **outer filter/slicer context** (page filters, slicers, multi-select and cross-column OR slicers) and the **active row-level-security role**, but **without** the group-by axis. Its scalar value is then substituted as a constant everywhere it is referenced.

This is the natural tool for "compare each row to a whole-context value" — e.g. a threshold, a max date, or a grand total — where recomputing per row would be both wasteful and wrong:

```
GVAR maxDate = MAX(DimDate[Date])
RETURN CALCULATE(SUM(FactSales[Amount]), FactOrderDate[Date] > maxDate)
```

`maxDate` is computed a single time for the whole query (not once per visual row), so every row filters against the same boundary.

**"% of grand total" — the canonical example:**
```
GVAR grand = SUM(Sales[amount])          -- once per query = the whole-context total
RETURN DIVIDE(SUM(Sales[amount]), grand) -- each group / the total
```
Written with a plain `VAR grand = …`, `grand` would be re-evaluated per group and the ratio would be `1.0` everywhere. With `GVAR`, each group shows its share of the total.

**Slicer-respecting, not an absolute constant.** A `GVAR` still sees the query's slicers — it just drops the row/group axis. With a slicer restricting the data (e.g. one product), `grand` reflects that slice, not the unfiltered total. (This is what distinguishes a `GVAR` from a model-level [global variable](#global-variables), which is inlined statically and re-evaluated per row.)

**Rules:**
- `GVAR` and `VAR` may be interleaved before `RETURN`; they are routed by keyword, not source order.
- A `VAR` **may** reference a `GVAR` (the GVAR is resolved to a literal first). A `GVAR` may reference an **earlier** `GVAR`, but **not** a `VAR` (a query-scoped value cannot depend on a per-row local) and **not** a later/self `GVAR`.
- A `GVAR` binding must be a **scalar** — `QUERY`, window (`WINDOW`/`OFFSET`/`INDEX`/`RANK`) and time-intelligence expressions are rejected.
- A `GVAR` binding may reference another measure (`GVAR total = [Revenue]`), an earlier `GVAR`, or a constant expression of earlier `GVAR`s (`GVAR half = total / 2`).
- `GVAR` is a measure feature only (not calculated columns / model global variables) and is resolved by the query engine facade (`Engine::query` / `query_with_meta`). A `GVAR` that resolves to `BLANK` (e.g. an aggregate over an empty context) propagates `BLANK` — it is not an error.
- **Not yet supported (fails closed):** `GVAR` together with a calculation group; `GVAR` under **multiple active RLS roles** (query under a single role); and evaluation through `query_auto_tier` / `query_explained` / `query_auto_refresh` (use `Engine::query` / `query_with_meta`).

### QUERY-in-VAR (Two-Stage Aggregation)

**Aggregate of aggregates using intermediate grouped tables.**

QUERY materializes an intermediate grouped table inside a VAR binding, then the RETURN expression aggregates over it. This enables "aggregate of aggregates" patterns like average monthly revenue, peak quarter, or count of active months — patterns that require two levels of aggregation.

**Text syntax:**
```
VAR monthly = QUERY(
  SUM(fact_sales[linetotal]) AS revenue
  BY dim_date[year], dim_date[month]
)
RETURN AVG(monthly[revenue])
```

The QUERY produces a table with the specified GROUP BY columns plus the aliased aggregate column(s). The RETURN expression can then aggregate over this intermediate table using standard aggregation functions.

**Multiple aggregates in a single QUERY:**
```
VAR monthly = QUERY(
  SUM(fact_sales[linetotal]) AS revenue,
  COUNT(fact_sales[salesorderdetailid]) AS orders
  BY dim_date[year], dim_date[month]
)
RETURN DIVIDE(AVG(monthly[revenue]), AVG(monthly[orders]))
```

**QUERY with named context (filtered source):**

A named context on the inner aggregate filters the source data BEFORE the QUERY groups it. For example, "average monthly bikes revenue" means: sum only bike sales per month, then average across months.

```
VAR monthly = QUERY(
  SUM(fact_sales[linetotal], ctx_bikes) AS revenue
  BY dim_date[year], dim_date[month]
)
RETURN AVG(monthly[revenue])
```

**QUERY with KEEP on intermediate table:**

KEEP can filter the intermediate table produced by QUERY, letting you slice the two-stage aggregation (e.g., "only Q1 months"):

```
VAR monthly = QUERY(
  SUM(fact_sales[linetotal]) AS revenue
  BY dim_date[year], dim_date[month], dim_date[quarter]
)
RETURN AVG(monthly[revenue], KEEP(monthly, monthly[quarter] = 1))
```

**Cross-dimension GROUP BY (context propagation):**

When the outer query groups by a dimension NOT in the QUERY's BY clause, the engine injects that dimension into the QUERY's materialization. This produces correct per-group values:

```
-- Measure definition (no category in BY):
VAR monthly = QUERY(
  SUM(fact_sales[linetotal]) AS revenue
  BY dim_date[year], dim_date[month]
)
RETURN AVG(monthly[revenue])

-- When queried with GROUP BY dim_product[categoryname]:
-- Engine injects categoryname into the QUERY, producing
-- per-category monthly totals, then AVG per category.
```

**Common patterns:**
```
-- Average monthly revenue
VAR m = QUERY(SUM(t[amount]) AS rev BY dim_date[year], dim_date[month])
RETURN AVG(m[rev])

-- Peak month
VAR m = QUERY(SUM(t[amount]) AS rev BY dim_date[year], dim_date[month])
RETURN MAX(m[rev])

-- Number of active months
VAR m = QUERY(SUM(t[amount]) AS rev BY dim_date[year], dim_date[month])
RETURN COUNTROWS(m)

-- Peak-to-trough ratio
VAR m = QUERY(SUM(t[amount]) AS rev BY dim_date[year], dim_date[month])
RETURN DIVIDE(MAX(m[rev]), MIN(m[rev]))

-- Rounded average quarterly revenue
VAR q = QUERY(SUM(t[amount]) AS rev BY dim_date[year], dim_date[quarter])
RETURN ROUND(AVG(q[rev]), 0)
```

**Parser API:**
```rust
use engine::parse_measure_expression;

let expr = parse_measure_expression(
    "VAR monthly = QUERY(SUM(fact_sales[linetotal]) AS revenue BY dim_date[year], dim_date[month]) RETURN AVG(monthly[revenue])"
).unwrap();
// Produces Expression::Block with a Query binding and AVG result.
```

**Rust API (programmatic):**
```rust
use engine::expression::{self as expr};
use engine::AggregateOp;

let avg_monthly = expr::block(
    vec![(
        "monthly".into(),
        expr::query_expr(
            vec![(expr::agg(AggregateOp::Sum, expr::col("linetotal")), "revenue".into())],
            vec![("dim_date".into(), "year".into()), ("dim_date".into(), "month".into())],
        ),
    )],
    expr::agg(AggregateOp::Average, expr::qualified_col("monthly", "revenue")),
);
```

### clear_inner() / clear_outer()

**Source-specific filter clearing.**

Filters have two sources: **inner** (group-by/matrix row context) and **outer** (query-level slicer filters). `clear()` and `reset()` target both sources. These variants target only one:

| Function | Clears | Keeps |
|----------|--------|-------|
| `clear_inner(expr, targets)` | Group-by filters on targets | Query-level filters |
| `clear_outer(expr, targets)` | Query-level filters on targets | Group-by filters |
| `reset_inner(expr)` | All group-by filters | Query-level filters |
| `reset_outer(expr)` | All query-level filters | Group-by filters |

**Rust API:**
```rust
// Ignore the group-by context on Region, but respect slicer filters
let expr = expr::agg(
    AggregateOp::Sum,
    expr::clear_inner(
        expr::col("amount"),
        vec![ClearTarget::Column { table: "Sales".into(), column: "Region".into() }],
    ),
);

// Ignore all slicer/page filters
let expr = expr::agg(AggregateOp::Sum, expr::reset_outer(expr::col("amount")));
```

### Table Variables

**Named, pre-filtered table references.**

Table variables define a subset of a table's rows. They are composable — a variable can be based on another variable. Defined at the model level.

**Text syntax (using KEEP):**
```
VAR bikes = KEEP(dim_product, dim_product[categoryname] = "Bikes")
VAR road_bikes = KEEP(bikes, dim_product[productline] = "R")
```

Table variables reuse the `KEEP` function syntax. The first argument is the source table (or another variable), followed by filter predicates. The `parse_table_variable()` function parses this syntax and returns the source name and filters.

**Using table variables in measures:**
```
DEFINE Bike Count = DISTINCTCOUNT(bikes[productid])
DEFINE Road Bike Count = DISTINCTCOUNT(road_bikes[productid])
```

When a measure references a table variable via bracket notation (e.g., `bikes[productid]`), the engine automatically applies the variable's pre-defined filters during evaluation.

**Parser API:**
```rust
use engine::parse_table_variable;

let (source, filters) = parse_table_variable(
    r#"KEEP(dim_product, dim_product[categoryname] = "Bikes")"#,
).unwrap();
assert_eq!(source, "dim_product");
assert_eq!(filters.len(), 1);
```

**Rust API (programmatic):**
```rust
use engine::*;
use engine::expression::{self as expr, ComparisonOp, FilterPredicate};

let premium = TableVariable::new(
    "premium",
    "Products",
    vec![FilterPredicate::new("Products", "category", ComparisonOp::Equal, "Premium")],
);

// Add to model
let model = DataModel::builder()
    .add_table(products_table)
    .add_table_variable(premium)
    .build()?;
```

Reference columns via `qualified_col()`:
```rust
// premium.category — resolves to Products.category with variable filters applied
expr::qualified_col("premium", "category")
```

### keep_in()

**IN-membership filter.**

Tests whether a column's values appear in a table variable's column. Generates a SQL `IN (SELECT ...)` subquery.

**Conceptual syntax:**
```
PremiumRevenue = sum(keep_in(Sales.Amount, Sales.ProductId IN premium.Id))
```

**Rust API:**
```rust
use engine::expression::{self as expr, InPredicate};
use engine::AggregateOp;

let revenue = expr::agg(
    AggregateOp::Sum,
    expr::keep_in(
        expr::col("amount"),
        vec![InPredicate::new("Sales", "product_id", "premium", "id")],
    ),
);
```

The `InPredicate` resolves the table variable chain to its base table and accumulated filters at evaluation time.

---

## Composition Patterns

Context functions compose by nesting. Read from inside-out to understand the evaluation order.

### Override a Filter

To replace an outer filter (instead of narrowing), `clear()` first then `keep()`:

```
// If query context has Year = 2023, this replaces it with 2024
AlwaysCurrentYear = sum(keep(clear(Sales.Amount, Calendar.Year), Calendar.Year = 2024))
```

```rust
let always_2024 = expr::agg(
    AggregateOp::Sum,
    expr::keep(
        expr::clear(
            expr::col("amount"),
            vec![ClearTarget::Column {
                table: "Calendar".into(),
                column: "Year".into(),
            }],
        ),
        vec![FilterPredicate::new("Calendar", "Year", ComparisonOp::Equal, "2024")],
    ),
);
```

### Percentage of Region Total

```
PctOfRegion = {
    actual = sum(Sales.Amount)
    region_total = sum(clear(Sales.Amount, Products.Category))
    return actual / region_total
}
```

### Cross-Table Filtering

With auto-propagation (default for ManyToOne relationships), filters on dimension tables automatically reach the fact table:

```
// Products.Color filter auto-propagates to Sales through the relationship
RedRevenue = sum(keep(Sales.Amount, Products.Color = "Red"))
```

Without auto-propagation, use `traverse()`:

```
RedRevenue = sum(keep(traverse(Sales.Amount, Sales -> Products), Products.Color = "Red"))
```

### Composable Named Contexts

Contexts can inherit from other contexts:

```rust
let ctx_2024 = ContextDefinition::new("ctx_2024", vec![
    ContextOp::Keep(vec![
        FilterPredicate::new("Calendar", "Year", ComparisonOp::Equal, "2024"),
    ]),
]);

let ctx_bikes_2024 = ContextDefinition::new("ctx_bikes_2024", vec![
    ContextOp::Inherit("ctx_2024".into()),
    ContextOp::Keep(vec![
        FilterPredicate::new("Products", "Category", ComparisonOp::Equal, "Bikes"),
    ]),
]);
```

### Context with Reset

Named contexts can also clear or reset filters:

```rust
let ctx_all_regions = ContextDefinition::new("all_regions", vec![
    ContextOp::Clear(vec![ClearTarget::Column {
        table: "Sales".into(),
        column: "Region".into(),
    }]),
]);
```

---

## Relationship Propagation

Relationships declare how filters propagate between tables:

| Mode | Behavior | Default for |
|------|----------|-------------|
| `FilterPropagation::Auto` | Dimension filters auto-propagate to fact table | `ManyToOne` |
| `FilterPropagation::None` | No auto-propagation; requires `traverse()` | `OneToMany`, `OneToOne` |
| `FilterPropagation::Both` | Bidirectional propagation | — |

Set explicitly when creating relationships:

```rust
let rel = Relationship::many_to_one(
    "Sales_Products", "Sales", "product_id", "Products", "id",
).with_propagation(FilterPropagation::Both);
```

---

## Execution Model

When a measure is evaluated in a query context (with group-by and filters):

1. **Start with outer context** — query-level filters + current group-by row
2. **Evaluate inside-out** — each context function modifies the active context:
   - `keep()` → AND conditions into context
   - `clear()` → remove specific dimension filters
   - `reset()` → remove all filters
   - `traverse()` → set explicit relationship path
   - `using()` → expand and apply named context operations
3. **Resolve relationships** — cross-table filters resolved via model propagation settings (or explicit `traverse()`)
4. **Aggregate** — compute the aggregation over the resulting filtered rows

This is deterministic and explicit: reading the expression from inside-out tells you exactly what happens at each step.

---

## Pushdown Behavior

The query planner considers context operations when deciding execution strategy:

| Pattern | Execution |
|---------|-----------|
| Simple `AGG(column)` or `COUNTROWS(table)` on single table | Pushed to data source |
| Conditional/math wrapping aggregates (`DIVIDE`, `IF`, `ROUND`, etc.) | Computed locally |
| Any measure with context ops (`keep`, `clear`, `reset`, `keep_in`, `clear_inner`, `clear_outer`, `reset_inner`, `reset_outer`, `traverse`, `using`, `block`) | Computed locally |
| Multi-table queries | Fetched from sources, joined and aggregated locally |

Measures with context operations, conditional logic, or math functions always force local aggregation to ensure correct evaluation.

---

## Expression Builder Reference

All builder functions are in the `engine::expression` module (or `engine_core::compute::expression`):

| Function | Signature | Description |
|----------|-----------|-------------|
| `col(name)` | `fn col(&str) -> Expression` | Column reference |
| `lit(value)` | `fn lit(f64) -> Expression` | Float literal |
| `lit_int(value)` | `fn lit_int(i64) -> Expression` | Integer literal |
| `agg(op, expr)` | `fn agg(AggregateOp, Expression) -> Expression` | Aggregate |
| `keep(expr, filters)` | `fn keep(Expression, Vec<FilterPredicate>) -> Expression` | Add filters |
| `clear(expr, targets)` | `fn clear(Expression, Vec<ClearTarget>) -> Expression` | Remove filters |
| `reset(expr)` | `fn reset(Expression) -> Expression` | Remove all filters |
| `traverse(expr, path)` | `fn traverse(Expression, RelationshipPath) -> Expression` | Explicit traversal |
| `using(expr, name)` | `fn using(Expression, impl Into<String>) -> Expression` | Apply named context |
| `clear_inner(expr, targets)` | `fn clear_inner(Expression, Vec<ClearTarget>) -> Expression` | Remove inner filters |
| `clear_outer(expr, targets)` | `fn clear_outer(Expression, Vec<ClearTarget>) -> Expression` | Remove outer filters |
| `reset_inner(expr)` | `fn reset_inner(Expression) -> Expression` | Remove all inner filters |
| `reset_outer(expr)` | `fn reset_outer(Expression) -> Expression` | Remove all outer filters |
| `keep_in(expr, preds)` | `fn keep_in(Expression, Vec<InPredicate>) -> Expression` | IN-membership filter |
| `keep_vars(expr, names)` | `fn keep_vars(Expression, Vec<String>) -> Expression` | Apply variables/contexts by name |
| `table_ref(name)` | `fn table_ref(impl Into<String>) -> Expression` | Table/variable reference |
| `qualified_col(tbl, col)` | `fn qualified_col(impl Into<String>, impl Into<String>) -> Expression` | Qualified column ref |
| `block(bindings, result)` | `fn block(Vec<(String, Expression)>, Expression) -> Expression` | Block expression |
| `count_rows()` | `fn count_rows() -> Expression` | COUNTROWS aggregate |
| `safe_divide(num, den, alt)` | `fn safe_divide(Expression, Expression, Option<Expression>) -> Expression` | Safe division |
| `if_expr(cond, t, f)` | `fn if_expr(Expression, Expression, Expression) -> Expression` | IF conditional |
| `switch(expr, cases, default)` | `fn switch(Expression, Vec<(Expression, Expression)>, Option<Expression>) -> Expression` | SWITCH multi-branch |
| `blank()` | `fn blank() -> Expression` | BLANK (NULL) value |
| `is_blank(expr)` | `fn is_blank(Expression) -> Expression` | Test for NULL |
| `coalesce(exprs)` | `fn coalesce(Vec<Expression>) -> Expression` | First non-NULL value |
| `compare(l, op, r)` | `fn compare(Expression, ComparisonOp, Expression) -> Expression` | Comparison expression |
| `and(l, r)` | `fn and(Expression, Expression) -> Expression` | Logical AND |
| `or(l, r)` | `fn or(Expression, Expression) -> Expression` | Logical OR |
| `not(expr)` | `fn not(Expression) -> Expression` | Logical NOT |
| `lit_str(s)` | `fn lit_str(impl Into<String>) -> Expression` | String literal |
| `scalar_fn(func, args)` | `fn scalar_fn(ScalarFunction, Vec<Expression>) -> Expression` | Math function call |
| `query_expr(aggs, group_by)` | `fn query_expr(Vec<(Expression, String)>, Vec<(String, String)>) -> Expression` | QUERY two-stage aggregation |
| `has_one_value(col)` | `fn has_one_value(Expression) -> Expression` | Test for single distinct value |
| `selected_value(col, alt)` | `fn selected_value(Expression, Option<Expression>) -> Expression` | Return value if single, else alternate |
| `first_value(col, order_by)` | `fn first_value(Expression, Expression) -> Expression` | First value by ordering |

**ScalarFunction variants:** `Abs`, `Round`, `RoundUp`, `RoundDown`, `Int`, `Trunc`, `Ceiling`, `Floor`, `Mod`, `Power`, `Sqrt`, `Ln`, `Log10`, `Sign`

Arithmetic methods on `Expression`:

| Method | Description |
|--------|-------------|
| `.add(other)` | `self + other` |
| `.subtract(other)` | `self - other` |
| `.multiply(other)` | `self * other` |
| `.divide(other)` | `self / other` |
