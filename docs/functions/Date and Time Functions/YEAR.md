# YEAR

Extracts the year from a date or timestamp value.

## Syntax

```
YEAR(date)
```

### Parameters

| Parameter | Definition |
|-----------|------------|
| `date` | A date or timestamp expression. Can be a column reference or any expression that produces a date. |

## Return value

An integer representing the year component of the date (e.g., 2024).

## Remarks

- YEAR extracts only the year part, discarding month and day information.
- Returns NULL if the input date is blank or null.
- Translates to `date_part('year', date)` in SQL.

## Example 1: Extract order year

Group sales by the year of the order date.

```dax
YEAR(dim_date[order_date])
```

## Example 2: Filter to current year

```dax
DEFINE CurrentYearSales = SUM(fact_sales[linetotal]), KEEP(dim_date[year] = YEAR(TODAY()))
```

## See also

- [MONTH](MONTH.md) — extract the month from a date
- [DAY](DAY.md) — extract the day from a date
- [QUARTER](QUARTER.md) — extract the quarter from a date
- [TODAY](TODAY.md) — returns the current date
