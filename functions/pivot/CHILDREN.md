# CHILDREN

Evaluates an expression at each direct child row and returns the average.

**Category:** Hierarchy

**Syntax:** `CHILDREN(expr)`

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| expr | Expression | Yes | The expression to evaluate at each child row |

## Examples

```
CALC AvgChildSales = CHILDREN([TotalSales])
CALC AboveAvg = [TotalSales] - CHILDREN([TotalSales])
```

## Behavior

- At a Year row with 3 Country children: returns average of the 3 countries' values.
- At a leaf row (no children): returns the leaf's own value.
- Subtotal rows are excluded from the average.

**Alias:** `EXPAND` (PowerBI-compatible)

## See Also

- [LEAVES](LEAVES.md) — average of leaf-level descendants
- [PARENT](PARENT.md) — value at parent level
