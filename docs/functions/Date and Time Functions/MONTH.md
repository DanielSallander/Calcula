# MONTH

Extracts the month number from a date or timestamp value.

## Syntax

```
MONTH(date)
```

### Parameters

| Parameter | Definition |
|-----------|------------|
| `date` | A date or timestamp expression. Can be a column reference or any expression that produces a date. |

## Return value

An integer from 1 to 12 representing the month component of the date.

## Remarks

- MONTH returns 1 for January through 12 for December.
- Returns NULL if the input date is blank or null.
- Translates to `date_part('month', date)` in SQL.

## Example 1: Extract order month

```dax
MONTH(dim_date[order_date])
```

## Example 2: Filter to a specific month

```dax
DEFINE Q1Sales = SUM(fact_sales[linetotal]), KEEP(dim_date[month] <= 3)
```

## See also

- [YEAR](YEAR.md) — extract the year from a date
- [DAY](DAY.md) — extract the day from a date
- [QUARTER](QUARTER.md) — extract the quarter from a date
