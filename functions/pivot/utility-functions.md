# Utility Functions

## RANGE

Returns the number of rows in a slice of the row axis. Useful for building custom window calculations.

**Syntax:**
- `RANGE(size)` — last N rows ending at the current row
- `RANGE(start, end)` — relative offsets from the current position

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| size | Number | Yes (form 1) | Number of rows in the window |
| start | Number | Yes (form 2) | Start offset relative to current row (negative = before) |
| end | Number | Yes (form 2) | End offset relative to current row (positive = after) |

**Examples:**
```
CALC Window3 = RANGE(3)           # Returns 3 (count of rows in window)
CALC Window = RANGE(-2, 0)        # 3 rows: 2 before + current
CALC Forward = RANGE(0, 2)        # 3 rows: current + 2 after
```

**Note:** RANGE currently returns the count of rows in the specified window. It's most useful in combination with other arithmetic to build custom window calculations.

---

## ISATLEVEL

Returns 1 if a specified row field is at the current hierarchy level, 0 otherwise. Useful for conditional calculations that should only apply at certain grouping levels.

**Syntax:** `ISATLEVEL(field_name)`

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| field_name | Field reference | Yes | The row field to check |

**Examples:**

Given **ROWS: Year, Quarter, Month**:

```
CALC YearOnly = [Sales] * ISATLEVEL(Year)
```

| Row | [Sales] | ISATLEVEL(Year) | YearOnly |
|-----|---------|-----------------|----------|
| 2024 | 10000 | 1 | 10000 |
| - Q1 | 2500 | 0 | 0 |
| -- Jan | 800 | 0 | 0 |
| -- Feb | 850 | 0 | 0 |
| -- Mar | 850 | 0 | 0 |
| - Q2 | 2600 | 0 | 0 |

**Use cases:**
- Show a value only at a specific hierarchy level
- Conditional formatting logic: `ISATLEVEL(Year) * [Sales] / GRANDTOTAL([Sales])`
- Different calculations at different levels:
  ```
  CALC Smart = ISATLEVEL(Year) * GRANDTOTAL([Sales]) + (1 - ISATLEVEL(Year)) * PARENT([Sales])
  ```
