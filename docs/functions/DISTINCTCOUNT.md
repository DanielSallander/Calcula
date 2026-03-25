# DISTINCTCOUNT

Counts the number of distinct (unique) values in a column.

## Syntax

```
DISTINCTCOUNT(table[column])
```

### Parameters

| Parameter | Definition |
|-----------|------------|
| `table[column]` | The column that contains the values to count. Can be any data type. |

## Return value

A whole number.

## Remarks

- The DISTINCTCOUNT function counts only unique values. Duplicate values are counted once.
- NULL values are excluded from the count.
- Unlike [COUNT](COUNT.md), which counts all non-null rows, DISTINCTCOUNT counts each unique value only once.
- The column reference must be fully qualified using the bracket notation: `table[column]`.
- When used without context operations, DISTINCTCOUNT on a single column is pushed down to the data source for maximum performance.
- DISTINCTCOUNT is particularly useful for counting unique entities, such as the number of distinct products sold or the number of unique customers.

## Example 1: Count distinct products

Count how many different products have been sold.

```
DEFINE Distinct Products = DISTINCTCOUNT(fact_sales[productid])
```

| Distinct Products |
|------------------|
| 266 |

## Example 2: Distinct count with grouping

Count the number of distinct products sold per category.

```
DEFINE Distinct Products = DISTINCTCOUNT(fact_sales[productid])
QUERY: Distinct Products BY dim_product[categoryname]
```

| categoryname | Distinct Products |
|-------------|------------------|
| Components | 134 |
| Bikes | 97 |
| Clothing | 22 |
| Accessories | 13 |

## Example 3: Comparing COUNT and DISTINCTCOUNT

Use both measures to see the difference between total and unique counts.

```
DEFINE Total Orders = COUNT(fact_sales[salesorderdetailid])
DEFINE Unique Products = DISTINCTCOUNT(fact_sales[productid])
QUERY: Total Orders, Unique Products BY dim_product[categoryname]
```

This shows that while there are many order lines (COUNT), only a smaller number of distinct products (DISTINCTCOUNT) generated them.

## See also

- [COUNT](COUNT.md)
- [SUM](SUM.md)
