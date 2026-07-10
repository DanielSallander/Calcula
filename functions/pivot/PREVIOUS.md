# PREVIOUS

Returns the value from a preceding row.

**Category:** Window

**Syntax:** `PREVIOUS(field, [steps], [reset])`

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| field | Field reference or expression | Yes | The value to look up |
| steps | Number | No | How many rows back (default: 1) |
| reset | Reset parameter | No | Partition boundary (default: NONE) |

## Examples

```
CALC PrevSales = PREVIOUS([TotalSales])
CALC TwoBack = PREVIOUS([TotalSales], 2)
CALC YoY = [TotalSales] - PREVIOUS([TotalSales])
CALC Growth = ([TotalSales] - PREVIOUS([TotalSales])) / PREVIOUS([TotalSales])
```

## Behavior

- Returns NaN if there is no previous row (first row in partition).
- Steps defaults to 1 if not specified; steps must be >= 0 (0 = the current row).
- **Steps vs. reset:** a bare keyword or field name in the steps slot is read
  as the reset — `PREVIOUS([Sales], HIGHESTPARENT)` is shorthand for
  `PREVIOUS([Sales], 1, HIGHESTPARENT)`. A number there is the step count. To
  combine both, write `PREVIOUS(field, steps, reset)`; a reset in the 2nd
  position cannot be followed by further arguments.
- The window only contains rows at the same hierarchy level as the current
  row; subtotal and grand total rows return NaN.

## See Also

- [NEXT](NEXT.md) — value from a subsequent row
- [FIRST](FIRST.md) — first value in partition
