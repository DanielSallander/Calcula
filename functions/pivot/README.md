# Pivot Visual Calculation Functions

Visual calculation functions operate on the pivot table's visual axis, enabling calculations that reference other rows, parent/child hierarchy levels, and positional data. They are used inside `CALC` expressions in the Pivot Design view.

## Quick Reference

| Function | Category | Syntax | Description |
|----------|----------|--------|-------------|
| RUNNINGSUM | Window | `RUNNINGSUM(field, [reset])` | Cumulative sum |
| MOVINGAVERAGE | Window | `MOVINGAVERAGE(field, window, [reset])` | Moving average |
| PREVIOUS | Window | `PREVIOUS(field, [steps], [reset])` | Value from prior row |
| NEXT | Window | `NEXT(field, [steps], [reset])` | Value from subsequent row |
| FIRST | Window | `FIRST(field, [reset])` | First value in partition |
| LAST | Window | `LAST(field, [reset])` | Last value in partition |
| PARENT | Hierarchy | `PARENT(field)` | Value at parent level |
| GRANDTOTAL | Hierarchy | `GRANDTOTAL(field)` | Value at grand total level |
| CHILDREN | Hierarchy | `CHILDREN(expr)` | Average of direct children |
| LEAVES | Hierarchy | `LEAVES(expr)` | Average of leaf-level descendants |
| RANGE | Utility | `RANGE(size)` or `RANGE(start, end)` | Row window slice |
| ISATLEVEL | Utility | `ISATLEVEL(field)` | 1 if field is at current level |

## Categories

### Window Functions
Window functions traverse the flattened row axis in visual order (top to bottom). They can be partitioned using the **Reset** parameter so calculations restart at group boundaries.

See: [Window Functions](window-functions.md)

### Hierarchy Functions
Hierarchy functions navigate the row axis tree structure (parent/child relationships). They enable percentage-of-parent, percentage-of-total, and drill-down calculations.

See: [Hierarchy Functions](hierarchy-functions.md)

### Utility Functions
Utility functions provide conditional logic and custom window capabilities.

See: [Utility Functions](utility-functions.md)

## The Reset Parameter

Many window functions accept an optional **reset** parameter that controls when the calculation restarts. See: [Reset Parameter](reset-parameter.md)

## The Axis Parameter

Window functions default to traversing the **ROWS** axis (top to bottom). When column fields are present, you can specify `COLUMNS` to traverse left to right instead:

```
CALC RunCols = RUNNINGSUM([Sales], COLUMNS)
CALC PrevCol = PREVIOUS([Sales], 1, COLUMNS)
```

| Value | Description |
|-------|-------------|
| `ROWS` | Traverse rows top to bottom (default) |
| `COLUMNS` | Traverse columns left to right |

Note: The axis parameter is specified in the same position as the reset parameter. The engine distinguishes between them by name (`ROWS`/`COLUMNS` = axis, `HIGHESTPARENT`/`LOWESTPARENT`/`NONE` = reset).

## Usage in DSL

Visual calculation functions are used inside `CALC` expressions in the Pivot Design view:

```
ROWS:    dim_date.year, dim_customer.country
VALUES:  [TotalSales],
         CALC RunTotal = RUNNINGSUM([TotalSales]),
         CALC YoY = [TotalSales] - PREVIOUS([TotalSales]),
         CALC PctParent = [TotalSales] / PARENT([TotalSales]),
         CALC PctTotal = [TotalSales] / GRANDTOTAL([TotalSales])
```

Functions can be combined with regular arithmetic:
```
CALC Margin = ([Revenue] - [Cost]) / PARENT([Revenue])
CALC VsPrev = [Sales] - PREVIOUS([Sales])
CALC Growth = ([Sales] - PREVIOUS([Sales])) / PREVIOUS([Sales])
```
