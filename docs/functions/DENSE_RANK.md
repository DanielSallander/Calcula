# DENSE_RANK

Assigns a rank to each row within a partition. Rows with equal values receive the same rank, and subsequent ranks have no gaps.

## Syntax

```
DENSE_RANK(ORDERBY(table[column] [, table[column], ...]) [, PARTITIONBY(table[column] [, table[column], ...])])
```

### Parameters

| Parameter | Definition |
|-----------|------------|
| `ORDERBY(...)` | One or more columns defining the row ordering within each partition. |
| `PARTITIONBY(...)` | Optional. One or more columns defining independent groups. The ranking restarts for each partition. |

## Return value

An integer representing the dense rank of each row. Tied rows receive the same rank, and the next rank increments by exactly 1 regardless of the number of ties (e.g., 1, 2, 2, 3).

## Remarks

- DENSE_RANK generates SQL `DENSE_RANK() OVER (PARTITION BY ... ORDER BY ...)` internally.
- When rows have equal values in the ORDER BY columns, they receive the same rank. Unlike RANK, the next rank after a tie does not skip. For example, if two rows tie for rank 2, the next row gets rank 3 (not 4).
- To get ranks with gaps after ties, use [RANK](RANK.md) instead.
- DENSE_RANK always uses local aggregation (never pushed to data sources).
- It is materialized via two-stage evaluation: stage 1 produces one row per query group-by combination with each `ORDERBY` column aggregated as `SUM(fact[col])`; stage 2 applies `DENSE_RANK() OVER (PARTITION BY … ORDER BY … DESC)` locally via DataFusion.
- The ranking is over the query's **group-by rows**, ordered **descending** by the aggregated order key (the largest value is rank 1).
- **v1 constraints (fail closed otherwise):** the query must have a `group_by`; every `ORDERBY` column must be a column of the measure's fact table (aggregated with `SUM`); every `PARTITIONBY` column must be one of the query's `group_by` columns.

## Example 1: Dense rank products by revenue

Rank all products by their total sales revenue with no gaps.

```
DEFINE Revenue = SUM(fact_sales[linetotal])
DEFINE Dense Sales Rank = DENSE_RANK(ORDERBY(fact_sales[linetotal]))
QUERY: Revenue, Dense Sales Rank BY dim_product[productname]
```

| productname | Revenue | Dense Sales Rank |
|------------|---------|------------------|
| Mountain-200 Black, 38 | 4,400,592 | 1 |
| Mountain-200 Silver, 38 | 3,399,528 | 2 |
| Road-150 Red, 62 | 2,363,740 | 3 |

## Example 2: Dense rank within each category

Rank products within their category. Ties produce consecutive ranks without gaps.

```
DEFINE Category Dense Rank = DENSE_RANK(
  ORDERBY(fact_sales[linetotal]),
  PARTITIONBY(dim_product[categoryname])
)
DEFINE Revenue = SUM(fact_sales[linetotal])
QUERY: Revenue, Category Dense Rank BY dim_product[categoryname], dim_product[productname]
```

| categoryname | productname | Revenue | Category Dense Rank |
|-------------|------------|---------|---------------------|
| Bikes | Mountain-200 Black, 38 | 4,400,592 | 1 |
| Bikes | Mountain-200 Silver, 38 | 3,399,528 | 2 |
| Clothing | Long-Sleeve Logo Jersey, L | 156,240 | 1 |
| Clothing | Short-Sleeve Classic Jersey, M | 156,240 | 1 |
| Clothing | AWC Logo Cap | 51,229 | 2 |

Note that two Clothing items tied for rank 1, and the next rank is 2 (no gap), unlike RANK which would assign 3.

## Example 3: Price tiers using dense rank

Assign price tier numbers to products based on their list price. Products with the same price share a tier.

```
DEFINE Price Tier = DENSE_RANK(ORDERBY(dim_product[listprice]))
QUERY: Price Tier BY dim_product[productname], dim_product[listprice]
```

| productname | listprice | Price Tier |
|------------|-----------|------------|
| Road-150 Red, 62 | 3,578.27 | 1 |
| Mountain-100 Silver, 38 | 3,399.99 | 2 |
| Mountain-100 Black, 38 | 3,374.99 | 3 |
| Touring-1000 Yellow, 46 | 2,384.07 | 4 |

DENSE_RANK is ideal for tier assignments because there are no gaps, making the tier numbers easy to use for filtering (e.g., "show tier 1 through 5").

## See also

- [RANK](RANK.md) -- assigns ranks with gaps for ties
- [ROW_NUMBER](ROW_NUMBER.md) -- assigns unique sequential numbers (no ties)
- [WINDOW](WINDOW.md) -- sliding window aggregation
