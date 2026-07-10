# GRANDTOTAL

Returns the value of a field at the grand total level. Useful for percentage-of-total calculations.

**Category:** Hierarchy

**Syntax:** `GRANDTOTAL(field)`

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| field | Field reference or expression | Yes | The value to look up at the grand total |

## Examples

```
CALC PctOfTotal = [TotalSales] / GRANDTOTAL([TotalSales])
CALC ShareOfAll = [Revenue] / GRANDTOTAL([Revenue])
```

## Behavior

- Always returns the same value regardless of the current row's depth.
- Works even when the grand total row is hidden in the layout — the value is
  computed from the cache, so percent-of-total calculations keep working with
  grand totals disabled.

**Alias:** `COLLAPSEALL` (PowerBI-compatible)

## See Also

- [PARENT](PARENT.md) — value at parent level
