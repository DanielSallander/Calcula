# LOOKUP

Find a value on the visual matrix by matching row field values. Excludes subtotal and grand total rows from the search.

**Category:** Lookup

**Syntax:** `LOOKUP(expr, field1, value1, [field2, value2, ...])`

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| expr | Expression | Yes | The expression to evaluate at the found row |
| field1 | Field reference | Yes | Row field to match |
| value1 | Value | Yes | Value to match against field1 |
| field2, value2, ... | Field/value pairs | No | Additional match criteria |

## Examples

```
CALC Sales2024 = LOOKUP([TotalSales], Year, 2024)
CALC SwedenSales = LOOKUP([TotalSales], Country, "Sweden")
CALC Specific = LOOKUP([TotalSales], Year, 2024, Country, "Sweden")
```

## Behavior

- Searches through all data rows (skipping subtotals and grand totals)
- Returns the value from the **first** matching row
- Returns NaN if no matching row is found
- The value may be a quoted string (`"Sweden"`), a bare identifier (`Sweden`),
  or a number (`2024`)
- Match criteria are case-insensitive and **numeric-aware**: `"2024"` matches
  the number 2024 (and a label like `2024.0`)
- Multiple field/value pairs are AND-combined (all must match)

## See Also

- [LOOKUPWITHTOTALS](LOOKUPWITHTOTALS.md) — includes total rows in search
- [PREVIOUS](PREVIOUS.md) — positional row reference
