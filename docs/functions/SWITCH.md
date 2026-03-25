# SWITCH

Evaluates an expression against a list of values and returns the result corresponding to the first match. If no match is found, returns an optional default value.

## Syntax

```
SWITCH(expression, value1, result1 [, value2, result2, ...] [, default])
```

### Parameters

| Parameter | Definition |
|-----------|------------|
| `expression` | The expression to evaluate. Typically an aggregation like SUM or COUNT. |
| `value1` | The first value to compare against the expression. |
| `result1` | The result returned if the expression equals value1. |
| `value2, result2, ...` | *(Optional)* Additional value/result pairs. |
| `default` | *(Optional)* The result returned if no value matches. If omitted, returns BLANK (NULL). The default is specified as the last unpaired argument. |

## Return value

The result corresponding to the first matching value, or the default if no match is found.

## Remarks

- SWITCH generates a SQL `CASE expression WHEN value1 THEN result1 WHEN value2 THEN result2 ... ELSE default END` internally.
- Values are compared using equality (`=`). For range comparisons, use [IF](IF.md) instead.
- The expression and all values/results can contain aggregation functions.
- SWITCH always forces local computation — it is not pushed down to the data source.
- If the number of remaining arguments after value/result pairs is odd, the last argument is treated as the default value.
- For simple two-way branching, [IF](IF.md) may be more readable.

## Example 1: Map status codes to labels

```
DEFINE Status = SWITCH(
    SUM(fact_sales[statuscode]),
    1, "Active",
    2, "Inactive",
    3, "Archived",
    "Unknown"
)
```

## Example 2: Categorize by count ranges

Using SWITCH with computed thresholds.

```
DEFINE OrderTier = SWITCH(
    INT(DIVIDE(COUNT(fact_sales[salesorderdetailid]), 10000)),
    0, "Small",
    1, "Medium",
    2, "Large",
    "Extra Large"
)
```

## Example 3: Without a default

If no match is found, BLANK (NULL) is returned.

```
DEFINE Label = SWITCH(
    SUM(fact_sales[orderqty]),
    1, "Single",
    2, "Double",
    3, "Triple"
)
```

## See also

- [IF](IF.md) — two-way conditional branching
- [DIVIDE](DIVIDE.md) — safe division
- [INT](INT.md) — truncate to integer (useful for bucketing in SWITCH)
