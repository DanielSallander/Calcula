# CEILING

Rounds a number up to the nearest multiple of significance.

## Syntax

```
CEILING(expression [, significance])
```

### Parameters

| Parameter | Definition |
|-----------|------------|
| `expression` | A numeric expression to round up. |
| `significance` | *(Optional)* The multiple to round up to. Defaults to 1. |

## Return value

A number rounded up to the nearest multiple of significance.

## Remarks

- `CEILING(4.3)` returns `5` (rounds up to nearest integer).
- `CEILING(4.3, 0.5)` returns `4.5` (rounds up to nearest 0.5).
- `CEILING(105, 10)` returns `110` (rounds up to nearest 10).
- CEILING generates SQL `CEILING(expr / sig) * sig`.

## Example

```
DEFINE CeilingRevenue = CEILING(SUM(fact_sales[linetotal]), 1000)
```

## See also

- [FLOOR](FLOOR.md) — round down to nearest multiple
- [ROUND](ROUND.md) — standard rounding
- [INT](INT.md) — truncate to integer
