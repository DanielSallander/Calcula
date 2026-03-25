# SELECTEDVALUE

Returns the value of a column when the filter context has exactly one distinct value. If there are multiple distinct values, returns the alternate value (or BLANK if no alternate is provided).

## Syntax

```
SELECTEDVALUE(table[column] [, alternate])
```

### Parameters

| Parameter | Definition |
|-----------|------------|
| `table[column]` | The column to check and return. |
| `alternate` | (Optional) The value to return when the column has more than one distinct value. If omitted, returns BLANK (NULL). |

## Return value

The single value of the column if there is exactly one distinct value in the current filter context, otherwise the alternate value.

## Remarks

- SELECTEDVALUE generates SQL `CASE WHEN COUNT(DISTINCT column) = 1 THEN MIN(column) ELSE alternate END` internally.
- SELECTEDVALUE is equivalent to `IF(HASONEVALUE(table[column]), MIN(table[column]), alternate)`, but more concise.
- The alternate can be any expression: a literal string, a number, BLANK(), or even another aggregation.
- SELECTEDVALUE always forces local computation when used in a measure expression.
- SELECTEDVALUE is commonly used in:
  - Dynamic titles and labels that adapt to the user's filter selections
  - Conditional calculations that depend on a single selection
  - Lookup resolution expressions for per-query lookup columns

## Example 1: Dynamic label

Show the selected year, or "All Years" when no single year is filtered.

```
DEFINE YearLabel = SELECTEDVALUE(dim_date[year], "All Years")
```

| Context | YearLabel |
|---------|-----------|
| Year = 2024 | 2024 |
| No year filter | All Years |

## Example 2: With BLANK alternate

When no alternate is specified, BLANK is returned for multiple values.

```
DEFINE SelectedCategory = SELECTEDVALUE(dim_product[categoryname])
```

## Example 3: As a lookup resolution expression

When defining a column's lookup resolution, SELECTEDVALUE provides clean handling of 1:many scenarios.

```rust
Column::new("project_manager", DataType::String)
    .with_lookup_resolution("SELECTEDVALUE(project_manager, \"*\")")
```

When used as a lookup, this shows the project manager name if there's exactly one, or `*` if the lookup key maps to multiple managers.

## Example 4: Conditional measure

Use SELECTEDVALUE to change behavior based on what's selected.

```
VAR SelectedYear = SELECTEDVALUE(dim_date[year], 0)
RETURN IF(SelectedYear = 0, SUM(fact_sales[linetotal]), SUM(fact_sales[linetotal], KEEP(dim_date, dim_date[year] = SelectedYear)))
```

## See also

- [HASONEVALUE](HASONEVALUE.md) — tests whether a column has one value (boolean)
- [IF](IF.md) — conditional branching
- [BLANK](BLANK.md) — NULL value
- [MIN](MIN.md) — returns the minimum value
