# MOD

Returns the remainder after division (modulo operation).

## Syntax

```
MOD(number, divisor)
```

### Parameters

| Parameter | Definition |
|-----------|------------|
| `number` | The number to divide (the dividend). |
| `divisor` | The number to divide by. |

## Return value

The remainder after dividing `number` by `divisor`.

## Remarks

- `MOD(10, 3)` returns `1` (10 divided by 3 is 3 remainder 1).
- MOD generates the SQL `%` operator internally.
- MOD is useful for cyclic grouping, bucketing, or detecting even/odd values.

## Example 1: Remainder of total quantity

```
DEFINE QtyMod1000 = MOD(SUM(fact_sales[orderqty]), 1000)
```

## Example 2: Even/odd detection in IF

```
DEFINE IsEvenQty = IF(MOD(SUM(fact_sales[orderqty]), 2) = 0, "Even", "Odd")
```

## See also

- [INT](INT.md) — truncate to integer
- [DIVIDE](DIVIDE.md) — safe division
- [POWER](POWER.md) — exponentiation
