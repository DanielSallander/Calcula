# RANGE

Returns the number of rows that fall in a window slice after clamping to the axis. Building block for custom window calculations.

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

## Behavior

- Returns the **count** of rows in the slice after clamping to the axis —
  only rows at the current row's hierarchy level that actually exist are
  counted. At the first row, `RANGE(3)` returns 1.
- `RANGE(0)` returns 0.
- A negative size is an error, as is `RANGE(start, end)` with start > end.
- Returns NaN on subtotal and grand total rows, like the other window
  functions.

## See Also

- [MOVINGAVERAGE](MOVINGAVERAGE.md) — built-in moving average
- [RUNNINGSUM](RUNNINGSUM.md) — cumulative sum
