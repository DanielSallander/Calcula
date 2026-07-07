# Pivot Design View Reference

The Design view provides a text-based DSL (Domain-Specific Language) for configuring pivot table layouts. It is an alternative to the drag-and-drop Fields view, offering faster editing, precise control, and support for calculated fields with visual calculation functions.

## Switching to Design View

Click the **Design** tab at the top of the PivotTable Fields pane. Changes in the Design view are reflected in the Fields view and vice versa (bidirectional sync).

## Basic Structure

A pivot layout is defined by clauses, each starting with a keyword followed by a colon:

```
ROWS:    field1, field2
COLUMNS: field3
VALUES:  [Measure1], [Measure2]
FILTERS: field4 = ("value1", "value2")
LAYOUT:  compact, repeat-labels
```

All clauses are optional. Order doesn't matter.

---

## Clauses

### ROWS

Defines row fields (dimensions displayed as row labels).

```
ROWS:    dim_date.year, dim_customer.country
```

- Comma-separated field names
- For BI models: use `Table.Column` notation (e.g., `dim_date.year`)
- For grid pivots: use column header names
- LOOKUP fields: prefix with `LOOKUP` keyword (e.g., `LOOKUP dim_customer.name`)

**Field options:**
```
ROWS:    Region (no-subtotals), Category
```

### COLUMNS

Defines column fields (dimensions displayed as column headers).

```
COLUMNS: dim_date.quarter
```

Same syntax as ROWS.

### VALUES

Defines value fields (measures) and calculated fields. Supports interleaved ordering.

**Regular measures (BI model):**
```
VALUES:  [TotalSales], [BikeSales]
```

**Aggregation functions (grid pivots):**
```
VALUES:  Sum(Sales), Count(Orders), Average(Profit)
```

Available aggregations: `Sum`, `Count`, `Average`, `Min`, `Max`, `CountNumbers`, `StdDev`, `StdDevP`, `Var`, `VarP`, `Product`

**Show values as:**
```
VALUES:  Sum(Sales) [% of Grand Total]
```

Options: `[% of Grand Total]`, `[% of Row]`, `[% of Column]`, `[% of Parent Row]`, `[% of Parent Column]`, `[Difference]`, `[% Difference]`, `[Running Total]`, `[Index]`

**Custom display name:**
```
VALUES:  Sum(Sales) AS "Total Revenue"
```

**Inline calculated fields:**
```
VALUES:  [TotalSales],
         CALC Margin = [TotalSales] - [Cost],
         [BikeSales]
```

The order of entries in VALUES determines the column order in the pivot table. Calculated fields can be interleaved with regular measures and reordered freely.

### FILTERS

Defines filter fields with optional value restrictions.

```
FILTERS: dim_date.year
FILTERS: dim_date.year NOT IN ("2011", "2012")
FILTERS: dim_customer.country = ("Sweden", "Norway")
FILTERS: dim_date.year, dim_product.category = ("Bikes", "Accessories")
```

- No value restriction: field appears as a filter dropdown without pre-filtering
- `= (values)`: include only these values (show only)
- `NOT IN (values)`: exclude these values (hide)
- Multiple filters separated by commas
- Value lists enclosed in parentheses

### CALC (standalone)

Defines calculated fields as a separate clause. These are appended after all VALUES.

```
CALC:    Margin = [Revenue] - [Cost]
CALC:    GrowthPct = ([Sales] - PREVIOUS([Sales])) / PREVIOUS([Sales])
```

For interleaved ordering with measures, use inline CALC within VALUES instead.

### SORT

Defines sort order for fields.

```
SORT:    Region ASC, Sales DESC
```

### LAYOUT

Defines layout options.

```
LAYOUT:  tabular, repeat-labels, no-grand-totals
```

**Report layout:** `compact` (default), `outline`, `tabular`

**Label options:** `repeat-labels`, `no-repeat-labels`

**Grand totals:** `grand-totals`, `no-grand-totals`, `no-row-totals`, `no-column-totals`

**Other:** `show-empty-rows`, `show-empty-cols`, `values-on-rows`, `values-on-columns`, `auto-fit`

### TOP / BOTTOM

```
TOP 10 BY Sum(Sales)
BOTTOM 5 BY Count(Orders)
```

### SAVE AS

Save the current layout as a named configuration.

```
SAVE AS "Quarterly Review"
```

---

## Calculated Field Expressions

Calculated fields support arithmetic, transformation functions (conditional /
math / text), and visual calculation functions. Expressions are evaluated
**after aggregation** — a field reference resolves to the aggregated value for
the current cell.

### Arithmetic

