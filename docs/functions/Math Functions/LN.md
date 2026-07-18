# LN

Returns the natural logarithm (base e) of a number.

## Syntax

```
LN(expression)
```

### Parameters

| Parameter | Definition |
|-----------|------------|
| `expression` | A positive numeric expression. |

## Return value

The natural logarithm of the expression.

## Remarks

- The expression must be positive. Passing zero or a negative value will produce an error.
- LN is the inverse of `POWER(e, x)` where e is Euler's number (~2.71828).
- For base-10 logarithm, use [LOG10](LOG10.md).

## Example

```
DEFINE LogRevenue = LN(SUM(fact_sales[linetotal]))
```

## See also

- [LOG10](LOG10.md) — base-10 logarithm
- [POWER](POWER.md) — exponentiation
- [SQRT](SQRT.md) — square root
