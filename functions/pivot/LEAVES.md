# LEAVES

Evaluates an expression at each leaf-level descendant and returns the average.

**Category:** Hierarchy

**Syntax:** `LEAVES(expr)`

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| expr | Expression | Yes | The expression to evaluate at each leaf row |

## Examples

```
CALC AvgLeafSales = LEAVES([TotalSales])
CALC VsLeafAvg = [TotalSales] - LEAVES([TotalSales])
```

## Behavior

Given **ROWS: Year, Country, City**:

| Row | [Sales] | LEAVES([Sales]) |
|-----|---------|-----------------|
| Grand Total | 25000 | 833 (avg of 30 cities) |
| 2024 | 10000 | 667 (avg of 15 cities in 2024) |
| - Sweden | 6000 | 750 (avg of 8 Swedish cities) |
| -- Stockholm | 2000 | 2000 (leaf, returns own value) |

- At a parent row: returns the average of only its leaf descendants.
- At a leaf row: returns its own value.

**Alias:** `EXPANDALL` (PowerBI-compatible)

## See Also

- [CHILDREN](CHILDREN.md) — average of direct children
