# FLOOR

Rounds a number down to the nearest multiple of significance.

## Syntax

```
FLOOR(expression [, significance])
```

### Parameters

| Parameter | Definition |
|-----------|------------|
| `expression` | A numeric expression to round down. |
| `significance` | *(Optional)* The multiple to round down to. Defaults to 1. |

## Return value

A number rounded down to the nearest multiple of significance.

## Remarks

- `FLOOR(4.7)` returns `4` (rounds down to nearest integer).
- `FLOOR(4.7, 0.5)` returns `4.5` (rounds down to nearest 0.5).
- `FLOOR(105, 10)` returns `100` (rounds down to nearest 10).
- FLOOR generates SQL `FLOOR(expr / sig) * sig`.

## Example

```
DEFINE FloorRevenue = FLOOR(SUM(fact_sales[linetotal]), 1000)
```

## See also

- [CEILING](CEILING.md) — round up to nearest multiple
- [ROUND](ROUND.md) — standard rounding
- [INT](INT.md) — truncate to integer (equivalent to `FLOOR(x, 1)`)
