# MAX_BY

Returns the value from the row where the sort column has its maximum value.

## Syntax

```
MAX_BY(table[value_column], table[sort_column])
```

### Parameters

| Parameter | Definition |
|-----------|------------|
| `table[value_column]` | The column whose value to return. Can be any data type. |
| `table[sort_column]` | The column used to determine which row to pick. The row with the maximum value in this column is selected. |

## Return value

The value of the value column from the row where the sort column is at its maximum. The data type matches the value column's data type.

## Remarks

- MAX_BY generates SQL `FIRST_VALUE(value ORDER BY sort_column DESC)` internally.
- This is an aggregate function and can be used directly as a measure definition.
- If multiple rows share the maximum sort value, one is selected deterministically by the data source.
- NULL values in the sort column are excluded.
- Context operations can be passed as additional arguments: `MAX_BY(table[value_column], table[sort_column], KEEP(...))`.
- When used without context operations, MAX_BY is pushed down to the data source for maximum performance.

## Example 1: Product name of the most expensive item

Get the name of the product with the highest list price.

```
DEFINE Most Expensive Product = MAX_BY(dim_product[productname], dim_product[listprice])
```

| Most Expensive Product |
|------------------------|
| Road-150 Red, 62 |

## Example 2: Latest order product per category

Find which product had the most recent sale in each category.

```
DEFINE Latest Sold Product = MAX_BY(dim_product[productname], fact_sales[orderdate])
QUERY: Latest Sold Product BY dim_product[categoryname]
```

| categoryname | Latest Sold Product |
|-------------|---------------------|
| Bikes | Mountain-200 Black, 38 |
| Clothing | Long-Sleeve Logo Jersey, L |
| Accessories | Sport-100 Helmet, Blue |

## Example 3: Best performing month's revenue

Get the revenue from the month with the highest order count.

```
DEFINE Revenue At Peak Volume = MAX_BY(
  SUM(fact_sales[linetotal]),
  COUNT(fact_sales[salesorderdetailid])
)
```

Returns the total revenue for the month that had the most order lines.

## See also

- [MIN_BY](MIN_BY.md) -- returns the value from the row with the minimum sort value
- [MAX](MAX.md) -- returns the largest value in a column
- [FIRST](FIRST.md) -- returns the first value by a specified ordering
