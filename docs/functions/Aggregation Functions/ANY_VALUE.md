# ANY_VALUE

Returns an arbitrary value from the group. Useful when the value is known to be constant within the group.

## Syntax

```
ANY_VALUE(table[column])
ANY_VALUE(table[column], context_op1, context_op2, ...)
```

### Parameters

| Parameter | Definition |
|-----------|------------|
| `table[column]` | The column from which to return a value. Can be any data type. |
| `context_op` | Optional. One or more context operations ([KEEP](KEEP.md), [CLEAR](CLEAR.md), [RESET](RESET.md)) that modify the evaluation context. |

## Return value

A single value from the column within the current group. The data type matches the column's data type.

## Remarks

- ANY_VALUE generates SQL `MIN(col)` internally, which is semantically equivalent when the value is constant within the group.
- This is a standard aggregate function and can be used directly as a measure definition.
- ANY_VALUE is intended for cases where all rows in a group share the same value for the specified column. If values differ, the result is deterministic (it returns the minimum) but the semantic intent is "any value will do."
- Context operations can be passed as additional arguments: `ANY_VALUE(table[column], KEEP(...))`.
- When used without context operations, ANY_VALUE is pushed down to the data source for maximum performance.

## Example 1: Retrieve a constant attribute

When grouping by product key, retrieve the product name (which is functionally dependent on the key).

```
DEFINE Product Name = ANY_VALUE(dim_product[productname])
QUERY: Product Name BY dim_product[productkey]
```

| productkey | Product Name |
|-----------|-------------|
| 1 | Mountain-100 Black, 42 |
| 2 | Mountain-100 Black, 44 |
| 3 | Mountain-100 Black, 48 |

## Example 2: Display a parent attribute alongside an aggregation

Show the category name alongside a sum, when grouping by subcategory (which has a single parent category).

```
DEFINE Revenue = SUM(fact_sales[linetotal])
DEFINE Category = ANY_VALUE(dim_product[categoryname])
QUERY: Revenue, Category BY dim_product[subcategoryname]
```

| subcategoryname | Revenue | Category |
|----------------|---------|----------|
| Road Bikes | 28,318,145 | Bikes |
| Mountain Bikes | 9,952,760 | Bikes |
| Jerseys | 699,429 | Clothing |

## Example 3: With context operation

Retrieve the product name for a specific filtered context.

```
DEFINE Top Category Name = ANY_VALUE(
  dim_product[categoryname],
  KEEP(dim_product[categoryname] = "Bikes")
)
```

Returns "Bikes" regardless of the current filter context, since KEEP forces the filter.

## See also

- [MIN](MIN.md) -- returns the smallest value
- [MAX](MAX.md) -- returns the largest value
- [SELECTEDVALUE](SELECTEDVALUE.md) -- returns the value when there is exactly one distinct value
