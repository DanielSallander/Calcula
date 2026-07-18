# SIGN

Returns the sign of a number: 1 for positive, -1 for negative, 0 for zero.

## Syntax

```
SIGN(expression)
```

### Parameters

| Parameter | Definition |
|-----------|------------|
| `expression` | A numeric expression. |

## Return value

An integer: `1` if the expression is positive, `-1` if negative, `0` if zero.

## Remarks

- SIGN is useful for conditional logic based on whether a value is positive, negative, or zero.
- SIGN generates the SQL `signum()` function for DataFusion execution.

## Example 1: Sign of revenue

```
DEFINE RevenueSign = SIGN(SUM(fact_sales[linetotal]))
```

Always returns 1 since revenue is positive.

## Example 2: Sign of difference

```
DEFINE DiffSign = SIGN(SUM(fact_sales[linetotal]) - 50000000)
```

Returns 1 if revenue exceeds 50M, -1 if below, 0 if exactly 50M.

## See also

- [ABS](ABS.md) — absolute value
- [IF](../Conditional%20Functions/IF.md) — conditional branching (more flexible alternative)
