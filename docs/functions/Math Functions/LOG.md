# LOG

Returns the logarithm of a number to the specified base.

## Syntax

```
LOG(number, base)
```

### Parameters

| Parameter | Definition |
|-----------|------------|
| `number` | A positive numeric expression. Must be greater than zero. |
| `base` | The base of the logarithm. Must be a positive number other than 1. Defaults to 10 if omitted. |

## Return value

A number — the logarithm of the input to the given base.

## Remarks

- LOG with base 10 is equivalent to [LOG10](LOG10.md). LOG with base e is equivalent to [LN](LN.md).
- The number must be positive. LOG of zero or a negative number is undefined.
- When base is omitted, LOG defaults to base 10 (common logarithm).
- Generates SQL `LOG(base, x)` when pushed to the data source. Note that SQL argument order may differ from the formula syntax.
- LOG forces local computation when arguments contain aggregation functions.

## Example 1: Common logarithm

```
DEFINE LogValue = LOG(100, 10)
```

Returns 2.

## Example 2: Binary logarithm

Calculate the number of bits needed to represent a count.

```
DEFINE Bits = ROUNDUP(LOG(COUNT(fact_sales[salesorderdetailid]), 2), 0)
```

## See also

- [LN](LN.md) — natural logarithm (base e)
- [LOG10](LOG10.md) — common logarithm (base 10)
- [EXP](EXP.md) — inverse of LN
- [POWER](POWER.md) — raise a number to a power
