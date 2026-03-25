# ROUND

Rounds a number to the specified number of decimal places.

## Syntax

```
ROUND(expression, decimals)
```

### Parameters

| Parameter | Definition |
|-----------|------------|
| `expression` | A numeric expression to round. |
| `decimals` | The number of decimal places to round to. Use 0 for rounding to the nearest integer. |

## Return value

A number rounded to the specified number of decimal places.

## Remarks

- ROUND uses standard rounding rules (round half up).
- `ROUND(x, 0)` rounds to the nearest integer.
- `ROUND(x, 2)` rounds to two decimal places.
- For rounding always away from zero, see [ROUNDUP](ROUNDUP.md). For rounding always toward zero, see [ROUNDDOWN](ROUNDDOWN.md).
- ROUND always forces local computation when the argument contains aggregation functions.

## Example 1: Round revenue to whole number

```
DEFINE RoundedRevenue = ROUND(SUM(fact_sales[linetotal]), 0)
```

## Example 2: Round average to 2 decimals

```
DEFINE RoundedAvg = ROUND(
    DIVIDE(SUM(fact_sales[linetotal]), COUNT(fact_sales[salesorderdetailid])),
    2
)
```

## Example 3: Round grouped results

```
DEFINE RoundedAvg = ROUND(DIVIDE(SUM(fact_sales[linetotal]), COUNTROWS(fact_sales)), 2)
QUERY: RoundedAvg BY dim_territory[territorygroup]
```

## See also

- [ROUNDUP](ROUNDUP.md) — round away from zero
- [ROUNDDOWN](ROUNDDOWN.md) — round toward zero
- [INT](INT.md) — truncate to integer (always rounds down)
- [TRUNC](TRUNC.md) — truncate to specified decimal places
