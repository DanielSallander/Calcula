# POWER

Raises a number to a power.

## Syntax

```
POWER(base, exponent)
```

### Parameters

| Parameter | Definition |
|-----------|------------|
| `base` | The base number. |
| `exponent` | The exponent to raise the base to. |

## Return value

The base raised to the power of the exponent.

## Remarks

- `POWER(2, 3)` returns `8` (2 cubed).
- `POWER(x, 2)` squares a value. `POWER(x, 0.5)` is equivalent to [SQRT](SQRT.md).
- POWER generates the SQL `POWER(base, exponent)` function.

## Example 1: Square the count

```
DEFINE CountSquared = POWER(COUNT(fact_sales[salesorderdetailid]), 2)
```

## Example 2: Cube root

```
DEFINE CubeRoot = POWER(SUM(fact_sales[linetotal]), 1.0 / 3)
```

## See also

- [SQRT](SQRT.md) — square root (equivalent to `POWER(x, 0.5)`)
- [LN](LN.md) — natural logarithm
- [LOG10](LOG10.md) — base-10 logarithm
