# GREATEST

Returns the largest value from a list of expressions.

## Syntax

```
GREATEST(expression1, expression2 [, expression3, ...])
```

### Parameters

| Parameter | Definition |
|-----------|------------|
| `expression1` | The first expression to compare. |
| `expression2` | The second expression to compare. |
| `expression3, ...` | *(Optional)* Additional expressions to compare. |

## Return value

The largest value among all arguments. If any argument is NULL (BLANK), returns BLANK.

## Remarks

- GREATEST requires at least two arguments.
- Arguments are compared using their natural ordering. Works with numbers, dates, and text.
- GREATEST generates the SQL `GREATEST(a, b, ...)` function.
- Returns BLANK if any argument is BLANK. To handle NULLs, wrap arguments with [COALESCE](COALESCE.md) before passing them to GREATEST.
- GREATEST always forces local computation when any argument contains aggregation functions.
- GREATEST differs from [MAX](../Aggregation%20Functions/MAX.md): MAX aggregates across rows of a single column, while GREATEST compares values across multiple expressions within the same row or result.

## Example 1: Floor a value at zero

Ensure a profit measure never returns a negative number.

```
DEFINE ProfitFloor = GREATEST(0, SUM(fact_sales[profit]))
```

Returns the sum of profit if positive, otherwise 0.

## Example 2: Latest of two dates

Find the most recent date between order date and ship date.

```
DEFINE LatestDate = GREATEST(MAX(fact_sales[orderdate]), MAX(fact_sales[shipdate]))
```

## Example 3: Best-performing metric

Pick the higher value between revenue and target for variance reporting.

```
DEFINE BestResult = GREATEST(
    SUM(fact_sales[linetotal]),
    SUM(fact_sales[target_amount]),
    SUM(fact_sales[forecast_amount])
)
```

## See also

- [LEAST](LEAST.md) -- returns the smallest value from a list of expressions
- [MAX](../Aggregation%20Functions/MAX.md) -- returns the maximum value across rows of a column
- [IF](IF.md) -- conditional branching
