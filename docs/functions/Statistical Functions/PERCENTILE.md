# PERCENTILE

Returns the k-th percentile of a set of numeric values. The percentile indicates the value below which a given percentage of observations fall.

## Syntax

```
PERCENTILE(table[column], k)
PERCENTILE(table[column], k, context_op1, context_op2, ...)
```

### Parameters

| Parameter | Definition |
|-----------|------------|
| `table[column]` | A column reference containing numeric values. |
| `k` | A decimal number between 0.0 and 1.0 (inclusive) representing the desired percentile. For example, 0.5 is the 50th percentile (median), 0.95 is the 95th percentile. |
| `context_op` | Optional. One or more context operations ([KEEP](KEEP.md), [CLEAR](CLEAR.md), [RESET](RESET.md)) that modify the evaluation context. |

## Return value

A number — the value at the k-th percentile. Returns BLANK if there are no rows.

## Remarks

- `PERCENTILE(table[column], 0.5)` is equivalent to [MEDIAN](MEDIAN.md).
- k must be between 0.0 and 1.0. Values outside this range produce an error.
- NULL values are excluded from the calculation.
- PERCENTILE uses linear interpolation between data points when the percentile falls between two values.
- PERCENTILE supports context operations like other aggregation functions.
- PERCENTILE always requires local computation and cannot be pushed down to the data source.

## Example 1: 95th percentile

Find the 95th percentile of order amounts.

```
DEFINE P95 Sales = PERCENTILE(fact_sales[linetotal], 0.95)
```

## Example 2: Quartiles

Define the three quartile boundaries.

```
DEFINE Q1 = PERCENTILE(fact_sales[linetotal], 0.25)
DEFINE Q2 = PERCENTILE(fact_sales[linetotal], 0.5)
DEFINE Q3 = PERCENTILE(fact_sales[linetotal], 0.75)
```

## Example 3: Percentile with context filter

```
DEFINE P90 Bikes = PERCENTILE(fact_sales[linetotal], 0.90, KEEP(dim_product, dim_product[categoryname] = "Bikes"))
```

## See also

- [MEDIAN](MEDIAN.md) — 50th percentile (shorthand)
- [MIN](MIN.md) — minimum value (0th percentile)
- [MAX](MAX.md) — maximum value (100th percentile)
