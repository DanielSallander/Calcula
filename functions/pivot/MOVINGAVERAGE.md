# MOVINGAVERAGE

Calculates the moving average over a specified window of rows.

**Category:** Window

**Syntax:** `MOVINGAVERAGE(field, window, [reset])`

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| field | Field reference or expression | Yes | The value to average |
| window | Number | Yes | Number of rows in the window |
| reset | Reset parameter | No | When to restart (default: NONE) |

## Examples

```
CALC MA3 = MOVINGAVERAGE([TotalSales], 3)
CALC MA5ByYear = MOVINGAVERAGE([TotalSales], 5, HIGHESTPARENT)
```

## Behavior

With window=3:

| Row | [Sales] | MA3 |
|-----|---------|-----|
| Q1 | 100 | 100 (only 1 row available) |
| Q2 | 200 | 150 (average of 2 rows) |
| Q3 | 300 | 200 (average of Q1, Q2, Q3) |
| Q4 | 400 | 300 (average of Q2, Q3, Q4) |

- The window includes the current row and up to (window-1) preceding rows.
- If fewer rows are available (start of partition), averages whatever is available.

## See Also

- [RUNNINGSUM](RUNNINGSUM.md) — cumulative sum
- [Reset Parameter](reset-parameter.md)
