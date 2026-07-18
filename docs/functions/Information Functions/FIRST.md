# FIRST

Returns the first value of a column, ordered by another expression. This is useful for retrieving the value associated with the first row according to a specific sort order.

## Syntax

```
FIRST(table[column], ORDER BY table[sort_column])
```

The `ORDER BY` keywords are optional:

```
FIRST(table[column], table[sort_column])
```

### Parameters

| Parameter | Definition |
|-----------|------------|
| `table[column]` | The column whose value to return. |
| `table[sort_column]` | The column or expression that determines the ordering. The first value according to this ordering is returned. |

## Return value

The value of the column from the first row according to the specified ordering.

## Remarks

- FIRST generates SQL `FIRST_VALUE(column ORDER BY sort_column)` internally.
- The ordering is ascending by default.
- FIRST always forces local computation when used in a measure expression.
- This is a simplified version of the DAX FIRST function. The DAX parameters `axis`, `blanks`, and `reset` are not supported — these are visual calculation concepts that don't apply to the Calcula Engine's tabular computation model.
- FIRST is particularly useful as a lookup resolution expression, where you want to pick a deterministic value from a 1:many relationship based on ordering.

## Example 1: First order date

Get the earliest order date for each product.

```
DEFINE FirstOrder = FIRST(fact_sales[orderdate], ORDER BY fact_sales[orderdate])
```

## Example 2: As a lookup resolution expression

When a lookup column may have multiple values per key, use FIRST to pick the value from the row with the lowest sort key.

```rust
Column::new("product_name", DataType::String)
    .with_lookup_resolution("FIRST(product_name, ORDER BY sort_order)")
```

This retrieves the product name from the row with the lowest `sort_order` value, giving deterministic and meaningful results for 1:many lookups.

## Example 3: Without ORDER BY keywords

The `ORDER BY` keywords are optional — the second argument is always interpreted as the sort expression.

```
DEFINE FirstName = FIRST(dim_employee[name], dim_employee[hire_date])
```

Returns the name of the employee with the earliest hire date.

## See also

- [MIN](MIN.md) — returns the smallest value (not order-dependent)
- [MAX](MAX.md) — returns the largest value
- [SELECTEDVALUE](SELECTEDVALUE.md) — returns the value when there's exactly one
