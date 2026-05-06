# Hierarchy Functions

Hierarchy functions navigate the row axis tree structure. When a pivot table has multiple row fields (e.g., Year > Country > City), these functions let you compare values across hierarchy levels.

## PARENT

Returns the value of a field at the parent hierarchy level. Useful for percentage-of-parent calculations.

**Syntax:** `PARENT(field)`

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| field | Field reference or expression | Yes | The value to look up at the parent level |

**Examples:**
```
CALC PctOfParent = [TotalSales] / PARENT([TotalSales])
CALC DiffFromParent = [TotalSales] - PARENT([TotalSales])
```

**Behavior:**
- For a City row, returns the Country-level value
- For a Country row, returns the Year-level value
- For a top-level row (no parent), returns the grand total value
- For the grand total row, returns NaN

**Example with ROWS: Year, Country:**
| Row | [Sales] | PARENT([Sales]) | [Sales] / PARENT([Sales]) |
|-----|---------|-----------------|---------------------------|
| 2024 | 10000 | 25000 (grand total) | 40% |
| - Sweden | 6000 | 10000 (2024 total) | 60% |
| - Norway | 4000 | 10000 (2024 total) | 40% |
| 2025 | 15000 | 25000 (grand total) | 60% |
| - Sweden | 9000 | 15000 (2025 total) | 60% |
| - Norway | 6000 | 15000 (2025 total) | 40% |

---

## GRANDTOTAL

Returns the value of a field at the grand total level. Useful for percentage-of-total calculations.

**Syntax:** `GRANDTOTAL(field)`

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| field | Field reference or expression | Yes | The value to look up at the grand total |

**Examples:**
```
CALC PctOfTotal = [TotalSales] / GRANDTOTAL([TotalSales])
CALC ShareOfAll = [Revenue] / GRANDTOTAL([Revenue])
```

**Behavior:**
- Always returns the same value regardless of the current row's depth
- Returns NaN if no grand total row exists (grand totals disabled)

---

## CHILDREN

Evaluates an expression at each direct child row and returns the average. Useful for comparing a parent's value against the average of its children.

**Syntax:** `CHILDREN(expr)`

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| expr | Expression | Yes | The expression to evaluate at each child row |

**Examples:**
```
CALC AvgChildSales = CHILDREN([TotalSales])
CALC AboveAvg = [TotalSales] - CHILDREN([TotalSales])
```

**Behavior:**
- At a Year row with 3 Country children: returns average of the 3 countries' values
- At a leaf row (no children): returns the leaf's own value
- Subtotal rows are excluded from the average

---

## LEAVES

Evaluates an expression at each leaf-level descendant and returns the average. Goes all the way down to the lowest hierarchy level.

**Syntax:** `LEAVES(expr)`

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| expr | Expression | Yes | The expression to evaluate at each leaf row |

**Examples:**
```
CALC AvgLeafSales = LEAVES([TotalSales])
CALC VsLeafAvg = [TotalSales] - LEAVES([TotalSales])
```

**Behavior:**
- At the grand total row: returns the average across all leaf-level data rows
- At a parent row: returns the average of only its leaf descendants
- At a leaf row: returns its own value
- Useful for comparing an aggregate against the "typical" individual value

**Example with ROWS: Year, Country, City:**
| Row | [Sales] | LEAVES([Sales]) |
|-----|---------|-----------------|
| Grand Total | 25000 | 833 (avg of 30 cities) |
| 2024 | 10000 | 667 (avg of 15 cities in 2024) |
| - Sweden | 6000 | 750 (avg of 8 Swedish cities) |
| -- Stockholm | 2000 | 2000 (leaf, returns own value) |