```
CALC Profit = [Revenue] - [Cost]
CALC Margin = ([Revenue] - [Cost]) / [Revenue]
CALC Adjusted = [Sales] * 1.1 + 500
```

Operators: `+`, `-`, `*`, `/`, parentheses, unary negation. Division by zero
yields `#DIV/0!`.

### Field References

- Bracket notation: `[TotalSales]` (BI measures)
- Bare names: `Revenue`, `Cost` (grid pivot fields)
- Quoted names: `'Total Sales'` (names with spaces)

### Transformation Functions

Transformation functions add conditional logic, comparisons, and text handling
on top of aggregated values. Unlike visual-calc functions they need no pivot
context, and — importantly — **`IF`/`SWITCH` can return text labels or booleans**,
not just numbers.

**Comparison & boolean operators**

`>`, `<`, `>=`, `<=`, `=`, `<>` compare two values and yield a boolean. Combine
them with `AND(...)`, `OR(...)`, `NOT(...)`:

```
CALC Big     = [Sales] > 1000
CALC InBand  = AND([Sales] > 100, [Sales] < 1000)
```

**Conditional**

| Function | Syntax | Description |
|----------|--------|-------------|
| IF | `IF(condition, then, [else])` | Returns `then` when the condition is true, else `else` (or blank) |
| SWITCH | `SWITCH(expr, v1, r1, …, [default])` | Matches `expr` to the first `vi` and returns `ri`; a trailing odd argument is the default |

```
CALC Rating = IF([Sales] > 1000, "High", "Low")
CALC Tier   = SWITCH([Region], "W", 1, "E", 2, 0)
CALC Bonus  = IF([Margin] >= 0.3, [Sales] * 0.1, 0)
```

**Scalar math**

`ABS(x)`, `ROUND(x, digits)`, `MIN(a, …)`, `MAX(a, …)`, `CEILING(x, [significance])`,
`FLOOR(x, [significance])`, `SQRT(x)`, `MOD(x, divisor)`, `INT(x)`, `SIGN(x)`,
`POWER(base, exp)`.

```
CALC Rounded = ROUND([Margin] * 100, 1)
CALC Capped  = MIN([Sales], 10000)
```

**Text**

`CONCAT(a, …)` (or the `&` operator), `LEFT(text, [n])`, `RIGHT(text, [n])`,
`MID(text, start, count)`, `LEN(text)`, `UPPER(text)`, `LOWER(text)`,
`TRIM(text)`, `TEXT(value, format)`.

```
CALC Label = [Class] & " — " & [Style]
CALC Code  = UPPER(LEFT([Product], 3))
CALC Pct   = TEXT([Margin], "0.0%")
```

**Type coercion & errors** — booleans coerce to `1`/`0` in arithmetic; blanks
count as `0`; comparisons are numeric when both sides are numeric, otherwise
case-insensitive text. Runtime problems surface as error values in the cell
(`#DIV/0!`, `#VALUE!`, `#NUM!`). `IF` only evaluates the branch it takes, so an
error in the untaken branch is not raised.

See the [Transformation Functions reference](transform-functions.md) for full
details.

### Visual Calculation Functions

#### Window Functions

Traverse the row (or column) axis in visual order.

| Function | Syntax | Description |
|----------|--------|-------------|
| RUNNINGSUM | `RUNNINGSUM(field, [reset])` | Cumulative sum |
| MOVINGAVERAGE | `MOVINGAVERAGE(field, window, [reset])` | Moving average |
| PREVIOUS | `PREVIOUS(field, [steps], [reset])` | Value from prior row |
| NEXT | `NEXT(field, [steps], [reset])` | Value from subsequent row |
| FIRST | `FIRST(field, [reset])` | First value in partition |
| LAST | `LAST(field, [reset])` | Last value in partition |

**Examples:**
```
CALC RunTotal = RUNNINGSUM([TotalSales])
CALC MA3 = MOVINGAVERAGE([TotalSales], 3)
CALC YoY = [TotalSales] - PREVIOUS([TotalSales])
CALC Growth = ([TotalSales] - PREVIOUS([TotalSales])) / PREVIOUS([TotalSales])
CALC VsFirst = [TotalSales] - FIRST([TotalSales])
```

#### Hierarchy Functions

Navigate the row axis tree structure (parent/child relationships).

| Function | Syntax | Description |
|----------|--------|-------------|
| PARENT | `PARENT(field, [levels])` | Value at parent level (default 1 level up) |
| GRANDTOTAL | `GRANDTOTAL(field)` | Value at grand total level |
| CHILDREN | `CHILDREN(expr)` | Average of direct children |
| LEAVES | `LEAVES(expr)` | Average of leaf-level descendants |

