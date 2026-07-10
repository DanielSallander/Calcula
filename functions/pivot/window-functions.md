# Window Functions

Window functions traverse the axis in visual order. The window only contains rows at the **same hierarchy level** as the current row — a quarter row traverses the other quarter rows, and a parent (year) row gets its own window over the rows at its level. Subtotal and grand total rows are never part of a window; on those rows every window function (including FIRST and LAST) returns NaN.

All window functions also accept an optional trailing axis keyword (`ROWS`, the default, or `COLUMNS`) after the arguments shown below. The axis keyword must be the last argument and can be combined with a reset; it never substitutes for a required argument. See [the Axis Parameter](README.md#the-axis-parameter).

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
- Only rows at the current row's hierarchy level are accumulated; a parent
  group row accumulates over the other rows at its level
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
- Window includes the current row and up to (window-1) preceding rows at the
  same hierarchy level
- If fewer rows are available (e.g., first row), averages whatever is available
- For window=3 at row 5: average of rows 3, 4, 5
- The window size must be > 0, and it is required — a reset keyword in the
  window slot (`MOVINGAVERAGE([Sales], HIGHESTPARENT)`) is an error
- Subtotal/grand total rows: NaN

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
- Steps defaults to 1 if not specified; steps must be >= 0 (0 = the current row)
- **Steps vs. reset:** a bare keyword or field name in the steps slot is read
  as the reset — `PREVIOUS([Sales], HIGHESTPARENT)` is shorthand for
  `PREVIOUS([Sales], 1, HIGHESTPARENT)`. A number there is the step count. To
  combine both, write `PREVIOUS(field, steps, reset)`; a reset in the 2nd
  position cannot be followed by further arguments
- Only rows at the current row's hierarchy level are traversed; subtotal and
  grand total rows return NaN

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
- Steps defaults to 1 if not specified; steps must be >= 0 (0 = the current row)
- **Steps vs. reset:** as with PREVIOUS, a bare keyword or field name in the
  steps slot is read as the reset (`NEXT([Sales], HIGHESTPARENT)`); a number
  there is the step count. To combine both, write `NEXT(field, steps, reset)`
- Only rows at the current row's hierarchy level are traversed; subtotal and
  grand total rows return NaN

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

**Behavior:**
- Returns the first value among rows at the current row's hierarchy level
  (within the reset partition, if one is given)
- Subtotal and grand total rows return NaN

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

**Behavior:**
- Returns the last value among rows at the current row's hierarchy level
  (within the reset partition, if one is given)
- Subtotal and grand total rows return NaN
