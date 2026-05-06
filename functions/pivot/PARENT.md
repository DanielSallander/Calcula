# PARENT

Returns the value of a field at a parent hierarchy level. Useful for percentage-of-parent calculations.

**Category:** Hierarchy

**Syntax:** `PARENT(field, [levels])`

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| field | Field reference or expression | Yes | The value to look up at the parent level |
| levels | Number | No | Number of levels to go up (default: 1) |

## Examples

```
CALC PctOfParent = [TotalSales] / PARENT([TotalSales])
CALC DiffFromParent = [TotalSales] - PARENT([TotalSales])
CALC TwoLevelsUp = PARENT([TotalSales], 2)
```

## Behavior

Given **ROWS: Year, Quarter, Month**:

| Row | [Sales] | PARENT([Sales]) | PARENT([Sales], 2) |
|-----|---------|-----------------|---------------------|
| 2024 | 10000 | 25000 (grand total) | 25000 (grand total) |
| - Q1 | 2500 | 10000 (2024) | 25000 (grand total) |
| -- Jan | 800 | 2500 (Q1) | 10000 (2024) |
| -- Feb | 850 | 2500 (Q1) | 10000 (2024) |

- `PARENT([Sales])` — goes up 1 level (default)
- `PARENT([Sales], 2)` — goes up 2 levels
- At top level (no parent), returns grand total value
- At grand total row, returns NaN

**Alias:** `COLLAPSE` (PowerBI-compatible)

## See Also

- [GRANDTOTAL](GRANDTOTAL.md) — value at grand total level
- [CHILDREN](CHILDREN.md) — average of child values
