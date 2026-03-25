# ABS

Returns the absolute value of a number — the number without its sign.

## Syntax

```
ABS(expression)
```

### Parameters

| Parameter | Definition |
|-----------|------------|
| `expression` | A numeric expression. Can be a literal, column reference, aggregation, or any expression that produces a number. |

## Return value

A non-negative number — the absolute value of the expression.

## Remarks

- ABS removes the sign from a number: `ABS(-5)` returns `5`, `ABS(5)` returns `5`.
- ABS can wrap any numeric expression including aggregations and [DIVIDE](DIVIDE.md).
- ABS always forces local computation when the argument contains aggregation functions.

## Example 1: Absolute difference

Calculate the absolute difference between revenue and a target.

```
DEFINE AbsDiff = ABS(SUM(fact_sales[linetotal]) - 999999999)
```

## Example 2: ABS with DIVIDE

```
DEFINE AbsRatio = ABS(DIVIDE(SUM(fact_sales[orderqty]), SUM(fact_sales[linetotal])))
```

## Example 3: Nested with ROUND

```
DEFINE AbsRoundedAvg = ABS(ROUND(DIVIDE(SUM(fact_sales[linetotal]), COUNT(fact_sales[salesorderdetailid])), 0))
```

## See also

- [SIGN](SIGN.md) — returns the sign of a number (-1, 0, or 1)
- [ROUND](ROUND.md) — round to a given number of decimal places
- [INT](INT.md) — truncate to integer
