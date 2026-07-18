# LEAST

Returns the smallest value from a list of expressions.

## Syntax

```
LEAST(expression1, expression2 [, expression3, ...])
```

### Parameters

| Parameter | Definition |
|-----------|------------|
| `expression1` | The first expression to compare. |
| `expression2` | The second expression to compare. |
| `expression3, ...` | *(Optional)* Additional expressions to compare. |

## Return value

The smallest value among all arguments. If any argument is NULL (BLANK), returns BLANK.

## Remarks

- LEAST requires at least two arguments.
- Arguments are compared using their natural ordering. Works with numbers, dates, and text.
- LEAST generates the SQL `LEAST(a, b, ...)` function.
- Returns BLANK if any argument is BLANK. To handle NULLs, wrap arguments with [COALESCE](COALESCE.md) before passing them to LEAST.
- LEAST always forces local computation when any argument contains aggregation functions.
- LEAST differs from [MIN](../Aggregation%20Functions/MIN.md): MIN aggregates across rows of a single column, while LEAST compares values across multiple expressions within the same row or result.

## Example 1: Cap a value at a maximum

Ensure a discount percentage never exceeds 100%.

```
DEFINE CappedDiscount = LEAST(100, SUM(fact_sales[discount_pct]))
```

## Example 2: Earliest of two dates

Find the earliest date between order date and ship date.

```
DEFINE EarliestDate = LEAST(MIN(fact_sales[orderdate]), MIN(fact_sales[shipdate]))
```

## Example 3: Conservative estimate

Take the lower of actual revenue and budgeted revenue for conservative reporting.

```
DEFINE ConservativeRevenue = LEAST(
    SUM(fact_sales[linetotal]),
    SUM(fact_sales[budget_amount])
)
```

## See also

- [GREATEST](GREATEST.md) -- returns the largest value from a list of expressions
- [MIN](../Aggregation%20Functions/MIN.md) -- returns the minimum value across rows of a column
- [IF](IF.md) -- conditional branching
