# FIRST

Returns the value from the first row in the partition.

**Category:** Window

**Syntax:** `FIRST(field, [reset])`

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| field | Field reference or expression | Yes | The value to look up |
| reset | Reset parameter | No | Partition boundary (default: NONE) |

## Examples

```
CALC VsFirst = [TotalSales] - FIRST([TotalSales])
CALC PctOfFirst = [TotalSales] / FIRST([TotalSales])
CALC FirstInYear = FIRST([TotalSales], HIGHESTPARENT)
```

## Behavior

- Returns the first value among rows at the current row's **hierarchy level**
  (within the reset partition, if one is given); a parent group row gets its
  own window over the rows at its level.
- Subtotal and grand total rows return NaN.

## See Also

- [LAST](LAST.md) — last value in partition
- [PREVIOUS](PREVIOUS.md) — value from preceding row
