# COUNTIF

Counts the number of rows where a condition is true.

## Syntax

```
COUNTIF(condition)
```

The alias `COUNT_IF` can also be used:

```
COUNT_IF(condition)
```

### Parameters

| Parameter | Definition |
|-----------|------------|
| `condition` | A Boolean expression evaluated for each row. Rows where the condition is true are counted. |

## Return value

A whole number representing the count of rows satisfying the condition.

## Remarks

- COUNTIF generates SQL `SUM(CASE WHEN condition THEN 1 ELSE 0 END)` internally.
- This is an aggregate function (`has_aggregate = true`), so it can be used directly as a measure definition.
- NULL values in the condition are treated as false and are not counted.
- The condition supports comparison operators (`=`, `<>`, `>`, `<`, `>=`, `<=`) and logical operators (`AND`, `OR`, `NOT`).
- Context operations can be passed as additional arguments after the condition: `COUNTIF(condition, KEEP(...))`.
- When used without context operations and with a simple condition, COUNTIF can be pushed down to the data source.

## Example 1: Count high-value orders

Count the number of sales lines exceeding 1000.

```
DEFINE High Value Orders = COUNTIF(fact_sales[linetotal] > 1000)
```

| High Value Orders |
|-------------------|
| 27,843 |

## Example 2: Count with equality condition and grouping

Count orders for a specific product color per category.

```
DEFINE Red Product Sales = COUNTIF(dim_product[color] = "Red")
QUERY: Red Product Sales BY dim_product[categoryname]
```

| categoryname | Red Product Sales |
|-------------|-------------------|
| Bikes | 6,721 |
| Clothing | 3,445 |
| Accessories | 1,102 |

## Example 3: Count with context operation

Count high-value orders while keeping only a specific date range.

```
DEFINE High Value Orders 2013 = COUNTIF(
  fact_sales[linetotal] > 1000,
  KEEP(dim_date[calendaryear] = 2013)
)
```

This counts order lines above 1000 that occurred in calendar year 2013, regardless of any other date filters in the query context.

## See also

- [COUNT](COUNT.md) -- counts non-null values in a column
- [COUNTROWS](COUNTROWS.md) -- counts all rows in a table
- [IF](IF.md) -- conditional expression
