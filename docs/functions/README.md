# Calcula Engine — Function Reference

This directory contains the complete reference documentation for all functions supported by the Calcula Engine expression language.

## How to test functions

Edit `crates/engine/examples/measures.txt` and run:

```
cargo run -p engine --example run_measures
```

## Aggregation Functions

Functions that compute a single value from a column of data.

| Function | Description |
|----------|-------------|
| [SUM](SUM.md) | Adds all the values in a column |
| [COUNT](COUNT.md) | Counts the number of non-null values in a column |
| [AVG](AVG.md) | Returns the arithmetic mean of all values in a column |
| [MIN](MIN.md) | Returns the smallest value in a column |
| [MAX](MAX.md) | Returns the largest value in a column |
| [DISTINCTCOUNT](DISTINCTCOUNT.md) | Counts the number of distinct (unique) values in a column |
| [COUNTROWS](COUNTROWS.md) | Counts the total number of rows in a table (including NULLs) |

## Information Functions

Functions that inspect the current filter context.

| Function | Description |
|----------|-------------|
| [HASONEVALUE](HASONEVALUE.md) | Tests whether a column has exactly one distinct value in the current filter context |
| [SELECTEDVALUE](SELECTEDVALUE.md) | Returns the single value of a column if there is exactly one, otherwise returns an alternate |
| [FIRST](FIRST.md) | Returns the first value of a column ordered by another expression |

## Logical Functions

Functions that return boolean (TRUE/FALSE) values. Available both as functions and as operators.

| Function | Description |
|----------|-------------|
| [AND](AND.md) | Returns TRUE if both arguments are TRUE. Also available as operator: `a AND b` |
| [OR](OR.md) | Returns TRUE if either argument is TRUE. Also available as operator: `a OR b` |
| [NOT](NOT.md) | Negates a logical value. Also available as operator: `NOT a` |
| [TRUE](TRUE.md) | Returns the boolean value TRUE |
| [FALSE](FALSE.md) | Returns the boolean value FALSE |
| [XOR](XOR.md) | Returns TRUE when exactly one argument is TRUE (exclusive OR, Calcula extension) |

## Conditional Functions

Functions for branching logic and handling NULL values.

| Function | Description |
|----------|-------------|
| [IF](IF.md) | Evaluates a condition and returns one of two values |
| [SWITCH](SWITCH.md) | Evaluates an expression against a list of values and returns the matching result |
| [DIVIDE](DIVIDE.md) | Performs safe division, returning an alternate value on division by zero |
| [BLANK](BLANK.md) | Returns a blank (NULL) value |
| [ISBLANK](ISBLANK.md) | Tests whether an expression is BLANK (NULL) |
| [COALESCE](COALESCE.md) | Returns the first non-BLANK value from a list of expressions |

## Math Functions

Scalar math functions that operate on numeric values.

| Function | Description |
|----------|-------------|
| [ABS](ABS.md) | Returns the absolute value of a number |
| [ROUND](ROUND.md) | Rounds to a specified number of decimal places |
| [ROUNDUP](ROUNDUP.md) | Rounds away from zero |
| [ROUNDDOWN](ROUNDDOWN.md) | Rounds toward zero |
| [INT](INT.md) | Rounds down to the nearest integer |
| [TRUNC](TRUNC.md) | Truncates toward zero to specified decimal places |
| [CEILING](CEILING.md) | Rounds up to the nearest multiple of significance |
| [FLOOR](FLOOR.md) | Rounds down to the nearest multiple of significance |
| [MOD](MOD.md) | Returns the remainder after division |
| [POWER](POWER.md) | Raises a number to a power |
| [SQRT](SQRT.md) | Returns the square root of a number |
| [LN](LN.md) | Returns the natural logarithm (base e) |
| [LOG10](LOG10.md) | Returns the base-10 logarithm |
| [SIGN](SIGN.md) | Returns the sign of a number (-1, 0, or 1) |

## Text Functions

