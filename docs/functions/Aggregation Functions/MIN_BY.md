# MIN_BY

Returns the value from the row where the sort column has its minimum value.

## Syntax

```
MIN_BY(table[value_column], table[sort_column])
MIN_BY(table[value_column], table[sort_column], context_op1, context_op2, ...)
```

### Parameters

| Parameter | Definition |
|-----------|------------|
| `table[value_column]` | The column whose value to return. Can be any data type. |
| `table[sort_column]` | The column used to determine which row to pick. The row with the minimum value in this column is selected. |
| `context_op` | Optional. One or more context operations ([KEEP](../Context%20Functions/KEEP.md), [CLEAR](../Context%20Functions/CLEAR.md), [RESET](../Context%20Functions/RESET.md)) that modify the evaluation context. |

## Return value

The value of the value column from the row where the sort column is at its minimum. The data type matches the value column's data type.

## Remarks

- MIN_BY generates SQL `FIRST_VALUE(value ORDER BY sort_column ASC)` internally.
- This is an aggregate function and can be used directly as a measure definition.
- If multiple rows share the minimum sort value, one is selected deterministically by the data source.
- NULL values in the sort column are excluded.
- Context operations can be passed as additional arguments: `MIN_BY(table[value_column], table[sort_column], KEEP(...))`.
- When used without context operations, MIN_BY is pushed down to the data source for maximum performance.

## Example 1: First product ever sold

Get the name of the product from the earliest sale.

```
DEFINE First Product Sold = MIN_BY(dim_product[productname], fact_sales[orderdate])
```

| First Product Sold |
|--------------------|
| Mountain-100 Silver, 38 |

## Example 2: Earliest sold product per category

Find which product had the first sale in each category.

```
DEFINE First Sold Product = MIN_BY(dim_product[productname], fact_sales[orderdate])
QUERY: First Sold Product BY dim_product[categoryname]
```

| categoryname | First Sold Product |
|-------------|---------------------|
| Bikes | Mountain-100 Silver, 38 |
| Clothing | Classic Vest, S |
| Accessories | Sport-100 Helmet, Red |

## Example 3: Starting price of each product line

Get the initial list price (the price at the earliest date) for each product.

```
DEFINE Starting Price = MIN_BY(fact_sales[unitprice], fact_sales[orderdate])
QUERY: Starting Price BY dim_product[productname]
```

| productname | Starting Price |
|------------|----------------|
| Mountain-100 Black, 42 | 3,374.99 |
| Road-150 Red, 62 | 3,578.27 |

## See also

- [MAX_BY](MAX_BY.md) -- returns the value from the row with the maximum sort value
- [MIN](MIN.md) -- returns the smallest value in a column
- [FIRST](../Information%20Functions/FIRST.md) -- returns the first value by a specified ordering
