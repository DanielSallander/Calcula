# DAY

Extracts the day of the month from a date or timestamp value.

## Syntax

```
DAY(date)
```

### Parameters

| Parameter | Definition |
|-----------|------------|
| `date` | A date or timestamp expression. Can be a column reference or any expression that produces a date. |

## Return value

An integer from 1 to 31 representing the day component of the date.

## Remarks

- DAY returns the day-of-month number. The maximum depends on the month (28-31).
- Returns NULL if the input date is blank or null.
- Translates to `date_part('day', date)` in SQL.

## Example 1: Extract order day

```dax
DAY(dim_date[order_date])
```

## Example 2: Filter to first week of the month

```dax
DEFINE FirstWeekSales = SUM(fact_sales[linetotal]), KEEP(dim_date[day] <= 7)
```

## See also

- [YEAR](YEAR.md) — extract the year from a date
- [MONTH](MONTH.md) — extract the month from a date
- [DATE](DATE.md) — construct a date from year, month, and day parts
