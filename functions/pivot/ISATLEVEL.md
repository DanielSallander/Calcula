# ISATLEVEL

Returns 1 if the specified row field is at the current hierarchy level, 0 otherwise. Useful for conditional calculations per hierarchy level.

**Category:** Utility

**Syntax:** `ISATLEVEL(field_name)`

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| field_name | Field reference | Yes | The row field to check |

## Examples

Given **ROWS: Year, Quarter, Month**:

```
CALC YearOnly = [Sales] * ISATLEVEL(Year)
```

| Row | [Sales] | ISATLEVEL(Year) | YearOnly |
|-----|---------|-----------------|----------|
| 2024 | 10000 | 1 | 10000 |
| - Q1 | 2500 | 0 | 0 |
| -- Jan | 800 | 0 | 0 |

## Use Cases

- Show a value only at a specific hierarchy level
- Different calculations per level:
  ```
  CALC Smart = ISATLEVEL(Year) * GRANDTOTAL([Sales]) + (1 - ISATLEVEL(Year)) * PARENT([Sales])
  ```

## See Also

- [PARENT](PARENT.md) — value at parent level
- [GRANDTOTAL](GRANDTOTAL.md) — value at grand total level
