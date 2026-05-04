# MEDIAN

Returns the median (50th percentile) of a set of numeric values. The median is the middle value when all values are sorted in order.

## Syntax

```
MEDIAN(table[column])
MEDIAN(table[column], context_op1, context_op2, ...)
```

### Parameters

| Parameter | Definition |
|-----------|------------|
| `table[column]` | A column reference containing numeric values. |
| `context_op` | Optional. One or more context operations ([KEEP](KEEP.md), [CLEAR](CLEAR.md), [RESET](RESET.md)) that modify the evaluation context. |

## Return value

A number — the median value of the column. Returns BLANK if there are no rows.

## Remarks

- For an odd number of values, MEDIAN returns the middle value. For an even number, it returns the average of the two middle values.
- MEDIAN is a statistical aggregate. It supports context operations like other aggregation functions (SUM, AVG, etc.).
- MEDIAN is equivalent to `PERCENTILE(table[column], 0.5)`.
- NULL values are excluded from the calculation.
- MEDIAN always requires local computation and cannot be pushed down to the data source as a simple aggregate.

## Example 1: Median sale amount

```
DEFINE Median Sale = MEDIAN(fact_sales[linetotal])
```

## Example 2: Median with context filter

```
DEFINE Median Bikes = MEDIAN(fact_sales[linetotal], KEEP(dim_product, dim_product[categoryname] = "Bikes"))
```

## See also

- [AVG](AVG.md) — arithmetic mean
- [PERCENTILE](PERCENTILE.md) — arbitrary percentile
- [MIN](MIN.md) — minimum value
- [MAX](MAX.md) — maximum value
