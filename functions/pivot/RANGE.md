# RANGE

Returns the number of rows in a window slice. Building block for custom window calculations.

**Category:** Utility

**Syntax:**
- `RANGE(size)` — last N rows ending at the current row
- `RANGE(start, end)` — relative offsets from the current position

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| size | Number | Yes (form 1) | Number of rows in the window |
| start | Number | Yes (form 2) | Start offset (negative = before current) |
| end | Number | Yes (form 2) | End offset (positive = after current) |

## Examples

```
CALC Window3 = RANGE(3)
CALC Window = RANGE(-2, 0)
CALC Forward = RANGE(0, 2)
```

## See Also

- [MOVINGAVERAGE](MOVINGAVERAGE.md) — built-in moving average
- [RUNNINGSUM](RUNNINGSUM.md) — cumulative sum
