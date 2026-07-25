# TRAVERSE

Forces a measure to resolve cross-table filters along an **explicit relationship path** instead of the model's default propagation. Use it when a relationship is defined with `FilterPropagation::None`, or when several relationship paths connect two tables and you need to pin a specific multi-hop route.

## Syntax

```
TRAVERSE(aggregate, table1 -> table2 [-> table3 ...])
```

### Parameters

| Parameter | Definition |
|-----------|------------|
| `aggregate` | The measure expression whose cross-table filters should follow the named path. |
| `table1 -> table2 -> ...` | The relationship path, written as table names joined by `->`. At least **two** tables are required (a single table is rejected). |

## Remarks

- The path must name at least two tables; `TRAVERSE(SUM(x), Sales)` is a parse error.
- Each `->` step must correspond to a relationship declared in the model; the engine joins along exactly that route.
- `TRAVERSE` is typically combined with [KEEP](KEEP.md) so the filter has somewhere to land:
  `SUM(Sales[amount], KEEP(TRAVERSE(Sales, Sales -> Warehouse -> Products), Products[color] = "Red"))`.
- A measure using `TRAVERSE` is computed locally (the explicit path is not pushed down).
- For the common case of a single active `ManyToOne` relationship, no `TRAVERSE` is needed — dimension filters propagate automatically.

## Example: multi-hop path

Route the `Products` filter through the `Warehouse` bridge explicitly:

```
DEFINE Red Via Warehouse = SUM(
    Sales[amount],
    KEEP(TRAVERSE(Sales, Sales -> Warehouse -> Products), Products[color] = "Red")
)
```

## See also

- [KEEP](KEEP.md) — add the filter conditions that travel along the path
- [USERELATIONSHIP](USERELATIONSHIP.md) — activate a specific inactive relationship by name
- The expression-language reference for relationship propagation modes
