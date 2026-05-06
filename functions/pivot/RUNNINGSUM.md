# RUNNINGSUM

Calculates the cumulative sum of a field along the row axis.

**Category:** Window

**Syntax:** `RUNNINGSUM(field, [reset])`

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| field | Field reference or expression | Yes | The value to accumulate |
| reset | Reset parameter | No | When to restart the sum (default: NONE) |

## Examples

```
CALC RunTotal = RUNNINGSUM([TotalSales])
CALC RunByYear = RUNNINGSUM([TotalSales], HIGHESTPARENT)
CALC RunByParent = RUNNINGSUM([TotalSales], LOWESTPARENT)
```

## Behavior

| Row | [Sales] | RUNNINGSUM([Sales]) | RUNNINGSUM([Sales], HIGHESTPARENT) |
|-----|---------|---------------------|------------------------------------|
| 2024 Q1 | 100 | 100 | 100 |
| 2024 Q2 | 150 | 250 | 250 |
| 2024 Q3 | 200 | 450 | 450 |
| 2025 Q1 | 120 | 570 | 120 (restarted) |
| 2025 Q2 | 160 | 730 | 280 |

- Subtotal and grand total rows are excluded from the running sum and return NaN.
- The sum includes the current row.

## See Also

- [MOVINGAVERAGE](MOVINGAVERAGE.md) — average over a fixed window
- [Reset Parameter](reset-parameter.md) — partition control
