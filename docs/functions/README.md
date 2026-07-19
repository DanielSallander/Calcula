# Calcula Engine — Function Reference

This directory contains the complete reference documentation for all functions supported by the Calcula Engine expression language. Each function lives in a subfolder named after its category (inspired by the Power BI / DAX function categories, adapted to Calcula's own concepts).

| Category | Contents |
|----------|----------|
| [Aggregation Functions](Aggregation%20Functions/) | Reduce a column to a single value (SUM, COUNT, …) |
| [Statistical Functions](Statistical%20Functions/) | Statistical measures over a column (MEDIAN, STDEV, …) |
| [Logical Functions](Logical%20Functions/) | Boolean logic (AND, OR, NOT, …) |
| [Conditional Functions](Conditional%20Functions/) | Branching and NULL handling (IF, SWITCH, COALESCE, …) |
| [Math Functions](Math%20Functions/) | Scalar math (ABS, ROUND, POWER, …) |
| [Date and Time Functions](Date%20and%20Time%20Functions/) | Date parts and date arithmetic (YEAR, DATEADD, …) |
| [Text Functions](Text%20Functions/) | String manipulation (LEFT, SUBSTITUTE, FORMAT, …) |
| [Time Intelligence Functions](Time%20Intelligence%20Functions/) | Shifts and accumulations over the date table (YTD, PRIORYEAR, …) |
| [Information Functions](Information%20Functions/) | Inspect the current filter context (HASONEVALUE, ISFILTERED, …) |
| [Context Functions](Context%20Functions/) | Modify the evaluation context (KEEP, CLEAR, RESET, …) |
| [Relationship and Hierarchy Functions](Relationship%20and%20Hierarchy%20Functions/) | Cross-table lookups and parent-child paths (RELATED, PATH, …) |
| [Window Functions](Window%20Functions/) | Sliding windows, offsets, and ranking (WINDOW, RANK, …) |
| [Iterator Functions](Iterator%20Functions/) | Row-context iteration (ITERATE, THISROW) |
| [Table Functions](Table%20Functions/) | Intermediate table materialization (QUERY) |
| [Calculation Group Functions](Calculation%20Group%20Functions/) | Functions used inside calculation-item expressions (SELECTEDMEASURE) |

## How to test functions

Edit `crates/engine/examples/measures.txt` and run:

```
cargo run -p engine --example run_measures
```

## Aggregation Functions

Functions that compute a single value from a column of data.

| Function | Description |
|----------|-------------|
| [SUM](Aggregation%20Functions/SUM.md) | Adds all the values in a column |
| [COUNT](Aggregation%20Functions/COUNT.md) | Counts the number of non-null values in a column |
| [AVG](Aggregation%20Functions/AVG.md) | Returns the arithmetic mean of all values in a column |
| [MIN](Aggregation%20Functions/MIN.md) | Returns the smallest value in a column |
| [MAX](Aggregation%20Functions/MAX.md) | Returns the largest value in a column |
| [DISTINCTCOUNT](Aggregation%20Functions/DISTINCTCOUNT.md) | Counts the number of distinct (unique) values in a column |
| [COUNTROWS](Aggregation%20Functions/COUNTROWS.md) | Counts the total number of rows in a table (including NULLs) |
| [COUNTIF](Aggregation%20Functions/COUNTIF.md) | Counts rows where a condition is true |
| [ANY_VALUE](Aggregation%20Functions/ANY_VALUE.md) | Returns an arbitrary value from the group |
| [LISTAGG](Aggregation%20Functions/LISTAGG.md) | Concatenates values into a delimited string |
| [MAX_BY](Aggregation%20Functions/MAX_BY.md) | Returns the value from the row with the maximum of another column |
| [MIN_BY](Aggregation%20Functions/MIN_BY.md) | Returns the value from the row with the minimum of another column |

## Statistical Functions

Statistical measures computed over a column of data.

| Function | Description |
|----------|-------------|
| [MEDIAN](Statistical%20Functions/MEDIAN.md) | Returns the median (50th percentile) of values |
| [PERCENTILE](Statistical%20Functions/PERCENTILE.md) | Returns the k-th percentile of values |
| [STDEV](Statistical%20Functions/STDEV.md) | Returns the sample standard deviation |
| [STDEVP](Statistical%20Functions/STDEVP.md) | Returns the population standard deviation |
| [VARIANCE](Statistical%20Functions/VARIANCE.md) | Returns the sample variance |
| [VARIANCEP](Statistical%20Functions/VARIANCEP.md) | Returns the population variance |
| [MODE](Statistical%20Functions/MODE.md) | Returns the most frequently occurring value |

## Logical Functions

Functions that return boolean (TRUE/FALSE) values. Available both as functions and as operators.

| Function | Description |
|----------|-------------|
| [AND](Logical%20Functions/AND.md) | Returns TRUE if both arguments are TRUE. Also available as operator: `a AND b` |
| [OR](Logical%20Functions/OR.md) | Returns TRUE if either argument is TRUE. Also available as operator: `a OR b` |
| [NOT](Logical%20Functions/NOT.md) | Negates a logical value. Also available as operator: `NOT a` |
| [TRUE](Logical%20Functions/TRUE.md) | Returns the boolean value TRUE |
| [FALSE](Logical%20Functions/FALSE.md) | Returns the boolean value FALSE |
| [XOR](Logical%20Functions/XOR.md) | Returns TRUE when exactly one argument is TRUE (exclusive OR, Calcula extension) |

## Conditional Functions

Functions for branching logic and handling NULL values.

| Function | Description |
|----------|-------------|
| [IF](Conditional%20Functions/IF.md) | Evaluates a condition and returns one of two values |
| [SWITCH](Conditional%20Functions/SWITCH.md) | Evaluates an expression against a list of values and returns the matching result |
| [DIVIDE](Conditional%20Functions/DIVIDE.md) | Performs safe division, returning an alternate value on division by zero |
| [BLANK](Conditional%20Functions/BLANK.md) | Returns a blank (NULL) value |
| [ISBLANK](Conditional%20Functions/ISBLANK.md) | Tests whether an expression is BLANK (NULL) |
| [COALESCE](Conditional%20Functions/COALESCE.md) | Returns the first non-BLANK value from a list of expressions |
| [IFERROR](Conditional%20Functions/IFERROR.md) | Returns an alternate value when an expression evaluates to NULL/error |
| [GREATEST](Conditional%20Functions/GREATEST.md) | Returns the largest value from a list of expressions |
| [LEAST](Conditional%20Functions/LEAST.md) | Returns the smallest value from a list of expressions |
| [NULLIF](Conditional%20Functions/NULLIF.md) | Returns NULL if two values are equal, otherwise returns the first value |

## Math Functions

Scalar math functions that operate on numeric values.

| Function | Description |
|----------|-------------|
| [ABS](Math%20Functions/ABS.md) | Returns the absolute value of a number |
| [ROUND](Math%20Functions/ROUND.md) | Rounds to a specified number of decimal places |
| [ROUNDUP](Math%20Functions/ROUNDUP.md) | Rounds away from zero |
| [ROUNDDOWN](Math%20Functions/ROUNDDOWN.md) | Rounds toward zero |
| [INT](Math%20Functions/INT.md) | Rounds down to the nearest integer |
| [TRUNC](Math%20Functions/TRUNC.md) | Truncates toward zero to specified decimal places |
| [CEILING](Math%20Functions/CEILING.md) | Rounds up to the nearest multiple of significance |
| [FLOOR](Math%20Functions/FLOOR.md) | Rounds down to the nearest multiple of significance |
| [MOD](Math%20Functions/MOD.md) | Returns the remainder after division |
| [POWER](Math%20Functions/POWER.md) | Raises a number to a power |
| [SQRT](Math%20Functions/SQRT.md) | Returns the square root of a number |
| [LN](Math%20Functions/LN.md) | Returns the natural logarithm (base e) |
| [LOG10](Math%20Functions/LOG10.md) | Returns the base-10 logarithm |
| [SIGN](Math%20Functions/SIGN.md) | Returns the sign of a number (-1, 0, or 1) |
| [EXP](Math%20Functions/EXP.md) | Returns e raised to the power of a number |
| [LOG](Math%20Functions/LOG.md) | Returns the logarithm of a number to a specified base |
| [PI](Math%20Functions/PI.md) | Returns the value of Pi (3.14159...) |

## Date and Time Functions

Functions that extract parts from dates or perform date arithmetic.

| Function | Description |
|----------|-------------|
| [YEAR](Date%20and%20Time%20Functions/YEAR.md) | Extracts the year from a date |
| [MONTH](Date%20and%20Time%20Functions/MONTH.md) | Extracts the month (1-12) from a date |
| [DAY](Date%20and%20Time%20Functions/DAY.md) | Extracts the day (1-31) from a date |
| [QUARTER](Date%20and%20Time%20Functions/QUARTER.md) | Extracts the quarter (1-4) from a date |
| [DATE](Date%20and%20Time%20Functions/DATE.md) | Constructs a date from year, month, and day parts |
| [DATEDIFF](Date%20and%20Time%20Functions/DATEDIFF.md) | Returns the difference between two dates in the specified interval |
| [TODAY](Date%20and%20Time%20Functions/TODAY.md) | Returns the current date |
| [NOW](Date%20and%20Time%20Functions/NOW.md) | Returns the current date and time |
| [DATEADD](Date%20and%20Time%20Functions/DATEADD.md) | Adds a specified number of intervals to a date |
| [DATE_TRUNC](Date%20and%20Time%20Functions/DATE_TRUNC.md) | Truncates a date to the start of a period |
| [LAST_DAY](Date%20and%20Time%20Functions/LAST_DAY.md) | Returns the last day of the period containing a date |
| [EOMONTH](Date%20and%20Time%20Functions/EOMONTH.md) | Returns the last day of the month, with optional offset |
| [DAYOFWEEK](Date%20and%20Time%20Functions/DAYOFWEEK.md) | Returns the day of the week as a number (0-6) |
| [DAYOFYEAR](Date%20and%20Time%20Functions/DAYOFYEAR.md) | Returns the day of the year (1-366) |
| [WEEKNUM](Date%20and%20Time%20Functions/WEEKNUM.md) | Returns the ISO week number (1-53) |
| [DAYNAME](Date%20and%20Time%20Functions/DAYNAME.md) | Returns the name of the day of the week |
| [MONTHNAME](Date%20and%20Time%20Functions/MONTHNAME.md) | Returns the name of the month |
| [MONTHS_BETWEEN](Date%20and%20Time%20Functions/MONTHS_BETWEEN.md) | Returns the number of months between two dates |

## Text Functions

Functions that manipulate text strings.

| Function | Description |
|----------|-------------|
| [CONCATENATE](Text%20Functions/CONCATENATE.md) | Joins text strings (accepts arbitrary number of arguments) |
| [COMBINEVALUES](Text%20Functions/COMBINEVALUES.md) | Joins text strings with a delimiter |
| [EXACT](Text%20Functions/EXACT.md) | Compares two text strings (case-sensitive) |
| [FIND](Text%20Functions/FIND.md) | Returns the position of text within text (case-sensitive) |
| [FIXED](Text%20Functions/FIXED.md) | Rounds a number and returns it as text |
| [LEFT](Text%20Functions/LEFT.md) | Returns characters from the start of a text string |
| [LEN](Text%20Functions/LEN.md) | Returns the number of characters in a text string |
| [LOWER](Text%20Functions/LOWER.md) | Converts text to lowercase |
| [MID](Text%20Functions/MID.md) | Returns characters from the middle of a text string |
| [REPLACE](Text%20Functions/REPLACE.md) | Replaces part of a text string by position |
| [REPT](Text%20Functions/REPT.md) | Repeats text a given number of times |
| [RIGHT](Text%20Functions/RIGHT.md) | Returns characters from the end of a text string |
| [SEARCH](Text%20Functions/SEARCH.md) | Returns the position of text within text (case-insensitive) |
| [SUBSTITUTE](Text%20Functions/SUBSTITUTE.md) | Replaces occurrences of text with new text |
| [TRIM](Text%20Functions/TRIM.md) | Removes leading and trailing spaces |
| [UNICHAR](Text%20Functions/UNICHAR.md) | Returns the Unicode character for a code point |
| [UNICODE](Text%20Functions/UNICODE.md) | Returns the Unicode code point of the first character |
| [UPPER](Text%20Functions/UPPER.md) | Converts text to uppercase |
| [VALUE](Text%20Functions/VALUE.md) | Converts a text string to a number |
| [LTRIM](Text%20Functions/LTRIM.md) | Removes leading characters (Calcula extension) |
| [RTRIM](Text%20Functions/RTRIM.md) | Removes trailing characters (Calcula extension) |
| [LPAD](Text%20Functions/LPAD.md) | Left-pads a text string to a specified length (Calcula extension) |
| [RPAD](Text%20Functions/RPAD.md) | Right-pads a text string to a specified length (Calcula extension) |
| [REVERSE](Text%20Functions/REVERSE.md) | Reverses the order of characters in a text string (Calcula extension) |
| [SPLIT](Text%20Functions/SPLIT.md) | Splits text by a delimiter and returns a specified part (Calcula extension) |
| [FORMAT](Text%20Functions/FORMAT.md) | Formats a value as text using a format pattern |
| [CONTAINS](Text%20Functions/CONTAINS.md) | Tests whether text contains a substring (case-insensitive) |
| [STARTSWITH](Text%20Functions/STARTSWITH.md) | Tests whether text starts with a prefix |
| [ENDSWITH](Text%20Functions/ENDSWITH.md) | Tests whether text ends with a suffix |
| [INITCAP](Text%20Functions/INITCAP.md) | Capitalizes the first letter of each word |

## Time Intelligence Functions

Functions that shift or accumulate a measure over the model's marked date table. They work either with date-role columns on the group-by axis (running totals / positional shifts) or purely from the date filter context (cards, non-date pivots).

| Function | Description |
|----------|-------------|
| [YTD](Time%20Intelligence%20Functions/YTD.md) | Year-to-date running total |
| [QTD](Time%20Intelligence%20Functions/QTD.md) | Quarter-to-date running total |
| [MTD](Time%20Intelligence%20Functions/MTD.md) | Month-to-date running total |
| [WTD](Time%20Intelligence%20Functions/WTD.md) | Week-to-date running total (from Monday of the ISO week) |
| [PRIORYEAR](Time%20Intelligence%20Functions/PRIORYEAR.md) | Same period, one year earlier |
| [SAMEPERIODLASTYEAR](Time%20Intelligence%20Functions/SAMEPERIODLASTYEAR.md) | Synonym for PRIORYEAR |
| [PRIORPERIOD](Time%20Intelligence%20Functions/PRIORPERIOD.md) | Shift back by N years/quarters/months |
| [PARALLELPERIOD](Time%20Intelligence%20Functions/PARALLELPERIOD.md) | Signed period shift (±N years/quarters/months) |
| [DATESINPERIOD](Time%20Intelligence%20Functions/DATESINPERIOD.md) | Trailing window of N periods ending at the as-of date |
| [DATESBETWEEN](Time%20Intelligence%20Functions/DATESBETWEEN.md) | Absolute, inclusive date range on the date table |
| [CLOSINGBALANCE](Time%20Intelligence%20Functions/CLOSINGBALANCE.md) | Semi-additive balance at the last date in the period |
| [OPENINGBALANCE](Time%20Intelligence%20Functions/OPENINGBALANCE.md) | Semi-additive balance at the first date in the period |
| [PREVIOUSDAY](Time%20Intelligence%20Functions/PREVIOUSDAY.md) | The single day before the context's first date |
| [NEXTDAY](Time%20Intelligence%20Functions/NEXTDAY.md) | The single day after the context's last date |
| [FIRSTNONBLANK](Time%20Intelligence%20Functions/FIRSTNONBLANK.md) | Value at the first context date with fact data |
| [LASTNONBLANK](Time%20Intelligence%20Functions/LASTNONBLANK.md) | Value at the last context date with fact data |

## Information Functions

Functions that inspect the current filter context.

| Function | Description |
|----------|-------------|
| [HASONEVALUE](Information%20Functions/HASONEVALUE.md) | Tests whether a column has exactly one distinct value in the current filter context |
| [SELECTEDVALUE](Information%20Functions/SELECTEDVALUE.md) | Returns the single value of a column if there is exactly one, otherwise returns an alternate |
| [FIRST](Information%20Functions/FIRST.md) | Returns the first value of a column ordered by another expression |
| [ISINSCOPE](Information%20Functions/ISINSCOPE.md) | Returns TRUE if a column is in the current GROUP BY context |
| [ISFILTERED](Information%20Functions/ISFILTERED.md) | Returns TRUE when a column carries a direct filter (axis or slicer) in the current context |

## Context Functions

Functions that modify the evaluation context — the set of filters applied when computing a measure. Context functions are used as the second argument to an aggregation function.

| Function | Description |
|----------|-------------|
| [KEEP](Context%20Functions/KEEP.md) | Adds filter conditions to the evaluation context |
| [CLEAR](Context%20Functions/CLEAR.md) | Removes filters (axis + slicers) on a specific table or column |
| [RESET](Context%20Functions/RESET.md) | Removes all filters from the evaluation context |
| [CLEAREXCEPT](Context%20Functions/CLEAREXCEPT.md) | Clears all filters on a table except specified columns (like DAX's ALLEXCEPT) |
| [ALLSELECTED](Context%20Functions/ALLSELECTED.md) | Removes group-by (visual) filters but keeps slicers (DAX-compatible spelling of the inner-clear family) |
| [NOT IN](Context%20Functions/NOT_IN.md) | Anti-membership: keep rows whose value is NOT in a literal or variable set |
| [TREATAS](Context%20Functions/TREATAS.md) | Applies one column's values as a virtual filter on another, unrelated table |
| [USERELATIONSHIP](Context%20Functions/USERELATIONSHIP.md) | Activates an inactive relationship for the measure's evaluation |
| [TRAVERSE](Context%20Functions/TRAVERSE.md) | Forces cross-table filters along an explicit multi-hop relationship path |

### Source-Specific Context Functions

These are advanced variants of CLEAR and RESET that target only one filter source. Filters come from two sources: **inner** (group-by context) and **outer** (query-level slicer filters).

| Function | Clears | Keeps |
|----------|--------|-------|
| [CLEAR_INNER](Context%20Functions/CLEAR_INNER.md) | Group-by filters on specified targets | Query-level filters |
| [CLEAR_OUTER](Context%20Functions/CLEAR_OUTER.md) | Query-level filters on specified targets | Group-by filters |
| [RESET_INNER](Context%20Functions/RESET_INNER.md) | All group-by filters | Query-level filters |
| [RESET_OUTER](Context%20Functions/RESET_OUTER.md) | All query-level filters | Group-by filters |

> **Note on execution (local / in-memory path).** `CLEAR`/`RESET`/`CLEAREXCEPT`/`CLEAR_INNER` re-aggregate over the surviving group-by partition, so percent-of-total and percent-of-parent compute correctly. Three cases **fail closed** with a typed error rather than return a wrong number: (1) clearing a table that also carries a **report slicer** (slicer removal is not yet wired — use `CLEAR_INNER` for axis-only, or remove the slicer); (2) a **non-additive** aggregate under CLEAR (`AVG`, `DISTINCTCOUNT`, `MEDIAN`, …) — only `SUM`/`COUNT`/`COUNTROWS`/`MIN`/`MAX` recombine; (3) **percent-of-parent** combined with totals, lookups, hierarchies, or context columns.

## Relationship and Hierarchy Functions

Functions that fetch values across relationships or navigate parent-child hierarchies.

| Function | Description |
|----------|-------------|
| [RELATED](Relationship%20and%20Hierarchy%20Functions/RELATED.md) | Fetches a value from the ONE side of a many-to-one relationship for the current row |
| [LOOKUPVALUE](Relationship%20and%20Hierarchy%20Functions/LOOKUPVALUE.md) | Returns a value from another table's row matching given search columns (no relationship needed) |
| [PATH](Relationship%20and%20Hierarchy%20Functions/PATH.md) | Builds a parent-child path string (root→row) as a calculated column |
| [PATHITEM](Relationship%20and%20Hierarchy%20Functions/PATHITEM.md) | Returns the item at a 1-based position in a path string |
| [PATHLENGTH](Relationship%20and%20Hierarchy%20Functions/PATHLENGTH.md) | Returns the depth (number of levels) of a path string |

## Window Functions

Functions that compute over a window of rows relative to the current row, using `ORDERBY`/`PARTITIONBY` syntax — sliding aggregates, positional lookups, and ranking.

| Function | Description |
|----------|-------------|
| [WINDOW](Window%20Functions/WINDOW.md) | Aggregates a measure over a sliding window of rows (running totals, moving averages) |
| [OFFSET](Window%20Functions/OFFSET.md) | Returns a measure's value at a relative position from the current row |
| [INDEX](Window%20Functions/INDEX.md) | Returns a measure's value at an absolute position within a partition |
| [ROW_NUMBER](Window%20Functions/ROW_NUMBER.md) | Assigns a unique sequential number to each row |
| [RANK](Window%20Functions/RANK.md) | Assigns a rank with gaps for tied values |
| [DENSE_RANK](Window%20Functions/DENSE_RANK.md) | Assigns a rank without gaps for tied values |

## Iterator Functions

Row-context iteration — Calcula's composable alternative to DAX X-functions.

| Function | Description |
|----------|-------------|
| [ITERATE](Iterator%20Functions/ITERATE.md) | Declares row-context iteration over a table for use with any aggregate |
| [THISROW](Iterator%20Functions/THISROW.md) | The anchor row's column value inside a nested ITERATE (Calcula's answer to DAX EARLIER) |

## Table Functions

| Function | Description |
|----------|-------------|
| [QUERY](Table%20Functions/QUERY.md) | Materializes an intermediate grouped table for two-stage aggregation (aggregate of aggregates) |

## Calculation Group Functions

Functions that are only meaningful inside **calculation-item** expressions of a calculation group.

| Function | Description |
|----------|-------------|
| [SELECTEDMEASURE](Calculation%20Group%20Functions/SELECTEDMEASURE.md) | Placeholder for the measure a calculation item is applied to |
| [ISSELECTEDMEASURE](Calculation%20Group%20Functions/ISSELECTEDMEASURE.md) | TRUE when the applied measure is one of the listed measures |
| [SELECTEDMEASURENAME](Calculation%20Group%20Functions/SELECTEDMEASURENAME.md) | Name of the applied measure, as a string |
| [SELECTEDMEASUREFORMATSTRING](Calculation%20Group%20Functions/SELECTEDMEASUREFORMATSTRING.md) | Format string of the applied measure (dynamic format strings) |

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

See [KEEP](Context%20Functions/KEEP.md) for the filter syntax and the [expression language reference](../expression-language.md) for details.

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
