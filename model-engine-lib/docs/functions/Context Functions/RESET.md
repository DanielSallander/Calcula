# RESET

Removes all filters from the evaluation context. The measure is computed against the full, unfiltered dataset. Pinned filters survive unless an explicit `LEVEL` includes them.

## Syntax

Remove all ordinary filters:

```
SUM(table[column], RESET())
```

Remove filters up to and including a pinned level:

```
SUM(table[column], RESET(LEVEL n))
```

### Parameters

| Parameter | Definition |
|-----------|------------|
| `LEVEL n` | Optional. Extends the reset to pinned filters: removes filter levels 0 through `n` (n = 0..9) across **all** tables. Without it, RESET removes levels 0–1 only. |

## Return value

The result of the aggregation function, computed over the entire dataset with no filters applied.

## Remarks

- RESET is always used as the **second argument** to an aggregation function (SUM, COUNT, AVG, MIN, MAX, DISTINCTCOUNT). It cannot be used standalone.
- RESET removes **all** ordinary filters — both group-by filters (level 0) and query-level filters (level 1) — across all tables. The measure sees every row in the table.
- **Pinned** filters (levels 2–9 — filters marked as structural when added to the request) **survive a bare RESET()**. Use `RESET(LEVEL n)` to remove filter levels 0 through `n`, pins included. See [CLEAR](CLEAR.md) for the full level table.
- `RESET(LEVEL 0)` canonicalizes to [RESET_INNER](RESET_INNER.md) and `RESET(LEVEL 1)` to bare RESET — a saved formula renders back in the canonical spelling. `LEVEL` must be the last (here: only) argument; a non-integer or out-of-range level (10 or higher) is a parse error.
- RESET is equivalent to calling [CLEAR](CLEAR.md) on every table in the model.
- To remove filters from only one source (query-level or group-by), use [RESET_INNER](RESET_INNER.md) or [RESET_OUTER](RESET_OUTER.md) instead.
- To remove filters on only specific tables or columns, use [CLEAR](CLEAR.md) instead.
- RESET is commonly used to compute grand totals or denominators for percentage calculations.
- A measure using RESET is always computed locally (not pushed down to the data source).

## Example 1: Grand total

Calculate the grand total revenue, ignoring all filters.

```
DEFINE Grand Total = SUM(fact_sales[linetotal], RESET())
```

No matter what filters or groupings the query applies, this measure always returns the same value — the total across the entire dataset.

## Example 2: Percentage of grand total

Compare each row's revenue to the grand total.

```
DEFINE Revenue = SUM(fact_sales[linetotal])
DEFINE Grand Total = SUM(fact_sales[linetotal], RESET())
QUERY: Revenue, Grand Total BY dim_product[categoryname]
```

| categoryname | Revenue | Grand Total |
|-------------|---------|-------------|
| Bikes | $94,620,526.47 | $109,846,381.40 |
| Components | $11,799,076.67 | $109,846,381.40 |
| Clothing | $2,120,542.60 | $109,846,381.40 |
| Accessories | $1,306,235.66 | $109,846,381.40 |

In a host application, you would create a percentage measure:

```
DEFINE Pct of Grand Total = SUM(fact_sales[linetotal]) / SUM(fact_sales[linetotal], RESET())
```

## Example 3: Grand total with grouping by date

Even when grouped by year, RESET returns the same total across all years.

```
DEFINE Revenue = SUM(fact_sales[linetotal])
DEFINE Grand Total = SUM(fact_sales[linetotal], RESET())
QUERY: Revenue, Grand Total BY dim_date[year]
```

| year | Revenue | Grand Total |
|------|---------|-------------|
| 2011 | $12,641,672.21 | $109,846,381.40 |
| 2012 | $30,674,756.65 | $109,846,381.40 |
| 2013 | $43,421,059.13 | $109,846,381.40 |
| 2014 | $23,108,893.41 | $109,846,381.40 |

## See also

- [CLEAR](CLEAR.md) — remove specific filters
- [RESET_INNER](RESET_INNER.md) — remove only group-by filters
- [RESET_OUTER](RESET_OUTER.md) — remove only query-level filters
- [KEEP](KEEP.md) — add filters to the evaluation context