**Examples:**
```
CALC PctParent = [TotalSales] / PARENT([TotalSales])
CALC PctTotal = [TotalSales] / GRANDTOTAL([TotalSales])
CALC TwoUp = PARENT([TotalSales], 2)
CALC AvgKids = CHILDREN([TotalSales])
```

#### Lookup Functions

Find values by matching field conditions.

| Function | Syntax | Description |
|----------|--------|-------------|
| LOOKUP | `LOOKUP(expr, field, value, ...)` | Find value where field matches (excludes totals) |
| LOOKUPWITHTOTALS | `LOOKUPWITHTOTALS(expr, field, value, ...)` | Same but includes total rows |

**Examples:**
```
CALC Sales2024 = LOOKUP([TotalSales], Year, 2024)
CALC SwedenSales = LOOKUP([TotalSales], Country, "Sweden")
```

#### Utility Functions

| Function | Syntax | Description |
|----------|--------|-------------|
| RANGE | `RANGE(size)` or `RANGE(start, end)` | Row window slice |
| ISATLEVEL | `ISATLEVEL(field)` | 1 if field is at current level, 0 otherwise |

**Examples:**
```
CALC Win3 = RANGE(3)
CALC YearOnly = [Sales] * ISATLEVEL(Year)
```

### Reset Parameter

Controls when window functions restart their calculation.

| Value | Description |
|-------|-------------|
| `NONE` or `0` | No reset (default) |
| `HIGHESTPARENT` or `1` | Reset at outermost group |
| `LOWESTPARENT` or `-1` | Reset at immediate parent |
| Integer N | Reset at depth level N |
| Field name | Reset at that field's level |

**Examples:**
```
CALC RunByYear = RUNNINGSUM([TotalSales], HIGHESTPARENT)
CALC RunByQ = RUNNINGSUM([TotalSales], Quarter)
```

### Axis Parameter

Window functions default to traversing rows. Add `ROWS` or `COLUMNS` as the last argument to specify the axis.

```
CALC RunCols = RUNNINGSUM([Sales], COLUMNS)
CALC PrevCol = PREVIOUS([Sales], 1, COLUMNS)
```

---

## Comments

Lines starting with `#` are comments:

```
# This is a quarterly sales report
ROWS:    dim_date.year, dim_date.quarter
VALUES:  [TotalSales]
```

---

## BI Model Specifics

When connected to a Calcula data model:

- **Dimension fields**: `Table.Column` notation (e.g., `dim_date.year`)
- **Measures**: `[MeasureName]` bracket notation (e.g., `[TotalSales]`)
- **LOOKUP fields**: `LOOKUP Table.Column` prefix for post-aggregation attributes
- **Relationship disambiguation**: `Table.Column VIA OtherTable.ForeignKey`
- **Unqualified names**: If a column name is unique across all tables, the table prefix can be omitted

---

## Autocomplete

The Design view provides context-aware autocomplete:

- **Line start**: Clause keywords (ROWS:, COLUMNS:, VALUES:, etc.)
- **After ROWS:/COLUMNS:/FILTERS:**: Dimension field names, LOOKUP keyword
- **After VALUES:**: Aggregation functions, BI measures
- **Inside CALC expressions**: Visual calculation functions, field names, measures, reset options
- **Inside function parentheses**: Field names (1st arg), reset/axis options (2nd+ arg)
- **After LAYOUT:**: Layout directives

Press **Ctrl+Space** to manually trigger autocomplete.

---

## Live Preview

Changes in the Design view update the pivot table in real-time (debounced 300ms). If **Defer Layout Update** is checked, changes accumulate until the **Update** button is clicked.

Syntax errors are shown as red underlines with error messages. The pivot only updates when the DSL is free of syntax errors.

---

## Using a design query in a chart

The same DSL can drive a **chart** directly, with no pivot table in between — the
data lives in the chart object. In **Insert ▸ Chart…**, on the **Data** tab, set
**Data source** to **Design query**, choose a BI **Connection**, and type the DSL:

```
ROWS:    dim_product.class
VALUES:  [TotalSales]
FILTERS: dim_product.style = ("W")
```

The chart runs the query headlessly against the connection's model and renders
the result — row labels become categories, value/column fields become series.
The query re-runs when the chart is opened, refreshed, or the model's data
changes.

**v1 scope:** ROWS, COLUMNS, VALUES, FILTERS, and CALC are supported. LOOKUP
columns, hierarchies, and calculation groups are not yet available in a chart
design query (they still work in a pivot). A design query must have at least one
measure (VALUES) and at least one dimension (ROWS or COLUMNS).
