# TRUNC

Truncates a number toward zero to the specified number of decimal places.

## Syntax

```
TRUNC(expression [, decimals])
```

### Parameters

| Parameter | Definition |
|-----------|------------|
| `expression` | A numeric expression to truncate. |
| `decimals` | *(Optional)* The number of decimal places. Defaults to 0 (truncate to integer). |

## Return value

A number truncated toward zero.

## Remarks

- TRUNC removes decimal places without rounding. `TRUNC(3.7)` returns `3`, `TRUNC(-3.7)` returns `-3`.
- TRUNC differs from [INT](INT.md) for negative numbers: `INT(-3.7)` returns `-4` (floor), while `TRUNC(-3.7)` returns `-3` (toward zero).
- TRUNC is equivalent to [ROUNDDOWN](ROUNDDOWN.md).
- TRUNC generates the SQL `TRUNC(expr, decimals)` function.

## Example 1: Truncate to integer

```
DEFINE TruncRevenue = TRUNC(SUM(fact_sales[linetotal]))
```

## Example 2: Truncate to 2 decimal places

```
DEFINE TruncAvg = TRUNC(
    DIVIDE(SUM(fact_sales[linetotal]), COUNT(fact_sales[salesorderdetailid])),
    2
)
```

## See also

- [INT](INT.md) — round down (floor, differs for negatives)
- [ROUND](ROUND.md) — standard rounding
- [ROUNDDOWN](ROUNDDOWN.md) — equivalent function
