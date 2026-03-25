# INT

Rounds a number down to the nearest integer.

## Syntax

```
INT(expression)
```

### Parameters

| Parameter | Definition |
|-----------|------------|
| `expression` | A numeric expression to truncate to an integer. |

## Return value

A whole number — the largest integer less than or equal to the expression (floor).

## Remarks

- INT always rounds **down** (toward negative infinity), not toward zero. For example, `INT(-2.5)` returns `-3`, not `-2`.
- For rounding toward zero, use [TRUNC](TRUNC.md).
- INT is equivalent to the SQL `FLOOR` function.
- INT always forces local computation when the argument contains aggregation functions.

## Example 1: Integer average

```
DEFINE IntAvg = INT(
    DIVIDE(SUM(fact_sales[linetotal]), COUNT(fact_sales[salesorderdetailid]))
)
```

## Example 2: INT for bucketing

Use INT to create numeric buckets for [SWITCH](SWITCH.md).

```
DEFINE Tier = SWITCH(
    INT(DIVIDE(SUM(fact_sales[linetotal]), 100000)),
    0, "Under 100K",
    1, "100K-200K",
    "Over 200K"
)
```

## Example 3: Grouped

```
DEFINE IntRevenue = INT(SUM(fact_sales[linetotal]))
QUERY: IntRevenue BY dim_territory[territorygroup]
```

## See also

- [TRUNC](TRUNC.md) — truncate toward zero (differs for negative numbers)
- [ROUND](ROUND.md) — standard rounding
- [CEILING](CEILING.md) — round up to nearest multiple
- [FLOOR](FLOOR.md) — round down to nearest multiple
