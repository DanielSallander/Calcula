# MODE

Returns the most frequently occurring value in a group.

## Syntax

```
MODE(table[column])
```

### Parameters

| Parameter | Definition |
|-----------|------------|
| `table[column]` | The column from which to find the most frequent value. Can be any data type. |

## Return value

The value that appears most frequently in the column within the current group. The data type matches the column's data type.

## Remarks

- MODE generates SQL `MODE() WITHIN GROUP (ORDER BY col)` for PostgreSQL.
- This is a standard aggregate function and can be used directly as a measure definition.
- If multiple values share the highest frequency, the result is deterministic based on the data source's implementation (PostgreSQL returns the first value in sort order).
- NULL values are excluded from the frequency calculation.
- Context operations can be passed as additional arguments: `MODE(table[column], KEEP(...))`.
- When used without context operations, MODE is pushed down to the data source for maximum performance.

## Example 1: Most common product color

Find the most frequently sold product color.

```
DEFINE Most Common Color = MODE(dim_product[color])
```

| Most Common Color |
|-------------------|
| Black |

## Example 2: Most common color per category

Find the most popular color within each product category.

```
DEFINE Popular Color = MODE(dim_product[color])
QUERY: Popular Color BY dim_product[categoryname]
```

| categoryname | Popular Color |
|-------------|---------------|
| Bikes | Black |
| Clothing | Red |
| Accessories | Silver |

## Example 3: Most common order month

Find the month in which the most orders are placed.

```
DEFINE Peak Month = MODE(dim_date[monthname])
QUERY: Peak Month BY dim_date[calendaryear]
```

| calendaryear | Peak Month |
|-------------|------------|
| 2012 | June |
| 2013 | November |

## See also

- [AVG](AVG.md) -- returns the arithmetic mean
- [MEDIAN](MEDIAN.md) -- returns the middle value
- [ANY_VALUE](ANY_VALUE.md) -- returns an arbitrary value from the group
