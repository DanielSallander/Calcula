# SQRT

Returns the square root of a number.

## Syntax

```
SQRT(expression)
```

### Parameters

| Parameter | Definition |
|-----------|------------|
| `expression` | A non-negative numeric expression. |

## Return value

The square root of the expression.

## Remarks

- The expression must be non-negative. Passing a negative value will produce an error or NaN.
- Use [ABS](ABS.md) to ensure a non-negative input when the sign is uncertain: `SQRT(ABS(x))`.
- SQRT is equivalent to `POWER(x, 0.5)`.

## Example 1: Square root of count

```
DEFINE SqrtCount = SQRT(COUNT(fact_sales[salesorderdetailid]))
```

## Example 2: SQRT with ABS

```
DEFINE SafeSqrt = SQRT(ABS(SUM(fact_sales[linetotal]) - SUM(fact_sales[orderqty])))
```

## Example 3: Rounded SQRT

```
DEFINE RoundSqrt = ROUND(SQRT(SUM(fact_sales[orderqty])), 2)
```

## See also

- [POWER](POWER.md) — raise to any power
- [ABS](ABS.md) — absolute value (ensure non-negative input)
- [ROUND](ROUND.md) — round the result
