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
- Steps defaults to 1 if not specified.
- Subtotal and grand total rows are skipped.

## See Also

- [NEXT](NEXT.md) — value from a subsequent row
- [FIRST](FIRST.md) — first value in partition
