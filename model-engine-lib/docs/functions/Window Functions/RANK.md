# RANK

Assigns a rank to each row within a partition. Rows with equal values receive the same rank, and subsequent ranks have gaps.

## Syntax

```
RANK(ORDERBY(table[column] [, table[column], ...]) [, PARTITIONBY(table[column] [, table[column], ...])])
```

### Parameters

| Parameter | Definition |
|-----------|------------|
| `ORDERBY(...)` | One or more columns defining the row ordering within each partition. |
| `PARTITIONBY(...)` | Optional. One or more columns defining independent groups. The ranking restarts for each partition. |

## Return value

An integer representing the rank of each row. Tied rows receive the same rank, and the next rank is incremented by the number of tied rows (e.g., 1, 2, 2, 4). A group whose aggregated order key is `NULL` (e.g. all-blank/voided values) ranks **last**.

## Remarks

- RANK generates SQL `RANK() OVER (PARTITION BY ... ORDER BY ...)` internally.
- When rows have equal values in the ORDER BY columns, they receive the same rank. The next rank after a tie skips ahead, creating gaps. For example, if two rows tie for rank 2, the next row gets rank 4 (not 3).
- To get ranks without gaps, use [DENSE_RANK](DENSE_RANK.md) instead.
- RANK always uses local aggregation (never pushed to data sources).
- It is materialized via two-stage evaluation: stage 1 produces one row per query group-by combination with each `ORDERBY` column aggregated as `SUM(fact[col])`; stage 2 applies `RANK() OVER (PARTITION BY … ORDER BY … DESC)` locally via DataFusion.
- The ranking is over the query's **group-by rows**, ordered **descending** by the aggregated order key (the largest value is rank 1).
- **v1 constraints (fail closed otherwise):** the query must have a `group_by`; every `ORDERBY` column must be a measure column of the query's genuine fact table (aggregated with `SUM`) — ordering by a **dimension** attribute fails closed (order a dimension at the request level instead); every `PARTITIONBY` column must be one of the query's `group_by` columns.

## Example 1: Rank products by revenue

Rank all products by their total sales revenue.

```
DEFINE Revenue = SUM(fact_sales[linetotal])
DEFINE Sales Rank = RANK(ORDERBY(fact_sales[linetotal]))
QUERY: Revenue, Sales Rank BY dim_product[productname]
```

| productname | Revenue | Sales Rank |
|------------|---------|------------|
| Mountain-200 Black, 38 | 4,400,592 | 1 |
| Mountain-200 Silver, 38 | 3,399,528 | 2 |
| Road-150 Red, 62 | 2,363,740 | 3 |

## Example 2: Rank within each category

Rank products within their category, showing gaps when products tie.

```
DEFINE Category Rank = RANK(
  ORDERBY(fact_sales[linetotal]),
  PARTITIONBY(dim_product[categoryname])
)
DEFINE Revenue = SUM(fact_sales[linetotal])
QUERY: Revenue, Category Rank BY dim_product[categoryname], dim_product[productname]
```

| categoryname | productname | Revenue | Category Rank |
|-------------|------------|---------|---------------|
| Bikes | Mountain-200 Black, 38 | 4,400,592 | 1 |
| Bikes | Mountain-200 Silver, 38 | 3,399,528 | 2 |
| Bikes | Road-150 Red, 62 | 2,363,740 | 3 |
| Clothing | Long-Sleeve Logo Jersey, L | 156,240 | 1 |
| Clothing | Short-Sleeve Classic Jersey, M | 156,240 | 1 |
| Clothing | AWC Logo Cap | 51,229 | 3 |

Note that two Clothing items tied for rank 1, so the next rank is 3 (not 2).

## Example 3: Rank months by order volume

Rank months by the number of orders placed, highlighting the busiest months.

```
DEFINE Order Count = COUNTROWS(fact_sales)
DEFINE Month Rank = RANK(ORDERBY(fact_sales[salesorderdetailid]))
QUERY: Order Count, Month Rank BY dim_date[monthname], dim_date[calendaryear]
```

| calendaryear | monthname | Order Count | Month Rank |
|-------------|-----------|-------------|------------|
| 2013 | November | 12,443 | 1 |
| 2013 | June | 11,987 | 2 |
| 2013 | December | 10,328 | 3 |

## See also

- [DENSE_RANK](DENSE_RANK.md) -- assigns ranks without gaps for ties
- [ROW_NUMBER](ROW_NUMBER.md) -- assigns unique sequential numbers (no ties)
- [WINDOW](WINDOW.md) -- sliding window aggregation
