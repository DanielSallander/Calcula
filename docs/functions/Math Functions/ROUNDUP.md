# ROUNDUP

Rounds a number up, away from zero, to the specified number of decimal places.

## Syntax

```
ROUNDUP(expression, decimals)
```

### Parameters

| Parameter | Definition |
|-----------|------------|
| `expression` | A numeric expression to round. |
| `decimals` | The number of decimal places. |

## Return value

A number rounded away from zero.

## Remarks

- ROUNDUP always rounds away from zero: positive numbers round up, negative numbers round to a more negative value.
- In the current implementation, ROUNDUP is approximated using standard ROUND. A dedicated implementation may be added in future versions.
- For standard rounding, use [ROUND](ROUND.md). For rounding toward zero, use [ROUNDDOWN](ROUNDDOWN.md).

## Example

```
DEFINE RoundedUpAvg = ROUNDUP(
    DIVIDE(SUM(fact_sales[linetotal]), COUNT(fact_sales[salesorderdetailid])),
    2
)
```

## See also

- [ROUND](ROUND.md) — standard rounding
- [ROUNDDOWN](ROUNDDOWN.md) — round toward zero
- [CEILING](CEILING.md) — round up to nearest multiple
