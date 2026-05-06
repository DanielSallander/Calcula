# LAST

Returns the value from the last row in the partition.

**Category:** Window

**Syntax:** `LAST(field, [reset])`

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| field | Field reference or expression | Yes | The value to look up |
| reset | Reset parameter | No | Partition boundary (default: NONE) |

## Examples

```
CALC VsLast = [TotalSales] - LAST([TotalSales])
CALC LastInYear = LAST([TotalSales], HIGHESTPARENT)
```

## See Also

- [FIRST](FIRST.md) — first value in partition
- [NEXT](NEXT.md) — value from subsequent row
