# ROW_NUMBER

Assigns a unique sequential integer to each row within a partition, ordered by the specified columns.

## Syntax

```
ROW_NUMBER(ORDERBY(table[column] [, table[column], ...]) [, PARTITIONBY(table[column] [, table[column], ...])])
```

### Parameters

| Parameter | Definition |
|-----------|------------|
| `ORDERBY(...)` | One or more columns defining the row ordering within each partition. |
| `PARTITIONBY(...)` | Optional. One or more columns defining independent groups. The row numbering restarts at 1 for each partition. |

## Return value

An integer starting at 1, incrementing by 1 for each row in the partition according to the specified order. Every row receives a unique number within its partition.

## Remarks

- ROW_NUMBER generates SQL `ROW_NUMBER() OVER (PARTITION BY ... ORDER BY ...)` internally.
- Unlike RANK and DENSE_RANK, ROW_NUMBER always produces unique values -- tied rows receive different numbers (the tiebreaker is nondeterministic unless the ORDER BY columns are unique).
- ROW_NUMBER always uses local aggregation (never pushed to data sources).
- It is materialized via two-stage evaluation like other window functions: the inner data is grouped and fetched first, then the window function is applied locally via DataFusion.
- When the outer query groups by dimensions not in ORDER BY or PARTITION BY, those dimensions are automatically injected into PARTITION BY.

## Example 1: Number products by revenue

Assign a sequential number to each product based on total sales, highest first.

```
DEFINE Revenue = SUM(fact_sales[linetotal])
DEFINE Row Num = ROW_NUMBER(ORDERBY(fact_sales[linetotal]))
QUERY: Revenue, Row Num BY dim_product[productname]
```

| productname | Revenue | Row Num |
|------------|---------|---------|
| Mountain-200 Black, 38 | 4,400,592 | 1 |
| Mountain-200 Silver, 38 | 3,399,528 | 2 |
| Road-150 Red, 62 | 2,363,740 | 3 |

## Example 2: Row number within each category

Number products within their category by revenue.

```
DEFINE Row In Category = ROW_NUMBER(
  ORDERBY(fact_sales[linetotal]),
  PARTITIONBY(dim_product[categoryname])
)
```

| categoryname | productname | Row In Category |
|-------------|------------|-----------------|
| Bikes | Mountain-200 Black, 38 | 1 |
| Bikes | Mountain-200 Silver, 38 | 2 |
| Clothing | Long-Sleeve Logo Jersey, L | 1 |
| Clothing | Short-Sleeve Classic Jersey, M | 2 |

## Example 3: Top 5 products filter

Use ROW_NUMBER to identify the top 5 products by sales for further analysis.

```
DEFINE Revenue = SUM(fact_sales[linetotal])
DEFINE Product Rank = ROW_NUMBER(ORDERBY(fact_sales[linetotal]))
QUERY: Revenue, Product Rank BY dim_product[productname]
```

The host application can then filter to rows where `Product Rank <= 5` to show only the top 5 products.

## See also

- [RANK](RANK.md) -- assigns ranks with gaps for ties
- [DENSE_RANK](DENSE_RANK.md) -- assigns ranks without gaps for ties
- [INDEX](INDEX.md) -- retrieves a value at a specific position
