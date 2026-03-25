# ROUNDDOWN

Rounds a number toward zero to the specified number of decimal places.

## Syntax

```
ROUNDDOWN(expression, decimals)
```

### Parameters

| Parameter | Definition |
|-----------|------------|
| `expression` | A numeric expression to round. |
| `decimals` | The number of decimal places. |

## Return value

A number rounded toward zero (truncated) to the specified decimal places.

## Remarks

- ROUNDDOWN is equivalent to [TRUNC](TRUNC.md) — both truncate toward zero.
- For standard rounding, use [ROUND](ROUND.md). For rounding away from zero, use [ROUNDUP](ROUNDUP.md).

## Example

```
DEFINE TruncatedAvg = ROUNDDOWN(
    DIVIDE(SUM(fact_sales[linetotal]), COUNT(fact_sales[salesorderdetailid])),
    2
)
```

## See also

- [ROUND](ROUND.md) — standard rounding
- [ROUNDUP](ROUNDUP.md) — round away from zero
- [TRUNC](TRUNC.md) — equivalent truncation function
- [FLOOR](FLOOR.md) — round down to nearest multiple
