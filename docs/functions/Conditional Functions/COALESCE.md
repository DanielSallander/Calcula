# COALESCE

Returns the first non-BLANK (non-NULL) value from a list of expressions. Evaluates each argument in order and returns the first one that is not BLANK.

## Syntax

```
COALESCE(expression1, expression2 [, expression3, ...])
```

### Parameters

| Parameter | Definition |
|-----------|------------|
| `expression1` | The first expression to evaluate. |
| `expression2` | The fallback expression if expression1 is BLANK. |
| `expression3, ...` | *(Optional)* Additional fallback expressions, evaluated in order. |

## Return value

The first non-BLANK value from the argument list. If all arguments are BLANK, returns BLANK.

## Remarks

- COALESCE requires at least two arguments.
- Arguments are evaluated left to right. The first non-NULL value is returned.
- COALESCE generates the SQL `COALESCE(expr1, expr2, ...)` function.
- This is more concise than `IF(ISBLANK(x), fallback, x)` for simple NULL replacement.
- COALESCE is commonly used to wrap [DIVIDE](DIVIDE.md) results to ensure a numeric value (e.g., 0) is returned instead of BLANK.
- COALESCE always forces local computation when any argument contains aggregation functions.

## Example 1: Replace NULL with zero

Ensure the result is never BLANK.

```
DEFINE SafeRevenue = COALESCE(SUM(fact_sales[linetotal]), 0)
```

## Example 2: Wrap DIVIDE

Provide 0 when DIVIDE returns BLANK (due to division by zero).

```
DEFINE SafeAvg = COALESCE(
    DIVIDE(SUM(fact_sales[linetotal]), COUNT(fact_sales[salesorderdetailid])),
    0
)
```

This is equivalent to `DIVIDE(SUM(...), COUNT(...), 0)` but COALESCE is more general — it catches BLANK from any source, not just division by zero.

## Example 3: Multiple fallbacks

Try multiple expressions in order.

```
DEFINE BestRevenue = COALESCE(
    SUM(fact_sales[linetotal]),
    SUM(fact_sales[orderqty]),
    0
)
```

Returns linetotal sum if available, otherwise orderqty sum, otherwise 0.

## Example 4: COALESCE in arithmetic

```
DEFINE TotalSafe = COALESCE(SUM(fact_sales[linetotal]), 0) + COALESCE(SUM(fact_sales[orderqty]), 0)
```

## See also

- [BLANK](BLANK.md) — returns a BLANK value
- [ISBLANK](ISBLANK.md) — test whether a value is BLANK
- [DIVIDE](DIVIDE.md) — safe division with built-in alternate value
- [IF](IF.md) — conditional branching (more verbose alternative)
