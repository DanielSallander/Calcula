# LOG10

Returns the base-10 logarithm of a number.

## Syntax

```
LOG10(expression)
```

### Parameters

| Parameter | Definition |
|-----------|------------|
| `expression` | A positive numeric expression. |

## Return value

The base-10 logarithm of the expression.

## Remarks

- The expression must be positive. Passing zero or a negative value will produce an error.
- LOG10 is useful for computing orders of magnitude.
- For natural logarithm (base e), use [LN](LN.md).

## Example

```
DEFINE OrderOfMagnitude = INT(LOG10(SUM(fact_sales[linetotal])))
```

## See also

- [LN](LN.md) — natural logarithm
- [POWER](POWER.md) — exponentiation
- [INT](INT.md) — truncate to integer