Functions that manipulate text strings.

| Function | Description |
|----------|-------------|
| [CONCATENATE](CONCATENATE.md) | Joins text strings (accepts arbitrary number of arguments) |
| [COMBINEVALUES](COMBINEVALUES.md) | Joins text strings with a delimiter |
| [EXACT](EXACT.md) | Compares two text strings (case-sensitive) |
| [FIND](FIND.md) | Returns the position of text within text (case-sensitive) |
| [FIXED](FIXED.md) | Rounds a number and returns it as text |
| [LEFT](LEFT.md) | Returns characters from the start of a text string |
| [LEN](LEN.md) | Returns the number of characters in a text string |
| [LOWER](LOWER.md) | Converts text to lowercase |
| [MID](MID.md) | Returns characters from the middle of a text string |
| [REPLACE](REPLACE.md) | Replaces part of a text string by position |
| [REPT](REPT.md) | Repeats text a given number of times |
| [RIGHT](RIGHT.md) | Returns characters from the end of a text string |
| [SEARCH](SEARCH.md) | Returns the position of text within text (case-insensitive) |
| [SUBSTITUTE](SUBSTITUTE.md) | Replaces occurrences of text with new text |
| [TRIM](TRIM.md) | Removes leading and trailing spaces |
| [UNICHAR](UNICHAR.md) | Returns the Unicode character for a code point |
| [UNICODE](UNICODE.md) | Returns the Unicode code point of the first character |
| [UPPER](UPPER.md) | Converts text to uppercase |
| [VALUE](VALUE.md) | Converts a text string to a number |
| [LTRIM](LTRIM.md) | Removes leading characters (Calcula extension) |
| [RTRIM](RTRIM.md) | Removes trailing characters (Calcula extension) |
| [LPAD](LPAD.md) | Left-pads a text string to a specified length (Calcula extension) |
| [RPAD](RPAD.md) | Right-pads a text string to a specified length (Calcula extension) |
| [REVERSE](REVERSE.md) | Reverses the order of characters in a text string (Calcula extension) |
| [SPLIT](SPLIT.md) | Splits text by a delimiter and returns a specified part (Calcula extension) |

## Context Functions

Functions that modify the evaluation context — the set of filters applied when computing a measure. Context functions are used as the second argument to an aggregation function.

| Function | Description |
|----------|-------------|
| [KEEP](KEEP.md) | Adds filter conditions to the evaluation context |
| [CLEAR](CLEAR.md) | Removes filters on a specific table or column |
| [RESET](RESET.md) | Removes all filters from the evaluation context |
| [USERELATIONSHIP](USERELATIONSHIP.md) | Activates an inactive relationship for the measure's evaluation |

### Source-Specific Context Functions

These are advanced variants of CLEAR and RESET that target only one filter source. Filters come from two sources: **inner** (group-by context) and **outer** (query-level slicer filters).

| Function | Clears | Keeps |
|----------|--------|-------|
| [CLEAR_INNER](CLEAR_INNER.md) | Group-by filters on specified targets | Query-level filters |
| [CLEAR_OUTER](CLEAR_OUTER.md) | Query-level filters on specified targets | Group-by filters |
| [RESET_INNER](RESET_INNER.md) | All group-by filters | Query-level filters |
| [RESET_OUTER](RESET_OUTER.md) | All query-level filters | Group-by filters |

## Two-Stage Aggregation

| Function | Description |
|----------|-------------|
| [QUERY](QUERY.md) | Materializes an intermediate grouped table for two-stage aggregation (aggregate of aggregates) |

## Table Variables

Table variables are pre-filtered subsets of tables, defined using `KEEP` syntax:

```
VAR bikes = KEEP(dim_product, dim_product[categoryname] = "Bikes")
VAR road_bikes = KEEP(bikes, dim_product[productline] = "R")
```

Variables are composable — a variable can reference another variable as its source. Use bracket notation to reference variable columns in measures:

```
DEFINE Bike Count = DISTINCTCOUNT(bikes[productid])
```

See [KEEP](KEEP.md) for the filter syntax and the [expression language reference](../expression-language.md) for details.

## Named Contexts

Named contexts are reusable, composable filter configurations defined at the model level. They are referenced as **bare names** in measure context arguments — no `USING()` wrapper needed.

```
CONTEXT ctx_bikes = KEEP(dim_product, dim_product[categoryname] = "Bikes")
CONTEXT ctx_2024 = KEEP(dim_date, dim_date[year] = 2024)
CONTEXT ctx_bikes_2024 = ctx_2024, KEEP(dim_product, dim_product[categoryname] = "Bikes")

DEFINE Revenue Bikes = SUM(fact_sales[linetotal], ctx_bikes)
DEFINE Revenue Bikes 2024 = SUM(fact_sales[linetotal], ctx_bikes_2024)
```

Context names must not collide with table or table variable names. See the [expression language reference](../expression-language.md) for the full context definition syntax.

## Scalar Variables (VAR / RETURN)

VAR/RETURN defines named intermediate values within a measure expression:

```
VAR Revenue = SUM(fact_sales[linetotal])
VAR Orders = COUNT(fact_sales[salesorderdetailid])
RETURN ROUND(DIVIDE(Revenue, Orders), 2)
```

Variables can reference earlier variables. Each binding can include its own context operations. See the [expression language reference](../expression-language.md) for details.

## Arithmetic Operators

Standard arithmetic operators are supported between expressions:

| Operator | Description | Example |
|----------|-------------|---------|
| `+` | Addition | `SUM(t[a]) + SUM(t[b])` |
| `-` | Subtraction | `SUM(t[a]) - SUM(t[b])` |
| `*` | Multiplication | `SUM(t[price] * t[qty])` |
| `/` | Division | `SUM(t[a]) / COUNT(t[b])` |

Operator precedence follows standard math rules: `*` and `/` bind tighter than `+` and `-`. Use parentheses to override: `(SUM(t[a]) - SUM(t[b])) * 100`.

## Column References

Columns are referenced using bracket notation:

```
table[column]
```

The table name is always required to avoid ambiguity. Examples:

```
fact_sales[linetotal]
dim_date[year]
dim_product[categoryname]
```

## Quick Examples

```
// Simple aggregations
DEFINE Revenue = SUM(fact_sales[linetotal])
DEFINE Orders = COUNT(fact_sales[salesorderdetailid])
DEFINE Avg Price = AVG(fact_sales[unitprice])
DEFINE TotalRows = COUNTROWS(fact_sales)

// Safe division and math
DEFINE AvgOrder = DIVIDE(SUM(fact_sales[linetotal]), COUNT(fact_sales[salesorderdetailid]))
DEFINE RoundedAvg = ROUND(DIVIDE(SUM(fact_sales[linetotal]), COUNTROWS(fact_sales)), 2)
DEFINE SafeRevenue = COALESCE(SUM(fact_sales[linetotal]), 0)

// Conditional logic
DEFINE Tier = IF(SUM(fact_sales[linetotal]) > 1000000, "High", "Low")
DEFINE Label = SWITCH(INT(DIVIDE(SUM(fact_sales[orderqty]), 1000)), 0, "Small", 1, "Medium", "Large")

// Context operations
DEFINE Rev 2014 = SUM(fact_sales[linetotal], KEEP(dim_date, dim_date[year] = 2014))
DEFINE Rev All Time = SUM(fact_sales[linetotal], CLEAR(dim_date))
DEFINE Grand Total = SUM(fact_sales[linetotal], RESET())

// Relationship overrides
DEFINE Ship Revenue = SUM(fact_sales[linetotal], USERELATIONSHIP("Sales_Dates_Ship"))

// Queries
QUERY: Revenue, Rev 2014 BY dim_product[categoryname]
QUERY: Revenue BY dim_date[year]
```
