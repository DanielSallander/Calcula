# ITERATE

Declares row-context iteration over a table. Used inside aggregation functions to compute a per-row expression before aggregating. This is the Calcula equivalent of DAX's X-functions (SUMX, AVERAGEX, etc.) but more composable — any aggregate can wrap ITERATE.

## Syntax

```
AGGREGATE(ITERATE(table, expression))
```

### Parameters

| Parameter | Definition |
|-----------|------------|
| `table` | The table to iterate over, one row at a time. |
| `expression` | An expression evaluated for each row. Can reference columns from the table, use arithmetic, and call scalar functions. |

## Return value

ITERATE itself does not return a final value. It produces a per-row series that the enclosing aggregation function (SUM, AVG, MIN, MAX, COUNT, etc.) reduces to a single result.

## Remarks

- ITERATE creates a row context — column references inside the expression are evaluated per row, not aggregated.
- ITERATE must always be wrapped in an aggregation function. `ITERATE(...)` alone is not valid as a measure.
- Any aggregation function can wrap ITERATE: SUM, AVG, MIN, MAX, COUNT, MEDIAN, STDEV, etc.
- This design replaces the need for separate SUMX, AVERAGEX, MINX, MAXX functions. Instead of `SUMX(table, expr)`, write `SUM(ITERATE(table, expr))`.
- ITERATE forces local computation. The engine fetches the required columns and evaluates the expression row by row before aggregating.
- The expression can use any scalar function: arithmetic, IF, DIVIDE, ABS, ROUND, etc.

## Example 1: Line total calculation (equivalent to SUMX)

Calculate total revenue as quantity times unit price, summed across all rows.

```
DEFINE Revenue = SUM(ITERATE(fact_sales, fact_sales[quantity] * fact_sales[unit_price]))
```

## Example 2: Average line amount (equivalent to AVERAGEX)

```
DEFINE Avg Line = AVG(ITERATE(fact_sales, fact_sales[quantity] * fact_sales[unit_price]))
```

## Example 3: Max margin per row (equivalent to MAXX)

```
DEFINE Max Margin = MAX(ITERATE(fact_sales, fact_sales[unit_price] - fact_sales[unit_cost]))
```

## Example 4: With scalar functions

Apply rounding and safe division per row before summing.

```
DEFINE Rounded Revenue = SUM(ITERATE(fact_sales, ROUND(DIVIDE(fact_sales[linetotal], fact_sales[orderqty], 0), 2)))
```

## See also

- [SUM](SUM.md) — aggregate sum
- [AVG](AVG.md) — aggregate average
- [MIN](MIN.md), [MAX](MAX.md) — aggregate min/max
- [DIVIDE](DIVIDE.md) — safe division
