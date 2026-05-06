# Window Functions

Window functions traverse the flattened row axis in visual order. They see the same rows that the user sees in the pivot table, excluding subtotals and grand totals.

## RUNNINGSUM

Calculates the cumulative sum of a field along the row axis.

**Syntax:** `RUNNINGSUM(field, [reset])`

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| field | Field reference or expression | Yes | The value to accumulate |
| reset | Reset parameter | No | When to restart the sum (default: NONE) |

**Examples:**
```
CALC RunTotal = RUNNINGSUM([TotalSales])
CALC RunByYear = RUNNINGSUM([TotalSales], HIGHESTPARENT)
CALC RunByParent = RUNNINGSUM([TotalSales], LOWESTPARENT)
```

**Behavior:**
- Row 1: value[1]
- Row 2: value[1] + value[2]
- Row 3: value[1] + value[2] + value[3]
- Subtotal/grand total rows: NaN (excluded from window)

---

## MOVINGAVERAGE

Calculates the moving average over a specified window of rows.

**Syntax:** `MOVINGAVERAGE(field, window, [reset])`

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| field | Field reference or expression | Yes | The value to average |
| window | Number | Yes | Number of rows in the window |
| reset | Reset parameter | No | When to restart (default: NONE) |

**Examples:**
```
CALC MA3 = MOVINGAVERAGE([TotalSales], 3)
CALC MA5ByYear = MOVINGAVERAGE([TotalSales], 5, HIGHESTPARENT)
```

**Behavior:**
- Window includes the current row and up to (window-1) preceding rows
- If fewer rows are available (e.g., first row), averages whatever is available
- For window=3 at row 5: average of rows 3, 4, 5

---

## PREVIOUS

Returns the value from a preceding row.

**Syntax:** `PREVIOUS(field, [steps], [reset])`

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| field | Field reference or expression | Yes | The value to look up |
| steps | Number | No | How many rows back (default: 1) |
| reset | Reset parameter | No | Partition boundary (default: NONE) |

**Examples:**
```
CALC PrevSales = PREVIOUS([TotalSales])
CALC TwoBack = PREVIOUS([TotalSales], 2)
CALC YoY = [TotalSales] - PREVIOUS([TotalSales])
CALC Growth = ([TotalSales] - PREVIOUS([TotalSales])) / PREVIOUS([TotalSales])
```

**Behavior:**
- Returns NaN if there is no previous row (first row in partition)
- Steps defaults to 1 if not specified

---

## NEXT

Returns the value from a subsequent row.

**Syntax:** `NEXT(field, [steps], [reset])`

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| field | Field reference or expression | Yes | The value to look up |
| steps | Number | No | How many rows forward (default: 1) |
| reset | Reset parameter | No | Partition boundary (default: NONE) |

**Examples:**
```
CALC NextSales = NEXT([TotalSales])
CALC VsNext = [TotalSales] - NEXT([TotalSales])
```

**Behavior:**
- Returns NaN if there is no next row (last row in partition)

---

## FIRST

Returns the value from the first row in the partition.

**Syntax:** `FIRST(field, [reset])`

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| field | Field reference or expression | Yes | The value to look up |
| reset | Reset parameter | No | Partition boundary (default: NONE) |

**Examples:**
```
CALC VsFirst = [TotalSales] - FIRST([TotalSales])
CALC PctOfFirst = [TotalSales] / FIRST([TotalSales])
CALC FirstInYear = FIRST([TotalSales], HIGHESTPARENT)
```

---

## LAST

Returns the value from the last row in the partition.

**Syntax:** `LAST(field, [reset])`

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| field | Field reference or expression | Yes | The value to look up |
| reset | Reset parameter | No | Partition boundary (default: NONE) |

**Examples:**
```
CALC VsLast = [TotalSales] - LAST([TotalSales])
CALC LastInYear = LAST([TotalSales], HIGHESTPARENT)
```
