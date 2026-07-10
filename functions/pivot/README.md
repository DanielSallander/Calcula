# Pivot CALC Functions

Functions used inside `CALC` expressions in the Pivot Design view fall into two
groups: **transformation functions** (conditional / math / text, evaluated
post-aggregation, context-free) and **visual calculation functions** (which
reference other rows, parent/child hierarchy levels, and positional data on the
pivot's visual axis).

## Transformation Functions

Conditional logic, comparisons, scalar math, and text handling on top of
aggregated values. `IF`/`SWITCH` can return text labels and booleans, not just
numbers.

| Function | Category | Syntax | Description |
|----------|----------|--------|-------------|
| IF | Conditional | `IF(cond, then, [else])` | Branch on a condition |
| SWITCH | Conditional | `SWITCH(expr, v1, r1, …, [default])` | Match a value to a result |
| AND / OR / NOT | Boolean | `AND(a, b, …)` | Boolean combinators |
| ABS / ROUND / MIN / MAX | Math | `ROUND(x, digits)` | Scalar math |
| CEILING / FLOOR / SQRT / MOD / INT / SIGN / POWER | Math | `MOD(x, y)` | Scalar math |
| CONCAT / LEFT / RIGHT / MID / LEN | Text | `CONCAT(a, b, …)` | Build / slice text |
| UPPER / LOWER / TRIM / TEXT | Text | `TEXT(value, format)` | Transform text |

`CONCATENATE` is accepted as an alias of `CONCAT`. Comparison (`>`, `<`, `>=`,
`<=`, `=`, `<>`), concatenation (`&`), and power (`^`) operators are also
available. `^` is right-associative and unary minus binds tighter, so
`-2^2 = 4`. See: [Transformation Functions](transform-functions.md).

## Visual Calculation Functions

Visual calculation functions operate on the pivot table's visual axis, enabling calculations that reference other rows, parent/child hierarchy levels, and positional data.

## Quick Reference

| Function | Category | Syntax | Description |
|----------|----------|--------|-------------|
| RUNNINGSUM | Window | `RUNNINGSUM(field, [reset])` | Cumulative sum |
| MOVINGAVERAGE | Window | `MOVINGAVERAGE(field, window, [reset])` | Moving average |
| PREVIOUS | Window | `PREVIOUS(field, [steps], [reset])` | Value from prior row |
| NEXT | Window | `NEXT(field, [steps], [reset])` | Value from subsequent row |
| FIRST | Window | `FIRST(field, [reset])` | First value in partition |
| LAST | Window | `LAST(field, [reset])` | Last value in partition |
| PARENT | Hierarchy | `PARENT(field, [levels])` | Value at parent level |
| GRANDTOTAL | Hierarchy | `GRANDTOTAL(field)` | Value at grand total level |
| CHILDREN | Hierarchy | `CHILDREN(expr)` | Average of direct children |
| LEAVES | Hierarchy | `LEAVES(expr)` | Average of leaf-level descendants |
| RANGE | Utility | `RANGE(size)` or `RANGE(start, end)` | Row window slice |
| ISATLEVEL | Utility | `ISATLEVEL(field)` | 1 if field is at current level |
| LOOKUP | Lookup | `LOOKUP(expr, field, value, …)` | Value from first matching row (skips totals) |
| LOOKUPWITHTOTALS | Lookup | `LOOKUPWITHTOTALS(expr, field, value, …)` | Same, including subtotal/grand total rows |

## Categories

### Window Functions
Window functions traverse the axis in visual order, visiting only rows at the **same hierarchy level** as the current row — a parent group row gets its own window over the rows at its level. Subtotal and grand total rows always return NaN. Windows can be partitioned using the **Reset** parameter so calculations restart at group boundaries.

See: [Window Functions](window-functions.md)

### Hierarchy Functions
Hierarchy functions navigate the row axis tree structure (parent/child relationships). They enable percentage-of-parent, percentage-of-total, and drill-down calculations.

See: [Hierarchy Functions](hierarchy-functions.md)

### Utility Functions
Utility functions provide conditional logic and custom window capabilities.

See: [Utility Functions](utility-functions.md)

### Lookup Functions
Lookup functions find a row on the visual matrix by matching row field values and evaluate an expression there.

See: [LOOKUP](LOOKUP.md), [LOOKUPWITHTOTALS](LOOKUPWITHTOTALS.md)

## The Reset Parameter

Many window functions accept an optional **reset** parameter that controls when the calculation restarts. See: [Reset Parameter](reset-parameter.md)

## The Axis Parameter

Window functions default to traversing the **ROWS** axis (top to bottom). When column fields are present, you can specify `COLUMNS` to traverse left to right instead:

```
CALC RunCols = RUNNINGSUM([Sales], COLUMNS)
CALC RunColsByGroup = RUNNINGSUM([Sales], HIGHESTPARENT, COLUMNS)
CALC PrevCol = PREVIOUS([Sales], 1, COLUMNS)
```

| Value | Description |
|-------|-------------|
| `ROWS` | Traverse rows top to bottom (default) |
| `COLUMNS` | Traverse columns left to right |

Rules:

- The axis keyword must be the **last** argument. It can be combined with a
  reset: `RUNNINGSUM([Sales], HIGHESTPARENT, COLUMNS)`.
- The axis keyword never counts toward a function's required arguments —
  `MOVINGAVERAGE([Sales], COLUMNS)` is an arity error (the window size is
  missing), not a columns-axis moving average.
- Resets (keywords, level numbers, and field names) work on the `COLUMNS` axis
  too; field-name resets then resolve against the column fields.
- On the `COLUMNS` axis the first argument must be a direct field reference
  (arbitrary expressions are only supported on the `ROWS` axis).

## Limits & Locale

- A formula may be at most **4096 characters** long and **256 nesting levels**
  deep; exceeding either limit is an error.
- CALC formulas are **locale-invariant**: `,` always separates arguments and
  `.` is always the decimal separator. Under a locale like sv-SE, a typed
  decimal comma inside an argument list would be read as an argument
  separator — write `ROUND([Sales], 1)` and `0.5`, never `0,5`.

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

Notes:

- `[Bracketed]` and bare field names are interchangeable — `[Sales]` resolves a
  plain `Sales` key and vice versa. Grid pivots register the source field name
  (`Sales`) alongside the display name (`Sum of Sales`), so the examples above
  work on both grid and BI pivots.
- A CALC field may reference another CALC field defined **earlier** in the
  column order (same row only). Cross-row references to other calc fields
  (e.g. `PREVIOUS` of a calc field) are not supported.
- With column fields present, each calculated field produces one column per
  column item, labeled `CalcName (ColumnLabel)` and evaluated at that column
  intersection; ROWS-axis window functions then read the current column's
  values.
