# NEXT

Returns the value from a subsequent row.

**Category:** Window

**Syntax:** `NEXT(field, [steps], [reset])`

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| field | Field reference or expression | Yes | The value to look up |
| steps | Number | No | How many rows forward (default: 1) |
| reset | Reset parameter | No | Partition boundary (default: NONE) |

## Examples

```
CALC NextSales = NEXT([TotalSales])
CALC VsNext = [TotalSales] - NEXT([TotalSales])
```

## Behavior

- Returns NaN if there is no next row (last row in partition).
- Steps defaults to 1 if not specified.

## See Also

- [PREVIOUS](PREVIOUS.md) — value from a preceding row
- [LAST](LAST.md) — last value in partition
