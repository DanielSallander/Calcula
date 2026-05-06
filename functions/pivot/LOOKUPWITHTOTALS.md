# LOOKUPWITHTOTALS

Find a value on the visual matrix by matching row field values. Includes subtotal and grand total rows in the search.

**Category:** Lookup

**Syntax:** `LOOKUPWITHTOTALS(expr, field1, value1, [field2, value2, ...])`

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| expr | Expression | Yes | The expression to evaluate at the found row |
| field1 | Field reference | Yes | Row field to match |
| value1 | Value | Yes | Value to match against field1 |
| field2, value2, ... | Field/value pairs | No | Additional match criteria |

## Examples

```
CALC TotalRow = LOOKUPWITHTOTALS([TotalSales], Year, "Grand Total")
```

## Behavior

- Same as LOOKUP but includes subtotal and grand total rows in the search
- Useful for referencing specific total values

## See Also

- [LOOKUP](LOOKUP.md) — excludes total rows
