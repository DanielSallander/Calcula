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

## Behavior

- Returns the last value among rows at the current row's **hierarchy level**
  (within the reset partition, if one is given); a parent group row gets its
  own window over the rows at its level.
- Subtotal and grand total rows return NaN.

## See Also

- [FIRST](FIRST.md) — first value in partition
- [NEXT](NEXT.md) — value from subsequent row
