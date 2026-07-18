# QUARTER

Extracts the quarter number from a date or timestamp value.

## Syntax

```
QUARTER(date)
```

### Parameters

| Parameter | Definition |
|-----------|------------|
| `date` | A date or timestamp expression. Can be a column reference or any expression that produces a date. |

## Return value

An integer from 1 to 4 representing the quarter of the year.

## Remarks

- QUARTER returns 1 for January-March, 2 for April-June, 3 for July-September, 4 for October-December.
- Returns NULL if the input date is blank or null.
- Translates to `date_part('quarter', date)` in SQL.

## Example 1: Extract order quarter

```dax
QUARTER(dim_date[order_date])
```

## Example 2: Compare quarterly totals

```dax
DEFINE Q4Sales = SUM(fact_sales[linetotal]), KEEP(dim_date[quarter] = 4)
```

## See also

- [YEAR](YEAR.md) — extract the year from a date
- [MONTH](MONTH.md) — extract the month from a date
- [DAY](DAY.md) — extract the day from a date
